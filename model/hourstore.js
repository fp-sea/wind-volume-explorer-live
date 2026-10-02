// Just-in-time model data for one forecast hour of a live GRIB model.
//
// A store starts empty. ensure(needs) fetches only the messages it doesn't have yet (byte
// ranges, coalesced), decodes and crops them in workers, and keeps the crops. raw() assembles
// what it has into the shape everything downstream reads (rrfs.js loadVolume's), with fields it
// doesn't have as all-NaN arrays (shown as holes, never guessed) and `have` listing what's real.
//
// The surface set and the above-ground winds are always part of ensure() (they're small and
// almost always on screen); pressure-level fields come as needed: [{f, mb}] with f one of
// HGT TMP RH UGRD VGRD DZDT ABSV (our names; HRRR's VVEL is fetched for DZDT and converted).
// Extra 2-D fields come the same way as {sfc: "GRIB key"} (sea-level pressure for the channel
// analysis), from the surface file.

import { decodeMessage } from "./grib2.js?v=20261002173952";
import { fetchIdx, fetchMessages } from "./fetch.js?v=20261002173952";
import { fileUrl, cropFor, decodeCropped, SURFACE_KEYS, AGL_KEYS, AGL_M } from "./rrfs.js?v=20261002173952";
import { gridOf } from "./volume.js?v=20261002173952";

const NANS = new Map();
const nanOf = (n) => { if (!NANS.has(n)) NANS.set(n, new Float32Array(n).fill(NaN)); return NANS.get(n); };

export class HourStore {
  constructor(model, cycle, fhr, bbox) {
    Object.assign(this, { model, cycle, fhr, bbox });
    this.url = fileUrl(model, cycle, fhr);
    this.url2d = model.path2d ? fileUrl(model, cycle, fhr, { which: "path2d" }) : null;
    this.arr = new Map();          // GRIB key → cropped Float32Array (winds turned, ω converted)
    this.absent = new Set();       // keys this file doesn't have (capability absent)
    this.bytes = 0; this.ms = 0; this.version = 0;
    this.pending = null;
  }
  // Memory held (bytes): the cropped fields.
  heldBytes() { let b = 0; for (const a of this.arr.values()) b += a.byteLength; return b; }
  // Our field names → the file's: HRRR's ω for w; cloud ice is CIMIXR (HRRR) or ICMR (RRFS).
  gribName(f) {
    if (f === "DZDT" && this.model.packFields?.W) return this.model.packFields.W;
    if (f === "CICE") return this.model.iceField || "ICMR";
    return f;
  }
  key(f, mb) { return `${this.gribName(f)}:${mb} mb`; }
  surfaceKeys() { return this.model.packSurface || [...SURFACE_KEYS, ...AGL_KEYS]; }
  has(need) {
    return need.every(({ f, mb, sfc }) => (sfc ? this.arr.has(sfc) || this.absent.has(sfc) : this.arr.has(this.key(f, mb)) || this.absent.has(this.key(f, mb)))) && this.idx;
  }

  // What fetching `need` would download for this hour (bytes, from the index's message sizes;
  // needs the index: → NaN before it's in). The same keys ensure() would fetch.
  costOf(need) {
    if (!this.idx) return NaN;
    const want = new Set(need.filter((q) => !q.sfc).map(({ f, mb }) => this.key(f, mb)));
    if (this.gribName("DZDT") === "VVEL") for (const { f, mb, sfc } of need) if (!sfc && f === "DZDT") want.add(this.key("TMP", mb));
    for (const k of [...want]) { const [f, lv] = k.split(":"); if (f === "UGRD") want.add(`VGRD:${lv}`); if (f === "VGRD") want.add(`UGRD:${lv}`); }
    const size = (idx, k) => { const e = idx?.find((q) => q.key === k); return e ? (e.end != null ? e.end - e.start : 1e6) : 0; };
    let b = 0;
    for (const k of want) if (!this.arr.has(k) && !this.absent.has(k)) b += size(this.idx, k);
    for (const q of need) if (q.sfc && !this.arr.has(q.sfc) && !this.absent.has(q.sfc)) b += size(this.idx2d || this.idx, q.sfc);
    return b;
  }

  // Fetch whatever of `need` (plus the surface set) isn't here yet. Serialised per store.
  ensure(need, { signal, onProgress } = {}) {
    const run = async () => {
      const t0 = performance.now();
      if (!this.idx) {
        [this.idx, this.idx2d] = await Promise.all([fetchIdx(this.url, { signal }), this.url2d ? fetchIdx(this.url2d, { signal }) : null]);
        this.keys = new Set(this.idx.map((e) => e.key)); this.keys2d = new Set((this.idx2d || []).map((e) => e.key));
      }
      // HRRR's ω needs temperature at the same level to become w.
      const want = new Set(need.filter((q) => !q.sfc).map(({ f, mb }) => this.key(f, mb)));
      const extra = need.filter((q) => q.sfc).map((q) => q.sfc);
      if (this.gribName("DZDT") === "VVEL") for (const { f, mb, sfc } of need) if (!sfc && f === "DZDT") want.add(this.key("TMP", mb));
      // Winds come in pairs (turning to true north needs both).
      for (const k of [...want]) { const [f, lv] = k.split(":"); if (f === "UGRD") want.add(`VGRD:${lv}`); if (f === "VGRD") want.add(`UGRD:${lv}`); }
      const prs = [...want].filter((k) => !this.arr.has(k) && !this.absent.has(k));
      const sfc = this.url2d ? [...new Set([...this.surfaceKeys(), ...extra])].filter((k) => !this.arr.has(k) && !this.absent.has(k)) : [];
      for (const k of prs) if (!this.keys.has(k)) this.absent.add(k);
      for (const k of sfc) if (!this.keys2d.has(k)) this.absent.add(k);
      const getP = prs.filter((k) => this.keys.has(k)), getS = sfc.filter((k) => this.keys2d.has(k));
      if (!getP.length && !getS.length) return false;
      let bytes = 0;
      const onBytes = (n) => { bytes += n; this.bytes += n; onProgress?.({ phase: "fetch", bytes, count: getP.length + getS.length }); };
      const [mp, ms] = await Promise.all([
        getP.length ? fetchMessages(this.url, getP, { idx: this.idx, signal, onBytes }) : new Map(),
        getS.length ? fetchMessages(this.url2d, getS, { idx: this.idx2d, signal, onBytes }) : new Map(),
      ]);
      const all = [...mp, ...ms];
      if (!this.grid) {                                             // the first message sets grid and crop
        const g = decodeMessage(all[0][1]).grid;
        this.grid = g; this.geo = gridOf(g); this.geo.check();
        this.box = cropFor(this.geo, this.bbox);
        const { w, h } = this.box;
        this.lat = new Float64Array(w * h); this.lon = new Float64Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const p = this.geo.latLon(this.box.i0 + i, this.box.j0 + j); this.lat[j * w + i] = p.lat; this.lon[j * w + i] = p.lon; }
      }
      const got = await Promise.all(all.map(async ([k, m]) => [k, (await decodeCropped(m, this.box)).values]));
      for (const [k, a] of got) this.arr.set(k, a);
      this.finish(got.map(([k]) => k));
      this.ms += performance.now() - t0;
      this.version++;
      return true;
    };
    // One ensure at a time per store; later ones wait for earlier ones, then add what's still missing.
    const p = (this.pending || Promise.resolve()).catch(() => {}).then(run);
    this.pending = p;
    return p;
  }

  // Turn new wind pairs to true north (Lambert grids) and convert new ω to w (once each).
  finish(newKeys) {
    this.done ||= new Set();
    const lambert = this.grid.tpl === 30;
    for (const k of newKeys) {
      const [f, lv] = k.split(":");
      if ((f === "UGRD" || f === "VGRD") && lambert) {
        const ku = `UGRD:${lv}`, kv = `VGRD:${lv}`, tag = `turn:${lv}`;
        if (this.arr.has(ku) && this.arr.has(kv) && !this.done.has(tag)) { turnWinds(this.geo, this.box, this.arr.get(ku), this.arr.get(kv)); this.done.add(tag); }
      }
    }
    if (this.gribName("DZDT") === "VVEL") {
      for (const k of this.arr.keys()) {
        const [f, lv] = k.split(":");
        if (f !== "VVEL" || this.done.has(`w:${lv}`) || !this.arr.has(`TMP:${lv}`)) continue;
        const mb = +lv.replace(" mb", ""), W = this.arr.get(k), T = this.arr.get(`TMP:${lv}`);
        for (let c = 0; c < W.length; c++) W[c] = -W[c] * 287.05 * T[c] / (mb * 100 * 9.80665);
        this.done.add(`w:${lv}`);
      }
    }
  }

  // Everything held, in loadVolume()'s shape. Fields not held are NaN; `have` says which are real.
  raw(levels) {
    const n = this.box.w * this.box.h, data = {}, have = new Set();
    for (const f of ["HGT", "TMP", "RH", "UGRD", "VGRD", "DZDT", "ABSV", "CLMR", "CICE"]) {
      data[f] = levels.map((mb) => {
        const k = this.key(f, mb), a = this.arr.get(k);
        if (f === "DZDT" && this.gribName("DZDT") === "VVEL" && a && !this.done?.has(`w:${mb} mb`)) return nanOf(n);   // ω not yet convertible
        if (a) have.add(`${f}:${mb}`);
        return a || nanOf(n);
      });
    }
    const surface = {}, agl = Object.fromEntries(AGL_M.map((m) => [m, {}]));
    for (const k of this.surfaceKeys()) {
      const a = this.arr.get(k);
      if (!a) continue;
      const [name, level] = k.split(":"), m = /^(\d+) m above ground$/.exec(level);
      if (m && agl[+m[1]]) agl[+m[1]][name] = a;
      else if (m) surface[`${name}${m[1]}`] = a;
      else surface[name] = a;
    }
    for (const [k, a] of this.arr) {
      if (k.endsWith(":mean sea level")) surface.MSLP = a;          // Pa (MSLMA / MSLET)
      else if (k === "VIS:surface") surface.VIS = a;                // m, the model's visibility (fog layer)
    }
    return { model: this.model.id, cycle: this.cycle, fhr: this.fhr, valid: new Date(this.cycle.getTime() + this.fhr * 3600e3), levels, agl,
             crop: this.box, grid: this.grid, lat: this.lat, lon: this.lon, data, surface, have, bytes: this.bytes, ms: this.ms, version: this.version };
  }
}

function turnWinds(grid, box, U, V) {
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
    const c = j * box.w + i, a = grid.turnAt(box.i0 + i, box.j0 + j), co = Math.cos(a), si = Math.sin(a), u = U[c], v = V[c];
    U[c] = co * u + si * v; V[c] = -si * u + co * v;
  }
}

// ---------- what the displays need ----------
// Standard-atmosphere height of a pressure level (m): only used to pick which levels a height needs.
export const stdZ = (mb) => 44330.8 * (1 - (mb / 1013.25) ** 0.190263);
const FIELDS_OF = { none: ["UGRD", "VGRD"], froude: [], speed: ["UGRD", "VGRD"], gust: [], gustf: [], w: ["DZDT"], conv: ["UGRD", "VGRD"], temp: ["TMP"], rh: ["RH"], vort: ["ABSV"], shear: ["UGRD", "VGRD"], ri: ["UGRD", "VGRD", "TMP"], pbl: [], airsea: [], mixdown: ["UGRD", "VGRD"] };
export const fieldsOf = (colourBy) => FIELDS_OF[colourBy] ?? ["UGRD", "VGRD"];

// Levels (from `levels`) covering heights z0..z1 (m above sea level), with one level beyond each end.
export function levelsFor(levels, z0, z1) {
  const sorted = [...levels].sort((a, b) => b - a);                  // high pressure (low) first
  let lo = sorted.findIndex((mb) => stdZ(mb) >= z0), hi = sorted.findIndex((mb) => stdZ(mb) > z1);
  if (lo < 0) lo = sorted.length - 1;
  if (hi < 0) hi = sorted.length - 1;
  return sorted.slice(Math.max(0, lo - 1), Math.min(sorted.length, hi + 1));
}

// The always-on set: wind, height, temperature and humidity from 1000 to 850 mb (slices just
// above sea level; the marine layer and fog), on top of the surface set and above-ground winds
// that ensure() always brings.
export const coreNeeds = (levels) => levels.filter((mb) => mb >= 850).flatMap((mb) => ["HGT", "UGRD", "VGRD", "TMP", "RH"].map((f) => ({ f, mb })));

export function needsOf(parts, levels) {
  const out = new Map();
  for (const { fields, mbs } of parts) for (const f of fields) for (const mb of mbs) out.set(`${f}:${mb}`, { f, mb });
  // Anything at a level also needs that level's height (to place it).
  for (const { mb } of [...out.values()]) out.set(`HGT:${mb}`, { f: "HGT", mb });
  return [...coreNeeds(levels), ...out.values()];
}
