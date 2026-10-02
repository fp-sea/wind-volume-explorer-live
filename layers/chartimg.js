// Raster nautical charts laid on the sea, as an alternative to the vector chart (chart.js):
//
//   stored  the same, fetched once by pipeline/noaachart.py and served with the site (the default:
//           no dependency on NOAA's server): a base image and 0.5° tiles loaded when zoomed in.
//   live    NOAA's Chart Display Service (gis.charttools.noaa.gov, CORS open): the current ENC
//           data drawn in paper-chart style, as images in plain lat/lon (EPSG:4326, pixels square
//           in degrees: see degAspect). One base
//           image for the whole region, and, when you're zoomed in, a sharper one for the area in
//           view (the service shows more detail, e.g. soundings, at larger scales). Depth units
//           follow the Depths in setting. Updated by NOAA weekly.
//   19320   NOAA chart 19320, Island of Hawaiʻi (1:250,000, soundings in fathoms), the owner's
//           PDF rasterised and georeferenced from its own graticule (pipeline/chart19320.py; fit
//           within 0.3 px). A fixed copy: it's the last edition, since NOAA ended paper and raster
//           chart production.
//
// Each image is drawn on a subdivided mesh whose vertices are placed by lat/lon through the
// scene's projection, so the chart lines up exactly (Mercator for 19320, linear lat/lon for the
// live service). Not for navigation.

import * as THREE from "three";

const SERVICE = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export";
const LAYERS = "show:1,2,3,4,5,6,7,10,11";     // without the data-quality, low-accuracy and overscale layers (clutter here)
const DEPTH_CODE = { m: 1, ft: 2, fathoms: 3 };
const Z = 0.004;                                  // just above sea level: low coastal land (under ~1-2 m at 3x) is all it covers
// Image proportions in plain degrees. The service keeps its pixels square in degrees: ask for any
// other shape and it widens the box it draws, so the image no longer matches the box it's laid on
// (33% off at 48°N; the Salish Sea chart was misplaced by this).
export const degAspect = (b) => (b.lonMax - b.lonMin) / (b.latMax - b.latMin);
const merc = (la) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));

async function bitmap(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`chart image HTTP ${r.status}`);
  return createImageBitmap(await r.blob(), { imageOrientation: "flipY" });
}

export class RasterChart {
  constructor() { this.group = new THREE.Group(); this.opacity = 0.75; this.meshes = { base: null, detail: null }; }

  setOpacity(o) { this.opacity = o; for (const m of Object.values(this.meshes)) if (m) m.material.uniforms.uOpacity.value = o; }

  clear(which = null) {
    for (const k of which ? [which] : Object.keys(this.meshes)) {
      const m = this.meshes[k];
      if (!m) continue;
      const t = m.material.uniforms.uTex.value;
      this.group.remove(m); m.geometry.dispose(); t?.image?.close?.(); t?.dispose(); m.material.dispose();
      this.meshes[k] = null;
    }
    if (!which) {
      this.abort?.abort(); this.key = null; this.detailKey = null;
      for (const m of this.stored?.tiles.values() || []) { this.group.remove(m); m.geometry.dispose(); m.material.uniforms.uTex.value.image?.close?.(); m.material.uniforms.uTex.value.dispose(); m.material.dispose(); }
      this.stored = null;
    }
  }

  // A mesh over [latMin, latMax] × [lonMin, lonMax], vertices through proj, UVs from uv(lat, lon).
  mesh(tex, b, proj, uv, order) {
    const N = 48, pos = [], uvs = [], idx = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const la = b.latMin + ((b.latMax - b.latMin) * j) / N, lo = b.lonMin + ((b.lonMax - b.lonMin) * i) / N, p = proj.toXY(la, lo), [u, v] = uv(la, lo);
      pos.push(p.x, p.y, Z); uvs.push(u, v);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, c = a + N + 1; idx.push(a, a + 1, c, a + 1, c + 1, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx);
    // uHole (u0, v0, u1, v1): part of this image not drawn (the base under the sharper detail image,
    // so the two don't double up at partial opacity).
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uOpacity: { value: this.opacity }, uHole: { value: new THREE.Vector4(2, 2, 2, 2) } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uOpacity; uniform vec4 uHole; varying vec2 vUv;
        void main() {
          if (vUv.x > uHole.x && vUv.y > uHole.y && vUv.x < uHole.z && vUv.y < uHole.w) discard;
          vec4 c = texture2D(uTex, vUv);
          gl_FragColor = vec4(c.rgb, c.a * uOpacity);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = order;
    return m;
  }
  texture(bmp) {
    const t = new THREE.Texture(bmp);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
    return t;
  }

  // Chart 19320 (web/data/<region>/chart19320.json + .jpg).
  async showStatic(regionId, meta, proj) {
    const key = `static|${regionId}`;
    if (this.key === key && this.meshes.base) return;
    this.clear(); this.key = key; this.liveBox = null;
    const bmp = await bitmap(`data/${regionId}/${meta.file}`);
    if (this.key !== key) { bmp.close(); return; }
    const uv = (la, lo) => [(meta.xA + meta.xB * lo) / meta.w, 1 - (meta.yA - meta.yB * merc(la)) / meta.h];
    this.meshes.base = this.mesh(this.texture(bmp), meta.bounds, proj, uv, 3);
    this.group.add(this.meshes.base);
  }

  // The stored copy (pipeline/noaachart.py → data/<region>/noaachart/): the region's base image, and
  // when zoomed in the 0.5° tiles that overlap the view (the base is cut out under them).
  async showStored(regionId, index, proj) {
    const key = `stored|${regionId}|${index.fetched}`;
    if (this.key === key && this.meshes.base) return;
    this.clear(); this.key = key; this.liveBox = index.base.bbox; this.stored = { regionId, index, tiles: new Map() };
    const bmp = await bitmap(`data/${regionId}/noaachart/${index.base.file}`);
    if (this.key !== key) { bmp.close(); return; }
    const b = index.base.bbox;
    this.meshes.base = this.mesh(this.texture(bmp), b, proj, (la, lo) => [(lo - b.lonMin) / (b.lonMax - b.lonMin), (la - b.latMin) / (b.latMax - b.latMin)], 3);
    this.group.add(this.meshes.base);
  }
  async showStoredDetail(view, proj) {
    const st = this.stored;
    if (!st || !this.meshes.base) return;
    const want = view ? st.index.tiles.filter((t) => t.bbox.lonMax > view.lonMin && t.bbox.lonMin < view.lonMax && t.bbox.latMax > view.latMin && t.bbox.latMin < view.latMax) : [];
    const token = (this.detailToken = (this.detailToken || 0) + 1);
    // Load the new tiles first, then swap: cutting the base out before they arrived left a blank
    // patch for a moment on every zoom.
    await Promise.all(want.filter((t) => !st.tiles.has(t.file)).map(async (t) => {
      const bmp = await bitmap(`data/${st.regionId}/noaachart/${t.file}`);
      if (this.stored !== st || st.tiles.has(t.file)) { bmp.close(); return; }
      const tb = t.bbox, m = this.mesh(this.texture(bmp), tb, proj, (la, lo) => [(lo - tb.lonMin) / (tb.lonMax - tb.lonMin), (la - tb.latMin) / (tb.latMax - tb.latMin)], 4);
      st.tiles.set(t.file, m); this.group.add(m);
    }));
    if (this.stored !== st || token !== this.detailToken) return;               // a newer view took over
    const names = new Set(want.map((t) => t.file));
    for (const [f, m] of st.tiles) if (!names.has(f)) { this.group.remove(m); m.geometry.dispose(); m.material.uniforms.uTex.value.image?.close?.(); m.material.uniforms.uTex.value.dispose(); m.material.dispose(); st.tiles.delete(f); }
    // Cut the base out under the tiles' block (the view's tiles form a rectangle).
    const hole = this.meshes.base.material.uniforms.uHole.value, b = st.index.base.bbox;
    if (!want.length) hole.set(2, 2, 2, 2);
    else {
      const u = (lo) => (lo - b.lonMin) / (b.lonMax - b.lonMin), v = (la) => (la - b.latMin) / (b.latMax - b.latMin);
      hole.set(u(Math.min(...want.map((t) => t.bbox.lonMin))), v(Math.min(...want.map((t) => t.bbox.latMin))), u(Math.max(...want.map((t) => t.bbox.lonMax))), v(Math.max(...want.map((t) => t.bbox.latMax))));
    }
  }

  // The live service: the region at up to 4096 px, and the view (when zoomed in) at screen size.
  exportUrl(b, w, h, units) {
    const dp = encodeURIComponent(JSON.stringify({ ECDISParameters: { version: "10.9", DynamicParameters: { Parameter: [{ name: "DisplayDepthUnits", value: DEPTH_CODE[units] ?? 2 }] } } }));
    return `${SERVICE}?bbox=${b.lonMin},${b.latMin},${b.lonMax},${b.latMax}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=png&transparent=true&layers=${LAYERS}&display_params=${dp}&f=image`;
  }
  async showLive(bbox, proj, units) {
    const key = `live|${JSON.stringify(bbox)}|${units}`;
    if (this.key === key && this.meshes.base) return;
    this.clear(); this.key = key; this.liveBox = bbox;
    this.abort = new AbortController();
    const aspect = degAspect(bbox);
    const W = aspect >= 1 ? 4096 : Math.round(4096 * aspect), H = aspect >= 1 ? Math.round(4096 / aspect) : 4096;
    const bmp = await bitmap(this.exportUrl(bbox, W, H, units), this.abort.signal);
    if (this.key !== key) { bmp.close(); return; }
    this.meshes.base = this.mesh(this.texture(bmp), bbox, proj, (la, lo) => [(lo - bbox.lonMin) / (bbox.lonMax - bbox.lonMin), (la - bbox.latMin) / (bbox.latMax - bbox.latMin)], 3);
    this.group.add(this.meshes.base);
  }
  // view: the lat/lon box on screen (clipped to the region) and its size in px; null = zoomed out.
  async showLiveDetail(view, proj, units) {
    if (!view) { this.clear("detail"); this.detailKey = null; this.meshes.base?.material.uniforms.uHole.value.set(2, 2, 2, 2); return; }
    const key = `${view.latMin.toFixed(3)},${view.lonMin.toFixed(3)},${view.latMax.toFixed(3)},${view.lonMax.toFixed(3)}|${units}`;
    if (key === this.detailKey) return;
    this.detailKey = key;
    this.detailAbort?.abort(); this.detailAbort = new AbortController();
    try {
      const bmp = await bitmap(this.exportUrl(view, view.w, view.h, units), this.detailAbort.signal);
      if (this.detailKey !== key) { bmp.close(); return; }
      this.clear("detail");
      const b = this.liveBox;                                     // cut the detail's area out of the base
      if (b && this.meshes.base) this.meshes.base.material.uniforms.uHole.value.set((view.lonMin - b.lonMin) / (b.lonMax - b.lonMin), (view.latMin - b.latMin) / (b.latMax - b.latMin), (view.lonMax - b.lonMin) / (b.lonMax - b.lonMin), (view.latMax - b.latMin) / (b.latMax - b.latMin));
      this.meshes.detail = this.mesh(this.texture(bmp), view, proj, (la, lo) => [(lo - view.lonMin) / (view.lonMax - view.lonMin), (la - view.latMin) / (view.latMax - view.latMin)], 4);
      this.group.add(this.meshes.detail);
    } catch (e) { if (e.name !== "AbortError") throw e; }
  }
}
