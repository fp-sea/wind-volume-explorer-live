// Surface inspector: a true-scale patch of sea (200 m square, no exaggeration) at a clicked
// point, for the chop there (web/model/waves.js). Wave trains are drawn from a JONSWAP spectrum
// (peak enhancement γ = 3.3) around the peak period, spread ±70° about the wind direction
// (cos²-type), with random phases, and scaled so their significant height is the chop's Hs.
// Deep-water dispersion (ω² = g k); real time, so periods on screen are true. A 10 m boat for
// scale bobs at the centre. Linear waves (slightly sharpened crests, for looks): an
// illustration of what that Hs and period look like, not a forecast of individual waves.
//
// Gusts: the model's gust at the spot (its estimate of the peak gusts) drives a handful of puffs
// and lulls drifting downwind across the patch at about the wind speed, the strongest reaching
// the model's gust. Puffs raise ripples that roughen the water (cat's paws: darker, glittering,
// ragged-edged); lulls go glassy. The boat
// heels to the wind where it is, with a short lag, and a readout shows the wind at that moment.
// Strength follows the model; the timing, size and spacing of the puffs are illustrative.
//
// Sailing: the boat sails the chosen tack and point of sail against the true wind; its speed
// comes from approximate polars (polars.js) at the wind it's in, easing up and down with the
// puffs over several seconds; apparent wind from true wind and boat speed; heel from the apparent
// wind (most close-hauled, least running), sails trimmed to the apparent angle. A compass shows
// heading, true and apparent wind; instruments show HDG, BSP, TWS/TWD/TWA and AWS/AWA.
// Wind particles (optional): streaks a few metres above the water moving at the wind there (a
// log profile over the sea), faster in the puffs.
//
// Surroundings: the real terrain within ~30 km at true scale (the map's ground heights and land
// mask), and the sea running on to the horizon with distance haze; the wave patch fades into it at
// its edge. The boat makes way at its polar speed: the waves, puffs and wind streaks move
// relative to it (so the streaks show the apparent wind), and nearby land slides past. Reset puts
// it back on the clicked spot. Full screen with ⛶. Boat motion: see moveBoat.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { trains, TRAINS as N } from "./model/waves.js?v=20261002173952";
import { buildBoat, BOATS } from "./boats.js?v=20261002173952";
import { POINTS, POLARS, boatSpeed, apparent } from "./polars.js?v=20261002173952";
import { PLANS, autoPlan, heelFor, leeway, waveLoss, sailMoment, sailArea, sailShapes, sailCoefs, sailForces } from "./sailplan.js?v=20261002173952";
import { waveOnCurrent, chopOnCurrent } from "./model/currents.js?v=20261002173952";
import { sunPosition, moonPosition, moonIllumination, phaseName, toVec } from "./astro.js?v=20261002173952";
import { wxLine, rainWord, fF } from "./route/weather.js?v=20261002173952";

const SPRAY = 1500, NSF = 1500, TRAIL = 10;    // spray droplets; streaks round the sails and their trail points
// The Beaufort scale (WMO): upper wind limit (kt), name, and the open sea's look.
const BEAUFORT = [[1, "calm", "sea like a mirror"], [3, "light air", "ripples, no foam crests"], [6, "light breeze", "small wavelets, glassy crests"],
  [10, "gentle breeze", "large wavelets, crests begin to break, scattered whitecaps"], [16, "moderate breeze", "small waves, fairly frequent whitecaps"],
  [21, "fresh breeze", "moderate waves, many whitecaps, some spray"], [27, "strong breeze", "large waves forming, white foam crests everywhere, some spray"],
  [33, "near gale", "sea heaps up, foam from breaking waves blown in streaks"], [40, "gale", "crests break into spindrift, foam in well-marked streaks"],
  [47, "strong gale", "high waves, dense foam streaks, crests topple, spray may cut visibility"], [55, "storm", "very high waves, the sea white with foam"],
  [63, "violent storm", "exceptionally high waves, visibility reduced by spray"], [Infinity, "hurricane force", "the air filled with foam and spray"]];
const beaufort = (kt) => { const i = BEAUFORT.findIndex(([top]) => kt <= top); return { n: i, name: BEAUFORT[i][1], sea: BEAUFORT[i][2] }; };
const G = 9.80665, SIZE = 200, FT = 3.28084, KT = 1.943844, NWP_MAX = 6000;
const activeKey = (plan, twa) => plan.heads.map((h) => (h.includes("@") ? `${h}${twa >= 70 && twa < 120}` : h)).join(",") + (twa >= 120);
const deg3 = (d) => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, "0");
const $ = (id) => document.getElementById(id);

export class SurfaceInspector {
  constructor() {
    this.el = document.createElement("div");
    this.el.id = "inspector";
    this.el.hidden = true;
    this.el.innerHTML = `<div class="ins-head"><b id="ins-title">Sea surface</b><span><button class="btn mini" id="ins-min" title="Minimise to this bar (click again to restore); drag the panel's corner to resize it">▁</button> <button class="btn mini" id="ins-full" title="Full screen (Esc to leave)">⛶</button> <button class="btn mini" id="ins-close" title="Close (Esc)">✕</button></span></div>
      <div id="ins-view"><div id="ins-wind" hidden></div><div id="ins-motion" hidden></div>
        <svg id="ins-compass" viewBox="-60 -60 120 120" aria-label="Compass: heading, true and apparent wind"></svg></div>
      <div id="ins-time"><div class="ins-time-lab"><b id="ins-t-lab">Model time</b><span id="ins-t-sub"></span></div>
        <div class="ins-time-row"><button class="btn mini" id="ins-play" title="Play: the forecast here as it goes on (or, replaying a passage, sail it)">▶</button><span id="ins-t-lo"></span><input id="ins-t" type="range" min="0" max="18" step="0.25" value="0" title="Model time (or, replaying a passage, the passage): moves the main time slider too; the viewer redraws for the new hour"><span id="ins-t-hi"></span></div></div>
      <div class="ins-tabs" role="tablist">
        <button class="on" data-tab="data" role="tab">Data</button><button data-tab="ctl" role="tab">Controls</button></div>
      <div id="ins-panes">
        <section data-pane="data"><div id="ins-seas"></div>
      <div id="ins-inst"></div>
      <div id="ins-hist"><canvas id="ins-hist-c" width="380" height="74"></canvas>
        <select id="ins-hist-win" class="mini" title="How much history the trace shows"><option value="60">1 min</option><option value="120" selected>2 min</option><option value="300">5 min</option></select></div>
      <details id="ins-details"><summary>Details: waves, swell, gusts, sources</summary><div class="note" id="ins-note"></div></details></section>
        <section data-pane="ctl" hidden>
          <h4 class="ins-h">Sailing</h4><div class="ins-grp"><span class="seg"><button class="btn mini" id="ins-port" title="Port tack: wind over the port (left) side">Port</button><button class="btn mini" id="ins-stbd" title="Starboard tack: wind over the starboard (right) side">Starboard</button></span>
          <select id="ins-pos" class="mini" title="Point of sail (true wind angle)">${POINTS.map((q) => `<option value="${q.id}">${q.label} ${q.twa}°</option>`).join("")}</select></div>
          <div class="ins-grp"><select id="ins-sails" class="mini" title="Sails set: auto reefs for the model's gusts (keeps the heel near 20° in the gusts, and reefs by gust strength when running); or choose a plan"></select></div>
          <div class="ins-grp"><span class="ins-gl">Passage</span><select id="ins-speed" class="mini" title="Fast-forward the passage: the boat's progress (and its track on the map) runs this much faster; waves, puffs and wind streaks stay real time"><option value="1">real time</option><option value="10">×10</option><option value="60">×60</option></select>
          <button class="btn mini" id="ins-reset" title="Back to the clicked spot">Reset position</button></div>
          <h4 class="ins-h">Wind</h4><div class="ins-grp"><label class="row" title="Wind streaks from just above the water to 30 m, moving at the wind at their height (a standard over-sea wind profile from the model's 10 m wind), faster in the puffs; brightness shows the wind's force (dynamic pressure, speed squared), warmer in strong puffs"><input id="ins-wp" type="checkbox" checked> Wind particles</label>
        <label class="row" title="How many wind streaks (200 to 6,000)">density <input id="ins-wpd" type="range" min="200" max="6000" step="100" value="1200"></label>
        <label class="row" title="The air flowing round the sails: each sail set (reefed or not, whichever headsails, the spinnaker) is modelled as a stack of vortices carrying its lift (lifting-line theory), which bend the streaks near the boat: lifted ahead of the luff, faster to leeward and through the slot, turned down off the leech, with tip vortices; off the wind the sails stall and leave a slow, churning wake. Some streaks are released just upwind of the rig to show it"><input id="ins-sflow" type="checkbox" checked> Flow round the sails</label></div>
          <h4 class="ins-h">Sea &amp; scene</h4><div class="ins-grp"><label class="row" title="The sea's texture for the wind (the Beaufort scale's signs): whitecaps covering the share of the sea the wind gives (Monahan's relation: ~1% at 20 kt, ~4% at 30 kt, ~10% at 40 kt, more in the puffs), foam blown in streaks along the wind from Force 7, spindrift off the crests from Force 8"><input id="ins-bft" type="checkbox" checked> Beaufort texture</label>
        <label class="row" title="The boat's own marks on the water: bow wave and wake foam growing with speed, spray sheets when surfing, and a burst of spray when the bow slams (its size from how hard it came down, the droplets random, blown downwind)"><input id="ins-spray" type="checkbox" checked> Spray &amp; wake</label>
        <label class="row" title="The model's weather here (HRRR, or RRFS in Hawaiʻi; in a passage replay, the passage's weather at the boat): cloud cover as a drifting deck that greys the sky and dims the sun, moon and stars; fog closing the view in to the model's visibility; rain falling at its rate (drizzle to heavy), blown by the wind; lightning flashes in thunderstorms. The air temperature, visibility, rain and cloud are in the Data tab"><input id="ins-wx" type="checkbox" checked> Weather (sky, fog, rain)</label>
        <label class="row" title="Sentinel-2 satellite imagery on the land (the map's cloud-free 2024 mosaic)"><input id="ins-sat" type="checkbox" checked> Satellite on land</label>
        <select id="ins-vex" class="mini" title="Terrain exaggeration: stretch the land's heights (the sea, waves and boat stay true scale)"><option value="1">terrain 1× (true)</option><option value="2">terrain 2×</option><option value="3">terrain 3×</option><option value="5">terrain 5×</option></select>
        <select id="ins-night" class="mini" hidden title="At night: see the sea surface better. Brighter lifts the whole scene (like night vision); spotlight shines a searchlight from the bow onto the water ahead, with a deck floodlight"><option value="natural">night: natural</option><option value="bright">night: brighter</option><option value="spot">night: spotlight</option></select></div>
          <h4 class="ins-h">View</h4><div class="ins-grp"><button class="btn mini" id="ins-cam-reset" title="Back to the chase view: behind the boat, looking along its heading">Reset view</button>
        <button class="btn mini" id="ins-cam-sails" title="Close in on the rig from the leeward quarter, to watch the flow round the sails">Sail view</button>
        <button class="btn mini" id="ins-cam-cockpit" title="From the cockpit: sitting at the helm on the windward side, moving with the boat (heel, roll, pitch, yaw, heave), with a motion readout">Cockpit</button>
        <select id="ins-look" class="mini" hidden title="Where you're looking from the cockpit"><option value="ahead">look ahead</option><option value="lee">to leeward</option><option value="wind">to windward</option><option value="sails">up at the sails</option><option value="heads">at the headsails (telltales)</option><option value="astern">astern</option></select></div></section>
      </div>`;
    document.body.append(this.el);
    $("ins-close").addEventListener("click", () => this.close());
    $("ins-min").addEventListener("click", () => { const m = this.el.classList.toggle("mini"); $("ins-min").textContent = m ? "▢" : "▁"; if (!m) this.fit(); this.keepOnScreen(); });
    this.movable();
    // Tabs: the readouts (Data) and the controls.
    for (const b of this.el.querySelectorAll(".ins-tabs button")) b.addEventListener("click", () => {
      for (const x of this.el.querySelectorAll(".ins-tabs button")) x.classList.toggle("on", x === b);
      for (const sec of this.el.querySelectorAll("#ins-panes > section")) sec.hidden = sec.dataset.pane !== b.dataset.tab;
    });
    this.tack = "port"; this.point = "close";
    const sync = () => { $("ins-port").classList.toggle("on", this.tack === "port"); $("ins-stbd").classList.toggle("on", this.tack === "stbd"); $("ins-pos").value = this.point; };
    const own = () => { if (this.replay) { this.replay = null; this.el.classList.remove("replay"); this.onReplayEnd?.(); } };   // taking the helm ends a replay
    $("ins-port").addEventListener("click", () => { own(); this.tack = "port"; sync(); this.course(); });
    $("ins-stbd").addEventListener("click", () => { own(); this.tack = "stbd"; sync(); this.course(); });
    $("ins-pos").addEventListener("change", (e) => { own(); this.point = e.target.value; this.course(); });
    $("ins-sails").addEventListener("change", () => this.course());
    // Model time: the viewer's own slider drives the main one (timeCtl, set by the explorer).
    $("ins-t").addEventListener("input", (e) => { this.timeLabel(+e.target.value); this.ctl()?.set(+e.target.value); });
    $("ins-play").addEventListener("click", () => { this.ctl()?.play?.(); setTimeout(() => this.syncTime(), 50); });
    $("ins-wp").addEventListener("change", (e) => { if (this.wp) this.wp.visible = e.target.checked; });
    $("ins-wpd").addEventListener("input", () => this.setParticleCount());
    $("ins-sflow").addEventListener("change", () => { this.vort = null; });
    $("ins-sat").addEventListener("change", () => this.landStyle());
    $("ins-night").addEventListener("change", () => this.setSky(this.skyDate ?? null));
    $("ins-wx").addEventListener("change", () => { if (!$("ins-wx").checked) { this.wx = null; this.setSky(this.skyDate ?? null); } this.onWantWx?.(); });
    $("ins-vex").addEventListener("change", () => { if (this.land) this.land.scale.z = +$("ins-vex").value; });
    sync();
    this.hist = [];                                                   // [t (s), TWS kt, BSP kn, AWS kt], one every 0.5 s
    $("ins-hist-win").addEventListener("change", () => this.drawHistory());
    window.addEventListener("keydown", (e) => { if (e.key !== "Escape" || this.el.hidden) return; if (this.el.classList.contains("full")) this.fullscreen(false); else this.close(); });
    $("ins-full").addEventListener("click", () => this.fullscreen(!this.el.classList.contains("full")));
    $("ins-reset").addEventListener("click", () => this.resetPosition());
    const cam = (mode) => {
      this.camMode = mode; $("ins-look").hidden = mode !== "cockpit"; $("ins-motion").hidden = mode !== "cockpit";
      $("ins-cam-cockpit").classList.toggle("on", mode === "cockpit");
      this.controls.enabled = mode !== "cockpit";
      if (mode !== "cockpit") { this.camera.up.set(0, 0, 1); if (this.camera.fov !== 45) { this.camera.fov = 45; this.camera.updateProjectionMatrix(); } mode === "sails" ? this.sailView() : this.chase(); }
    };
    $("ins-cam-reset").addEventListener("click", () => cam("chase"));
    $("ins-cam-sails").addEventListener("click", () => cam("sails"));
    $("ins-cam-cockpit").addEventListener("click", () => cam(this.camMode === "cockpit" ? "chase" : "cockpit"));
    window.addEventListener("resize", () => { if (!this.el.hidden) this.fit(); });
    // Redraw at the view's size whenever its box changes (full screen, tabs, window, fonts).
    new ResizeObserver(() => { if (!this.el.hidden) this.fit(); }).observe($("ins-view"));
    this.renderer = null;
  }

  // The model time slider: range and labels from the explorer's (local and UTC, lead time, run).
  // The time row's control: the forecast (timeCtl, the explorer's), or while a passage replays in
  // the viewer, the passage itself (passCtl, the planner's): scrub it and sail it from here.
  ctl() { return this.replay && this.passCtl?.get() ? this.passCtl : this.timeCtl; }
  syncTime() {
    const c = this.ctl()?.get();
    $("ins-time").hidden = !c;
    if (!c) return;
    const r = $("ins-t");
    r.min = c.min; r.max = c.max; r.step = c.step;
    if (document.activeElement !== r) r.value = c.value;
    const fmt = (t) => new Intl.DateTimeFormat("en-US", { timeZone: c.tz, weekday: "short", hour: "numeric", timeZoneName: "short" }).format(new Date(c.passage ? t : c.cycle.getTime() + t * 3600e3));
    $("ins-t-lo").textContent = fmt(c.min); $("ins-t-hi").textContent = fmt(c.max);
    const playing = !!this.ctl()?.playing?.();
    $("ins-play").textContent = playing ? "⏸" : "▶";
    $("ins-play").title = c.passage ? (playing ? "Pause the passage" : "Sail the passage from here") : (playing ? "Stop the forecast playing" : "Play the forecast: the wind and sea here as the forecast goes on");
    this.timeLabel(+r.value);
  }
  timeLabel(t) {
    const c = this.ctl()?.get();
    if (!c) return;
    if (c.passage) {                                             // (the passage: its time, and how far along)
      const d = new Date(t), loc = new Intl.DateTimeFormat("en-US", { timeZone: c.tz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
      $("ins-t-lab").textContent = `${loc} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
      $("ins-t-sub").textContent = `the passage: ${Math.round(((t - c.min) / Math.max(1, c.max - c.min)) * 100)}% of the way · drag to move the boat, ▶ to sail it${this.sky ? ` · ${this.sky.text}` : ""}`;
      return;
    }
    const d = new Date(c.cycle.getTime() + t * 3600e3);
    const loc = new Intl.DateTimeFormat("en-US", { timeZone: c.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
    const utc = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
    $("ins-t-lab").textContent = `${loc} · ${utc}`;
    $("ins-t-sub").textContent = `+${t % 1 ? t.toFixed(2).replace(/0$/, "") : t} h · ${c.model} ${String(c.cycle.getUTCHours()).padStart(2, "0")}Z run${this.sky ? ` · ${this.sky.text}` : ""}`;
  }

  // Passage replay: the planner drives the boat. s: {t (ms), hdg, side (+1 wind from starboard),
  // twa, bsp, motor, hold, offX, offY (m from the viewer's anchor)} or null to hand back.
  setReplay(s) {
    const was = !!this.replay;
    this.replay = s;
    if (was !== !!s || s) this.syncTime();                       // (the time row follows the passage, or back to the forecast)
    this.el.classList.toggle("replay", !!s);
    if (!s) { if (was) this.course(); return; }
    const tack = s.side > 0 ? "stbd" : s.side < 0 ? "port" : this.tack;
    this.when = new Date(s.t); this.simT0 = this.simT || 0;
    if (tack !== this.tack || Math.abs(Math.abs(s.twa || 0) - (this.twa || 0)) > 3 || Math.abs(((s.hdg - (this.hdg ?? 0) + 540) % 360) - 180) > 3) {
      this.tack = tack; $("ins-port").classList.toggle("on", tack === "port"); $("ins-stbd").classList.toggle("on", tack === "stbd");
      this.course();
    }
    if (this.off) { this.off.set(s.offX, s.offY); if (this.land) this.land.position.set(-s.offX, -s.offY, 0); }
  }

  close() { this.fullscreen(false); this.el.hidden = true; this.running = false; this.onClose?.(); }
  fullscreen(on) { this.el.classList.toggle("full", on); $("ins-full").textContent = on ? "⤡" : "⛶"; this.fit(); if (!on) this.keepOnScreen(); }

  // A floating window: drag it by its title bar; resize from the bottom-right corner (it's placed
  // by its top-left, so the corner follows the pointer); where it was is remembered. (Narrow
  // screens keep the full-width layout; full screen fills the window.)
  movable() {
    const KEY = "wve.viewer.geom", head = this.el.querySelector(".ins-head"), narrow = () => innerWidth <= 700;
    const save = () => { try { const r = this.el.getBoundingClientRect(); localStorage.setItem(KEY, JSON.stringify({ l: r.left, t: r.top, w: r.width, h: this.el.classList.contains("mini") ? null : r.height })); } catch { /* no storage */ } };
    // (placed by its top-left from where it is now, or from where it was last time)
    this.place = () => {
      if (narrow() || this.el.classList.contains("full") || this.el.hidden) { if (narrow()) for (const k of ["left", "top", "right", "bottom", "width", "height"]) this.el.style[k] = ""; return; }
      let g = null; try { g = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* no storage */ }
      if (!this.placed && g) { this.el.style.width = `${g.w}px`; if (g.h) this.el.style.height = `${g.h}px`; this.el.style.left = `${g.l}px`; this.el.style.top = `${g.t}px`; }
      else if (!this.placed) { const r = this.el.getBoundingClientRect(); this.el.style.left = `${r.left}px`; this.el.style.top = `${r.top}px`; }
      this.el.style.right = "auto"; this.el.style.bottom = "auto"; this.placed = true;
      this.keepOnScreen();
    };
    this.keepOnScreen = () => {
      if (!this.placed || narrow() || this.el.classList.contains("full")) return;
      const r = this.el.getBoundingClientRect(), w = Math.min(r.width, innerWidth - 16);
      if (r.width > innerWidth - 16) this.el.style.width = `${w}px`;
      if (r.height > innerHeight - 16) this.el.style.height = `${innerHeight - 16}px`;
      this.el.style.left = `${Math.min(innerWidth - 120, Math.max(120 - w, r.left))}px`;       // (the title bar stays reachable)
      this.el.style.top = `${Math.min(innerHeight - 40, Math.max(0, r.top))}px`;
    };
    head.style.cursor = "move"; head.style.touchAction = "none";
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select, input") || narrow() || this.el.classList.contains("full")) return;
      this.place();
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (q) => { this.el.style.left = `${q.clientX - dx}px`; this.el.style.top = `${q.clientY - dy}px`; this.keepOnScreen(); };
      const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); save(); };
      head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
      e.preventDefault();
    });
    // Resizing (the CSS corner) is saved as it settles; the view refits (the ResizeObserver).
    let t = null;
    new ResizeObserver(() => { if (this.placed && !this.el.hidden && !this.el.classList.contains("full")) { clearTimeout(t); t = setTimeout(save, 300); } }).observe(this.el);
    window.addEventListener("resize", () => this.keepOnScreen());
  }
  // The renderer to the view's size (the panel's width, about 3:2, or the whole window in full screen).
  fit() {
    if (!this.renderer) return;
    const v = $("ins-view"), full = this.el.classList.contains("full"), w = full ? v.clientWidth : v.clientWidth || 464, h = full ? v.clientHeight : Math.round(w * 0.68);
    if (!w || !h) return;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  resetPosition() { this.off.set(0, 0); this.waveOff?.set(0, 0); this.logM = 0; if (this.land) this.land.position.set(0, 0, 0); this.onMove?.(this.off, this.hdg ?? 0); }

  // Wind history: true wind speed over the last 1-5 minutes (with the model's mean and gust as
  // reference lines), apparent wind and boat speed below, like a wind-trace instrument page.
  drawHistory() {
    const cv = $("ins-hist-c"), g = cv.getContext("2d"), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 380, H = cv.clientHeight || 74;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const win = +$("ins-hist-win").value, h = this.hist, gs = this.gust;
    if (!h.length || !gs) return;
    const tEnd = h[h.length - 1][0], t0 = tEnd - win, kt = 1.943844;
    const top = Math.max(gs.gust * kt * 1.1, ...h.map((r) => r[3])) , L = 30, R = W - 4, T = 6, B = H - 12;
    const X = (t) => L + ((t - t0) / win) * (R - L), Y = (v) => B - (v / top) * (B - T);
    g.font = "9px ui-monospace, monospace"; g.fillStyle = "rgba(146,171,178,.9)"; g.strokeStyle = "rgba(146,171,178,.25)"; g.lineWidth = 1;
    for (const v of [0, Math.round(top / 2), Math.round(top)]) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(R, Y(v)); g.stroke(); g.fillText(`${v}`, 4, Y(v) + 3); }
    g.fillText(`−${win >= 120 ? `${win / 60} min` : `${win} s`}`, L, H - 2); g.fillText("now", R - 18, H - 2);
    const ref = (v, col, label) => { g.setLineDash([4, 3]); g.strokeStyle = col; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(R, Y(v)); g.stroke(); g.setLineDash([]); g.fillStyle = col; g.fillText(label, R - 44, Y(v) - 2); };
    ref(gs.mean * kt, "rgba(111,184,255,.65)", "mean"); ref(gs.gust * kt, "rgba(255,120,90,.8)", "gust");
    const line = (k, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); let on = false; for (const r of h) { if (r[0] < t0) continue; on ? g.lineTo(X(r[0]), Y(r[k])) : g.moveTo(X(r[0]), Y(r[k])); on = true; } g.stroke(); };
    line(3, "#ffb347", 1.2); line(2, "#e8f3f5", 1.2); line(1, "#6fb8ff", 2);
    g.fillStyle = "#6fb8ff"; g.fillText("TWS", L + 2, T + 7); g.fillStyle = "#ffb347"; g.fillText("AWS", L + 28, T + 7); g.fillStyle = "#e8f3f5"; g.fillText("STW", L + 54, T + 7);
  }

  // at {lat, lon}; c: chopAt() result (or null); swell: [{hs, tp, dir}] from the wave model;
  // boat: a BOATS key; extra: note lines (e.g. the wave-model source).
  // wind: {mean, gust (m/s), fromDeg} from the model at the spot, or null.
  // env: {key, x, y (scene km), heightM(x, y), isLand(x, y)} for the surroundings, or null.
  open(at, c, swell = [], boat = "ps37", extra = "", wind = null, env = null) {
    this.el.hidden = false;
    this.place?.();
    const view = $("ins-view");
    if (!this.renderer) this.setup(view);
    const ft = (m) => (m * FT).toFixed(1), L = c ? (G * c.tp * c.tp) / (2 * Math.PI) : 0;
    const dir = c ? ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(c.fromDeg / 22.5) % 16] : "";
    $("ins-title").textContent = `Sea surface at ${at.lat.toFixed(3)}°, ${at.lon.toFixed(3)}°`;
    const windKt = (c?.u10 ?? 0) * KT;
    // Replaying a passage (and in its movie) the conditions change every few minutes of passage:
    // they ease from one to the next (blend(), ~1 s) instead of starting the sea, the puffs and
    // the wave clock afresh each time, which made the viewer jump.
    const smooth = !!this.replay && this.running && !!this.waves && !!this.gust;
    const twd = wind?.fromDeg ?? c?.fromDeg ?? (swell[0]?.dir ?? 0), gw = wind || (c ? { mean: c.u10, gust: null, fromDeg: c.fromDeg } : null);
    this.heelRad ??= 0;
    if (smooth && gw && gw.mean > 0.5) this.gustTarget = gw;
    else { this.twd = twd; this.gustTarget = null; this.setGusts(gw); }
    const sw = swell.map((s) => `${(s.hs * FT).toFixed(1)} ft at ${Math.round(s.tp)} s from ${Math.round(s.dir)}°`).join("; ");
    const tot = Math.sqrt((c?.hs ?? 0) ** 2 + swell.reduce((a, s) => a + s.hs * s.hs, 0));
    const bs = BOATS[boat];
    $("ins-note").innerHTML = (c ? `Chop ${ft(c.hs)} ft (${c.hs.toFixed(2)} m) at ${c.tp.toFixed(1)} s from ${dir} (${Math.round(c.fromDeg)}°) · wavelength ~${Math.round(L)} m · wind ${Math.round(windKt)} kt over ${Math.round(c.fetchKm)} km of fetch.` : "No local chop here (calm).")
      + (sw ? `<br>Swell: ${sw} (NOAA wave model).` : "<br>No swell here in the wave model (sheltered water).")
      + `<br>Combined about ${ft(tot)} ft. True scale, ${SIZE} m square, no exaggeration, real-time motion. The boat is a stylised ${bs.name} (${bs.note}, ${bs.lod.toFixed(1)} m on deck, ${bs.beam} m beam), sailing the tack and point of sail chosen below.`
      + ` An illustration of those heights and periods (random wave trains), not a forecast of individual waves.`
      + (this.gust ? `<br>Gusts: the model's gust here is ${Math.round(this.gust.gust * 1.943844)} kt against a mean of ${Math.round(this.gust.mean * 1.943844)} kt (gust factor ${(this.gust.gust / Math.max(0.5, this.gust.mean)).toFixed(1)}). Passing puffs darken the water (cat's paws) and lulls go glassier; the boat heels with the wind where it is. The strength follows the model; the timing and spacing of puffs are illustrative.` : "")
      + `<br>Sailing: boat speed from approximate polars (estimated for a heavy full-keel cutter from its waterline, not a measured polar) at the wind the boat is in, less the speed lost to the waves on this heading, and more or less with a bigger or smaller sail plan than the auto one; apparent wind from true wind and boat speed. Heel: the sails' heeling moment (area, height and the apparent wind at their height) against the boat's righting moment (approximate displacement and stability). Sails: auto reefs to keep the heel near 20° in the model's gusts, and by gust strength when running. Leeway from heel and speed. STW is the speed through the water (boat speed); SOG and COG are over the ground, with the tidal current's set and drift when currents are on (Sea &amp; weather → Tidal currents, "current effects on waves"; always in a passage replay planned with currents). VMG: speed toward (↑) or away from (↓) the true wind. TWA/AWA: P = wind over the port side, S = starboard.`
      + (extra ? `<br>${extra}` : "");
    // (the same seed all through a replay, so the wave trains change smoothly with the conditions)
    if (!this.replay) this.replaySeed = null;
    const seed = this.replaySeed ?? Math.round(at.lat * 1000 + at.lon * 1000);
    if (this.replay) this.replaySeed = seed;
    const nw = trains(c, seed, swell);
    // Tidal current (optional): each wave train keeps its frequency over the ground but is
    // shortened and steepened against the current (lengthened with it), capped where it breaks;
    // the wind the boat feels is the wind over the moving water; the boat drifts with it.
    const cur = env?.current || null;
    if (smooth && this.cur && cur) this.curTarget = cur; else { this.cur = cur; this.curTarget = null; }
    if (cur) for (const w of nw) {
      const k = Math.hypot(w.kx, w.ky);
      if (!(k > 0) || !(w.a > 0)) continue;
      const r = waveOnCurrent((2 * Math.PI) / w.w, (cur.u * w.kx + cur.v * w.ky) / k), k1 = (2 * Math.PI) / r.L;
      w.kx *= k1 / k; w.ky *= k1 / k; w.a = Math.min(w.a * r.mul, 0.3 / k1);
    }
    if (smooth && this.waves.length === nw.length) this.waveTarget = nw; else { this.waves = nw; this.waveTarget = null; }
    if (this.boatKey !== boat) {
      const cur = $("ins-sails").value;
      $("ins-sails").innerHTML = `<option value="auto">Sails: auto</option>` + PLANS[boat].map((q) => `<option value="${q.id}">${q.label}</option>`).join("");
      $("ins-sails").value = PLANS[boat].some((q) => q.id === cur) ? cur : "auto";
    }
    this.boatKey = boat;
    this.when = env?.when || null; this.tz = env?.tz; this.at = at; this.simT0 = this.simT || 0;
    this.wx = $("ins-wx").checked ? env?.weather || null : null;
    this.course();
    this.setSky(this.when);
    this.syncTime();
    // Sea state at a glance (details in the fold below): combined height, chop and each swell.
    const dirTxt = (d) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
    const parts = [c ? `chop ${ft(c.hs)} ft @ ${c.tp.toFixed(0)} s ${dirTxt(c.fromDeg)}` : "no chop"]
      .concat(swell.map((w) => `swell ${ft(w.hs)} ft @ ${Math.round(w.tp)} s ${dirTxt(w.dir)}`));
    const bf = beaufort((this.gust?.mean ?? 0) * KT);
    $("ins-seas").innerHTML = `<span>Seas ≈ ${ft(tot)} ft combined · Force ${bf.n}, ${bf.name}: ${bf.sea}${bf.n >= 4 ? " (in open water; less in short fetch)" : ""}</span><b>${parts.join(" · ")}</b>`
      + (this.cur ? `<span class="ins-cur">Current ${this.cur.kt.toFixed(1)} kt setting ${String(Math.round(this.cur.set)).padStart(3, "0")}° (${this.cur.src ? `${this.cur.src} model` : `NOAA predictions${this.cur.station ? `; nearest station ${this.cur.station}${Number.isFinite(this.cur.km) ? `, ${(this.cur.km / 1.852).toFixed(1)} nm away` : ""}` : ""}`}${this.cur.route ? "; the passage's current at the boat, now" : ""}). <b>On the waves:</b> ${this.curWaves(c, swell)}. The boat drifts with it (SOG and COG over the ground).</span>`
        : env?.curOff ? `<span>Tidal current not applied (turn on Sea &amp; weather → Tidal currents, "current effects on waves").</span>` : "")
      + (this.wx ? `<span class="ins-wxl">Weather: ${wxLine(this.wx)}${Number.isFinite(this.wx.td) ? ` · dewpoint ${fF(this.wx.td)}°F` : ""} (${this.wx.src})</span>` : "")
      + `<span id="ins-seas-cost">${this.waveF < 0.995 ? `waves cost ~${Math.round((1 - this.waveF) * 100)}% of boat speed on this heading` : "no speed lost to the waves on this heading"}</span>`;
    if (env?.key !== this.envKey) {
      this.envKey = env?.key; this.buildLand(env);
      if (!smooth) { this.resetPosition(); this.hist = []; this.simT = 0; this.mo = null; this.chase(); this.chasedHdg = this.hdg; }   // (a replay's boat and camera carry on: the land moves under them)
    }
    if (smooth) return;
    const u = this.mat.uniforms;
    for (let i = 0; i < N; i++) { const t = this.waves[i]; u.uA.value[i] = t.a; u.uK.value[i].set(t.kx, t.ky); u.uW.value[i] = t.w; u.uP.value[i] = t.ph; }
    this.t0 = performance.now();
    if (!this.running) { this.running = true; requestAnimationFrame((t) => this.loop(t)); }
  }

  // How the current changes the chop here, in words.
  curEffect(c) {
    const to = ((c.fromDeg + 180) * Math.PI) / 180, U = this.cur.u * Math.sin(to) + this.cur.v * Math.cos(to);
    const L0 = (G * c.tp * c.tp) / (2 * Math.PI), q = chopOnCurrent(c.hs, c.tp, Math.sin(to), Math.cos(to), this.cur.u, this.cur.v);
    if (Math.abs(U) < 0.1) return "about unchanged (current across it)";
    if (q.blocked) return `against it and strong enough to block it: the waves shorten and steepen until they break (${Math.round(q.L)} m apart instead of ${Math.round(L0)}, heights limited by breaking), a short, breaking sea — dangerous for a small boat`;
    return `${U < 0 ? "against" : "with"} it: ${Math.round(Math.abs(q.mul - 1) * 100)}% ${q.mul >= 1 ? "higher" : "lower"}, ${Math.round(q.L)} m apart instead of ${Math.round(L0)}`
      + (q.blocked ? ", breaking (the current stops the waves)" : "") + (q.rating > 1 ? " — dangerous" : q.rating ? " — steep" : "");
  }

  // What the current does to each wave train here, in words: chop and each swell.
  curWaves(c, swell = []) {
    const out = [];
    if (c) out.push(`chop ${this.curEffect(c)}`);
    for (const s of swell) {
      const to = ((s.dir + 180) * Math.PI) / 180, U = this.cur.u * Math.sin(to) + this.cur.v * Math.cos(to);
      if (Math.abs(U) < 0.1) { out.push(`swell from ${Math.round(s.dir)}° about unchanged (current across it)`); continue; }
      const L0 = (G * s.tp * s.tp) / (2 * Math.PI), r = waveOnCurrent(s.tp, U);
      out.push(`swell from ${Math.round(s.dir)}° ${U < 0 ? "against" : "with"} it: ${Math.round(Math.abs(r.mul - 1) * 100)}% ${r.mul >= 1 ? "higher" : "lower"}, ${Math.round(r.L)} m apart instead of ${Math.round(L0)}`);
    }
    return out.length ? out.join("; ") : "no waves to change";
  }

  // The wind over the water (what the boat sails in and its instruments read): the model's wind
  // over the ground (speed v m/s from this.twd) less the tidal current. → {ms, from (°)}.
  water(v) {
    const r = (this.twd * Math.PI) / 180, wx = -Math.sin(r) * v - (this.cur?.u || 0), wy = -Math.cos(r) * v - (this.cur?.v || 0);
    return { ms: Math.hypot(wx, wy), from: ((Math.atan2(-wx, -wy) * 180) / Math.PI + 360) % 360 };
  }

  // Heading, sail trim and the boat itself for the chosen tack and point of sail. Port tack: wind
  // over the port side, heading = TWD + TWA; starboard: TWD − TWA (the boat mirrored).
  course() {
    if (!this.scene) return;
    // (During a passage replay the route sets the heading and the true wind angle.)
    const rq = this.replay, q = rq ? { twa: Math.max(30, Math.min(180, Math.abs(rq.twa) || 90)) } : POINTS.find((x) => x.id === this.point) || POINTS[1];
    this.twa = q.twa;
    const wm = this.water(this.gust?.mean ?? 0), wg = this.water(this.gust?.gust ?? 0);
    this.twdW = wm.from;
    this.hdg = rq ? ((rq.hdg % 360) + 360) % 360 : ((this.twdW + (this.tack === "port" ? q.twa : -q.twa)) % 360 + 360) % 360;
    this.yaw = ((90 - this.hdg) * Math.PI) / 180;
    // Trim to the apparent angle at the mean wind: boom about half the apparent angle off the centreline.
    const tws = wm.ms * KT, bsp = boatSpeed(this.boatKey, tws, q.twa);
    const aw = apparent(this.twdW, tws, this.hdg, bsp), sheet = Math.min(1.35, Math.max(0.18, (Math.abs(aw.awa) * Math.PI) / 180 * 0.5));
    // Sails: the auto plan reefs for the gust (apparent wind in the gust, at the sails' height);
    // a chosen plan is sailed as set, faster or slower than the auto one by its area.
    const gKt = wg.ms * KT, awG = apparent(this.twdW, gKt, this.hdg, bsp), k = this.boatKey;
    this.prof = { u: this.gust?.mean ?? 0, ...this.profile(this.gust?.mean ?? 0) };
    const hf = this.prof.f(5.5), moment = (p) => sailMoment(k, p, q.twa);
    const auto = autoPlan(k, q.twa, gKt, (awG.aws / KT) * hf, awG.awa, moment);
    const sel = $("ins-sails").value, plan = PLANS[k].find((p) => p.id === sel) || auto;
    const ref = auto.spinOnly ? PLANS[k][0] : auto;                                  // what the polars assume: no spinnaker
    this.plan = plan; this.autoId = auto.id; this.sheet = sheet;
    this.sailGeo = sailShapes(k, { plan, twa: q.twa, sheet });                   // for the flow round the sails
    this.sailAM = moment(plan);
    const shapes = sailShapes(k, { plan, twa: q.twa }), A = shapes.reduce((a, x) => a + x.area, 0);
    this.windF = this.prof.f(shapes.reduce((a, x) => a + x.area * x.ceZ, 0) / Math.max(1, A));   // the wind at the sails' height, of the 10 m wind
    this.sailF = Math.min(1.12, Math.max(0.55, Math.sqrt(A / sailArea(k, ref, q.twa))));
    this.waveF = 1 - waveLoss(k, this.waves, this.hdg);
    const wl = $("ins-seas-cost");
    if (wl) wl.textContent = this.waveF < 0.995 ? `waves cost ~${Math.round((1 - this.waveF) * 100)}% of boat speed on this heading` : "no speed lost to the waves on this heading";
    const key = `${k}|${sheet.toFixed(2)}|${plan.id}|${activeKey(plan, q.twa)}|${plan.spin ? Math.round(q.twa / 10) : ""}`;
    if (key !== this.boatBuilt) {
      if (this.boat) { this.scene.remove(this.boat); this.boat.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
      this.boat = new THREE.Group(); this.heel = buildBoat(k, { sheet, plan, twa: q.twa }); this.boat.add(this.heel); this.scene.add(this.boat);
      this.boatBuilt = key;
    }
    this.heel.scale.y = this.tack === "port" ? 1 : -1;                    // starboard tack: sails to port
    this.trimAwa = Math.abs(aw.awa);                                       // the sails are trimmed for this apparent angle
    this.makeTelltales();
    this.bsp ??= bsp;
    // Re-aim the camera only for a real change of course (a tack, a new point of sail or spot),
    // not when the forecast time moves on and the wind shifts a degree.
    if (this.chasedHdg == null || Math.abs(((this.hdg - this.chasedHdg + 540) % 360) - 180) > 8) { if (this.camMode !== "cockpit") this.camMode === "sails" ? this.sailView() : this.chase(); this.chasedHdg = this.hdg; }
    if (this.off) this.onMove?.(this.off, this.hdg);
    this.spotAim();
  }

  // Chase view: behind and above the boat, looking along its heading (the scenery ahead in frame).
  // Set on opening and on a new course; drag to look around.
  chase() {
    if (!this.controls) return;
    const r = (this.hdg * Math.PI) / 180, fx = Math.sin(r), fy = Math.cos(r), side = this.tack === "port" ? -1 : 1;
    this.camera.position.set(-fx * 42 + fy * 14 * side, -fy * 42 - fx * 14 * side, 15);
    this.controls.target.set(fx * 60, fy * 60, 3);
    this.controls.update();
  }

  // Sail view: from leeward, side-on to the apparent wind, looking at the middle of the rig (where
  // the flow round the sails shows best).
  sailView() {
    if (!this.controls) return;
    const b = BOATS[this.boatKey] || BOATS.cg31, r = (this.hdg * Math.PI) / 180, fx = Math.sin(r), fy = Math.cos(r);
    const lee = this.tack === "port" ? 1 : -1, lx = fy * lee, ly = -fx * lee;              // to leeward (starboard on port tack)
    const h = b.mastH * 0.45;
    // Side-on to the apparent wind from leeward, so the streaks cross the view and their bending shows.
    const aw = ((this.aw?.awa ?? 45) * Math.PI) / 180, from = r + aw;                  // the apparent wind's bearing (awa: + starboard)
    let nx = Math.cos(from), ny = -Math.sin(from);                                  // perpendicular to it …
    if (nx * lx + ny * ly < 0) { nx = -nx; ny = -ny; }                              // … on the leeward side
    this.camera.position.set(nx * b.lod * 2.3 - Math.sin(from) * b.lod * 0.4, ny * b.lod * 2.3 - Math.cos(from) * b.lod * 0.4, h + 1);
    this.controls.target.set(fx * b.lod * 0.15, fy * b.lod * 0.15, h);
    this.controls.update();
  }

  // Cockpit view: at the helm on the windward side (port side in the boat's port-tack frame, which
  // the mirror turns to starboard on starboard tack), seated eye height; the camera is carried by
  // the boat, so the horizon heels, rolls, pitches, yaws and heaves as it would. And the motion readout.
  cockpit() {
    if (!this.heel) return;
    const b = BOATS[this.boatKey] || BOATS.cg31, V3 = THREE.Vector3;
    this.heel.updateMatrixWorld(true);
    // (Up at the sails: from the leeward corner of the cockpit, where you'd check the headsail telltales.)
    // (At the headsails: from the leeward rail just aft of the mast, clear of the boom, looking forward
    // and up at their luffs.)
    const mode = $("ins-look").value, eye = mode === "heads" ? new V3(b.lod / 2 - b.mastAt * b.lod - 0.5, -b.beam * 0.47, b.fb[1] + 1.0)
      : new V3(-b.lod * (mode === "sails" ? 0.42 : 0.32), b.beam * (mode === "sails" ? -0.36 : 0.32), b.fb[2] + (mode === "sails" ? 1.0 : 1.35));
    const look = { ahead: [30, 0, -1.5], lee: [4, -30, -1], wind: [4, 30, -2], astern: [-30, 0, -1] }[mode] || [30, 0, -1.5];
    // Up at the sails: aimed at the middle of the sail plan (area-weighted), with a wide lens so the
    // whole rig is in frame.
    let T;
    if ((mode === "sails" || mode === "heads") && this.sailGeo?.length) {
      let A = 0; const c = new V3();
      for (const sl of this.sailGeo.filter((x) => mode === "sails" || (x.name !== "main" && x.name !== "trysail"))) for (const [a, bb, cc] of sl.tris) { const ar = new V3(...bb).sub(new V3(...a)).cross(new V3(...cc).sub(new V3(...a))).length() / 2; c.addScaledVector(new V3((a[0] + bb[0] + cc[0]) / 3, (a[1] + bb[1] + cc[1]) / 3, (a[2] + bb[2] + cc[2]) / 3), ar); A += ar; }
      c.divideScalar(A || 1); c.z += 1.2;
      T = this.heel.localToWorld(c);
    } else T = this.heel.localToWorld(eye.clone().add(new V3(...look)));
    const fov = mode === "sails" ? 95 : mode === "heads" ? 70 : 45;
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const E = this.heel.localToWorld(eye.clone());
    this.camera.up.copy(new V3(0, 0, 1).transformDirection(this.heel.matrixWorld));
    this.camera.position.copy(E); this.camera.lookAt(T);
    this.controls.target.copy(T);
    const m = this.mo || {}, d = (x) => (x * 180) / Math.PI, heel = d(this.heelRad || 0), roll = d(m.r || 0);
    if (!this.lastMotion || performance.now() - this.lastMotion > 150) {
      this.lastMotion = performance.now();
      const port = this.tack === "port", tot = (port ? heel : -heel) + roll;
      $("ins-motion").innerHTML = `<b>Motion</b><table>`
        + `<tr><td>Heel (sails)</td><td>${Math.abs(heel).toFixed(0)}° to ${port ? "stbd" : "port"}</td></tr>`
        + `<tr><td>Roll (waves)</td><td>${roll >= 0 ? "+" : "−"}${Math.abs(roll).toFixed(1)}°</td></tr>`
        + `<tr><td>Total</td><td>${Math.abs(tot).toFixed(0)}° to ${tot >= 0 ? "stbd" : "port"}</td></tr>`
        + `<tr><td>Pitch</td><td>${Math.abs(d(m.p || 0)).toFixed(1)}° bow ${(m.p || 0) < 0 ? "up" : "down"}</td></tr>`
        + `<tr><td>Yaw</td><td>${d(m.y || 0) >= 0 ? "+" : "−"}${Math.abs(d(m.y || 0)).toFixed(1)}° off course</td></tr>`
        + `<tr><td>Heave</td><td>${(m.z || 0) >= 0 ? "+" : "−"}${Math.abs(m.z || 0).toFixed(2)} m</td></tr>`
        + `<tr><td>Vertical g</td><td>${(1 + (m.az || 0) / 9.80665).toFixed(2)} g</td></tr></table>`;
    }
  }

  // True wind (m/s) at scene point (x, y): the mean plus the puffs and lulls there.
  windAt(x, y) {
    const g = this.gust;
    if (!g) return 0;
    let v = g.mean;
    for (const q of this.puffs) {
      const cx = q.along * g.ux + q.across * g.uy, cy = q.along * g.uy - q.across * g.ux, dx = x - cx, dy = y - cy;
      const a = dx * g.ux + dy * g.uy, c = dx * g.uy - dy * g.ux;
      v += q.amp * Math.exp(-(a * a) / (q.L * q.L) - (c * c) / (q.W * q.W));
    }
    return Math.min(g.gust, Math.max(0, v));
  }

  // The wind at height z (m) as a fraction of the 10 m wind: the neutral log profile over the sea,
  // u(z) = u10 · ln(z/z0) / ln(10/z0), with the sea's roughness z0 from the Charnock relation
  // (z0 = 0.011 u*²/g, plus the smooth-flow term 0.11 ν/u* in light air), u* from u10 by the same
  // log law. Typical: 0.6-0.7 × u10 at 0.3 m, ~0.9 at 3 m, ~1.1 at 30 m. Neutral stability assumed.
  profile(u10) {
    let z0 = 2e-4;
    for (let k = 0; k < 6; k++) { const us = (0.4 * Math.max(0.3, u10)) / Math.log(10 / z0); z0 = (0.011 * us * us) / G + (0.11 * 1.5e-5) / us; }
    const L10 = Math.log(10 / z0);
    return { z0, f: (z) => Math.log(Math.max(z, z0 * 2) / z0) / L10 };
  }
  // Heights 0.3-30 m, log-uniform (as many streaks per metre near the water as the profile changes fastest).
  randomHeight() { return 0.3 * Math.pow(100, Math.random()); }
  setParticleCount() {
    this.nwp = Math.min(NWP_MAX, Math.max(100, +$("ins-wpd").value || 1200));
    if (this.wp) this.wp.geometry.setDrawRange(0, this.nwp * 2);
  }
  // Spray: n droplets from the bow (boat frame x forward), speed scale v (m/s), both sides or one.
  emitSpray(n, v, { up = 1, side = 1.0 } = {}) {
    if (!this.spray || !$("ins-spray").checked || !this.heel) return;
    const D = this.drops, b = BOATS[this.boatKey] || BOATS.cg31;
    for (let k = 0; k < n; k++) {
      let i = -1;
      for (let j = 0; j < SPRAY; j++) { const q = (this.dropNext = ((this.dropNext || 0) + 1) % SPRAY); if (!(D[7 * q + 6] > 0)) { i = q; break; } }
      if (i < 0) return;
      const sgn = Math.random() < 0.5 ? -1 : 1, at = b.lod * (0.34 + 0.12 * Math.random());
      const p = this.heel.localToWorld(new THREE.Vector3(at, sgn * b.beam * (0.18 + 0.14 * Math.random()), 0.25));   // at the hull's side near the bow
      const o = new THREE.Vector3(0.3 * Math.random() - 0.1, sgn * (0.5 + Math.random()) * side, (0.6 + Math.random()) * up).transformDirection(this.heel.matrixWorld);
      const sp = v * (0.4 + Math.random() * 0.9);
      D.set([p.x, p.y, p.z, o.x * sp, o.y * sp, Math.abs(o.z) * sp, 1.2 + Math.random() * 1.3], 7 * i);
    }
  }
  stepSpray(dt, sx, sy) {
    if (!this.spray) return;
    const D = this.drops, pos = this.spray.geometry.attributes.position.array, g = this.gust, w = g ? g.mean : 0;
    for (let i = 0; i < SPRAY; i++) {
      if (!(D[7 * i + 6] > 0)) { pos[3 * i + 2] = -999; continue; }
      // Gravity, and the air dragging the droplet toward the wind's speed (~0.4 s).
      D[7 * i + 3] += ((g ? g.ux * w : 0) - D[7 * i + 3]) * dt / 0.4; D[7 * i + 4] += ((g ? g.uy * w : 0) - D[7 * i + 4]) * dt / 0.4; D[7 * i + 5] -= 9.80665 * dt;
      D[7 * i] += D[7 * i + 3] * dt - sx; D[7 * i + 1] += D[7 * i + 4] * dt - sy; D[7 * i + 2] += D[7 * i + 5] * dt;
      D[7 * i + 6] -= dt;
      if (D[7 * i + 2] < -0.3) D[7 * i + 6] = 0;
      pos[3 * i] = D[7 * i]; pos[3 * i + 1] = D[7 * i + 1]; pos[3 * i + 2] = D[7 * i + 2];
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
  }

  // The flow round the sails (lifting-line theory): each sail of the plan set is cut into strips up
  // its luff; each strip carries a horseshoe vortex (bound along its quarter chord, trailing away
  // downwind from both ends) of circulation Γ = ½·V·c·CL, V the apparent wind at the strip's
  // height, c its chord, CL the lift for the apparent angle (sailplan.sailCoefs). The streaks near
  // the boat take the velocity those vortices induce (Biot–Savart, with a 0.3 m core). Off the wind
  // the lift falls and the flow separates: a slow, churning wake downwind of each sail.
  buildVortices() {
    this.vort = null;
    if (!$("ins-sflow").checked || !this.heel || !this.sailGeo || !this.aw) return;
    this.heel.updateMatrixWorld(true);
    const M = this.heel.matrixWorld, A = Math.min(180, Math.abs(this.aw.awa)), a = (A * Math.PI) / 180, aws = this.aw.aws / KT;
    const { cl, sep } = sailCoefs(A), prof = this.prof?.f || (() => 1);
    const f = new THREE.Vector3(-Math.cos(a), -Math.sin(a), 0).transformDirection(M);   // the apparent flow (port-tack frame: leeward −y)
    f.z = 0; f.normalize();
    const W = (p) => new THREE.Vector3(...p).applyMatrix4(M), segs = [], wakes = [], TR = 90, NS = 5;
    for (const sl of this.sailGeo) {
      if (!sl.luff) continue;
      const [t, h] = sl.luff, c = sl.clew, at = (e) => { const L = t.map((v, i) => v + (h[i] - v) * e), R = c.map((v, i) => v + (h[i] - v) * e); return [L, R]; };
      const k = sl.name === "spinnaker" ? 1.15 : 1;                                  // a spinnaker's deep camber: more lift
      for (let j = 0; j < NS; j++) {
        const [La, Ra] = at(j / NS), [Lb, Rb] = at((j + 1) / NS), [Lm, Rm] = at((j + 0.5) / NS);
        const q = (L, R) => W(L.map((v, i) => v + 0.25 * (R[i] - v))), Qa = q(La, Ra), Qb = q(Lb, Rb), Ta = W(Ra), Tb = W(Rb);   // quarter chord; leech
        const chord = Math.hypot(Rm[0] - Lm[0], Rm[1] - Lm[1], Rm[2] - Lm[2]), zm = (Qa.z + Qb.z) / 2;
        const G = 0.5 * aws * prof(Math.max(0.5, zm)) * chord * cl * k * (1 - 0.5 * sep);
        const Fa = Ta.clone().addScaledVector(f, TR), Fb = Tb.clone().addScaledVector(f, TR);      // trailing vortices shed from the leech
        segs.push([Fa, Ta, G], [Ta, Qa, G], [Qa, Qb, G], [Qb, Tb, G], [Tb, Fb, G]);
      }
      const [Lm, Rm] = at(0.4), cen = W(Lm.map((v, i) => (v + Rm[i]) / 2)), ch = Math.hypot(Rm[0] - Lm[0], Rm[1] - Lm[1]);
      wakes.push({ c: cen, chord: ch, z0: Math.min(W(t).z, W(c).z), z1: W(h).z });
    }
    // The sails as surfaces the air can't pass through (for the flow along them): each sail's
    // triangle in world coordinates, its normal pointing to leeward, and what's needed to test
    // whether a point lies over it.
    const surf = [];
    for (const sl of this.sailGeo) {
      if (!sl.luff) continue;
      const a = W(sl.luff[0]), e1 = W(sl.luff[1]).sub(a), e2 = W(sl.clew).sub(a);
      const nl = new THREE.Vector3(...sl.luff[1]).sub(new THREE.Vector3(...sl.luff[0])).cross(new THREE.Vector3(...sl.clew).sub(new THREE.Vector3(...sl.luff[0])));
      if (nl.y > 0) nl.negate();                                                     // local leeward is −y
      const n = nl.normalize().transformDirection(M);
      const d00 = e1.dot(e1), d01 = e1.dot(e2), d11 = e2.dot(e2);
      surf.push({ a, e1, e2, n, d00, d01, d11, den: d00 * d11 - d01 * d01 || 1, area: e1.clone().cross(e2).length() / 2 });
    }
    this.vort = { surf, segs: segs.filter(([A, B]) => A.distanceToSquared(B) > 1e-4).map(([A, B, G]) => [A.x, A.y, A.z, B.x, B.y, B.z, G]), f, sep, wakes, zTop: Math.max(...wakes.map((w) => w.z1), 5) };
    // Circulation sense: the flow must run faster on the leeward (convex) side of the sails.
    const s0 = this.sailGeo.find((x) => x.luff), [Lm, Rm] = [s0.luff[0].map((v, i) => v + (s0.luff[1][i] - v) * 0.4), s0.clew.map((v, i) => v + (s0.luff[1][i] - v) * 0.4)];
    const test = W([(Lm[0] + Rm[0]) / 2, (Lm[1] + Rm[1]) / 2 - 0.7, (Lm[2] + Rm[2]) / 2]), u = this.induced(test.x, test.y, test.z);
    if (u[0] * f.x + u[1] * f.y < 0) for (const q of this.vort.segs) q[6] = -q[6];
  }
  // Telltales: short ribbons on both sides of each headsail's luff (15% of the chord back, at a
  // quarter, half and three quarters of its height) and on the main's leech; red on the port side,
  // green on starboard. Built with the boat; moved by updateTelltales.
  makeTelltales() {
    if (!this.heel || this.ttFor === this.heel) { this.colourTelltales(); return; }
    this.ttFor = this.heel; this.tt = [];
    const V3 = THREE.Vector3, geo = new THREE.PlaneGeometry(0.7, 0.07); geo.translate(0.35, 0, 0);   // (about twice real size, so they read)
    for (const sl of this.sailGeo || []) {
      if (!sl.luff || sl.name === "spinnaker") continue;
      const t0 = new V3(...sl.luff[0]), h = new V3(...sl.luff[1]), c = new V3(...sl.clew);
      const n = h.clone().sub(t0).cross(c.clone().sub(t0)).normalize();
      if (n.y < 0) n.negate();                                                     // toward windward (+y in the port-tack frame)
      const leech = sl.name === "main" || sl.name === "trysail";
      if (!leech) for (const e of [0.35, 0.65]) {                                    // a headsail's leech telltales
        const L = t0.clone().lerp(h, e), R = c.clone().lerp(h, e), chord = R.clone().sub(L);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
        m.position.copy(L.clone().addScaledVector(chord, 0.97)); this.heel.add(m);
        this.tt.push({ m, dir: chord.clone().normalize(), n, side: 0, leech: true, ph: Math.random() * 10, f: 5 + Math.random() * 4 });
      }
      for (const e of leech ? [0.3, 0.55, 0.8] : [0.25, 0.5, 0.75]) {
        const L = t0.clone().lerp(h, e), R = c.clone().lerp(h, e), chord = R.clone().sub(L);
        const at = L.clone().addScaledVector(chord, leech ? 0.97 : 0.15), dir = chord.clone().normalize();
        for (const side of leech ? [0] : [1, -1]) {
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
          m.position.copy(at).addScaledVector(n, side * 0.04);
          this.heel.add(m);
          this.tt.push({ m, dir, n, side, leech, ph: Math.random() * 10, f: 5 + Math.random() * 4 });
        }
      }
    }
    this.colourTelltales();
  }
  colourTelltales() {
    // (local +y is port on port tack; the boat is mirrored on starboard tack)
    for (const q of this.tt || []) { const port = (q.side >= 0) === (this.tack === "port"); q.m.material.color.setHex(q.leech ? 0xff5a4e : port ? 0xe8322b : 0x1fb34a); }
  }
  // Each frame: streaming aft along the sail when the flow is attached; the windward ones lift and
  // flutter when the apparent wind comes forward of the trim (pinching, a header), the leeward ones
  // stall, curl and flutter when it goes aft (bearing away, a puff) or the sails stall off the wind;
  // the leech ones curl round to leeward when the main's leech stalls.
  updateTelltales(t) {
    if (!this.tt?.length || !this.aw) return;
    const A = Math.abs(this.aw.awa), dev = A - (this.trimAwa ?? A), sep = sailCoefs(A).sep;
    const lift = Math.min(1, Math.max(0, (-dev - 4) / 10)), stall = Math.min(1, Math.max(0, (dev - 6) / 10, (sep - 0.2) / 0.5));
    this.ttState = { lift, stall }; this.stallLee = stall;
    const V3 = THREE.Vector3, rad = Math.PI / 180, x = new V3(), y = new V3(), mtx = new THREE.Matrix4();
    for (const q of this.tt) {
      const up = q.n.clone().cross(q.dir); if (up.z < 0) up.negate();                // in the sail's plane, upward
      const fl = Math.sin(t * q.f + q.ph) + 0.5 * Math.sin(t * q.f * 2.3 + q.ph * 1.7);   // flutter
      let th = fl * 3 * rad, ph = 0;                                                   // streaming: a small wag
      if (q.leech) { th = stall * (-50 + 25 * fl) * rad; ph = stall * 70 * rad; }       // curled round to leeward
      else if (q.side > 0 && lift > 0) { th = lift * (65 + 30 * fl) * rad; ph = lift * 15 * fl * rad; }
      else if (q.side < 0 && stall > 0) { th = -stall * (115 + 45 * fl) * rad; ph = -stall * 25 * rad * (1 + 0.5 * fl); }
      x.copy(q.dir).multiplyScalar(Math.cos(th)).addScaledVector(up, Math.sin(th));
      x.multiplyScalar(Math.cos(ph)).addScaledVector(q.n, Math.sin(ph) * (q.leech ? -1 : q.side)).normalize();
      y.copy(q.n).cross(x).normalize();
      mtx.makeBasis(x, y, x.clone().cross(y));
      q.m.quaternion.setFromRotationMatrix(mtx);
    }
  }

  // Near a sail the air can't pass through it: within ~1 m of a sail's surface the velocity loses
  // its component across the sail (fully at the surface), so the flow runs along it (attached);
  // a streak that has reached the surface is held just off it on its own side. Where the flow has
  // separated (off the wind, or a stalled leeward side), the leeward flow slows and churns instead.
  // q = [x, y, z, vx, vy, vz], changed in place.
  sailSurface(q, stall) {
    const S = this.vort?.surf;
    if (!S) return;
    for (const f of S) {
      const px = q[0] - f.a.x, py = q[1] - f.a.y, pz = q[2] - f.a.z, d = px * f.n.x + py * f.n.y + pz * f.n.z;
      if (Math.abs(d) > 1.0) continue;
      const ex = px - d * f.n.x, ey = py - d * f.n.y, ez = pz - d * f.n.z;                  // projected onto the sail's plane
      const d20 = ex * f.e1.x + ey * f.e1.y + ez * f.e1.z, d21 = ex * f.e2.x + ey * f.e2.y + ez * f.e2.z;
      const v = (f.d11 * d20 - f.d01 * d21) / f.den, w = (f.d00 * d21 - f.d01 * d20) / f.den;
      if (v < -0.03 || w < -0.03 || v + w > 1.03) continue;                                 // not over this sail
      const k = 1 - Math.abs(d) / 1.0, vn = q[3] * f.n.x + q[4] * f.n.y + q[5] * f.n.z;
      q[3] -= vn * f.n.x * k; q[4] -= vn * f.n.y * k; q[5] -= vn * f.n.z * k;
      const side = d >= 0 ? 1 : -1;
      // Attached flow: faster along the leeward side, slower along the windward side (the lift).
      const g = side > 0 ? 1 + 0.25 * k * (1 - stall) : 1 - 0.12 * k;
      q[3] *= g; q[4] *= g; q[5] *= g;
      if (Math.abs(d) < 0.12) { const m = side * 0.12 - d; q[0] += m * f.n.x; q[1] += m * f.n.y; q[2] += m * f.n.z; }
      if (side > 0 && stall > 0.05) {                                                        // leeward and separated
        const sp = Math.hypot(q[3], q[4], q[5]), j = stall * k;
        q[3] *= 1 - 0.6 * j; q[4] *= 1 - 0.6 * j; q[5] *= 1 - 0.6 * j;
        q[3] += (Math.random() - 0.5) * sp * j; q[4] += (Math.random() - 0.5) * sp * j; q[5] += (Math.random() - 0.5) * sp * j * 0.8;
      }
    }
  }

  // Velocity (m/s) induced at (x, y, z) by the sails' vortices.
  induced(x, y, z) {
    let ux = 0, uy = 0, uz = 0;
    for (const [ax, ay, az, bx, by, bz, G] of this.vort.segs) {
      const r1x = x - ax, r1y = y - ay, r1z = z - az, r2x = x - bx, r2y = y - by, r2z = z - bz;
      const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x, c2 = cx * cx + cy * cy + cz * cz;
      const r0x = bx - ax, r0y = by - ay, r0z = bz - az, L2 = r0x * r0x + r0y * r0y + r0z * r0z;
      const d = c2 + 0.25 * L2;                                                        // 0.5 m core: no singularity on the line
      if (!(d > 1e-9)) continue;
      const n1 = Math.hypot(r1x, r1y, r1z) || 1e-6, n2 = Math.hypot(r2x, r2y, r2z) || 1e-6;
      const k = (G / (4 * Math.PI * d)) * (r0x * (r1x / n1 - r2x / n2) + r0y * (r1y / n1 - r2y / n2) + r0z * (r1z / n1 - r2z / n2));
      ux += k * cx; uy += k * cy; uz += k * cz;
    }
    return [ux, uy, uz];
  }

  // The streaks round the sails: released in a band just upwind of the rig (in the apparent wind,
  // across the sails' span and up to the masthead), carried by the wind plus the sails' induced
  // flow, re-released once they're well past. Colour: amber where the flow slows (to windward, in
  // a stalled lee), pale gold to white where it speeds up (to leeward, through the slot).
  stepSailFlow(dt) {
    const V = this.vort, on = !!V && this.wp?.visible;
    this.sf.visible = this.sfHead.visible = on;
    if (!on) { this.sfState.fill(0); return; }
    const g = this.gust, S = this.sfState, T = this.sfTrail, b = BOATS[this.boatKey] || BOATS.cg31, fx = V.f.x, fy = V.f.y, zTop = V.zTop + 1.5;
    const n = Math.min(NSF, Math.max(150, Math.round((this.nwp || 1200) * 0.3)));   // a third of the density setting
    this.sf.geometry.setDrawRange(0, n * (TRAIL - 1) * 2); this.sfHead.geometry.setDrawRange(0, n);
    const pos = this.sf.geometry.attributes.position.array, col = this.sf.geometry.attributes.color.array, head = this.sfHead.geometry.attributes.position.array;
    const prof = this.prof?.f || (() => 1), span = b.lod * 0.75;
    // Half the streaks start right at a sail's luff, just off the cloth on one side or the other
    // (a sail picked by area, at any height), so they run along it to the leech; the rest come in
    // from a band upwind of the rig.
    const surf = V.surf, sArea = surf.reduce((q, f) => q + f.area, 0);
    const release = (i, anywhere) => {
      if (i % 2 === 0 && surf.length) {
        let r = Math.random() * sArea, f = surf[0];
        for (const x of surf) { r -= x.area; if (r <= 0) { f = x; break; } }
        const e = 0.05 + 0.85 * Math.random(), L = f.a.clone().addScaledVector(f.e1, e), R = f.a.clone().add(f.e2).addScaledVector(f.e1.clone().sub(f.e2), e);
        const ch = R.sub(L).normalize(), side = Math.random() < 0.5 ? 1 : -1, off = 0.08 + 0.3 * Math.random();
        const P = L.addScaledVector(ch, -0.7).addScaledVector(f.n, side * off);
        S[4 * i] = P.x; S[4 * i + 1] = P.y; S[4 * i + 2] = P.z; S[4 * i + 3] = 1;
        for (let k = 0; k < TRAIL; k++) T.set([P.x, P.y, P.z], (i * TRAIL + k) * 3);
        return;
      }
      const back = anywhere ? -8 + Math.random() * 22 : 7 + Math.random() * 9, across = (Math.random() - 0.5) * 2 * span;
      S[4 * i] = -fx * back - fy * across; S[4 * i + 1] = -fy * back + fx * across; S[4 * i + 2] = 0.8 + Math.random() * zTop; S[4 * i + 3] = 1;
      for (let k = 0; k < TRAIL; k++) T.set([S[4 * i], S[4 * i + 1], S[4 * i + 2]], (i * TRAIL + k) * 3);
    };
    this.sfTick = (this.sfTick || 0) + dt;
    const push = this.sfTick >= 0.04;                                      // a trail point every ~0.04 s
    if (push) this.sfTick = 0;
    for (let i = 0; i < n; i++) {
      if (!(S[4 * i + 3] > 0)) { release(i, true); }
      let x = S[4 * i], y = S[4 * i + 1], z = S[4 * i + 2];
      const v = this.windAt(x, y) * prof(z), [ix, iy, iz] = this.induced(x, y, z);
      let vx = g.ux * v + ix, vy = g.uy * v + iy, vz = iz;
      if (V.sep > 0.05) for (const w of V.wakes) {
        const dx = x - w.c.x, dy = y - w.c.y, al = dx * fx + dy * fy, cr = Math.abs(dx * fy - dy * fx);
        if (al > 0 && al < 3.5 * w.chord && cr < 0.9 * w.chord && z > w.z0 - 0.5 && z < w.z1 + 0.5) {
          const k = V.sep * (1 - al / (3.5 * w.chord)), m = Math.hypot(vx, vy);
          vx *= 1 - 0.65 * k; vy *= 1 - 0.65 * k; vx += (Math.random() - 0.5) * m * k * 0.9; vy += (Math.random() - 0.5) * m * k * 0.9; vz += (Math.random() - 0.5) * m * k * 0.6;
        }
      }
      if (V) { const q = this.sq || (this.sq = new Float64Array(6)); q[0] = x; q[1] = y; q[2] = z; q[3] = vx; q[4] = vy; q[5] = vz; this.sailSurface(q, this.stallLee || 0); [x, y, z, vx, vy, vz] = q; }
      x += vx * dt; y += vy * dt; z = Math.max(0.2, z + vz * dt);
      const ra = x * fx + y * fy, rc = x * fy - y * fx;
      if (!Number.isFinite(x + y + z) || ra > 14 || Math.abs(rc) > span * 1.6 || z > zTop + 6) { release(i, false); x = S[4 * i]; y = S[4 * i + 1]; z = S[4 * i + 2]; vx = vy = vz = 0; }
      S[4 * i] = x; S[4 * i + 1] = y; S[4 * i + 2] = z;
      // The trail: the newest point follows the streak; older ones step back every ~0.04 s.
      const o = i * TRAIL * 3;
      if (push) T.copyWithin(o + 3, o, o + (TRAIL - 1) * 3);
      T[o] = x; T[o + 1] = y; T[o + 2] = z;
      const q = (vx * vx + vy * vy + vz * vz) / Math.max(0.25, g.mean * g.mean), k = Math.min(1, Math.max(0, (q - 0.75) / 0.7));
      const gg = 0.55 + 0.42 * k, bb = 0.12 + 0.7 * k * k;
      head[3 * i] = x; head[3 * i + 1] = y; head[3 * i + 2] = z;
      for (let m = 0; m < TRAIL - 1; m++) {
        const w = (i * (TRAIL - 1) + m) * 6, a = 1 - m / (TRAIL - 1), a2 = 1 - (m + 1) / (TRAIL - 1);
        pos.set([T[o + 3 * m], T[o + 3 * m + 1], T[o + 3 * m + 2], T[o + 3 * m + 3], T[o + 3 * m + 4], T[o + 3 * m + 5]], w);
        col.set([a, gg * a, bb * a, a2, gg * a2, bb * a2], w);                  // fading toward the tail
      }
    }
    this.sf.geometry.attributes.position.needsUpdate = true; this.sf.geometry.attributes.color.needsUpdate = true; this.sfHead.geometry.attributes.position.needsUpdate = true;
  }

  // Wind particles: streaks from 0.3 to 30 m, each moving downwind at the wind at its height there.
  stepParticles(dt) {
    const g = this.gust, P = this.wpState, n = this.nwp || 1200;
    if (!g || !this.wp?.visible) return;
    if (!this.prof || Math.abs(this.prof.u - g.mean) > 0.2) this.prof = { u: g.mean, ...this.profile(g.mean) };
    const pos = this.wp.geometry.attributes.position.array, col = this.wp.geometry.attributes.color.array, prof = this.prof.f;
    // Brightness by the wind's force: dynamic pressure ½ρV² against the mean wind's at 10 m, so a
    // puff 20% stronger glows ~44% brighter (the extra load on the sails); lulls fade.
    // With the flow round the sails on, the background streaks also take the sails' flow near the
    // boat; the streaks released at the rig are their own layer (stepSailFlow).
    this.buildVortices();
    const V = this.vort, fx = V?.f.x ?? 0, fy = V?.f.y ?? 0, zTop = V ? V.zTop + 3 : 0;
    this.stepSailFlow(dt);
    for (let i = 0; i < n; i++) {
      let x = P[4 * i], y = P[4 * i + 1], z = P[4 * i + 2];
      const v = this.windAt(x, y) * prof(z);
      let vx = g.ux * v, vy = g.uy * v, vz = 0;
      if (V && x * x + y * y < 2500 && z < zTop + 6) {
        const [ix, iy, iz] = this.induced(x, y, z);
        vx += ix; vy += iy; vz += iz;
        // Separated flow off the wind: slow and churning in each sail's lee.
        if (V.sep > 0.05) for (const w of V.wakes) {
          const dx = x - w.c.x, dy = y - w.c.y, al = dx * fx + dy * fy, cr = Math.abs(dx * fy - dy * fx);
          if (al > 0 && al < 3.5 * w.chord && cr < 0.9 * w.chord && z > w.z0 - 0.5 && z < w.z1 + 0.5) {
            const k = V.sep * (1 - al / (3.5 * w.chord)), m = Math.hypot(vx, vy);
            vx *= 1 - 0.65 * k; vy *= 1 - 0.65 * k;
            vx += (Math.random() - 0.5) * m * k * 0.9; vy += (Math.random() - 0.5) * m * k * 0.9; vz += (Math.random() - 0.5) * m * k * 0.6;
          }
        }
      }
      if (V) { const q = this.sq || (this.sq = new Float64Array(6)); q[0] = x; q[1] = y; q[2] = z; q[3] = vx; q[4] = vy; q[5] = vz; this.sailSurface(q, this.stallLee || 0); [x, y, z, vx, vy, vz] = q; }
      x += vx * dt; y += vy * dt; z = Math.max(0.2, z + vz * dt);
      if (!Number.isFinite(x + y + z)) { x = 0; y = 0; z = 1; P[4 * i + 3] = 0; vx = vy = vz = 0; }     // (never stuck: re-released)
      const along = x * g.ux + y * g.uy;
      if (along > SIZE * 0.55 || Math.abs(x) > SIZE * 0.6 || Math.abs(y) > SIZE * 0.6) {    // left the patch: back in upwind
        const across = (Math.random() - 0.5) * SIZE * 1.1, back = -SIZE * 0.5 - Math.random() * 20;
        x = back * g.ux + across * g.uy; y = back * g.uy - across * g.ux; z = this.randomHeight();
      }
      P[4 * i] = x; P[4 * i + 1] = y; P[4 * i + 2] = z;
      const L = 0.35;                                                          // streak: where it was 0.35 s ago (along its own velocity)
      pos[6 * i] = x - vx * L; pos[6 * i + 1] = y - vy * L; pos[6 * i + 2] = z - vz * L;
      pos[6 * i + 3] = x; pos[6 * i + 4] = y; pos[6 * i + 5] = z;
      const sp = Math.hypot(vx, vy, vz), q = (sp * sp) / Math.max(0.25, g.mean * g.mean), b = Math.min(1, 0.22 + 0.5 * q), warm = Math.min(1, Math.max(0, q - 1.1));
      {
        const dim = V ? 0.8 : 1;                                                // (dimmed a little with the sail-flow streaks on)
        col[6 * i] = col[6 * i + 3] = b * dim; col[6 * i + 1] = col[6 * i + 4] = b * (1 - 0.25 * warm) * dim; col[6 * i + 2] = col[6 * i + 5] = b * (1 - 0.55 * warm) * dim;
      }
    }
    this.wp.geometry.attributes.position.needsUpdate = true; this.wp.geometry.attributes.color.needsUpdate = true;
  }
  seedParticles() {
    const P = (this.wpState = new Float32Array(NWP_MAX * 4));
    for (let i = 0; i < NWP_MAX; i++) { P[4 * i] = (Math.random() - 0.5) * SIZE; P[4 * i + 1] = (Math.random() - 0.5) * SIZE; P[4 * i + 2] = this.randomHeight(); }
  }

  // The compass (north up): heading as the boat, true wind (blue) and apparent wind (orange)
  // arrows pointing where each blows from; ticks every 30°.
  drawCompass(awd) {
    const r = Math.PI / 180, pt = (d, rr) => [Math.sin(d * r) * rr, -Math.cos(d * r) * rr];
    const ticks = Array.from({ length: 12 }, (_, i) => { const [x1, y1] = pt(i * 30, 44), [x2, y2] = pt(i * 30, i % 3 ? 48 : 51); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }).join("");
    const lab = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([t, d]) => { const [x, y] = pt(d, 37); return `<text x="${x}" y="${y + 3.5}">${t}</text>`; }).join("");
    const arrow = (d, cls) => { const [x1, y1] = pt(d, 52), [x2, y2] = pt(d, 16), [la, lb] = [pt(d + 10, 24), pt(d - 10, 24)]; return `<g class="${cls}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><polyline points="${la[0]},${la[1]} ${x2},${y2} ${lb[0]},${lb[1]}"/></g>`; };
    const h = this.hdg, boat = [pt(h, 20), pt(h + 150, 12), pt(h + 180, 8), pt(h - 150, 12)].map((q) => q.join(",")).join(" ");
    $("ins-compass").innerHTML = `<circle r="54" class="rim"/><g class="ticks">${ticks}</g><g class="lab">${lab}</g>${arrow(this.twdW ?? this.twd, "tw")}${arrow(awd, "aw")}<polygon class="hdg" points="${boat}"/>`;
  }

  // Puffs and lulls for mean/gust (m/s) from fromDeg. Up to NP at once, recycled upwind as they
  // leave the patch downwind; amplitudes so the strongest puffs reach the model's gust.
  setGusts(w) {
    const NP = 8;
    if (!w || !(w.mean > 0.5)) { this.gust = null; this.puffs = []; return; }
    const gust = Number.isFinite(w.gust) && w.gust > w.mean ? w.gust : w.mean * 1.25;      // no gust field: a mild default
    const to = ((w.fromDeg + 180) * Math.PI) / 180;
    this.gust = { mean: w.mean, gust, excess: gust - w.mean, ux: Math.sin(to), uy: Math.cos(to) };
    this.puffs = Array.from({ length: NP }, () => this.spawnPuff(true));
  }
  spawnPuff(anywhere = false) {
    const g = this.gust, lull = Math.random() < 0.3, W = 22 + Math.random() * 45;
    const along = anywhere ? (Math.random() - 0.5) * SIZE * 1.4 : -SIZE * 0.7 - Math.random() * SIZE * 0.4, across = (Math.random() - 0.5) * SIZE * 1.2;
    return { along, across, W, L: W * (1.4 + Math.random() * 0.8),
             amp: lull ? -g.excess * (0.25 + 0.35 * Math.random()) : g.excess * (0.35 + 0.65 * Math.pow(Math.random(), 0.6)),
             speed: g.mean * (1.0 + 0.15 * Math.random()) };
  }
  stepGusts(dt) {
    const g = this.gust;
    if (!g) return null;
    let v = g.mean;
    for (let i = 0; i < this.puffs.length; i++) {
      const q = this.puffs[i];
      q.along += q.speed * dt;
      if (q.along > SIZE * 0.75 + q.L) { this.puffs[i] = this.spawnPuff(); continue; }
      v += q.amp * Math.exp(-(q.along * q.along) / (q.L * q.L) - (q.across * q.across) / (q.W * q.W));   // at the boat (0, 0)
    }
    return Math.min(g.gust, Math.max(0, v));                        // overlapping puffs don't exceed the model's gust
  }

  // The real terrain within R km of the spot at true scale: land from the map's ground heights and
  // mask, shaded by height; sea cells sit below the water. Drawn under the distance haze.
  buildLand(env) {
    if (!this.scene) return;
    if (this.land) { this.scene.remove(this.land); this.land.geometry.dispose(); this.land.material.dispose(); this.land = null; }
    if (!env?.heightM) return;
    const R = 30, N = 181, pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), idx = [], ext = env.photoExtent;
    let any = false;
    const ramp = [[0, [0.72, 0.68, 0.52]], [40, [0.42, 0.56, 0.34]], [600, [0.30, 0.44, 0.26]], [1500, [0.44, 0.40, 0.30]], [3000, [0.55, 0.52, 0.48]], [4200, [0.92, 0.93, 0.95]]];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const dx = -R + (2 * R * i) / (N - 1), dy = -R + (2 * R * j) / (N - 1), k = j * N + i;
      const land = env.isLand(env.x + dx, env.y + dy), h = land ? Math.max(1.5, env.heightM(env.x + dx, env.y + dy)) : -25;
      if (land) any = true;
      pos[3 * k] = dx * 1000; pos[3 * k + 1] = dy * 1000; pos[3 * k + 2] = h;
      let c = ramp[0][1];
      for (let r = 1; r < ramp.length; r++) if (h >= ramp[r - 1][0]) { const [h0, c0] = ramp[r - 1], [h1, c1] = ramp[r], f = Math.min(1, (h - h0) / (h1 - h0)); c = c0.map((v, q) => v + (c1[q] - v) * f); }
      col.set(c, 3 * k);
      if (ext) { uv[2 * k] = (env.x + dx - ext[0]) / (ext[2] - ext[0]); uv[2 * k + 1] = (env.y + dy - ext[1]) / (ext[3] - ext[1]); }   // into the region's satellite mosaic
    }
    if (!any) return;                                                  // open ocean: nothing to draw
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i; idx.push(a, a + 1, a + N + 1, a, a + N + 1, a + N); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3)); g.setIndex(idx);
    if (ext) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.land = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.land.scale.z = +$("ins-vex").value || 1;
    this.scene.add(this.land);
    // The satellite mosaic (loaded once per region, shared with the map), when there is one.
    if (ext && env.photo) env.photo().then((t) => { this.photoTex = t; this.landStyle(); }, () => {});
    this.landStyle();
  }

  // Land: satellite imagery (lit) or the height colours, per the "Satellite on land" toggle.
  landStyle() {
    const m = this.land?.material;
    if (!m) return;
    const sat = $("ins-sat").checked && !!this.photoTex && !!this.land.geometry.attributes.uv;
    m.map = sat ? this.photoTex : null; m.vertexColors = !sat; m.needsUpdate = true;
    $("ins-sat").closest("label").hidden = !this.land.geometry.attributes.uv;
  }

  setup(view) {
    const w = view.clientWidth || 464, h = Math.round(w * 0.68);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    view.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa9c3cf);
    this.scene.fog = new THREE.Fog(0xa9c3cf, 700, 42000);          // distance haze: the land fades toward the horizon
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 120000);
    this.off = new THREE.Vector2(); this.waveOff = new THREE.Vector2(); this.logM = 0;   // off: the boat's track (fast-forwarded); waveOff: real time
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-38, -48, 16);                   // close enough to feel the chop; drag to look around
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();
    const uniforms = { uT: { value: 0 }, uA: { value: new Array(N).fill(0) }, uK: { value: Array.from({ length: N }, () => new THREE.Vector2()) },
                       uW: { value: new Array(N).fill(0) }, uP: { value: new Array(N).fill(0) },
                       uPuff: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uPuffAmp: { value: new Array(8).fill(0) },
                       uDir: { value: new THREE.Vector2(0, 1) }, uOff: { value: new THREE.Vector2() },
                       uLdir: { value: new THREE.Vector3(-0.4, -0.3, 0.85) }, uSkyCol: { value: new THREE.Color(0.7, 0.8, 0.86) }, uBright: { value: 1 }, uGlint: { value: 0.5 },
                       uSpot: { value: 0 }, uSpotDir: { value: new THREE.Vector2(0, 1) },
                       uU10: { value: 0 }, uGustEx: { value: 0 }, uBft: { value: 1 }, uWake: { value: 1 }, uHead: { value: new THREE.Vector2(0, 1) }, uSpd: { value: 0 }, uSurf: { value: 0 },
                       uHull: { value: new THREE.Vector2(4.7, 1.45) }, uSlam: { value: new THREE.Vector4(0, 0, 99, 0) } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: `#define NW ${N}
        uniform float uT; uniform float uA[NW]; uniform vec2 uK[NW]; uniform float uW[NW]; uniform float uP[NW]; uniform vec2 uOff;
        varying vec3 vN; varying float vH; varying vec3 vPos;
        #include <fog_pars_vertex>
        void main() {
          vec3 p = position; float z = 0.0; vec2 d = vec2(0.0); vec2 sh = vec2(0.0);
          // Waves fade out at the patch's edge into the calm far sea (the ring beyond); sampled at the
          // boat's travelled offset, so it sails through them.
          float edge = 1.0 - smoothstep(76.0, 97.0, length(position.xy));
          for (int i = 0; i < NW; i++) {
            float ph = dot(uK[i], position.xy + uOff) - uW[i] * uT + uP[i];
            float kk = length(uK[i]);
            z += uA[i] * cos(ph);
            d += -uA[i] * uK[i] * sin(ph);                              // slope
            sh += -0.6 * uA[i] * (uK[i] / max(kk, 1e-4)) * sin(ph);     // sharpened crests (Gerstner-style)
          }
          z *= edge; d *= edge; sh *= edge;
          p.xy += sh; p.z = z;
          vN = normalize(vec3(-d.x, -d.y, 1.0)); vH = z; vPos = p;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fog: true,
      fragmentShader: `varying vec3 vN; varying float vH; varying vec3 vPos;
        uniform float uT; uniform vec4 uPuff[8]; uniform float uPuffAmp[8]; uniform vec2 uDir;
        uniform vec3 uLdir; uniform vec3 uSkyCol; uniform float uBright; uniform float uGlint;
        uniform float uSpot; uniform vec2 uSpotDir;
        uniform float uU10; uniform float uGustEx; uniform float uBft; uniform float uWake; uniform vec2 uHead; uniform float uSpd; uniform float uSurf;
        uniform vec2 uHull; uniform vec4 uSlam;
        #include <common>
        #include <fog_pars_fragment>
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main() {
          // Gusts: puffs (uPuffAmp > 0) ruffle and darken the water, lulls (< 0) smooth it.
          vec2 perp = vec2(uDir.y, -uDir.x); float ruf = 0.0, calm = 0.0;
          for (int i = 0; i < 8; i++) {
            vec2 d = vPos.xy - uPuff[i].xy; float a = dot(d, uDir), c = dot(d, perp);   // (puffs are placed relative to the boat)
            float f = exp(-(a * a) / (uPuff[i].z * uPuff[i].z) - (c * c) / (uPuff[i].w * uPuff[i].w));
            ruf += max(uPuffAmp[i], 0.0) * f; calm += max(-uPuffAmp[i], 0.0) * f;
          }
          // Ragged edges, streaked along the wind (a cat's paw isn't a smooth blob).
          vec2 pw = vec2(dot(vPos.xy, uDir) * 0.08, dot(vPos.xy, perp) * 0.22) - vec2(uT * 0.25, 0.0);
          float rag = vnoise(pw) * 0.65 + vnoise(pw * 2.7 + 3.1) * 0.35;
          ruf = clamp(ruf * smoothstep(0.15, 0.75, ruf + 0.55 * (rag - 0.5)) * 1.25, 0.0, 1.0); calm = clamp(calm, 0.0, 1.0);
          // The wind's ripples (capillary and short gravity wavelets, ~0.7-2.5 m, spread about the
          // wind and running at their own speed): they tilt the surface, so rough water reflects less
          // of the bright sky and scatters the sun into glitter. Strength: a light base from the mean
          // wind, much more in a puff, almost none in a lull.
          float R = (0.35 * clamp(uU10 / 12.0, 0.0, 1.0) + 1.1 * ruf) * (1.0 - 0.85 * calm);
          R *= 1.0 - smoothstep(90.0, 450.0, length(cameraPosition - vPos));        // (too fine to resolve far off: no speckle)
          vec2 slope = vec2(0.0);
          for (int j = 0; j < 6; j++) {
            float fj = float(j), ang = (fj - 2.5) * 0.28, kj = 2.6 + fj * 1.25;
            vec2 dj = vec2(uDir.x * cos(ang) - uDir.y * sin(ang), uDir.x * sin(ang) + uDir.y * cos(ang));
            slope += dj * sin(dot(dj, vPos.xy) * kj - uT * sqrt(9.81 * kj + 0.074 * kj * kj * kj) + fj * 1.7) * (0.9 - fj * 0.08);
          }
          slope += (vec2(vnoise(vPos.xy * 3.3 - uDir * uT * 1.6), vnoise(vPos.xy * 3.3 + 17.0 - uDir * uT * 1.6)) - 0.5) * 1.4;
          vec3 N = normalize(vN + vec3(slope * 0.085 * R, 0.0));
          // Lit by the sun (or the moon at night, uLdir), reflecting the sky's colour near the horizon.
          vec3 V = normalize(cameraPosition - vPos), L = normalize(uLdir);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 deep = vec3(0.04, 0.20, 0.28) * uBright, sky = uSkyCol;
          float diff = max(dot(N, L), 0.0);
          vec3 c = mix(deep * (0.55 + 0.6 * diff), sky, (0.15 + 0.7 * fres) * (1.0 - 0.35 * ruf));
          float spec = pow(max(dot(reflect(-L, N), V), 0.0), 60.0 - 30.0 * ruf);
          float foam = smoothstep(0.35, 0.6, 1.0 - vN.z) * 0.6 * (0.15 + 0.85 * uBright);   // steep faces whiten
          c += spec * uGlint * (1.0 - 0.3 * ruf) * (1.0 + 0.5 * calm) + foam;
          vec3 white = vec3(0.93, 0.96, 0.97) * (0.12 + 0.88 * uBright);
          vec2 perpW = vec2(uDir.y, -uDir.x);
          if (uBft > 0.0) {
            // Whitecaps: patches on the crests covering the share Monahan's relation gives for the
            // wind here (puffs included), drifting with the waves and forming and fading.
            float U = uU10 + ruf * uGustEx, W = clamp(3.84e-6 * pow(U, 3.41), 0.0, 0.35);
            // (in wave-aligned coordinates: whitecaps run along the crests, across the wind)
            vec2 q = vPos.xy - uDir * uT * 3.0, qa = vec2(dot(q, uDir) * 0.75, dot(q, vec2(uDir.y, -uDir.x)) * 0.3);
            float n = 0.55 * vnoise(qa * 1.1 + uT * 0.07) + 0.3 * vnoise(qa * 3.0 - uT * 0.13) + 0.15 * vnoise(q * 3.1);
            float crest = smoothstep(-0.05, 0.35, vH) * (0.6 + 0.4 * smoothstep(0.05, 0.3, 1.0 - vN.z));
            // (n is about normal, mean 0.5, spread ~0.12: the threshold for a share W of the sea.)
            float z = 0.9 * sqrt(-2.0 * log(max(W, 1e-5))) - 0.5, tau = 0.55 + 0.12 * z;
            float cap = 0.92 * smoothstep(tau - 0.015, tau + 0.06, n + 0.1 * crest);
            // Foam blown in streaks along the wind (Force 7 and up) and spindrift haze (Force 8 and up).
            float along = dot(vPos.xy, uDir), across = dot(vPos.xy, perpW);
            float st = vnoise(vec2(along * 0.045 - uT * 0.12, across * 1.1)) * vnoise(vec2(along * 0.1, across * 2.3 + 7.0));
            float streak = smoothstep(0.34 - 0.12 * clamp((U - 14.0) / 10.0, 0.0, 1.0), 0.5, st) * clamp((U - 13.5) / 8.0, 0.0, 0.8);
            c = mix(c, white * 1.05, clamp(cap + streak * 0.7, 0.0, 1.0));
            c = mix(c, white * 0.9, 0.18 * clamp((U - 17.0) / 10.0, 0.0, 1.0) * vnoise(q * 0.05 + uT * 0.2));
          }
          if (uWake > 0.0) {
            // The boat's marks: a bow wave along the forward hull, the wake behind (turbulent strip and
            // the Kelvin wedge's arms at ~19.5°), growing with speed and surfing; a slam's foam.
            vec2 hp = vPos.xy; float fa = dot(hp, uHead), fc = dot(hp, vec2(uHead.y, -uHead.x));
            float sp = clamp((uSpd - 1.0) / 3.0, 0.0, 1.0) + uSurf, nz = vnoise(hp * 1.3 - uHead * uT * uSpd * 1.3);
            float e = length(vec2(fa / uHull.x, fc / uHull.y));
            float bow = smoothstep(1.35, 1.02, e) * smoothstep(0.95, 1.02, e) * smoothstep(-0.2, 0.6, fa / uHull.x);
            float a = -fa - uHull.x, wakeC = a > 0.0 ? exp(-a / (12.0 + 25.0 * sp)) * smoothstep(uHull.y * 0.9 + a * 0.06, 0.0, abs(fc)) : 0.0;
            float arm = a > 0.0 ? exp(-a / (30.0 + 40.0 * sp)) * smoothstep(0.6 + a * 0.03, 0.0, abs(abs(fc) - a * 0.354)) : 0.0;
            float wk = sp * (0.9 * bow + 0.75 * wakeC + 0.35 * arm) * (0.45 + 0.55 * nz);
            float sa = uSlam.z, sl = sa < 4.0 ? uSlam.w * exp(-sa / 1.4) * smoothstep(1.0 + sa * 3.0, 0.0, length(hp - uSlam.xy)) * (0.5 + 0.5 * vnoise(hp * 2.0 + sa)) : 0.0;
            c = mix(c, white, clamp(wk + sl, 0.0, 0.95));
          }
          // Night lights (optional): a searchlight from the bow onto the water ahead, and the deck
          // floodlight's pool round the boat; lit by the wave slope, so the surface's shape shows.
          if (uSpot > 0.0) {
            vec2 q = vPos.xy - uSpotDir * 4.0; float dq = length(q);
            float cone = 1.6 * smoothstep(0.9, 0.975, dot(q / max(dq, 1e-3), uSpotDir)) / (1.0 + pow(dq / 70.0, 2.0));
            float pool = exp(-dot(vPos.xy, vPos.xy) / (14.0 * 14.0)) * 0.45;
            vec3 Ls = normalize(vec3(-q, 9.0)); float ds = max(dot(vN, Ls), 0.0), ss = pow(max(dot(reflect(-Ls, vN), V), 0.0), 40.0);
            vec3 lamp = vec3(1.0, 0.95, 0.85) * uSpot * (cone + pool);
            c += lamp * (0.5 * ds + 1.2 * ss + 0.6 * foam) + lamp * vec3(0.05, 0.13, 0.16);
          }
          // Cat's paws read darker (the ripples show the deep water, not the sky); lulls glassier.
          c = mix(c, c * 0.8, 0.45 * ruf);
          c = mix(c, c * 1.05 + 0.015, 0.5 * calm);
          gl_FragColor = vec4(c, 1.0);
          #include <fog_fragment>
        }`,
    });
    Object.assign(this.mat.uniforms, uniforms);                     // ours on top of the fog uniforms
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE, 200, 200), this.mat);
    this.scene.add(sea);
    // The sea beyond the patch, to the horizon: the same shading, no waves.
    const far = new THREE.Mesh(new THREE.RingGeometry(96, 60000, 96, 12), this.mat);
    this.scene.add(far);
    // Wind particles: short white streaks (positions filled each frame).
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NWP_MAX * 6), 3));
    wg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NWP_MAX * 6).fill(1), 3));
    this.wp = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }));
    this.wp.frustumCulled = false; this.wp.visible = $("ins-wp").checked;
    this.scene.add(this.wp);
    this.seedParticles();
    this.setParticleCount();
    // The streaks round the sails (with Flow round the sails on): their own layer, drawn solid in a
    // warm colour with a bright head, so they stand out from the background wind.
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NSF * (TRAIL - 1) * 6), 3));
    fg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NSF * (TRAIL - 1) * 6), 3));
    this.sf = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NSF * 3), 3));
    this.sfHead = new THREE.Points(hg, new THREE.PointsMaterial({ color: 0xffe08a, size: 0.14, transparent: true, opacity: 0.95, depthWrite: false }));   // (round heads: map set once the dot texture exists)
    for (const o of [this.sf, this.sfHead]) { o.frustumCulled = false; o.visible = false; this.scene.add(o); }
    this.sfState = new Float32Array(NSF * 4);
    this.sfTrail = new Float32Array(NSF * TRAIL * 3);                 // each streak's last positions (newest first)

    // Spray: droplets thrown from the bow (slams, surfing), falling and blowing downwind.
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPRAY * 3).fill(-999), 3));
    const dot = document.createElement("canvas"); dot.width = dot.height = 32;
    { const g = dot.getContext("2d"), r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.5, "rgba(255,255,255,.8)"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, 32, 32); }
    this.dotTex = new THREE.CanvasTexture(dot);
    this.spray = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xf2f7f8, size: 0.2, map: this.dotTex, transparent: true, opacity: 0.9, depthWrite: false }));
    this.spray.frustumCulled = false; this.scene.add(this.spray);
    this.drops = new Float32Array(SPRAY * 7);                         // x y z vx vy vz life
    this.sfHead.material.map = this.dotTex; this.sfHead.material.size = 0.2; this.sfHead.material.needsUpdate = true;
    // Light for the boat (the sea shades itself).
    this.hemi = new THREE.HemisphereLight(0xeef4f8, 0x2a3a40, 1.4); this.scene.add(this.hemi);
    this.deckLight = new THREE.PointLight(0xfff1dc, 0, 40, 1.5); this.deckLight.position.set(0, 0, 7); this.scene.add(this.deckLight);
    // Rain: streaks in a box round the camera (stepRain), as many as the rate calls for.
    { const n = 5000, g = new THREE.BufferGeometry(), pos = new Float32Array(n * 6);
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd2dce2, transparent: true, opacity: 0.38, depthWrite: false }));
      this.rain.frustumCulled = false; this.rain.visible = false; this.rain.renderOrder = 5; this.scene.add(this.rain);
      this.rainP = Float32Array.from({ length: n * 3 }, (_, k) => (Math.random() - 0.5) * (k % 3 === 2 ? 40 : 70)); }
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6); this.sun.position.set(-40, -30, 60); this.scene.add(this.sun);
    // The sky: a dome following the camera, coloured by the sun's height (day, twilight, night),
    // with the sun's glow, stars at night and the moon at its place and phase (setSky).
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: new THREE.Vector3(0, 0, 1) }, uMoon: { value: new THREE.Vector3(0, 0, -1) }, uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uHorSun: { value: new THREE.Color() },
                  uGlow: { value: new THREE.Color() }, uStars: { value: 0 }, uMoonA: { value: 0 }, uSunA: { value: 1 },
                  uCloud: { value: 0 }, uCloudCol: { value: new THREE.Color(0.8, 0.82, 0.85) }, uCT: { value: 0 }, uDrift: { value: new THREE.Vector2() },
                  uFogCol: { value: new THREE.Color() }, uFogMix: { value: 0 }, uFlash: { value: 0 } },
      vertexShader: `varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vD; uniform vec3 uSun, uMoon, uZen, uHor, uHorSun, uGlow, uCloudCol, uFogCol; uniform float uStars, uMoonA, uSunA, uCloud, uCT, uFogMix, uFlash; uniform vec2 uDrift;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float h2(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
        void main() {
          vec3 d = normalize(vD); float h = max(d.z, 0.0);
          // The horizon warmer toward the sun (sunset and sunrise), cooler opposite.
          float toSun = length(d.xy) > 1e-3 && length(uSun.xy) > 1e-3 ? dot(normalize(d.xy), normalize(uSun.xy)) : 0.0;
          vec3 hor = mix(uHor, uHorSun, pow((toSun + 1.0) / 2.0, 3.0));
          vec3 c = mix(hor, uZen, pow(h, 0.45));
          float s = max(dot(d, uSun), 0.0);
          c += uGlow * (pow(s, 6.0) * (1.0 - 0.6 * h) + 0.25 * pow(s, 64.0));        // glow round the sun, strongest low
          c += vec3(1.0, 0.95, 0.85) * uSunA * smoothstep(0.99985, 0.9999, s);         // the sun's disc
          vec3 g = floor(d * 380.0); float st = hash(g);
          c += vec3(0.85, 0.88, 1.0) * uStars * step(0.9975, st) * (0.4 + 0.6 * hash(g + 1.7)) * smoothstep(0.0, 0.15, d.z);
          // The moon, drawn ~4× its real size so it reads: its sunlit side from the sun's direction.
          float R = 0.0183, m = dot(d, uMoon);
          if (m > cos(R)) {
            vec3 o = (d - uMoon * m) / sin(R); float r2 = dot(o, o);
            vec3 n = o - uMoon * sqrt(max(0.0, 1.0 - r2));
            float lit = smoothstep(-0.04, 0.04, dot(n, uSun));
            vec3 mc = vec3(0.92, 0.92, 0.86) * (0.04 + 0.96 * lit) * (0.85 + 0.15 * hash(floor(o * 9.0)));
            c = mix(c, mc + c * 0.3, uMoonA * smoothstep(1.0, 0.9, r2));
          }
          // Cloud (the model's cover): a deck on a plane overhead, drifting with the wind; thin
          // cover as scattered cells, overcast as a full deck, shaded a little.
          if (uCloud > 0.01 && d.z > 0.0) {
            vec2 p = d.xy / (d.z + 0.08) * 1.6 + uDrift * uCT;
            float n = fbm(p), th = 1.0 - uCloud;
            float cov = max(smoothstep(th - 0.08, th + 0.22, n + 0.1 * uCloud), smoothstep(0.85, 1.0, uCloud));
            vec3 cc = uCloudCol * (0.78 + 0.3 * vn(p * 3.0 + 7.0)) * (1.0 - 0.18 * smoothstep(0.55, 0.9, n));
            c = mix(c, cc, cov * mix(0.55, 1.0, smoothstep(0.0, 0.15, d.z)));
          }
          if (d.z < 0.0) c = mix(hor, hor * 0.6, min(1.0, -d.z * 4.0));
          c = mix(c, uFogCol, uFogMix);                                     // (in fog the sky is the fog)
          c += vec3(0.85, 0.88, 1.0) * uFlash;                              // (lightning)
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(90000, 48, 24), this.skyMat);
    this.skyDome.renderOrder = -1; this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
    this.setSky(null);
  }

  // Light and sky for the time on screen at the spot: the sun's height sets day, twilight (sun
  // 0 to −6°: civil, to −12°: nautical, to −18°: astronomical) or night; the moon's place and
  // phase light the night. date null: a fixed mid-morning.
  setSky(date) {
    if (!this.skyMat) return;
    const at = this.at || { lat: 0, lon: 0 };
    const sp = date ? sunPosition(date, at.lat, at.lon) : { altitude: 0.7, azimuth: 2.2 }, mp = date ? moonPosition(date, at.lat, at.lon) : { altitude: -1, azimuth: 0 };
    const mi = date ? moonIllumination(date) : { fraction: 0, phase: 0 };
    const alt = (sp.altitude * 180) / Math.PI, ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const day = ss(-6, 7, alt), tw = ss(-14, -2, alt) * (1 - ss(2, 14, alt));              // daylight; twilight's colour, strongest near sunset
    const moonUp = ss(-1, 4, (mp.altitude * 180) / Math.PI), moonLight = moonUp * mi.fraction * (1 - day);
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    let zen = mix([0.01, 0.015, 0.035], [0.36, 0.56, 0.78], day), hor = mix([0.03, 0.04, 0.07], [0.70, 0.80, 0.86], day);
    zen = mix(zen, [0.13, 0.18, 0.34], tw * 0.8);
    let horSun = mix(hor, [0.95, 0.55, 0.30], tw * 0.85); hor = mix(hor, [0.42, 0.40, 0.55], tw * 0.6);    // toward the sun; opposite (the pinkish-blue band)
    zen = zen.map((v, i) => v + moonLight * [0.03, 0.05, 0.10][i]); hor = hor.map((v, i) => v + moonLight * [0.06, 0.08, 0.13][i]); horSun = horSun.map((v, i) => v + moonLight * [0.06, 0.08, 0.13][i]);
    const horAvg = hor.map((v, i) => (v * 3 + horSun[i]) / 4);
    const u = this.skyMat.uniforms, sv = toVec(sp), mv = toVec(mp);
    u.uSun.value.set(...sv); u.uMoon.value.set(...mv); u.uZen.value.setRGB(...zen); u.uHor.value.setRGB(...hor); u.uHorSun.value.setRGB(...horSun);
    u.uGlow.value.setRGB(...mix([0.0, 0.0, 0.0], [1.0, 0.55, 0.25], Math.max(tw, 0.35 * day) * ss(-10, 0, alt)));
    u.uStars.value = (1 - ss(-16, -5, alt)) * (1 - 0.6 * moonLight); u.uMoonA.value = ss(-1, 1, (mp.altitude * 180) / Math.PI) * (1 - 0.55 * day) * (mi.fraction > 0.02 ? 1 : 0); u.uSunA.value = ss(-1, 0.5, alt);
    this.scene.fog.color.setRGB(...horAvg); this.scene.background.setRGB(...horAvg);
    // Lights: the sun (warmer low down), the sky's fill, moonlight at night.
    const warm = ss(0, 20, alt);
    this.sun.position.set(sv[0] * 100, sv[1] * 100, Math.max(0.05, sv[2]) * 100); this.sun.intensity = 1.8 * ss(-1, 8, alt);
    this.sun.color.setRGB(1, 0.62 + 0.38 * warm, 0.4 + 0.6 * warm);
    this.hemi.intensity = 0.06 + 1.3 * day + 0.25 * tw + 0.35 * moonLight;
    this.hemi.color.setRGB(...zen.map((v) => Math.min(1, 0.5 + v)));
    const su = this.mat.uniforms, glintFromMoon = day < 0.2 && moonUp > 0;
    su.uLdir.value.set(...(glintFromMoon ? mv : sv)); su.uSkyCol.value.setRGB(...horAvg); su.uBright.value = 0.05 + 0.95 * day + 0.2 * tw + 0.25 * moonLight;
    su.uGlint.value = glintFromMoon ? 0.6 * mi.fraction : 0.5 * ss(-1, 5, alt);
    if (this.wp) this.wp.material.opacity = 0.15 + 0.45 * Math.max(day, 0.5 * tw, 0.6 * moonLight);
    // Weather (the model's, here): cloud greys the sky, dims the sun (and the glint), hides the
    // stars and the moon; fog closes the view in to the visibility (and is the sky in thick fog).
    { const W = this.wx, cover = W && Number.isFinite(W.tcc) ? Math.min(1, W.tcc / 100) : 0, low = W && Number.isFinite(W.lcc) ? Math.min(1, W.lcc / 100) : 0;
      const vis = W && Number.isFinite(W.vis) ? W.vis : 50000, lit = Math.max(day, 0.35 * tw);
      const cloud = mix(mix([0.045, 0.05, 0.06], [0.8, 0.82, 0.85].map((v) => v * (1 - 0.3 * low)), lit), [0.95, 0.6, 0.4], tw * 0.35 * (1 - low));
      u.uCloud.value = cover; u.uCloudCol.value.setRGB(...cloud);
      const g = this.gust, dk = 0.02 + 0.004 * (g?.mean || 3);
      u.uDrift.value.set(-(g?.ux || 0.7) * dk, -(g?.uy || 0.7) * dk);
      u.uStars.value *= 1 - cover; u.uMoonA.value *= 1 - 0.9 * cover;
      this.sun.intensity *= 1 - 0.8 * Math.pow(cover, 1.5); this.hemi.intensity *= 1 - 0.3 * cover;
      su.uGlint.value *= 1 - 0.85 * cover; su.uBright.value *= 1 - 0.25 * cover;
      const hz = mix(horAvg, cloud, 0.55 * cover), fogK = 1 - Math.min(1, Math.max(0, (vis - 800) / 8200));
      const fogCol = mix(hz, mix([0.05, 0.055, 0.065], [0.7, 0.73, 0.76], lit), 0.6);
      const fc = mix(hz, fogCol, fogK);
      this.scene.fog.color.setRGB(...fc); this.scene.background.setRGB(...fc); su.uSkyCol.value.setRGB(...mix(hz, fc, fogK));
      u.uFogCol.value.setRGB(...fc); u.uFogMix.value = Math.min(1, fogK * 1.1);
      if (vis < 25000) { this.scene.fog.far = Math.max(150, vis * 1.3); this.scene.fog.near = Math.min(700, this.scene.fog.far * 0.04); }
      else { this.scene.fog.near = 700; this.scene.fog.far = 42000; }
      this.rainRate = W ? ({ drizzle: 0.2, "light rain": 0.35, rain: 0.6, "heavy rain": 1, thunderstorm: 1 })[rainWord(W)] || 0 : 0;
      this.rainSlow = W && rainWord(W) === "drizzle";
      this.thunder = !!W && rainWord(W) === "thunderstorm"; }
    // Night lights: offered once it's dark (sun below ~−3°).
    this.skyDate = date;
    const dark = 1 - day, sel = $("ins-night"), mode = dark > 0.5 ? sel.value : "natural";
    sel.hidden = dark <= 0.5;
    if (mode === "bright") {                                              // like night vision: the sea and boat lifted, the sky left dark
      su.uBright.value = Math.max(su.uBright.value, 0.55); su.uSkyCol.value.lerp(new THREE.Color(0.32, 0.38, 0.44), 0.6);
      su.uGlint.value = Math.max(su.uGlint.value, 0.35); su.uLdir.value.set(-0.4, -0.3, 0.85);
      this.hemi.intensity = Math.max(this.hemi.intensity, 0.8);
      if (this.wp) this.wp.material.opacity = Math.max(this.wp.material.opacity, 0.45);
    }
    su.uSpot.value = mode === "spot" ? 1 : 0;
    this.deckLight.intensity = mode === "spot" ? 12 : 0;
    this.spotAim();
    this.hemiBase = this.hemi.intensity;                                // (lightning adds to it: stepRain)
    // The readout: local time, the sun and the moon.
    if (!date) { this.sky = null; return; }
    const loc = new Intl.DateTimeFormat("en-US", { timeZone: this.tz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
    const sunTxt = alt > 0 ? `sun ${Math.round(alt)}° up` : alt > -6 ? "civil twilight" : alt > -12 ? "nautical twilight" : alt > -18 ? "astronomical twilight" : "night";
    const mAlt = Math.round((mp.altitude * 180) / Math.PI);
    const utc = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
    this.sky = { time: `${loc} · ${utc}`, text: `${sunTxt} · moon ${Math.round(mi.fraction * 100)}% ${phaseName(mi.phase)}, ${mAlt > 0 ? `${mAlt}° up` : "below the horizon"}` };
    if (this.ctl() && document.activeElement !== $("ins-t")) this.timeLabel(+$("ins-t").value);   // (the sun and moon ride on the time line)
  }

  // The searchlight points along the heading.
  spotAim() { if (!this.mat) return; const r = ((this.hdg ?? 0) * Math.PI) / 180; this.mat.uniforms.uSpotDir.value.set(Math.sin(r), Math.cos(r)); }

  // Sea height and slope at (x, y) on the CPU, for the boat.
  surf(x, y, t) {
    let z = 0, dx = 0, dy = 0;
    const X = x + (this.waveOff?.x || 0), Y = y + (this.waveOff?.y || 0);        // the boat's travel through the waves (real time)
    for (const w of this.waves) { const ph = w.kx * X + w.ky * Y - w.w * t + w.ph; z += w.a * Math.cos(ph); dx -= w.a * w.kx * Math.sin(ph); dy -= w.a * w.ky * Math.sin(ph); }
    return { z, dx, dy };
  }

  // The boat on the waves: the water sampled at bow, stern and both sides (so waves shorter than
  // the hull mostly average out, as they do for a real boat), giving target heave, pitch and roll;
  // the boat follows them as damped oscillators with a cruising boat's natural periods (heave
  // ~2.4 s, pitch ~2.6 s, roll ~3.6 s; roll lightly damped), so it lags, overshoots a little and
  // rolls at its own rhythm (damped more when the sails are drawing). The sails' heel is added to
  // the roll; the waves' orbital flow yaws it a few degrees (steered back). No hull hydrodynamics
  // beyond that.
  moveBoat(t, dt) {
    const b = BOATS[this.boatKey] || BOATS.cg31, Lh = b.lod * 0.8, B = b.beam, r = ((this.hdg ?? 0) * Math.PI) / 180;
    const fx = Math.sin(r), fy = Math.cos(r), lx = -fy, ly = fx;             // forward, and left (port)
    const zb = this.surf(fx * Lh / 2, fy * Lh / 2, t).z, zs = this.surf(-fx * Lh / 2, -fy * Lh / 2, t).z;
    const zp = this.surf(lx * B / 2, ly * B / 2, t).z, zq = this.surf(-lx * B / 2, -ly * B / 2, t).z;
    const target = { z: (zb + zs + zp + zq) / 4, p: -Math.atan((zb - zs) / Lh), r: Math.atan((zp - zq) / B) };
    // Yaw: the waves' orbital flow pushes bow and stern sideways by different amounts (most in
    // quartering and following seas); the helm (or autopilot) steers back: a damped swing about
    // the course, period ~5 s, the target the difference of those sideways flows over the speed.
    const orb = (x, y) => { let u = 0, v = 0; const X = x + (this.waveOff?.x || 0), Y = y + (this.waveOff?.y || 0); for (const w of this.waves) { const k = Math.hypot(w.kx, w.ky) || 1, c = w.a * w.w * Math.cos(w.kx * X + w.ky * Y - w.w * t + w.ph); u += c * w.kx / k; v += c * w.ky / k; } return [u, v]; };
    const [ubx, uby] = orb(fx * Lh / 2, fy * Lh / 2), [usx, usy] = orb(-fx * Lh / 2, -fy * Lh / 2);
    const lat = (ubx - usx) * lx + (uby - usy) * ly, spd = (this.bspNow ?? this.bsp ?? 0) * 0.514444 + 1.5;
    target.y = Math.max(-0.15, Math.min(0.15, (4 * lat) / spd));                    // (gain set for a few degrees in moderate seas)
    const m = (this.mo ||= { z: target.z, vz: 0, p: target.p, vp: 0, r: target.r, vr: 0, y: 0, vy: 0, az: 0 });
    const vz0 = m.vz;
    const osc = (x, v, goal, T, zeta, h) => { const w = (2 * Math.PI) / T, a = w * w * (goal - x) - 2 * zeta * w * v; v += a * h; return [x + v * h, v]; };
    const n = Math.max(1, Math.ceil(dt / 0.02)), h = dt / n;
    // Roll damping: the hull's own (light), plus the sails' when they're drawing (a sail resists
    // being swung through the air; a boat under sail rolls far less than one motoring).
    const zr = 0.15 + 0.3 * Math.min(1, ((this.aw?.aws ?? 0) / KT) / 8) * (this.sailGeo ? 1 : 0);
    for (let i = 0; i < n; i++) {
      [m.z, m.vz] = osc(m.z, m.vz, target.z, 2.4, 0.35, h);
      [m.p, m.vp] = osc(m.p, m.vp, target.p, 2.6, 0.35, h);
      [m.r, m.vr] = osc(m.r, m.vr, target.r, 3.6, zr, h);
      [m.y, m.vy] = osc(m.y ?? 0, m.vy ?? 0, target.y, 5, 0.55, h);
    }
    if (dt > 0) m.az += (((m.vz - vz0) / dt) - m.az) * Math.min(1, dt / 0.25);          // vertical acceleration (smoothed)
    // For surfing: the water's slope along the hull (positive: bow lower, running downhill).
    this.slopeFwd = (zs - zb) / Lh;
    // Slamming: the forefoot (~0.25 m below the waterline near the bow) lifts clear of the water and
    // comes back down fast: re-entry faster than 0.093·√(g·L) (Ochi's threshold) is a slam. It
    // knocks the bow up and costs a little speed.
    const bowZ = m.z - Math.sin(m.p) * (Lh / 2), rel = bowZ - zb, fd = 0.25, vth = 0.093 * Math.sqrt(9.80665 * Lh);
    const vr = this.relPrev == null || !(dt > 0) ? 0 : (rel - this.relPrev) / dt;
    if (this.emerged && rel < fd && vr < -vth) {
      (this.slams ||= []).push(this.simT || 0); if (this.slams.length > 60) this.slams.shift();
      m.vp -= 0.1; this.bsp = Math.max(0, (this.bsp || 0) - 0.25);
      const sev = Math.min(3, -vr / vth);                                        // how hard: 1 at the threshold
      this.emitSpray(Math.round((120 + 180 * Math.random()) * sev), 4 + 3 * sev, { up: 1.8 });
      const bw = this.heel.localToWorld(new THREE.Vector3(b.lod * 0.4, 0, 0));
      this.mat.uniforms.uSlam.value.set(bw.x, bw.y, 0, Math.min(1, 0.45 * sev));
    }
    this.emerged = rel > fd; this.relPrev = rel;
    this.boat.position.set(0, 0, m.z);
    this.boat.rotation.set(0, 0, 0);
    this.heel.rotation.set(0, 0, 0);
    this.heel.rotateZ(this.yaw + (m.y || 0)); this.heel.rotateY(m.p);                   // heading plus the waves' yaw (world frame, + to port)
    this.heel.rotateX((this.tack === "port" ? this.heelRad : -this.heelRad) + m.r);   // heel to leeward (starboard on port tack) plus the waves' roll
  }

  // The animation: a frame each display refresh, or, while a movie records (this.manual), only
  // the frames the recorder asks for (frame(now) with its own clock).
  loop(now) {
    if (!this.running) return;
    if (!this.manual) this.frame(now);
    requestAnimationFrame((q) => this.loop(q));
  }
  // Rain falling round the camera (m/s: ~7 for rain, ~2.5 for drizzle), blown by the wind; and
  // lightning in thunderstorms (a flash or two every 4–15 s).
  stepRain(dt) {
    const R = this.rain, rate = this.rainRate || 0;
    if (!R) return;
    R.visible = rate > 0;
    if (rate > 0) {
      const n = this.rainP.length / 3, m = Math.round(n * rate), c = this.camera.position, g = this.gust, vs = this.rainSlow ? 2.5 : 7;
      const wx = (g?.ux || 0) * (g?.mean || 0) * 0.8, wy = (g?.uy || 0) * (g?.mean || 0) * 0.8, P = this.rainP, pos = R.geometry.attributes.position.array, L = this.rainSlow ? 0.05 : 0.035;
      const wrap = (v, c0, B) => c0 + ((((v - c0 + B / 2) % B) + B) % B) - B / 2;
      for (let i = 0; i < m; i++) {
        let x = P[3 * i] + wx * dt, y = P[3 * i + 1] + wy * dt, z = P[3 * i + 2] - vs * dt;
        x = wrap(x, c.x, 70); y = wrap(y, c.y, 70); z = wrap(z, Math.max(20, c.z), 40); if (z < 0) z += 40;
        P[3 * i] = x; P[3 * i + 1] = y; P[3 * i + 2] = z;
        pos.set([x, y, z, x - wx * L, y - wy * L, z + vs * L], 6 * i);
      }
      R.geometry.setDrawRange(0, m * 2); R.geometry.attributes.position.needsUpdate = true;
    }
    let flash = 0;
    if (this.thunder) {
      const now = performance.now();
      if (!this.nextFlash || now > this.nextFlash + 400) this.nextFlash = now + 4000 + Math.random() * 11000;
      const k = now - this.nextFlash;
      if (k > 0 && k < 400) flash = (k < 90 || (k > 180 && k < 260)) ? 1 : 0;
    }
    this.skyMat.uniforms.uFlash.value = flash * 0.55;
    if (this.hemiBase != null) this.hemi.intensity = this.hemiBase + flash * 2.2;
  }

  // Ease the waves, wind and current toward the newest conditions (replays: see open()). Each
  // wave train's phase is adjusted as its wavenumber and frequency change, so the sea at the boat
  // and now carries on where it was rather than jumping.
  blend(dt) {
    const f = 1 - Math.exp(-dt / 0.8), T = this.waveTarget;
    if (T) {
      const u = this.mat.uniforms, X = this.waveOff?.x || 0, Y = this.waveOff?.y || 0, t = u.uT.value;
      let far = 0;
      for (let i = 0; i < N; i++) {
        const a = this.waves[i], b = T[i], kx = a.kx + (b.kx - a.kx) * f, ky = a.ky + (b.ky - a.ky) * f, w = a.w + (b.w - a.w) * f;
        a.ph += (a.kx - kx) * X + (a.ky - ky) * Y + (w - a.w) * t;
        a.kx = kx; a.ky = ky; a.w = w; a.a += (b.a - a.a) * f;
        far = Math.max(far, Math.abs(b.a - a.a), Math.abs(b.w - a.w) * 0.1);
        u.uA.value[i] = a.a; u.uK.value[i].set(a.kx, a.ky); u.uW.value[i] = a.w; u.uP.value[i] = a.ph;
      }
      if (far < 1e-4) this.waveTarget = null;
    }
    const G = this.gustTarget, g = this.gust;
    if (G && g) {
      const gust = Number.isFinite(G.gust) && G.gust > G.mean ? G.gust : G.mean * 1.25, d = ((G.fromDeg - this.twd + 540) % 360) - 180;
      g.mean += (G.mean - g.mean) * f; g.excess += (gust - G.mean - g.excess) * f; g.gust = g.mean + g.excess;
      this.twd = (this.twd + d * f + 360) % 360;
      const to = ((this.twd + 180) * Math.PI) / 180; g.ux = Math.sin(to); g.uy = Math.cos(to);
      if (Math.abs(d) < 0.2 && Math.abs(G.mean - g.mean) < 0.02) this.gustTarget = null;
    }
    const C = this.curTarget, c = this.cur;
    if (C && c) {
      const u = c.u + (C.u - c.u) * f, v = c.v + (C.v - c.v) * f;
      this.cur = { ...C, u, v, kt: Math.hypot(u, v) * KT, set: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 };
      if (Math.hypot(C.u - u, C.v - v) < 0.005) this.curTarget = null;
    }
  }

  frame(now) {
    const t = (now - this.t0) / 1000, dt = Math.min(0.1, Math.max(0, t - (this.tPrev ?? t)));
    this.tPrev = t;
    this.mat.uniforms.uT.value = t;
    this.blend(dt);
    this.stepRain(dt);
    this.skyMat.uniforms.uCT.value = t;
    // Gusts: the wind at the boat now, the heel easing toward it (~1 s), puffs to the shader.
    const vNow = this.stepGusts(dt), u = this.mat.uniforms;
    this.stepParticles(dt);
    // (last frame's boat step: puffs and streaks shift back by it)
    const [sx, sy] = this.boatStep || [0, 0];
    if (sx || sy) {
      const g = this.gust;
      if (g) for (const q of this.puffs) { q.along -= sx * g.ux + sy * g.uy; q.across -= sx * g.uy - sy * g.ux; }
      if (this.wpState) for (let i = 0; i < NWP_MAX; i++) { this.wpState[4 * i] -= sx; this.wpState[4 * i + 1] -= sy; }
      if (this.sfState) for (let i = 0; i < NSF; i++) { this.sfState[4 * i] -= sx; this.sfState[4 * i + 1] -= sy; }
      if (this.sfTrail) for (let i = 0; i < NSF * TRAIL; i++) { this.sfTrail[3 * i] -= sx; this.sfTrail[3 * i + 1] -= sy; }
    }
    if (vNow != null) {
      const g = this.gust, ww = this.water(vNow), tws = ww.ms * KT, twdW = ww.from;
      const twaNow = Math.abs(((twdW - this.hdg + 540) % 360) - 180);
      // Boat speed eases toward the polar speed at the wind it's in (~6 s); apparent wind; heel
      // from the apparent wind, most close-hauled and least running, easing in over ~1 s.
      // Heel: the sails' moment in the wind at their height against the righting moment; past
      // ~25° the crew eases and feathers (the heel grows slowly) and the boat slows.
      const aw0 = apparent(twdW, tws, this.hdg, this.bsp);
      const heelEq = heelFor(this.boatKey, this.sailAM, (aw0.aws / KT) * (this.windF || 1), aw0.awa);
      const heelDeg = heelEq > 25 ? 25 + 0.35 * (heelEq - 25) : heelEq, over = heelEq > 25 ? Math.max(0.6, 1 - 0.015 * (heelEq - 25)) : 1;
      const R = this.replay, target = R ? (R.hold ? 0 : R.bsp || 0) : boatSpeed(this.boatKey, tws, twaNow) * (this.sailF || 1) * (this.waveF || 1) * over;
      this.bsp += (target - this.bsp) * (1 - Math.exp(-dt / 6));
      // Surfing: a wave's face pushes the boat on down it (gravity along the slope under the hull,
      // about half of it effective on a heavy hull), the surge dying away over ~3 s. Surfing when
      // it carries the boat past its hull speed.
      const Gs = 9.80665, hullKn = (POLARS[this.boatKey] || POLARS.cg31).hull;
      this.surge = (this.surge || 0) + (0.5 * Gs * Math.sin(Math.atan(this.slopeFwd || 0)) - (this.surge || 0) / 3) * dt;
      const bspNow = Math.max(0, this.bsp + this.surge / 0.514444);
      if (bspNow > hullKn * 1.05 && this.surge > 0.25) this.surfT = this.simT || 0;
      const surfing0 = (this.simT || 0) - (this.surfT ?? -99) < 1.5;
      this.bspMax = Math.max(this.bspMaxT != null && this.bspMaxT > (this.simT || 0) - 60 ? this.bspMax ?? 0 : 0, bspNow);   // best in the last minute
      if (bspNow >= this.bspMax) this.bspMaxT = this.simT || 0;
      // Making way: the boat's travel (m); the land slides back, and the puffs and streaks drift
      // relative to it (so the streaks show the apparent wind).
      // (Fast-forward: the track and the land run k× faster; the waves, puffs and streaks stay real time.)
      this.lee = leeway(this.boatKey, (this.heelRad * 180) / Math.PI, this.bsp);
      this.cog = (this.hdg + (this.tack === "port" ? this.lee : -this.lee) + 360) % 360;   // slipping to leeward
      // Over the ground: through the water along the course plus the current's set and drift.
      const r = (this.cog * Math.PI) / 180, vms = bspNow * 0.514444, kf = +$("ins-speed").value || 1;
      const gx = Math.sin(r) * vms + (this.cur?.u || 0), gy = Math.cos(r) * vms + (this.cur?.v || 0), bx = gx * dt, by = gy * dt;
      this.sog = Math.hypot(gx, gy) / 0.514444; this.cogG = ((Math.atan2(gx, gy) * 180) / Math.PI + 360) % 360;
      if (R) { this.off.set(R.offX, R.offY); this.logM = R.logM ?? this.logM; }       // (the route places the boat)
      else { this.off.x += bx * kf; this.off.y += by * kf; this.logM += vms * dt * kf; }
      this.waveOff.x += bx; this.waveOff.y += by;
      u.uOff.value.copy(this.waveOff);
      if (this.land) this.land.position.set(-this.off.x, -this.off.y, 0);
      this.boatStep = [bx, by];
      const aw = apparent(twdW, tws, this.hdg, bspNow); this.bspNow = bspNow;
      const heelTarget = (heelDeg * Math.PI) / 180;
      this.heelRad += (heelTarget - this.heelRad) * (1 - Math.exp(-dt / 1.1));
      this.aw = aw;
      this.simT = (this.simT || 0) + dt;
      if (!this.hist.length || this.simT - this.hist[this.hist.length - 1][0] >= 0.5) {
        this.hist.push([this.simT, tws, bspNow, aw.aws]);
        while (this.hist.length && this.simT - this.hist[0][0] > 305) this.hist.shift();
      }
      u.uDir.value.set(g.ux, g.uy);
      // Sea texture and the boat's marks.
      u.uU10.value = g.mean; u.uGustEx.value = g.excess; u.uBft.value = $("ins-bft").checked ? 1 : 0; u.uWake.value = $("ins-spray").checked ? 1 : 0;
      u.uHead.value.set(Math.sin(r), Math.cos(r)); u.uSpd.value = vms; u.uSurf.value = surfing0 ? 0.6 : 0;
      { const bb = BOATS[this.boatKey] || BOATS.cg31; u.uHull.value.set(bb.lod * 0.47, bb.beam * 0.5); }
      u.uSlam.value.z += dt; u.uSlam.value.x -= bx; u.uSlam.value.y -= by;
      if (surfing0 && Math.random() < dt * 25) this.emitSpray(2 + Math.floor(Math.random() * 5), 1.5 + this.surge * 2, { up: 0.5, side: 1.4 });
      for (let i = 0; i < 8; i++) {
        const q = this.puffs[i];
        if (!q) { u.uPuffAmp.value[i] = 0; continue; }
        u.uPuff.value[i].set(q.along * g.ux + q.across * g.uy, q.along * g.uy - q.across * g.ux, q.L, q.W);
        u.uPuffAmp.value[i] = q.amp / Math.max(0.5, g.excess);
      }
      if (!this.lastReadout || now - this.lastReadout > 180) {
        this.lastReadout = now;
        const el = $("ins-wind"), kt = (x) => Math.round(x * KT), side = (a) => `${Math.round(Math.abs(a))}° ${a < 0 ? "P" : "S"}`;
        el.hidden = false;
        el.innerHTML = `Wind now <b>${kt(vNow)} kt</b><br><span>mean ${kt(g.mean)} · gusts to ${kt(g.gust)}</span>`
          + (this.sky ? `<br><span>${this.sky.time}</span>` : "");
        el.classList.toggle("puff", vNow > g.mean + 0.35 * g.excess);
        const twaSigned = this.tack === "port" ? -twaNow : twaNow;
        // VMG over the ground toward (↑) or away from (↓) the wind.
        const vmg = this.sog * Math.cos((((this.cogG - twdW + 540) % 360) - 180) * Math.PI / 180);
        const surfing = (this.simT || 0) - (this.surfT ?? -99) < 1.5, slams = (this.slams || []).filter((q) => q > (this.simT || 0) - 300).length, slamNow = (this.simT || 0) - ((this.slams || []).at(-1) ?? -99) < 1.2;
        el.classList.toggle("slam", slamNow); el.classList.toggle("surf", surfing && !slamNow);
        if (slamNow || surfing) el.innerHTML += `<br><b class="ev">${slamNow ? "Slam!" : "Surfing"}</b>`;
        $("ins-inst").innerHTML = `<div><span>HDG</span><b>${deg3(this.hdg)}°</b></div><div class="${surfing ? "surfing" : ""}"><span title="Speed through the water (boat speed)">STW${surfing ? " · surfing" : ""}</span><b>${bspNow.toFixed(1)} kn</b></div>`
          + `<div class="tw"><span>TWS</span><b>${Math.round(tws)} kt</b></div><div class="tw"><span>TWD</span><b>${deg3(twdW)}°</b></div><div class="tw"><span>TWA</span><b>${side(twaSigned)}</b></div>`
          + `<div class="aw"><span>AWS</span><b>${Math.round(this.aw.aws)} kt</b></div><div class="aw"><span>AWA</span><b>${side(this.aw.awa)}</b></div><div><span>Heel</span><b>${Math.round((this.heelRad * 180) / Math.PI)}°</b></div>`
          + `<div><span title="Course over the ground (with the current)">COG</span><b>${deg3(this.cogG)}°</b></div><div><span title="Speed over the ground (with the current)">SOG</span><b>${this.sog.toFixed(1)} kn</b></div><div><span>Leeway</span><b>${this.lee.toFixed(1)}°</b></div>`
          + (() => {                                             // the tidal current and what it does to the boat
            if (!this.cur) return `<div class="cur"><span>Current</span><b>–</b></div><div class="cur"><span>Current effect</span><b>–</b></div>`;
            const kn = this.cur.kt, r = (this.cog * Math.PI) / 180, along = ((this.cur.u * Math.sin(r) + this.cur.v * Math.cos(r)) / 0.514444), set = ((this.cogG - this.cog + 540) % 360) - 180;
            return `<div class="cur"><span title="Tidal current: drift (kt) and set (the direction it flows toward)">Current</span><b>${kn < 0.1 ? "slack" : `${kn.toFixed(1)} kt → ${deg3(this.cur.set)}°`}</b></div>`
              + `<div class="cur ${along > 0.2 ? "fair" : along < -0.2 ? "foul" : ""}"><span title="Along the boat's course: + fair (SOG gains), − foul; and how far the current sets the track off the course through the water">Current effect</span><b>${along >= 0 ? "+" : "−"}${Math.abs(along).toFixed(1)} kn${Math.abs(set) >= 1 ? ` · set ${Math.round(Math.abs(set))}° ${set > 0 ? "stbd" : "port"}` : ""}</b></div>`;
          })()
          + `<div><span>VMG</span><b>${Math.abs(vmg).toFixed(1)} kn ${vmg >= 0 ? "↑" : "↓"}</b></div>`
          + `<div><span>Max STW 1 min</span><b>${this.bspMax.toFixed(1)} kn</b></div><div class="${slams ? "slams" : ""}"><span>Slams 5 min</span><b>${slams}</b></div>`
          + `<div class="log"><span>Log</span><b>${(this.logM / 1852).toFixed(2)} nm</b></div>`
          + (() => { const A = this.sailGeo ? this.sailGeo.reduce((q, x) => q + x.area, 0) : 0, F = sailForces(A, (this.aw.aws / KT) * (this.windF || 1), this.aw.awa);
              return `<div class="sails"><span>Sails${$("ins-sails").value === "auto" ? " (auto)" : this.plan.id === this.autoId ? "" : " (set by you)"} · ${Math.round(A)} m² · flow ${F.sep < 0.15 ? "attached" : F.sep < 0.6 ? "partly separated" : "separated"} · telltales ${!this.ttState ? "–" : this.ttState.stall > 0.3 ? "leeward stalling (head up or trim in)" : this.ttState.lift > 0.3 ? "windward lifting (bear away or ease)" : "streaming"} · drive ${Math.round(F.drive / 9.81)} kgf, heeling ${Math.round(F.side / 9.81)} kgf</span><b>${this.plan.short}</b></div>`; })();

        if (this.when) this.setSky(new Date(this.when.getTime() + ((this.simT || 0) - (this.simT0 || 0)) * 1000));   // the clock runs in real time from the time on screen
        this.drawCompass(this.aw.awd);
        this.drawHistory();
        this.onMove?.(this.off, this.hdg);                              // the map's boat and its trail
      }
    } else { $("ins-wind").hidden = true; $("ins-inst").innerHTML = ""; }
    this.moveBoat(t, dt);
    this.updateTelltales(t);
    if (this.camMode === "cockpit") this.cockpit();
    this.stepSpray(dt, ...(this.boatStep || [0, 0]));
    if (this.camMode !== "cockpit") this.controls.update();                  // (the cockpit camera rides the boat)
    this.skyDome?.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
