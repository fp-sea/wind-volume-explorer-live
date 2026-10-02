// The Passage tab: plan a passage through waypoints clicked on the map.
//
// "The forecast": the fastest route through the loaded run (route/router.js isochrones): the 10 m
// wind and gust every hour (route/windhours.js), the chop and swell, the tidal currents (set,
// drift, the wind over the moving water, the chop on the current), the boat's polars, tacks and
// gybes, optional motoring, and the limits (gust, sea height, clearance off land, dangerous
// wind-against-current). Stats and an hour-by-hour table; "Best departure" routes every
// departure hour in the run and charts the passage time.
//
// "Currents only": no wind, for planning ahead (the stored tidal predictions run for a year): the
// shortest water path through the waypoints, then every departure in a window (every 30 min) at
// a steady speed through the water, holding the track against the cross-set, for several speeds:
// passage time against departure time (the fair-tide windows), the best departures for each speed,
// and for a chosen one a full current-aware route.

import { planRoute, alongTrack } from "./route/router.js?v=20261002173952";
import { makeEnv, CurrentField, hiresSource } from "./route/env.js?v=20261002173952";
import { latestGlobal, loadGlobal } from "./route/global.js?v=20261002173952";
import { loadSurfaceRun } from "./model/hrrrzarr.js?v=20261002173952";
import { latestCycle } from "./model/rrfs.js?v=20261002173952";
import { loadRunWind } from "./route/windhours.js?v=20261002173952";
import { loadCurrents, currentStations } from "./model/currents.js?v=20261002173952";
import { SscofsField, MixedField, sscofsLatest } from "./model/sscofs.js?v=20261002173952";
import { boatSpeed, apparent } from "./polars.js?v=20261002173952";
import { HULL, autoPlan, sailMoment } from "./sailplan.js?v=20261002173952";
import { boatForRegion, BOATS } from "./boats.js?v=20261002173952";
import { sunPosition } from "./astro.js?v=20261002173952";
import { RouteLayer } from "./layers/route.js?v=20261002173952";
import { reveal } from "./tabs.js?v=20261002173952";
import { RouteReport } from "./report.js?v=20261002173952";
import { PassageMovie } from "./movie.js?v=20261002173952";
import { loadWeather, wxLine, rainWord, cloudWord, fF, visText } from "./route/weather.js?v=20261002173952";
import * as THREE from "three";

const $ = (id) => document.getElementById(id);
const NM = 1.852, FT = 3.28084, KT = 1.943844;
const pad = (n) => String(n).padStart(2, "0");
const deg3 = (d) => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, "0");
// Magnetic variation (° east), approximate for 2026 across each region (within ~½°): for the
// True/Magnetic switch. Check the chart's compass rose for the place.
const VARIATION = { "salish-sea": 15.2, hawaii: 9.6 };
const bearing = (a, b) => ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
const hm = (h) => `${Math.floor(h)}h ${pad(Math.round((h % 1) * 60) % 60)}m`;

// A wall-clock time in a time zone ("2026-10-05T08:00", "America/Los_Angeles") → UTC ms.
function zonedToUtc(str, tz) {
  const [d, t] = str.split("T"), [Y, M, D] = d.split("-").map(Number), [h, m] = (t || "0:0").split(":").map(Number), guess = Date.UTC(Y, M - 1, D, h, m);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return guess - (asUtc - guess);
}

export class Passage {
  constructor(ex) {
    this.ex = ex; this.wps = []; this.picking = false; this.result = null;
    this.layer = new RouteLayer(); ex.stage.scene.add(this.layer.group);
    this.report = new RouteReport(this);
    this.movie = new PassageMovie(this);

    ex.stage.controls.addEventListener("change", () => this.layer.placeTag());   // (the tag stays on screen as the view moves)
    const lab = (id, f) => { const u = () => ($(`${id}-l`).textContent = f(+$(id).value)); $(id).addEventListener("input", u); u(); };
    lab("ps-gust", (v) => `${v} kt`); lab("ps-hs", (v) => `${v} ft`); lab("ps-offland", (v) => `${v} nm`); lab("ps-tack", (v) => `${v} s`);
    lab("ps-mbelow", (v) => `${v} kn`); lab("ps-narrow-w", (v) => `${v} nm`); lab("ps-mkn", (v) => `${v} kn`); lab("ps-days", (v) => `${v} day${v > 1 ? "s" : ""}`); lab("ps-kn", (v) => `${v} kn`); lab("ps-gate", (v) => (v ? `${v} nm` : "exact")); lab("ps-hz", (v) => `${v} h (${(v / 24).toFixed(1)} days)`);
    $("ps-wsrc").addEventListener("change", () => this.windUI());
    $("ps-hz").addEventListener("input", () => this.syncRun(true));
    $("ps-dep").addEventListener("input", () => this.depLabel());
    $("ps-motor").addEventListener("change", (e) => { document.querySelector(".ps-motor").hidden = !e.target.checked; });
    $("ps-narrow").addEventListener("change", (e) => { document.querySelector(".ps-narrow").hidden = !e.target.checked; });
    $("ps-mode").addEventListener("change", () => this.modeUI());
    $("ps-reset").addEventListener("click", () => this.resetDefaults());
    $("ps-pick").addEventListener("click", () => this.setPicking(!this.picking));
    $("ps-undo").addEventListener("click", () => { this.wps.pop(); this.changed(); });
    $("ps-clear").addEventListener("click", () => { this.wps = []; this.changed(); });
    $("ps-rev").addEventListener("click", () => { this.wps.reverse(); this.changed(); $("ps-status").textContent = "Reversed: route it again for the trip back."; });
    $("ps-order").addEventListener("click", () => this.bestOrder());
    $("ps-quick-go").addEventListener("click", () => this.quickRoute());
    $("ps-go").addEventListener("click", () => this.runForecast());
    $("ps-best").addEventListener("click", () => this.bestDeparture());
    $("ps-tidego").addEventListener("click", () => this.runTide());
    $("ps-chart").addEventListener("click", (e) => this.chartClick(e));
    $("ps-out").addEventListener("click", (e) => { const r = e.target.closest("tr[data-t]"); if (r) this.goTo(+r.dataset.t); });
    this.modeUI();
    this.dragSetup();
  }

  // Hovering the route line: what the boat is doing there and why.
  hoverRoute(e) {
    const P = this.result?.pts, tip = (this.tip ||= Object.assign(document.createElement("div"), { className: "ps-tip" }));
    if (!tip.parentNode) document.body.append(tip);
    if (!P?.length || e.buttons) { tip.hidden = true; return; }
    const ex = this.ex, cv = ex.stage.renderer.domElement, r = cv.getBoundingClientRect(), V = new THREE.Vector3();
    let bi = -1, bd = 10;
    for (let i = 1; i < P.length; i++) { V.set(P[i].x, P[i].y, 0.08).project(ex.stage.camera); if (V.z > 1) continue; const d = Math.hypot(r.left + ((V.x + 1) / 2) * r.width - e.clientX, r.top + ((1 - V.y) / 2) * r.height - e.clientY); if (d < bd) { bd = d; bi = i; } }
    if (bi < 0) { tip.hidden = true; return; }
    const p = P[bi], row = this.row(p, P[bi - 1], this.exportData.boat), m = p.m || {}, fixed = this.result.res.fixedKn;
    const pos = m.hold ? (m.gate ? "holding for the tide" : "waiting in harbour") : m.narrow ? "motoring through a narrow channel" : m.motor ? "motoring" : fixed ? `making ${fixed} kn through the water` : (() => { const a = Math.abs(m.twa); return a < 60 ? "beating to windward" : a < 80 ? "close reaching" : a < 115 ? "beam reaching" : a < 150 ? "broad reaching" : "running"; })();
    const wdir = Number.isFinite(row.tws) ? (() => { const c = p.c || {}, wu = (c.u || 0) - (c.cu || 0), wv = (c.v || 0) - (c.cv || 0); return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round((((Math.atan2(-wu, -wv) * 180) / Math.PI + 360) % 360) / 22.5) % 16]; })() : "";
    const cur = row.curKt >= 0.2 ? `${row.along >= 0 ? "fair" : "foul"} current ${row.along >= 0 ? "+" : "−"}${Math.abs(row.along).toFixed(1)} kt` : "little current";
    tip.innerHTML = `<b>${this.fmt(p.t)}</b> · ${pos}${!fixed && !m.hold && !m.motor && Number.isFinite(row.tws) ? ` in ${wdir} ${Math.round(row.tws)} kt` : ""}<br>${this.boatLines(p, row, { hold: m.hold }).join("<br>")}<br>${cur}${!fixed ? ` · seas ${row.hs.toFixed(1)} ft` : ""}${!fixed && !m.hold && !m.motor ? ` · ${row.sails}` : ""}`;
    tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; tip.hidden = false;
  }

  // Drag a waypoint pin on the map to move it (it snaps to the water); the route is then cleared
  // until you route again.
  dragSetup() {
    const ex = this.ex, cv = ex.stage.renderer.domElement, V = new THREE.Vector3();
    const pinAt = (e) => {
      const r = cv.getBoundingClientRect();
      let best = -1, bd = 14;
      this.wps.forEach((w, i) => { V.set(w.x, w.y, 0.08).project(ex.stage.camera); const sx = r.left + ((V.x + 1) / 2) * r.width, sy = r.top + ((1 - V.y) / 2) * r.height, d = Math.hypot(sx - e.clientX, sy - e.clientY); if (V.z < 1 && d < bd) { bd = d; best = i; } });
      return best;
    };
    // The boat on the route: grab it and drag it along the route to move through the passage.
    const toScreen = (x, y) => { const r = cv.getBoundingClientRect(); V.set(x, y, 0.08).project(ex.stage.camera); return V.z > 1 ? null : [r.left + ((V.x + 1) / 2) * r.width, r.top + ((1 - V.y) / 2) * r.height]; };
    const onBoat = (e) => { const b = this.layer.boat; if (!b?.visible || !this.layer.line.visible || !this.rp) return false; const s = toScreen(b.position.x, b.position.y); return s && Math.hypot(s[0] - e.clientX, s[1] - e.clientY) < 16; };
    // (the time on the route nearest the pointer, on screen, between points)
    const timeAt = (e) => {
      const P = this.result?.pts; if (!P) return null;
      let best = null;
      for (let i = 1; i < P.length; i++) {
        const a = toScreen(P[i - 1].x, P[i - 1].y), b = toScreen(P[i].x, P[i].y); if (!a || !b) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, u = L2 ? Math.max(0, Math.min(1, ((e.clientX - a[0]) * dx + (e.clientY - a[1]) * dy) / L2)) : 0;
        const d = Math.hypot(a[0] + u * dx - e.clientX, a[1] + u * dy - e.clientY);
        if (!best || d < best.d) best = { d, t: P[i - 1].t + u * (P[i].t - P[i - 1].t) };
      }
      return best;
    };
    this.boatDragAt = (e) => { const q = timeAt(e); if (q) { this.rp.t = q.t; this.replayAt(q.t, true); } };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (onBoat(e)) {
        e.stopImmediatePropagation(); e.preventDefault();
        if (this.rp.playing) this.stopReplay(false);
        ex.stage.controls.enabled = false; this.boatDrag = true; cv.setPointerCapture?.(e.pointerId); cv.style.cursor = "grabbing";
        return;
      }
      if (!this.wps.length) return;
      const i = pinAt(e);
      if (i < 0) return;
      e.stopImmediatePropagation(); e.preventDefault();                   // (not a map drag)
      ex.stage.controls.enabled = false; this.drag = { i, moved: false };
      cv.setPointerCapture?.(e.pointerId);
    }, { capture: true });
    cv.addEventListener("pointermove", (e) => {
      if (this.boatDrag) { this.boatDragAt(e); return; }
      if (!this.drag) { cv.style.cursor = onBoat(e) || (this.wps.length && pinAt(e) >= 0) ? "grab" : ""; this.hoverRoute(e); return; }
      const p = ex.waterPoint(e.clientX, e.clientY), w = p && this.onWater(p.x, p.y);
      if (!w) return;
      this.wps[this.drag.i] = { x: w.x, y: w.y }; this.drag.moved = true;
      this.layer.setWaypoints(this.wps); ex.stage.markDirty();
      cv.style.cursor = "grabbing";
    }, { capture: true });
    const end = () => {
      if (this.boatDrag) { this.boatDrag = false; ex.stage.controls.enabled = true; cv.style.cursor = ""; this.justDragged = performance.now(); return; }
      if (!this.drag) return;
      const moved = this.drag.moved; this.drag = null; ex.stage.controls.enabled = true; cv.style.cursor = "";
      this.justDragged = performance.now();
      if (moved) { this.changed(); $("ps-status").textContent = "Waypoint moved: route it again."; }
    };
    cv.addEventListener("pointerup", end, { capture: true });
    cv.addEventListener("pointercancel", end, { capture: true });
  }

  // The "Wind from" controls: long range and horizon only when used; the models to compare.
  windUI() {
    const m = $("ps-wsrc").value, ex = this.ex;
    $("ps-glob-row").hidden = m === "run"; $("ps-hz-row").hidden = m === "run"; $("ps-cmp").hidden = m !== "compare";
    $("ps-light-row").hidden = !ex.model?.id?.startsWith("hrrr") || m === "global";
    if (m === "compare") {
      const others = (ex.models || []).filter((q) => q.region === ex.region?.id && q.id !== ex.model?.id && q.verified && !q.archived && q.family !== "refs" && q.source !== "hrrrzarr");
      $("ps-cmp").innerHTML = [[`loaded`, `${ex.model?.short || "loaded"} (the loaded run)`], ...others.map((q) => [`m:${q.id}`, `${q.short || q.label} (newest run)`]), ["gfs", "GFS (NOAA, 0.25°)"], ["ifs", "ECMWF IFS (0.25°)"]]
        .map(([v, l]) => `<label class="row"><input type="checkbox" data-src="${v}" checked> ${l}</label>`).join("");
    }
    this.syncRun(true);
    $("ps-wnote").textContent = m === "run" ? "Only the loaded run: a passage past its end can't be routed."
      : m === "stitch" ? "The freshest run (the loaded one) first; if the passage goes past its end, the same model's longer run even if it's a few hours older (HRRR 48 h via its Zarr copy, RRFS Hawaiʻi 84 h), then the long-range model, blended over 3 hours at each hand-over. Each loaded only when the route needs it."
      : m === "stitchg" ? "The freshest run (the loaded one) first; past its end, straight to the long-range model (skipping the high-resolution model's older long run), blended over 3 hours. Loaded only when the route needs it."
      : m === "global" ? "The long-range model (GFS or ECMWF) for the whole passage: ~25 km, so gap winds and wind shadows are smoothed out, but one consistent model from start to end. Loaded a day at a time from the departure; no high-resolution download."
      : "A route with each model (from the same departure, each within its own forecast span; the global models to the horizon), side by side.";
  }

  // Every planner setting back to the page's defaults (the markup's values). Waypoints, the quick
  // route choice, the departure (it follows the map's time) and the wind already loaded are kept.
  resetDefaults() {
    for (const el of document.querySelectorAll('[data-tab="passage"] input, [data-tab="passage"] select')) {
      if (/^ps-(from-pl|via-pl|to-pl|dep|scrub)$/.test(el.id) || el.closest("#ps-cmp, #ps-out")) continue;
      if (el.type === "checkbox" || el.type === "radio") el.checked = el.defaultChecked;
      else if (el.tagName === "SELECT") { const d = [...el.options].find((o) => o.defaultSelected) || el.options[0]; if (d) el.value = d.value; }
      else el.value = el.defaultValue;
      el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change"));
    }
    this.windUI(); this.modeUI(); this.syncRun(true);
    if (this.ex.cycle) { $("ps-dep").value = String(Math.min(+$("ps-dep").max, Math.max(+$("ps-dep").min, Math.round(this.ex.t ?? 0)))); this.depLabel(); }
    this.status("Settings back to their defaults (waypoints kept).");
  }

  modeUI() {
    const tide = $("ps-mode").value === "tide";
    $("ps-forecast").hidden = tide; $("ps-tide").hidden = !tide;
    if (tide && !$("ps-from").value) {
      const tz = this.ex.region?.tz || "UTC", p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
      $("ps-from").value = `${p.year}-${p.month}-${p.day}T${pad((+p.hour + 1) % 24)}:00`;
    }
  }
  // The departure slider follows the loaded run.
  syncRun(force = false) {
    const ex = this.ex;
    this.loadedLine();
    if (!ex.cycle) return;
    const long = $("ps-wsrc").value !== "run", r = $("ps-dep"), lo = Math.ceil(+$("fhr").min), hi = long ? Math.max(Math.floor(+$("fhr").max) - 1, +$("ps-hz").value - 12) : Math.floor(+$("fhr").max) - 1;
    if (force && +r.value > hi) r.value = String(hi);
    if (+r.min !== lo || +r.max !== hi) { r.min = lo; r.max = hi; r.value = String(Math.min(hi, Math.max(lo, Math.round(ex.t ?? lo)))); }
    this.depLabel();
  }
  // Which run is loaded (the model and run the planner starts from), next to the wind choice.
  loadedLine() {
    const ex = this.ex, el = $("ps-loaded"), c = ex.cycle;
    $("ps-light-row").hidden = !ex.model?.id?.startsWith("hrrr");
    if (!c) { el.innerHTML = `Loaded: <b>no model run yet</b> (load one in the Data tab).`; return; }
    const tz = ex.region?.tz || "UTC", when = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(c);
    const key = `${ex.model?.id}|${c.getTime()}|${$("fhr").max}|${Math.floor(Date.now() / 600e3)}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = `Loaded: <b>${ex.model?.short || ex.model?.label || "model"} ${pad(c.getUTCHours())}Z</b> (${when} local, ${Math.round((Date.now() - c) / 3600e3)} h old), to +${Math.floor(+$("fhr").max)} h · <a href="#" class="ps-to-data">change</a>`;
    el.querySelector("a").onclick = (e) => { e.preventDefault(); reveal($("run-select")); $("run-select").focus(); };
  }
  depLabel() {
    const ex = this.ex;
    if (!ex.cycle) { $("ps-dep-l").textContent = ""; return; }
    $("ps-dep-l").textContent = this.fmt(ex.cycle.getTime() + +$("ps-dep").value * 3600e3);
  }
  fmt(t, long = false) {
    return new Intl.DateTimeFormat("en-US", { timeZone: this.ex.region?.tz, weekday: "short", ...(long ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit" }).format(t);
  }
  utc(t) { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; }

  setPicking(on) {
    this.picking = on;
    $("ps-pick").classList.toggle("on", on);
    $("ps-pick").textContent = on ? "Done adding waypoints" : "Add waypoints on the map";
    $("ps-status").textContent = on ? "Click the water on the map: the start, any points to pass, then the end." : $("ps-status").textContent;
  }
  // A point on the water: (x, y) itself, or the nearest water within 3 km (harbours and anchorages
  // right at the shore can fall on "land" at the planner's 0.5 km land grid). null if none.
  onWater(x, y) {
    const L = this.ex.routeGridCache?.rid === this.ex.region?.id ? this.ex.routeGridCache.grid : this.ex.landGrid();
    if (!L) return null;
    const i0 = Math.round((x - L.x0) / L.dxy), j0 = Math.round((y - L.y0) / L.dxy), wet = (i, j) => i >= 0 && j >= 0 && i < L.nx && j < L.ny && L.mask[j * L.nx + i] !== 1;
    if (wet(i0, j0)) return { x, y, moved: 0 };
    let best = null;
    for (let r = 1; r <= Math.ceil(3 / L.dxy); r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !wet(i0 + di, j0 + dj)) continue;
        const px = L.x0 + (i0 + di) * L.dxy, py = L.y0 + (j0 + dj) * L.dxy, d = Math.hypot(px - x, py - y);
        if (!best || d < best.moved) best = { x: px, y: py, moved: d };
      }
      if (best) return best;
    }
    return null;
  }
  addWaypoint(x, y, at = this.wps.length) {
    const w = this.onWater(x, y);
    if (!w) { $("ps-status").textContent = "That's land, more than 3 km from water: click the water."; return; }
    this.wps.splice(at, 0, { x: w.x, y: w.y });
    this.changed();
    if (w.moved > 0.05) $("ps-status").textContent = `Moved ${(w.moved / NM).toFixed(2)} nm to the nearest water on the planner's ${this.ex.routeGridCache?.rid === this.ex.region?.id ? "200 m" : "0.5 km"} water mask.`;
  }
  changed() {
    this.sensToken = (this.sensToken || 0) + 1;                 // (stops a sensitivity still running)
    this.stopReplay(); this.closeReplayViewer(); this.layer.setAlts?.([]); this.summary = null; this.report?.routeChanged();
    this.layer.setWaypoints(this.wps); this.layer.setRoute(null); this.result = null;
    const tz = this.ex.region?.tz;
    $("ps-list").innerHTML = this.wps.map((w, i) => { const ll = this.ex.proj.toLatLon(w.x, w.y);
      const leg = i ? ` · ${(Math.hypot(w.x - this.wps[i - 1].x, w.y - this.wps[i - 1].y) / NM).toFixed(1)} nm ${deg3(bearing(this.wps[i - 1], w))}°` : "";
      return `<li>${i === 0 ? "Start" : i === this.wps.length - 1 ? "End" : `Waypoint ${i}`} <span>${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}${leg}</span> ${i ? `<button class="btn mini ps-up" data-i="${i}" title="Move up">↑</button>` : ""}${i < this.wps.length - 1 ? `<button class="btn mini ps-dn" data-i="${i}" title="Move down">↓</button>` : ""}<button class="btn mini ps-del" data-i="${i}" title="Remove this waypoint">×</button></li>`; }).join("");
    const swap = (a, b) => { [this.wps[a], this.wps[b]] = [this.wps[b], this.wps[a]]; this.changed(); };
    for (const b of $("ps-list").querySelectorAll(".ps-up")) b.addEventListener("click", () => swap(+b.dataset.i, +b.dataset.i - 1));
    for (const b of $("ps-list").querySelectorAll(".ps-dn")) b.addEventListener("click", () => swap(+b.dataset.i, +b.dataset.i + 1));
    for (const b of $("ps-list").querySelectorAll(".ps-del")) b.addEventListener("click", () => { this.wps.splice(+b.dataset.i, 1); this.changed(); });
    $("ps-out").innerHTML = ""; $("ps-chart").hidden = true;
    this.ex.stage.markDirty();
  }
  regionChanged(rid = this.ex.region?.id) {
    this.stopReplay(); this.wps = []; this.setPicking(false); this.changed(); $("ps-status").textContent = ""; this.loaded = null; this.compare = null;
    setTimeout(() => this.ex.routeGrid?.(), 3000);                  // (the fine water mask, ahead of use)
    this.windUI(); this.loadQuick(rid);
  }
  // The region's common places and vias (web/data/<region>/passages.json), alphabetical.
  // (rid: the region being set up; this.ex.region may not be set yet when it changes)
  async loadQuick(rid = this.ex.region?.id) {
    this.quickRid = rid;
    const d = rid ? await fetch(`data/${rid}/passages.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    if (this.quickRid !== rid) return;
    const key = (q) => q.name.replace(/[ʻ‘']/g, ""), abc = (a, b) => key(a).localeCompare(key(b), "en", { sensitivity: "base" });   // (Hāna before Hilo; ʻokina and macrons ignored)
    if (d) { d.places?.sort(abc); d.vias?.sort(abc); }
    this.quick = d;
    document.querySelector(".ps-quick").hidden = !d?.places?.length;
    if (!d) return;
    const opt = (list, none) => (none ? `<option value="">${none}</option>` : "") + list.map((q, i) => `<option value="${i}">${q.name}</option>`).join("");
    $("ps-from-pl").innerHTML = opt(d.places, "choose…"); $("ps-to-pl").innerHTML = opt(d.places, "choose…"); $("ps-via-pl").innerHTML = opt(d.vias || [], "(direct)");
  }
  quickRoute() {
    const d = this.quick, f = $("ps-from-pl").value, v = $("ps-via-pl").value, to = $("ps-to-pl").value;
    if (!d || f === "" || to === "") { $("ps-status").textContent = "Choose where from and where to."; return; }
    const pts = [d.places[+f], ...(v !== "" ? [d.vias[+v]] : []), d.places[+to]];
    this.wps = [];
    for (const q of pts) { const p = this.ex.proj.toXY(q.lat, q.lon), w = this.onWater(p.x, p.y); if (w) this.wps.push({ x: w.x, y: w.y }); }
    this.changed();
    $("ps-status").textContent = `${pts.map((q) => q.name).join(" → ")}: set. Route it${v !== "" ? "" : " (or choose a via)"}.`;
  }

  boat() {
    const key = boatForRegion(this.ex.region.id), H = HULL[key];
    return { key, polar: (tws, twa) => boatSpeed(key, tws, twa), lwl: H.lwl, motorKn: +$("ps-mkn").value, motorBelow: +$("ps-mbelow").value, tackS: +$("ps-tack").value, gybeS: +$("ps-tack").value * 0.6, noGo: 42 };
  }
  // Stations with their predictions from tA to tB and the field between them (cached per span).
  // The current field for tA..tB: NOAA's stations (predictions, blended between them), or SSCOFS
  // (the Salish Sea model, where it has the hours) with the stations beyond it. source: "stations"
  // | "sscofs" (default: the Currents from choice). Cached per span and source.
  async field(tA, tB, { source = null } = {}) {
    const rid = this.ex.region.id, src = rid === "salish-sea" ? source || $("ps-cursrc")?.value || "stations" : "stations", key = `${rid}|${tA}|${tB}|${src}`;
    this.fields ||= new Map();
    if (this.fields.has(key)) return this.fields.get(key);
    if (!(await currentStations(rid)).length) return null;
    const st = await loadCurrents(rid, new Date(tA), new Date(tB));
    for (const q of st) { const xy = this.ex.proj.toXY(q.lat, q.lon); q.x = xy.x; q.y = xy.y; }
    const land = await this.ex.routeGrid();
    let f = new CurrentField(st, land);                              // (200 m: narrow channels get their stations' currents)
    f.prepare(tA - 3600e3, tB + 3600e3, 300e3);
    f.label = `NOAA predictions (${st.length} stations)`;
    if (src === "sscofs") {
      const S = this.sscofs?.rid === rid ? this.sscofs.f : await (async () => { this.status("Loading SSCOFS currents (the model's mesh)…"); const s = await SscofsField.open(land, this.ex.proj).catch((e) => { console.warn("SSCOFS", e); return null; }); this.sscofs = { rid, f: s }; return s; })();
      if (S) {
        this.status(`Loading SSCOFS currents for the passage's hours…`);
        await S.prepare(tA, tB);
        const age = Math.round((Date.now() - S.meta.cycleDate.getTime()) / 3600e3), past = tB > S.meta.t1;
        const mf = new MixedField(S, f);
        mf.label = `SSCOFS ${S.label.slice(7)} (run ${age} h old)${past ? `, NOAA stations past ${this.fmt(S.meta.t1)}` : ""}${mf.weakNote()}`;
        f = mf;
      } else f.label += " (SSCOFS isn't available right now)";
    }
    if (this.fields.size > 6) this.fields.delete(this.fields.keys().next().value);
    this.fields.set(key, f); if (!source) this.fieldObj = f;          // (the plan's own; not the sensitivity's other one)
    return f;
  }
  opts(extra = {}) {
    return { dtMin: +$("ps-dt").value, dhDeg: 5, currents: true, motor: $("ps-motor").checked, narrowKm: $("ps-narrow").checked ? +$("ps-narrow-w").value * NM : 0, maxHours: 96, gateKm: +$("ps-gate").value * NM,
      limits: { maxGustKt: +$("ps-gust").value, maxHsM: +$("ps-hs").value / FT, clearKm: +$("ps-offland").value * NM, avoidDanger: $("ps-danger").checked }, ...extra };
  }
  // The viewer's time row, while it sails a passage: the passage (scrub and sail it from there).
  viewerCtl() {
    const ex = this.ex;
    return {
      get: () => (this.result && this.rp?.inRun ? { passage: true, min: this.result.pts[0].t, max: this.result.pts.at(-1).t, step: 60000, value: this.rp.t, tz: ex.region?.tz } : null),
      set: (t) => { this.rp.t = t; if (this.rp.playing) this.stopReplay(false); this.replayAt(t, true); },
      play: () => (this.rp?.playing ? this.stopReplay(false) : this.startReplay()),
      playing: () => !!this.rp?.playing,
    };
  }
  // A bearing (° true) as shown: true or magnetic per the switch, with T or M.
  brg(d) {
    if (!Number.isFinite(d)) return "–";
    const mag = $("ps-brg")?.value === "mag";
    return `${deg3(mag ? d - (VARIATION[this.ex.region?.id] ?? 0) : d)}°${mag ? "M" : "T"}`;
  }
  // Course made good at route point p: from the start of the leg it's on.
  cmg(p) {
    const res = this.result?.res, leg = res?.legs?.find((l) => p.t >= l.t0 && p.t <= l.t1), a = leg ? (leg.from === 0 ? this.result.pts[0] : this.wps[leg.from]) : this.result?.pts[0];
    return a && Math.hypot(p.x - a.x, p.y - a.y) > 0.05 ? bearing(a, p) : NaN;
  }
  // The boat's numbers at a route point, as short lines (hover, map tag): speeds, headings and
  // courses, true and apparent wind, and the tack.
  boatLines(p, row, { hold = false } = {}) {
    const fixed = this.result.res.fixedKn, side = (v) => (Number.isFinite(v) ? `${Math.round(Math.abs(v))}° ${v < 0 ? "P" : "S"}` : "–");
    const tack = row.side > 0 ? "starboard tack" : row.side < 0 ? "port tack" : "";
    const L = [];
    if (!hold) L.push(`STW ${(row.bsp ?? 0).toFixed(1)} · SOG ${row.sog.toFixed(1)} kn`, `HDG ${this.brg(row.hdg)} · COG ${this.brg(row.cog)} · CMG ${this.brg(this.cmg(p))}`);
    if (!fixed && Number.isFinite(row.tws)) {
      L.push(`TWS ${Math.round(row.tws)} kt (gust ${Math.round(row.gust)}) from ${this.brg(row.twd)}`);
      if (!hold && !row.motor) L.push(`TWA ${side(row.twa)} · ${tack}`, `AWS ${Math.round(row.aws)} kt · AWA ${side(row.awa)}`);
    }
    return L;
  }
  variation() { return VARIATION[this.ex.region?.id] ?? 0; }
  sunAlt(t, ll) { return sunPosition(new Date(t), ll.lat, ll.lon).altitude * 57.2958; }   // (degrees, for darkness)
  // A place on the map in words: the nearest common place or via within 3 nm, else its position.
  spotName(s) {
    const ll = this.ex.proj.toLatLon(s.x, s.y), q = this.quick;
    let best = null;
    for (const p of [...(q?.places || []), ...(q?.vias || [])]) { const xy = this.ex.proj.toXY(p.lat, p.lon), d = Math.hypot(xy.x - s.x, xy.y - s.y); if (d < 3 * NM && (!best || d < best.d)) best = { d, name: p.name }; }
    return best ? `near ${best.name}` : `at ${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}`;
  }
  status(html) { $("ps-status").innerHTML = html; }

  // The wind sources. "loaded": the loaded run (every hour). extended: also the same model's longer
  // run where it's light to fetch, then the global model to the horizon. → [source]
  async loadedSource() {
    const ex = this.ex, hours = []; for (let h = Math.ceil(+$("fhr").min); h <= Math.floor(+$("fhr").max); h++) hours.push(h);
    // Lighter (option, HRRR): the loaded run from the Zarr copy if it's there, else the newest run
    // that is (an hour or a few older), rather than ~6 MB an hour of full-country files.
    if ($("ps-light").checked && ex.model?.id.startsWith("hrrr")) {
      for (let k = 0; k <= 6; k++) {
        const cyc = new Date(ex.cycle.getTime() - k * 3600e3);
        this.status(k ? `Looking for a lighter HRRR run in the Zarr copy (${pad(cyc.getUTCHours())}Z)…` : "Looking for this run in the HRRR Zarr copy…");
        const z = await loadSurfaceRun(cyc, ex.region.bbox).catch(() => null);
        if (z?.hours?.length > 1) {
          const S = hiresSource(z, cyc, `HRRR ${pad(cyc.getUTCHours())}Z${k ? " (Zarr, lighter)" : ""}`, "loaded");
          S.via = z.source || "the HRRR Zarr copy"; return S;
        }
      }
      this.status("No HRRR run in the Zarr copy yet: loading the run hour by hour…");
    }
    this.status("Loading the wind and gusts for every hour of the run…");
    const w = await loadRunWind(ex.model, ex.cycle, hours, ex.region.bbox, { stores: ex.stores,
      onProgress: (p) => this.status(`Loading the wind and gusts for every hour of the run… ${p.of > 1 ? `${p.done} of ${p.of} hours, ` : ""}${(p.bytes / 1e6).toFixed(1)} MB`) });
    const S = hiresSource(w, ex.cycle, `${ex.model?.short || "model"} ${pad(ex.cycle.getUTCHours())}Z`, "loaded");
    S.via = w.source; return S;
  }
  // The same model's longer run past `after`, where it's light to fetch (HRRR through its Zarr
  // copy, RRFS Hawaiʻi's small grid). → source, or null
  async longRun(after, until) {
    const ex = this.ex, m = ex.model;
    const longMax = Math.max(...m.cycles.map((c) => c.maxFhr));
    if (!(after < until && ex.cycle.getTime() + longMax * 3600e3 > after && (m.id.startsWith("hrrr") || m.region === "hawaii"))) return null;
    try {
      this.status(`Finding ${m.short}'s newest long run (to +${longMax} h)…`);
      const L = m.id.startsWith("hrrr") ? null : await latestCycle(m, { needFhr: longMax, which: m.path2d ? "path2d" : "path" });
      let cyc = L?.cycle;
      if (m.id.startsWith("hrrr")) { for (let h = Math.floor(Date.now() / 6 / 3600e3) * 6 * 3600e3, k = 0; k < 5 && !cyc; k++, h -= 6 * 3600e3) { const z = await loadSurfaceRun(new Date(h), ex.region.bbox).catch(() => null); if (z && z.hours.at(-1) >= 36) cyc = new Date(h); } }
      if (!cyc || cyc.getTime() + longMax * 3600e3 <= after) return null;
      const c = cyc.getTime(), hours = []; for (let h = Math.max(0, Math.floor((after - 3 * 3600e3 - c) / 3600e3)); h <= longMax && c + h * 3600e3 <= until + 3600e3; h++) hours.push(h);
      if (hours.length < 2) return null;
      this.status(`Loading ${m.short} ${pad(cyc.getUTCHours())}Z long run for the hours past the loaded run…`);
      const w = await loadRunWind(m, cyc, hours, ex.region.bbox, { onProgress: (p) => this.status(`Loading ${m.short} ${pad(cyc.getUTCHours())}Z long run… ${(p.bytes / 1e6).toFixed(1)} MB`) });
      const S = hiresSource(w, cyc, `${m.short} ${pad(cyc.getUTCHours())}Z (long run)`, "long"); S.via = w.source;
      return S;
    } catch (e) { console.warn("long run", e); return null; }
  }
  // The global model (GFS or ECMWF IFS) from `after` to `until`. → source
  // cycle: the run to use (to extend one already loaded), else the newest one reaching `reach`.
  async globalRun(after, until, kind = $("ps-glob").value, { cycle = null, reach = until } = {}) {
    const ex = this.ex, name = kind === "gfs" ? "GFS" : "ECMWF IFS";
    if (!cycle) this.status(`Finding the newest ${name} run…`);
    const G = cycle ? { cycle } : await latestGlobal(kind, reach);
    if (!G) throw new Error(`no ${name} run reaching ${this.fmt(until, true)} is posted yet`);
    this.status(`Loading ${name} ${pad(G.cycle.getUTCHours())}Z (10 m wind and gust, every 3 h)…`);
    return loadGlobal(kind, G.cycle, after - 3 * 3600e3, until, ex.region.bbox, { onProgress: (p) => this.status(`Loading ${name} ${pad(G.cycle.getUTCHours())}Z: ${p.done} of ${p.of} steps, ${(p.bytes / 1e6).toFixed(1)} MB`) });
  }
  // The routing environment for a list of sources; currents for their whole span.
  async envFor(sources) {
    const ex = this.ex, t0 = Math.min(...sources.map((s) => s.times[0])), t1 = Math.max(...sources.map((s) => s.times.at(-1)));
    const field = $("ps-cur").checked ? await this.field(ex.cycle.getTime() + Math.ceil(+$("fhr").min) * 3600e3, t1) : null;
    return { env: makeEnv(ex, sources, field, { currents: !!field, land: await ex.routeGrid() }), field, sources };
  }
  // level 0: the loaded run; 1: + the same model's long run; 2, 3, …: + the global model for 1, 2, …
  // days past that (to the horizon). Each is loaded only when asked for, and kept for the next plan.
  // → {env, field, sources, level, more: whether a higher level would add hours}
  async forecastEnv(level = 0, { from = null } = {}) {
    const ex = this.ex;
    if (!ex.cycle || !ex.vol) throw new Error("load a model run first (Data tab)");
    const mode = $("ps-wsrc").value, hz = ex.cycle.getTime() + +$("ps-hz").value * 3600e3;
    // The long-range model only: a day at a time from a little before the departure (the earliest
    // being now, so the sensitivity's earlier departures are covered).
    if (mode === "global") {
      const kind = $("ps-glob").value, f = from ?? ex.cycle.getTime(), after = Math.max(ex.cycle.getTime(), Math.min(f - 7 * 3600e3, Math.max(f - 3 * 3600e3, Date.now() - 3600e3)));
      const to = Math.min(hz, after + (level + 1) * 24 * 3600e3);
      let G = this.globalOnly;
      if (!G || G.kind !== kind || G.cyc !== ex.cycle.getTime() || G.after > after) G = this.globalOnly = { kind, after, cyc: ex.cycle.getTime(), to: 0, S: null };
      if (!G.S || G.to < to) {
        const part = await this.globalRun(G.S ? G.S.times.at(-1) : G.after, to, kind, { cycle: G.S?.cycle, reach: hz });
        if (G.S) { for (const [tt, fr] of part.frames) G.S.frames.set(tt, fr); G.S.times = [...G.S.frames.keys()].sort((a, b) => a - b); G.S.bytes += part.bytes; } else G.S = part;
        G.to = to;
      }
      return { ...(await this.envFor([G.S])), level, more: to < hz };
    }
    this.loaded ||= {};
    const key = `${ex.model.id}|${ex.cycle.getTime()}|${$("ps-light").checked && ex.model.id.startsWith("hrrr") ? "light" : ""}`;
    if (this.loaded.key !== key) this.loaded = { key, src: await this.loadedSource() };
    const L = this.loaded, sources = [L.src], until = ex.cycle.getTime() + +$("ps-hz").value * 3600e3;
    let more = level < 1 && L.src.times.at(-1) < until;
    if (level >= 1 && mode !== "stitchg") {
      if (L.longUntil == null || L.longUntil < until) { L.long = await this.longRun(L.src.times.at(-1), until); L.longUntil = until; }
      if (L.long) sources.push(L.long);
      else level = Math.max(level, 2);                       // (no long run to try: on to the global model)
      more = sources.at(-1).times.at(-1) < until;
    } else if (level >= 1) level = Math.max(level, 2);        // (straight to the long-range model)
    if (level >= 2) {
      const after = sources.at(-1).times.at(-1), to = Math.min(until, after + (level - 1) * 24 * 3600e3), kind = $("ps-glob").value;
      if (after < until) {
        const G = L.glob?.kind === kind && L.glob.after === after ? L.glob : null;
        if (!G || G.to < to) {
          // (the run is chosen to reach the horizon, so later days extend the same run)
          const part = await this.globalRun(G ? G.S.times.at(-1) : after, to, kind, { cycle: G?.S.cycle, reach: until });
          if (G) { for (const [t, f] of part.frames) G.S.frames.set(t, f); G.S.times = [...G.S.frames.keys()].sort((a, b) => a - b); G.S.bytes += part.bytes; G.to = to; }
          else L.glob = { kind, after, to, S: part };
        }
        sources.push(L.glob.S);
      }
      more = to < until;
    }
    return { ...(await this.envFor(sources)), level, more };
  }

  async runForecast(depH = +$("ps-dep").value) {
    if (this.wps.length < 2) { this.status("Add at least a start and an end on the map."); return; }
    this.setPicking(false);
    if ($("ps-wsrc").value === "compare") return this.runCompare(depH);
    try {
      const t0 = this.ex.cycle.getTime() + depH * 3600e3, boat = this.boat(), stitch = ["stitch", "stitchg", "global"].includes($("ps-wsrc").value);
      const route = async (level) => {
        const E = await this.forecastEnv(level, { from: t0 }), t00 = performance.now();
        this.status("Routing…");
        const res = await planRoute(E.env, boat, this.opts({ currents: !!E.field }), this.wps, t0, { onProgress: ({ leg, step }) => this.status(`Routing… leg ${leg + 1}, ${Math.round((step * +$("ps-dt").value) / 60 * 10) / 10} h out`) });
        return { E, res, level: E.level, more: E.more, ms: performance.now() - t00 };
      };
      // The loaded run first; only if the passage runs past its end (or leaves after it), the same
      // model's long run, and only past that, the global model.
      const runEnd = this.ex.cycle.getTime() + Math.floor(+$("fhr").max) * 3600e3;
      let R = await route(stitch && $("ps-wsrc").value !== "global" && t0 >= runEnd - 3600e3 ? 1 : 0);
      while (!R.res.ok && stitch && R.more && /end of the forecast/.test(R.res.reason)) {
        this.status($("ps-wsrc").value === "global" || R.level >= 2 ? "The passage goes further: loading another day of the long-range model…" : R.level === 0 ? "The passage goes past the loaded run: loading the longer run…" : "The passage goes past the high-resolution runs: loading the long-range model…");
        R = await route(R.level + 1);
      }
      const { E, res } = R;
      if (!res.ok) { this.showFail(res, E.env, boat, { sources: E.sources, field: E.field }); return; }
      this.show(res, E.env, boat, { sources: E.sources, field: E.field, ms: R.ms });
    } catch (e) { this.status(`Couldn't route: ${e.message}`); console.error(e); }
  }

  // No route: why (what stopped the last moves most, where and when), and the best partial route.
  showFail(res, env, boat, meta) {
    const w = res.why, ll = w?.x != null ? this.ex.proj.toLatLon(w.x, w.y) : null;
    const where = w ? ` Mostly stopped by <b>${w.what}</b>${ll ? ` near ${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}` : ""}${w.t ? ` at ${this.fmt(w.t)}` : ""}.` : "";
    const hint = /gust/.test(w?.what) ? " Raise Max gust, or try another departure." : /seas/.test(w?.what) ? " Raise Max seas, or try another departure." : /clearance/.test(w?.what) ? " Lower Off land." : /current/.test(w?.what) ? " Untick Avoid dangerous wind-against-current, or try another departure." : "";
    if (res.partial?.length > 1) {
      this.show({ ok: true, pts: res.partial, legs: res.legs, partial: true }, env, boat, meta);
      $("ps-status").innerHTML = `<b>No complete route:</b> ${res.reason}.${where}${hint} The route as far as it got is shown (pink), with its stats.`;
    } else { this.status(`<b>No route:</b> ${res.reason}.${where}${hint}`); this.layer.setRoute(null); $("ps-out").innerHTML = ""; }
  }

  // Where the wind came from along the passage: each source, the stretch of the passage it covered,
  // its run and how old the run is (now), and the forecast lead over that stretch.
  provenance(pts, sources) {
    const segs = [];
    for (const p of pts) { const s = p.c?.src || "?"; if (segs.at(-1)?.src === s) segs.at(-1).t1 = p.t; else segs.push({ src: s, t0: p.t, t1: p.t }); }
    const now = Date.now(), age = (S) => Math.round((now - S.cycle.getTime()) / 3600e3);
    const byLabel = new Map(sources.map((S) => [S.label, S]));
    const li = segs.map((g) => {
      const parts = g.src.split(" → "), A = byLabel.get(parts[0]), B = parts[1] && byLabel.get(parts[1]);
      const lead = (S, t) => Math.round((t - S.cycle.getTime()) / 3600e3);
      const what = B ? `blending <b>${A?.label}</b> into <b>${B.label}</b>` : `<b>${g.src}</b>${A ? ` (run ${age(A)} h old now; lead +${lead(A, g.t0)} to +${lead(A, g.t1)} h${A.res ? `; ${A.res}` : ""})` : ""}`;
      return `<li>${this.fmt(g.t0)} – ${this.fmt(g.t1)}: ${what}</li>`;
    }).join("");
    return `<div class="ps-prov"><b>Wind from</b><ul>${li}</ul></div>`;
  }

  // Holds along the way (for the tide, at a gate's approach or out of a strong foul stream): each
  // run with where, when, how long and what for. → [{t0, t1, h, x, y, where, why}]
  holds(pts) {
    const out = [];
    let cur = null;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p.m?.hold && p.m.gate) { if (!cur) out.push((cur = { t0: pts[i - 1].t, t1: p.t, x: p.x, y: p.y, gateAt: p.m.gateAt })); else cur.t1 = p.t; }
      else cur = null;
    }
    for (const h of out) {
      h.h = (h.t1 - h.t0) / 3600e3; h.where = this.spotName(h);
      h.why = h.gateAt ? `for the current to ease at the narrows ${this.spotName(h.gateAt).replace(/^(near|at) /, "by ")}` : "for the foul current to ease or turn";
    }
    return out;
  }
  // Why the route waits: gusts near the limit at the start, a foul tide, or too little wind.
  waitWhy(pts, boat) {
    const hold = pts.filter((p) => p.m?.hold), go = pts.find((p, i) => i && !p.m?.hold);
    const maxG = Math.max(...hold.map((p) => (p.c?.g || 0) * KT)), lim = +$("ps-gust").value;
    if (maxG >= 0.85 * lim) return `for gusts to ease (up to ${Math.round(maxG)} kt against your ${lim} kt limit on the way)`;
    const r0 = hold[0] && this.row(hold[0], pts[0], boat), r1 = go && this.row(go, pts[pts.indexOf(go) - 1], boat);
    if (r1 && r1.along > 0.3 && (!r0 || r0.along <= 0.3)) return "for a fair tide";
    return "for better wind or tide";
  }

  // The waypoints between start and end in the order with the shortest way by water (every order,
  // for up to 7 of them; otherwise nearest-next).
  async bestOrder() {
    const W = this.wps;
    if (W.length < 4) { $("ps-status").textContent = "Best order needs at least two waypoints between the start and the end."; return; }
    const land = await this.ex.routeGrid(), env = makeEnv(this.ex, null, null, { windless: true, land });
    const D = W.map((w) => env.toGo(w.x, w.y)), d = (i, j) => D[j](W[i].x, W[i].y);
    const mid = W.slice(1, -1).map((_, k) => k + 1), last = W.length - 1;
    let best = null;
    const cost = (ord) => { let s = d(0, ord[0]); for (let k = 1; k < ord.length; k++) s += d(ord[k - 1], ord[k]); return s + d(ord.at(-1), last); };
    if (mid.length <= 7) {
      const perm = (a, k = 0) => { if (k === a.length) { const c = cost(a); if (!best || c < best.c) best = { c, o: [...a] }; return; } for (let i = k; i < a.length; i++) { [a[k], a[i]] = [a[i], a[k]]; perm(a, k + 1); [a[k], a[i]] = [a[i], a[k]]; } };
      perm([...mid]);
    } else { const left = new Set(mid), o = []; let cur = 0; while (left.size) { let bj = null; for (const j of left) if (bj == null || d(cur, j) < d(cur, bj)) bj = j; o.push(bj); left.delete(bj); cur = bj; } best = { c: cost(o), o }; }
    const before = cost(mid);
    this.wps = [W[0], ...best.o.map((k) => W[k]), W[last]];
    this.changed();
    $("ps-status").textContent = best.c < before - 0.05 ? `Reordered: ${(best.c / NM).toFixed(1)} nm by water instead of ${(before / NM).toFixed(1)}. Route it again.` : "That order was already the shortest by water.";
  }

  // Why the route goes the way it does, in words.
  why(pts, boat, stats) {
    const out = [], land = this.ex.routeGridCache?.grid;
    let beat = 0, run = 0, reach = 0, tot = 0, gain = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], dt = (p.t - pts[i - 1].t) / 3600e3; if (p.m?.hold) continue; tot += dt;
      const a = Math.abs(p.m?.twa ?? 90); if (!p.m?.motor) { if (a < 70) beat += dt; else if (a > 130) run += dt; else reach += dt; }
      gain += this.row(p, pts[i - 1], boat).along * dt;              // nm the current added along the track
    }
    if (stats.rhumb > 0 && stats.water > stats.rhumb * 1.08) out.push(`Land is in the way: the shortest way by water is ${(stats.water / NM).toFixed(1)} nm against ${(stats.rhumb / NM).toFixed(1)} nm straight.`);
    if (tot && beat / tot > 0.25) out.push(`Beating to windward ${Math.round((beat / tot) * 100)}% of the time: the tacks (${stats.nT}) make the distance sailed ${(stats.dist / NM).toFixed(1)} nm.`);
    else if (tot && run / tot > 0.4) out.push(`Mostly running (${Math.round((run / tot) * 100)}%)${stats.nG ? `, with ${stats.nG} gybe${stats.nG > 1 ? "s" : ""} to keep a better angle` : ""}.`);
    else if (tot && reach / tot > 0.5) out.push(`Mostly reaching (${Math.round((reach / tot) * 100)}% of the time): the fast point of sail.`);
    if (stats.waitH > 0.05) out.push(`Waits ${hm(stats.waitH)} in harbour, ${this.waitWhy(pts, boat)}: leaving at once gets there no sooner.`);
    for (const h of stats.holds || []) out.push(`Holds ${hm(h.h)} ${h.where} (${this.fmt(h.t0)} to ${this.fmt(h.t1)}) ${h.why}: pushing on against it gets there later.`);
    if (Math.abs(gain) > 0.3) out.push(`The current ${gain > 0 ? "helps" : "hinders"} overall: about ${Math.abs(gain).toFixed(1)} nm ${gain > 0 ? "gained" : "lost"} along the way (${hm(stats.fair)} fair, ${hm(stats.foul)} foul).`);
    if (stats.maxG >= 0.9 * +$("ps-gust").value) out.push(`The gust limit (${$("ps-gust").value} kt) is close to what's met (${Math.round(stats.maxG)} kt): it shapes the timing or the way.`);
    if (stats.motorH > 0.05) out.push(`Motors ${hm(stats.motorH)} where the sails would make less than ${$("ps-mbelow").value} kn.`);
    return out;
  }

  // Tacks and gybes, and the hour-by-hour rows.
  analyse(pts, boat) {
    const tacks = [], rows = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.m && b.m && !a.m.motor && !b.m.motor && !a.m.hold && !b.m.hold && a.m.side && b.m.side && a.m.side !== b.m.side) tacks.push({ x: a.x, y: a.y, t: a.t, kind: Math.abs(b.m.twa) < 90 ? "tack" : "gybe" });
    }
    let nextH = Math.ceil(pts[0].t / 3600e3) * 3600e3;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p.t >= nextH || i === pts.length - 1) { rows.push({ p, prev: pts[i - 1] }); while (nextH <= p.t) nextH += 3600e3; }
    }
    return { tacks, rows };
  }
  row(p, prev, boat, trackBrg) {
    const c = p.c || prev.c || {}, cu = c.cu || 0, cv = c.cv || 0, wu = (c.u || 0) - cu, wv = (c.v || 0) - cv, tws = Math.hypot(wu, wv) * KT;
    const twd = ((Math.atan2(-wu, -wv) * 180) / Math.PI + 360) % 360, gust = (c.g || 0) * KT, m = p.m || {}, hdg = p.h ?? 0;
    const cog = bearing(prev, p), curKt = Math.hypot(cu, cv) * KT, along = ((cu * Math.sin((cog * Math.PI) / 180) + cv * Math.cos((cog * Math.PI) / 180)) * KT);
    let sails = "–";
    if (!m.motor && m.bsp > 0 && Number.isFinite(m.twa)) {
      const awG = apparent(twd, gust, hdg, m.bsp), key = boat.key;
      sails = autoPlan(key, Math.abs(m.twa), gust, (awG.aws / KT) * 0.93, awG.awa, (q) => sailMoment(key, q, Math.abs(m.twa))).short;
    }
    const aw = Number.isFinite(tws) && !m.hold ? apparent(twd, tws, hdg, m.bsp || 0) : null;
    return { t: p.t, cog, sog: p.sog, bsp: m.bsp, tws, twd, gust, twa: m.twa, aws: aw?.aws, awa: aw?.awa, side: m.side || 0, hs: Math.sqrt((c.hs || 0) ** 2 + (c.swell2 || 0)) * FT, curKt, along, motor: m.motor, sails, hdg };
  }

  show(res, env, boat, meta = {}) {
    const pts = res.pts, { tacks, rows } = this.analyse(pts, boat);
    this.result = { res, pts };
    this.layer.setRoute(pts, tacks);
    const t0 = pts[0].t, t1 = pts.at(-1).t, hours = (t1 - t0) / 3600e3;
    let dist = 0, motorH = 0, foul = 0, fair = 0, maxTws = 0, maxG = 0, maxHs = 0, maxFoul = 0, waitH = 0, holdH = 0;
    const R = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b.x - a.x, b.y - a.y), dt = (b.t - a.t) / 3600e3, r = this.row(b, a, boat);
      dist += d; if (b.m?.motor) motorH += dt; if (b.m?.hold) { if (b.m.gate) holdH += dt; else waitH += dt; continue; }
      if (r.along < -0.5) foul += dt; else if (r.along > 0.5) fair += dt;
      maxTws = Math.max(maxTws, r.tws); maxG = Math.max(maxG, r.gust); maxHs = Math.max(maxHs, r.hs); maxFoul = Math.max(maxFoul, -r.along);
    }
    let rhumb = 0; for (let i = 1; i < this.wps.length; i++) rhumb += Math.hypot(this.wps[i].x - this.wps[i - 1].x, this.wps[i].y - this.wps[i - 1].y);
    // Daylight: hours of darkness (sun below −6°: after civil twilight) and sunrise/sunset on the way.
    let darkH = 0; const sunEv = [];
    { let prevAlt = null;
      for (let tt = t0; tt <= t1; tt += 600e3) {
        const q = pts.find((p) => p.t >= tt) || pts.at(-1), ll = this.ex.proj.toLatLon(q.x, q.y), alt = sunPosition(new Date(tt), ll.lat, ll.lon).altitude * 57.2958;
        if (alt < -6) darkH += 1 / 6;
        if (prevAlt != null && (prevAlt < -0.833) !== (alt < -0.833)) sunEv.push(`${alt > prevAlt ? "sunrise" : "sunset"} ${this.fmt(tt)}`);
        prevAlt = alt;
      } }
    const nT = tacks.filter((q) => q.kind === "tack").length, nG = tacks.length - nT;
    let water = 0; if (env?.toGo) for (let i = 1; i < this.wps.length; i++) { const f = env.toGo(this.wps[i].x, this.wps[i].y); water += f(this.wps[i - 1].x, this.wps[i - 1].y) || 0; }
    const holds = this.holds(pts);
    const whyList = this.why(pts, boat, { rhumb, water, dist, nT, nG, waitH, holdH, holds, fair, foul, maxG, motorH });
    this.routeField = meta.field || null;                    // (the viewer's current during the replay)
    const prov = meta.sources?.length ? this.provenance(pts, meta.sources) : "", used = (meta.sources || []).filter((S) => S.times[0] <= pts.at(-1).t && S.times.at(-1) >= pts[0].t - 3 * 3600e3),
      src = used.length ? `Wind: ${used.map((s) => s.label).join(", then ")}. ` : "";
    const easedTxt = (res.eased || []).map((e) => {
      const why = `${(e.from / NM).toFixed(2)} nm ${Number.isFinite(e.extraKm) ? `would add ${(e.extraKm / NM).toFixed(1)} nm` : "closes them"}`;
      return e.spots?.length
        ? `<br>Clearance off land kept at ${(e.from / NM).toFixed(2)} nm on leg ${e.leg}, eased to ${(e.to / NM).toFixed(2)} nm only within ~0.8 nm of the narrow place${e.spots.length > 1 ? "s" : ""} ${e.spots.map((s) => this.spotName(s)).join(", ")} (${why}).`
        : `<br>Clearance off land eased to ${(e.to / NM).toFixed(2)} nm on leg ${e.leg} to get through narrow passes (${why}).`;
    }).join("");
    if (!res.partial) this.status(`${res.fixedKn ? "" : src}${meta.field ? `Currents: ${meta.field.label || `NOAA predictions (${meta.field.stations.length} stations)`}. ` : "No currents. "}${meta.ms ? `Routed in ${(meta.ms / 1000).toFixed(1)} s.` : ""}${easedTxt}`);
    const wxOn = !!$("ps-wx")?.checked, wxTd = (t) => (wxOn ? `<td class="wx" data-wt="${t}">…</td>` : "");
    const tbl = rows.map(({ p, prev }) => { const r = this.row(p, prev, boat);
      if (p.m?.hold) return `<tr data-t="${r.t}" title="Show on the map"><td>${this.fmt(r.t)}</td><td colspan="${res.fixedKn ? 4 : 9}">${p.m.gate ? "holding for the tide" : "waiting in harbour"}${Number.isFinite(r.tws) && !res.fixedKn ? ` (wind ${Math.round(r.tws)}/${Math.round(r.gust)} kt, current ${r.curKt.toFixed(1)} kt)` : ` (current ${r.curKt.toFixed(1)} kt)`}</td>${wxTd(r.t)}</tr>`;
      return `<tr data-t="${r.t}" title="Show on the map"><td>${this.fmt(r.t)}</td><td class="brg" data-d="${r.cog}">${this.brg(r.cog)}</td><td>${r.sog.toFixed(1)}</td><td>${Number.isFinite(r.bsp) ? r.bsp.toFixed(1) : "–"}</td>`
        + (res.fixedKn ? "" : `<td>${r.motor ? "motor" : Number.isFinite(r.tws) ? `${Math.round(r.tws)}/${Math.round(r.gust)}` : "–"}</td><td>${Number.isFinite(r.twa) && !r.motor ? `${Math.round(Math.abs(r.twa))}${r.twa < 0 ? "P" : "S"}` : "–"}</td><td>${r.hs.toFixed(1)}</td>`)
        + `<td class="${r.along > 0.3 ? "fair" : r.along < -0.3 ? "foul" : ""}">${r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)}` : "–"}</td>${res.fixedKn ? "" : `<td>${r.sails}</td><td class="src">${(p.c?.src || "").replace(/ \(long run\)/, " long")}</td>`}${wxTd(r.t)}</tr>`; }).join("");
    const t0r = pts[0].t, t1r = pts.at(-1).t, inRun = !res.fixedKn;
    $("ps-out").innerHTML = `<button class="btn ps-report-btn" id="ps-report" title="The full route report in its own window (move, resize, minimise, print): summary, cautions, charts along the passage, legs, why this route, where the wind comes from, sensitivity, the model comparison and the hour-by-hour table">📋 Route report</button>
      <div class="ps-replay">
      <button class="btn" id="ps-play" title="Sail the passage: the boat moves along the route on the map${inRun ? ", the forecast steps along with it, and the surface viewer sails it" : ""}">▶ Replay</button>
      <select id="ps-rspeed" class="mini" title="How fast the passage plays"><option value="60">1 min/s</option><option value="300" selected>5 min/s</option><option value="900">15 min/s</option><option value="3600">1 h/s</option></select>
      <span id="ps-rtime" class="val"></span>
      <input id="ps-scrub" type="range" min="${t0r}" max="${t1r}" step="60000" value="${t0r}" title="Drag through the passage">
      <label class="row" title="Keep the boat in the middle of the 3D map"><input id="ps-follow" type="checkbox" checked> Follow on the map</label>
      ${inRun ? `<label class="row" title="The surface viewer sails the route: position, heading, tack, speed; the wind, waves and current where the boat is, at that time"><input id="ps-viewer" type="checkbox" checked> Sail it in the viewer</label>` : ""}
      <select id="ps-brg" class="mini" title="Bearings (heading, course over ground, course made good, wind direction) in degrees true or magnetic (variation ${VARIATION[this.ex.region?.id] ?? 0}° E, approximate for 2026: check the chart's compass rose)"><option value="true"${this.brgMode === "mag" ? "" : " selected"}>°True</option><option value="mag"${this.brgMode === "mag" ? " selected" : ""}>°Magnetic</option></select>
      <label class="row" title="The route, the boat and its tag on the map (untick to clear the map when you're done; the plan and waypoints stay here)"><input id="ps-onmap" type="checkbox" checked> Route on the map</label>
      <span class="inline" title="The conditions and notes at that time on the map: beside the boat (clear of it, with a line to it; in the corner when there's no room), always in the map's corner, or off"><span class="lab">Conditions</span><select id="ps-tag" class="mini"><option value="boat"${(this.tagMode || "boat") === "boat" ? " selected" : ""}>beside the boat</option><option value="corner"${this.tagMode === "corner" ? " selected" : ""}>in the corner</option><option value="off"${this.tagMode === "off" ? " selected" : ""}>off</option></select></span>
      <div id="ps-now" class="ps-now"></div></div>
      ${inRun ? this.movie.panelHTML() : ""}
      <div class="ps-sum">
      <div><span>Depart</span><b>${this.fmt(t0, true)}</b><i>${this.utc(t0)}</i></div>
      <div><span>Arrive (ETA)</span><b>${this.fmt(t1, true)}</b><i>${this.utc(t1)}</i></div>
      <div><span>Passage</span><b>${hm(hours)}</b><i>${(dist / NM).toFixed(1)} nm sailed · ${(rhumb / NM).toFixed(1)} nm straight</i></div>
      <div><span>Average under way</span><b>SOG ${(dist / NM / Math.max(0.1, hours - waitH - holdH)).toFixed(1)} kn</b><i>${(() => { let s = 0, T = 0; for (let i = 1; i < pts.length; i++) { const m = pts[i].m; if (!m || m.hold) continue; const d = pts[i].t - pts[i - 1].t; s += (m.bsp || 0) * d; T += d; } return T ? `STW ${(s / T).toFixed(1)} kn · ` : ""; })()}made good ${(rhumb / NM / hours).toFixed(1)} kn overall (straight line ÷ passage time)</i></div>
      ${res.fixedKn ? `<div><span>Speed through water</span><b>${res.fixedKn} kn</b><i>steady</i></div>` : `<div><span>Wind</span><b>max ${Math.round(maxTws)} kt</b><i>gusts to ${Math.round(maxG)} kt</i></div>
      <div><span>Seas</span><b>max ${maxHs.toFixed(1)} ft</b><i>${nT} tack${nT === 1 ? "" : "s"}, ${nG} gybe${nG === 1 ? "" : "s"}${motorH > 0.05 ? `, ${hm(motorH)} motoring` : ""}</i></div>`}
      ${waitH > 0.05 ? `<div><span>Wait first</span><b>${hm(waitH)}</b><i>in harbour, ${this.waitWhy(pts, boat)}; under way ${this.fmt(t0 + waitH * 3600e3)}</i></div>` : ""}
      ${holdH > 0.05 ? `<div><span>Hold for the tide</span><b>${hm(holdH)}</b><i>${holds.map((h) => `${hm(h.h)} ${h.where} from ${this.fmt(h.t0)}`).join("; ")}</i></div>` : ""}
      <div><span>Current</span><b>${hm(fair)} fair</b><i>${hm(foul)} foul${maxFoul > 0.3 ? `, worst ${maxFoul.toFixed(1)} kt against` : ""}</i></div>
      <div><span>Darkness</span><b>${hm(darkH)}</b><i>${sunEv.length ? sunEv.join(", ") : "no sunrise or sunset on the way"}</i></div>
      ${wxOn ? `<div id="ps-wx-tile"><span>Weather</span><b>…</b><i>loading the weather along the route…</i></div>` : ""}</div>
      ${prov}
      ${whyList.length ? `<div class="ps-why"><b>Why this route</b><ul>${whyList.map((w) => `<li>${w}</li>`).join("")}</ul></div>` : ""}
      <div class="ps-exp"><span>Export</span>
        <button class="btn mini" id="ps-gpx" title="The route as turn points (start, each tack or gybe, each real course change, your waypoints, the end) with ETAs: for Navionics, Garmin, Raymarine, B&amp;G, OpenCPN, iNavX…">GPX route</button>
        <button class="btn mini" id="ps-gpxt" title="The full planned track with times, as a GPX track">GPX track</button>
        <button class="btn mini" id="ps-csv" title="Turn points as a spreadsheet: name, latitude, longitude, ETA, course and distance to the next">CSV</button>
        ${res.fixedKn || res.partial ? "" : `<button class="btn mini" id="ps-sens" title="Route it again with the wind 15% lighter and stronger, the boat sailing 10% and 20% slower and faster, without the currents, and leaving an hour at a time up to 6 h later (and earlier while that's still ahead of now): how much the plan depends on each">Sensitivity</button>`}</div>
      <div id="ps-sens-out"></div>
      <div class="ps-tbl" id="ps-hourly"><table><thead><tr><th>Time</th><th title="Course over the ground">COG</th><th title="Speed over the ground (kn): through the water plus the current">SOG</th><th title="Speed through the water (kn): the boat's own speed">STW</th>${res.fixedKn ? "" : "<th>TWS/gust</th><th>TWA</th><th>Seas ft</th>"}<th title="Current along the track: + fair, − foul (kt)">Cur</th>${res.fixedKn ? "" : "<th>Sails</th><th title=\"The model (and run) the wind came from at that hour; A → B while blending from one to the next\">Wind from</th>"}${wxOn ? `<th title="Air temperature (°F), visibility, rain and cloud (CLR, FEW, SCT, BKN, OVC) from the model; hover a cell for the dewpoint, ceiling and source">Weather</th>` : ""}</tr></thead><tbody>${tbl}</tbody></table></div>
      <p class="note">Click a row to see it on the map${res.fixedKn ? "" : " (and move the time slider there)"}. The pink line is the route (grey where motoring); white diamonds are tacks, blue gybes; the yellow dot is the boat at the time on screen.</p>`;
    this.ex.stage.markDirty();
    this.stopReplay(false);
    this.rp = { t: t0r, playing: false, inRun };
    this.exportData = { pts, tacks, boat };
    this.summary = { t0, t1, hours, dist, rhumb, water, motorH, waitH, holdH, holds, fair, foul, maxTws, maxG, maxHs, maxFoul, darkH, sunEv, nT, nG, whyList, prov, src, easedTxt, fieldStations: meta.field?.stations.length || 0, curLabel: meta.field?.label || "", sources: meta.sources || [], ms: meta.ms };
    this.lastEnv = env; this.sensRows = null;
    this.report?.routeChanged();
    this.onTime(this.ex.validDate());
    $("ps-brg").addEventListener("change", (e) => {
      this.brgMode = e.target.value;
      for (const td of $("ps-out").querySelectorAll("td.brg")) td.textContent = this.brg(+td.dataset.d);
      this.updateTag(this.tagT); const tt = this.rp ? $("ps-scrub") ? +$("ps-scrub").value : this.rp.t : null; if (tt) this.nowReadout(tt, this.stateAt(tt));
    });
    $("ps-onmap").addEventListener("change", (e) => { if (!e.target.checked) { this.stopReplay(); this.closeReplayViewer(); } this.layer.line.visible = e.target.checked; if (this.layer.alts) this.layer.alts.visible = e.target.checked; this.ex.stage.markDirty(); });
    this.layer.line.visible = true; if (this.layer.alts) this.layer.alts.visible = true;
    $("ps-tag").addEventListener("change", (e) => { this.tagMode = e.target.value; this.layer.tagMode = this.tagMode; this.updateTag(this.tagT ?? this.ex.validDate()?.getTime()); });
    this.layer.tagMode = this.tagMode || "boat";
    $("ps-report").addEventListener("click", () => this.report.open());
    if ($("pm")) this.movie.bind();
    $("ps-gpx").addEventListener("click", () => this.download("gpx"));
    $("ps-gpxt").addEventListener("click", () => this.download("track"));
    $("ps-csv").addEventListener("click", () => this.download("csv"));
    $("ps-sens")?.addEventListener("click", () => this.sensitivity(env, boat));
    // (the sensitivity, by itself in the background, when that's on)
    if ($("ps-autosens")?.checked && !res.fixedKn && !res.partial) setTimeout(() => { if (this.result?.res === res) this.sensitivity(env, boat, $("ps-sens-out"), { auto: true }); }, 300);
    $("ps-play").addEventListener("click", () => (this.rp.playing ? this.stopReplay() : this.startReplay()));
    $("ps-scrub").addEventListener("input", (e) => { this.rp.t = +e.target.value; this.replayAt(this.rp.t, true); });
    $("ps-rtime").textContent = this.fmt(t0r);
    this.wx = null; this.summary.wx = null;
    if (wxOn) this.routeWeather(pts);
  }

  // ---------- weather along the route ----------
  // Loaded after each route (in the background), from the loaded model and run (then GFS past it).
  async routeWeather(pts) {
    const ex = this.ex, gen = (this.wxGen = (this.wxGen || 0) + 1);
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of pts) { const ll = ex.proj.toLatLon(p.x, p.y); la0 = Math.min(la0, ll.lat); la1 = Math.max(la1, ll.lat); lo0 = Math.min(lo0, ll.lon); lo1 = Math.max(lo1, ll.lon); }
    const bbox = { latMin: la0 - 0.08, latMax: la1 + 0.08, lonMin: lo0 - 0.1, lonMax: lo1 + 0.1 }, tile = () => $("ps-wx-tile");
    try {
      const w = await loadWeather({ model: ex.model, cycle: ex.cycle, bbox, t0: pts[0].t, t1: pts.at(-1).t,
        onProgress: (q) => { if (gen === this.wxGen && tile()) tile().querySelector("i").textContent = `loading the weather along the route… ${(q.bytes / 1e6).toFixed(1)} MB`; } });
      if (gen !== this.wxGen || this.result?.pts !== pts) return;
      if (!w.parts.length) throw new Error("no weather fields for these hours");
      this.wx = w; this.fillWeather(pts);
    } catch (e) {
      if (gen !== this.wxGen) return;
      console.warn("route weather", e);
      if (tile()) { tile().querySelector("b").textContent = "–"; tile().querySelector("i").textContent = `couldn't load it (${e.message || e})`; }
    }
  }
  // The weather at time t on the route (the boat's place then). → sample or null
  wxAt(t) {
    if (!this.wx) return null;
    const s = this.stateAt(t); if (!s) return null;
    const ll = this.ex.proj.toLatLon(s.x, s.y);
    return this.wx.sample(ll.lat, ll.lon, t);
  }
  fillWeather(pts) {
    const oct = (p) => (!Number.isFinite(p) ? "" : p < 10 ? "CLR" : p < 30 ? "FEW" : p < 60 ? "SCT" : p < 88 ? "BKN" : "OVC");
    for (const td of document.querySelectorAll("#ps-hourly td.wx")) {
      const w = this.wxAt(+td.dataset.wt);
      if (!w) { td.textContent = "–"; continue; }
      const rw = rainWord(w);
      td.textContent = [Number.isFinite(w.t2) ? `${fF(w.t2)}°` : "", visText(w.vis), rw ? rw.replace("thunderstorm", "⚡ T-storm").replace("light rain", "lt rain") : "", oct(w.tcc)].filter(Boolean).join(" ");
      td.title = `${wxLine(w)}${Number.isFinite(w.td) ? ` · dewpoint ${fF(w.td)}°F` : ""} (${w.src})`;
      td.classList.toggle("fog", w.vis < 1852); td.classList.toggle("wet", !!rw && rw !== "drizzle");
    }
    // The passage in a few numbers (every 10 minutes).
    const t0 = pts[0].t, t1 = pts.at(-1).t, W = [];
    for (let t = t0; t <= t1; t += 600e3) { const w = this.wxAt(t); if (w) W.push({ t, w }); }
    const S = { labels: this.wx.labels, bytes: this.wx.bytes, samples: W, tmin: NaN, tmax: NaN, fogH: 0, mistH: 0, rainH: 0, thunder: [], minVis: Infinity, minVisT: null, cloud: NaN };
    let cs = 0, cn = 0;
    for (const { t, w } of W) {
      if (Number.isFinite(w.t2)) { S.tmin = Number.isFinite(S.tmin) ? Math.min(S.tmin, w.t2) : w.t2; S.tmax = Number.isFinite(S.tmax) ? Math.max(S.tmax, w.t2) : w.t2; }
      if (w.vis < 1852) S.fogH += 1 / 6; else if (w.vis < 5000) S.mistH += 1 / 6;
      if (w.vis < S.minVis) { S.minVis = w.vis; S.minVisT = t; }
      const rw = rainWord(w); if (rw && rw !== "drizzle") S.rainH += 1 / 6; if (rw === "thunderstorm") S.thunder.push(t);
      if (Number.isFinite(w.tcc)) { cs += w.tcc; cn++; }
    }
    S.cloud = cn ? cs / cn : NaN;
    this.summary.wx = S;
    const tile = $("ps-wx-tile");
    if (tile) {
      tile.querySelector("b").textContent = Number.isFinite(S.tmin) ? `${fF(S.tmin)}–${fF(S.tmax)} °F` : "–";
      tile.querySelector("i").textContent = [S.fogH >= 0.1 ? `fog ${hm(S.fogH)} (vis under 1 nm)` : S.mistH >= 0.1 ? `mist or haze ${hm(S.mistH)}` : "no fog",
        S.thunder.length ? "thunderstorms" : S.rainH >= 0.1 ? `rain ${hm(S.rainH)}` : "dry", cloudWord(S.cloud), `${this.wx.labels.join(", then ")}`].filter(Boolean).join(" · ");
    }
    this.report?.routeChanged();
    this.updateTag(this.tagT);
  }

  // ---------- compare models ----------
  async runCompare(depH) {
    const ex = this.ex, picks = [...$("ps-cmp").querySelectorAll("input:checked")].map((i) => i.dataset.src);
    if (!picks.length) { this.status("Tick at least one model to compare."); return; }
    const c = ex.cycle.getTime(), t0 = c + depH * 3600e3, until = c + +$("ps-hz").value * 3600e3, boat = this.boat(), out = [];
    const COLS = ["#ff54c7", "#6fb8ff", "#ffd166", "#3fc1a5", "#f29a3b", "#c58cf2"];
    try {
      for (const pick of picks) {
       try {
        let sources;
        if (pick === "loaded") {
          // The loaded run, and past its end the same model's longer run (not another model).
          const E0 = await this.forecastEnv(0), L = this.loaded;
          let E = E0, res = await planRoute(E0.env, boat, this.opts({ currents: !!E0.field }), this.wps, t0);
          if (!res.ok && /end of the forecast/.test(res.reason || "")) {
            if (L.longUntil == null || L.longUntil < until) { L.long = await this.longRun(L.src.times.at(-1), until); L.longUntil = until; }
            if (L.long) { E = await this.envFor([L.src, L.long]); this.status(`Routing with ${L.src.label} and its long run…`); res = await planRoute(E.env, boat, this.opts({ currents: !!E.field }), this.wps, t0); }
          }
          out.push({ label: E.sources.length > 1 ? `${E.sources[0].label} + long run` : E.sources[0].label, S: E.sources[0], E, res });
          continue;
        }
        else if (pick === "gfs" || pick === "ifs") {
          const name = pick === "gfs" ? "GFS" : "ECMWF IFS", G = await latestGlobal(pick, until);
          if (!G) { out.push({ label: name, fail: "no run reaching the horizon is posted yet" }); continue; }
          // A day at a time (each step ~2.7 MB), only as far as the route gets.
          let S = null, res = null, E = null, from = t0 - 3 * 3600e3;
          while (from < until) {
            const to = Math.min(until, from + 24 * 3600e3);
            this.status(`Loading ${name} ${pad(G.cycle.getUTCHours())}Z to ${this.fmt(to, true)}…`);
            const part = await loadGlobal(pick, G.cycle, from, to, ex.region.bbox, { onProgress: (p) => this.status(`Loading ${name}: ${p.done} of ${p.of} steps, ${(((S?.bytes || 0) + p.bytes) / 1e6).toFixed(1)} MB`) });
            if (S) { for (const [t, f] of part.frames) S.frames.set(t, f); S.times = [...S.frames.keys()].sort((a, b) => a - b); S.bytes += part.bytes; } else S = part;
            from = S.times.at(-1);
            E = await this.envFor([S]);
            this.status(`Routing with ${S.label}…`);
            res = await planRoute(E.env, boat, this.opts({ currents: !!E.field }), this.wps, t0);
            if (res.ok || !/end of the forecast/.test(res.reason) || to >= until) break;
          }
          out.push({ label: S.label, S, E, res });
          continue;
        } else {
          const m = ex.models.find((q) => q.id === pick.slice(2)), maxF = Math.max(...m.cycles.map((q) => q.maxFhr));
          this.status(`Finding ${m.short}'s newest run…`);
          const L = await latestCycle(m, { needFhr: Math.min(maxF, 18), which: m.path2d ? "path2d" : "path" });
          if (!L) { out.push({ label: m.short, fail: "no run found" }); continue; }
          // Each hour of a country-wide model is a few MB, so hours are loaded 12 at a time, only as far
          // as the route gets.
          const cc = L.cycle.getTime(), last = Math.min(Math.max(...m.cycles.filter((q) => q.hours.includes(L.cycle.getUTCHours())).map((q) => q.maxFhr)), Math.ceil((until - cc) / 3600e3), 48);
          const name = `${m.short} ${pad(L.cycle.getUTCHours())}Z`, frames = new Map();
          let h0 = Math.max(0, Math.floor((t0 - cc) / 3600e3) - 1), bytes = 0, w = null, res = null, E = null;
          while (h0 <= last) {
            const hours = []; for (let h = h0; h <= Math.min(last, h0 + 12); h++) hours.push(h);
            this.status(`Loading ${name} (hours +${hours[0]} to +${hours.at(-1)} of 10 m wind and gust)…`);
            const part = await loadRunWind(m, L.cycle, hours, ex.region.bbox, { onProgress: (p) => this.status(`Loading ${name}: ${p.done} of ${p.of} hours, ${((bytes + p.bytes) / 1e6).toFixed(1)} MB`) });
            for (const [h, f] of part.frames) frames.set(h, f);
            bytes += part.bytes; w = { ...part, frames, bytes }; h0 = hours.at(-1) + 1;
            E = await this.envFor([hiresSource(w, L.cycle, name, pick)]);
            this.status(`Routing with ${name}…`);
            res = await planRoute(E.env, boat, this.opts({ currents: !!E.field }), this.wps, t0);
            if (res.ok || !/end of the forecast/.test(res.reason) || h0 > last) break;
          }
          out.push({ label: name, S: E.sources[0], E, res });
          continue;
        }
        const E = await this.envFor(sources);
        this.status(`Routing with ${sources[0].label}…`);
        const res = await planRoute(E.env, boat, this.opts({ currents: !!E.field }), this.wps, t0);
        out.push({ label: sources[0].label, S: sources[0], E, res });
       } catch (e) {                                             // (one model failing doesn't end the comparison)
        console.warn("compare", pick, e);
        out.push({ label: pick === "gfs" ? "GFS" : pick === "ifs" ? "ECMWF IFS" : pick === "loaded" ? "the loaded run" : pick.slice(2), fail: `couldn't load it (${e.message || e})` });
       }
      }
    } catch (e) { this.status(`Couldn't compare: ${e.message}`); console.error(e); return; }
    const ok = out.filter((q) => q.res?.ok);
    if (!ok.length) { this.status(`No model gets a route: ${out.map((q) => `${q.label}: ${q.fail || q.res?.reason}`).join("; ")}.`); return; }
    ok.forEach((q, k) => { q.color = COLS[k % COLS.length]; });
    this.compare = { out, ok, boat };
    this.showCompared(ok[0]);
  }
  showCompared(main) {
    const { out, ok, boat } = this.compare, now = Date.now();
    this.show(main.res, main.E.env, boat, { sources: main.E.sources, field: main.E.field });
    this.layer.setAlts(ok.filter((q) => q !== main).map((q) => ({ pts: q.res.pts, color: q.color })));
    const rows = out.map((q) => {
      if (!q.res?.ok) return `<tr><td>${q.label}</td><td colspan="6">no route: ${q.fail || q.res?.reason}</td></tr>`;
      const P = q.res.pts, h = (P.at(-1).t - P[0].t) / 3600e3; let d = 0, g = 0, w = 0, tk = 0;
      for (let i = 1; i < P.length; i++) { d += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); g = Math.max(g, (P[i].c?.g || 0) * KT); w = Math.max(w, Math.hypot(P[i].c?.u || 0, P[i].c?.v || 0) * KT); if (P[i].m?.side && P[i - 1].m?.side && P[i].m.side !== P[i - 1].m.side && !P[i].m.hold) tk++; }
      return `<tr data-cmp="${ok.indexOf(q)}" class="${q === main ? "now" : ""}" title="Show this model's route in full"><td><span class="swatch" style="background:${q.color}"></span>${q.label}</td><td>${Math.round((now - q.S.cycle.getTime()) / 3600e3)} h</td><td>${hm(h)}</td><td>${this.fmt(P.at(-1).t, true)}</td><td>${(d / NM).toFixed(1)}</td><td>${Math.round(w)}/${Math.round(g)}</td><td>${tk}</td></tr>`;
    }).join("");
    const hs = ok.map((q) => (q.res.pts.at(-1).t - q.res.pts[0].t) / 3600e3), spread = Math.max(...hs) - Math.min(...hs);
    $("ps-out").insertAdjacentHTML("afterbegin", `<div class="ps-cmp"><b>Compare models</b> (same departure, waypoints and limits)<div class="ps-tbl"><table><thead><tr><th>Model run</th><th title="How old the run is now">Age</th><th>Passage</th><th>ETA</th><th>nm</th><th>Wind/gust max</th><th>Tacks</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">The models agree to within ${hm(spread)} on the passage time${spread > 1.5 ? ": a big spread: treat the timing as uncertain" : spread < 0.5 ? ": good agreement" : ""}. Each model's route is drawn in its colour; the full stats below are for the highlighted one (click a row for another).</p></div>`);
    for (const tr of $("ps-out").querySelectorAll("tr[data-cmp]")) tr.addEventListener("click", () => this.showCompared(ok[+tr.dataset.cmp]));
  }

  // ---------- sensitivity ----------
  // The same waypoints and limits, routed (a little coarser, for speed) with one thing changed at a
  // time, against a baseline routed the same way.
  // auto: run by itself after a route (in the background): only the forecast already loaded (cases
  // that need more say so); stopped when the route changes (a newer run takes over).
  async sensitivity(env, boat, out = $("ps-sens-out"), { auto = false } = {}) {
    const token = (this.sensToken = (this.sensToken || 0) + 1), result = this.result;
    const t0 = this.result.pts[0].t, base = this.opts({ currents: !!this.fieldObj && $("ps-cur").checked });   // (the plan's own resolution: coarser was too noisy)
    // Each variation makes its environment from a base one (so it can be redone on a longer
    // forecast when it runs past the loaded one).
    const scaled = (k) => (E) => { const e = Object.create(E); e.cond = (x, y, tt) => { const c = E.cond(x, y, tt); return c && { ...c, u: c.u * k, v: c.v * k, g: c.g * k, hs: c.hs * k }; }; return e; };
    const same = (E) => E, faster = (k) => ({ ...boat, polar: (s, a) => boat.polar(s, a) * k });
    const variants = [["As planned", same, boat, base, t0], ["Wind 15% lighter", scaled(0.85), boat, base, t0], ["Wind 15% stronger", scaled(1.15), boat, base, t0],
      ["Boat 20% slower", same, faster(0.8), base, t0], ["Boat 10% slower", same, faster(0.9), base, t0], ["Boat 10% faster", same, faster(1.1), base, t0], ["Boat 20% faster", same, faster(1.2), base, t0]];
    const noCur = (E) => { const e = Object.create(E); e.cond = (x, y, tt) => E.cond(x, y, tt, true); return e; };
    if (base.currents) variants.push(["Without the currents", noCur, boat, { ...base, currents: false }, t0]);
    // The current assumptions: stronger or weaker than forecast, the tide turning earlier or later,
    // and the other source (SSCOFS ↔ NOAA stations).
    if (base.currents) {
      const curK = (k) => (E) => { const e = Object.create(E); e.cond = (x, y, tt) => { const c = E.cond(x, y, tt); return c && { ...c, cu: c.cu * k, cv: c.cv * k }; }; return e; };
      const curShift = (ms) => (E) => { const e = Object.create(E); e.cond = (x, y, tt) => { const c = E.cond(x, y, tt), s = E.current?.(x, y, tt + ms); return c && s ? { ...c, cu: s.u, cv: s.v } : c; }; return e; };
      variants.push(["Currents 25% weaker", curK(0.75), boat, base, t0], ["Currents 25% stronger", curK(1.25), boat, base, t0],
        ["Tide 30 min earlier", curShift(30 * 60e3), boat, base, t0], ["Tide 30 min later", curShift(-30 * 60e3), boat, base, t0]);
      if (this.ex.region?.id === "salish-sea") {
        const other = $("ps-cursrc")?.value === "sscofs" ? "stations" : "sscofs", P = this.result.pts;
        const alt = await this.field(P[0].t - 7 * 3600e3, P.at(-1).t + 8 * 3600e3, { source: other }).catch(() => null), land = await this.ex.routeGrid();
        if (alt && (other === "stations" || alt instanceof MixedField)) variants.push([`Currents from ${other === "sscofs" ? "SSCOFS" : "NOAA stations"}`, (E) => makeEnv(this.ex, E.sources, alt, { currents: true, land }), boat, base, t0]);
      }
    }
    // Other departures, an hour apart: up to 6 h later, and earlier only while that's still ahead
    // of now and inside the forecast.
    const first = Math.max(Date.now(), Math.min(...(env.sources || []).map((S) => S.times[0])) || 0);
    for (let k = -6; k <= 6; k++) if (k && t0 + k * 3600e3 >= first - 60e3) variants.push([`Leave ${Math.abs(k)} h ${k < 0 ? "earlier" : "later"}`, same, boat, base, t0 + k * 3600e3, k]);
    // Past the end of what's loaded (a later departure, a slower boat): the longer runs, loaded as
    // the main route would load them (stitch mode).
    const stitch = ["stitch", "stitchg", "global"].includes($("ps-wsrc").value) && $("ps-mode").value !== "tide";
    const rows = [];
    let n = 0;
    for (const [name, mk, b, o, t, dep] of variants) {
      if (token !== this.sensToken || result !== this.result) return null;          // (a new route: this one's moot)
      out.innerHTML = `<p class="note">${auto ? "Sensitivity (in the background)" : "Sensitivity"}: ${++n} of ${variants.length}, ${name.toLowerCase()}…</p>`;
      let r = await planRoute(mk(env), b, o, this.wps, t);
      if (auto && !r.ok && /end of the forecast/.test(r.reason || "")) { rows.push({ name, dep, fail: "needs a longer forecast than is loaded", needs: true }); continue; }
      for (let lvl = 1; stitch && !r.ok && /end of the forecast/.test(r.reason || "") && lvl <= 6; lvl++) {
        const E2 = await this.forecastEnv(lvl, { from: t0 }).catch(() => null);
        if (!E2) break;
        out.innerHTML = `<p class="note">Routing: ${name.toLowerCase()} (on the longer forecast)…</p>`;
        r = await planRoute(mk(E2.env), b, { ...o, currents: o.currents && !!E2.field }, this.wps, t);
        if (!E2.more) break;
      }
      if (!r.ok) { rows.push({ name, dep, fail: r.reason }); continue; }
      const P = r.pts, h = (P.at(-1).t - P[0].t) / 3600e3; let g = 0, tk = 0;
      for (let i = 1; i < P.length; i++) { g = Math.max(g, (P[i].c?.g || 0) * KT); if (P[i].m?.side && P[i - 1].m?.side && P[i].m.side !== P[i - 1].m.side && !P[i].m.hold) tk++; }
      rows.push({ name, dep, h, eta: P.at(-1).t, g, tk, start: P[0].t });
    }
    if (token !== this.sensToken || result !== this.result) return null;
    this.sensRows = rows; this.sensPartial = rows.some((r) => r.needs); this.report?.sensDone();
    const b0 = rows[0]?.h, W = 60;
    const maxD = Math.max(0.25, ...rows.filter((r) => Number.isFinite(r.h)).map((r) => Math.abs(r.h - b0)));
    // (the change in passage time as a bar from the centre line: faster to the left, teal; slower to the right, orange)
    const bar = (r) => { const w = r === rows[0] ? 0 : Math.round((Math.abs(r.h - b0) / maxD) * W); return `<span class="sdiv"><span class="sbar ${r.h > b0 ? "worse" : "better"}" style="width:${w}px;${r.h > b0 ? `left:${W}px` : `left:${W - w}px`}"></span></span>`; };
    out.innerHTML = `<h3>Sensitivity</h3><div class="ps-tbl"><table><thead><tr><th>Change</th><th>Passage</th><th>ETA</th><th>vs plan</th><th title="The change in passage time against the plan: teal bars to the left are faster, orange to the right slower; the longest bar is the biggest change">Faster ◂ | ▸ Slower</th><th>Max gust</th><th>Tacks</th></tr></thead><tbody>`
      + rows.map((r) => r.fail ? `<tr><td>${r.name}</td><td colspan="6">no route: ${r.fail}</td></tr>`
        : `<tr><td>${r.name}</td><td>${hm(r.h)}</td><td>${this.fmt(r.eta)}</td><td>${r === rows[0] ? "–" : `${r.h >= b0 ? "+" : "−"}${hm(Math.abs(r.h - b0))}`}</td>`
          + `<td>${bar(r)}</td><td>${Math.round(r.g)} kt</td><td>${r.tk}</td></tr>`).join("")
      + `</tbody></table></div>${this.sensSummary(rows)}${this.sensPartial ? `<p class="note">${rows.filter((r) => r.needs).length} of these need more forecast than is loaded (run automatically, it only uses what's loaded). <button class="btn mini" id="ps-sens-full">Run in full</button> (loads the longer runs as the plan would).</p>` : ""}<p class="note">Each routed again the same way as the plan (same time step and headings) with one change. A plan that shifts a lot with small changes (a tide gate, a wind shift) deserves a margin.</p>`;
    out.querySelector("#ps-sens-full")?.addEventListener("click", () => this.sensitivity(env, boat, out));
  }

  sensSummary(rows) {
    const b = rows[0], v = rows.slice(1), out = [];
    if (!b || !Number.isFinite(b.h)) return "";
    const other = v.filter((r) => r.dep == null), deps = v.filter((r) => r.dep != null);
    const failed = other.filter((r) => r.fail), moved = other.filter((r) => Number.isFinite(r.h)).sort((p, q) => Math.abs(q.h - b.h) - Math.abs(p.h - b.h));
    if (moved[0] && Math.abs(moved[0].h - b.h) > 0.3) out.push(`Most sensitive to: <b>${moved[0].name.toLowerCase()}</b> (${moved[0].h > b.h ? "+" : "−"}${hm(Math.abs(moved[0].h - b.h))}).`);
    if (failed.length) out.push(`No route within the forecast if: ${failed.map((r) => r.name.toLowerCase()).join("; ")}.`);
    const w = other.find((r) => r.name.includes("lighter"));
    if (w && Number.isFinite(w.h) && w.h < b.h - 0.5) out.push("Less wind is faster here: the gust limit (or the seas) is holding the boat back.");
    // Departures: the quickest passage and the earliest arrival among them, against the plan.
    const ok = deps.filter((r) => Number.isFinite(r.h));
    if (ok.length) {
      const q = [...ok, b].sort((p, r) => p.h - r.h)[0], e = [...ok, b].sort((p, r) => p.eta - r.eta)[0], span = `${Math.min(0, ...deps.map((r) => r.dep))} to +${Math.max(0, ...deps.map((r) => r.dep))} h`;
      out.push(q === b ? `Of the departures tried (${span}), the plan's is the quickest passage.` : `Of the departures tried (${span}), the quickest passage is to <b>${q.name.toLowerCase()}</b>: ${hm(q.h)} (${hm(b.h - q.h)} shorter), arriving ${this.fmt(q.eta)}.`);
      if (e !== b && e !== q) out.push(`The earliest arrival is to ${e.name.toLowerCase()}: ${this.fmt(e.eta)}.`);
      const same = ok.filter((r) => Math.abs(r.eta - b.eta) < 25 * 60e3 && r.dep < 0);
      if (same.length) out.push(`Leaving earlier (${same.map((r) => `${-r.dep} h`).join(", ")}) arrives at about the same time: a tide gate or a wait sets the arrival.`);
      if (deps.length && !deps.some((r) => r.dep < 0)) out.push("(No earlier departures: they'd be in the past or before the forecast starts.)");
    }
    return out.length ? `<p class="ps-sens-sum">${out.join(" ")}</p>` : "";
  }

  // ---------- export ----------
  // Turn points: the start, the end, your waypoints (where the route passed them), each tack and
  // gybe, and the corners of the track simplified to ~0.1 nm (Douglas-Peucker).
  turnPoints() {
    const { pts, tacks } = this.exportData, keep = new Set([0, pts.length - 1]);
    const dp = (i0, i1) => {
      let best = -1, bd = 0.18;                                        // km off the straight line
      const a = pts[i0], b = pts[i1], L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
      for (let i = i0 + 1; i < i1; i++) { const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L; if (d > bd) { bd = d; best = i; } }
      if (best > 0) { keep.add(best); dp(i0, best); dp(best, i1); }
    };
    dp(0, pts.length - 1);
    for (const tk of tacks) { const i = pts.findIndex((p) => p.t === tk.t); if (i > 0) keep.add(i); }
    this.wps.slice(1, -1).forEach((w) => { let bi = 0, bd = Infinity; pts.forEach((p, i) => { const d = Math.hypot(p.x - w.x, p.y - w.y); if (d < bd) { bd = d; bi = i; } }); keep.add(bi); });
    const idx = [...keep].sort((a, b) => a - b);
    let nT = 0;
    return idx.map((i, k) => {
      const p = pts[i], ll = this.ex.proj.toLatLon(p.x, p.y), next = pts[idx[k + 1]];
      const tk = tacks.find((q) => q.t === p.t), isWp = this.wps.slice(1, -1).some((w) => Math.hypot(p.x - w.x, p.y - w.y) < 1.2);
      const name = k === 0 ? "START" : k === idx.length - 1 ? "END" : tk ? `${tk.kind === "gybe" ? "G" : "T"}${pad(++nT)}` : isWp ? `WP${pad(k)}` : `C${pad(k)}`;
      return { name, lat: ll.lat, lon: ll.lon, t: p.t, cog: next ? bearing(p, next) : null, nm: next ? Math.hypot(next.x - p.x, next.y - p.y) / NM : null, kind: tk ? tk.kind : k === 0 ? "start" : k === idx.length - 1 ? "end" : isWp ? "waypoint" : "course change" };
    });
  }
  download(kind) {
    if (!this.exportData) return;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"), iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
    const t0 = this.exportData.pts[0].t, stamp = new Date(t0).toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
    const boat = BOATS[this.exportData.boat.key]?.name || "boat", title = `Passage ${this.fmt(t0, true)} (${boat})`;
    let text, type, ext;
    if (kind === "csv") {
      text = "name,latitude,longitude,eta_local,eta_utc,kind,course_to_next_T,distance_to_next_nm\n" + this.turnPoints().map((q) => [q.name, q.lat.toFixed(6), q.lon.toFixed(6), `"${this.fmt(q.t, true)}"`, iso(q.t), q.kind, q.cog == null ? "" : deg3(q.cog), q.nm == null ? "" : q.nm.toFixed(2)].join(",")).join("\n") + "\n";
      type = "text/csv"; ext = "csv";
    } else {
      const head = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wind Volume Explorer" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(title)}</name><desc>Planned with Wind Volume Explorer from the forecast; not for navigation on its own.</desc><time>${iso(Date.now())}</time></metadata>\n`;
      if (kind === "track") {
        text = head + `<trk><name>${esc(title)}</name><trkseg>\n` + this.exportData.pts.map((p) => { const ll = this.ex.proj.toLatLon(p.x, p.y); return `<trkpt lat="${ll.lat.toFixed(6)}" lon="${ll.lon.toFixed(6)}"><time>${iso(p.t)}</time></trkpt>`; }).join("\n") + `\n</trkseg></trk>\n</gpx>\n`;
      } else {
        text = head + `<rte><name>${esc(title)}</name>\n` + this.turnPoints().map((q) => `<rtept lat="${q.lat.toFixed(6)}" lon="${q.lon.toFixed(6)}"><name>${q.name}</name><desc>${esc(`${q.kind}, ETA ${this.fmt(q.t, true)} (${iso(q.t)})${q.cog != null ? `; then ${deg3(q.cog)}°T ${q.nm.toFixed(1)} nm` : ""}`)}</desc><time>${iso(q.t)}</time></rtept>`).join("\n") + `\n</rte>\n</gpx>\n`;
      }
      type = "application/gpx+xml"; ext = "gpx";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = `passage-${stamp}${kind === "track" ? "-track" : ""}.${ext}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.lastExport = text;                                            // (for checking)
  }

  // ---------- replay ----------
  // The route's state at time t: position (interpolated), and the move being made (heading, side,
  // TWA, boat speed, motoring, waiting) from the step that covers t.
  stateAt(t) {
    const P = this.result?.pts;
    if (!P?.length) return null;
    t = Math.max(P[0].t, Math.min(P.at(-1).t, t));
    let i = 1; while (i < P.length - 1 && P[i].t < t) i++;
    const a = P[i - 1], b = P[i], f = (t - a.t) / Math.max(1, b.t - a.t), m = b.m || {};
    let log = 0; for (let k = 1; k < i; k++) log += Math.hypot(P[k].x - P[k - 1].x, P[k].y - P[k - 1].y);
    const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
    log += Math.hypot(x - a.x, y - a.y);
    return { t, x, y, hdg: b.h ?? bearing(a, b), side: m.side || 0, twa: m.twa, bsp: m.hold ? 0 : m.bsp || b.sog || 0, motor: !!m.motor, hold: !!m.hold, logKm: log };
  }
  // "On the route now": the boat's state and conditions at replay time t, and its table row lit.
  nowReadout(t, s) {
    const P = this.result?.pts;
    if (!P || !$("ps-now")) return;
    let i = 1; while (i < P.length - 1 && P[i].t < t) i++;
    const r = this.row(P[i], P[i - 1], this.exportData.boat), ll = this.ex.proj.toLatLon(s.x, s.y), fixed = this.result.res.fixedKn;
    const cur = r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)} kt ${r.along >= 0 ? "fair" : "foul"}` : "slack";
    $("ps-now").innerHTML = s.hold ? `<b>${this.fmt(t)}</b> ${P[i].m?.gate ? "holding for the tide" : "waiting in harbour"} · ${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}${fixed ? "" : ` · wind ${Math.round(r.tws)}/${Math.round(r.gust)} kt`}`
      : `<b>${this.fmt(t)}</b> · ${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)} · ${this.boatLines(P[i], r).join(" · ")}`
        + (fixed ? "" : ` · seas ${r.hs.toFixed(1)} ft`)
        + ` · current ${cur} · ${(s.logKm / NM).toFixed(1)} nm sailed${fixed || r.motor ? (r.motor ? " · motoring" : "") : ` · ${r.sails}`}`
        + (this.wx ? ` · ${wxLine(this.wxAt(t))}` : "");
    const rows = [...document.querySelectorAll(".ps-tbl tr[data-t]")];
    let best = null; for (const tr of rows) { if (+tr.dataset.t <= t + 1) best = tr; tr.classList.remove("now"); }
    (best || rows[0])?.classList.add("now");
  }
  startReplay() {
    const R = this.rp;
    if (!R) return;
    if (R.t >= this.result.pts.at(-1).t) R.t = this.result.pts[0].t;
    R.playing = true; R.last = performance.now(); R.sliderT = null;
    $("ps-play").textContent = "⏸ Pause";
    if (R.inRun && $("ps-viewer")?.checked) { this.anchor = null; this.ex.inspector.onReplayEnd = () => this.stopReplay(); }
    const tick = (now) => {
      if (!R.playing) return;
      if (!R.buffering) R.t += ((now - R.last) / 1000) * +$("ps-rspeed").value * 1000;   // (waits while an hour loads)
      R.last = now;
      const end = this.result.pts.at(-1).t;
      if (R.t >= end) { R.t = end; this.replayAt(R.t); this.stopReplay(false); $("ps-play").textContent = "▶ Replay"; return; }
      this.replayAt(R.t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  // The surface viewer (and its ⛵ on the map) if the replay opened it: closed with the route.
  closeReplayViewer() {
    if (this.viewerOpened && !this.ex.inspector.el.hidden) this.ex.inspector.close();
    this.viewerOpened = false;
  }
  stopReplay(handBack = true) {
    if (this.rp) this.rp.playing = false;
    this.ex.inspector?.syncTime?.();
    if ($("ps-play")) $("ps-play").textContent = "▶ Replay";
    if (handBack) { this.ex.replayPos = null; this.ex.inspector.setReplay?.(null); }
  }
  // Show the passage at time t: the boat on the map, the time slider (every 15 minutes of the
  // passage, within the run), the map camera, the viewer.
  replayAt(t, scrub = false) {
    const ex = this.ex, R = this.rp, s = this.stateAt(t);
    if (!s) return;
    $("ps-scrub").value = String(t); $("ps-rtime").textContent = this.fmt(t);
    this.layer.setTime(t);
    this.nowReadout(t, s);
    // The forecast on the map follows continuously (blended between hours, like playback).
    if (R.inRun) { R.buffering = ex.followTime((t - ex.cycle.getTime()) / 3600e3, { force: scrub }) === false; }
    if (R.buffering) $("ps-rtime").textContent = `${this.fmt(t)} · loading the forecast…`;
    if ($("ps-follow").checked) {
      const st = ex.stage, c = st.controls, dx = s.x - c.target.x, dy = s.y - c.target.y, k = scrub ? 1 : 0.15;
      c.target.x += dx * k; c.target.y += dy * k; st.camera.position.x += dx * k; st.camera.position.y += dy * k; c.update();
    }
    this.updateTag(t);                                       // (after the camera moves: it places itself on screen)
    ex.stage.markDirty();
    if (R.inRun && $("ps-viewer")?.checked && R.playing !== undefined) {
      // Re-anchor the viewer (its land) every 8 km; the conditions follow the boat. (Not open yet,
      // e.g. a start in harbour that the sea-state grid counts as land: try again each km.)
      const far = !this.anchor || Math.hypot(s.x - this.anchor.x, s.y - this.anchor.y) > (ex.inspector.el.hidden ? 1 : 8);
      if (far) { if (ex.inspector.el.hidden) this.viewerOpened = true; this.anchor = { x: s.x, y: s.y }; ex.replayPos = [s.x, s.y]; ex.inspectPoint(s.x, s.y); }
      if (ex.inspector.el.hidden) return;
      ex.replayPos = [s.x, s.y];
      ex.inspector.setReplay({ t, hdg: s.hdg, side: s.side, twa: s.twa, bsp: s.bsp, motor: s.motor, hold: s.hold, offX: (s.x - this.anchor.x) * 1000, offY: (s.y - this.anchor.y) * 1000, logM: s.logKm * 1000 });
    }
  }
  goTo(t) {
    const ex = this.ex, f = (t - ex.cycle?.getTime()) / 3600e3;
    if (ex.cycle && f >= +$("fhr").min && f <= +$("fhr").max) { $("fhr").value = String(Math.round(f * 4) / 4); $("fhr").dispatchEvent(new Event("input")); }
    this.layer.setTime(t); ex.stage.markDirty();
  }
  onTime(d) {
    if (!d || !this.result) return;
    if (this.rp?.playing) return;                            // (the replay sets the boat and tag itself)
    this.layer.setTime(d.getTime()); this.updateTag(d.getTime());
  }
  // The tag beside the boat on the map: the time, what the boat is doing, the conditions, and notes
  // (tacking or gybing, waiting, motoring, dark, where the wind comes from).
  updateTag(t) {
    const P = this.result?.pts, res = this.result?.res;
    this.tagT = t;
    if (!P?.length || this.exportData?.pts !== P || !Number.isFinite(t) || $("ps-tag")?.value === "off" || t < P[0].t || t > P.at(-1).t) { this.layer.setTag(null); return; }
    let i = 1; while (i < P.length - 1 && P[i].t < t) i++;
    const r = this.row(P[i], P[i - 1], this.exportData.boat), s = this.stateAt(t), ll = this.ex.proj.toLatLon(s.x, s.y), fixed = res.fixedKn;
    const notes = [];
    if (s.hold) notes.push(P[i].m?.gate ? "holding for the tide" : "waiting in harbour");
    else if (P[i].m?.narrow) notes.push("motoring: narrow channel");
    else if (r.motor) notes.push("motoring");
    const tk = (this.exportData.tacks || []).find((q) => Math.abs(q.t - t) <= 10 * 60e3);
    if (tk) notes.push(tk.kind === "gybe" ? "gybe here" : "tack here");
    const alt = sunPosition(new Date(t), ll.lat, ll.lon).altitude * 57.2958;
    if (alt < -6) notes.push("dark"); else if (alt < 0) notes.push("twilight");
    if (!fixed && r.curKt >= 1 && r.along < -0.3 && r.tws >= 12 && Number.isFinite(r.twa) && Math.abs(r.twa) < 90) notes.push("wind against current: steep chop");
    const lim = this.opts().limits;
    if (!fixed && r.gust >= lim.maxGustKt - 3) notes.push(`gusts near the ${lim.maxGustKt} kt limit`);
    const src = P[i].c?.src;
    const cur = r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)} kt ${r.along >= 0 ? "fair" : "foul"}` : "slack";
    const lines = [`<b>${this.fmt(t)}</b>`, ...this.boatLines(P[i], r, { hold: s.hold }),
      fixed ? `current ${cur}` : `seas ${r.hs.toFixed(1)} ft · current ${cur}`,
      wxLine(this.wxAt(t), { short: true }),
      fixed || s.hold || r.motor ? "" : `<span class="dim">${r.sails}</span>`,
      ...notes.map((n) => `<span class="note">${n}</span>`),
      src ? `<span class="dim">${src}</span>` : ""].filter(Boolean);
    this.layer.setTag(lines.join("<br>"), this.ex.stage.camera);
    this.ex.stage.markDirty();
  }

  // Every departure hour in the run: how long the passage takes (coarser routing for speed).
  async bestDeparture() {
    if (this.wps.length < 2) { this.status("Add at least a start and an end on the map."); return; }
    this.setPicking(false);
    try {
      const { env, field } = await this.forecastEnv(), boat = this.boat(), out = [], lo = +$("ps-dep").min, hi = +$("ps-dep").max;
      for (let h = lo; h <= hi; h++) {
        this.status(`Trying each departure: +${h} h (${this.fmt(this.ex.cycle.getTime() + h * 3600e3)})…`);
        const r = await planRoute(env, boat, this.opts({ dtMin: Math.max(15, +$("ps-dt").value), dhDeg: 10, currents: !!field, allowWait: false }), this.wps, this.ex.cycle.getTime() + h * 3600e3);   // (leaving at that hour: no waiting)
        out.push({ h, t: this.ex.cycle.getTime() + h * 3600e3, hours: r.ok ? (r.pts.at(-1).t - r.pts[0].t) / 3600e3 : NaN, reason: r.reason });
      }
      const ok = out.filter((q) => Number.isFinite(q.hours));
      if (!ok.length) { this.status(`No departure in this run gets there: ${out.at(-1)?.reason}.`); return; }
      const best = ok.reduce((a, b) => (b.hours < a.hours ? b : a));
      this.chart = { kind: "forecast", series: [{ label: "passage", pts: out.map((q) => ({ t: q.t, v: q.hours })) }], best: [best] };
      this.drawChart();
      $("ps-dep").value = String(best.h); this.depLabel();
      await this.runForecast(best.h);
      $("ps-status").innerHTML += `<br><b>Best departure: ${this.fmt(best.t, true)}</b> (${hm(best.hours)}, arriving ${this.fmt(best.t + best.hours * 3600e3, true)}); the chart shows each departure's passage time (gaps: no route within the forecast or the limits). Click a bar to route that departure.`;
    } catch (e) { this.status(`Couldn't route: ${e.message}`); console.error(e); }
  }

  // Currents only: the water path, then every departure in the window at each speed.
  async runTide() {
    if (this.wps.length < 2) { this.status("Add at least a start and an end on the map."); return; }
    this.setPicking(false);
    const ex = this.ex, tz = ex.region.tz;
    try {
      const tA = zonedToUtc($("ps-from").value, tz), days = +$("ps-days").value, tB = tA + days * 86400e3, main = +$("ps-kn").value;
      const speeds = [...new Set([main, ...$("ps-kns").value.split(/[ ,;]+/).map(Number).filter((v) => v >= 1 && v <= 15)])].sort((a, b) => a - b);
      this.status("Loading the tidal current predictions…");
      const field = await this.field(tA - 3600e3, tB + 2 * 86400e3);
      if (!field) { this.status("No NOAA current stations in this region."); return; }
      const land = await ex.routeGrid(), boat = this.boat(), envW = makeEnv(ex, null, field, { windless: true, currents: false, land }), envC = makeEnv(ex, null, field, { windless: true, currents: true, land });
      this.status("Finding the water path through the waypoints…");
      const path = await planRoute(envW, boat, { dtMin: 10, dhDeg: 5, fixedKn: main, currents: false, maxHours: 240, limits: { clearKm: +$("ps-offland").value * NM } }, this.wps, tA);
      if (!path.ok) { this.status(`No water path: ${path.reason}.`); return; }
      const track = path.pts.map((p) => ({ x: p.x, y: p.y }));
      this.tide = { track, speeds, envC, boat, field };
      const series = [], best = [], day = $("ps-day").checked, start = this.wps[0], ll = ex.proj.toLatLon(start.x, start.y);
      for (const kn of speeds) {
        const pts = [];
        for (let t = tA; t < tB; t += 1800e3) {
          if (day && sunPosition(new Date(t), ll.lat, ll.lon).altitude * 57.3 < -6) { pts.push({ t, v: NaN }); continue; }
          const r = alongTrack(envC, track, kn, t);
          pts.push({ t, v: r ? (r.t1 - t) / 3600e3 : NaN, r });
        }
        const ok = pts.filter((q) => Number.isFinite(q.v)), top = ok.reduce((a, b) => (!a || b.v < a.v ? b : a), null), worst = ok.reduce((a, b) => (!a || b.v > a.v ? b : a), null);
        // The good window: the run of departures round the best that are within 10% (at least 15 min) of it.
        let w0 = null, w1 = null;
        if (top) { const lim = top.v + Math.max(0.25, top.v * 0.1), k = pts.indexOf(top); let a = k, b = k; while (a > 0 && pts[a - 1].v <= lim) a--; while (b < pts.length - 1 && pts[b + 1].v <= lim) b++; w0 = pts[a].t; w1 = pts[b].t; }
        // The best each (local) day.
        const days = new Map();
        for (const q of ok) { const key = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", weekday: "short" }).format(q.t); if (!days.has(key) || q.v < days.get(key).v) days.set(key, q); }
        series.push({ label: `${kn} kn`, kn, pts, top, worst, w0, w1, days });
        if (top) best.push({ ...top, kn });
      }
      this.chart = { kind: "tide", series, best };
      this.drawChart();
      const still = (track.reduce((s, p, i) => s + (i ? Math.hypot(p.x - track[i - 1].x, p.y - track[i - 1].y) : 0), 0)) / NM;
      const M = series.find((s) => s.kn === main) || series[0], arr = (q) => this.fmt(q.t + q.v * 3600e3, true);
      const dep = (q, kn) => `<a href="#" data-kn="${kn}" data-dep="${q.t}">${this.fmt(q.t, true)}</a>`;
      $("ps-out").innerHTML = `${M.top ? `<div class="ps-best"><span>Best time to leave at ${main} kn</span><b>${dep(M.top, main)}</b>
          <i>arrive ${arr(M.top)} · ${hm(M.top.v)} for ${still.toFixed(1)} nm · ${Math.round(M.top.r.fairMin)} min fair, ${Math.round(M.top.r.foulMin)} min foul current</i>
          <i>Good window: leave ${this.fmt(M.w0)} to ${this.fmt(M.w1)} (within 10% of the best). Worst: ${hm(M.worst.v)} leaving ${this.fmt(M.worst.t, true)}; at slack water it would take ${hm(still / main)}.</i></div>` : `<p class="note">No departure at ${main} kn makes it (a foul current stronger than the boat somewhere on the way).</p>`}
        <div class="ps-tbl"><table><thead><tr><th>Speed</th><th>Best time to leave</th><th>Arrive</th><th>Passage</th><th>Good window</th><th>Worst</th></tr></thead><tbody>${series.map((s) => s.top ? `<tr><td>${s.kn} kn</td><td>${dep(s.top, s.kn)}</td><td>${arr(s.top)}</td><td>${hm(s.top.v)}</td><td>${this.fmt(s.w0)}–${this.fmt(s.w1)}</td><td>${hm(s.worst.v)}</td></tr>` : `<tr><td>${s.kn} kn</td><td colspan="5">can't make it against the current</td></tr>`).join("")}</tbody></table></div>
        ${days > 1 ? `<details><summary>Best departure each day (${main} kn)</summary><div class="ps-tbl"><table><tbody>${[...M.days].map(([d, q]) => `<tr><td>${d}</td><td>${dep(q, main)}</td><td>${hm(q.v)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
        <p class="note">Water path ${still.toFixed(1)} nm, at a steady speed through the water, holding the track against the cross-set; departures every 30 minutes. The chart: passage time against departure time, one line per speed (the dips are the fair-tide windows; white dots, the best). Click a departure or a point on the chart for its full current-aware route, ETA and table. Tidal predictions only: no wind, waves, or wind-driven and river currents.</p>`;
      for (const a of $("ps-out").querySelectorAll("a[data-dep]")) a.addEventListener("click", (e) => { e.preventDefault(); this.tideRoute(+a.dataset.kn, +a.dataset.dep); });
      this.status(`Every departure from ${this.fmt(tA, true)} for ${days} day${days > 1 ? "s" : ""}, every 30 min, at ${speeds.join(", ")} kn${day ? " (daylight only)" : ""}.`);
      this.layer.setRoute(path.pts.map((p) => ({ ...p, m: { motor: false } })));
    } catch (e) { this.status(`Couldn't plan: ${e.message}`); console.error(e); }
  }
  // One departure in currents-only mode: the full current-aware route (isochrones at a steady speed).
  async tideRoute(kn, t) {
    const T = this.tide;
    if (!T) return;
    this.status(`Routing the ${this.fmt(t, true)} departure at ${kn} kn with the currents…`);
    const ms0 = performance.now(), r = await planRoute(T.envC, T.boat, { dtMin: 10, dhDeg: 5, fixedKn: kn, currents: true, maxHours: 240, limits: { clearKm: +$("ps-offland").value * NM } }, this.wps, t);
    if (!r.ok) { this.status(`No route: ${r.reason}.`); return; }
    r.fixedKn = kn;
    const out = $("ps-out").innerHTML;
    this.show(r, T.envC, T.boat, { field: T.field, ms: performance.now() - ms0 });
    $("ps-out").insertAdjacentHTML("beforeend", `<details><summary>Back to the departure table</summary>${out}</details>`);
    for (const a of $("ps-out").querySelectorAll("a[data-dep]")) a.addEventListener("click", (e) => { e.preventDefault(); this.tideRoute(+a.dataset.kn, +a.dataset.dep); });
  }

  // Passage time against departure time: one line per speed (currents only) or bars (forecast).
  drawChart() {
    const C = this.chart, cv = $("ps-chart");
    cv.hidden = false;
    const dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth || 280, H = 150;
    cv.style.height = `${H}px`; cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const all = C.series.flatMap((s) => s.pts), vs = all.map((p) => p.v).filter(Number.isFinite);
    if (!vs.length) return;
    const t0 = all[0].t, t1 = all.at(-1).t, vmin = Math.min(...vs) * 0.95, vmax = Math.max(...vs) * 1.03, L = 30, R = 6, T = 8, B = H - 18;
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), Y = (v) => B - ((v - vmin) / (vmax - vmin || 1)) * (B - T);
    this.chartGeom = { t0, t1, L, R, X, Y };
    const ink = getComputedStyle(document.body).getPropertyValue("--ink-soft") || "#8aa", tz = this.ex.region.tz;
    g.font = "9.5px ui-monospace, monospace"; g.fillStyle = ink;
    for (const v of [vmin, (vmin + vmax) / 2, vmax]) { g.fillText(`${v.toFixed(1)}h`, 0, Y(v) + 3); g.strokeStyle = "rgba(140,160,170,.18)"; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); }
    for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
      const hh = +new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(t);
      if (hh !== 0 && !(C.kind === "forecast" && hh % 6 === 0)) continue;
      g.strokeStyle = "rgba(140,160,170,.35)"; g.beginPath(); g.moveTo(X(t), T); g.lineTo(X(t), B); g.stroke();
      g.fillText(hh === 0 ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "numeric" }).format(t) : `${hh}h`, X(t) + 2, H - 5);
    }
    const cols = ["#6fb8ff", "#3fc1a5", "#f2d04b", "#f29a3b", "#e0473c", "#c58cf2"];
    C.series.forEach((s, k) => {
      g.strokeStyle = g.fillStyle = cols[k % cols.length];
      if (C.kind === "forecast") { const bw = Math.max(2, (W - L - R) / s.pts.length - 2); for (const p of s.pts) if (Number.isFinite(p.v)) g.fillRect(X(p.t) - bw / 2, Y(p.v), bw, B - Y(p.v)); return; }
      g.lineWidth = 1.5; g.beginPath(); let on = false;
      for (const p of s.pts) { if (!Number.isFinite(p.v)) { on = false; continue; } on ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v)); on = true; }
      g.stroke();
      g.fillText(s.label, W - R - 34, T + 10 + k * 11);
    });
    for (const b of C.best) { g.fillStyle = "#fff"; g.beginPath(); g.arc(X(b.t), Y(b.hours ?? b.v), 3.5, 0, 2 * Math.PI); g.fill(); }
  }
  chartClick(e) {
    const C = this.chart, G = this.chartGeom;
    if (!C || !G) return;
    const r = e.target.getBoundingClientRect(), t = G.t0 + ((e.clientX - r.left - G.L) / (r.width - G.L - G.R)) * (G.t1 - G.t0);
    if (C.kind === "forecast") { const h = Math.round((t - this.ex.cycle.getTime()) / 3600e3); $("ps-dep").value = String(h); this.depLabel(); this.runForecast(h); return; }
    // The nearest line to the click, at that departure.
    let best = null;
    for (const s of C.series) { const p = s.pts.reduce((a, q) => (Math.abs(q.t - t) < Math.abs(a.t - t) ? q : a)); if (!Number.isFinite(p.v)) continue; const d = Math.abs(G.Y(p.v) - (e.clientY - r.top)); if (!best || d < best.d) best = { d, kn: s.kn, t: p.t }; }
    if (best) this.tideRoute(best.kn, best.t);
  }
}
