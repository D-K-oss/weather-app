# Clima — Weather App



Everything the Clima weather app needs to run, consolidated in one folder —
**including the UI**. No Node.js, no build step, no dependencies: just Python 3.

```
weather-app/
├── backend/          Python weather service (port 5050) — API + serves the UI
│   ├── app.py        the whole server: static frontend + JSON API
│   ├── dev.py        optional stdlib supervisor (auto-restart on .py change)
│   ├── daemon_start.py  double-fork daemon launcher (used in the sandbox)
│   ├── package.json  only used by the sandbox `bun run dev` flow (optional)
│   └── .last_good/   disk-persisted "last good" payloads (stale fallback)
├── frontend/         the built-in UI — plain HTML/CSS/JS, zero build step
│   ├── index.html
│   ├── styles.css    4 themes: minimal · dark · paper · retro CRT (+ auto)
│   └── app.js        full feature set (see below), same as the Next.js app
├── logo.svg          the Clima logo (also served as favicon)
└── README.md         this file
```

## Run it

```bash
cd weather-app/backend
python3 app.py
```

Then open **http://localhost:5050** — the full app is served right there at `/`.

Stop with `Ctrl+C`. Nothing else to install.

## Features

- Current conditions: temperature, feels-like, humidity, wind speed + direction
  (with gusts), pressure + 3h trend, cloud cover, UV, sunrise/sunset
- **Weather alerts**: severity-ordered banner for thunderstorms, damaging
  gusts (62/90 km/h), heavy rain (8/15 mm per 24 h), extreme heat/cold
- **Today's insights**: rule-based "good to know" chips (rain timing,
  vs-yesterday, UV, wind, temperature swing, muggy, precipitation total)
- Hour-by-hour strip (48h) with rain probability bars
- **Temperature trend chart** context via the hourly strip + **rain outlook**
  (next-12h probability bars, peak marker, expected accumulation)
- **Precipitation nowcast**: observed past 6 h vs forecast next 12 h on one
  shared scale with a NOW divider
- **Best time outside**: 12-hour outdoor-comfort score strip + best-window
  recommendation chips
- **Wind compass** with Beaufort force, gusts and direction dial
- **Daylight arc** with sun position, daylight-left % and **moon phase**
- **Past 7 days** history chart (high/low range bars, rain days, week stats)
- **Air quality**: European AQI color-banded gauge + PM2.5 / PM10 / O₃ / NO₂
- **Ambient effects**: rain / snow / stars / fog / clouds / lightning + a warm
  glow near sunrise & sunset (all disabled for reduced-motion users)
- **Compare favorites**: side-by-side modal with hottest/coldest/wettest badges
- 15-day forecast with temperature range bars (3-day when running on backup data)
- City search (Open-Meteo geocoding) + "use my location" + `/` search shortcut
- Favorites: pin cities, live temps on chips, rain/wind alert dots
- Share button (native share sheet or clipboard summary)
- °C/°F, km/h ↔ mph, mm ↔ in units
- 5 theme options: Minimal, Dark, Paper, Retro CRT (scanlines + phosphor glow),
  and Auto (light by day / dark by night, based on the selected city's sun state)
- Remembers your city, favorites, units and theme (browser localStorage)
- Auto-refresh every 10 minutes with a visible countdown, local clock at the
  forecast location

## Resilience (why the app survives rate limits / outages)

Open-Meteo (free tier) is rate limited per IP; the daily quota can run out
(`HTTP 429`). The backend therefore:

1. **Caches** every upstream response for 15 minutes.
2. **Retries** with exponential backoff (honouring `Retry-After`) on 429/5xx.
3. **Serves stale data**: the last successful payload per location is stored in
   memory AND on disk (`.last_good/`); if both providers fail, up to 24h-old
   data is served marked `stale: true` (the UI shows a "saved data" banner).
   A 60s per-key cooldown prevents retry storms while the upstream is down.
4. **Falls back to wttr.in**: when Open-Meteo is quota-exhausted, forecast
   payloads are rebuilt from wttr.in (free, no key) and marked `degraded: true`
   (3-day / 3-hourly resolution, rain probability kept, no history/nowcast).
   The UI shows a "backup data" banner and the daily card becomes
   "N-day forecast (backup feed)".

Raw upstream errors never reach the UI — failures map to friendly messages.

