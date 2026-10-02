// Model values under the cursor (desktop hover) or under a tap (phones): a small card next to
// the pointer.
//
//   on the horizontal slice   wind (from-direction; knots or the chosen units) and gust at the slice height, the
//                             colour-by value, the height (≈ mb · m · ft)
//   on the cross-section      the same at that point in the section
//   anywhere else             surface wind (10 m) and gust
//   always, when on           inversion base/top/strength and mixed-layer depth in that column;
//                             chop, swell and the NWS zone forecast (Sea state); visibility (Fog)
//
// Values are the ones drawn: between hours, the same linear blend; near the ground with the
// 15-minute data on, the 15-minute wind and gust. The lat/lon and ground-height/chart-depth
// line stays in the bottom-right hint (groundpanel.js).

import * as THREE from "three";
import { COLOUR_BY, mixDown, seaMinusAir } from "./layers/slice.js?v=20261002173952";
import { detectionOf } from "./layers/inversion.js?v=20261002173952";
import { tiiClass } from "./model/twi.js?v=20261002173952";
import { RI_CLASSES, riClass } from "./layers/colormap.js?v=20261002173952";
import { fmtSpeed } from "./units.js?v=20261002173952";
import { chopAt } from "./model/waves.js?v=20261002173952";
import { wavesAt as wavesAtSwell } from "./model/gfswave.js?v=20261002173952";
import { periodSummary } from "./model/zones.js?v=20261002173952";
import { visText } from "./layers/visibility.js?v=20261002173952";

const KT = 1.943844, M_FT = 3.28084;
const $ = (id) => document.getElementById(id);
const n0 = (x) => Math.round(x).toLocaleString("en-US");
const ft100 = (m) => Math.round((m * M_FT) / 100) * 100;

export class Probe {
  constructor(explore) {
    this.x = explore;
    this.el = document.createElement("div");
    this.el.id = "probe";
    this.el.hidden = true;
    document.body.append(this.el);
    const canvas = explore.stage.renderer.domElement;
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    let pending = null, down = null;
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (e.buttons) { this.hide(); return; }                  // rotating or panning: out of the way
      if (!pending) requestAnimationFrame(() => { const q = pending; pending = null; this.show(q.clientX, q.clientY); });
      pending = { clientX: e.clientX, clientY: e.clientY };
    });
    canvas.addEventListener("pointerleave", () => this.hide());
    // Touch: a tap (not a drag) shows the card for a few seconds.
    canvas.addEventListener("pointerdown", (e) => { down = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; if (down) this.hide(); });
    canvas.addEventListener("pointerup", (e) => {
      if (!down || e.pointerType !== "touch") return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 400;
      down = null;
      if (moved < 8 && quick) { this.show(e.clientX, e.clientY); clearTimeout(this.timer); this.timer = setTimeout(() => this.hide(), 6000); }
    });
  }

  hide() { this.el.hidden = true; }

  // Redo the card at the same spot (the time moved on during playback, or a layer changed).
  refresh() { if (!this.el.hidden && this.at) this.show(this.at[0], this.at[1]); }

  show(cx, cy) {
    this.at = [cx, cy];
    let lines = this.lines(cx, cy);
    // Over an observation label: its details first (the labels let the mouse through to the map).
    const tip = this.x.obsAt?.(cx, cy);
    if (tip) { const [head, ...rest] = tip.split("\n").map((t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])); lines = [`<b>${head}</b>`, ...rest, ...(lines ? ["", ...lines] : [])]; }
    if (!lines) { this.hide(); return; }
    this.el.innerHTML = lines.join("<br>");
    this.el.hidden = false;
    const W = window.innerWidth, H = window.innerHeight, r = this.el.getBoundingClientRect();
    const x = cx + 16 + r.width > W - 8 ? cx - 16 - r.width : cx + 16, y = Math.min(H - r.height - 8, Math.max(8, cy + 16));
    this.el.style.left = `${Math.max(8, x)}px`; this.el.style.top = `${y}px`;
  }

  // Readout lines for screen point (cx, cy), or null (no model loaded, or off the domain).
  lines(cx, cy) {
    const X = this.x, vol = X.vol, stage = X.stage;
    if (!vol || !X.proj) return null;
    const r = stage.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, stage.camera);
    const vex = stage.vex, clipped = (p) => X.clip.on && !X.isWater?.(p.x, p.y);
    const meshes = [];
    if (X.slice.mesh && X.slice.group.visible) meshes.push(X.slice.mesh);
    for (const c of X.curtain.group.children) if (c.isMesh) meshes.push(c);
    const hit = this.ray.intersectObjects(meshes, false).find((h) => h.object !== X.slice.mesh || !clipped(h.point));
    let p, zMsl, where;
    if (hit) {
      p = hit.point;
      const ll = X.proj.toLatLon(p.x, p.y), ter = vol.terrainAt(ll.lat, ll.lon);
      if (hit.object === X.slice.mesh) {
        zMsl = X.spec.ref === "agl" ? ter + X.spec.h : X.spec.h;
        where = "Slice";
      } else { zMsl = (p.z / vex) * 1000; where = "Cross-section"; }
      zMsl = Math.max(zMsl, ter);
    } else {
      // Nothing drawn under the pointer: the ground (or sea) there, surface wind.
      const t = new THREE.Vector3();
      const ground = this.ray.intersectObjects(X.groundMeshes?.() || [], false)[0]?.point
        || (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), t) ? t : null);
      if (!ground) return null;
      p = ground; where = "Surface"; zMsl = null;
    }
    if (!X.proj.contains(p.x, p.y)) return null;
    const ll = X.proj.toLatLon(p.x, p.y), c = this.cell(vol, ll.lat, ll.lon);
    if (c < 0) return null;
    const ter = vol.terrain[c], agl = zMsl == null ? 10 : zMsl - ter;
    const out = [];

    // Wind at that point. Near the ground with 15-minute data: that; else the volume.
    const near = agl <= 10.5, S = near && X.surf ? X.surf : null;
    let u, v, gust = NaN;
    if (S) { u = S.U[c]; v = S.V[c]; gust = S.G ? S.G[c] : NaN; }
    else {
      const z = zMsl ?? ter + 10;
      u = vol.sample("U", ll.lat, ll.lon, z); v = vol.sample("V", ll.lat, ll.lon, z);
      if (near && vol.raw.surface.GUST) gust = vol.raw.surface.GUST[c];
    }
    const head = `<b>${where}</b> · ${zMsl == null ? "10 m above ground" : this.height(vol, zMsl, agl)}${S ? " · 15-min" : ""}`;
    out.push(head);
    if (Number.isFinite(u) && Number.isFinite(v)) {
      const spd = Math.hypot(u, v) * KT, dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
      out.push(`Wind ${String(Math.round(dir) % 360).padStart(3, "0")}° ${fmtSpeed(spd)}` + (Number.isFinite(gust) ? ` · gust ${fmtSpeed(gust * KT)}` : ""));
    } else out.push("Wind: no data here");

    // The colour-by value, when it isn't the wind speed already shown.
    const f = COLOUR_BY[X.spec.field];
    if (hit && !["speed", "gust", "none"].includes(X.spec.field)) {
      const x = f.column2d ? f.value(vol, c) : f.surfaceOnly ? (near ? f.value(vol, c) : NaN) : f.sampled(vol, ll.lat, ll.lon, zMsl);
      out.push(`${f.label}: ${this.fmt(f, x)}`);
    }

    // Column extras.
    if ($("show-inversion").checked && X.vol0 && !X.model?.noInversion) {
      const d = detectionOf(X.nearest());
      out.push(Number.isFinite(d.base[c])
        ? `Inversion ${n0(d.base[c])}–${n0(d.top[c])} m (${n0(ft100(d.base[c]))}–${n0(ft100(d.top[c]))} ft) · TII ${d.tii[c].toFixed(1)} (${tiiClass(d.tii[c])})`
        : "No inversion in this column");
    }
    if ($("show-sea").checked && X.fetchGrid) {
      const w = X.windAt10(ll.lat, ll.lon), cur = $("cur-waves").checked && !$("cur-layer").hidden ? X.currentAt?.(p.x, p.y) : null;
      const cw = w && cur ? X.chopWithCurrent(p.x, p.y, w, cur) : null, ch = cw ? { ...cw.chop, hs: cw.hs } : w && chopAt(X.fetchGrid, p.x, p.y, w[0], w[1]);
      if (ch && ch.hs > 0) out.push(`Chop ${(ch.hs * 3.28084).toFixed(1)} ft at ${ch.tp.toFixed(1)} s · fetch ${Math.round(ch.fetchKm)} km${cw && Math.abs(cw.mul - 1) > 0.05 ? ` (${cw.mul > 1 ? "+" : "−"}${Math.round(Math.abs(cw.mul - 1) * 100)}% from the current)` : ""} · click to inspect`);
      const wm = X.swellHour ? wavesAtSwell(X.swellHour, ll.lat, ll.lon) : null;
      if (wm?.swell?.length) out.push(`Swell ${wm.swell.map((s) => `${(s.hs * 3.28084).toFixed(1)} ft ${Math.round(s.tp)} s from ${Math.round(s.dir)}°`).join(" · ")}`);
      const n = X.nwsAt?.(ll.lat, ll.lon);
      if (n) out.push(n.period ? `NWS ${n.zone.id} ${n.period.name.toLowerCase()}: ${periodSummary(n.period)}` : `NWS ${n.zone.id} ${n.zone.name}${X.cwf ? ": no period for this time" : ""}`);
    }
    if (!$("cur-layer").hidden && ($("show-cur").checked || ($("show-sea").checked && $("cur-waves").checked)) && X.curData) {
      const cur = X.currentAt(p.x, p.y), w = X.windAt10(ll.lat, ll.lon);
      if (cur) {
        const r = w && X.fetchGrid ? X.chopWithCurrent(p.x, p.y, w, cur) : null;
        out.push(`Current ${cur.kt.toFixed(1)} kt setting ${String(Math.round(cur.set)).padStart(3, "0")}° (${cur.src ? cur.src : `NOAA ${cur.station.name}, ${cur.km.toFixed(1)} km`})`
          + (r?.rating ? ` · ${r.rating > 1 ? "dangerous" : "steep"} chop: wind against current, ${(r.hs * 3.28084).toFixed(1)} ft, ${Math.round(r.L)} m apart` : ""));
      } else if ($("show-cur").checked) out.push($("cur-src")?.value === "sscofs" ? "Current: none here (outside SSCOFS and more than 5 km from a NOAA station)" : "Current: no NOAA station within 5 km");
    }
    if ($("show-fog").checked) {
      const V = vol.raw.surface.VIS, t = V ? visText(V[c]) : null;
      if (t) out.push(`Visibility ${t}`);
    }
    // Vertical mixing: how deep the stirred layer is, the wind in it (what can reach the water as
    // gusts) against the wind at 10 m, and over the water whether the sea is warmer than the air.
    if (($("show-turb").checked || ["pbl", "mixdown", "airsea", "gustf", "gust"].includes(X.spec?.field)) && vol.raw.surface.HPBL) {
      const V0 = X.nearest(), h = V0.raw.surface.HPBL[c];
      if (Number.isFinite(h)) {
        const md = mixDown(V0, c) * 1.943844, a = V0.raw.agl?.[10], s10 = a?.UGRD ? Math.hypot(a.UGRD[c], a.VGRD[c]) * 1.943844 : NaN, sa = seaMinusAir(V0, c);
        out.push(`Mixing: mixed layer ${n0(h)} m (${n0(ft100(h))} ft)`
          + (Number.isFinite(md) ? ` · up to ${Math.round(md)} kt in it${Number.isFinite(s10) ? ` (${Math.round(s10)} kt at 10 m)` : ""}` : "")
          + (Number.isFinite(sa) ? ` · sea ${Math.abs(sa).toFixed(1)} °C ${sa >= 0 ? "warmer" : "colder"} than the air: ${sa > 1 ? "unstable, the wind aloft mixes down (gusty)" : sa < -1 ? "stable, the surface wind is cut off from the wind aloft (smoother, often lighter)" : "near neutral"}` : ""));
      }
    }
    return out;
  }

  cell(vol, lat, lon) {
    const q = vol.merc.ij(lat, lon), i = Math.round(q.i - vol.raw.crop.i0), j = Math.round(q.j - vol.raw.crop.j0);
    return i < 0 || j < 0 || i >= vol.w || j >= vol.h ? -1 : j * vol.w + i;
  }

  height(vol, zMsl, agl) {
    const mb = vol.mbAt(zMsl), m = (x) => `${n0(x)} m · ${n0(x * M_FT)} ft`;
    return `${Number.isFinite(mb) ? `≈ ${Math.round(mb / 5) * 5} mb · ` : ""}${m(zMsl)}` + (agl > 1 && zMsl - agl > 5 ? ` (${n0(agl)} m above ground)` : "");
  }

  fmt(f, x) {
    if (!Number.isFinite(x)) return "no data here";
    if (f.ramp === "ri") { const k = riClass(x); return `${k < 0 ? "neither" : RI_CLASSES[k].label} (Ri ${x.toFixed(2)})`; }
    const d = Math.abs(x) < 10 ? 1 : 0;
    return `${x.toFixed(d)} ${f.units}`;
  }
}
