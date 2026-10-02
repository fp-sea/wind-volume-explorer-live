// SSCOFS surface currents (NOAA's Salish Sea operational forecast model, FVCOM), from the shared
// Salish Sea currents data (fp-sea/salish-currents on GitHub Pages, published once a day (the morning run) by the
// iMac job in salish-sea-flow-explorer: pipeline/runner.py): a current field the planner, the map
// and the viewer can use like the stations' (sample(x, y, t) → {u, v} m/s), from the model's mesh
// (down to tens of metres in the channels) rather than a blend between stations.
//
// Data contract (sscofs/latest.json; salish-sea-flow-explorer pipeline/sscofs.py docstring):
//   mesh-<hash>/nodes.f32.gz   float32 [lon, lat] per node     mesh-<hash>/nv.u32.gz  3 node indices per element
//   <cycle>/t1-fNNN.bin.gz     int16 zeta[N] cm, then int8 us[E], vs[E], ua[E], va[E] (0.1 kt; surface
//                              us/vs used here), then the overflow list: uint32 n, uint32 idx[n], int16 val[n]
//   <cycle>/skill.json         (latest.json "skill", optional) this run against NOAA's current predictions at
//                              each station: {stations: [{id, name, lat, lon, ratio, flag: "under"|"over"|null, noaaMax, modelMax}]}
//                              (salish-sea-flow-explorer pipeline/skill.py). Where flag is set — the model is far off
//                              NOAA, e.g. ~⅓ of the predicted ebb in Deception Pass narrows, too narrow for its mesh —
//                              MixedField uses NOAA's predictions within WEAK_KM of the station instead.
// Replaces this project's own wve-currents job (2026-10-02, owner): one runner feeds both sites.
// status.json beside sscofs/ says when the runner last succeeded (sscofsStatus()).
//
// Each 200 m water cell of the planner's grid takes its nearest mesh element (within 1.5 km); the
// hours are loaded as needed (~330 kB each) and blended in time.

const ROOT = "https://fp-sea.github.io/salish-currents/";
const BASE = `${ROOT}sscofs/`;
const KN = 0.0514444;                                   // 0.1 kt → m/s
const WEAK_KM = 1.2;                                    // around a station where the run is far off NOAA: NOAA's predictions
let META = null;

async function gunzip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SSCOFS: ${r.status} for ${url.split("/").pop()}`);
  let buf = await r.arrayBuffer();
  const h = new Uint8Array(buf, 0, 2);
  if (h[0] === 0x1f && h[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return buf;
}

// The newest published run (checked again after 30 minutes). → {cycle (Date), leads, t0, t1, ...} or null
export async function sscofsLatest() {
  if (META && Date.now() - META.checked < 30 * 60e3) return META.m;
  try {
    const m = await fetch(`${BASE}latest.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null));
    // (the data's "t1" is the tier-1 file block; this project uses t0/t1 for the run's time span)
    if (m) { m.hourFiles = m.t1; m.cycleDate = new Date(m.cycle); m.t0 = m.cycleDate.getTime() + m.leads[0] * 3600e3; m.t1 = m.cycleDate.getTime() + m.leads.at(-1) * 3600e3; }
    META = { m, checked: Date.now() };
    return m;
  } catch { META = { m: null, checked: Date.now() }; return null; }
}

// The data runner's status (status.json): {surface: {cycle}, lastAttempt, lastSuccess, failuresInARow, staleHours} or null.
export async function sscofsStatus() {
  try { const r = await fetch(`${ROOT}status.json`, { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; }
}

// The field over the planner's water grid `land` (explore.routeGrid()), projection `proj`.
export class SscofsField {
  static async open(land, proj, { onProgress } = {}) {
    const m = await sscofsLatest();
    if (!m) return null;
    const f = new SscofsField(m, land);
    await f.index(proj, onProgress);
    await f.loadSkill(proj);
    return f;
  }
  constructor(meta, land) {
    Object.assign(this, { meta, land, frames: new Map(), loading: new Map() });
    this.label = `SSCOFS ${String(meta.cycleDate.getUTCHours()).padStart(2, "0")}Z ${meta.cycle.slice(5, 10)}`;
    this.stations = [];                                   // (the report's station list stays the stations')
  }
  // Each water cell's nearest element: elements bucketed by 1 km, 3×3 buckets searched.
  async index(proj, onProgress) {
    const m = this.meta, L = this.land, n = m.elements;
    const [nb, vb] = await Promise.all([gunzip(`${BASE}${m.mesh}/nodes.f32.gz`), gunzip(`${BASE}${m.mesh}/nv.u32.gz`)]);
    const nodes = new Float32Array(nb), nv = new Uint32Array(vb);
    onProgress?.("Placing the SSCOFS mesh on the water…");
    const ex = new Float32Array(n), ey = new Float32Array(n);
    for (let k = 0; k < n; k++) {                         // element centre = mean of its three nodes
      const a = nv[3 * k], b = nv[3 * k + 1], c = nv[3 * k + 2];
      const p = proj.toXY((nodes[2 * a + 1] + nodes[2 * b + 1] + nodes[2 * c + 1]) / 3, (nodes[2 * a] + nodes[2 * b] + nodes[2 * c]) / 3);
      ex[k] = p.x; ey[k] = p.y;
    }
    const B = 1.0, bx0 = L.x0, by0 = L.y0, bnx = Math.ceil((L.nx * L.dxy) / B) + 1, bny = Math.ceil((L.ny * L.dxy) / B) + 1;
    const head = new Int32Array(bnx * bny).fill(-1), next = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) { const i = Math.floor((ex[k] - bx0) / B), j = Math.floor((ey[k] - by0) / B); if (i < 0 || j < 0 || i >= bnx || j >= bny) continue; const b = j * bnx + i; next[k] = head[b]; head[b] = k; }
    const N = L.nx * L.ny, idx = new Int32Array(N).fill(-1), R2 = 1.5 * 1.5;
    for (let c = 0; c < N; c++) {
      if (L.mask[c] === 1) continue;
      const i = c % L.nx, j = (c - i) / L.nx, x = L.x0 + i * L.dxy, y = L.y0 + j * L.dxy, bi = Math.floor((x - bx0) / B), bj = Math.floor((y - by0) / B);
      let best = -1, bd = R2;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = bi + di, b = bj + dj; if (a < 0 || b < 0 || a >= bnx || b >= bny) continue;
        for (let k = head[b * bnx + a]; k >= 0; k = next[k]) { const d = (ex[k] - x) ** 2 + (ey[k] - y) ** 2; if (d < bd) { bd = d; best = k; } }
      }
      idx[c] = best;
      if ((c & 0x3ffff) === 0) await new Promise((r) => setTimeout(r, 0));   // (the page breathes)
    }
    this.idx = idx;
  }
  covers(t) { return t >= this.meta.t0 && t <= this.meta.t1; }
  // The run's skill against NOAA (optional): the flagged stations, placed on the scene.
  async loadSkill(proj) {
    this.weak = [];
    if (!this.meta.skill) return;
    try {
      const sk = await fetch(`${BASE}${this.meta.skill}`).then((r) => (r.ok ? r.json() : null));
      for (const s of sk?.stations || []) if (s.flag) { const p = proj.toXY(s.lat, s.lon); this.weak.push({ ...s, x: p.x, y: p.y }); }
    } catch { /* no skill: SSCOFS everywhere */ }
  }
  // The flagged station within WEAK_KM of scene (x, y), or null.
  weakAt(x, y) { for (const s of this.weak || []) if (Math.hypot(s.x - x, s.y - y) <= WEAK_KM) return s; return null; }
  // Load the hours for tA..tB (a few at a time). → how many
  async prepare(tA, tB) {
    const m = this.meta, c = m.cycleDate.getTime(), leads = m.leads.filter((l) => c + l * 3600e3 >= tA - 3600e3 && c + l * 3600e3 <= tB + 3600e3);
    const need = leads.filter((l) => !this.frames.has(l));
    for (let i = 0; i < need.length; i += 6) await Promise.all(need.slice(i, i + 6).map((l) => this.frame(l)));
    return leads.length;
  }
  frame(l) {
    if (this.frames.has(l)) return Promise.resolve(this.frames.get(l));
    if (!this.loading.has(l)) this.loading.set(l, gunzip(`${BASE}${this.meta.hourFiles.file.replace("{lead:03d}", String(l).padStart(3, "0"))}`).then((buf) => {
      // Surface u, v (0.1 kt) after the int16 water levels; values past ±12.7 kt from the overflow list.
      const N = this.meta.nodes, n = this.meta.elements, off = 2 * N, q = new Int8Array(buf, off, 4 * n);
      const u = new Float32Array(n), v = new Float32Array(n);
      for (let k = 0; k < n; k++) { u[k] = q[k]; v[k] = q[n + k]; }
      const dv = new DataView(buf), base = off + 4 * n, cnt = dv.getUint32(base, true);
      for (let i = 0; i < cnt; i++) {
        const j = dv.getUint32(base + 4 + 4 * i, true), val = dv.getInt16(base + 4 + 4 * cnt + 2 * i, true);
        if (j < n) u[j] = val; else if (j < 2 * n) v[j - n] = val;
      }
      const f = { u, v };
      this.frames.set(l, f); this.loading.delete(l); return f;
    }));
    return this.loading.get(l);
  }
  // Current (u, v m/s) at scene (x, y), time t: null outside the model's area, hours or loaded frames.
  sample(x, y, t) {
    const L = this.land, i = Math.round((x - L.x0) / L.dxy), j = Math.round((y - L.y0) / L.dxy);
    if (i < 0 || j < 0 || i >= L.nx || j >= L.ny) return null;
    const e = this.idx[j * L.nx + i];
    if (e < 0) return null;
    const c = this.meta.cycleDate.getTime(), h = (t - c) / 3600e3, l0 = Math.floor(h), l1 = l0 + 1, a = this.frames.get(l0), b = this.frames.get(l1) || (h === l0 ? a : null);
    if (!a || !b) return null;
    const f = h - l0;
    return { u: (a.u[e] * (1 - f) + b.u[e] * f) * KN, v: (a.v[e] * (1 - f) + b.v[e] * f) * KN, reach: 1 };
  }
}

// SSCOFS where it has the time and place, the stations' field elsewhere (past its hours, outside
// its area) and round the stations where this run is far off NOAA's predictions (skill.json): the
// planner's current field when SSCOFS is chosen. usedNoaa: the flagged stations a sample fell back on.
export class MixedField {
  constructor(sscofs, stations) { Object.assign(this, { sscofs, fallback: stations, stations: stations?.stations || [], label: sscofs.label, usedNoaa: new Set() }); }
  prepare(tA, tB, step) { this.fallback?.prepare?.(tA, tB, step); }
  sample(x, y, t) {
    if (this.sscofs.covers(t)) {
      const w = this.sscofs.weakAt(x, y), n = w && this.fallback?.sample(x, y, t);
      if (n) { this.usedNoaa.add(w.name); return n; }
      const s = this.sscofs.sample(x, y, t); if (s) return s;
    }
    return this.fallback?.sample(x, y, t) || null;
  }
  // "…; NOAA's predictions at Deception Pass (Narrows), … (SSCOFS far off there)" for labels.
  weakNote() { const w = [...(this.sscofs.weak || [])].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio))); return w.length ? `; NOAA's predictions round ${w.length} station${w.length > 1 ? "s" : ""} where this run is far off them (${w.slice(0, 4).map((s) => s.name.split(",")[0]).join(", ")}${w.length > 4 ? ", …" : ""})` : ""; }
}
