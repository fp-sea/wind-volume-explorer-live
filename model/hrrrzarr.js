// HRRR forecasts from the University of Utah's HRRR Zarr archive (s3://hrrrzarr), read in the
// browser the way radar-explorer reads its analyses: 150 × 150-cell tiles (Blosc/LZ4 float32),
// so only the tiles over the region download. In the forecast Zarr each tile holds every
// forecast hour of the run (chunks [T, 150, 150]), so one download covers the whole run and
// playback afterwards is instant.
//
// What the forecast Zarr carries is HRRR's "surface" file: winds at 10 m, 80 m and 1000, 925,
// 850, 700, 500 mb (+300, 250 without heights, not used), T and dewpoint at those levels, heights
// at 1000/850/700/500 mb, vertical motion only at 700 mb, and the surface set. So, for this
// source only:
//   RH aloft       from T and dewpoint (Magnus), as the Zarr has no RH aloft;
//   HGT 925 mb     by the hypsometric equation from 1000 mb (the Zarr has no 925 mb height);
//   vorticity      computed from the winds (grid finite differences + f), as the Zarr has none;
//   w              700 mb only (NaN elsewhere: not guessed);
//   inversion      not offered (three levels in 950-600 mb can't resolve a cap).
// Winds are grid-relative (GRIB-derived) and are turned to true north here.

import { bloscDecode } from "./blosc.js?v=20261002173952";
import { LambertGrid } from "./lambert.js?v=20261002173952";
import { cropFor } from "./rrfs.js?v=20261002173952";
import { FetchFailed, pool } from "./fetch.js?v=20261002173952";

const BUCKET = "https://hrrrzarr.s3.amazonaws.com";
const TILE = 150;
// HRRR's CONUS grid (the same as its GRIB header; checked against ecCodes in lambert.test.mjs).
export const HRRR_GRID = { tpl: 30, ni: 1799, nj: 1059, la1: 21.138123, lo1: -122.719528, lov: -97.5, latin1: 38.5, latin2: 38.5,
                           lad: 38.5, dx: 3000, dy: 3000, shape: 6, scan: 64 };
const LEVELS = [1000, 925, 850, 700, 500];
const RD = 287.05, G = 9.80665, OMEGA = 7.2921e-5;

// [zarr level, variable, our tag]
const WANT = [
  ...["10m_above_ground", "80m_above_ground"].flatMap((l) => [[l, "UGRD", `AGL${parseInt(l, 10)}:UGRD`], [l, "VGRD", `AGL${parseInt(l, 10)}:VGRD`]]),
  ...LEVELS.flatMap((mb) => [[`${mb}mb`, "UGRD", `UGRD:${mb}`], [`${mb}mb`, "VGRD", `VGRD:${mb}`], [`${mb}mb`, "TMP", `TMP:${mb}`], [`${mb}mb`, "DPT", `DPT:${mb}`]]),
  ...[1000, 850, 700, 500].map((mb) => [`${mb}mb`, "HGT", `HGT:${mb}`]),
  ["700mb", "DZDT", "DZDT:700"],
  ["2m_above_ground", "TMP", "SFC:TMP2"], ["2m_above_ground", "RH", "SFC:RH2"], ["surface", "TMP", "SFC:TMP"],   // (surface TMP: the skin, the sea surface over water)
  ...["HGT", "GUST", "HPBL", "FRICV", "LAND"].map((v) => ["surface", v, `SFC:${v}`]),
];

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => [`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`, pad(d.getUTCHours())];
export const runBase = (cycle) => { const [day, hh] = stamp(cycle); return `${BUCKET}/sfc/${day}/${day}_${hh}z_fcst.zarr`; };

// Does this run's forecast Zarr exist, and how many hours does it hold? (0 if not there.)
export async function runLength(cycle, { signal } = {}) {
  try {
    const r = await fetch(`${runBase(cycle)}/850mb/UGRD/850mb/UGRD/.zarray`, { signal });
    return r.ok ? (await r.json()).shape[0] : 0;
  } catch (e) { if (e.name === "AbortError") throw e; return 0; }
}

// Newest run (within 30 h) whose Zarr holds at least needFhr hours.
export async function latestZarrCycle(model, { needFhr = 1, signal } = {}) {
  const now = Date.now();
  let h = Math.floor(now / 3600e3) * 3600e3;
  for (let k = 0; k < 30; k++, h -= 3600e3) {
    const c = new Date(h);
    if (!model.cycles.some((cy) => cy.hours.includes(c.getUTCHours()) && cy.maxFhr >= needFhr)) continue;
    const n = await runLength(c, { signal });
    if (n >= needFhr) return { cycle: c, hours: n };
  }
  return null;
}

async function chunk(url, signal) {
  const r = await fetch(url, { signal }).catch((e) => { if (e.name === "AbortError") throw e; throw new FetchFailed(`network failure: ${url.split("/").slice(-4).join("/")}`, e); });
  if (r.status === 403 || r.status === 404) return null;            // not in this run: capability absent
  if (!r.ok) throw new FetchFailed(`HTTP ${r.status}: ${url.split("/").slice(-4).join("/")}`);
  const buf = await r.arrayBuffer();
  return { raw: bloscDecode(buf), bytes: buf.byteLength };
}

// Download a run over the region: every WANT variable's tiles. Cached per run.
const runs = new Map();
export function loadRun(cycle, bbox, { signal, onProgress } = {}) {
  const key = cycle.getTime();
  if (runs.has(key)) return runs.get(key);
  const job = (async () => {
    const t0 = performance.now(), grid = new LambertGrid(HRRR_GRID), box = cropFor(grid, bbox);
    const tis = [], tjs = [];
    for (let t = Math.floor(box.i0 / TILE); t <= Math.floor((box.i0 + box.w - 1) / TILE); t++) tis.push(t);
    for (let t = Math.floor(box.j0 / TILE); t <= Math.floor((box.j0 + box.h - 1) / TILE); t++) tjs.push(t);
    const base = runBase(cycle);
    let bytes = 0;
    const fp = await chunk(`${base}/850mb/UGRD/forecast_period/0`, signal);
    if (!fp) throw new FetchFailed("this run's forecast Zarr isn't posted yet");
    const hours = Array.from(new BigInt64Array(fp.raw.buffer.slice(fp.raw.byteOffset, fp.raw.byteOffset + fp.raw.byteLength)), Number);
    const T = hours.length, vars = {}, missing = [];
    const jobs = WANT.flatMap(([lev, name, tag]) => tjs.flatMap((tj) => tis.map((ti) => async () => {
      const c = await chunk(`${base}/${lev}/${name}/${lev}/${name}/0.${tj}.${ti}`, signal);
      if (!c) { if (!missing.includes(tag)) missing.push(tag); return; }
      bytes += c.bytes; onProgress?.({ phase: "fetch", bytes });
      const f = new Float32Array(c.raw.buffer.slice(c.raw.byteOffset, c.raw.byteOffset + c.raw.byteLength));
      (vars[tag] ||= {})[`${tj}.${ti}`] = f;
    })));
    await pool(jobs, 8);
    return { cycle, hours, T, vars, missing, box, grid, bytes, ms: performance.now() - t0 };
  })();
  runs.set(key, job);
  job.catch(() => runs.delete(key));
  if (runs.size > 3) runs.delete(runs.keys().next().value);
  return job;
}

// One forecast hour from a loaded run, in the shape of rrfs.js loadVolume().
export async function loadZarrHour(model, cycle, fhr, { bbox, signal, onProgress } = {}) {
  const run = await loadRun(cycle, bbox, { signal, onProgress });
  const t = run.hours.indexOf(fhr);
  if (t < 0) throw new FetchFailed(`HTTP 404: +${fhr} h isn't in this run's Zarr (it holds +${run.hours[0]}–${run.hours[run.hours.length - 1]} h)`);
  const { box, grid } = run, n = box.w * box.h, PX = TILE * TILE;
  const take = (tag) => {
    const tiles = run.vars[tag];
    if (!tiles) return null;
    const out = new Float32Array(n);
    for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
      const gi = box.i0 + i, gj = box.j0 + j, tile = tiles[`${Math.floor(gj / TILE)}.${Math.floor(gi / TILE)}`];
      const v = tile ? tile[t * PX + (gj % TILE) * TILE + (gi % TILE)] : NaN;
      out[j * box.w + i] = v === -9999 ? NaN : v;
    }
    return out;
  };
  const lat = new Float64Array(n), lon = new Float64Array(n);
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) { const p = grid.latLon(box.i0 + i, box.j0 + j); lat[j * box.w + i] = p.lat; lon[j * box.w + i] = p.lon; }
  const nanArr = () => new Float32Array(n).fill(NaN);
  const data = { HGT: [], TMP: [], RH: [], UGRD: [], VGRD: [], DZDT: [], ABSV: [] };
  for (const mb of LEVELS) {
    const T = take(`TMP:${mb}`), Td = take(`DPT:${mb}`), u = take(`UGRD:${mb}`), v = take(`VGRD:${mb}`);
    data.TMP.push(T || nanArr());
    data.RH.push(T && Td ? T.map((tk, c) => rhFrom(tk, Td[c])) : nanArr());
    data.UGRD.push(u || nanArr()); data.VGRD.push(v || nanArr());
    data.DZDT.push(take(`DZDT:${mb}`) || nanArr());
    data.ABSV.push(u && v ? absVort(u, v, grid, box, lat) : nanArr());
    data.HGT.push(take(`HGT:${mb}`));
  }
  // 925 mb height: hypsometric from 1000 mb with the layer-mean temperature.
  const k925 = LEVELS.indexOf(925);
  if (!data.HGT[k925] && data.HGT[0]) data.HGT[k925] = data.HGT[0].map((z, c) => z + (RD * (data.TMP[0][c] + data.TMP[k925][c]) / 2 / G) * Math.log(1000 / 925));
  data.HGT = data.HGT.map((a) => a || nanArr());
  // Turn winds to true north (vorticity was computed first, on the grid's own axes).
  for (let k = 0; k < LEVELS.length; k++) turn(grid, box, data.UGRD[k], data.VGRD[k]);
  const agl = {}, surface = {};
  for (const m of [10, 80]) {
    const u = take(`AGL${m}:UGRD`), v = take(`AGL${m}:VGRD`);
    if (u && v) { turn(grid, box, u, v); agl[m] = { UGRD: u, VGRD: v }; }
  }
  for (const nm of ["HGT", "GUST", "HPBL", "FRICV", "LAND", "TMP2", "RH2", "TMP"]) { const a = take(`SFC:${nm}`); if (a) surface[nm] = a; }
  return { model: model.id, cycle, fhr, valid: new Date(cycle.getTime() + fhr * 3600e3), levels: LEVELS, agl, crop: box, grid: HRRR_GRID,
           lat, lon, data, surface, bytes: run.bytes, ms: run.ms, zarr: { missing: run.missing, hours: run.hours } };
}

const esat = (tc) => 6.112 * Math.exp((17.67 * tc) / (tc + 243.5));
const rhFrom = (tK, tdK) => (Number.isFinite(tK) && Number.isFinite(tdK) ? Math.min(100, 100 * esat(tdK - 273.15) / esat(tK - 273.15)) : NaN);

function turn(grid, box, U, V) {
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
    const c = j * box.w + i, a = grid.turnAt(box.i0 + i, box.j0 + j), co = Math.cos(a), si = Math.sin(a), u = U[c], v = V[c];
    U[c] = co * u + si * v; V[c] = -si * u + co * v;
  }
}

// Absolute vorticity from grid-relative winds: ∂v/∂x − ∂u/∂y by centred differences in grid
// cells (ground size from the map factor), plus the Coriolis parameter.
function absVort(U, V, grid, box, lat) {
  const { w, h } = box, out = new Float32Array(w * h).fill(NaN);
  for (let j = 1; j < h - 1; j++) {
    const d = grid.cellSizeM(box.i0 + w / 2, box.j0 + j);
    for (let i = 1; i < w - 1; i++) {
      const c = j * w + i;
      const zeta = (V[c + 1] - V[c - 1]) / (2 * d) - (U[c + w] - U[c - w]) / (2 * d);
      out[c] = zeta + 2 * OMEGA * Math.sin(lat[c] * Math.PI / 180);
    }
  }
  return out;
}

// The 10 m wind and surface gust for every hour of a run over the region, and nothing else (the
// passage planner's needs): 3 variables × the region's tiles, each tile holding all the hours.
// → {hours: [fhr…], grid, box, frames: Map fhr → {U, V, G} (true east/north, m/s)}, or null if
// this run's Zarr isn't posted.
const surfRuns = new Map();
export function loadSurfaceRun(cycle, bbox, { signal, onProgress } = {}) {
  const key = `${cycle.getTime()}|${JSON.stringify(bbox)}`;
  if (surfRuns.has(key)) return surfRuns.get(key);
  const job = (async () => {
    const grid = new LambertGrid(HRRR_GRID), box = cropFor(grid, bbox), base = runBase(cycle);
    const fp = await chunk(`${base}/10m_above_ground/UGRD/forecast_period/0`, signal).catch(() => null);
    if (!fp) return null;
    const hours = Array.from(new BigInt64Array(fp.raw.buffer.slice(fp.raw.byteOffset, fp.raw.byteOffset + fp.raw.byteLength)), Number);
    const tis = [], tjs = [];
    for (let t = Math.floor(box.i0 / TILE); t <= Math.floor((box.i0 + box.w - 1) / TILE); t++) tis.push(t);
    for (let t = Math.floor(box.j0 / TILE); t <= Math.floor((box.j0 + box.h - 1) / TILE); t++) tjs.push(t);
    const vars = {};
    let bytes = 0;
    await pool([["10m_above_ground", "UGRD", "U"], ["10m_above_ground", "VGRD", "V"], ["surface", "GUST", "G"]].flatMap(([lev, name, tag]) => tjs.flatMap((tj) => tis.map((ti) => async () => {
      const c = await chunk(`${base}/${lev}/${name}/${lev}/${name}/0.${tj}.${ti}`, signal);
      if (!c) return;
      bytes += c.bytes; onProgress?.({ bytes });
      (vars[tag] ||= {})[`${tj}.${ti}`] = new Float32Array(c.raw.buffer.slice(c.raw.byteOffset, c.raw.byteOffset + c.raw.byteLength));
    }))), 8);
    if (!vars.U || !vars.V) return null;
    const n = box.w * box.h, PX = TILE * TILE, frames = new Map();
    const take = (tag, t) => {
      const tiles = vars[tag];
      if (!tiles) return null;
      const out = new Float32Array(n);
      for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
        const gi = box.i0 + i, gj = box.j0 + j, tile = tiles[`${Math.floor(gj / TILE)}.${Math.floor(gi / TILE)}`];
        const v = tile ? tile[t * PX + (gj % TILE) * TILE + (gi % TILE)] : NaN;
        out[j * box.w + i] = v === -9999 ? NaN : v;
      }
      return out;
    };
    hours.forEach((fhr, t) => { const U = take("U", t), V = take("V", t); turn(grid, box, U, V); frames.set(fhr, { U, V, G: take("G", t) }); });
    return { hours, grid, box, frames, bytes, source: "HRRR Zarr (all hours in one download)" };
  })();
  surfRuns.set(key, job);
  job.catch(() => surfRuns.delete(key));
  if (surfRuns.size > 3) surfRuns.delete(surfRuns.keys().next().value);
  return job;
}

// Any of the forecast Zarr's 2D variables over `bbox`, tile by tile (each tile holds every hour of
// the run), cached by tile so the planner and the viewer share them (the weather along a
// passage, route/weather.js). vars: [[zarr level, variable, our tag]].
// → {grid, hours: [fhr], get(tag, k, gi, gj) → value at hour index k, HRRR cell (gi, gj), or NaN}
const tileCache = new Map(), hoursCache = new Map();
export async function zarrTiles(cycle, bbox, vars, { signal, onProgress } = {}) {
  const grid = new LambertGrid(HRRR_GRID), box = cropFor(grid, bbox, 1), base = runBase(cycle);
  if (!hoursCache.has(base)) hoursCache.set(base, chunk(`${base}/10m_above_ground/UGRD/forecast_period/0`, signal).then((fp) => (fp ? Array.from(new BigInt64Array(fp.raw.buffer.slice(fp.raw.byteOffset, fp.raw.byteOffset + fp.raw.byteLength)), Number) : null)).catch((e) => { hoursCache.delete(base); throw e; }));
  const hours = await hoursCache.get(base);
  if (!hours) return null;
  const tis = [], tjs = [];
  for (let t = Math.floor(box.i0 / TILE); t <= Math.floor((box.i0 + box.w - 1) / TILE); t++) tis.push(t);
  for (let t = Math.floor(box.j0 / TILE); t <= Math.floor((box.j0 + box.h - 1) / TILE); t++) tjs.push(t);
  let bytes = 0;
  await pool(vars.flatMap(([lev, name]) => tjs.flatMap((tj) => tis.map((ti) => async () => {
    const key = `${base}|${lev}/${name}|${tj}.${ti}`;
    if (!tileCache.has(key)) tileCache.set(key, chunk(`${base}/${lev}/${name}/${lev}/${name}/0.${tj}.${ti}`, signal).then((c) => {
      if (!c) return null;
      bytes += c.bytes; onProgress?.({ bytes });
      return new Float32Array(c.raw.buffer.slice(c.raw.byteOffset, c.raw.byteOffset + c.raw.byteLength));
    }).catch((e) => { tileCache.delete(key); throw e; }));
    await tileCache.get(key);
  }))), 8);
  while (tileCache.size > 40) tileCache.delete(tileCache.keys().next().value);   // (~4–5 MB each)
  const tiles = {};
  for (const [lev, name, tag] of vars) for (const tj of tjs) for (const ti of tis) {
    const p = tileCache.get(`${base}|${lev}/${name}|${tj}.${ti}`);
    if (p) (tiles[tag] ||= {})[`${tj}.${ti}`] = await p;
  }
  const PX = TILE * TILE;
  return {
    grid, hours, bytes,
    get(tag, k, gi, gj) {
      const t = tiles[tag]?.[`${Math.floor(gj / TILE)}.${Math.floor(gi / TILE)}`];
      if (!t || gi < 0 || gj < 0) return NaN;
      const v = t[k * PX + (gj % TILE) * TILE + (gi % TILE)];
      return v === -9999 || v > 1e19 ? NaN : v;
    },
  };
}
