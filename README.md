# ⛈️ Weather Alert

A high-performance, hyper-local severe weather alert engine built with **Bun**, **PostgreSQL (PostGIS)**, **Uber H3**, **Redis 7**, **BullMQ**, and **grammY**.

The system monitors severe convective storms, damaging hail, and meteorological hazards across Europe by combining official civil protection bulletins (**MeteoGate / MeteoAlarm CAP 1.2**) with real-time Doppler radar nowcasting (**EUMETNET OPERA HDF5 composite**).

---

## 🏗️ Architecture & Pipeline Flow

```mermaid
flowchart TD
    subgraph Ingestion["1. Ingestion Layer"]
        A1["MeteoGate CAP Warnings<br/>(OGC-API EDR JSON)"] --> A2["Area & MultiPolygon Normalizer<br/>(mergeMeteoAlarmWarningAreas)"]
        B1["EUMETNET OPERA Radar<br/>(ODIM HDF5 Composite)"] --> B2["jsfive Parser & proj4<br/>(LAEA ➔ WGS84 Centroids)"]
        B2 --> B3["Storm Velocity & Motion Tracker<br/>(Heading, Speed & ETA)"]
    end

    subgraph SpatialEngine["2. Inverted H3 Spatial Engine"]
        A2 --> C1["Warning Polygon"]
        C1 --> C2["h3.polygonToCells(geom, Res 6)<br/>+ gridDisk(1) Buffer"]
        C2 --> C3["PostgreSQL B-Tree Scan:<br/>WHERE h3_index IN (:impacted_cells)"]
        C3 --> C4["Exact Verification:<br/>ST_Covers(polygon, location)"]
        B3 --> C5["Spatial Bounding Box Scan:<br/>location && ST_MakeEnvelope(...)"]
    end

    subgraph StateAndQueue["3. Deduplication & Delivery"]
        C4 --> D1["Redis Lua Deduplication Gate<br/>(alert:state:user:cell)"]
        C5 --> D1
        D1 -->|"Approved (Initial / Escalation / Cooldown Expired)"| E1["BullMQ Dispatch Queue<br/>(Rate limited: 30 jobs/sec)"]
        D1 -->|"Suppressed (Unchanged severity within cooldown)"| E2["Drop Redundant Alert"]
        E1 --> F1["BullMQ Worker<br/>(HTML Formatter + Parse Fallback)"]
        F1 --> G1["Telegram Bot Delivery<br/>(grammY)"]
    end
```

---

> 🏛️ **Architecture Decisions & Engineering Challenges:**
> For a comprehensive, issue-by-issue breakdown of architectural trade-offs, evaluated alternatives, benchmarks, and decisions made across all phases, see the **[Engineering Challenges & Decisions Log](docs/CHALLENGES_AND_DECISIONS.md)**.

---

## ⚡ Core Technical Highlights

### 1. Inverted H3 Geospatial Matching Engine
- Rather than running slow $O(N)$ spherical polygon evaluations (`ST_Covers`) against every registered coordinate in PostGIS, the app hexifies warning polygons into **Uber H3 Resolution 6 cells** (`h3.polygonToCellsExperimental(..., 6, containmentOverlapping, true)`) buffered by 1 ring (`gridDisk`).
- It performs a sub-millisecond B-Tree index scan on `h3_index` in PostgreSQL, followed by exact geometric verification (`ST_Covers`) solely on the filtered candidate locations. This achieves **100% spatial parity** with PostGIS spherical math at **up to 11.7x faster speed** (measured locally with 500k users).
- 📖 **Deep Dive:** See [Spatial Engine Methodology](docs/spatial-engine-methodology.md) for the complete visual step-by-step breakdown.

### 2. Live Doppler Radar & Storm Cell Nowcasting
- Direct in-memory parsing of European OPERA radar composites (`.h5` HDF5 format) via `jsfive` and projection from LAEA to WGS84 using `proj4`.
- Connected-component clustering isolates high-reflectivity convective cores ($\ge 40\text{ dBZ}$) and tracks cell displacement across consecutive sweeps to derive storm travel speed ($\text{km/h}$) and compass heading ($\text{bearing}^\circ$).
- Computes a dynamic user ETA (in minutes) based on an along-track / cross-track trajectory cone.
- Velocity tracking state is persisted in Redis (`radar:previous_scan`), making nowcasting resilient across application restarts.
- 📖 **Deep Dive:** See [Doppler Radar Nowcasting Methodology](docs/radar-nowcasting-methodology.md) for the complete visual step-by-step breakdown.

### 3. Atomic Redis Lua Deduplication Gate
- An atomic Lua script in Redis prevents notification fatigue:
  - **Initial Alert:** Sent immediately on first detection.
  - **Severity Escalation:** Bypasses cooldowns immediately if hazard severity rank increases (e.g., Orange $\rightarrow$ Red or hail core surges).
  - **Cooldown Suppression:** Repeat alerts with identical severity are suppressed for 24 hours (or until warning expiry).
  - **Failure Rollback:** If BullMQ job retries are exhausted or queueing fails, the reservation is rolled back atomically via `releaseFailedAlertDispatch`.

### 4. Resilient Telegram Delivery & Universal Fallback
- Alerts are formatted with official MeteoAlarm awareness color badges (🟡 Yellow, 🟠 Orange, 🔴 Red) and hazard symbols.
- A custom grammY transformer intercepts Telegram `400: can't parse entities` errors and retries the message as sanitized plain text, guaranteeing life-safety alerts are never dropped due to malformed upstream tags.
- Rate-limited to 30 messages/sec in BullMQ to adhere to Telegram API broadcast guidelines.

### 5. Quantitative Forecasting & Multi-Hazard Thresholds
- Complements civil defense bulletins and live radar with personalized, everyday numerical weather prediction (NWP) threshold alerts.
- Ingests high-resolution European models (DWD ICON / ECMWF via Open-Meteo) to track rolling 24-hour accumulation and extremes:
  - 🌧️ **Rainfall** (mm accumulation)
  - ❄️ **Snowfall** (cm accumulation)
  - 💨 **Wind Gusts** (km/h peak)
  - 🥶 **Frost / Freeze** (°C minimum)
  - 🌡️ **Extreme Heat** (°C maximum)
  - 🧊 **Hail Risk** (WMO codes + CAPE & radar nowcasting)
- **H3 Spatial Forecast Caching**: Caches forecasts by **Uber H3 Resolution 6 hexagon** (`openmeteo:forecast:h3:<cell>`, 1-hour TTL). Because Resolution 6 hexagons (~36 km² area, ~7 km across) align closely with NWP model grid resolutions (DWD ICON-EU at 7 km, ECMWF at 9 km), all users within the same cell share one cached forecast, eliminating redundant upstream requests and preventing rate-limit blocks (HTTP 429).
- Bundles multiple simultaneous threshold breaches into consolidated cards with 24-hour Redis cooldown deduplication.
- **7:00 AM Local Morning Briefings & Dual-Time Display**: Threshold forecasts are scheduled to notify users at **7:00 AM in their local timezone** (derived dynamically from their coordinates via `tz-lookup`). Alert messages clearly show local time with UTC reference (e.g., `~11:00 CEST (09:00 UTC)`).
- **Past Event Suppression**: Automatically discards weather events that occurred prior to evaluation time so users never receive alerts for expired precipitation or past wind peaks.
- **Wall-Clock Cron Scheduling**: Uses `croner` for drift-free background execution aligned to wall-clock boundaries (`0 * * * *`).
- 📖 **Deep Dive:** See [Threshold Alerts Methodology](docs/threshold-alerts-methodology.md) for the complete visual step-by-step breakdown.

---

## ⬡ Spatial Matching Methodology (PostGIS + Uber H3)

The engine implements a **two-tier coarse-to-fine filtering architecture** to resolve curved weather hazard polygons against user locations:

```text
+-------------------+-------------------------------------------------------------+
| Step              | What Happens                                                |
+-------------------+-------------------------------------------------------------+
| 1. Registration   | User point is saved with PostGIS Point AND an H3 Cell ID    |
| 2. Storm Ingest   | Curved weather polygon arrives via GeoJSON                  |
| 3. Hexification   | Polygon converted to discrete H3 hexagons in memory         |
| 4. 1-Ring Buffer  | gridDisk(1) adds a border ring to avoid missing edge users  |
| 5. Tier 1 (H3)    | Fast B-Tree scan prunes 99.9% of unrelated users in <1ms    |
| 6. Tier 2 (GIS)   | ST_Covers verifies candidates against exact curved boundary |
| 7. Notification   | Redis deduplicates and Telegram delivers the alert          |
+-------------------+-------------------------------------------------------------+
```

```text
                  Two-Tier Coarse-to-Fine Matching:

  [ Incoming Storm Warning Polygon ]
                 │
                 ▼
  [ In-Memory Hexification + 1-Ring Buffer (gridDisk) ]
                 │
                 ▼
  [ Tier 1: PostgreSQL B-Tree Index Scan ] ──► Prunes 99.9% of users in <1ms
                 │
                 ▼
  [ Tier 2: PostGIS ST_Covers Evaluation ]  ──► Runs ONLY on candidate users inside
                 │                              the buffered hexagons
                 ▼
  [ 100% Spatial Parity at 11.7x Speed (500k Users) ]
```

> 📖 **Full Visual Deep Dive:** See [Spatial Engine Methodology](docs/spatial-engine-methodology.md) for detailed ASCII diagrams, boundary edge cases, and architectural tradeoffs.

---

## 📡 Doppler Radar Nowcasting Methodology

The radar tracking engine converts pan-European OPERA radar composites into hyper-local storm trajectory alerts with arrival times:

```text
                           THE 15-KM THREAT CORRIDOR
                           
                                                Corridor Boundary (+15 km)
       - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - 
                                                        User B
                                                           * (Cross-track: 6 km)
                                                    
      [Storm Cell] === Heading: 65° ===► ── ── ── ── ── ── ── ── ── ── ── 
                                                     
                                                               User C
       - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - * - - - 
                                                Corridor Boundary (-15 km)
                                                
                 * User A                                 * User D
            (Behind storm,                           (Too far off path,
             Along-track ≤ 0)                         Cross-track: 28 km)
```

```text
+---------------------+---------------------------------------------------------+
| Pipeline Stage      | What Happens                                            |
+---------------------+---------------------------------------------------------+
| 1. Binary Ingest    | In-memory HDF5 (.h5) decoding of European OPERA radar   |
| 2. Core Detection   | Filter ≥40 dBZ convective cores & LAEA ➔ WGS84 convert  |
| 3. Motion Tracking  | Compare scan T₀ vs T₁: derive speed (km/h) & heading    |
| 4. Spatial Pruning  | PostGIS 120km envelope (ST_MakeEnvelope) via GiST index |
| 5. Corridor Math    | Threat if Cross-Track ≤ 15km, Along-Track > 0, ETA ≤60m |
| 6. Deduplication    | Redis lock (TTL = ETA + 10m) prevents repeat spam       |
+---------------------+---------------------------------------------------------+
```

> 📖 **Full Visual Deep Dive:** See [Doppler Radar Nowcasting Methodology](docs/radar-nowcasting-methodology.md) for detailed formulas, coordinate transforms, and flood-fill clustering algorithms.

---

## 📋 Requirements

- [Bun](https://bun.sh) (v1.2+)
- [Docker](https://www.docker.com/) & Docker Compose
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- MeteoGate API Key (from [api.meteogate.eu](https://api.meteogate.eu))

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
bun install
cp .env.example .env
```

### 2. Configure Environment Variables

Edit `.env` and fill in your keys:

```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/weather_alert
REDIS_URL=redis://localhost:6380
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
METEOGATE_API_KEY=your_meteogate_api_key_here
PORT=3000
HOST=0.0.0.0
H3_RESOLUTION=6
```

### 3. Start Infrastructure

**For local host development** (running the app directly with Bun):
```bash
# Start PostGIS and Redis only
docker compose up -d postgis redis
bun run migrate
bun run dev
```

**For complete containerized deployment** (PostGIS, Redis, and App all in Docker):
```bash
# Builds and starts all 3 containers; migrations run automatically
docker compose up -d --build
```

The app will:
1. Verify PostGIS connection and ensure H3 indexes are synchronized.
2. Verify Redis connection.
3. Start the Bull Board monitoring dashboard on `http://localhost:3000/ui`.
4. Start the Telegram Bot via long polling.
5. Launch background cron pollers via `croner`: MeteoGate CAP warnings every 10 min (`*/10 * * * *`), live Doppler radar tracking every 5 min (`*/5 * * * *`), and 24h threshold morning briefings at top-of-hour (`0 * * * *`, evaluating users at 7:00 AM local time).

> 💡 **Headless Mode:** If `TELEGRAM_BOT_TOKEN` is left empty, the app runs in headless mode. You can still run simulations and tests without Telegram.

---

## ⚙️ Configuration Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/weather_alert` | PostgreSQL + PostGIS connection string |
| `REDIS_URL` | `redis://localhost:6380` | Redis connection for BullMQ and deduplication |
| `TELEGRAM_BOT_TOKEN` | `""` | Telegram bot token from @BotFather |
| `METEOGATE_API_KEY` | `""` | API key for MeteoGate EDR & Radar services |
| `METEOGATE_API_URL` | `https://api.meteogate.eu/warnings` | Base URL for MeteoGate warnings endpoint |
| `METEOGATE_LOCATION` | `ALL` | Ingestion scope (`ALL` or country code e.g. `IT`, `FR`, `DE`) |
| `H3_RESOLUTION` | `6` | Uber H3 hexagon resolution (0–15, default 6 $\approx 36\text{ km}^2$) |
| `PORT` | `3000` | HTTP port for Bull Board dashboard |
| `HOST` | `0.0.0.0` | Binding host for Bull Board server |
| `DASHBOARD_USERNAME`| `admin` | Optional HTTP Basic Auth username for `/ui` |
| `DASHBOARD_PASSWORD`| `""` | Optional HTTP Basic Auth password (auth disabled if empty) |

---

## 🐳 Docker Production Setup & Auto-Deployment

All three services (**PostGIS**, **Redis**, and the **Bun Application**) run in separate, isolated containers orchestrated by Docker Compose:

| Container | Image | Port | Description |
| :--- | :--- | :--- | :--- |
| `weather-alert-postgis` | `postgis/postgis:16-3.4` | `5433:5432` | PostGIS spatial database with persistent storage |
| `weather-alert-redis` | `redis:7-alpine` | `6380:6379` | In-memory deduplication gate & BullMQ queue |
| `weather-alert-app` | Custom (`Dockerfile`) | `3000:3000` | Production Bun runner & Bull Board UI |

When the `app` container starts, it automatically applies any pending Drizzle database migrations (`bun run src/db/migrate.ts`) before launching the service.

### 1. Initial Server Setup

SSH into your local server and run:

```bash
# 1. Clone your repository
git clone git@github.com:apbetioli/weather-alert.git ~/weather-alert
cd ~/weather-alert

# 2. Configure environment variables
cp .env.example .env
nano .env

# 3. Launch all containers
docker compose up -d --build

# 4. Check logs to verify health
docker compose logs -f app
```

---

### 2. Auto-Deploy on `git push` (GitHub Self-Hosted Runner)

Because local home servers are typically behind a router/NAT without a static public IP or port forwarding, a **GitHub Self-Hosted Runner** is the ideal solution. It establishes an **outbound HTTPS connection** to GitHub, eliminating the need to expose any ports to the public internet.

Whenever you push to the `main` branch, GitHub dispatches the job to your local server runner, which triggers [`scripts/deploy.sh`](scripts/deploy.sh) to pull changes, run migrations, and rebuild the containers with zero downtime.

#### Step 1: Register the Runner in GitHub

1. In your GitHub repository, navigate to **Settings** ➔ **Actions** ➔ **Runners**.
2. Click **New self-hosted runner**.
3. Select your server OS (e.g. **Linux**) and Architecture (e.g. **x64** or **ARM64**).

#### Step 2: Install the Runner on Your Server

SSH into your server and run the commands provided by GitHub:

```bash
# Create and enter the runner directory
mkdir ~/actions-runner && cd ~/actions-runner

# Download and extract the runner package (use the exact URL/version from GitHub UI)
curl -o actions-runner-linux.tar.gz -L https://github.com/actions/runner/releases/download/...
tar xzf ./actions-runner-linux.tar.gz

# Configure the runner (use the token provided in the GitHub UI)
./config.sh --url https://github.com/apbetioli/weather-alert --token <YOUR_RUNNER_REGISTRATION_TOKEN>
```
> Accept the default runner name and labels by pressing `<Enter>`.

#### Step 3: Ensure Docker Permissions

Ensure the server user running the runner can execute Docker commands without `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

#### Step 4: Run the Runner as a System Service (Auto-Start on Boot)

Install and start the runner as a background systemd service so it stays running after disconnects and reboots:

```bash
cd ~/actions-runner
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

#### Step 5: Test the Workflow

From your development machine, make any change, commit, and push:

```bash
git push origin main
```

- In GitHub, go to the **Actions** tab to watch the workflow run.
- Your local server will execute `.github/workflows/deploy.yml` ➔ `scripts/deploy.sh`.
- Docker pulls the latest code, applies new Drizzle migrations, rebuilds the container, and restarts the app automatically.

---

### 3. Useful Server Commands

```bash
# View live container logs
docker compose logs -f app

# Check container health and status
docker compose ps

# Manual redeploy at any time
./scripts/deploy.sh

# Stop all containers
docker compose down
```

---

## 🤖 Telegram Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | Welcome prompt with interactive "Share Location" button |
| `/status` | View your monitored coordinates and Uber H3 cell index |
| `/setname <Name>` | Rename your location label (e.g. `/setname Home`) |
| `/pollalerts` | Query the live official MeteoGate warning feed on-demand |
| `/testh3match` | Run a side-by-side benchmark: Inverted H3 vs PostGIS `ST_Covers` |
| `/testalert` | Simulate an incoming storm cell over your coordinates |
| `/testescalate` | Simulate a rapid severity escalation (surge to Red alert) |
| `/testradar` | Simulate an approaching Doppler radar storm cell |
| `/testthreshold` | Simulate a multi-hazard forecast threshold breach |
| `/pollthresholds` | On-demand sweep evaluating weather thresholds for all users |
| `/resetalerts` | Reset your Redis cooldown window across warnings, radar, and forecast thresholds |
| `/help` | Complete service guide and awareness level explanations |

---

## 🧪 Simulation & Test Suites

You can test every component independently without waiting for live severe weather:

```bash
# 1. PostGIS & Uber H3 spatial matching simulation
bun run simulate

# 2. Redis Lua 4-sweep deduplication and escalation test
bun run test:dedup

# 3. Live MeteoGate CAP warning ingestion & H3 parity verification
bun run poll

# 4. Doppler radar cell tracking & user ETA calculation simulation
bun run test:radar

# 5. Database health check
bun run check:db
```

---

## 📊 Real-Time Queue Dashboard

A live **Bull Board** interface is available at:
👉 **`http://localhost:3000/ui`**

Features:
- Live inspection of `alert-dispatch` queue (active, completed, failed, waiting).
- Full payload inspection (storm alert attributes, user coordinates, deduplication reason).
- Worker throughput, retry counts, and latency monitoring.
- Protected by optional HTTP Basic Auth (`DASHBOARD_PASSWORD`).

---

## 🗺️  Roadmap & Implementation Checklist

### ✅ Phase 1: Foundation & Dual Spatial Indexing ([MVP 1](docs/mvp1-plan.md))
- [x] Bun runtime environment with native TypeScript execution and `.env` parsing
- [x] PostgreSQL 16 + PostGIS 3.4 infrastructure via Docker Compose
- [x] Drizzle ORM schema with custom `geography(Point, 4326)` mapping
- [x] Dual spatial representation: PostGIS spherical Point + Uber H3 cell index (`h3.latLngToCell`)
- [x] Telegram Bot onboarding via `grammY` (`/start`, `message:location`)
- [x] Baseline spherical spatial matching (`ST_Covers`)
- [x] Standalone spatial simulation CLI suite (`bun run simulate`)

### ✅ Phase 2: Distributed State & Deduplication ([MVP 2](docs/mvp2-plan.md))
- [x] Redis 7 infrastructure via Docker Compose
- [x] Atomic Redis Lua deduplication script (`DEDUP_LUA_SCRIPT`)
  - [x] Initial alert dispatch (`Code 1`)
  - [x] Escalation bypass for rising severity (`Code 2`)
  - [x] Cooldown suppression window (`Code 0`)
  - [x] Expiration-aware TTL management
- [x] Failed dispatch reservation rollback (`releaseFailedAlertDispatch`)
- [x] BullMQ asynchronous message queue (`alert-dispatch`) with exponential backoff
- [x] Rate-limited Telegram worker (30 messages/sec)
- [x] Bull Board real-time monitoring UI dashboard (`/ui`)
- [x] Multi-sweep deduplication verification suite (`bun run test:dedup`)

### ✅ Phase 3: Inverted H3 Spatial Engine & Feed Ingestion ([MVP 3](docs/mvp3-plan.md))
- [x] Inverted H3 spatial matching engine (`alertToH3Cells` + coarse-to-fine B-Tree index scan)
- [x] 1-ring hexagon buffer (`gridDisk`) ensuring zero boundary misses and 100% PostGIS parity
- [x] CAP alert normalization across 14 MeteoAlarm hazard types and awareness levels (Yellow, Orange, Red)
- [x] Multi-area polygon merging for split CAP warning features (`mergeMeteoAlarmWarningAreas`)
- [x] Universal Telegram API fallback transformer (gracefully handles HTML parse errors as plain text)
- [x] On-demand feed query command (`/pollalerts`) & H3 benchmark command (`/testh3match`)
- [x] Automated 10-minute authoritative warning poller with concurrency mutex

### ✅ Phase 4: MeteoGate API & Live Doppler Radar Nowcasting ([MVP 4](docs/mvp4-plan.md))
- [x] EUMETNET MeteoGate Warnings API integration (`api.meteogate.eu/warnings`)
- [x] Authoritative EMMA warning boundary ingestion and caching (`meteoalarm_zones`)
- [x] Live OPERA European radar composite ingestion (`.h5` HDF5 format via `jsfive`)
- [x] In-memory projection conversion from LAEA to WGS84 via `proj4`
- [x] Convective core clustering ($\ge 40\text{ dBZ}$) and connected-component analysis
- [x] Storm cell tracking across radar sweeps (displacement, velocity in km/h, compass heading)
- [x] Radar tracking state persistence in Redis (`radar:previous_scan`) across restarts
- [x] Hyper-local dynamic user ETA calculation (along-track / cross-track trajectory cone)
- [x] PostGIS spatial bounding box optimization for radar user queries (`location && ST_MakeEnvelope`)
- [x] Radar tracking simulation suite (`bun run test:radar`)

### 🔮 Phase 5: Multi-Channel Delivery & Production Hardening ([MVP 5](docs/mvp5-plan.md))
- [ ] User-configurable alerting thresholds (minimum severity level: Yellow vs Orange vs Red)
- [ ] Convective / Hail only filtering toggle (`/settings` or `/setlevel`)
- [ ] Multi-zone monitoring per user (e.g. Home, Office, Vacation home)
- [ ] Quiet hours with life-safety overrides (extreme Red alerts bypass quiet hours)
- [ ] Multi-channel delivery adapters:
  - [ ] WhatsApp Cloud API dispatch worker
  - [ ] Web Push (PWA) notifications
- [ ] Production webhook migration for Telegram bot (replacing long polling)
- [ ] Automated unit test suite with `bun test` for pure normalization, tracking, and formatting logic
