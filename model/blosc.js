// SYNC: radar-explorer web/model/blosc.js@20a7d31. Copied verbatim below this header; scripts/check_sync.py reports upstream changes.

// Blosc (v1) with LZ4, as used by the University of Utah's HRRR Zarr archive.
//
// A Blosc frame: a 16-byte header (flags, element size, sizes), a table of
// block offsets, then each block compressed on its own, optionally split into
// one stream per byte of the element ("split" mode) and byte-shuffled first
// (all first bytes of the floats, then all second bytes...), which is what
// makes float fields compress. Decoding undoes it in that order.

// LZ4 block format: sequences of literals then a back-reference.
function lz4Block(src, s, sEnd, dst, d, dEnd) {
  while (s < sEnd) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    for (let k = 0; k < lit; k++) dst[d++] = src[s++];
    if (s >= sEnd) break;                              // the last sequence has no match
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    let from = d - off;
    for (let k = 0; k < len; k++) dst[d++] = dst[from++];
  }
  return d;
}

export function bloscDecode(buf) {
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const flags = src[2], typesize = src[3];
  const nbytes = dv.getUint32(4, true), blocksize = dv.getUint32(8, true);
  const out = new Uint8Array(nbytes);
  if (flags & 0x02) { out.set(src.subarray(16, 16 + nbytes)); return out; }      // stored as is
  const shuffle = flags & 0x01, bitshuffle = flags & 0x04, dontSplit = (flags & 0x10) !== 0;
  const codec = flags >> 5;
  if (bitshuffle) throw new Error("blosc bitshuffle not supported");
  if (codec !== 1) throw new Error(`blosc codec ${codec} not supported (LZ4 only)`);
  const nblocks = Math.ceil(nbytes / blocksize), leftover = nbytes % blocksize;
  const tmp = new Uint8Array(blocksize);
  for (let j = 0; j < nblocks; j++) {
    const bsize = j === nblocks - 1 && leftover ? leftover : blocksize;
    const leftBlock = j === nblocks - 1 && leftover > 0;
    const nsplits = !dontSplit && !leftBlock && typesize <= 16 && bsize / typesize >= 128 ? typesize : 1;
    const neblock = bsize / nsplits;
    let s = dv.getUint32(16 + j * 4, true);
    const target = shuffle && typesize > 1 ? tmp : out, base = shuffle && typesize > 1 ? 0 : j * blocksize;
    for (let k = 0; k < nsplits; k++) {
      const cb = dv.getUint32(s, true);
      s += 4;
      const d0 = base + k * neblock;
      if (cb === neblock) target.set(src.subarray(s, s + cb), d0);                 // stored
      else lz4Block(src, s, s + cb, target, d0, d0 + neblock);
      s += cb;
    }
    if (shuffle && typesize > 1) {
      const n = Math.floor(bsize / typesize), o = j * blocksize;
      for (let b = 0; b < typesize; b++) for (let i = 0; i < n; i++) out[o + i * typesize + b] = tmp[b * n + i];
      for (let r = n * typesize; r < bsize; r++) out[o + r] = tmp[r];              // odd tail bytes
    }
  }
  return out;
}
