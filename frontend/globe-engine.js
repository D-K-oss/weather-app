/* ============================================================
   Clima globe-engine.js — a tiny framework-free 3D world globe.
   Renders the one-degree land grid (land-mask.js) as a dot sphere,
   colours every dot by live temperature (IDW from world cities),
   shades the night side in real time and lets the user drag, zoom,
   hover and click cities.

   Usage:
     var globe = ClimaGlobe.create(canvasEl, {
       onCityClick: function (city) { ... }
     });
     globe.setCities([{ name, country, lat, lon, temp, code, is_day, wind, rank }, ...]);
     globe.setUnits("imperial" | "metric");
     globe.refreshTheme();          // re-read --wx-* CSS variables
     globe.focus(lat, lon);         // animate to a location
     globe.zoomBy(1.25);
     globe.destroy();

   Works standalone (classic <script>) and inside any framework.
   ============================================================ */
window.ClimaGlobe = (function () {
  "use strict";

  /* ---------- shared colour scale (exposed for legends) ---------- */
  var STOPS = [
    { t: -45, c: [31, 58, 84] },    // deep slate
    { t: -30, c: [45, 96, 132] },   // cold blue
    { t: -15, c: [86, 158, 173] },  // ice teal
    { t: -2, c: [120, 190, 170] },  // frost green
    { t: 8, c: [168, 206, 122] },   // cool green
    { t: 16, c: [214, 209, 110] },  // mild yellow-green
    { t: 23, c: [240, 189, 79] },   // warm amber
    { t: 31, c: [235, 138, 65] },   // hot orange
    { t: 42, c: [214, 59, 51] },    // extreme red
  ];

  function lerp(a, b, f) { return a + (b - a) * f; }

  function tempColor(t) {
    if (t === null || t === undefined || isNaN(t)) return null;
    if (t <= STOPS[0].t) return "rgb(" + STOPS[0].c.join(",") + ")";
    for (var i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i].t) {
        var a = STOPS[i - 1], b = STOPS[i];
        var f = (t - a.t) / (b.t - a.t);
        var rgb = [0, 1, 2].map(function (k) { return Math.round(lerp(a.c[k], b.c[k], f)); });
        return "rgb(" + rgb.join(",") + ")";
      }
    }
    return "rgb(" + STOPS[STOPS.length - 1].c.join(",") + ")";
  }

  var GRADIENT_CSS = STOPS.map(function (s) { return tempColor(s.t) + " " + ((s.t + 45) / 87 * 100).toFixed(1) + "%"; }).join(", ");

  var WMO_TEXT = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain",
    65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow",
    73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Light showers",
    81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
  };
  function wmoText(code) { return WMO_TEXT[code] || "—"; }

  var REDUCED = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* decode the base64 land bit grid into dot arrays */
  function decodeLand(mask) {
    var raw = atob(mask.bits);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var dots = [];
    for (var row = 0; row < mask.h; row++) {
      var lat = 89.5 - row;
      var radLat = lat * Math.PI / 180;
      var cosLat = Math.cos(radLat), sinLat = Math.sin(radLat);
      for (var col = 0; col < mask.w; col++) {
        var index = row * mask.w + col;
        if (bytes[index >> 3] & (1 << (7 - (index & 7)))) {
          var lon = -179.5 + col;
          var radLon = lon * Math.PI / 180;
          dots.push(cosLat, sinLat, Math.cos(radLon), Math.sin(radLon));
        }
      }
    }
    return new Float32Array(dots); // stride 4: cosLat, sinLat, cosLon, sinLon
  }

  /* subsolar point (declination + hour angle) in Earth-fixed xyz */
  function sunVector(now) {
    var start = Date.UTC(now.getUTCFullYear(), 0, 0);
    var dayOfYear = (now.getTime() - start) / 86400000;
    var decl = 23.44 * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
    var utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    var subLon = (12 - utcHours) * 15;
    var radDecl = decl * Math.PI / 180, radLon = subLon * Math.PI / 180;
    return [Math.cos(radDecl) * Math.sin(radLon), Math.sin(radDecl), Math.cos(radDecl) * Math.cos(radLon)];
  }

  function smoothstep(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /* self-injected styles (tooltip + labels) */
  var CSS_INJECTED = false;
  function injectCSS() {
    if (CSS_INJECTED) return;
    CSS_INJECTED = true;
    var style = document.createElement("style");
    style.textContent = [
      ".cg-tooltip{position:absolute;pointer-events:none;z-index:40;background:var(--wx-surface,#fff);color:var(--wx-text,#111);",
      "border:1px solid var(--wx-border,#ddd);border-radius:10px;padding:6px 10px;font:600 12px/1.35 var(--wx-font,system-ui);",
      "box-shadow:0 8px 24px -12px rgba(0,0,0,.45);white-space:nowrap;transform:translate(-50%,-135%);opacity:0;transition:opacity .12s}",
      ".cg-tooltip.on{opacity:1}",
      ".cg-tooltip .cg-tt-sub{font-weight:400;opacity:.75}",
      ".cg-wrap{position:relative}",
      ".cg-hint{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font:500 11px var(--wx-font,system-ui);",
      "color:var(--wx-muted,#888);background:color-mix(in srgb,var(--wx-surface,#fff) 78%,transparent);",
      "padding:3px 10px;border-radius:99px;pointer-events:none;transition:opacity .4s;white-space:nowrap}",
      ".cg-hint.off{opacity:0}",
    ].join("");
    document.head.appendChild(style);
  }

  function create(canvas, opts) {
    opts = opts || {};
    injectCSS();

    var ctx = canvas.getContext("2d");
    var wrap = canvas.parentElement || canvas;
    if (getComputedStyle(wrap).position === "static") wrap.classList.add("cg-wrap");

    var tooltip = document.createElement("div");
    tooltip.className = "cg-tooltip";
    tooltip.setAttribute("role", "status");
    wrap.appendChild(tooltip);

    var hint = document.createElement("div");
    hint.className = "cg-hint";
    hint.textContent = "Drag to spin - scroll to zoom - click a city";
    wrap.appendChild(hint);

    /* ---------- state ---------- */
    var DOT_STRIDE = 4;
    var dots = null;             // Float32Array land dots
    var dotCount = 0;
    var dotTemp = null;          // Float32Array interpolated temperature per dot
    var dotSun = null;           // Float32Array sun exposure per dot (day/night)
    var buckets = null;          // array of Int32Array indices, one per colour bucket
    var BRIGHT_LEVELS = 4;
    var COLOR_LEVELS = 12;
    var neutralDots = null;      // Int32Array pairs (dotIndex, brightness) for no-data dots
    var cities = [];
    var units = "metric";
    var yaw = -0.35, pitch = 0.42;   // view rotation
    var zoom = 1;
    var velYaw = 0, velPitch = 0;    // inertia
    var lastInteract = -1e9;
    var hovered = null;
    var running = false;
    var destroyed = false;
    var raf = 0;
    var sun = sunVector(new Date());
    var sunRefreshAt = 0;
    var focusAnim = null;
    var dpr = Math.max(1, window.devicePixelRatio || 1);

    /* ---------- geometry cache ---------- */

    /* IDW interpolation: every land dot takes the weighted temperature of its
       5 nearest cities. Runs once per data refresh, never per frame. */
    function computeDotTemps() {
      if (!dots || !cities.length) { dotTemp = null; return; }
      dotTemp = new Float32Array(dotCount);
      var warm = cities.filter(function (c) { return c.temp !== null && c.temp !== undefined && !isNaN(c.temp); });
      if (!warm.length) { dotTemp = null; return; }
      var vectors = warm.map(function (c) {
        var la = c.lat * Math.PI / 180, lo = c.lon * Math.PI / 180;
        var cl = Math.cos(la);
        return [cl * Math.sin(lo), Math.sin(la), cl * Math.cos(lo)];
      });
      var K = Math.min(5, vectors.length);
      for (var d = 0; d < dotCount; d++) {
        var cosLat = dots[d * DOT_STRIDE], sinLat = dots[d * DOT_STRIDE + 1];
        var cosLon = dots[d * DOT_STRIDE + 2], sinLon = dots[d * DOT_STRIDE + 3];
        /* nearest-K selection (linear scan is fine for ~100 cities) */
        var best = []; // {d2, t}
        for (var i = 0; i < vectors.length; i++) {
          var v = vectors[i];
          var dot = cosLat * sinLon * v[0] + sinLat * v[1] + cosLat * cosLon * v[2];
          var d2 = 2 - 2 * dot; // chord distance squared
          if (best.length < K || d2 < best[best.length - 1].d2) {
            var entry = { d2: d2, t: warm[i].temp };
            var pos = best.length;
            while (pos > 0 && best[pos - 1].d2 > d2) pos--;
            best.splice(pos, 0, entry);
            if (best.length > K) best.pop();
          }
        }
        var wSum = 0, tSum = 0;
        for (var k = 0; k < best.length; k++) {
          var w = 1 / (best[k].d2 + 0.004);
          wSum += w; tSum += w * best[k].t;
        }
        dotTemp[d] = tSum / wSum;
      }
    }

    function computeDotSun() {
      sun = sunVector(new Date());
      if (!dots) return;
      dotSun = new Float32Array(dotCount);
      for (var d = 0; d < dotCount; d++) {
        var cosLat = dots[d * DOT_STRIDE], sinLat = dots[d * DOT_STRIDE + 1];
        var cosLon = dots[d * DOT_STRIDE + 2], sinLon = dots[d * DOT_STRIDE + 3];
        dotSun[d] = cosLat * sinLon * sun[0] + sinLat * sun[1] + cosLat * cosLon * sun[2];
      }
    }

    function tempBucketIndex(t) {
      var span = [-45, 42];
      var f = (t - span[0]) / (span[1] - span[0]);
      f = Math.max(0, Math.min(0.999, f));
      return Math.floor(f * COLOR_LEVELS);
    }

    function bucketColor(ci, bi) {
      var t = -45 + (ci + 0.5) / COLOR_LEVELS * 87;
      var rgb = tempColor(t).slice(4, -1).split(",");
      var bright = 0.34 + 0.66 * (bi / (BRIGHT_LEVELS - 1));
      return "rgb(" + rgb.map(function (v) { return Math.round(v * bright); }).join(",") + ")";
    }

    /* rebuild the per-bucket dot index lists (colour x brightness).
       Neutral (no temperature data) dots are kept in a separate list. */
    function rebuildBuckets() {
      if (!dots) return;
      var lists = [];
      for (var i = 0; i < COLOR_LEVELS * BRIGHT_LEVELS; i++) lists.push([]);
      var neutral = [];
      for (var d = 0; d < dotCount; d++) {
        var lit = dotSun ? smoothstep(-0.06, 0.16, dotSun[d]) : 1;
        var bi = Math.min(BRIGHT_LEVELS - 1, Math.floor(lit * BRIGHT_LEVELS));
        if (dotTemp) {
          lists[tempBucketIndex(dotTemp[d]) * BRIGHT_LEVELS + bi].push(d);
        } else {
          neutral.push(d, bi);
        }
      }
      buckets = lists.map(function (arr) { return Int32Array.from(arr); });
      neutralDots = Int32Array.from(neutral);
    }

    /* ---------- theme ---------- */
    var theme = {
      text: "#f8fafc", muted: "#94a3b8", accent: "#f59e0b",
      neutral: [91, 107, 99],
    };
    function readTheme() {
      var cs = getComputedStyle(document.documentElement);
      function pick(name, fallback) {
        var v = cs.getPropertyValue(name);
        return v && v.trim() ? v.trim() : fallback;
      }
      theme.text = pick("--wx-text", theme.text);
      theme.muted = pick("--wx-muted", theme.muted);
      theme.accent = pick("--wx-accent", theme.accent);
    }

    /* ---------- sizing ---------- */
    function resize() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      var d = Math.max(1, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
        canvas.width = Math.round(w * d);
        canvas.height = Math.round(h * d);
        dpr = d;
      }
    }
    var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (resizeObserver) resizeObserver.observe(canvas);

    /* ---------- projection helpers ---------- */
    function project(cosLat, sinLat, cosLon, sinLon, R, cx, cy, cosYaw, sinYaw, cosP, sinP, out) {
      var x1 = cosLat * (sinLon * cosYaw + cosLon * sinYaw);
      var z1 = cosLat * (cosLon * cosYaw - sinLon * sinYaw);
      var y1 = sinLat;
      var z2 = y1 * sinP + z1 * cosP;
      if (z2 <= 0.012) return false; // back side (tiny margin avoids rim speckle)
      out.x = cx + R * x1;
      out.y = cy - R * (y1 * cosP - z1 * sinP);
      return true;
    }
    var P = { x: 0, y: 0 };

    /* ---------- main render ---------- */
    function render() {
      resize();
      var w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      var cx = w / 2, cy = h / 2;
      var R = (Math.min(w, h) / 2 - 8 * dpr) * zoom;

      /* ocean sphere with a soft highlight */
      var grad = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      grad.addColorStop(0, "#17323d");
      grad.addColorStop(0.65, "#10222b");
      grad.addColorStop(1, "#0b1820");
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      /* rim */
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.stroke();

      var cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
      var cosP = Math.cos(pitch), sinP = Math.sin(pitch);

      /* graticule: meridians every 30 deg, parallels every 30 deg */
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      for (var lon = -180; lon < 180; lon += 30) {
        ctx.beginPath();
        var started = false;
        for (var la = -90; la <= 90; la += 4) {
          var rla = la * Math.PI / 180, rlo = lon * Math.PI / 180;
          var ok = project(Math.cos(rla), Math.sin(rla), Math.cos(rlo), Math.sin(rlo), R, cx, cy, cosYaw, sinYaw, cosP, sinP, P);
          if (ok) { if (started) ctx.lineTo(P.x, P.y); else { ctx.moveTo(P.x, P.y); started = true; } }
          else started = false;
        }
        ctx.stroke();
      }
      for (var lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        started = false;
        var rla2 = lat * Math.PI / 180;
        for (var lo = -180; lo <= 180; lo += 4) {
          var rlo2 = lo * Math.PI / 180;
          var ok2 = project(Math.cos(rla2), Math.sin(rla2), Math.cos(rlo2), Math.sin(rlo2), R, cx, cy, cosYaw, sinYaw, cosP, sinP, P);
          if (ok2) { if (started) ctx.lineTo(P.x, P.y); else { ctx.moveTo(P.x, P.y); started = true; } }
          else started = false;
        }
        ctx.stroke();
      }

      /* land dots */
      if (dots) {
        var dotSize = Math.max(1.4 * dpr, 2.05 * dpr * Math.pow(zoom, 0.55));
        var half = dotSize / 2;
        var i, d, ok;
        if (buckets) {
          for (var b = 0; b < buckets.length; b++) {
            var list = buckets[b];
            if (!list.length) continue;
            ctx.fillStyle = bucketColor(Math.floor(b / BRIGHT_LEVELS), b % BRIGHT_LEVELS);
            for (i = 0; i < list.length; i++) {
              d = list[i];
              ok = project(dots[d * DOT_STRIDE], dots[d * DOT_STRIDE + 1], dots[d * DOT_STRIDE + 2], dots[d * DOT_STRIDE + 3], R, cx, cy, cosYaw, sinYaw, cosP, sinP, P);
              if (ok) ctx.fillRect(P.x - half, P.y - half, dotSize, dotSize);
            }
          }
        }
        /* neutral (no data) dots */
        if (neutralDots && neutralDots.length) {
          for (i = 0; i < neutralDots.length; i += 2) {
            d = neutralDots[i];
            var bi = neutralDots[i + 1];
            var bright = 0.34 + 0.66 * (bi / (BRIGHT_LEVELS - 1));
            ctx.fillStyle = "rgba(" + Math.round(theme.neutral[0] * bright) + "," + Math.round(theme.neutral[1] * bright) + "," + Math.round(theme.neutral[2] * bright) + ",0.9)";
            ok = project(dots[d * DOT_STRIDE], dots[d * DOT_STRIDE + 1], dots[d * DOT_STRIDE + 2], dots[d * DOT_STRIDE + 3], R, cx, cy, cosYaw, sinYaw, cosP, sinP, P);
            if (ok) ctx.fillRect(P.x - half, P.y - half, dotSize, dotSize);
          }
        }
      }

      /* cities: markers + labels */
      var labelSlots = [];
      var ordered = cities.slice().sort(function (a, b) { return (a.rank || 3) - (b.rank || 3); });
      var cityPx = [];
      for (var c = 0; c < ordered.length; c++) {
        var city = ordered[c];
        var la3 = city.lat * Math.PI / 180, lo3 = city.lon * Math.PI / 180;
        var cl3 = Math.cos(la3);
        var visible = project(cl3, Math.sin(la3), Math.cos(lo3), Math.sin(lo3), R, cx, cy, cosYaw, sinYaw, cosP, sinP, P);
        if (!visible) continue;
        cityPx.push({ city: city, x: P.x, y: P.y });
      }
      /* hover test cache */
      hoverPoints = cityPx;

      for (var m = 0; m < cityPx.length; m++) {
        var item = cityPx[m];
        var isHover = hovered && hovered.city === item.city;
        var isMajor = (item.city.rank || 3) === 1;
        var r = (isHover ? 4.4 : isMajor ? 3.1 : 2.3) * dpr;
        ctx.beginPath();
        ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.4 * dpr;
        ctx.strokeStyle = isHover ? theme.accent : "rgba(15,23,42,0.65)";
        ctx.stroke();
      }

      /* labels: majors + hovered, with cheap vertical overlap avoidance */
      ctx.font = "600 " + 11.5 * dpr + "px " + (getComputedStyle(document.documentElement).getPropertyValue("--wx-font") || "system-ui").split(",")[0];
      ctx.textBaseline = "middle";
      for (var l = 0; l < cityPx.length; l++) {
        var it = cityPx[l];
        var show = (hovered && hovered.city === it.city) || (it.city.rank || 3) === 1;
        if (!show) continue;
        var label = it.city.name + (it.city.temp !== null && it.city.temp !== undefined ? " " + fmtTemp(it.city.temp) : "");
        var tw = ctx.measureText(label).width;
        var lx = it.x + 8 * dpr, ly = it.y;
        if (lx + tw > w - 4) { lx = it.x - 8 * dpr - tw; }
        var clash = false;
        for (var s = 0; s < labelSlots.length; s++) {
          if (Math.abs(labelSlots[s] - ly) < 12 * dpr && Math.abs(lx - labelSlots[s + 1]) < 60 * dpr) { clash = true; break; }
        }
        if (clash && !(hovered && hovered.city === it.city)) continue;
        labelSlots.push(ly, lx);
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = "rgba(8,16,22,0.85)";
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(label, lx, ly);
      }

      /* focus animation */
      if (focusAnim) {
        var now = performance.now();
        var f = Math.min(1, (now - focusAnim.start) / focusAnim.duration);
        var ease = 1 - Math.pow(1 - f, 3);
        yaw = focusAnim.y0 + (focusAnim.y1 - focusAnim.y0) * ease;
        pitch = focusAnim.p0 + (focusAnim.p1 - focusAnim.p0) * ease;
        if (f >= 1) focusAnim = null;
      }
    }

    function fmtTemp(c) {
      var v = units === "imperial" ? c * 9 / 5 + 32 : c;
      return Math.round(v) + "°";
    }

    /* ---------- animation loop ---------- */
    var lastFrame = 0;
    function frame(now) {
      if (destroyed) return;
      raf = requestAnimationFrame(frame);
      var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
      lastFrame = now;

      /* sun moves slowly — refresh every 60s */
      if (now > sunRefreshAt) {
        computeDotSun();
        rebuildBuckets();
        sunRefreshAt = now + 60000;
      }

      /* inertia */
      if (!dragging && (Math.abs(velYaw) > 0.0001 || Math.abs(velPitch) > 0.0001)) {
        yaw += velYaw * dt;
        pitch += velPitch * dt;
        velYaw *= Math.pow(0.06, dt);
        velPitch *= Math.pow(0.06, dt);
        pitch = Math.max(-1.25, Math.min(1.25, pitch));
      }

      /* auto-rotate when idle */
      if (!REDUCED && !dragging && !focusAnim && now - lastInteract > 3000 && Math.abs(velYaw) < 0.001) {
        yaw += 0.05 * dt;
      }

      render();
    }

    function start() {
      if (running || destroyed) return;
      running = true;
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    var visible = true, pageVisible = !document.hidden;
    function updateRun() { (visible && pageVisible) ? start() : stop(); }

    var intersectionObserver = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(function (entries) {
          visible = entries[0].isIntersecting;
          updateRun();
        }, { threshold: 0.05 })
      : null;
    if (intersectionObserver) intersectionObserver.observe(canvas);
    function onVisibility() { pageVisible = !document.hidden; updateRun(); }
    document.addEventListener("visibilitychange", onVisibility);

    /* ---------- interaction ---------- */
    var pointers = new Map();
    var dragging = false;
    var moved = 0;
    var downAt = 0;
    var pinchStart = 0, pinchZoomStart = 1;
    var hoverPoints = [];

    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";

    function canvasPoint(event) {
      var rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * dpr * (canvas.width / (rect.width * dpr)), y: (event.clientY - rect.top) * dpr * (canvas.height / (rect.height * dpr)) };
    }

    function onPointerDown(event) {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, canvasPoint(event));
      if (pointers.size === 1) {
        dragging = true;
        moved = 0;
        downAt = performance.now();
        velYaw = velPitch = 0;
        focusAnim = null;
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinchStart = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchZoomStart = zoom;
      }
      lastInteract = performance.now();
      hideHint();
    }

    function onPointerMove(event) {
      var pt = canvasPoint(event);
      var prev = pointers.get(event.pointerId);
      pointers.set(event.pointerId, pt);

      if (dragging && pointers.size === 1 && prev) {
        var dx = pt.x - prev.x;
        var dy = pt.y - prev.y;
        yaw -= dx / (canvas.width * 0.5) * 1.6 / zoom;
        pitch += dy / (canvas.width * 0.5) * 1.6 / zoom;
        pitch = Math.max(-1.25, Math.min(1.25, pitch));
        velYaw = -dx / (canvas.width * 0.5) * 26 / zoom;
        velPitch = dy / (canvas.width * 0.5) * 26 / zoom;
        moved += Math.abs(dx) + Math.abs(dy);
        lastInteract = performance.now();
        return;
      }
      if (pointers.size === 2) {
        var pts2 = Array.from(pointers.values());
        var dist = Math.hypot(pts2[0].x - pts2[1].x, pts2[0].y - pts2[1].y);
        if (pinchStart > 0) {
          zoom = Math.max(0.75, Math.min(2.6, pinchZoomStart * dist / pinchStart));
        }
        lastInteract = performance.now();
        return;
      }
      /* hover (no buttons pressed) */
      if (event.buttons === 0) updateHover(pt);
    }

    function updateHover(pt) {
      var best = null, bestD = 18 * dpr;
      for (var i = 0; i < hoverPoints.length; i++) {
        var d = Math.hypot(hoverPoints[i].x - pt.x, hoverPoints[i].y - pt.y);
        if (d < bestD) { bestD = d; best = hoverPoints[i]; }
      }
      if (best) {
        var c = best.city;
        var line2 = wmoText(c.code) + (c.wind != null ? " - wind " + Math.round(units === "imperial" ? c.wind / 1.609344 : c.wind) + (units === "imperial" ? " mph" : " km/h") : "");
        tooltip.innerHTML = "<strong>" + escapeHTML(c.name) + "</strong> " +
          (c.temp !== null && c.temp !== undefined ? fmtTemp(c.temp) : "") +
          '<div class="cg-tt-sub">' + escapeHTML(line2) + "</div>";
        tooltip.style.left = best.x / dpr + "px";
        tooltip.style.top = best.y / dpr + "px";
        tooltip.classList.add("on");
        canvas.style.cursor = "pointer";
        hovered = best;
      } else {
        tooltip.classList.remove("on");
        canvas.style.cursor = dragging ? "grabbing" : "grab";
        hovered = null;
      }
    }

    function onPointerUp(event) {
      pointers.delete(event.pointerId);
      if (pointers.size === 0) {
        canvas.style.cursor = "grab";
        if (dragging && moved < 8 && performance.now() - downAt < 600) {
          updateHover(canvasPoint(event));
          if (hovered && opts.onCityClick) opts.onCityClick(hovered.city);
        }
        dragging = false;
      }
      if (pointers.size < 2) pinchStart = 0;
      lastInteract = performance.now();
    }

    function onWheel(event) {
      event.preventDefault();
      zoom = Math.max(0.75, Math.min(2.6, zoom * Math.exp(-event.deltaY * 0.0011)));
      lastInteract = performance.now();
      hideHint();
    }

    var hintHidden = false;
    function hideHint() {
      if (hintHidden) return;
      hintHidden = true;
      setTimeout(function () { hint.classList.add("off"); }, 400);
    }
    /* the hint also fades out on its own after a while */
    setTimeout(function () { hint.classList.add("off"); }, 9000);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", function () { tooltip.classList.remove("on"); hovered = null; });
    canvas.addEventListener("wheel", onWheel, { passive: false });

    function escapeHTML(s) {
      return String(s).replace(/[&<>"']/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
      });
    }

    /* ---------- public API ---------- */
    function setCities(list) {
      cities = (list || []).map(function (c) {
        return {
          name: c.name, country: c.country, lat: c.lat, lon: c.lon,
          temp: c.temp !== undefined ? c.temp : null,
          code: c.code !== undefined ? c.code : 0,
          is_day: c.is_day, wind: c.wind, rank: c.rank || 3,
        };
      });
      computeDotTemps();
      computeDotSun();
      rebuildBuckets();
    }

    function focus(lat, lon, animate) {
      var targetYaw = -lon * Math.PI / 180;
      var targetPitch = Math.max(-1.25, Math.min(1.25, lat * Math.PI / 180 * 0.85));
      /* choose the shortest equivalent yaw path */
      while (targetYaw - yaw > Math.PI) targetYaw -= 2 * Math.PI;
      while (targetYaw - yaw < -Math.PI) targetYaw += 2 * Math.PI;
      if (animate === false || REDUCED) {
        yaw = targetYaw; pitch = targetPitch; return;
      }
      focusAnim = { start: performance.now(), duration: 700, y0: yaw, y1: targetYaw, p0: pitch, p1: targetPitch };
      lastInteract = performance.now();
    }

    readTheme();
    if (window.ClimaLandMask) {
      dots = decodeLand(window.ClimaLandMask);
      dotCount = dots.length / DOT_STRIDE;
      computeDotSun();
      sunRefreshAt = performance.now() + 60000;
    }

    updateRun();

    return {
      setCities: setCities,
      setUnits: function (u) { units = u === "imperial" ? "imperial" : "metric"; },
      refreshTheme: readTheme,
      focus: focus,
      zoomBy: function (factor) { zoom = Math.max(0.75, Math.min(2.6, zoom * factor)); hideHint(); },
      destroy: function () {
        destroyed = true;
        stop();
        if (resizeObserver) resizeObserver.disconnect();
        if (intersectionObserver) intersectionObserver.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        tooltip.remove();
        hint.remove();
      },
    };
  }

  return {
    create: create,
    tempColor: tempColor,
    gradientCss: GRADIENT_CSS,
  };
})();
