// One loaded forecast hour as a 3D volume: every display samples from here, so the panel
// chooses what to *show*, never what to *load*.
//
// Each grid column stacks everything the model gives, sorted by height above sea level:
//   the ground (model terrain), 2 m temperature/humidity, winds at 10-320 m above ground,
//   and the pressure levels at their real geopotential height, where they're above ground
//   (below-ground pressure levels are extrapolated by the model, not real, so they're dropped).
// Values between entries are interpolated linearly in height. Above the top level there's
// nothing (NaN); below the lowest entry wind, T and RH hold their lowest value down to the ground
// (w and vorticity don't: NaN), and heights under the ground are NaN.
//
// Heights are metres above sea level (MSL) unless a function says "agl".

import { MercatorGrid } from "./mercator.js?v=20261002173952";
import { LambertGrid } from "./lambert.js?v=20261002173952";

// Grid geometry for a GRIB grid header: Mercator (RRFS Hawaiʻi) or Lambert (HRRR / RRFS CONUS).
export const gridOf = (g) => (g.tpl === 30 ? new LambertGrid(g) : new MercatorGrid(g));

const OMEGA = 7.2921e-5;
export const FIELDS = ["U", "V", "W", "T", "RH", "VORT", "P", "Q"];   // Q: cloud condensate, water + ice (g/kg)
// Fields held down to the ground below their lowest value (they have near-surface anchors: 10 m wind,
// 2 m T/RH). w and vorticity come only from the pressure levels, so under the lowest one they're
// unknown (NaN), not guessed.
const HOLD = new Set(["U", "V", "T", "RH"]);

export class Volume {
  constructor(vol, grid) {
    this.raw = vol;
    this.merc = gridOf(grid);          // (named merc for history: any grid with ij/latLon/cellSizeM/toGrid)
    const { w, h } = vol.crop;
    this.w = w; this.h = h; this.n = w * h;
    this.terrain = Float32Array.from(vol.surface.HGT, (g) => Math.max(0, g));
    this.build();
    this.pressureHeights();
  }

  // Terrain slope per cell along the grid's i and j axes (m of rise per m), cached.
  terrainGrad() {
    if (this._tg) return this._tg;
    const { w, h, terrain: t } = this, gi = new Float32Array(this.n), gj = new Float32Array(this.n);
    for (let j = 0; j < h; j++) {
      const cm = this.merc.cellSizeM(this.raw.crop.i0 + w / 2, this.raw.crop.j0 + j);
      for (let i = 0; i < w; i++) {
        const c = j * w + i, il = Math.max(0, i - 1), ir = Math.min(w - 1, i + 1), jd = Math.max(0, j - 1), ju = Math.min(h - 1, j + 1);
        gi[c] = ((t[j * w + ir] || 0) - (t[j * w + il] || 0)) / ((ir - il) * cm || 1);
        gj[c] = ((t[ju * w + i] || 0) - (t[jd * w + i] || 0)) / ((ju - jd) * cm || 1);
      }
    }
    return (this._tg = { gi, gj });
  }

  // Per column: sorted heights and each field's value at them (NaN where that entry lacks it).
  build() {
    const v = this.raw, L = v.levels.length, A = Object.keys(v.agl).map(Number).sort((a, b) => a - b);
    const N = 1 + A.length + L;                              // 2 m + AGL levels + pressure levels
    this.N = N;
    const z = new Float32Array(this.n * N).fill(NaN);
    const vals = Object.fromEntries(FIELDS.map((f) => [f, new Float32Array(this.n * N).fill(NaN)]));
    this.count = new Uint8Array(this.n);
    const tmp = [], tg = this.terrainGrad(), U10 = v.agl[10]?.UGRD, V10 = v.agl[10]?.VGRD;
    for (let c = 0; c < this.n; c++) {
      const g = this.terrain[c], f = 2 * OMEGA * Math.sin(v.lat[c] * Math.PI / 180);
      tmp.length = 0;
      // Vertical velocity at the ground: the wind following the terrain, w = V·∇h (0 over water).
      // The model gives w only on pressure levels; without this anchor there was none below the
      // lowest level above ground (the lowest 100-300 m), so surface air couldn't rise.
      let w0 = NaN;
      if (U10 && V10) {
        const i = c % this.w, j = (c - i) / this.w, [ug, vg] = this.merc.toGrid(U10[c], V10[c], v.crop.i0 + i, v.crop.j0 + j);
        w0 = ug * tg.gi[c] + vg * tg.gj[c];
      }
      tmp.push({ z: g + 2, T: v.surface.TMP2?.[c], RH: v.surface.RH2?.[c], W: w0 });
      for (const m of A) if (v.agl[m].UGRD) tmp.push({ z: g + m, U: v.agl[m].UGRD[c], V: v.agl[m].VGRD[c] });
      for (let k = 0; k < L; k++) {
        const zz = v.data.HGT[k][c];
        if (!(zz > g + 5)) continue;                           // below (or at) the model's ground: not real
        const qw = v.data.CLMR?.[k]?.[c], qi = v.data.CICE?.[k]?.[c];
        const q = Number.isFinite(qw) || Number.isFinite(qi) ? ((Number.isFinite(qw) ? qw : 0) + (Number.isFinite(qi) ? qi : 0)) * 1000 : NaN;
        tmp.push({ z: zz, Q: q, U: v.data.UGRD[k][c], V: v.data.VGRD[k][c], W: v.data.DZDT[k][c], T: v.data.TMP[k][c], RH: v.data.RH[k][c],
                   VORT: v.data.ABSV[k][c] - f, P: v.levels[k] });
      }
      tmp.sort((a, b) => a.z - b.z);
      const base = c * N;
      tmp.forEach((e, i) => { z[base + i] = e.z; for (const fld of FIELDS) if (e[fld] !== undefined) vals[fld][base + i] = e[fld]; });
      this.count[c] = tmp.length;
    }
    this.z = z; this.vals = vals;
  }

  // Turbulence proxies, per layer between adjacent column entries (computed once, on first use):
  //   SHEAR  |ΔV|/Δz (1/s) between any two entries that both have wind (includes the
  //          10-320 m above-ground winds, so low-level shear is resolved)
  //   RI     gradient Richardson number N²/S² between adjacent pressure levels (needs θ, so
  //          temperature and pressure at both ends): < 0.25 turbulence likely (shear beats
  //          stability, Kelvin-Helmholtz), 0.25-1 possible, < 0 convectively unstable.
  // Piecewise constant within a layer. Proxies only: the model has no TKE, and real turbulence
  // is far smaller than a 2.5 km cell and 25 mb layers.
  // In pieces too (stabilityFill over column ranges), so it can be computed in idle time for an
  // upcoming hour (explore.js prewarm); stability() finishes whatever is left.
  stability() {
    if (this.lay) return this.lay;
    this.stabilityFill(this._layDone || 0, this.n);
    return this.lay;
  }
  stabilityFill(c0, c1) {
    if (this.lay) return;
    const N = this.N, z = this.z, V = this.vals, n = this.n;
    const P = (this._layWork ||= { z0: new Float32Array(n * N).fill(NaN), z1: new Float32Array(n * N).fill(NaN), S: new Float32Array(n * N).fill(NaN), RI: new Float32Array(n * N).fill(NaN), cnt: new Uint8Array(n) });
    const { z0, z1, S, RI, cnt } = P;
    for (let c = Math.max(c0, this._layDone || 0); c < Math.min(c1, n); c++) {
      const b = c * N, m = this.count[c];
      let k = 0, lastWind = -1, lastThermo = -1;
      for (let i = 0; i < m; i++) {
        const q = b + i, hasW = Number.isFinite(V.U[q]) && Number.isFinite(V.V[q]);
        const hasTh = hasW && Number.isFinite(V.T[q]) && Number.isFinite(V.P[q]);
        if (hasW && lastWind >= 0) {
          const p = b + lastWind, dz = z[q] - z[p];
          if (dz > 1) {
            const du = V.U[q] - V.U[p], dv = V.V[q] - V.V[p], s2 = (du * du + dv * dv) / (dz * dz);
            let ri = NaN;
            if (hasTh && lastThermo === lastWind) {
              const th0 = V.T[p] * (1000 / V.P[p]) ** 0.286, th1 = V.T[q] * (1000 / V.P[q]) ** 0.286;
              const n2 = (9.81 / ((th0 + th1) / 2)) * ((th1 - th0) / dz);
              ri = n2 / Math.max(s2, 1e-10);
            }
            const o = b + k++;
            z0[o] = z[p]; z1[o] = z[q]; S[o] = Math.sqrt(s2); RI[o] = ri;
          }
        }
        if (hasW) lastWind = i;
        if (hasTh) lastThermo = i;
      }
      cnt[c] = k;
    }
    this._layDone = Math.max(this._layDone || 0, Math.min(c1, n));
    if (this._layDone >= n) { this.lay = P; this._layWork = null; }
  }
  // SHEAR or RI in column c at height zMsl (NaN outside the column's layers).
  layerAt(field, c, zMsl) {
    const L = this.stability(), b = c * this.N, arr = field === "SHEAR" ? L.S : L.RI;
    for (let i = 0; i < L.cnt[c]; i++) if (zMsl >= L.z0[b + i] && zMsl <= L.z1[b + i]) return arr[b + i];
    return NaN;
  }

  // Field value in column c at height zMsl (m). NaN below ground or above the top.
  column(field, c, zMsl) {
    if (field === "SHEAR" || field === "RI") return zMsl < this.terrain[c] ? NaN : this.layerAt(field, c, zMsl);
    if (zMsl < this.terrain[c]) return NaN;
    const N = this.N, base = c * N, cnt = this.count[c], z = this.z, a = this.vals[field];
    let lo = -1, hi = -1;
    for (let i = 0; i < cnt; i++) {                          // ≤ ~40 entries: a scan is fine
      if (Number.isNaN(a[base + i])) continue;
      if (z[base + i] <= zMsl) lo = i; else { hi = i; break; }
    }
    if (lo < 0) return hi < 0 || !HOLD.has(field) ? NaN : a[base + hi];   // below the lowest value: hold wind/T/RH down to the ground
    if (hi < 0) return zMsl - z[base + lo] < 1 ? a[base + lo] : NaN;   // above the top: nothing
    const t = (zMsl - z[base + lo]) / (z[base + hi] - z[base + lo]);
    return a[base + lo] + t * (a[base + hi] - a[base + lo]);
  }

  // column() at many ascending heights zs in one pass up the column (same values; EtaFlow uses
  // this: a scan per height made building an hour's particle flow take ~1 s).
  // Writes out[off + k * stride] for each zs[k].
  profile(field, c, zs, out, off, stride) {
    if (field === "SHEAR" || field === "RI") { for (let k = 0; k < zs.length; k++) out[off + k * stride] = this.column(field, c, zs[k]); return; }
    const base = c * this.N, cnt = this.count[c], z = this.z, a = this.vals[field], hold = HOLD.has(field), ter = this.terrain[c];
    let first = -1, last = -1, p = -1, next = -1;               // p: last finite entry at or below the height; next: the one after
    for (let i = 0; i < cnt; i++) if (!Number.isNaN(a[base + i])) { if (first < 0) first = i; last = i; }
    next = first;
    for (let k = 0; k < zs.length; k++) {
      const zq = zs[k], o = off + k * stride;
      if (zq < ter || first < 0) { out[o] = NaN; continue; }
      while (next >= 0 && z[base + next] <= zq) {
        p = next; next = -1;
        for (let i = p + 1; i <= last; i++) if (!Number.isNaN(a[base + i])) { next = i; break; }
      }
      if (p < 0) out[o] = hold ? a[base + first] : NaN;
      else if (next < 0) out[o] = zq - z[base + p] < 1 ? a[base + p] : NaN;
      else { const t = (zq - z[base + p]) / (z[base + next] - z[base + p]); out[o] = a[base + p] + t * (a[base + next] - a[base + p]); }
    }
  }

  // Bilinear across the four surrounding columns at (lat, lon), height zMsl (or AGL if agl).
  sample(field, lat, lon, zMsl, agl = false) {
    const q = this.merc.ij(lat, lon), i = q.i - this.raw.crop.i0, j = q.j - this.raw.crop.j0;
    if (i < 0 || j < 0 || i > this.w - 1 || j > this.h - 1) return NaN;
    const i0 = Math.min(this.w - 2, Math.floor(i)), j0 = Math.min(this.h - 2, Math.floor(j)), u = i - i0, t = j - j0;
    let s = 0, wsum = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - u) * (1 - t)], [1, 0, u * (1 - t)], [0, 1, (1 - u) * t], [1, 1, u * t]]) {
      const c = (j0 + dj) * this.w + (i0 + di);
      const x = this.column(field, c, agl ? this.terrain[c] + zMsl : zMsl);
      if (!Number.isNaN(x) && wt > 0) { s += x * wt; wsum += wt; }
    }
    return wsum > 0.5 ? s / wsum : NaN;                         // mostly below ground: nothing
  }
  // sample() along a section: path [{lat, lon}] × ascending heights zs (m MSL), as
  // out[k * path.length + i]. Same values, one pass up each column (shared by neighbouring points).
  section(field, path, zs) {
    const n = path.length, NZ = zs.length, out = new Float32Array(n * NZ).fill(NaN), prof = new Map();
    const col = (c) => { let a = prof.get(c); if (!a) { a = new Float32Array(NZ); this.profile(field, c, zs, a, 0, 1); prof.set(c, a); } return a; };
    for (let i = 0; i < n; i++) {
      const q = this.merc.ij(path[i].lat, path[i].lon), fi = q.i - this.raw.crop.i0, fj = q.j - this.raw.crop.j0;
      if (fi < 0 || fj < 0 || fi > this.w - 1 || fj > this.h - 1) continue;
      const i0 = Math.min(this.w - 2, Math.floor(fi)), j0 = Math.min(this.h - 2, Math.floor(fj)), u = fi - i0, t = fj - j0;
      const cs = [[0, 0, (1 - u) * (1 - t)], [1, 0, u * (1 - t)], [0, 1, (1 - u) * t], [1, 1, u * t]].filter((e) => e[2] > 0)
        .map(([di, dj, wt]) => [col((j0 + dj) * this.w + (i0 + di)), wt]);
      for (let k = 0; k < NZ; k++) {
        let s = 0, wsum = 0;
        for (const [a, wt] of cs) { const x = a[k]; if (!Number.isNaN(x)) { s += x * wt; wsum += wt; } }
        if (wsum > 0.5) out[k * n + i] = s / wsum;
      }
    }
    return out;
  }
  terrainAt(lat, lon) {
    const q = this.merc.ij(lat, lon), i = Math.round(q.i - this.raw.crop.i0), j = Math.round(q.j - this.raw.crop.j0);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? 0 : this.terrain[j * this.w + i];
  }

  // Domain-mean height of each pressure level (for "≈ mb" labels): [{mb, z}] ascending in z.
  pressureHeights() {
    const v = this.raw;
    this.pz = v.levels.map((mb, k) => {
      let s = 0, n = 0;
      for (let c = 0; c < this.n; c++) if (v.data.HGT[k][c] > this.terrain[c] + 5) { s += v.data.HGT[k][c]; n++; }
      return { mb, z: n ? s / n : NaN };
    }).filter((e) => !Number.isNaN(e.z)).sort((a, b) => a.z - b.z);
  }
  // Approximate pressure (mb) at height zMsl, log-linear between the domain-mean level heights.
  mbAt(zMsl) {
    const p = this.pz;
    if (!p.length) return NaN;
    if (zMsl <= p[0].z) {                                      // below the lowest level: ~8 km scale height
      return p[0].mb * Math.exp((p[0].z - zMsl) / 8000);
    }
    for (let i = 1; i < p.length; i++) if (zMsl <= p[i].z) {
      const t = (zMsl - p[i - 1].z) / (p[i].z - p[i - 1].z);
      return Math.exp(Math.log(p[i - 1].mb) + t * (Math.log(p[i].mb) - Math.log(p[i - 1].mb)));
    }
    return NaN;
  }
  get topM() { return this.pz.length ? this.pz[this.pz.length - 1].z : 0; }
}

// "≈ 850 mb · 1,460 m · 4,790 ft". For heights above ground the mb is for the height above
// sea level over open water (terrain 0), so it's marked as such.
const M_FT = 3.28084;
export function heightLabel(vol, h, ref = "msl") {
  const m = Math.round(h), ft = Math.round(h * M_FT);
  const n = (x) => x.toLocaleString("en-US");
  const mb = vol ? vol.mbAt(h) : NaN;
  const p = Number.isFinite(mb) ? `≈ ${Math.round(mb / 5) * 5} mb${ref === "agl" ? " over water" : ""} · ` : "";
  return `${p}${n(m)} m · ${n(ft)} ft ${ref === "agl" ? "above ground" : "above sea level"}`;
}

// Between two forecast hours: the same interface as Volume, each value the linear blend of
// the two hours (brief 4.6). Heights, terrain and grid come from the first hour (they barely
// move in an hour; terrain doesn't at all).
export class BlendVolume {
  constructor(a, b, t) {
    Object.assign(this, { a, b, t, merc: a.merc, w: a.w, h: a.h, n: a.n, terrain: a.terrain, pz: a.pz, N: a.N });
    const mix = (k) => { const x0 = a.raw.surface[k], x1 = b.raw.surface[k]; return x0 && x1 ? x0.map((x, i) => x + (x1[i] - x) * t) : x0; };
    this.raw = { ...a.raw, surface: { ...a.raw.surface, GUST: mix("GUST"), MSLP: mix("MSLP"), VIS: mix("VIS") } };
  }
  get topM() { return this.a.topM; }
  mbAt(z) { return this.a.mbAt(z); }
  terrainAt(la, lo) { return this.a.terrainAt(la, lo); }
  column(f, c, z) { return lerp(this.a.column(f, c, z), this.b.column(f, c, z), this.t); }
  sample(f, la, lo, z, agl) { return lerp(this.a.sample(f, la, lo, z, agl), this.b.sample(f, la, lo, z, agl), this.t); }
  section(f, path, zs) { const p = this.a.section(f, path, zs), q = this.b.section(f, path, zs); return p.map((x, i) => lerp(x, q[i], this.t)); }
  profile(f, c, zs, out, off, stride) {
    const n = zs.length, p = new Float32Array(n), q = new Float32Array(n);
    this.a.profile(f, c, zs, p, 0, 1); this.b.profile(f, c, zs, q, 0, 1);
    for (let k = 0; k < n; k++) out[off + k * stride] = lerp(p[k], q[k], this.t);
  }
}
const lerp = (x, y, t) => (Number.isFinite(x) && Number.isFinite(y) ? x + (y - x) * t : t < 0.5 ? x : y);
