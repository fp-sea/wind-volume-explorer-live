// Swell (and the wave model's own wind sea) from NOAA's GFS-Wave (WAVEWATCH III), read in the
// browser from the NOAA Open Data bucket (noaa-gfs-bdp-pds, CORS open):
//   gfs.YYYYMMDD/HH/wave/gridded/gfswave.tHHz.{grid}.fFFF.grib2 (+ .idx)
//   grids: wcoast.0p16 (25-50 N, 150-110 W: the Salish Sea approaches), epacif.0p16 (Hawaiʻi)
//   runs 00/06/12/18Z, hourly output; fields per point: HTSGW (all waves), WVHGT/WVPER/WVDIR
//   (wind sea), SWELL/SWPER/SWDIR in up to three partitions ("1/2/3 in sequence"), all at 1/6°.
// The messages are JPEG2000-packed (GRIB2 template 5.40), decoded with OpenJPEG compiled to
// WebAssembly (loaded from jsDelivr only when this is used). Land and sheltered waters are
// masked (bitmap): no swell reaches the inner Salish Sea in the model, which is realistic.

import { parseIdx, fetchMessages, exists } from "./fetch.js?v=20261002173952";

const BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
const OJ = "https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.4/dist/";
export const WAVE_GRID = { "salish-sea": "wcoast.0p16", hawaii: "epacif.0p16" };
const url = (grid, cyc, f) => {
  const ymd = cyc.toISOString().slice(0, 10).replace(/-/g, ""), hh = String(cyc.getUTCHours()).padStart(2, "0");
  return `${BUCKET}/gfs.${ymd}/${hh}/wave/gridded/gfswave.t${hh}z.${grid}.f${String(f).padStart(3, "0")}.grib2`;
};

// ---------- OpenJPEG (WASM), once ----------
let ojReady = null;
function openjpeg() {
  if (ojReady) return ojReady;
  ojReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = OJ + "openjpegwasm_decode.js";
    s.onload = () => window.OpenJPEGWASM({ locateFile: (f) => OJ + f }).then(resolve, reject);
    s.onerror = () => reject(new Error("couldn't load the JPEG2000 decoder"));
    document.head.append(s);
  });
  ojReady.catch(() => { ojReady = null; });
  return ojReady;
}

// ---------- GRIB2, lat/lon grid (3.0) + JPEG2000 (5.40) + bitmap ----------
export async function decodeJ2kMessage(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 16, grid = null, rep = null, bitmap = null, data = null;
  const i4 = (p) => { const v = dv.getUint32(p); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
  const i2 = (p) => { const v = dv.getUint16(p); return v & 0x8000 ? -(v & 0x7fff) : v; };
  while (o < buf.length - 4) {
    const L = dv.getUint32(o), n = buf[o + 4];
    if (L === 0x37373737) break;                                   // "7777"
    if (n === 3) {
      const tpl = dv.getUint16(o + 12);
      if (tpl !== 0) throw new Error(`wave grid template ${tpl} not handled`);
      grid = { ni: dv.getUint32(o + 30), nj: dv.getUint32(o + 34), la1: i4(o + 46) / 1e6, lo1: i4(o + 50) / 1e6, la2: i4(o + 55) / 1e6, lo2: i4(o + 59) / 1e6,
               di: dv.getUint32(o + 63) / 1e6, dj: dv.getUint32(o + 67) / 1e6, scan: buf[o + 71] };
    } else if (n === 5) {
      const tpl = dv.getUint16(o + 9);
      if (tpl !== 40) throw new Error(`wave packing template ${tpl} not handled`);
      rep = { npacked: dv.getUint32(o + 5), R: dv.getFloat32(o + 11), E: i2(o + 15), D: i2(o + 17), bits: buf[o + 19] };
    } else if (n === 6) {
      bitmap = buf[o + 5] === 0 ? buf.subarray(o + 6, o + L) : null;
    } else if (n === 7) {
      data = buf.subarray(o + 5, o + L);
    }
    o += L;
  }
  if (!grid || !rep || !data) throw new Error("incomplete wave message");
  const N = grid.ni * grid.nj, out = new Float32Array(N).fill(NaN);
  let packed;
  if (rep.bits === 0 || data.length === 0) packed = new Float64Array(rep.npacked).fill(0);
  else {
    const oj = await openjpeg(), dec = new oj.J2KDecoder();
    dec.getEncodedBuffer(data.length).set(data);
    dec.decode();
    const fi = dec.getFrameInfo(), raw = dec.getDecodedBuffer();
    const n = fi.width * fi.height;
    // The decoder keeps the image width as 16 bits: fields with more than 65,535 sea points
    // (e.g. global.0p25) come back truncated. Our regional grids are well under; refuse rather than misplace values.
    if (n !== rep.npacked) { dec.delete?.(); throw new Error(`JPEG2000 decode gave ${n} of ${rep.npacked} values (grid too large for the decoder)`); }
    packed = fi.bitsPerSample > 8 ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 2)) : Uint8Array.from(raw.subarray(0, n));
    dec.delete?.();
  }
  const f2 = 2 ** rep.E, f10 = 10 ** -rep.D;
  let k = 0;
  for (let q = 0; q < N; q++) {
    if (bitmap && !(bitmap[q >> 3] & (128 >> (q & 7)))) continue;
    out[q] = (rep.R + packed[k++] * f2) * f10;
  }
  return { grid, values: out };
}

// ---------- the newest wave run, and one hour's fields ----------
const FIELDS = ["HTSGW:surface", "WVHGT:surface", "WVPER:surface", "WVDIR:surface",
  ...[1, 2, 3].flatMap((k) => [`SWELL:${k} in sequence`, `SWPER:${k} in sequence`, `SWDIR:${k} in sequence`])];

// The newest run with f000 posted (runs post ~4-5 h after cycle time).
export async function latestWaveCycle(grid, now = new Date()) {
  const t = new Date(Math.floor(now.getTime() / (6 * 3600e3)) * 6 * 3600e3);
  for (let k = 0; k < 6; k++) {
    const c = new Date(t.getTime() - k * 6 * 3600e3);
    if (await exists(url(grid, c, 0))) return c;
  }
  return null;
}

// One valid time: {cycle, fhr, grid, bbox-cropped fields {name: Float32Array}, lat/lon of the crop}.
export async function loadWaveHour(region, bbox, valid, { cycle = null, signal } = {}) {
  const grid = WAVE_GRID[region];
  if (!grid) return null;
  cycle ||= await latestWaveCycle(grid);
  if (!cycle) throw new Error("no wave-model run found");
  const fhr = Math.max(0, Math.min(120, Math.round((valid - cycle) / 3600e3)));
  const u = url(grid, cycle, fhr);
  const r = await fetch(u + ".idx", { signal });
  if (!r.ok) throw new Error(`wave model +${fhr} h not posted (HTTP ${r.status})`);
  const idx = parseIdx(await r.text());
  const msgs = await fetchMessages(u, FIELDS.filter((k) => idx.some((e) => e.key === k)), { idx, signal });
  const out = { cycle, fhr, grid, fields: {} };
  for (const [k, m] of msgs) {
    const { grid: g, values } = await decodeJ2kMessage(m);
    if (!out.g) {                                                   // the crop, with a 2-cell margin
      const lon = (x) => ((x % 360) + 360) % 360;
      const i0 = Math.max(0, Math.floor((lon(bbox.lonMin) - g.lo1) / g.di) - 2), i1 = Math.min(g.ni - 1, Math.ceil((lon(bbox.lonMax) - g.lo1) / g.di) + 2);
      const j0 = Math.max(0, Math.floor((g.la1 - bbox.latMax) / g.dj) - 2), j1 = Math.min(g.nj - 1, Math.ceil((g.la1 - bbox.latMin) / g.dj) + 2);
      out.g = { ...g, i0, j0, w: i1 - i0 + 1, h: j1 - j0 + 1 };
    }
    const { i0, j0, w, h } = out.g, a = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) a[j * w + i] = values[(j0 + j) * g.ni + (i0 + i)];
    const [name, level] = k.split(":");
    out.fields[level.includes("sequence") ? `${name}${level[0]}` : name] = a;
  }
  return out;
}

// The wave model at a point: nearest sea cell within ~2 cells, else null (land or sheltered).
// → {hs (all waves), wind: {hs, tp, dir}, swell: [{hs, tp, dir}] (dir = coming from, deg)}.
export function wavesAt(wh, lat, lon) {
  if (!wh?.g) return null;
  const g = wh.g, lo = ((lon % 360) + 360) % 360, fi = (lo - g.lo1) / g.di - g.i0, fj = (g.la1 - lat) / g.dj - g.j0;
  const F = wh.fields;
  let best = null, bd = Infinity;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const i = Math.round(fi) + di, j = Math.round(fj) + dj;
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
    const c = j * g.w + i;
    if (!Number.isFinite(F.HTSGW?.[c])) continue;
    const d = (i - fi) ** 2 + (j - fj) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  if (best == null) return null;
  const c = best, swell = [];
  for (const k of [1, 2, 3]) {
    const hs = F[`SWELL${k}`]?.[c];
    if (hs > 0.05) swell.push({ hs, tp: F[`SWPER${k}`][c], dir: F[`SWDIR${k}`][c] });
  }
  return { hs: F.HTSGW[c], wind: { hs: F.WVHGT?.[c], tp: F.WVPER?.[c], dir: F.WVDIR?.[c] }, swell };
}

// Total swell energy (Σ Hs², m²) at a point, bilinear between the wave model's cells (sea cells
// only, weights renormalised), for a smooth map; falls back to the nearest cell near the coast.
export function swellHs2At(wh, lat, lon) {
  if (!wh?.g) return null;
  const g = wh.g, F = wh.fields, lo = ((lon % 360) + 360) % 360, fi = (lo - g.lo1) / g.di - g.i0, fj = (g.la1 - lat) / g.dj - g.j0;
  const i0 = Math.floor(fi), j0 = Math.floor(fj), a = fi - i0, b = fj - j0;
  const e = (c) => [1, 2, 3].reduce((s, k) => { const h = F[`SWELL${k}`]?.[c]; return s + (h > 0 ? h * h : 0); }, 0);
  let s = 0, w = 0;
  for (const [di, dj, wt] of [[0, 0, (1 - a) * (1 - b)], [1, 0, a * (1 - b)], [0, 1, (1 - a) * b], [1, 1, a * b]]) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
    const c = j * g.w + i;
    if (!Number.isFinite(F.HTSGW?.[c]) || wt <= 0) continue;
    s += e(c) * wt; w += wt;
  }
  if (w > 0.05) return s / w;
  const n = wavesAt(wh, lat, lon);
  return n ? n.swell.reduce((q, x) => q + x.hs * x.hs, 0) : null;
}
