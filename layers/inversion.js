// The inversion (Hawaiʻi: trade-wind inversion; elsewhere "capping stable layer"): detected per
// model column (web/model/twi.js), drawn as a band.
//
//   3D             a surface at the base, coloured by strength (TII 0-10) on its own violet ramp,
//                  which no other field uses (brief 4.7: never reuse the wind or spread hues), and a
//                  faint surface at the top. Columns with no inversion are holes.
//   cross-section  a crisp bright line at the base (the operationally important number), the top
//                  line, and a translucent fill between them, along the section.

import * as THREE from "three";
import { detectVolume, detectAlloc, detectRange } from "../model/twi.js?v=20261002173952";
import { idleLoop } from "../idle.js?v=20261002173952";
import { gridXY, gridIndex } from "./gridxy.js?v=20261002173952";

const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
export const TII_RAMP = ["#5a3490", "#7240b4", "#8c55d4", "#a870e6", "#c895f2", "#ecc8ff"].map(hex);   // low end lifted: weak inversions were near-black on the dark sea
const tiiColour = (x) => {
  const t = Math.min(1, Math.max(0, x / 10)) * (TII_RAMP.length - 1), i = Math.min(TII_RAMP.length - 2, Math.floor(t)), f = t - i;
  return TII_RAMP[i].map((a, k) => a + (TII_RAMP[i + 1][k] - a) * f);
};
const BASE_LINE = 0xf3e6ff, TOP_LINE = 0xb58be0;

// Detection for a Volume, computed once per forecast hour, then smoothed for display: each
// column's base/top/TII becomes the median of its 5×5 neighbourhood where at least 60% of it
// found an inversion, else nothing. A median keeps a real column's value rather than inventing
// an average, and drops lone detections and lone gaps (per-column detection is noisy at 25 mb).
// The detection for one hour (a Volume), cached on it. Started in idle time for upcoming hours by
// prewarmDetection (~250 ms of work in slices); if it's needed before it's done, the rest runs now.
export const detectionOf = (vol) => {
  if (vol._twi) return vol._twi;
  if (vol._twiJob) { vol._twiJob.finish(); if (vol._twi) return vol._twi; }
  return (vol._twi = smooth(detectVolume(vol), vol.w, vol.h));
};
export function prewarmDetection(vol) {
  if (!vol || vol._twi || vol._twiJob) return;
  const { n, w, h } = vol, d = detectAlloc(n), step = 600, nd = Math.ceil(n / step);
  let out = null;
  vol._twiJob = idleLoop(nd + h, (i) => {
    if (i < nd) { detectRange(vol, d, i * step, (i + 1) * step); return; }
    out ||= smoothAlloc(d, w, h);
    smoothRow(d, out, w, h, i - nd);
    if (i === nd + h - 1) { out.raw = d; vol._twi = out; }
  });
}

const smoothAlloc = (d, w, h) => ({ ...d, base: new Float32Array(w * h).fill(NaN), top: new Float32Array(w * h).fill(NaN), tii: new Float32Array(w * h) });
function smooth(d, w, h, R = 2, minFrac = 0.6) {
  const out = smoothAlloc(d, w, h);
  for (let j = 0; j < h; j++) smoothRow(d, out, w, h, j, R, minFrac);
  out.raw = d;
  return out;
}
// Median of the finite neighbours within R cells, where at least minFrac of them found a layer.
function smoothRow(d, out, w, h, j, R = 2, minFrac = 0.6) {
  const nb = [], nt = [], ni = [];
  for (let i = 0; i < w; i++) {
    nb.length = nt.length = ni.length = 0;
    let tot = 0;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      tot++;
      const c = y * w + x;
      if (Number.isFinite(d.base[c])) { nb.push(d.base[c]); nt.push(d.top[c]); ni.push(d.tii[c]); }
    }
    if (nb.length < minFrac * tot) continue;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const c = j * w + i;
    out.base[c] = med(nb); out.top[c] = med(nt); out.tii[c] = med(ni);
  }
}

export class InversionLayer {
  constructor(clip = null) { this.group = new THREE.Group(); this.opacity = 0.5; this.clip = clip; }

  setOpacity(o) {
    this.opacity = o;
    this.group.traverse((m) => { if (m.material && m.userData.base != null) m.material.opacity = m.userData.base * o / 0.5; });
  }

  clear() { for (const o of [...this.group.children]) { this.group.remove(o); o.traverse((q) => { q.geometry?.dispose(); q.material?.dispose(); }); } }

  // vol: Volume (one forecast hour); proj: scene projection. Returns {found (fraction of water
  // columns with an inversion), baseMedian, tiiMedian}.
  build(vol, proj, vex) {
    this.clear();
    const d = detectionOf(vol), { w, h } = vol, lat = vol.raw.lat, lon = vol.raw.lon, n = w * h;
    const xy = gridXY(vol, proj);                                   // (shared per grid: gridxy.js)
    // Cells drawn: all four corners found an inversion, agreeing within 600 m (no walls across gaps).
    const ok = new Uint8Array((w - 1) * (h - 1)), B = d.base, T = d.top;
    const tri = new Uint32Array((w - 1) * (h - 1) * 6);
    let nt = 0;
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, e = a + w + 1;
      if (!(B[a] === B[a] && B[b] === B[b] && B[c] === B[c] && B[e] === B[e] && T[a] === T[a] && T[b] === T[b] && T[c] === T[c] && T[e] === T[e])) continue;   // x === x: finite (not NaN)
      if (Math.max(B[a], B[b], B[c], B[e]) - Math.min(B[a], B[b], B[c], B[e]) > 600) continue;
      ok[j * (w - 1) + i] = 1;
      tri[nt++] = a; tri[nt++] = b; tri[nt++] = e; tri[nt++] = a; tri[nt++] = e; tri[nt++] = c;
    }
    const triIdx = tri.subarray(0, nt);                              // the same for every sheet
    const col = new Float32Array(n * 3);
    for (let c = 0; c < n; c++) { const k = tiiColour(d.tii[c]); col[3 * c] = k[0]; col[3 * c + 1] = k[1]; col[3 * c + 2] = k[2]; }
    const mat = (opacity, order) => {
      const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false });
      if (this.clip) this.clip.patch(m);
      return m;
    };
    const add = (geo, opacity, order) => {
      const m = new THREE.Mesh(geo, mat(opacity * this.opacity / 0.5, order));
      m.renderOrder = order;
      m.userData.base = opacity;                                   // relative to the default 0.5, so the slider scales it
      this.group.add(m);
    };
    // A sheet at a fraction f of the way from base to top (f = 0 base, 1 top).
    const sheet = (f, opacity, order, lighten = 0) => {
      const pos = new Float32Array(n * 3), cc = new Float32Array(n * 3);
      for (let c = 0; c < n; c++) {
        const zb = d.base[c], zt = d.top[c], z = Number.isFinite(zb) && Number.isFinite(zt) ? zb + (zt - zb) * f : 0;
        pos[3 * c] = xy[2 * c]; pos[3 * c + 1] = xy[2 * c + 1]; pos[3 * c + 2] = (z / 1000) * vex;
        for (let k = 0; k < 3; k++) cc[3 * c + k] = col[3 * c + k] + (1 - col[3 * c + k]) * lighten;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(cc, 3));
      geo.setIndex(new THREE.BufferAttribute(triIdx, 1));
      add(geo, opacity, order);
    };
    // Filled band: the base (coloured by strength), three faint sheets inside, a lighter top.
    sheet(0, 0.55, 14);
    for (const f of [0.25, 0.5, 0.75]) sheet(f, 0.14, 13);
    sheet(1, 0.3, 13, 0.35);
    // Walls where the band ends, base to top, so it reads as a slab from the side.
    const wpos = [], wcol = [];
    const wall = (a, b) => {
      const P = (c, arr) => [xy[2 * c], xy[2 * c + 1], (arr[c] / 1000) * vex], C = (c) => [col[3 * c], col[3 * c + 1], col[3 * c + 2]];
      wpos.push(...P(a, d.base), ...P(b, d.base), ...P(b, d.top), ...P(a, d.base), ...P(b, d.top), ...P(a, d.top));
      wcol.push(...C(a), ...C(b), ...C(b), ...C(a), ...C(b), ...C(a));
    };
    const cell = (i, j) => i >= 0 && j >= 0 && i < w - 1 && j < h - 1 && ok[j * (w - 1) + i];
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      if (!ok[j * (w - 1) + i]) continue;
      const a = j * w + i;
      if (!cell(i, j - 1)) wall(a, a + 1);
      if (!cell(i, j + 1)) wall(a + w, a + w + 1);
      if (!cell(i - 1, j)) wall(a, a + w);
      if (!cell(i + 1, j)) wall(a + 1, a + w + 1);
    }
    if (wpos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(wpos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(wcol, 3));
      add(geo, 0.3, 13);
    }
    // Summary over water columns (land columns are often too short to hold the cap).
    const land = vol.raw.surface.LAND, bases = [], tiis = [];
    let water = 0;
    for (let c = 0; c < n; c++) {
      if (land && land[c] > 0.5) continue;
      water++;
      if (Number.isFinite(d.raw.base[c])) { bases.push(d.raw.base[c]); tiis.push(d.raw.tii[c]); }
    }
    const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : NaN);
    const trueInv = tiis.filter((x) => x > 0).length;                // temperature actually rises through it
    return { found: water ? bases.length / water : 0, baseMedian: med(bases), tiiMedian: med([...tiis]), tiiMax: tiis.length ? Math.max(...tiis) : NaN,
             trueFrac: tiis.length ? trueInv / tiis.length : NaN };
  }

  // The band along a cross-section: path [{lat, lon}] → base line, top line, fill between.
  curtain(vol, proj, path, vex) {
    const d = detectionOf(vol), m = vol.merc, i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0;
    const at = (arr, p) => {                        // nearest column: the detection isn't interpolable across gaps
      const q = m.ij(p.lat, p.lon), i = Math.round(q.i - i0), j = Math.round(q.j - j0);
      return i < 0 || j < 0 || i >= vol.w || j >= vol.h ? NaN : arr[j * vol.w + i];
    };
    const xy = path.map((p) => proj.toXY(p.lat, p.lon)), base = path.map((p) => at(d.base, p)), top = path.map((p) => at(d.top, p));
    const g = new THREE.Group();
    const runs = (arr) => {                          // continuous stretches where the band exists
      const out = []; let cur = [];
      arr.forEach((z, i) => { if (Number.isFinite(z) && Number.isFinite(top[i])) cur.push(i); else if (cur.length) { out.push(cur); cur = []; } });
      if (cur.length) out.push(cur);
      return out;
    };
    for (const run of runs(base)) {
      if (run.length < 2) continue;
      const line = (arr, color, opacity) => {
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(run.map((i) => new THREE.Vector3(xy[i].x, xy[i].y, (arr[i] / 1000) * vex))),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
        l.renderOrder = 16; g.add(l);
      };
      line(base, BASE_LINE, 1); line(top, TOP_LINE, 0.8);
      const pos = [];
      for (let k = 0; k < run.length - 1; k++) {
        const a = run[k], b = run[k + 1];
        const P = (i, arr) => [xy[i].x, xy[i].y, (arr[i] / 1000) * vex];
        pos.push(...P(a, base), ...P(b, base), ...P(b, top), ...P(a, base), ...P(b, top), ...P(a, top));
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xa35ee0, transparent: true, opacity: 0.44 * this.opacity, side: THREE.DoubleSide, depthWrite: false }));
      fill.userData.base = 0.22;
      fill.renderOrder = 15; g.add(fill);
    }
    this.group.add(g);
  }
}
