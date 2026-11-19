# Clima — Technical Documentation

This document explains every library, API, service and data source the Clima
weather app uses, and exactly how each one is used inside the project.

Clima is a lightweight weather app with **two surfaces that share one brain**:

```
                    ┌──────────────────────────────────────────────┐
                    │  Data providers (free, no API keys)          │
                    │  Open-Meteo · BigDataCloud · wttr.in         │
                    │  RainViewer · Esri · Natural Earth           │
                    └───────────────┬──────────────────────────────┘
                                    │ HTTPS
                    ┌───────────────▼──────────────────────────────┐
                    │  Python backend  (weather-app/backend/app.py)│
                    │  stdlib-only HTTP server on port 5050        │
                    │  cache · retry · stale fallback · wttr backup│
                    └───────────────┬──────────────────────────────┘
                                    │ same-origin JSON API + static UI
              ┌─────────────────────┼──────────────────────────────┐
              │                     │                              │
   ┌──────────▼──────────┐  ┌───────▼───────────────┐   ┌──────────▼──────────┐
   │ Standalone UI       │  │ Next.js 16 UI         │   │ Downloaded folder   │
   │ (served by Python)  │  │ (project root, :3000) │   │ = weather-app/ only │
   │ vanilla HTML/CSS/JS │  │ React 19 + Tailwind 4 │   │ runs with Python 3  │
   └─────────────────────┘  └───────────────────────┘   └─────────────────────┘
```

- **Surface 1 — the portable folder** (`weather-app/`): `python3 app.py` serves
  *both* the JSON API and a complete vanilla-JS UI at `http://localhost:5050`.
  No Node.js, no build step, no pip installs.
- **Surface 2 — the Next.js app** (project root): a React 19 / TypeScript UI on
  port 3000 that consumes the *same* Python service. Its `weather-app.tsx`
  page is the demo version of the identical experience.

Both frontends render the same cards and use the same two "engine" files
(globe + radar), which are kept byte-for-byte identical so behaviour matches.

---

## 1. External APIs (data providers)

All providers are free, keyless and called **only from the Python backend** —
the browser never talks to them directly (which avoids CORS issues, hides
upstream flakiness and lets one cache serve every visitor).

### 1.1 Open-Meteo Forecast API — the primary weather source

- URL: `https://api.open-meteo.com/v1/forecast`
- Used for: current conditions, 48 h of hourly data, 15-day forecast,
  yesterday's summary, past-7-days history, and the pressure trend.

How it is called (`_open_meteo_forecast` in `app.py`):

| Parameter | Value | Why |
|---|---|---|
| `latitude`, `longitude` | float | the selected city (or every city, comma-separated, for batch calls) |
| `current` | temperature_2m, apparent_temperature, relative_humidity_2m, is_day, precipitation, weather_code, cloud_cover, pressure_msl, wind_speed_10m, wind_direction_10m, wind_gusts_10m | the whole hero card |
| `hourly` | same + precipitation_probability, pressure_msl | hourly strip, rain outlook, nowcast, planner, temp chart |
| `daily` | weather_code, temp max/min, apparent max/min, sunrise, sunset, precipitation_probability_max, precipitation_sum, wind max + dominant direction, uv_index_max | 15-day card, daylight arc, wind compass |
| `timezone` | `auto` | Open-Meteo returns times already in the city's local time |
| `forecast_days` | 16 | gives us the "15-day forecast" (today + 15) |
| `past_days` | 7 | yesterday comparison + "Past 7 days" history chart |
| `wind_speed_unit` | `kmh` | canonical unit; conversion to mph happens in the UI |

Clever trick used: Open-Meteo accepts **comma-separated coordinates** and
returns an array of forecasts — this powers `/api/batch` (favorite chips) and
`/api/globe` (world cities) with a handful of requests instead of 100.

### 1.2 Open-Meteo Air Quality API

- URL: `https://air-quality-api.open-meteo.com/v1/air-quality`
- Used for: the "Air quality" card — European AQI plus PM2.5, PM10, ozone,
  NO₂, SO₂, CO, dust and UV index. Optional by design: if it fails, the card
  quietly shows "—" and the page never breaks over it.

### 1.3 Open-Meteo Geocoding API

- URL: `https://geocoding-api.open-meteo.com/v1/search`
- Used for: the city search box. Parameter `name=<query>`; results give
  `name`, `admin1` (region), `country`, `latitude/longitude`, `timezone`,
  `population` (used to rank results). Debounced in the UI, `/` is a shortcut.

### 1.4 BigDataCloud Reverse Geocoding (client endpoint)

- URL: `https://api.bigdatacloud.net/data/reverse-geocode-client`
- Used for: the "use my location" button — turns browser coordinates from the
  Geolocation API into a place name. This specific endpoint is free and
  keyless, which is why it was chosen. Proxied as `/api/reverse`.

### 1.5 wttr.in — the backup weather provider

- URL: `https://wttr.in/{lat},{lon}?format=j1` (JSON format)
- Used for: **graceful degradation only**. When Open-Meteo is quota-exhausted
  (HTTP 429) or unreachable, forecast payloads are rebuilt from wttr.in and
  marked `degraded: true` — the UI shows a "backup data" banner, the daily
  card becomes "N-day forecast (backup feed)".
- Details handled in `app.py`:
  - wttr.in reports WWO weather codes → mapped to WMO codes via `_WWO_TO_WMO`
    so the rest of the app needs no special-casing.
  - wttr.in has no timezone API → local UTC offset is **guessed from
    lat/lon**, including EU/US/AU daylight-saving rules and half-hour zones
    (India, Iran…), so sunrise/sunset and day/night still look right.
  - Called with a `curl` User-Agent (wttr.in serves plain HTML to browsers)
    and a 20 s timeout, 2 attempts.

### 1.6 RainViewer — live precipitation radar

- Frame index: `https://api.rainviewer.com/public/weather-maps.json`
  (proxied as `/api/radar/maps`, 4-minute cache — the index refreshes every
  ~10 min upstream)
- Tiles: `https://tilecache.rainviewer.com{path}/{z}/{x}/{y}.png`
  (proxied as `/api/radar/tile?path=...&z=&x=&y=`)
- Used for: the animated **Radar** tab — past 2 hours of observed frames plus
  a 30-minute nowcast, played back at 520 ms/frame. Tile paths are validated
  with the regex `^/v2/radar/[0-9a-f]{6,24}$` before proxying (prevents the
  endpoint being abused as an open relay), and tiles are kept in an in-memory
  LRU cache (~720 tiles ≈ 6 MB, each frame dropped after 1 h).

### 1.7 Esri ArcGIS basemap tiles

- URLs: `.../Canvas/World_Light_Gray_Base/...` and `World_Dark_Gray_Base/...`
- Used for: the neutral light/dark basemap under the radar overlay. CARTO's
  free basemaps started requiring an API key, so Esri's gray canvas was chosen
  — it is keyless and keeps the precipitation colours legible.

### 1.8 Natural Earth land polygons (build-time only)

- Source: `ne_110m_land.geojson` from the `natural-earth-vector` GitHub repo
  (fetched via raw.githubusercontent.com or jsDelivr).
- Used **once, at generation time** by `tools/gen_land_mask.py`: the polygons
  are rasterised onto a 360×180 one-degree grid and written as a base64 bit
  string into `land-mask.js`. The app itself never calls any map-data API at
  runtime — the globe's continents are this embedded bit grid.

---

## 2. The Python backend (`weather-app/backend/app.py`)

~1,050 lines, **Python standard library only** — this is what makes the
downloaded folder work on any machine with Python 3 and nothing else.

### 2.1 Standard-library modules and how each is used

| Module | Used for |
|---|---|
| `http.server` (`ThreadingHTTPServer`, `BaseHTTPRequestHandler`) | threaded HTTP server on port 5050; serves the static UI and the JSON API from one process |
| `urllib.request` / `urllib.parse` / `urllib.error` | the HTTP client for all upstream providers (`fetch_json`); distinguishes `HTTPError` (429 → retry) from `URLError` |
| `json` | encoding/decoding every payload; safe error responses |
| `collections.OrderedDict` | the in-memory response cache with bounded size |
| `threading.Lock` | makes the cache and last-good store thread-safe under `ThreadingHTTPServer` |
| `concurrent.futures.ThreadPoolExecutor` | parallel upstream calls: favorite-chip batch fallback (6 workers) and the world-globe city chunks (4 workers) |
| `datetime` (`date`, `datetime`, `timedelta`, `timezone`) | UTC math, DST rules for the wttr.in timezone guess, sunrise/sunset, day labels |
| `re` | validating RainViewer tile paths before proxying (security) |
| `os` | locating the `frontend/` folder, `.last_good/` disk store, logo |
| `copy` | deep-copying cached payloads before mutation so a handler can never corrupt the cache |
| `time` | TTL checks, backoff sleeps, cooldowns |
| `BaseHTTPRequestHandler.log_message` | silenced — the app logs via stdout banner/errors only |

### 2.2 HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness probe (`{"status":"ok"}`) |
| `GET /api/weather?lat=&lon=` | the full forecast payload: current + hourly (trimmed to the next 48 h) + `past_hourly` (the 6 h before now, for the nowcast) + 15-day daily + yesterday + 7-day history + 3 h pressure trend. Runs the full resilience pipeline below. |
| `GET /api/airquality?lat=&lon=` | European AQI + pollutants (optional, independently cached) |
| `GET /api/geocode?name=` | city search proxy |
| `GET /api/reverse?lat=&lon=` | "use my location" place-name lookup |
| `GET /api/batch?locs=lat,lon;…` | current temp / code / is_day **+ today's extremes** for up to 12 locations in one call — powers favorite chips and their alert dots; per-location wttr.in fallback |
| `GET /api/radar/maps` | RainViewer frame index (past 2 h + 30 min nowcast) |
| `GET /api/radar/tile?path=&z=&x=&y=` | radar PNG tile proxy, regex-guarded, LRU-cached |
| `GET /api/globe` | current weather for ~96 world cities, fetched as 4 chunked multi-location requests (25 cities each, 4 worker threads), cached 15 min |
| `GET /` + static files | the built-in UI: `index.html`, `styles.css`, `app.js`, `globe-engine.js`, `radar-view.js`, `land-mask.js`, `vendor/leaflet.js|.css`, `logo.svg`, favicons |

### 2.3 The resilience pipeline (why 429 errors stopped killing the app)

Every expensive upstream call goes through `fetch_with_fallback(key, build)`:

1. **Memory cache** — 15-minute TTL (`CACHE_TTL_SECONDS = 900`). Most requests
   never leave the process.
2. **Retry with exponential backoff** — `fetch_json` retries up to 4 attempts
   with sleeps of 0.7 / 1.5 / 3.0 s (capped at 8 s), **honouring a numeric
   `Retry-After` header** when the upstream sends one. Permanent 4xx errors
   fail fast; only 429/5xx/network errors are retried.
3. **Stale fallback ("last good")** — every successful payload is also written
   to `backend/.last_good/` on disk. If cache is empty and upstream fails, the
   last known payload (up to 24 h old) is served with `stale: true` and
   `stale_minutes`, which the UI surfaces as a "saved data" banner. A 60 s
   per-key cooldown prevents retry storms while upstream is down.
4. **Backup provider** — if there is no last-good data either, wttr.in builds
   a reduced payload marked `degraded: true` (3-day / 3-hourly, rain
   probability kept, no history/nowcast).
5. **Friendly errors** — raw upstream errors never reach the browser; they map
   to short human messages in the JSON `error` field.

### 2.4 Helper scripts in `backend/`

- `dev.py` — stdlib supervisor used by the sandbox: runs `app.py`, restarts it
  on crash or whenever a `.py` file changes (mtime polling every 1 s).
- `daemon_start.py` — double-fork daemonizer (`os.fork` + `os.setsid`) that
  detaches the supervisor into its own session so it survives the sandbox
  shell being torn down; redirects stdout/stderr to `service.log`.
- `package.json` — contains only `{"dev": "python3 dev.py"}` so the sandbox's
  `bun run dev` convention can start the Python service. Not needed when you
  run `python3 app.py` yourself.

---

## 3. The standalone frontend (`weather-app/frontend/`)

Plain HTML/CSS/JS, no build step, classic `<script>` tags only.

### 3.1 `index.html`

Semantic, accessible skeleton of the whole app: search combobox with ARIA
roles, °C/°F and theme radio groups, hero card, live-weather tabs (Radar /
3D world), all analysis cards, hourly + daily sections, footer, and a native
`<dialog>` for "Compare favorites". Loads the scripts in dependency order:
`leaflet.js → land-mask.js → globe-engine.js → radar-view.js → app.js`.

### 3.2 `styles.css` — the theme system

All colours flow through CSS custom properties (`--wx-bg`, `--wx-surface`,
`--wx-border`, `--wx-accent`, `--wx-font`, …) switched by
`html[data-theme="…"]`. Five choices:

- **minimal** — warm white + amber accent (`#d97706`)
- **dark** — soft midnight + amber
- **paper** — sepia editorial look, serif font
- **retro CRT** — near-black + phosphor green (`#4ade80`), monospace font,
  glow shadows and a scanline overlay
- **auto** — JS picks minimal by day / dark by night based on the *selected
  city's* sun state

Everything respects `prefers-reduced-motion` (ambient effects disabled).

### 3.3 `app.js` (~1,700 lines) — the application brain

- State + persistence in `localStorage` (`clima.sa.location`,
  `clima.sa.favorites`, `clima.sa.units`, `clima.sa.theme`).
- Renders every card: hero, alerts, insights, air quality, daylight + moon,
  wind compass, past-7-days history, rain outlook, nowcast, best-time-outside
  planner, hourly strip, 15-day list, compare dialog.
- Derived-data engines mirrored from the Next.js app: severity-ordered
  **alerts** (thunderstorm codes 95/96/99, gusts 62/90 km/h, rain 8/15 mm/24 h,
  extreme temperatures), rule-based **insights** chips, **Beaufort** scale,
  **moon phase** (synodic-month approximation).
- Ambient canvas effects (rain / snow / stars / fog / clouds / lightning) plus
  a warm "golden hour" glow near sunrise/sunset.
- Auto-refresh every 10 minutes with a visible countdown; local clock at the
  forecast location; share via Web Share API with clipboard fallback.
- A small `api()` wrapper preserves the gateway's `XTransformPort` query
  parameter when the page is served through the sandbox reverse proxy — this
  is what lets both `:5050` and the proxied preview work with one code path.

### 3.4 `globe-engine.js` — the 3D world (`window.ClimaGlobe`)

A ~700-line framework-free 3D globe drawn on a plain `<canvas>` (no three.js,
no WebGL requirement):

- Projects the 360×180 land bit grid (`land-mask.js`) onto a sphere and draws
  one dot per land cell — an orthographic dot-sphere globe.
- Every land dot is **coloured by live temperature**: inverse-distance-weighted
  (IDW) interpolation from the ~96 cities returned by `/api/globe`, using a
  9-stop colour scale from −45 °C (deep slate) to +42 °C (red).
- The **day/night terminator** is computed in real time from the sun's
  declination and hour angle (UTC), and the night side is dimmed.
- Interaction: drag to spin with inertia, wheel/button zoom, hover tooltips,
  click a city pin to load that city's forecast, `focus(lat, lon)` animation.
- `refreshTheme()` re-reads the `--wx-*` CSS variables so the globe matches
  whichever theme is active.

### 3.5 `radar-view.js` — the animated radar (`window.ClimaRadar`)

A ~360-line widget that wraps **Leaflet** and the backend's RainViewer proxy:

- Basemap: Esri gray canvas (light/dark variant follows the theme).
- RainViewer overlay frames: past 2 h + 30 min nowcast, played at 520 ms per
  frame, re-indexed every 5 minutes, up to 24 frame layers cached.
- TV-broadcast chrome: play/pause, scrubber, LIVE / FORECAST badges, rainfall
  intensity legend, opacity toggle. `setCenter(lat, lon)` follows the selected
  city.

### 3.6 `land-mask.js` and `vendor/leaflet.js`

- `land-mask.js` — generated data (see §1.8): `window.ClimaLandMask =
  { w: 360, h: 180, bits: "<base64>" }`.
- `vendor/leaflet.js` + `leaflet.css` — **Leaflet 1.9.4**, the only vendored
  third-party library, used exclusively by the radar view. Vendoring keeps the
  folder fully offline-capable and dependency-free.

---

## 4. The Next.js frontend (project root)

Next.js 16 (App Router) + React 19 + TypeScript 5, styled with Tailwind CSS 4.
The entire app lives under a single route: `src/app/page.tsx` renders
`<WeatherApp />`.

### 4.1 Libraries the weather app actually uses

| Library | How it is used |
|---|---|
| `next` | framework: App Router, `next/font/google` (Geist + Geist Mono), static `metadata` + `viewport`, `manifest.ts` for the PWA manifest |
| `react` / `react-dom` | all UI + hooks (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`); charts are hand-drawn SVG, so no charting library is needed |
| `lucide-react` | every icon in the UI (Search, Droplets, Wind, Flame, Snowflake, …) |
| `clsx` + `tailwind-merge` | the `cn()` helper (via `src/lib/utils.ts`) for conditional class names |
| `class-variance-authority` | variants inside the shadcn/ui components (toast, dialog) |
| `@radix-ui/react-dialog` | the shadcn/ui Dialog used by **Compare favorites** |
| `@radix-ui/react-toast` | the shadcn/ui Toaster used for refresh/error notifications (`use-toast`) |
| `tailwindcss` 4 (+ `tw-animate-css`) | all styling; theme tokens defined in `globals.css` |

### 4.2 Project-internal modules

- `src/lib/weather.ts` — the typed API client: `serviceUrl()` builds
  `/api/…?XTransformPort=5050` gateway URLs; `fetchWeather`, `fetchGeocode`,
  `fetchReverse`, `fetchAirQuality`, `fetchLocationSummaries` (batch),
  `fetchWorldCities` (globe); `zipHourly` / `zipPastHourly` / `zipHistory`
  convert Open-Meteo's column-oriented arrays into row objects; helpers for
  compass labels, Beaufort, hour/day formatting via `Intl.DateTimeFormat`.
- `src/lib/units.ts` — metric ↔ imperial conversions (°C↔°F, km/h↔mph,
  mm↔in) shared by every card.
- `src/lib/themes.ts` — the four themes + `auto` resolution (day/night).
- `src/lib/alerts.ts` — the same rule-based alert engine as the standalone app.
- `src/lib/insights.ts` — rule-based "today's insights" chips.
- `src/lib/moon.ts` — synodic-month moon-phase approximation.
- `src/components/weather/*` — 28 components, one per card, plus
  `weather-app.tsx` (state owner: location, favorites, units, theme,
  auto-refresh) and `live-panel.tsx`.
- `src/components/weather/live-panel.tsx` — loads the **same vanilla engines**
  (`/clima/vendor/leaflet.js`, `land-mask.js`, `globe-engine.js`,
  `radar-view.js` from `public/clima/`) at runtime via sequential script
  injection, then owns their React lifecycle (create / setCities / setTheme /
  destroy). This is the parity trick: one engine implementation, two apps.
- `public/clima/*` — verbatim copies of the standalone engines; kept in sync.
- `public/icon.svg`, `public/icon-512.png`, `public/logo.svg` — app icons
  referenced by `layout.tsx` metadata and `manifest.ts` (PWA-installable).

### 4.3 Scaffold libraries present but **not** used by Clima

The starter template ships a broad `package.json`. The weather app does not
import these, they only exist as scaffold capability: Prisma/SQLite
(`prisma/schema.prisma` still holds the demo User/Post models — all Clima
state lives in browser localStorage instead), `zustand`, `@tanstack/react-query`,
`framer-motion`, `recharts`, `next-auth`, `next-intl`, `zod`,
`react-hook-form`, `sonner`, `vaul`, `embla-carousel-react`, `dnd-kit`, etc.
Likewise `src/app/api/route.ts` ("Hello, world!") is scaffold demo code.

---

## 5. Infrastructure in the sandbox

### 5.1 The Caddy gateway (`Caddyfile`)

Only one external port is exposed (:81). Caddy routes:

- requests with `?XTransformPort=NNNN` → `localhost:NNNN` (that is how the
  Next.js frontend reaches the Python service on 5050)
- everything else → `localhost:3000` (the Next.js dev server)

This is why every frontend fetch is a **relative** URL carrying
`XTransformPort=5050` — no absolute ports ever appear in client code.

### 5.2 `tools/gen_land_mask.py`

One-off generator (stdlib: `urllib`, `json`, `base64`) that downloads Natural
Earth 110m land polygons, rasterises them onto the 360×180 grid and rewrites
`land-mask.js`. You never need to run it again unless you want finer coastlines.

---

## 6. Data storage summary

| Where | What | Lifetime |
|---|---|---|
| Browser `localStorage` | last location, favorites, unit system, theme (keys `clima.sa.*` standalone; `clima-location` / `clima-favorites` / `clima-units` / `clima-theme` Next.js) | until cleared |
| Python process memory | 15-min response cache; radar tile LRU (~6 MB); radar frame index (4 min) | process lifetime |
| `backend/.last_good/*.json` | last successful upstream payloads per key | up to 24 h, used as stale fallback |
| Upstream providers | nothing is ever sent but coordinates/queries; no accounts, no keys | — |

---

## 7. Quick runbook

```bash
# Portable folder (any machine with Python 3):
cd weather-app/backend
python3 app.py            # → http://localhost:5050

# Optional: auto-restart supervisor
python3 dev.py

# Next.js demo surface (sandbox):
bun run dev               # Next.js on :3000 (preview via gateway :81)
bun run lint              # code-quality check
```

Health checks: `GET :5050/health` (Python) and `GET /api` on the Next.js
surface return JSON status.
