// Visibility map: the model's surface visibility forecast (VIS) as a flat map just above the
// surface, in the mariner's classes (as the UK Met Office's shipping forecast uses them):
//   very poor  under 1,000 m (fog)       poor  1,000 m – 2 nm       moderate  2 – 5 nm
//   good       over 5 nm (not drawn)
// The model's visibility falls for fog, mist, haze, smoke and rain or snow alike; it doesn't say
// which. Where the 3D fog layer shows depth, this shows how far you'd see.

import * as THREE from "three";
import { idleLoop } from "../idle.js?v=20261002173952";
import { LITE } from "../device.js?v=20261002173952";

export const NM = 1852;
export const VIS_CLASSES = [
  { max: 1000, label: "very poor", note: "under 1,000 m: fog", rgb: [0xa3, 0x34, 0x1f] },
  { max: 2 * NM, label: "poor", note: "1,000 m – 2 nm", rgb: [0xe0, 0x7b, 0x26] },
  { max: 5 * NM, label: "moderate", note: "2 – 5 nm", rgb: [0xf2, 0xcf, 0x6b] },
];
export const visClass = (m) => (Number.isFinite(m) ? VIS_CLASSES.findIndex((c) => m < c.max) : -1);   // -1: good (or none)
export function visText(m) {
  if (!Number.isFinite(m)) return null;
  const nm = m / NM, k = visClass(m);
  const d = nm < 1 ? nm.toFixed(2) : nm < 10 ? nm.toFixed(1) : Math.round(nm);
  return `${d} nm (${m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`}) · ${k < 0 ? "good" : VIS_CLASSES[k].label}`;
}

export class VisibilityLayer {
  // Per model hour (idle-time slices, idle.js), cross-faded between hours on the GPU.
  constructor() { this.group = new THREE.Group(); this.opacity = 0.8; this.mesh = null; this.meshKey = null; this.hours = new Map(); }
  clear() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh = null; this.meshKey = null; }
    for (const h of this.hours.values()) h.tex?.dispose();
    this.hours.clear();
  }
  hide() { if (this.mesh) this.mesh.visible = false; }
  get shown() { return !!this.mesh?.visible; }
  setOpacity(o) { this.opacity = o; if (this.mesh) this.mesh.material.uniforms.uOpacity.value = o * 0.75; }

  // One hour: {tex (RGBA classes), stats {frac: water fraction per class}, job}; none without VIS.
  hour(vol, proj) {
    let h = this.hours.get(vol);
    if (h) { this.hours.delete(vol); this.hours.set(vol, h); return h; }
    h = { tex: null, stats: null, none: !vol.raw.surface.VIS };
    this.hours.set(vol, h);
    while (this.hours.size > 6) { const [k, old] = this.hours.entries().next().value; old.job?.done || old.job?.finish(); old.tex?.dispose(); this.hours.delete(k); }
    if (h.none) { h.job = { promise: Promise.resolve(), done: true, finish() {} }; return h; }
    const vis = vol.raw.surface.VIS, b = proj.box, W = b.x1 - b.x0, H = b.y1 - b.y0, G = LITE ? 256 : 384, NX = Math.min(G, Math.ceil(W)), NY = Math.min(G, Math.ceil(H));
    const px = new Uint8Array(NX * NY * 4), land = vol.raw.surface.LAND, i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0, count = [0, 0, 0];
    let water = 0;
    h.job = idleLoop(NY, (iy) => {
      for (let ix = 0; ix < NX; ix++) {
        const ll = proj.toLatLon(b.x0 + ((ix + 0.5) * W) / NX, b.y0 + ((iy + 0.5) * H) / NY), q = vol.merc.ij(ll.lat, ll.lon);
        const i = Math.round(q.i - i0), j = Math.round(q.j - j0);
        if (i < 0 || j < 0 || i >= vol.w || j >= vol.h) continue;
        const c = j * vol.w + i, wet = !(land && land[c] > 0.5), k = visClass(vis[c]);
        if (wet) { water++; if (k >= 0) count[k]++; }
        if (k < 0) continue;
        const o = 4 * (iy * NX + ix), rgb = VIS_CLASSES[k].rgb;
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
      }
    });
    h.job.promise.then(() => {
      const tex = new THREE.DataTexture(px, NX, NY, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
      h.tex = tex; h.stats = { frac: count.map((n) => (water ? n / water : 0)) };
      this.onReady?.();                                              // any hour done: the explorer redraws
    }, () => {});
    return h;
  }
  prewarm(vol, proj) { if (vol && proj) this.hour(vol, proj); }

  // As FogLayer.show: the nearer hour's stats, {none: true} without VIS, null while not ready.
  show(V0, V1, frac, proj, onReady) {
    const a = this.hour(V0, proj), bh = V1 && frac > 0 ? this.hour(V1, proj) : a;
    if (a.none) { this.hide(); return { none: true }; }
    if (!a.tex) { a.job.promise.then(onReady, () => {}); return null; }
    const b = bh.tex ? bh : a;
    if (!bh.tex && !bh.none) bh.job.promise.then(onReady, () => {});
    const box = proj.box, key = `${box.x0},${box.y0},${box.x1},${box.y1}`;
    if (key !== this.meshKey) {
      if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
      const W = box.x1 - box.x0, H = box.y1 - box.y0;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uA: { value: null }, uB: { value: null }, uFrac: { value: 0 }, uOpacity: { value: this.opacity * 0.75 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D uA; uniform sampler2D uB; uniform float uFrac; uniform float uOpacity; varying vec2 vUv;
          void main() {
            vec4 c = mix(texture2D(uA, vUv), texture2D(uB, vUv), uFrac);
            if (c.a < 0.4) discard;
            gl_FragColor = vec4(c.rgb / max(c.a, 0.001), uOpacity);
          }`,
        transparent: true, depthWrite: false,
      });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      this.mesh.position.set((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, 0.009);   // just over the sea-state layer
      this.mesh.renderOrder = 9;
      this.group.add(this.mesh);
      this.meshKey = key;
    }
    const u = this.mesh.material.uniforms;
    u.uA.value = a.tex; u.uB.value = b.tex; u.uFrac.value = b === a ? 0 : frac;
    this.mesh.visible = true;
    return frac >= 0.5 && b !== a ? b.stats : a.stats;
  }
}
