// Capping-inversion detector, per model column: a JS mirror of pipeline/twi/detector.py
// (the Hilo-sounding TWI method, run on every grid column). web/tests/twi.test.mjs checks the
// two agree on a fixture the Python writes, so change both together.
//
// Layer: seed at the strongest potential-temperature gradient below max_search_m, grow up and
// down while dθ/dz stays above 5 K/km (above ordinary stable stratification; "grow while
// warming" swallows the whole profile). TII 0-10 scores sharpness, drying and thickness.
// Levels at or below the ground are dropped first (RRFS extrapolates them under the terrain).
//
// In Hawaiʻi this is the trade-wind inversion. Elsewhere the page calls it a "capping stable
// layer" (brief 3.2): the algorithm is generic, the trade-wind story isn't.

const THRESH = 0.005;              // K/m (5 K/km)

const dewpointC = (tK, rh) => {
  const t = tK - 273.15, r = Math.min(100, Math.max(1, rh)), a = 17.625, b = 243.04;
  const g = Math.log(r / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
};

// TII (0-10): the Alenuihāhā briefing's own score (TWI_analysis.py _norm_score), so numbers and
// categories agree with it: strong >= 6, moderate >= 3, weak below. dT <= 0 scores 0.
function score(dth, dt, drh, thick) {
  const x = (Math.max(dth, 0) / 2.5) * (Math.max(dt, 0) / 2.4) * (Math.max(drh, 0) / 45);
  return 10 * Math.tanh(x / (Math.max(thick, 10) / 300 + 0.4));
}
export const TII_STRONG = 6, TII_MODERATE = 3;
// The Alenuihāhā briefing's gap-wind flag (TWI_analysis.py risk_flag): inversion strength with the
// 850-925 hPa trade-wind speed (kt, 75th percentile of the levels there). LOW / MED / HIGH.
export function riskFlag(tii, llwKt) {
  if (!Number.isFinite(tii) || !Number.isFinite(llwKt)) return "LOW";
  const strong = tii >= TII_STRONG, moderate = tii >= TII_MODERATE;
  if (strong && llwKt >= 30) return "HIGH";
  if ((strong && llwKt >= 25) || (moderate && llwKt >= 30)) return "MED";
  if (moderate && llwKt >= 23) return "MED";
  return "LOW";
}
// 75th percentile (linear, as numpy's default).
export function pct75(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const r = 0.75 * (a.length - 1), i = Math.floor(r);
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * (r - i) : a[i];
}
export const tiiClass = (x) => (!Number.isFinite(x) ? "–" : x >= TII_STRONG ? "strong" : x >= TII_MODERATE ? "moderate" : "weak");

const NONE = { base_m: null, top_m: null, thickness_m: null, dtheta_k: null, drh_pct: null, ddry_c: null, tii: 0 };

// One column: arrays per pressure level (any order). Returns the detector's dict.
// Search band 950-600 hPa, as the Alenuihāhā briefing's Hilo TWI method (keeps surface
// night-time inversions out; see pipeline/twi/detector.py).
export const BAND_HPA = [600, 950];

// thresh (K/m) is the growth threshold; the channel analysis varies it for its sensitivity check.
export function detectColumn(tK, rh, z, p, { maxSearchM = 4000, terrainM = 0, bandHpa = BAND_HPA, thresh = THRESH } = {}) {
  const idx = p.map((_, i) => i).sort((a, b) => p[b] - p[a]);          // surface (highest pressure) first
  const L = idx.filter((i) => z[i] <= maxSearchM && z[i] > terrainM + 5 && p[i] >= bandHpa[0] && p[i] <= bandHpa[1]
    && Number.isFinite(tK[i]) && Number.isFinite(rh[i]) && Number.isFinite(z[i]));
  if (L.length < 3) return { ...NONE };
  const P = L.map((i) => p[i]), T = L.map((i) => tK[i]), R = L.map((i) => rh[i]), Z = L.map((i) => z[i]);
  const th = T.map((t, k) => t * (1000 / P[k]) ** 0.286);
  const tdd = T.map((t, k) => t - 273.15 - dewpointC(t, R[k]));
  const g = [];
  for (let k = 0; k < L.length - 1; k++) g.push((th[k + 1] - th[k]) / Math.max(1e-3, Z[k + 1] - Z[k]));
  let seed = 0;
  for (let k = 1; k < g.length; k++) if (g[k] > g[seed]) seed = k;
  if (!g.length || g[seed] <= 2 * thresh) return { ...NONE };
  let lo = seed, hi = seed;
  while (lo > 0 && g[lo - 1] > thresh) lo--;
  while (hi < g.length - 1 && g[hi + 1] > thresh) hi++;
  const base = Z[lo], top = Z[hi + 1], thick = top - base, dth = th[hi + 1] - th[lo], drh = R[lo] - R[hi + 1];
  return { base_m: base, top_m: top, thickness_m: thick, dtheta_k: dth, drh_pct: drh, ddry_c: tdd[hi + 1] - tdd[lo], tii: score(dth, T[hi + 1] - T[lo], drh, thick) };
}

// Every column of a Volume (raw pressure levels, not interpolated). Returns typed arrays
// (NaN where none): base, top, tii, dtheta, drh.
export function detectVolume(vol, opts = {}) {
  const out = detectAlloc(vol.n);
  detectRange(vol, out, 0, vol.n, opts);
  return out;
}
// The same in pieces (columns c0 … c1-1), so it can run in idle time (layers/inversion.js).
export const detectAlloc = (n) => ({ base: new Float32Array(n).fill(NaN), top: new Float32Array(n).fill(NaN), tii: new Float32Array(n),
                                     dtheta: new Float32Array(n).fill(NaN), drh: new Float32Array(n).fill(NaN) });
export function detectRange(vol, out, c0, c1, opts = {}) {
  const raw = vol.raw, L = raw.levels.length;
  const t = new Array(L), r = new Array(L), z = new Array(L);
  for (let c = c0; c < Math.min(c1, vol.n); c++) {
    for (let k = 0; k < L; k++) { t[k] = raw.data.TMP[k][c]; r[k] = raw.data.RH[k][c]; z[k] = raw.data.HGT[k][c]; }
    const d = detectColumn(t, r, z, raw.levels, { ...opts, terrainM: vol.terrain[c] });
    if (d.base_m != null) { out.base[c] = d.base_m; out.top[c] = d.top_m; out.tii[c] = d.tii; out.dtheta[c] = d.dtheta_k; out.drh[c] = d.drh_pct; }
  }
}
