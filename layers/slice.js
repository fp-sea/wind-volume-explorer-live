// Horizontal slice through the volume at one height: either a height above ground (terrain-
// following, draped on the drawn terrain) or above sea level (a flat sheet, with holes where
// the ground is higher). Coloured by any field the volume has at that height; where it
// doesn't (e.g. w below the lowest pressure level), the slice has a hole rather than a guess.

import * as THREE from "three";
import { tkeAt } from "../model/tke.js?v=20261002173952";
import { RAMPS, sample, uwWind, RI_CLASSES, riClass } from "./colormap.js?v=20261002173952";

const KT = 1.943844;

// What a slice or cross-section can be coloured by. value(vol, c, zMsl) in column c;
// sampled(vol, lat, lon, zMsl) anywhere (bilinear, for cross-sections).
const sp = (u, v) => Math.hypot(u, v) * KT;
export const COLOUR_BY = {
  none: { label: "None (wind symbols only)", units: "kt", ramp: "uw", range: [0, 47.5], none: true,
    value: (v, c, z) => sp(v.column("U", c, z), v.column("V", c, z)),
    sampled: (v, la, lo, z) => sp(v.sample("U", la, lo, z), v.sample("V", la, lo, z)), from: ["U", "V"], calc: sp },
  speed: { label: "Wind speed", units: "kt", ramp: "uw", range: [0, 47.5],
    value: (v, c, z) => sp(v.column("U", c, z), v.column("V", c, z)),
    sampled: (v, la, lo, z) => sp(v.sample("U", la, lo, z), v.sample("V", la, lo, z)), from: ["U", "V"], calc: sp },
  gust: { label: "Surface gust", units: "kt", ramp: "uw", range: [0, 47.5], surfaceOnly: true,
    value: (v, c) => (v.raw.surface.GUST ? v.raw.surface.GUST[c] * KT : NaN), sampled: () => NaN },
  w: { label: "Vertical velocity w", units: "m/s", ramp: "diverging", range: [-1, 1],
    value: (v, c, z) => v.column("W", c, z), sampled: (v, la, lo, z) => v.sample("W", la, lo, z), from: ["W"], calc: (x) => x },
  conv: { label: "Convergence (+) / divergence (−)", units: "10⁻⁴/s", ramp: "diverging", range: [-3, 3],
    value: (v, c, z) => convergence(v, c, z),
    sampled: (v, la, lo, z) => { const q = v.merc.ij(la, lo), i = Math.round(q.i - v.raw.crop.i0), j = Math.round(q.j - v.raw.crop.j0); return convergence(v, j * v.w + i, z); } },
  temp: { label: "Temperature", units: "°C", ramp: "orange", range: null,
    value: (v, c, z) => v.column("T", c, z) - 273.15, sampled: (v, la, lo, z) => v.sample("T", la, lo, z) - 273.15, from: ["T"], calc: (x) => x - 273.15 },
  rh: { label: "Relative humidity", units: "%", ramp: "teal", range: [0, 100],
    value: (v, c, z) => v.column("RH", c, z), sampled: (v, la, lo, z) => v.sample("RH", la, lo, z), from: ["RH"], calc: (x) => x },
  vort: { label: "Relative vorticity", units: "10⁻⁴/s", ramp: "diverging", range: [-5, 5],
    value: (v, c, z) => v.column("VORT", c, z) * 1e4, sampled: (v, la, lo, z) => v.sample("VORT", la, lo, z) * 1e4, from: ["VORT"], calc: (x) => x * 1e4 },
  // Turbulence proxies (volume.js stability()): the model has no TKE.
  tke: { label: "Turbulence: model TKE (HRRR only)", units: "m²/s²", ramp: "gold", range: [0, 4], hrrrOnly: true,
    value: (v, c, z) => tkeOf(v, c, z),
    sampled: (v, la, lo, z) => { const q = v.merc.ij(la, lo), i = Math.round(q.i - v.raw.crop.i0), j = Math.round(q.j - v.raw.crop.j0); return i < 0 || j < 0 || i >= v.w || j >= v.h ? NaN : tkeOf(v, j * v.w + i, z); } },
  shear: { label: "Wind shear", units: "kt/1000 ft", ramp: "gold", range: [0, 10], proxy: true,
    value: (v, c, z) => v.column("SHEAR", c, z) * SHEAR_KT_KFT, sampled: (v, la, lo, z) => v.sample("SHEAR", la, lo, z) * SHEAR_KT_KFT },
  ri: { label: "Turbulence proxy (Ri)", units: "class", ramp: "ri", range: [0, 1], proxy: true, classes: RI_CLASSES,
    value: (v, c, z) => v.column("RI", c, z), sampled: (v, la, lo, z) => v.sample("RI", la, lo, z) },
  gustf: { label: "Gust factor (surface)", units: "gust ÷ 10 m wind", ramp: "gold", range: [1, 2], surfaceOnly: true, proxy: true,
    value: (v, c) => { const g = v.raw.surface.GUST?.[c], u = v.raw.agl[10]?.UGRD?.[c], w = v.raw.agl[10]?.VGRD?.[c], sp = Math.hypot(u, w); return g && sp > 2 ? g / sp : NaN; },
    sampled: () => NaN },
  // Vertical mixing (surface maps: the slice at 10 m). The mixed layer is where the air is stirred
  // top to bottom, so the wind anywhere in it can reach the water as gusts.
  pbl: { label: "Mixed-layer depth (model)", units: "m", ramp: "teal", range: [0, 2000], surfaceOnly: true,
    value: (v, c) => v.raw.surface.HPBL?.[c] ?? NaN, sampled: () => NaN },
  mixdown: { label: "Wind in the mixed layer (what can mix down as gusts)", units: "kt", ramp: "uw", range: [0, 47.5], surfaceOnly: true,
    value: (v, c) => mixDown(v, c) * KT, sampled: () => NaN },
  airsea: { label: "Sea minus air temperature (+ unstable, gusty; − stable, smooth)", units: "°C", ramp: "diverging", range: [-5, 5], surfaceOnly: true, proxy: true,
    value: (v, c) => seaMinusAir(v, c), sampled: () => NaN },
};
const SHEAR_KT_KFT = 1.943844 * 304.8;          // (m/s)/m → kt per 1000 ft

// The strongest wind (m/s) between 10 m and the top of the model's mixed layer (HPBL) at column c:
// sampled at fixed heights above ground up to the top (and at the top). NaN without HPBL.
const MIX_H = [10, 40, 80, 150, 250, 400, 600, 800, 1000, 1300, 1600, 2000, 2500, 3000];
export function mixDown(v, c) {
  const top = v.raw.surface.HPBL?.[c];
  if (!Number.isFinite(top)) return NaN;
  const zt = Math.min(3000, Math.max(10, top)), g = v.terrain[c];
  let best = NaN;
  for (const h of [...MIX_H.filter((q) => q < zt), zt]) {
    const s = Math.hypot(v.column("U", c, g + h), v.column("V", c, g + h));
    if (Number.isFinite(s) && !(s <= best)) best = s;
  }
  return best;
}
// Over the water: the sea (the model's skin temperature) minus the air at 2 m (°C). Positive: the
// sea warms the air from below, it's unstable, the wind aloft mixes down (gusty, choppy); negative:
// the air is warmer, it's stable, the surface wind decouples from the wind aloft (smoother, often
// lighter, fog-prone).
export function seaMinusAir(v, c) {
  const s = v.raw.surface;
  if (s.LAND?.[c] > 0.5) return NaN;
  const sea = s.TMP?.[c], air = s.TMP2?.[c];
  return Number.isFinite(sea) && Number.isFinite(air) ? sea - air : NaN;
}

// HRRR's TKE at column c, height z (m above sea level); between hours, the two hours blended.
// NaN until the hour's TKE has loaded (explore.ensureTke) or for models without it.
function tkeOf(v, c, z) {
  const agl = z - v.terrain[c];
  if (v.a && v.b) { const x = tkeAt(v.a._tke, c, agl), y = tkeAt(v.b._tke, c, agl); return Number.isFinite(x) && Number.isFinite(y) ? x + (y - x) * v.t : v.t < 0.5 ? x : y; }
  return tkeAt(v._tke, c, agl);
}

// Horizontal convergence −(∂u/∂x + ∂v/∂y) (10⁻⁴/s) at column c, height z (m above sea level).
// Smoothed derivatives: differences across ±K cells, averaged over the three rows (or columns)
// either side, so the result is at the ~10-15 km scale of convergence zones and sea-breeze fronts
// rather than the grid-scale speckle that every ridge and valley makes. Winds are turned to the
// grid's own axes. On a slice: all at the slice's height (above ground or sea level, as the
// slice is). Elsewhere (hover, cross-section), in the lowest 1.5 km the neighbours are read at
// the same height above their ground, so a terrain step isn't mistaken for convergence. Positive: air piling in, which has to
// rise (the Puget Sound Convergence Zone, sea-breeze fronts, flow meeting behind an island).
const CONV_K = 2;
// Smoothed convergence from grid-axis winds ug, vg (one value per column), at column c.
function convFromGrid(v, ug, vg, c) {
  const { w, h } = v, i = c % w, j = (c - i) / w, K = CONV_K;
  if (i < K || j < K || i > w - 1 - K || j > h - 1 - K) return NaN;
  let dudx = 0, dvdy = 0, nu = 0, nv = 0;
  for (let d = -1; d <= 1; d++) {
    const x = ug[(j + d) * w + i + K] - ug[(j + d) * w + i - K], y = vg[(j + K) * w + i + d] - vg[(j - K) * w + i + d];
    if (x === x) { dudx += x; nu++; }
    if (y === y) { dvdy += y; nv++; }
  }
  if (nu < 2 || nv < 2) return NaN;
  return (-(dudx / nu + dvdy / nv) / (2 * K * v.merc.cellSizeM(v.raw.crop.i0 + i, v.raw.crop.j0 + j))) * 1e4;
}
// The whole slice at once: the winds at the slice's height, turned to the grid, then convergence.
function convergenceSlice(v, spec, out) {
  const n = v.n, ug = new Float32Array(n), vg = new Float32Array(n), m = v.merc, i0 = v.raw.crop.i0, j0 = v.raw.crop.j0;
  for (let c = 0; c < n; c++) {
    const z = spec.ref === "agl" ? v.terrain[c] + spec.h : spec.h, i = c % v.w;
    [ug[c], vg[c]] = m.toGrid(v.column("U", c, z), v.column("V", c, z), i0 + i, j0 + (c - i) / v.w);
  }
  for (let c = 0; c < n; c++) out[c] = convFromGrid(v, ug, vg, c);
  return out;
}
function convergence(v, c, z) {
  const { w, h } = v, i = c % w, j = (c - i) / w, K = CONV_K;
  if (i < K || j < K || i > w - 1 - K || j > h - 1 - K) return NaN;
  const m = v.merc, i0 = v.raw.crop.i0, j0 = v.raw.crop.j0, ter = v.terrain, agl = z - ter[c];
  const at = (ii, jj, comp) => {
    const cc = jj * w + ii, zz = agl < 1500 ? ter[cc] + agl : z;
    return m.toGrid(v.column("U", cc, zz), v.column("V", cc, zz), i0 + ii, j0 + jj)[comp];
  };
  let dudx = 0, dvdy = 0, nu = 0, nv = 0;
  for (let d = -1; d <= 1; d++) {
    const x = at(i + K, j + d, 0) - at(i - K, j + d, 0), y = at(i + d, j + K, 1) - at(i + d, j - K, 1);
    if (Number.isFinite(x)) { dudx += x; nu++; }
    if (Number.isFinite(y)) { dvdy += y; nv++; }
  }
  if (nu < 2 || nv < 2) return NaN;
  return (-(dudx / nu + dvdy / nv) / (2 * K * m.cellSizeM(i0 + i, j0 + j))) * 1e4;
}

// Fields computed elsewhere and handed in (the channel analysis's Froude number, one value per
// column for the hour on screen).
export const DYN = { froude: null, froudeKey: null };
COLOUR_BY.froude = { label: "Froude number, two-layer (experimental)", units: "Fr = U/√(g′D)", ramp: "diverging", range: [0, 2], column2d: true, proxy: false,
  value: (v, c) => DYN.froude?.[c] ?? NaN, sampled: () => NaN };

// Colour of value x for field f in range [lo, hi]: UW wind bands for speeds, else the field's ramp.
export function colourOf(f, x, lo, hi) {
  if (f.ramp === "uw") return uwWind(x);
  if (f.ramp === "ri") { const k = riClass(x); return k < 0 ? [0, 0, 0] : RI_CLASSES[k].colour; }
  return sample(RAMPS[f.ramp], (x - lo) / (hi - lo));
}
// Colour per pixel: the mesh carries the value (attribute aVal), interpolated across each
// triangle, and a ramp texture turns it into a colour in the fragment shader. Band edges (UW
// wind bands, Ri classes) then run as smooth contours along the interpolated field, instead of
// the stair-steps and muddy mixes that per-vertex colours gave between 2.5-3 km grid points.
// Banded ramps sample the texture nearest (crisp bands), continuous ones linearly.
const RAMP_TEX = new Map();
export function rampTexture(f, lo, hi) {
  const key = `${f.ramp}|${lo}|${hi}`;
  if (RAMP_TEX.has(key)) return RAMP_TEX.get(key);
  const N = 1024, px = new Uint8Array(N * 4), banded = f.ramp === "uw" || f.ramp === "ri";
  for (let k = 0; k < N; k++) {
    const x = lo + ((hi - lo) * (k + 0.5)) / N;
    const c = f.ramp === "ri" ? RI_CLASSES[x < 0.5 ? 0 : 1].colour : colourOf(f, x, lo, hi);
    px[4 * k] = Math.round(c[0] * 255); px[4 * k + 1] = Math.round(c[1] * 255); px[4 * k + 2] = Math.round(c[2] * 255); px[4 * k + 3] = 255;
  }
  const tex = new THREE.DataTexture(px, N, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = banded ? THREE.NearestFilter : THREE.LinearFilter;
  tex.needsUpdate = true;
  RAMP_TEX.set(key, tex);
  return tex;
}
// The value a vertex carries, and the texture range: Ri as its class (0 likely, 1 possible).
export const carried = (f, x) => (f.ramp === "ri" ? (riClass(x) >= 0 ? riClass(x) : NaN) : x);
// (UW wind: past the top band, so winds beyond it get the "over" colour rather than the last band's.)
export const texRange = (f, lo, hi) => (f.ramp === "ri" ? [-0.5, 1.5] : f.ramp === "uw" ? [lo, hi + (hi - lo) * 0.4] : [lo, hi]);
export function patchValueColour(mat, f, lo, hi) {
  const [a, b] = texRange(f, lo, hi);
  // uGusty > 0: the value shimmers up toward the gust (aGx: gust − mean, in the field's units) in
  // puff-shaped patches carried along by the local wind (aWind, m/s; uAdv: scene km per m/s per
  // second on screen, the particles' speed-up). Illustrative: the model gives gust strength, not
  // individual gusts. Two noise phases cross-fade (period 4 s) so the pattern never smears.
  const u = { uRamp: { value: rampTexture(f, a, b) }, uRange: { value: new THREE.Vector2(a, b) },
              uGusty: { value: 0 }, uT: { value: 0 }, uAdv: { value: 0.1 } };
  mat.userData.ramp = u;
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aVal; attribute float aGx; attribute vec2 aWind;\nvarying float vVal; varying float vGx; varying vec2 vWind; varying vec2 vXY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvVal = aVal; vGx = aGx; vWind = aWind; vXY = position.xy;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
uniform sampler2D uRamp; uniform vec2 uRange; uniform float uGusty; uniform float uT; uniform float uAdv;
varying float vVal; varying float vGx; varying vec2 vWind; varying vec2 vXY;
float gh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), f.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), f.x), f.y); }
float gpuff(vec2 p) { float n = 0.65 * gn(p) + 0.35 * gn(p * 2.3 + 7.1); return smoothstep(0.44, 0.78, n) - 0.35 * smoothstep(0.5, 0.82, 1.0 - n); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
float val = vVal;
if (uGusty > 0.5 && vGx > 0.0) {
  const float P = 4.0; float t1 = fract(uT / P), t2 = fract(uT / P + 0.5);
  vec2 v = vWind * uAdv, p = vXY / 6.0;                      // puffs a few km across, carried by the wind
  float g = mix(gpuff(p - v * t1 * P / 6.0), gpuff(p - v * t2 * P / 6.0 + 3.7), abs(2.0 * t1 - 1.0));
  val = vVal + vGx * g;
}
diffuseColor.rgb *= texture2D(uRamp, vec2(clamp((val - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0), 0.5)).rgb;`);
  };
  mat.customProgramCacheKey = () => `valcol2|${prevKey.call(mat)}`;
  return mat;
}
export function setValueRange(mat, f, lo, hi) {
  const u = mat.userData.ramp, [a, b] = texRange(f, lo, hi);
  if (!u || (u.uRange.value.x === a && u.uRange.value.y === b)) return;
  u.uRange.value.set(a, b); u.uRamp.value = rampTexture(f, a, b);
}

// Light smoothing (optional): one 1-2-1 pass each way, ignoring holes and keeping them holes.
export function smooth121(vals, w, h) {
  const out = new Float32Array(vals.length), K = [1, 2, 1];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = j * w + i;
    if (!Number.isFinite(vals[c])) { out[c] = NaN; continue; }
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const v = vals[y * w + x];
      if (Number.isFinite(v)) { const k = K[di + 1] * K[dj + 1]; s += v * k; n += k; }
    }
    out[c] = s / n;
  }
  return out;
}

// Is value x drawn at all? (The turbulence proxy shows only where turbulence is likely/possible.)
export const shows = (f, x) => Number.isFinite(x) && (f.ramp !== "ri" || riClass(x) >= 0);

// Colour range: fixed where physics sets one, else rounded from the values given.
export function rangeOf(key, values) {
  const f = COLOUR_BY[key];
  if (f.range) return f.range;
  let lo = Infinity, hi = -Infinity;
  for (const x of values) if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return Number.isFinite(lo) ? [Math.floor(lo), Math.ceil(hi)] : [0, 1];
}

export class SliceLayer {
  constructor(clip = null) { this.group = new THREE.Group(); this.mesh = null; this.opacity = 0.85; this.clip = clip; }

  clear() { this.key = null; if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh = null; } }

  // Values of the field in every column at the slice (NaN = hole).
  values(vol, spec) {
    const f = COLOUR_BY[spec.field], vals = new Float32Array(vol.n);
    // 15-minute surface data (spec.surf: {U, V, G} at the current time) for the 10 m wind and gust.
    const S = spec.surf;
    if (S && spec.ref === "agl" && spec.h <= 10 && (spec.field === "speed" || spec.field === "gust" || spec.field === "gustf")) {
      for (let c = 0; c < vol.n; c++) {
        const sp = Math.hypot(S.U[c], S.V[c]) * 1.943844, g = S.G ? S.G[c] * 1.943844 : NaN;
        vals[c] = spec.field === "speed" ? sp : spec.field === "gust" ? g : (sp > 3.9 ? g / sp : NaN);
      }
      return vals;
    }
    if (f.column2d) { for (let c = 0; c < vol.n; c++) vals[c] = f.value(vol, c); return vals; }   // one value per column, any height
    if (spec.field === "conv") return convergenceSlice(vol, spec, vals);                       // one pass for the winds, then differences
    for (let c = 0; c < vol.n; c++) {
      const z = spec.ref === "agl" ? vol.terrain[c] + spec.h : spec.h;
      vals[c] = f.surfaceOnly ? (spec.ref === "agl" && spec.h <= 10 ? f.value(vol, c, z) : NaN) : f.value(vol, c, z);
    }
    return vals;
  }

  // vol: Volume; spec: {h (m), ref: "agl"|"msl", field}; groundKm(x, y): drawn terrain height (km, exaggerated).
  // Returns {lo, hi, field, holesPct}. `range` forces the colour range (so slice and cross-section agree).
  build(vol, proj, spec, vex, groundKm, range = null) {
    const f = COLOUR_BY[spec.field], { w, h } = vol, n = w * h, lat = vol.raw.lat, lon = vol.raw.lon;
    let vals = this.values(vol, spec);
    if (spec.smooth && f.ramp !== "ri" && !f.none) vals = smooth121(vals, w, h);     // display only: readouts stay raw
    const [lo, hi] = range || rangeOf(spec.field, vals);
    // Positions only change with the grid, height, exaggeration or ground (spec.geoKey): during
    // playback only the colours do, so the sheet is recoloured in place rather than rebuilt.
    const key = spec.geoKey != null ? `${spec.geoKey}|${spec.h}|${spec.ref}|${vex}|${f.none ? 0 : 1}|${f.ramp}` : null;
    const reuse = key && this.mesh && this.key === key && this.lat === lat;
    const pos = reuse ? this.mesh.geometry.attributes.position.array : new Float32Array(n * 3);
    const val = reuse ? this.mesh.geometry.attributes.aVal.array : new Float32Array(n);
    for (let c = 0; c < n; c++) {
      if (!reuse) {
        const p = proj.toXY(lat[c], lon[c]);
        pos[3 * c] = p.x; pos[3 * c + 1] = p.y;
        pos[3 * c + 2] = spec.ref === "agl" ? (groundKm ? groundKm(p.x, p.y) : 0) + (spec.h / 1000) * vex : (spec.h / 1000) * vex;
      }
      val[c] = carried(f, vals[c]);
    }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let m = 0, holes = 0;
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (!(shows(f, vals[a]) && shows(f, vals[b]) && shows(f, vals[c]) && shows(f, vals[d]))) { holes++; continue; }
      idx[m++] = a; idx[m++] = b; idx[m++] = d; idx[m++] = a; idx[m++] = d; idx[m++] = c;
    }
    const stats = { lo, hi, field: f, holesPct: (100 * holes) / ((w - 1) * (h - 1)) };
    // Gustiness on the surface wind fill: the gust excess (kt) and the 10 m wind (m/s) per point.
    const gusty = !!spec.gusty && spec.field === "speed" && spec.ref === "agl" && spec.h <= 10 && !!spec.gust;
    const gx = reuse && this.mesh.geometry.attributes.aGx ? this.mesh.geometry.attributes.aGx.array : new Float32Array(n);
    const wv = reuse && this.mesh.geometry.attributes.aWind ? this.mesh.geometry.attributes.aWind.array : new Float32Array(n * 2);
    if (gusty) for (let c = 0; c < n; c++) {
      const [ue, ve] = spec.gust.wind(c), g = spec.gust.G[c] * 1.943844 - vals[c];
      gx[c] = Number.isFinite(g) && g > 0 ? g : 0; wv[2 * c] = ue || 0; wv[2 * c + 1] = ve || 0;
    } else gx.fill(0);
    this.gustyOn = gusty;
    if (reuse) {
      const geo = this.mesh.geometry;
      geo.attributes.aVal.needsUpdate = true;
      if (geo.attributes.aGx) { geo.attributes.aGx.needsUpdate = true; geo.attributes.aWind.needsUpdate = true; }
      this.mesh.material.userData.ramp.uGusty.value = gusty ? 1 : 0;
      geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, m), 1));
      setValueRange(this.mesh.material, f, lo, hi);
      return stats;
    }
    this.clear();
    this.key = key; this.lat = lat;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aVal", new THREE.BufferAttribute(val, 1));
    geo.setAttribute("aGx", new THREE.BufferAttribute(gx, 1));
    geo.setAttribute("aWind", new THREE.BufferAttribute(wv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, m), 1));
    const mat = patchValueColour(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: this.opacity, depthWrite: false }), f, lo, hi);
    mat.userData.ramp.uGusty.value = gusty ? 1 : 0;
    if (f.none) mat.colorWrite = false;                             // "None": the sheet is there (heights, readout, symbols) but not drawn
    this.clip?.patch(mat);                                          // "over water only"
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
    return stats;
  }

  setOpacity(o) { this.opacity = o; if (this.mesh) this.mesh.material.opacity = o; }
}
