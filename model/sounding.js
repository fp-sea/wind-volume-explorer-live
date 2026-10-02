// The latest balloon sounding for a site, from the Iowa Environmental Mesonet's RAOB archive
// (mesonet.agron.iastate.edu/json/raob.py: browser-readable; the University of Wyoming's
// isn't). Soundings are at 00Z and 12Z; this looks back launch by launch for the newest one IEM
// has. IEM's copy can lag (Hilo was 8 days behind on 2026-09-27), so the caller shows the age
// and doesn't compare a sounding that's too old.
//
// The profile is run through the same inversion detector as the model (twi.js), on the
// balloon's full resolution, and the same 850-925 mb trade-wind speed is taken (75th percentile).

import { detectColumn, pct75, riskFlag, tiiClass } from "./twi.js?v=20261002173952";

const IEM = "https://mesonet.agron.iastate.edu/json/raob.py";
const cache = new Map();                           // IEM id → {at, result}

// RH (%) from temperature and dewpoint (°C), Magnus form (as twi.js's dewpoint uses).
const rhOf = (t, td) => {
  const a = 17.625, b = 243.04;
  return 100 * Math.exp((a * td) / (b + td) - (a * t) / (b + t));
};

async function fetchAt(id, t) {
  const ts = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}${String(t.getUTCHours()).padStart(2, "0")}00`;
  const r = await fetch(`${IEM}?station=${encodeURIComponent(id)}&ts=${ts}`);
  if (!r.ok) return null;
  const p = (await r.json()).profiles?.[0];
  return p?.profile?.length > 10 ? p : null;
}

// {valid (Date), det (detector result), llwKt, flag (Hawaiʻi only), cls} or {error}. maxBackDays: how far back to look for the newest.
export async function latestSounding(id, { maxBackDays = 12, region = null } = {}) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.result;
  let result = { error: "no sounding found" };
  try {
    const now = new Date(), t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() >= 12 ? 12 : 0));
    // Four launches at a time, newest first (a lagging archive otherwise means a dozen round trips in a row).
    let p = null;
    for (let k = 0; k < maxBackDays * 2 && !p; k += 4) {
      const batch = await Promise.all([0, 1, 2, 3].map((q) => fetchAt(id, new Date(t.getTime() - (k + q) * 12 * 3600e3)).catch(() => null)));
      p = batch.find(Boolean) || null;
    }
    if (p) {
      const rows = p.profile.filter((q) => q.pres != null && q.hght != null && q.tmpc != null && q.dwpc != null);
      const P = rows.map((q) => q.pres), Z = rows.map((q) => q.hght), T = rows.map((q) => q.tmpc + 273.15), RH = rows.map((q) => rhOf(q.tmpc, q.dwpc));
      const det = detectColumn(T, RH, Z, P, { terrainM: Z[0] - 6 });
      const llwKt = pct75(p.profile.filter((q) => q.pres >= 850 && q.pres <= 925 && q.sknt != null && q.sknt >= 0 && q.sknt <= 80).map((q) => q.sknt));
      result = { valid: new Date(p.valid), det, llwKt, cls: tiiClass(det.base_m != null ? det.tii : NaN), flag: region === "hawaii" ? riskFlag(det.tii, llwKt) : null };
    }
  } catch (e) { result = { error: e.message }; }
  cache.set(id, { at: Date.now(), result });
  return result;
}
