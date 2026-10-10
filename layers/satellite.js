// GOES-West satellite imagery from NASA GIBS (gibs.earthdata.nasa.gov WMS, browser-readable),
// for checking the model's clouds against the real sky. One image for the region's box, in
// plate carrée (EPSG:4326), which maps linearly onto the scene's local projection.
//
//   GeoColor   true colour by day, infrared clouds and city lights at night
//   Clean IR   band 13 (10.3 µm): cold cloud tops bright, day and night; drawn as clouds only
//   Visible    band 2 (0.64 µm), daytime only
//
// Laid over the map (under the model clouds, markers and particles) so the two can be compared
// from above. The time is the forecast time on screen when that's already past (to the 10 min
// the satellite has), else the newest image; the caller says which. GIBS runs 20-40 min behind.

import * as THREE from "three";

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
export const PRODUCTS = {
  geocolor: { layer: "GOES-West_ABI_GeoColor", label: "GeoColor (true colour by day, infrared at night)" },
  ir: { layer: "GOES-West_ABI_Band13_Clean_Infrared", label: "Clean infrared (clouds, day and night)", cloudsOnly: true },
  vis: { layer: "GOES-West_ABI_Band2_Red_Visible_1km", label: "Visible (daytime only)" },
};

export class SatelliteLayer {
  constructor() { this.group = new THREE.Group(); this.opacity = 0.75; this.key = null; this.mesh = null; }

  clear() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.uniforms.uTex.value?.dispose(); this.mesh.material.dispose(); this.mesh = null; }
    this.key = null;
  }
  setOpacity(o) { this.opacity = o; if (this.mesh) this.mesh.material.uniforms.uOpacity.value = o; }

  // bbox {latMin, latMax, lonMin, lonMax}; time: Date or null (newest). Resolves when drawn.
  async show(proj, bbox, product, time) {
    const p = PRODUCTS[product] || PRODUCTS.geocolor;
    const t = time ? new Date(Math.floor(time.getTime() / 600e3) * 600e3) : null;       // the 10-min slot
    const key = `${product}|${t?.toISOString() ?? "latest"}|${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}`;
    if (key === this.key && this.mesh) return;
    this.key = key;
    const dLon = bbox.lonMax - bbox.lonMin, dLat = bbox.latMax - bbox.latMin;
    const W = 2048, H = Math.round((W * dLat) / dLon);
    const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${p.layer}&CRS=EPSG:4326`
      + `&BBOX=${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg`
      + (t ? `&TIME=${t.toISOString().slice(0, 19)}Z` : "");
    // fetch (not an <img>) so the download meter sees it; flipped to match TextureLoader's orientation.
    const r = await fetch(url);
    if (!r.ok) throw new Error(`satellite HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob(), { imageOrientation: "flipY" });
    if (this.key !== key) { bmp.close(); return; }                   // superseded while loading
    const tex = new THREE.Texture(bmp);
    tex.flipY = false; tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const sw = proj.toXY(bbox.latMin, bbox.lonMin), ne = proj.toXY(bbox.latMax, bbox.lonMax);
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.uniforms.uTex.value?.dispose(); this.mesh.material.dispose(); }
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uOpacity: { value: this.opacity }, uClouds: { value: p.cloudsOnly ? 1 : 0 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uOpacity; uniform float uClouds; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(uTex, vUv).rgb;
          float a = uOpacity;
          if (uClouds > 0.5) { float l = dot(c, vec3(0.299, 0.587, 0.114)); a *= smoothstep(0.25, 0.7, l); }   // infrared: clouds only
          gl_FragColor = vec4(c, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(ne.x - sw.x, ne.y - sw.y), mat);
    this.mesh.position.set((sw.x + ne.x) / 2, (sw.y + ne.y) / 2, 0.05);
    this.mesh.renderOrder = 9;                                       // over the ground, under the model's layers
    this.group.add(this.mesh);
  }
}
