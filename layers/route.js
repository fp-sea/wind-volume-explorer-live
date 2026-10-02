// The passage planner on the map: numbered waypoint pins, the planned route as a bright ribbon
// on the water (grey where motoring), marks where it tacks or gybes, and the boat's position at
// the time on screen.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const Z = 0.075;

export class RouteLayer {
  constructor() {
    this.group = new THREE.Group(); this.group.renderOrder = 14;
    this.pins = new THREE.Group(); this.line = new THREE.Group(); this.boat = null;
    this.group.add(this.pins, this.line);
  }
  dispose(g) {
    for (const o of [...g.children]) { g.remove(o); o.traverse?.((q) => { q.geometry?.dispose(); q.material?.dispose?.(); if (q.isCSS2DObject) q.element.remove(); }); }
  }
  // wps: [{x, y}]
  setWaypoints(wps) {
    this.dispose(this.pins);
    wps.forEach((w, i) => {
      const last = i === wps.length - 1 && wps.length > 1, col = i === 0 ? 0x3fc1a5 : last ? 0xe0473c : 0xffd166;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.75, 28), new THREE.MeshBasicMaterial({ color: col, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      ring.position.set(w.x, w.y, Z + 0.003); ring.renderOrder = 16; this.pins.add(ring);
      const el = document.createElement("div"); el.className = "label wp"; el.textContent = i === 0 ? "Start" : last ? "End" : String(i);
      const lab = new CSS2DObject(el); lab.position.set(w.x, w.y, Z + 0.01); lab.center.set(-0.15, 1.1); this.pins.add(lab);
    });
  }
  // pts: the route's points ({x, y, m: {motor, side}}); tacks: [{x, y, kind}]
  setRoute(pts, tacks = []) {
    this.dispose(this.line);
    this.pts = pts;
    if (!pts?.length) return;
    // A ribbon ~0.35 km wide, with a dark edge underneath.
    const ribbon = (w, colorOf, z, order, opacity) => {
      const pos = [], col = [], idx = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, c = colorOf(pts[i]);
        pos.push(pts[i].x + nx * w, pts[i].y + ny * w, z, pts[i].x - nx * w, pts[i].y - ny * w, z); col.push(...c, ...c);
        if (i) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      m.renderOrder = order; this.line.add(m);
    };
    ribbon(0.3, () => [0.03, 0.07, 0.09], Z, 14, 0.85);
    ribbon(0.18, (p) => (p.m?.motor ? [0.72, 0.74, 0.76] : [1, 0.33, 0.78]), Z + 0.001, 15, 1);
    for (const t of tacks) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.32, 4), new THREE.MeshBasicMaterial({ color: t.kind === "gybe" ? 0x6fb8ff : 0xffffff, depthWrite: false, depthTest: false }));
      d.position.set(t.x, t.y, Z + 0.002); d.renderOrder = 16; this.line.add(d);
    }
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: 0xffd166, depthWrite: false, depthTest: false }));
    b.renderOrder = 17; b.visible = false; this.line.add(b); this.boat = b;
    // (a dark rim, so the disc shows on yellow and light layers too)
    const rim = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.8, 32), new THREE.MeshBasicMaterial({ color: 0x0b1418, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false }));
    rim.renderOrder = 16.9; b.add(rim);
    // The conditions tag beside the boat (html set by setTag; follows the boat).
    // (a zero-size anchor at the boat; the box and its leader line are placed from it)
    const el = document.createElement("div"); el.className = "route-tag"; el.hidden = true; el.innerHTML = `<svg class="rt-lead"><line/></svg><div class="rt-box"></div>`;
    this.tag = new CSS2DObject(el); this.tag.center.set(0, 0); b.add(this.tag);
  }
  // html: the tag's contents, or null to hide it.
  setTag(html, camera = null) {
    if (!this.tag) return;
    const el = this.tag.element;
    if (!html) { el.hidden = true; return; }
    const box = el.querySelector(".rt-box");
    if (box.innerHTML !== html) box.innerHTML = html;
    el.hidden = !this.boat.visible;
    if (camera) this.camera = camera;
    this.placeTag();
  }
  // Clear of the boat, never over it: 36 px off to the right, left, above or below, whichever fits
  // wholly in the view, with a leader line to the boat; if none does, in the view's top-left
  // corner. (mode "corner": always there, no leader.) Called again as the view or boat moves.
  placeTag() {
    const el = this.tag?.element, cam = this.camera;
    if (!el || el.hidden || !cam || !this.boat.visible) return;
    const box = el.querySelector(".rt-box"), lead = el.querySelector(".rt-lead"), line = lead.firstChild;
    const view = el.parentElement, W = view?.clientWidth || innerWidth, H = view?.clientHeight || innerHeight;
    const v = this.boat.getWorldPosition(new THREE.Vector3()).project(cam), px = ((v.x + 1) / 2) * W, py = ((1 - v.y) / 2) * H;
    const w = box.offsetWidth, h = box.offsetHeight, gap = 36, m = 6, top = 56;             // (top: under the map's own title bar)
    const fits = (x, y) => x >= m && y >= top && x + w <= W - m && y + h <= H - m;
    let pos = null;
    if (this.tagMode !== "corner") for (const [x, y] of [[px + gap, py - h / 2], [px - gap - w, py - h / 2], [px - w / 2, py - gap - h], [px - w / 2, py + gap]]) if (fits(x, y)) { pos = [x, y]; break; }
    const corner = !pos;
    if (corner) pos = [m + 4, top];
    const dx = pos[0] - px, dy = pos[1] - py;
    box.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    el.classList.toggle("corner", corner);
    lead.style.display = corner ? "none" : "";
    if (!corner) {                                                  // (to the box's nearest point)
      const nx = Math.max(dx, Math.min(0, dx + w)), ny = Math.max(dy, Math.min(0, dy + h));
      line.setAttribute("x1", 0); line.setAttribute("y1", 0); line.setAttribute("x2", nx); line.setAttribute("y2", ny);
    }
  }
  // The boat on the route at time t (ms); hidden before the start or after the end.
  setTime(t) {
    const P = this.pts;
    if (!this.boat || !P?.length) return;
    if (t < P[0].t || t > P[P.length - 1].t) { this.boat.visible = false; if (this.tag) this.tag.element.hidden = true; return; }
    let i = 1; while (i < P.length - 1 && P[i].t < t) i++;
    const a = P[i - 1], b = P[i], f = (t - a.t) / Math.max(1, b.t - a.t);
    this.boat.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, Z + 0.004); this.boat.visible = true;
  }
  // Other models' routes (compare): thin coloured lines. alts: [{pts, color}]
  setAlts(alts = []) {
    this.alts ||= new THREE.Group(); if (!this.alts.parent) this.group.add(this.alts);
    this.dispose(this.alts);
    for (const a of alts) {
      const g = new THREE.BufferGeometry().setFromPoints(a.pts.map((p) => new THREE.Vector3(p.x, p.y, Z - 0.002)));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: a.color, transparent: true, opacity: 0.95, depthTest: false }));
      l.renderOrder = 13; this.alts.add(l);
    }
  }
  clear() { this.dispose(this.pins); this.dispose(this.line); if (this.alts) this.dispose(this.alts); this.pts = null; this.boat = null; }
}
