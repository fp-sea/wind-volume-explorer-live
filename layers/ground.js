// Ground: land and water as two separate surfaces, each with its own controls.
//
//   Land   terrain mesh from the DEM, land cells only (GSHHS mask). Styles as radar-explorer's
//          Ground block: shaded relief (hypsometric tint, lit), satellite photo (draped), or plain
//          dark. Relief exaggeration: 1×, 1.5×, 2×, 3×, or "match" (the vertical exaggeration,
//          the default, so model levels and terrain stay in step).
//   Water  a flat surface at sea level with its own style (plain sea, satellite photo, plain
//          dark). The marine chart (chart.js) sits on it and belongs to the water controls.
//
// Data: pipeline/ground → web/data/<region>/ground.json, terrain.i16.gz, land.u8.gz, photo.jpg.
// Grid layout is radar-explorer's (int16 m, [ny][nx], row 0 south, x fastest); mesh building
// and the tint are adapted from its web/terrain.js@fdbb733.

import * as THREE from "three";

export async function gunzipTyped(url, Type) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  let buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  return new Type(buf);
}

// SYNC: radar-explorer web/terrain.js@fdbb733 hypsometric tint. Copied verbatim.
// Hypsometric tint: low green, mid tan, high grey, snow above ~2.2 km.
const TINT = [[0, [52, 84, 58]], [300, [74, 104, 66]], [800, [112, 118, 78]], [1400, [128, 112, 92]],
  [2000, [140, 136, 132]], [2400, [220, 224, 230]]];
function tint(m) {
  if (m <= TINT[0][0]) return TINT[0][1];
  for (let i = 1; i < TINT.length; i++) {
    if (m <= TINT[i][0]) {
      const [a, ca] = TINT[i - 1], [b, cb] = TINT[i], w = (m - a) / (b - a);
      return ca.map((c, k) => c + (cb[k] - c) * w);
    }
  }
  return TINT[TINT.length - 1][1];
}
// END SYNC

const WATER_COLORS = { sea: 0x0b3f4a, dark: 0x0d1418 };
const LAND_DARK = [34, 40, 40];

export class Ground {
  constructor() {
    this.group = new THREE.Group();
    this.land = null; this.water = null;
    this.meta = null; this.h = null; this.mask = null; this.coast = null; this.photo = null;
  }

  async load(regionId) {
    this.dispose();
    this.meta = this.h = this.mask = this.coast = this.photo = null;
    const r = await fetch(`data/${regionId}/ground.json`, { cache: "no-cache" });
    if (!r.ok) return false;                               // not built: the page keeps its flat outline
    this.meta = await r.json();
    this.region = regionId;
    const t = this.meta.terrain;
    if (!t) return false;
    [this.h, this.mask, this.coast] = await Promise.all([gunzipTyped(`data/${regionId}/${t.file}`, Int16Array), gunzipTyped(`data/${regionId}/${t.mask}`, Uint8Array),
      t.coast ? gunzipTyped(`data/${regionId}/${t.coast}`, Int16Array) : Promise.resolve(null)]);
    return true;
  }

  get ready() { return !!this.h; }

  async photoTexture() {
    if (this.photo || !this.meta?.photo) return this.photo;
    const tex = await new THREE.TextureLoader().loadAsync(`data/${this.region}/${this.meta.photo.file}`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.photo = tex;
    return tex;
  }

  // Ground height (km, true scale) at scene (x, y); 0 on water and outside the grid.
  heightKm(x, y) {
    if (!this.h) return 0;
    const t = this.meta.terrain, fx = (x - t.x0) / t.dxy, fy = (y - t.y0) / t.dxy;
    if (fx < 0 || fy < 0 || fx > t.nx - 1 || fy > t.ny - 1) return 0;
    const i = Math.min(t.nx - 2, Math.floor(fx)), j = Math.min(t.ny - 2, Math.floor(fy)), u = fx - i, v = fy - j;
    const at = (a, b) => Math.max(0, this.h[b * t.nx + a]) / 1000;
    return (1 - u) * (1 - v) * at(i, j) + u * (1 - v) * at(i + 1, j) + (1 - u) * v * at(i, j + 1) + u * v * at(i + 1, j + 1);
  }

  isLand(x, y) {
    if (!this.mask) return false;
    const t = this.meta.terrain, i = Math.round((x - t.x0) / t.dxy), j = Math.round((y - t.y0) / t.dxy);
    return i >= 0 && j >= 0 && i < t.nx && j < t.ny && this.mask[j * t.nx + i] === 1;
  }

  // On the water, inside the grid (outside it: unknown, so false). "Over water only" uses this.
  isWater(x, y) {
    if (!this.mask) return false;
    const t = this.meta.terrain, i = Math.round((x - t.x0) / t.dxy), j = Math.round((y - t.y0) / t.dxy);
    return i >= 0 && j >= 0 && i < t.nx && j < t.ny && this.mask[j * t.nx + i] !== 1;
  }

  dispose() {
    for (const k of ["land", "water"]) {
      const m = this[k];
      if (!m) continue;
      this.group.remove(m); m.geometry.dispose(); m.material.dispose(); this[k] = null;
    }
  }

  // land: {on, style: "relief"|"photo"|"dark", relief (× applied to heights; 0.001 = flat)}
  async buildLand({ on, style, relief }) {
    if (this.land) { this.group.remove(this.land); this.land.geometry.dispose(); this.land.material.dispose(); this.land = null; }
    if (!this.h) return;
    const t = this.meta.terrain, { nx, ny, x0, y0, dxy } = t;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), col = new Float32Array(nx * ny * 3);
    const W = (nx - 1) * dxy, H = (ny - 1) * dxy;
    // Smooth coastline: nodes near the coast get a height tied to their signed distance from it
    // (+ land, − water), so the mesh crosses sea level (the water surface) on the real
    // coastline rather than along the 500 m grid. Water nodes sit just below the water surface.
    const S = 0.01;                                    // km of height per km of distance, near the coast only
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, m = Math.max(0, this.h[k]);
      const sd = this.coast ? this.coast[k] / 100 : (this.mask[k] ? 1 : -1);
      const zLand = on ? m / 1000 * relief : 0.001;
      pos[3 * k] = x0 + i * dxy; pos[3 * k + 1] = y0 + j * dxy; pos[3 * k + 2] = sd > 0 ? Math.max(zLand, sd * S) : sd * S;
      uv[2 * k] = (i * dxy) / W; uv[2 * k + 1] = (j * dxy) / H;
      const c = style === "dark" ? LAND_DARK : tint(m);
      col[3 * k] = c[0] / 255; col[3 * k + 1] = c[1] / 255; col[3 * k + 2] = c[2] / 255;
    }
    // Quads touching land only: the land/water split. Water is its own surface.
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      const near = (q) => this.mask[q] || (this.coast && this.coast[q] > -dxy * 150);   // land, or water within 1.5 cells
      if (!(near(a) || near(b) || near(c) || near(d))) continue;
      idx.push(a, b, d, a, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = style === "photo" ? await this.photoTexture() : null;
    const mat = tex ? new THREE.MeshLambertMaterial({ map: tex }) : new THREE.MeshLambertMaterial({ vertexColors: true });
    this.land = new THREE.Mesh(geo, mat);
    this.land.renderOrder = 1;
    this.group.add(this.land);
  }

  // water: {on, style: "sea"|"photo"|"dark"}
  async buildWater({ on, style }) {
    if (this.water) { this.group.remove(this.water); this.water.geometry.dispose(); this.water.material.dispose(); this.water = null; }
    if (!this.h || !on) return;
    const t = this.meta.terrain, W = (t.nx - 1) * t.dxy, H = (t.ny - 1) * t.dxy;
    const tex = style === "photo" ? await this.photoTexture() : null;
    const mat = tex
      ? new THREE.MeshBasicMaterial({ map: tex })
      : new THREE.MeshBasicMaterial({ color: WATER_COLORS[style] ?? WATER_COLORS.sea });
    Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });   // behind the coast's land quads
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    this.water.position.set(t.x0 + W / 2, t.y0 + H / 2, 0);
    this.water.renderOrder = 0;
    this.group.add(this.water);
  }

  credits() {
    const m = this.meta || {};
    return [m.terrain?.credit, m.photo?.credit].filter(Boolean);
  }
}
