// SYNC: radar-explorer web/chart.js@20a7d31. Copied verbatim except the line marked "WVE CHANGE" (data path).
// radar-explorer is still iterating on its marine chart (owner, 2026-09-27): run scripts/check_sync.py and re-sync.

// Marine chart, drawn here from NOAA ENC vector data (built per area by
// src/radarviz/chart.py from ENC Direct to GIS): sharp at any zoom, loaded
// once, and styled to sit under the radar rather than in S-52 chart colours.
//
//   depth areas     graded blues, pale where it dries or is shallow
//   depth contours  fine light lines (10, 20, 50, 100 m brighter)
//   traffic lanes   soft magenta; separation zones purple; dredged channels
//                   grey-blue; fairways outlined
//   buoys, lights   small dots in their colours
//   soundings       numbers when zoomed in close; any depth on hover
//
// Coordinates arrive in the area's km (10 m units). For seeing where the
// water is and how deep, not for navigation.

import * as THREE from "three";

// Depth bands (metres, by the shallow edge of each area) and their colours.
export const DEPTH_BANDS = [
  [-Infinity, "#6f7f5e", "dries"], [0, "#cfeef6", "0-2"], [2, "#a6dcef", "2-5"], [5, "#7cc4e6", "5-10"],
  [10, "#56a6d6", "10-20"], [20, "#3a86c0", "20-50"], [50, "#2a69a3", "50-100"], [100, "#1f5084", "100-200"], [200, "#173c66", "200+"],
];
const bandOf = (d1) => { let k = 0; for (let i = 0; i < DEPTH_BANDS.length; i++) if (d1 >= DEPTH_BANDS[i][0]) k = i; return d1 < 0 ? 0 : Math.max(1, k); };
// S-57 colour codes -> colours (1 white, 2 black, 3 red, 4 green, 6 yellow, 11 orange).
const MARK = { 1: "#ffffff", 2: "#222222", 3: "#ff4b4b", 4: "#3ce07a", 5: "#4f9dff", 6: "#ffd84a", 11: "#ff9f43" };
const Z = 0.02;
const unpack = (a) => { const v = []; for (let i = 0; i < a.length; i += 2) v.push(new THREE.Vector2(a[i] / 100, a[i + 1] / 100)); return v; };

export class ChartLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.labels = new THREE.Group();
    this.group.add(this.labels);
    this.area = null;
    this.data = null;
    this.opacity = 0.8;
    this.mats = [];
  }

  async load(areaId) {
    if (this.area === areaId && this.data !== undefined) return this.data;
    this.area = areaId;
    // WVE CHANGE: this project's data path (areaId is the region id).
    this.data = await fetch(`data/${areaId}/chart.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.build();
    return this.data;
  }

  clear() {
    for (const o of [...this.group.children]) if (o !== this.labels) { o.geometry?.dispose(); o.removeFromParent(); }
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.labels.clear();
  }

  mat(color, opacity, extra = {}) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });
    m.userData.base = opacity;
    m.opacity = opacity * this.opacity;
    this.mats.push(m);
    return m;
  }

  // Polygons (rings in 10 m units) -> one mesh.
  fill(polys, color, opacity, order, z = Z) {
    const pos = [];
    for (const r of polys) {
      const outer = unpack(r[0]), holes = r.slice(1).map(unpack);
      if (outer.length < 3) continue;
      const tris = THREE.ShapeUtils.triangulateShape(outer, holes), all = outer.concat(...holes);
      for (const t of tris) for (const k of t) pos.push(all[k].x, all[k].y, z);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, this.mat(color, opacity));
    m.renderOrder = order;
    this.group.add(m);
  }

  // Lines (flat arrays in 10 m units) -> one line set.
  stroke(lines, color, opacity, order, z = Z + 0.002) {
    const pos = [];
    for (const a of lines) for (let i = 2; i < a.length; i += 2) pos.push(a[i - 2] / 100, a[i - 1] / 100, z, a[i] / 100, a[i + 1] / 100, z);
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false });
    m.userData.base = opacity; m.opacity = opacity * this.opacity;
    this.mats.push(m);
    const l = new THREE.LineSegments(g, m);
    l.renderOrder = order;
    this.group.add(l);
  }

  dots(flat, colorOf, size, opacity, order) {
    const pos = [], col = [], c = new THREE.Color();
    for (let i = 0; i < flat.length; i += 3) { pos.push(flat[i] / 100, flat[i + 1] / 100, Z + 0.01); c.set(colorOf(flat[i + 2])); col.push(c.r, c.g, c.b); }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false });
    m.userData.base = opacity; m.opacity = opacity * this.opacity;
    this.mats.push(m);
    const p = new THREE.Points(g, m);
    p.renderOrder = order;
    this.group.add(p);
  }

  build() {
    this.clear();
    const d = this.data;
    if (!d) return;
    // Depth areas by band, coarse first (the file is in that order), so finer ones cover them.
    const byBand = DEPTH_BANDS.map(() => []);
    for (const a of d.depth) byBand[bandOf(a.d1 ?? 0)].push(a.r);
    // (One mesh per colour: the file's coarse-to-fine order holds within each.)
    byBand.forEach((polys, i) => this.fill(polys, DEPTH_BANDS[i][1], 0.55, 3));   // see-through: the map and relief show under it
    this.fill(d.dredged.map((f) => f.r), "#9fb3c4", 0.55, 4, Z + 0.001);
    this.fill(d.tsszone.map((f) => f.r), "#b06ad6", 0.2, 4, Z + 0.001);
    this.fill(d.lane.map((f) => f.r), "#e45fa8", 0.1, 4, Z + 0.001);
    const outline = (fs) => fs.flatMap((f) => f.r.map((ring) => ring.concat(ring.slice(0, 2))));
    this.stroke(outline(d.lane), "#e45fa8", 0.55, 5);
    this.stroke(outline(d.fairway), "#d7e6f2", 0.5, 5);
    const major = (v) => [10, 20, 50, 100, 200].includes(v);
    this.stroke(d.contour.filter((c) => !major(c.v)).map((c) => c.p), "#e8f3fa", 0.22, 5);
    this.stroke(d.contour.filter((c) => major(c.v)).map((c) => c.p), "#f4fbff", 0.5, 5);
    this.dots(d.light, () => "#ffe66b", 4, 0.9, 6);
    this.dots(d.buoy, (c) => MARK[c] || "#ffffff", 5, 1, 6);
    this.index();
  }

  setOpacity(o) {
    this.opacity = o;
    for (const m of this.mats) m.opacity = m.userData.base * o;
  }

  // Grids for hover and sounding labels: soundings by 2 km cell, depth areas by bounding box.
  index() {
    const d = this.data, S = new Map(), A = new Map(), key = (x, y) => `${Math.floor(x / 2)},${Math.floor(y / 2)}`;
    for (let i = 0; i < d.sounding.length; i += 3) {
      const x = d.sounding[i] / 100, y = d.sounding[i + 1] / 100, k = key(x, y);
      if (!S.has(k)) S.set(k, []);
      S.get(k).push([x, y, d.sounding[i + 2] / 10]);
    }
    d.depth.forEach((a, n) => {
      const r = a.r[0];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
      a.bb = [x0 / 100, x1 / 100, y0 / 100, y1 / 100];
      for (let cx = Math.floor(a.bb[0] / 2); cx <= Math.floor(a.bb[1] / 2); cx++) for (let cy = Math.floor(a.bb[2] / 2); cy <= Math.floor(a.bb[3] / 2); cy++) {
        const k = `${cx},${cy}`;
        if (!A.has(k)) A.set(k, []);
        A.get(k).push(n);
      }
    });
    this.idx = { S, A, key };
  }

  // Depth at a point: the finest depth area containing it, and the nearest sounding (within 1 km).
  probe(x, y) {
    if (!this.data || !this.idx) return null;
    const { S, A, key } = this.idx;
    const inRing = (r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const xi = r[i] / 100, yi = r[i + 1] / 100, xj = r[j] / 100, yj = r[j + 1] / 100; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    let area = null;
    for (const n of A.get(key(x, y)) || []) {
      const a = this.data.depth[n];
      if (x < a.bb[0] || x > a.bb[1] || y < a.bb[2] || y > a.bb[3]) continue;
      if (inRing(a.r[0]) && !a.r.slice(1).some(inRing)) area = a;          // later = finer: keep the last
    }
    let best = null;
    for (let cx = -1; cx <= 1; cx++) for (let cy = -1; cy <= 1; cy++) {
      for (const s of S.get(`${Math.floor(x / 2) + cx},${Math.floor(y / 2) + cy}`) || []) {
        const dd = Math.hypot(s[0] - x, s[1] - y);
        if (dd < 1 && (!best || dd < best.d)) best = { d: dd, z: s[2] };
      }
    }
    return area || best ? { d1: area?.d1, d2: area?.d2, sounding: best?.z, soundingKm: best?.d } : null;
  }

  // Sounding numbers near the view's centre when close in (kmPerPx small).
  soundingLabels(view, label, fmtDepth) {
    this.labels.clear();
    if (!this.data || !this.idx || view.kmPerPx > 0.06) return 0;
    const { S } = this.idx, c = view.center, span = view.kmPerPx * 500, gap = view.kmPerPx * 45, placed = [];
    const cand = [];
    for (let cx = Math.floor((c.x - span) / 2); cx <= Math.floor((c.x + span) / 2); cx++) for (let cy = Math.floor((c.y - span) / 2); cy <= Math.floor((c.y + span) / 2); cy++) {
      for (const s of S.get(`${cx},${cy}`) || []) if (Math.abs(s[0] - c.x) < span && Math.abs(s[1] - c.y) < span) cand.push(s);
    }
    cand.sort((a, b) => Math.hypot(a[0] - c.x, a[1] - c.y) - Math.hypot(b[0] - c.x, b[1] - c.y));
    for (const s of cand) {
      if (placed.length >= 160) break;
      if (placed.some((p) => Math.abs(p[0] - s[0]) < gap && Math.abs(p[1] - s[1]) < gap * 0.6)) continue;
      placed.push(s);
      this.labels.add(label(fmtDepth(s[2]), "sounding", new THREE.Vector3(s[0], s[1], Z + 0.02)));
    }
    return placed.length;
  }
}
