// Model data kept on this device: files that never change once posted are stored in the
// browser (its Cache Storage) the first time they're downloaded, and read from there after
// that, across reloads and visits, so the same run isn't downloaded twice.
//
// Kept (immutable once they exist):
//   HRRR Zarr tiles (hrrrzarr bucket: the numbered chunks and forecast_period; not the .zarray
//     metadata, which tells whether a run is there yet);
//   GRIB byte ranges and their .idx / .index files (HRRR, RRFS, GFS, GFS-Wave, ECMWF);
//   SSCOFS hours and mesh (the hour files carry their run in the query; the mesh its hash).
// Never kept: anything that says what's newest (SSCOFS latest.json, run listings), forecasts,
// observations, this site's own files (the browser's HTTP cache has those).
//
// A cache a day ("wve-data-YYYYMMDD"); caches more than 3 days old are dropped, and the oldest
// days go while the whole store is over ~1.5 GB. Off switch: Data tab → "Keep downloaded model
// data on this device" (localStorage "wve.store" = "off"), which also clears it.
// Installed over window.fetch after the download meter (netmeter.js), so what's read from here
// isn't counted as downloaded; the meter shows it separately (addLocal).

import { addLocal } from "../netmeter.js?v=20261002173952";

const PREFIX = "wve-data-", KEEP_DAYS = 3, MAX_BYTES = 1.5e9;
const KEEP = [
  (u) => u.hostname === "hrrrzarr.s3.amazonaws.com" && /\/(\d+(\.\d+)*|forecast_period\/0)$/.test(u.pathname),
  (u) => /^(noaa-hrrr-bdp-pds|noaa-rrfs-ops-pds|noaa-rrfs-pds|noaa-gfs-bdp-pds)\.s3\.amazonaws\.com$/.test(u.hostname) || u.hostname === "ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
  (u) => u.hostname === "fp-sea.github.io" && /\/salish-currents\/sscofs\/(\d{10}\/t1-f\d+\.bin\.gz|mesh-[0-9a-f]+\/(nodes\.f32|nv\.u32)\.gz)$/.test(u.pathname),
];
const on = () => { try { return localStorage.getItem("wve.store") !== "off" && "caches" in window; } catch { return "caches" in window; } };
const today = () => { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`; };

function keepable(url) {
  try { const u = new URL(url, location.href); return u.origin !== location.origin && KEEP.some((f) => f(u)); } catch { return false; }
}
// The stored key: the URL, with the byte range (a Range request) as a query parameter.
function keyFor(url, range) { return range ? `${url}${url.includes("?") ? "&" : "?"}wve-range=${encodeURIComponent(range)}` : url; }

const netFetch = window.fetch.bind(window);          // (the meter's, which counts downloads)
let stats = { hits: 0, bytes: 0 };
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" || !on() || !keepable(url)) return netFetch(input, init);
  const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)), range = h.get("range") || "";
  const key = keyFor(url, range);
  try {
    const hit = await caches.match(key);
    if (hit) {
      const buf = await hit.arrayBuffer();
      stats.hits++; stats.bytes += buf.byteLength; addLocal(buf.byteLength, url);
      return new Response(buf, { status: range ? 206 : 200, headers: { "content-type": hit.headers.get("content-type") || "application/octet-stream", "x-wve-store": "hit" } });
    }
  } catch { /* storage unavailable: the network */ }
  const r = await netFetch(input, init);
  if (r.ok && (r.status === 200 || r.status === 206)) {
    // (stored as a plain 200: the Cache API won't keep a 206; the range is in the key)
    r.clone().arrayBuffer().then((buf) => caches.open(PREFIX + today()).then((c) => c.put(key, new Response(buf, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } }))))
      .then(() => trimSoon()).catch(() => {});
  }
  return r;
};

// Old days and the size cap, a few seconds after storing (not on every file).
let trimT = null;
function trimSoon() { clearTimeout(trimT); trimT = setTimeout(trim, 5000); }
export async function trim() {
  if (!("caches" in window)) return;
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX)).sort();
  const cut = new Date(Date.now() - KEEP_DAYS * 86400e3), cutKey = PREFIX + `${cut.getUTCFullYear()}${String(cut.getUTCMonth() + 1).padStart(2, "0")}${String(cut.getUTCDate()).padStart(2, "0")}`;
  for (const n of names) if (n < cutKey) await caches.delete(n);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  let left = (await caches.keys()).filter((n) => n.startsWith(PREFIX)).sort();
  while (est && est.usage > MAX_BYTES && left.length > 1) { await caches.delete(left.shift()); est.usage = (await navigator.storage.estimate()).usage; }
}
// What's stored (for the Data tab): → {bytes (the browser's estimate for this site), days, hits, readBytes}
export async function storeInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const days = "caches" in window ? (await caches.keys()).filter((n) => n.startsWith(PREFIX)).length : 0;
  return { bytes: est?.usage ?? NaN, quota: est?.quota ?? NaN, days, hits: stats.hits, readBytes: stats.bytes, on: on() };
}
export async function clearStore() { if ("caches" in window) for (const n of await caches.keys()) if (n.startsWith(PREFIX)) await caches.delete(n); }
export function setStoreOn(v) { try { localStorage.setItem("wve.store", v ? "on" : "off"); } catch { /* no storage */ } if (!v) clearStore(); }
setTimeout(() => trim().catch(() => {}), 8000);      // (once after the page settles)
