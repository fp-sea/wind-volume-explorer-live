// Fog and mist from the model: its surface visibility forecast (VIS) where it's under 1 km (fog)
// or 1-5 km (mist), drawn as a soft white layer next to the surface. The layer's depth is the
// model's own cloud water down at the surface (the contiguous condensate from the ground up,
// to 600 m); where visibility is low with no cloud water, a shallow 60 m layer.
//
// The model is the fog simulation: visibility is its diagnostic of fog, haze and precipitation,
// and fog forecasting is hard, so read this as "where the model has fog", not a promise.
//
// Computed once per model hour (in idle-time slices, idle.js) and cross-faded between hours on
// the GPU, so playback costs nothing per step (performance review, 2026-09-28).

import * as THREE from "three";
import { idleLoop } from "../idle.js?v=20261002173952";
import { LITE } from "../device.js?v=20261002173952";

const NS = 10, ZMAX = 600;                      // sheets and the deepest fog drawn (m)
const FOG_M = 1000, MIST_M = 5000;

export class FogLayer {
  constructor() { this.group = new THREE.Group(); this.opacity = 0.8; this.hours = new Map(); this.meshes = []; this.meshKey = null; }
  clear() {
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = []; this.meshKey = null;
    for (const h of this.hours.values()) h.tex?.dispose();
    this.hours.clear();
  }
  hide() { for (const m of this.meshes) m.visible = false; }
  get shown() { return this.meshes.some((m) => m.visible); }
  setOpacity(o) { this.opacity = o; for (const m of this.meshes) m.material.uniforms.uOpacity.value = o; }

  // One model hour: {tex (r: density, g: top / ZMAX), stats, job}; null data when the model gave
  // no visibility (h.none).
  hour(vol, proj) {
    let h = this.hours.get(vol);
    if (h) { this.hours.delete(vol); this.hours.set(vol, h); return h; }
    h = { tex: null, stats: null, none: !vol.raw.surface.VIS };
    this.hours.set(vol, h);
    while (this.hours.size > 6) { const [k, old] = this.hours.entries().next().value; old.job?.done || old.job?.finish(); old.tex?.dispose(); this.hours.delete(k); }
    if (h.none) { h.job = { promise: Promise.resolve(), done: true, finish() {} }; return h; }
    const vis = vol.raw.surface.VIS, b = proj.box, W = b.x1 - b.x0, H = b.y1 - b.y0;
    const G = LITE ? 160 : 256, NX = Math.min(G, Math.ceil(W / 1)), NY = Math.min(G, Math.ceil(H / 1));
    const data = new Uint8Array(NX * NY * 2), zs = Array.from({ length: 24 }, (_, k) => 10 + k * 25), prof = new Float32Array(zs.length);
    const land = vol.raw.surface.LAND, i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0, tops = [];
    let water = 0, fog = 0, mist = 0;
    h.job = idleLoop(NY, (iy) => {
      for (let ix = 0; ix < NX; ix++) {
        const ll = proj.toLatLon(b.x0 + ((ix + 0.5) * W) / NX, b.y0 + ((iy + 0.5) * H) / NY), q = vol.merc.ij(ll.lat, ll.lon);
        const i = Math.round(q.i - i0), j = Math.round(q.j - j0);
        if (i < 0 || j < 0 || i >= vol.w || j >= vol.h) continue;
        const c = j * vol.w + i, v = vis[c];
        if (!Number.isFinite(v)) continue;
        const wet = !(land && land[c] > 0.5);
        if (wet) water++;
        if (v >= MIST_M) continue;
        // Density: 1 at ≤ 200 m visibility, falling to 0.25 at the fog limit and ~0 at 5 km.
        const dens = v < FOG_M ? 1 - 0.75 * Math.max(0, (v - 200) / (FOG_M - 200)) : 0.25 * (1 - (v - FOG_M) / (MIST_M - FOG_M));
        // Depth: condensate from the ground up (terrain-relative heights).
        const ter = vol.terrain[c];
        vol.profile("Q", c, zs.map((z) => ter + z), prof, 0, 1);
        let top = 0;
        for (let k = 0; k < zs.length; k++) { if (prof[k] > 0.005) top = zs[k] + 12; else if (top > 0 || k > 2) break; }
        if (!top) top = 60;
        data[2 * (iy * NX + ix)] = Math.round(255 * dens);
        data[2 * (iy * NX + ix) + 1] = Math.round((255 * Math.min(top, ZMAX)) / ZMAX);
        if (wet) { if (v < FOG_M) { fog++; tops.push(top); } else mist++; }
      }
    });
    h.job.promise.then(() => {
      const tex = new THREE.DataTexture(data, NX, NY, THREE.RGFormat, THREE.UnsignedByteType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
      const med = (a) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : NaN);
      h.tex = tex; h.stats = { fogFrac: water ? fog / water : 0, mistFrac: water ? mist / water : 0, topMedian: med(tops) };
      this.onReady?.();                                              // any hour done: the explorer redraws
    }, () => {});
    return h;
  }
  prewarm(vol, proj) { if (vol && proj) this.hour(vol, proj); }

  // The time between V0 and V1 (frac). Returns the nearer hour's stats; {none: true} when the
  // model has no visibility; null while V0 is still being worked out (onReady when it's in).
  show(V0, V1, frac, proj, vex, onReady) {
    const a = this.hour(V0, proj), bh = V1 && frac > 0 ? this.hour(V1, proj) : a;
    if (a.none) { this.hide(); return { none: true }; }
    if (!a.tex) { a.job.promise.then(onReady, () => {}); return null; }
    const b = bh.tex ? bh : a;
    if (!bh.tex && !bh.none) bh.job.promise.then(onReady, () => {});
    this.sheets(proj, vex);
    for (const m of this.meshes) { const u = m.material.uniforms; u.uA.value = a.tex; u.uB.value = b.tex; u.uFrac.value = b === a ? 0 : frac; m.visible = true; }
    return frac >= 0.5 && b !== a ? b.stats : a.stats;
  }

  sheets(proj, vex) {
    const b = proj.box, key = `${b.x0},${b.y0},${b.x1},${b.y1}|${vex}`;
    if (key === this.meshKey) return;
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = []; this.meshKey = key;
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    for (let k = 0; k < NS; k++) {
      const hFrac = (k + 0.5) / NS;                                  // this sheet's height, as a fraction of ZMAX
      const mat = new THREE.ShaderMaterial({
        uniforms: { uA: { value: null }, uB: { value: null }, uFrac: { value: 0 }, uH: { value: hFrac }, uOpacity: { value: this.opacity } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D uA; uniform sampler2D uB; uniform float uFrac; uniform float uH; uniform float uOpacity; varying vec2 vUv;
          void main() {
            vec2 f = mix(texture2D(uA, vUv).rg, texture2D(uB, vUv).rg, uFrac);   // r: density, g: top / ZMAX; the two hours cross-faded
            if (f.r < 0.02 || uH > f.g) discard;
            float edge = smoothstep(0.0, 0.15, f.g - uH);           // soft top
            gl_FragColor = vec4(vec3(0.93, 0.95, 0.96), f.r * edge * 0.3 * uOpacity);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, ((hFrac * ZMAX) / 1000) * vex + 0.01);
      m.renderOrder = 16; m.visible = false;
      this.meshes.push(m); this.group.add(m);
    }
  }
}
