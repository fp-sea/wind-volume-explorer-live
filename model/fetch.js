// Generic GRIB2 fetch: .idx parsing, byte ranges coalesced into few requests, bounded
// concurrency, and errors that say which of the three states happened (brief §6):
//
//   CapabilityAbsent  expected: this model/file doesn't carry that field. Disable the
//                     control and caption it; never substitute anything.
//   FetchFailed       a real failure right now: network, CORS, HTTP status, decode.
//   stale             not an error: the data arrived but is older than expected. The
//                     caller decides that from the cycle time (see rrfs.js).

export class CapabilityAbsent extends Error { constructor(msg, keys) { super(msg); this.name = "CapabilityAbsent"; this.keys = keys; } }
export class FetchFailed extends Error { constructor(msg, cause) { super(msg); this.name = "FetchFailed"; this.cause = cause; } }

// "<n>:<start>:d=<cycle>:<PARAM>:<LEVEL>:<STEP>:..." → [{n, start, end, key, name, level, step}]
export function parseIdx(text) {
  const rows = text.trim().split("\n").filter(Boolean).map((l) => l.split(":"));
  return rows.map((r, i) => ({
    n: +r[0], start: +r[1], end: i + 1 < rows.length ? +rows[i + 1][1] : null,     // end exclusive; null = EOF
    name: r[3], level: r[4], key: `${r[3]}:${r[4]}`, step: r[5] || "",
  }));
}

// Group wanted messages into ranges, bridging gaps up to maxGap bytes (fetching a few
// unwanted bytes beats another request). Returns [{start, end, parts: [{entry, off}]}].
export function coalesce(entries, maxGap = 150_000) {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && last.end !== null && e.start - last.end <= maxGap) {
      last.parts.push({ entry: e, off: e.start - last.start });
      last.end = e.end;
    } else out.push({ start: e.start, end: e.end, parts: [{ entry: e, off: 0 }] });
  }
  return out;
}

// (A dropped or throttled request — a network error, a 5xx or no answer in 45 s — is tried
// again, up to 3 times, pausing 1 then 3 s, so one bad request doesn't stall or end a load.)
async function get(url, { range, signal } = {}) {
  let last = null;
  for (let k = 0; k < 3; k++) {
    let r;
    const t = AbortSignal.timeout ? AbortSignal.timeout(45000) : null, sig = t && AbortSignal.any ? AbortSignal.any([t, signal].filter(Boolean)) : signal;
    try {
      r = await fetch(url, { signal: sig, headers: range ? { Range: `bytes=${range.start}-${range.end == null ? "" : range.end - 1}` } : {} });
    } catch (e) {
      if (signal?.aborted) throw e;
      last = new FetchFailed(e.name === "TimeoutError" ? `no answer in 45 s: ${url.split("/").pop()}` : `network or CORS failure: ${url.split("/").pop()}`, e);
      await new Promise((q) => setTimeout(q, k ? 3000 : 1000));
      continue;
    }
    if (r.ok || r.status === 206) return r;
    last = new FetchFailed(`HTTP ${r.status}: ${url.split("/").pop()}`);
    if (r.status < 500) throw last;                             // (a 4xx is an answer)
    await new Promise((q) => setTimeout(q, k ? 3000 : 1000));
  }
  throw last;
}

export async function fetchIdx(url, opts) {
  return parseIdx(await (await get(url + ".idx", opts)).text());
}

// Does this file exist yet? A one-byte GET of its .idx (the .idx lands after the file). Not HEAD:
// the HRRR bucket's CORS rules allow GET only, so a HEAD fails there as a network error.
export async function exists(url, { signal } = {}) {
  try { const r = await fetch(url + ".idx", { headers: { Range: "bytes=0-0" }, signal }); return r.ok || r.status === 206; } catch { return false; }
}

// Run async jobs with at most `limit` in flight.
export async function pool(jobs, limit = 6) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

// Fetch the raw GRIB messages for `keys` from one file. Missing keys raise
// CapabilityAbsent (listing all of them) before any data is fetched.
// Returns Map key → Uint8Array (one complete message each).
export async function fetchMessages(url, keys, { idx = null, signal, onBytes } = {}) {
  idx = idx || await fetchIdx(url, { signal });
  const byKey = new Map(idx.map((e) => [e.key, e]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) throw new CapabilityAbsent(`not in ${url.split("/").pop()}: ${missing.join(", ")}`, missing);
  const ranges = coalesce(keys.map((k) => byKey.get(k)));
  const out = new Map();
  await pool(ranges.map((rg) => async () => {
    const buf = new Uint8Array(await (await get(url, { range: rg, signal })).arrayBuffer());
    onBytes?.(buf.length);
    for (const { entry, off } of rg.parts) {
      const len = (entry.end ?? rg.start + buf.length) - entry.start;
      const msg = buf.subarray(off, off + len);
      if (msg[0] !== 0x47 || msg[1] !== 0x52 || msg[2] !== 0x49 || msg[3] !== 0x42) throw new FetchFailed(`bad GRIB message for ${entry.key}`);
      out.set(entry.key, msg);
    }
  }));
  return out;
}
