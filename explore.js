// The Explore panel: the main controls, built around one loaded volume per forecast hour.
//
//   Preset      a question and the settings that answer it (presets.js); edits → "Custom"
//   Run         newest run 0–18 h (default, like HRRR) or newest long run 0–48 h
//   Forecast    hour slider + play; hours load live and the next ones prefetch in the background
//   Height      one slider, above ground (terrain-following) or above sea level, shown as
//               ≈ mb · m · ft; interpolated between all the model's levels
//   Show        horizontal slice, cross-section, colour by … (particles, rotation/turbulence and
//               inversion are listed, disabled, until they're built)
//
// The detailed controls (model, column top, opacity, scene, land, water) sit under "More settings".
//
// Three distinct states, never collapsed (brief §6): capability absent, fetch failed, stale.

import { latestCycle, loadVolume, maxFhr, staleness, levelsTo, candidateCycles, fileUrl } from "./model/rrfs.js?v=20261002173952";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { outlinedLines } from "./layers/windglyphs.js?v=20261002173952";
import { exists } from "./model/fetch.js?v=20261002173952";
import { latestPackCycle, loadPack } from "./model/packs.js?v=20261002173952";
import { latestZarrCycle, loadZarrHour, runBase } from "./model/hrrrzarr.js?v=20261002173952";
import { HourStore, needsOf, levelsFor, fieldsOf, stdZ } from "./model/hourstore.js?v=20261002173952";
import { SubhStore, SurfaceFlow } from "./model/subh.js?v=20261002173952";
import { CapabilityAbsent, FetchFailed } from "./model/fetch.js?v=20261002173952";
import { Volume, BlendVolume, heightLabel } from "./model/volume.js?v=20261002173952";
import { EtaFlow, LevelFlow, BlendFlow } from "./model/flow.js?v=20261002173952";
import { SliceLayer, COLOUR_BY } from "./layers/slice.js?v=20261002173952";
import { CurtainLayer } from "./layers/curtain.js?v=20261002173952";
import { WindParticles, PARTICLE_COLOURS } from "./layers/particles.js?v=20261002173952";
import { InversionLayer, TII_RAMP, prewarmDetection } from "./layers/inversion.js?v=20261002173952";
import { detectColumn, tiiClass, riskFlag, pct75 } from "./model/twi.js?v=20261002173952";
import { latestSounding } from "./model/sounding.js?v=20261002173952";
import { TurbulenceLayer } from "./layers/turbulence.js?v=20261002173952";
import { CloudLayer, CLOUD_TOP_M } from "./layers/clouds.js?v=20261002173952";
import { FogLayer } from "./layers/fog.js?v=20261002173952";
import { WaveLayer, seaKey, shoreMask } from "./layers/waves.js?v=20261002173952";
import { FetchGrid, chopAt, DURATION } from "./model/waves.js?v=20261002173952";
import { SurfaceInspector } from "./inspector.js?v=20261002173952";
import { CurrentLayer, rampAt } from "./layers/currents.js?v=20261002173952";
import { CurrentFlow } from "./layers/curflow.js?v=20261002173952";
import { loadWeather } from "./route/weather.js?v=20261002173952";
import { Passage } from "./passage.js?v=20261002173952";
import { SscofsField, MixedField } from "./model/sscofs.js?v=20261002173952";
import { currentStations, loadCurrents, stationCurrent, stationSpeed, currentNear, chopOnCurrent } from "./model/currents.js?v=20261002173952";
import { shoreDistance, CurrentField } from "./route/env.js?v=20261002173952";
import { boatForRegion } from "./boats.js?v=20261002173952";
import { loadWaveHour, wavesAt, swellHs2At } from "./model/gfswave.js?v=20261002173952";
import { ZoneMap, loadCwf, periodAt, periodSummary, compass } from "./model/zones.js?v=20261002173952";
import { VisibilityLayer, VIS_CLASSES } from "./layers/visibility.js?v=20261002173952";

// Where the sea-state note reports the swell: the open-water end of each region.
const SWELL_REF = { "salish-sea": { name: "Neah Bay (buoy 46087)", lat: 48.494, lon: -124.728 }, hawaii: { name: "the ʻAlenuihāhā Channel", lat: 20.35, lon: -156.1 } };
import { SatelliteLayer, PRODUCTS as SAT_PRODUCTS } from "./layers/satellite.js?v=20261002173952";
import { RI_CLASSES } from "./layers/colormap.js?v=20261002173952";
import { WaterClip } from "./layers/waterclip.js?v=20261002173952";
import { RAMPS, legendBar, uwLegend } from "./layers/colormap.js?v=20261002173952";
import { ChannelFrame } from "./shell/geo.js?v=20261002173952";
import { PRESETS } from "./presets.js?v=20261002173952";
import { PresetInfo } from "./presetinfo.js?v=20261002173952";
import { reveal, selectTab } from "./tabs.js?v=20261002173952";
import { idleLoop } from "./idle.js?v=20261002173952";
import { loadTke } from "./model/tke.js?v=20261002173952";
import { LITE } from "./device.js?v=20261002173952";
import { Probe } from "./probe.js?v=20261002173952";
import { ChannelPanel } from "./channelpanel.js?v=20261002173952";
import { WindGlyphs } from "./layers/windglyphs.js?v=20261002173952";
import { fmtSpeed, fromKt, unitLabel } from "./units.js?v=20261002173952";

const KT_PER_MS = 1.943844;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const cycleKey = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
const parseCycle = (s) => (/^\d{10}$/.test(s) ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10))) : null);
const RUN_H = { short: 18, long: 48, partial: 18 };
const CACHE_HOURS = 8;                // built 3-D volumes kept (the larger objects; rebuilt from the kept fields in a fraction of a second)
// Downloaded fields (cropped to the region) are kept for every hour of the run within this
// budget, so a second pass through the forecast doesn't download anything again.
const STORE_BUDGET = () => (window.matchMedia("(max-width: 700px)").matches || (navigator.deviceMemory && navigator.deviceMemory <= 4) ? 120e6 : 400e6);
const UNAVAILABLE = { "hawaii:hrrr": "HRRR doesn't reach Hawaiʻi." };

// Height slider: fine near the ground, coarse aloft. s ∈ [0, 1000] → metres.
const H_MIN = 10;
const sToH = (s, top) => Math.round(H_MIN + (top - H_MIN) * (s / 1000) ** 2.4);
const hToS = (h, top) => Math.round(1000 * Math.max(0, (h - H_MIN) / (top - H_MIN)) ** (1 / 2.4));

export class ExplorePanel {
  constructor({ stage, status, groundKm, isWater, groundMeshes, currentView, goView, onChange }) {
    Object.assign(this, { stage, status, groundKm, isWater, groundMeshes, currentView, goView, onChange: onChange || (() => {}) });
    this.clip = new WaterClip();
    this.slice = new SliceLayer(this.clip);
    this.curtain = new CurtainLayer();
    this.particles = new WindParticles();
    this.inversion = new InversionLayer(this.clip);
    this.turb = new TurbulenceLayer(this.clip);
    this.clouds = new CloudLayer();
    this.fog = new FogLayer();
    this.visMap = new VisibilityLayer();
    // Per-hour work finishes in idle time: redraw the layer whenever an hour is in.
    this.clouds.onReady = () => { this.drawClouds(); this.stage.markDirty(); };
    this.fog.onReady = this.visMap.onReady = () => { this.drawFog(); this.stage.markDirty(); };
    this.waves = new WaveLayer();
    this.currents = new CurrentLayer();
    this.curFlow = new CurrentFlow();                                  // (particles and streamlines of the current)
    this.passage = new Passage(this);                                  // the Passage tab (stage is set above)
    this.inspector = new SurfaceInspector();
    // Where the inspector is looking: a pole and a boat label at the clicked point, while it's open.
    this.inspectMark = new THREE.Group();
    stage.scene.add(this.inspectMark);
    this.inspector.onClose = () => { this.inspectXY = null; this.markInspect(null); };
    this.inspector.onWantWx = () => { if (this.inspectXY && !this.inspector.el.hidden) { this.inspectKey = null; this.inspectPoint(...this.inspectXY); } };
    this.inspector.onMove = (off, hdg) => this.moveBoatMark(off, hdg);
    this.inspector.timeCtl = {
      get: () => (this.cycle ? { min: +$("fhr").min, max: +$("fhr").max, step: +$("fhr").step || 0.25, value: +$("fhr").value, cycle: this.cycle, tz: this.region?.tz, model: this.model?.short || this.modelName() } : null),
      set: (t) => { $("fhr").value = String(t); $("fhr").dispatchEvent(new Event("input")); },
      play: () => (this.playing ? this.stopPlay() : this.play()),
      playing: () => this.playing,
    };
    this.inspector.passCtl = this.passage.viewerCtl();
    this.sat = new SatelliteLayer();
    $("water-only").addEventListener("change", (e) => { this.custom(); this.clip.on = e.target.checked; this.updateParticles(); this.drawGlyphs(this.lastPath); this.stage.markDirty(); });
    stage.scene.add(this.slice.group, this.curtain.group, this.particles.group, this.inversion.group, this.turb.group, this.clouds.group, this.fog.group, this.visMap.group, this.sat.group, this.waves.group, this.currents.group, this.curFlow.group);
    $("show-sea").addEventListener("change", () => { this.custom(); this.seaKeyStr = null; this.redraw(); });
    $("sea-duration").addEventListener("change", (e) => { DURATION.value = +e.target.value; this.seaKeyStr = null; this.drawWaves(); });
    $("sea-mode").addEventListener("change", () => { this.seaKeyStr = null; this.drawWaves(); });
    const seaStyle = () => { this.waves.setStyle(this.seaStyle()); this.drawKeys2(); this.stage.markDirty(); };
    for (const id of ["sea-fill", "sea-crests", "sea-anim", "sea-arrows"]) $(id).addEventListener("change", seaStyle);
    this.seaFrames = new Map();                                        // (the sea worked out per forecast hour: drawWaves)
    $("cur-src").addEventListener("change", () => { this.curField = null; this.seaKeyStr = null; this.drawWaves(); this.drawCurrents?.(); this.inspectKey = null; this.stage.markDirty(); });
    stage.onFrame.push((now) => this.waves.tick(now));                // (the sea surface's animation)
    stage.onFrame.push((now) => {                                     // (the current's particles, placed and paced for the view)
      const dt = (now - (this.cfPrev ?? now)) / 1000; this.cfPrev = now;
      if (!this.curFlow.grid) return false;
      const c = stage.camera, tg = stage.controls.target, h = 2 * c.position.distanceTo(tg) * Math.tan((c.fov * Math.PI) / 360);
      const re = this.curFlow.setView(tg.x, tg.y, h * c.aspect, h);
      return this.curFlow.step(dt) || re;
    });
    { const prev = stage.on2D; stage.on2D = (on) => { prev?.(on); this.waves.setFlat(on); this.curFlow.setFlat(on); this.currents.setFlat(on); this.stage.markDirty(); }; this.waves.setFlat(!!stage.is2D); this.curFlow.setFlat(!!stage.is2D); this.currents.setFlat(!!stage.is2D); }
    $("sea-zone").addEventListener("change", () => this.drawZoneCompare());
    $("sea-bar").getContext("2d").drawImage(seaKey(256, 10), 0, 0);
    // Click (not drag) on the water with Sea state on: the surface inspector there.
    { const cv = stage.renderer.domElement; let down = null;
      cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
      cv.addEventListener("pointerup", (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 400;
        down = null;
        if (moved >= 6 || !quick || this.isPlaceAt?.(e)) return;           // a click on a place label pins its card instead
        if (performance.now() - (this.passage?.justDragged || 0) < 300) return;   // (the end of a waypoint drag, not a click)
        if (this.passage?.picking) { const p = this.waterPoint(e.clientX, e.clientY); if (p) this.passage.addWaypoint(p.x, p.y); return; }
        if ($("show-cur").checked && !$("cur-layer").hidden) {          // a current station: its graph
          const p = this.waterPoint(e.clientX, e.clientY), cam = this.stage.camera.position, r = p ? Math.max(0.8, 0.012 * Math.hypot(cam.x - p.x, cam.y - p.y, cam.z)) : 0;
          const st = p && this.currents.stationAt(p.x, p.y, r);
          if (st) { this.curGraphFor = st.id; this.drawCurGraph(); return; }
        }
        if ($("show-sea").checked) this.inspectAt(e.clientX, e.clientY);
      }); }
    $("show-fog").addEventListener("change", () => { this.custom(); this.fogKey = null; this.redraw(); });
    $("fog-mode").addEventListener("change", () => this.drawFog());
    $("vis-key").innerHTML = VIS_CLASSES.map((c) => `<span title="${c.note}"><i style="background:rgb(${c.rgb})"></i>${c.label}</span>`).join("") + `<span><i style="border:1px solid var(--ink-soft)"></i>good (over 5 nm)</span>`;
    for (const id of ["show-sat", "sat-product"]) $(id).addEventListener("change", () => { this.satKey = null; this.drawSatellite(); });
    $("show-clouds").addEventListener("change", () => { this.custom(); this.cloudKey = null; this.redraw(); });
    for (const id of ["show-turb", "turb-pockets", "turb-pbl", "turb-style"]) $(id).addEventListener("change", () => { this.custom(); this.drawTurbulence(); });
    const tb = $("tii-bar").getContext("2d");
    for (let x = 0; x < 256; x++) { const t = (x / 255) * (TII_RAMP.length - 1), i = Math.min(TII_RAMP.length - 2, Math.floor(t)), f = t - i;
      tb.fillStyle = `rgb(${TII_RAMP[i].map((a, k) => (a + (TII_RAMP[i + 1][k] - a) * f) * 255 | 0)})`; tb.fillRect(x, 0, 1, 8); }
    $("show-inversion").addEventListener("change", () => { this.custom(); this.redraw(); });
    let last = performance.now();
    stage.onFrame.push((now) => {                              // playback and particles
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const playing = this.playing ? this.tick(dt, now) : false;
      const moving = $("show-particles").checked && this.particles.group.visible ? this.particles.step(dt) : false;
      if (moving) this.drawSpeedScale(dt);
      return playing || moving;
    });
    this.probe = new Probe(this);                              // values under the cursor / a tap
    if (LITE) $("pt-density").value = "0.6";                   // phones start lighter (device.js); the slider still goes up
    // Freshness: back on the tab (after 10 min away) or every 15 min while it's visible.
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - (this.lastNewerCheck || 0) > 10 * 60e3) this.checkForNewer(); });
    setInterval(() => { if (!document.hidden && Date.now() - (this.lastNewerCheck || 0) > 15 * 60e3) this.checkForNewer(); }, 60e3);
    $("model-notes").addEventListener("click", (e) => { if (e.target.id === "load-newer") this.loadLatest({ fresh: true }); });
    // The newer-run chip in the top bar, and the bar that offers big extra downloads (Load / Not now).
    this.newerChip = Object.assign(document.createElement("button"), { className: "btn mini newer-chip", hidden: true });
    this.newerChip.addEventListener("click", () => this.loadLatest({ fresh: true }));
    $("topbar").append(this.newerChip);
    this.needBar = Object.assign(document.createElement("div"), { id: "need-bar", hidden: true });
    document.body.append(this.needBar);
    this.needBar.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || !this.pendingNeed) return;
      if (b.dataset.a === "load") { for (const k of this.pendingNeed.keys) this.approved.add(k); this.pendingNeed = null; this.needBar.hidden = true; this.checkNeeds(); }
      else if (b.dataset.a === "switch") { const to = this.pendingNeed.to; this.pendingNeed = null; this.needBar.hidden = true; this.switchModel(to); }
      else { if (this.pendingNeed.to) this.modelDismissed = this.pendingNeed.sig; else this.needDismissed = this.pendingNeed.sig; this.pendingNeed = null; this.needBar.hidden = true; }
    });
    this.approved = new Set();                                          // (field keys cleared to download: gateNeeds)
    this.presetInfo = new PresetInfo();                                 // (the preset guide window; ⓘ opens it)
    $("preset-info").addEventListener("click", () => { const p = PRESETS.find((q) => q.id === $("preset-select").value) || PRESETS.find((q) => q.id === this.lastPreset); if (p) this.presetInfo.show(p, this.region); });
    $("dl-run").addEventListener("click", () => (this.dl ? this.stopDownload() : this.downloadRun()));
    this.channel = new ChannelPanel(this);                     // experimental channel analysis (collapsed)
    stage.beforeLabels.push(() => this.occludeLabels());
    this.glyphs = new WindGlyphs();
    stage.scene.add(this.glyphs.group);
    for (const id of ["wind-barbs", "wind-stream"]) $(id).addEventListener("change", () => { this.custom(); this.redraw(); });
    for (const id of ["glyph-density", "glyph-size"]) $(id).addEventListener("input", () => { clearTimeout(this.glyphT); this.glyphT = setTimeout(() => this.drawGlyphs(this.lastPath), 60); });
    $("glyph-opacity").addEventListener("input", () => { this.glyphs.setOpacity(+$("glyph-opacity").value); this.stage.markDirty(); });
    $("glyph-colour").addEventListener("change", () => this.redraw());
    $("pt-width").addEventListener("change", (e) => { this.particles.setWidth(+e.target.value); this.stage.markDirty(); });
    window.addEventListener("resize", () => this.glyphs.setResolution(window.innerWidth, window.innerHeight));
    // Barb and streamline spacing follows the zoom: redraw when it changes class.
    stage.controls.addEventListener("change", () => {
      if (!this.vol || !($("wind-barbs").checked || $("wind-stream").checked)) return;
      if (this.glyphSpacing() !== this.glyphKm) { clearTimeout(this.glyphT); this.glyphT = setTimeout(() => this.drawGlyphs(this.lastPath), 150); }
    });
    $("pt-where-note").addEventListener("click", (e) => {
      const id = e.target.dataset?.go;
      if (!id) return;
      e.preventDefault();
      reveal($(id));
      $(id).scrollIntoView({ behavior: "smooth", block: "center" });
      $(id).classList.remove("flash"); void $(id).offsetWidth; $(id).classList.add("flash");
    });                              // values under the cursor / a tap
    this.cache = new Map(); this.inflight = new Map(); this.stores = new Map(); this.subh = new Map();
    this.vol = null; this.cycle = null; this.playing = false;
    this.spec = { h: 10, ref: "agl", field: "speed" };
    this.top = 9000;

    const GROUPS = [["air", "Wind & air"], ["water", "On the water"], ["weather", "Weather"]];
    $("preset-select").innerHTML = `<option value="custom">Custom</option>` + GROUPS.map(([g, name]) => `<optgroup label="${name}">${PRESETS.filter((p) => (p.group || "air") === g).map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}</optgroup>`).join("");
    $("field-select").innerHTML = Object.entries(COLOUR_BY).map(([k, f]) => `<option value="${k}">${f.none ? f.label : `${f.label} (${f.units})`}</option>`).join("");
    $("preset-select").addEventListener("change", (e) => this.applyPreset(e.target.value));
    $("model-load").addEventListener("click", () => this.loadLatest({ fresh: true }));
    $("model-off").addEventListener("click", () => this.clear());
    $("model-select").addEventListener("change", () => { this.fullFor = false; this.clear(); this.describe(); });
    $("run-select").addEventListener("change", () => { if (this.cycle) this.loadLatest(); });
    $("top-select").addEventListener("change", () => { if (this.cycle) this.open(this.cycle, +$("fhr").value); });
    let t = null;
    $("now-btn").addEventListener("click", () => this.goNow());
    $("view-model").addEventListener("click", (e) => { if (e.target.closest(".to-data")) { e.preventDefault(); selectTab("data"); } });
    setInterval(() => this.syncNow(), 30e3);                   // the present moves on
    $("fhr").addEventListener("input", (e) => { this.stopPlay(); this.setFhrLabel(+e.target.value); clearTimeout(t); t = setTimeout(() => this.showTime(+e.target.value), 150); });
    $("play").addEventListener("click", () => (this.playing ? this.stopPlay() : this.play()));
    $("play-rate").addEventListener("change", () => {});
    $("height").addEventListener("input", (e) => {
      this.spec.h = sToH(+e.target.value, this.top); this.custom(); this.redraw();
      if ($("pt-range").value === "slice" || $("pt-range").value === "hslab") { clearTimeout(this.ptT); this.ptT = setTimeout(() => this.updateParticles(), 200); }
    });
    $("ref-agl").addEventListener("click", () => this.setRef("agl"));
    $("ref-msl").addEventListener("click", () => this.setRef("msl"));
    for (const id of ["show-slice", "show-curtain"]) $(id).addEventListener("change", () => { this.custom(); if (this.region) this.fillSlabModes(); this.redraw(); this.updateParticles(); });
    $("subh").addEventListener("change", () => { if (this.t != null && this.vol0) { this.setTime(this.t, this.vol0, this.vol1, this.frac); this.redraw(); this.updateParticles(); } });
    const slabParticles = () => { if ($("pt-range").value === "xslab" || $("pt-range").value === "hslab") { clearTimeout(this.slabT); this.slabT = setTimeout(() => this.updateParticles(), 150); } };
    $("slab-mode").addEventListener("change", () => { $("slab-pos").value = "0"; this.custom(); this.redraw(); slabParticles(); });
    for (const id of ["slab-pos", "slab-turn"]) $(id).addEventListener("input", () => { this.custom(); this.redraw(); slabParticles(); });
    for (const id of ["slab-width", "slice-thick"]) $(id).addEventListener("input", () => { this.custom(); this.syncSliceBox(); slabParticles(); });
    $("slab-prev").addEventListener("click", () => this.stepSlab(-1));
    $("slab-next").addEventListener("click", () => this.stepSlab(1));
    $("slab-sweep").addEventListener("click", () => this.sweepSlab());
    $("slab-face").addEventListener("click", () => this.faceSlab());
    $("slab-square").addEventListener("click", () => { $("slab-pos").value = "0"; $("slab-turn").value = "0"; this.redraw(); });
    window.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input, select, textarea") || !$("show-curtain").checked) return;
      if (e.key === "[") this.stepSlab(-1); else if (e.key === "]") this.stepSlab(1);
    });
    $("field-select").addEventListener("change", (e) => { this.spec.field = e.target.value; this.custom(); this.redraw(); });
    $("smooth").addEventListener("change", () => this.redraw());
    $("slice-gusty").addEventListener("change", () => { this.custom(); this.redraw(); this.gustTick(); });
    // Tidal currents: the layer, the wind-against-current flags, and their effect on the waves.
    for (const id of ["cur-fill", "cur-arrows", "cur-marks", "cur-scale", "cur-names"]) $(id).addEventListener("input", () => this.drawCurrents());
    for (const id of ["cur-parts", "cur-lines", "cur-density", "cur-speed"]) $(id).addEventListener("input", () => {
      $("cur-density-val").textContent = `${+$("cur-density").value}×`; $("cur-speed-val").textContent = `${+$("cur-speed").value}×`;
      if (id === "cur-density") { clearTimeout(this.cfT); this.cfT = setTimeout(() => this.drawCurrents(), 200); } else this.drawCurrents();
    });
    $("cur-graph-x").addEventListener("click", () => { this.curGraphFor = null; $("cur-graph").hidden = true; });
    $("cur-graph-c").addEventListener("click", (e) => {                 // click the graph: that time on the slider (within the run)
      const g = this.curGraphGeom; if (!g) return;
      const r = e.target.getBoundingClientRect(), tt = g.t0 + ((e.clientX - r.left - g.L) / (r.width - g.L - g.R)) * (g.t1 - g.t0), f = (tt - this.cycle.getTime()) / 3600e3;
      if (f >= +$("fhr").min && f <= +$("fhr").max) { $("fhr").value = String(Math.round(f * 4) / 4); $("fhr").dispatchEvent(new Event("input")); }
    });
    for (const id of ["show-cur", "cur-flag", "cur-waves"]) $(id).addEventListener("change", () => {
      this.seaKeyStr = null; this.redraw();
      if (this.inspectXY && !this.inspector.el.hidden) this.inspectPoint(...this.inspectXY);
    });
    // Per-layer opacity: a small slider on each layer's row.
    const setOp = { slice: (o) => this.slice.setOpacity(o), curtain: (o) => this.curtain.setOpacity(o),
                    particles: (o) => this.particles.setOpacity(o), inversion: (o) => this.inversion.setOpacity(o), turb: (o) => this.turb.setOpacity(o),
                    clouds: (o) => this.clouds.setOpacity(o), fog: (o) => { this.fog.setOpacity(o); this.visMap.setOpacity(o); }, sat: (o) => this.sat.setOpacity(o), sea: (o) => this.waves.setOpacity(o), seaarrows: (o) => this.waves.setSymOpacity(o),
                    cur: (o) => this.currents.setOpacity(o, +$("op-curarrows").value), curarrows: (o) => this.currents.setOpacity(+$("op-cur").value, o),
                    curparts: (o) => this.curFlow.setOpacity(o, +$("op-curlines").value), curlines: (o) => this.curFlow.setOpacity(+$("op-curparts").value, o) };
    for (const [k, fn] of Object.entries(setOp)) {
      $(`op-${k}`).addEventListener("input", (e) => { fn(+e.target.value); stage.markDirty(); });
      fn(+$(`op-${k}`).value);
    }
    const pt = () => { this.custom(); this.updateParticles(); };
    $("show-particles").addEventListener("change", pt);
    for (const id of ["pt-range", "pt-colour", "pt-interp", "pt-vertical", "pt-wboost", "pt-heads", "pt-gusty", "pt-tke"]) $(id).addEventListener("change", pt);
    $("pt-tke").addEventListener("change", () => this.ensureTke());
    $("pt-density").addEventListener("input", (e) => { $("pt-density-val").textContent = `${(+e.target.value).toFixed(1)}×`; clearTimeout(this.ptT); this.ptT = setTimeout(pt, 250); });
    $("pt-density-val").textContent = `${(+$("pt-density").value).toFixed(1)}×`;
    this.syncHeight();
  }

  ptOpts() {
    const range = $("pt-range").value, slabMode = range === "xslab" || range === "hslab";
    let slab = null;
    if (range === "xslab") {
      const g = this.region ? this.slabGeom() : null;
      if (g) slab = { kind: "x", c: g.c, u: g.u, n: g.n, t0: g.t0, t1: g.t1, hw: +$("slab-width").value, zTop: Math.min(this.top, 5000) };
    } else if (range === "hslab") slab = { kind: "h", ref: this.spec.ref, h: this.spec.h, dh: +$("slice-thick").value };
    const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : x);
    return { interp: slabMode || $("pt-interp").checked, vertical: $("pt-vertical").checked, wBoost: +$("pt-wboost").value, colour: $("pt-colour").value,
             density: +$("pt-density").value, range, heads: $("pt-heads").checked, gusty: $("pt-gusty").checked, tkeJitter: $("pt-tke").checked && !!this.model?.tke, sliceH: this.spec.h, sliceRef: this.spec.ref,
             ink: $("show-slice").checked && range === "slice", opacity: +$("op-particles").value,
             slab, slabKey: slab ? JSON.stringify(slab, (k, v) => r1(v)) : null, waterOnly: $("water-only").checked && this.clip.ready };
  }

  // ---------- 15-minute surface wind and gust ----------
  subhOn() { const m = this.model; return $("subh").checked && !!m?.pathSubh && this.isLive(); }
  // The 10 m wind and gust at a whole 15-minute step: the hourly data on the hour, else the sub-hourly file.
  frameAt(min) {
    if (min % 60 === 0) {
      const V = this.cache.get(min / 60), a = V?.raw.agl?.[10];
      return a?.UGRD && a?.VGRD ? { U: a.UGRD, V: a.VGRD, G: V.raw.surface.GUST || null } : null;
    }
    const ff = Math.ceil(min / 60), st = this.subh.get(ff);
    if (!st) { this.loadSubh(ff); return null; }
    return st.frames.get(min) || null;
  }
  loadSubh(ff) {
    const m = this.model;
    if (!this.cycle || !this.subhOn() || ff < 1 || ff > (m.subhMaxFhr ?? 18) || this.subh.has(ff)) return;
    const ref = [...this.stores.values()].find((q) => q.box && q.geo);
    if (!ref) return;
    const st = new SubhStore(m, this.cycle, ff, ref.box, ref.geo);
    this.subh.set(ff, st);
    st.load({ signal: this.abort.signal }).then(() => {
      // Now in: if the time on screen needs it, show it.
      if (this.t != null && this.vol0 && Math.ceil(this.t) === ff && !this.playing) { this.setTime(this.t, this.vol0, this.vol1, this.frac); this.redraw(); this.updateParticles(); }
    }, () => { this.subh.delete(ff); });
  }
  // 10 m wind and gust at time t from the 15-minute steps around it (linear blend), or null
  // (off, beyond 18 h, or not loaded yet: the hourly blend is used meanwhile).
  surfaceAt(t) {
    if (!this.subhOn() || t == null || t > (this.model.subhMaxFhr ?? 18)) return null;
    const min = t * 60, m0 = Math.floor(min / 15 + 1e-6) * 15, f = (min - m0) / 15;
    const A = this.frameAt(m0);
    if (!A) return null;
    if (f < 1e-3) return { ...A, minute: m0 };
    const B = this.frameAt(m0 + 15);
    if (!B) return null;
    const mix = (a, b) => (a && b ? a.map((x, i) => x + (b[i] - x) * f) : null);
    return { U: mix(A.U, B.U), V: mix(A.V, B.V), G: mix(A.G, B.G), minute: min };
  }

  // The particle flow for time t: one hour's grid, or a blend of the two around t.
  flowAt() {
    // Particles pinned to a near-ground slice ride the 15-minute 10 m wind when it's in.
    if (this.surf && $("pt-range").value === "slice" && $("pt-interp").checked && this.spec.ref === "agl" && this.spec.h <= 10) {
      return new SurfaceFlow(this.surf, this.vol0.w, this.vol0.h, this.vol0);
    }
    const interp = this.ptOpts().interp, ri = !!PARTICLE_COLOURS[$("pt-colour").value]?.ri;
    // (A flow prewarmed in idle time may be part-filled: finish() completes it now if needed.)
    const of = (V) => { if (!interp) return (V._levelFlow ||= new LevelFlow(V)); const f = (V._etaFlow ||= new EtaFlow(V)).finish(); f.wantRi = ri; return f; };
    return this.vol1 && this.frac > 0 ? new BlendFlow(of(this.vol0), of(this.vol1), this.frac) : of(this.vol0);
  }

  updateParticles() {
    this.checkNeeds();
    this.syncSliceBox();
    const on = $("show-particles").checked;
    $("particle-box").hidden = !on;
    $("pt-vertical").disabled = !$("pt-interp").checked;          // vertical motion needs the interpolated column
    if (!on || !this.vol) { this.particles.clear(); this.particles.group.visible = false; this.stage.markDirty(); return; }
    this.particles.group.visible = true;
    this.prebuildFlows();
    this.particles.setVolume(this.vol0 || this.vol, { proj: this.proj, groundKm: this.groundKm, isWater: this.isWater, vexFn: () => this.stage.vex }, this.ptOpts(), this.flowAt());
    if ($("pt-gusty").checked) this.particles.setGustField(...this.gustField()); else this.particles.setGustField(null, null);
    this.particles.setTke(this.nearest()?._tke || null);
    const c = PARTICLE_COLOURS[$("pt-colour").value];
    if (c.bands) $("pt-key").innerHTML = c.bands.map(([, col, name]) => `<span class="dk"><i style="background:${col}"></i>${name}</span>`).join("") + "<br>above ground";
    else if (c.ri) $("pt-key").innerHTML = RI_CLASSES.map((k) => `<span class="dk"><i style="background:rgb(${k.colour.map((x) => x * 255 | 0)})"></i>${k.label}</span>`).join("")
      + `<span class="dk"><i style="background:#474f57"></i>neither</span><br>Turbulence proxy (Ri), not observed.`;
    else {
      const cv = document.createElement("canvas"); cv.width = 256; cv.height = 8;
      const g = cv.getContext("2d");
      (c.stops || []).forEach((st, i) => { g.fillStyle = `rgb(${st.map((x) => x * 255 | 0)})`; g.fillRect((i * 256) / c.stops.length, 0, 256 / c.stops.length + 1, 8); });
      $("pt-key").innerHTML = c.uw ? `Particles by ${c.label}: ${fmtSpeed(c.range[0], { unit: false })} to ${fmtSpeed(c.range[1])}` : `Particles by ${c.label}: ${c.range[0]} to ${c.range[1]} ${c.units}`;
      if (c.uw) { const u = uwLegend(256, 8); $("pt-key").append(u.bar); } else $("pt-key").append(cv);
    }
    this.stage.markDirty();
  }

  // Particle speed key: particles move at the model wind × one fixed factor (particles.js
  // timeScale), so the key gives that factor and a reference streak moving at 10 kt at the
  // view's centre (its pixel speed follows the zoom).
  drawSpeedScale(dt) {
    const P = this.particles, cv = $("pt-scale");
    if (!P.timeScale || !cv || !cv.getClientRects().length) return;
    const cam = this.stage.camera, dist = cam.position.distanceTo(this.stage.controls.target);
    const pxPerKm = window.innerHeight / (2 * dist * Math.tan((cam.fov * Math.PI) / 360));
    const pxPerS = ((10 / KT_PER_MS) * P.timeScale / 1000) * pxPerKm;      // a 10 kt wind, in screen px per second
    const W = cv.width = cv.clientWidth * 2, H = cv.height = 16, g = cv.getContext("2d");
    this.scaleX = ((this.scaleX ?? 0) + pxPerS * 2 * dt) % (W + 60);
    g.clearRect(0, 0, W, H);
    const x = this.scaleX, grad = g.createLinearGradient(x - 50, 0, x, 0);
    grad.addColorStop(0, "rgba(217,238,241,0)"); grad.addColorStop(1, "rgba(217,238,241,0.95)");
    g.strokeStyle = grad; g.lineWidth = 3; g.lineCap = "round";
    g.beginPath(); g.moveTo(x - 50, H / 2); g.lineTo(x, H / 2); g.stroke();
    const min = P.timeScale / 60, km20 = (20 / KT_PER_MS) * P.timeScale / 1000;
    const txt = `Speed to scale: 1 s on screen ≈ ${min < 90 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} h`} of real motion · ${fmtSpeed(20)} ≈ ${km20.toFixed(1)} km a second · streak above: ${fmtSpeed(10)} at the view centre`
      + (this.ptOpts().vertical && this.ptOpts().interp ? ` · up/down × ${this.stage.vex} (vertical exaggeration)${+$("pt-wboost").value > 1 ? ` × ${$("pt-wboost").value} (boost)` : ""}` : "");
    if ($("pt-scale-note").textContent !== txt) $("pt-scale-note").textContent = txt;
  }

  // "HRRR" / "RRFS" / "REFS": the short name for wording.
  modelName() { return (this.model?.label || "model").split(/[ ·]/)[0]; }
  get model() { return this.models?.find((m) => m.id === $("model-select").value); }
  custom() { $("preset-select").value = "custom"; $("preset-note").textContent = ""; }

  setRegion(region, proj, models, coast = null) {
    Object.assign(this, { region, proj, models });
    this.clear();
    this.buildCoast(coast);
    this.channel.setRegion(region);
    // Hawaiʻi: the trade-wind inversion (off by default). Elsewhere the same detector finds a
    // generic capping stable layer; the trade-wind story isn't assumed (brief 3.2).
    const hi = region.id === "hawaii";
    $("inversion-label").textContent = hi ? "Trade-wind inversion" : "Capping stable layer";
    $("show-inversion").checked = false;
    this.verification = null;
    this.fillSlabModes();
    fetch(`data/${region.id}/twi_verification.json`).then((r) => (r.ok ? r.json() : null)).then((v) => { this.verification = v; }).catch(() => {});
    const opts = models.filter((m) => m.region === region.id).map((m) => ({
      id: m.id, label: m.label,
      why: m.archived ? `archived for now: ${m.archived}` : !m.verified ? `not checked on the real bucket yet${m.note ? `: ${m.note}` : ""}` : m.family === "refs" ? "ensemble layer not built yet" : "",
    }));
    for (const fam of new Set([...region.models, "hrrr"])) {
      const why = UNAVAILABLE[`${region.id}:${fam}`];
      if (why) opts.push({ id: `x-${fam}`, label: fam.toUpperCase(), why });
    }
    this.opts = opts;
    $("model-select").innerHTML = opts.map((o) => `<option value="${o.id}"${o.why ? " disabled" : ""} title="${o.why}">${o.label}${o.why ? " (unavailable)" : ""}</option>`).join("");
    // (the preferred model first: the light HRRR on the Salish Sea, models.json "preferred")
    const first = opts.find((o) => !o.why && models.find((m) => m.id === o.id)?.preferred) || opts.find((o) => !o.why);
    // Presets for this region only (presets.js regions).
    for (const o of $("preset-select").querySelectorAll("option")) { const p = PRESETS.find((q) => q.id === o.value); o.hidden = o.disabled = !!(p?.regions && !p.regions.includes(region.id)); }
    if (first) $("model-select").value = first.id;
    $("model-load").disabled = !first;
    this.describe();
  }

  describe() {
    const m = this.model;
    $("top-select").innerHTML = (m?.columnTops || []).map((c) => `<option value="${c.mb}">${c.label}</option>`).join("");
    if (m) $("top-select").value = String(m.defaultTopMb);
    $("subh-row").hidden = !m?.pathSubh;
    const off = (this.opts || []).filter((o) => o.why).map((o) => `<b>${o.label}</b>: ${o.why}`);
    $("model-note").innerHTML = [m ? `${m.label}. Runs: ${m.cycles.map((c) => `${c.hours.map(pad).join("/")}Z to ${c.maxFhr} h`).join("; ")}. Output every hour.` : "No model can be loaded here yet.",
      m?.liveNote ? `<span class="caution">Heavy:</span> ${m.liveNote}` : "", m?.zarrNote || "", ...off].filter(Boolean).join("<br>");
    if (!m) this.setState(`No model for ${this.region.label} yet: ${off.map((s) => s.replace(/<[^>]+>/g, "")).join(" ")}`);
  }

  clear() {
    this.stopPlay({ settle: false });
    this.t = null; this.vol0 = this.vol1 = null; this.frac = 0;
    this.abort?.abort();
    this.cache.clear(); this.inflight.clear(); this.stores.clear(); this.subh.clear(); this.needBusy = false; this.loading = new Map(); this.surf = null;
    this.newer = null; this.posted = null;
    this.vol = null; this.cycle = null; this.legend = null; this.newerComplete = null;
    if ($("model-tag")) $("model-tag").textContent = "";
    this.slice.clear(); this.curtain.clear(); this.particles.clear(); this.inversion.clear(); this.turb.clear();
    if (this.coastLine) this.coastLine.visible = false;
    this.glyphs?.clear();
    this.clouds?.clear(); this.cloudKey = null;
    this.fog?.clear(); this.visMap?.clear(); this.fogKey = null;
    this.waves?.clear(); this.seaKeyStr = null;
    this.channel?.clearMarker();
    $("legend").hidden = true;
    this.showModelControls(false);
    this.setViewModel();
    $("timebar").hidden = true;
    $("model-off").disabled = true;
    this.stopDownload(); $("dl-run").disabled = true;
    this.setState("");
    this.stage.markDirty();
  }

  // Status, in fixed slots so the panel doesn't jump while playing: the run (one line), what's
  // happening now (one line, cut to fit; full text on hover), and notes that need reading
  // (failures, a newer or stale run), which appear only when there is one.
  setState(html, cls = "") {
    if (cls) { $("model-notes").innerHTML = `<span class="${cls}">${html}</span>`; return; }
    const el = $("model-act");
    if (el.innerHTML !== html) { el.innerHTML = html; el.title = el.textContent; }
    if (!html) { $("model-notes").innerHTML = ""; $("model-run").textContent = ""; }
  }
  // "HRRR · 0–18 h run" etc.: which model and which kind of run is on screen.
  runTag() {
    const r = $("run-select").value, kind = r === "long" ? "0–48 h run" : r === "partial" ? "run still posting" : "0–18 h run";
    return `${this.model?.short || this.modelName()} · ${kind}`;
  }
  // The View tab's "Loaded model": which model and where it comes from, standard or extended run,
  // the run's start (init) time, how far it goes, and whether a newer one is out.
  setViewModel(st = null) {
    const el = $("view-model");
    if (!el) return;
    const m = this.model;
    if (!m || !this.cycle) { el.innerHTML = m ? `${m.label}: no run loaded yet.` : "No model loaded yet."; return; }
    const r = $("run-select").value, tz = this.region?.tz;
    const loc = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
    const last = +$("fhr").max, end = new Date(this.cycle.getTime() + last * 3600e3);
    const kind = r === "long" ? "extended run, 0–48 h" : r === "partial" ? `newest run, still posting (to +${last} h so far)` : "standard run, 0–18 h";
    const src = m.source === "hrrrzarr" ? "University of Utah's HRRR Zarr copy of NOAA output (AWS)" : m.source === "packs" ? "pre-built packs from NOAA output" : "NOAA Open Data on AWS, read live (GRIB2)";
    const ageH = st?.ageH ?? (Date.now() - this.cycle.getTime()) / 3600e3;
    el.innerHTML = `<b>${m.label}</b><br>${kind}<br>`
      + `Init ${pad(this.cycle.getUTCHours())}Z ${this.cycle.toUTCString().slice(5, 11)} (${loc(this.cycle)}) · ${ageH.toFixed(1)} h ago<br>`
      + `Forecast to +${last} h: ${loc(end)}<br>Source: ${src}`
      + (this.newerComplete ? `<br><span class="newer">A newer run is ready (${pad(this.newerComplete.getUTCHours())}Z): Load it in the Data tab.</span>` : st?.stale ? `<br><span class="stale">A newer run should exist by now: Load in the Data tab.</span>` : "")
      + `<br><a href="#" class="to-data">Change the model or run ›</a>`;
  }
  setModelTag() {
    const el = $("model-tag");
    if (!el) return;
    el.textContent = this.cycle ? `${this.model?.short || this.modelName()} ${pad(this.cycle.getUTCHours())}Z · ${$("run-select").value === "long" ? "0–48 h" : "0–18 h"}` : "";
  }

  // Is a newer complete run out? Checked when you come back to the tab and every 15 min while
  // it's visible; offered with a button, never switched to on its own (the view would change
  // under you). Not while playing, not for "still posting" (that one follows the newest anyway).
  async checkForNewer() {
    const m = this.model, cycle = this.cycle, run = $("run-select").value;
    if (!m || !cycle || this.playing || run === "partial" || document.hidden) return;
    this.lastNewerCheck = Date.now();
    try {
      const need = run === "long" ? RUN_H.long : RUN_H.short;
      const found = m.source === "hrrrzarr" ? await latestZarrCycle(m, { needFhr: Math.max(need, m.firstHour ?? 0) })
        : m.source === "packs" ? null : await latestCycle(m, { needFhr: need });
      if (this.cycle !== cycle) return;
      this.newerComplete = found && found.cycle > cycle ? found.cycle : null;
      if (this.vol0) this.report(Math.floor(this.t ?? 0));
      this.showNewer();
    } catch { /* offline: try again later */ }
  }

  setRunLine(text) { const el = $("model-run"); if (el.textContent !== text) { el.textContent = text; el.title = text; } }

  setFhrLabel(t) { const s = this.fhrLabel(t); $("fhr-val").textContent = s; $("fhr-val").title = s; this.syncNow(t); }

  // The Now button: jump the slider to the present (to the quarter hour), when the run covers it.
  nowFhr() { return this.cycle ? (Date.now() - this.cycle.getTime()) / 3600e3 : NaN; }
  syncNow(t = +$("fhr").value) {
    const b = $("now-btn"), f = this.nowFhr(), lo = +$("fhr").min, hi = +$("fhr").max;
    if (!b) return;
    const inRun = f >= lo - 0.125 && f <= hi + 0.125, local = this.region ? new Intl.DateTimeFormat("en-US", { timeZone: this.region.tz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date()) : "";
    b.disabled = !inRun;
    b.classList.toggle("at-now", inRun && Math.abs(t - f) <= 0.125);
    b.title = inRun ? `Jump to now (${local})` : `Now (${local}) is outside this run's hours${f > hi ? ": load a newer run" : ""}`;
  }
  goNow() {
    const f = this.nowFhr(), lo = +$("fhr").min, hi = +$("fhr").max;
    if (!Number.isFinite(f)) return;
    const t = Math.min(hi, Math.max(lo, Math.round(f * 4) / 4));
    this.stopPlay();
    $("fhr").value = String(t);
    this.setFhrLabel(t);
    this.showTime(t);
  }

  fhrLabel(t) {
    const h = Number.isInteger(t) ? `+${t} h` : `+${Math.floor(t)}:${pad(Math.round((t % 1) * 60))} h`;
    if (!this.cycle) return h;
    const valid = new Date(this.cycle.getTime() + t * 3600e3);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: this.region.tz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(valid);
    return `${h} · ${local}${Number.isInteger(t) ? "" : " (between hours)"}`;
  }

  // A run counts only once the last hour you'll look at has posted (brief 4.5): runs post hour by
  // hour over about an hour, so "the newest run" is often still missing its later hours.
  // "partial" deliberately takes the newest run anyway, and shows only the hours posted so far.
  // opts.fresh: the newest run (a click); otherwise a run kept on this device that started under
  // 3 h ago opens from there, and a newer one is offered (the top bar's chip).
  async loadLatest(opts = {}) {
    const m = this.model;
    if (!m) return;
    const run = $("run-select").value, need = run === "long" ? RUN_H.long : run === "partial" ? 0 : RUN_H.short;
    this.clear();
    $("model-notes").innerHTML = "";
    this.keptOpened = false; this.newerChip && (this.newerChip.hidden = true);
    if (!opts.fresh) {
      const k = await this.keptRun().catch(() => null);
      if (k && this.model === m) {
        this.keptOpened = true;
        try { await this.open(k, Math.max(m.firstHour ?? 0, Math.min(RUN_H[run], opts.at ? Math.round(((opts.at - k) / 3600e3) * 4) / 4 : Math.round((Date.now() - k) / 3600e3)))); } catch (e) { this.fail(e); return; }
        this.checkForNewer();
        return;
      }
    }
    this.setState(run === "long" ? "Finding the newest run with all 48 h posted…" : run === "partial" ? "Finding the newest run…" : "Finding the newest complete run (0–18 h posted)…");
    try {
      const found = m.source === "packs" ? await latestPackCycle(m, { needFhr: need })
        : m.source === "hrrrzarr" ? await latestZarrCycle(m, { needFhr: Math.max(need, m.firstHour ?? 0) })
        : await latestCycle(m, { needFhr: need });
      if (!found) { this.setState(`Fetch failed: no ${m.label} run ${need ? `with +${need} h posted ` : ""}in the last 30 h.`, "fail"); return; }
      this.posted = run === "partial" && this.isLive() ? await this.lastPosted(found.cycle) : null;
      const fhr = Math.max(m.firstHour ?? 0, Math.min(this.posted ?? RUN_H[run], opts.at ? Math.round(((opts.at - found.cycle) / 3600e3) * 4) / 4 : Math.round((Date.now() - found.cycle) / 3600e3)));
      await this.open(found.cycle, fhr);
      this.lastNewerCheck = Date.now();                        // it is the newest right now
      if (run !== "partial" && this.isLive()) this.noteNewer(found.cycle);
    } catch (e) { this.fail(e); }
  }
  // The last forecast hour of a run that has posted (a few one-byte probes, doubling then bisecting).
  async lastPosted(cycle) {
    const m = this.model, top = Math.min(maxFhr(m, cycle.getUTCHours()), 18), ok = (f) => exists(fileUrl(m, cycle, f));
    if (!(await ok(0))) return -1;
    let lo = 0, hi = 1;
    while (hi <= top && (await ok(hi))) { lo = hi; hi *= 2; }
    hi = Math.min(hi, top + 1);
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await ok(mid)) lo = mid; else hi = mid; }
    return lo;
  }
  // Is a newer run already posting? Say so (the complete one is shown; "Newest run, still posting" takes it).
  async noteNewer(cycle) {
    const m = this.model, cands = candidateCycles(m, new Date(), { needFhr: 0 }).filter((c) => c > cycle);
    for (const c of cands) {
      if (!(await exists(fileUrl(m, c, 0)))) continue;
      const last = await this.lastPosted(c);
      if (this.cycle?.getTime() !== cycle.getTime()) return;
      this.newer = { cycle: c, last };
      this.report(Math.floor(this.t ?? 0));
      return;
    }
    this.newer = null;
  }

  // Open a specific run (links use this: the link's run, not "latest").
  async open(cycle, fhr) {
    const m = this.model;
    if (this.cycle?.getTime() !== cycle.getTime()) { this.runBytes = 0; this.cache.clear(); this.inflight.clear(); this.stores.clear(); this.subh.clear(); this.stopDownload(); $("dl-run").textContent = "Download whole run"; }
    if ($("top-select").value !== this.loadedTop) { this.cache.clear(); this.inflight.clear(); }    // stores keep what they fetched
    this.cycle = cycle;
    if ((this.isLive() || m.source === "hrrrzarr") && $("run-select").value !== "partial") try { localStorage.setItem(`wve.kept.${m.id}.${$("run-select").value}`, cycle.toISOString()); } catch { /* no storage */ }
    this.approved = new Set(this.needs().map((q) => this.needSig(q)));   // (what's on when a run opens loads with it)
    this.pendingNeed = null; if (this.needBar) this.needBar.hidden = true;
    this.abort?.abort();
    this.abort = new AbortController();
    const last = Math.min(maxFhr(m, cycle.getUTCHours()), RUN_H[$("run-select").value], this.posted ?? Infinity);
    $("fhr").max = String(last);
    $("fhr").min = String(m.firstHour ?? 0);                   // the Zarr forecast starts at +1 h
    $("fhr").step = "0.25";
    $("fhr").value = String(Math.min(fhr, last));
    this.showModelControls(true);
    $("timebar").hidden = false;
    requestAnimationFrame(() => this.drawSky());
    $("model-off").disabled = false;
    $("dl-run").disabled = !this.isLive();                         // live GRIB only (packs and Zarr load whole hours anyway)
    this.setFhrLabel(+$("fhr").value);
    await this.showTime(+$("fhr").value);
  }

  // ---------- just-in-time loading (live GRIB models) ----------
  // Every hour holds the core set (surface, winds above ground, wind + height 1000-850 mb);
  // other fields and levels load when a display on screen needs them, and are kept.
  isLive() { return this.model?.source === "live" || !this.model?.source; }
  levels() { return levelsTo(this.model, $("top-select").value); }
  needs() {
    const L = this.levels(), f = COLOUR_BY[this.spec.field], parts = [], topZ = stdZ(Math.min(...L)), maxTer = 4500;
    const sliceZ = () => [this.spec.h, this.spec.ref === "agl" ? this.spec.h + maxTer : this.spec.h];
    // Wind near the ground comes straight from the above-ground winds (10/80 m HRRR, 10-320 m RRFS):
    // no pressure levels needed for a wind slice at or below the highest of them.
    const aglTop = Math.max(0, ...(this.model.packSurface || ["UGRD:320 m above ground"]).map((k) => +(/^UGRD:(\d+) m above ground$/.exec(k)?.[1] ?? 0)));
    const windOnly = (field) => fieldsOf(field).every((x) => x === "UGRD" || x === "VGRD");
    const aglWind = (field) => this.spec.ref === "agl" && this.spec.h <= aglTop && windOnly(field);
    if ($("show-slice").checked && !f.surfaceOnly && !aglWind(this.spec.field)) parts.push({ fields: fieldsOf(this.spec.field), mbs: levelsFor(L, ...sliceZ()) });
    if ($("show-curtain").checked) parts.push({ fields: fieldsOf(this.spec.field), mbs: levelsFor(L, 0, Math.min(topZ, 5000)) });
    if ($("show-slice").checked && this.spec.field === "mixdown") parts.push({ fields: ["UGRD", "VGRD"], mbs: levelsFor(L, 0, 3500) });   // (the winds up through a mixed layer)
    if ($("show-particles").checked) {
      const o = this.ptOpts(), fields = ["UGRD", "VGRD"];
      if (o.interp && o.vertical && o.range !== "slice") fields.push("DZDT");   // particles pinned to a slice don't rise or sink
      if (o.colour === "updown") fields.push("DZDT"); else if (o.colour === "rotation") fields.push("ABSV"); else if (o.colour === "turbulence") fields.push("TMP");
      const dh = +$("slice-thick").value, hz = this.spec.ref === "agl" ? [Math.max(0, this.spec.h - dh), this.spec.h + dh + maxTer] : [this.spec.h - dh, this.spec.h + dh];
      const mbs = o.range === "column" ? L : o.range === "low" ? levelsFor(L, 0, 2000)
        : o.range === "xslab" ? levelsFor(L, 0, Math.min(topZ, 5000))
        : o.range === "hslab" ? levelsFor(L, ...hz)
        : (aglWind("speed") && fields.length === 2 ? [] : levelsFor(L, ...sliceZ()));     // particles on a near-ground slice: above-ground winds
      parts.push({ fields, mbs });
    }
    if ($("show-inversion").checked && !this.model.noInversion) parts.push({ fields: ["TMP", "RH"], mbs: L.filter((mb) => mb >= 575 && mb <= 975) });
    if ($("show-turb").checked) parts.push({ fields: ["UGRD", "VGRD", "TMP"], mbs: levelsFor(L, 0, 6000) });
    if ($("show-clouds").checked) parts.push({ fields: ["CLMR", "CICE"], mbs: levelsFor(L, 0, CLOUD_TOP_M) });
    const fogOn = $("show-fog").checked;
    if (fogOn) parts.push({ fields: ["CLMR", "CICE"], mbs: levelsFor(L, 0, 800) });
    // Channel analysis (open) or the Froude colouring: the column to ~4.5 km, and sea-level pressure.
    const chan = this.channel?.wantsFields;
    if (chan) parts.push({ fields: ["UGRD", "VGRD", "TMP", "RH"], mbs: L.filter((mb) => mb >= 575) });
    const out = needsOf(parts, L);
    if (chan && this.model.mslpKey) out.push({ sfc: this.model.mslpKey });
    if (fogOn) out.push({ sfc: "VIS:surface" });
    return out;
  }
  store(fhr) {
    if (!this.cycle) throw Object.assign(new Error("run changed"), { name: "AbortError" });
    let st = this.stores.get(fhr);
    if (!st) { st = new HourStore(this.model, this.cycle, fhr, this.region.bbox); this.stores.set(fhr, st); }
    return st;
  }
  // Does the hour on screen (and the one after it, if blending) have what the displays need?
  // If not, fetch the rest in the background and redraw when it's in.
  // Big downloads wait for a click. A setting that needs fields not loaded yet (clouds, fog, more
  // heights, vertical motion…) is costed from the run's index (exact message sizes, per hour, times
  // the run's hours); under ~25 MB for the run it just loads, over that the bar offers Load (or
  // Not now). What's been loaded or cleared stays cleared for the session.
  needSig(q) { return q.sfc || `${q.f}:${q.mb}`; }
  needsApproved() { return this.needs().filter((q) => this.approved.has(this.needSig(q))); }
  gateNeeds() {
    const fresh = this.needs().filter((q) => !this.approved.has(this.needSig(q)));
    if (!fresh.length) { this.needDismissed = null; if (this.pendingNeed && !this.pendingNeed.to) { this.pendingNeed = null; this.needBar.hidden = true; } return; }
    const st = [this.vol0?.raw.fhr, ...this.stores.keys()].map((f) => this.stores.get(f)).find((q) => q?.idx);
    const perHour = st ? st.costOf(fresh) : NaN, hours = +$("fhr").max - +$("fhr").min + 1, total = perHour * hours;
    if (!st || !(total >= 25e6)) { for (const q of fresh) this.approved.add(this.needSig(q)); return; }   // (small, or can't tell yet: just load)
    const sig = fresh.map((q) => this.needSig(q)).sort().join(",");
    this.pendingNeed = { keys: fresh.map((q) => this.needSig(q)), perHour, total, sig };
    if (this.needDismissed === sig) return;
    const words = { UGRD: "winds", VGRD: "winds", TMP: "temperature", RH: "humidity", DZDT: "vertical motion", ABSV: "vorticity", CLMR: "cloud water", CICE: "cloud ice", HGT: "heights", "VIS:surface": "visibility" };
    const what = [...new Set(fresh.map((q) => words[q.sfc || q.f] || q.sfc || q.f))].join(", "), mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
    const lv = [...new Set(fresh.filter((q) => q.mb).map((q) => q.mb))];
    this.needBar.innerHTML = `<span>What's on now needs <b>${what}</b>${lv.length ? ` at ${lv.length} level${lv.length > 1 ? "s" : ""}` : ""}: <b>~${mb(perHour)} an hour</b>, ~${mb(total)} for the whole run (hours load as you view them).</span> <button class="btn mini" data-a="load">Load</button> <button class="btn mini" data-a="no">Not now</button>`;
    this.needBar.hidden = false;
  }
  // What's on that the light HRRR (Zarr: 5 levels, surface set, hourly) can't show. → [words]
  zarrGaps() {
    const gaps = [];
    if ($("show-clouds").checked) gaps.push("the clouds");
    if ($("show-fog").checked) gaps.push("fog and visibility");
    if ($("show-inversion").checked) gaps.push("the inversion");
    if (this.spec.field === "tke" || $("pt-tke").checked) gaps.push("the model's turbulence (TKE)");   // (the turbulence layer itself uses the Ri proxy and the mixed-layer depth: both in the light run)
    if ($("show-particles").checked && (this.ptOpts().colour === "updown" || (this.ptOpts().vertical && this.ptOpts().range !== "slice"))) gaps.push("vertical motion");
    return gaps;
  }
  // The light HRRR (Zarr) and the full one (GRIB) on the Salish Sea: when something on needs the
  // full column, offer the switch (its cost); after a switch, once nothing needs it, offer the way
  // back. Never switched on its own.
  offerModel() {
    const m = this.model, zarr = this.models?.find((q) => q.region === this.region?.id && q.source === "hrrrzarr"), full = this.models?.find((q) => q.region === this.region?.id && q.id === "hrrr-conus");
    if (!m || !zarr || !full || !this.cycle) return;
    let offer = null;
    if (m.id === zarr.id) {
      const gaps = this.zarrGaps();
      if (gaps.length) offer = { to: full.id, sig: `full|${gaps.join()}`, html: `<span><b>${gaps.join(", ").replace(/^./, (c) => c.toUpperCase())}</b> need${gaps.length > 1 || /s$/.test(gaps[0]) ? "" : "s"} the full-column HRRR (GRIB): ~50 MB an hour as you view them, against ~${Math.round((this.runBytes || 45e6) / 1e6)} MB for this whole light run. The light run has winds at 5 levels and the surface set, hourly.</span> <button class="btn mini" data-a="switch">Switch</button> <button class="btn mini" data-a="no">Not now</button>` };
    } else if (m.id === full.id && this.fullFor && !this.zarrGaps().length) {
      offer = { to: zarr.id, sig: "light", html: `<span>Nothing on needs the full column now: back to the <b>light HRRR</b> (the whole run in ~45 MB instead of ~50 MB an hour)?</span> <button class="btn mini" data-a="switch">Switch back</button> <button class="btn mini" data-a="no">Stay</button>` };
    }
    if (!offer) { if (this.pendingNeed?.to) { this.pendingNeed = null; this.needBar.hidden = true; } this.modelDismissed = null; return; }
    if (this.pendingNeed?.sig === offer.sig || this.modelDismissed === offer.sig) return;
    this.pendingNeed = offer; this.needBar.innerHTML = offer.html; this.needBar.hidden = false;
  }
  // Change the model and load it, keeping the time on screen.
  async switchModel(id) {
    const at = this.validDate()?.getTime(), from = this.model?.id;
    $("model-select").value = id; this.clear(); this.describe();
    this.fullFor = id === "hrrr-conus" && from !== id;
    await this.loadLatest({ at });
  }
  // The run kept on this device for this model and run length (model/store.js), if it started
  // under 3 h ago and its first hour is still stored. → Date or null
  async keptRun() {
    const m = this.model, run = $("run-select").value;
    const zarr = m?.source === "hrrrzarr";
    if (!m || !(this.isLive() || zarr) || run === "partial" || !("caches" in window)) return null;
    let iso = null, off = false;
    try { iso = localStorage.getItem(`wve.kept.${m.id}.${run}`); off = localStorage.getItem("wve.store") === "off"; } catch { /* no storage */ }
    if (!iso || off) return null;
    const c = new Date(iso);
    if (!(Date.now() - c.getTime() < 3 * 3600e3)) return null;
    // (any of its files stored: the part of the file name the hours share)
    let pre;
    if (zarr) pre = runBase(c) + "/";
    else { const u0 = fileUrl(m, c, 0), u1 = fileUrl(m, c, 1); let n = 0; while (n < u0.length && u0[n] === u1[n]) n++; pre = u0.slice(0, n); }
    for (const name of (await caches.keys()).filter((q) => q.startsWith("wve-data-")).reverse()) {
      const keys = await (await caches.open(name)).keys();
      if (keys.some((r) => r.url.startsWith(pre))) return c;
    }
    return null;
  }
  // The top bar's chip when a newer complete run is out: its size, roughly (this run's hours so far).
  showNewer() {
    const c = this.newerComplete, chip = this.newerChip;
    if (!chip) return;
    const off = !c || !this.cycle || c <= this.cycle;
    document.body.classList.toggle("has-newer", !off);
    if (off) { chip.hidden = true; return; }
    const st = [...this.stores.values()].filter((q) => q.bytes > 0), per = st.length ? st.reduce((a, q) => a + q.bytes, 0) / st.length : 0;
    const hours = +$("fhr").max - +$("fhr").min + 1, est = per * hours;
    chip.textContent = `${this.model?.short || "Model"} ${pad(c.getUTCHours())}Z is out · Load${per ? ` (~${Math.round(per / 1e6)} MB an hour)` : this.runBytes && !this.isLive() ? ` (~${Math.round(this.runBytes / 1e6)} MB)` : ""}`;
    chip.title = `A newer complete run started at ${pad(c.getUTCHours())}Z. On screen: the ${pad(this.cycle.getUTCHours())}Z run${this.keptOpened ? ", opened from this device" : ""}. Loading the newer one downloads it hour by hour as you view them: about ${per ? `${Math.round(per / 1e6)} MB an hour with what's on now, ~${Math.round(est / 1e6)} MB if you view the whole run` : "as much as this run"}.`;
    chip.hidden = false;
  }
  checkNeeds() {
    this.offerModel();
    if (!this.isLive() || !this.cycle || this.needBusy) return;
    this.gateNeeds();
    const need = this.needsApproved(), hours = [this.vol0?.raw.fhr, this.vol1?.raw.fhr].filter((f) => f != null);
    const short = hours.filter((f) => !this.stores.get(f)?.has(need));
    if (!short.length) return;
    this.needBusy = true;
    const t = this.t;
    Promise.all(short.map((f) => this.load(f))).then(() => {
      this.needBusy = false;
      if (this.t !== t || !this.cycle) return;
      const f0 = Math.floor(t), last = +$("fhr").max, f1 = Math.min(last, f0 + 1);
      this.setTime(t, this.cache.get(f0), this.frac > 0 ? this.cache.get(f1) : null, this.frac);
      this.redraw(); this.updateParticles(); this.report(f0);
    }, (e) => { this.needBusy = false; if (e.name !== "AbortError") this.fail(e); });
  }

  // A forecast hour's Volume with what the displays need: from cache, in flight, or fetched now.
  async load(fhr) {
    const m = this.model, top = $("top-select").value, signal = this.abort.signal;
    this.loadedTop = top;
    const progress = (q) => { if (!this.isLive() && q.bytes) this.runBytes = Math.max(this.runBytes || 0, q.bytes); if (Math.floor(this.t ?? -1) === fhr || fhr === +$("fhr").value) this.setState(q.phase === "fetch" ? `Loading +${fhr} h: ${(q.bytes / 1e6).toFixed(1)} MB (${q.count} fields)…` : `Decoding +${fhr} h…`); };
    if (!this.isLive()) {                                        // packs / Zarr: whole hours
      if (this.cache.has(fhr)) return this.cache.get(fhr);
      if (!this.inflight.has(fhr)) {
        const loader = m.source === "packs" ? loadPack : loadZarrHour;
        this.inflight.set(fhr, loader(m, this.cycle, fhr, { bbox: this.region.bbox, levels: this.levels(), signal, onProgress: progress })
          .then((raw) => this.keep(fhr, new Volume(raw, raw.grid)), (e) => { this.inflight.delete(fhr); throw e; }));
      }
      return this.inflight.get(fhr);
    }
    const st = this.store(fhr), need = this.needsApproved(), cached = this.cache.get(fhr);
    if (cached && cached.raw.version === st.version && st.has(need)) return cached;
    await st.ensure(need, { signal, onProgress: progress });
    this.trimStores();
    const again = this.cache.get(fhr);
    if (again && again.raw.version === st.version) return again;
    return this.keep(fhr, new Volume(st.raw(this.levels()), st.grid));
  }
  // "Download whole run": every hour of the run on screen, two at a time, fields only (what the
  // layers on screen need, plus the 15-minute surface data); volumes are built when an hour is
  // shown. Stops on click, on a run change, or on Clear.
  async downloadRun() {
    const cycle = this.cycle;
    if (!cycle || !this.isLive()) return;
    const f0 = +$("fhr").min, f1 = +$("fhr").max, hours = [];
    for (let f = f0; f <= f1; f++) hours.push(f);
    const total = hours.length;
    const token = (this.dl = { stop: false }), btn = $("dl-run");
    btn.classList.add("busy");
    let done = 0;
    const need = this.needsApproved(), before = [...this.stores.values()].reduce((a, q) => a + q.bytes, 0);
    const show = () => {
      const got = [...this.stores.values()].reduce((a, q) => a + q.bytes, 0) - before;
      btn.textContent = `Downloading run: ${done} / ${total} h · ${Math.round(got / 1e6)} MB · stop`;
    };
    show();
    const worker = async () => {
      while (hours.length && !token.stop && this.cycle === cycle) {
        const f = hours.shift();
        try {
          const st = this.store(f);
          if (!st.has(need)) await st.ensure(need, { signal: this.abort.signal });
          this.trimStores();
          if (f >= 1) this.loadSubh(f);
        } catch (e) { if (e.name === "AbortError") return; }
        done++; show();
      }
    };
    await Promise.all([worker(), worker()]);
    if (this.dl !== token) return;
    this.dl = null;
    btn.classList.remove("busy");
    const kept = [...this.stores.values()].reduce((a, q) => a + q.heldBytes(), 0);
    btn.textContent = token.stop || this.cycle !== cycle ? "Download whole run" : `Whole run downloaded (${this.stores.size} h, ${Math.round(kept / 1e6)} MB kept)`;
    if (this.vol0 && this.cycle === cycle) this.report(Math.floor(this.t ?? 0));
  }
  stopDownload() {
    if (!this.dl) return;
    this.dl.stop = true; this.dl = null;
    const btn = $("dl-run"); btn.classList.remove("busy"); btn.textContent = "Download whole run";
  }

  // Over the memory budget: drop the downloaded fields of the hours farthest from the one on
  // screen (never the ones with a volume in use).
  trimStores() {
    const budget = STORE_BUDGET(), cur = this.t ?? +$("fhr").value;
    let total = 0;
    for (const st of this.stores.values()) total += st.heldBytes();
    if (total <= budget) return;
    const order = [...this.stores.keys()].filter((f) => !this.cache.has(f)).sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur));
    for (const f of order) {
      if (total <= budget) break;
      total -= this.stores.get(f).heldBytes();
      this.stores.delete(f);
    }
  }
  keep(fhr, vol) {
    this.inflight.delete(fhr);
    // Full: drop the hour farthest from the time being asked for (this.want: a jump, the replay or the
    // movie), never the two hours it needs. (From the time on screen, a jump from +11 h to +3 h
    // dropped +4 h to make room for +3 h and then +3 h for +4 h, for ever.)
    if (!this.cache.has(fhr) && this.cache.size >= CACHE_HOURS) {
      const cur = this.want ?? this.t ?? +$("fhr").value, need = new Set([Math.floor(cur), Math.floor(cur) + 1, fhr]);
      const far = [...this.cache.keys()].filter((k) => !need.has(k)).sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur))[0];
      if (far != null) this.cache.delete(far);                   // the volume only: its downloaded fields stay (trimStores)
    }
    this.cache.set(fhr, vol);
    this.prebuildFlows();
    return vol;
  }
  // Particles on: build each cached hour's flow while the page is idle, so playback doesn't
  // stall on it when it reaches the hour. In slices of a few hundred columns (the whole field is
  // ~340 ms on a fast Mac: one idle callback used to block for all of it); one hour at a time.
  prebuildFlows() {
    if (!$("show-particles").checked || !this.ptOpts().interp || this.prebuilding) return;
    const next = [...this.cache.values()].find((v) => !v._etaFlow || !v._etaFlow.ready);
    if (!next) return;
    this.prebuilding = true;
    const f = (next._etaFlow ||= new EtaFlow(next, { defer: true })), step = 400;
    idleLoop(Math.ceil((f.n - f.filled) / step), (i) => { const c0 = f.filled; f.fill(c0, c0 + step); })
      .promise.finally(() => { this.prebuilding = false; this.prebuildFlows(); });
  }

  // Show forecast time t (hours; fractional = blended between the two hours around it).
  async showTime(t, { quiet = false } = {}) {
    if (!this.model || !this.cycle) return;
    this.want = t;
    const last = +$("fhr").max, f0 = Math.floor(t), f1 = Math.min(last, f0 + 1), frac = f1 > f0 ? t - f0 : 0;
    let V0, V1 = null;
    try { V0 = await this.load(f0); if (frac > 0) V1 = await this.load(f1); }
    catch (e) { if (e.name !== "AbortError") this.fail(e, frac > 0 && !V0 ? f0 : V0 ? f1 : f0); return; }
    if (!quiet && Math.abs(+$("fhr").value - t) > 1e-6) return;   // the slider moved on while this loaded
    this.setTime(t, V0, V1, frac);
    this.redraw();
    this.updateParticles();
    this.report(f0);
    this.prefetch(f0);
    this.onChange();
  }

  setTime(t, V0, V1, frac) {
    Object.assign(this, { t, vol0: V0, vol1: V1, frac });
    this.surf = this.surfaceAt(t);
    this.vol = V1 && frac > 0 ? new BlendVolume(V0, V1, frac) : V0;
    const top = Math.floor(stdZ(Math.min(...V0.raw.levels)) / 100) * 100;   // from the column choice, not from what's loaded yet
    if (top !== this.top) { this.top = top; this.syncHeight(); }
  }

  // "Download whole run (~N MB)": the hours not loaded yet, at what the loaded ones cost each.
  dlLabel() {
    const btn = $("dl-run");
    if (!btn || this.dl || !this.isLive() || !this.cycle || /downloaded/.test(btn.textContent)) return;
    const st = [...this.stores.values()].filter((q) => q.bytes > 0), per = st.length ? st.reduce((a, q) => a + q.bytes, 0) / st.length : 0;
    const left = +$("fhr").max - +$("fhr").min + 1 - [...this.stores.keys()].filter((f) => this.stores.get(f).bytes > 0).length;
    btn.textContent = per && left > 0 ? `Download whole run (~${Math.round((per * left) / 1e6)} MB)` : "Download whole run";
    btn.title = `Every hour of this run with what's on now, so playing it needs no more downloads${per ? `: ~${Math.round(per / 1e6)} MB an hour, ${left} hours to go` : ""}. Kept on this device (Data tab).`;
  }
  report(f0) {
    this.dlLabel();
    const complete = $("run-select").value !== "partial";
    const st = staleness(this.model, this.cycle, new Date(), complete ? 150 : 60), raw = this.vol0.raw;   // complete runs lag by their posting time
    const run = `${pad(this.cycle.getUTCHours())}Z ${this.cycle.toUTCString().slice(0, 11)}`;
    const fields = raw.have ? ` · ${raw.have.size} level-fields (just in time)` : "";
    this.setRunLine(`${this.runTag()} · run ${run} · ${st.ageH.toFixed(1)} h old` + (this.posted != null ? ` · posted +0–${this.posted} h so far` : ""));
    this.setModelTag();
    this.setViewModel(st);
    this.setState(`+${f0} h · ${(raw.bytes / 1e6).toFixed(1)} MB in ${(raw.ms / 1000).toFixed(1)} s${fields} · ${this.stores.size} h downloaded (${Math.round([...this.stores.values()].reduce((a, q) => a + q.heldBytes(), 0) / 1e6)} MB kept)`);
    const notes = (this.newerComplete ? `<span class="newer">A newer complete run is ready: ${this.model.short || this.modelName()} ${pad(this.newerComplete.getUTCHours())}Z. <button class="btn mini" id="load-newer">Load it</button></span><br>` : "")
      + (this.newer && !this.newerComplete ? `A newer run (${pad(this.newer.cycle.getUTCHours())}Z) is posting: +0–${this.newer.last} h so far. Run → "Newest run, still posting" to use it.` : "")
      + (st.stale ? `${this.newer ? "<br>" : ""}<span class="stale">Stale: a run ${st.behindH} h newer should exist by now. Load to check.</span>` : "");
    if ($("model-notes").innerHTML !== notes) $("model-notes").innerHTML = notes;
  }

  // Background: the next two hours, one at a time (quiet; failures show when you get there).
  async prefetch(fhr) {
    const ahead = this.model?.prefetchHours ?? 3, cycle = this.cycle;
    this.loadSubh(fhr + 1);
    for (let f = fhr + 1; f <= fhr + ahead; f++) {
      if (f > +$("fhr").max || this.cycle !== cycle) break;     // run changed meanwhile: stop
      this.loadSubh(f + 1);
      try { await this.loadOnce(f); } catch { return; }       // tops up hours already cached, too (just in time)
      this.prewarm(this.cache.get(f));
      if (!this.playing && this.vol0 && this.cycle === cycle) this.report(Math.floor(this.t ?? fhr));   // the cached count moves on
    }
  }
  // The per-hour work for an upcoming hour, in idle time (performance review, 2026-09-28), so
  // playback doesn't stall when it gets there: the clouds, fog and visibility when they're on
  // (the particles' flow field has prebuildFlows).
  prewarm(V) {
    if (!V || !this.proj) return;
    if ($("show-clouds").checked) this.clouds.prewarm(V, this.proj);
    if (this.wantsTke()) this.ensureTke([V]);
    if ($("show-turb").checked && !V.lay && !V._layJob) { const step = 500; V._layJob = idleLoop(Math.ceil(V.n / step), (i) => V.stabilityFill(i * step, (i + 1) * step)); }
    if ($("show-inversion").checked && !this.model?.noInversion) prewarmDetection(V);
    if ($("show-fog").checked) { const m = $("fog-mode").value; if (m !== "map") this.fog.prewarm(V, this.proj); if (m !== "fog") this.visMap.prewarm(V, this.proj); }
  }
  // load(f), but never twice at once for the same hour (playback asks every frame while buffering).
  loadOnce(f) {
    this.loading ||= new Map();
    if (!this.loading.has(f)) {
      const p = this.load(f).catch((e) => { if (e.name !== "AbortError") this.fail(e, f); throw e; }).finally(() => this.loading.delete(f));
      this.loading.set(f, p);
    }
    return this.loading.get(f);
  }

  // Smooth playback: time advances continuously; particles blend every frame, the slice and
  // cross-section are recoloured ten times a second. If the next hour isn't loaded yet,
  // playback waits for it ("buffering") instead of skipping.
  play() {
    if (!this.cycle) return;
    this.playing = true; this.lastRedraw = 0; $("play").textContent = "■"; this.inspector?.syncTime?.();
    this.stage.markDirty();
  }
  tick(dt, now) {
    const last = +$("fhr").max, rate = +$("play-rate").value;
    let t = (this.t ?? 0) + rate * dt;
    if (t > last) t = +$("fhr").min;
    this.want = t;
    const f0 = Math.floor(t), f1 = Math.min(last, f0 + 1);
    const V0 = this.cache.get(f0), V1 = this.cache.get(f1);
    if (!V0 || !V1) {                                           // buffering
      if (!V0) this.loadOnce(f0);
      if (!V1) this.loadOnce(f1);
      this.setState(`Buffering +${V0 ? f1 : f0} h…`);
      return true;
    }
    const frac = f1 > f0 ? t - f0 : 0, hourChanged = f0 !== Math.floor(this.t ?? -1);
    this.setTime(t, V0, V1, frac);
    $("fhr").value = String(t); this.setFhrLabel(Math.round(t * 4) / 4);
    // Particles: swap in the blended flow (cheap). They keep their places.
    if ($("show-particles").checked && this.particles.set) this.particles.flow = this.flowAt(), this.particles.vol = V0;
    if (now - this.lastRedraw > 100) { this.lastRedraw = now; this.redraw(); }   // ~10/s: the slice is recoloured in place (a few ms)
    if (hourChanged) { this.report(f0); this.prefetch(f0); }
    return true;
  }
  // The passage replay (and the movie): the forecast at time t (fractional hours), blended between
  // the hours like playback, every frame. → false while an hour it needs is still loading (the
  // caller waits), true when shown. force: redraw now (the movie's frames).
  followTime(t, { force = false } = {}) {
    if (!this.cycle) return true;
    const last = +$("fhr").max, lo = +$("fhr").min;
    if (t < lo || t > last) return true;
    this.want = t;
    const f0 = Math.floor(t), f1 = Math.min(last, f0 + 1), V0 = this.cache.get(f0), V1 = this.cache.get(f1);
    if (!V0 || !V1) { if (!V0) this.loadOnce(f0).catch(() => {}); if (!V1) this.loadOnce(f1).catch(() => {}); this.setState(`Buffering +${V0 ? f1 : f0} h…`); return false; }
    const frac = f1 > f0 ? t - f0 : 0, hourChanged = f0 !== Math.floor(this.t ?? -1);
    this.setTime(t, V0, V1, frac);
    $("fhr").value = String(t); this.setFhrLabel(Math.round(t * 4) / 4);
    if ($("show-particles").checked && this.particles.set) this.particles.flow = this.flowAt(), this.particles.vol = V0;
    const now = performance.now();
    if (force || now - (this.lastRedraw || 0) > 100) { this.lastRedraw = now; this.redraw(); }
    if (hourChanged) { this.report(f0); this.prefetch(f0); }
    this.stage.markDirty();
    return true;
  }
  stopPlay({ settle = true } = {}) {
    if (settle && this.playing && this.t != null && this.cycle) { this.showTime(Math.round(this.t * 4) / 4, { quiet: true }); $("fhr").value = String(Math.round(this.t * 4) / 4); }
    this.playing = false; $("play").textContent = "▶"; this.inspector?.syncTime?.();
  }

  fail(e, fhr) {
    this.stopPlay({ settle: false });
    if (e instanceof CapabilityAbsent) this.setState(`Not in this file (capability absent): ${e.keys.join(", ")}. Nothing substituted.`, "fail");
    else if (e instanceof FetchFailed) {
      const notYet = /HTTP 40[34]/.test(e.message) && fhr != null;
      this.setState(notYet ? `+${fhr} h isn't posted yet for this run (${e.message}).` : `Fetch failed: ${e.message}. Try again.`, "fail");
    } else this.setState(`Failed: ${e.message}`, "fail");
    console.error(e);
  }

  setRef(ref) {
    if (ref === this.spec.ref) return;
    // Keep roughly the same height when switching (over water the two are the same).
    this.spec.ref = ref;
    $("ref-agl").classList.toggle("on", ref === "agl"); $("ref-msl").classList.toggle("on", ref === "msl");
    this.custom(); this.syncHeight(); this.redraw();
  }
  syncHeight() {
    this.spec.h = Math.min(this.spec.h, this.top);
    $("height").value = String(hToS(this.spec.h, this.top));
    $("height-val").textContent = heightLabel(this.vol, this.spec.h, this.spec.ref);
    $("ref-agl").classList.toggle("on", this.spec.ref === "agl"); $("ref-msl").classList.toggle("on", this.spec.ref === "msl");
    $("field-select").value = this.spec.field;
  }

  // ---------- cross-section as a CT-style slab (radar-explorer's slab scan, as a vertical plane) ----------
  // The plane runs through centre C at bearing θ (+ turn), shifted sideways by `pos` km, and spans
  // the whole domain. Orientation: along / across an axis subarea, N-S or E-W.
  axisSub() {
    const v = this.currentView?.(), subs = this.region.subareas.filter((q) => q.axis);
    return subs.find((q) => v?.id?.startsWith(`${q.id}-`)) || subs[0] || null;
  }
  fillSlabModes() {
    const sub = this.axisSub(), cur = $("slab-mode").value;
    const opts = [...(sub ? [["along", `along the ${sub.label} axis`], ["across", `across the ${sub.label} axis`]] : []), ["ns", "north–south"], ["ew", "east–west"]];
    $("slab-mode").innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    $("slab-mode").value = opts.some(([v]) => v === cur) ? cur : opts[0][0];
    const b = this.proj.box, half = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2;
    $("slab-pos").min = String(-Math.round(half)); $("slab-pos").max = String(Math.round(half));
  }
  slabGeom() {
    const mode = $("slab-mode").value, sub = this.axisSub(), b = this.proj.box;
    let C = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, th0 = 0;
    if ((mode === "along" || mode === "across") && sub) {
      const fr = new ChannelFrame(sub), ax = fr.sceneAxes(this.proj);
      C = ax.origin;
      th0 = Math.atan2(ax.along.x, ax.along.y) * 180 / Math.PI + (mode === "across" ? 90 : 0);
    } else if (mode === "ew") th0 = 90;
    const th = (th0 + +$("slab-turn").value) * Math.PI / 180;
    const u = { x: Math.sin(th), y: Math.cos(th) };
    // Sideways direction: right of the line; for "across", + means downstream along the axis.
    let n = { x: u.y, y: -u.x };
    if (mode === "across") n = { x: -n.x, y: -n.y };
    const pos = +$("slab-pos").value, c = { x: C.x + n.x * pos, y: C.y + n.y * pos };
    // Clip the infinite line to the domain box (slab method).
    let t0 = -Infinity, t1 = Infinity;
    for (const [p0, d, lo, hi] of [[c.x, u.x, b.x0, b.x1], [c.y, u.y, b.y0, b.y1]]) {
      if (Math.abs(d) < 1e-9) { if (p0 < lo || p0 > hi) return null; continue; }
      const a = (lo - p0) / d, z = (hi - p0) / d;
      t0 = Math.max(t0, Math.min(a, z)); t1 = Math.min(t1, Math.max(a, z));
    }
    if (!(t1 > t0)) return null;
    return { c, u, n, t0, t1, bearing: ((th * 180 / Math.PI) % 360 + 360) % 360, mode, pos };
  }
  sectionPath() {
    const g = this.slabGeom();
    const b = this.proj.box, half = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2;
    const dir = (deg) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
    if (!g) { $("slab-pos-val").textContent = "outside the domain"; return null; }
    const shift = g.n ? Math.atan2(g.n.x, g.n.y) * 180 / Math.PI : 0;
    $("slab-pos-val").textContent = g.pos === 0 ? "centre" : `${Math.abs(g.pos).toFixed(1)} km ${dir(g.pos > 0 ? shift : shift + 180)}`;
    $("slab-turn-val").textContent = `${+$("slab-turn").value > 0 ? "+" : ""}${$("slab-turn").value}° · runs ${String(Math.round(g.bearing) % 180).padStart(3, "0")}°/${String((Math.round(g.bearing) % 180) + 180).padStart(3, "0")}°`;
    const N = 180, pts = [];
    for (let i = 0; i < N; i++) {
      const t = g.t0 + (g.t1 - g.t0) * (i / (N - 1)), x = g.c.x + g.u.x * t, y = g.c.y + g.u.y * t, q = this.proj.toLatLon(x, y);
      pts.push({ lat: q.lat, lon: q.lon });
    }
    void half;
    return { pts, geom: g, label: `${$("slab-mode").selectedOptions[0]?.textContent || ""}, ${(g.t1 - g.t0).toFixed(0)} km long` };
  }
  // A view with a section (the channel's curtain views) sets the slab to match.
  onView(v) {
    if (!this.region) return;
    this.channel.onView(this.region.subareas.find((s) => v?.id?.startsWith(`${s.id}-`))?.id);
    this.fillSlabModes();
    if (v?.section === "along") { $("slab-mode").value = "along"; $("slab-pos").value = "0"; $("slab-turn").value = "0"; }
    else if (v?.section?.startsWith("x-")) { $("slab-mode").value = "across"; $("slab-pos").value = String(v.alongKm ?? 0); $("slab-turn").value = "0"; }
    if ($("show-curtain").checked) this.redraw();
  }
  stepSlab(dir) { const e = $("slab-pos"); e.value = String(Math.max(+e.min, Math.min(+e.max, +e.value + dir * 3))); this.custom(); this.redraw(); }
  sweepSlab() {
    if (this.sweepT) { clearInterval(this.sweepT); this.sweepT = null; $("slab-sweep").textContent = "▶ sweep"; return; }
    const e = $("slab-pos");
    if (+e.value >= +e.max - 1) e.value = e.min;
    $("slab-sweep").textContent = "■ stop";
    this.sweepT = setInterval(() => {
      if (+e.value >= +e.max) return this.sweepSlab();
      e.value = String(+e.value + 1.5); this.redraw();
      if ($("pt-range").value === "xslab") this.updateParticles();
    }, 120);
  }
  // Labels hidden when something is in front of them, each frame:
  //   the cross-section: a vertical rectangle, so a line-through-rectangle test (its own height
  //     ticks are exempt)
  //   the terrain: the drawn ground height sampled about every km along the line of sight
  //     (the last 2 km before the label skipped, so a label on a hillside doesn't hide itself)
  // Hidden labels also stay out of saved pictures (export.js).
  occludeLabels() {
    const labels = [];
    this.stage.scene.traverse((o) => { if (o.isCSS2DObject) labels.push(o); });
    // Behind the section: hidden only when it's solid (≥ 90% opacity), like the 3D markers behind it.
    const sec = $("show-curtain").checked && this.vol && this.lastPath?.geom && CurtainLayer.solid(this.curtain.opacity) ? this.lastPath.geom : null;
    const C = this.stage.camera.position, P = this.scratchV ||= new THREE.Vector3();
    let ux = 0, uy = 0, nx = 0, ny = 0, um = 1, Hs = 0, dc = 0;
    if (sec) {
      um = Math.hypot(sec.u.x, sec.u.y) || 1; ux = sec.u.x / um; uy = sec.u.y / um; nx = -uy; ny = ux;
      Hs = (Math.min(this.top || 5000, 5000) / 1000) * this.stage.vex;
      dc = (C.x - sec.c.x) * nx + (C.y - sec.c.y) * ny;
    }
    const ground = this.groundKm;
    // Each label's result is kept against everything it depends on (camera, exaggeration, ground,
    // the solid section, the label's own position) and recomputed only when one changes: during
    // playback with the camera still, this pass is nearly free (performance review).
    const sig = `${C.x},${C.y},${C.z}|${this.stage.vex}|${this.groundVer ?? 0}|${sec ? `${sec.c.x},${sec.c.y},${sec.u.x},${sec.u.y},${sec.t0},${sec.t1},${Hs}` : ""}`;
    const memo = (this.occMemo ||= new WeakMap());
    for (const o of labels) {
      o.getWorldPosition(P);
      const m = memo.get(o);
      if (m && m.sig === sig && m.x === P.x && m.y === P.y && m.z === P.z) {
        const v = m.hide ? "hidden" : "";
        if (o.element.style.visibility !== v) o.element.style.visibility = v;
        continue;
      }
      let own = false;
      for (let q = o.parent; q; q = q.parent) if (q === this.curtain.group) { own = true; break; }
      let hide = false;
      if (sec && !own) {
        const dp = (P.x - sec.c.x) * nx + (P.y - sec.c.y) * ny;
        if (dc * dp < 0) {
          const s = dc / (dc - dp), x = C.x + s * (P.x - C.x), y = C.y + s * (P.y - C.y), z = C.z + s * (P.z - C.z);
          const a = ((x - sec.c.x) * ux + (y - sec.c.y) * uy) / um;
          hide = a >= sec.t0 && a <= sec.t1 && z >= 0 && z <= Hs;
        }
      }
      if (!hide && ground && !own) {
        const dx = P.x - C.x, dy = P.y - C.y, dz = P.z - C.z, L = Math.hypot(dx, dy);
        const n = Math.min(240, Math.ceil(L)), end = Math.max(0, 1 - 2 / (L || 1));   // ~1 km steps, stop 2 km short
        for (let k = 1; k < n; k++) {
          const f = (k / n) * end, z = C.z + dz * f;
          if (ground(C.x + dx * f, C.y + dy * f) > z + 0.03) { hide = true; break; }
        }
      }
      memo.set(o, { sig, x: P.x, y: P.y, z: P.z, hide });
      const v = hide ? "hidden" : "";
      if (o.element.style.visibility !== v) o.element.style.visibility = v;
    }
    this.declutterObs(labels);
  }

  // Observation labels that overlap on screen: the water stations win (buoy, then coastal),
  // airports give way. They come back as you zoom in and they separate.
  declutterObs(labels) {
    const cam = this.stage.camera, W = window.innerWidth, H = window.innerHeight, P = this.scratchV2 ||= new THREE.Vector3();
    const rank = (el) => (el.classList.contains("land") ? 1 : 2);
    const items = [];
    for (const o of labels) {
      const el = o.element;
      if (!el.classList.contains("obs") || el.style.visibility === "hidden") continue;
      o.getWorldPosition(P).project(cam);
      if (P.z > 1) continue;
      const w = el.offsetWidth || 40, h = el.offsetHeight || 14, x = ((P.x + 1) / 2) * W - w / 2, y = ((1 - P.y) / 2) * H + 24;
      items.push({ el, r: rank(el), x, y, w, h, tip: el.dataset.tip });
    }
    items.sort((a, b) => b.r - a.r);
    const kept = [];
    for (const it of items) {
      const hit = kept.some((k) => it.x < k.x + k.w + 2 && k.x < it.x + it.w + 2 && it.y < k.y + k.h + 1 && k.y < it.y + it.h + 1);
      if (hit) it.el.style.visibility = "hidden"; else kept.push(it);
    }
    this.obsHits = kept;
  }
  // The observation label under a screen point (its tooltip text), for the hover readout.
  obsAt(cx, cy) { return (this.obsHits || []).find((k) => cx >= k.x - 2 && cx <= k.x + k.w + 2 && cy >= k.y - 2 && cy <= k.y + k.h + 2)?.tip || null; }

  // Point the camera straight at the section: centred on the part of it nearest to where you're
  // looking, close enough that its height fills about half the visible screen (a whole-domain
  // section is ~300 km long and ~15 km tall: fitting all of it gives a thin ribbon), from the side
  // with less terrain in the way, and raised just enough to look over any ridge between the
  // camera and the section's lower part.
  faceSlab() {
    const g = this.slabGeom();
    if (!g) return;
    const st = this.stage, vex = st.vex, L = g.t1 - g.t0, tgt = st.controls.target;
    const Hs = (Math.min(this.top || 5000, 5000) / 1000) * vex;           // the section's height on screen (km)
    const r = st.visibleRect(), tanHalf = Math.tan((st.camera.fov * Math.PI) / 360);
    const tanV = (tanHalf * r.h) / r.H, tanH = (tanHalf * r.w) / r.H;
    const d = Math.min(Math.max(L / 2 / tanH, Hs / 2 / tanV) * 1.1, Hs / 2 / tanV / 0.5);   // the whole section if short, else half-screen tall
    const half = Math.min(L / 2, d * tanH);                                        // half the length in view
    const um = Math.hypot(g.u.x, g.u.y) || 1;
    const tNear = ((tgt.x - g.c.x) * g.u.x + (tgt.y - g.c.y) * g.u.y) / (um * um);  // the section point nearest the current target
    const tm = Math.max(g.t0 + half, Math.min(g.t1 - half, tNear));
    const mid = { x: g.c.x + g.u.x * tm, y: g.c.y + g.u.y * tm, z: Hs * 0.45 };
    const nm = Math.hypot(g.n.x, g.n.y) || 1, nx = g.n.x / nm, ny = g.n.y / nm;
    // Elevation angle needed on each side so the sight lines clear the ground to 1/4 up the section.
    const zb = Hs * 0.25;
    const need = (side) => {
      let a = 0;
      for (const f of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]) {                 // across the part in view
        const t = tm + half * f, bx = g.c.x + g.u.x * t, by = g.c.y + g.u.y * t;
        for (let k = 1; k <= 16; k++) {
          const sd = (d * k) / 16, gz = this.groundKm(bx + nx * sd * side, by + ny * sd * side);
          a = Math.max(a, Math.atan2(gz - zb, sd));
        }
      }
      return a;
    };
    const cam = st.camera.position, here = Math.sign((cam.x - mid.x) * nx + (cam.y - mid.y) * ny) || 1;
    const aHere = need(here), aThere = need(-here), deg = Math.PI / 180;
    const side = aThere < aHere - 2 * deg ? -here : here;                  // stay on this side unless the other is clearly clearer
    const elev = Math.min(35 * deg, Math.max(8 * deg, Math.min(aHere, aThere) + 3 * deg));
    st.flyTo({ pos: { x: mid.x + nx * side * d * Math.cos(elev), y: mid.y + ny * side * d * Math.cos(elev), z: mid.z + d * Math.sin(elev) }, target: mid });
  }

  // The height controls live under the slice; they're also needed by particles "at the slice height".
  syncSliceBox() {
    const pt = $("show-particles").checked, range = $("pt-range").value;
    const slice = $("show-slice").checked, pinned = pt && (range === "slice" || range === "hslab");
    $("slice-box").hidden = !(slice || pinned);
    $("slice-why").hidden = slice || !pinned;
    $("slice-thick-row").hidden = !(pt && range === "hslab");
    const xs = pt && range === "xslab";
    $("slab-box").hidden = !($("show-curtain").checked || xs);
    $("slab-why").hidden = $("show-curtain").checked || !xs;
    $("slab-width-row").hidden = !xs;
    // Where the slab's own controls are (they're shared with the cross-section / slice).
    const note = $("pt-where-note");
    note.hidden = !(pt && (xs || range === "hslab" || range === "slice"));
    const html = xs ? `Move, turn and sweep the slab with the <a href="#" data-go="slab-box">cross-section controls ↑</a>.`
      : `Height: the <a href="#" data-go="slice-box">slice height slider ↑</a>.`;
    if (note.innerHTML !== html) note.innerHTML = html;
    $("slice-thick-val").textContent = `± ${(+$("slice-thick").value).toLocaleString()} m (${Math.round(+$("slice-thick").value * 3.28084 / 10) * 10} ft)`;
    $("slab-width-val").textContent = `± ${(+$("slab-width").value).toFixed(1)} km`;
    $("pt-interp").disabled = range === "xslab" || range === "hslab";
    $("pt-interp").closest("label").title = $("pt-interp").disabled ? "Slab particles always move freely in 3D (interpolated)." : $("pt-interp").closest("label").title;
  }

  redraw() {
    this.syncSliceBox();
    this.ensureTke();
    $("height-val").textContent = heightLabel(this.vol, this.spec.h, this.spec.ref);
    if (!this.vol) return;
    this.checkNeeds();                                          // anything on screen not loaded yet: fetch it, redraw when in
    const vex = this.stage.vex, f = COLOUR_BY[this.spec.field];
    // One colour range for slice and cross-section, so the same colour means the same value.
    let range = f.range;
    if (!range) {
      const vals = this.slice.values(this.vol, this.spec);
      let lo = Infinity, hi = -Infinity;
      for (const x of vals) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      range = Number.isFinite(lo) ? [Math.floor(lo) - 2, Math.ceil(hi) + 2] : [0, 1];
    }
    let holes = 0;
    if (f.column2d) this.channel.ensureField();                  // the Froude field for this hour and cap setting
    if ($("show-slice").checked) holes = this.slice.build(this.vol, this.proj, { ...this.spec, surf: this.surf, smooth: $("smooth").checked, geoKey: `${this.region?.id}|${this.groundVer ?? 0}`,
      gusty: $("slice-gusty").checked, gust: $("slice-gusty").checked ? this.gustData() : null }, vex, this.drapeKm(), range).holesPct; else this.slice.clear();
    this.gustTick();
    const path = $("show-curtain").checked ? this.sectionPath() : null;
    $("curtain-where").textContent = $("show-curtain").checked ? (path ? path.label : "the section is outside the domain: Square up") : "";
    if (path) this.curtain.build(this.vol, this.proj, path.pts, this.spec, Math.min(this.top, 5000), vex, this.groundKm, range);
    else this.curtain.clear();
    this.placeCoast();
    this.drawClouds();
    this.drawFog();
    this.drawSatellite();
    this.drawWaves();
    this.drawCurrents();
    this.drawKeys2();
    this.passage?.syncRun(); this.passage?.onTime(this.validDate());
    // The surface viewer follows the time on screen (and new data for it).
    const ik = this.inspectXY && !this.inspector.el.hidden ? [Math.round((this.t ?? 0) * 4) / 4, this.vol0?.raw.version, this.vol1?.raw.version, this.fetchGrid ? 1 : 0, this.swellHour?.key, this.curKey, ...this.inspectXY, ...(this.replayPos || []).map((v) => v.toFixed(0))].join("|") : null;
    if (ik && ik !== this.inspectKey) { this.inspectKey = ik; this.inspectPoint(...this.inspectXY); }
    this.lastPath = path;
    if (!this.playing || !this.lastGlyphs || performance.now() - this.lastGlyphs > 500) this.drawGlyphs(path);   // playing: twice a second (streamlines ~12 ms)
    this.drawInversion(path);
    if (!this.playing || !this.turbDrawnFor || this.turbDrawnFor !== this.nearest()) this.drawTurbulence();
    const [lo, hi] = range, mid = (lo + hi) / 2, fmt = (x) => (Math.abs(x) < 10 && x % 1 ? x.toFixed(1) : Math.round(x));
    const where = f.column2d ? "· one value per column (the cap set in Channel analysis)" : f.surfaceOnly ? "at the surface" : $("show-slice").checked ? `at ${heightLabel(this.vol, this.spec.h, this.spec.ref)}` : "";
    const fifteen = this.surf && this.spec.ref === "agl" && this.spec.h <= 10 && ["speed", "gust", "gustf"].includes(this.spec.field) ? " · 15-min data" : "";
    const full = `${f.label}${f.units === "class" ? "" : ` (${f.ramp === "uw" ? unitLabel() : f.units})`} ${where}${fifteen}${f.hrrrOnly && !this.model?.tke ? " · not in this model's output (HRRR only)" : f.hrrrOnly && !this.nearest()?._tke ? " · loading…" : ""}${f.proxy ? (/proxy/i.test(f.label) ? ` · no TKE in ${this.modelName()}` : ` · a proxy (no TKE in ${this.modelName()})`) : ""}` + (holes >= 0.5 && $("show-slice").checked && f.ramp !== "ri" ? ` · holes: ${f.column2d ? "no capping layer found (Froude number undefined)" : f.surfaceOnly ? "surface only" : "no data at this height (below ground, or w/vorticity under the lowest pressure level)"}` : "");
    // The key's title: short ("10 m wind speed (kt)"); the details in its hover text.
    const unit = f.units === "class" ? "" : ` (${f.ramp === "uw" ? unitLabel() : f.units})`, lc = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
    const agl = !f.column2d && !f.surfaceOnly && $("show-slice").checked && this.spec.ref === "agl";
    const warn = f.hrrrOnly && !this.model?.tke ? " · not in this model (HRRR only)" : f.hrrrOnly && !this.nearest()?._tke ? " · loading…" : "";
    $("legend-title").textContent = (agl ? `${Math.round(this.spec.h)} m ${lc(f.label)}${unit}` : `${f.label}${unit}${f.surfaceOnly ? " at the surface" : f.column2d ? " (per column)" : $("show-slice").checked ? ` at ${Math.round(this.spec.h).toLocaleString("en-US")} m above sea level` : ""}`) + warn;
    $("legend-title").title = full.replace(/\s+/g, " ").trim();
    let bar, ticks;
    if (f.ramp === "uw") ({ bar, ticks } = uwLegend());
    else if (f.ramp === "ri") {
      bar = document.createElement("canvas"); bar.width = 256; bar.height = 12;
      const g = bar.getContext("2d");
      f.classes.forEach((k, i) => { g.fillStyle = `rgb(${k.colour.map((x) => x * 255 | 0)})`; g.fillRect(i * 128, 0, 128, 12); });
      ticks = f.classes.map((k, i) => [k.label, (i + 0.5) / 2]);
    }
    else { bar = legendBar(RAMPS[f.ramp]); ticks = [[String(fmt(lo)), 0], [String(fmt(mid)), 0.5], [String(fmt(hi)), 1]]; }
    if (f.ramp === "uw" && unitLabel() !== "kt") ticks = ticks.map(([t, fr]) => [t.replace(/\d+(\.\d+)?/, (x) => String(Math.round(fromKt(+x)))), fr]);
    // No fill: no colour key, unless the wind symbols are coloured by speed (then it's their key).
    const symbolsBySpeed = $("glyph-colour").value === "speed" && ($("wind-barbs").checked || $("wind-stream").checked);
    const filled = $("show-slice").checked || $("show-curtain").checked;
    $("legend").hidden = (!!f.none || !filled) && !symbolsBySpeed;
    if (f.none && symbolsBySpeed) { $("legend-title").textContent = `Wind symbols by speed (${unitLabel()})`; $("legend-title").title = `Barbs and streamlines coloured by wind speed (${unitLabel()}) ${where}`; }
    const ctx = $("legend-bar").getContext("2d"); ctx.clearRect(0, 0, 256, 12); ctx.drawImage(bar, 0, 0);
    $("legend-ticks").innerHTML = ticks.map(([t, fr]) => `<span style="left:${(fr * 100).toFixed(1)}%">${t}</span>`).join("");
    this.afterRedraw?.();
    this.channel?.update();
    this.probe?.refresh();                                     // the card under the cursor follows playback
    this.legend = { title: `${this.model.label} · ${f.label} (${f.units})${f.ramp === "uw" ? ", UW WRF wind bands" : ""}`, bar, ticks };
    this.stage.markDirty();
  }

  // Ground under an above-ground slice: the highest drawn terrain within half a model cell of
  // each vertex. The slice has a vertex every 2.5-3 km and the terrain one every 500 m, so
  // draping on the ground right under each vertex let ridges between them poke through
  // (blotchy over the islands); this keeps the sheet just clear of them.
  drapeKm() {
    const g = this.groundKm, v = this.vol;
    if (!g || !v) return g;
    const half = v.merc.cellSizeM(v.raw.crop.i0 + v.w / 2, v.raw.crop.j0 + v.h / 2) / 2000, d = [-1.2, -0.6, 0, 0.6, 1.2].map((k) => k * half);   // 5×5 over a bit more than the cell
    return (x, y) => { let m = 0; for (const dx of d) for (const dy of d) m = Math.max(m, g(x + dx, y + dy)); return m; };
  }

  // The model's 10 m wind (and gust) at a point, at the time on screen: {dir, kt, gustKt}.
  // For comparing with an observation at timeMs: null unless the screen is within 45 min of it.
  modelAtObs(lat, lon, timeMs) {
    const v = this.vol;
    if (!v || !this.cycle || this.t == null || Math.abs((timeMs - this.cycle.getTime()) / 3600e3 - this.t) > 0.75) return null;
    const q = v.merc.ij(lat, lon), i = Math.round(q.i - v.raw.crop.i0), j = Math.round(q.j - v.raw.crop.j0);
    if (i < 0 || j < 0 || i >= v.w || j >= v.h) return null;
    const c = j * v.w + i, S = this.surf;
    const u = S ? S.U[c] : v.sample("U", lat, lon, 10, true), w = S ? S.V[c] : v.sample("V", lat, lon, 10, true);
    const g = S?.G ? S.G[c] : v.raw.surface.GUST?.[c];
    if (!Number.isFinite(u) || !Number.isFinite(w)) return null;
    return { dir: ((Math.atan2(-u, -w) * 180) / Math.PI + 360) % 360, kt: Math.hypot(u, w) * KT_PER_MS, gustKt: Number.isFinite(g) ? g * KT_PER_MS : NaN };
  }

  // Day and night along the forecast slider (sun at the region's centre; dusk and dawn shaded
  // down to the sun 6° under the horizon), a tick each hour (taller every 6 h), and "now".
  drawSky() {
    const el = $("fhr");
    if (!this.cycle || !this.proj || !el.clientWidth) return;
    const W = el.clientWidth, H = 7, pad = 8, dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement("canvas"); c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.scale(dpr, dpr);
    const t0 = +el.min, t1 = +el.max, b = this.proj.box, ll = this.proj.toLatLon((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    const xOf = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
    for (let x = pad; x < W - pad; x++) {
      const t = t0 + ((x - pad) / (W - 2 * pad)) * (t1 - t0), e = sunElevation(this.cycle.getTime() + t * 3600e3, ll.lat, ll.lon);
      const f = Math.max(0, Math.min(1, (e + 6) / 8));           // 0 night … 1 day (from −6° to +2°)
      g.fillStyle = `rgb(${Math.round(28 + (212 - 28) * f)},${Math.round(52 + (232 - 52) * f)},${Math.round(64 + (238 - 64) * f)})`;
      g.fillRect(x, H - 4, 1, 4);
    }
    g.fillStyle = "rgba(6,34,42,.55)";
    for (let h = Math.ceil(t0); h <= t1; h++) { const x = Math.round(xOf(h)); g.fillRect(x, h % 6 ? H - 4 : H - 7, 1, h % 6 ? 4 : 7); }
    const now = (Date.now() - this.cycle.getTime()) / 3600e3;
    if (now >= t0 && now <= t1) { g.fillStyle = "#e8742a"; g.fillRect(Math.round(xOf(now)) - 1, 0, 2, H); }
    el.style.backgroundImage = `url(${c.toDataURL()})`;
    el.title = "Forecast time. Strip: day and night at the region's centre, a tick each hour (taller every 6 h), orange = now. Keys: space plays, ← → step 15 min (shift: 1 h).";
  }

  // Clouds for the time on screen (rebuilt per blended time, at most twice a second while playing).
  drawClouds() {
    const on = $("show-clouds").checked && this.vol;
    $("cloud-box").hidden = !on;
    if (!on) { if (this.clouds.meshes.some((m) => m.visible)) { this.clouds.hide(); this.stage.markDirty(); } return; }   // keeps the computed hours
    // Per model hour, cross-faded on the GPU between hours: cheap every step (no throttle needed).
    const r = this.clouds.show(this.vol0, this.frac > 0 ? this.vol1 : null, this.frac, this.proj, this.stage.vex, () => { this.drawClouds(); this.stage.markDirty(); });
    if (!r) { $("cloud-note").textContent = "Working out the model's clouds…"; this.stage.markDirty(); return; }
    const m = (x) => (Number.isFinite(x) ? `${Math.round(x).toLocaleString()} m (${Math.round(x * 3.28084 / 100) * 100} ft)` : "–");
    $("cloud-note").innerHTML = `Cloud over ${Math.round(r.cover * 100)}% of the map · typical base ${m(r.baseMedian)}, top ${m(r.topMedian)}.`
      + `<br>The model's own cloud water and ice (${this.model?.short || this.modelName()}), to 8 km: brighter is denser. Real model output, on its 2.5–3 km grid, so small cumulus are smoothed into broad patches.`;
    this.stage.markDirty();
  }

  // The fetch grid for the region (for the chop), from the ground layers' metadata.
  async setFetch(regionId, meta) {
    this.fetchGrid = null; this.zoneMap = null; this.cwf = null; this.zoneCells = new Map();
    this.loadZones(regionId);
    this.curData = null; this.curKey = null; this.curLoading = null; this.curCells = null; this.currents.clear();
    this.passage?.regionChanged(regionId);
    currentStations(regionId).then((st) => {
      if (this.region?.id !== regionId) return;
      $("cur-layer").hidden = !st.length;
      $("cur-src-row").hidden = regionId !== "salish-sea";           // (SSCOFS covers the Salish Sea only)
      if (!st.length) { $("show-cur").checked = false; $("cur-box").hidden = true; }
    });
    this.fetchGrid = await FetchGrid.load(regionId, meta).catch(() => null); this.seaKeyStr = null; this.redraw();
  }

  // The region's land mask (0.5 km) and distance to shore (km), for routing and the current field.
  landGrid() {
    const L = this.terrain?.land?.();
    if (!L) return null;
    if (this.landCache?.mask !== L.mask) this.landCache = { ...L, dist: shoreDistance(L.mask, L.nx, L.ny, L.dxy) };
    return this.landCache;
  }
  // The passage planner's fine water mask (200 m, from the ENC chart's depth areas; pipeline/routegrid.py),
  // loaded on first use, with its distance to shore; falls back to the 500 m land grid where there's none.
  async routeGrid() {
    const rid = this.region?.id;
    if (this.routeGridCache?.rid === rid) return this.routeGridCache.grid;
    let grid = null;
    try {
      const meta = await fetch(`data/${rid}/route-land.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null));
      if (meta) {
        const { gunzipTyped } = await import("./layers/ground.js?v=20261002173952");
        const bits = await gunzipTyped(`data/${rid}/${meta.file}`, Uint8Array), n = meta.nx * meta.ny, mask = new Uint8Array(n);
        for (let k = 0; k < n; k++) mask[k] = (bits[k >> 3] >> (k & 7)) & 1;
        // Channels narrower than the mask (Port Townsend Canal, Deception Pass): opened along their lines.
        const qp = await fetch(`data/${rid}/passages.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        for (const cut of qp?.cuts || []) {
          const P = cut.pts.map(([la, lo]) => this.proj.toXY(la, lo));
          for (let s = 1; s < P.length; s++) {
            const a0 = P[s - 1], b0 = P[s], steps = Math.ceil(Math.hypot(b0.x - a0.x, b0.y - a0.y) / (meta.dxy / 4));
            for (let k = 0; k <= steps; k++) {
              const x = a0.x + ((b0.x - a0.x) * k) / steps, y = a0.y + ((b0.y - a0.y) * k) / steps, i = Math.round((x - meta.x0) / meta.dxy), j = Math.round((y - meta.y0) / meta.dxy);
              for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < meta.nx && jj < meta.ny) mask[jj * meta.nx + ii] = 0; }
            }
          }
        }
        // Distance to shore: measured from the 50 m charted land where the pipeline stored it
        // (20 m units), else worked out from this mask. Cuts are water in either case.
        let dist = null;
        if (meta.distFile) {
          const u8 = await gunzipTyped(`data/${rid}/${meta.distFile}`, Uint8Array).catch(() => null);
          if (u8?.length === n) { dist = new Float32Array(n); for (let k = 0; k < n; k++) dist[k] = mask[k] === 1 ? 0 : Math.max(u8[k] * 0.02, 0.01); }
        }
        grid = { ...meta, mask, dist: dist || shoreDistance(mask, meta.nx, meta.ny, meta.dxy) };
      }
    } catch (e) { console.warn("route grid", e); }
    grid ||= this.landGrid();
    this.routeGridCache = { rid, grid };
    return grid;
  }
  // SSCOFS for the map (Salish Sea, with Currents from on SSCOFS): the mesh on the 200 m water once,
  // then the hours around the time on screen as it moves. Redraws the sea surface as they arrive.
  async ensureSscofs() {
    if (this.region?.id !== "salish-sea" || $("cur-src")?.value !== "sscofs" || !this.cycle) return;
    const rid = this.region.id;
    if (!this.sscofsMap || this.sscofsMap.rid !== rid) {
      if (this.sscofsOpening) return;
      this.sscofsOpening = true;
      try { const land = await this.routeGrid(); this.sscofsMap = { rid, f: await SscofsField.open(land, this.proj) }; }
      catch (e) { console.warn("SSCOFS", e); this.sscofsMap = { rid, f: null }; }
      finally { this.sscofsOpening = false; }
      this.curMixed = null;
    }
    const f = this.sscofsMap.f, t = this.validDate()?.getTime();
    if (!f || !t || !f.covers(t)) return;
    const need = [Math.floor((t - f.meta.cycleDate.getTime()) / 3600e3), Math.floor((t - f.meta.cycleDate.getTime()) / 3600e3) + 1].filter((l) => l >= 0 && !f.frames.has(l));
    if (!need.length) return;
    await f.prepare(t - 3600e3, t + 3 * 3600e3);
    this.sscofsStamp = (this.sscofsStamp || 0) + 1; this.seaKeyStr = null; this.inspectKey = null;
    this.drawWaves(); this.drawCurrents?.(); this.stage.markDirty();
  }
  // The current field between the stations (built once per station list and land mask).
  // (On the planner's 200 m water mask once it's loaded, so narrow channels have their currents;
  // the 500 m land grid until then.)
  currentField() {
    const L = (this.routeGridCache?.rid === this.region?.id && this.routeGridCache.grid) || this.landGrid();
    if (!L || !this.curData?.length) return null;
    if (this.curField?.stations !== this.curData || this.curField.land !== L.mask) { this.curField = new CurrentField(this.curData, L); this.curField.land = L.mask; }
    // SSCOFS where it has the time and place (Currents from), the stations elsewhere.
    const S = this.sscofsMap;
    if ($("cur-src")?.value === "sscofs" && S?.rid === this.region?.id && S.f) return (this.curMixed?.sscofs === S.f && this.curMixed.fallback === this.curField) ? this.curMixed : (this.curMixed = new MixedField(S.f, this.curField));
    return this.curField;
  }

  // Tidal current predictions for the run's time span (NOAA's, stored with the site), when anything uses them:
  // the current layer, or current effects on the waves with sea state on or the viewer open.
  wantsCurrents() {
    if ($("cur-layer").hidden) return false;
    return $("show-cur").checked || ($("cur-waves").checked && ($("show-sea").checked || !this.inspector.el.hidden));
  }
  ensureCurrents() {
    if (!this.cycle || !this.wantsCurrents()) return;
    const t0 = new Date(this.cycle.getTime() + (+$("fhr").min) * 3600e3), t1 = new Date(this.cycle.getTime() + (+$("fhr").max + 1) * 3600e3);
    const key = `${this.region.id}|${t0.toISOString()}|${t1.toISOString()}`, rid = this.region.id;
    if (this.curKey === key || this.curLoading === key) return;
    this.curLoading = key;
    $("cur-note").textContent = "Loading NOAA's current predictions…";
    loadCurrents(rid, t0, t1)
      .then((st) => {
        if (this.curLoading !== key || this.region?.id !== rid) return;
        for (const q of st) { const xy = this.proj.toXY(q.lat, q.lon); q.x = xy.x; q.y = xy.y; }
        this.curData = st; this.curKey = key; this.curLoading = null; this.curCells = null;
        this.seaKeyStr = null; this.redraw();
        if (this.inspectXY && !this.inspector.el.hidden) this.inspectPoint(...this.inspectXY);
      }, (e) => { if (this.curLoading === key) { this.curLoading = null; $("cur-note").textContent = `Current predictions unavailable: ${e.message}`; } });
  }
  // The current (u, v m/s toward east/north, kt, set, nearest station) at scene (x, y) for the time on screen.
  // (From the field between the stations, which doesn't reach across land; the nearest station
  // named for the readouts.)
  currentAt(x, y) {
    const d = this.validDate();
    if (!this.curData || !d) return null;
    const f = this.currentField(), n = currentNear(this.curData, x, y, d.getTime(), 8);
    if (!f) return n && n.km <= 5 ? n : null;
    const s = f.sample(x, y, d.getTime());
    if (!s) return null;
    const fromModel = !!(f.sscofs?.covers(d.getTime()) && f.sscofs.sample(x, y, d.getTime()));   // (SSCOFS gave it, not the stations)
    return { u: s.u, v: s.v, kt: Math.hypot(s.u, s.v) / 0.514444, set: ((Math.atan2(s.u, s.v) * 180) / Math.PI + 360) % 360, station: n?.station ?? { name: "nearby stations" }, km: n?.km ?? NaN, src: fromModel ? f.label : null };
  }
  // The chop at a station or point with the wind over the moving water, and what the current does to it.
  chopWithCurrent(x, y, w, cur) {
    const c = chopAt(this.fetchGrid, x, y, w[0] - cur.u, w[1] - cur.v);
    if (!c || !(c.hs > 0)) return null;
    const rw = Math.hypot(w[0] - cur.u, w[1] - cur.v) || 1;
    return { chop: c, ...chopOnCurrent(c.hs, c.tp, (w[0] - cur.u) / rw, (w[1] - cur.v) / rw, cur.u, cur.v) };
  }
  // The current layer: arrows at the stations for the time on screen, rings where wind opposes current.
  drawCurrents() {
    const on = $("show-cur").checked && !$("cur-layer").hidden && this.vol;
    $("cur-box").hidden = !on;
    this.ensureCurrents();
    if (!on || !this.curData) { if (this.currents.meshes.length || this.currents.wash || this.currents.fieldMeshes.length) { this.currents.clear(); this.currents.clearField(); this.stage.markDirty(); } this.curHaz = []; this.curFlow.clear(); return; }
    this.ensureSscofs();                                           // (SSCOFS for the field, when that's the source)
    const d = this.validDate(), t = d.getTime(), items = [], haz = [];
    for (const s of this.curData) {
      const c = stationCurrent(s, t), it = { x: s.x, y: s.y, kt: c.kt, set: c.set, rating: 0, name: s.name, id: s.id, type: s.type };
      if (this.fetchGrid && c.kt >= 0.3 && this.fetchGrid.at(s.x, s.y, 0) > 0) {
        const w = this.windAt10(s.lat, s.lon), r = w && this.chopWithCurrent(s.x, s.y, w, c);
        if (r?.rating) { it.rating = r.rating; haz.push({ s, c, w, r }); }
      }
      items.push(it);
    }
    const fill = $("cur-fill").checked, arrows = $("cur-arrows").value, grid = fill || arrows === "grid" ? this.curGridPair(t) : null, L = this.routeGridCache?.rid === this.region?.id ? this.routeGridCache.grid : null;
    if (!L && !this.curRgWait) { this.curRgWait = true; this.routeGrid().then(() => { this.curRgWait = false; this.drawCurrents(); }); }   // (the 200 m water grid and its shoreline, once)
    this.currents.setField(grid ? { gA: grid.gA, gB: grid.gB, f: grid.fr, fill, arrows: arrows === "grid", scale: +$("cur-scale").value, shore: L ? shoreMask(L) : null } : null);
    this.currents.setOpacity(+$("op-cur").value, +$("op-curarrows").value);
    this.currents.build({ stations: items, t, arrows, marks: $("cur-marks").value,
      scale: +$("cur-scale").value, flags: $("cur-flag").checked, names: $("cur-names").checked });
    this.updateFlow(t);
    this.drawKeys2();
    if (this.curGraphFor) this.drawCurGraph();
    haz.sort((a, b) => b.r.rating - a.r.rating || b.r.steep - a.r.steep);
    this.curHaz = haz;
    const top = [...items].sort((a, b) => b.kt - a.kt)[0], fast = this.curData[items.indexOf(top)];
    const ft = (m) => (m * 3.28084).toFixed(1), dir = (w) => String(Math.round(((Math.atan2(-w[0], -w[1]) * 180) / Math.PI + 360) % 360)).padStart(3, "0");
    const list = $("cur-flag").checked ? haz.slice(0, 5).map(({ s, c, w, r }) => `<br>${r.rating > 1 ? "🔴" : "🟠"} <b>${s.name}</b>: ${c.kt.toFixed(1)} kt setting ${String(Math.round(c.set)).padStart(3, "0")}° against ${Math.round(Math.hypot(w[0], w[1]) * 1.943844)} kt from ${dir(w)}° → chop ${ft(r.chop.hs)} → ${ft(r.hs)} ft at ${r.chop.tp.toFixed(1)} s, ${Math.round(r.L)} m apart (steepness ${r.steep.toFixed(2)}${r.blocked ? ", breaking" : ""})`).join("") : "";
    $("cur-note").innerHTML = `NOAA tidal current predictions at ${this.curData.length} stations for ${this.fhrLabel(this.t)}. Fastest: ${fast ? `${fast.name}, ${top.kt.toFixed(1)} kt` : "–"}.`
      + ($("cur-flag").checked ? `<br>Wind against current: ${haz.filter((h) => h.r.rating > 1).length} dangerous, ${haz.filter((h) => h.r.rating === 1).length} steep.${list}${haz.length > 5 ? `<br>…and ${haz.length - 5} more (rings on the map).` : ""}` : "")
      + (this.curData.until && Date.parse(this.curData.until) - Date.now() < 30 * 86400e3 ? `<br><b>The stored predictions end ${this.curData.until}</b>: refresh them (pipeline.currents).` : "")
      + `<br>Tidal predictions only (no wind-driven or river currents), at the stations; the sea state and viewer use the nearest stations within 5 km. Chop against a current gets shorter and higher (wave–current theory, capped where it breaks).`;
    this.stage.markDirty();
  }
  // The current's particles and streamlines: the field (SSCOFS or the stations') sampled on a
  // 400 m grid over the domain at time t (continuous, so playback flows), again after a minute of
  // forecast time has passed (at most 4 times a second); the streamlines are traced again after
  // 10 minutes.
  // The current (SSCOFS or the stations') on a 400 m grid over the domain at the forecast hours
  // either side of t, kept for the last three hours: the colour fill, the grid arrows, the
  // particles and the streamlines all blend these two. → {gA, gB, fr} or null
  curGridPair(t) {
    const f = this.currentField(), L = this.routeGridCache?.grid || this.landGrid(), dxy = 0.4;
    if (!f || !L) return null;
    const key = `${this.region?.id}|${f.label || "stations"}|${this.sscofsStamp || 0}|${L.nx}|${this.curKey}`;
    if (this.curGridKey !== key) { for (const g of this.curGrids?.values() || []) g.tex?.dispose(); this.curGrids = new Map(); this.curGridKey = key; }
    const grid = (h) => {
      if (this.curGrids.has(h)) return this.curGrids.get(h);
      const nx = Math.floor((L.nx * L.dxy) / dxy), ny = Math.floor((L.ny * L.dxy) / dxy), u = new Float32Array(nx * ny).fill(NaN), v = new Float32Array(nx * ny).fill(NaN);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const s = f.sample(L.x0 + i * dxy, L.y0 + j * dxy, h);
        if (!s) continue;
        const k = Math.min(1, (s.reach ?? 1) * 1.5);                  // (the stations' field fades out away from them)
        u[j * nx + i] = s.u * k; v[j * nx + i] = s.v * k;
      }
      const g = { x0: L.x0, y0: L.y0, dxy, nx, ny, u, v };
      this.curGrids.set(h, g);
      for (const [h0, g0] of this.curGrids) { if (this.curGrids.size <= 3) break; if (h0 === h) continue; g0.tex?.dispose(); this.curGrids.delete(h0); }
      return g;
    };
    const hA = Math.floor(t / 3600e3) * 3600e3, fr = (t - hA) / 3600e3, out = { gA: grid(hA), gB: fr > 1e-6 ? grid(hA + 3600e3) : null, fr };
    // (the hour after, in an idle moment, so playing into it doesn't stall)
    const next = hA + 2 * 3600e3, k0 = this.curGridKey;
    if (!this.curGrids.has(next) && !this.curGridIdle) { this.curGridIdle = true; (window.requestIdleCallback || setTimeout)(() => { this.curGridIdle = false; if (this.curGridKey === k0) grid(next); }, { timeout: 2000 }); }
    return out;
  }
  // The current's particles and streamlines (layers/curflow.js), from curGridPair; the streamlines
  // are traced again after 10 minutes of forecast time (or a view change).
  updateFlow(t) {
    const F = this.curFlow, parts = $("cur-parts").checked, lines = $("cur-lines").checked, P = parts || lines ? this.curGridPair(t) : null;
    if (!P) { F.clear(); return; }
    const relines = F.grid?.x0 !== P.gA.x0 || Math.abs(t - (this.curFlowLinesT ?? -Infinity)) >= 600e3;
    if (relines) this.curFlowLinesT = t;
    F.set({ particles: parts, lines, density: +$("cur-density").value, speed: +$("cur-speed").value });   // (rebuilds what a changed setting needs)
    F.setGrid(P.gA, relines, P.gB, P.fr);
    F.setOpacity(+$("op-curparts").value, +$("op-curlines").value);
    this.stage.markDirty();
  }
  // NWS marine zones (outlines shipped with the site) and their coastal waters forecast (live).
  async loadZones(regionId) {
    const zm = await ZoneMap.load(regionId).catch(() => null);
    if (this.region?.id !== regionId) return;
    this.zoneMap = zm;
    $("sea-zone").innerHTML = zm ? zm.zones.map((z) => `<option value="${z.id}"${z.id === zm.default ? " selected" : ""}>${z.id} ${z.name}</option>`).join("") : "";
    if (!zm) return;
    this.cwfErr = null;
    loadCwf(zm.office).then((c) => { if (this.region?.id === regionId) { this.cwf = c; this.drawZoneCompare(); this.probe?.refresh(); } },
      (e) => { this.cwfErr = e.message; this.drawZoneCompare(); });
  }
  // The surface fill's gustiness: gust per cell (m/s: 15-minute when in) and the 10 m wind there.
  gustData() {
    const v = this.vol, G = this.surf?.G || v?.raw.surface.GUST;
    if (!G) return null;
    const S = this.surf, A = this.vol0?.raw.agl[10], B = this.frac > 0 ? this.vol1?.raw.agl[10] : null, t = this.frac;
    const wind = (c) => S ? [S.U[c], S.V[c]] : A?.UGRD ? [B ? A.UGRD[c] + (B.UGRD[c] - A.UGRD[c]) * t : A.UGRD[c], B ? A.VGRD[c] + (B.VGRD[c] - A.VGRD[c]) * t : A.VGRD[c]] : [0, 0];
    return { G, wind };
  }
  // While the gust shimmer is showing: advance its clock and redraw every frame.
  gustTick() {
    const on = () => $("slice-gusty").checked && this.slice.gustyOn && this.slice.mesh?.visible !== false && $("show-slice").checked;
    if (!on() || this.gustTicking) return;
    this.gustTicking = true;
    const b = this.proj.box, adv = (Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1000 * 0.03) / 10 / 1000, t0 = performance.now();   // the particles' speed-up, km per (m/s) per s
    const loop = (now) => {
      if (!on()) { this.gustTicking = false; this.stage.markDirty(); return; }
      const u = this.slice.mesh.material.userData.ramp;
      u.uT.value = (now - t0) / 1000; u.uAdv.value = adv;
      this.stage.markDirty();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  // Gust factor per model cell for the time on screen (gust ÷ 10 m wind, at least 1; wind under
  // 2 m/s counts as 2) and the mixed-layer depth it applies to, for the particles' gustiness.
  gustField() {
    const v = this.vol, n = v?.n;
    if (!v || !v.raw.surface.GUST) return [null, null];
    const G = this.surf?.G || v.raw.surface.GUST, S = this.surf, A = this.vol0?.raw.agl[10], B = this.frac > 0 ? this.vol1?.raw.agl[10] : null, t = this.frac;
    const gf = (this._gf?.length === n ? this._gf : (this._gf = new Float32Array(n)));
    for (let c = 0; c < n; c++) {
      let u, w;
      if (S) { u = S.U[c]; w = S.V[c]; } else if (A?.UGRD) { u = B ? A.UGRD[c] + (B.UGRD[c] - A.UGRD[c]) * t : A.UGRD[c]; w = B ? A.VGRD[c] + (B.VGRD[c] - A.VGRD[c]) * t : A.VGRD[c]; } else { gf[c] = 1; continue; }
      const g = G[c] / Math.max(2, Math.hypot(u, w));
      gf[c] = Number.isFinite(g) ? Math.min(3, Math.max(1, g)) : 1;
    }
    return [gf, this.nearest()?.raw.surface.HPBL || null];
  }
  // HRRR's TKE (model/tke.js) for the hours on screen, when Colour by TKE or the particles'
  // turbulence jitter wants it: loaded once per hour (~5 MB), then a redraw.
  wantsTke() { return !!this.model?.tke && this.isLive() && (this.spec.field === "tke" || $("pt-tke").checked); }
  ensureTke(vols = [this.vol0, this.vol1]) {
    $("pt-tke-row").hidden = !this.model?.tke;
    if (!this.wantsTke()) return;
    for (const V of vols) {
      if (!V || V._tke || V._tkeP) continue;
      V._tkeP = loadTke(this.model, this.cycle, V.raw.fhr, V.raw.crop).then((T) => {
        V._tke = T;
        if (V === this.vol0 || V === this.vol1) { this.slice.key = null; this.redraw(); this.updateParticles(); }
      }, (e) => { V._tkeP = null; this.setState?.(`TKE: ${e.message}`); });
    }
  }
  // The layer controls in the Wind and Sea & weather tabs need a loaded run; until then, a note.
  showModelControls(on) {
    for (const el of document.querySelectorAll(".needs-model")) el.hidden = !on;
    for (const el of document.querySelectorAll(".no-model")) el.hidden = on;
  }
  // The model at a place for the time on screen (places.js card): 10 m wind and gust, chop and
  // swell when on the water, and the NWS zone forecast. HTML, or "" with no run loaded.
  placeReport(lat, lon) {
    const v = this.vol;
    if (!v || !this.proj) return "";
    const out = [`<b>Model</b> · ${this.fhrLabel(this.t)}`], w = this.windAt10(lat, lon);
    if (w) {
      const q = v.merc.ij(lat, lon), c = Math.round(q.j - v.raw.crop.j0) * v.w + Math.round(q.i - v.raw.crop.i0);
      const g = this.surf?.G?.[c] ?? v.raw.surface.GUST?.[c], dir = ((Math.atan2(-w[0], -w[1]) * 180) / Math.PI + 360) % 360;
      out.push(`Wind ${String(Math.round(dir) % 360).padStart(3, "0")}° ${fmtSpeed(Math.hypot(w[0], w[1]) * 1.943844)}${Number.isFinite(g) ? ` · gust ${fmtSpeed(g * 1.943844)}` : ""} (10 m)`);
    }
    const xy = this.proj.toXY(lat, lon), ch = w && this.fetchGrid ? chopAt(this.fetchGrid, xy.x, xy.y, w[0], w[1]) : null;
    if (ch && ch.hs > 0.01) out.push(`Chop ${(ch.hs * 3.28084).toFixed(1)} ft at ${ch.tp.toFixed(1)} s`);
    const wm = this.swellHour ? wavesAt(this.swellHour, lat, lon) : null;
    if (wm?.swell?.length) out.push(`Swell ${wm.swell.map((x) => `${(x.hs * 3.28084).toFixed(1)} ft ${Math.round(x.tp)} s from ${Math.round(x.dir)}°`).join(" · ")}`);
    const n = this.nwsAt(lat, lon);
    if (n?.period) out.push(`NWS ${n.zone.id} ${n.period.name.toLowerCase()}: ${periodSummary(n.period)}`);
    return out.join("<br>");
  }
  validDate() { return this.cycle && this.t != null ? new Date(this.cycle.getTime() + this.t * 3600e3) : null; }
  // The NWS zone at a point (or by id), its forecast and the period covering the time on screen.
  nwsAt(lat, lon, id = null) {
    const z = id ? this.zoneMap?.byId(id) : this.zoneMap?.at(lat, lon);
    if (!z) return null;
    const fc = this.cwf?.zones[z.id] || null, valid = this.validDate();
    return { zone: z, fc, period: fc && valid ? periodAt(fc, valid) : null };
  }
  // Model against the NWS forecast for the chosen zone, for the period covering the time on screen.
  drawZoneCompare() {
    const el = $("sea-nws");
    if (!el || $("sea-box").hidden) return;
    const id = $("sea-zone").value, zm = this.zoneMap;
    if (!zm || !id) { el.innerHTML = ""; return; }
    if (!this.cwf) { el.innerHTML = this.cwfErr ? `NWS forecast unavailable: ${this.cwfErr}.` : "Loading the NWS coastal waters forecast…"; return; }
    const n = this.nwsAt(0, 0, id), fc = n.fc, p = n.period, z = n.zone;
    const iss = new Intl.DateTimeFormat("en-US", { timeZone: this.region.tz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(this.cwf.issued);
    const src = `NWS ${zm.office === "HFO" ? "Honolulu" : "Seattle"} coastal waters forecast, issued ${iss}; period times approximate (day 6 am–6 pm, night 6 pm–6 am).`;
    if (!fc) { el.innerHTML = `No NWS text for ${z.id} in the latest forecast. ${src}`; return; }
    if (!p) { el.innerHTML = `<b>${z.id} ${z.name}</b>: the time on screen is outside the forecast's periods (${fc.periods[0]?.name.toLowerCase()} to ${fc.periods.at(-1)?.name.toLowerCase()}). ${src}`; return; }
    const m = this.zoneModel(z);
    const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–"), r0 = (x) => (Number.isFinite(x) ? Math.round(x) : "–");
    // The model's typical value against the forecaster's range (or single value).
    // Tolerance: 20% under / 25% over, and at least tol (3 kt for wind, 1 ft for heights).
    const flag = (x, lo, hi, tol = 1) => {
      if (!Number.isFinite(x) || hi == null) return "";
      if (x < lo - Math.max(tol, 0.2 * lo)) return `<span class="flag" title="The model's typical value is well under the NWS forecast">▼ lower</span>`;
      if (x > hi + Math.max(tol, 0.25 * hi)) return `<span class="flag" title="The model's typical value is well over the NWS forecast">▲ higher</span>`;
      return `<span class="flag" title="Within the NWS forecast, give or take 20–25% (at least 3 kt or 1 ft)">≈</span>`;
    };
    const rng = (r) => (r ? (r.min === r.max ? `${r.max}` : r.min === 0 ? `≤ ${r.max}` : `${r.min}–${r.max}`) : "–");
    const chopT = p.trains.filter((t) => t.kind === "chop"), swellT = p.trains.filter((t) => t.kind === "swell");
    const tr = (a) => a.map((t) => `${compass(t.dir)} ${t.ft} ft ${t.tp} s`).join(", ");
    const comb = (a) => Math.sqrt(a.reduce((s, t) => s + t.ft * t.ft, 0));
    const seasR = p.seas || p.waves;
    const rows = [["Wind", p.wind ? `${compass(p.wind.dir)} ${rng(p.wind)} kt` : "–", m ? `${compass(m.windDir)} ${r0(m.wind[0])} · ${r0(m.wind[1])} kt` : "–", m && p.wind ? flag(m.wind[0], p.wind.min, p.wind.max, 3) : ""],
      [p.seas ? "Seas" : "Waves", seasR ? `${rng(seasR)} ft${p.seas?.then ? `, ${p.seas.then.trend} to ${rng(p.seas.then)}` : ""}` : "–", m ? `${f1(m.total[0])} · ${f1(m.total[1])} ft` : "–", m && seasR ? flag(m.total[0], seasR.min, seasR.max) : ""]];
    if (chopT.length) rows.push(["Chop", tr(chopT), m ? `${f1(m.chop[0])} · ${f1(m.chop[1])} ft, ${f1(m.chopTp)} s` : "–", m ? flag(m.chop[0], comb(chopT), comb(chopT)) : ""]);
    if (swellT.length || m?.swellTrains.length) {
      const ms = m ? Math.sqrt(m.swellTrains.reduce((a, s) => a + (s.hs * 3.28084) ** 2, 0)) : NaN;
      rows.push(["Swell", swellT.length ? tr(swellT) : "none given", m ? (m.swellTrains.length ? m.swellTrains.map((s) => `${compass(s.dir)} ${f1(s.hs * 3.28084)} ft ${Math.round(s.tp)} s`).join(", ") : "none") : "–", m && swellT.length ? flag(ms, comb(swellT), comb(swellT)) : ""]);
    }
    el.innerHTML = `<b>${z.id} ${z.name}</b> · ${p.name.toLowerCase()}${fc.headline ? ` · <b>${fc.headline.toLowerCase()}</b>` : ""}`
      + `<table><tr><th></th><th>NWS</th><th>Model: typical · 1 in 10 above</th><th></th></tr>`
      + rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("") + `</table>`
      + `Model over the zone's water: the ${this.model?.short || this.modelName()} 10 m wind, our chop (wind for ${$("sea-duration").selectedOptions[0].text}) and NOAA's swell${m?.swellTrains.length ? " (its trains near the zone's centre)" : ""}. NWS seas are the height of all the waves together, like our total. ${src}`;
  }
  // The model over one zone's water: fetch-grid cells inside its outline (cached per zone).
  zoneModel(z) {
    const F = this.fetchGrid;
    if (!F || !this.vol) return null;
    let cells = this.zoneCells.get(z.id);
    if (!cells) {
      cells = [];
      const step = F.nx * F.ny > 120000 ? 2 : 1;
      for (let j = 0; j < F.ny; j += step) for (let i = 0; i < F.nx; i += step) {
        const x = F.x0 + i * F.dxy, y = F.y0 + j * F.dxy;
        if (!(F.at(x, y, 0) > 0)) continue;
        const ll = this.proj.toLatLon(x, y);
        if (this.zoneMap.at(ll.lat, ll.lon)?.id === z.id) cells.push([x, y, ll.lat, ll.lon]);
      }
      this.zoneCells.set(z.id, cells);
    }
    if (!cells.length) return null;
    const wind = [], chop = [], total = [], tps = [], sh = this.swellHour;
    let su = 0, sv = 0;
    for (const [x, y, la, lo] of cells) {
      const w = this.windAt10(la, lo);
      if (!w) continue;
      su += w[0]; sv += w[1]; wind.push(Math.hypot(w[0], w[1]) * 1.943844);
      const c = chopAt(F, x, y, w[0], w[1]), s2 = sh ? swellHs2At(sh, la, lo) ?? 0 : 0, hc = c ? c.hs : 0;
      chop.push(hc * 3.28084); total.push(Math.sqrt(hc * hc + s2) * 3.28084);
      if (c?.tp) tps.push(c.tp);
    }
    const q = (a) => { if (!a.length) return [NaN, NaN]; a.sort((p, r) => p - r); return [a[a.length >> 1], a[Math.floor(a.length * 0.9)]]; };
    const [lon, lat] = z.label, wm = sh ? wavesAt(sh, lat, lon) : null;
    return { wind: q(wind), windDir: ((Math.atan2(-su, -sv) * 180) / Math.PI + 360) % 360, chop: q(chop), chopTp: q(tps)[0], total: q(total), swellTrains: wm?.swell || [] };
  }
  // 10 m wind at a point for the time on screen: the 15-minute data when in, else the volume.
  windAt10(lat, lon) {
    const v = this.vol;
    if (!v) return null;
    const q = v.merc.ij(lat, lon), i = Math.round(q.i - v.raw.crop.i0), j = Math.round(q.j - v.raw.crop.j0);
    if (i < 0 || j < 0 || i >= v.w || j >= v.h) return null;
    const c = j * v.w + i;
    if (this.surf) return [this.surf.U[c], this.surf.V[c]];
    // The hours' own 10 m arrays, blended (same values as the column lookup at 10 m, much cheaper).
    const A = this.vol0?.raw.agl[10], B = this.frac > 0 ? this.vol1?.raw.agl[10] : null, t = this.frac;
    if (A?.UGRD && this.vol0.w === v.w && (!B || B.UGRD)) return B ? [A.UGRD[c] + (B.UGRD[c] - A.UGRD[c]) * t, A.VGRD[c] + (B.VGRD[c] - A.VGRD[c]) * t] : [A.UGRD[c], A.VGRD[c]];
    return [v.column("U", c, v.terrain[c] + 10), v.column("V", c, v.terrain[c] + 10)];
  }
  // Sea state (chop) for the time on screen.
  drawWaves() {
    this.drawKeys2();
    const on = $("show-sea").checked && this.vol;
    $("sea-box").hidden = !on;
    if (!on) {
      if (this.waves.mesh || this.waves.arrows) { this.waves.clear(); this.stage.markDirty(); }
      for (const F of this.seaFrames.values()) WaveLayer.dispose(F); this.seaFrames.clear(); this.seaKeyStr = null; return;
    }
    if (!this.fetchGrid) { $("sea-note").textContent = "Loading the fetch grid…"; return; }
    this.ensureSwell();                                               // NOAA wave model for this hour (async; redraws when in)
    const mode = $("sea-mode").value;
    this.ensureCurrents();
    const curOn = $("cur-waves").checked && !$("cur-layer").hidden && !!this.curData;
    if (curOn) this.ensureSscofs();
    this.waves.setStyle(this.seaStyle());
    if (this.routeGridCache?.rid === this.region?.id) this.waves.setShore(this.routeGridCache.grid);
    else this.routeGrid().then(() => { this.seaKeyStr = null; this.drawWaves(); });   // (the fine shoreline, once loaded)
    // Worked out once per forecast hour and blended between the two hours on the graphics card, so
    // stepping or playing through the time costs next to nothing (it was ~70 ms a step).
    const base = [this.region?.id, this.model?.id, this.cycle?.getTime(), mode, $("sea-duration").value, this.swellHour?.key, curOn && this.curKey, curOn && $("cur-src").value, curOn && this.sscofsStamp].join("|");
    const key = [base, this.vol0?.raw.version, this.vol1?.raw.version, this.frac, !!this.surf].join("|");
    if (key === this.seaKeyStr) return;
    this.seaKeyStr = key;
    // Per-cell caches (performance review): the model cell under each water cell (per model grid),
    // and the swell (per wave-model hour). Filled lazily; -2 = not looked up yet.
    const sh = this.swellHour, n = this.waves.cellsFor(this.fetchGrid, this.proj).n, V = this.vol;
    const gk = `${V.raw.crop.i0},${V.raw.crop.j0},${V.w},${V.h},${this.model?.id}|${n}`;
    if (this.waveCellKey !== gk) { this.waveCellKey = gk; this.waveCell = new Int32Array(n).fill(-2); }
    const cellOf = this.waveCell, cell = (la, lo, k) => {
      let c = cellOf[k];
      if (c === -2) { const q = V.merc.ij(la, lo), i = Math.round(q.i - V.raw.crop.i0), j = Math.round(q.j - V.raw.crop.j0); c = cellOf[k] = i < 0 || j < 0 || i >= V.w || j >= V.h ? -1 : j * V.w + i; }
      return c;
    };
    if (sh && this.swellCellKey !== `${sh.key}|${n}`) { this.swellCellKey = `${sh.key}|${n}`; this.swellCell = new Float32Array(n).fill(-2); }
    const swellAt = sh ? (la, lo, k) => { let s2 = this.swellCell[k]; if (s2 === -2) { const v = swellHs2At(sh, la, lo); s2 = this.swellCell[k] = v == null ? -1 : v; } return s2 < 0 ? null : s2; } : null;
    // Currents on the waves at a time (ms).
    const field = curOn ? this.currentField() : null, C = this.waves.cellsFor(this.fetchGrid, this.proj);
    const curAt = (tms) => (field ? (k) => { const s = field.sample(C.x[k], C.y[k], tms); return s ? [s.u, s.v] : null; } : null);
    // One hour's sea, from that hour's own 10 m wind (kept: the last four hours).
    const frame = (raw) => {
      const A = raw?.agl?.[10];
      if (!A?.UGRD || !this.cycle) return null;
      const k = `${base}|${raw.fhr}|${raw.version}`;
      if (this.seaFrames.has(k)) return this.seaFrames.get(k);
      const F = this.waves.compute(this.fetchGrid, this.proj, (la, lo, kk) => { const c = cell(la, lo, kk); return c < 0 ? null : [A.UGRD[c], A.VGRD[c]]; },
        swellAt, mode, curAt(this.cycle.getTime() + raw.fhr * 3600e3), curOn);
      this.seaFrames.set(k, F);
      for (const [k0, F0] of this.seaFrames) { if (this.seaFrames.size <= 4) break; if (F0 === this.waves.A || F0 === this.waves.B || F0 === F) continue; WaveLayer.dispose(F0); this.seaFrames.delete(k0); }
      return F;
    };
    let A = frame(this.vol0?.raw), B = this.frac > 0 ? frame(this.vol1?.raw) : A, f = this.frac > 0 && B ? this.frac : 0;
    if (!A) {
      // (no hourly 10 m arrays in this model's files: the time on screen, worked out each step)
      const S = this.surf, windAt = (la, lo, k) => { const c = cell(la, lo, k); if (c < 0) return null; if (S) return [S.U[c], S.V[c]]; return [V.column("U", c, V.terrain[c] + 10), V.column("V", c, V.terrain[c] + 10)]; };
      if (this.seaNow) WaveLayer.dispose(this.seaNow);
      A = B = this.seaNow = this.waves.compute(this.fetchGrid, this.proj, windAt, swellAt, mode, curAt(this.validDate().getTime()), curOn); f = 0;
    }
    this.waves.show(A, B || A, f);
    const r = (f < 0.5 ? A : B || A).stats;
    const ft = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–"), what = { total: "Total sea", chop: "Chop", swell: "Swell" }[mode];
    const ref = SWELL_REF[this.region.id], wm = sh && ref ? wavesAt(sh, ref.lat, ref.lon) : null;
    const swellTxt = !sh ? (this.swellErr ? `Swell unavailable: ${this.swellErr}.` : "Loading swell from NOAA's wave model…")
      : !wm ? `Swell: none in the wave model near ${ref?.name}.`
      : `<b>Swell at ${ref.name}</b> (NOAA GFS-Wave ${String(sh.cycle.getUTCHours()).padStart(2, "0")}Z +${sh.fhr} h): `
        + (wm.swell.length ? wm.swell.map((s) => `${ft(s.hs * 3.28084)} ft at ${Math.round(s.tp)} s from ${Math.round(s.dir)}°`).join("; ") : "none")
        + (Number.isFinite(wm.wind.hs) ? `; its own wind sea there ${ft(wm.wind.hs * 3.28084)} ft at ${wm.wind.tp.toFixed(1)} s` : "") + `.`;
    $("sea-note").innerHTML = `${what} over the water: typical ${ft(r.median)} ft, 1 in 10 spots above ${ft(r.p90)} ft, highest ${ft(r.max)} ft.`
      + `<br>${swellTxt}`
      + `<br>Chop: local wind waves from the model's 10 m wind, the fetch and how long the wind has blown (CEM growth relations). Swell: NOAA's wave model (about 18 km grid; sheltered inland waters get none). ${curOn ? "Tidal currents: on (NOAA predictions within 5 km of a station): chop steeper and higher against the current, lower with it." : $("cur-layer").hidden ? "No tidal currents here." : "Tidal currents: off (Tidal currents → Current effects on waves)."} No shallow-water effects. <b>Click the water</b> for the true-scale surface inspector.`;
    this.stage.markDirty();
    this.drawZoneCompare();
  }
  // The keys for the current's and the wave height's colour fills, beside the wind's (when on).
  drawKeys2() {
    const keys = [], mk = (title, draw, ticks) => keys.push({ title, draw, ticks });
    if ($("show-cur").checked && $("cur-fill").checked && !$("cur-layer").hidden && this.curData)
      mk("Current speed (kt)", (g, w, h) => { for (let x = 0; x < w; x++) { const c = rampAt((x / (w - 1)) * 5.5); g.fillStyle = `rgb(${c.map((v) => Math.round(v * 255))})`; g.fillRect(x, 0, 1, h); } }, [[0, "0"], [1 / 5.5, "1"], [2 / 5.5, "2"], [3 / 5.5, "3"], [4 / 5.5, "4"], [1, "5.5+"]]);
    if ($("show-sea").checked && $("sea-fill").checked && this.vol)
      mk(`Wave height, ${$("sea-mode").selectedOptions[0].text.replace(/ \(.*\)/, "")} (ft)`, (g, w, h) => g.drawImage(seaKey(w, h), 0, 0), [[0, "0"], [0.25, "2.5"], [0.5, "5"], [0.75, "7.5"], [1, "10+"]]);
    const sig = keys.map((k) => k.title).join("|");
    if (sig === this.keys2Sig) return;
    this.keys2Sig = sig;
    $("keys2").innerHTML = keys.map((k, i) => `<div class="key2"><div class="lbl">${k.title}</div><canvas width="190" height="10" data-k="${i}"></canvas><div class="ticks">${k.ticks.map(([f, l]) => `<span style="left:${f * 100}%">${l}</span>`).join("")}</div></div>`).join("");
    keys.forEach((k, i) => { const cv = $("keys2").querySelector(`canvas[data-k="${i}"]`); k.draw(cv.getContext("2d"), cv.width, cv.height); });
  }
  // What the sea surface draws (Sea state box / Surface layers).
  seaStyle() { return { fill: $("sea-fill").checked, crests: $("sea-crests").checked, animate: $("sea-anim").checked, arrows: $("sea-arrows").checked }; }
  // The wave model's hour for the time on screen (cached per valid hour and region).
  ensureSwell() {
    if (!this.cycle || this.t == null) return;
    const valid = new Date(this.cycle.getTime() + Math.round(this.t) * 3600e3), key = `${this.region.id}|${valid.toISOString()}`;
    if (this.swellHour?.key === key || this.swellLoading === key) return;
    this.swellLoading = key;
    loadWaveHour(this.region.id, this.region.bbox, valid).then((wh) => {
      if (this.swellLoading !== key) return;
      this.swellHour = wh ? { ...wh, key } : null; this.swellErr = null; this.swellLoading = null;
      this.seaKeyStr = null; this.drawWaves();
    }, (e) => { if (this.swellLoading === key) { this.swellLoading = null; this.swellErr = e.message; this.seaKeyStr = null; this.drawWaves(); } });
  }

  // Scene (x, y) at a screen point on the sea-level plane, or null.
  waterPoint(cx, cy) {
    const r = this.stage.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster(), hit = new THREE.Vector3();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.stage.camera);
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.008), hit) ? { x: hit.x, y: hit.y } : null;
  }

  // A station's current through the loaded span, like a meteogram: flood above the line, ebb
  // below (each with its direction), slack and the maximums marked, the time on screen as a line.
  drawCurGraph() {
    const s = this.curData?.find((q) => q.id === this.curGraphFor);
    if (!s) { $("cur-graph").hidden = true; return; }
    $("cur-graph").hidden = false;
    const cv = $("cur-graph-c"), g = cv.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth || 380, H = cv.clientHeight || 170;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const t0 = this.cycle.getTime() + (+$("fhr").min) * 3600e3, t1 = this.cycle.getTime() + (+$("fhr").max) * 3600e3, L = 30, R = 8, T = 16, B = H - 18;
    const N = 240, vals = []; for (let k = 0; k <= N; k++) vals.push(stationSpeed(s, t0 + ((t1 - t0) * k) / N));
    const top = Math.max(1, ...vals.map(Math.abs)) * 1.15, X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => (T + B) / 2 - (v / top) * ((B - T) / 2);
    this.curGraphGeom = { t0, t1, L, R };
    const css = getComputedStyle(document.body), ink = css.getPropertyValue("--ink-soft") || "#8aa", tz = this.region.tz;
    g.font = "9.5px ui-monospace, monospace";
    // Days and 6-hour ticks (local time).
    for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
      const hh = +new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(t) % 24;
      if (hh % 6) continue;
      g.strokeStyle = hh === 0 ? "rgba(140,160,170,.45)" : "rgba(140,160,170,.18)"; g.beginPath(); g.moveTo(X(t), T); g.lineTo(X(t), B); g.stroke();
      g.fillStyle = ink; g.fillText(hh === 0 ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(t) : `${hh}h`, X(t) + 2, H - 5);
    }
    // Flood (above) and ebb (below) filled.
    const fill = (sign, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(X(t0), Y(0)); vals.forEach((v, k) => g.lineTo(X(t0 + ((t1 - t0) * k) / N), Y(sign > 0 ? Math.max(0, v) : Math.min(0, v)))); g.lineTo(X(t1), Y(0)); g.closePath(); g.fill(); };
    fill(1, "rgba(63,193,165,.35)"); fill(-1, "rgba(242,154,59,.35)");
    g.strokeStyle = "#dfe9ec"; g.lineWidth = 1.4; g.beginPath(); vals.forEach((v, k) => { const x = X(t0 + ((t1 - t0) * k) / N), y = Y(v); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.strokeStyle = "rgba(200,210,215,.5)"; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - R, Y(0)); g.stroke();
    for (const v of [top / 1.15, -top / 1.15]) { g.fillStyle = ink; g.fillText(`${Math.abs(v).toFixed(1)}`, 2, Y(v) + 3); }
    g.fillStyle = "#3fc1a5"; g.fillText(`FLOOD → ${String(Math.round(s.flood)).padStart(3, "0")}°`, L + 4, T + 8);
    g.fillStyle = "#f29a3b"; g.fillText(`EBB → ${String(Math.round(s.ebb)).padStart(3, "0")}°`, L + 4, B - 4);
    // Slack and maximum events.
    for (const e of s.ev) {
      if (e.t < t0 || e.t > t1) continue;
      const x = X(e.t), y = Y(e.v);
      g.fillStyle = e.type === "slack" ? "#ffffff" : e.v > 0 ? "#3fc1a5" : "#f29a3b";
      g.beginPath(); g.arc(x, y, e.type === "slack" ? 2.5 : 3, 0, 2 * Math.PI); g.fill();
      if (e.type !== "slack") { g.fillStyle = "#e8f3f5"; g.fillText(`${Math.abs(e.v).toFixed(1)}`, x - 8, e.v > 0 ? y - 5 : y + 12); }
    }
    // The time on screen.
    const now = this.validDate()?.getTime();
    if (now >= t0 && now <= t1) { g.strokeStyle = "#ffd166"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(now), T - 4); g.lineTo(X(now), B); g.stroke(); }
    const c = stationCurrent(s, now ?? t0), next = s.ev.find((e) => e.t > (now ?? t0));
    const loc = (t) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(t);
    $("cur-graph-h").innerHTML = `<b>${s.name}</b> <span>(NOAA ${s.id}, ${s.type === "H" ? "harmonic" : "subordinate"} station)</span>`;
    $("cur-graph-n").innerHTML = `Now ${c.kt.toFixed(1)} kt ${stationSpeed(s, now ?? t0) >= 0 ? "flood" : "ebb"} setting ${String(Math.round(c.set)).padStart(3, "0")}°`
      + (next ? ` · next: ${next.type === "slack" ? "slack" : `max ${next.type} ${Math.abs(next.v).toFixed(1)} kt`} at ${loc(next.t)}` : "") + `. Knots; click the graph to go to that time.`;
  }

  // Open the surface inspector at a screen point on the water.
  inspectAt(cx, cy) {
    if (!this.fetchGrid || !this.vol) return;
    const r = this.stage.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.stage.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.008), hit)) return;
    this.inspectPoint(hit.x, hit.y);
  }
  // The inspector's spot on the map (null: none). Redrawn only when it moves or the exaggeration changes.
  markInspect(x, y) {
    this.inspectMark.visible = !this.replayPos;                  // (hidden while a passage replays: see moveBoatMark)
    const key = x == null ? null : `${x.toFixed(3)},${y.toFixed(3)},${this.stage.vex}`;
    if (key === this.inspectMarkKey) return;
    this.inspectMarkKey = key;
    for (const o of [...this.inspectMark.children]) { this.inspectMark.remove(o); o.traverse?.((q) => { q.geometry?.dispose(); q.material?.dispose?.(); if (q.isCSS2DObject) q.element.remove(); }); }
    this.boatMark = null; this.trailMesh = null; this.trail = [];
    if (x != null) {
      // The boat: a group at its position (moves as it sails in the viewer) with a pole, the ⛵
      // label and a flat arrow on the water pointing along its heading.
      const h = 0.9 * this.stage.vex, g = new THREE.Group();
      g.add(outlinedLines([0, 0, 0, 0, 0, h], 0xff6f61, { width: 2.6, opacity: 1, order: 22 }));
      const el = document.createElement("div");
      el.className = "label inspect-mark";
      el.textContent = "⛵";
      el.title = "The spot the sea-state inspector is showing; the arrow is the boat's heading, the line its track";
      const o = new CSS2DObject(el);
      o.position.set(0, 0, h);
      g.add(o);
      // The heading arrow (~1.9 km long, so it reads at channel scale), coral on a dark outline.
      const pts = (k) => [new THREE.Vector2(1.12 * k, 0), new THREE.Vector2(-0.72 * k, 0.5 * k), new THREE.Vector2(-0.4 * k, 0), new THREE.Vector2(-0.72 * k, -0.5 * k)];
      const flat = (k, color, order) => { const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts(k))), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 })); m.renderOrder = order; return m; };
      const arrow = new THREE.Group();
      arrow.add(flat(1.18, 0x0b1a20, 23), flat(1, 0xff6f61, 24));
      arrow.position.z = 0.03;
      g.add(arrow);
      g.position.set(x, y, 0);
      this.boatMark = { g, arrow, x0: x, y0: y };
      this.inspectMark.add(g);
      this.trail = [[x, y]];
    }
    this.stage.markDirty();
  }
  // The viewer's boat has moved (off: metres from the clicked spot; hdg °): move the map boat,
  // turn its arrow, and extend the breadcrumb trail (a point every 10 m; cleared on reset).
  moveBoatMark(off, hdg) {
    const b = this.boatMark;
    if (!b) return;
    // (replaying a passage, the route's own boat is the one on the map: the viewer's marker, which
    // follows the viewer's sailing physics and drifts off the plan, is hidden)
    this.inspectMark.visible = !this.replayPos;
    if (this.replayPos) return;
    const x = b.x0 + off.x / 1000, y = b.y0 + off.y / 1000;
    b.g.position.set(x, y, 0);
    b.arrow.rotation.z = ((90 - hdg) * Math.PI) / 180;
    if (off.x === 0 && off.y === 0) this.trail = [[x, y]];
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) > 0.01) this.trail.push([x, y]);
    if (this.trailMesh) { this.inspectMark.remove(this.trailMesh); this.trailMesh.traverse((q) => { q.geometry?.dispose(); q.material?.dispose?.(); }); this.trailMesh = null; }
    if (this.trail.length > 4000) this.trail = this.trail.filter((_, i) => i % 2 === 0 || i === this.trail.length - 1);   // long passages: thin the older points
    if (this.trail.length > 1) {
      // The track: a bright line, a breadcrumb dot every ~250 m, and a ring at the start.
      const segs = [], dots = [];
      let run = 0;
      for (let i = 1; i < this.trail.length; i++) {
        const [ax, ay] = this.trail[i - 1], [bx, by] = this.trail[i];
        segs.push(ax, ay, 0.025, bx, by, 0.025);
        run += Math.hypot(bx - ax, by - ay);
        if (run >= 0.25) { run = 0; dots.push(bx, by, 0.03); }
      }
      const g = new THREE.Group();
      g.add(outlinedLines(segs, 0xfff1a8, { width: 2.4, opacity: 1, order: 22, depthTest: false }));
      const ring = [], [sx, sy] = this.trail[0];
      for (let k = 0; k < 24; k++) { const a0 = (k / 24) * 2 * Math.PI, a1 = ((k + 1) / 24) * 2 * Math.PI; ring.push(sx + 0.3 * Math.cos(a0), sy + 0.3 * Math.sin(a0), 0.03, sx + 0.3 * Math.cos(a1), sy + 0.3 * Math.sin(a1), 0.03); }
      g.add(outlinedLines(ring, 0xfff1a8, { width: 2.4, opacity: 1, order: 22, depthTest: false }));
      if (dots.length) {
        const dg = new THREE.BufferGeometry(); dg.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
        const pm = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xfff1a8, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
        pm.renderOrder = 23; g.add(pm);
      }
      this.trailMesh = g;
      this.inspectMark.add(g);
    }
    this.stage.markDirty();
  }
  // Open the surface viewer at the region's main channel: the middle of its throat (the
  // ʻAlenuihāhā), else its axis origin or its first box's centre. Waits for the fetch grid.
  async inspectDefault() {
    for (let k = 0; k < 240 && (!this.fetchGrid || !this.vol); k++) await new Promise((r) => setTimeout(r, 250));   // up to 60 s: a preset link loads the model first
    if (!this.fetchGrid || !this.vol) return;
    const sub = this.region.subareas.find((q) => q.axis) || this.region.subareas[0];
    let ll = null;
    if (sub?.axis?.throat) { const [a, b] = [sub.axis.throat.left, sub.axis.throat.right]; ll = { lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2 }; }
    else if (sub?.axis?.origin) ll = { lat: sub.axis.origin[0], lon: sub.axis.origin[1] };
    else if (sub?.box) ll = { lat: (sub.box.latMin + sub.box.latMax) / 2, lon: (sub.box.lonMin + sub.box.lonMax) / 2 };
    if (!ll) return;
    const p = this.proj.toXY(ll.lat, ll.lon);
    this.inspectPoint(p.x, p.y);
  }
  // The inspector at scene (x, y) for the time on screen (redone when the time changes).
  // (During a passage replay the viewer is anchored at (x, y), which keeps its land and waves, while
  // the conditions come from the boat's position on the route, this.replayPos.)
  // The weather at the viewer's spot (its sky, fog and rain): the passage's during a replay, else
  // the model's round the spot, loaded once for the run's hours (the viewer redraws when it's in).
  viewerWeather(ll, when) {
    if (!when || !this.cycle || !$("ins-wx")?.checked) return null;
    const t = when.getTime(), P = this.passage;
    if (this.replayPos && P?.wx) { const w = P.wx.sample(ll.lat, ll.lon, t); if (w) return w; }
    const S = this.spotWx, rid = this.region.id, cyc = this.cycle;
    if (S && S.rid === rid && S.cyc === cyc.getTime() && Math.abs(ll.lat - S.lat) < 0.2 && Math.abs(ll.lon - S.lon) < 0.28) return S.w?.sample(ll.lat, ll.lon, t) || null;
    if (!this.spotWxLoading) {
      this.spotWxLoading = true;
      const t0 = cyc.getTime() + (+$("fhr").min) * 3600e3, t1 = cyc.getTime() + (+$("fhr").max) * 3600e3, spot = { rid, cyc: cyc.getTime(), lat: ll.lat, lon: ll.lon };
      loadWeather({ model: this.model, cycle: cyc, bbox: { latMin: ll.lat - 0.25, latMax: ll.lat + 0.25, lonMin: ll.lon - 0.35, lonMax: ll.lon + 0.35 }, t0, t1 })
        .then((w) => { this.spotWx = { ...spot, w }; }, (e) => { console.warn("viewer weather", e); this.spotWx = { ...spot, w: null }; })
        .finally(() => { this.spotWxLoading = false; if (this.region?.id === rid && this.inspectXY && !this.inspector.el.hidden) { this.inspectKey = null; this.inspectPoint(...this.inspectXY); } });
    }
    return null;
  }
  inspectPoint(x, y) {
    if (!this.fetchGrid || !this.vol) return;
    const at = this.proj.toLatLon(x, y), anchor = [x, y];
    if (this.replayPos) [x, y] = this.replayPos;
    const ll = this.proj.toLatLon(x, y), w = this.windAt10(ll.lat, ll.lon);
    let cur = !$("cur-layer").hidden && $("cur-waves").checked ? this.currentAt(x, y) : null;
    // Replaying a passage planned with currents: the planner's current at the boat's position and
    // time, whatever the currents layer shows.
    const P = this.passage, rf = this.replayPos && P?.routeField;
    if (rf && Number.isFinite(P.rp?.t)) {
      const q = rf.sample(x, y, P.rp.t);
      if (q) {
        let near = null; for (const st of rf.stations) { const d = Math.hypot(st.x - x, st.y - y); if (!near || d < near.d) near = { d, name: st.name }; }
        cur = { u: q.u, v: q.v, kt: Math.hypot(q.u, q.v) / 0.514444, set: ((Math.atan2(q.u, q.v) * 180) / Math.PI + 360) % 360, station: { name: near?.name || "nearby stations" }, km: near?.d ?? NaN, route: true,
          src: rf.sscofs?.covers(P.rp.t) && rf.sscofs.sample(x, y, P.rp.t) ? rf.sscofs.label : null };
      }
    }
    const c = w && chopAt(this.fetchGrid, x, y, w[0] - (cur?.u || 0), w[1] - (cur?.v || 0));      // the wind over the moving water (the viewer applies the current to the waves)
    const wm = this.swellHour ? wavesAt(this.swellHour, ll.lat, ll.lon) : null, swell = wm?.swell || [];
    if (!this.fetchGrid.at(x, y, 0) && !swell.length) return;              // land
    this.inspectXY = anchor;
    this.markInspect(...anchor);
    const n = this.nwsAt(ll.lat, ll.lon);
    const extra = [`${this.fhrLabel(this.t)} · ${this.model?.short || this.modelName()} wind.`,
      this.swellHour ? `Swell: NOAA GFS-Wave ${String(this.swellHour.cycle.getUTCHours()).padStart(2, "0")}Z +${this.swellHour.fhr} h.` : "",
      n?.period ? `NWS ${n.zone.id} ${n.zone.name}, ${n.period.name.toLowerCase()}: ${periodSummary(n.period)}.` : ""].filter(Boolean).join("<br>");
    // The model's gust here (15-minute data when in, else the hour's), for the inspector's gusts.
    const v = this.vol, q = v.merc.ij(ll.lat, ll.lon), cell = Math.round(q.j - v.raw.crop.j0) * v.w + Math.round(q.i - v.raw.crop.i0);
    const gust = this.surf?.G?.[cell] ?? v.raw.surface.GUST?.[cell];
    const wind = w ? { mean: Math.hypot(w[0], w[1]), gust: Number.isFinite(gust) ? gust : null, fromDeg: ((Math.atan2(-w[0], -w[1]) * 180) / Math.PI + 360) % 360 } : null;
    const env = this.terrain ? { key: `${this.region.id}|${anchor[0].toFixed(3)}|${anchor[1].toFixed(3)}`, x: anchor[0], y: anchor[1], heightM: this.terrain.heightM, isLand: this.terrain.isLand,
      photo: this.terrain.photo, photoExtent: this.terrain.photoExtent(),
      when: this.cycle && Number.isFinite(this.t) ? new Date(this.cycle.getTime() + this.t * 3600e3) : null, tz: this.region.tz } : null;
    if (env) { env.current = cur ? { u: cur.u, v: cur.v, kt: cur.kt, set: cur.set, station: cur.station.name, km: cur.km, route: !!cur.route, src: cur.src || null } : null; env.curOff = !cur && !!this.curData; }
    if (env) env.weather = this.viewerWeather(ll, env.when);
    this.inspector.open(at, c && c.hs > 0.01 ? c : null, swell, boatForRegion(this.region.id), extra, wind, env);
  }

  // Fog and mist from the model's surface visibility (rebuilt like the clouds).
  drawFog() {
    const on = $("show-fog").checked && this.vol;
    $("fog-box").hidden = !on;
    if (!on) { if (this.fog.shown || this.visMap.shown) { this.fog.hide(); this.visMap.hide(); this.stage.markDirty(); } return; }   // keeps the computed hours
    // Per model hour, cross-faded on the GPU between hours: cheap every step.
    const mode = $("fog-mode").value, V1 = this.frac > 0 ? this.vol1 : null, again = () => { this.drawFog(); this.stage.markDirty(); };
    const r = mode !== "map" ? this.fog.show(this.vol0, V1, this.frac, this.proj, this.stage.vex, again) : (this.fog.hide(), undefined);
    const v = mode !== "fog" ? this.visMap.show(this.vol0, V1, this.frac, this.proj, again) : (this.visMap.hide(), undefined);
    $("vis-key").hidden = mode === "fog";
    const pct = (x) => `${x < 0.005 && x > 0 ? "<1" : Math.round(x * 100)}%`;
    const none = r?.none || v?.none, pending = r === null || v === null;
    const html = none ? `Loading the model's visibility…`
      : pending ? "Working out the model's fog and visibility…"
      : (r ? `Over the water: fog (visibility under 1 km) ${pct(r.fogFrac)}, mist (1–5 km) ${pct(r.mistFrac)}`
        + (Number.isFinite(r.topMedian) ? ` · fog typically ${Math.round(r.topMedian)} m deep` : "") + `.<br>` : "")
      + (v ? `Visibility over the water: very poor ${pct(v.frac[0])}, poor ${pct(v.frac[1])}, moderate ${pct(v.frac[2])}; the rest good. Hover for the value.<br>` : "")
      + `The model's own visibility forecast (${this.model?.short || this.modelName()}): it drops for fog, mist, haze, smoke and rain alike. The fog layer's depth is its cloud water at the surface. Fog is hard to forecast: read this as where the model has it.`;
    if ($("fog-note").innerHTML !== html) $("fog-note").innerHTML = html;
    this.stage.markDirty();
  }

  // GOES-West imagery for the time on screen when that's past, else the newest.
  async drawSatellite() {
    const on = $("show-sat").checked && this.region;
    $("sat-box").hidden = !on;
    this.sat.group.visible = !!on;
    if (!on) { this.stage.markDirty(); return; }
    const valid = this.cycle && this.t != null ? new Date(this.cycle.getTime() + this.t * 3600e3) : null;
    const past = valid && valid.getTime() < Date.now() - 45 * 60e3;            // GIBS runs 20-40 min behind
    const product = $("sat-product").value, key = `${product}|${past ? Math.floor(valid / 600e3) : "latest:" + Math.floor(Date.now() / 600e3)}|${this.region.id}`;
    if (key === this.satKey) return;
    if (this.playing && this.lastSat && performance.now() - this.lastSat < 2000) return;
    this.satKey = key; this.lastSat = performance.now();
    $("sat-note").textContent = "Loading the image…";
    try {
      await this.sat.show(this.proj, this.region.bbox, product, past ? valid : null);
      const when = past ? new Date(Math.floor(valid / 600e3) * 600e3) : null;
      $("sat-note").innerHTML = (when ? `Image at ${when.toUTCString().slice(17, 22)} UTC, matching the time on screen.` : `The newest image (about 20–40 min old): the forecast time on screen is later than the satellite has.`)
        + ` NASA GIBS, GOES-West ABI${SAT_PRODUCTS[product]?.cloudsOnly ? "; clear sky left transparent" : ""}.`;
    } catch (e) { $("sat-note").textContent = `Couldn't load the image (${e.message || "network"}).`; }
    this.stage.markDirty();
  }

  // Spacing (km) of barbs / streamlines for the current zoom: a power-of-two multiple of the
  // model cell, about 5 % of the camera distance.
  glyphSpacing() {
    const v = this.vol;
    if (!v) return 0;
    const cell = v.merc.cellSizeM(v.raw.crop.i0 + v.w / 2, v.raw.crop.j0 + v.h / 2) / 1000;
    const d = this.stage.camera.position.distanceTo(this.stage.controls.target);
    // (about 1/30 of the view apart, in whole grid steps: 1/16 left only a handful of barbs over
    // the water once the land's were dropped)
    return cell * 2 ** Math.max(0, Math.round(Math.log2((d * 0.025) / cell)));
  }
  drawGlyphs(path) {
    this.glyphs.clear();
    this.lastGlyphs = performance.now();
    const barbs = $("wind-barbs").checked, stream = $("wind-stream").checked, v = this.vol;
    $("glyph-box").hidden = !(barbs || stream);
    if (!v || !(barbs || stream)) { this.stage.markDirty(); return; }
    $("glyph-box").hidden = false;
    const density = +$("glyph-density").value, size = +$("glyph-size").value;
    $("glyph-density-val").textContent = `${density.toFixed(1)}×`; $("glyph-size-val").textContent = `${size.toFixed(1)}×`;
    this.glyphKm = this.glyphSpacing();
    const spacingKm = this.glyphKm / density, vex = this.stage.vex, i0 = v.raw.crop.i0, j0 = v.raw.crop.j0;
    this.glyphs.size = size; this.glyphs.opacity = +$("glyph-opacity").value;
    this.glyphs.mode = $("glyph-colour").value;
    this.glyphs.onFill = !COLOUR_BY[this.spec.field]?.none;         // auto: dark on a colour fill, light on the bare scene
    if ($("show-slice").checked) {
      const { h, ref } = this.spec, S = this.surf && ref === "agl" && h <= 10 ? this.surf : null, U = new Float32Array(v.n), V = new Float32Array(v.n);
      for (let c = 0; c < v.n; c++) {
        if (S) { U[c] = S.U[c]; V[c] = S.V[c]; continue; }
        const z = ref === "agl" ? v.terrain[c] + h : h;
        U[c] = v.column("U", c, z); V[c] = v.column("V", c, z);
      }
      // Heights: the slice's own drawn surface (so glyphs sit on it), bilinear between its vertices.
      const Z = this.slice.mesh?.geometry.attributes.position.array, W = v.w;
      const zAt = (i, j) => {
        if (!Z) return (h / 1000) * vex;
        const i0 = Math.min(W - 2, Math.max(0, Math.floor(i))), j0 = Math.min(v.h - 2, Math.max(0, Math.floor(j))), a = i - i0, b = j - j0;
        const z = (c) => Z[3 * c + 2];
        return (1 - a) * (1 - b) * z(j0 * W + i0) + a * (1 - b) * z(j0 * W + i0 + 1) + (1 - a) * b * z((j0 + 1) * W + i0) + a * b * z((j0 + 1) * W + i0 + 1) + 0.006;
      };
      this.glyphs.slice({
        w: v.w, h: v.h, U, V, cellKm: v.merc.cellSizeM(i0 + v.w / 2, j0 + v.h / 2) / 1000,
        at: (i, j) => { const q = v.merc.latLon(i0 + i, j0 + j); return this.proj.toXY(q.lat, q.lon); },
        zAt,
        toGrid: (u, w, i, j) => v.merc.toGrid(u, w, i0 + i, j0 + j),
        keep: (x, y) => !this.clip.on || !!this.isWater?.(x, y),
      }, { barbs, stream, spacingKm });
    }
    if (path && $("show-curtain").checked && v.section) {
      const pts = path.pts, n = pts.length, NZ = 60, top = Math.min(this.top, 5000), zs = Array.from({ length: NZ }, (_, k) => (top * k) / (NZ - 1));
      const U = v.section("U", pts, zs), V = v.section("V", pts, zs), W = v.section("W", pts, zs), g = path.geom;
      const m = Math.hypot(g.u.x, g.u.y), ux = g.u.x / m, uy = g.u.y / m, UA = U.map((u, q) => u * ux + V[q] * uy);
      this.glyphs.section({ n, NZ, xy: pts.map((p) => this.proj.toXY(p.lat, p.lon)), zs, U, V, W, UA, dsKm: (g.t1 - g.t0) / (n - 1), vex },
        { barbs, stream, spacingKm });
    }
    this.stage.markDirty();
  }

  // A thin coastline riding on top of the horizontal slice: a strong wind layer otherwise hides
  // where the land is (the terrain's own edge is under the sheet).
  buildCoast(coast) {
    if (this.coastLine) { this.stage.scene.remove(this.coastLine); this.coastLine.geometry.dispose(); this.coastLine.material.dispose(); this.coastLine = null; }
    if (!coast?.polygons || !this.proj) return;
    const pts = [];
    for (const rings of coast.polygons) for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = this.proj.toXY(ring[i][1], ring[i][0]), b = this.proj.toXY(ring[i + 1][1], ring[i + 1][0]);
        pts.push(a.x, a.y, 0, b.x, b.y, 0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.coastLine = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x06222a, transparent: true, opacity: 0.75, depthWrite: false }));
    this.coastLine.renderOrder = 11;
    this.coastLine.visible = false;
    this.stage.scene.add(this.coastLine);
  }
  placeCoast() {
    if (!this.coastLine) return;
    // Only near the surface: a coastline on a slice aloft would float above the real one and
    // slide off it as the view turns.
    const on = !!this.vol && $("show-slice").checked && this.spec.h <= 150;
    this.coastLine.visible = on;
    // At the slice's height over the sea (where the coast is), just above it.
    if (on) this.coastLine.position.z = (this.spec.h / 1000) * this.stage.vex + 0.004;
  }

  nearest() { return this.vol1 && this.frac >= 0.5 ? this.vol1 : this.vol0; }

  // Turbulence proxies for the nearer hour (classes aren't blended).
  drawTurbulence() {
    this.checkNeeds();
    const on = $("show-turb").checked && this.vol0;
    $("turb-box").hidden = !on;
    if (!on) { if (this.turb.group.children.length) { this.turb.clear(); this.stage.markDirty(); } this.turbDrawnFor = null; this.turbKey = null; return; }
    const V = this.nearest();
    // Unchanged hour, options and exaggeration: keep what's drawn (redraw runs on every slider move).
    const key = [$("turb-pockets").checked, $("turb-pbl").checked, $("turb-style").value, this.stage.vex, this.region?.id].join("|");
    if (this.turbDrawnFor === V && this.turbKey === key && this.turb.group.children.length) return;
    this.turb.clear();
    this.turbDrawnFor = null; this.turbKey = key;
    const r = this.turb.build(V, this.proj, this.stage.vex, { pockets: $("turb-pockets").checked, pbl: $("turb-pbl").checked, style: $("turb-style").value });
    this.turbDrawnFor = V;
    const pbl = V.raw.surface.HPBL, land = V.raw.surface.LAND;
    let sum = 0, n = 0;
    if (pbl) for (let c = 0; c < V.n; c++) if (!(land && land[c] > 0.5)) { sum += pbl[c]; n++; }
    $("turb-note").innerHTML = `<span style="color:rgb(${RI_CLASSES[0].colour.map((x) => x * 255 | 0)})">●</span> likely ${r.likely.toLocaleString()} · `
      + `<span style="color:rgb(${RI_CLASSES[1].colour.map((x) => x * 255 | 0)})">●</span> possible ${r.possible.toLocaleString()} layer-cells`
      + (n ? ` · mixed layer ${Math.round(sum / n)} m (${Math.round(sum / n * 3.28084 / 100) * 100} ft) over water` : "")
      + `<br>Proxies, not observations: the ${this.modelName()} output read here has no turbulence field, so these come from its wind shear and stability`
      + ` (Richardson number) between its pressure levels (25–50 mb apart), and its boundary-layer depth. Real turbulence is much smaller than a 2.5–3 km cell.`
      + ` For the surface, Colour by → Gust factor; aloft, Colour by → Wind shear or Turbulence proxy.`;
    this.stage.markDirty();
  }

  // The inversion band for the hour on screen (between hours: the nearer one; detections aren't blended).
  drawInversion(path) {
    const on = $("show-inversion").checked && this.vol0;
    const V = this.vol1 && this.frac >= 0.5 ? this.vol1 : this.vol0;
    // The same hour, section and exaggeration as last time (playback redraws often): keep it.
    const key = on ? [V?.raw.fhr, this.cycle?.getTime(), path ? JSON.stringify(path.geom.c) + path.geom.bearing : "", this.stage.vex, this.region?.id].join("|") : null;
    if (key && key === this.invKey && this.inversion.group.children.length) return;
    this.invKey = key;
    this.inversion.clear();
    $("inversion-box").hidden = !on;
    if (!on) return;
    if (this.model?.noInversion) { $("inversion-note").innerHTML = `<b>Not available for ${this.model.label}:</b> ${this.model.noInversion}`; return; }
    const r = this.inversion.build(V, this.proj, this.stage.vex);
    if (path) this.inversion.curtain(V, this.proj, path.pts, this.stage.vex);
    const v = this.verification?.summary?.rrfs_f012, n = this.verification?.n;
    const ftr = (m) => Math.round(m * 3.28084 / 100) * 100, mr = (m) => Math.round(m).toLocaleString();
    $("inversion-note").innerHTML = (Number.isFinite(r.baseMedian)
      ? `<b>Over the water:</b> a capping layer over ${Math.round(r.found * 100)}%, base ${mr(r.baseMedian)} m (${ftr(r.baseMedian)} ft) typical. `
        + `Strength (TII, scored as the Alenuihāhā briefing does): typical ${r.tiiMedian.toFixed(1)} (${tiiClass(r.tiiMedian)}), strongest ${r.tiiMax.toFixed(1)} (${tiiClass(r.tiiMax)}). `
        + `In ${Math.round(r.trueFrac * 100)}% of these columns the temperature actually rises through the layer; the rest are very stable layers, not true inversions, which score 0 (the model's levels are ~250 m apart, so sharp inversions get smoothed).`
      : "No inversion found in this hour's columns (950–600 mb).")
      + this.soundingSiteNote(V)
      + (v && this.region.id === "hawaii" ? `<br><b>Checked against ${n} Hilo balloon soundings:</b> the 12 h forecast agrees with the balloon on whether there's an inversion ${v.agreement_pct}% of the time (it misses some the balloon sees), and its base runs about ${Math.abs(v.base_m.bias)} m ${v.base_m.bias < 0 ? "low" : "high"} (typical error ${v.base_m.median_abs} m). Treat the band as indicative.` : "");
    this.updateBalloon();
  }

  // The model's inversion at the region's balloon site, found and scored the way the Alenuihāhā
  // briefing scores the Hilo sounding (TII: strong >= 6, moderate >= 3, weak below), plus its
  // gap-wind flag (TII with the 850-925 mb trades) in Hawaiʻi. A single column, not smoothed.
  soundingSite() { return (this.region?.stations || []).find((s) => s.kind === "sounding") || null; }
  // The model's single column at the balloon site: {d (detector result), llw (kt)} or null.
  modelAtSite(V, st) {
    const q = V.merc.ij(st.lat, st.lon), i = Math.round(q.i - V.raw.crop.i0), j = Math.round(q.j - V.raw.crop.j0);
    if (i < 0 || j < 0 || i >= V.w || j >= V.h) return null;
    const c = j * V.w + i, raw = V.raw, L = raw.levels;
    const col = (f) => L.map((_, k) => raw.data[f][k][c]);
    const d = detectColumn(col("TMP"), col("RH"), col("HGT"), L, { terrainM: V.terrain[c] });
    const llw = pct75(L.map((mb, k) => (mb >= 850 && mb <= 925 ? Math.hypot(raw.data.UGRD[k][c], raw.data.VGRD[k][c]) * 1.943844 : NaN)));
    return { d, llw };
  }
  invText(d) {
    return d.base_m != null ? `inversion ${Math.round(d.base_m).toLocaleString()}–${Math.round(d.top_m).toLocaleString()} m, TII ${d.tii.toFixed(1)} (${tiiClass(d.tii)})` : "no inversion (950–600 mb)";
  }
  soundingSiteNote(V) {
    const st = this.soundingSite();
    if (!st || !V) return "";
    const m = this.modelAtSite(V, st);
    if (!m) return "";
    const name = st.label.replace(/ sounding.*$/i, "");
    const trades = Number.isFinite(m.llw) ? `; 850–925 mb wind ${fmtSpeed(m.llw)}` : "";
    const flag = this.region.id === "hawaii" ? ` · gap-wind flag <b>${riskFlag(m.d.tii, m.llw)}</b> (the Alenuihāhā briefing's rule)` : "";
    return `<br><b>Model at ${name}</b> (the balloon site, ${this.fhrLabel(V.raw.fhr)}): ${this.invText(m.d)}${trades}${flag}.`
      + (st.iemId ? `<br><span id="balloon-note">Latest ${name} balloon: looking it up…</span>` : "");
  }

  // The latest balloon (IEM), and the model at the launch hour when that's in this run.
  async updateBalloon() {
    const st = this.soundingSite(), el = () => $("balloon-note");
    if (!st?.iemId || !el()) return;
    const name = st.label.replace(/ sounding.*$/i, ""), region = this.region.id, cycle = this.cycle;
    const b = await latestSounding(st.iemId, { region });
    if (!el() || this.cycle !== cycle) return;
    if (b.error) { el().innerHTML = `Latest ${name} balloon: not available (${b.error}).`; return; }
    const ageH = (Date.now() - b.valid) / 3600e3, when = `${String(b.valid.getUTCHours()).padStart(2, "0")}Z ${b.valid.toUTCString().slice(0, 11)}`;
    const age = ageH < 48 ? `${Math.round(ageH)} h ago` : `${Math.round(ageH / 24)} days ago`;
    if (ageH > 48) {
      el().innerHTML = `<b>${name} balloon:</b> the newest in IEM's archive is ${when} (${age}), too old to compare with this run. (IEM's copy of this site lags; the University of Wyoming has newer ones but doesn't allow browser access.)`;
      return;
    }
    const trades = Number.isFinite(b.llwKt) ? `; 850–925 mb wind ${fmtSpeed(b.llwKt)}` : "";
    const flag = b.flag ? ` · flag <b>${b.flag}</b>` : "";
    let html = `<b>${name} balloon</b>, ${when} (${age}): ${this.invText(b.det)}${trades}${flag}.`;
    // Compare with the model at the launch hour (or the run's nearest hour).
    const f0 = +$("fhr").min, f1 = +$("fhr").max, fl = Math.round((b.valid - cycle) / 3600e3), fh = Math.max(f0, Math.min(f1, fl));
    const gap = Math.abs(fl - fh);
    const Vs = this.cache.get(fh);
    if (!Vs) {
      el().innerHTML = html + ` <i>Loading the model hour of the launch to compare…</i>`;
      this.loadOnce(fh).then(() => { if (this.cycle === cycle) this.updateBalloon(); }).catch(() => {});
      return;
    }
    const m = this.modelAtSite(Vs, st);
    if (m) {
      const bi = b.det.base_m != null, mi = m.d.base_m != null;
      const verdict = bi && mi ? `<b>agree</b> on an inversion; the model's base is ${Math.abs(Math.round(m.d.base_m - b.det.base_m))} m ${m.d.base_m < b.det.base_m ? "lower" : "higher"}, TII ${m.d.tii.toFixed(1)} vs ${b.det.tii.toFixed(1)}`
        : !bi && !mi ? "<b>agree</b>: neither finds an inversion"
        : bi ? "<b>disagree</b>: the balloon finds an inversion, the model doesn't" : "<b>disagree</b>: the model finds an inversion, the balloon doesn't";
      html += `<br>Model at ${name} ${gap ? `(nearest hour in this run, ${gap} h after the launch)` : "at the launch hour"}: ${this.invText(m.d)}. They ${verdict}.`;
    }
    el().innerHTML = html;
  }

  applyPreset(id, { keepView = false } = {}) {
    const p = PRESETS.find((q) => q.id === id);
    if (!p) return;
    const s = p.set;
    $("preset-note").textContent = p.tip;
    this.spec = { h: s.slice.h, ref: s.slice.ref, field: s.field };
    $("show-slice").checked = s.slice.on;
    $("show-curtain").checked = s.curtain.on;
    $("show-inversion").checked = !!s.inversion;
    $("show-turb").checked = !!s.turbulence;
    const wo = s.waterOnly ?? true;                               // most presets: over water only (the default)
    if ($("water-only").checked !== wo) { $("water-only").checked = wo; this.clip.on = wo; this.drawGlyphs?.(this.lastPath); }
    const pt = s.particles || { on: false };
    $("show-particles").checked = pt.on;
    if (pt.range) $("pt-range").value = pt.range;
    if (pt.colour) $("pt-colour").value = pt.colour;
    if (pt.vertical) $("pt-interp").checked = true;
    $("pt-vertical").checked = !!pt.vertical;                         // (not left on from an earlier preset)
    $("pt-gusty").checked = !!pt.gusty;
    $("slice-gusty").checked = !!s.slice.gusty;
    // The surface scene: what the preset names on, the rest off or back to its default (presets.js).
    const ctl = (id, v) => {
      const e = $(id); if (!e) return;
      if (e.type === "checkbox") { if (e.checked === !!v) return; e.checked = !!v; } else { if (e.value === String(v)) return; e.value = String(v); }
      e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const gl = s.glyphs || {}, cu = s.currents, sea = s.sea;
    ctl("wind-barbs", gl.barbs); ctl("wind-stream", gl.stream); ctl("op-slice", s.sliceOp ?? 0.85);
    ctl("show-sea", !!sea?.on); ctl("sea-fill", sea ? sea.fill !== false : true); ctl("sea-crests", sea ? sea.crests !== false : true);
    ctl("sea-arrows", !!sea?.arrows); ctl("sea-mode", sea?.mode || "total");
    ctl("show-cur", !!cu && !$("cur-layer").hidden);
    if (cu) { ctl("cur-fill", cu.fill !== false); ctl("cur-arrows", cu.arrows || "grid"); ctl("cur-parts", cu.parts !== false); ctl("cur-lines", !!cu.lines); ctl("cur-marks", cu.marks || "rings"); ctl("cur-flag", cu.flag !== false); if (cu.waves != null) ctl("cur-waves", cu.waves); }
    ctl("show-fog", !!s.fog); ctl("show-clouds", !!s.clouds); ctl("show-sat", !!s.sat);
    this.waves.setStyle(this.seaStyle());
    $("pt-wboost").value = String(pt.wBoost || 1);
    this.syncHeight();
    if (!keepView) {
      if (!s.flat && this.stage.is2D) this.stage.set2D(false);
      this.goView(s.view(this.region));
      if (s.flat && !this.stage.is2D) setTimeout(() => this.stage.set2D(true), 900);   // (after the view has flown in: 2D keeps its middle)
    }
    this.redraw();
    this.updateParticles();
    $("preset-select").value = id; this.lastPreset = id;
    if (this.presetInfo?.auto && !keepView) this.presetInfo.show(p, this.region);
    if (s.inspect) this.inspectDefault();
  }

  // Links: "model,run,cycle,fhr,h,ref,field,slice,curtain,top" (m=), preset separately (p=).
  toParam() {
    if (!this.vol || !this.cycle) return null;
    return [this.model.id, $("run-select").value, cycleKey(this.cycle), +$("fhr").value, this.spec.h, this.spec.ref, this.spec.field,
      $("show-slice").checked ? 1 : 0, $("show-curtain").checked ? 1 : 0, $("top-select").value].join(",");
  }
  async fromParam(s) {
    const [id, run, cyc, fhr, h, ref, field, sl, cu, top] = String(s).split(",");
    const c = parseCycle(cyc);
    if (!this.models.some((m) => m.id === id && m.region === this.region.id) || !c) return;
    $("model-select").value = id; this.describe();
    if (RUN_H[run]) $("run-select").value = run;
    if ([...$("top-select").options].some((o) => o.value === top)) $("top-select").value = top;
    this.spec = { h: +h || 10, ref: ref === "msl" ? "msl" : "agl", field: COLOUR_BY[field] ? field : "speed" };
    $("show-slice").checked = sl !== "0"; $("show-curtain").checked = cu === "1";
    this.syncHeight();
    try { await this.open(c, +fhr || 0); } catch (e) { this.fail(e); }
  }
  // Particles: "on,range,colour,interp,vertical,wboost,density,heads,width"
  ptParam() {
    if (!$("show-particles").checked) return null;
    const o = this.ptOpts();
    return [1, o.range, o.colour, o.interp ? 1 : 0, o.vertical ? 1 : 0, o.wBoost, o.density, o.heads ? 1 : 0, $("pt-width").value].join(",");
  }
  fromPtParam(v) {
    const [on, range, colour, interp, vertical, wb, dens, hd, wid] = String(v).split(",");
    if ([...$("pt-width").options].some((o) => o.value === wid)) { $("pt-width").value = wid; this.particles.setWidth(+wid); }
    $("show-particles").checked = on === "1";
    if ([...$("pt-range").options].some((o) => o.value === range)) $("pt-range").value = range;
    if (PARTICLE_COLOURS[colour]) $("pt-colour").value = colour;
    $("pt-interp").checked = interp !== "0"; $("pt-vertical").checked = vertical !== "0";
    if ([...$("pt-wboost").options].some((o) => o.value === wb)) $("pt-wboost").value = wb;
    if (isFinite(+dens)) { $("pt-density").value = dens; $("pt-density-val").textContent = `${(+dens).toFixed(1)}×`; }
    $("pt-heads").checked = hd === "1";
    this.updateParticles();
  }
  presetParam() { const v = $("preset-select").value; return v === "custom" ? null : v; }

  validLabel() { return this.vol ? `${this.model.label} · ${this.fhrLabel(+$("fhr").value)}` : null; }
}

// Sun elevation (degrees) at a time and place: the usual low-precision solar formulas (good to
// a fraction of a degree, plenty for shading day and night).
function sunElevation(ms, lat, lon) {
  const d = ms / 86400e3 - 10957.5, rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 3.6e-7 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
