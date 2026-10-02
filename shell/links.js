// Shareable links: the page's state as URL query parameters.
//
// Each part of the page registers the parameters it owns, as a writer (current state →
// string, or null to leave the parameter out) and a reader (string → apply). The shell
// owns region, sub, view, case and cam. Layers add their own later (for example the
// marine chart's chart=<op>[,snd][,key], as in radar-explorer), so nothing here needs
// to know about them.
//
// Rules carried over from radar-explorer (commit 33eb6a7 there): a link never carries a
// broken camera, and a link's own camera wins over the view's automatic framing.

const params = new Map();      // key -> { write, read, order }

export function register(key, { write, read, order = 50 }) {
  params.set(key, { write, read, order });
}

// Current state as a query string (no leading "?").
export function toQuery() {
  const q = new URLSearchParams();
  for (const [k, p] of [...params].sort((a, b) => a[1].order - b[1].order)) {
    const v = p.write();
    if (v != null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

// Apply a query string, in registration order: region before view before camera.
export async function apply(query) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  for (const [k, p] of [...params].sort((a, b) => a[1].order - b[1].order)) {
    if (q.has(k)) await p.read(q.get(k));
  }
}

// Camera: "px,py,pz,tx,ty,tz" in km, one decimal. Null if anything isn't finite, so a
// link never carries a broken camera.
const r1 = (v) => Math.round(v * 10) / 10;
export function camToParam(pos, target) {
  const a = [pos.x, pos.y, pos.z, target.x, target.y, target.z];
  return a.every(Number.isFinite) ? a.map(r1).join(",") : null;
}
export function paramToCam(s) {
  const a = String(s).split(",").map(Number);
  if (a.length !== 6 || !a.every(Number.isFinite)) return null;
  if (a[0] === a[3] && a[1] === a[4] && a[2] === a[5]) return null;       // camera on its target: no direction
  return { pos: { x: a[0], y: a[1], z: a[2] }, target: { x: a[3], y: a[4], z: a[5] } };
}

export function clearForTests() { params.clear(); }
