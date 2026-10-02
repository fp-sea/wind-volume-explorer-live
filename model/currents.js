// Tidal currents from NOAA's current predictions (CO-OPS), and what they do to waves.
//
// Stations: web/data/<region>/currents.json (pipeline/currents.py), ~170 on the Salish Sea.
// Predictions: NOAA's own (api.tidesandcurrents.noaa.gov, interval=MAX_SLACK: the times and speeds
// of slack water and maximum flood and ebb, the same form for harmonic and subordinate stations),
// fetched a year at a time by pipeline/currents.py and stored per month with the site; tidal
// predictions don't change with the weather, and ~170 live requests a visit get throttled. Between them the speed follows NOAA's usual sine curve
// (slack → max over a quarter wave), along the station's flood or ebb direction. These are
// tidal predictions: no wind-driven or river currents, and only at the stations; between
// stations the current is taken from the nearest ones within a few km (currents change sharply
// round points and in passes, so it's left blank farther out rather than guessed).
//
// Waves on a current (deep water, a wave train meeting a current U along its direction of travel;
// U < 0 against the waves): its frequency seen from the ground is fixed, so against the current it
// slows and shortens, and to carry the same energy flux its height grows,
//   c/c0 = ½(1 + √(1 + 4U/c0)),  H/H0 = c0 / √(c (c + 2U))       (Longuet-Higgins & Stewart 1961)
// with c0 = g/ω. At U = −c0/4 the waves can't make headway and break (blocking). Steepness Hs/L
// is what makes a sea dangerous: over ~0.07 it's steep and short, near 0.1 it breaks.

const G = 9.80665, KT = 0.514444;
const STORE = new Map();                      // region id → Promise of the station list

export async function currentStations(regionId) {
  if (!STORE.has(regionId)) STORE.set(regionId, fetch(`data/${regionId}/currents.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null)).then((d) => d?.stations || []).catch(() => []));
  return STORE.get(regionId);
}

const ymdhm = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

// Predictions for every station from t0 to t1 (Dates), from the months stored with the site
// (pipeline/currents.py fetches NOAA's predictions a year at a time):
// [{...station, ev: [{t ms, v kt (flood +), type}], flood, ebb}]. Stations with no events in the span are left out.
export async function loadCurrents(regionId, t0, t1, { signal } = {}) {
  const meta = await fetch(`data/${regionId}/currents.json`, { cache: "no-cache", signal }).then((r) => (r.ok ? r.json() : null));
  if (!meta?.months?.length) throw new Error("no stored predictions for this region");
  const a = new Date(t0.getTime() - 8 * 3600e3), b = new Date(t1.getTime() + 8 * 3600e3), want = [];
  for (let d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1)); d <= b; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
    want.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  const have = want.filter((m) => meta.months.includes(m));
  if (!have.length) throw new Error(`the stored predictions cover ${meta.from} to ${meta.until}; this run is outside them`);
  const files = await Promise.all(have.map((m) => fetch(`data/${regionId}/currents/${m}.json`, { signal }).then((r) => r.json())));
  const TYPE = { s: "slack", f: "flood", e: "ebb" };
  const out = meta.stations.map((s) => {
    const ev = [];
    for (const f of files) {
      const m0 = Date.parse(f.minutesFrom);
      for (const [min, v, ty] of f.stations[s.id] || []) { const t = m0 + min * 60e3; if (t >= a.getTime() - 12 * 3600e3 && t <= b.getTime() + 12 * 3600e3) ev.push({ t, v, type: TYPE[ty] }); }
    }
    return { ...s, ev };
  }).filter((s) => s.ev.length >= 2);
  out.until = meta.until;                                                    // the stored span's end (refresh before it)
  return out;
}

// Signed speed (kt, flood +) at time t (ms): between successive events, a sine from slack to max
// and back (NOAA's standard shape); at the ends, held.
export function stationSpeed(s, t) {
  const e = s.ev;
  if (!e.length) return 0;
  if (t <= e[0].t) return e[0].v;
  for (let i = 0; i < e.length - 1; i++) {
    const a = e[i], b = e[i + 1];
    if (t > b.t) continue;
    const f = (t - a.t) / Math.max(1, b.t - a.t);
    if (a.type === "slack" && b.type !== "slack") return b.v * Math.sin((f * Math.PI) / 2);
    if (a.type !== "slack" && b.type === "slack") return a.v * Math.cos((f * Math.PI) / 2);
    return a.v + (b.v - a.v) * (1 - Math.cos(f * Math.PI)) / 2;       // max to max (no slack between): smooth
  }
  return e[e.length - 1].v;
}

// A station's current at t: {kt, set (° toward), u, v (m/s, toward east / north)}.
export function stationCurrent(s, t) {
  const v = stationSpeed(s, t), dir = v >= 0 ? s.flood : s.ebb, r = (dir * Math.PI) / 180, ms = Math.abs(v) * KT;
  return { kt: Math.abs(v), set: dir, u: ms * Math.sin(r), v: ms * Math.cos(r) };
}

// The current at scene point (x, y) km from the stations (with scene x/y) within R km: the nearest
// one's if it's close, else inverse-distance weighted (1/d²) between up to three; null if none.
export function currentNear(stations, x, y, t, R = 5) {
  const near = [];
  for (const s of stations) { const d = Math.hypot(s.x - x, s.y - y); if (d <= R) near.push([d, s]); }
  if (!near.length) return null;
  near.sort((a, b) => a[0] - b[0]);
  let wu = 0, wv = 0, w = 0;
  for (const [d, s] of near.slice(0, 3)) { const c = stationCurrent(s, t), k = 1 / Math.max(0.25, d) ** 2; wu += c.u * k; wv += c.v * k; w += k; }
  const u = wu / w, v = wv / w;
  return { u, v, kt: Math.hypot(u, v) / KT, set: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, station: near[0][1], km: near[0][0] };
}

// A wave train of period tp (s) on a current U (m/s) along its direction of travel (negative:
// against it): height factor, new wavelength (m), and whether it's blocked (breaks).
export function waveOnCurrent(tp, U) {
  const w = (2 * Math.PI) / tp, c0 = G / w, r = 1 + (4 * U) / c0;
  if (r <= 0.02) return { mul: 3, L: (2 * Math.PI * (c0 / 2) ** 2) / G, blocked: true };      // at blocking c = c0/2: a quarter of the wavelength
  const c = (c0 / 2) * (1 + Math.sqrt(r));
  return { mul: Math.min(3, c0 / Math.sqrt(c * (c + 2 * U))), L: (2 * Math.PI * c * c) / G, blocked: false };
}

// Chop (hs m, tp s, travelling toward the wind's direction wx, wy unit) on a current (u, v m/s):
// height (capped at the breaking steepness 0.1), steepness before and after, and a rating:
// 0 fine; 1 steep: against a current over ~0.3 kt, 40%+ steeper than without it (Hs/L ≥ 0.055)
// and over ~1.1 ft; 2 dangerous: breaking-steep (Hs/L ≥ 0.08, or blocked) and over ~2.5 ft.
export function chopOnCurrent(hs, tp, wx, wy, u, v) {
  const U = u * wx + v * wy, L0 = (G * tp * tp) / (2 * Math.PI), r = waveOnCurrent(tp, U);
  const h = Math.min(hs * r.mul, 0.1 * r.L), s0 = hs / L0, s1 = h / r.L;
  // Rated by steepness and size: steep, short chop under a foot is a tide rip's texture, not a hazard.
  const big = Math.max(h, hs), vsteep = r.blocked || s1 >= 0.08, steepened = s1 >= 0.055 && s1 >= 1.4 * s0;
  const rating = U > -0.15 ? 0 : vsteep && big >= 0.75 ? 2 : (vsteep || steepened) && big >= 0.35 ? 1 : 0;
  return { hs: h, L: r.L, steep0: s0, steep: s1, mul: h / Math.max(1e-6, hs), U, rating, blocked: r.blocked };
}
