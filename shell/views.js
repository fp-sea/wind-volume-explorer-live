// Camera views, generated from the region registry.
//
// A view is a centre in scene km, how much ground to fit across the visible part of the
// screen (span, km), a tilt from straight down (0 = map, ~55 = the "3D" look, ~84 =
// side-on) and the compass direction the camera sits in from the target (az).
//
// Every region gets a whole-domain map and 3D view. Every subarea gets a map and a 3D
// view of its water. Axis subareas get 3D views both up and down the channel, and the curtain views: side-on along the axis,
// and looking down the axis at three cross-sections (upstream end, origin, downstream
// end). Nothing is hand-placed per region, so a new region gets its views for free.

import { ChannelFrame } from "./geo.js?v=20261002173952";

// SYNC: radar-explorer web/views.js@7439092 framing(). Copied verbatim. scripts/check_sync.py reports upstream changes.
// Camera position and target that fit `span` km into the visible rectangle.
// visible: {w, h} in px of the unobscured area; H: full canvas height; fov in degrees.
export function framing(v, center, ctx) {
  const { grid: g, vex, visible, H, fov } = ctx;
  const span = v.span === "grid" ? Math.max(g.x1 - g.x0, g.y1 - g.y0) : Math.min(v.span, Math.max(g.x1 - g.x0, g.y1 - g.y0));
  const k = Math.tan((fov / 2) * Math.PI / 180) * Math.min(visible.w, visible.h) / H;
  const tilt = (v.tilt || 0.3) * Math.PI / 180;           // never exactly overhead: keeps north up
  // A tilted camera sees a stretched footprint; pull in a little so the span still fills the view.
  // Whole-grid views keep the full distance so the near edge stays on screen.
  const d = (span / 2) / k * (1 - (v.span === "grid" ? 0.05 : 0.3) * Math.sin(tilt));
  const az = (v.az ?? 180) * Math.PI / 180;
  const target = { x: center.x, y: center.y, z: (v.lift || 0) * vex };
  const pos = {
    x: target.x + d * Math.sin(tilt) * Math.sin(az),
    y: target.y + d * Math.sin(tilt) * Math.cos(az),
    z: target.z + d * Math.cos(tilt),
  };
  return { pos, target };
}
// END SYNC

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const norm = (d) => ((d % 360) + 360) % 360;

// All views for a region: [{id, label, group, center: {x, y}, span, tilt, az, lift}].
export function regionViews(region, proj) {
  const b = proj.box;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const az3d = region.view3dAzDeg ?? 205;
  const out = [
    { id: "region-top", group: region.label, label: "Whole domain · from above", center: { x: cx, y: cy }, span: "grid", tilt: 0 },
    { id: "region-3d", group: region.label, label: "Whole domain · 3D", center: { x: cx, y: cy }, span: "grid", tilt: 52, az: az3d },
  ];
  for (const s of region.subareas) {
    const g = s.label;
    if (s.axis) {
      const fr = new ChannelFrame(s), vb = s.viewBox, down = s.axis.downstreamBearingDeg;
      const at = (along, across) => { const q = fr.toLatLon(along, across); return proj.toXY(q.lat, q.lon); };
      const [a0, a1] = vb.alongKm, [c0, c1] = vb.acrossKm;
      const mid = at((a0 + a1) / 2, (c0 + c1) / 2);
      const L = a1 - a0, W = c1 - c0;
      out.push(
        { id: `${s.id}-top`, group: g, label: `${s.label} · from above`, center: mid, span: Math.max(L, W), tilt: 0 },
        // 3D both ways along the channel: looking down it (from the upstream end, with the wind) and
        // up it (from downstream, into the wind). The subarea's "view3d" ("up" or "down", default
        // down) picks which is the plain "-3d" view that Home, the 3D button and presets use.
        ...(() => {
          // Up the channel (owner's framing, 2026-09-28): the camera straight downwind on the axis,
          // low (70° from overhead) and well back, aimed a little downstream of the throat and toward
          // the left shore (Hawaiʻi Island for the ʻAlenuihāhā): the channel opens up ahead into the wind.
          const up = { center: at(a0 + (a1 - a0) * 0.63, c0 + (c1 - c0) * 0.244), span: 2.3 * Math.max(L, W), tilt: 70, lift: 1.5, az: norm(down) };   // (2.3: a bit farther out than the owner's link, as asked)
          const dn = { center: mid, span: Math.max(L, W), tilt: 55, lift: 1, az: norm(down + 210) };
          const v = (dir) => ({ group: g, ...(dir === "up" ? up : dn),
            label: `${s.label} · 3D looking ${dir} the channel (toward ${compass(dir === "up" ? down + 180 : down)})` });
          const first = s.view3d === "up" ? "up" : "down", other = first === "up" ? "down" : "up";
          return [{ id: `${s.id}-3d`, ...v(first) }, { id: `${s.id}-3d-${other}`, ...v(other) }];
        })(),
        // Side-on along the axis: the camera stands off to the left of downstream, looking across.
        { id: `${s.id}-along`, group: g, label: `${s.label} · along-axis curtain`, center: at((a0 + a1) / 2, 0),
          span: L, tilt: 84, az: norm(down - 90), lift: 1, axis: s.id, section: "along" },
      );
      // Looking downstream at three cross-sections.
      const upName = compass(down + 180), downName = compass(down);
      const origin = s.axis.method === "throat" ? "throat" : "centre";
      for (const [key, along, name] of [["x-up", a0 * 0.6, `${upName} end`], ["x-mid", 0, origin], ["x-down", a1 * 0.6, `${downName} end`]]) {
        out.push({ id: `${s.id}-${key}`, group: g, label: `${s.label} · cross-section, ${name}`, center: at(along, (c0 + c1) / 2),
                   span: W, tilt: 84, az: norm(down + 180), lift: 1, axis: s.id, section: key, alongKm: along });
      }
    } else if (s.box) {
      const sw = proj.toXY(s.box.latMin, s.box.lonMin), ne = proj.toXY(s.box.latMax, s.box.lonMax);
      const c = { x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 }, span = Math.max(ne.x - sw.x, ne.y - sw.y);
      out.push(
        { id: `${s.id}-top`, group: g, label: `${s.label} · from above`, center: c, span, tilt: 0 },
        { id: `${s.id}-3d`, group: g, label: `${s.label} · 3D`, center: c, span, tilt: 55, az: az3d, lift: 1 },
      );
    }
  }
  return out;
}

// The view a region opens on: its own choice (config), else the whole domain in 3D.
export const homeView = (region) => region.homeView || "region-3d";
