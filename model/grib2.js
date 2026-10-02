// SYNC: radar-explorer web/model/grib2.js@7439092. Copied verbatim except the lines marked "WVE CHANGE"
// (the Mercator grid, 3.10). scripts/check_sync.py reports upstream changes; pipeline/fetch/grib_check.py
// checks this decoder against ecCodes on real RRFS messages.

// GRIB2, just what NOAA's GFS and HRRR files need: one message at a time, a
// regular latitude/longitude grid (template 3.0, GFS) or Lambert conformal
// (3.30, HRRR: only its size and scan order are read, the projection is
// web/model/hrrr.js's), and "complex packing with spatial differencing"
// (template 5.3, also plain 5.0), no bitmap.
//
// Template 5.3 in short: values are stored as differences from their
// neighbours (first or second order), split into groups; each group has a
// reference value, a bit width and a length, and its values are packed at that
// width. Undo the groups, then the differencing, then scale:
//   value = (R + X · 2^E) / 10^D

// Big-endian bit reader.
class Bits {
  constructor(b, byte) { this.b = b; this.pos = byte * 8; }
  read(n) {
    let v = 0;
    while (n > 0) {                                  // a byte's worth at a time
      const off = this.pos & 7, take = Math.min(n, 8 - off);
      v = v * (1 << take) + ((this.b[this.pos >> 3] >> (8 - off - take)) & ((1 << take) - 1));
      this.pos += take; n -= take;
    }
    return v;
  }
  align() { this.pos = Math.ceil(this.pos / 8) * 8; }
}
// Sign-and-magnitude integers (GRIB's signed convention).
const sm = (v, bits) => (v >= 2 ** (bits - 1) ? -(v - 2 ** (bits - 1)) : v);

export function decodeMessage(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 4)) !== "GRIB") throw new Error("not GRIB");
  let p = 16, grid = null, s5 = null, data = null, bitmap = 255;
  while (p < b.length - 4) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;
    const len = dv.getUint32(p), sec = b[p + 4];
    if (sec === 3) {
      const tpl = dv.getUint16(p + 12);
      const s32 = (o) => sm(dv.getUint32(p + o), 32);
      if (tpl === 30) grid = { tpl, ni: dv.getUint32(p + 30), nj: dv.getUint32(p + 34), la1: s32(38) / 1e6, lo1: s32(42) / 1e6, scan: b[p + 64],
        // WVE CHANGE: the full Lambert header (projection constants, spacing, earth shape) for web/model/lambert.js.
        shape: b[p + 14], lad: s32(47) / 1e6, lov: s32(51) / 1e6, dx: dv.getUint32(p + 55) / 1e3, dy: dv.getUint32(p + 59) / 1e3,
        latin1: s32(65) / 1e6, latin2: s32(69) / 1e6, uvGrid: !!(b[p + 46] & 8) };
      // WVE CHANGE: Mercator (3.10), used by RRFS's Hawaiʻi grids. Di/Dj are metres at latitude LaD.
      else if (tpl === 10) grid = { tpl, shape: b[p + 14], ni: dv.getUint32(p + 30), nj: dv.getUint32(p + 34), la1: s32(38) / 1e6, lo1: s32(42) / 1e6,
               lad: s32(47) / 1e6, la2: s32(51) / 1e6, lo2: s32(55) / 1e6, scan: b[p + 59], di: dv.getUint32(p + 64) / 1e3, dj: dv.getUint32(p + 68) / 1e3 };
      else if (tpl !== 0) throw new Error(`GRIB grid template 3.${tpl} not supported`);
      else grid = { tpl, ni: dv.getUint32(p + 30), nj: dv.getUint32(p + 34), la1: s32(46) / 1e6, lo1: s32(50) / 1e6,
               la2: s32(55) / 1e6, lo2: s32(59) / 1e6, di: dv.getUint32(p + 63) / 1e6, dj: dv.getUint32(p + 67) / 1e6, scan: b[p + 71] };
    } else if (sec === 5) {
      s5 = { p, n: dv.getUint32(p + 5), tpl: dv.getUint16(p + 9) };
    } else if (sec === 6) {
      bitmap = b[p + 5];
    } else if (sec === 7) {
      data = { p: p + 5, end: p + len };
    }
    p += len;
  }
  if (!grid || !s5 || !data) throw new Error("incomplete GRIB message");
  if (bitmap !== 255) throw new Error("GRIB bitmaps not supported");
  const q = s5.p;
  const R = dv.getFloat32(q + 11), E = sm(dv.getUint16(q + 15), 16), D = sm(dv.getUint16(q + 17), 16), nbits = b[q + 19];
  const scaleE = 2 ** E, scaleD = 10 ** D, n = s5.n, out = new Float32Array(n);
  if (s5.tpl === 0) {
    if (nbits === 0) { out.fill(R / scaleD); return { grid, values: out }; }
    const r = new Bits(b, data.p);
    for (let i = 0; i < n; i++) out[i] = (R + r.read(nbits) * scaleE) / scaleD;
    return { grid, values: out };
  }
  // WVE CHANGE: CCSDS/AEC packing (5.42), used by ECMWF's open data.
  if (s5.tpl === 42) {
    const X = aecDecode(b, data.p, data.end, n, nbits, b[q + 21], b[q + 22], dv.getUint16(q + 23));
    for (let i = 0; i < n; i++) out[i] = (R + X[i] * scaleE) / scaleD;
    return { grid, values: out };
  }
  if (s5.tpl !== 3 && s5.tpl !== 2) throw new Error(`GRIB packing template 5.${s5.tpl} not supported`);
  const missMgmt = b[q + 22], ng = dv.getUint32(q + 31);
  const refW = b[q + 35], bitsW = b[q + 36], refL = dv.getUint32(q + 37), incL = b[q + 41];
  const lastL = dv.getUint32(q + 42), bitsL = b[q + 46];
  const order = s5.tpl === 3 ? b[q + 47] : 0, extra = s5.tpl === 3 ? b[q + 48] : 0;
  let d = data.p;
  const extraVal = () => { let v = 0; for (let k = 0; k < extra; k++) v = v * 256 + b[d + k]; d += extra; return sm(v, extra * 8); };
  const ival1 = order >= 1 ? extraVal() : 0, ival2 = order === 2 ? extraVal() : 0, minsd = order >= 1 ? extraVal() : 0;
  const r = new Bits(b, d);
  const refs = new Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = r.read(nbits);
  r.align();
  const widths = new Array(ng);
  for (let g = 0; g < ng; g++) widths[g] = refW + r.read(bitsW);
  r.align();
  const lens = new Array(ng);
  for (let g = 0; g < ng; g++) lens[g] = refL + incL * r.read(bitsL);
  lens[ng - 1] = lastL;
  r.align();
  const h = new Float64Array(n);
  const miss = new Uint8Array(n);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const w = widths[g], L = lens[g], allOnes = 2 ** w - 1;
    for (let i = 0; i < L && k < n; i++, k++) {
      if (w === 0) {
        h[k] = refs[g];
        if (missMgmt && refs[g] === 2 ** nbits - 1) miss[k] = 1;
      } else {
        const v = r.read(w);
        if (missMgmt && v === allOnes) miss[k] = 1; else h[k] = refs[g] + v;
      }
    }
  }
  // Undo the spatial differencing over the values that are present.
  if (order >= 1) {
    const idx = [];
    for (let i = 0; i < n; i++) if (!miss[i]) idx.push(i);
    for (const i of idx) h[i] += minsd;
    if (order === 1) {
      if (idx.length) h[idx[0]] = ival1;
      for (let m = 1; m < idx.length; m++) h[idx[m]] += h[idx[m - 1]];
    } else {
      if (idx.length) h[idx[0]] = ival1;
      if (idx.length > 1) h[idx[1]] = ival2;
      for (let m = 2; m < idx.length; m++) h[idx[m]] += 2 * h[idx[m - 1]] - h[idx[m - 2]];
    }
  }
  for (let i = 0; i < n; i++) out[i] = miss[i] ? NaN : (R + h[i] * scaleE) / scaleD;
  return { grid, values: out };
}

// Keep only columns i0..i1, rows j0..j1 of the decoded grid (the area on
// screen): a whole HRRR field is ~7.6 MB, the area ~50 KB.
export function cropGrid(grid, values, { i0, i1, j0, j1 }) {
  i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(grid.ni - 1, i1); j1 = Math.min(grid.nj - 1, j1);
  if (i1 < i0 || j1 < j0) return { grid, values };
  const w = i1 - i0 + 1, h = j1 - j0 + 1, out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) out.set(values.subarray((j0 + j) * grid.ni + i0, (j0 + j) * grid.ni + i0 + w), j * w);
  return { grid: { ...grid, crop: { i0, j0, w, h } }, values: out };
}

// WVE CHANGE: CCSDS 121.0 lossless decoding (the "adaptive entropy coder", libaec), GRIB template
// 5.42. The stream is blocks of J samples, grouped into reference sample intervals (RSI) of `rsi`
// blocks; each block starts with an option ID: zero blocks or the "second extension" (ID 0), the
// Rice split-sample code with k low bits (ID 1…), or uncompressed (all ones). With preprocessing
// (flag 8) the first sample of each RSI is a raw reference and the others are mapped prediction
// residuals, undone here as libaec does (unsigned data). Flag 32: each RSI padded to a byte.
export function aecDecode(b, start, end, n, nbits, flags, J, rsi) {
  const pre = !!(flags & 8), pad = !!(flags & 32), out = new Float64Array(n);
  const idLen = nbits > 16 ? 5 : nbits > 8 ? 4 : 3, idMax = (1 << idLen) - 1;
  let pos = start * 8;
  const endBit = end * 8;
  const bit = () => { const v = (b[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
  const read = (k) => { let v = 0; for (let i = 0; i < k; i++) v = v * 2 + ((b[pos >> 3] >> (7 - (pos & 7))) & 1), pos++; return v; };
  const fs = () => { let z = 0; while (pos < endBit && !bit()) z++; return z; };
  // Second extension: m → the pair via triangular numbers.
  const SE = []; for (let beta = 0, m = 0; m < 92; beta++) for (let i = 0; i <= beta && m < 92; i++, m++) SE.push([beta, (beta * (beta + 1)) / 2]);
  let o = 0;
  while (o < n && pos < endBit) {
    const r0 = o;
    for (let blk = 0; blk < rsi && o < n && pos < endBit; ) {
      const id = read(idLen), ref = pre && blk === 0;
      if (id === 0) {
        const second = bit();
        if (ref) out[o++] = read(nbits);
        if (!second) {                                                   // zero blocks
          let zb = fs() + 1;
          if (zb === 5) zb = Math.min(64 - (blk % 64), rsi - blk); else if (zb > 5) zb--;
          const cnt = zb * J - (ref ? 1 : 0);
          for (let i = 0; i < cnt && o < n; i++) out[o++] = 0;
          blk += zb;
        } else {                                                         // second extension
          for (let i = ref ? 1 : 0; i < J; ) {
            const m = fs(), [beta, ms] = SE[m] || [0, 0], d1 = m - ms;
            if ((i & 1) === 0) { if (o < n) out[o++] = beta - d1; i++; }
            if (o < n) out[o++] = d1; i++;
          }
          blk++;
        }
      } else if (id === idMax) {                                         // uncompressed (the reference is the first sample)
        for (let i = 0; i < J && o < n; i++) out[o++] = read(nbits);
        blk++;
      } else {                                                           // split sample, k low bits
        const k = id - 1, first = o;
        if (ref) out[o++] = read(nbits);
        const cnt = J - (ref ? 1 : 0), hi = new Array(cnt);
        for (let i = 0; i < cnt; i++) hi[i] = fs();
        for (let i = 0; i < cnt; i++) { const v = hi[i] * 2 ** k + (k ? read(k) : 0); if (o < n) out[o++] = v; }
        void first;
        blk++;
      }
    }
    // Undo the preprocessing over this RSI (unsigned: libaec's flush_unsigned).
    if (pre) {
      const xmax = 2 ** nbits - 1, med = Math.floor(xmax / 2) + 1;
      let data = out[r0];
      for (let i = r0 + 1; i < o; i++) {
        const d = out[i], half = Math.floor(d / 2) + (d % 2), mask = data >= med ? xmax : 0, dist = mask ? xmax - data : data;
        if (half <= dist) data = d % 2 ? data - (Math.floor(d / 2) + 1) : data + d / 2;
        else data = mask ? xmax - d : d;
        out[i] = data;
      }
    }
    if (pad) pos = Math.ceil(pos / 8) * 8;
  }
  return out;
}
