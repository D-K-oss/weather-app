/* ============================================================
   Clima — standalone weather app front-end (no build step).
   Talks to the Python service in ../backend/app.py (same origin).
   ============================================================ */
(function () {
  "use strict";

  /* ---------- gateway passthrough (sandbox preview only) ----------
     When this page is served through a reverse proxy that carries an
     XTransformPort query parameter, API calls must keep that parameter. */
  var GW_PORT = new URLSearchParams(location.search).get("XTransformPort");
  function api(path) {
    if (!GW_PORT) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "XTransformPort=" + encodeURIComponent(GW_PORT);
  }

  /* ---------- constants + storage ---------- */
  var DEFAULT_LOCATION = { name: "Rome", admin1: "Lazio", country: "Italy", latitude: 41.9028, longitude: 12.4964 };
  var REFRESH_MS = 10 * 60 * 1000;
  var MAX_FAVORITES = 12;
  var LS = { loc: "clima.sa.location", favs: "clima.sa.favorites", units: "clima.sa.units", theme: "clima.sa.theme" };
  var FILE_HINT = "You opened this file directly from disk. Start the server first: run “python3 app.py” inside the backend folder, then open http://localhost:5050";

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /* ---------- state ---------- */
  var state = {
    location: lsGet(LS.loc, null) || DEFAULT_LOCATION,
    units: lsGet(LS.units, "metric"),
    theme: lsGet(LS.theme, "auto"),
    favorites: lsGet(LS.favs, []),
    data: null,
    aqi: null,
    updated: null,
    seq: 0,
    dismissedAlerts: {},      // alert id -> true (reset on every successful load)
    compareSeq: 0,
    compareCache: {},         // locKey -> WeatherData | null (null = failed)
  };

  var REDUCED_MOTION = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- tiny dom helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- svg icon library (stroke = currentColor) ---------- */
  function svg(inner, size, cls) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="' + (cls || "") + '">' + inner + "</svg>";
  }
  var SUN_CORE = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON_PATH = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var CLOUD_PATH = '<path d="M17.5 19a4.5 4.5 0 0 0 .3-9A7 7 0 1 0 6.3 16.6"/>';
  var MINI_SUN = '<circle cx="8" cy="8" r="3"/><path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.2 4.2l1 1M10.8 10.8l1 1M10.8 5.2l1-1M4.2 11.8l1-1"/>';
  var MINI_MOON = '<path d="M15.5 9a6.5 6.5 0 1 1-6-8 5 5 0 0 0 6 8z"/>';
  var ICONS = {
    sun: SUN_CORE,
    moon: MOON_PATH,
    "cloud-sun": MINI_SUN + CLOUD_PATH,
    "cloud-moon": MINI_MOON + CLOUD_PATH,
    cloud: CLOUD_PATH,
    cloudy: '<path d="M17.5 19a4.5 4.5 0 0 0 .3-9A7 7 0 1 0 6.3 16.6"/><path d="M6.5 19h11"/>' ,
    fog: CLOUD_PATH + '<path d="M4 14h16M6 18h12"/>',
    drizzle: CLOUD_PATH + '<path d="M8 19v1M12 18.5v1M16 19v1"/>',
    rain: CLOUD_PATH + '<path d="M8 19l-1 2M12 18.5l-1 2.5M16 19l-1 2"/>',
    snow: CLOUD_PATH + '<path d="M8 19h.01M12 19.5h.01M16 19h.01M10 21.5h.01M14 21.5h.01"/>',
    lightning: '<path d="M17.5 14a4.5 4.5 0 0 0 .3-9A7 7 0 1 0 6.3 11.6"/><path d="M13 12l-3 5h4l-3 5"/>',
    hail: CLOUD_PATH + '<circle cx="8.5" cy="19.5" r=".9" fill="currentColor" stroke="none"/><circle cx="12.5" cy="20.5" r=".9" fill="currentColor" stroke="none"/><circle cx="16.5" cy="19.5" r=".9" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    star: '<path d="M11.5 3.2a.6.6 0 0 1 1 0l2.6 5.2 5.8.9a.6.6 0 0 1 .3 1l-4.2 4.1 1 5.8a.6.6 0 0 1-.8.6l-5.2-2.7-5.2 2.7a.6.6 0 0 1-.8-.6l1-5.8L2.8 10.3a.6.6 0 0 1 .3-1l5.8-.9z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    droplet: '<path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"/>',
    wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2"/>',
    gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M13.4 10.6 19 5"/><path d="M3.3 17a9 9 0 1 1 17.4 0"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    umbrella: '<path d="M22 12a10 10 0 0 0-20 0Z"/><path d="M12 12v7a2 2 0 0 0 4 0"/>',
    sunrise: '<path d="M12 2v6M4.9 10.9l1.4 1.4M2 18h2M20 18h2M17.7 12.3l1.4-1.4M22 22H2M8 6l4-4 4 4M9 18h6"/>',
    sunset: '<path d="M12 10V2M4.9 10.9l1.4 1.4M2 18h2M20 18h2M17.7 12.3l1.4-1.4M22 22H2M16 6l-4 4-4-4M9 18h6"/>',
    thermo: '<path d="M14 4a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0z"/>',
    arrow: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    snowflake: '<path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07 19.07 4.93"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
    compare: '<path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    palm: '<path d="M13 8c1.5-2 4-3.5 6.5-3.5.5 2-.5 4-2 5"/><path d="M13 8c-1.5-2-4-3.5-6.5-3.5-.5 2 .5 4 2 5"/><path d="M13 8c.5-2.5 2-4.5 4.5-5.5"/><path d="M12 10c0 4-1 8-4 12"/><path d="M12 10c0 4 1 8 4 12"/><path d="M8 21.5c1-1.5 2.5-2 4-2s3 .5 4 2"/>',
    radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62a10 10 0 1 0 19.02-1.27"/><path d="M16.24 7.76a6 6 0 1 0-8.01 8.91"/><path d="M12 18h.01"/><path d="M17.99 11.66a6 6 0 0 1-2.22 4.75"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  };
  function icon(name, size) { return svg(ICONS[name] || ICONS.cloud, size || 20); }

  /* ---------- WMO weather codes (same mapping as the main app) ---------- */
  function weatherInfo(code, isDay) {
    var map = {
      0: ["Clear sky", isDay ? "sun" : "moon"],
      1: ["Mainly clear", isDay ? "cloud-sun" : "cloud-moon"],
      2: ["Partly cloudy", isDay ? "cloud-sun" : "cloud-moon"],
      3: ["Overcast", "cloudy"],
      45: ["Fog", "fog"], 48: ["Fog", "fog"],
      51: ["Light drizzle", "drizzle"], 53: ["Drizzle", "drizzle"], 55: ["Heavy drizzle", "drizzle"],
      56: ["Freezing drizzle", "drizzle"], 57: ["Freezing drizzle", "drizzle"],
      61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"],
      66: ["Freezing rain", "rain"], 67: ["Freezing rain", "rain"],
      71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"], 77: ["Snow grains", "snow"],
      80: ["Light showers", "rain"], 81: ["Rain showers", "rain"], 82: ["Violent showers", "rain"],
      85: ["Snow showers", "snow"], 86: ["Snow showers", "snow"],
      95: ["Thunderstorm", "lightning"],
      96: ["Storm with hail", "hail"], 99: ["Storm with hail", "hail"],
    };
    var row = map[code] || ["Unknown", "cloud"];
    return { label: row[0], icon: row[1] };
  }

  /* ---------- units + formatting ---------- */
  function convTemp(c) { return state.units === "imperial" ? c * 9 / 5 + 32 : c; }
  function tempUnit() { return state.units === "imperial" ? "°F" : "°C"; }
  function fmtTemp(c, withUnit) {
    if (c == null) return "—";
    var v = Math.round(convTemp(c));
    return withUnit ? v + "°" + (withUnit === true ? "" : tempUnit()) : v + "°";
  }
  function fmtSpeed(kmh) {
    if (kmh == null) return "—";
    return state.units === "imperial" ? Math.round(kmh / 1.609344) + " mph" : Math.round(kmh) + " km/h";
  }
  function fmtAmount(mm) {
    if (mm == null) return "—";
    if (state.units === "imperial") {
      var inches = mm / 25.4;
      return (inches > 0 && inches < 0.1 ? inches.toFixed(2) : inches.toFixed(2)) + " in";
    }
    return (mm >= 10 ? Math.round(mm) : Number(mm).toFixed(1)) + " mm";
  }
  function fmtPressure(hpa) {
    if (hpa == null) return "—";
    return state.units === "imperial" ? (hpa * 0.02953).toFixed(2) + " inHg" : Math.round(hpa) + " hPa";
  }
  var COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function compass(deg) {
    if (deg == null) return "";
    return COMPASS[Math.round(deg / 22.5) % 16];
  }
  function uvLabel(uv) {
    if (uv == null) return "—";
    return Number(uv).toFixed(0) + " · " + (uv < 3 ? "Low" : uv < 6 ? "Moderate" : uv < 8 ? "High" : uv < 11 ? "Very high" : "Extreme");
  }
  /* location-local ISO strings ("2025-11-16T14:00") — parse by hand, never via Date(iso) */
  function hourLabel(iso, first) { return first ? "Now" : iso.slice(11, 13) + ":00"; }
  function hm(iso) { return iso ? iso.slice(11, 16) : "—"; }
  function weekday(dateStr, index) {
    if (index === 0) return "Today";
    if (index === 1) return "Tomorrow";
    var p = dateStr.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  function dateLabel(dateStr) {
    var p = dateStr.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function weekdayName(dateStr) {
    var p = dateStr.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString(undefined, { weekday: "short" });
  }

  /* ---------- round-13 shared helpers (ports from the Next.js libs) ---------- */
  function convWind(kmh) { return state.units === "imperial" ? kmh / 1.609344 : kmh; }
  function windUnit() { return state.units === "imperial" ? "mph" : "km/h"; }
  function convPrecip(mm) { return state.units === "imperial" ? mm / 25.4 : mm; }
  function precipUnit() { return state.units === "imperial" ? "in" : "mm"; }
  function precipLabel(mm) {
    // Match the Next.js formatting: round to 2 decimals but drop trailing zeros ("0", "0.35", "10.5")
    return String(Math.round(convPrecip(mm || 0) * 100) / 100);
  }
  function isoMinutes(iso) {
    var s = String(iso || "");
    var h = Number(s.slice(11, 13)), m = Number(s.slice(14, 16));
    if (isNaN(h) || isNaN(m)) return 0;
    return h * 60 + m;
  }
  function fmtMinutes(mins) {
    var h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return h + "h " + String(m).padStart(2, "0") + "m";
  }
  var BEAUFORT = [
    { max: 1, force: 0, label: "Calm" }, { max: 6, force: 1, label: "Light air" },
    { max: 12, force: 2, label: "Light breeze" }, { max: 20, force: 3, label: "Gentle breeze" },
    { max: 29, force: 4, label: "Moderate breeze" }, { max: 39, force: 5, label: "Fresh breeze" },
    { max: 50, force: 6, label: "Strong breeze" }, { max: 62, force: 7, label: "Near gale" },
    { max: 75, force: 8, label: "Gale" }, { max: 89, force: 9, label: "Strong gale" },
    { max: 103, force: 10, label: "Storm" }, { max: 118, force: 11, label: "Violent storm" },
    { max: Infinity, force: 12, label: "Hurricane" },
  ];
  function beaufort(kmh) {
    var row = BEAUFORT[BEAUFORT.length - 1];
    for (var i = 0; i < BEAUFORT.length; i++) { if (kmh < BEAUFORT[i].max) { row = BEAUFORT[i]; break; } }
    return { force: row.force, label: row.label };
  }
  function moonPhase(at) {
    var SYNODIC = 29.53058867;
    var ref = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
    var days = at.getTime() / 86400000 - ref;
    var age = ((days % SYNODIC) + SYNODIC) % SYNODIC;
    var phase = age / SYNODIC;
    var illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    var names = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
    return { illumination: illumination, age: age, name: names[Math.floor(phase * 8 + 0.5) % 8], phase: phase };
  }
  /* Column frames -> row objects (same shape as the Next.js zipHourly) */
  function hourlyRows(frame) {
    if (!frame || !frame.time) return [];
    var rows = [];
    for (var i = 0; i < frame.time.length; i++) {
      rows.push({
        time: frame.time[i],
        temperature_2m: frame.temperature_2m ? frame.temperature_2m[i] : null,
        apparent_temperature: frame.apparent_temperature ? frame.apparent_temperature[i] : null,
        relative_humidity_2m: frame.relative_humidity_2m ? frame.relative_humidity_2m[i] : null,
        precipitation_probability: frame.precipitation_probability ? (frame.precipitation_probability[i] || 0) : 0,
        precipitation: frame.precipitation ? (frame.precipitation[i] || 0) : 0,
        weather_code: frame.weather_code ? frame.weather_code[i] : 0,
        wind_speed_10m: frame.wind_speed_10m ? frame.wind_speed_10m[i] : 0,
        wind_direction_10m: frame.wind_direction_10m ? frame.wind_direction_10m[i] : 0,
        is_day: frame.is_day ? frame.is_day[i] === 1 : true,
      });
    }
    return rows;
  }

  /* ---------- insights engine (port of src/lib/insights.ts) ---------- */
  function rainWindow(rows) {
    var horizon = Math.min(rows.length, 24);
    for (var i = 0; i < horizon; i++) {
      var wet = rows[i].precipitation_probability >= 50 || rows[i].precipitation >= 0.2;
      if (!wet) continue;
      var to = i;
      while (to + 1 < horizon && (rows[to + 1].precipitation_probability >= 40 || rows[to + 1].precipitation >= 0.1)) to++;
      return { from: i, to: to };
    }
    return null;
  }
  function buildInsights(d, rows) {
    var out = [];
    var daily = d.daily;
    if (!daily || !daily.time || !daily.time.length) return out;
    var T = function (c) { return Math.round(convTemp(c)); };

    var rain = rainWindow(rows);
    if (rain) {
      var parts = ["Rain likely around " + hm(rows[rain.from].time)];
      if (rain.to > rain.from) parts.push("lasting until " + hm(rows[rain.to].time));
      var peak = 0;
      for (var i = rain.from; i <= rain.to; i++) peak = Math.max(peak, rows[i].precipitation_probability);
      parts.push("peak " + peak + "%");
      out.push({ id: "rain-window", icon: "rain", tone: "rain", text: parts.join(", ") });
    } else {
      out.push({ id: "rain-dry", icon: "sun", tone: "good", text: "No rain expected in the next 24 hours" });
    }

    var yesterday = d.yesterday;
    if (yesterday) {
      var diff = T(daily.temperature_2m_max[0]) - T(yesterday.temperature_2m_max);
      if (diff === 0) out.push({ id: "vs-yesterday", icon: "trend", tone: "info", text: "Same high as yesterday (" + T(yesterday.temperature_2m_max) + "\u00b0)" });
      else out.push({ id: "vs-yesterday", icon: "trend", tone: "info", text: Math.abs(diff) + "\u00b0 " + (diff > 0 ? "warmer" : "cooler") + " than yesterday" });
    }

    var uv = daily.uv_index_max[0];
    if (uv != null) {
      if (uv >= 8) out.push({ id: "uv", icon: "sun", tone: "warn", text: "Very high UV " + Math.round(uv) + " \u2014 sunscreen and shade advised" });
      else if (uv >= 6) out.push({ id: "uv", icon: "sun", tone: "info", text: "High UV " + Math.round(uv) + " around midday" });
    }

    var windMax = daily.wind_speed_10m_max[0];
    if (windMax >= 40) out.push({ id: "wind", icon: "wind", tone: "warn", text: "Very windy \u2014 up to " + Math.round(convWind(windMax)) + " " + windUnit() });
    else if (windMax >= 25) out.push({ id: "wind", icon: "wind", tone: "info", text: "Breezy at times, up to " + Math.round(convWind(windMax)) + " " + windUnit() });

    var swing = T(daily.temperature_2m_max[0]) - T(daily.temperature_2m_min[0]);
    if (swing >= 12) out.push({ id: "swing", icon: "thermo", tone: "info", text: "Wide " + swing + "\u00b0 swing today \u2014 dress in layers" });

    var cur = d.current;
    if (cur.relative_humidity_2m >= 75 && cur.apparent_temperature >= 26) {
      out.push({ id: "muggy", icon: "droplet", tone: "warn", text: "Muggy \u2014 " + Math.round(cur.relative_humidity_2m) + "% humidity makes it feel hotter" });
    }
    if (daily.precipitation_sum[0] >= 1) {
      out.push({ id: "precip-total", icon: "droplet", tone: "rain", text: precipLabel(daily.precipitation_sum[0]) + " " + precipUnit() + " of precipitation expected today" });
    }
    return out;
  }

  /* ---------- severe-weather alert engine (port of src/lib/alerts.ts) ---------- */
  var THUNDER_CODES = { 95: 1, 96: 1, 99: 1 };
  function deriveAlerts(d) {
    var alerts = [];
    var rows = hourlyRows(d.hourly).slice(0, 24);
    var cur = d.current, daily = d.daily;

    var thunderHour = null;
    for (var i = 0; i < Math.min(rows.length, 12); i++) {
      if (THUNDER_CODES[rows[i].weather_code]) { thunderHour = rows[i]; break; }
    }
    if (THUNDER_CODES[cur.weather_code]) {
      alerts.push({ id: "thunder-now", severity: "severe", icon: "lightning", title: "Thunderstorm overhead", detail: "Seek shelter and avoid open areas." });
    } else if (thunderHour) {
      alerts.push({ id: "thunder-soon", severity: "severe", icon: "lightning", title: "Thunderstorm expected around " + hm(thunderHour.time), detail: "Plan outdoor activities before it arrives." });
    }

    var maxGust = cur.wind_gusts_10m || 0;
    for (var j = 0; j < rows.length; j++) maxGust = Math.max(maxGust, rows[j].wind_speed_10m);
    if (maxGust >= 90) alerts.push({ id: "wind-severe", severity: "severe", icon: "wind", title: "Damaging gusts up to " + Math.round(maxGust) + " km/h", detail: "Secure loose objects; take care on roads." });
    else if (maxGust >= 62) alerts.push({ id: "wind-moderate", severity: "moderate", icon: "wind", title: "Gusty winds up to " + Math.round(maxGust) + " km/h", detail: "Cycling and high vehicles take note." });

    var rainSum = 0;
    for (var k = 0; k < rows.length; k++) rainSum += rows[k].precipitation;
    if (rainSum >= 15) alerts.push({ id: "rain-heavy", severity: "severe", icon: "rain", title: "Heavy rain: ~" + Math.round(rainSum) + " mm expected", detail: "Localised flooding possible in the next 24 h." });
    else if (rainSum >= 8) alerts.push({ id: "rain-moderate", severity: "moderate", icon: "rain", title: "Wet day ahead: ~" + Math.round(rainSum) + " mm", detail: "Bring waterproofs; allow extra travel time." });

    var feelsMax = daily ? daily.apparent_temperature_max[0] : null;
    if (feelsMax != null && feelsMax >= 40) alerts.push({ id: "heat-extreme", severity: "severe", icon: "flame", title: "Extreme heat \u2014 feels like " + Math.round(convTemp(feelsMax)) + "\u00b0", detail: "Stay hydrated, avoid the midday sun." });
    else if (feelsMax != null && feelsMax >= 36) alerts.push({ id: "heat-moderate", severity: "moderate", icon: "flame", title: "Heat caution \u2014 feels like " + Math.round(convTemp(feelsMax)) + "\u00b0 today", detail: "Sunscreen, shade and water recommended." });

    var feelsMin = daily ? daily.apparent_temperature_min[0] : null;
    if (feelsMin != null && feelsMin <= -15) alerts.push({ id: "cold-extreme", severity: "severe", icon: "snowflake", title: "Extreme cold \u2014 feels like " + Math.round(convTemp(feelsMin)) + "\u00b0", detail: "Frostbite risk; layer up and limit time outside." });
    else if (feelsMin != null && feelsMin <= -8) alerts.push({ id: "cold-moderate", severity: "moderate", icon: "snowflake", title: "Very cold \u2014 feels like " + Math.round(convTemp(feelsMin)) + "\u00b0 today", detail: "Cover exposed skin; check on the vulnerable." });

    alerts.sort(function (a, b) { return (a.severity === "severe" ? 0 : 1) - (b.severity === "severe" ? 0 : 1); });
    return alerts;
  }

  /* ---------- theme ---------- */
  function resolvedTheme() {
    if (state.theme !== "auto") return state.theme;
    return state.data && state.data.current && state.data.current.is_day === 0 ? "dark" : "minimal";
  }
  function applyTheme() {
    var resolved = resolvedTheme();
    document.documentElement.setAttribute("data-theme", resolved);
    document.querySelectorAll("[data-theme-choice]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-theme-choice") === state.theme));
    });
  }

  /* ---------- data access ---------- */
  function getJSON(path) {
    return fetch(api(path), { headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          throw { message: (body && body.error) || "Request failed (HTTP " + res.status + ")", code: (body && body.code) || "http_" + res.status };
        }
        return body;
      });
    }, function () {
      throw {
        message: location.protocol === "file:" ? FILE_HINT : "Could not reach the weather service. Is app.py running?",
        code: "network",
      };
    });
  }

  function locKey(lat, lon) { return Number(lat).toFixed(3) + "," + Number(lon).toFixed(3); }

  function load(location, opts) {
    opts = opts || {};
    state.location = location;
    lsSet(LS.loc, location);
    var seq = ++state.seq;
    var firstLoad = !state.data;

    if (firstLoad) { showOnly("loading"); }
    setRefreshing(true);

    var weatherPromise = getJSON("/api/weather?lat=" + encodeURIComponent(location.latitude) + "&lon=" + encodeURIComponent(location.longitude));
    var aqiPromise = getJSON("/api/airquality?lat=" + encodeURIComponent(location.latitude) + "&lon=" + encodeURIComponent(location.longitude))
      .catch(function () { return null; });

    return Promise.all([weatherPromise, aqiPromise]).then(function (results) {
      if (seq !== state.seq) return; // a newer request superseded this one
      state.data = results[0];
      state.aqi = results[1];
      state.updated = new Date();
      state.dismissedAlerts = {}; // fresh city / fresh data -> alerts visible again
      applyTheme();
      renderAll();
      renderChips(); // instant render from cache; live temps arrive with the batch
      loadChipsSummaries();
    }).catch(function (err) {
      if (seq !== state.seq) return;
      showError(err && err.message ? err.message : "Something went wrong.", err && err.code);
    }).finally(function () {
      if (seq === state.seq) setRefreshing(false);
    });
  }

  /* ---------- renderers ---------- */
  function showOnly(section) {
    ["loading", "error", "content"].forEach(function (id) {
      $(id).hidden = id !== section;
    });
  }

  function setRefreshing(on) {
    ["refresh", "refresh-top"].forEach(function (id) {
      var btn = $(id);
      if (!btn) return;
      btn.classList.toggle("spin", !!on);
      btn.disabled = !!on;
    });
  }

  function showError(message, code) {
    showOnly("error");
    var isFile = location.protocol === "file:";
    $("error").innerHTML =
      "<h2>Weather data unavailable</h2>" +
      "<p>" + esc(message) + "</p>" +
      (code === "rate_limited" ? '<p class="err-hint">The free provider limits requests per day — the app will keep working from cache and backups, check back in a minute.</p>' : "") +
      (isFile ? '<p class="err-hint">' + esc(FILE_HINT) + "</p>" : "") +
      '<button class="retry-btn" id="retry" type="button">Try again</button>';
    $("retry").addEventListener("click", function () { load(state.location, { force: true }); });
  }

  function renderAll() {
    showOnly("content");
    renderBanner();
    renderAlerts();
    renderHero();
    renderInsights();
    renderAqi();
    renderDaylight();
    renderWind();
    renderHistory();
    renderRainOutlook();
    renderNowcast();
    renderPlanner();
    renderHourly();
    renderDaily();
    renderPin();
    renderFooter();
    renderMeta();
    renderEffects();
    renderGolden();
    updateTitle();
  }

  function renderBanner() {
    var d = state.data;
    var banner = $("banner");
    var msg = null;
    if (d.degraded) {
      msg = "Backup data — the main weather provider is rate limited right now, so this comes from the wttr.in backup (3-day / 3-hourly resolution).";
    } else if (d.stale) {
      msg = "Saved data — the provider is unreachable; showing a cached copy from " + d.stale_minutes + " min ago.";
    }
    if (!msg) { banner.hidden = true; banner.innerHTML = ""; return; }
    banner.hidden = false;
    banner.innerHTML = icon("alert", 17) + "<span>" + esc(msg) + "</span>";
  }

  function renderHero() {
    var d = state.data, cur = d.current, today = (d.daily && d.daily.time && d.daily.time.length) ? 0 : -1;
    var name = state.location.name || "Unknown place";
    var subParts = [state.location.admin1, state.location.country].filter(Boolean);
    $("place-name").textContent = name;
    $("place-sub").textContent = subParts.join(", ") + " · " + hm(cur.time) + " local";

    var info = weatherInfo(cur.weather_code, cur.is_day === 1);
    $("hero-icon").innerHTML = icon(info.icon, 84);
    $("hero-temp").innerHTML = (cur.temperature_2m == null ? "—" : Math.round(convTemp(cur.temperature_2m))) +
      '<span class="deg">' + tempUnit() + "</span>";
    $("cond-label").textContent = info.label;
    $("cond-feels").textContent = "Feels like " + fmtTemp(cur.apparent_temperature, true);
    if (today >= 0) {
      $("cond-range").textContent =
        "High " + fmtTemp(d.daily.temperature_2m_max[today], true) + " · Low " + fmtTemp(d.daily.temperature_2m_min[today], true);
    } else {
      $("cond-range").textContent = "";
    }

    var trend = d.pressure_trend;
    var trendText = "Steady";
    if (trend && typeof trend.delta === "number") {
      trendText = (trend.delta > 0.3 ? "Rising" : trend.delta < -0.3 ? "Falling" : "Steady") +
        " · " + (trend.delta > 0 ? "+" : "") + Math.abs(trend.delta).toFixed(1) + " / " + trend.hours + "h";
    }

    var rainProb = today >= 0 ? d.daily.precipitation_probability_max[today] : null;
    var rainSum = today >= 0 ? d.daily.precipitation_sum[today] : null;

    var tiles = [
      { label: "Feels like", icon: "thermo", value: fmtTemp(cur.apparent_temperature, true) },
      { label: "Humidity", icon: "droplet", value: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) + "%" : "—",
        sub: "Relative humidity" },
      { label: "Wind", icon: "wind",
        value: compass(cur.wind_direction_10m) + " · " + fmtSpeed(cur.wind_speed_10m),
        sub: "Gusts " + fmtSpeed(cur.wind_gusts_10m),
        arrow: cur.wind_direction_10m },
      { label: "Pressure", icon: "gauge", value: fmtPressure(cur.pressure_msl), sub: trendText },
      { label: "Cloud cover", icon: "eye", value: cur.cloud_cover != null ? Math.round(cur.cloud_cover) + "%" : "—" },
      { label: "Rain today", icon: "umbrella", value: rainProb != null ? Math.round(rainProb) + "%" : "—",
        sub: rainSum != null ? fmtAmount(rainSum) + " expected" : null },
    ];

    $("hero-details").innerHTML = tiles.map(function (tile) {
      return '<div class="detail"><span class="d-label">' + icon(tile.icon, 13) + esc(tile.label) + "</span>" +
        '<div class="d-value">' +
        (tile.arrow != null ? '<span class="wind-arrow" style="display:inline-block;transform:rotate(' + (tile.arrow + 180) + 'deg)">' + icon("arrow", 13) + "</span> " : "") +
        esc(tile.value) + "</div>" +
        (tile.sub ? '<div class="d-sub">' + esc(tile.sub) + "</div>" : "") +
        "</div>";
    }).join("");

    var sunTiles = [];
    if (today >= 0) {
      sunTiles.push(
        { label: "Sunrise", icon: "sunrise", value: hm(d.daily.sunrise[today]) },
        { label: "Sunset", icon: "sunset", value: hm(d.daily.sunset[today]) },
        { label: "UV index", icon: "sun", value: uvLabel(d.daily.uv_index_max[today]) }
      );
    }
    $("sun-row").innerHTML = sunTiles.map(function (tile) {
      return '<div class="detail"><span class="d-label">' + icon(tile.icon, 13) + esc(tile.label) + "</span>" +
        '<div class="d-value">' + esc(tile.value) + "</div></div>";
    }).join("");
  }

  function renderHourly() {
    var h = state.data.hourly;
    var wrap = $("hourly");
    $("hourly-extra").textContent = h && h.time ? h.time.length + " hours" : "";
    if (!h || !h.time || !h.time.length) { wrap.innerHTML = '<p class="chips-hint">Hourly data unavailable.</p>'; return; }

    var html = "";
    for (var i = 0; i < h.time.length; i++) {
      var info = weatherInfo(h.weather_code[i], h.is_day[i] === 1);
      var prob = h.precipitation_probability ? h.precipitation_probability[i] : null;
      var barH = prob == null ? 2 : Math.max(2, Math.round((prob / 100) * 26));
      html +=
        '<div class="hour' + (i === 0 ? " now" : "") + '" role="listitem" title="' +
        esc(hourLabel(h.time[i], i === 0) + " — " + fmtTemp(h.temperature_2m[i], true) + ", feels " + fmtTemp(h.apparent_temperature[i], true) +
          " · rain " + (prob == null ? "?" : Math.round(prob) + "%") + " · wind " + fmtSpeed(h.wind_speed_10m[i])) + '">' +
        '<span class="h-time">' + esc(hourLabel(h.time[i], i === 0)) + "</span>" +
        '<span class="h-icon">' + icon(info.icon, 20) + "</span>" +
        '<span class="h-temp">' + fmtTemp(h.temperature_2m[i]) + "</span>" +
        '<span class="h-precip">' +
        (prob != null && prob > 0 ? '<span class="p-pct">' + Math.round(prob) + "%</span>" : "") +
        '<span class="p-bar" style="height:' + barH + 'px"></span>' +
        "</span></div>";
    }
    wrap.innerHTML = html;
  }

  function renderDaily() {
    var d = state.data.daily;
    var wrap = $("daily");
    if (!d || !d.time || !d.time.length) { wrap.innerHTML = '<p class="chips-hint">Daily forecast unavailable.</p>'; return; }

    $("daily-title").textContent = d.time.length >= 15 ? "15-day forecast" : d.time.length + "-day forecast (backup feed)";

    var gMin = Infinity, gMax = -Infinity;
    for (var i = 0; i < d.time.length; i++) {
      gMin = Math.min(gMin, d.temperature_2m_min[i]);
      gMax = Math.max(gMax, d.temperature_2m_max[i]);
    }
    var span = Math.max(1, gMax - gMin);

    var html = "";
    for (var j = 0; j < d.time.length; j++) {
      var info = weatherInfo(d.weather_code[j], 1);
      var left = ((d.temperature_2m_min[j] - gMin) / span) * 100;
      var width = Math.max(6, ((d.temperature_2m_max[j] - d.temperature_2m_min[j]) / span) * 100);
      var prob = d.precipitation_probability_max ? d.precipitation_probability_max[j] : null;
      var sum = d.precipitation_sum ? d.precipitation_sum[j] : null;
      var tip = weekday(d.time[j], j) + ": feels " + fmtTemp(d.apparent_temperature_min[j], true) + " to " + fmtTemp(d.apparent_temperature_max[j], true) +
        " · wind up to " + fmtSpeed(d.wind_speed_10m_max[j]) +
        (sum != null ? " · rain " + fmtAmount(sum) : "") +
        " · sun " + hm(d.sunrise[j]) + "–" + hm(d.sunset[j]);
      html +=
        '<div class="day-row" title="' + esc(tip) + '">' +
        '<span class="day-name">' + esc(weekday(d.time[j], j)) + "<span class='d-sub'>" + esc(dateLabel(d.time[j])) + "</span></span>" +
        '<span class="day-icon">' + icon(info.icon, 20) + "</span>" +
        '<span class="day-prob">' + icon("droplet", 12) + (prob != null ? Math.round(prob) + "%" : "—") + "</span>" +
        '<span class="range"><span class="r-fill" style="left:' + left.toFixed(1) + "%;width:" + width.toFixed(1) + '%"></span></span>' +
        '<span class="day-min">' + fmtTemp(d.temperature_2m_min[j]) + "</span>" +
        '<span class="day-max">' + fmtTemp(d.temperature_2m_max[j]) + "</span>" +
        '<span class="day-rain">' + icon("umbrella", 12) + (sum != null ? esc(fmtAmount(sum)) : "—") + "</span>" +
        "</div>";
    }
    wrap.innerHTML = html;
  }

  function aqiBand(value) {
    var bands = [
      [20, "Good", "#22c55e"], [40, "Fair", "#84cc16"], [60, "Moderate", "#eab308"],
      [80, "Poor", "#f97316"], [100, "Very poor", "#ef4444"], [Infinity, "Extremely poor", "#a21caf"],
    ];
    for (var i = 0; i < bands.length; i++) {
      if (value <= bands[i][0]) return { cat: bands[i][1], color: bands[i][2] };
    }
    return { cat: "Extremely poor", color: "#a21caf" };
  }

  function renderAqi() {
    var card = $("aqi-card"), row = $("aqi-row"), extra = $("aqi-extra");
    var aq = state.aqi && state.aqi.current ? state.aqi.current : null;
    var value = aq && aq.european_aqi != null ? Math.round(aq.european_aqi) : null;
    if (value == null) {
      card.hidden = true;
      row.innerHTML = "";
      extra.textContent = "";
      return;
    }
    card.hidden = false;
    var band = aqiBand(value);
    var GAUGE_MAX = 120;
    var pos = Math.min(Math.max((value / GAUGE_MAX) * 100, 1), 99);
    var stops = [[0, "#22c55e"], [20, "#84cc16"], [40, "#eab308"], [60, "#f97316"], [80, "#ef4444"], [100, "#a21caf"]];
    var gradient = "linear-gradient(90deg," + stops.map(function (s) {
      return s[1] + " " + ((s[0] / GAUGE_MAX) * 100).toFixed(1) + "%";
    }).join(", ") + ")";
    var pollutants = [
      { label: "PM2.5", value: aq.pm2_5 },
      { label: "PM10", value: aq.pm10 },
      { label: "O\u2083", value: aq.ozone },
      { label: "NO\u2082", value: aq.nitrogen_dioxide },
    ];
    row.innerHTML =
      '<div class="aqi-top"><span class="aqi-big">' + value + '</span><span class="aqi-unit">European AQI</span>' +
      '<span class="aqi-band-chip" style="background:' + band.color + '22;color:' + band.color + '">' + esc(band.cat) + "</span></div>" +
      '<div class="aqi-gauge" role="img" aria-label="Air quality index ' + value + ", " + esc(band.cat) + '" style="background:' + gradient + '">' +
      '<span class="aqi-marker" style="left:' + pos.toFixed(1) + "%;background:" + band.color + '"></span></div>' +
      '<div class="aqi-scale"><span>0</span><span>60</span><span>120+</span></div>' +
      '<div class="aqi-pollutants">' + pollutants.map(function (p) {
        return '<div class="pol"><div class="p-name">' + p.label + "</div>" +
          '<div class="p-val">' + (p.value != null ? p.value.toFixed(1) : "\u2014") + "</div>" +
          '<div class="p-unit">\u00b5g/m\u00b3</div></div>';
      }).join("") + "</div>";
  }

  /* ---------- round-13 renderers ---------- */

  function renderAlerts() {
    var wrap = $("alerts");
    var alerts = state.data ? deriveAlerts(state.data) : [];
    var visible = alerts.filter(function (a) { return !state.dismissedAlerts[a.id]; });
    if (!visible.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    wrap.hidden = false;
    wrap.innerHTML = visible.map(function (a) {
      return '<div class="wx-alert wx-alert--' + a.severity + '" role="' + (a.severity === "severe" ? "alert" : "status") + '">' +
        icon(a.icon, 17) +
        '<div class="a-body"><p class="a-title">' + esc(a.title) + '</p><p class="a-detail">' + esc(a.detail) + "</p></div>" +
        '<button type="button" class="a-close" data-alert="' + esc(a.id) + '" aria-label="Dismiss alert: ' + esc(a.title) + '" title="Dismiss">' + icon("x", 14) + "</button>" +
        "</div>";
    }).join("");
  }

  function renderInsights() {
    var wrap = $("insights");
    var list = state.data ? buildInsights(state.data, hourlyRows(state.data.hourly)) : [];
    if (!list.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    wrap.hidden = false;
    wrap.innerHTML = list.map(function (item, i) {
      return '<div class="wx-insight is-' + item.tone + '" role="listitem" style="animation-delay:' + (i * 70) + 'ms">' +
        icon(item.icon, 13) + "<span>" + esc(item.text) + "</span></div>";
    }).join("");
  }

  function renderDaylight() {
    var card = $("daylight-card"), row = $("daylight-row"), extra = $("daylight-extra");
    var d = state.data;
    var sunrise = d.daily && d.daily.sunrise ? d.daily.sunrise[0] : null;
    var sunset = d.daily && d.daily.sunset ? d.daily.sunset[0] : null;
    if (!sunrise || !sunset) { card.hidden = true; return; }
    var srM = isoMinutes(sunrise), ssM = isoMinutes(sunset), nowM = isoMinutes(d.current.time);
    if (ssM <= srM) { card.hidden = true; return; } // polar day/night edge case
    card.hidden = false;
    var dayLen = ssM - srM;
    extra.textContent = fmtMinutes(dayLen) + " of daylight";
    var isDay = nowM >= srM && nowM <= ssM;
    var progress = Math.min(Math.max((nowM - srM) / dayLen, 0), 1);
    var CX = 120, CY = 118, R = 92;
    var angle = Math.PI * (1 - progress);
    var sx = CX + R * Math.cos(angle), sy = CY - R * Math.sin(angle);
    var arcPath = "M " + (CX - R) + " " + CY + " A " + R + " " + R + " 0 0 1 " + (CX + R) + " " + CY;
    var phase = moonPhase(new Date(d.current.time));
    var pct = Math.round(phase.illumination * 100);
    var defs = '<defs><linearGradient id="wx-sky-arc" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" style="stop-color:var(--wx-muted)"/>' +
      '<stop offset="50%" style="stop-color:var(--wx-accent)"/>' +
      '<stop offset="100%" style="stop-color:var(--wx-muted)"/></linearGradient></defs>';
    var horizon = '<line x1="' + (CX - R - 14) + '" y1="' + CY + '" x2="' + (CX + R + 14) + '" y2="' + CY + '" style="stroke:var(--wx-border)" stroke-width="1.5" stroke-dasharray="3 5"/>';
    var track = '<path d="' + arcPath + '" fill="none" style="stroke:var(--wx-border)" stroke-width="2.5" stroke-linecap="round"/>';
    var elapsed = isDay ? '<path d="' + arcPath + '" fill="none" stroke="url(#wx-sky-arc)" stroke-width="3.5" stroke-linecap="round" pathLength="100" stroke-dasharray="' + (progress * 100).toFixed(1) + ' 100"/>' : "";
    var sun = isDay
      ? '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="13" style="fill:var(--wx-accent)" opacity="0.25"/>' +
        '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="7" style="fill:var(--wx-accent)"/>'
      : '<circle cx="' + CX + '" cy="' + (CY - R / 2 - 10) + '" r="16" style="fill:var(--wx-accent-soft)"/>';
    row.innerHTML =
      '<div class="daylight-figure">' +
      '<svg viewBox="0 0 240 130" class="wx-svg" role="img" aria-label="Sun position today">' + defs + horizon + track + elapsed + sun + "</svg>" +
      (isDay
        ? '<div class="daylight-center"><span class="dl-pct">' + Math.round(((ssM - nowM) / dayLen) * 100) + '%</span><span class="dl-sub">daylight left</span></div>'
        : '<div class="daylight-center"><span class="dl-sub">' + (nowM < srM ? "Before sunrise" : "After sunset") + '</span><span class="dl-sub">' + esc(phase.name) + " \u00b7 " + pct + "% lit</span></div>") +
      "</div>" +
      '<div class="daylight-foot">' +
      '<span><span class="dl-label">Sunrise</span><span class="dl-time">' + hm(sunrise) + "</span></span>" +
      '<span class="dl-moon" title="Moon age ' + phase.age.toFixed(1) + ' days">' + icon("moon", 12) + esc(phase.name) + " \u00b7 " + pct + "%</span>" +
      '<span><span class="dl-label">Sunset</span><span class="dl-time">' + hm(sunset) + "</span></span>" +
      "</div>";
  }

  function renderWind() {
    var card = $("wind-card"), row = $("wind-row"), extra = $("wind-extra");
    var cur = state.data.current;
    if (cur.wind_speed_10m == null) { card.hidden = true; return; }
    card.hidden = false;
    var speedKmh = cur.wind_speed_10m, gustKmh = cur.wind_gusts_10m || 0, dir = cur.wind_direction_10m || 0;
    var bf = beaufort(speedKmh);
    extra.textContent = "Force " + bf.force + " \u00b7 " + bf.label;
    var C = 105, R_OUTER = 88, R_TICK = 80;
    function pt(deg, r) { var rad = ((deg - 90) * Math.PI) / 180; return { x: C + r * Math.cos(rad), y: C + r * Math.sin(rad) }; }
    var ticks = "";
    for (var deg = 0; deg < 360; deg += 15) {
      var major = deg % 45 === 0;
      var p1 = pt(deg, major ? R_TICK - 6 : R_TICK), p2 = pt(deg, R_TICK + 2);
      ticks += '<line x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + p2.x.toFixed(1) + '" y2="' + p2.y.toFixed(1) + '" style="stroke:' + (major ? "var(--wx-muted)" : "var(--wx-border)") + '" stroke-width="' + (major ? 1.5 : 1) + '"/>';
    }
    var cardinals = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(function (c) {
      var p = pt(c[1], R_TICK - 19);
      return '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 4).toFixed(1) + '" text-anchor="middle" font-size="' + (c[0] === "N" ? 13 : 11) + '" font-weight="' + (c[0] === "N" ? 700 : 500) + '" style="fill:' + (c[0] === "N" ? "var(--wx-accent)" : "var(--wx-muted)") + '">' + c[0] + "</text>";
    }).join("");
    // Needle points INTO the wind: geometry is drawn pointing North, the group
    // rotates by the wind direction (single rotation — matches a wind vane).
    var tip = pt(0, R_TICK - 12), tail = pt(180, 26), sideA = pt(180, 44), sideB = pt(180, 38);
    var defs = '<defs><linearGradient id="wx-needle" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" style="stop-color:var(--wx-accent)"/>' +
      '<stop offset="100%" style="stop-color:var(--wx-accent);stop-opacity:0.45"/></linearGradient></defs>';
    var dial = '<circle cx="' + C + '" cy="' + C + '" r="' + R_OUTER + '" fill="none" style="stroke:var(--wx-border)" stroke-width="1.5"/>' +
      '<circle cx="' + C + '" cy="' + C + '" r="' + (R_OUTER - 10) + '" fill="none" style="stroke:var(--wx-border)" stroke-width="0.75" stroke-dasharray="1 4" opacity="0.7"/>';
    var needle = '<g class="needle-spin" style="transform: rotate(' + dir + 'deg); transform-origin: ' + C + "px " + C + 'px">' +
      '<line x1="' + C + '" y1="' + C + '" x2="' + tip.x.toFixed(1) + '" y2="' + tip.y.toFixed(1) + '" stroke="url(#wx-needle)" stroke-width="3.5" stroke-linecap="round"/>' +
      '<polygon points="' + tip.x.toFixed(1) + "," + (tip.y - 13).toFixed(1) + " " + (tip.x - 5.5).toFixed(1) + "," + (tip.y + 1).toFixed(1) + " " + (tip.x + 5.5).toFixed(1) + "," + (tip.y + 1).toFixed(1) + '" style="fill:var(--wx-accent)"/>' +
      '<line x1="' + C + '" y1="' + C + '" x2="' + tail.x.toFixed(1) + '" y2="' + tail.y.toFixed(1) + '" style="stroke:var(--wx-muted)" stroke-width="2" stroke-linecap="round" opacity="0.65"/>' +
      '<line x1="' + sideA.x.toFixed(1) + '" y1="' + sideA.y.toFixed(1) + '" x2="' + sideB.x.toFixed(1) + '" y2="' + sideB.y.toFixed(1) + '" style="stroke:var(--wx-muted)" stroke-width="2" stroke-linecap="round" opacity="0.65"/>' +
      "</g>";
    var hub = '<circle cx="' + C + '" cy="' + C + '" r="30" style="fill:var(--wx-surface);stroke:var(--wx-border)" stroke-width="1"/>' +
      '<circle cx="' + C + '" cy="' + C + '" r="2.4" style="fill:var(--wx-accent)"/>';
    row.innerHTML =
      '<div class="wind-figure">' +
      '<svg viewBox="0 0 210 210" class="wx-svg" role="img" aria-label="Wind ' + compass(dir) + " at " + Math.round(convWind(speedKmh)) + " " + windUnit() + '">' + defs + dial + ticks + cardinals + needle + hub + "</svg>" +
      '<div class="wind-center"><span class="w-speed' + (speedKmh >= 40 ? " is-strong" : "") + '">' + Math.round(convWind(speedKmh)) + '</span><span class="w-unit">' + windUnit() + "</span></div>" +
      "</div>" +
      '<div class="wind-facts">' +
      '<div class="wf"><div class="wf-label">From</div><div class="wf-val">' + compass(dir) + " <small>" + Math.round(dir) + "\u00b0</small></div></div>" +
      '<div class="wf"><div class="wf-label">Gusts</div><div class="wf-val">' + Math.round(convWind(gustKmh)) + " <small>" + windUnit() + "</small></div></div>" +
      '<div class="wf"><div class="wf-label">Force</div><div class="wf-val">' + bf.force + "</div></div>" +
      "</div>";
  }

  function renderHistory() {
    var card = $("history-card"), row = $("history-row"), extra = $("history-extra");
    var d = state.data;
    var history = d.history || [];
    if (!history.length || history[0].temperature_2m_max == null) { card.hidden = true; return; }
    card.hidden = false;
    var highs = history.map(function (day) { return day.temperature_2m_max; });
    var lows = history.map(function (day) { return day.temperature_2m_min; });
    var globalMin = Math.min.apply(null, lows), globalMax = Math.max.apply(null, highs);
    var span = Math.max(globalMax - globalMin, 1);
    var n = history.length;
    var W = 340, H = 132, PAD_X = 26, PAD_TOP = 24, PAD_BOTTOM = 30;
    var step = n > 1 ? (W - PAD_X * 2) / (n - 1) : 0;
    function x(i) { return n > 1 ? PAD_X + i * step : W / 2; }
    function y(v) { return PAD_TOP + (1 - (v - globalMin) / span) * (H - PAD_TOP - PAD_BOTTOM); }
    var maxPts = highs.map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    var minPts = lows.map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    var avgHigh = highs.reduce(function (s, v) { return s + v; }, 0) / n;
    var avgLow = lows.reduce(function (s, v) { return s + v; }, 0) / n;
    var totalRain = history.reduce(function (s, day) { return s + (day.precipitation_sum || 0); }, 0);
    var warmestIndex = highs.indexOf(globalMax);
    var trend = highs[n - 1] - highs[0];
    extra.innerHTML = '<span class="mini-chip ' + (trend >= 0 ? "mini-chip--rain" : "mini-chip--cool") +
      '" title="Change in daily high between 7 days ago and yesterday">' + (trend >= 0 ? "+" : "") + Math.round(convTemp(trend)) + "\u00b0 this week</span>";
    var todayHigh = d.daily.temperature_2m_max[0];
    var tMin = Math.min(globalMin, todayHigh), tMax = Math.max(globalMax, todayHigh);
    var tSpan = Math.max(tMax - tMin, 1);
    var todayY = PAD_TOP + (1 - (todayHigh - tMin) / tSpan) * (H - PAD_TOP - PAD_BOTTOM);
    var defs = '<defs><linearGradient id="wx-hist-bar" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" style="stop-color:var(--wx-accent);stop-opacity:0.75"/>' +
      '<stop offset="100%" style="stop-color:var(--wx-accent);stop-opacity:0.18"/></linearGradient></defs>';
    var bars = history.map(function (day, i) {
      var top = y(day.temperature_2m_max), bottom = y(day.temperature_2m_min);
      var rain = (day.precipitation_sum || 0) > 0.4;
      return '<g class="wx-hist-group">' +
        '<rect x="' + (x(i) - 4.5).toFixed(1) + '" y="' + top.toFixed(1) + '" width="9" height="' + Math.max(bottom - top, 3).toFixed(1) + '" rx="4.5" fill="url(#wx-hist-bar)"/>' +
        '<circle cx="' + x(i).toFixed(1) + '" cy="' + top.toFixed(1) + '" r="2.4" style="fill:var(--wx-accent)"/>' +
        '<circle cx="' + x(i).toFixed(1) + '" cy="' + bottom.toFixed(1) + '" r="2.4" style="fill:var(--wx-surface);stroke:var(--wx-muted)" stroke-width="1.2"/>' +
        (rain ? '<circle cx="' + x(i).toFixed(1) + '" cy="' + (H - 17) + '" r="2" style="fill:var(--wx-accent)" opacity="0.75"/>' : "") +
        '<text x="' + x(i).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" class="axis-text">' + esc(weekdayName(day.time)) + "</text></g>";
    }).join("");
    row.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" class="wx-svg" role="img" aria-label="Temperature range for the past 7 days">' +
      defs +
      '<line x1="' + (PAD_X - 14) + '" y1="' + todayY.toFixed(1) + '" x2="' + (W - PAD_X + 14) + '" y2="' + todayY.toFixed(1) + '" style="stroke:var(--wx-border)" stroke-dasharray="4 4"/>' +
      '<polyline points="' + minPts + '" fill="none" style="stroke:var(--wx-muted)" stroke-width="1.25" stroke-dasharray="3 3" opacity="0.8"/>' +
      '<polyline points="' + maxPts + '" fill="none" style="stroke:var(--wx-accent)" stroke-width="1.5" opacity="0.9"/>' +
      bars + "</svg>" +
      '<div class="hist-legend">' +
      '<span class="lg"><span class="lg-line"></span>High</span>' +
      '<span class="lg"><span class="lg-dash"></span>Low</span>' +
      '<span class="lg"><span class="lg-dot"></span>Rain day</span>' +
      '<span class="lg"><span class="lg-dash"></span>Today high</span>' +
      "</div>" +
      '<div class="hist-stats">' +
      '<div><div class="hs-label">Avg high</div><div class="hs-val">' + Math.round(convTemp(avgHigh)) + "\u00b0</div></div>" +
      '<div><div class="hs-label">Avg low</div><div class="hs-val">' + Math.round(convTemp(avgLow)) + "\u00b0</div></div>" +
      '<div><div class="hs-label">Rain total</div><div class="hs-val">' + precipLabel(totalRain) + " <small>" + precipUnit() + "</small></div></div>" +
      "</div>" +
      '<p class="hist-note">Warmest day: ' + esc(weekdayName(history[warmestIndex].time)) + " at " + Math.round(convTemp(globalMax)) + "\u00b0</p>";
  }

  function renderRainOutlook() {
    var card = $("rain-card"), row = $("rain-row"), extra = $("rain-extra");
    var rows = hourlyRows(state.data.hourly).slice(0, 12);
    if (rows.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    var unit = precipUnit();
    var totalMm = 0, probs = [];
    for (var i = 0; i < rows.length; i++) { totalMm += rows[i].precipitation; probs.push(rows[i].precipitation_probability); }
    var maxProb = Math.max.apply(null, probs);
    var peakIndex = probs.indexOf(maxProb);
    var firstWet = -1;
    for (var j = 0; j < probs.length; j++) { if (probs[j] >= 50) { firstWet = j; break; } }
    var summary = maxProb < 20 ? "No rain expected in the next 12 hours"
      : firstWet === -1 ? "Slight chance of rain \u2014 peak " + maxProb + "%"
      : firstWet === 0 ? "Rain likely right now"
      : "Dry until " + hm(rows[firstWet].time) + ", then rain likely";
    extra.innerHTML = '<span class="wx-muted" title="Expected accumulation over the next 12 hours">~' + precipLabel(totalMm) + " " + unit + " expected</span>" +
      '<span class="mini-chip ' + (maxProb >= 50 ? "mini-chip--rain" : "mini-chip--good") + '">' + esc(summary) + "</span>";
    var W = 640, H = 150, PL = 30, PR = 10, PT = 26, PB = 26;
    var innerW = W - PL - PR, innerH = H - PT - PB;
    var band = innerW / rows.length;
    var barW = Math.min(band * 0.55, 30);
    function y(p) { return PT + (1 - p / 100) * innerH; }
    var defs = '<defs><linearGradient id="wx-rain-bar" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" style="stop-color:var(--wx-accent);stop-opacity:0.85"/>' +
      '<stop offset="100%" style="stop-color:var(--wx-accent);stop-opacity:0.25"/></linearGradient></defs>';
    var grid = [25, 50, 75].map(function (v) {
      return '<line x1="' + PL + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y(v).toFixed(1) + '" style="stroke:var(--wx-border)" stroke-dasharray="2 5"/>' +
        '<text x="' + (PL - 6) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end" class="axis-text">' + v + "</text>";
    }).join("");
    var bandsSvg = rows.map(function (point, i) {
      var prob = point.precipitation_probability, amount = point.precipitation;
      var cx = PL + band * i + band / 2;
      var barTop = y(prob);
      var isPeak = i === peakIndex && maxProb >= 20;
      var showAmount = amount >= 0.2;
      var opacity = prob >= 50 ? 1 : prob >= 20 ? 0.72 : 0.4;
      return '<g class="wx-rain-band"><title>' + esc(hm(point.time) + " \u2014 " + prob + "% chance, " + precipLabel(amount) + " " + unit) + "</title>" +
        '<rect x="' + (PL + band * i).toFixed(1) + '" y="' + (PT - 8) + '" width="' + band.toFixed(1) + '" height="' + (innerH + 8) + '" fill="transparent"/>' +
        '<rect class="wx-rain-bar" x="' + (cx - barW / 2).toFixed(1) + '" y="' + barTop.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(PT + innerH - barTop, 1.5).toFixed(1) + '" rx="' + Math.min(barW / 2, 5).toFixed(1) + '" fill="url(#wx-rain-bar)" opacity="' + opacity + '"/>' +
        (isPeak ? '<circle cx="' + cx.toFixed(1) + '" cy="' + (barTop - 10).toFixed(1) + '" r="2.2" style="fill:var(--wx-accent)"/><text x="' + cx.toFixed(1) + '" y="' + (barTop - 16).toFixed(1) + '" text-anchor="middle" font-size="9.5" font-weight="600" style="fill:var(--wx-accent)">' + prob + "%</text>" : "") +
        (showAmount && !isPeak ? '<text x="' + cx.toFixed(1) + '" y="' + (barTop - 6).toFixed(1) + '" text-anchor="middle" font-size="8.5" class="axis-text">' + precipLabel(amount) + "</text>" : "") +
        ((i % 2 === 0 || rows.length <= 8) ? '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="axis-text">' + esc(i === 0 ? "Now" : hm(point.time)) + "</text>" : "") +
        "</g>";
    }).join("");
    row.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" class="wx-svg" role="img" aria-label="Precipitation probability for the next 12 hours, peak ' + maxProb + '%">' +
      defs + grid +
      '<line x1="' + PL + '" y1="' + (PT + innerH) + '" x2="' + (W - PR) + '" y2="' + (PT + innerH) + '" style="stroke:var(--wx-muted)"/>' +
      '<text x="' + (PL - 6) + '" y="' + (PT + 3) + '" text-anchor="end" class="axis-text">%</text>' +
      bandsSvg + "</svg>";
  }

  function renderNowcast() {
    var card = $("nowcast-card"), row = $("nowcast-row"), extra = $("nowcast-extra");
    var observed = hourlyRows(state.data.past_hourly).slice(-6);
    var ahead = hourlyRows(state.data.hourly).slice(0, 12);
    if (observed.length === 0 && ahead.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    var unit = precipUnit();
    var pastTotal = 0, futureTotal = 0, probs = [];
    observed.forEach(function (p) { pastTotal += p.precipitation; });
    ahead.forEach(function (p) { futureTotal += p.precipitation; probs.push(p.precipitation_probability); });
    var maxProb = probs.length ? Math.max.apply(null, probs) : 0;
    var peakIndex = probs.indexOf(maxProb);
    var amounts = observed.concat(ahead).map(function (p) { return p.precipitation; });
    var scale = Math.max.apply(null, [1].concat(amounts));
    var slots = observed.length + ahead.length;
    var W = 640, H = 150, PL = 34, PR = 12, PT = 24, PB = 24;
    var innerW = W - PL - PR, innerH = H - PT - PB;
    var band = innerW / Math.max(slots, 1);
    var barW = Math.min(band * 0.52, 20);
    var nowX = PL + band * observed.length;
    var baseline = PT + innerH;
    function barH(a) { return Math.max((a / scale) * innerH, a > 0 ? 2 : 0); }
    var summary = pastTotal < 0.1 && futureTotal < 0.2 && maxProb < 20 ? "Dry so far \u00b7 none expected in 12h"
      : pastTotal >= 0.1 && futureTotal < 0.2 ? precipLabel(pastTotal) + " " + unit + " fell \u00b7 clearing up"
      : pastTotal < 0.1 ? "Dry past 6h \u00b7 ~" + precipLabel(futureTotal) + " " + unit + " ahead"
      : precipLabel(pastTotal) + " " + unit + " so far \u00b7 ~" + precipLabel(futureTotal) + " " + unit + " more";
    extra.innerHTML = "<span>" + esc(summary) + "</span>" +
      '<span class="mini-chip ' + (futureTotal >= 0.2 || maxProb >= 50 ? "mini-chip--rain" : "mini-chip--good") + '">Peak ' + maxProb + "%</span>";
    function renderBar(point, slotIndex, observedBar) {
      var amount = point.precipitation;
      var cx = PL + band * slotIndex + band / 2;
      var hgt = barH(amount), top = baseline - hgt;
      var isPeak = !observedBar && slotIndex - observed.length === peakIndex && maxProb >= 20;
      var showLabel = amount >= 0.2 && hgt >= 10;
      return '<g class="wx-now-band"><title>' + esc(hm(point.time) + " \u2014 " + (observedBar ? "observed" : "forecast") + ": " + precipLabel(amount) + " " + unit + (observedBar ? "" : ", " + point.precipitation_probability + "% chance")) + "</title>" +
        '<rect x="' + (cx - band / 2).toFixed(1) + '" y="' + (PT - 6) + '" width="' + band.toFixed(1) + '" height="' + (innerH + 6) + '" fill="transparent"/>' +
        (amount > 0 ? '<rect class="' + (observedBar ? "wx-now-obs-bar" : "wx-now-fc-bar") + '" x="' + (cx - barW / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="' + Math.min(barW / 2, 4).toFixed(1) + '" style="fill:' + (observedBar ? "var(--wx-accent)" : "url(#wx-now-fc)") + '" opacity="' + (observedBar ? 0.9 : 0.75) + '"/>' : "") +
        (showLabel ? '<text x="' + cx.toFixed(1) + '" y="' + (top - 5).toFixed(1) + '" text-anchor="middle" font-size="8.5" class="axis-text">' + precipLabel(amount) + "</text>" : "") +
        (isPeak ? '<text x="' + cx.toFixed(1) + '" y="' + (top - 15).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" style="fill:var(--wx-accent)">' + maxProb + "%</text>" : "") +
        ((slotIndex % 3 === 0 || (slotIndex === observed.length - 1 && observed.length % 3 !== 0)) ? '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="axis-text">' + esc(hm(point.time)) + "</text>" : "") +
        "</g>";
    }
    var defs = '<defs><linearGradient id="wx-now-fc" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" style="stop-color:var(--wx-accent);stop-opacity:0.75"/>' +
      '<stop offset="100%" style="stop-color:var(--wx-accent);stop-opacity:0.2"/></linearGradient></defs>';
    var gridLines = [0.5, 1].map(function (f) {
      var gy = baseline - f * innerH;
      return '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '" style="stroke:var(--wx-border)" stroke-dasharray="2 5"/>' +
        '<text x="' + (PL - 6) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" class="axis-text">' + precipLabel(scale * f) + "</text>";
    }).join("");
    var bars = observed.map(function (p, i) { return renderBar(p, i, true); }).join("") +
      ahead.map(function (p, i) { return renderBar(p, observed.length + i, false); }).join("");
    row.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" class="wx-svg" role="img" aria-label="Precipitation timeline: observed past 6 hours vs expected next 12 hours">' +
      defs +
      '<rect x="' + PL + '" y="' + (PT - 6) + '" width="' + Math.max(nowX - PL, 0).toFixed(1) + '" height="' + (innerH + 6) + '" rx="8" style="fill:var(--wx-muted)" opacity="0.06"/>' +
      gridLines +
      '<line x1="' + PL + '" y1="' + baseline + '" x2="' + (W - PR) + '" y2="' + baseline + '" style="stroke:var(--wx-muted)"/>' +
      '<text x="' + (PL - 6) + '" y="' + (PT + 3) + '" text-anchor="end" class="axis-text">' + unit + "</text>" +
      bars +
      '<g><line x1="' + nowX.toFixed(1) + '" y1="' + (PT - 8) + '" x2="' + nowX.toFixed(1) + '" y2="' + baseline + '" style="stroke:var(--wx-accent)" stroke-width="1.4" stroke-dasharray="3 4"/>' +
      '<circle cx="' + nowX.toFixed(1) + '" cy="' + (PT - 8) + '" r="2.6" style="fill:var(--wx-accent)"/>' +
      '<text x="' + nowX.toFixed(1) + '" y="' + (PT - 14) + '" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="0.6" style="fill:var(--wx-accent)">NOW</text></g>' +
      '<g font-size="9" style="fill:var(--wx-muted)">' +
      '<rect x="' + (W - PR - 128) + '" y="' + (PT - 2) + '" width="8" height="8" rx="2" style="fill:var(--wx-accent)" opacity="0.9"/>' +
      '<text x="' + (W - PR - 117) + '" y="' + (PT + 5) + '">Observed</text>' +
      '<rect x="' + (W - PR - 62) + '" y="' + (PT - 2) + '" width="8" height="8" rx="2" fill="url(#wx-now-fc)"/>' +
      '<text x="' + (W - PR - 51) + '" y="' + (PT + 5) + '">Forecast</text></g>' +
      "</svg>";
  }

  function renderPlanner() {
    var card = $("plan-card"), row = $("plan-row"), extra = $("plan-extra");
    var rows = hourlyRows(state.data.hourly).slice(0, 12);
    if (rows.length < 3) { card.hidden = true; return; }
    card.hidden = false;
    function scoreHour(p) {
      var feels = p.apparent_temperature != null ? p.apparent_temperature : (p.temperature_2m || 0);
      var wind = p.wind_speed_10m || 0, hum = p.relative_humidity_2m || 0;
      var raw = 100 - p.precipitation_probability * 0.5 - p.precipitation * 8 -
        Math.max(0, Math.abs(feels - 22) - 4) * 5 - Math.max(0, wind - 20) * 1.5 - Math.max(0, hum - 70) * 0.4;
      return Math.max(0, Math.min(100, Math.round(raw)));
    }
    function tone(s) { return s >= 75 ? "great" : s >= 55 ? "good" : s >= 35 ? "fair" : "poor"; }
    function word(s) { return s >= 75 ? "Great" : s >= 55 ? "Good" : s >= 35 ? "Fair" : "Poor"; }
    var scores = rows.map(scoreHour);
    var windows = [];
    var start = null;
    for (var i = 0; i <= scores.length; i++) {
      var good = i < scores.length && scores[i] >= 55;
      if (good && start === null) start = i;
      if (!good && start !== null) {
        var slice = scores.slice(start, i);
        var avg = Math.round(slice.reduce(function (s, v) { return s + v; }, 0) / slice.length);
        if (slice.length >= 2) windows.push({ from: start, to: i - 1, avg: avg });
        start = null;
      }
    }
    windows.sort(function (a, b) { return b.avg - a.avg; });
    var best = windows[0];
    var bestIndex = 0;
    for (var j = 1; j < scores.length; j++) if (scores[j] > scores[bestIndex]) bestIndex = j;
    var chips = windows.length > 0
      ? windows.slice().sort(function (a, b) { return a.from - b.from; }).slice(0, 3)
      : [{ from: bestIndex, to: bestIndex, avg: scores[bestIndex] }];
    function range(from, to) {
      return from === to ? (from === 0 ? "Now" : hm(rows[from].time)) : hm(rows[from].time) + "\u2013" + hm(rows[to].time);
    }
    extra.innerHTML = '<span class="mini-chip ' + (best ? "mini-chip--" + tone(best.avg) : "") + '">' +
      (best ? "Best window " + range(best.from, best.to) : "Head out at " + hm(rows[bestIndex].time)) + "</span>";
    var strip = rows.map(function (point, i) {
      var score = scores[i];
      var inBest = best ? i >= best.from && i <= best.to : i === bestIndex;
      var feels = Math.round(convTemp(point.apparent_temperature != null ? point.apparent_temperature : point.temperature_2m));
      var tip = (i === 0 ? "Now" : hm(point.time)) + " \u2014 " + word(score) + " (" + score + "/100) \u00b7 feels " + feels + "\u00b0 \u00b7 " +
        point.precipitation_probability + "% rain \u00b7 " + Math.round(convWind(point.wind_speed_10m)) + " " + windUnit();
      return '<div class="plan-seg is-' + tone(score) + (inBest ? " is-best" : "") + '" title="' + esc(tip) + '">' +
        '<span class="pl-score">' + score + "</span>" +
        '<span class="pl-hour">' + esc(i === 0 ? "Now" : hm(point.time)) + "</span></div>";
    }).join("");
    var chipHtml = chips.map(function (chip) {
      var hour = rows[chip.from];
      var gust = beaufort(hour.wind_speed_10m || 0);
      var t = tone(chip.avg);
      return '<li class="pl-chip is-' + t + '"><b>' + esc(range(chip.from, chip.to)) + '</b><span class="pl-muted">\u00b7</span>' +
        "<span>" + word(chip.avg) + " \u00b7 feels " + Math.round(convTemp(hour.apparent_temperature != null ? hour.apparent_temperature : hour.temperature_2m)) +
        "\u00b0 \u00b7 " + hour.precipitation_probability + "% rain \u00b7 " + gust.label.toLowerCase() + "</span></li>";
    }).join("");
    row.innerHTML = '<div class="plan-strip" role="img" aria-label="Hourly outdoor comfort scores for the next 12 hours">' + strip + "</div>" +
      '<ul class="plan-chips">' + chipHtml + "</ul>";
  }

  /* ---------- ambient effects + golden hour ---------- */

  var EFFECT_SEEDS = { rain: 4177, storm: 9103, snow: 8117, fog: 2201, stars: 5501, clouds: 3307, clear: 4409 };
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function effectKind(code, isDay) {
    if (code === 45 || code === 48) return "fog";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if (code === 95 || code >= 96) return "storm";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
    if (!isDay && code <= 1) return "stars";
    if (code === 2 || code === 3) return "clouds";
    return "clear";
  }
  function renderEffects() {
    var host = $("effects");
    if (!host) return;
    if (REDUCED_MOTION || !state.data) { host.innerHTML = ""; return; }
    var kind = effectKind(state.data.current.weather_code, state.data.current.is_day === 1);
    var rand = mulberry32(EFFECT_SEEDS[kind]);
    var html = "", i, size;
    if (kind === "rain" || kind === "storm") {
      var count = kind === "storm" ? 90 : 64;
      for (i = 0; i < count; i++) {
        html += '<span class="wx-drop" style="left:' + (rand() * 100).toFixed(2) +
          "%;height:" + (12 + rand() * 12).toFixed(1) +
          "px;opacity:" + (0.14 + rand() * 0.3).toFixed(2) +
          ";animation-duration:" + (0.55 + rand() * (kind === "storm" ? 0.45 : 0.6)).toFixed(2) +
          "s;animation-delay:" + (-rand() * 2).toFixed(2) + 's"></span>';
      }
      html += '<span class="wx-lightning"></span>';
    } else if (kind === "snow") {
      for (i = 0; i < 46; i++) {
        size = 2.5 + rand() * 3.5;
        html += '<span class="wx-flake" style="left:' + (rand() * 100).toFixed(2) +
          "%;width:" + size.toFixed(1) + "px;height:" + size.toFixed(1) +
          "px;opacity:" + (0.25 + rand() * 0.4).toFixed(2) +
          ";--drift:" + ((rand() - 0.5) * 90).toFixed(0) +
          "px;animation-duration:" + (5 + rand() * 6).toFixed(2) +
          "s;animation-delay:" + (-rand() * 10).toFixed(2) + 's"></span>';
      }
    } else if (kind === "stars") {
      for (i = 0; i < 54; i++) {
        size = 1.2 + rand() * 2;
        html += '<span class="wx-star" style="left:' + (rand() * 100).toFixed(2) +
          "%;top:" + (rand() * 62).toFixed(2) +
          "%;width:" + size.toFixed(1) + "px;height:" + size.toFixed(1) +
          "px;animation-duration:" + (2 + rand() * 3.5).toFixed(2) +
          "s;animation-delay:" + (-rand() * 5).toFixed(2) + 's"></span>';
      }
    } else { // fog | clouds | clear
      var count2 = kind === "fog" ? 4 : kind === "clouds" ? 3 : 2;
      for (i = 0; i < count2; i++) {
        var left = -8 + rand() * 70;
        var top = kind === "clear" ? (i === 0 ? -12 : 4) : 4 + rand() * 62;
        var w = 28 + rand() * 26;
        var hgt = kind === "clear" ? 30 + rand() * 14 : 9 + rand() * 8;
        var opacity = kind === "clear" ? 0.16 : 0.1 + rand() * 0.07;
        if (kind === "clear") {
          html += '<span class="wx-sunglow" style="' + (i === 0 ? "right:-6%;" : "left:4%;") +
            "top:" + top.toFixed(0) + "%;width:" + w.toFixed(0) + "vw;height:" + w.toFixed(0) +
            "vw;opacity:" + opacity.toFixed(2) + ";animation-duration:" + (18 + rand() * 16).toFixed(1) +
            "s;animation-delay:" + (-rand() * 20).toFixed(1) + 's"></span>';
        } else {
          html += '<span class="' + (kind === "fog" ? "wx-fog" : "wx-cloud") + '" style="left:' + left.toFixed(0) +
            "%;top:" + top.toFixed(0) + "%;width:" + w.toFixed(0) + "vw;height:" + hgt.toFixed(0) +
            "vh;opacity:" + opacity.toFixed(2) + ";animation-duration:" + (18 + rand() * 16).toFixed(1) +
            "s;animation-delay:" + (-rand() * 20).toFixed(1) + 's"></span>';
        }
      }
    }
    host.innerHTML = html;
  }

  function renderGolden() {
    var el = $("golden");
    var d = state.data;
    if (!el) return;
    if (!d || !d.daily || !d.daily.sunrise || !d.daily.sunset) { el.hidden = true; return; }
    var sunrise = isoMinutes(d.daily.sunrise[0]);
    var sunset = isoMinutes(d.daily.sunset[0]);
    var now = isoMinutes(d.current.time);
    var WINDOW_MIN = 45;
    var kind = null, intensity = 0;
    if (Math.abs(now - sunrise) <= WINDOW_MIN) { kind = "dawn"; intensity = 1 - Math.abs(now - sunrise) / WINDOW_MIN; }
    else if (Math.abs(sunset - now) <= WINDOW_MIN) { kind = "dusk"; intensity = 1 - Math.abs(sunset - now) / WINDOW_MIN; }
    if (!kind || intensity <= 0) { el.hidden = true; return; }
    el.hidden = false;
    el.className = "wx-golden wx-golden--" + kind;
    el.style.opacity = String(0.55 * intensity + 0.15);
  }

  /* ---------- meta line (local clock + updated + countdown) ---------- */

  function renderMeta() {
    var d = state.data;
    var clock = $("meta-clock");
    if (d && d.timezone) {
      try {
        clock.textContent = "Local " + new Intl.DateTimeFormat("en-GB", {
          timeZone: d.timezone, hour: "2-digit", minute: "2-digit",
        }).format(new Date());
      } catch (e) { clock.textContent = ""; }
    } else {
      clock.textContent = "";
    }
    tickMetaUpdated();
  }
  function tickMetaUpdated() {
    var el = $("meta-updated");
    if (!el) return;
    if (!state.updated) { el.textContent = ""; return; }
    var label = "Updated " + state.updated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (!$("refresh").disabled) {
      var remaining = Math.max(0, REFRESH_MS - (Date.now() - state.updated.getTime()));
      var m = Math.floor(remaining / 60000), s = Math.floor((remaining % 60000) / 1000);
      label += " \u00b7 next " + m + ":" + String(s).padStart(2, "0");
    }
    el.textContent = label;
  }

  /* ---------- share ---------- */

  function shareWeather() {
    var d = state.data;
    if (!d) return;
    var place = [state.location.name, state.location.country].filter(Boolean).join(", ");
    var text = place + ": " + fmtTemp(d.current.temperature_2m, true) + tempUnit() +
      ", " + fmtTemp(d.daily.temperature_2m_max[0], true) + " / " + fmtTemp(d.daily.temperature_2m_min[0], true) +
      ", rain chance " + Math.round(d.daily.precipitation_probability_max[0] || 0) + "% \u2014 via Clima";
    if (navigator.share) {
      navigator.share({ title: "Clima", text: text }).catch(function () { /* share sheet dismissed */ });
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flashBanner("Copied to clipboard \u2014 " + text); },
        function () { flashBanner(text); }
      );
    } else {
      flashBanner(text);
    }
  }

  /* ---------- compare favorites ---------- */

  function openCompare() {
    var dlg = $("compare-dialog");
    if (dlg && !dlg.open) dlg.showModal();
    renderCompare();
    var favs = state.favorites.slice(0, 8);
    var seq = ++state.compareSeq;
    favs.forEach(function (fav) {
      var key = locKey(fav.latitude, fav.longitude);
      if (state.compareCache[key] !== undefined) return; // already cached (or failed)
      getJSON("/api/weather?lat=" + encodeURIComponent(fav.latitude) + "&lon=" + encodeURIComponent(fav.longitude))
        .then(function (data) {
          if (seq !== state.compareSeq) return;
          state.compareCache[key] = data;
          renderCompare();
        })
        .catch(function () {
          if (seq !== state.compareSeq) return;
          state.compareCache[key] = null;
          renderCompare();
        });
    });
  }
  function closeCompare() {
    var dlg = $("compare-dialog");
    if (dlg && dlg.open) dlg.close();
  }
  function renderCompare() {
    var grid = $("compare-grid");
    var favs = state.favorites.slice(0, 8);
    $("compare-sub").textContent = favs.length
      ? "Side-by-side conditions for your pinned cities \u2014 tap one to open it."
      : "Pin a few cities with the star first.";
    if (!favs.length) { grid.innerHTML = ""; return; }
    var rows = favs.map(function (fav) {
      return { fav: fav, data: state.compareCache[locKey(fav.latitude, fav.longitude)] };
    });
    var loaded = rows.filter(function (r) { return r.data; });
    var hottest = null, coldest = null, wettest = null;
    loaded.forEach(function (r) {
      var t = r.data.current.temperature_2m;
      if (hottest === null || t > hottest.data.current.temperature_2m) hottest = r;
      if (coldest === null || t < coldest.data.current.temperature_2m) coldest = r;
      var wet = r.data.daily.precipitation_probability_max[0] || 0;
      if (wettest === null || wet > (wettest.data.daily.precipitation_probability_max[0] || 0)) wettest = r;
    });
    grid.innerHTML = rows.map(function (r) {
      var key = locKey(r.fav.latitude, r.fav.longitude);
      if (r.data === undefined) return '<div class="compare-card is-loading">Loading ' + esc(r.fav.name) + "\u2026</div>";
      if (r.data === null) return '<div class="compare-card is-failed">Unavailable</div>';
      var d = r.data;
      var info = weatherInfo(d.current.weather_code, d.current.is_day === 1);
      var badges = "";
      if (loaded.length > 1) {
        if (hottest && hottest.fav === r.fav) badges += '<span class="cc-badge is-hot">Hottest</span>';
        if (coldest && coldest.fav === r.fav) badges += '<span class="cc-badge is-cold">Coldest</span>';
        if (wettest && wettest.fav === r.fav) badges += '<span class="cc-badge is-wet">Wettest</span>';
      }
      return '<button type="button" class="compare-card" data-key="' + esc(key) + '" title="Show ' + esc(r.fav.name) + '">' +
        '<div class="cc-top"><span class="cc-name">' + esc(r.fav.name) + '</span><span class="cc-icon">' + icon(info.icon, 17) + "</span></div>" +
        '<div class="cc-temp">' + Math.round(convTemp(d.current.temperature_2m)) + tempUnit() + "</div>" +
        '<div class="cc-rows">' +
        "<span>High " + fmtTemp(d.daily.temperature_2m_max[0], true) + " \u00b7 Low " + fmtTemp(d.daily.temperature_2m_min[0], true) + "</span>" +
        "<span>Rain " + Math.round(d.daily.precipitation_probability_max[0] || 0) + "% \u00b7 Wind " + fmtSpeed(d.current.wind_speed_10m) + "</span>" +
        "</div>" + badges + "</button>";
    }).join("");
  }

  /* ---------- favorites ---------- */
  function isPinned() {
    var key = locKey(state.location.latitude, state.location.longitude);
    return state.favorites.some(function (fav) { return locKey(fav.latitude, fav.longitude) === key; });
  }

  function renderPin() {
    var pinned = isPinned();
    var btn = $("pin");
    btn.classList.toggle("pinned", pinned);
    btn.setAttribute("aria-pressed", String(pinned));
    btn.title = pinned ? "Remove from favorites" : "Pin this city";
  }

  function togglePin() {
    var key = locKey(state.location.latitude, state.location.longitude);
    if (isPinned()) {
      state.favorites = state.favorites.filter(function (fav) { return locKey(fav.latitude, fav.longitude) !== key; });
    } else {
      if (state.favorites.length >= MAX_FAVORITES) return;
      state.favorites.push({
        name: state.location.name, admin1: state.location.admin1, country: state.location.country,
        latitude: state.location.latitude, longitude: state.location.longitude,
      });
    }
    lsSet(LS.favs, state.favorites);
    renderPin();
    renderChips();
    loadChipsSummaries();
  }

  function chipAlerts(summary) {
    var dots = [];
    if (!summary) return dots;
    var prob = summary.precip_prob_max, sum = summary.precip_sum, gust = summary.wind_gust_max;
    if (prob != null && prob >= 85 || sum != null && sum >= 15) dots.push({ severe: true, tip: "Heavy rain today · " + Math.round(prob || 0) + "% · " + fmtAmount(sum) });
    else if (prob != null && prob >= 55 || sum != null && sum >= 4) dots.push({ severe: false, tip: "Rain likely today · " + Math.round(prob || 0) + "% · " + fmtAmount(sum) });
    if (gust != null && gust >= 90) dots.push({ severe: true, tip: "Severe gusts today · " + fmtSpeed(gust) });
    else if (gust != null && gust >= 60) dots.push({ severe: false, tip: "Windy today · gusts " + fmtSpeed(gust) });
    return dots;
  }

  function renderChips() {
    var wrap = $("chips");
    if (!state.favorites.length) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    var currentKey = locKey(state.location.latitude, state.location.longitude);
    var summaries = state.chipSummaries || {};
    var html = "";
    state.favorites.forEach(function (fav, index) {
      var key = locKey(fav.latitude, fav.longitude);
      var summary = summaries[key];
      var info = summary ? weatherInfo(summary.weather_code, summary.is_day === 1) : null;
      var dots = chipAlerts(summary).map(function (dot) {
        return '<span class="chip-dot' + (dot.severe ? " severe" : "") + '" title="' + esc(dot.tip) + '"></span>';
      }).join("");
      html +=
        '<div class="chip' + (key === currentKey ? " active" : "") + '">' +
        '<button type="button" class="chip-main" data-index="' + index + '" ' +
        'title="Show ' + esc(fav.name) + '">' +
        (info ? '<span class="chip-icon">' + icon(info.icon, 15) + "</span>" : "") +
        "<span>" + esc(fav.name) + "</span>" +
        (summary && summary.temperature_2m != null ? '<span class="chip-temp">' + fmtTemp(summary.temperature_2m) + "</span>" : "") +
        dots + "</button>" +
        '<button type="button" class="chip-x" data-index="' + index + '" aria-label="Remove ' + esc(fav.name) + ' from favorites" title="Remove">' +
        icon("x", 12) + "</button></div>";
    });
    if (state.favorites.length >= 2) {
      html += '<button type="button" class="compare-chip" title="Compare pinned cities side by side">' +
        icon("compare", 13) + "<span>Compare</span></button>";
    }
    wrap.innerHTML = html;
  }

  function loadChipsSummaries() {
    if (!state.favorites.length) { renderChips(); return; }
    var locs = state.favorites.map(function (fav) { return fav.latitude + "," + fav.longitude; }).join(";");
    getJSON("/api/batch?locs=" + encodeURIComponent(locs)).then(function (data) {
      var map = {};
      (data.summaries || []).forEach(function (row) {
        map[locKey(row.latitude, row.longitude)] = row;
      });
      state.chipSummaries = map;
      renderChips();
    }).catch(function () {
      state.chipSummaries = {};
      renderChips(); // chips without live temps, gracefully
    });
  }

  /* ---------- footer + title ---------- */
  function renderFooter() {
    var d = state.data;
    var extra = "";
    if (d.degraded) extra = " + wttr.in backup";
    else if (d.stale) extra = " · cached copy " + d.stale_minutes + " min old";
    $("foot-extra").textContent = extra;
    $("updated").textContent = state.updated
      ? "Updated " + state.updated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : "";
    var tz = d.timezone ? " · " + d.timezone : "";
    $("place-sub").title = tz ? "Timezone: " + d.timezone : "";
  }

  function updateTitle() {
    var cur = state.data && state.data.current;
    var name = state.location.name || "Clima";
    document.title = cur ? fmtTemp(cur.temperature_2m) + " " + name + " · Clima" : "Clima · Weather";
  }

  /* ---------- search ---------- */
  var searchState = { timer: null, results: [], selected: -1 };

  function closeResults() {
    $("results").hidden = true;
    $("search").setAttribute("aria-expanded", "false");
    searchState.selected = -1;
  }

  function renderResults() {
    var list = $("results");
    if (!searchState.results.length) {
      list.innerHTML = '<li class="no-results">No cities found</li>';
      list.hidden = false;
      $("search").setAttribute("aria-expanded", "true");
      return;
    }
    list.innerHTML = searchState.results.map(function (row, index) {
      var subParts = [row.admin1, row.country].filter(Boolean).join(", ");
      return '<li role="option" id="result-' + index + '" aria-selected="' + (index === searchState.selected) + '">' +
        '<button type="button" data-index="' + index + '"><span class="result-name">' + esc(row.name) + "</span>" +
        '<span class="result-sub">' + esc(subParts) + "</span></button></li>";
    }).join("");
    list.hidden = false;
    $("search").setAttribute("aria-expanded", "true");
  }

  function runSearch(query) {
    getJSON("/api/geocode?name=" + encodeURIComponent(query)).then(function (data) {
      if ($("search").value.trim() !== query) return; // stale response
      searchState.results = (data.results || []).slice(0, 8);
      searchState.selected = -1;
      renderResults();
    }).catch(function () { closeResults(); });
  }

  function pickResult(index) {
    var row = searchState.results[index];
    if (!row) return;
    closeResults();
    $("search").value = "";
    $("search").blur();
    load({ name: row.name, admin1: row.admin1, country: row.country, latitude: row.latitude, longitude: row.longitude });
  }

  function onSearchInput() {
    var query = $("search").value.trim();
    clearTimeout(searchState.timer);
    if (query.length < 2) { closeResults(); return; }
    searchState.timer = setTimeout(function () { runSearch(query); }, 320);
  }

  function onSearchKeydown(event) {
    var list = $("results");
    if (list.hidden) {
      if (event.key === "Enter") { event.preventDefault(); onSearchInput(); }
      return;
    }
    var count = searchState.results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      searchState.selected = count ? (searchState.selected + 1) % count : -1;
      renderResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      searchState.selected = count ? (searchState.selected - 1 + count) % count : -1;
      renderResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      pickResult(searchState.selected >= 0 ? searchState.selected : 0);
    } else if (event.key === "Escape") {
      closeResults();
    }
  }

  /* ---------- geolocate ---------- */
  function locate() {
    if (!navigator.geolocation) { flashBanner("Geolocation is not supported by this browser."); return; }
    var btn = $("locate");
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      getJSON("/api/reverse?lat=" + pos.coords.latitude + "&lon=" + pos.coords.longitude).then(function (place) {
        load({
          name: place.name || "My location",
          admin1: place.admin1 || null,
          country: place.country || null,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      }).catch(function () {
        load({
          name: "My location", admin1: null, country: null,
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
        });
      });
    }, function () {
      btn.disabled = false;
      flashBanner("Could not get your location — permission denied or unavailable.");
    }, { timeout: 10000, maximumAge: 600000 });
  }

  var flashTimer = null;
  function flashBanner(message) {
    var banner = $("banner");
    banner.hidden = false;
    banner.innerHTML = icon("alert", 17) + "<span>" + esc(message) + "</span>";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      if (!state.data || state.data.degraded || state.data.stale) renderBanner();
      else { banner.hidden = true; banner.innerHTML = ""; }
    }, 4500);
  }

  /* ---------- wiring ---------- */
  function bind() {
    $("search").addEventListener("input", onSearchInput);
    $("search").addEventListener("keydown", onSearchKeydown);
    $("search").addEventListener("blur", function () { setTimeout(closeResults, 160); });
    $("results").addEventListener("click", function (event) {
      var btn = event.target.closest("button[data-index]");
      if (btn) pickResult(Number(btn.getAttribute("data-index")));
    });
    $("locate").addEventListener("click", locate);

    document.querySelectorAll("[data-unit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.units = btn.getAttribute("data-unit");
        lsSet(LS.units, state.units);
        document.querySelectorAll("[data-unit]").forEach(function (other) {
          other.setAttribute("aria-checked", String(other === btn));
        });
        if (state.data) { renderAll(); loadChipsSummaries(); }
      });
    });

    document.querySelectorAll("[data-theme-choice]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.theme = btn.getAttribute("data-theme-choice");
        lsSet(LS.theme, state.theme);
        applyTheme();
      });
    });

    $("pin").addEventListener("click", togglePin);

    $("alerts").addEventListener("click", function (event) {
      var btn = event.target.closest(".a-close");
      if (!btn) return;
      state.dismissedAlerts[btn.getAttribute("data-alert")] = true;
      renderAlerts();
    });

    $("share").addEventListener("click", shareWeather);
    $("refresh-top").addEventListener("click", function () { load(state.location, { force: true }); });

    $("compare-close").addEventListener("click", closeCompare);
    $("compare-grid").addEventListener("click", function (event) {
      var card = event.target.closest("button.compare-card");
      if (!card) return;
      var key = card.getAttribute("data-key");
      var fav = state.favorites.filter(function (f) { return locKey(f.latitude, f.longitude) === key; })[0];
      if (!fav) return;
      closeCompare();
      load({ name: fav.name, admin1: fav.admin1, country: fav.country, latitude: fav.latitude, longitude: fav.longitude });
    });

    window.addEventListener("keydown", function (event) {
      if (event.key !== "/") return;
      var t = event.target && event.target.tagName;
      if (t === "INPUT" || t === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
      event.preventDefault();
      $("search").focus();
    });

    $("chips").addEventListener("click", function (event) {
      if (event.target.closest(".compare-chip")) {
        openCompare();
        return;
      }
      var remove = event.target.closest(".chip-x");
      if (remove) {
        state.favorites.splice(Number(remove.getAttribute("data-index")), 1);
        lsSet(LS.favs, state.favorites);
        renderPin();
        renderChips();
        loadChipsSummaries();
        return;
      }
      var main = event.target.closest(".chip-main");
      if (main) {
        var fav = state.favorites[Number(main.getAttribute("data-index"))];
        if (fav) load({ name: fav.name, admin1: fav.admin1, country: fav.country, latitude: fav.latitude, longitude: fav.longitude });
      }
    });

    $("refresh").addEventListener("click", function () { load(state.location, { force: true }); });

    window.addEventListener("scroll", function () {
      $("topbar").classList.toggle("scrolled", window.scrollY > 6);
    }, { passive: true });

    window.addEventListener("resize", function () { /* reserved for future canvas charts */ });
  }

  /* ---------- boot ---------- */
  function init() {
    document.querySelectorAll("[data-unit]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-unit") === state.units));
    });
    applyTheme();
    bind();
    load(state.location);
    setInterval(function () { load(state.location, { force: true }); }, REFRESH_MS);
    setInterval(tickMetaUpdated, 1000);                     // refresh countdown
    setInterval(function () { if (state.data) renderMeta(); }, 30000); // local clock
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
