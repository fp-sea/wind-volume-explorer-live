// Download meter: bytes this page has downloaded over the last 10 minutes, shown as a small chip
// in the top bar (total and a per-minute sparkline), with a breakdown by source on hover.
//
// Counted:
//   - fetch() from other sites (model GRIB ranges, Zarr chunks, wave model, long-range wind,
//     satellite, observations, forecasts): the response's Content-Length (the bytes on the wire,
//     compressed), or as the body is read when there is none. HEAD requests carry no body.
//   - everything from this site (data, charts, masks, the page, modules, styles, the ground
//     photo) and other sites' scripts and fonts: the browser's resource timing, whose transfer
//     size is 0 when the file came from the browser's cache, so a reload isn't counted twice.
// The decode worker only decodes (no fetches). Imported first in app.js so it sees everything.
// Model data read back from this device (model/store.js) isn't a download: it's shown apart.

const WINDOW_MS = 10 * 60e3, BARS = 10;
const events = [];                          // [time ms, bytes, source]
let session = 0, chip = null, spark = null, listeners = [];
const sessionBy = new Map(), reqs = new Map();   // source → bytes since the page opened; → requests

const SOURCES = [
  [/noaa-hrrr|noaa-rrfs|hrrrzarr|mesowest|hrrr-bdp|rrfs-pds/i, "weather model"],
  [/gfswave|wave\//i, "wave model"],
  [/noaa-gfs-bdp/i, "long-range wind (GFS)"],
  [/ecmwf-forecasts/i, "long-range wind (ECMWF)"],
  [/tidesandcurrents/i, "tides & currents (NOAA)"],
  [/gibs\.earthdata/i, "satellite"],
  [/charttools\.noaa\.gov/i, "NOAA chart (live)"],
  [/api\.weather\.gov|weather\.gc\.ca|mesonet\.agron|ndbc/i, "observations & forecasts"],
  [/jsdelivr|cdnjs|fonts\.g/i, "libraries & fonts"],
];
function sourceOf(url) {
  let u;
  try { u = new URL(url, location.href); } catch { return "other"; }
  if (u.origin === location.origin) return /\/noaachart\/|chart19320/.test(u.pathname) ? "charts (stored with the site)" : "this site's data";
  for (const [re, name] of SOURCES) if (re.test(u.hostname + u.pathname)) return name;
  return "other";
}
function add(bytes, url) {
  if (!(bytes > 0)) return;
  const src = sourceOf(url);
  events.push([performance.now(), bytes, src]);
  session += bytes;
  sessionBy.set(src, (sessionBy.get(src) || 0) + bytes); reqs.set(src, (reqs.get(src) || 0) + 1);
  schedule();
}

// Model data read from this device instead of downloaded (model/store.js).
let localSession = 0, localFiles = 0;
export function addLocal(bytes) { localSession += bytes; localFiles++; schedule(); }

// fetch(): count when the headers arrive (Content-Length), or as the body is read.
const counted = new WeakSet(), origFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const r = await origFetch(input, init);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "HEAD") return r;
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (sameSite(url)) return r;                               // (resource timing counts these)
  const len = +r.headers.get("content-length");
  if (len > 0) { add(len, url); counted.add(r); }
  else r._meterUrl = url;
  return r;
};
for (const m of ["arrayBuffer", "blob", "text", "json"]) {
  const orig = Response.prototype[m];
  Response.prototype[m] = async function (...a) {
    const out = await orig.apply(this, a);
    if (this._meterUrl && !counted.has(this)) {
      counted.add(this);
      add(out?.byteLength ?? out?.size ?? (typeof out === "string" ? out.length : JSON.stringify(out ?? "").length), this._meterUrl);
    }
    return out;
  };
}
function sameSite(url) { try { return new URL(url, location.href).origin === location.origin; } catch { return false; } }
// This site's files (fetched or not) and other sites' non-fetch files (libraries, fonts).
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if ((e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") && !sameSite(e.name)) continue;
      add(e.transferSize || e.encodedBodySize, e.name);
    }
  }).observe({ type: "resource", buffered: true });
  // (the timeline keeps 250 entries by default; the observer has its copies, so keep it from filling)
  performance.addEventListener?.("resourcetimingbufferfull", () => performance.clearResourceTimings());
} catch { /* old browser: script-fetched bytes only */ }

// ---------- the chip ----------
const fmt = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
let pending = false;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; draw(); }); } }

export function recentBytes() {
  const now = performance.now();
  while (events.length && now - events[0][0] > WINDOW_MS) events.shift();
  return events.reduce((s, e) => s + e[1], 0);
}
export function onMeter(fn) { listeners.push(fn); }

function draw() {
  const now = performance.now(), total = recentBytes();
  if (!chip) return;
  const bins = new Array(BARS).fill(0), by = new Map();
  for (const [t, b, src] of events) {
    const k = BARS - 1 - Math.min(BARS - 1, Math.floor((now - t) / 60e3));
    bins[k] += b; by.set(src, (by.get(src) || 0) + b);
  }
  chip.querySelector(".nm-val").textContent = total ? fmt(total) : "0 MB";
  const max = Math.max(...bins, 1), g = spark.getContext("2d"), W = spark.width, H = spark.height, bw = W / BARS;
  g.clearRect(0, 0, W, H);
  bins.forEach((b, i) => {
    if (!b) { g.fillStyle = "rgba(159,199,207,.25)"; g.fillRect(i * bw + 1, H - 1, bw - 2, 1); return; }
    const h = Math.max(2, Math.round((Math.sqrt(b) / Math.sqrt(max)) * (H - 1)));
    g.fillStyle = i === BARS - 1 ? "#ffcf8a" : "#9fc7cf";
    g.fillRect(i * bw + 1, H - h, bw - 2, h);
  });
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([s, b]) => `  ${s}: ${fmt(b)}`).join("\n");
  if (panel && !panel.hidden) fillPanel(by);
  chip.title = `Click for the breakdown by source. Downloaded in the last 10 minutes: ${fmt(total)}${rows ? `\n${rows}` : ""}\nSince this page opened: ${fmt(session)}${localSession ? `\nRead from this device instead (kept model data): ${fmt(localSession)}` : ""}\nBars: one per minute, newest on the right (height by √bytes).`;
  for (const fn of listeners) fn(total);
}

// The breakdown (click the chip): each source's bytes in the last 10 minutes and since the page
// opened, and its requests.
let panel = null;
function fillPanel(by) {
  const srcs = [...new Set([...sessionBy.keys(), ...by.keys()])].sort((a, b) => (sessionBy.get(b) || 0) - (sessionBy.get(a) || 0));
  panel.innerHTML = `<div class="nm-h"><b>Downloads</b><button class="btn mini" title="Close">✕</button></div><table><thead><tr><th>Source</th><th>Last 10 min</th><th>Since opened</th><th>Requests</th></tr></thead><tbody>`
    + srcs.map((s) => `<tr><td>${s}</td><td>${by.get(s) ? fmt(by.get(s)) : "–"}</td><td>${fmt(sessionBy.get(s) || 0)}</td><td>${reqs.get(s) || 0}</td></tr>`).join("")
    + `<tr class="tot"><td>Total</td><td>${fmt([...by.values()].reduce((a, b) => a + b, 0))}</td><td>${fmt(session)}</td><td>${[...reqs.values()].reduce((a, b) => a + b, 0)}</td></tr></tbody></table>`
    + (localSession ? `<p><b>Read from this device instead of downloading:</b> ${fmt(localSession)} in ${localFiles} files since the page opened (model data kept from earlier: Data tab → Kept on this device).</p>` : "")
    + `<p>Every download the page makes: script fetches (model data, charts, satellite, forecasts, the site's own files) by their size on the wire, and the page's own files, libraries and fonts from the browser's timing. Files the browser already had in its cache count as nothing. Model data is fetched by byte range, so only the fields and area used count.</p>`;
  panel.querySelector("button").onclick = () => { panel.hidden = true; };
}

export function mountMeter(parent) {
  chip = document.createElement("span");
  chip.id = "netmeter";
  chip.innerHTML = `<span class="nm-lab">↓</span><span class="nm-val">0 MB</span><canvas width="40" height="12"></canvas><span class="nm-lab">10 min</span>`;
  spark = chip.querySelector("canvas");
  parent.append(chip);
  panel = document.createElement("div"); panel.id = "nm-panel"; panel.hidden = true; document.body.append(panel);
  chip.style.cursor = "pointer";
  chip.addEventListener("click", () => { panel.hidden = !panel.hidden; if (!panel.hidden) draw(); });
  setInterval(draw, 10e3);                                   // old minutes roll off even when idle
  draw();
}
