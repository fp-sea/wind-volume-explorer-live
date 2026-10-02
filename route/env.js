// The routing environment from what the explorer has loaded: the 10 m wind and gust for every
// hour of the run (route/windhours.js), the tidal current predictions, the chop (fetch, wind over
// the moving water, the current's effect on it), the swell, and the land (the 0.5 km terrain
// mask, with a distance-to-shore map for the clearance). Everything in scene km, times in ms.
// See router.js for the interface.

import { chopAt } from "../model/waves.js?v=20261002173952";
import { stationCurrent, chopOnCurrent } from "../model/currents.js?v=20261002173952";
import { swellHs2At } from "../model/gfswave.js?v=20261002173952";

// Distance to land (km) for every cell of a land mask (1 = land), by a two-pass chamfer transform.
export function shoreDistance(mask, nx, ny, dxy) {
  const D = new Float32Array(nx * ny), BIG = 1e9, a = dxy, b = dxy * Math.SQRT2;
  for (let k = 0; k < D.length; k++) D[k] = mask[k] === 1 ? 0 : BIG;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let d = D[k];
    if (i > 0) d = Math.min(d, D[k - 1] + a);
    if (j > 0) { d = Math.min(d, D[k - nx] + a); if (i > 0) d = Math.min(d, D[k - nx - 1] + b); if (i < nx - 1) d = Math.min(d, D[k - nx + 1] + b); }
    D[k] = d;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let d = D[k];
    if (i < nx - 1) d = Math.min(d, D[k + 1] + a);
    if (j < ny - 1) { d = Math.min(d, D[k + nx] + a); if (i < nx - 1) d = Math.min(d, D[k + nx + 1] + b); if (i > 0) d = Math.min(d, D[k + nx - 1] + b); }
    D[k] = d;
  }
  return D;
}

// Distance by water (km) from every cell of the land mask to a target point, going round the
// land (Dijkstra over the 8-neighbour grid). → Float32Array (Infinity where unreachable).
// ok(k): an optional extra test for a cell (the router's clearance), so the guide and the router
// agree on which passes are open. No squeezing diagonally between two land cells that touch at a
// corner.
// cost(k): optional, how many times its length a step into cell k counts (to prefer some water).
export function waterDistance(land, tx, ty, ok = null, cost = null) {
  const { mask, nx, ny, x0, y0, dxy } = land, N = nx * ny, D = new Float64Array(N).fill(Infinity);   // (64-bit: a float32 store rounds and the heap skips nodes)
  let ti = Math.round((tx - x0) / dxy), tj = Math.round((ty - y0) / dxy);
  if (ti < 0 || tj < 0 || ti >= nx || tj >= ny) return D;
  // (a target just on a land cell at this resolution: start from the nearest water cell)
  if (mask[tj * nx + ti] === 1) { let best = null; for (let r = 1; r < 15 && !best; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const i = ti + di, j = tj + dj; if (i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] !== 1 && !best) best = [i, j]; } if (best) [ti, tj] = best; }
  // A binary heap in typed arrays (millions of cells).
  let cap = 1 << 16, hk = new Float64Array(cap), hv = new Int32Array(cap), n = 0;
  const push = (d, k) => {
    if (n === cap) { cap *= 2; const a = new Float64Array(cap), b = new Int32Array(cap); a.set(hk); b.set(hv); hk = a; hv = b; }
    let i = n++; while (i) { const p = (i - 1) >> 1; if (hk[p] <= d) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = d; hv[i] = k;
  };
  const pop = () => {
    const k = hv[0], d = hk[--n], v = hv[n];
    let i = 0; for (;;) { const l = 2 * i + 1; if (l >= n) break; const r = l + 1, m = r < n && hk[r] < hk[l] ? r : l; if (hk[m] >= d) break; hk[i] = hk[m]; hv[i] = hv[m]; i = m; }
    hk[i] = d; hv[i] = v;
    return k;
  };
  const S2 = Math.SQRT2 * dxy;
  D[tj * nx + ti] = 0; push(0, tj * nx + ti);
  while (n) {
    const dk = hk[0], k = pop();
    if (dk > D[k]) continue;
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const q = b * nx + a;
      if (mask[q] === 1 || (ok && !ok(q))) continue;
      if (di && dj && (mask[j * nx + a] === 1 || mask[b * nx + i] === 1)) continue;   // (a corner gap: closed)
      const nd = dk + (di && dj ? S2 : dxy) * (cost ? cost(q) : 1);
      if (nd < D[q]) { D[q] = nd; push(nd, q); }
    }
  }
  return D;
}

// A current field from the stations, over a regular grid (the land mask's cells): each water
// cell takes the stations within R km that it can see across water (no land between), weighted
// by a smooth falloff; farther than R from every station it's blank. Built once per region and
// station list: weights per cell (up to 4 stations); the currents at a time are then cheap.
export class CurrentField {
  // (land: the planner's 200 m water mask, so narrow channels like Deception Pass and Agate Passage
  // get their stations' currents; weights and station numbers are kept in bytes to stay small.)
  constructor(stations, land, R = 5) {
    const { mask, nx, ny, x0, y0, dxy } = land, N = nx * ny, K = 4, S = stations.length;
    Object.assign(this, { stations, nx, ny, x0, y0, dxy, R });
    const none = S < 255 ? 255 : -1, idx = S < 255 ? new Uint8Array(N * K).fill(255) : new Int16Array(N * K).fill(-1);
    const bd = new Float32Array(N * K).fill(Infinity), wt = new Uint8Array(N * K), reach = new Uint8Array(N);
    const seesWater = (ax, ay, bx, by) => {                      // no land on the straight line
      const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / (dxy * 0.7)));
      for (let s = 1; s < n; s++) { const x = ax + ((bx - ax) * s) / n, y = ay + ((by - ay) * s) / n, i = Math.round((x - x0) / dxy), j = Math.round((y - y0) / dxy); if (i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] === 1) return false; }
      return true;
    };
    // Per station, the cells within R it can see across water; each cell keeps its K nearest.
    stations.forEach((s, si) => {
      const i0 = Math.max(0, Math.floor((s.x - R - x0) / dxy)), i1 = Math.min(nx - 1, Math.ceil((s.x + R - x0) / dxy));
      const j0 = Math.max(0, Math.floor((s.y - R - y0) / dxy)), j1 = Math.min(ny - 1, Math.ceil((s.y + R - y0) / dxy));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (mask[c] === 1) continue;
        const x = x0 + i * dxy, y = y0 + j * dxy, d = Math.hypot(x - s.x, y - s.y), o = c * K;
        if (d > R || d >= bd[o + K - 1] || !seesWater(s.x, s.y, x, y)) continue;
        let m = K - 1; while (m > 0 && bd[o + m - 1] > d) { bd[o + m] = bd[o + m - 1]; idx[o + m] = idx[o + m - 1]; m--; }
        bd[o + m] = d; idx[o + m] = si;
      }
    });
    for (let c = 0; c < N; c++) {
      const o = c * K;
      if (idx[o] === none) continue;
      let tot = 0; const w = [0, 0, 0, 0];
      for (let m = 0; m < K && idx[o + m] !== none; m++) { const d = bd[o + m]; w[m] = (1 - (d / R) ** 2) ** 2 / Math.max(0.3, d); tot += w[m]; }
      for (let m = 0; m < K; m++) wt[o + m] = Math.round((w[m] / (tot || 1)) * 255);
      reach[c] = Math.round((1 - Math.min(1, bd[o] / R)) * 255);   // 1 at a station, 0 at R: for fading the display
    }
    Object.assign(this, { K, idx, wt, reach, none });
    this.tKey = null;
  }
  // Every station's current on a time grid from tA to tB (ms, every stepMs), for long runs of
  // samples (routing, departure sweeps): then at(t) interpolates in time instead of walking the
  // predictions each time.
  prepare(tA, tB, stepMs = 600e3) {
    if (this.pre && this.pre.tA <= tA && this.pre.tB >= tB && this.pre.step === stepMs) return;
    const n = Math.ceil((tB - tA) / stepMs) + 1, S = this.stations.length, U = new Float32Array(n * S), V = new Float32Array(n * S);
    this.stations.forEach((st, k) => { for (let i = 0; i < n; i++) { const c = stationCurrent(st, tA + i * stepMs); U[i * S + k] = c.u; V[i * S + k] = c.v; } });
    this.pre = { tA, tB: tA + (n - 1) * stepMs, step: stepMs, n, U, V };
    this.tKey = null;
  }
  // The stations' currents at time t: [{u, v}] (cached for the last time asked).
  at(t) {
    if (this.tKey === t) return this.su;
    this.tKey = t;
    const P = this.pre, S = this.stations.length;
    if (P && t >= P.tA && t <= P.tB) {
      const f = (t - P.tA) / P.step, i = Math.min(P.n - 2, Math.floor(f)), a = f - i;
      this.su = this.stations.map((_, k) => ({ u: P.U[i * S + k] * (1 - a) + P.U[(i + 1) * S + k] * a, v: P.V[i * S + k] * (1 - a) + P.V[(i + 1) * S + k] * a }));
    } else this.su = this.stations.map((st) => stationCurrent(st, t));
    return this.su;
  }
  // Current (u, v m/s) at scene (x, y), time t, or null outside every station's reach.
  sample(x, y, t) {
    const i = Math.round((x - this.x0) / this.dxy), j = Math.round((y - this.y0) / this.dxy);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    const c = j * this.nx + i, K = this.K, none = this.none;
    if (this.idx[c * K] === none) return null;
    let u = 0, v = 0;
    const P = this.pre;
    if (P && t >= P.tA && t <= P.tB) {                             // straight from the time grid: only the stations used here
      const f = (t - P.tA) / P.step, i = Math.min(P.n - 2, Math.floor(f)), a = f - i, S = this.stations.length;
      for (let m = 0; m < K; m++) { const s = this.idx[c * K + m]; if (s === none) break; const w = this.wt[c * K + m] / 255;
        u += (P.U[i * S + s] * (1 - a) + P.U[(i + 1) * S + s] * a) * w; v += (P.V[i * S + s] * (1 - a) + P.V[(i + 1) * S + s] * a) * w; }
    } else {
      const su = this.at(t);
      for (let m = 0; m < K; m++) { const s = this.idx[c * K + m]; if (s === none) break; const w = this.wt[c * K + m] / 255; u += su[s].u * w; v += su[s].v * w; }
    }
    return { u, v, reach: this.reach[c] / 255 };
  }
}

// env for router.js. ex: the explorer; wind: route/windhours.js result; field: CurrentField or
// null; opts: {currents, windless}.
// The local half-width of the water (km): the greatest distance to land within `r` cells, a
// separable max filter over the distance-to-shore map. In a channel it's about half its width;
// in open water, large. (For clearance that narrows sensibly in narrow passes.)
export function localHalfWidth(dist, nx, ny, r = 3) {
  const A = new Float32Array(nx * ny), B = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let m = 0; for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) m = Math.max(m, dist[j * nx + k]); A[j * nx + i] = m; }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { let m = 0; for (let k = Math.max(0, j - r); k <= Math.min(ny - 1, j + r); k++) m = Math.max(m, A[k * nx + i]); B[j * nx + i] = m; }
  return B;
}

// opts.land: the fine routing water mask (explore.routeGrid(), 200 m) for water, clearance and the
// guide; the 500 m land grid otherwise. The wind and swell lookups stay on the 500 m grid.
// A wind source from route/windhours.js's hours (forecast hours of `cycle`) → absolute times.
export function hiresSource(w, cycle, label, id = "hires") {
  if (!w) return null;
  const c = cycle.getTime(), frames = new Map();
  for (const [h, f] of w.frames) frames.set(c + h * 3600e3, f);
  const times = [...frames.keys()].sort((a, b) => a - b);
  return { id, label, cycle, grid: w.grid, box: w.box, times, frames, bytes: w.bytes, res: w.res || "" };
}

// wind: a list of wind sources in priority order ({label, cycle, grid, box, times [ms], frames
// Map(ms → {U, V, G})}), or one (or route/windhours.js's result, taken as the loaded run). At a
// time t the first source covering t is used; in the last 3 hours of a source's span, where the
// next one covers t too, the two are blended linearly (a smooth hand-over). Each condition says
// where its wind came from (c.src).
export function makeEnv(ex, wind, field, opts = {}) {
  const coarse = ex.landGrid(), land = opts.land || coarse, dist = land.dist, F = ex.fetchGrid, proj = ex.proj, sh = ex.swellHour;
  const cycle = ex.cycle?.getTime();
  const sources = !wind ? [] : Array.isArray(wind) ? wind.filter(Boolean) : [wind.times ? wind : hiresSource(wind, ex.cycle, `${ex.model?.short || "model"} ${String(ex.cycle.getUTCHours()).padStart(2, "0")}Z`)];
  const cellOf = (G) => (x, y) => { const i = Math.round((x - G.x0) / G.dxy), j = Math.round((y - G.y0) / G.dxy); return i >= 0 && j >= 0 && i < G.nx && j < G.ny ? j * G.nx + i : -1; };
  const coarseCell = cellOf(coarse), cell = cellOf(land);
  // Per source: scene (x, y) → its grid's (i, j), cached per 500 m cell (the wind is smooth on that
  // scale), worked out at the cell's centre so the answer doesn't depend on which point asked
  // first; the caches belong to this environment (sources are shared between environments).
  const IJ = new Map(sources.map((S) => [S, [new Float32Array(coarse.nx * coarse.ny).fill(NaN), new Float32Array(coarse.nx * coarse.ny).fill(NaN)]]));
  const gridIJ = (S, x, y) => {
    const c = coarseCell(x, y);
    if (c < 0) return null;
    const [gi, gj] = IJ.get(S);
    if (Number.isNaN(gi[c])) { const ci = c % coarse.nx, cj = (c - ci) / coarse.nx, ll = proj.toLatLon(coarse.x0 + ci * coarse.dxy, coarse.y0 + cj * coarse.dxy), q = S.grid.ij(ll.lat, ll.lon); gi[c] = q.i - S.box.i0; gj[c] = q.j - S.box.j0; }
    return [gi[c], gj[c]];
  };
  const bil = (S, A, i, j) => {
    const { w, h } = S.box;
    if (!A || i < 0 || j < 0 || i > w - 1 || j > h - 1) return NaN;
    const i0 = Math.min(w - 2, Math.floor(i)), j0 = Math.min(h - 2, Math.floor(j)), a = i - i0, b = j - j0, c = j0 * w + i0;
    return A[c] * (1 - a) * (1 - b) + A[c + 1] * a * (1 - b) + A[c + w] * (1 - a) * b + A[c + w + 1] * a * b;
  };
  // One source's wind at (x, y, t), interpolated in space and time; null outside its span or area.
  const fromSource = (S, x, y, t) => {
    const T = S.times;
    if (!T.length || t < T[0] || t > T.at(-1) + 1) return null;
    const q = gridIJ(S, x, y);
    if (!q) return null;
    let k = T.findIndex((v) => v > t); if (k < 0) k = T.length - 1; if (k === 0) k = 1;
    const A = S.frames.get(T[k - 1]), B = S.frames.get(T[k]), s = Math.min(1, Math.max(0, (t - T[k - 1]) / (T[k] - T[k - 1])));
    const lerp = (P, Q) => { const p = bil(S, P, q[0], q[1]), r = bil(S, Q, q[0], q[1]); return p + (r - p) * s; };
    const u = lerp(A.U, B.U), v = lerp(A.V, B.V), g = A.G && B.G ? lerp(A.G, B.G) : NaN;
    return Number.isFinite(u) && Number.isFinite(v) ? { u, v, g: Number.isFinite(g) ? Math.max(g, Math.hypot(u, v)) : Math.hypot(u, v) * 1.3 } : null;
  };
  const BLEND = 3 * 3600e3;
  const windAt = (x, y, t) => {
    for (let k = 0; k < sources.length; k++) {
      const S = sources[k], a = fromSource(S, x, y, t);
      if (!a) continue;
      const end = S.times.at(-1), N = sources.slice(k + 1).find((Q) => Q.times.length && Q.times[0] <= t && Q.times.at(-1) >= t);
      if (N && t > end - BLEND) {
        const b = fromSource(N, x, y, t);
        if (b) { const w = (t - (end - BLEND)) / BLEND; return { u: a.u + (b.u - a.u) * w, v: a.v + (b.v - a.v) * w, g: a.g + (b.g - a.g) * w, src: `${S.label} → ${N.label}` }; }
      }
      return { ...a, src: S.label };
    }
    return null;
  };
  const swellCache = new Map();
  const swell2 = (x, y) => {
    if (!sh) return 0;
    const c = coarseCell(x, y);
    if (!swellCache.has(c)) { const ll = proj.toLatLon(x, y); swellCache.set(c, swellHs2At(sh, ll.lat, ll.lon) || 0); }
    return swellCache.get(c);
  };
  const current = (x, y, t) => (field && opts.currents !== false ? field.sample(x, y, t) : null);
  return {
    tMax: opts.windless ? Infinity : Math.max(...sources.map((S) => S.times.at(-1) ?? 0), 0),
    sources,
    water: (x, y) => { const c = cell(x, y); return c >= 0 && land.mask[c] !== 1; },
    clear: (x, y) => { const c = cell(x, y); return c >= 0 ? dist[c] : 0; },
    // Clear enough of the shore? (Where a clearance would close the natural way through narrow
    // passes, router.legClearance eases it for that leg and says so.)
    clearOk(x, y, clearKm) { const c = cell(x, y); return c >= 0 && dist[c] >= clearKm; },
    current,
    // Distance by water to a target (km), for guiding the search (cached per target).
    // Where the boat may be: water, clear enough of the shore (narrowing in passes), or anywhere on
    // the water near a waypoint (harbours). One byte per fine cell, built once per clearance and
    // waypoint set: the router's move checks and the guide both read it.
    passMask(clearKm = 0, wps = [], ease = null) {
      if (ease) return this._ease.get(ease.key);                    // (a leg's locally eased mask: easeFor)
      const key = `${clearKm}|${wps.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join(";")}`;
      this._pass ||= new Map();
      if (this._pass.has(key)) return this._pass.get(key);
      const m = new Uint8Array(land.nx * land.ny), R = clearKm + 1.5;
      for (let k = 0; k < m.length; k++) m[k] = land.mask[k] !== 1 && (clearKm <= 0 || dist[k] >= clearKm) ? 1 : 0;
      if (clearKm > 0) for (const w of wps) {                         // near each waypoint: all water
        const i0 = Math.round((w.x - land.x0) / land.dxy), j0 = Math.round((w.y - land.y0) / land.dxy), r = Math.ceil(R / land.dxy);
        for (let j = Math.max(0, j0 - r); j <= Math.min(land.ny - 1, j0 + r); j++) for (let i = Math.max(0, i0 - r); i <= Math.min(land.nx - 1, i0 + r); i++) {
          const k = j * land.nx + i; if (land.mask[k] !== 1 && (i - i0) ** 2 + (j - j0) ** 2 <= r * r) m[k] = 1;
        }
      }
      this._pass.set(key, m); if (this._pass.size > 6) this._pass.delete(this._pass.keys().next().value);
      return m;
    },
    // Where a leg has to go closer to land than clearKm (a narrow pass or inlet), found as the way
    // by water at clearance c that keeps the full clearance wherever it can (a step closer than
    // clearKm counts 1.5 times its length, so it keeps clear unless that costs much), traced from a to b; its stretches inside clearKm, away
    // from the waypoints, are the narrow places. The eased mask is the full one plus the water at
    // least c from land within 1.5 km of those stretches: the clearance holds everywhere else.
    // → {c, key, spots: [{x, y}] (the middle of each narrow stretch)} for passMask/toGo, or null.
    easeFor(a, b, clearKm, c, wps = []) {
      const full = this.passMask(clearKm, wps), low = this.passMask(c, wps), { nx, ny } = land;
      const D = waterDistance(land, b.x, b.y, (k) => low[k] === 1, (k) => (full[k] ? 1 : this.easePenalty ?? 1.5));
      let k = cell(a.x, a.y);
      if (k < 0 || !Number.isFinite(D[k])) return null;
      const path = [k];
      for (let n = 0; n < nx * ny && D[k] > 0; n++) {                // steepest descent to b
        const i = k % nx, j = (k - i) / nx; let best = k;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a2 = i + di, b2 = j + dj; if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= ny) continue; const q = b2 * nx + a2; if (D[q] < D[best]) best = q; }
        if (best === k) break;
        path.push((k = best));
      }
      const choke = path.map((q, n) => [q, n]).filter(([q]) => !full[q]);
      if (!choke.length) return null;
      const r = Math.ceil(1.5 / land.dxy), m = Uint8Array.from(full), spots = [];
      for (const [q] of choke) {
        const i0 = q % nx, j0 = (q - i0) / nx;
        for (let j = Math.max(0, j0 - r); j <= Math.min(ny - 1, j0 + r); j++) for (let i = Math.max(0, i0 - r); i <= Math.min(nx - 1, i0 + r); i++) { const k2 = j * nx + i; if (low[k2] && (i - i0) ** 2 + (j - j0) ** 2 <= r * r) m[k2] = 1; }
      }
      // (the narrow stretches: runs along the path, split where they're more than 2 km apart)
      let run = [choke[0]];
      const flush = () => { const [q] = run[Math.floor(run.length / 2)], i = q % nx, j = (q - i) / nx; spots.push({ x: land.x0 + i * land.dxy, y: land.y0 + j * land.dxy }); };
      for (let n = 1; n < choke.length; n++) { if ((choke[n][1] - choke[n - 1][1]) * land.dxy > 2) { flush(); run = []; } run.push(choke[n]); }
      flush();
      const key = `ease|${clearKm}|${c}|${a.x.toFixed(2)},${a.y.toFixed(2)}|${b.x.toFixed(2)},${b.y.toFixed(2)}|${wps.length}`;
      this._ease ||= new Map(); this._ease.set(key, m); if (this._ease.size > 12) this._ease.delete(this._ease.keys().next().value);
      return { c, key, spots };
    },
    passable(x, y, m) { const c = cell(x, y); return c >= 0 && m[c] === 1; },
    // The guide: distance by water within the passable cells, so it never leads into a pass the
    // router can't use.
    toGo(tx, ty, clearKm = 0, wps = [], ease = null) {
      const key = `${tx.toFixed(3)},${ty.toFixed(3)}|${clearKm}|${wps.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join(";")}|${ease?.key || ""}`;
      this._togo ||= new Map();
      const pm = this.passMask(clearKm, wps, ease), ok = (k) => pm[k] === 1;
      if (!this._togo.has(key)) this._togo.set(key, waterDistance(land, tx, ty, ok));
      const D = this._togo.get(key);
      return (x, y) => { const c = cell(x, y); return c < 0 ? Infinity : D[c]; };
    },
    // (noCur: as if there were no tidal current: no drift, and the chop not changed by it)
    cond(x, y, t, noCur = false) {
      const cur = noCur ? null : current(x, y, t), cu = cur?.u || 0, cv = cur?.v || 0;
      if (opts.windless) return { u: 0, v: 0, g: 0, cu, cv, hs: 0, tp: 0, from: 0, rating: 0, swell2: 0 };
      const w = windAt(x, y, t);
      if (!w) return null;
      const ch = F ? chopAt(F, x, y, w.u - cu, w.v - cv) : null;
      let hs = ch?.hs || 0, rating = 0;
      if (ch && hs > 0 && cur) { const ru = w.u - cu, rv = w.v - cv, rm = Math.hypot(ru, rv) || 1, r = chopOnCurrent(hs, ch.tp, ru / rm, rv / rm, cu, cv); hs = r.hs; rating = r.rating; }
      const k = cell(x, y), shore = k >= 0 ? dist[k] : null;                 // (for motoring in narrow channels)
      return { u: w.u, v: w.v, g: w.g, src: w.src, shore, cu, cv, hs, tp: ch?.tp || 0, from: ch?.fromDeg ?? ((Math.atan2(-w.u, -w.v) * 180) / Math.PI + 360) % 360, rating, swell2: swell2(x, y) };
    },
  };
}
