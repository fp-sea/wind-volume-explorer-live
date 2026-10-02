// Approximate polars for the inspector's boats: boat speed (kn) by true wind speed (kn) and true
// wind angle (°). ESTIMATES, not measured or ORC polars: built for heavy, full-keel cruising
// cutters from their waterline (hull speed ≈ 1.34 √LWL ft: Cape George 31 ≈ 6.8 kn, Pacific
// Seacraft 37 ≈ 7.1 kn), with modest light-air speed, pointing no higher than ~45°, best speed on a
// reach, and a little lost upwind in 25 kt (reefed, pounding). To use real polars, replace a
// table here (same layout: rows TWS, columns TWA).

const TWA = [45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];
const TWS = [6, 8, 10, 12, 14, 16, 20, 25];
const CG31 = [
  [3.0, 3.5, 3.9, 4.3, 4.5, 4.4, 4.2, 3.8, 3.3, 2.9, 2.7],
  [3.9, 4.5, 4.9, 5.3, 5.5, 5.4, 5.2, 4.8, 4.3, 3.8, 3.6],
  [4.6, 5.2, 5.6, 6.0, 6.2, 6.1, 6.0, 5.6, 5.1, 4.6, 4.3],
  [5.0, 5.6, 6.0, 6.3, 6.5, 6.5, 6.4, 6.1, 5.7, 5.2, 4.9],
  [5.2, 5.8, 6.2, 6.5, 6.7, 6.7, 6.7, 6.5, 6.1, 5.7, 5.4],
  [5.3, 5.9, 6.3, 6.6, 6.8, 6.9, 6.9, 6.8, 6.5, 6.1, 5.8],
  [5.2, 5.9, 6.3, 6.7, 6.9, 7.1, 7.2, 7.1, 6.9, 6.6, 6.3],
  [4.8, 5.6, 6.1, 6.6, 6.9, 7.2, 7.4, 7.4, 7.2, 7.0, 6.7],
];
export const POLARS = {
  cg31: { name: "Cape George 31", twa: TWA, tws: TWS, bsp: CG31, hull: 6.8 },
  ps37: { name: "Pacific Seacraft 37", twa: TWA, tws: TWS, bsp: CG31.map((r) => r.map((v) => +(v * 1.05).toFixed(2))), hull: 7.1 },
};

// Points of sail offered in the viewer (true wind angle, °).
export const POINTS = [
  { id: "beat", label: "close-hauled", twa: 48 },
  { id: "close", label: "close reach", twa: 60 },
  { id: "beam", label: "beam reach", twa: 90 },
  { id: "broad", label: "broad reach", twa: 135 },
  { id: "run", label: "running", twa: 170 },
];

// Boat speed (kn) at tws (kn) and twa (°, 0-180), bilinear in the table (held at its edges;
// below the lightest row, scaled down toward 0 kn at 0 kt).
export function boatSpeed(key, tws, twa) {
  const P = POLARS[key] || POLARS.cg31, a = Math.min(180, Math.max(P.twa[0], Math.abs(twa)));
  const idx = (arr, x) => { let i = 0; while (i < arr.length - 2 && arr[i + 1] < x) i++; return [i, Math.max(0, Math.min(1, (x - arr[i]) / (arr[i + 1] - arr[i])))]; };
  const [ia, fa] = idx(P.twa, a), s = Math.max(0, tws);
  const row = (r) => P.bsp[r][ia] + (P.bsp[r][ia + 1] - P.bsp[r][ia]) * fa;
  if (s <= P.tws[0]) return row(0) * (s / P.tws[0]);
  const [is, fs] = idx(P.tws, Math.min(s, P.tws[P.tws.length - 1]));
  return row(is) + (row(is + 1) - row(is)) * fs;
}

// Apparent wind from true wind (from twd °, tws) and the boat (heading hdg °, bsp; same units).
// → {aws, awd (from, °), awa (−180…180: + starboard, − port)}.
export function apparent(twd, tws, hdg, bsp) {
  const r = Math.PI / 180, to = (twd + 180) * r;
  const wx = tws * Math.sin(to) - bsp * Math.sin(hdg * r), wy = tws * Math.cos(to) - bsp * Math.cos(hdg * r);   // air relative to the boat
  const aws = Math.hypot(wx, wy), awd = ((Math.atan2(-wx, -wy) / r) + 360) % 360;
  return { aws, awd, awa: ((awd - hdg + 540) % 360) - 180 };
}
