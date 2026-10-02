// Turbulence proxies in 3D. The model has no turbulence field (no TKE in RRFS Hawaiʻi), so this
// shows where its own wind and temperature profiles point to turbulence:
//
//   pockets      soft dots at each layer where the Richardson number says turbulence is likely
//                (red, Ri < 0.25, incl. convectively unstable Ri < 0) or possible (amber, Ri 0.25-1),
//                every other column, up to 6 km
//   mixed layer  a faint sheet at the model's PBL top (HPBL): the turbulent layer next to the ground
//
// Real turbulence is far smaller than a 2.5 km cell and a 25 mb layer: read these as "where to
// expect it", not as observations.

import * as THREE from "three";
import { gridXY, gridIndex } from "./gridxy.js?v=20261002173952";
import { RI_CLASSES, riClass } from "./colormap.js?v=20261002173952";

let dot = null;
function dotTexture() {
  if (dot) return dot;
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.5, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return (dot = new THREE.CanvasTexture(c));
}

export class TurbulenceLayer {
  constructor(clip = null) { this.group = new THREE.Group(); this.opacity = 0.8; this.clip = clip; }

  clear() {
    const texs = new Set();
    for (const o of [...this.group.children]) { this.group.remove(o); if (o.userData.fogTex) texs.add(o.userData.fogTex); o.geometry?.dispose(); o.material?.dispose(); }
    for (const t of texs) t.dispose();
  }

  setOpacity(o) {
    this.opacity = o;
    for (const m of this.group.children) {
      if (m.material?.uniforms?.uOpacity) m.material.uniforms.uOpacity.value = o;
      else if (m.material) m.material.opacity = (m.userData.base ?? 1) * o;
    }
  }

  // vol: Volume (one forecast hour, not blended: classes don't blend). Returns counts per class.
  // style: "dots" (a dot per layer) or "fog" (soft red/amber volumes, the same classes).
  build(vol, proj, vex, { pockets = true, pbl = true, topM = 6000, style = "dots" } = {}) {
    this.clear();
    const { w, h } = vol, lat = vol.raw.lat, lon = vol.raw.lon, counts = [0, 0];
    if (pockets && style === "fog") this.fog(vol, proj, vex, topM, counts);
    if (pockets && style !== "fog") {
      const L = vol.stability(), N = vol.N, pos = [], col = [], xy = gridXY(vol, proj);
      for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i += 2) {
        const c = j * w + i, b = c * N;
        for (let k = 0; k < L.cnt[c]; k++) {
          const cls = riClass(L.RI[b + k]), zm = (L.z0[b + k] + L.z1[b + k]) / 2;
          if (cls < 0 || zm > topM) continue;
          const rgb = RI_CLASSES[cls].colour;
          pos.push(xy[2 * c], xy[2 * c + 1], (zm / 1000) * vex);
          col.push(rgb[0], rgb[1], rgb[2]);
          counts[cls]++;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      const pmat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: dotTexture(), vertexColors: true,
        transparent: true, opacity: 0.85 * this.opacity, depthWrite: false });
      this.clip?.patch(pmat);
      const pts = new THREE.Points(geo, pmat);
      pts.userData.base = 0.85;
      pts.renderOrder = 18;
      this.group.add(pts);
    }
    if (pbl && vol.raw.surface.HPBL) {
      const hp = vol.raw.surface.HPBL, posA = new Float32Array(w * h * 3), xy = gridXY(vol, proj);
      for (let c = 0; c < w * h; c++) { posA[3 * c] = xy[2 * c]; posA[3 * c + 1] = xy[2 * c + 1]; posA[3 * c + 2] = ((vol.terrain[c] + hp[c]) / 1000) * vex; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(posA, 3));
      geo.setIndex(new THREE.BufferAttribute(gridIndex(w, h), 1));
      const pblMat = new THREE.MeshBasicMaterial({ color: 0x9fe0c8, transparent: true, opacity: 0.16 * this.opacity, side: THREE.DoubleSide, depthWrite: false });
      this.clip?.patch(pblMat);
      const m = new THREE.Mesh(geo, pblMat);
      m.userData.base = 0.16;
      m.renderOrder = 12;
      this.group.add(m);
      // A faint grid on the sheet: every 3rd model line (a full wireframe of every triangle was
      // most of this layer's build time, at 8% opacity).
      const wi = [], G = 3;
      for (let j = 0; j < h; j += G) for (let i = 0; i + G < w; i += G) { const a = j * w + i; wi.push(a, a + G); }
      for (let i = 0; i < w; i += G) for (let j = 0; j + G < h; j += G) { const a = j * w + i; wi.push(a, a + G * w); }
      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute("position", geo.getAttribute("position"));
      wgeo.setIndex(wi);
      const wire = new THREE.LineSegments(wgeo, new THREE.LineBasicMaterial({ color: 0x9fe0c8, transparent: true, opacity: 0.08 * this.opacity, depthWrite: false }));
      wire.userData.base = 0.08;
      wire.renderOrder = 12;
      this.group.add(wire);
    }
    return { likely: counts[0], possible: counts[1] };
  }

  // Soft fog: the Ri classes resampled onto a regular grid over the scene (~1.5 km, 40 heights
  // to topM) as a two-channel 3-D texture (likely, possible), drawn as stacked translucent
  // sheets like the clouds. Same data as the dots; easier to read as regions in 3-D.
  fog(vol, proj, vex, topM, counts) {
    const b = proj.box, W = b.x1 - b.x0, H = b.y1 - b.y0, NZ = 40;
    const NX = Math.min(200, Math.ceil(W / 1.5)), NY = Math.min(200, Math.ceil(H / 1.5));
    const zs = Array.from({ length: NZ }, (_, k) => ((k + 0.5) * topM) / NZ);
    const data = new Uint8Array(NX * NY * NZ * 2), L = vol.stability(), N = vol.N, i0 = vol.raw.crop.i0, j0 = vol.raw.crop.j0;
    for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
      const ll = proj.toLatLon(b.x0 + ((ix + 0.5) * W) / NX, b.y0 + ((iy + 0.5) * H) / NY), q = vol.merc.ij(ll.lat, ll.lon);
      const i = Math.round(q.i - i0), j = Math.round(q.j - j0);
      if (i < 0 || j < 0 || i >= vol.w || j >= vol.h) continue;
      const c = j * vol.w + i, base = c * N;
      for (let l = 0; l < L.cnt[c]; l++) {
        const cls = riClass(L.RI[base + l]);
        if (cls < 0) continue;
        counts[cls]++;
        for (let k = 0; k < NZ; k++) if (zs[k] >= L.z0[base + l] && zs[k] <= L.z1[base + l]) data[2 * (k * NX * NY + iy * NX + ix) + cls] = 255;
      }
    }
    const tex = new THREE.Data3DTexture(data, NX, NY, NZ);
    tex.format = THREE.RGFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
    const red = RI_CLASSES[0].colour, amber = RI_CLASSES[1].colour;
    for (let k = 0; k < NZ; k++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: tex }, uZ: { value: (k + 0.5) / NZ }, uOpacity: { value: this.opacity },
                    uRed: { value: new THREE.Vector3(...red) }, uAmber: { value: new THREE.Vector3(...amber) } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `precision highp float; precision highp sampler3D;
          uniform sampler3D uTex; uniform float uZ; uniform float uOpacity; uniform vec3 uRed; uniform vec3 uAmber; varying vec2 vUv;
          void main() {
            vec2 d = texture(uTex, vec3(vUv, uZ)).rg;                   // r: likely, g: possible
            float s = d.r + d.g;
            if (s < 0.06) discard;
            vec3 c = mix(uAmber, uRed, d.r / max(s, 1e-3));
            gl_FragColor = vec4(c, clamp(d.r * 0.22 + d.g * 0.12, 0.0, 0.3) * uOpacity);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (zs[k] / 1000) * vex);
      m.renderOrder = 18;
      m.userData.fogTex = tex;
      this.group.add(m);
    }
  }
}
