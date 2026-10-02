// The weather a sailor feels, along a passage and at the surface viewer's spot: air temperature
// and dewpoint (2 m), visibility, rain (the model's radar echo 1 km up and its rain rate), cloud
// (total and low) with the ceiling, and lightning. For the route report, the planner's table and
// tag, and the viewer's sky, fog and rain.
//
// Where it comes from (the lightest source that has it):
//   Salish Sea  HRRR, from the Utah HRRR Zarr: each 150 × 150-cell tile holds every hour of the
//               run, so a passage costs a few MB a tile (~7 MB for all the fields, 48 h), once,
//               shared with the viewer (model/hrrrzarr.js zarrTiles).
//   Hawaiʻi     RRFS Hawaiʻi, each hour's GRIB by byte range (~0.5 MB an hour for all the fields).
//   beyond      GFS 0.25°, 3-hourly, fewer fields (temperature, dewpoint, visibility, rain rate,
//               cloud: ~3 MB a step, as its fields cover the globe) for hours past the run.
//
// → a Weather: sample(lat, lon, t) → {t2, td (°C), vis (m), dbz, rain (mm/h), tcc, lcc (%),
//   ceil (m, NaN: none), ltng, src} or null outside the loaded hours; the sources' labels; bytes.

import { zarrTiles, runLength } from "../model/hrrrzarr.js?v=20261002173952";
import { fileUrl, cropFor, decodeCropped } from "../model/rrfs.js?v=20261002173952";
import { fetchIdx, fetchMessages, pool } from "../model/fetch.js?v=20261002173952";
import { decodeMessage } from "../model/grib2.js?v=20261002173952";
import { gridOf } from "../model/volume.js?v=20261002173952";
import { latestGlobal, GFS, GRID025, boxFor } from "./global.js?v=20261002173952";

const FIELDS = [
  { k: "t2", zarr: ["2m_above_ground", "TMP"], grib: ["TMP:2 m above ground"], conv: (v) => v - 273.15 },
  { k: "td", zarr: ["2m_above_ground", "DPT"], grib: ["DPT:2 m above ground"], conv: (v) => v - 273.15 },
  { k: "vis", zarr: ["surface", "VIS"], grib: ["VIS:surface"] },
  { k: "dbz", zarr: ["1000m_above_ground", "REFD"], grib: ["REFD:1000 m above ground", "REFC:entire atmosphere (considered as a single layer)"] },
  { k: "rain", zarr: ["surface", "PRATE"], grib: ["PRATE:surface"], conv: (v) => Math.max(0, v * 3600) },   // kg m⁻² s⁻¹ → mm/h
  { k: "tcc", zarr: ["entire_atmosphere", "TCDC"], grib: ["TCDC:entire atmosphere (considered as a single layer)", "TCDC:entire atmosphere"] },
  { k: "lcc", zarr: ["low_cloud_layer", "LCDC"], grib: ["LCDC:low cloud layer"] },
  { k: "ceil", zarr: ["cloud_ceiling", "HGT"], grib: ["HGT:cloud ceiling"], conv: (v) => (v > 15000 || v < 0 ? NaN : v) },
  { k: "ltng", zarr: ["entire_atmosphere", "LTNG"], grib: ["LTNG:entire atmosphere"] },
];
const GFS_FIELDS = ["t2", "td", "vis", "rain", "tcc", "lcc"];   // (radar, ceiling and lightning cost ~1 MB more each a step there)
const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// Bilinear in a field read by cell (NaN cells left out).
function bilinear(read, i, j) {
  const i0 = Math.floor(i), j0 = Math.floor(j), fi = i - i0, fj = j - j0;
  let s = 0, w = 0;
  for (const [a, b, q] of [[0, 0, (1 - fi) * (1 - fj)], [1, 0, fi * (1 - fj)], [0, 1, (1 - fi) * fj], [1, 1, fi * fj]]) {
    const v = read(i0 + a, j0 + b);
    if (Number.isFinite(v) && q > 0) { s += v * q; w += q; }
  }
  return w > 0 ? s / w : NaN;
}

export class Weather {
  constructor(parts, bytes) { Object.assign(this, { parts, bytes }); this.labels = parts.map((p) => p.label); }
  covers(t) { return this.parts.some((p) => t >= p.times[0] && t <= p.times.at(-1)); }
  sample(lat, lon, t) {
    const p = this.parts.find((q) => t >= q.times[0] && t <= q.times.at(-1));
    if (!p) return null;
    let k = 0; while (k < p.times.length - 2 && p.times[k + 1] <= t) k++;
    const f = p.times.length > 1 ? Math.min(1, Math.max(0, (t - p.times[k]) / (p.times[k + 1] - p.times[k]))) : 0;
    const out = { src: p.label };
    for (const F of FIELDS) {
      if (!p.has.has(F.k)) continue;
      const a = p.val(F.k, k, lat, lon), b = p.times.length > 1 ? p.val(F.k, k + 1, lat, lon) : a;
      const v = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(a) ? a : b;
      out[F.k] = F.conv && Number.isFinite(v) ? F.conv(v) : v;
    }
    if (Number.isFinite(out.ceil) && out.tcc < 50) out.ceil = NaN;                      // (no ceiling under broken cloud)
    return out;
  }
}

// HRRR from the Zarr: the run itself if it's there with the hours, else the newest that is.
async function hrrrPart(model, cycle, bbox, t0, t1, opts) {
  const need = (c) => Math.ceil((t1 - c.getTime()) / 3600e3);
  const cands = [cycle];
  for (let h = Math.floor(Date.now() / 3600e3) * 3600e3, k = 0; k < 24; k++, h -= 3600e3) cands.push(new Date(h));
  let pick = null, best = null;
  for (const c of cands) {
    const max = Math.max(-1, ...model.cycles.filter((q) => q.hours.includes(c.getUTCHours())).map((q) => q.maxFhr));
    if (max < 0 || c.getTime() > t0 + 3600e3) continue;
    const n = await runLength(c, opts).catch(() => 0);
    if (!n) continue;
    if (n - 1 >= Math.min(need(c), max)) { pick = c; break; }
    if (!best || c.getTime() + (n - 1) * 3600e3 > best.getTime() + best.n * 3600e3) { best = c; best.n = n - 1; }
    if (c !== cycle && need(c) > 48) break;                       // (no run reaches: take the best seen)
  }
  pick ||= best;
  if (!pick) return null;
  const z = await zarrTiles(pick, bbox, FIELDS.map((F) => [...F.zarr, F.k]), opts);
  if (!z) return null;
  const c = pick.getTime();
  return { label: `HRRR ${pad(pick.getUTCHours())}Z`, res: "3 km", has: new Set(FIELDS.map((F) => F.k)), bytes: z.bytes,
           times: z.hours.map((h) => c + h * 3600e3),
           val: (key, k, lat, lon) => { const q = z.grid.ij(lat, lon); return bilinear((i, j) => z.get(key, k, i, j), q.i, q.j); } };
}

// Per-hour (or per-step) GRIB fields cropped to `box`: → part.
function gribPart(label, res, grid, box, frames) {
  const times = [...frames.keys()].sort((a, b) => a - b), has = new Set();
  for (const f of frames.values()) for (const k of Object.keys(f)) has.add(k);
  return { label, res, has, times, val: (key, k, lat, lon) => {
    const a = frames.get(times[k])?.[key]; if (!a) return NaN;
    const q = grid.ij(lat, lon);
    return bilinear((i, j) => { const x = i - box.i0, y = j - box.j0; return x < 0 || y < 0 || x >= box.w || y >= box.h ? NaN : a[y * box.w + x]; }, q.i, q.j);
  } };
}
// The wanted fields' messages in one file, instantaneous where the file also has hour means or
// maxima (fetchMessages keeps one message a key).
async function gribFields(url, keys, box0, opts, onBytes) {
  const idx = await fetchIdx(url, opts), pickd = [], got = {};
  for (const F of FIELDS.filter((q) => keys.includes(q.k))) {
    const cands = idx.filter((e) => F.grib.includes(e.key));
    const e = cands.find((q) => /^\d+ hour fcst$|^anl$/.test(q.step)) || cands[0];
    if (e) pickd.push([F.k, e]);
  }
  if (!pickd.length) return { got, grid: null, box: null };
  const msgs = await fetchMessages(url, pickd.map(([, e]) => e.key), { idx: pickd.map(([, e]) => e), signal: opts.signal, onBytes });
  let grid = null, box = box0;
  for (const [k, e] of pickd) {
    const m = msgs.get(e.key); if (!m) continue;
    if (!box) { grid = gridOf(decodeMessage(m).grid); box = cropFor(grid, opts.bbox, 1); }
    got[k] = (await decodeCropped(m, box)).values;
  }
  return { got, grid, box };
}

async function modelPart(model, cycle, bbox, t0, t1, opts, onBytes) {
  const c = cycle.getTime(), max = Math.max(-1, ...model.cycles.filter((q) => q.hours.includes(cycle.getUTCHours())).map((q) => q.maxFhr));
  const hours = [];
  for (let f = Math.max(0, Math.floor((t0 - c) / 3600e3)); f <= Math.min(max, Math.ceil((t1 - c) / 3600e3)); f++) hours.push(f);
  if (!hours.length) return null;
  const frames = new Map(); let grid = null, box = null;
  await pool(hours.map((f) => async () => {
    const url = fileUrl(model, cycle, f, { which: model.path2d ? "path2d" : "path" });
    const r = await gribFields(url, FIELDS.map((q) => q.k), box, { ...opts, bbox }, onBytes).catch(() => null);
    if (!r?.got || !Object.keys(r.got).length) return;
    grid ||= r.grid; box ||= r.box;
    frames.set(c + f * 3600e3, r.got);
  }), 3);
  return frames.size && grid ? gribPart(`${model.short || model.id} ${pad(cycle.getUTCHours())}Z`, "2.5–3 km", grid, box, frames) : null;
}

async function gfsPart(from, t1, bbox, opts, onBytes) {
  const run = await latestGlobal("gfs", t1, opts);
  if (!run) return null;
  const cyc = run.cycle, c = cyc.getTime(), hh = pad(cyc.getUTCHours()), grid = GRID025(0), box = boxFor(grid, bbox), frames = new Map(), steps = [];
  for (let f = Math.max(0, Math.floor((from - c) / 3600e3 / 3) * 3); c + f * 3600e3 <= t1 + 3 * 3600e3; f += 3) steps.push(f);
  await pool(steps.map((f) => async () => {
    const url = `${GFS}/gfs.${ymd(cyc)}/${hh}/atmos/gfs.t${hh}z.pgrb2.0p25.f${pad(f, 3)}`;
    const r = await gribFields(url, GFS_FIELDS, box, { ...opts, bbox }, onBytes).catch(() => null);
    if (r?.got && Object.keys(r.got).length) frames.set(c + f * 3600e3, r.got);
  }), 3);
  return frames.size ? gribPart(`GFS ${hh}Z (3-hourly)`, "0.25°", grid, box, frames) : null;
}

const cache = new Map();
// The weather over `bbox` for t0..t1 (ms), from the model and run the passage (or the map) uses.
export function loadWeather({ model, cycle, bbox, t0, t1, onProgress, signal }) {
  const key = `${model?.id}|${cycle?.getTime()}|${[bbox.latMin, bbox.latMax, bbox.lonMin, bbox.lonMax].map((v) => v.toFixed(2)).join(",")}|${Math.floor(t0 / 3600e3)}|${Math.ceil(t1 / 3600e3)}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const opts = { signal }, parts = [];
    let bytes = 0;
    const onBytes = (n) => { bytes += n; onProgress?.({ bytes }); };
    if (model && cycle) {
      const p = model.id.startsWith("hrrr")
        ? await hrrrPart(model, cycle, bbox, t0, t1, { signal, onProgress: (q) => onProgress?.({ bytes: bytes + q.bytes }) })
        : await modelPart(model, cycle, bbox, t0, t1, opts, onBytes);
      if (p) { parts.push(p); bytes += p.bytes || 0; }
    }
    const end = parts.length ? parts[0].times.at(-1) : t0 - 1;
    if (end < t1) { const g = await gfsPart(Math.max(t0, end), t1, bbox, opts, onBytes).catch(() => null); if (g) parts.push(g); }
    return new Weather(parts, bytes);
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return job;
}

// ---------- in words ----------
export const fF = (c) => (Number.isFinite(c) ? Math.round(c * 1.8 + 32) : NaN);
export const visNm = (m) => m / 1852;
export function visText(m) {
  if (!Number.isFinite(m)) return "–";
  const nm = m / 1852;
  return nm >= 9.5 ? "10+ nm" : nm >= 2 ? `${Math.round(nm)} nm` : nm >= 0.5 ? `${nm.toFixed(1)} nm` : `${Math.round(m / 10) * 10} m`;
}
// Rain from the rate (mm/h) and the radar echo (dBZ): what it would look like.
export function rainWord(w) {
  if (!w) return "";
  const r = w.rain ?? 0, z = w.dbz ?? -99;
  if ((w.ltng ?? 0) > 0.01 || z >= 50) return "thunderstorm";
  if (r >= 7.6 || z >= 45) return "heavy rain";
  if (r >= 2.5 || z >= 35) return "rain";
  if (r >= 0.25 || z >= 25) return "light rain";
  if (r >= 0.05 || z >= 15) return "drizzle";
  return "";
}
export function cloudWord(p) {
  if (!Number.isFinite(p)) return "";
  return p < 10 ? "clear" : p < 30 ? "few clouds" : p < 60 ? "partly cloudy" : p < 88 ? "mostly cloudy" : "overcast";
}
export const fogWord = (m) => (!Number.isFinite(m) ? "" : m < 1000 ? "fog" : m < 5000 ? "mist/haze" : "");
// One short line: "54°F · vis 3 nm · light rain · overcast, ceiling 1,200 ft".
export function wxLine(w, { short = false } = {}) {
  if (!w) return "";
  const parts = [];
  if (Number.isFinite(w.t2)) parts.push(`${fF(w.t2)}°F`);
  if (Number.isFinite(w.vis)) parts.push(`${short ? "" : "vis "}${visText(w.vis)}${fogWord(w.vis) && !short ? ` (${fogWord(w.vis)})` : ""}`);
  const rw = rainWord(w); if (rw) parts.push(rw);
  const cw = cloudWord(w.tcc);
  if (cw && !short) parts.push(`${cw}${Number.isFinite(w.ceil) ? `, ceiling ${(Math.round((w.ceil * 3.28084) / 100) * 100).toLocaleString("en-US")} ft` : ""}`);
  return parts.join(" · ");
}
