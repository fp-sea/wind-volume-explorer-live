// Decode (and crop) GRIB2 messages off the page's thread, as radar-explorer does
// (web/model/decodeworker.js there). A whole-CONUS message is ~1.9 M points; only the crop
// comes back, as a transferred Float32Array.

import { decodeMessage } from "./grib2.js?v=20261002173952";

self.onmessage = ({ data: { id, buf, crop } }) => {
  try {
    const { grid, values } = decodeMessage(new Uint8Array(buf));
    if (!crop) { self.postMessage({ id, grid, values }, [values.buffer]); return; }
    const { i0, j0, w, h } = crop, out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) out.set(values.subarray((j0 + j) * grid.ni + i0, (j0 + j) * grid.ni + i0 + w), j * w);
    self.postMessage({ id, grid, values: out }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
