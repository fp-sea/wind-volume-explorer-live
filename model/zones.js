// NWS coastal waters forecasts (CWF) for the region's marine zones: the forecaster's wind, seas
// and "Wave Detail" trains, read live from api.weather.gov (CORS open) and parsed per zone and
// period. A JavaScript port of zone_wave_parser.py, extended for Seattle's abbreviated style
// ("NW wind 5 to 10 kt", "Waves around 2 ft or less", "MON NIGHT").
//
// Periods carry names, not times. Each period is placed with the usual day (6 am-6 pm) and
// night (6 pm-6 am) split in the issuing office's local time, starting from the issue time;
// the boundaries are approximate, as they are in the text itself.
//
// Each train is labelled wind sea (chop) or swell: chop when its period is 6 s or less, or when
// it comes from within 45° of that period's wind with a period that wind could raise
// (≤ 0.6 U + 2 s, U the top wind speed in m/s); otherwise swell.

const API = "https://api.weather.gov";
const WORDS = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 };
const ABBR = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const TZ = { HST: -10, AKST: -9, AKDT: -8, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4 };
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// "east northeast" / "ENE" / "and south" → degrees (from), or null (variable, unknown).
export function dirDeg(phrase) {
  const p = phrase.trim().replace(/^and\s+/i, "");
  if (ABBR[p.toUpperCase()] != null && p.length <= 3) return ABBR[p.toUpperCase()];
  const w = p.toLowerCase().split(/\s+/);
  if (w.length === 1) return WORDS[w[0]] ?? null;
  if (w.length === 2 && WORDS[w[0]] != null && WORDS[w[1]] != null) {  // "east northeast": halfway, toward the second
    const a = WORDS[w[0]], b = WORDS[w[1]], d = ((b - a + 540) % 360) - 180;
    return (a + d / 2 + 360) % 360;
  }
  return null;
}
const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const unit = "(?:knots|kt)", ft = "(?:feet|ft)";

// One period's text → {wind: {dir, min, max}, seas: {min, max, then?}, waves (inland), trains}.
export function parsePeriod(body) {
  const t = body.replace(/\s+/g, " ").trim();
  let wind = null, m;
  if ((m = t.match(new RegExp(`([A-Za-z ]+?)\\s+winds?\\s+(?:(\\d+)\\s+to\\s+(\\d+)|around\\s+(\\d+)|(\\d+)\\s+${unit}\\s+or\\s+less|less\\s+than\\s+(\\d+)|to\\s+(\\d+))`, "i")))) {
    const dir = dirDeg(m[1].split(/[.,]/).pop());
    const min = m[2] ? +m[2] : m[4] ? +m[4] : 0, max = m[3] ? +m[3] : m[4] ? +m[4] : +(m[5] || m[6] || m[7]);
    wind = { dir, min, max };
  }
  const range = (re) => {
    const r = t.match(re);
    if (!r) return null;
    if (r[1]) return { min: +r[1], max: +r[2] };
    if (r[3]) return { min: +r[3], max: +r[3] };
    return { min: 0, max: +(r[4] || r[5] || r[6]) };
  };
  const num = `(?:(\\d+)\\s+to\\s+(\\d+)|around\\s+(\\d+)(?!\\s+${ft}\\s+or\\s+less)|(?:around\\s+|to\\s+)?(\\d+)\\s+${ft}\\s+or\\s+less|less\\s+than\\s+(\\d+)|to\\s+(\\d+))`;
  const seas = range(new RegExp(`Seas\\s+${num}`, "i")), waves = range(new RegExp(`Waves\\s+${num}`, "i"));
  const then = t.match(new RegExp(`Seas[^.]*?,\\s*(building|subsiding)\\s+to\\s+(\\d+)\\s+to\\s+(\\d+)\\s+${ft}`, "i"));
  if (seas && then) seas.then = { trend: then[1].toLowerCase(), min: +then[2], max: +then[3] };
  const trains = [], wd = t.match(/Wave Detail:\s*(.+?)\.(?:\s|$)/i);
  if (wd) {
    const U = wind ? wind.max * 0.514444 : 0, tpMax = Math.max(6, 0.6 * U + 2);
    for (const piece of wd[1].split(/,\s*|\s+and\s+/)) {
      const q = piece.match(new RegExp(`^([A-Za-z ]+?)\\s+(\\d+)\\s+${ft}\\s+at\\s+(\\d+)\\s+seconds`, "i"));
      if (!q) continue;
      const dir = dirDeg(q[1]), tr = { dir, ft: +q[2], tp: +q[3] };
      tr.kind = tr.tp <= 6 || (dir != null && wind?.dir != null && angle(dir, wind.dir) <= 45 && tr.tp <= tpMax) ? "chop"
              : (dir == null || wind?.dir == null) && tr.tp <= 7 ? "chop" : "swell";
      trains.push(tr);
    }
  }
  return { wind, seas, waves, trains, text: t };
}

// Local wall time (ms, as if UTC) → UTC Date, for a fixed offset (h).
const utc = (localMs, off) => new Date(localMs - off * 3600e3);

// A whole CWF product → {issued: Date, offset, zones: {PHZ121: {name, headline, periods: [...]}}}.
export function parseCwf(text) {
  const iss = text.match(/^(\d{1,4})\s+(AM|PM)\s+([A-Z]{3,4})\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})\s*$/m);
  if (!iss) throw new Error("couldn't read the forecast's issue time");
  const hhmm = iss[1].padStart(3, "0"), off = TZ[iss[3]] ?? 0;
  let h = +hhmm.slice(0, -2) % 12; if (iss[2] === "PM") h += 12;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(iss[4]);
  const issueLocal = Date.UTC(+iss[6], mon, +iss[5], h, +hhmm.slice(-2));
  const out = { issued: utc(issueLocal, off), offset: off, tz: iss[3], zones: {} };
  for (const sec of text.split(/\n\$\$/)) {
    const lines = sec.replace(/^\s+/, "").split("\n");
    let k = 0, ugc = "";
    while (k < lines.length && /^[A-Z]{2}Z[\d>-]+$/.test(lines[k].trim()) === false && k < 3) k++;
    while (k < lines.length && /^[A-Z0-9>-]+$/.test(lines[k].trim()) && lines[k].trim()) ugc += lines[k++].trim();
    const ids = expandUgc(ugc);
    if (!ids.length) continue;
    const name = (lines[k] || "").replace(/-\s*$/, "").trim(), body = lines.slice(k + 1).join("\n");
    const hl = body.match(/^\.\.\.([\s\S]+?)\.\.\.\s*$/m);
    const periods = [];
    const re = /^\.([A-Z][A-Z ]*?)\.\.\.([\s\S]*?)(?=^\.[A-Z][A-Z ]*?\.\.\.|(?![\s\S]))/gm;
    let pm;
    while ((pm = re.exec(body))) periods.push({ name: pm[1].trim(), ...parsePeriod(pm[2]) });
    placePeriods(periods, issueLocal, off);
    const z = { name, headline: hl ? hl[1].replace(/\s+/g, " ").trim() : null, periods };
    for (const id of ids) out.zones[id] = z;
  }
  return out;
}

// "PZZ133>135-281015-" → ["PZZ133", "PZZ134", "PZZ135"]; "PHZ117-118-281330-" → two.
export function expandUgc(ugc) {
  const out = [];
  let pre = null;
  for (const tok of ugc.split("-").filter(Boolean)) {
    let m = tok.match(/^([A-Z]{2}Z)(\d{3})(?:>(\d{3}))?$/);
    if (m) pre = m[1]; else if (pre && (m = tok.match(/^()(\d{3})(?:>(\d{3}))?$/))) {} else continue;
    const a = +m[2], b = m[3] ? +m[3] : a;
    for (let n = a; n <= b; n++) out.push(`${pre}${String(n).padStart(3, "0")}`);
  }
  return out;
}

// Start and end (UTC) for each period from its name, in order from the issue time.
function placePeriods(periods, issueLocal, off) {
  const day0 = Math.floor(issueLocal / 86400e3) * 86400e3, H = 3600e3;
  let prev = issueLocal;
  for (const p of periods) {
    const n = p.name.toUpperCase();
    let s;
    if (/^(TODAY|THIS AFTERNOON|THIS MORNING|REST OF TODAY|OVERNIGHT)$/.test(n)) s = issueLocal;
    else if (/^(TONIGHT|THIS EVENING|REST OF TONIGHT)$/.test(n)) s = Math.max(issueLocal, day0 + 18 * H);
    else {
      const night = / NIGHT$/.test(n), d = DAYS.indexOf(n.replace(/ NIGHT$/, "").slice(0, 3));
      if (d < 0) { s = prev; } else {
        s = day0 + (night ? 18 : 6) * H;
        while (new Date(s).getUTCDay() !== d || s < prev) s += 86400e3;
      }
    }
    p.startLocal = s; prev = s;
  }
  periods.forEach((p, i) => {
    const end = periods[i + 1]?.startLocal ?? p.startLocal + 12 * H;
    p.start = utc(p.startLocal, off); p.end = utc(end, off);
    delete p.startLocal;
  });
}

// The period covering a valid time (Date), or null (before the issue time or past the last).
export function periodAt(zone, valid) {
  return zone?.periods.find((p) => valid >= p.start && valid < p.end) || null;
}

// The latest CWF text for an office (HFO, SEW), cached for 20 minutes.
const cache = new Map();
export async function loadCwf(office, { signal } = {}) {
  const c = cache.get(office);
  if (c && Date.now() - c.at < 20 * 60e3) return c.p;
  const p = (async () => {
    const list = await (await fetch(`${API}/products/types/CWF/locations/${office}`, { signal })).json();
    const id = list["@graph"]?.[0]?.id;
    if (!id) throw new Error(`no ${office} coastal waters forecast`);
    const prod = await (await fetch(`${API}/products/${id}`, { signal })).json();
    return parseCwf(prod.productText);
  })();
  cache.set(office, { at: Date.now(), p });
  p.catch(() => cache.delete(office));
  return p;
}

// Zone outlines (web/data/<region>/zones.json): which zone contains a point.
export class ZoneMap {
  constructor(meta) { Object.assign(this, meta); }
  static async load(regionId) {
    const r = await fetch(`data/${regionId}/zones.json`, { cache: "no-cache" });   // revalidate: edits show on the next load
    return r.ok ? new ZoneMap(await r.json()) : null;
  }
  at(lat, lon) {
    for (const z of this.zones) for (const ring of z.rings) if (inside(ring, lon, lat)) return z;
    return null;
  }
  byId(id) { return this.zones.find((z) => z.id === id) || null; }
}
function inside(ring, x, y) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Short text for a period: "E 25–30 kt · seas 11–15 ft · ENE 14 ft at 8 s (chop), SSW 4 ft at 13 s (swell)".
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (d) => (d == null ? "variable" : COMPASS[Math.round(d / 22.5) % 16]);
const rng = (r) => (r.min === r.max ? `${r.max}` : r.min === 0 ? `≤ ${r.max}` : `${r.min}–${r.max}`);
export function periodSummary(p) {
  const bits = [];
  if (p.wind) bits.push(`${compass(p.wind.dir)} ${rng(p.wind)} kt`);
  if (p.seas) bits.push(`seas ${rng(p.seas)} ft${p.seas.then ? `, ${p.seas.then.trend} to ${rng(p.seas.then)}` : ""}`);
  else if (p.waves) bits.push(`waves ${rng(p.waves)} ft`);
  if (p.trains.length) bits.push(p.trains.map((t) => `${compass(t.dir)} ${t.ft} ft at ${t.tp} s (${t.kind})`).join(", "));
  return bits.join(" · ");
}
