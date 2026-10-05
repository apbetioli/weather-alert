# Implementation Plan — Weather Alert App (MVP 2: State, Deduplication & Queues)

## Goal: MVP 2 State Management, Redis Lua Deduplication & BullMQ Queue

In a real meteorological pipeline, radar sweeps and weather updates arrive continuously every 2 to 5 minutes. Without a state management and deduplication layer, a storm lingering over a city for an hour would trigger dozens of repetitive notifications.

**MVP 2** introduces the production-grade state and queue layer described in the architecture specification:
1. **Atomic Deduplication Gate (Redis + Lua Script):**
   * **Suppression (Idempotency):** Suppress duplicate alerts for the same storm cell within a 45-minute window if conditions remain unchanged.
   * **Escalation Bypass:** Instantly bypass the cooldown and dispatch a new alert if conditions worsen significantly (e.g., hail size increases by $\ge 1.5\text{ cm}$).
   * **Atomic Concurrency:** Enforce idempotency via a Redis Lua script running in $<1\text{ms}$, preventing race conditions between parallel ingestion workers.
2. **Asynchronous Message Queue (BullMQ):**
   * Decouple spatial matching from external delivery networks.
   * Ensure rate-limiting (e.g. respect Telegram's 30 msgs/sec limit), automatic retries with exponential backoff, and dead-letter queue resilience.
3. **Multi-Sweep Verification Suite:**
   * Automated tests simulating multiple radar sweeps over the same user to prove initial alert delivery, subsequent suppression, and escalation triggers.

---

## Architecture Flow for MVP 2

```mermaid
sequenceDiagram
    autonumber
    participant Poller as Weather / Radar Sweep (every 2-5m)
    participant PostGIS as Spatial Matcher (ST_Covers)
    participant Redis as Redis Atomic Lua Gate
    participant Queue as BullMQ Dispatch Queue
    participant Worker as Async Telegram Worker
    actor User as User on Telegram

    Poller->>PostGIS: Sweep 1: Hail 2.0 cm over User location
    PostGIS-->>Redis: Evaluate alert:state:user_1:cell_123
    Note over Redis: State does not exist
    Redis-->>PostGIS: Code 1 (INITIAL_ALERT) -> Allow dispatch
    PostGIS->>Queue: Enqueue alert job
    Queue->>Worker: Consume job with rate limit & retries
    Worker->>User: ⚠️ Hail Detected (2.0 cm)

    Note over Poller,User: 3 minutes later (Sweep 2: Hail 2.2 cm - unchanged severity)
    Poller->>PostGIS: Sweep 2: Hail 2.2 cm over User location
    PostGIS-->>Redis: Evaluate alert:state:user_1:cell_123
    Note over Redis: Cooldown active (42 min left) & Δhail < 1.5 cm
    Redis-->>PostGIS: Code 0 (SUPPRESSED) -> Drop event silently
    Note over PostGIS,Queue: Job NOT enqueued; User not spammed!

    Note over Poller,User: 6 minutes later (Sweep 3: Hail jumps to 4.0 cm - Escalation!)
    Poller->>PostGIS: Sweep 3: Hail 4.0 cm (Δ = +1.8 cm)
    PostGIS-->>Redis: Evaluate alert:state:user_1:cell_123
    Note over Redis: Escalation condition met: Δ >= 1.5 cm!
    Redis-->>PostGIS: Code 2 (ESCALATION) -> Allow dispatch
    PostGIS->>Queue: Enqueue urgent alert job
    Queue->>Worker: Consume job
    Worker->>User: ⚠️ ESCALATION: Hail increased to 4.0 cm!
```

---

## User Review Required

> [!IMPORTANT]
> **Redis 7 Added to Docker Compose:**
> We will add a lightweight `redis:7-alpine` container to `docker-compose.yml` on port `6379`. Running `docker compose up -d` will start both PostGIS and Redis seamlessly.

> [!NOTE]
> **Key Configuration Parameters for Deduplication:**
> * `COOLDOWN_SECONDS = 45 * 60` (45 minutes suppression window)
> * `ESCALATION_HAIL_DELTA_CM = 1.5` (Bypass cooldown if hail grows by $\ge 1.5\text{ cm}$)
> * `ALERT_KEY_TTL_SECONDS = 90 * 60` (90 minutes auto-expiration in Redis)

---

## Open Questions

None. The architecture strictly follows the deduplication and queue design detailed in the technical specification.

---

## Proposed Changes

### 1. Infrastructure & Dependencies

#### [MODIFY] [docker-compose.yml](file:///Users/alex/Code/alex/weather-alert/docker-compose.yml)
* Add `redis` service (`redis:7-alpine`) with port `6379:6379` and persistent volume `redis_data`.

#### [MODIFY] [package.json](file:///Users/alex/Code/alex/weather-alert/package.json)
* Install `ioredis` and `bullmq` via Bun:
  ```bash
  bun add ioredis bullmq
  bun add -d @types/ioredis
  ```

#### [MODIFY] [.env.example](file:///Users/alex/Code/alex/weather-alert/.env.example) & [.env](file:///Users/alex/Code/alex/weather-alert/.env)
* Add `REDIS_URL=redis://localhost:6379`.

#### [MODIFY] [src/config/env.ts](file:///Users/alex/Code/alex/weather-alert/src/config/env.ts)
* Add validated `REDIS_URL` with default fallback.

---

### 2. Redis Client & Atomic Lua Deduplicator (`src/redis`)

#### [NEW] `src/redis/client.ts`
* Initializes and exports a singleton `ioredis` connection instance.

#### [NEW] `src/redis/deduplicator.ts`
* Implements the exact atomic Lua evaluation script from Section 5 of the technical specification:
  ```lua
  local exists = redis.call('EXISTS', KEYS[1])
  if exists == 0 then
    redis.call('HSET', KEYS[1], 'last_notified_at', ARGV[1], 'max_hail_cm', ARGV[2], 'dispatch_count', 1)
    redis.call('EXPIRE', KEYS[1], ARGV[5])
    return 1 -- INITIAL ALERT: SEND
  end

  local last_notified = tonumber(redis.call('HGET', KEYS[1], 'last_notified_at') or '0')
  local prev_hail = tonumber(redis.call('HGET', KEYS[1], 'max_hail_cm') or '0')
  local current_hail = tonumber(ARGV[2])
  local now = tonumber(ARGV[1])

  -- Condition 1: Significant Escalation (Bypass Cooldown)
  if current_hail >= (prev_hail + tonumber(ARGV[4])) then
    redis.call('HSET', KEYS[1], 'last_notified_at', ARGV[1], 'max_hail_cm', math.max(prev_hail, current_hail))
    redis.call('HINCRBY', KEYS[1], 'dispatch_count', 1)
    redis.call('EXPIRE', KEYS[1], ARGV[5])
    return 2 -- ESCALATION ALERT: SEND
  end

  -- Condition 2: Cooldown Expired (Periodic Reminder)
  if (now - last_notified) >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], 'last_notified_at', ARGV[1], 'max_hail_cm', math.max(prev_hail, current_hail))
    redis.call('HINCRBY', KEYS[1], 'dispatch_count', 1)
    redis.call('EXPIRE', KEYS[1], ARGV[5])
    return 3 -- PERIODIC UPDATE: SEND
  end

  -- Condition 3: Suppressed
  if current_hail > prev_hail then
    redis.call('HSET', KEYS[1], 'max_hail_cm', current_hail)
  end
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 0 -- SUPPRESS
  ```
* Exports `evaluateAlertDeduplication(userId, cellId, hailSizeCm) -> { shouldSend: boolean, reason: string }`.

---

### 3. Asynchronous BullMQ Queue & Worker (`src/queue`)

#### [NEW] `src/queue/index.ts`
* Defines `alertDispatchQueue` (`Queue<{ alert: StormAlert, user: MatchedUser, reason: string }>`).
* Configures queue options: default job retention, exponential backoff retries (3 attempts).

#### [NEW] `src/queue/worker.ts`
* Runs the `Worker` that consumes jobs from `alertDispatchQueue`.
* Formats MarkdownV2 messages with an optional escalation header (e.g. `🔺 ESCALATION: Hail increased to 4.0 cm!`).
* Dispatches messages via Telegram API with concurrency control.

---

### 4. Integration & Testing

#### [MODIFY] [src/bot/handlers.ts](file:///Users/alex/Code/alex/weather-alert/src/bot/handlers.ts)
* Update `/testalert` to pass matched users through the Redis deduplication gate.
* When approved, enqueue the job into BullMQ instead of making direct HTTP calls.

#### [NEW] `src/simulator/test-deduplication.ts`
* Automated multi-sweep test suite demonstrating:
  1. **Sweep 1:** Initial alert -> Approved (`INITIAL_ALERT`).
  2. **Sweep 2:** Minor change (2.0 cm -> 2.2 cm) -> Blocked (`SUPPRESSED`).
  3. **Sweep 3:** Major jump (2.2 cm -> 3.8 cm) -> Approved (`ESCALATION`).
  4. **Sweep 4:** Fast-forward timestamp past cooldown -> Approved (`COOLDOWN_EXPIRED`).

---

## Verification Plan

### Automated Tests
1. **Redis Health Check:** Verify connection to Redis on port 6379 (`redis.ping()`).
2. **Deduplication Multi-Sweep Test:**
   ```bash
   bun run test:dedup
   ```
   Verifies that:
   * Sweep 1 outputs: `Code 1 (INITIAL_ALERT)`
   * Sweep 2 outputs: `Code 0 (SUPPRESSED)`
   * Sweep 3 outputs: `Code 2 (ESCALATION)`
   * Sweep 4 outputs: `Code 3 (COOLDOWN_EXPIRED)`

### Manual Verification
1. `docker compose up -d` (PostGIS and Redis both healthy).
2. Start dev server: `bun run dev`.
3. In Telegram, send `/testalert`:
   * First time: receives hail warning.
4. Immediately send `/testalert` again:
   * Alert is suppressed! Bot replies: *"Alert suppressed by Redis deduplication gate (cooldown active)."*
5. Run simulation script with escalation hail size to observe immediate alert bypass!
