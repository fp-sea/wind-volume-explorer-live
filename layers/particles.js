// Wind particles through the whole volume.
//
// Motion is the model's real wind, sped up so it reads: 10 m/s crosses ~3% of the domain a
// second, whatever the domain's size (radar-explorer's rule). Everything that bends a path,
// eddies and rotation included, is already in the real u, v; vorticity is a diagnostic of
// that wind, so it colours particles (Colour by: rotation) and never pushes them (brief 4.7).
//
// Two ways to place particles in height:
//   interpolate ON   anywhere in the column. Their height coordinate η is height above ground
//                    near the surface blending to height above sea level aloft
//                    (z = η + ground · max(0, 1 − η/H), H = 6 km), so near-surface particles
//                    follow the terrain and particles aloft don't. The wind is resampled once
//                    per forecast hour onto fixed η levels (from volume.js), then trilinear.
//   interpolate OFF  only on the model's own levels (10-320 m above ground, and each pressure
//                    level at its real height); no values in between are made up.
// Vertical motion (w, from DZDT) is optional, and it gets the same time speed-up as the
// horizontal. On screen it's also multiplied by the vertical exaggeration, and an extra boost
// can be applied.
//
// Rendering (streaks with additive glow, fading tails, optional heads) is radar-explorer's
// web/particles.js@20a7d31.

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { sample as rampSample, uwWind, RI_CLASSES, riClass } from "./colormap.js?v=20261002173952";
import { EtaFlow, LevelFlow, H_BLEND, zOf } from "../model/flow.js?v=20261002173952";
import { tkeAt } from "../model/tke.js?v=20261002173952";

const TRAIL = 12;                   // points per streak (11 segments)
const KT = 1.943844;
const INK = [0.04, 0.13, 0.17];
const BG = [0.043, 0.102, 0.125];     // the scene's clear colour (#0b1a20): solid streaks fade to it

// Particle colours. Additive glow on a dark scene: low values dim, high values bright.
const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
export const PARTICLE_COLOURS = {
  // UW WRF wind bands (the family's model-map key). Drawn solid, not glowing: glow would wash these pastels to white.
  speed: { label: "speed (UW WRF wind bands)", uw: true, range: [0, 47.5], units: "kt", solid: true },
  height: { label: "height", bands: [[100, "#ffffff", "< 100 m"], [500, "#5ee6ff", "100–500 m"], [1500, "#6cf07a", "0.5–1.5 km"], [3000, "#ffe45c", "1.5–3 km"], [5500, "#ffa53c", "3–5.5 km"], [Infinity, "#ff6fd8", "> 5.5 km"]] },
  updown: { label: "up / down", stops: ["#4f9dff", "#3a5f8f", "#4a4a48", "#a3483c", "#ff6b5a"].map(hex), range: [-1, 1], units: "m/s" },
  rotation: { label: "rotation", stops: ["#4f9dff", "#3a5f8f", "#4a4a48", "#a3483c", "#ff6b5a"].map(hex), range: [-5, 5], units: "10⁻⁴/s" },
  // Turbulence proxy class (Richardson number): red likely, amber possible, dim otherwise.
  turbulence: { label: "turbulence proxy (Ri)", ri: true },
};

// SYNC: radar-explorer web/particles.js@20a7d31 dotTexture, heads, streaks. Copied verbatim.
let dotTex = null;
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d"), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.45, "rgba(255,255,255,0.8)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  return (dotTex = new THREE.CanvasTexture(c));
}
function heads(count, size) {
  const geo = new THREE.BufferGeometry(), hp = new Float32Array(count * 3), hc = new Float32Array(count * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(hp, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(hc, 3).setUsage(THREE.DynamicDrawUsage));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: dotTexture(), vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.frustumCulled = false;
  pts.renderOrder = 31;
  return { pts, hp, hc };
}

function streaks(count, width, resolution) {
  const segs = count * (TRAIL - 1), geo = new LineSegmentsGeometry();
  geo.setPositions(new Float32Array(segs * 6));
  geo.setColors(new Float32Array(segs * 6));
  const mat = new LineMaterial({ vertexColors: true, linewidth: width, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.resolution.copy(resolution);
  const lines = new LineSegments2(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 30;
  return { lines, pos: geo.attributes.instanceStart.data.array, col: geo.attributes.instanceColorStart.data.array };
}
// END SYNC

export class WindParticles {
  constructor() {
    this.group = new THREE.Group();
    this.set = null;
    this.width = 2.5;
    this.resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
    this.opts = { gusty: false, interp: true, vertical: true, wBoost: 1, colour: "speed", density: 1, range: "column", opacity: 0.9, heads: false, sliceH: 10, sliceRef: "agl", ink: false };
    window.addEventListener("resize", () => { this.resolution.set(window.innerWidth, window.innerHeight); if (this.set) this.set.lines.material.resolution.copy(this.resolution); });
  }

  clear() {
    const s = this.set;
    if (s) { s.lines.geometry.dispose(); s.lines.material.dispose(); if (s.pts) { s.pts.geometry.dispose(); s.pts.material.dispose(); } }
    this.group.clear();
    this.set = null;
  }

  // New forecast hour or new options. Particles keep their places when only the hour changes.
  setVolume(vol, ctx, opts = {}, flow = null) {
    const keys = ["interp", "density", "range", "heads", "slabKey", "waterOnly", ...(opts.range === "slice" ? ["sliceH", "sliceRef"] : [])];
    const rebuild = !this.set || keys.some((k) => k in opts && opts[k] !== this.opts[k]);
    Object.assign(this.opts, opts);
    this.ctx = ctx;                                             // {proj, groundKm, vexFn}
    this.vol = vol;
    this.flow = flow || (this.opts.interp ? (vol._etaFlow ||= new EtaFlow(vol)).finish() : (vol._levelFlow ||= new LevelFlow(vol)));   // once per hour
    const spanKm = Math.max(ctx.proj.box.x1 - ctx.proj.box.x0, ctx.proj.box.y1 - ctx.proj.box.y0);
    this.timeScale = (spanKm * 1000 * 0.03) / 10;              // model seconds per real second: 10 m/s → 3 % of the domain a second
    const m = vol.merc, i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0;
    // Cell size (m) per row, from the grid's own geometry (Mercator or Lambert).
    this.cellM = Float32Array.from({ length: vol.h }, (_, j) => m.cellSizeM(i0 + vol.w / 2, j0 + j));
    if (rebuild) this.build();
    this.setInk(this.opts.ink);
  }
  // The gust factor per model cell (gust ÷ 10 m wind, ≥ 1) and the depth it applies to (the mixed
  // layer, m above ground), for the gustiness option; null when the model has no gust field.
  setGustField(gf, top) { this.gustF = gf; this.gustTop = top; }
  // HRRR's TKE for the hour on screen ({agl, data}: model/tke.js), for the turbulence jitter.
  setTke(T) { this.tke = T; }

  // Streak width in screen pixels (Size in the particle box).
  setWidth(px) {
    this.width = px;
    const s = this.set;
    if (s) { s.lines.material.linewidth = px; if (s.pts) s.pts.material.size = px * 2.2; }
  }
  setOpacity(o) {
    this.opts.opacity = o;                                        // glow: scales brightness each frame
    const s = this.set;
    if (s && this.mode !== "glow") s.lines.material.opacity = (this.opts.ink ? 0.75 : 1) * o / 0.9;
  }
  // How streaks blend: glow (additive, fades to nothing), solid (normal, fades to the scene
  // background) or ink (dark, over a coloured slice).
  get mode() { return this.opts.ink ? "ink" : PARTICLE_COLOURS[this.opts.colour]?.solid ? "solid" : "glow"; }

  // Ink: dark streaks, normally blended, for drawing over a coloured slice (additive glow would
  // turn everything white there). The slice then carries the value; the streaks carry direction.
  setInk(on) {
    this.opts.ink = on;
    const s = this.set;
    if (!s) return;
    const solid = this.mode !== "glow";
    s.lines.material.blending = solid ? THREE.NormalBlending : THREE.AdditiveBlending;
    s.lines.material.opacity = solid ? (on ? 0.75 : 1) * Math.min(1, this.opts.opacity / 0.9) : 1;
    s.lines.material.needsUpdate = true;
  }

  build() {
    this.clear();
    const o = this.opts, span = Math.max(this.vol.w, this.vol.h) * 2.5;
    const slab = o.range === "xslab" || o.range === "hslab";
    const count = Math.round(Math.min(40000, Math.min(9000, 3500 * Math.sqrt(span / 300)) * o.density * (o.range === "slice" ? 0.6 : slab ? 0.5 : 1)));
    const { lines, pos, col } = streaks(count, this.width, this.resolution);
    this.group.add(lines);
    this.set = { count, lines, pos, col, pi: new Float32Array(count), pj: new Float32Array(count), pe: new Float32Array(count), pl: new Uint8Array(count),
                 hx: new Float32Array(count * TRAIL), hy: new Float32Array(count * TRAIL), hz: new Float32Array(count * TRAIL),
                 age: new Float32Array(count), life: new Float32Array(count), val: new Float32Array(count),
                 dying: new Uint8Array(count), rgb: new Float32Array(count * 3),
                 gph: Float32Array.from({ length: count }, () => Math.random() * 6.283) };   // each particle's own gust rhythm
    if (o.heads) Object.assign(this.set, heads(count, this.width * 2.2)), this.group.add(this.set.pts);
    for (let p = 0; p < count; p++) this.spawn(p, Math.random());
    this.step(0);
  }

  // Where a particle's height starts, by the chosen range.
  randomEta() {
    const o = this.opts, top = this.flow.eta ? this.flow.eta[this.flow.eta.length - 1] : 9000;
    if (o.range === "slice") return o.sliceRef === "agl" ? Math.max(10, o.sliceH) : o.sliceH;
    const hi = o.range === "low" ? Math.min(2000, top) : Math.min(top, 9000);
    return 10 + (hi - 10) * Math.random() ** 1.8;               // more of them low down, where the detail is
  }
  randomLevel() {
    const o = this.opts, L = this.flow.levels;
    if (o.range === "slice") {                                   // the model level nearest the slice height
      let best = 0, d = Infinity;
      L.forEach((lv, k) => {
        // Above-ground levels compare with an above-ground slice; pressure levels with a sea-level one
        // (by their domain-mean height).
        if ((lv.agl != null) !== (o.sliceRef === "agl")) return;
        const z = lv.agl ?? this.vol.pz.find((q) => q.mb === lv.mb)?.z ?? NaN, dd = Math.abs(z - o.sliceH);
        if (dd < d) { d = dd; best = k; }
      });
      return best;
    }
    const maxK = o.range === "low" ? L.findIndex((lv) => lv.mb && lv.mb < 800) : L.length;
    const k = Math.floor((maxK > 0 ? maxK : L.length) * Math.random() ** 1.6);
    return Math.min(L.length - 1, k);
  }

  sample(p) {
    const s = this.set;
    return this.opts.interp ? this.flow.at(s.pi[p], s.pj[p], s.pe[p]) : this.flow.at(s.pl[p], s.pi[p], s.pj[p]);
  }

  // ---------- slabs (CT style): particles only in a slab around the cross-section, or in a layer
  // around the slice height. They move freely in 3D (w included) and are reborn when they leave.
  // opts.slab: {kind: "x", c, u, n, t0, t1, hw (km), zTop (m)} or {kind: "h", ref, h, dh (m)}.
  placeInSlab(p) {
    const s = this.set, v = this.vol, sl = this.opts.slab, m = v.merc, i0 = v.raw.crop.i0, j0 = v.raw.crop.j0;
    if (sl.kind === "x") {
      const t = sl.t0 + Math.random() * (sl.t1 - sl.t0), d = (Math.random() * 2 - 1) * sl.hw;
      const x = sl.c.x + sl.u.x * t + sl.n.x * d, y = sl.c.y + sl.u.y * t + sl.n.y * d, ll = this.ctx.proj.toLatLon(x, y), q = m.ij(ll.lat, ll.lon);
      s.pi[p] = q.i - i0; s.pj[p] = q.j - j0;
      s.pe[p] = 10 + (sl.zTop - 10) * Math.random() ** 1.6;
      return true;
    }
    s.pi[p] = Math.random() * (v.w - 1); s.pj[p] = Math.random() * (v.h - 1);
    const g = this.groundM(p), off = (Math.random() * 2 - 1) * sl.dh;
    if (sl.ref === "agl") { s.pe[p] = Math.max(10, sl.h + off); return true; }
    const z = sl.h + off;                                         // metres above sea level
    if (z < g + 10) return false;                                // under the ground here
    s.pe[p] = z >= H_BLEND ? z : Math.max(10, (z - g) / (1 - g / H_BLEND));   // invert z = η + g(1 − η/H)
    return true;
  }
  groundM(p) {
    const s = this.set, v = this.vol, c = Math.min(v.h - 1, Math.max(0, Math.round(s.pj[p]))) * v.w + Math.min(v.w - 1, Math.max(0, Math.round(s.pi[p])));
    return v.terrain[c] || 0;
  }
  inSlab(p, xyz) {
    const sl = this.opts.slab, s = this.set;
    if (sl.kind === "x") {
      const dx = xyz[0] - sl.c.x, dy = xyz[1] - sl.c.y, d = dx * sl.n.x + dy * sl.n.y, t = dx * sl.u.x + dy * sl.u.y;
      return Math.abs(d) <= sl.hw && t >= sl.t0 && t <= sl.t1 && s.pe[p] <= sl.zTop;
    }
    if (sl.ref === "agl") return Math.abs(s.pe[p] - sl.h) <= sl.dh;
    return Math.abs(zOf(s.pe[p], this.groundM(p)) - sl.h) <= sl.dh;
  }

  spawn(p, ageFrac = 0) {
    const s = this.set, v = this.vol, slab = this.opts.slab && (this.opts.range === "xslab" || this.opts.range === "hslab");
    for (let tries = 0, n = this.opts.waterOnly ? 24 : 8; tries < n; tries++) {   // water only: more tries (the Salish Sea box is mostly land)
      if (slab) { if (!this.placeInSlab(p)) continue; }
      else {
        s.pi[p] = Math.random() * (v.w - 1); s.pj[p] = Math.random() * (v.h - 1);
        if (this.opts.interp) s.pe[p] = this.randomEta(); else s.pl[p] = this.randomLevel();
      }
      const w = this.sample(p);
      if (!w) continue;
      const xyz = this.scene(p, w);
      if (this.opts.waterOnly && this.ctx.isWater && !this.ctx.isWater(xyz[0], xyz[1])) continue;     // over water only: start on the water
      for (let t = 0; t < TRAIL; t++) { s.hx[p * TRAIL + t] = xyz[0]; s.hy[p * TRAIL + t] = xyz[1]; s.hz[p * TRAIL + t] = xyz[2]; }
      s.life[p] = 3 + Math.random() * 5;
      s.age[p] = ageFrac * s.life[p];
      return;
    }
    s.life[p] = 0.5; s.age[p] = 0;
  }

  // Scene position of particle p (km; z exaggerated), on the drawn terrain near the ground.
  scene(p, w) {
    const s = this.set, v = this.vol, ll = v.merc.latLon(v.raw.crop.i0 + s.pi[p], v.raw.crop.j0 + s.pj[p]);
    const q = this.ctx.proj.toXY(ll.lat, ll.lon), vex = this.ctx.vexFn(), g = this.ctx.groundKm(q.x, q.y);
    let z;
    if (this.opts.interp) { const e = s.pe[p]; z = g * Math.max(0, 1 - e / H_BLEND) + (e / 1000) * vex; }
    else { const lv = this.flow.levels[s.pl[p]]; z = lv.agl != null ? g + (lv.agl / 1000) * vex : (w[4] / 1000) * vex; }
    return [q.x, q.y, z];
  }

  colourOf(p, w, spd) {
    const c = PARTICLE_COLOURS[this.opts.colour], s = this.set;
    if (this.opts.colour === "height") {
      const cell = Math.round(s.pj[p]) * this.vol.w + Math.round(s.pi[p]);
      const agl = this.opts.interp ? s.pe[p] : (this.flow.levels[s.pl[p]].agl ?? (w[4] - this.vol.terrain[cell]));
      for (const [lim, col] of c.bands) if (agl < lim) return hex(col);
    }
    if (c.ri) { const k = riClass(w[5]); return k < 0 ? [0.28, 0.32, 0.34] : RI_CLASSES[k].colour; }
    const x = this.opts.colour === "speed" ? spd : this.opts.colour === "updown" ? w[2] : w[3] * 1e4;
    if (!Number.isFinite(x)) return [0.3, 0.3, 0.3];
    if (c.uw) return uwWind(x);
    return rampSample(c.stops, (x - c.range[0]) / (c.range[1] - c.range[0]));
  }

  // Advance dt seconds (capped, so a pause doesn't fling them) and redraw the streaks.
  step(dt) {
    const s = this.set;
    if (!s || !this.vol) return false;
    // After a stall (a background hour decoding), catch up at most ~3 frames: a brief slowdown
    // instead of a visible lurch.
    dt = Math.min(dt, 0.05);
    const o = this.opts, T = this.timeScale * dt, { hx, hy, hz, pos, col } = s, solidMode = this.mode === "solid";
    this.gustClock = (this.gustClock || 0) + dt;
    // A particle that has to end early (reached land with "over water only", left its slab, ran
    // off the grid or under the ground) fades out where it is over this long, instead of
    // vanishing mid-stride; the others fade over the last 0.6 s of their life as before.
    const FADE_OUT = 0.4;
    const retire = (p) => { s.dying[p] = 1; s.life[p] = Math.min(s.life[p], s.age[p] + FADE_OUT); };
    let vi = 0;
    for (let p = 0; p < s.count; p++) {
      const k = p * TRAIL;
      s.age[p] += dt;
      if (s.age[p] > s.life[p]) { s.dying[p] = 0; this.spawn(p); continue; }
      let r, g, b;
      if (s.dying[p]) {
        r = s.rgb[3 * p]; g = s.rgb[3 * p + 1]; b = s.rgb[3 * p + 2];            // holds still and fades
      } else {
      const w = this.sample(p);
      if (!w) { retire(p); r = s.rgb[3 * p]; g = s.rgb[3 * p + 1]; b = s.rgb[3 * p + 2]; } else {
      // Move in grid cells (u east, v north: the Mercator grid's own axes) and in height.
      const cm = this.cellM[Math.max(0, Math.min(this.vol.h - 1, Math.round(s.pj[p])))];
      // Winds are true east/north; turn them to the grid's axes (identity on Mercator, ~16° on the Salish Sea Lambert grid).
      const v = this.vol, [ug, vg] = v.merc.toGrid(w[0], w[1], v.raw.crop.i0 + s.pi[p], v.raw.crop.j0 + s.pj[p]);
      // Gustiness (optional): in the lowest layer, the wind surges and lulls around the mean in
      // proportion to the model's gust factor there. Illustrative rhythm (a couple of pulses a
      // second on screen, each particle its own), not modelled gusts: those are far too short-lived
      // to see at this time scale.
      let gf = 1;
      if (o.gusty && this.gustF) {
        const cc = Math.min(v.h - 1, Math.max(0, Math.round(s.pj[p]))) * v.w + Math.min(v.w - 1, Math.max(0, Math.round(s.pi[p])));
        const G = this.gustF[cc], top = this.gustTop?.[cc] || 1000, agl = o.interp ? s.pe[p] : 10;
        if (G > 1.05 && agl < top) {
          const ph = s.gph[p], tt = this.gustClock;
          const g = Math.max(-0.35, Math.min(1, 0.65 * Math.sin(2.1 * tt + ph) + 0.45 * Math.sin(5.3 * tt + 2 * ph)));
          gf = 1 + (G - 1) * g * (1 - agl / top);
        }
      }
      s.pi[p] += (ug * T * gf) / cm; s.pj[p] += (vg * T * gf) / cm;
      // Turbulence jitter (optional, HRRR's TKE): each step a random nudge, up/down and sideways,
      // the size of turbulent mixing over that stretch of model time: √(2·σ·ℓ·T), σ = √(⅔·TKE),
      // ℓ = 100 m mixing length. Shows where the air is churning; not modelled eddies.
      if (o.tkeJitter && this.tke && o.interp && o.range !== "slice") {
        const cc = Math.min(v.h - 1, Math.max(0, Math.round(s.pj[p]))) * v.w + Math.min(v.w - 1, Math.max(0, Math.round(s.pi[p])));
        const K = tkeAt(this.tke, cc, s.pe[p]);
        if (K > 0.05) {
          const d = Math.sqrt(2 * Math.sqrt((2 / 3) * K) * 100 * T), gz = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.41;
          s.pe[p] = Math.max(10, s.pe[p] + gz() * d);
          s.pi[p] += (gz() * d) / cm; s.pj[p] += (gz() * d) / cm;
        }
      }
      if (o.interp && o.vertical && Number.isFinite(w[2]) && o.range !== "slice") {             // slabs: free in 3D
        // Height z = η + g(1 − η/H) already follows the ground, so η moves with the part of w
        // that isn't just the flow following the terrain: η̇ = (w − (1 − η/H) V·∇g) / (1 − g/H).
        // The boost applies to that departure, so air hugging a slope isn't lifted off it.
        const e = s.pe[p], v2 = this.vol, c = Math.min(v2.h - 1, Math.max(0, Math.round(s.pj[p]))) * v2.w + Math.min(v2.w - 1, Math.max(0, Math.round(s.pi[p])));
        const g = v2.terrain[c] || 0, tg = v2.terrainGrad?.();
        const follow = e < H_BLEND && tg ? (1 - e / H_BLEND) * (ug * tg.gi[c] + vg * tg.gj[c]) : 0;
        const edot = e < H_BLEND ? (w[2] - follow) / Math.max(0.2, 1 - g / H_BLEND) : w[2];
        s.pe[p] = Math.max(10, e + edot * T * o.wBoost);
      }
      const after = this.sample(p), xyz = after ? this.scene(p, after) : null;
      const out = !after || (o.slab && (o.range === "xslab" || o.range === "hslab") && !this.inSlab(p, xyz))   // left the slab
        || (o.waterOnly && this.ctx.isWater && !this.ctx.isWater(xyz[0], xyz[1]));                           // reached land
      if (out) { retire(p); r = s.rgb[3 * p]; g = s.rgb[3 * p + 1]; b = s.rgb[3 * p + 2]; }
      else {
        for (let t = TRAIL - 1; t > 0; t--) { hx[k + t] = hx[k + t - 1]; hy[k + t] = hy[k + t - 1]; hz[k + t] = hz[k + t - 1]; }
        hx[k] = xyz[0]; hy[k] = xyz[1]; hz[k] = xyz[2];
        const spd = Math.hypot(after[0], after[1]) * KT;
        [r, g, b] = o.ink ? INK : this.colourOf(p, after, spd);
        s.rgb[3 * p] = r; s.rgb[3 * p + 1] = g; s.rgb[3 * p + 2] = b;
      }
      }
      }
      // Fade in and out over life; brighter with speed.
      const life = s.life[p], a = s.age[p], fade = Math.max(0, Math.min(1, a / 0.6, (life - a) / (s.dying[p] ? FADE_OUT : 0.6)));
      const bright = o.ink ? 1 : 0.8 * fade * o.opacity;         // colour carries the value; brightness only fades
      if (s.pts) { const hb = Math.min(1.4, bright * 1.3); s.hp.set([hx[k], hy[k], hz[k]], p * 3); s.hc.set([r * hb, g * hb, b * hb], p * 3); }
      for (let t = 0; t < TRAIL - 1; t++) {
        const a0 = o.ink ? 1 : bright * (1 - t / (TRAIL - 1)), a1 = o.ink ? 1 : bright * (1 - (t + 1) / (TRAIL - 1));
        // Solid: fade toward the dark scene colour instead of toward nothing (no per-vertex alpha).
        const mix = (cc, a, bgc) => (solidMode ? bgc + (cc - bgc) * Math.min(1, a / 0.8) : cc * a);
        pos[vi * 3] = hx[k + t]; pos[vi * 3 + 1] = hy[k + t]; pos[vi * 3 + 2] = hz[k + t];
        col[vi * 3] = mix(r, a0, BG[0]); col[vi * 3 + 1] = mix(g, a0, BG[1]); col[vi * 3 + 2] = mix(b, a0, BG[2]); vi++;
        pos[vi * 3] = hx[k + t + 1]; pos[vi * 3 + 1] = hy[k + t + 1]; pos[vi * 3 + 2] = hz[k + t + 1];
        col[vi * 3] = mix(r, a1, BG[0]); col[vi * 3 + 1] = mix(g, a1, BG[1]); col[vi * 3 + 2] = mix(b, a1, BG[2]); vi++;
      }
    }
    // Respawned particles this frame left their old streak slots stale: blank the rest.
    col.fill(0, vi * 3);
    if (s.pts) { s.pts.geometry.attributes.position.needsUpdate = true; s.pts.geometry.attributes.color.needsUpdate = true; }
    s.lines.geometry.attributes.instanceStart.data.needsUpdate = true;
    s.lines.geometry.attributes.instanceColorStart.data.needsUpdate = true;
    return true;
  }
}
