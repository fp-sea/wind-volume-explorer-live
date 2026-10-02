// 15-minute surface wind and gust (HRRR wrfsubhfFF, RRFS 2dfld…subh.fFFF): the model's own
// sub-hourly output for the first 18 hours.
//
// File FF holds the steps at (FF−1)h + 15, 30, 45 min and at FF h. The top of each hour comes
// from the hourly data (so hourly and 15-min views agree exactly on the hour); this store loads
// the :15, :30 and :45 steps. Only 10 m wind and surface gust: the 3D column stays hourly.
//
// The idx lists the same field several times (one per step), so messages are picked by step
// label ("75 min fcst") rather than by name:level alone.

import { coalesce } from "./fetch.js?v=20261002173952";
import { fileUrl, decodeCropped } from "./rrfs.js?v=20261002173952";
import { FetchFailed } from "./fetch.js?v=20261002173952";

const WANT = [["UGRD", "10 m above ground", "U"], ["VGRD", "10 m above ground", "V"], ["GUST", "surface", "G"]];

export class SubhStore {
  // ff: the file's forecast hour (1…18); box/geo: the hourly store's crop and grid (same grid).
  constructor(model, cycle, ff, box, geo) {
    Object.assign(this, { model, cycle, ff, box, geo });
    this.url = fileUrl(model, cycle, ff, { which: "pathSubh" });
    this.frames = new Map();     // minute → {U, V, G} (true east/north)
    this.bytes = 0;
    this.job = null;
  }
  minutes() { return [15, 30, 45].map((m) => (this.ff - 1) * 60 + m); }

  load({ signal } = {}) {
    if (this.job) return this.job;
    this.job = (async () => {
      const r = await fetch(this.url + ".idx", { signal }).catch((e) => { if (e.name === "AbortError") throw e; throw new FetchFailed("network failure: sub-hourly index", e); });
      if (!r.ok) throw new FetchFailed(`HTTP ${r.status}: sub-hourly f${this.ff} not posted`);
      const rows = (await r.text()).trim().split("\n").map((l) => l.split(":"));
      const entries = rows.map((c, i) => ({ start: +c[1], end: i + 1 < rows.length ? +rows[i + 1][1] : null, name: c[3], level: c[4], step: c[5] }));
      const want = [];
      for (const min of this.minutes()) for (const [name, level, tag] of WANT) {
        const e = entries.find((x) => x.name === name && x.level === level && x.step === `${min} min fcst`);
        if (e) want.push({ ...e, key: `${tag}:${min}`, min, tag });
      }
      const got = new Map();
      await Promise.all(coalesce(want).map(async (rg) => {
        const res = await fetch(this.url, { signal, headers: { Range: `bytes=${rg.start}-${rg.end == null ? "" : rg.end - 1}` } });
        if (!(res.ok || res.status === 206)) throw new FetchFailed(`HTTP ${res.status}: sub-hourly f${this.ff}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        this.bytes += buf.length;
        await Promise.all(rg.parts.map(async ({ entry, off }) => {
          const len = (entry.end ?? rg.start + buf.length) - entry.start;
          got.set(entry.key, (await decodeCropped(buf.subarray(off, off + len), this.box)).values);
        }));
      }));
      for (const min of this.minutes()) {
        const U = got.get(`U:${min}`), V = got.get(`V:${min}`), G = got.get(`G:${min}`);
        if (!U || !V) continue;
        if (this.geo.turnAt && this.geo.constructor.name === "LambertGrid") turn(this.geo, this.box, U, V);
        this.frames.set(min, { U, V, G: G || null });
      }
      return this;
    })();
    this.job.catch(() => { this.job = null; });
    return this.job;
  }
}

function turn(grid, box, U, V) {
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
    const c = j * box.w + i, a = grid.turnAt(box.i0 + i, box.j0 + j), co = Math.cos(a), si = Math.sin(a), u = U[c], v = V[c];
    U[c] = co * u + si * v; V[c] = -si * u + co * v;
  }
}

// A 2-D wind field as a particle flow (particles pinned near the ground): same interface as
// EtaFlow.at(i, j, eta) → [u, v, w, vort, z, Ri] (only u, v known here).
export class SurfaceFlow {
  constructor(surf, w, h, vol) { Object.assign(this, { U: surf.U, V: surf.V, w, h, vol }); this.eta = [10, 10]; }
  at(i, j) {
    const { w, h } = this;
    if (i < 0 || j < 0 || i > w - 1 || j > h - 1) return null;
    const i0 = Math.min(w - 2, Math.floor(i)), j0 = Math.min(h - 2, Math.floor(j)), a = i - i0, b = j - j0;
    let u = 0, v = 0, s = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - a) * (1 - b)], [1, 0, a * (1 - b)], [0, 1, (1 - a) * b], [1, 1, a * b]]) {
      const c = (j0 + dj) * w + (i0 + di), x = this.U[c], y = this.V[c];
      if (Number.isFinite(x) && Number.isFinite(y) && wt > 0) { u += x * wt; v += y * wt; s += wt; }
    }
    return s > 0.5 ? [u / s, v / s, NaN, NaN, NaN, NaN] : null;
  }
}
