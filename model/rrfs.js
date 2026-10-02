// RRFS-family live loading: which cycle to use, and a cropped 3D volume for one
// forecast hour. Paths, cycles and latency come from config/models.json (verified on the
// real bucket), so nothing about a model is hardcoded here.
//
// Replaces the planning-session scaffold rrfs_live_fetch.js. Its cycle-detection rule is
// kept: a cycle counts only once the forecast hour you need has actually landed, not
// merely once its folder exists.

import { decodeMessage } from "./grib2.js?v=20261002173952";
import { gridOf } from "./volume.js?v=20261002173952";
import { fetchIdx, fetchMessages, exists, pool, CapabilityAbsent } from "./fetch.js?v=20261002173952";

const pad = (n, w) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;

export function fileUrl(model, cycle, fhr, { kind = "mean", which = "path" } = {}) {
  const t = model[which].replaceAll("{ymd}", ymd(cycle)).replaceAll("{hh}", pad(cycle.getUTCHours(), 2))
    .replaceAll("{f3}", pad(fhr, 3)).replaceAll("{f2}", pad(fhr, 2)).replaceAll("{kind}", kind);
  return `${model.base}/${t}`;
}

// The longest forecast a cycle hour reaches, or -1 if that hour doesn't run at all
// (so it never satisfies needFhr = 0).
export function maxFhr(model, hour) {
  return Math.max(-1, ...model.cycles.filter((c) => c.hours.includes(hour)).map((c) => c.maxFhr));
}

// Candidate cycles, newest first, from `now` back `hoursBack`, skipping ones too recent to
// have posted anything (latency) and ones that can't reach `needFhr`.
export function candidateCycles(model, now = new Date(), { needFhr = 0, hoursBack = 30 } = {}) {
  const out = [];
  const t0 = new Date(Math.floor((now.getTime() - model.latencyMin * 60e3) / 3600e3) * 3600e3);
  for (let h = 0; h <= hoursBack; h++) {
    const c = new Date(t0.getTime() - h * 3600e3);
    if (maxFhr(model, c.getUTCHours()) >= needFhr) out.push(c);
  }
  return out;
}

// Newest cycle whose forecast hour `needFhr` exists. {cycle, checked} or null.
export async function latestCycle(model, { needFhr = 0, now = new Date(), signal, which = "path", kind } = {}) {
  let checked = 0;
  for (const c of candidateCycles(model, now, { needFhr })) {
    checked++;
    if (await exists(fileUrl(model, c, needFhr, { which, kind }), { signal })) return { cycle: c, checked };
  }
  return null;
}

// Is data from this cycle stale? The newest cycle that should exist by now, allowing for
// latency plus a grace period, is newer than the one we have.
export function staleness(model, cycle, now = new Date(), graceMin = 60) {
  const expect = candidateCycles(model, new Date(now.getTime() - graceMin * 60e3), { hoursBack: 12 })[0];
  const behindH = expect ? (expect.getTime() - cycle.getTime()) / 3600e3 : 0;
  return { stale: behindH > 0, behindH, ageH: (now.getTime() - cycle.getTime()) / 3600e3 };
}

// Crop box (grid indices) covering a lat/lon bbox, with a margin of cells. Samples along all four
// edges, not just the corners: on a Lambert grid the bbox edges are curved in grid space.
export function cropFor(merc, bbox, margin = 2) {
  const corners = [];
  for (let k = 0; k <= 20; k++) {
    const f = k / 20, la = bbox.latMin + f * (bbox.latMax - bbox.latMin), lo = bbox.lonMin + f * (bbox.lonMax - bbox.lonMin);
    corners.push(merc.ij(bbox.latMin, lo), merc.ij(bbox.latMax, lo), merc.ij(la, bbox.lonMin), merc.ij(la, bbox.lonMax));
  }
  const i0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.i))) - margin);
  const i1 = Math.min(merc.ni - 1, Math.ceil(Math.max(...corners.map((c) => c.i))) + margin);
  const j0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.j))) - margin);
  const j1 = Math.min(merc.nj - 1, Math.ceil(Math.max(...corners.map((c) => c.j))) + margin);
  return { i0, j0, w: i1 - i0 + 1, h: j1 - j0 + 1 };
}

function crop(values, ni, { i0, j0, w, h }) {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) out.set(values.subarray((j0 + j) * ni + i0, (j0 + j) * ni + i0 + w), j * w);
  return out;
}

// Surface fields from the 2D file: the model's own terrain (to mask isobaric levels that lie
// below ground, where values are extrapolated, not real), land mask, and PBL height.
export const SURFACE_KEYS = ["HGT:surface", "LAND:surface", "HPBL:surface", "GUST:surface", "FRICV:surface", "TMP:2 m above ground", "RH:2 m above ground", "TMP:surface"];   // (TMP:surface: the skin temperature, the sea surface over water)
// Winds at fixed heights above ground (2D file): the near-surface layer the isobaric levels miss.
// 1000 mb is not "the surface": ~100 m up over the sea, below ground on high terrain.
export const AGL_M = [10, 30, 50, 80, 100, 160, 320];
export const AGL_KEYS = AGL_M.flatMap((m) => [`UGRD:${m} m above ground`, `VGRD:${m} m above ground`]);

// Load one forecast hour: `fields` at `levels` (mb), cropped to `bbox`, plus the surface fields.
// Returns { cycle, fhr, valid, levels, crop, lat, lon (Float64Array per cell),
//           data: {FIELD: [Float32Array per level]}, agl: {metres: {UGRD, VGRD}},
//           surface: {HGT, LAND, HPBL, GUST, FRICV}, bytes, ms }.
// Missing fields raise CapabilityAbsent; network/decode trouble raises FetchFailed.
// Pressure levels from 1000 mb up to (and including) the column top. `top` is a number (mb) or
// "mb/step" (e.g. "500/50": every 50 mb to 500 mb).
export const levelsTo = (model, top) => {
  const [mb, step] = String(top).split("/").map(Number);
  return model.levelsAllMb.filter((lv) => lv >= mb && (!step || (1000 - lv) % step === 0));
};

// Decode + crop in a small pool of workers (radar-explorer's approach), falling back to the page.
const WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
let workers = null, seq = 0;
const waiting = new Map();
function workerPool() {
  if (workers !== null) return workers;
  try {
    workers = Array.from({ length: WORKERS }, (_, k) => {
      const w = new Worker(new URL("./decodeworker.js?v=20261002173952", import.meta.url), { type: "module" });
      w.onmessage = ({ data }) => { const p = waiting.get(data.id); waiting.delete(data.id); data.error ? p?.reject(new Error(data.error)) : p?.resolve(data); };
      // (a worker that dies, e.g. out of memory, fails what it had rather than leaving it waiting)
      w.onerror = (e) => { for (const [id, p] of waiting) if (id % WORKERS === k) { waiting.delete(id); p.reject(new Error(`decoding failed (${e.message || "worker error"})`)); } };
      return w;
    });
  } catch { workers = []; }
  return workers;
}
export function decodeCropped(msg, box) {
  const ws = typeof Worker === "undefined" ? [] : workerPool();
  if (!ws.length) {
    const { grid, values } = decodeMessage(msg);
    return Promise.resolve({ grid, values: box ? crop(values, grid.ni, box) : values });
  }
  const id = ++seq, buf = msg.slice().buffer;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); ws[id % ws.length].postMessage({ id, buf, crop: box }, [buf]); });
}

export async function loadVolume(model, cycle, fhr, { bbox, levels = levelsTo(model, model.defaultTopMb ?? 300), fields = ["HGT", "TMP", "RH", "UGRD", "VGRD", "DZDT", "ABSV"], signal, onProgress, store = null } = {}) {
  // Everything for the hour: an HourStore asked for every field at every level.
  const { HourStore } = await import("./hourstore.js?v=20261002173952");
  const st = store || new HourStore(model, cycle, fhr, bbox);
  const need = levels.flatMap((mb) => fields.map((f) => ({ f, mb })));
  await st.ensure(need, { signal, onProgress });
  const missing = need.map(({ f, mb }) => st.key(f, mb)).filter((k) => st.absent.has(k));
  if (missing.length) throw new CapabilityAbsent(`not in ${st.url.split("/").pop()}: ${missing.join(", ")}`, missing);
  return st.raw(levels);
}

// Grid-relative → true east/north, in place, over a crop (the inverse of LambertGrid.toGrid).
function turnWinds(grid, box, U, V) {
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
    const c = j * box.w + i, a = grid.turnAt(box.i0 + i, box.j0 + j), co = Math.cos(a), si = Math.sin(a);
    const u = U[c], v = V[c];
    U[c] = co * u + si * v; V[c] = -si * u + co * v;
  }
}

// Which of `fields` × `levels` this file actually has (the capability probe, from the real .idx).
export async function capabilities(model, cycle, fhr, { signal } = {}) {
  const idx = await fetchIdx(fileUrl(model, cycle, fhr), { signal });
  const have = new Set(idx.map((e) => e.key));
  return { have, missing: (keys) => keys.filter((k) => !have.has(k)) };
}

export { CapabilityAbsent };
