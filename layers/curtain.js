// Cross-section ("curtain"): a vertical sheet through the volume along a line, coloured by
// the same field and scale as the slice. Below the model's ground it's empty; a line traces
// the drawn terrain along its foot, a line marks the slice height, and height ticks are
// labelled in m, ft and ≈ mb.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { COLOUR_BY, rangeOf, shows, carried, patchValueColour } from "./slice.js?v=20261002173952";

const M_FT = 3.28084;

export class CurtainLayer {
  constructor() { this.group = new THREE.Group(); this.opacity = 0.9; }

  clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
  }

  // path: [{lat, lon}] along the section (evenly spaced); spec: {field, h, ref}; zTopM: top (m MSL).
  build(vol, proj, path, spec, zTopM, vex, groundKm, range = null) {
    this.clear();
    const f = COLOUR_BY[spec.field], NZ = 90, n = path.length;
    const zs = Array.from({ length: NZ }, (_, k) => (zTopM * k) / (NZ - 1));
    const xy = path.map((p) => proj.toXY(p.lat, p.lon));
    let vals = new Float32Array(n * NZ);
    if (f.from && vol.section) {                                 // fast: one pass up each column
      const src = f.from.map((fld) => vol.section(fld, path, zs));
      vals = src[0].map((_, q) => { const xs = src.map((a) => a[q]); return xs.every(Number.isFinite) ? f.calc(...xs) : NaN; });
    } else for (let i = 0; i < n; i++) for (let k = 0; k < NZ; k++) {
      vals[k * n + i] = f.surfaceOnly ? NaN : f.sampled(vol, path[i].lat, path[i].lon, zs[k]);
    }
    const [lo, hi] = range || rangeOf(spec.field, vals);
    const pos = new Float32Array(n * NZ * 3), val = new Float32Array(n * NZ);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < n; i++) {
      const q = k * n + i;
      pos[3 * q] = xy[i].x; pos[3 * q + 1] = xy[i].y; pos[3 * q + 2] = (zs[k] / 1000) * vex;
      val[q] = carried(f, vals[q]);                              // coloured per pixel (slice.js patchValueColour)
    }
    const idx = [];
    for (let k = 0; k < NZ - 1; k++) for (let i = 0; i < n - 1; i++) {
      const a = k * n + i, b = a + 1, c = a + n, d = c + 1;
      if ([a, b, c, d].every((q) => shows(f, vals[q]))) idx.push(a, b, d, a, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aVal", new THREE.BufferAttribute(val, 1));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, patchValueColour(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: this.opacity, depthWrite: false, colorWrite: !f.none }), f, lo, hi));
    mesh.renderOrder = 11;
    mesh.material.depthWrite = CurtainLayer.solid(this.opacity);
    // Pushed back a touch in depth, so the barbs and streamlines drawn on it stay in front.
    mesh.material.polygonOffset = true; mesh.material.polygonOffsetFactor = 2; mesh.material.polygonOffsetUnits = 2;
    this.group.add(mesh);

    const lineAt = (pts, color, opacity = 0.9) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      l.renderOrder = 12;
      this.group.add(l);
    };
    // Ground along the foot, and the slice height (above sea level: flat; above ground: follows it).
    lineAt(xy.map((p) => new THREE.Vector3(p.x, p.y, groundKm ? groundKm(p.x, p.y) : 0)), 0xd9c9a3);
    if (spec.h != null) {
      lineAt(xy.map((p) => new THREE.Vector3(p.x, p.y, spec.ref === "agl" ? (groundKm ? groundKm(p.x, p.y) : 0) + (spec.h / 1000) * vex : (spec.h / 1000) * vex)), 0xffffff, 0.8);
    }
    // Height ticks at the start of the section: every km (every 500 m when shallow).
    const step = zTopM > 4000 ? 1000 : 500;
    for (let z = step; z < zTopM; z += step) {
      const el = document.createElement("div");
      el.className = "label tick";
      const mb = vol.mbAt(z);
      el.textContent = `${(z / 1000).toFixed(z % 1000 ? 1 : 0)} km · ${Math.round(z * M_FT / 100) * 100} ft${Number.isFinite(mb) ? ` · ≈${Math.round(mb / 5) * 5} mb` : ""}`;
      const o = new CSS2DObject(el);
      o.position.set(xy[0].x, xy[0].y, (z / 1000) * vex);
      this.group.add(o);
      lineAt([new THREE.Vector3(xy[0].x, xy[0].y, (z / 1000) * vex), new THREE.Vector3(xy[n - 1].x, xy[n - 1].y, (z / 1000) * vex)], 0xffffff, 0.12);
    }
    return { lo, hi, field: f };
  }

  // At 90% opacity and above the section is solid: it writes depth, so station poles, barbs and
  // particles behind it are hidden. Below that it stays see-through, markers included.
  static solid(o) { return o >= 0.9; }
  setOpacity(o) {
    this.opacity = o;
    for (const c of this.group.children) if (c.isMesh) { c.material.opacity = o; c.material.depthWrite = CurtainLayer.solid(o); }
  }
}
