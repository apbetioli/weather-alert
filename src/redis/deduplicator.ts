import { redis } from './client';

export const DEDUP_LUA_SCRIPT = `
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
  return 3 -- PERIODIC UPDATE / COOLDOWN EXPIRED: SEND
end

-- Condition 3: Suppressed
if current_hail > prev_hail then
  redis.call('HSET', KEYS[1], 'max_hail_cm', current_hail)
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 0 -- SUPPRESS
`;

export const COOLDOWN_SECONDS = 2700; // 45 minutes
export const ESCALATION_DELTA_CM = 1.5; // Hail increase threshold
export const KEY_TTL_SECONDS = 5400; // 90 minutes

export type DedupReason = 'INITIAL_ALERT' | 'ESCALATION' | 'COOLDOWN_EXPIRED' | 'SUPPRESSED';

export interface DedupResult {
  shouldSend: boolean;
  reason: DedupReason;
  code: number;
}

/**
 * Atomically evaluates storm alert deduplication via Redis Lua script.
 *
 * @param userId - Unique user identifier (e.g. telegramChatId or user_id)
 * @param cellId - Storm cell unique identifier
 * @param hailCm - Current hail diameter in cm
 * @param customTimestamp - Optional unix timestamp (in seconds) for time-shifted testing
 */
export async function evaluateAlertDeduplication(
  userId: string | number,
  cellId: string,
  hailCm: number,
  customTimestamp?: number
): Promise<DedupResult> {
  const key = `alert:state:${userId}:${cellId}`;
  const now = customTimestamp ?? Math.floor(Date.now() / 1000);

  const rawCode = await redis.eval(
    DEDUP_LUA_SCRIPT,
    1,
    key,
    now.toString(),
    hailCm.toString(),
    COOLDOWN_SECONDS.toString(),
    ESCALATION_DELTA_CM.toString(),
    KEY_TTL_SECONDS.toString()
  );

  const code = Number(rawCode);

  switch (code) {
    case 1:
      return { shouldSend: true, reason: 'INITIAL_ALERT', code: 1 };
    case 2:
      return { shouldSend: true, reason: 'ESCALATION', code: 2 };
    case 3:
      return { shouldSend: true, reason: 'COOLDOWN_EXPIRED', code: 3 };
    case 0:
    default:
      return { shouldSend: false, reason: 'SUPPRESSED', code: 0 };
  }
}
