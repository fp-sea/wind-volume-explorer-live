// Wind barbs and streamlines on the horizontal slice and the cross-section.
//
//   barbs        standard met barbs, in knots (half feather 5, feather 10, pennant 50; a circle
//                for calm), lying flat at their true height and pointing into the wind. On the
//                cross-section too: still horizontal, still true direction (what the wind does
//                there), so seen face-on they foreshorten.
//   streamlines  evenly spaced lines along the wind (a simple Jobard-Lefer: seeds on a grid,
//                a line stops when it runs into another), with small arrowheads downstream.
//                On the slice: the horizontal wind. On the cross-section: the flow in the
//                section's plane (the along-section wind and w), so lee waves and rising and
//                sinking air show as lines that climb and fall (heights are exaggerated like
//                everything else).
//
// Spacing follows the zoom (spacingKm); the caller rebuilds when it changes.
//
// Drawn as screen-width lines (1.6 px) over a wider halo of the opposite shade, so they read on
// any colour underneath. Colour (this.mode): "auto" (dark on a colour-filled slice or section,
// light on the bare scene: this.onFill), "dark", "light", or "speed" (UW wind bands, dark halo).

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { uwWind } from "./colormap.js?v=20261002173952";

const KT = 1.943844;
export const DARK = 0x06222a, LIGHT = 0xf2fafb;

// Screen-width line materials need the canvas size; every one made here is kept in step.
const LINE_MATS = new Set();
export function setLineResolution(w, h) { for (const m of LINE_MATS) m.resolution.set(w, h); }
function lineMaterial(opts) {
  const mat = new LineMaterial(opts);
  mat.resolution.set(window.innerWidth, window.innerHeight);
  LINE_MATS.add(mat);
  mat.addEventListener("dispose", () => LINE_MATS.delete(mat));
  return mat;
}
// Segments (pairs of xyz) as a coloured line over a wider dark outline: readable on any
// background, white included (station poles, observed-wind barbs). Returns a Group.
export function outlinedLines(segs, colour, { width = 2, halo = DARK, haloWidth = 2.6, opacity = 1, order = 21, depthTest = true } = {}) {
  const g = new THREE.Group();
  if (!segs.length) return g;
  for (const [c, w, op, o] of [[halo, width + haloWidth, 0.75 * opacity, order - 1], [colour, width, opacity, order]]) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segs);
    const l = new LineSegments2(geo, lineMaterial({ color: c, linewidth: w, transparent: true, opacity: op, depthWrite: false, depthTest }));
    l.renderOrder = o;
    g.add(l);
  }
  return g;
}
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export class WindGlyphs {
  constructor() {
    this.group = new THREE.Group(); this.group.renderOrder = 19;
    this.size = 1; this.opacity = 0.9; this.mode = "auto"; this.onFill = true;
    this.resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
  }
  setOpacity(o) { this.opacity = o; for (const c of this.group.children) c.material.opacity = o * (c.userData.base ?? 1); }
  setResolution(w, h) { this.resolution.set(w, h); setLineResolution(w, h); }

  clear() { for (const o of [...this.group.children]) { this.group.remove(o); o.geometry.dispose(); o.material.dispose(); } }

  // segs: positions (pairs of xyz); ks: wind speed (kt) per vertex, for "speed" colouring.
  add(segs, ks, rel = 1) {
    if (!segs.length) return;
    const dark = this.mode === "dark" || this.mode === "speed" || (this.mode === "auto" && this.onFill);
    const core = dark && this.mode !== "speed" ? rgb(DARK) : rgb(LIGHT), halo = dark && this.mode !== "speed" ? rgb(LIGHT) : rgb(DARK);
    const nv = segs.length / 3, cc = new Float32Array(nv * 3), hc = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const c = this.mode === "speed" ? uwWind(ks[v] ?? NaN) : core;
      cc[3 * v] = c[0]; cc[3 * v + 1] = c[1]; cc[3 * v + 2] = c[2];
      hc[3 * v] = halo[0]; hc[3 * v + 1] = halo[1]; hc[3 * v + 2] = halo[2];
    }
    const make = (cols, width, op, order) => {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(segs); geo.setColors(cols);
      const mat = lineMaterial({ vertexColors: true, linewidth: width, transparent: true, opacity: this.opacity * op, depthWrite: false });
      const l = new LineSegments2(geo, mat);
      l.userData.base = op;
      l.renderOrder = order;
      this.group.add(l);
    };
    make(hc, 2.0 * Math.max(1, this.size) + 2.6, 0.62 * rel, 18);   // halo
    make(cc, 2.0 * Math.max(1, this.size), rel, 19);                  // line (2 px: 1.6 was faint over a colour fill)
  }

  // Horizontal slice. g: {w, h, U, V (m/s east/north per cell, NaN = none), at(i, j) → {x, y},
  //   zAt(i, j) (scene height at a grid point, fractional ok), cellKm, toGrid(u, v, i, j) → [ug, vg] (grid axes), keep(x, y) → bool}.
  slice(g, { barbs, stream, spacingKm }) {
    const step = Math.max(1, Math.round(spacingKm / g.cellKm)), L = step * g.cellKm * 0.75 * this.size;
    if (barbs) {
      const segs = [], ks = [];
      for (let j = step >> 1; j < g.h; j += step) for (let i = step >> 1; i < g.w; i += step) {
        const c = j * g.w + i, u = g.U[c], v = g.V[c];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        const p = g.at(i, j);
        if (!g.keep(p.x, p.y)) continue;
        barb(segs, p.x, p.y, g.zAt(i, j), u, v, L, ks);
      }
      this.add(segs, ks);
    }
    if (stream) { const r = streamlinesSlice(g, step * 1.6, L * 0.35); this.add(r.pos, r.ks, 0.9); }
  }

  // Cross-section. s: {n, NZ, xy[i] {x, y}, zs (m), UA, W, U, V (m/s, [k * n + i]), dsKm (km between
  //   path points), ux, uy (unit vector along the section, east/north), vex}.
  section(s, { barbs, stream, spacingKm }) {
    const { n, NZ, xy, zs, vex } = s;
    if (barbs) {
      // Spacing on screen: the zoom's, but at least 6 rows up the section (it's only ~15 km tall on screen).
      const sp = Math.min(spacingKm, ((zs[NZ - 1] / 1000) * vex) / 6);
      const di = Math.max(1, Math.round(sp / s.dsKm)), dzM = Math.max(100, ((sp / vex) * 1000)), segs = [], ks = [];
      const L = Math.min(di * s.dsKm, sp) * 0.75 * this.size;
      for (let i = di >> 1; i < n; i += di) for (let z = dzM / 2; z < zs[NZ - 1]; z += dzM) {
        const k = Math.round((z / zs[NZ - 1]) * (NZ - 1)), q = k * n + i, u = s.U[q], v = s.V[q];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        barb(segs, xy[i].x, xy[i].y, (zs[k] / 1000) * vex, u, v, L, ks);
      }
      this.add(segs, ks);
    }
    if (stream) { const r = streamlinesSection(s, spacingKm, this.size); this.add(r.pos, r.ks, 0.9); }
  }
}

// One barb at (x, y, z) for wind (u, v) m/s, staff length L (scene km), pushed as segments;
// ks (optional) gets the speed (kt) for each vertex added.
export function barb(out, x, y, z, u, v, L, ks = null) {
  const spd = Math.hypot(u, v), kt = Math.round((spd * KT) / 5) * 5, k0 = spd * KT;
  const seg = (ax, ay, bx, by) => { out.push(ax, ay, z, bx, by, z); if (ks) ks.push(k0, k0); };
  if (kt < 5) {                                              // calm: a small circle
    const r = L * 0.12;
    for (let a = 0; a < 12; a++) { const t0 = (a / 12) * 2 * Math.PI, t1 = ((a + 1) / 12) * 2 * Math.PI; seg(x + r * Math.cos(t0), y + r * Math.sin(t0), x + r * Math.cos(t1), y + r * Math.sin(t1)); }
    return;
  }
  const dx = -u / spd, dy = -v / spd;                        // toward where the wind comes from
  const px = dy, py = -dx;                                   // feathers on the clockwise side (northern hemisphere)
  const ex = x + dx * L, ey = y + dy * L, st = L * 0.13, fl = L * 0.4;
  seg(x, y, ex, ey);
  let rest = kt, pos = 0;
  const at = (d) => [ex - dx * d, ey - dy * d];
  while (rest >= 50) {                                       // pennant: a triangle
    const [ax, ay] = at(pos), [bx, by] = at(pos + st), tx = ax + px * fl, ty = ay + py * fl;
    seg(ax, ay, tx, ty); seg(tx, ty, bx, by); seg(ax + (tx - ax) * 0.5, ay + (ty - ay) * 0.5, bx, by);
    pos += st * 1.25; rest -= 50;
  }
  while (rest >= 10) { const [ax, ay] = at(pos); seg(ax, ay, ax + px * fl + dx * st, ay + py * fl + dy * st); pos += st; rest -= 10; }
  if (rest >= 5) {
    if (kt === 5) pos = st;                                  // a lone half feather sits in from the end
    const [ax, ay] = at(pos); seg(ax, ay, ax + (px * fl + dx * st) * 0.5, ay + (py * fl + dy * st) * 0.5);
  }
}

// Evenly spaced streamlines in grid-index space; dsep in cells, arrow size in scene km.
function streamlinesSlice(g, dsep, arrow) {
  const { w, h } = g, out = [], ks = [], R = dsep / 2;
  const spd = (i, j) => {                                     // speed (kt) at a grid point, nearest cell
    const c = Math.min(h - 1, Math.max(0, Math.round(j))) * w + Math.min(w - 1, Math.max(0, Math.round(i)));
    return Math.hypot(g.U[c], g.V[c]) * KT;
  };
  const RW = Math.ceil(w / R) + 1, RH = Math.ceil(h / R) + 1, occ = new Int32Array(RW * RH);
  const cellOf = (i, j) => Math.floor(j / R) * RW + Math.floor(i / R);
  // The wind in grid axes, once per cell (turning it per step was most of the cost).
  const GU = new Float32Array(w * h), GV = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = j * w + i, u = g.U[c], v = g.V[c];
    if (Number.isFinite(u) && Number.isFinite(v)) { const t = g.toGrid(u, v, i, j); GU[c] = t[0]; GV[c] = t[1]; } else GU[c] = GV[c] = NaN;
  }
  const vel = (i, j) => {
    if (i < 0 || j < 0 || i > w - 1 || j > h - 1) return null;
    const i0 = Math.min(w - 2, Math.floor(i)), j0 = Math.min(h - 2, Math.floor(j)), a = i - i0, b = j - j0;
    let u = 0, v = 0, s = 0;
    for (let c4 = 0; c4 < 4; c4++) {
      const di = c4 & 1, dj = c4 >> 1, wt = (di ? a : 1 - a) * (dj ? b : 1 - b), c = (j0 + dj) * w + (i0 + di), x = GU[c];
      if (x === x && wt > 0) { u += x * wt; v += GV[c] * wt; s += wt; }
    }
    if (s < 0.5) return null;
    u /= s; v /= s;
    const m = Math.hypot(u, v);
    if (m < 0.3) return null;                                // calm: no direction to follow
    return [u / m, v / m];
  };
  const seeds = [];
  for (let j = dsep / 2; j < h; j += dsep) for (let i = dsep / 2; i < w; i += dsep) seeds.push([i, j]);
  for (let k = seeds.length - 1; k > 0; k--) { const r = (k * 7919) % (k + 1); [seeds[k], seeds[r]] = [seeds[r], seeds[k]]; }   // fixed shuffle: same lines each time
  let id = 0;
  for (const [si, sj] of seeds) {
    if (occ[cellOf(si, sj)]) continue;
    id++;
    const trace = (sign) => {
      const pts = [];
      let i = si, j = sj;
      for (let n = 0; n < 600; n++) {
        const d1 = vel(i, j);
        if (!d1) break;
        const mi = i + sign * d1[0] * 0.25, mj = j + sign * d1[1] * 0.25, d2 = vel(mi, mj);   // midpoint (RK2), half-cell steps
        if (!d2) break;
        i += sign * d2[0] * 0.5; j += sign * d2[1] * 0.5;
        if (i < 0 || j < 0 || i > w - 1 || j > h - 1) break;
        const c = cellOf(i, j);
        if (occ[c] && occ[c] !== id) break;
        const p = g.at(i, j);
        if (!g.keep(p.x, p.y)) break;
        occ[c] = id;
        pts.push([i, j]);
      }
      return pts;
    };
    occ[cellOf(si, sj)] = id;
    const pts = [...trace(-1).reverse(), [si, sj], ...trace(1)];
    if (pts.length < 6) continue;
    const xyz = pts.map(([i, j]) => { const p = g.at(i, j); return [p.x, p.y, g.zAt(i, j) + 0.004]; });
    const sk = pts.map(([i, j]) => spd(i, j));
    for (let k = 1; k < xyz.length; k++) { out.push(...xyz[k - 1], ...xyz[k]); ks.push(sk[k - 1], sk[k]); }
    const every = Math.max(4, Math.round(dsep * 4));
    for (let k = every >> 1; k < xyz.length - 1; k += every) { arrowhead(out, xyz[k - 1], xyz[k + 1], arrow); ks.push(sk[k], sk[k], sk[k], sk[k]); }
  }
  return { pos: out, ks };
}

// Streamlines of the in-plane flow on a cross-section, in (path index, metres) space.
function streamlinesSection(s, spacingKm, size = 1) {
  const { n, NZ, xy, zs, UA, W, vex } = s, top = zs[NZ - 1], out = [], ks = [];
  const dzM = top / (NZ - 1);
  const sp = Math.min(spacingKm * 1.4, ((top / 1000) * vex) / 7);    // on-screen separation, ≥ 7 lines up the section
  const sepI = Math.max(2, sp / s.dsKm), sepZ = Math.max(100, (sp / vex) * 1000);
  const RW = Math.ceil(n / (sepI / 2)) + 1, RH = Math.ceil(top / (sepZ / 2)) + 1, occ = new Int32Array(RW * RH);
  const cellOf = (i, z) => Math.floor(z / (sepZ / 2)) * RW + Math.floor(i / (sepI / 2));
  const at = (i, z) => {                                     // [ds/dt in path points, dz/dt in m] per unit, normalised in display space
    if (i < 0 || i > n - 1 || z < 0 || z > top) return null;
    const i0 = Math.min(n - 2, Math.floor(i)), fk = z / dzM, k0 = Math.min(NZ - 2, Math.floor(fk)), a = i - i0, b = fk - k0;
    let ua = 0, ww = 0, s1 = 0;
    for (const [di, dk, wt] of [[0, 0, (1 - a) * (1 - b)], [1, 0, a * (1 - b)], [0, 1, (1 - a) * b], [1, 1, a * b]]) {
      const q = (k0 + dk) * n + (i0 + di), x = UA[q];
      if (Number.isFinite(x) && wt > 0) { ua += x * wt; const y = W[q]; ww += (Number.isFinite(y) ? y : 0) * wt; s1 += wt; }
    }
    if (s1 < 0.5) return null;
    ua /= s1; ww /= s1;
    // In display units (km on screen): along = ua, up = w × vex. Normalise to a fixed on-screen step.
    const ex = ua, ez = ww * vex, m = Math.hypot(ex, ez);
    if (m < 0.2) return null;
    return [ex / m, ez / m];
  };
  const stepKm = s.dsKm * 0.5;
  let id = 0;
  for (let z = sepZ / 2; z < top; z += sepZ) for (let i = sepI / 2; i < n; i += sepI) {
    if (occ[cellOf(i, z)]) continue;
    id++;
    const trace = (sign) => {
      const pts = [];
      let pi = i, pz = z;
      for (let k = 0; k < 800; k++) {
        const d = at(pi, pz);
        if (!d) break;
        pi += (sign * d[0] * stepKm) / s.dsKm; pz += (sign * d[1] * stepKm * 1000) / vex;
        if (pi < 0 || pi > n - 1 || pz < 0 || pz > top) break;
        const c = cellOf(pi, pz);
        if (occ[c] && occ[c] !== id) break;
        occ[c] = id;
        pts.push([pi, pz]);
      }
      return pts;
    };
    occ[cellOf(i, z)] = id;
    const pts = [...trace(-1).reverse(), [i, z], ...trace(1)];
    if (pts.length < 6) continue;
    const xyz = pts.map(([pi, pz]) => {
      const i0 = Math.min(n - 2, Math.floor(pi)), f = pi - i0;
      return [xy[i0].x + (xy[i0 + 1].x - xy[i0].x) * f, xy[i0].y + (xy[i0 + 1].y - xy[i0].y) * f, (pz / 1000) * vex];
    });
    const sk = pts.map(([pi, pz]) => {                        // horizontal speed (kt), nearest grid point
      const q = Math.min(NZ - 1, Math.round(pz / dzM)) * n + Math.min(n - 1, Math.round(pi));
      return Math.hypot(s.U[q], s.V[q]) * KT;
    });
    for (let k = 1; k < xyz.length; k++) { out.push(...xyz[k - 1], ...xyz[k]); ks.push(sk[k - 1], sk[k]); }
    const every = Math.max(12, Math.round((sp * 3) / (s.dsKm * 0.5)));   // about three line-spacings apart
    for (let k = every >> 1; k < xyz.length - 1; k += every) {
      arrowhead(out, xyz[k - 1], xyz[k + 1], Math.min(s.dsKm * 1.5, sp * 0.22) * size, true);   // fits between neighbouring lines
      ks.push(sk[k], sk[k], sk[k], sk[k]);
    }
  }
  return { pos: out, ks };
}

// A small open arrowhead between a and c, pointing a → c. Wings lie flat (slice) or in the
// vertical plane of the line (inPlane: cross-section lines).
function arrowhead(out, a, c, size, inPlane = false) {
  const tx = c[0] - a[0], ty = c[1] - a[1], tz = c[2] - a[2], m = Math.hypot(tx, ty, tz);
  if (!m) return;
  const ux = tx / m, uy = ty / m, uz = tz / m, mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2, mz = (a[2] + c[2]) / 2;
  let px, py, pz;
  if (inPlane) { px = -uz * ux; py = -uz * uy; pz = 1 - uz * uz; }   // "up", made perpendicular to the line
  else { px = -uy; py = ux; pz = 0; }
  const pm = Math.hypot(px, py, pz);
  if (!pm) return;
  px /= pm; py /= pm; pz /= pm;
  for (const sgn of [1, -1]) out.push(mx, my, mz, mx - ux * size + sgn * px * size * 0.55, my - uy * size + sgn * py * size * 0.55, mz - uz * size + sgn * pz * size * 0.55);
}
