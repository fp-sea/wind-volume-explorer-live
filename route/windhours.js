// The 10 m wind and surface gust for every hour of the loaded run, over the region, for the
// passage planner: the only model fields routing needs.
//
// HRRR: from the HRRR Zarr copy when this run is posted there (each map tile holds every hour, so
// the whole run is ~10-15 MB for the Salish Sea); otherwise, and for the other models, from each
// hour's GRIB surface file by byte range (UGRD and VGRD at 10 m, GUST; on HRRR ~6 MB an hour, as
// its messages cover the whole country; RRFS Hawaiʻi's are small). Hours the explorer already
// holds are reused. → {hours, grid, box, frames: Map fhr → {U, V, G}, bytes, source}

import { loadSurfaceRun } from "../model/hrrrzarr.js?v=20261002173952";
import { fileUrl, cropFor, decodeCropped } from "../model/rrfs.js?v=20261002173952";
import { fetchIdx, fetchMessages, pool } from "../model/fetch.js?v=20261002173952";
import { decodeMessage } from "../model/grib2.js?v=20261002173952";
import { gridOf } from "../model/volume.js?v=20261002173952";

const KEYS = ["UGRD:10 m above ground", "VGRD:10 m above ground", "GUST:surface"];
const cache = new Map();

function turn(geo, box, U, V) {
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) {
    const c = j * box.w + i, a = geo.turnAt(box.i0 + i, box.j0 + j), co = Math.cos(a), si = Math.sin(a), u = U[c], v = V[c];
    U[c] = co * u + si * v; V[c] = -si * u + co * v;
  }
}

// model, cycle: the run; hours: the forecast hours wanted; bbox: the region; stores: the
// explorer's per-hour stores (reused where they hold the fields).
export function loadRunWind(model, cycle, hours, bbox, { stores = new Map(), onProgress, signal } = {}) {
  const key = `${model.id}|${cycle.getTime()}|${hours[0]}-${hours.at(-1)}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    if (model.id.startsWith("hrrr")) {
      const z = await loadSurfaceRun(cycle, bbox, { signal, onProgress: (p) => onProgress?.({ bytes: p.bytes, done: 0, of: 1 }) });
      if (z && hours.every((h) => z.frames.has(h))) return z;
      if (model.source === "hrrrzarr") throw new Error("this run isn't fully in the HRRR Zarr yet");
    }
    let grid = null, box = null, bytes = 0, done = 0;
    const frames = new Map();
    await pool(hours.map((fhr) => async () => {
      const st = stores.get(fhr);
      if (st?.arr?.has(KEYS[0]) && st.arr.has(KEYS[1]) && st.box) {
        grid ||= st.geo; box ||= st.box;
        // (copies: the explorer reuses its hour stores' arrays as it loads other hours, which would
        // change the planner's wind under a plan)
        frames.set(fhr, { U: st.arr.get(KEYS[0]).slice(), V: st.arr.get(KEYS[1]).slice(), G: st.arr.get(KEYS[2])?.slice() || null });
      } else {
        const url = fileUrl(model, cycle, fhr, { which: model.path2d ? "path2d" : "path" });
        const idx = await fetchIdx(url, { signal });
        const msgs = await fetchMessages(url, KEYS.filter((k) => idx.some((e) => e.key === k)), { idx, signal, onBytes: (n) => { bytes += n; onProgress?.({ bytes, done, of: hours.length }); } });
        if (!grid) { grid = gridOf(decodeMessage(msgs.get(KEYS[0])).grid); box = cropFor(grid, bbox); }
        const [U, V, G] = await Promise.all(KEYS.map((k) => (msgs.has(k) ? decodeCropped(msgs.get(k), box).then((r) => r.values) : null)));
        if (grid.turnAt) turn(grid, box, U, V);
        frames.set(fhr, { U, V, G });
      }
      done++; onProgress?.({ bytes, done, of: hours.length });
    }), 3);
    return { hours, grid, box, frames, bytes, source: "the model's GRIB surface files, hour by hour" };
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return job;
}
