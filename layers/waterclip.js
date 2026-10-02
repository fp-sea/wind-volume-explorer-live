// "Over water only": clips horizontal displays (slice, inversion sheet, turbulence dots) to the
// water, per pixel, against the smooth coastline (the ground layers' signed distance to the
// GSHHS coast, 500 m grid, linearly filtered), so the edge follows the real shore rather than the
// model's 2.5-3 km cells. Particles are kept to the water on the CPU (see particles.js).
//
// Outside the ground layers' grid (the model box is a little larger) there's no coastline, so
// those parts are hidden too.
//
// A material is patched once (patch()); the toggle is a shared uniform, so switching is instant.

import * as THREE from "three";

export class WaterClip {
  constructor() {
    this.uniforms = { uWaterClip: { value: 0 }, uCoastTex: { value: null }, uOrigin: { value: new THREE.Vector2() },
                      uSize: { value: new THREE.Vector2(1, 1) }, uTexN: { value: new THREE.Vector2(1, 1) } };
  }
  get ready() { return !!this.uniforms.uCoastTex.value; }
  set on(v) { this.uniforms.uWaterClip.value = v && this.ready ? 1 : 0; }
  get on() { return this.uniforms.uWaterClip.value > 0.5; }

  // ground: layers/ground.js Ground (meta.terrain grid + coast signed distance, 10 m units, + land).
  setGround(ground) {
    this.uniforms.uCoastTex.value?.dispose();
    this.uniforms.uCoastTex.value = null;
    if (!ground?.ready) return;
    const t = ground.meta.terrain, n = t.nx * t.ny, px = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      // Land > 128, water < 128, the coast at 128 (±2 km mapped onto ±120).
      const sd = ground.coast ? ground.coast[k] : (ground.mask[k] ? 200 : -200);
      px[k] = Math.max(0, Math.min(255, Math.round(128 + sd * 0.6)));
    }
    const tex = new THREE.DataTexture(px, t.nx, t.ny, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.uniforms.uCoastTex.value = tex;
    this.uniforms.uOrigin.value.set(t.x0, t.y0);
    this.uniforms.uSize.value.set((t.nx - 1) * t.dxy, (t.ny - 1) * t.dxy);
    this.uniforms.uTexN.value.set(t.nx, t.ny);
  }

  patch(material) {
    const u = this.uniforms, prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
    material.onBeforeCompile = (sh, r) => {
      prev.call(material, sh, r);                               // another patch first (value colouring)
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vWcXY;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvWcXY = (modelMatrix * vec4(transformed, 1.0)).xy;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vWcXY;\nuniform float uWaterClip; uniform sampler2D uCoastTex; uniform vec2 uOrigin; uniform vec2 uSize; uniform vec2 uTexN;")
        .replace("void main() {", `void main() {
  if (uWaterClip > 0.5) {
    vec2 uv = (vWcXY - uOrigin) / uSize;
    uv = uv * (uTexN - 1.0) / uTexN + 0.5 / uTexN;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || texture2D(uCoastTex, uv).r > 0.5) discard;   // outside the coastline grid: unknown, hidden
  }`);
    };
    material.customProgramCacheKey = () => `waterclip|${prevKey.call(material)}`;
    material.needsUpdate = true;
    return material;
  }
}
