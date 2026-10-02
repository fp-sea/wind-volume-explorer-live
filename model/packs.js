// Precomputed model packs (pipeline/packs/build.py): HRRR and RRFS over the Salish Sea, where
// the continental-US GRIB files are too big for the browser. A pack is one forecast hour,
// cropped and quantised; this reads it into the same shape as a live load (rrfs.js
// loadVolume), so Volume and every display work unchanged.
//
// Format (gzip): uint32 header length · JSON header · int16 blocks in header order.
// Value = (q + 32500) · scale + off; q = −32768 is missing (NaN).

import { FetchFailed } from "./fetch.js?v=20261002173952";
import { LambertGrid } from "./lambert.js?v=20261002173952";

const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
const parseKey = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10)));

export async function manifest(model, { signal } = {}) {
  const r = await fetch(`data/packs/${model.id}/manifest.json`, { cache: "no-cache", signal }).catch((e) => { throw new FetchFailed("pack list unreachable", e); });
  if (!r.ok) throw new FetchFailed(`no packs built for ${model.label} (HTTP ${r.status})`);
  return r.json();
}

// Newest run whose hours include needFhr: {cycle, hours} or null.
export async function latestPackCycle(model, { needFhr = 0, signal } = {}) {
  const m = await manifest(model, { signal });
  const run = m.runs.find((r) => r.hours.includes(needFhr)) || null;
  return run ? { cycle: parseKey(run.cycle), hours: run.hours, updated: m.updated } : null;
}

async function gunzip(buf) {
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;                 // already decoded by the server
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

export async function loadPack(model, cycle, fhr, { signal, onProgress } = {}) {
  const t0 = performance.now(), u = `data/packs/${model.id}/${key(cycle)}/f${String(fhr).padStart(3, "0")}.bin.gz`;
  let r;
  try { r = await fetch(u, { signal }); } catch (e) { if (e.name === "AbortError") throw e; throw new FetchFailed(`network failure: ${u}`, e); }
  if (!r.ok) throw new FetchFailed(`HTTP ${r.status}: pack +${fhr} h not built for this run`);
  const packed = await r.arrayBuffer();
  onProgress?.({ phase: "fetch", bytes: packed.byteLength });
  const buf = await gunzip(packed);
  const dv = new DataView(buf), hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const { w, h } = header.crop, n = w * h;
  let off = 4 + hlen;
  const blocks = {};
  for (const b of header.blocks) {
    const q = new Int16Array(buf.slice(off, off + n * 2)), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = q[i] === -32768 ? NaN : (q[i] + 32500) * b.scale + b.off;
    blocks[b.tag] = out; off += n * 2;
  }
  const levels = header.levels, data = {}, agl = {}, surface = {};
  const name = { HGT: "HGT", TMP: "TMP", RH: "RH", UGRD: "UGRD", VGRD: "VGRD", W: "DZDT", ABSV: "ABSV" };
  for (const [f, as] of Object.entries(name)) data[as] = levels.map((mb) => blocks[`${f}:${mb}`]);
  for (const [tag, a] of Object.entries(blocks)) {
    let m;
    if ((m = /^AGL(\d+):(\w+)$/.exec(tag))) (agl[+m[1]] ||= {})[m[2]] = a;
    else if ((m = /^SFC:(\w+)$/.exec(tag))) surface[m[1]] = a;
  }
  const grid = new LambertGrid(header.grid);
  grid.check();
  const lat = new Float64Array(n), lon = new Float64Array(n);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = grid.latLon(header.crop.i0 + i, header.crop.j0 + j); lat[j * w + i] = p.lat; lon[j * w + i] = p.lon;
  }
  return { model: model.id, cycle, fhr, valid: new Date(cycle.getTime() + fhr * 3600e3), levels, agl, crop: header.crop, grid: header.grid,
           lat, lon, data, surface, bytes: packed.byteLength, ms: performance.now() - t0, pack: { missing: header.missing, wFrom: header.wFrom } };
}
