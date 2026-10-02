// Long-range wind for the passage planner: NOAA's GFS and ECMWF's IFS (open data), 0.25°, read
// in the browser by byte range from their AWS buckets: the 10 m wind (u, v) and the gust only,
// cropped to the region, every 3 hours. A global field covers the whole world, so each step
// costs ~2.5–3 MB whatever the region; the download meter shows it.
//
//   GFS   noaa-gfs-bdp-pds  gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF (+ .idx)
//         runs 00/06/12/18Z, hourly to 120 h then 3-hourly to 384 h; posted ~4-5 h after the run.
//         GUST:surface (instantaneous).
//   IFS   ecmwf-forecasts   YYYYMMDD/HHz/ifs/0p25/oper/YYYYMMDDHH0000-{step}h-oper-fc.grib2 (+ .index,
//         JSON lines with byte offsets). 00/12Z to 360 h (3-hourly to 144 h, then 6-hourly),
//         06/18Z to 90 h; posted ~7-9 h after the run. 10fg: the highest gust since the previous
//         step. CCSDS-packed (grib2.js decodes it). Open data under CC BY 4.0 (ECMWF).
//
// → a wind source for route/env.js: {id, label, cycle, grid, box, times: [ms], frames: Map(ms →
//   {U, V, G}), bytes, res}.

import { fetchIdx, fetchMessages, pool } from "../model/fetch.js?v=20261002173952";
import { decodeCropped } from "../model/rrfs.js?v=20261002173952";

export const GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com", IFS = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com";
const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// A fetch that gives up after `ms` and tries again (up to 3 times, pausing 1 then 3 s): the
// buckets sometimes drop or throttle a request (ECMWF's in Frankfurt especially), which would
// otherwise stall or end a whole load. (A 404 is an answer: not retried.)
export async function fetchRetry(url, { signal, headers, ms = 45000 } = {}) {
  let err = null;
  for (let k = 0; k < 3; k++) {
    if (signal?.aborted) throw new DOMException("stopped", "AbortError");
    const t = AbortSignal.timeout ? AbortSignal.timeout(ms) : null, sig = t && AbortSignal.any ? AbortSignal.any([t, signal].filter(Boolean)) : signal;
    try {
      const r = await fetch(url, { signal: sig, headers });
      if (r.ok || r.status === 404 || r.status === 416) return r;
      err = new Error(`${r.status} from ${new URL(url).hostname}`);
    } catch (e) { if (signal?.aborted) throw e; err = e.name === "TimeoutError" ? new Error(`no answer from ${new URL(url).hostname} in ${ms / 1000} s`) : e; }
    await new Promise((r) => setTimeout(r, k ? 3000 : 1000));
  }
  throw err;
}

// A regular latitude/longitude grid (GRIB 3.0; row 0 north), with i across from lo1 eastwards.
export class LatLonGrid {
  constructor(g) { Object.assign(this, g); }
  ij(lat, lon) { return { i: ((((lon - this.lo1) % 360) + 360) % 360) / this.di, j: (this.la1 - lat) / this.dj }; }
  latLon(i, j) { return { lat: this.la1 - j * this.dj, lon: ((this.lo1 + i * this.di + 540) % 360) - 180 }; }
}
// The grid cells over the region's box (and a degree round it).
export function boxFor(grid, bbox) {
  const a = grid.ij(bbox.latMax + 1, bbox.lonMin - 1), b = grid.ij(bbox.latMin - 1, bbox.lonMax + 1);
  const i0 = Math.floor(a.i), j0 = Math.floor(a.j), i1 = Math.ceil(b.i), j1 = Math.ceil(b.j);
  return { i0, j0, w: i1 - i0 + 1, h: j1 - j0 + 1 };
}
export const GRID025 = (lo1) => new LatLonGrid({ ni: 1440, nj: 721, la1: 90, lo1, di: 0.25, dj: 0.25 });

// Newest run of `kind` ("gfs" | "ifs") that reaches `untilMs`, looking back 36 h. → {cycle, hours}
export async function latestGlobal(kind, untilMs, { signal } = {}) {
  const now = Date.now();
  for (let h = Math.floor(now / 6 / 3600e3) * 6 * 3600e3, k = 0; k < 7; k++, h -= 6 * 3600e3) {
    const cyc = new Date(h), hh = cyc.getUTCHours();
    const maxH = kind === "gfs" ? 384 : hh % 12 === 0 ? 360 : 90;
    const need = Math.ceil((untilMs - h) / 3600e3);
    if (need > maxH) continue;
    const step = Math.min(maxH, Math.max(3, Math.ceil(Math.min(need, 90) / 3) * 3));   // (a step that must be there)
    const url = kind === "gfs" ? `${GFS}/gfs.${ymd(cyc)}/${pad(hh)}/atmos/gfs.t${pad(hh)}z.pgrb2.0p25.f${pad(step, 3)}.idx`
      : `${IFS}/${ymd(cyc)}/${pad(hh)}z/ifs/0p25/oper/${ymd(cyc)}${pad(hh)}0000-${step}h-oper-fc.index`;
    const r = await fetchRetry(url, { signal, ms: 20000 }).catch(() => null);  // (GET: the GFS bucket allows only GET across sites; the index is small)
    if (r?.ok) return { cycle: cyc, maxH };
  }
  return null;
}

// Load `kind` from `cycle` for valid times t0..t1 (ms), every 3 hours (6 beyond 144 h on IFS).
export async function loadGlobal(kind, cycle, t0, t1, bbox, { onProgress, signal } = {}) {
  const c = cycle.getTime(), hh = cycle.getUTCHours(), grid = GRID025(kind === "gfs" ? 0 : 180), box = boxFor(grid, bbox);
  const steps = [];
  for (let f = Math.max(0, Math.floor((t0 - c) / 3600e3 / 3) * 3); c + f * 3600e3 <= t1 + 3 * 3600e3; f += kind === "ifs" && f >= 144 ? 6 : 3) steps.push(f);
  const frames = new Map();
  let bytes = 0, done = 0;
  await pool(steps.map((f) => async () => {
    let U, V, G;
    if (kind === "gfs") {
      const url = `${GFS}/gfs.${ymd(cycle)}/${pad(hh)}/atmos/gfs.t${pad(hh)}z.pgrb2.0p25.f${pad(f, 3)}`;
      const idx = await fetchIdx(url, { signal });
      const keys = ["UGRD:10 m above ground", "VGRD:10 m above ground", "GUST:surface"].filter((k) => idx.some((e) => e.key === k));
      const msgs = await fetchMessages(url, keys, { idx, signal, onBytes: (n) => { bytes += n; onProgress?.({ bytes, done, of: steps.length }); } });
      [U, V, G] = await Promise.all(["UGRD:10 m above ground", "VGRD:10 m above ground", "GUST:surface"].map((k) => (msgs.has(k) ? decodeCropped(msgs.get(k), box).then((r) => r.values) : null)));
    } else {
      const base = `${IFS}/${ymd(cycle)}/${pad(hh)}z/ifs/0p25/oper/${ymd(cycle)}${pad(hh)}0000-${f}h-oper-fc`;
      const ir = await fetchRetry(`${base}.index`, { signal });
      if (!ir.ok) throw new Error(`ECMWF step +${f} h isn't posted (${ir.status})`);
      const lines = (await ir.text()).trim().split("\n").map((l) => JSON.parse(l));
      const want = { "10u": null, "10v": null, "10fg": null };
      for (const e of lines) if (e.param in want && !want[e.param]) want[e.param] = e;
      const get = async (e) => {
        if (!e) return null;
        const r = await fetchRetry(`${base}.grib2`, { signal, headers: { Range: `bytes=${e._offset}-${e._offset + e._length - 1}` } });
        const buf = new Uint8Array(await r.arrayBuffer());
        bytes += buf.length; onProgress?.({ bytes, done, of: steps.length });
        return (await decodeCropped(buf, box)).values;
      };
      [U, V, G] = await Promise.all([get(want["10u"]), get(want["10v"]), get(want["10fg"])]);
    }
    if (U && V) frames.set(c + f * 3600e3, { U, V, G });
    done++; onProgress?.({ bytes, done, of: steps.length });
  }), 4);
  const times = [...frames.keys()].sort((a, b) => a - b);
  const name = kind === "gfs" ? "GFS" : "ECMWF IFS";
  return { id: kind, label: `${name} ${pad(hh)}Z ${cycle.toISOString().slice(5, 10)}`, short: name, cycle, grid, box, times, frames, bytes, res: "0.25° (~25 km)" };
}
