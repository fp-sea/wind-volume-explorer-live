// Channel analysis (experimental): gap-flow diagnostics from the literature, computed from the
// model on screen. Sources and caveats: docs/literature_alenuihaha.md, docs/literature_juan_de_fuca.md
// and the page channel-analysis.html.
//
//   cap layer     the capping stable layer's depth D (above the surface), the potential-
//                 temperature jump Δθ across it and the mean θ below it, by one of four
//                 definitions (the sensitivity check runs all four):
//                   detector   the inversion detector (twi.js), growth threshold in K/km
//                   isentrope  the first height where θ ≥ θ(surface) + offset (Hitzl et al.
//                              2014 used the 305 K isentrope in July, ≈ surface + 5 K)
//                   rh         the first height (above 200 m) where RH < a threshold (Hitzl: 60%)
//                   pbl        the model's boundary-layer height (HPBL)
//                 For all but the detector, Δθ = mean θ over D…D+W − mean θ over 0…D (W: window).
//   Froude        two-layer (reduced gravity): Fr = U / √(g Δθ/θ̄ · D), U the mean wind below D.
//                 < 1 subcritical, > 1 supercritical (a thinning, accelerating layer); a fall from
//                 > 1 to < 1 downstream is a hydraulic jump.
//   Bernoulli     u² = u₀² + 2Δp/ρ from the upstream end to the fastest point: an upper bound
//                 (Overland & Walter 1981); × 0.55 on the kinetic-energy gain for friction and
//                 mixing (Lackmann & Overland 1989). Flagged unreliable when the exit is warmer
//                 (Gaberšek & Durran 2004).
//   regime        ε = N h / U upstream for each bordering barrier: < 1 linear, 1–3 mountain-wave
//                 (strongest winds at the exit, sinking), > 3 blocked (strongest at the entrance)
//                 (after Gaberšek & Durran 2004: ≈ 1.5 and ≈ 5 are their mountain-wave and
//                 blocking cases; the class boundaries here are ours). A barrier above the cap
//                 base is flagged as blocking below the cap.
//   pressure rule wind (kt) ≈ 10 × Δp (mb) between a station pair (NOAA PMEL-44; Burch).

import { detectColumn } from "./twi.js?v=20261002173952";

const G = 9.80665, RHO = 1.22, KT = 1.943844;
export const CAP_DEFS = {
  detector: "Inversion detector",
  isentrope: "Isentrope (θ surface + offset)",
  rh: "Humidity drop (RH threshold)",
  pbl: "Model boundary layer (HPBL)",
};
export const DEFAULT_PARAMS = { lapseKkm: 5, thetaOffsetK: 5, rhPct: 60, windowM: 500 };

// Heights above the surface (m) for the column profiles.
export const ZS = Array.from({ length: 90 }, (_, k) => 10 + k * 50);        // 10 … 4460 m

// One column's profile at terrain + ZS: {z (MSL), T (K), P (mb), th, rh, spd (m/s)}.
export function columnProfile(vol, c) {
  const n = ZS.length, ter = vol.terrain[c], zs = ZS.map((z) => ter + z);
  const get = (f) => { const a = new Float32Array(n); vol.profile(f, c, zs, a, 0, 1); return a; };
  const T = get("T"), P = get("P"), RH = get("RH"), U = get("U"), V = get("V");
  // Pressure below the lowest pressure level: hydrostatic, from the lowest one there is.
  let k0 = P.findIndex((x) => Number.isFinite(x));
  if (k0 > 0) for (let k = 0; k < k0; k++) P[k] = P[k0] * Math.exp((zs[k0] - zs[k]) / 8000);
  const th = new Float32Array(n), spd = new Float32Array(n);
  for (let k = 0; k < n; k++) { th[k] = T[k] * (1000 / P[k]) ** 0.286; spd[k] = Math.hypot(U[k], V[k]); }
  return { z: zs, T, P, th, rh: RH, spd, U, V, ter, hpbl: vol.raw.surface.HPBL?.[c] };
}

const mean = (a, i0, i1) => { let s = 0, n = 0; for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++) if (Number.isFinite(a[k])) { s += a[k]; n++; } return n ? s / n : NaN; };
const idxOf = (h) => Math.max(0, Math.min(ZS.length - 1, Math.round((h - 10) / 50)));

// The cap by one definition: {D, top, dth, thbar, U, c, fr} (heights above the surface, m) or null.
export function capLayer(prof, def, prm = DEFAULT_PARAMS) {
  const { th, rh, spd } = prof;
  let D = NaN, top = NaN, dth = NaN;
  if (def === "detector") {
    const d = detectColumn(Array.from(prof.T), Array.from(rh), Array.from(prof.z), Array.from(prof.P), { terrainM: prof.ter, thresh: prm.lapseKkm / 1000 });
    if (d.base_m == null) return null;
    D = d.base_m - prof.ter; top = d.top_m - prof.ter; dth = d.dtheta_k;
  } else {
    if (def === "isentrope") {
      const target = mean(th, 0, 1) + prm.thetaOffsetK;
      const k = th.findIndex((x, i) => i >= 1 && x >= target);
      if (k < 0) return null;
      D = ZS[k];
    } else if (def === "rh") {
      let wasMoist = false, k = -1;
      for (let i = 0; i < ZS.length; i++) { if (rh[i] >= prm.rhPct) wasMoist = true; else if (wasMoist && ZS[i] >= 200) { k = i; break; } }
      if (k < 0) return null;
      D = ZS[k];
    } else if (def === "pbl") {
      if (!(prof.hpbl > 0)) return null;
      D = prof.hpbl;
    }
    const iD = idxOf(D), iW = idxOf(D + prm.windowM);
    dth = mean(th, iD, iW) - mean(th, 0, iD);
    top = D + prm.windowM;
  }
  if (!(D >= 100) || !(dth > 0.3)) return null;                   // no usable cap: Fr undefined
  const iD = idxOf(D), thbar = mean(th, 0, iD), U = mean(spd, 0, iD);
  const c = Math.sqrt((G * dth / thbar) * D);
  return { D, top, dth, thbar, U, c, fr: U / c };
}

// Along the channel axis (frame: ChannelFrame; box: viewBox), every stepKm. Each point:
// {along, lat, lon, c, wind (10 m, m/s), ualong (m/s, + downstream), mslp (mb), t2 (K), caps {def: cap|null}}.
export function channelProfile(vol, frame, box, { surf = null, prm = DEFAULT_PARAMS, stepKm = 2 } = {}) {
  const [a0, a1] = box.alongKm, out = [];
  for (let a = a0; a <= a1 + 1e-6; a += stepKm) {
    const ll = frame.toLatLon(a, 0), q = vol.merc.ij(ll.lat, ll.lon);
    const i = Math.round(q.i - vol.raw.crop.i0), j = Math.round(q.j - vol.raw.crop.j0);
    if (i < 0 || j < 0 || i >= vol.w || j >= vol.h) continue;
    const c = j * vol.w + i;
    const u = surf ? surf.U[c] : vol.sample("U", ll.lat, ll.lon, 10, true), v = surf ? surf.V[c] : vol.sample("V", ll.lat, ll.lon, 10, true);
    const prof = columnProfile(vol, c), caps = {};
    for (const def of Object.keys(CAP_DEFS)) caps[def] = capLayer(prof, def, prm);
    const mslp = vol.raw.surface.MSLP?.[c];
    out.push({ along: a, lat: ll.lat, lon: ll.lon, c, wind: Math.hypot(u, v), ualong: u * frame.ux + v * frame.uy,
               mslp: Number.isFinite(mslp) ? mslp / 100 : NaN, t2: vol.raw.surface.TMP2?.[c], caps, prof });
  }
  return out;
}

// The summary for the time on screen.
export function summarize(pts, { def = "detector", barriers = [] } = {}) {
  if (pts.length < 6) return null;
  const n = pts.length, flow = mean(Float32Array.from(pts, (p) => p.ualong), 0, n - 1);
  const down = flow >= 0;                                        // + along = the frame's downstream direction
  const order = down ? pts : [...pts].reverse();                 // upstream first
  const nUp = Math.max(2, Math.round(n * 0.15));
  const up = order.slice(0, nUp);
  const u0 = mean(Float32Array.from(up, (p) => p.wind), 0, nUp - 1);
  let iMax = nUp;
  for (let k = nUp; k < n; k++) if (order[k].wind > order[iMax].wind) iMax = k;
  const pUp = mean(Float32Array.from(up, (p) => p.mslp), 0, nUp - 1), pMax = order[iMax].mslp;
  const dp = pUp - pMax;                                         // mb, > 0: pressure falls toward the fastest point
  const bern = (frac) => (Number.isFinite(dp) ? Math.sqrt(Math.max(0, u0 * u0 + frac * 2 * dp * 100 / RHO)) : NaN);
  const warmExit = Number.isFinite(order[iMax].t2) && Number.isFinite(up[0].t2) && order[iMax].t2 > mean(Float32Array.from(up, (p) => p.t2), 0, nUp - 1) + 0.5;
  // Froude along the flow for the chosen definition: supercritical stretches and jumps (> 1 → < 1).
  const fr = order.map((p) => p.caps[def]?.fr ?? NaN), jumps = [];
  for (let k = 1; k < n; k++) if (fr[k - 1] > 1 && fr[k] < 1) jumps.push(order[k].along);
  const superPts = fr.filter((x) => x > 1).length, validFr = fr.filter(Number.isFinite).length;
  // Sensitivity: each definition's Froude number at the fastest point, and the spread.
  const byDef = Object.fromEntries(Object.keys(CAP_DEFS).map((d) => [d, order[iMax].caps[d]]));
  const frs = Object.values(byDef).filter(Boolean).map((cp) => cp.fr);
  const spread = frs.length > 1 ? Math.max(...frs) - Math.min(...frs) : NaN;
  const sides = frs.length ? [frs.some((x) => x < 1), frs.some((x) => x > 1)] : [false, false];
  // Upstream regime per barrier: ε = N h / U over the lowest h (upstream column profiles).
  const regimes = barriers.map((b) => {
    const eps = mean(Float32Array.from(up, (p) => {
      const pr = p.prof, iH = idxOf(b.heightM), dth = pr.th[iH] - pr.th[0], thb = mean(pr.th, 0, iH), U = mean(pr.spd, 0, iH);
      const N2 = (G / thb) * (dth / b.heightM);
      return N2 > 0 && U > 0.5 ? (Math.sqrt(N2) * b.heightM) / U : NaN;
    }), 0, nUp - 1);
    const capUp = mean(Float32Array.from(up, (p) => p.caps[def]?.D ?? NaN), 0, nUp - 1);
    return { ...b, eps, cls: !Number.isFinite(eps) ? "–" : eps < 1 ? "linear" : eps < 3 ? "mountain-wave" : "blocked",
             aboveCap: Number.isFinite(capUp) ? b.heightM > capUp : null, capUp };
  });
  return { down, u0, umax: order[iMax].wind, atAlong: order[iMax].along, ratio: order[iMax].wind / u0, dp, bern: bern(1), bern55: bern(0.55),
           warmExit, jumps, superFrac: validFr ? superPts / validFr : NaN, validFr, byDef, spread, robust: frs.length > 1 && !(sides[0] && sides[1]), regimes };
}

// Model sea-level pressure (mb) at a point (nearest cell), or NaN.
export function mslpAt(vol, lat, lon) {
  const q = vol.merc.ij(lat, lon), i = Math.round(q.i - vol.raw.crop.i0), j = Math.round(q.j - vol.raw.crop.j0);
  const a = vol.raw.surface.MSLP;
  if (!a || i < 0 || j < 0 || i >= vol.w || j >= vol.h) return NaN;
  return a[j * vol.w + i] / 100;
}

// The whole grid's two-layer Froude number (one definition), for colouring the slice.
export function froudeField(vol, def, prm = DEFAULT_PARAMS) {
  const out = new Float32Array(vol.n).fill(NaN);
  for (let c = 0; c < vol.n; c++) {
    const cap = capLayer(columnProfile(vol, c), def, prm);
    if (cap) out[c] = cap.fr;
  }
  return out;
}

export const ktOf = (ms) => ms * KT;
