// Named places on the map (web/data/<region>/places.json, built by pipeline/places.py from the
// owner's notes): waypoints, FADs, lights, anchorages, points, peaks, airports, channels and
// islands. Each has a short outlined pole in its kind's colour and a label with a symbol; islands
// and channels are labels only. The expedition's key stops (home port, base camps, summit) are
// emphasised.
//
// Hover (or tap) a label for a card (hit-tested from the map canvas; labels let the mouse through): the name, its meaning, position, light, the owner's notes,
// and the model's wind and sea there for the time on screen, with the NWS zone forecast.
// The optional expedition route (drawRoute) has its own toggle.
// Labels hide behind terrain like the others (explore.js occludeLabels); where place labels
// overlap on screen, the more important kind wins (declutter below), and zooming in shows the rest.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { outlinedLines } from "./layers/windglyphs.js?v=20261002173952";

export const KINDS = {
  island:    { label: "island", sym: "", colour: null, rank: 0 },
  channel:   { label: "channel", sym: "", colour: null, rank: 0 },
  anchorage: { label: "harbour or anchorage", sym: "⚓", colour: 0x8fe3a1, rank: 1 },
  light:     { label: "light or buoy", sym: "✦", colour: 0xfff1a8, rank: 2 },
  point:     { label: "point or cape", sym: "▸", colour: 0xd6c6ff, rank: 2 },
  peak:      { label: "summit or high ground", sym: "▲", colour: 0xc9b79c, rank: 3 },
  waypoint:  { label: "waypoint", sym: "◇", colour: 0x7fd6e0, rank: 3 },
  airport:   { label: "airport (weather data)", sym: "✈", colour: 0x9aa9ad, rank: 4 },
  fad:       { label: "fish aggregating device (FAD)", sym: "◎", colour: 0xf2c14e, rank: 4 },
  coast:     { label: "coastal feature", sym: "•", colour: 0xc9b79c, rank: 5 },
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class Places {
  // stage: Stage; groundKm(x, y): drawn ground height (km); report(lat, lon): the model there (HTML), or "".
  constructor(stage, { groundKm, report }) {
    Object.assign(this, { stage, groundKm, report });
    this.group = new THREE.Group();
    stage.scene.add(this.group);
    this.data = null; this.labels = [];
    this.card = document.createElement("div");
    this.card.id = "place-card"; this.card.hidden = true;
    document.body.append(this.card);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hideCard(true); });
    stage.beforeLabels.push(() => this.declutter());              // after occlusion (registered later)
    this.pointer(stage.renderer.domElement);
  }

  async load(regionId) {
    this.data = null;
    // no-cache: revalidate with the server each time (cheap, ETag), so an edit shows on the next load
    // instead of after the browser's 10-minute cache.
    const r = await fetch(`data/${regionId}/places.json`, { cache: "no-cache" }).catch(() => null);
    this.data = r?.ok ? await r.json() : null;
    return this.data;
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse?.((q) => { q.geometry?.dispose(); q.material?.dispose?.(); });
      if (o.isCSS2DObject) o.element.remove();
    }
    this.labels = []; this.hits = [];                               // (stale hover boxes answered hovers in the next region)
    this.hideCard(true);
  }

  // skip: names already labelled on the map (the areas of interest), compared without diacritics.
  draw(proj, vex, on, skip = []) {
    this.clear();
    const norm = (t) => t.normalize("NFD").replace(/[\u0300-\u036f\u02bb\u2018']/g, "").toLowerCase().trim(), dup = new Set(skip.map(norm));
    if (!on || !this.data) { this.stage.markDirty(); return; }
    const h = 0.6 * vex;
    for (const p of this.data.places) {
      const xy = proj.toXY(p.lat, p.lon);
      if (!proj.contains(xy.x, xy.y)) continue;
      if (!KINDS[p.kind]?.colour && dup.has(norm(p.label))) continue;          // an area of interest says it already
      const k = KINDS[p.kind] || KINDS.coast, z0 = this.groundKm(xy.x, xy.y) || 0, big = !k.colour;
      if (!big) this.group.add(outlinedLines([xy.x, xy.y, z0, xy.x, xy.y, z0 + h], k.colour, { width: p.key ? 2.4 : 1.6, opacity: 0.95, order: 20 }));
      const el = document.createElement("div");
      el.className = `label place k-${p.kind}${p.key ? " key" : ""}${big ? " big" : ""}`;
      el.innerHTML = `${k.sym ? `<span class="sym" style="color:#${k.colour.toString(16).padStart(6, "0")}">${k.sym}</span>` : ""}${esc(p.label)}${p.key ? `<span class="tag">${esc(p.key)}</span>` : ""}`;
      const o = new CSS2DObject(el);
      o.userData.card = p;                                        // hover/click: see pointer() (labels don't take the mouse)
      o.position.set(xy.x, xy.y, big ? z0 + 0.4 * vex : z0 + h);
      o.userData.rank = p.key ? -1 : k.rank;
      this.group.add(o);
      this.labels.push(o);
    }
    this.stage.markDirty();
  }

  // The optional expedition route (places.json "routes"): each leg an amber line just above the
  // sea with chevrons pointing along it, and a label at its longest segment whose card lists the
  // segments (distance, true bearing). Drawn only when its toggle is on; not a plan.
  drawRoute(proj, vex, on) {
    for (const o of [...(this.routeGroup?.children || [])]) { this.routeGroup.remove(o); o.traverse?.((q) => { q.geometry?.dispose(); q.material?.dispose?.(); }); if (o.isCSS2DObject) o.element.remove(); }
    if (!this.routeGroup) { this.routeGroup = new THREE.Group(); this.stage.scene.add(this.routeGroup); }
    this.routeLabels = [];
    const r = this.data?.routes?.[0];
    if (!on || !r) { this.stage.markDirty(); return; }
    const Z = 0.05, AMBER = 0xffb347, segs = [], chev = [];
    // Out-and-back stretches (a segment and its reverse both in the route) are drawn as two lanes,
    // each 0.35 km to the right of its direction of travel, so both directions show.
    const key = (p, q) => `${p.label}>${q.label}`, all = new Set();
    for (const leg of r.legs) for (let i = 0; i < leg.points.length - 1; i++) all.add(key(leg.points[i], leg.points[i + 1]));
    r.legs.forEach((leg, li) => {
      const xy = leg.points.map((q) => proj.toXY(q.lat, q.lon));
      let best = -1, bi = 0, lane = false;
      for (let i = 0; i < xy.length - 1; i++) {
        let a = xy[i], b = xy[i + 1];
        if (all.has(key(leg.points[i + 1], leg.points[i]))) {
          const dx0 = b.x - a.x, dy0 = b.y - a.y, L0 = Math.hypot(dx0, dy0) || 1, ox = (dy0 / L0) * 0.35, oy = (-dx0 / L0) * 0.35;
          a = { x: a.x + ox, y: a.y + oy }; b = { x: b.x + ox, y: b.y + oy }; lane = true;
        }
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
        segs.push(a.x, a.y, Z, b.x, b.y, Z);
        if (L > best) { best = L; bi = i; this._ab = [a, b]; }
        // Chevrons every ~8 km (at least one), pointing along the leg.
        const n = Math.max(1, Math.floor(L / 8)), ux = dx / (L || 1), uy = dy / (L || 1), s = Math.min(0.9, L / 4);
        for (let k = 1; k <= n; k++) {
          const f = k / (n + 1), cx = a.x + dx * f, cy = a.y + dy * f;
          chev.push(cx - ux * s - uy * s * 0.7, cy - uy * s + ux * s * 0.7, Z, cx, cy, Z, cx, cy, Z, cx - ux * s + uy * s * 0.7, cy - uy * s - ux * s * 0.7, Z);
        }
      }
      const [a, b] = this._ab, el = document.createElement("div"), f = lane ? 0.35 : 0.5;   // lanes: labels apart
      el.className = "label place route";
      el.innerHTML = `<span class="leg">${li + 1}</span>${leg.nm} nm`;                 // the leg's name is in its card
      const card = { label: `Leg ${li + 1}: ${leg.name}`, kind: "route", name: `${leg.name}`, notes: null, leg, route: r };
      const o = new CSS2DObject(el);
      o.userData.card = card;
      o.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, Z + 0.3);
      o.userData.rank = -2;                                        // wins the declutter
      this.routeGroup.add(o);
      this.routeLabels.push(o);
    });
    // Computed points (the turnaround): a pole and a label, since they aren't among the places.
    const seen = new Set();
    for (const leg of r.legs) for (const q of leg.points) {
      if (!q.computed || seen.has(q.label)) continue;
      seen.add(q.label);
      const xy = proj.toXY(q.lat, q.lon), h = 0.6 * vex;
      this.routeGroup.add(outlinedLines([xy.x, xy.y, 0, xy.x, xy.y, h], AMBER, { width: 2.2, opacity: 0.95, order: 20 }));
      const el = document.createElement("div");
      el.className = "label place route turn";
      el.textContent = `↺ ${q.label}`;
      el.title = `${q.lat.toFixed(4)}° N, ${Math.abs(q.lon).toFixed(4)}° W. ${r.note}`;
      const o = new CSS2DObject(el);
      o.position.set(xy.x, xy.y, h);
      o.userData.rank = -2;
      this.routeGroup.add(o); this.routeLabels.push(o);
    }
    this.routeGroup.add(outlinedLines(segs, AMBER, { width: 2.2, opacity: 0.95, order: 19 }));
    this.routeGroup.add(outlinedLines(chev, AMBER, { width: 2, opacity: 0.95, order: 19 }));
    this.stage.markDirty();
  }

  // Place labels that overlap on screen: the more important kind (and key stops) stay. Runs every
  // rendered frame, so no layout reads: screen positions come from projecting the anchors, and each
  // label's size is measured once and kept (its text never changes). All hiding is written at the
  // end. (Reading getBoundingClientRect between writes forced a layout per label: slow.)
  declutter() {
    const all = [...this.labels, ...(this.routeLabels || [])];
    if (!all.length) { this.hits = []; return; }
    const cam = this.stage.camera, W = innerWidth, H = innerHeight, P = (this._v ||= new THREE.Vector3()), items = [];
    for (const o of all) {
      const el = o.element;
      if (el.style.visibility === "hidden") continue;                 // behind terrain (the occlusion pass just ran)
      if (!o.userData.w) { o.userData.w = el.offsetWidth; o.userData.h = el.offsetHeight; }   // once per label
      o.getWorldPosition(P).project(cam);
      if (P.z > 1 || !o.userData.w) continue;
      const w = o.userData.w, h = o.userData.h, x = ((P.x + 1) / 2) * W - w / 2, y = ((1 - P.y) / 2) * H - h / 2;
      items.push({ o, el, rank: o.userData.rank, x, y, w, h });
    }
    items.sort((a, b) => a.rank - b.rank);
    const kept = [], hide = [];
    for (const it of items) {
      if (kept.some((k) => it.x < k.x + k.w + 2 && k.x < it.x + it.w + 2 && it.y < k.y + k.h && k.y < it.y + it.h)) hide.push(it.el);
      else kept.push(it);
    }
    for (const el of hide) el.style.visibility = "hidden";
    this.hits = kept.filter((k) => k.o.userData.card);
  }

  // The label under a pointer event, or undefined. (Window coordinates, as declutter() computes the
  // boxes: the canvas fills the window.) Also used so a click on a label doesn't open the inspector.
  hitAt(e) { return (this.hits || []).find((k) => e.clientX >= k.x - 3 && e.clientX <= k.x + k.w + 3 && e.clientY >= k.y - 2 && e.clientY <= k.y + k.h + 2); }

  // Hover and click on labels, from the map canvas: the labels let the mouse through, so a drag or
  // scroll that starts on one still rotates, pans or zooms the map. Hover shows a label's card; a
  // click (or tap) without moving pins it; a click elsewhere, Esc or the next drag closes it.
  pointer(canvas) {
    const at = (e) => this.hitAt(e);
    let pending = null, down = null, over = null;
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons) { if (over) { over = null; canvas.style.cursor = ""; } return; }   // dragging the map
      if (e.pointerType === "touch") return;
      if (!pending) requestAnimationFrame(() => {
        const q = pending; pending = null;
        const k = at(q);
        if (k?.o !== over?.o) {
          over = k || null;
          canvas.style.cursor = k ? "help" : "";
          if (k) { if (!this.pinned) this.showCard(k.o.userData.card, k.el); } else if (!this.pinned) this.hideCard();
        }
      });
      pending = { clientX: e.clientX, clientY: e.clientY };
    });
    canvas.addEventListener("pointerleave", () => { over = null; canvas.style.cursor = ""; if (!this.pinned) this.hideCard(); });
    canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener("pointerup", (e) => {
      if (!down) return;
      const click = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 400;
      down = null;
      if (!click) return;
      const k = at(e);
      if (k) this.showCard(k.o.userData.card, k.el, true);
      else if (this.pinned) this.hideCard(true);
    });
  }

  showCard(p, el, pin = false) {
    const k = KINDS[p.kind] || KINDS.coast;
    const rows = p.kind === "route" ? [
      `<div class="pc-h"><b>${esc(p.label)}</b></div>`,
      `<div class="pc-k">${esc(p.route.label)} · ${p.leg.nm} nm of ${p.route.nm} nm</div>`,
      `<table class="pc-legs">${p.leg.segments.map((g) => `<tr><td>→ ${esc(g.to)}</td><td>${g.nm} nm</td><td>${String(g.brgT).padStart(3, "0")}°T</td></tr>`).join("")}</table>`,
      `<div class="pc-notes">${esc(p.route.note)}</div>`,
    ] : [
      `<div class="pc-h"><b>${esc(p.label)}</b>${p.key ? ` <span class="tag">${esc(p.key)}</span>` : ""}</div>`,
      `<div class="pc-k">${esc(k.label)}${p.island ? ` · ${esc(p.island)}` : ""}${p.elevFt ? ` · ${p.elevFt.toLocaleString("en-US")} ft` : ""}</div>`,
      p.name !== p.label ? `<div class="pc-n">${esc(p.name)}</div>` : "",
      p.meaning ? `<div class="pc-m">“${esc(p.meaning)}”</div>` : "",
      p.dm ? `<div class="pc-pos">${esc(p.dm)}</div>` : "",
      p.light ? `<div class="pc-l">Light: ${esc(p.light)}</div>` : "",
      p.notes ? `<div class="pc-notes">${esc(p.notes)}</div>` : "",
    ];
    const model = p.kind === "route" ? "" : this.report?.(p.lat, p.lon) || "";
    this.card.innerHTML = rows.join("") + (model ? `<div class="pc-model">${model}</div>` : "")
      + (pin ? `<div class="pc-close">Tap elsewhere or Esc to close</div>` : "");
    this.card.hidden = false;
    this.pinned = pin;
    const r = el.getBoundingClientRect(), c = this.card.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    let x = r.right + 10, y = r.top - 6;
    if (x + c.width > W - 8) x = r.left - 10 - c.width;
    if (x < 8) x = Math.max(8, Math.min(W - c.width - 8, r.left));
    y = Math.max(8, Math.min(H - c.height - 8, y));
    this.card.style.left = `${x}px`; this.card.style.top = `${y}px`;
  }
  hideCard(force = false) { if (force || !this.pinned) { this.card.hidden = true; this.pinned = false; } }
}
