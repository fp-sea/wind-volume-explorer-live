// Per-grid geometry shared by the layers that draw on the model grid (turbulence, inversion):
// each cell's scene x/y, and the full triangle index of the grid. Both depend only on the grid
// (its lat/lon arrays) and the scene projection, not on the hour, so they're computed once
// instead of by every layer on every rebuild (performance review, 2026-09-28).

const XY = new WeakMap(), IDX = new Map();

// Float32Array [x0, y0, x1, y1, …] for vol's cells in proj's scene km.
export function gridXY(vol, proj) {
  const lat = vol.raw.lat, lon = vol.raw.lon;
  let e = XY.get(lat);
  if (e && e.proj === proj && e.lon === lon) return e.xy;
  const n = vol.n, xy = new Float32Array(n * 2);
  for (let c = 0; c < n; c++) { const p = proj.toXY(lat[c], lon[c]); xy[2 * c] = p.x; xy[2 * c + 1] = p.y; }
  XY.set(lat, { proj, lon, xy });
  return xy;
}

// Uint32Array of two triangles per grid square (w × h grid), shared read-only.
export function gridIndex(w, h) {
  const key = `${w}x${h}`;
  let idx = IDX.get(key);
  if (idx) return idx;
  idx = new Uint32Array((w - 1) * (h - 1) * 6);
  let m = 0;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) { const a = j * w + i; idx[m++] = a; idx[m++] = a + 1; idx[m++] = a + w + 1; idx[m++] = a; idx[m++] = a + w + 1; idx[m++] = a + w; }
  IDX.set(key, idx);
  return idx;
}
