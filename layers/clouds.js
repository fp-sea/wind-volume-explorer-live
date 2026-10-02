// Clouds: the model's own cloud water + cloud ice (condensate, g/kg), drawn as a stack of thin
// translucent sheets from the surface to 8 km. Real model output, not an effect: in Hawaiʻi the
// trade cumulus flattened under the inversion and the clear air in the lee; on the Salish Sea
// the marine layer and fog, and cloud banked on the Olympics.
//
// The condensate is resampled once per model HOUR onto a regular grid over the scene (about
// 1.5 km, NZ heights) and kept as a 3-D texture; each sheet samples its height in it. Between
// hours the two hours' textures are cross-faded on the GPU, so playback costs nothing per step
// (it used to resample the blended volume every step: ~300 ms). The resampling itself runs in
// idle-time slices (idle.js). Each sheet covers only the 8 × 8-cell tiles that have cloud at its
// height in either hour (plus their neighbours, so the texture's soft edges aren't cut off), not
// the whole map: most of the drawing cost was full-screen sheets with little or no cloud.
// Sheets rather than ray marching: they sort and depth-test with the terrain, markers and
// everything else, and stay light on phones. Seen edge-on they can look layered.

import * as THREE from "three";
import { idleLoop } from "../idle.js?v=20261002173952";
import { LITE } from "../device.js?v=20261002173952";

const NZ = LITE ? 32 : 48, ZTOP = 8000;    // sheets (fewer on phones: device.js) and top (m above sea level)
const QREF = 0.6;                          // g/kg that reads as a dense cloud
const TILE = 8, MIN_D = 6;                 // tile size (cells); stored density that's drawn at all (the shader's 0.02)
export const CLOUD_TOP_M = ZTOP;

export class CloudLayer {
  constructor() { this.group = new THREE.Group(); this.opacity = 0.8; this.hours = new Map(); this.meshes = []; this.meshKey = null; }

  clear() {
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = []; this.meshKey = null; this.pairA = this.pairB = null;
    for (const h of this.hours.values()) h.tex?.dispose();
    this.hours.clear();
  }
  hide() { for (const m of this.meshes) m.visible = false; }
  setOpacity(o) { this.opacity = o; for (const m of this.meshes) m.material.uniforms.uOpacity.value = o; }

  // One model hour (a Volume, not a blend) resampled: {tex, has (per height), stats, job}.
  // Computed in idle slices; ready when h.tex is set. Kept for the six most recently used hours (on screen, and prewarmed ahead).
  hour(vol, proj) {
    let h = this.hours.get(vol);
    if (h) { this.hours.delete(vol); this.hours.set(vol, h); return h; }     // most recently used last
    const b = proj.box, W = b.x1 - b.x0, H = b.y1 - b.y0;
    const G = LITE ? 120 : 200, NX = Math.min(G, Math.ceil(W / 1.5)), NY = Math.min(G, Math.ceil(H / 1.5));
    const zs = Array.from({ length: NZ }, (_, k) => ((k + 0.5) * ZTOP) / NZ);
    const data = new Uint8Array(NX * NY * NZ), prof = new Float32Array(NZ), has = new Uint8Array(NZ);
    const TX = Math.ceil(NX / TILE), TY = Math.ceil(NY / TILE), tiles = new Uint8Array(NZ * TX * TY);
    const i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0, tops = [], bases = [];
    let cloudy = 0, cols = 0;
    h = { tex: null, has, tiles, NX, NY, TX, TY, stats: null };
    h.job = idleLoop(NY, (iy) => {                       // one row of columns per step
      for (let ix = 0; ix < NX; ix++) {
        const x = b.x0 + ((ix + 0.5) * W) / NX, y = b.y0 + ((iy + 0.5) * H) / NY, ll = proj.toLatLon(x, y);
        const q = vol.merc.ij(ll.lat, ll.lon), i = Math.round(q.i - i0), j = Math.round(q.j - j0);
        if (i < 0 || j < 0 || i >= vol.w || j >= vol.h) continue;
        cols++;
        vol.profile("Q", j * vol.w + i, zs, prof, 0, 1);
        let base = -1, top = -1;
        for (let k = 0; k < NZ; k++) {
          const g = prof[k];
          if (!(g > 0.005)) continue;                               // below ~0.005 g/kg: clear
          const dv = Math.min(255, Math.round(255 * Math.sqrt(Math.min(1, g / QREF))));
          data[k * NX * NY + iy * NX + ix] = dv;
          has[k] = 1;
          if (dv >= MIN_D) {                                              // its tile and any tile it touches (soft edges)
            const tx0 = Math.max(0, (ix - 1) >> 3), tx1 = Math.min(TX - 1, (ix + 1) >> 3), ty0 = Math.max(0, (iy - 1) >> 3), ty1 = Math.min(TY - 1, (iy + 1) >> 3);
            for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles[(k * TY + ty) * TX + tx] = 1;
          }
          if (g > 0.02) { if (base < 0) base = k; top = k; }
        }
        if (top >= 0) { cloudy++; tops.push(zs[top]); bases.push(zs[base]); }
      }
    });
    h.job.promise.then(() => {
      const tex = new THREE.Data3DTexture(data, NX, NY, NZ);
      tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
      const med = (a) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : NaN);
      h.tex = tex; h.stats = { cover: cols ? cloudy / cols : 0, topMedian: med(tops), baseMedian: med(bases) };
      this.onReady?.();                                              // any hour done: the explorer redraws
    }, () => {});
    this.hours.set(vol, h);
    while (this.hours.size > 6) { const [k, old] = this.hours.entries().next().value; old.job.done || old.job.finish(); old.tex?.dispose(); this.hours.delete(k); }
    return h;
  }

  // Start an hour in the background (the next hours, while you look at this one).
  prewarm(vol, proj) { if (vol && proj) this.hour(vol, proj); }

  // Show the time between V0 and V1 (frac 0-1). Returns the stats of the nearer hour, or null
  // while V0 is still being resampled (onReady is called when it's in).
  show(V0, V1, frac, proj, vex, onReady) {
    const a = this.hour(V0, proj);
    const bh = V1 && frac > 0 ? this.hour(V1, proj) : a;
    if (!a.tex) { a.job.promise.then(onReady, () => {}); return null; }
    const b = bh.tex ? bh : a;                                        // next hour not ready yet: hold this one
    if (!bh.tex) bh.job.promise.then(onReady, () => {});
    this.sheets(proj, vex);
    if (this.pairA !== a || this.pairB !== b) { this.pairA = a; this.pairB = b; this.tileGeometry(a, b, proj); }
    for (let k = 0; k < NZ; k++) {
      const m = this.meshes[k], u = m.material.uniforms;
      u.uA.value = a.tex; u.uB.value = b.tex; u.uFrac.value = b === a ? 0 : frac;
      m.visible = m.geometry.index?.count > 0;
    }
    return frac >= 0.5 && b !== a ? b.stats : a.stats;
  }

  // Each sheet's geometry: quads over the tiles with cloud at its height in hour a or b. The quads
  // are in scene km with UVs into the whole-map texture, so the shader is unchanged.
  tileGeometry(a, b, proj) {
    const box = proj.box, W = box.x1 - box.x0, H = box.y1 - box.y0, { NX, NY, TX, TY } = a;
    for (let k = 0; k < NZ; k++) {
      const pos = [], uv = [], idx = [];
      for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
        const t = (k * TY + ty) * TX + tx;
        if (!a.tiles[t] && !b.tiles[t]) continue;
        const u0 = (tx * TILE) / NX, u1 = Math.min(NX, (tx + 1) * TILE) / NX, v0 = (ty * TILE) / NY, v1 = Math.min(NY, (ty + 1) * TILE) / NY, q = pos.length / 3;
        for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) { pos.push(box.x0 + u * W, box.y0 + v * H, 0); uv.push(u, v); }
        idx.push(q, q + 1, q + 2, q, q + 2, q + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const m = this.meshes[k];
      m.geometry.dispose(); m.geometry = g;
    }
  }

  // The NZ sheets (materials), built once per region and exaggeration; geometry per hour pair.
  sheets(proj, vex) {
    const b = proj.box, key = `${b.x0},${b.y0},${b.x1},${b.y1}|${vex}`;
    if (key === this.meshKey) return;
    this.pairA = this.pairB = null;                                 // new meshes: tiles again
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = []; this.meshKey = key;
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    for (let k = 0; k < NZ; k++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uA: { value: null }, uB: { value: null }, uFrac: { value: 0 }, uZ: { value: (k + 0.5) / NZ }, uOpacity: { value: this.opacity } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `precision highp float; precision highp sampler3D;
          uniform sampler3D uA; uniform sampler3D uB; uniform float uFrac; uniform float uZ; uniform float uOpacity; varying vec2 vUv;
          void main() {
            vec3 p = vec3(vUv, uZ);
            float d = mix(texture(uA, p).r, texture(uB, p).r, uFrac);     // the two model hours, cross-faded
            if (d < 0.02) discard;
            float a = (1.0 - exp(-d * 2.2)) * 0.42 * uOpacity;          // per sheet; a column of sheets builds up
            vec3 c = mix(vec3(0.70, 0.74, 0.78), vec3(1.0), clamp(0.35 + uZ * 0.9 + d * 0.25, 0.0, 1.0));   // greyer low, brighter up high
            gl_FragColor = vec4(c, a);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);       // tiles filled in by tileGeometry
      m.position.set(0, 0, ((((k + 0.5) * ZTOP) / NZ) / 1000) * vex);
      m.renderOrder = 17; m.visible = false;
      this.meshes.push(m); this.group.add(m);
    }
  }
}
