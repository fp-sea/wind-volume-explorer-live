// Wind resampled for particles, one forecast hour at a time (no three.js here, so node can test it).
//
//   EtaFlow    u, v, w, vorticity on fixed η levels. η is height above ground near the surface,
//              blending to height above sea level aloft: z = η + ground · max(0, 1 − η/H_BLEND).
//              Particles near the ground follow the terrain; particles aloft don't.
//   LevelFlow  the model's own levels only (10-320 m above ground, each pressure level at its
//              real height), for "interpolate between heights" off.

export const H_BLEND = 6000;        // m: above this, η is height above sea level
// Fixed η levels (m) the wind is resampled onto: fine near the ground, coarser aloft.
export const ETA = [10, 30, 50, 80, 120, 160, 220, 320, 450, 600, 800, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

// The wind on fixed η levels for one forecast hour (interpolated mode).
export class EtaFlow {
  // defer: allocate only; fill column ranges with fill(c0, c1) (e.g. in idle time, a few hundred
  // columns at a go: the whole field is ~340 ms), then ready. Otherwise filled at once.
  constructor(vol, { defer = false } = {}) {
    const n = vol.n, L = ETA.filter((e) => e <= vol.topM + 1);
    this.eta = L; this.w = vol.w; this.h = vol.h; this.n = n; this.vol = vol;
    const U = new Float32Array(n * L.length), V = new Float32Array(n * L.length), W = new Float32Array(n * L.length), R = new Float32Array(n * L.length);
    Object.assign(this, { U, V, W, R, filled: 0, zs: new Float64Array(L.length) });
    if (!defer) this.fill(0, n);
  }
  get ready() { return this.filled >= this.n; }
  fill(c0, c1) {                                              // columns c0 … c1-1, in order
    const { vol, n, eta: L, zs, U, V, W, R } = this;
    for (let c = c0; c < Math.min(c1, n); c++) {            // one pass up each column (η levels ascend, so heights do)
      for (let k = 0; k < L.length; k++) zs[k] = zOf(L[k], vol.terrain[c]);
      vol.profile("U", c, zs, U, c, n); vol.profile("V", c, zs, V, c, n); vol.profile("W", c, zs, W, c, n); vol.profile("VORT", c, zs, R, c, n);
    }
    this.filled = Math.max(this.filled, Math.min(c1, n));
  }
  finish() { if (!this.ready) this.fill(this.filled, this.n); return this; }
  // Richardson number on the η levels: only when particles are coloured by it (it needs the
  // whole stability pass).
  get RI() {
    if (this._ri) return this._ri;
    const { n, eta: L, vol } = this, RI = new Float32Array(n * L.length);
    for (let k = 0; k < L.length; k++) for (let c = 0; c < n; c++) RI[k * n + c] = vol.column("RI", c, zOf(L[k], vol.terrain[c]));
    return (this._ri = RI);
  }
  // [u, v, w (m/s), vort (1/s), NaN, Ri] at fractional cell (i, j) and η; null where there's no wind.
  // (Index 4 is LevelFlow's height; kept aligned so particles read both the same way.)
  at(i, j, eta) {
    const { w, h, n, eta: L } = this;
    if (i < 0 || j < 0 || i > w - 1 || j > h - 1 || eta < L[0] * 0.5 || eta > L[L.length - 1]) return null;
    let k = 0;
    while (k < L.length - 2 && L[k + 1] < eta) k++;
    const t = Math.max(0, Math.min(1, (eta - L[k]) / (L[k + 1] - L[k])));
    const i0 = Math.min(w - 2, Math.floor(i)), j0 = Math.min(h - 2, Math.floor(j)), a = i - i0, b = j - j0;
    // Trilinear, each field over the corners where it's finite. Plain loops, no allocation per
    // corner: this runs for every particle every frame (twice between hours).
    const { U, V, W, R } = this, RI = this.wantRi ? this.RI : null;
    let su = 0, sv = 0, sw = 0, sr = 0, sri = 0, gu = 0, gv = 0, gw = 0, gr = 0, gri = 0;
    for (let dk = 0; dk < 2; dk++) {
      const wk = dk ? t : 1 - t;
      if (wk <= 0) continue;
      for (let c4 = 0; c4 < 4; c4++) {
        const di = c4 & 1, dj = c4 >> 1, wt = wk * (di ? a : 1 - a) * (dj ? b : 1 - b);
        if (wt <= 0) continue;
        const q = (k + dk) * n + (j0 + dj) * w + (i0 + di);
        let x = U[q]; if (x === x) { su += x * wt; gu += wt; }        // x === x: not NaN (values are finite or NaN)
        x = V[q]; if (x === x) { sv += x * wt; gv += wt; }
        x = W[q]; if (x === x) { sw += x * wt; gw += wt; }
        x = R[q]; if (x === x) { sr += x * wt; gr += wt; }
        if (RI) { x = RI[q]; if (Number.isFinite(x)) { sri += x * wt; gri += wt; } }
      }
    }
    if (gu < 0.5) return null;                                  // mostly under the ground / above the top
    return [su / gu, gv > 0.5 ? sv / gv : NaN, gw > 0.5 ? sw / gw : NaN, gr > 0.5 ? sr / gr : NaN, NaN, gri > 0.5 ? sri / gri : NaN];
  }
}
export const zOf = (eta, ground) => eta + ground * Math.max(0, 1 - eta / H_BLEND);

// The model's own levels (interpolate off): winds above ground, and each pressure level.
export class LevelFlow {
  constructor(vol) {
    const raw = vol.raw, lv = [];
    for (const m of Object.keys(raw.agl).map(Number).sort((a, b) => a - b)) {
      if (raw.agl[m].UGRD) lv.push({ label: `${m} m`, agl: m, U: raw.agl[m].UGRD, V: raw.agl[m].VGRD, W: null, R: null, Z: null });
    }
    raw.levels.forEach((mb, k) => {
      // Only levels actually loaded (just-in-time stores hold some levels, not all).
      if (raw.have && !(raw.have.has(`UGRD:${mb}`) && raw.have.has(`HGT:${mb}`))) return;
      const f = Float32Array.from(raw.lat, (la) => 2 * 7.2921e-5 * Math.sin(la * Math.PI / 180));
      lv.push({ label: `${mb} mb`, mb, U: raw.data.UGRD[k], V: raw.data.VGRD[k], W: raw.data.DZDT[k], R: raw.data.ABSV[k].map((x, c) => x - f[c]), Z: raw.data.HGT[k] });
    });
    Object.assign(this, { levels: lv, w: vol.w, h: vol.h, vol });
  }
  // [u, v, w, vort, zMsl, Ri] on level L at fractional cell (i, j); null below ground or outside.
  at(L, i, j) {
    const { w, h } = this, lv = this.levels[L], ter = this.vol.terrain;
    if (!lv || i < 0 || j < 0 || i > w - 1 || j > h - 1) return null;
    const i0 = Math.min(w - 2, Math.floor(i)), j0 = Math.min(h - 2, Math.floor(j)), a = i - i0, b = j - j0;
    let u = 0, v = 0, ww = 0, r = 0, z = 0, s = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - a) * (1 - b)], [1, 0, a * (1 - b)], [0, 1, (1 - a) * b], [1, 1, a * b]]) {
      const c = (j0 + dj) * w + (i0 + di);
      const zc = lv.Z ? lv.Z[c] : ter[c] + lv.agl;
      if (lv.Z && !(zc > ter[c] + 5)) continue;                  // pressure level under the ground here
      u += lv.U[c] * wt; v += lv.V[c] * wt; ww += (lv.W ? lv.W[c] : 0) * wt; r += (lv.R ? lv.R[c] : 0) * wt; z += zc * wt; s += wt;
    }
    if (!(s > 0.5)) return null;
    const zz = z / s, cn = Math.round(j) * w + Math.round(i);
    return [u / s, v / s, lv.W ? ww / s : NaN, lv.R ? r / s : NaN, zz, this.vol.column("RI", cn, zz)];
  }
}


// Between two forecast hours: each sample is the linear blend of the two hours' samples
// (brief 4.6: temporal interpolation between the bracketing native-cadence outputs).
// Where only one hour has wind at that spot (e.g. a pressure level that dips under the
// ground in one of them), there's no wind (null), rather than half of one.
export class BlendFlow {
  constructor(a, b, t) { Object.assign(this, { a, b, t }); this.eta = a.eta; this.levels = a.levels; this.w = a.w; this.h = a.h; this.vol = a.vol; }
  at(...args) {
    const p = this.a.at(...args), q = this.b.at(...args);
    if (!p || !q) return this.t < 0.02 ? p : this.t > 0.98 ? q : null;
    const t = this.t;
    for (let i = 0; i < 6; i++) { const x = p[i], y = q[i]; p[i] = x === x && y === y ? x + (y - x) * t : x === x ? x : y; }
    return p;                                                   // (p is a fresh array from a.at)
  }
}
