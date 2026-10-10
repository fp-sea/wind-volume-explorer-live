// Tidal current layer, each part on its own:
//   fill     the current everywhere on the water as a smooth colour wash (blue under 1 kt … red
//            over 4 kt): SSCOFS's own field, or blended between the stations (fading out ~5 km
//            from the nearest; route/env.js CurrentField: no reaching across land);
//   arrows   "grid": on a regular ~2.5 km grid over the water, from the same field; "stations":
//            one at each NOAA prediction station;
//   marks    where the stations are: "rings" (small), "dots" (coloured by speed);
// plus rings where the wind is against the current and the chop is steep (amber) or dangerous
// (red) and, optionally, the names (and speeds) of the harmonic stations. The particles and
// streamlines are layers/curflow.js. Flat on the water, drawn over the sea state.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const CUR_BANDS = [[1, 0x5aa9e6], [2, 0x3fc1a5], [3, 0xf2d04b], [4, 0xf29a3b], [Infinity, 0xe0473c]];
export const curColour = (kt) => CUR_BANDS.find(([top]) => kt < top)[1];
const RAMP = [[0, [0.25, 0.5, 0.8]], [1, [0.35, 0.66, 0.9]], [2, [0.25, 0.76, 0.65]], [3, [0.95, 0.82, 0.29]], [4, [0.95, 0.6, 0.23]], [5.5, [0.88, 0.28, 0.24]]];
export const rampAt = (kt) => { for (let i = 1; i < RAMP.length; i++) if (kt <= RAMP[i][0]) { const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], f = (kt - a) / (b - a); return ca.map((v, k) => v + (cb[k] - v) * f); } return RAMP.at(-1)[1]; };
const Z = 0.06;

export class CurrentLayer {
  constructor() {
    this.group = new THREE.Group();
    this.group.renderOrder = 9;
    const s = new THREE.Shape();                                     // an arrow one unit long along +y (tail at the origin)
    s.moveTo(-0.09, 0); s.lineTo(0.09, 0); s.lineTo(0.09, 0.6); s.lineTo(0.26, 0.6); s.lineTo(0, 1); s.lineTo(-0.26, 0.6); s.lineTo(-0.09, 0.6); s.lineTo(-0.09, 0);
    this.arrowGeo = new THREE.ShapeGeometry(s);
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 40);
    this.dotGeo = new THREE.CircleGeometry(1, 20);
    this.meshes = []; this.labels = new Map(); this.wash = null; this.hitList = []; this.opMul = 1;
    this.fieldGroup = new THREE.Group(); this.group.add(this.fieldGroup); this.fieldMeshes = [];   // (the colour fill and grid arrows: setField)
  }
  // The layer's opacity (the slider on its row): every part's own opacity times this.
  // 2D: over the land's edge like the sea surface (no depth test); 3D: hidden behind the hills.
  setFlat(on) { this.flat = on; for (const m of [...this.meshes, ...this.fieldMeshes]) m.material.depthTest = !on; if (this.wash) this.wash.material.depthTest = !on; }
  setOpacity(fill, symbols = this.opMul) {
    this.opMul = symbols; this.washOp = fill;
    for (const m of [...this.meshes, ...this.fieldMeshes]) m.material.opacity = m.material.userData.base * symbols;
    if (this.wash) this.wash.material.uniforms.uOpacity.value = fill;
  }
  clear() {
    for (const m of this.meshes) { this.group.remove(m); m.material.dispose(); m.dispose?.(); }
    this.meshes = []; this.arrows = null; this.rings = null; this.hitList = [];
    this.hideLabels();
  }
  clearField() {
    for (const m of this.fieldMeshes) { this.fieldGroup.remove(m); m.material.dispose(); m.dispose?.(); }
    this.fieldMeshes = []; this.arrowGrid = null;
    if (this.wash) { this.fieldGroup.remove(this.wash); this.wash.material.dispose(); this.wash.geometry.dispose(); this.wash = null; }
  }
  hideLabels() { for (const o of this.labels.values()) o.visible = false; }

  inst(geo, n, color, opacity, order, grp = this.group, list = this.meshes) {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opacity * this.opMul, depthWrite: false, side: THREE.DoubleSide }), Math.max(1, n));
    m.material.userData.base = opacity; m.material.depthTest = !this.flat;
    m.count = n; m.renderOrder = order; m.frustumCulled = false; grp.add(m); list.push(m); return m;
  }
  // Arrows at (x, y) pointing to `set` (° toward), length ∝ speed; with a dark edge.
  arrowsAt(items, scale, grp = this.group, list = this.meshes) {
    const q = new THREE.Object3D(), c = new THREE.Color(), n = items.length;
    const edge = this.inst(this.arrowGeo, n, 0x0b1a22, 0.75, 9, grp, list), fill = this.inst(this.arrowGeo, n, 0xffffff, 0.95, 10, grp, list);
    items.forEach((it, i) => {
      const L = (it.L ?? 1.1 + 0.85 * Math.min(6, it.kt)) * scale, r = (-it.set * Math.PI) / 180, w = it.kt < 0.3 ? 0.6 : 1;
      q.position.set(it.x, it.y, Z); q.rotation.set(0, 0, r); q.scale.set(L * w, L, 1); q.updateMatrix(); fill.setMatrixAt(i, q.matrix);
      q.position.z = Z - 0.001; q.scale.set(L * 1.35 * w, L * 1.12, 1); q.updateMatrix(); edge.setMatrixAt(i, q.matrix);
      fill.setColorAt(i, c.setHex(it.kt < 0.3 ? 0x9fb3bd : curColour(it.kt)));
    });
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    this.arrows ||= fill;
  }

  // o: {stations: [{x, y, kt, set, rating, name, id, type}], field, t, fill, arrows ("none",
  // "grid", "stations"), marks ("none", "rings", "dots"), scale, flags, names}
  build(o) {
    this.clear();
    const st = o.stations || [], scale = o.scale || 1;
    this.hitList = st;                                                // (clicks on a station: explore hit-tests these)
    if (o.arrows === "stations") this.arrowsAt(st, scale);
    if (o.marks === "rings") {
      const q = new THREE.Object3D(), m = this.inst(this.ringGeo, st.length, 0xffffff, 0.8, 11);   // where the stations are
      st.forEach((it, i) => { q.position.set(it.x, it.y, Z + 0.001); q.scale.set(0.45 * scale, 0.45 * scale, 1); q.updateMatrix(); m.setMatrixAt(i, q.matrix); });
    } else if (o.marks === "dots") {
      const q = new THREE.Object3D(), c = new THREE.Color(), m = this.inst(this.dotGeo, st.length, 0xffffff, 0.95, 10);
      st.forEach((it, i) => { const R = (0.55 + 0.3 * Math.min(5, it.kt)) * scale; q.position.set(it.x, it.y, Z); q.scale.set(R, R, 1); q.updateMatrix(); m.setMatrixAt(i, q.matrix); m.setColorAt(i, c.setHex(it.kt < 0.3 ? 0x9fb3bd : curColour(it.kt))); });
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    const flagged = o.flags ? st.filter((it) => it.rating > 0) : [];
    if (flagged.length) {
      const q = new THREE.Object3D(), c = new THREE.Color(), m = this.inst(this.ringGeo, flagged.length, 0xffffff, 0.95, 12);
      flagged.forEach((it, i) => { const R = it.rating > 1 ? 3.2 : 2.6; q.position.set(it.x, it.y, Z + 0.002); q.scale.set(R, R, 1); q.updateMatrix(); m.setMatrixAt(i, q.matrix); m.setColorAt(i, c.setHex(it.rating > 1 ? 0xff3b30 : 0xffa51f)); });
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.rings = m;
    }
    this.nameStations(o.names ? st : []);
  }

  // The field: a colour wash and arrows every ~2.5 km, from the current on a grid at the forecast
  // hours either side of the time on screen (gA, gB: {x0, y0, dxy, nx, ny, u, v}, NaN off the
  // water), blended by f on the graphics card, clipped to the fine shoreline (shore: shoreMask()).
  // Only the blend changes as the time moves; the arrows come from the nearer hour.
  setField(o) {
    if (!o || (!o.fill && !o.arrows) || !o.gA) { this.clearField(); return; }
    const { gA, f = 0, scale = 1 } = o, gB = o.gB || gA;
    if (o.fill) {
      if (!this.wash || this.wash.userData.g !== `${gA.nx}|${gA.ny}|${gA.x0}|${gA.y0}|${gA.dxy}`) this.makeWash(gA);
      const u = this.wash.material.uniforms;
      u.tA.value = gridTex(gA); u.tB.value = gridTex(gB); u.uMix.value = gB === gA ? 0 : f;
      if (o.shore) { u.uMask.value = o.shore.tex; u.uMaskO.value = o.shore.o; u.uMaskS.value = o.shore.s; u.uMaskOn.value = 1; }
    } else if (this.wash) { this.fieldGroup.remove(this.wash); this.wash.material.dispose(); this.wash.geometry.dispose(); this.wash = null; }
    const near = f < 0.5 ? gA : gB, akey = o.arrows ? `${scale}` : null;
    if (near !== this.arrowGrid || akey !== this.arrowKey) {
      for (const m of this.fieldMeshes) { this.fieldGroup.remove(m); m.material.dispose(); m.dispose?.(); }
      this.fieldMeshes = []; this.arrowGrid = near; this.arrowKey = akey;
      if (o.arrows) {
        const { nx, ny, x0, y0, dxy, u, v } = near, step = Math.max(1, Math.round(2.5 / dxy)), items = [];
        for (let j = step >> 1; j < ny; j += step) for (let i = step >> 1; i < nx; i += step) {
          const c = j * nx + i; if (!Number.isFinite(u[c])) continue;
          const kt = Math.hypot(u[c], v[c]) / 0.514444;
          if (kt >= 0.15) items.push({ x: x0 + i * dxy, y: y0 + j * dxy, kt, set: ((Math.atan2(u[c], v[c]) * 180) / Math.PI + 360) % 360, L: 0.35 + 0.28 * Math.min(6, kt) });
        }
        this.arrowsAt(items, scale, this.fieldGroup, this.fieldMeshes);
      }
    }
  }
  makeWash(g) {
    if (this.wash) { this.fieldGroup.remove(this.wash); this.wash.material.dispose(); this.wash.geometry.dispose(); }
    const { nx, ny, x0, y0, dxy } = g, W = nx * dxy, H = ny * dxy;
    const mat = new THREE.ShaderMaterial({
      uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 0 }, uOpacity: { value: this.washOp ?? 0.8 }, uSize: { value: new THREE.Vector2(W, H) }, uOrigin: { value: new THREE.Vector2(x0 - dxy / 2, y0 - dxy / 2) },
                  uMask: { value: null }, uMaskOn: { value: 0 }, uMaskO: { value: new THREE.Vector2() }, uMaskS: { value: new THREE.Vector2(1, 1) } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D tA, tB, uMask; uniform float uMix, uOpacity, uMaskOn; uniform vec2 uSize, uOrigin, uMaskO, uMaskS; varying vec2 vUv;
        vec3 ramp(float k) {              // (the key: RAMP above)
          if (k < 1.0) return mix(vec3(0.25, 0.5, 0.8), vec3(0.35, 0.66, 0.9), k);
          if (k < 2.0) return mix(vec3(0.35, 0.66, 0.9), vec3(0.25, 0.76, 0.65), k - 1.0);
          if (k < 3.0) return mix(vec3(0.25, 0.76, 0.65), vec3(0.95, 0.82, 0.29), k - 2.0);
          if (k < 4.0) return mix(vec3(0.95, 0.82, 0.29), vec3(0.95, 0.6, 0.23), k - 3.0);
          return mix(vec3(0.95, 0.6, 0.23), vec3(0.88, 0.28, 0.24), min(1.0, (k - 4.0) / 1.5));
        }
        void main() {
          vec4 c = mix(texture2D(tA, vUv), texture2D(tB, vUv), uMix);          // (u, v and validity, blended over the water cells only)
          if (c.z < 0.3) discard;
          if (uMaskOn > 0.5 && texture2D(uMask, (uOrigin + vUv * uSize - uMaskO) / uMaskS).r < 0.5) discard;
          float kt = length(c.xy / c.z) * 1.943844;
          gl_FragColor = vec4(ramp(kt), 0.62 * min(1.0, 0.35 + kt / 1.5) * smoothstep(0.3, 0.7, c.z) * uOpacity);
        }`,
      transparent: true, depthWrite: false,
    });
    this.wash = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    this.wash.position.set(x0 - dxy / 2 + W / 2, y0 - dxy / 2 + H / 2, Z - 0.004); this.wash.renderOrder = 8; mat.depthTest = !this.flat;
    this.wash.userData.g = `${nx}|${ny}|${x0}|${y0}|${dxy}`;
    this.fieldGroup.add(this.wash);
  }

  // Names of the harmonic (primary) stations with their speed, thinned so no two are within ~6 km.
  nameStations(st) {
    this.hideLabels();
    const shown = [];
    for (const it of st) {
      if (it.type !== "H" || shown.some((s) => Math.hypot(s.x - it.x, s.y - it.y) < 6)) continue;
      shown.push(it);
      let o = this.labels.get(it.id);
      if (!o) {
        const el = document.createElement("div"); el.className = "label curst";
        o = new CSS2DObject(el); o.center.set(0, 1.2); this.labels.set(it.id, o); this.group.add(o);
      }
      o.position.set(it.x, it.y, Z + 0.01); o.visible = true;
      o.element.textContent = `${it.name.replace(/,.*$/, "")} ${it.kt.toFixed(1)} kt`;
    }
  }
  // The station nearest scene (x, y) within r km, or null.
  stationAt(x, y, r = 2) {
    let best = null, bd = r;
    for (const it of this.hitList) { const d = Math.hypot(it.x - x, it.y - y); if (d < bd) { bd = d; best = it; } }
    return best;
  }
}

// A current grid as a float texture: u, v (m/s) and 1 on the water, zeros elsewhere (so a blend
// over the water cells only, divided by the third channel, gives the current). Kept on the grid.
function gridTex(g) {
  if (g.tex) return g.tex;
  const n = g.nx * g.ny, a = new Float32Array(n * 4);
  for (let c = 0; c < n; c++) if (Number.isFinite(g.u[c])) { a[4 * c] = g.u[c]; a[4 * c + 1] = g.v[c]; a[4 * c + 2] = 1; }
  const t = new THREE.DataTexture(a, g.nx, g.ny, THREE.RGBAFormat, THREE.FloatType); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return (g.tex = t);
}
