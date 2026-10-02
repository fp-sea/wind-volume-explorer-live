// Region projection and channel frames.
//
// Scene convention (same as radar-explorer, so its chart layer drops in): x east,
// y north, z up, all in km, origin at the region bbox centre. The projection is flat
// (equirectangular) at the region's projectionRefLat. That is plenty over a ~300 km
// domain, and it's the same arithmetic the Python pipeline uses.
//
// ChannelFrame mirrors pipeline/regions.py ChannelFrame. web/tests/geo.test.mjs checks
// the two agree against a fixture the pipeline writes, so change both together.

export const KM_PER_DEG_LAT = 110.574;
export const kmPerDegLon = (lat) => 111.320 * Math.cos(lat * Math.PI / 180);

export class Projection {
  constructor(region) {
    const b = region.bbox;
    this.lat0 = (b.latMin + b.latMax) / 2;
    this.lon0 = (b.lonMin + b.lonMax) / 2;
    this.kx = kmPerDegLon(region.projectionRefLat);
    const sw = this.toXY(b.latMin, b.lonMin), ne = this.toXY(b.latMax, b.lonMax);
    this.box = { x0: sw.x, y0: sw.y, x1: ne.x, y1: ne.y };      // the scene, in km
  }
  toXY(lat, lon) { return { x: (lon - this.lon0) * this.kx, y: (lat - this.lat0) * KM_PER_DEG_LAT }; }
  toLatLon(x, y) { return { lat: this.lat0 + y / KM_PER_DEG_LAT, lon: this.lon0 + x / this.kx }; }
  contains(x, y) { const b = this.box; return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; }
}

// Origin of a subarea axis: the throat midpoint, or the declared origin.
export function axisOrigin(ax) {
  if (ax.method === "throat") {
    const [r, l] = [ax.throat.right, ax.throat.left];
    return { lat: (r[0] + l[0]) / 2, lon: (r[1] + l[1]) / 2 };
  }
  return { lat: ax.origin[0], lon: ax.origin[1] };
}

// Along/across km from the axis origin: +along toward downstreamBearingDeg,
// +across to the right of downstream.
export class ChannelFrame {
  constructor(subarea) {
    const ax = subarea.axis;
    const o = axisOrigin(ax);
    this.lat0 = o.lat; this.lon0 = o.lon;
    this.kx = kmPerDegLon(this.lat0);
    const b = ax.downstreamBearingDeg * Math.PI / 180;
    this.ux = Math.sin(b); this.uy = Math.cos(b);        // along (east, north)
    this.cx = this.uy; this.cy = -this.ux;                // across: 90° clockwise
  }
  toChannel(lat, lon) {
    const x = (lon - this.lon0) * this.kx, y = (lat - this.lat0) * KM_PER_DEG_LAT;
    return { along: x * this.ux + y * this.uy, across: x * this.cx + y * this.cy };
  }
  toLatLon(along, across) {
    const x = along * this.ux + across * this.cx, y = along * this.uy + across * this.cy;
    return { lat: this.lat0 + y / KM_PER_DEG_LAT, lon: this.lon0 + x / this.kx };
  }
  // Unit along/across vectors in scene km (the scene's own east/north scale differs
  // slightly from this frame's, since each uses its own reference latitude, so these
  // are renormalised in the scene).
  sceneAxes(proj) {
    const p0 = proj.toXY(this.lat0, this.lon0);
    const unit = (a, c) => {
      const q = this.toLatLon(a, c), p = proj.toXY(q.lat, q.lon);
      const dx = p.x - p0.x, dy = p.y - p0.y, n = Math.hypot(dx, dy);
      return { x: dx / n, y: dy / n };
    };
    return { origin: p0, along: unit(10, 0), across: unit(0, 10) };
  }
}

// True bearing (0-360) and distance (km) of the vector (dx east, dy north).
export const bearingDeg = (dx, dy) => ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;

// Where the ray from the box centre toward (x, y) leaves the box: the edge marker spot.
export function edgePoint(x, y, box) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, dx = x - cx, dy = y - cy;
  const ts = [];
  if (dx > 0) ts.push((box.x1 - cx) / dx); else if (dx < 0) ts.push((box.x0 - cx) / dx);
  if (dy > 0) ts.push((box.y1 - cy) / dy); else if (dy < 0) ts.push((box.y0 - cy) / dy);
  const t = Math.min(...ts);
  return { x: cx + dx * t, y: cy + dy * t };
}
