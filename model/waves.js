// Chop (local wind waves) from the model's 10 m wind and the fetch: how far the wind has blown
// over open water to reach each point (pipeline/ground/fetch.py, 16 directions).
//
// Fetch-limited growth, the JONSWAP relations as the US Army Corps of Engineers' Coastal
// Engineering Manual gives them (CEM 2002, II-2, eqs. II-2-36; deep water):
//   u*² = C_D U10²,  C_D = 0.001 (1.1 + 0.035 U10)
//   g Hm0 / u*² = 4.13e-2 (g F / u*²)^1/2        capped at 211.5 (fully developed)
//   g Tp  / u*  = 0.751   (g F / u*²)^1/3        capped at 239.8
//   duration-limited: the wind has blown for t: effective fetch
//   g F_e / u*² = 5.23e-3 (g t / u*)^3/2  (CEM II-2-38); the smaller of F and F_e is used
// Assumptions: steady wind for the chosen duration (default 12 h),
// deep water, no swell, no currents (tidal currents in the Strait and Puget Sound steepen or
// flatten chop a lot), and the wind at each point standing in for the wind along the fetch.

const G = 9.80665;
export const DURATION = { value: 12 * 3600 };            // the "wind has blown for" setting (s), shared by the layer, probe and inspector

// One point: U10 (m/s), fetch (m), wind duration (s; Infinity = fetch-limited only) → {hs (m), tp (s), limited}.
export function chop(u10, fetchM, durationS = Infinity) {
  if (!(u10 > 0.5) || !(fetchM > 0)) return { hs: 0, tp: 0 };
  const cd = 0.001 * (1.1 + 0.035 * u10), us2 = cd * u10 * u10, us = Math.sqrt(us2);
  const fe = Number.isFinite(durationS) ? 5.23e-3 * ((G * durationS) / us) ** 1.5 * us2 / G : Infinity;
  const limited = fe < fetchM ? "duration" : "fetch";
  const x = (G * Math.min(fetchM, fe)) / us2;
  const hs = Math.min(4.13e-2 * Math.sqrt(x), 211.5) * us2 / G;
  const tp = Math.min(0.751 * Math.cbrt(x), 239.8) * us / G;
  return { hs, tp, limited };
}
export const wavelength = (tp) => (G * tp * tp) / (2 * Math.PI);   // deep water, m

export class FetchGrid {
  // meta: ground.json "fetch" block; data: Uint16Array (0.1 km), [dir][ny][nx].
  constructor(meta, data) { Object.assign(this, meta); this.data = data; }
  static async load(regionId, meta) {
    if (!meta) return null;
    const { gunzipTyped } = await import("../layers/ground.js?v=20261002173952");  // (loaded lazily: keeps this module testable in node)
    return new FetchGrid(meta, await gunzipTyped(`data/${regionId}/${meta.file}`, Uint16Array));
  }
  // Fetch (km) at scene (x, y) for wind FROM `fromDeg`, interpolated between the two nearest
  // direction bins; 0 on land, NaN off the grid.
  at(x, y, fromDeg) {
    const i = Math.round((x - this.x0) / this.dxy), j = Math.round((y - this.y0) / this.dxy);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return NaN;
    const step = 360 / this.ndir, f = ((((fromDeg % 360) + 360) % 360) / step), k0 = Math.floor(f) % this.ndir, k1 = (k0 + 1) % this.ndir, w = f - Math.floor(f);
    const n = this.nx * this.ny, c = j * this.nx + i, a = this.data[k0 * n + c], b = this.data[k1 * n + c];
    if (a === 0 && b === 0) return 0;                            // land
    return ((1 - w) * a + w * b) / 10;
  }
}

// Chop at a point from the wind (u east, v north, m/s): {hs, tp, fetchKm, fromDeg} or null (land/off grid).
export function chopAt(fetch, x, y, u, v, durationS = DURATION.value) {
  const spd = Math.hypot(u, v);
  if (!Number.isFinite(spd)) return null;
  const fromDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360, fk = fetch.at(x, y, fromDeg);
  if (!(fk > 0)) return null;
  return { ...chop(spd, fk * 1000, durationS), fetchKm: fk, fromDeg, u10: spd };
}

// ---------- the surface inspector's wave trains ----------
// 32 for the chop plus 8 for each of up to three swell trains; unused slots have zero height.
export const CHOP_TRAINS = 32, SWELL_TRAINS = 8, TRAINS = CHOP_TRAINS + 3 * SWELL_TRAINS;
export function jonswap(f, fp, gamma = 3.3) {
  const s = f <= fp ? 0.07 : 0.09, r = Math.exp(-((f - fp) ** 2) / (2 * s * s * fp * fp));
  return f ** -5 * Math.exp(-1.25 * (fp / f) ** 4) * gamma ** r;
}

// One wave system as n trains: frequencies across [lo, hi]·fp, JONSWAP-weighted (peak γ),
// directions within ±spread (radians) of the travel direction, random phases, scaled to Hs.
function system({ hs, tp, fromDeg }, n, lo, hi, gamma, spread, rand) {
  if (!(hs > 0) || !(tp > 0)) return Array.from({ length: n }, () => ({ a: 0, kx: 0, ky: 0, w: 0, ph: 0 }));
  const fp = 1 / tp, toward = ((fromDeg + 180) * Math.PI) / 180, out = [];
  let e = 0;
  for (let i = 0; i < n; i++) {
    const f = fp * (lo + ((hi - lo) * i) / (n - 1)), df = (fp * (hi - lo)) / (n - 1);
    const th = toward + (rand() - 0.5) * 2 * spread * Math.pow(rand(), 0.6);   // denser near the mean
    const S = jonswap(f, fp, gamma) * df, w = 2 * Math.PI * f, k = (w * w) / G;
    out.push({ S, kx: k * Math.sin(th), ky: k * Math.cos(th), w, ph: rand() * 2 * Math.PI });
    e += S;
  }
  const m0 = (hs / 4) ** 2;                                        // Hs = 4 √m0; Σ a²/2 = m0
  for (const t of out) t.a = Math.sqrt((2 * t.S * m0) / e);
  return out;
}

// All trains for the inspector: the chop (broad spectrum, spread ±70°) and each swell
// (narrow: γ 7, ±12°). chop: {hs, tp, fromDeg} or null; swell: [{hs, tp, dir (from)}].
export function trains(chop, seed = 1, swell = []) {
  let rnd = ((Math.abs(Math.round(seed)) % 233280) * 9301 + 49297) % 233280;   // any seed (negative longitudes too) → [0, 1)
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  const out = system(chop || {}, CHOP_TRAINS, 0.7, 2.5, 3.3, 1.2, rand);
  for (let k = 0; k < 3; k++) {
    const sw = swell[k];
    out.push(...system(sw ? { hs: sw.hs, tp: sw.tp, fromDeg: sw.dir } : {}, SWELL_TRAINS, 0.85, 1.25, 7, 0.21, rand));
  }
  return out;
}
