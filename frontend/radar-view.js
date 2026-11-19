/* ============================================================
   Clima radar-view.js — animated live precipitation radar.

   Wraps Leaflet + the RainViewer frame index served by the Python
   backend (/api/radar/maps + /api/radar/tile) into a self-contained
   widget: basemap, animated past 2 hours, +30 min nowcast forecast,
   play/pause, scrubber, LIVE badge and intensity legend.

   Usage:
     var radar = ClimaRadar.create(container, {
       L: window.L,                                   // Leaflet global
       mapsUrl: "/api/radar/maps",                    // frame index JSON
       tileUrl: function (framePath) {                // -> Leaflet template
         return "/api/radar/tile?path=" + framePath + "&z={z}&x={x}&y={y}";
       },
       center: { lat: 41.9, lon: 12.5 },
       zoom: 5,
       theme: "dark",                                 // "light" | "dark"
     });
     radar.setTheme("light");
     radar.setCenter(lat, lon);
     radar.destroy();

   Classic <script> friendly — no modules, no build step.
   ============================================================ */
window.ClimaRadar = (function () {
  "use strict";

  /* Keyless basemaps: Esri's gray reference canvas (light + dark) — minimal
     background that keeps the precipitation overlay legible. CARTO's free
     basemaps now require an API key, so they are no longer usable. */
  var BASEMAPS = {
    light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  };
  var ATTRIBUTION =
    "Tiles &copy; Esri &middot; map data &copy; OpenStreetMap contributors &middot; " +
    'Radar &copy; <a href="https://rainviewer.com" target="_blank" rel="noopener">RainViewer</a>';
  var FRAME_MS = 520;      // playback speed
  var REFRESH_MS = 5 * 60 * 1000;
  var MAX_LAYERS = 24;     // cached frame layers

  var CSS_INJECTED = false;
  function injectCSS() {
    if (CSS_INJECTED) return;
    CSS_INJECTED = true;
    var style = document.createElement("style");
    style.textContent = [
      ".cr-wrap{position:relative;display:flex;flex-direction:column;height:100%;min-height:320px;border-radius:14px;overflow:hidden;",
      "border:1px solid var(--wx-border,#e7e5e4);background:var(--wx-surface,#fff)}",
      ".cr-map{flex:1;min-height:0;z-index:1}",
      ".cr-bar{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--wx-surface,#fff);",
      "border-top:1px solid var(--wx-border,#e7e5e4);z-index:2}",
      ".cr-play{flex:none;width:36px;height:36px;border-radius:50%;border:1px solid var(--wx-border,#e7e5e4);",
      "background:var(--wx-accent-soft,#eee);color:var(--wx-accent,#d97706);display:flex;align-items:center;",
      "justify-content:center;cursor:pointer;transition:transform .12s}",
      ".cr-play:hover{transform:scale(1.07)}",
      ".cr-mid{flex:1;min-width:0}",
      ".cr-slider{width:100%;height:22px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}",
      ".cr-slider::-webkit-slider-runnable-track{height:6px;border-radius:99px;",
      "background:linear-gradient(90deg,var(--wx-accent,#d97706) var(--cr-fill,0%),var(--wx-border,#e7e5e4) var(--cr-fill,0%))}",
      ".cr-slider::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:16px;height:16px;border-radius:50%;",
      "background:var(--wx-accent,#d97706);border:2px solid var(--wx-surface,#fff);box-shadow:0 1px 4px rgba(0,0,0,.35);margin-top:-5px}",
      ".cr-slider::-moz-range-track{height:6px;border-radius:99px;background:var(--wx-border,#e7e5e4)}",
      ".cr-slider::-moz-range-progress{height:6px;border-radius:99px;background:var(--wx-accent,#d97706)}",
      ".cr-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--wx-accent,#d97706);",
      "border:2px solid var(--wx-surface,#fff);box-shadow:0 1px 4px rgba(0,0,0,.35)}",
      ".cr-timebox{flex:none;text-align:right;min-width:86px}",
      ".cr-time{font:650 13px/1.1 var(--wx-font,system-ui);color:var(--wx-text,#1c1917);font-variant-numeric:tabular-nums}",
      ".cr-rel{font:500 10.5px/1.3 var(--wx-font,system-ui);color:var(--wx-muted,#78716c)}",
      ".cr-badge{flex:none;font:700 10px/1 var(--wx-font,system-ui);letter-spacing:.08em;padding:4px 8px;border-radius:99px}",
      ".cr-badge.live{color:#059669;background:rgba(16,185,129,.14);display:flex;align-items:center;gap:5px}",
      ".cr-badge.live::before{content:\"\";width:7px;height:7px;border-radius:50%;background:#10b981;animation:cr-pulse 1.6s infinite}",
      ".cr-badge.fc{color:#b45309;background:rgba(217,119,6,.14)}",
      "@keyframes cr-pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}70%{box-shadow:0 0 0 6px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}",
      ".cr-legend{position:absolute;left:10px;bottom:44px;z-index:500;padding:6px 9px;border-radius:10px;",
      "background:color-mix(in srgb,var(--wx-surface,#fff) 82%,transparent);backdrop-filter:blur(4px);",
      "border:1px solid var(--wx-border,#e7e5e4);font:500 9.5px/1 var(--wx-font,system-ui);color:var(--wx-muted,#78716c)}",
      ".cr-legend .cr-bar-grad{height:7px;width:110px;border-radius:99px;margin:4px 0;",
      "background:linear-gradient(90deg,#3fb0d0,#61d16b,#f9e54c,#f0953f,#e0322e,#b13ec9)}",
      ".cr-legend .cr-grad-labels{display:flex;justify-content:space-between;width:110px}",
      ".cr-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "gap:6px;z-index:600;background:var(--wx-surface,#fff);color:var(--wx-muted,#78716c);",
      "font:500 13px var(--wx-font,system-ui);text-align:center;padding:0 24px}",
      ".cr-leaflet-dark .leaflet-tile-pane{filter:brightness(.92)}",
    ].join("");
    document.head.appendChild(style);
  }

  var PLAY_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.2-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9c-.7-.4-1.6.1-1.6.9z"/></svg>';
  var PAUSE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4.4" height="16" rx="1.3"/><rect x="13.6" y="4" width="4.4" height="16" rx="1.3"/></svg>';

  function fmtClock(unixSec) {
    var d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function create(container, opts) {
    opts = opts || {};
    injectCSS();
    var L = opts.L;

    container.classList.add("cr-wrap");
    container.innerHTML =
      '<div class="cr-map" role="application" aria-label="Precipitation radar map"></div>' +
      '<div class="cr-legend" aria-hidden="true">Rainfall intensity' +
      '<div class="cr-bar-grad"></div><div class="cr-grad-labels"><span>Light</span><span>Heavy</span></div></div>' +
      '<div class="cr-bar">' +
      '<button class="cr-play" type="button" aria-label="Play radar animation">' + PLAY_SVG + "</button>" +
      '<div class="cr-mid"><input class="cr-slider" type="range" min="0" max="0" value="0" step="1" aria-label="Radar timeline"></div>' +
      '<div class="cr-timebox"><div class="cr-time">--:--</div><div class="cr-rel">loading</div></div>' +
      '<span class="cr-badge live" hidden>LIVE</span>' +
      "</div>";

    var mapDiv = container.querySelector(".cr-map");
    var playBtn = container.querySelector(".cr-play");
    var slider = container.querySelector(".cr-slider");
    var timeEl = container.querySelector(".cr-time");
    var relEl = container.querySelector(".cr-rel");
    var badge = container.querySelector(".cr-badge");

    if (!L) {
      showError("Leaflet failed to load - check vendor/leaflet.js");
      return { destroy: function () { container.innerHTML = ""; } };
    }

    var theme = opts.theme === "light" ? "light" : "dark";
    var map = L.map(mapDiv, {
      center: [opts.center ? opts.center.lat : 41.9, opts.center ? opts.center.lon : 12.5],
      zoom: opts.zoom || 5,
      minZoom: 2,
      maxZoom: 13,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    map.attributionControl.setPrefix(false);

    var basemap = null;
    function setBasemap() {
      if (basemap) map.removeLayer(basemap);
      basemap = L.tileLayer(BASEMAPS[theme], {
        attribution: ATTRIBUTION,
        maxNativeZoom: 16,
        maxZoom: 19,
      }).addTo(map);
    }
    setBasemap();

    var marker = L.circleMarker(
      [opts.center ? opts.center.lat : 41.9, opts.center ? opts.center.lon : 12.5],
      { radius: 5, color: "#0f172a", weight: 2, fillColor: "#ffffff", fillOpacity: 1 }
    ).addTo(map);

    /* ---------- frames + layers ---------- */
    var frames = [];          // {time, path, kind: "past"|"nowcast"}
    var layers = new Map();   // path -> tileLayer
    var loaded = new Set();   // paths whose tiles finished loading
    var addedPath = null;
    var index = 0;
    var playing = true;
    var timer = null;
    var destroyed = false;
    var refreshTimer = null;
    var fetchSeq = 0;

    function layerFor(frame) {
      var layer = layers.get(frame.path);
      if (!layer) {
        layer = L.tileLayer(opts.tileUrl(frame.path), {
          opacity: 0,
          maxNativeZoom: 12,
          maxZoom: 13,
          tileSize: 256,
          zIndex: 400,
        });
        layer.on("load", function () { loaded.add(frame.path); });
        layers.set(frame.path, layer);
        if (layers.size > MAX_LAYERS) {
          var oldest = layers.keys().next().value;
          if (oldest !== addedPath) {
            var old = layers.get(oldest);
            if (old) map.removeLayer(old);
            layers.delete(oldest);
          }
        }
      }
      return layer;
    }

    function showFrame(i, userInitiated) {
      if (!frames.length) return;
      index = (i + frames.length) % frames.length;
      var frame = frames[index];
      var layer = layerFor(frame);
      if (addedPath !== frame.path) {
        var prev = addedPath ? layers.get(addedPath) : null;
        layer.addTo(map);
        addedPath = frame.path;
        if (loaded.has(frame.path)) {
          layer.setOpacity(0.82);
          if (prev) map.removeLayer(prev);
        } else {
          /* poll for tile load — a missed `load` event must never freeze a frame at opacity 0 */
          var check = function () {
            if (destroyed || addedPath !== frame.path) return;
            if (loaded.has(frame.path)) {
              layer.setOpacity(0.82);
              if (prev) map.removeLayer(prev);
            } else {
              setTimeout(check, 150);
            }
          };
          check();
        }
      }

      var newestPast = 0;
      for (var k = 0; k < frames.length; k++) {
        if (frames[k].kind === "past") newestPast = Math.max(newestPast, frames[k].time);
      }
      var deltaMin = Math.round((frame.time - newestPast) / 60);
      timeEl.textContent = fmtClock(frame.time);
      if (frame.kind === "nowcast") {
        relEl.textContent = "+" + deltaMin + " min forecast";
        badge.hidden = false;
        badge.className = "cr-badge fc";
        badge.textContent = "FORECAST";
      } else if (deltaMin === 0) {
        relEl.textContent = "latest observed";
        badge.hidden = false;
        badge.className = "cr-badge live";
        badge.textContent = "LIVE";
      } else {
        relEl.textContent = deltaMin === 0 ? "now" : Math.abs(deltaMin) + " min ago";
        badge.hidden = true;
      }
      slider.value = String(index);
      slider.style.setProperty("--cr-fill", (frames.length <= 1 ? 0 : index / (frames.length - 1)) * 100 + "%");

      /* preload the next frame quietly */
      if (playing || userInitiated) {
        var next = frames[(index + 1) % frames.length];
        if (next) {
          var pre = layerFor(next);
          if (!loaded.has(next.path) && !map.hasLayer(pre)) {
            pre.addTo(map);
            pre.setOpacity(0);
          }
        }
      }
    }

    function setPlaying(on) {
      playing = on;
      playBtn.innerHTML = on ? PAUSE_SVG : PLAY_SVG;
      playBtn.setAttribute("aria-label", on ? "Pause radar animation" : "Play radar animation");
      clearInterval(timer);
      if (on && frames.length > 1) {
        timer = setInterval(function () { showFrame(index + 1); }, FRAME_MS);
      }
    }

    playBtn.addEventListener("click", function () { setPlaying(!playing); });
    slider.addEventListener("input", function () {
      setPlaying(false);
      showFrame(Number(slider.value), true);
    });

    /* ---------- data ---------- */
    function loadFrames() {
      if (destroyed) return;
      var seq = ++fetchSeq;
      fetch(opts.mapsUrl)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (data) {
          if (destroyed || seq !== fetchSeq) return;
          var past = (data.past || []).map(function (f) { return { time: f.time, path: f.path, kind: "past" }; });
          var nowcast = (data.nowcast || []).map(function (f) { return { time: f.time, path: f.path, kind: "nowcast" }; });
          if (!past.length) throw new Error("no radar frames");
          var prevTime = frames.length ? frames[index] && frames[index].time : null;
          frames = past.concat(nowcast);
          slider.max = String(frames.length - 1);
          /* keep the closest frame to whatever was on screen */
          var target = 0;
          if (prevTime) {
            var bestDelta = Infinity;
            for (var i = 0; i < frames.length; i++) {
              var d = Math.abs(frames[i].time - prevTime);
              if (d < bestDelta) { bestDelta = d; target = i; }
            }
          } else {
            target = Math.max(0, past.length - 1); // start on the latest observation
          }
          clearError();
          showFrame(target, true);
          if (!timer && playing) setPlaying(true);
          if (opts.onStatus) opts.onStatus({ state: "ready", frames: frames.length, nowcast: nowcast.length });
        })
        .catch(function (err) {
          if (destroyed || seq !== fetchSeq) return;
          showError("Radar is unavailable right now." + (err && err.message ? " (" + err.message + ")" : ""));
          if (opts.onStatus) opts.onStatus({ state: "error", error: String(err) });
          setTimeout(loadFrames, 60000);
        });
    }

    function showError(message) {
      clearError();
      var el = document.createElement("div");
      el.className = "cr-error";
      el.textContent = message;
      container.appendChild(el);
    }
    function clearError() {
      var el = container.querySelector(".cr-error");
      if (el) el.remove();
    }

    refreshTimer = setInterval(loadFrames, REFRESH_MS);
    loadFrames();

    /* re-measure the map whenever the widget becomes visible (tab switches) */
    var io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting) setTimeout(function () { map.invalidateSize(); }, 60);
        }, { threshold: 0.2 })
      : null;
    if (io) io.observe(mapDiv);

    return {
      setTheme: function (t) {
        theme = t === "light" ? "light" : "dark";
        setBasemap();
      },
      setCenter: function (lat, lon, zoomTo) {
        marker.setLatLng([lat, lon]);
        var current = map.getCenter();
        var distance = map.distance(current, [lat, lon]);
        if (distance > 60000) map.setView([lat, lon], zoomTo || map.getZoom(), { animate: true });
      },
      refresh: loadFrames,
      destroy: function () {
        destroyed = true;
        clearInterval(timer);
        clearInterval(refreshTimer);
        if (io) io.disconnect();
        map.remove();
        container.innerHTML = "";
        container.classList.remove("cr-wrap");
      },
    };
  }

  return { create: create };
})();
