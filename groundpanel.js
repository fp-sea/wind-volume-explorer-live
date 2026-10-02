// Land and Water controls: two separate blocks (owner, 2026-09-27), neither affecting the other.
//
//   Land   Terrain on/off · relief (1×, 1.5×, 2×, 3×, match vertical exaggeration = default) ·
//          ground style (shaded relief / satellite photo / plain dark) · roads & waterways
//          (radar-explorer's Ground block and its defaults)
//   Water  surface style (plain sea / satellite photo / plain dark) · marine chart (NOAA ENC):
//          off by default, opacity 0.75, soundings when zoomed in (off), depth key (off),
//          as radar-explorer at 7439092/fdbb733
//
// Also: depth units (ft default, as radar-explorer), and a hover readout of ground height or
// chart depth under the pointer. The chart has a style: the vector chart above, or a paper-style
// raster (layers/chartimg.js): NOAA's live Chart Display Service, or chart 19320 (Hawaiʻi).

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Ground } from "./layers/ground.js?v=20261002173952";
import { LinesLayer } from "./layers/lines.js?v=20261002173952";
import { ChartLayer, DEPTH_BANDS } from "./layers/chart.js?v=20261002173952";
import { RasterChart, degAspect } from "./layers/chartimg.js?v=20261002173952";
import { LITE } from "./device.js?v=20261002173952";

const $ = (id) => document.getElementById(id);
const FT = 3.28084;

export class GroundPanel {
  constructor({ stage, onChange }) {
    this.stage = stage;
    this.onChange = onChange || (() => {});
    this.ground = new Ground();
    this.lines = new LinesLayer();
    this.chart = new ChartLayer();
    this.chart.setOpacity(+$("chart-op").value);
    this.raster = new RasterChart();                          // paper-style charts: NOAA live, or chart 19320
    this.raster.setOpacity(+$("chart-op").value);
    stage.scene.add(this.ground.group, this.lines.group, this.chart.group, this.raster.group);
    $("chart-style").addEventListener("change", () => this.syncChart());
    $("chart-live").addEventListener("change", () => this.syncChart());
    const re = () => this.rebuildLand();
    $("show-terrain").addEventListener("change", re);
    $("terrain-relief").addEventListener("change", re);
    $("ground-select").addEventListener("change", re);
    $("show-lines").addEventListener("change", () => this.rebuildLines());
    $("water-select").addEventListener("change", () => this.rebuildWater());
    $("show-chart").addEventListener("change", () => this.syncChart());
    $("chart-snd").addEventListener("change", () => this.syncSoundings());
    $("chart-key").addEventListener("change", () => this.syncKey());
    $("depth-units").addEventListener("change", () => { this.syncSoundings(); this.syncKey(); if (this.style() === "noaa") this.syncChart(); });
    $("chart-op").addEventListener("input", (e) => { this.chart.setOpacity(+e.target.value); this.raster.setOpacity(+e.target.value); $("chart-op-val").textContent = (+e.target.value).toFixed(2); stage.markDirty(); });
    $("chart-op-val").textContent = (+$("chart-op").value).toFixed(2);
    let t = null;
    stage.controls.addEventListener("change", () => { if (!$("chart-snd").checked || !this.chart.group.visible) return; clearTimeout(t); t = setTimeout(() => this.syncSoundings(), 150); });
    let td = null;                                            // the live chart: a sharper image of the view when zoomed in
    stage.controls.addEventListener("change", () => { if (this.style() !== "noaa") return; clearTimeout(td); td = setTimeout(() => this.syncDetail(), this.live() ? 600 : 250); });
    this.hover();
  }

  // Relief actually applied to terrain heights (radar-explorer's rule: min(relief, vex), or vex when "match").
  relief() {
    const r = $("terrain-relief").value;
    return r === "match" ? this.stage.vex : Math.min(+r, this.stage.vex);
  }
  groundKm(x, y) { return $("show-terrain").checked ? this.ground.heightKm(x, y) * this.relief() : 0; }
  get ready() { return this.ground.ready; }

  async setRegion(region, proj) {
    this.region = region; this.proj = proj;
    const ok = await this.ground.load(region.id).catch(() => false);
    $("ground-note").textContent = ok ? "" : "Ground layers aren't built for this region yet (python -m pipeline.ground).";
    await Promise.all([this.lines.load(region.id), this.chart.load(region.id)]);
    const r = await fetch(`data/${region.id}/chart19320.json`, { cache: "no-cache" }).catch(() => null);
    this.staticMeta = r?.ok ? await r.json() : null;
    const ri = await fetch(`data/${region.id}/noaachart/index.json`, { cache: "no-cache" }).catch(() => null);
    this.storedIndex = ri?.ok ? await ri.json() : null;
    // Styles on offer here: vector if built, the live chart always, 19320 where it covers the region.
    for (const o of $("chart-style").options) o.hidden = o.disabled = (o.value === "vector" && !this.chart.data) || (o.value === "c19320" && !this.staticMeta);
    if ($("chart-style").selectedOptions[0]?.disabled) $("chart-style").value = this.chart.data ? "vector" : "noaa";
    this.raster.clear();
    this.chart.group.visible = $("show-chart").checked && this.style() === "vector";
    const bands = this.ground.meta?.chart?.bands;
    this.vectorInfo = this.chart.data
      ? `NOAA ENC ${bands?.join(" + ") || ""} bands. US charts only: Canadian waters show <b>no chart data</b> (not deep water). Not for navigation.`
      : "Vector chart not built for this region.";
    $("show-chart").disabled = false;                        // the live NOAA chart works anywhere in US waters
    $("chart-box").hidden = !$("show-chart").checked;
    await Promise.all([this.rebuildLand(), this.rebuildWater()]);
    this.rebuildLines();
    this.syncChart();
  }

  async rebuildLand() {
    const on = $("show-terrain").checked;
    await this.ground.buildLand({ on, style: $("ground-select").value, relief: this.relief() });
    const r = $("terrain-relief").value, vex = this.stage.vex;
    $("relief-note").hidden = r === "match" || +r === vex;
    $("relief-note").textContent = `Terrain is at ${Math.min(+r, vex)}×, the model at ${vex}×: ridges and model levels are not in step.`;
    this.rebuildLines();
    this.onChange();
    this.stage.markDirty();
  }

  async rebuildWater() {
    await this.ground.buildWater({ on: true, style: $("water-select").value });
    this.stage.markDirty();
  }

  rebuildLines() {
    // Label thinning: our domains are seen whole and tilted, so use radar-explorer's "large area"
    // spacing (it starts at 330 km) from 250 km up; its own rule is kept unchanged in lines.js.
    const raw = this.proj ? Math.max(this.proj.box.x1 - this.proj.box.x0, this.proj.box.y1 - this.proj.box.y0) : 300;
    const span = raw >= 250 ? Math.max(raw, 340) : raw;
    this.lines.build($("show-lines").checked, $("show-terrain").checked ? (x, y) => this.ground.heightKm(x, y) : null, this.relief(), span);
    this.stage.markDirty();
  }

  onVex() { return this.rebuildLand(); }

  style() { return $("chart-style").value; }
  live() { return $("chart-live").checked || !this.storedIndex; }            // no stored copy here: live
  syncChart() {
    const on = $("show-chart").checked, st = this.style(), vec = on && st === "vector" && !!this.chart.data;
    this.chart.group.visible = vec;
    $("chart-box").hidden = !on;
    // Soundings and the depth key belong to the vector chart; 19320 is printed in fathoms.
    $("chart-snd").closest("label").hidden = $("chart-key").closest("label").hidden = st !== "vector";
    $("depth-units").closest(".inline").hidden = st === "c19320";
    $("chart-live-row").hidden = st !== "noaa";
    $("chart-live").disabled = !this.storedIndex;
    const live = this.live(), feetOnly = !live && $("depth-units").value === "m";
    const info = {
      vector: this.vectorInfo,
      noaa: live
        ? `NOAA's current chart (ENC) in paper-chart style, live from the NOAA Chart Display Service; sharper detail (soundings, lights) loads for the area in view when you zoom in. Depths in ${$("depth-units").value === "m" ? "metres" : "feet"}.${this.storedIndex ? "" : " (No stored copy for this region.)"} US waters only. Not for navigation.`
        : `NOAA's chart (ENC) in paper-chart style: a copy stored with this site, as of ${this.storedIndex.fetched}; sharper tiles load for the area in view when you zoom in. Depths in feet${feetOnly ? " (the stored copy is in feet: tick Live for metres)" : ""}. Tick <b>Live from NOAA</b> for the latest and the finest detail close in. US waters only. Not for navigation.`,
      c19320: this.staticMeta ? `NOAA chart ${this.staticMeta.chart}, ${this.staticMeta.title}, ${this.staticMeta.scale}, soundings in fathoms: a fixed copy of the ${this.staticMeta.edition}. Georeferenced from its own latitude/longitude grid. Not for navigation.` : "",
    }[st];
    $("chart-info").innerHTML = info || "";
    this.raster.group.visible = on && st !== "vector";
    if (!on || st === "vector") this.raster.clear();
    else if (st === "noaa" && live && this.region?.bbox) this.raster.showLive(this.region.bbox, this.proj, $("depth-units").value).then(() => { this.syncDetail(); this.stage.markDirty(); }, (e) => { $("chart-info").textContent = `NOAA chart unavailable (NOAA's server): ${e.message}. Untick Live to use the stored copy.`; });
    else if (st === "noaa") this.raster.showStored(this.region.id, this.storedIndex, this.proj).then(() => { this.syncDetail(); this.stage.markDirty(); }, (e) => { $("chart-info").textContent = `Stored NOAA chart unavailable: ${e.message}`; });
    else if (st === "c19320" && this.staticMeta) this.raster.showStatic(this.region.id, this.staticMeta, this.proj).then(() => this.stage.markDirty(), (e) => { $("chart-info").textContent = `Chart 19320 unavailable: ${e.message}`; });
    this.syncSoundings(); this.syncKey();
    this.stage.markDirty();
  }
  // The area on screen (lat/lon, clipped to the region) when zoomed in well past the whole region;
  // else null. Sampled from a grid of screen points hitting sea level.
  viewBox() {
    const cam = this.stage.camera, el = this.stage.renderer.domElement, rc = new THREE.Raycaster(), v = new THREE.Vector2(), hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), b = this.region.bbox, pts = [];
    cam.updateMatrixWorld();                                   // current even if no frame has rendered since the move
    for (let j = 0; j <= 6; j++) for (let i = 0; i <= 6; i++) {
      v.set((i / 6) * 2 - 1, (j / 6) * 2 - 1); rc.setFromCamera(v, cam);
      if (rc.ray.intersectPlane(plane, hit)) pts.push(this.proj.toLatLon(hit.x, hit.y));
    }
    if (pts.length < 12) return null;
    const box = { latMin: Math.max(b.latMin, Math.min(...pts.map((p) => p.lat))), latMax: Math.min(b.latMax, Math.max(...pts.map((p) => p.lat))),
                  lonMin: Math.max(b.lonMin, Math.min(...pts.map((p) => p.lon))), lonMax: Math.min(b.lonMax, Math.max(...pts.map((p) => p.lon))) };
    if (!(box.latMax > box.latMin && box.lonMax > box.lonMin)) return null;
    const frac = ((box.latMax - box.latMin) * (box.lonMax - box.lonMin)) / ((b.latMax - b.latMin) * (b.lonMax - b.lonMin));
    if (frac > 0.35) return null;                              // zoomed out: the base image is enough
    const aspect = degAspect(box);                             // square pixels in degrees (see chartimg.js)
    const px = Math.min(LITE ? 2048 : 3072, Math.round(Math.max(el.clientWidth, el.clientHeight) * Math.min(2, devicePixelRatio || 1)));
    return { ...box, w: aspect >= 1 ? px : Math.round(px * aspect), h: aspect >= 1 ? Math.round(px / aspect) : px };
  }
  syncDetail() {
    if (!$("show-chart").checked || this.style() !== "noaa" || !this.region?.bbox) return;
    const v = this.viewBox(), done = () => this.stage.markDirty();
    if (this.live()) this.raster.showLiveDetail(v, this.proj, $("depth-units").value).then(done, () => {});
    else this.raster.showStoredDetail(v, this.proj).then(done, () => {});
  }

  fmtDepth(m) { return $("depth-units").value === "ft" ? `${Math.round(m * FT)}` : (m < 10 ? m.toFixed(1) : `${Math.round(m)}`); }

  syncSoundings() {
    if (!this.chart.group.visible || !$("chart-snd").checked) { this.chart.labels.clear(); this.stage.markDirty(); return; }
    const cam = this.stage.camera, tgt = this.stage.controls.target;
    const d = cam.position.distanceTo(tgt), kmPerPx = (2 * d * Math.tan((cam.fov / 2) * Math.PI / 180)) / window.innerHeight;
    const mk = (text, cls, pos) => { const el = document.createElement("div"); el.className = `label ${cls}`; el.textContent = text; const o = new CSS2DObject(el); o.position.copy(pos); return o; };
    this.chart.soundingLabels({ kmPerPx, center: { x: tgt.x, y: tgt.y } }, mk, (m) => this.fmtDepth(m));
    this.stage.markDirty();
  }

  // The depth key: in the panel, and (via legend()) in exports.
  syncKey() {
    const on = this.chart.group.visible && $("chart-key").checked;
    $("depth-key").hidden = !on;
    if (!on) return;
    const u = $("depth-units").value;
    const label = (s) => (u === "m" ? s : s.replace(/\d+/g, (n) => Math.round(n * FT)));
    $("depth-key").innerHTML = `<div class="lbl">Chart depth (${u})</div>` + DEPTH_BANDS.map(([, c, name]) =>
      `<span class="dk"><i style="background:${c}"></i>${name === "dries" ? "dries" : label(name)}</span>`).join("");
  }
  legend() {
    if (!(this.chart.group.visible && $("chart-key").checked)) return null;
    const c = document.createElement("canvas"); c.width = 256; c.height = 12;
    const g = c.getContext("2d"), n = DEPTH_BANDS.length;
    DEPTH_BANDS.forEach(([, col], i) => { g.fillStyle = col; g.fillRect((i * 256) / n, 0, 256 / n + 1, 12); });
    const u = $("depth-units").value, f = (m) => (u === "ft" ? Math.round(m * FT) : m);
    return { title: `Chart depth (${u}), NOAA ENC`, bar: c, ticks: [["dries", 0.5 / n], [String(f(10)), 4.5 / n], [String(f(50)), 6.5 / n], [`${f(200)}+`, 8.5 / n]] };
  }

  // Hover readout: ground height on land, chart depth on water (when the chart is on).
  hover() {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3();
    this.stage.renderer.domElement.addEventListener("pointermove", (e) => {
      const r = this.stage.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.stage.camera);
      const targets = [this.ground.land, this.ground.water].filter(Boolean);
      const hits = targets.length ? ray.intersectObjects(targets, false) : [];
      const p = hits[0]?.point || (ray.ray.intersectPlane(plane, hit) ? hit : null);
      if (!p || !this.proj?.contains(p.x, p.y)) { $("hover").textContent = ""; return; }
      const ll = this.proj.toLatLon(p.x, p.y);
      let s = `${ll.lat.toFixed(3)}°, ${ll.lon.toFixed(3)}°`;
      if (this.ground.ready && this.ground.isLand(p.x, p.y)) s += ` · ground ${Math.round(this.ground.heightKm(p.x, p.y) * 1000)} m`;
      else if ($("show-chart").checked && this.chart.data) {                  // depths from the vector data under any chart style
        const q = this.chart.probe(p.x, p.y), u = $("depth-units").value;
        if (q?.sounding != null) s += ` · sounding ${this.fmtDepth(q.sounding)} ${u}`;
        else if (q?.d1 != null) s += ` · depth ${this.fmtDepth(q.d1)}–${q.d2 != null ? this.fmtDepth(q.d2) : "?"} ${u}`;
        else s += " · no US chart data here";
      }
      $("hover").textContent = s;
    });
  }

  credits() {
    return [...this.ground.credits(), $("show-lines").checked && this.lines.data ? this.lines.data.credit : null,
      this.chart.group.visible ? this.chart.data?.credit : null,
      this.raster.group.visible && this.style() === "noaa" ? `Chart: NOAA Chart Display Service (ENC)${this.live() ? "" : `, stored ${this.storedIndex?.fetched}`}` : null,
      this.raster.group.visible && this.style() === "c19320" ? "Chart: NOAA chart 19320 (last edition)" : null].filter(Boolean).join(". ");
  }

  // Links: "terrain,relief,ground,lines,water" and "chart=op[,snd][,key]" (radar-explorer's form); units separately.
  toParams() {
    return {
      land: [$("show-terrain").checked ? 1 : 0, $("terrain-relief").value, $("ground-select").value, $("show-lines").checked ? 1 : 0].join(","),
      water: $("water-select").value,
      chart: $("show-chart").checked ? [$("chart-op").value, $("chart-snd").checked ? "snd" : null, $("chart-key").checked ? "key" : null, this.style() !== "vector" ? this.style() : null, this.style() === "noaa" && $("chart-live").checked ? "live" : null].filter(Boolean).join(",") : null,
      du: $("depth-units").value === "ft" ? null : $("depth-units").value,
    };
  }
  async fromParams({ land, water, chart, du }) {
    if (land) {
      const [t, r, g, l] = land.split(",");
      $("show-terrain").checked = t !== "0";
      if ([...$("terrain-relief").options].some((o) => o.value === r)) $("terrain-relief").value = r;
      if ([...$("ground-select").options].some((o) => o.value === g)) $("ground-select").value = g;
      $("show-lines").checked = l !== "0";
    }
    if (water && [...$("water-select").options].some((o) => o.value === water)) $("water-select").value = water;
    if (du === "m" || du === "ft") $("depth-units").value = du;
    if (chart) {
      const [op, ...flags] = chart.split(",");
      $("show-chart").checked = true;
      if (isFinite(+op)) { $("chart-op").value = op; this.chart.setOpacity(+op); $("chart-op-val").textContent = (+op).toFixed(2); }
      $("chart-snd").checked = flags.includes("snd");
      $("chart-key").checked = flags.includes("key");
      const st = flags.find((f) => f === "noaa" || f === "c19320") || (flags.includes("live") ? "noaa" : null);   // "live" alone: links from before the stored copy
      if (st) $("chart-style").value = st;
      $("chart-live").checked = flags.includes("live");
    }
    await Promise.all([this.rebuildLand(), this.rebuildWater()]);
    this.syncChart();
  }
}
