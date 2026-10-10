// Polars for the boats: boat speed (kn) by true wind speed (kn, rows) and true wind angle (°,
// columns), used by the passage planner (routing, sensitivity) and the surface viewer's sailing.
//
//   Pacific Seacraft 37  the owner's PSC 37 polar pack (config/polars/PSC37_Polar_Update_Pack,
//                        2026-10-06): the "Light cruise" table (cruise load, clean bottom, coastal
//                        chop, attentive crew), built from the boat's ORC certificate and a
//                        VPP-class sail model, corrected to its own sails (115% genoa, 312 sq ft
//                        main). The pack's own advice: Light cruise for day sails and coastal hops;
//                        the owner's logged beats in Admiralty Inlet match it. Its Conservative and
//                        Heavy loaded tables are ~6–8% slower: the planner's sensitivity (boat 10% and
//                        20% slower) covers them.
//   Cape George 36       the owner's polar (config/polars/CG36_based_on_Endurance35_6-40kt.txt, from
//                        an Endurance 35 polar), each wind speed's angle/speed pairs resampled onto
//                        the common angles (below its best beat angle, falling to 0 kn at 0°).
//   Cape George 31       no polar of its own: the CG36's scaled to the 31's waterline (speed ∝ √LWL:
//                        √(27.5/31.5) = 0.934). The same Atkin full-keel cutter family with a similar
//                        sail area to displacement (16.2 against 15.9). An estimate.
// Dimensions: sailboatdata.com (CG36: LWL 31.5 ft, 23,300 lb; CG31: LWL 27.5 ft, 15,835 lb).

const PSC_TWA = [0, 40, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];
const PSC_TWS = [6, 8, 10, 12, 15, 18, 20, 25, 30];
const PSC37 = [
  [0.00, 2.94, 3.39, 3.83, 4.20, 4.43, 4.43, 3.99, 3.80, 3.38, 2.96, 2.57, 2.32],
  [0.00, 3.62, 4.12, 4.62, 5.01, 5.27, 5.31, 5.02, 4.76, 4.31, 3.87, 3.40, 3.04],
  [0.00, 4.27, 4.84, 5.22, 5.65, 6.03, 6.06, 5.79, 5.57, 4.95, 4.66, 4.18, 3.78],
  [0.00, 4.86, 5.30, 5.91, 6.12, 6.34, 6.43, 6.38, 6.28, 5.72, 5.38, 4.90, 4.49],
  [0.00, 5.22, 5.87, 6.18, 6.41, 6.68, 6.77, 6.73, 6.68, 6.50, 6.20, 5.79, 5.39],
  [0.00, 5.39, 5.97, 6.22, 6.48, 6.93, 7.05, 7.09, 7.08, 6.85, 6.63, 6.50, 6.29],
  [0.00, 5.35, 5.96, 6.32, 6.54, 6.95, 7.22, 7.25, 7.25, 7.14, 6.93, 6.85, 6.60],
  [0.00, 5.07, 5.82, 6.18, 6.38, 7.02, 7.51, 7.31, 7.19, 7.18, 7.13, 7.01, 6.81],
  [0.00, 4.92, 5.06, 5.76, 6.45, 6.85, 7.01, 6.70, 6.78, 6.91, 6.86, 6.79, 6.68],
];
const CG_TWA = [0, 38, 40, 45, 52, 60, 70, 75, 80, 90, 110, 120, 135, 150, 165, 180];
const CG_TWS = [6, 8, 10, 12, 14, 16, 20, 24, 30, 35, 40];
const CG36 = [
  [0.00, 3.73, 3.93, 4.42, 4.85, 5.13, 5.30, 5.32, 5.30, 5.23, 4.73, 4.52, 4.02, 3.42, 2.97, 2.82],
  [0.00, 4.59, 4.83, 5.31, 5.75, 6.02, 6.17, 6.19, 6.20, 6.15, 5.77, 5.57, 5.08, 4.43, 3.93, 3.74],
  [0.00, 5.25, 5.52, 5.98, 6.40, 6.61, 6.73, 6.76, 6.77, 6.77, 6.57, 6.40, 5.93, 5.31, 4.79, 4.58],
  [0.00, 5.76, 6.07, 6.43, 6.80, 6.96, 7.06, 7.09, 7.11, 7.14, 7.06, 6.95, 6.60, 6.05, 5.53, 5.33],
  [0.00, 6.28, 6.50, 6.72, 7.04, 7.18, 7.28, 7.32, 7.35, 7.39, 7.39, 7.31, 7.06, 6.65, 6.19, 5.99],
  [0.00, 6.41, 6.63, 6.86, 7.18, 7.32, 7.45, 7.50, 7.54, 7.61, 7.67, 7.60, 7.37, 7.06, 6.72, 6.56],
  [0.00, 6.70, 6.79, 7.00, 7.31, 7.48, 7.67, 7.76, 7.84, 7.96, 8.17, 8.13, 7.92, 7.63, 7.39, 7.29],
  [0.00, 6.75, 6.84, 7.06, 7.38, 7.58, 7.82, 7.92, 8.03, 8.22, 8.50, 8.53, 8.44, 8.14, 7.90, 7.70],
  [0.00, 3.72, 3.91, 4.40, 7.30, 7.60, 7.85, 7.92, 8.05, 8.22, 8.50, 8.55, 8.45, 8.20, 7.85, 7.80],
  [0.00, 3.25, 3.42, 3.84, 7.00, 7.55, 7.82, 7.90, 8.00, 8.22, 8.50, 8.55, 8.45, 8.20, 7.85, 7.80],
  [0.00, 3.21, 3.38, 3.80, 6.80, 7.55, 7.82, 7.90, 8.00, 8.22, 8.50, 8.55, 8.45, 8.20, 7.85, 7.80],
];
const CG31 = CG36.map((r) => r.map((v) => +(v * 0.9344).toFixed(2)));   // (scaled: see above)
// hull: the rule-of-thumb hull speed 1.34·√LWL (kn), used to mark surfing; noGo: the closest true
// wind angle the router sails (the polar's best beat angles reach ~38–40°).
export const POLARS = {
  ps37: { name: "Pacific Seacraft 37", twa: PSC_TWA, tws: PSC_TWS, bsp: PSC37, hull: 7.1, noGo: 40, source: "PSC 37 polar pack, Light cruise" },
  cg36: { name: "Cape George 36", twa: CG_TWA, tws: CG_TWS, bsp: CG36, hull: 7.5, noGo: 38, source: "the owner's CG36 polar (from an Endurance 35 polar)" },
  cg31: { name: "Cape George 31", twa: CG_TWA, tws: CG_TWS, bsp: CG31, hull: 7.0, noGo: 38, source: "the CG36 polar scaled to the CG31's waterline (estimate)" },
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
