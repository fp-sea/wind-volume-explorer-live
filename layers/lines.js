// SYNC: radar-explorer web/lines.js@fdbb733. Copied verbatim except the line marked "WVE CHANGE" (data path).
// scripts/check_sync.py reports upstream changes.

// Roads and waterways (src/radarviz/basemap.py): freeways to orient by and, in
// Houston, the bayous whose watersheds decide where flooding happens. Drawn on
// the ground at the terrain's current relief.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

// Labels only for what people navigate by: numbered highways and the big waterways.
const ROAD_LABEL = /^(I|US|SH|TX|WA|HI|BC|SR|FM)[- ]?\d/;
const WATER_LABEL = /Bayou|River|Ship Channel/;
// Storm-scale areas (600 km): interstates and rivers only, spread out.
const WIDE_ROAD = /^I[- ]?\d/, WIDE_WATER = /River$/;

export class LinesLayer {
  constructor() { this.group = new THREE.Group(); this.data = null; }

  async load(siteId) {
    // WVE CHANGE: this project's data path (siteId is the region id).
    this.data = await fetch(`data/${siteId}/lines.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return !!this.data;
  }

  // heightKm(x, y) -> ground height; relief: terrain exaggeration in use (0 = flat).
  // span: the area's width (km), to thin the labels on a wide one.
  build(visible, heightKm, relief, span = 300) {
    this.group.clear();
    if (!visible || !this.data) return;
    const z = (x, y) => (heightKm ? heightKm(x, y) * relief : 0) + 0.04;
    for (const [kind, color, opacity] of [["water", 0x4fd1ff, 0.55], ["roads", 0xffb74a, 0.85]]) {
      const pts = [];
      for (const run of this.data[kind]) {
        for (let i = 1; i < run.length; i++) {
          const [x0, y0] = run[i - 1], [x1, y1] = run[i];
          pts.push(x0, y0, z(x0, y0), x1, y1, z(x1, y1));
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      lines.renderOrder = 3;
      this.group.add(lines);
    }
    // Thinner as the area grows: from ~330 km, spread out and no "Fork"s; past 450 km, interstates and rivers only.
    const wide = span > 450, big = span > 330, gap = big ? span / 8 : 0, placed = [];
    for (const lab of this.data.labels || []) {
      const ok = lab.kind === "roads" ? (wide ? WIDE_ROAD : ROAD_LABEL).test(lab.name) : (wide ? WIDE_WATER : WATER_LABEL).test(lab.name);
      if (!ok || (big && / Fork /.test(lab.name))) continue;
      if (gap && placed.some((q) => Math.hypot(q[0] - lab.at[0], q[1] - lab.at[1]) < (q[2] === lab.name ? gap * 2.5 : gap))) continue;
      placed.push([lab.at[0], lab.at[1], lab.name]);
      const el = document.createElement("div");
      el.className = `label ${lab.kind === "roads" ? "road" : "water"}`;
      el.textContent = lab.name;
      const obj = new CSS2DObject(el);
      obj.position.set(lab.at[0], lab.at[1], z(lab.at[0], lab.at[1]));
      this.group.add(obj);
    }
  }
}
