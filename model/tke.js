// HRRR's turbulent kinetic energy (TKE, m²/s²): the model's own measure of how turbulent the air
// is (its MYNN boundary-layer scheme), on its native (hybrid) levels 1-16, from 10 m to ~3.9 km
// above ground. Read from the wrfnat file (the pressure-level file has none), ~5 MB an hour for
// the whole CONUS messages, cropped to the region. Level heights above ground come from a fixed
// table (models.json "tke.aglM", measured once by scripts/hrrr_hybrid_heights.mjs): the low levels
// follow the terrain, so their heights barely change. HRRR only: RRFS Hawaiʻi has no TKE.
//
// As a rough guide, the turbulent wind fluctuation is σ ≈ √(2/3 · TKE): TKE 0.5 → ~0.6 m/s,
// 2 → ~1.2 m/s, 5 → ~1.8 m/s.

import { fileUrl, decodeCropped } from "./rrfs.js?v=20261002173952";
import { fetchIdx, fetchMessages } from "./fetch.js?v=20261002173952";

// One hour's TKE: {agl: [m], data: [Float32Array per level, crop-sized]}.
export async function loadTke(model, cycle, fhr, crop, { signal } = {}) {
  const cfg = model.tke, url = fileUrl(model, cycle, fhr, { which: "pathNat" });
  const idx = await fetchIdx(url, { signal });
  const keys = Array.from({ length: cfg.levels }, (_, k) => `TKE:${k + 1} hybrid level`);
  const msgs = await fetchMessages(url, keys, { idx, signal });
  const box = { i0: crop.i0, j0: crop.j0, w: crop.w, h: crop.h };
  const data = await Promise.all(keys.map((k) => decodeCropped(msgs.get(k), box).then((r) => r.values)));
  return { agl: cfg.aglM, data };
}

// TKE at cell c, height agl (m above ground): linear between levels; held below the lowest,
// NaN above the highest.
export function tkeAt(T, c, agl) {
  if (!T) return NaN;
  const L = T.agl;
  if (agl <= L[0]) return T.data[0][c];
  for (let k = 0; k < L.length - 1; k++) {
    if (agl <= L[k + 1]) { const f = (agl - L[k]) / (L[k + 1] - L[k]); return T.data[k][c] + (T.data[k + 1][c] - T.data[k][c]) * f; }
  }
  return NaN;
}
