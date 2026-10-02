// The 3D stage: renderer, label renderer, camera, orbit controls, render-on-demand
// loop, panel-aware framing, and smooth camera flights.
//
// Adapted from radar-explorer web/app.js (three.js setup, resize, visibleRect,
// updateViewOffset, view flights) at 7439092. That code lives inside radar-explorer's
// app.js, not in a module, so this is a rewrite of the same behaviour rather than a
// verbatim copy. The SYNC blocks mark the parts kept line-for-line.
//
// Camera controls are stock OrbitControls, as in radar-explorer: left-drag rotates,
// wheel or pinch zooms, and right-drag or shift/ctrl-drag pans. They run on Pointer
// Events, so touch works too.

import * as THREE from "three";
import { LITE } from "../device.js?v=20261002173952";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { framing } from "./views.js?v=20261002173952";

export class Stage {
  constructor(container, { panels = ["panel"] } = {}) {
    this.panels = panels;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });   // preserve: exports read the canvas
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LITE ? 1.5 : 2));   // phones: 1.5 (device.js)
    this.renderer.setClearColor(0x0b1a20);
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: "absolute", top: "0", pointerEvents: "none" });
    container.appendChild(this.labels.domElement);

    // SYNC: radar-explorer web/app.js@7439092 label cleanup on remove. Copied verbatim.
    // Labels are page elements drawn over the 3D view. three.js removes a label's
    // element only when that label itself is removed; one inside a group that is
    // removed or cleared kept its element, frozen where it last was on screen.
    // Every removal now takes nested labels with it.
    {
      const remove = THREE.Object3D.prototype.remove;
      THREE.Object3D.prototype.remove = function (...objs) {
        for (const o of objs) o?.traverse?.((d) => { if (d.isCSS2DObject && d.element?.parentNode) d.element.remove(); });
        return remove.apply(this, objs);
      };
    }
    // END SYNC

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 12000);
    this.camera.up.set(0, 0, 1);                                   // z up, as in radar-explorer
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.499;
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x202830, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-150, 100, 200);                              // low from the north-west, the usual hillshade light
    this.scene.add(sun);

    this.vex = 3;               // vertical exaggeration applied to heights (km); 3×: terrain looks natural, layers still read (owner, 2026-09-27)
    this.dirty = true;
    this.flight = null;
    this.onFrame = [];          // callbacks run each rendered frame (particles, etc.)
    this.beforeLabels = [];     // callbacks run just before labels are placed (label occlusion)
    this.controls.addEventListener("change", () => this.markDirty());
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  markDirty() { this.dirty = true; }

  // 2D: looking straight down, north up, like a chart. Left-drag pans, wheel or pinch zooms; no
  // rotating or tilting. Off: back to the 3D view it left. (The camera is kept a hair off vertical
  // so "up" stays north; the azimuth and tilt are then locked.)
  set2D(on) {
    const c = this.controls, cam = this.camera;
    if (on === !!this.is2D) return;
    if (on) {
      this.saved3D = { pos: cam.position.clone(), target: c.target.clone() };
      const d = cam.position.distanceTo(c.target);
      cam.position.set(c.target.x, c.target.y - d * 0.001, c.target.z + d); c.update();
      const pol = c.getPolarAngle(), az = c.getAzimuthalAngle();
      Object.assign(c, { minPolarAngle: pol, maxPolarAngle: pol, minAzimuthAngle: az, maxAzimuthAngle: az, screenSpacePanning: true });
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      Object.assign(c, { minPolarAngle: 0, maxPolarAngle: Math.PI * 0.499, minAzimuthAngle: -Infinity, maxAzimuthAngle: Infinity });
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      if (this.saved3D) {                                         // (back where it was, moved with any panning done in 2D)
        const dx = c.target.x - this.saved3D.target.x, dy = c.target.y - this.saved3D.target.y;
        cam.position.set(this.saved3D.pos.x + dx, this.saved3D.pos.y + dy, this.saved3D.pos.z);
        c.target.set(this.saved3D.target.x + dx, this.saved3D.target.y + dy, this.saved3D.target.z);
      }
    }
    this.is2D = on; c.update(); this.markDirty();
    this.on2D?.(on);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;             // a hidden or collapsed window: keep the last size (0/0 would poison the camera)
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.updateViewOffset();
  }

  // SYNC: radar-explorer web/app.js@7439092 visibleRect(). Same logic, with the panel ids passed in.
  // The part of the screen not covered by the panels. Views then frame into what you can actually see.
  visibleRect() {
    const W = window.innerWidth, H = window.innerHeight;
    let x0 = 0, x1 = W, y0 = 44, y1 = H - 64;
    for (const id of this.panels) {
      const el = document.getElementById(id);
      if (!el || el.hidden || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < W * 0.5) {
        if (r.left + r.width / 2 < W / 2) x0 = Math.max(x0, r.right + 8);
        else x1 = Math.min(x1, r.left - 8);
      } else if (r.top + r.height / 2 > H / 2) y1 = Math.min(y1, r.top - 8);
      else y0 = Math.max(y0, r.bottom + 8);
    }
    if (x1 - x0 < W * 0.3) { x0 = 0; x1 = W; }
    if (y1 - y0 < H * 0.25) { y0 = 0; y1 = H; }
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, W, H };
  }
  // END SYNC

  // A projection offset that puts the camera's centre in the middle of the visible rectangle.
  updateViewOffset() {
    const r = this.visibleRect();
    const dx = (r.x0 + r.x1) / 2 - r.W / 2, dy = (r.y0 + r.y1) / 2 - r.H / 2;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) this.camera.clearViewOffset();
    else this.camera.setViewOffset(r.W, r.H, -dx, -dy, r.W, r.H);
    this.camera.updateProjectionMatrix();
    this.markDirty();
  }

  // Camera for a view definition (views.js), framed into the visible area of `box`.
  framingFor(v, box) {
    this.updateViewOffset();
    return framing(v, v.center, { grid: box, vex: this.vex, visible: this.visibleRect(), H: window.innerHeight, fov: this.camera.fov });
  }

  // Move the camera to {pos, target}, smoothly unless instant (or the page is hidden:
  // hidden pages get no animation frames).
  flyTo({ pos, target }, { instant = false, ms = 900 } = {}) {
    const to = { pos: new THREE.Vector3(pos.x, pos.y, pos.z), target: new THREE.Vector3(target.x, target.y, target.z) };
    if (instant || document.hidden) {
      this.flight = null;
      this.camera.position.copy(to.pos);
      this.controls.target.copy(to.target);
      this.controls.update();
      this.markDirty();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.flight = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone() }, to, t0: performance.now(), ms, resolve };
    });
  }

  _loop(now) {
    const f = this.flight;
    if (f) {
      const u = Math.min(1, (now - f.t0) / f.ms), e = ease(u);
      this.camera.position.lerpVectors(f.from.pos, f.to.pos, e);
      this.controls.target.lerpVectors(f.from.target, f.to.target, e);
      this.markDirty();
      if (u >= 1) { this.flight = null; f.resolve(); }
    }
    this.controls.update();
    for (const cb of this.onFrame) if (cb(now)) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      for (const cb of this.beforeLabels) cb();
      this.labels.render(this.scene, this.camera);
    }
    requestAnimationFrame(this._loop);
  }

  // Render right now (exports call this between steps).
  renderNow() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    for (const cb of this.beforeLabels) cb();
    this.labels.render(this.scene, this.camera);
  }
}

// SYNC: radar-explorer web/app.js@7439092 ease(). Copied verbatim.
export const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
// END SYNC
