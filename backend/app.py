"""Clima weather mini-service (Python, standard library only).

A tiny HTTP server that proxies the free Open-Meteo APIs and adds:
  - a 15 minute in-memory cache (keeps the frontend snappy, upstream API happy)
  - automatic retry with exponential backoff (honours `Retry-After`)
  - a disk-persisted "last good" store: when the upstream is rate limited or
    unreachable, the most recent successful payload is served marked `stale`
    (up to 24h old) instead of failing the request
  - a backup provider (wttr.in, free / no key): when Open-Meteo is quota
    exhausted, forecast payloads are rebuilt from wttr.in and marked
    `degraded` (3-day / 3-hourly resolution, rain probability kept)
  - hourly arrays trimmed to the next 48 hours (lightweight payloads)
  - reverse geocoding for the browser "use my location" flow

Static frontend (self-contained, no Node/build step needed):
  GET /                       the full Clima UI (frontend/index.html)
  GET /styles.css /app.js     UI assets (served from ../frontend/)
  GET /logo.svg /favicon.svg /favicon.ico   the Clima logo

Endpoints:
  GET /health
  GET /api/weather?lat=<float>&lon=<float>
  GET /api/airquality?lat=<float>&lon=<float>
  GET /api/geocode?name=<city query>
  GET /api/reverse?lat=<float>&lon=<float>
  GET /api/batch?locs=<lat,lon;lat,lon;...>  (current temp/code/is_day per location)

Run anywhere with just Python 3:  `python3 app.py`  then open http://localhost:5050
Note: this service lives at `weather-app/backend/` (a `mini-services/weather-service`
symlink is kept for compatibility).
"""

import copy
import json
import math
import os
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError

PORT = 5050
CACHE_TTL_SECONDS = 900  # 15 minutes
STALE_MAX_SECONDS = 24 * 3600  # serve last-good data for up to 24h when upstream fails
UPSTREAM_COOLDOWN_SECONDS = 60  # after a failure, don't re-hit upstream for 60s if stale data exists
FETCH_ATTEMPTS = 4
FETCH_BACKOFF = (0.7, 1.5, 3.0)  # sleep before retry N (seconds)

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SERVICE_DIR)  # the portable weather-app folder
FRONTEND_DIR = os.path.join(PROJECT_DIR, "frontend")
LAST_GOOD_DIR = os.path.join(SERVICE_DIR, ".last_good")
LOGO_PATH = os.path.join(PROJECT_DIR, "logo.svg")

# Whitelisted static routes -> (absolute file path, content type).
# Only these exact paths are ever served from disk (no directory traversal).
STATIC_FILES = {
    "/": (os.path.join(FRONTEND_DIR, "index.html"), "text/html; charset=utf-8"),
    "/index.html": (os.path.join(FRONTEND_DIR, "index.html"), "text/html; charset=utf-8"),
    "/styles.css": (os.path.join(FRONTEND_DIR, "styles.css"), "text/css; charset=utf-8"),
    "/app.js": (os.path.join(FRONTEND_DIR, "app.js"), "text/javascript; charset=utf-8"),
    "/logo.svg": (LOGO_PATH, "image/svg+xml"),
    "/favicon.svg": (LOGO_PATH, "image/svg+xml"),
    "/favicon.ico": (LOGO_PATH, "image/svg+xml"),
}

_CACHE: dict = {}  # key -> (timestamp, payload)
_LAST_GOOD: dict = {}  # key -> (timestamp, payload)  (mirrored to disk)
_LAST_FAIL: dict = {}  # key -> timestamp of last upstream failure

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client"

WTTR_URL = "https://wttr.in/{place}?format=j1"
WTTR_UA = "curl/8.5.0"
WTTR_TIMEOUT = 20
WTTR_ATTEMPTS = 2
MAX_BATCH_LOCATIONS = 12


# ---------------------------------------------------------------------------
# Low level HTTP with retry / backoff
# ---------------------------------------------------------------------------

def fetch_json(
    url: str,
    params: dict,
    headers: dict | None = None,
    attempts: int = FETCH_ATTEMPTS,
    timeout: int = 15,
) -> dict:
    """GET JSON with retry on 429/5xx/network errors. Permanent 4xx (other than
    429) raise immediately. Honours a numeric `Retry-After` header when present."""
    query = urllib.parse.urlencode(params)
    target = f"{url}?{query}" if query else url
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                target,
                headers={
                    "User-Agent": "clima-mini-service/1.1",
                    "Accept": "application/json",
                    **(headers or {}),
                },
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            last_error = exc
            if 400 <= exc.code < 500 and exc.code != 429:
                raise  # permanent client error — retrying will not help
            if attempt >= attempts - 1:
                raise
            delay = FETCH_BACKOFF[min(attempt, len(FETCH_BACKOFF) - 1)]
            retry_after = None
            try:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
            except Exception:
                retry_after = None
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    pass
            time.sleep(min(delay, 8.0))
        except (URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt >= attempts - 1:
                raise
            time.sleep(FETCH_BACKOFF[min(attempt, len(FETCH_BACKOFF) - 1)])
    raise last_error if last_error else RuntimeError("fetch failed")  # pragma: no cover


# ---------------------------------------------------------------------------
# Cache + disk-persisted "last good" store
# ---------------------------------------------------------------------------

def cache_get(key: str):
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_SECONDS:
        return hit[1]
    return None


def cache_set(key: str, value) -> None:
    _CACHE[key] = (time.time(), value)


def _last_good_path(key: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-._" else "_" for ch in key)
    return os.path.join(LAST_GOOD_DIR, f"{safe}.json")


def _load_last_good(key: str):
    if key in _LAST_GOOD:
        return _LAST_GOOD[key]
    try:
        with open(_last_good_path(key), "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        entry = (float(stored["ts"]), stored["data"])
        if time.time() - entry[0] < STALE_MAX_SECONDS:
            _LAST_GOOD[key] = entry
            return entry
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def _store_last_good(key: str, data) -> None:
    entry = (time.time(), copy.deepcopy(data))
    _LAST_GOOD[key] = entry
    try:
        os.makedirs(LAST_GOOD_DIR, exist_ok=True)
        path = _last_good_path(key)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"ts": entry[0], "data": entry[1]}, fh)
        os.replace(tmp, path)
    except OSError:
        pass  # disk persistence is best-effort only


def _stale_payload(entry) -> dict:
    data = copy.deepcopy(entry[1])
    data["stale"] = True
    data["stale_minutes"] = max(1, int((time.time() - entry[0]) / 60))
    return data


def fetch_with_fallback(key: str, build):
    """Return cached/fresh data; when the upstream fails serve the last good
    payload (memory or disk, marked `stale`) for up to 24h. A 60s cooldown per
    key prevents retry storms while the upstream is known-bad. Raises when no
    usable fallback exists."""
    cached = cache_get(key)
    if cached is not None:
        return cached

    last_good = _load_last_good(key)
    now = time.time()
    if last_good is not None and (now - _LAST_FAIL.get(key, 0)) < UPSTREAM_COOLDOWN_SECONDS:
        return _stale_payload(last_good)  # in cooldown: don't touch the upstream

    try:
        data = build()
    except Exception:
        _LAST_FAIL[key] = time.time()
        if last_good is not None and now - last_good[0] < STALE_MAX_SECONDS:
            return _stale_payload(last_good)
        raise
    _LAST_FAIL.pop(key, None)
    _store_last_good(key, data)
    cache_set(key, data)
    return data


# ---------------------------------------------------------------------------
# Open-Meteo primary provider
# ---------------------------------------------------------------------------

def _open_meteo_forecast(lat: float, lon: float) -> dict:
    return fetch_json(
        FORECAST_URL,
        {
            "latitude": lat,
            "longitude": lon,
            "current": ",".join(
                [
                    "temperature_2m",
                    "apparent_temperature",
                    "relative_humidity_2m",
                    "is_day",
                    "precipitation",
                    "weather_code",
                    "cloud_cover",
                    "pressure_msl",
                    "wind_speed_10m",
                    "wind_direction_10m",
                    "wind_gusts_10m",
                ]
            ),
            "hourly": ",".join(
                [
                    "temperature_2m",
                    "apparent_temperature",
                    "relative_humidity_2m",
                    "precipitation_probability",
                    "precipitation",
                    "weather_code",
                    "wind_speed_10m",
                    "wind_direction_10m",
                    "pressure_msl",
                    "is_day",
                ]
            ),
            "daily": ",".join(
                [
                    "weather_code",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "apparent_temperature_max",
                    "apparent_temperature_min",
                    "sunrise",
                    "sunset",
                    "precipitation_probability_max",
                    "precipitation_sum",
                    "wind_speed_10m_max",
                    "wind_direction_10m_dominant",
                    "uv_index_max",
                ]
            ),
            "timezone": "auto",
            "forecast_days": 16,
            "past_days": 7,  # past week for the history chart + yesterday comparison
            "wind_speed_unit": "kmh",
        },
    )


def _postprocess_forecast(data: dict) -> dict:
    """Shared shaping for Open-Meteo AND fallback payloads: pressure trend,
    past-hourly capture + 48h trim, history/yesterday split."""
    # Pressure trend: compare the current hour with 3 hours earlier
    # (hourly arrays include past days because of past_days=7).
    data["pressure_trend"] = None
    try:
        current_hour = str(data["current"]["time"])[:13]
        times = [str(t) for t in data["hourly"]["time"]]
        now_index = next(i for i, stamp in enumerate(times) if stamp[:13] >= current_hour)
        past_index = now_index - 3
        if past_index >= 0:
            now_p = data["hourly"]["pressure_msl"][now_index]
            past_p = data["hourly"]["pressure_msl"][past_index]
            if now_p is not None and past_p is not None:
                data["pressure_trend"] = {
                    "delta": round(float(now_p) - float(past_p), 1),
                    "hours": 3,
                }
    except (KeyError, TypeError, ValueError, StopIteration):
        data["pressure_trend"] = None

    # Trim hourly arrays to the next 48 hours starting from "now", but first
    # capture the 6 hours BEFORE now (observed) for the precipitation nowcast.
    try:
        current_hour = str(data["current"]["time"])[:13]  # e.g. 2025-11-16T14
        times = data["hourly"]["time"]
        start = 0
        for index, stamp in enumerate(times):
            if str(stamp)[:13] >= current_hour:
                start = index
                break
        past_start = max(0, start - 6)
        data["past_hourly"] = {
            field: values[past_start:start] for field, values in data["hourly"].items()
        }
        end = min(start + 48, len(times))
        for field in list(data["hourly"].keys()):
            data["hourly"][field] = data["hourly"][field][start:end]
    except (KeyError, TypeError, ValueError):
        data["past_hourly"] = None  # keep the full payload if trimming fails for any reason

    # Split the daily arrays into: history (past 7 days, oldest first),
    # yesterday (last history day, kept for day-over-day comparison) and
    # the today-first 15-day forecast. Frontend consumes all three.
    data["history"] = []
    data["yesterday"] = None
    try:
        today = str(data["current"]["time"])[:10]
        daily = data["daily"]
        today_index = next(
            (i for i, stamp in enumerate(daily["time"]) if str(stamp)[:10] >= today), 0
        )
        past_fields = [field for field in daily if field != "time"]
        history = [
            {field: daily[field][i] for field in daily}
            for i in range(max(0, today_index - 7), today_index)
        ]
        data["history"] = history
        data["yesterday"] = history[-1] if history else None
        for field in past_fields:
            daily[field] = daily[field][today_index : today_index + 15]
        daily["time"] = daily["time"][today_index : today_index + 15]
    except (KeyError, TypeError, ValueError):
        data["history"] = []
        data["yesterday"] = None  # keep full payload if anything goes sideways

    return data


# ---------------------------------------------------------------------------
# wttr.in backup provider (used when Open-Meteo is quota exhausted / down)
# ---------------------------------------------------------------------------

# WWO weather codes (wttr.in) -> WMO codes (Open-Meteo convention)
_WWO_TO_WMO = {
    0: 0, 113: 0, 116: 2, 119: 3, 122: 3, 143: 45, 176: 61, 179: 71, 182: 66,
    185: 66, 200: 95, 227: 71, 230: 75, 248: 45, 260: 45, 263: 51, 266: 51,
    281: 56, 284: 56, 293: 61, 296: 61, 299: 63, 302: 63, 305: 65, 308: 65,
    311: 66, 314: 67, 317: 68, 320: 68, 323: 71, 326: 71, 329: 73, 332: 73,
    335: 75, 338: 75, 350: 79, 362: 68, 365: 68, 368: 85, 371: 86, 374: 79,
    377: 79, 386: 95, 389: 95, 392: 95, 395: 95,
}


def _wmo_code(wwt_code) -> int:
    try:
        return _WWO_TO_WMO.get(int(wwt_code), 3)
    except (TypeError, ValueError):
        return 3


def _parse_ampm(text: str) -> str:
    """'06:36 AM' -> '06:36', '07:42 PM' -> '19:42'."""
    try:
        parsed = datetime.strptime(str(text).strip().upper(), "%I:%M %p")
        return parsed.strftime("%H:%M")
    except ValueError:
        return "06:00" if "AM" in str(text).upper() else "18:00"


def _dst_last_sunday(year: int, month: int) -> date:
    day = date(year, month, 28)  # safe anchor inside every month
    while (day + timedelta(days=1)).month == month:
        day += timedelta(days=1)
    while day.weekday() != 6:  # Sunday
        day -= timedelta(days=1)
    return day


def _dst_nth_sunday(year: int, month: int, nth: int) -> date:
    day = date(year, month, 1)
    day += timedelta(days=(6 - day.weekday()) % 7)  # first Sunday
    return day + timedelta(days=7 * (nth - 1))


def _dst_active_eu(day: date) -> bool:
    return _dst_last_sunday(day.year, 3) <= day < _dst_last_sunday(day.year, 10)


def _dst_active_us(day: date) -> bool:
    start = _dst_nth_sunday(day.year, 3, 2)
    end = _dst_nth_sunday(day.year, 11, 1)
    return start <= day < end


def _dst_active_au(day: date) -> bool:
    return day >= _dst_nth_sunday(day.year, 10, 1) or day < _dst_nth_sunday(day.year, 4, 1)


def _guess_utc_offset(lat: float, lon: float, when: datetime) -> float:
    """Best-effort UTC offset (hours) for coordinates without a tz database.
    Longitude zones + regional fixes + EU/US/AU daylight-saving windows."""
    base = round(lon / 15)
    # Regional fixes for zones that ignore pure-longitude math:
    if 63 <= lat <= 67 and -26 <= lon <= -11:
        return 0.0  # Iceland stays on UTC
    if 5 <= lat <= 36 and 65 <= lon <= 90:
        return 5.5  # India + Sri Lanka
    if 10 <= lat <= 29 and 92 <= lon <= 102:
        return 6.5  # Myanmar
    if -10 <= lat <= 5 and 96 <= lon <= 107:
        return 8.0  # Singapore / Malaysia
    local_day = (when + timedelta(hours=base)).date()
    if 35 <= lat <= 72 and -12 <= lon <= 32 and _dst_active_eu(local_day):
        base += 1
    elif 24 <= lat <= 60 and -130 <= lon <= -60 and _dst_active_us(local_day):
        base += 1
    elif -45 <= lat <= -32 and 130 <= lon <= 154 and _dst_active_au(local_day):
        base += 1
    return float(base)


_HALF_HOUR_TZ = {
    5.5: "Asia/Kolkata",
    6.5: "Asia/Yangon",
    9.5: "Australia/Darwin",
    3.5: "Asia/Tehran",
    4.5: "Asia/Kabul",
    5.75: "Asia/Kathmandu",
    -3.5: "America/St_Johns",
}


def _tz_name(offset_hours: float) -> str:
    if offset_hours == int(offset_hours):
        hours = int(offset_hours)
        if hours == 0:
            return "UTC"
        # IANA Etc zones invert the sign: Etc/GMT-2 == UTC+2
        return f"Etc/GMT-{hours}" if hours > 0 else f"Etc/GMT+{-hours}"
    return _HALF_HOUR_TZ.get(offset_hours, "UTC")


def _wttr_fetch(place: str) -> dict:
    return fetch_json(
        WTTR_URL.format(place=urllib.parse.quote(place)),
        {},
        headers={"User-Agent": WTTR_UA},
        attempts=WTTR_ATTEMPTS,
        timeout=WTTR_TIMEOUT,
    )


def _wttr_sun_minutes(day: dict) -> tuple[int, int]:
    """(sunrise_minutes, sunset_minutes) from a wttr weather[day]['astronomy'] row."""
    astro = (day.get("astronomy") or [{}])[0]
    sr, ss = _parse_ampm(astro.get("sunrise", "06:00")), _parse_ampm(astro.get("sunset", "18:00"))
    return int(sr[:2]) * 60 + int(sr[3:5]), int(ss[:2]) * 60 + int(ss[3:5])


def _wttr_is_day(day: dict, local_minutes: int) -> int:
    sunrise, sunset = _wttr_sun_minutes(day)
    return 1 if sunrise <= local_minutes <= sunset else 0


def _wttr_forecast(lat: float, lon: float) -> dict:
    """Rebuild an Open-Meteo-shaped payload from wttr.in (3-day / 3-hourly).
    Times are already location-local; the UTC offset comes from a longitude
    + DST heuristic (good enough for a backup feed)."""
    raw = _wttr_fetch(f"{lat:.4f},{lon:.4f}")
    now_utc = datetime.now(timezone.utc)
    offset = _guess_utc_offset(lat, lon, now_utc)
    now_local = now_utc + timedelta(hours=offset)
    local_now_str = now_local.strftime("%Y-%m-%dT%H:%M")
    current_hour_str = local_now_str[:13]

    days = raw.get("weather") or []
    if not days:
        raise ValueError("wttr.in returned no forecast days")

    # --- hourly (3-hourly steps, trimmed to the next 48h) -------------------
    hourly = {
        "time": [], "temperature_2m": [], "apparent_temperature": [],
        "relative_humidity_2m": [], "precipitation_probability": [],
        "precipitation": [], "weather_code": [], "wind_speed_10m": [],
        "wind_direction_10m": [], "pressure_msl": [], "is_day": [],
    }
    for day in days:
        day_date = str(day.get("date", ""))
        for slot in day.get("hourly") or []:
            hhmm = str(slot.get("time", "0")).zfill(4)
            iso = f"{day_date}T{hhmm[:2]}:{hhmm[2:4]}"
            if iso[:13] < current_hour_str:
                continue  # skip past slots (today)
            if len(hourly["time"]) >= 48:
                break
            wind = float(slot.get("windspeedKmph") or 0)
            gust = slot.get("WindGustKmph")
            minutes = int(hhmm[:2]) * 60 + int(hhmm[2:4])
            hourly["time"].append(iso)
            hourly["temperature_2m"].append(float(slot.get("tempC") or 0))
            hourly["apparent_temperature"].append(float(slot.get("FeelsLikeC") or 0))
            hourly["relative_humidity_2m"].append(float(slot.get("humidity") or 0))
            hourly["precipitation_probability"].append(float(slot.get("chanceofrain") or 0))
            hourly["precipitation"].append(float(slot.get("precipMM") or 0))
            hourly["weather_code"].append(_wmo_code(slot.get("weatherCode")))
            hourly["wind_speed_10m"].append(wind)
            hourly["wind_direction_10m"].append(float(slot.get("winddirDegree") or 0))
            hourly["pressure_msl"].append(float(slot.get("pressure") or 0))
            hourly["is_day"].append(_wttr_is_day(day, minutes))
        if len(hourly["time"]) >= 48:
            break

    # --- daily (up to 3 days) ------------------------------------------------
    daily = {
        "time": [], "weather_code": [], "temperature_2m_max": [], "temperature_2m_min": [],
        "apparent_temperature_max": [], "apparent_temperature_min": [], "sunrise": [],
        "sunset": [], "precipitation_probability_max": [], "precipitation_sum": [],
        "wind_speed_10m_max": [], "wind_direction_10m_dominant": [], "uv_index_max": [],
    }
    for day in days:
        slots = day.get("hourly") or []
        if not slots:
            continue
        temps = [float(s.get("tempC") or 0) for s in slots]
        feels = [float(s.get("FeelsLikeC") or 0) for s in slots]
        probs = [float(s.get("chanceofrain") or 0) for s in slots]
        rains = [float(s.get("precipMM") or 0) for s in slots]
        winds = [float(s.get("windspeedKmph") or 0) for s in slots]
        wettest = max(range(len(slots)), key=lambda i: rains[i])
        midday = next((i for i, s in enumerate(slots) if str(s.get("time", "0")).zfill(4) >= "1200"), 0)
        dominant = max(range(len(slots)), key=lambda i: winds[i])
        sr_min, ss_min = _wttr_sun_minutes(day)
        sunrise = f"{day.get('date')}T{sr_min // 60:02d}:{sr_min % 60:02d}"
        sunset = f"{day.get('date')}T{ss_min // 60:02d}:{ss_min % 60:02d}"
        daily["time"].append(str(day.get("date")))
        daily["weather_code"].append(_wmo_code(slots[wettest].get("weatherCode")) if max(rains) > 0.2 else _wmo_code(slots[midday].get("weatherCode")))
        daily["temperature_2m_max"].append(float(day.get("maxtempC") or max(temps)))
        daily["temperature_2m_min"].append(float(day.get("mintempC") or min(temps)))
        daily["apparent_temperature_max"].append(max(feels))
        daily["apparent_temperature_min"].append(min(feels))
        daily["sunrise"].append(sunrise)
        daily["sunset"].append(sunset)
        daily["precipitation_probability_max"].append(max(probs))
        daily["precipitation_sum"].append(round(sum(rains), 1))
        daily["wind_speed_10m_max"].append(max(winds))
        daily["wind_direction_10m_dominant"].append(float(slots[dominant].get("winddirDegree") or 0))
        daily["uv_index_max"].append(float(day.get("uvIndex")) if day.get("uvIndex") is not None else None)

    # --- current -------------------------------------------------------------
    cc = (raw.get("current_condition") or [{}])[0]
    now_minutes = now_local.hour * 60 + now_local.minute
    wind_now = float(cc.get("windspeedKmph") or 0)
    today_local = local_now_str[:10]
    today_row = next((d for d in days if str(d.get("date")) == today_local), days[0])
    current = {
        "time": local_now_str,
        "temperature_2m": float(cc.get("temp_C") or 0),
        "apparent_temperature": float(cc.get("FeelsLikeC") or 0),
        "relative_humidity_2m": float(cc.get("humidity") or 0),
        "is_day": _wttr_is_day(today_row, now_minutes),
        "precipitation": float(cc.get("precipMM") or 0),
        "weather_code": _wmo_code(cc.get("weatherCode")),
        "cloud_cover": float(cc.get("cloudcover") or 0),
        "pressure_msl": float(cc.get("pressure") or 1013),
        "wind_speed_10m": wind_now,
        "wind_direction_10m": float(cc.get("winddirDegree") or 0),
        "wind_gusts_10m": round(wind_now * 1.5, 1),
    }

    return {
        "latitude": lat,
        "longitude": lon,
        "timezone": _tz_name(offset),
        "utc_offset_seconds": int(offset * 3600),
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "source": "wttr-in",
        "degraded": True,
    }


def _wttr_summary(lat: float, lon: float) -> dict:
    """Compact per-location summary for /api/batch from wttr.in."""
    raw = _wttr_fetch(f"{lat:.4f},{lon:.4f}")
    cc = (raw.get("current_condition") or [{}])[0]
    days = raw.get("weather") or [{}]
    today = days[0]
    slots = today.get("hourly") or [{}]
    now_utc = datetime.now(timezone.utc)
    offset = _guess_utc_offset(lat, lon, now_utc)
    now_local = now_utc + timedelta(hours=offset)
    wind_now = float(cc.get("windspeedKmph") or 0)
    return {
        "latitude": lat,
        "longitude": lon,
        "temperature_2m": float(cc.get("temp_C") or 0),
        "weather_code": _wmo_code(cc.get("weatherCode")),
        "is_day": _wttr_is_day(today, now_local.hour * 60 + now_local.minute),
        "precip_prob_max": max((float(s.get("chanceofrain") or 0) for s in slots), default=None),
        "precip_sum": round(sum(float(s.get("precipMM") or 0) for s in slots), 1),
        "wind_gust_max": max(
            (float(s.get("WindGustKmph") or 0) for s in slots), default=round(wind_now * 1.5, 1)
        ),
    }


# ---------------------------------------------------------------------------
# Public getters (cache + retry + fallbacks)
# ---------------------------------------------------------------------------

def get_weather(lat: float, lon: float) -> dict:
    key = f"weather:{round(lat, 2)}:{round(lon, 2)}"

    def build() -> dict:
        try:
            data = _open_meteo_forecast(lat, lon)
        except Exception as primary_error:
            try:
                data = _wttr_forecast(lat, lon)  # backup provider
            except Exception:
                raise primary_error  # report the primary (Open-Meteo) failure
        return _postprocess_forecast(data)

    return fetch_with_fallback(key, build)


def get_air_quality(lat: float, lon: float) -> dict:
    key = f"aq:{round(lat, 2)}:{round(lon, 2)}"

    def build() -> dict:
        return fetch_json(
            AIR_QUALITY_URL,
            {
                "latitude": lat,
                "longitude": lon,
                "current": ",".join(
                    [
                        "european_aqi",
                        "pm10",
                        "pm2_5",
                        "carbon_monoxide",
                        "nitrogen_dioxide",
                        "sulphur_dioxide",
                        "ozone",
                        "dust",
                        "uv_index",
                    ]
                ),
                "timezone": "auto",
            },
        )

    return fetch_with_fallback(key, build)


def geocode(name: str) -> dict:
    key = f"geocode:{name.strip().lower()}"

    def build() -> dict:
        data = fetch_json(GEOCODE_URL, {"name": name, "count": 8, "language": "en", "format": "json"})
        results = [
            {
                "name": item.get("name"),
                "admin1": item.get("admin1"),
                "country": item.get("country"),
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
                "timezone": item.get("timezone"),
                "population": item.get("population"),
            }
            for item in data.get("results", [])
        ]
        return {"results": results}

    return fetch_with_fallback(key, build)


def get_batch_summaries(locations: list) -> dict:
    """Current temperature / weather code / is_day for up to 12 locations in ONE
    upstream request (Open-Meteo accepts comma-separated coordinates).
    Used for the live temperature badges on the favorite-city chips.
    Falls back to per-location wttr.in requests when Open-Meteo fails."""
    key = (
        "batch:"
        + ",".join(f"{round(lat, 2)}_{round(lon, 2)}" for lat, lon in sorted(locations))
    )

    def _summaries_from_open_meteo() -> list[dict]:
        data = fetch_json(
            FORECAST_URL,
            {
                "latitude": ",".join(str(lat) for lat, _ in locations),
                "longitude": ",".join(str(lon) for _, lon in locations),
                "current": "temperature_2m,weather_code,is_day",
                # Today's extremes power the alert dots on the favorite chips.
                "daily": "precipitation_probability_max,precipitation_sum,wind_gusts_10m_max",
                "forecast_days": 1,
                "timezone": "auto",
            },
        )
        # Multi-location requests return a JSON array; a single one returns an object.
        rows = data if isinstance(data, list) else [data]
        summaries = []
        for (lat, lon), row in zip(locations, rows):
            current = (row or {}).get("current") or {}
            daily = (row or {}).get("daily") or {}

            def _today(field: str):
                values = daily.get(field)
                return (values or [None])[0] if isinstance(values, list) else None

            summaries.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "temperature_2m": current.get("temperature_2m"),
                    "weather_code": current.get("weather_code"),
                    "is_day": current.get("is_day"),
                    "precip_prob_max": _today("precipitation_probability_max"),
                    "precip_sum": _today("precipitation_sum"),
                    "wind_gust_max": _today("wind_gusts_10m_max"),
                }
            )
        return summaries

    def _summaries_from_wttr() -> list[dict]:
        with ThreadPoolExecutor(max_workers=6) as pool:
            rows = list(pool.map(lambda pair: _wttr_summary(pair[0], pair[1]), locations))
        return rows

    def build() -> dict:
        try:
            summaries = _summaries_from_open_meteo()
        except Exception:
            summaries = _summaries_from_wttr()  # backup provider, per-location
        return {"summaries": summaries}

    return fetch_with_fallback(key, build)


def reverse_geocode(lat: float, lon: float) -> dict:
    try:
        data = fetch_json(
            REVERSE_URL,
            {"latitude": lat, "longitude": lon, "localityLanguage": "en"},
        )
        city = data.get("city") or data.get("locality") or data.get("principalSubdivision")
        return {
            "name": city or "My location",
            "admin1": data.get("principalSubdivision"),
            "country": data.get("countryName"),
        }
    except Exception:
        return {"name": "My location", "admin1": None, "country": None}


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "ClimaMini/1.2"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")  # tiny local files: always revalidate
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path: str, query: str) -> bool:
        """Serve the bundled frontend. Returns False when `path` is not a static route."""
        route = STATIC_FILES.get(path)
        if route is None:
            return False
        file_path, content_type = route
        try:
            with open(file_path, "rb") as fh:
                body = fh.read()
        except OSError:
            self._send(404, {"error": f"Static asset missing: {path} (frontend/ folder incomplete?)"})
            return True
        # When reached through a reverse proxy that routes by the XTransformPort
        # query parameter, keep that parameter on relative asset URLs too.
        if content_type.startswith("text/html") and "xtransformport" in query.lower():
            try:
                port = urllib.parse.parse_qs(query).get("XTransformPort", ["5050"])[0]
                html = body.decode("utf-8")
                for asset in ("styles.css", "app.js", "logo.svg"):
                    html = html.replace(f'{asset}"', f'{asset}?XTransformPort={port}"')
                body = html.encode("utf-8")
            except (UnicodeDecodeError, ValueError):
                pass  # serve the raw file instead
        self._send_bytes(200, body, content_type)
        return True

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming convention
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        def first(name: str, default: str = "") -> str:
            return params.get(name, [default])[0]

        try:
            if self._serve_static(parsed.path, parsed.query):
                return
            if parsed.path == "/health":
                self._send(200, {"status": "ok", "service": "clima-python", "port": PORT})
            elif parsed.path == "/api/weather":
                self._send(200, get_weather(float(first("lat")), float(first("lon"))))
            elif parsed.path == "/api/airquality":
                self._send(200, get_air_quality(float(first("lat")), float(first("lon"))))
            elif parsed.path == "/api/geocode":
                name = first("name").strip()
                if not name:
                    self._send(400, {"error": "Query parameter 'name' is required."})
                else:
                    self._send(200, geocode(name))
            elif parsed.path == "/api/reverse":
                self._send(200, reverse_geocode(float(first("lat")), float(first("lon"))))
            elif parsed.path == "/api/batch":
                raw = first("locs").strip()
                if not raw:
                    self._send(400, {"error": "Query parameter 'locs' is required."})
                    return
                locations = []
                for chunk in raw.split(";"):
                    parts = chunk.split(",")
                    if len(parts) != 2:
                        raise ValueError(f"Malformed location '{chunk}'")
                    locations.append((float(parts[0]), float(parts[1])))
                if not locations:
                    self._send(400, {"error": "No locations provided."})
                    return
                locations = locations[:MAX_BATCH_LOCATIONS]
                self._send(200, get_batch_summaries(locations))
            else:
                self._send(404, {"error": "Not found."})
        except (ValueError, KeyError, IndexError) as exc:
            self._send(400, {"error": f"Bad request: {exc}"})
        except HTTPError as exc:
            if exc.code == 429:
                self._send(
                    503,
                    {
                        "error": "The weather provider is rate limiting us right now. "
                        "Please try again in a minute.",
                        "code": "rate_limited",
                    },
                )
            else:
                self._send(
                    502,
                    {
                        "error": f"The weather provider rejected the request (HTTP {exc.code}).",
                        "code": "upstream_error",
                    },
                )
        except (URLError, TimeoutError, ConnectionError, OSError):
            self._send(
                502,
                {
                    "error": "The weather provider is temporarily unreachable. "
                    "Please try again shortly.",
                    "code": "upstream_unreachable",
                },
            )
        except Exception as exc:  # unexpected — keep a short, readable message
            self._send(
                502,
                {"error": f"Unexpected service error: {exc}", "code": "internal_error"},
            )

    def log_message(self, fmt: str, *args) -> None:
        print(f"[clima:{PORT}] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"Clima Python weather service listening on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
