// The sea surface on the map: the water coloured by significant wave height (chop from the model's
// 10 m wind and the fetch, web/model/waves.js; swell from NOAA's wave model) on the 1 km fetch
// grid, water only, just above sea level and under the wind layers. Each part on its own: the
// colour fill; the animated crests (a shader, exaggerated so it reads at map scale: moving along
// the waves, bigger and whiter as the sea builds, whitecaps where it's rough); direction arrows;
// and wind against current pulsing orange (steep) or red (dangerous). Worked out per forecast
// hour and blended between two hours on the graphics card (the current is layers/curflow.js's).

import * as THREE from "three";
import { chopOnCurrent } from "../model/currents.js?v=20261002173952";
import { chopAt } from "../model/waves.js?v=20261002173952";

const FT = 3.28084;
export const SEA_FT_MAX = 10;                      // top of the colour scale (ft)
// Sequential, navy through blue and violet to pale lilac: calm water dark, rough water light.
// (No greens or tans: the teal ramp it replaces read like the land's colours on the hillshade.)
const STOPS = [[0x0c, 0x1f, 0x4d], [0x1c, 0x43, 0x94], [0x3a, 0x6b, 0xd0], [0x74, 0x7d, 0xe0], [0xb0, 0x8c, 0xe6], [0xf0, 0xdd, 0xff]];
export function seaColour(ft) {
  const t = Math.max(0, Math.min(1, ft / SEA_FT_MAX)) * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i;
  return STOPS[i].map((a, k) => (a + (STOPS[i + 1][k] - a) * f) / 255);
}
export function seaKey(w = 256, h = 10) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  for (let x = 0; x < w; x++) { const k = seaColour((x / (w - 1)) * SEA_FT_MAX); g.fillStyle = `rgb(${k.map((v) => Math.round(v * 255))})`; g.fillRect(x, 0, 1, h); }
  return c;
}

// The water mask of a land grid (the planner's 200 m chart-based grid) as a texture, shared by the
// layers that clip to the fine shoreline (the sea surface, the currents' colour fill).
// → {tex (R: 255 water), o (origin, km), s (size, km)}
const masks = new WeakMap();
export function shoreMask(land) {
  if (masks.has(land)) return masks.get(land);
  const n = land.nx * land.ny, a = new Uint8Array(n);
  for (let k = 0; k < n; k++) a[k] = land.mask[k] === 1 ? 0 : 255;
  const tex = new THREE.DataTexture(a, land.nx, land.ny, THREE.RedFormat); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const m = { tex, o: new THREE.Vector2(land.x0 - land.dxy / 2, land.y0 - land.dxy / 2), s: new THREE.Vector2(land.nx * land.dxy, land.ny * land.dxy) };
  masks.set(land, m);
  return m;
}

export class WaveLayer {
  constructor() {
    this.group = new THREE.Group(); this.opacity = 0.85; this.symOpacity = 0.9; this.mesh = null; this.t0 = performance.now();
    this.style = { fill: true, crests: true, animate: true, arrows: false };
    this.A = this.B = null; this.mix = 0; this.arrows = null;
  }
  clear() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh = null; this.meshNx = this.meshNy = null; }
    this.dropArrows(); this.A = this.B = null;
  }
  setOpacity(o) { this.opacity = o; if (this.mesh) this.mesh.material.uniforms.uOpacity.value = o; }
  setSymOpacity(o) { this.symOpacity = o; if (this.arrows) for (const m of this.arrows.children) m.material.opacity = m.userData.op * o; }
  // What's drawn: fill (the water coloured by wave height), crests (the moving wave texture and
  // whitecaps; on their own, white over the map), animate (move them), arrows (the waves'
  // direction, sized by height).
  setStyle(st) {
    const was = this.style.arrows;
    Object.assign(this.style, st);
    if (this.mesh) { const u = this.mesh.material.uniforms; u.uFill.value = this.style.fill ? 1 : 0; u.uCrests.value = this.style.crests ? 1 : 0; u.uAnim.value = this.style.animate ? 1 : 0; this.mesh.visible = this.style.fill || this.style.crests; }
    if (was !== this.style.arrows) this.arrowsFor(this.mix < 0.5 ? this.A : this.B);
  }
  // The shoreline from a finer water mask (the planner's 200 m chart-based grid): the layer is
  // clipped to it rather than to its own 1 km cells. land: {mask (1 = land), nx, ny, x0, y0, dxy}.
  setShore(land) {
    if (!land || this.maskLand === land) return;
    this.maskLand = land;
    const m = shoreMask(land), t = (this.maskTex = m.tex);
    this.maskO = m.o; this.maskS = m.s;
    if (this.mesh) { const u = this.mesh.material.uniforms; u.uMask.value = t; u.uMaskOn.value = 1; u.uMaskO.value = this.maskO; u.uMaskS.value = this.maskS; }
  }
  // 2D (seen straight down): drawn over the land, clipped by the fine shoreline mask, so the coast
  // is the 200 m one rather than the terrain's coarser edge. In 3D it stays under the land (hills
  // hide the water behind them).
  setFlat(on) {
    this.flat = on;
    if (this.mesh) { this.mesh.material.depthTest = !on; this.mesh.renderOrder = on ? 9.5 : 8; }   // (over the ground and photo, under the slice and the other wind layers)
    if (this.arrows) for (const m of this.arrows.children) m.material.depthTest = !on;
  }
  // Each frame (stage.onFrame): the animation's clock. → true while it needs redrawing.
  tick(now) { if (!this.mesh || !this.mesh.visible || !this.style.animate || !this.style.crests || !this.group.visible) return false; this.mesh.material.uniforms.uTime.value = (now - this.t0) / 1000; return true; }

  // The water cells of the fetch grid (fixed per region): pixel offset, scene x/y, lat/lon.
  // Computed once; each rebuild then only reads the wind and does the chop arithmetic
  // (performance review, 2026-09-28: the rebuild was ~310 ms, mostly these lookups).
  cellsFor(fetch, proj) {
    if (this.cells?.fetch === fetch && this.cells.proj === proj) return this.cells;
    const { nx, ny, x0, y0, dxy } = fetch, o = [], xs = [], ys = [], la = [], lo = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * dxy, y = y0 + j * dxy;
      if (!(fetch.at(x, y, 0) > 0)) continue;                          // land
      const ll = proj.toLatLon(x, y);
      o.push(4 * (j * nx + i)); xs.push(x); ys.push(y); la.push(ll.lat); lo.push(ll.lon);
    }
    return (this.cells = { fetch, proj, n: o.length, o: Int32Array.from(o), x: Float32Array.from(xs), y: Float32Array.from(ys), lat: Float64Array.from(la), lon: Float64Array.from(lo) });
  }

  // One time's sea (a forecast hour: the explorer keeps a few and blends two, show()).
  // fetch: FetchGrid; windAt(lat, lon, k) → [u, v] m/s (10 m), k the water cell's index in
  // cellsFor(); swellAt(lat, lon, k) → Σ swell Hs² (m²) or null; mode: "total" (chop and swell
  // combined, √Σ Hs²), "chop" or "swell"; currentAt(k) → [u, v] m/s (toward) or null: the tidal
  // current, which changes the chop when chopCur (the wind over the moving water, and the waves
  // shortened and steepened against it, model/currents.js).
  // → frame {nx, ny, x0, y0, dxy, px, d1, d2, stats: {median, p90, max, maxAt}}
  compute(fetch, proj, windAt, swellAt = null, mode = "total", currentAt = null, chopCur = true) {
    const { nx, ny, x0, y0, dxy } = fetch, C = this.cellsFor(fetch, proj);
    const px = new Uint8Array(nx * ny * 4), hsFt = new Float32Array(C.n);
    const d1 = new Float32Array(nx * ny * 4);   // [Hs m, period s, travel x, travel y]
    const d2 = new Float32Array(nx * ny * 4);   // [current u, v m/s, wind-against-current rating, 0]
    let nh = 0, maxFt = 0, maxAt = null;
    for (let k = 0; k < C.n; k++) {
      const x = C.x[k], y = C.y[k], w = windAt(C.lat[k], C.lon[k], k);
      const cu = w && currentAt ? currentAt(k) : null;
      const cc = chopCur && cu;                                        // (the current changes the chop only when that's on)
      let c = w ? chopAt(fetch, x, y, cc ? w[0] - cu[0] : w[0], cc ? w[1] - cu[1] : w[1]) : null;        // (duration from the shared setting)
      let rating = 0;
      if (c && cc && c.hs > 0) { const ru = w[0] - cu[0], rv = w[1] - cu[1], rm = Math.hypot(ru, rv) || 1, r = chopOnCurrent(c.hs, c.tp, ru / rm, rv / rm, cu[0], cu[1]); c = { ...c, hs: r.hs }; rating = r.rating || 0; }
      const sw = mode !== "chop" && swellAt ? swellAt(C.lat[k], C.lon[k], k) : null;
      const s2 = sw ?? 0, c2 = mode !== "swell" && c ? c.hs * c.hs : 0;
      if (!c && sw == null) continue;
      const ft = Math.sqrt(c2 + s2) * FT, col = seaColour(ft), o = C.o[k];
      px[o] = col[0] * 255; px[o + 1] = col[1] * 255; px[o + 2] = col[2] * 255; px[o + 3] = 255;
      const wm = w ? Math.hypot(w[0] - (cc ? cu[0] : 0), w[1] - (cc ? cu[1] : 0)) || 1 : 1;
      d1[o] = ft / FT; d1[o + 1] = c?.tp || 8; d1[o + 2] = w ? (w[0] - (cc ? cu[0] : 0)) / wm : 0; d1[o + 3] = w ? (w[1] - (cc ? cu[1] : 0)) / wm : 0;
      if (cu) { d2[o] = cu[0]; d2[o + 1] = cu[1]; } d2[o + 2] = rating;
      hsFt[nh++] = ft;
      if (ft > maxFt) { maxFt = ft; maxAt = { lat: C.lat[k], lon: C.lon[k], ...(c || {}), swellFt: Math.sqrt(s2) * FT }; }
    }
    soften(px, d1, nx, ny, 2);                                         // (the look only: zone swell and grid steps blurred)
    dilate(px, d1, d2, nx, ny, 2);                                     // (values two cells into the land: the fine shoreline mask clips)
    const hs = hsFt.subarray(0, nh).sort();
    return { nx, ny, x0, y0, dxy, px, d1, d2, stats: { median: nh ? hs[nh >> 1] : NaN, p90: nh ? hs[Math.floor(nh * 0.9)] : NaN, max: maxFt, maxAt } };
  }
  // Frame A blended toward B by `mix` (0..1), on the graphics card: new textures only when a frame
  // changes, so stepping through the time costs next to nothing.
  show(A, B, mix) {
    B ||= A;
    if (!A) { this.clear(); return; }
    const tex = (F) => {
      if (F.tex) return F.tex;
      const m = new THREE.DataTexture(F.px, F.nx, F.ny, THREE.RGBAFormat); m.magFilter = m.minFilter = THREE.LinearFilter; m.needsUpdate = true;
      const f = (a) => { const t = new THREE.DataTexture(a, F.nx, F.ny, THREE.RGBAFormat, THREE.FloatType); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
      return (F.tex = { map: m, d1: f(F.d1), d2: f(F.d2) });
    };
    if (!this.mesh || this.meshNx !== A.nx || this.meshNy !== A.ny) this.makeMesh(A);
    const u = this.mesh.material.uniforms, ta = tex(A), tb = tex(B);
    u.mapA.value = ta.map; u.d1A.value = ta.d1; u.d2A.value = ta.d2; u.mapB.value = tb.map; u.d1B.value = tb.d1; u.d2B.value = tb.d2; u.uMix.value = mix;
    const near = mix < 0.5 ? A : B, redo = near !== (this.mix < 0.5 ? this.A : this.B);
    this.A = A; this.B = B; this.mix = mix;
    if (redo || (this.style.arrows && !this.arrows)) this.arrowsFor(near);
  }
  // A frame no longer kept: its textures freed.
  static dispose(F) { if (F?.tex) { for (const t of Object.values(F.tex)) t.dispose(); F.tex = null; } }
  makeMesh(F) {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
    const { nx, ny, x0, y0, dxy } = F, W = (nx - 1) * dxy, H = (ny - 1) * dxy;
    this.meshNx = nx; this.meshNy = ny;
    const mat = new THREE.ShaderMaterial({
      uniforms: { mapA: { value: null }, d1A: { value: null }, d2A: { value: null }, mapB: { value: null }, d1B: { value: null }, d2B: { value: null }, uMix: { value: 0 },
        uSize: { value: new THREE.Vector2(W + dxy, H + dxy) }, uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector2(x0 - dxy / 2, y0 - dxy / 2) }, uMask: { value: this.maskTex || null }, uMaskOn: { value: this.maskTex ? 1 : 0 },
        uMaskO: { value: this.maskO || new THREE.Vector2() }, uMaskS: { value: this.maskS || new THREE.Vector2(1, 1) },
        uOpacity: { value: this.opacity }, uFill: { value: this.style.fill ? 1 : 0 }, uCrests: { value: this.style.crests ? 1 : 0 }, uAnim: { value: this.style.animate ? 1 : 0 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(W + dxy, H + dxy), mat);
    this.mesh.position.set(x0 + W / 2, y0 + H / 2, 0.008);
    this.mesh.renderOrder = 8;
    this.mesh.visible = this.style.fill || this.style.crests;
    if (this.flat) this.setFlat(true);
    this.group.add(this.mesh);
  }
  // Direction arrows every ~4 km over the water: along the waves' travel, longer and brighter for
  // bigger seas (from the nearer hour of the two shown).
  dropArrows() { if (this.arrows) { this.group.remove(this.arrows); for (const m of this.arrows.children) { m.geometry.dispose(); m.material.dispose(); } this.arrows = null; } }
  arrowsFor(F) {
    this.dropArrows();
    if (!F || !this.style.arrows) return;
    const { nx, ny, x0, y0, dxy, d1 } = F, step = Math.max(1, Math.round(4 / dxy)), items = [];
    const C = this.cells;
    const water = new Uint8Array(nx * ny); if (C) for (let k = 0; k < C.n; k++) water[C.o[k] / 4] = 1;
    for (let j = step >> 1; j < ny; j += step) for (let i = step >> 1; i < nx; i += step) {
      const c = j * nx + i, o = 4 * c; if (!water[c]) continue;
      const hs = d1[o] * FT, dx = d1[o + 2], dy = d1[o + 3]; if (!(hs > 0.2) || Math.hypot(dx, dy) < 0.1) continue;
      items.push([x0 + i * dxy, y0 + j * dxy, Math.atan2(dx, dy), hs]);
    }
    const s = new THREE.Shape();
    s.moveTo(-0.06, -0.5); s.lineTo(0.06, -0.5); s.lineTo(0.06, 0.15); s.lineTo(0.22, 0.15); s.lineTo(0, 0.5); s.lineTo(-0.22, 0.15); s.lineTo(-0.06, 0.15); s.lineTo(-0.06, -0.5);
    const geo = new THREE.ShapeGeometry(s), g = new THREE.Group(), q = new THREE.Object3D(), col = new THREE.Color();
    const mk = (color, op, order) => { const m = new THREE.InstancedMesh(geo.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op * this.symOpacity, depthWrite: false, depthTest: !this.flat }), Math.max(1, items.length)); m.userData.op = op; m.count = items.length; m.renderOrder = order; m.frustumCulled = false; g.add(m); return m; };
    const edge = mk(0x0b1a22, 0.7, 12.4), fill = mk(0xffffff, 0.95, 12.5);
    items.forEach(([x, y, a, hs], k) => {
      const L = 1.2 + 0.45 * Math.min(10, hs);
      q.position.set(x, y, 0.07); q.rotation.set(0, 0, -a); q.scale.set(L, L, 1); q.updateMatrix(); fill.setMatrixAt(k, q.matrix);
      q.position.z = 0.069; q.scale.set(L * 1.3, L * 1.12, 1); q.updateMatrix(); edge.setMatrixAt(k, q.matrix);
      const cc = seaColour(hs); fill.setColorAt(k, col.setRGB(...cc.map((v) => v + (1 - v) * 0.45)));
    });
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    this.arrows = g; this.group.add(g);
  }
}

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// (positions in km across the grid: crests about 0.6–1.8 km apart, so they read from the whole
// region down to a close view; exaggerated on purpose)
const FRAG = `
uniform sampler2D mapA, d1A, d2A, mapB, d1B, d2B, uMask; uniform vec2 uSize, uOrigin, uMaskO, uMaskS; uniform float uTime, uOpacity, uFill, uCrests, uAnim, uMaskOn, uMix; varying vec2 vUv;
// (a hash that stays steady at large coordinates, unlike sin(): no moiré on the GPU)
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
// Crests along a fixed direction D, blended over 16 directions (22.5° apart) by how well each
// matches the local one: a crest pattern taken along each spot's own direction swirls where that
// direction varies, since the positions run to hundreds of km. (8 directions, 45° apart, beat
// into a checkerboard; neighbours 22.5° apart only beat into broad groups, like real wave groups.)
float crests(vec2 P, vec2 D, float lam, float t, float sharp) {
  float qx = dot(P, D), qy = dot(P, vec2(-D.y, D.x));
  // Ridged noise stretched along the crest (not a sine grating: two gratings a few degrees apart beat
  // into contour-like loops where the blend mixes them; noise summed with noise stays noise).
  float n = noise(vec2(qx / lam - t, qy / (lam * 3.0))) * 0.75 + noise(vec2(qx / lam * 2.1 - t * 2.1 + 17.3, qy / (lam * 1.6))) * 0.25;
  return pow(1.0 - abs(2.0 * n - 1.0), sharp * 1.6);
}
void main() {
  vec4 base = mix(texture2D(mapA, vUv), texture2D(mapB, vUv), uMix);          // (two forecast hours, blended)
  vec2 P = vUv * uSize;                          // km across the layer
  float water = uMaskOn > 0.5 ? texture2D(uMask, (uOrigin + P - uMaskO) / uMaskS).r : base.a;
  if (water < 0.5 || base.a < 0.02) discard;
  vec4 a = mix(texture2D(d1A, vUv), texture2D(d1B, vUv), uMix), b = mix(texture2D(d2A, vUv), texture2D(d2B, vUv), uMix);
  float hs = a.x, tp = max(a.y, 1.5), t = uTime * uAnim;
  vec3 col = base.rgb / max(base.a, 0.02); float alpha = uFill;
  // Waves: crests across the direction of travel, moving with it; taller seas brighter, whiter.
  // Without the fill they're white strokes over the map.
  if (uCrests > 0.5) {
    // (faded, not cut, where Hs is tiny or the blended direction nearly cancels: a hard cut left
    // flat squares, the data cells, among the textured ones)
    vec2 d = a.zw; float dl = length(d), fade = smoothstep(0.0, 0.08, hs) * smoothstep(0.02, 0.35, dl);
    if (fade > 0.0) {
      d = dl > 0.001 ? d / dl : vec2(1.0, 0.0);
      float lam = 0.6 + 0.2 * tp, amp = clamp(hs / 2.0, 0.0, 1.0), C = 0.0, Wt = 0.0;
      for (int i = 0; i < 16; i++) { float an = float(i) * 0.392699; vec2 D = vec2(cos(an), sin(an)); float w = pow(max(0.0, dot(d, D)), 32.0);
        if (w > 0.03) { C += w * crests(P, D, lam, t * 0.3, 6.0 - 3.0 * amp); Wt += w; } }
      float crest = C / max(Wt, 0.001) * fade;
      float wc = smoothstep(0.9, 1.8, hs) * step(0.9, noise(P * 3.0 - d * t * 0.8)) * crest;
      if (uFill > 0.5) { col += vec3(0.85, 0.95, 1.0) * crest * (0.08 + 0.35 * amp); col = mix(col, vec3(1.0), wc * 0.8); }
      else { col = vec3(0.92, 0.97, 1.0); alpha = clamp(crest * (0.22 + 0.5 * amp) + wc * 0.8, 0.0, 1.0); }
    }
  }
  // Wind against current: steep (orange) or dangerous (red), pulsing gently.
  if (b.z > 0.3) {
    float p = 0.5 + 0.5 * sin(uTime * 2.5 * max(uAnim, 0.0001)), w = (0.12 + 0.16 * p) * smoothstep(0.3, 0.8, b.z);
    vec3 oc = mix(vec3(1.0, 0.62, 0.20), vec3(0.95, 0.25, 0.20), smoothstep(1.2, 1.8, b.z));
    if (alpha > 0.5) col = mix(col, oc, w); else { col = mix(col, oc, 0.8); alpha = max(alpha, w * 2.5); }
  }
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha * uOpacity);
}`;

// Water values spread into neighbouring land cells (`passes` cells deep), so the finer shoreline
// mask has colour and data to show right up to the coast.
function dilate(px, d1, d2, nx, ny, passes) {
  for (let p = 0; p < passes; p++) {
    const fill = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const o = 4 * (j * nx + i);
      if (px[o + 3]) continue;
      let n = 0; const acc = new Float32Array(12);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj; if ((!di && !dj) || a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = 4 * (b * nx + a); if (!px[q + 3]) continue;
        for (let k = 0; k < 4; k++) { acc[k] += px[q + k]; acc[4 + k] += d1[q + k]; acc[8 + k] += d2[q + k]; }
        n++;
      }
      if (n) fill.push([o, n, acc]);
    }
    for (const [o, n, acc] of fill) { for (let k = 0; k < 4; k++) { px[o + k] = acc[k] / n; d1[o + k] = acc[4 + k] / n; d2[o + k] = acc[8 + k] / n; } px[o + 3] = 255; d2[o + 2] = 0; }
  }
}

// Blur the colours, Hs and period over the water cells (3×3, `passes` times; land cells neither
// take nor give): the zone forecasts' swell and the grids step from cell to cell, which showed as
// blocks. Directions and currents are left as they are.
function soften(px, d1, nx, ny, passes) {
  const N = nx * ny, tmp = new Float32Array(N * 5);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i; if (!px[4 * c + 3]) continue;
      let n = 0, r = 0, g = 0, b = 0, h = 0, t = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, bb = j + dj; if (a < 0 || bb < 0 || a >= nx || bb >= ny) continue;
        const q = 4 * (bb * nx + a); if (!px[q + 3]) continue;
        r += px[q]; g += px[q + 1]; b += px[q + 2]; h += d1[q]; t += d1[q + 1]; n++;
      }
      tmp.set([r / n, g / n, b / n, h / n, t / n], 5 * c);
    }
    for (let c = 0; c < N; c++) { const o = 4 * c; if (!px[o + 3]) continue; const k = 5 * c; px[o] = tmp[k]; px[o + 1] = tmp[k + 1]; px[o + 2] = tmp[k + 2]; d1[o] = tmp[k + 3]; d1[o + 1] = tmp[k + 4]; }
  }
}
