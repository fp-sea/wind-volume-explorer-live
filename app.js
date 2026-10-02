// Wind Volume Explorer: the page. Wires the shell modules (stage, views, links, tour,
// export) to the region registry, and draws the geography every later layer sits on:
// land outline, domain frame, subarea outlines and axes, and stations.
//
// Nothing here is synthetic. When there's no model data (there isn't yet), the page
// says so rather than inventing any.

import { mountMeter } from "./netmeter.js?v=20261002173952";      // first: it counts every download from here on
import { storeInfo, clearStore, setStoreOn } from "./model/store.js?v=20261002173952";   // second: model data kept on this device (over the meter's fetch)
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Stage } from "./shell/stage.js?v=20261002173952";
import { Projection, ChannelFrame, bearingDeg, edgePoint } from "./shell/geo.js?v=20261002173952";
import { regionViews, homeView, compass } from "./shell/views.js?v=20261002173952";
import * as links from "./shell/links.js?v=20261002173952";
import { Tour, HOLD_MS } from "./shell/tour.js?v=20261002173952";
import { composite, record, saveBlob, outputSize } from "./shell/export.js?v=20261002173952";
import { ease } from "./shell/stage.js?v=20261002173952";
import { ExplorePanel } from "./explore.js?v=20261002173952";
import { Observations } from "./obs.js?v=20261002173952";
import { outlinedLines } from "./layers/windglyphs.js?v=20261002173952";
import { speedUnits, setSpeedUnits } from "./units.js?v=20261002173952";
import { GroundPanel } from "./groundpanel.js?v=20261002173952";
import { initTabs } from "./tabs.js?v=20261002173952";
import { mountMixer } from "./mixer.js?v=20261002173952";
import { Places } from "./places.js?v=20261002173952";
mountMeter(document.getElementById("topbar"));
initTabs();

const $ = (id) => document.getElementById(id);
const status = (text, err = false) => { $("status").textContent = text; $("status").classList.toggle("err", err); };

const stage = new Stage($("scene"), { panels: ["panel"] });
// 2D / 3D: the map straight down like a chart (simple mouse: drag pans, wheel zooms), or the 3D view.
{
  const b = document.createElement("button");
  b.className = "btn mini view2d"; b.id = "view2d";
  b.title = "2D: look straight down at the map, north up, like a chart; drag to pan, wheel or pinch to zoom (no tilting or rotating). Click again for 3D, back where you were. (Key: 2)";
  const sync = (on) => { b.textContent = on ? "3D" : "2D"; b.classList.toggle("on", on); document.body.classList.toggle("map2d", on); try { localStorage.setItem("wve.2d", on ? "1" : ""); } catch { /* no storage */ } };
  b.addEventListener("click", () => stage.set2D(!stage.is2D));
  stage.on2D = sync; sync(false);
  document.getElementById("topbar").append(b);
  addEventListener("keydown", (e) => { if (e.key === "2" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "") && !e.metaKey && !e.ctrlKey) stage.set2D(!stage.is2D); });
  let was = false; try { was = localStorage.getItem("wve.2d") === "1"; } catch { /* no storage */ }
  if (was) setTimeout(() => stage.set2D(true), 1500);         // (after the region's first view has flown in)
}

const state = { regions: [], models: [], region: null, proj: null, views: [], viewId: null, coast: null, linkedCase: null };

const groups = {
  base: new THREE.Group(),       // sea, land, domain frame: flat
  subareas: new THREE.Group(),   // outlines, axes and close-up volumes: have height
  stations: new THREE.Group(),   // poles and edge markers: have height
};
stage.scene.add(...Object.values(groups));

const model = new ExplorePanel({ stage, status, groundKm: (x, y) => ground.groundKm(x, y), isWater: (x, y) => ground.ground.isWater(x, y),
  groundMeshes: () => [ground.ground.land, ground.ground.water].filter(Boolean),
  currentView: () => state.views.find((v) => v.id === state.viewId), goView: (id) => goView(id) });
mountMixer($("mixer"));
// Data tab → Kept on this device (model/store.js): the switch, what's there, Clear.
{
  const info = async () => { const q = await storeInfo(); $("store-info").textContent = q.on ? `${Number.isFinite(q.bytes) ? `${(q.bytes / 1e6).toFixed(0)} MB stored by this site` : "stored"}${q.hits ? ` · ${q.hits} files (${(q.readBytes / 1e6).toFixed(1)} MB) read from it since the page opened` : ""}` : "off: every file is downloaded"; };
  try { $("store-on").checked = localStorage.getItem("wve.store") !== "off"; } catch { /* no storage */ }
  $("store-on").addEventListener("change", (e) => { setStoreOn(e.target.checked); setTimeout(info, 300); });
  $("store-clear").addEventListener("click", async () => { await clearStore(); info(); });
  document.querySelector('[role=tab][data-tab="data"]')?.addEventListener("click", info);
  setTimeout(info, 3000);
}                                            // (Sea & weather → Surface layers: mirrors of the wind, sea and current controls)
const obs = new Observations();
stage.scene.add(obs.group);
function drawObs() {
  if (!state.region) return;
  if (obs.draw(state.region, state.proj, { on: $("show-obs").checked && $("show-stations").checked, groundKm: (x, y) => ground.groundKm(x, y),
    modelAt: (la, lo, t) => model.modelAtObs(la, lo, t) })) stage.markDirty();
}
model.afterRedraw = drawObs;
const ground = new GroundPanel({ stage, onChange: () => { drawStations(); drawSubareas(); drawPlaces(); model.groundVer = (model.groundVer ?? 0) + 1; model.redraw(); } });
const places = new Places(stage, { groundKm: (x, y) => ground.groundKm(x, y), report: (la, lo) => model.placeReport(la, lo) });
model.isPlaceAt = (e) => !!places.hitAt(e);
model.terrain = { heightM: (x, y) => ground.ground.heightKm(x, y) * 1000, isLand: (x, y) => ground.ground.isLand(x, y),
  land: () => (ground.ground.mask ? { ...ground.ground.meta.terrain, mask: ground.ground.mask } : null),   // (the meta names its mask file "mask": the array wins)   // the 0.5 km land mask (routing, currents)
    // true heights, for the inspector's surroundings
  photo: () => ground.ground.photoTexture(), photoExtent: () => ground.ground.meta?.photo?.extent };                         // and the satellite mosaic on its land
const tour = new Tour(stage, () => `wind-volume-explorer:tour:${state.region?.id}`);
// A press on the map or the surface viewer clears any stray text selection (a drag that wandered
// off the canvas can otherwise leave the whole page selected).
document.addEventListener("pointerdown", (e) => { if (e.target instanceof HTMLCanvasElement) window.getSelection()?.removeAllRanges(); }, true);
if (new URLSearchParams(location.search).has("debug")) window.wve = { stage, state, links, model, ground, obs, get places() { return places; } };   // dev: poke at it from the console

// ---------- drawing helpers ----------
const COLORS = { sea: 0x0b3f4a, land: 0x33463f, coast: 0x9fb8a8, frame: 0x4c8a95, sub: 0x7fd6e0, subHi: 0xffffff,
                 axis: 0xffcc4d, volume: 0x0e7c8b, stn: 0xeaf3f4, edge: 0xc15a2b };

function clear(g) { while (g.children.length) { const c = g.children[0]; g.remove(c); c.traverse((q) => { q.geometry?.dispose?.(); q.material?.dispose?.(); }); } }

function line(points, color, { z = 0, dashed = false, opacity = 1 } = {}) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z ?? z)));
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.5, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const l = new THREE.Line(geo, mat);
  if (dashed) l.computeLineDistances();
  return l;
}

function label(text, cls, pos, title) {
  const el = document.createElement("div");
  el.className = `label ${cls}`;
  el.textContent = text;
  if (title) el.title = title;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  return o;
}

// ---------- base: sea, land, frame ----------
function drawBase() {
  clear(groups.base);
  const { proj, coast } = state, b = proj.box;
  const flat = !ground.ready;              // no built ground layers: a flat sea and land outline instead
  if (flat) {
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0), new THREE.MeshBasicMaterial({ color: COLORS.sea }));
    sea.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0);
    groups.base.add(sea);
  }

  const landMat = new THREE.MeshBasicMaterial({ color: COLORS.land, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const shapes = [];
  for (const rings of coast.polygons) {
    const pts = (ring) => ring.map(([lon, lat]) => { const p = proj.toXY(lat, lon); return new THREE.Vector2(p.x, p.y); });
    const shape = new THREE.Shape(pts(rings[0]));
    for (const h of rings.slice(1)) shape.holes.push(new THREE.Path(pts(h)));
    shapes.push(shape);
    // Coast outline drawn over everything (model slices would otherwise hide it from above).
    if (!flat) continue;                  // with terrain, the coastline is the land mesh's own edge
    const coastLine = line(rings[0].map(([lon, lat]) => proj.toXY(lat, lon)), COLORS.coast, { z: 0.02, opacity: 0.8 });
    coastLine.material.depthTest = false;
    coastLine.renderOrder = 20;
    groups.base.add(coastLine);
  }
  if (flat) {
    const land = new THREE.Mesh(new THREE.ShapeGeometry(shapes), landMat);
    land.position.z = 0.01;
    groups.base.add(land);
  }

  const frame = [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }];
  groups.base.add(line(frame, COLORS.frame, { z: 0.03 }));
}

// ---------- subareas: boxes, axes, close-up volumes ----------
const VOLUME_TOP_KM = 3;     // the height the prototype's curtains reach

function currentSubId() {
  const v = state.views.find((q) => q.id === state.viewId);
  return v && !v.id.startsWith("region-") ? state.region.subareas.find((s) => v.id.startsWith(`${s.id}-`))?.id : null;
}

function drawSubareas() {
  clear(groups.subareas);
  if (!$("show-subareas").checked) return;
  const { proj, region } = state, vex = stage.vex, active = currentSubId();
  for (const s of region.subareas) {
    const hi = s.id === active, col = hi ? COLORS.subHi : COLORS.sub;
    let labelAt;
    if (s.box) {
      const c = [[s.box.latMin, s.box.lonMin], [s.box.latMin, s.box.lonMax], [s.box.latMax, s.box.lonMax], [s.box.latMax, s.box.lonMin], [s.box.latMin, s.box.lonMin]]
        .map(([la, lo]) => proj.toXY(la, lo));
      groups.subareas.add(line(c, col, { z: 0.05, dashed: true, opacity: hi ? 1 : 0.7 }));
      const ne = proj.toXY(s.box.latMax, s.box.lonMax), sw = proj.toXY(s.box.latMin, s.box.lonMin);
      labelAt = new THREE.Vector3((sw.x + ne.x) / 2, ne.y, 0.1);
    }
    if (s.axis) {
      const fr = new ChannelFrame(s), vb = s.viewBox;
      const at = (a, c, z = 0) => { const q = fr.toLatLon(a, c), p = proj.toXY(q.lat, q.lon); return { x: p.x, y: p.y, z }; };
      const [a0, a1] = vb.alongKm, [c0, c1] = vb.acrossKm;
      // The axis, with an arrowhead at the downstream end.
      groups.subareas.add(line([at(a0, 0, 0.08), at(a1, 0, 0.08)], COLORS.axis));
      const tip = at(a1, 0, 0.08), l = at(a1 - 5, -2, 0.08), r = at(a1 - 5, 2, 0.08);
      groups.subareas.add(line([l, tip, r], COLORS.axis));
      // The close-up volume: the viewBox footprint up to the curtain height.
      const zt = VOLUME_TOP_KM * vex, corners = [[a0, c0], [a1, c0], [a1, c1], [a0, c1], [a0, c0]];
      groups.subareas.add(line(corners.map(([a, c]) => at(a, c, 0.06)), col, { opacity: hi ? 0.9 : 0.5 }));
      if (hi) {
        groups.subareas.add(line(corners.map(([a, c]) => at(a, c, zt)), col, { opacity: 0.35 }));
        for (const [a, c] of corners.slice(0, 4)) groups.subareas.add(line([at(a, c, 0), at(a, c, zt)], col, { opacity: 0.35 }));
      }
      if (s.axis.method === "throat") {
        const [tr, tl] = [s.axis.throat.right, s.axis.throat.left].map(([la, lo]) => { const p = proj.toXY(la, lo); return { x: p.x, y: p.y, z: 0.09 }; });
        groups.subareas.add(line([tr, tl], COLORS.axis, { dashed: true }));
      }
      if (!labelAt) { const p = at(0, c1); labelAt = new THREE.Vector3(p.x, p.y, 0.1); }
    }
    if (labelAt) groups.subareas.add(label(s.label, "sub", labelAt, `${s.zones.join(", ")}. ${s.mechanism || ""}`));
  }
}

// ---------- stations ----------
function drawStations() {
  clear(groups.stations);
  if (!$("show-stations").checked) return;
  const { proj, region } = state, vex = stage.vex, h = 1.2 * vex;
  const cx = (proj.box.x0 + proj.box.x1) / 2, cy = (proj.box.y0 + proj.box.y1) / 2;
  for (const st of region.stations) {
    const p = proj.toXY(st.lat, st.lon);
    const tip = [st.label, st.source, st.caveat].filter(Boolean).join("\n");
    if (proj.contains(p.x, p.y)) {
      const z0 = ground.groundKm(p.x, p.y);
      groups.stations.add(outlinedLines([p.x, p.y, z0, p.x, p.y, z0 + h], COLORS.stn, { width: 1.8, opacity: 0.95, order: 20 }));   // light pole, dark outline
      groups.stations.add(label(st.id, "stn", new THREE.Vector3(p.x, p.y, z0 + h), tip));
    } else {
      // Off-scene: a marker on the edge toward the station, with how far beyond it lies.
      const e = edgePoint(p.x, p.y, proj.box);
      const beyond = Math.hypot(p.x - e.x, p.y - e.y), brg = bearingDeg(p.x - cx, p.y - cy);
      groups.stations.add(outlinedLines([e.x, e.y, 0, e.x, e.y, h], COLORS.edge, { width: 1.8, order: 20 }));
      groups.stations.add(label(`${st.id} +${Math.round(beyond)} km ${compass(brg)}`, "edge", new THREE.Vector3(e.x, e.y, h),
                                `${tip}\n${Math.round(beyond)} km beyond the scene edge, bearing ${compass(brg)}`));
    }
  }
}

function drawRoute() { places.drawRoute(state.proj, stage.vex, $("show-route").checked); }
function drawPlaces() { drawRoute(); places.draw(state.proj, stage.vex, $("show-places").checked, $("show-subareas").checked ? state.region.subareas.map((s) => s.label) : []); }
function redrawHeights() { drawSubareas(); drawStations(); drawPlaces(); stage.markDirty(); }

// ---------- views ----------
function fillViewSelect() {
  const sel = $("view-select"), byGroup = new Map();
  for (const v of state.views) (byGroup.get(v.group) || byGroup.set(v.group, []).get(v.group)).push(v);
  // No numbers in the list (only the first nine have a key, so numbering was partial); keys 1-9
  // still jump to the first nine views, as the tooltip says.
  sel.innerHTML = [...byGroup].map(([g, vs]) => `<optgroup label="${g}">${vs.map((v) => `<option value="${v.id}">${v.label}</option>`).join("")}</optgroup>`).join("");
}

function goView(id, { instant = false } = {}) {
  const v = state.views.find((q) => q.id === id) || state.views.find((q) => q.id === homeView(state.region)) || state.views[0];
  state.viewId = v.id;
  $("view-select").value = v.id;
  const sub = state.region.subareas.find((s) => s.id === currentSubId());
  $("sub-note").innerHTML = sub
    ? `<b>${sub.label}</b> · ${sub.zones.join(", ")}${sub.axis ? ` · axis ${String(sub.axis.axisDeg).padStart(3, "0")}°/${String((sub.axis.axisDeg + 180) % 360).padStart(3, "0")}° (${sub.axis.method})` : ""}<br>${sub.mechanism || ""}`
    : `<b>${state.region.label}</b> · one model domain · ${state.region.models.join(", ").toUpperCase()}`;
  $("where").textContent = `${state.region.label} · ${v.label}`;
  drawSubareas();
  model.onView(v);                                        // the cross-section follows the view's section
  return stage.flyTo(stage.framingFor(v, state.proj.box), { instant });
}

// ---------- regions ----------
async function setRegion(id, { instant = true, view = null } = {}) {
  const region = state.regions.find((r) => r.id === id && r.enabled) || state.regions.find((r) => r.enabled);
  const r = await fetch(`data/${region.id}/coast.json`);
  if (!r.ok) throw new Error(`coastline for ${region.id}: ${r.status}`);
  state.coast = await r.json();
  state.region = region;
  state.proj = new Projection(region);
  state.views = regionViews(region, state.proj);
  $("region-select").value = region.id;
  fillViewSelect();
  await ground.setRegion(region, state.proj);
  model.clip.setGround(ground.ground); model.clip.on = $("water-only").checked;
  model.setFetch(region.id, ground.ground.meta?.fetch);           // coastline for "over water only"
  $("water-only").disabled = !model.clip.ready;
  drawBase();
  drawStations();
  places.clear();
  places.load(region.id).then((d) => {
    if (state.region !== region) return;
    $("places-grp").hidden = !d;
    const rt = d?.routes?.[0];
    $("route-row").hidden = !rt;
    if (rt) { $("route-label").textContent = rt.label; $("route-row").title = `${rt.note} ${rt.legs.length} legs, ${rt.nm} nm.`; }
    if (d) {
      const keys = d.places.filter((p) => p.key).map((p) => `${p.label}: ${p.key}`);
      $("places-note").textContent = `${d.places.length} places from your notes${keys.length ? `; key stops: ${keys.join("; ")}` : ""}. Hover or tap a label for its notes and the model there. Where labels overlap, harbours and lights win; zoom in to see the rest.`;
    }
    drawPlaces();
  });
  obs.clear(); obs.start(region, drawObs);
  tour.load();
  model.setRegion(region, state.proj, state.models, state.coast);
  await goView(view || homeView(region), { instant });
  status(state.linkedCase ? `Case "${state.linkedCase}": historical cases arrive with build step 9. Showing the live shell.` : "");
}

// ---------- links ----------
links.register("case", { order: 5, write: () => state.linkedCase, read: (v) => { state.linkedCase = v; } });
links.register("region", { order: 10, write: () => state.region?.id, read: (v) => setRegion(v, { instant: true }) });
links.register("view", { order: 20, write: () => state.viewId, read: (v) => goView(v, { instant: true }) });
links.register("vex", { order: 30, write: () => stage.vex,
  read: (v) => { if (isFinite(+v) && +v >= 1 && +v <= 20) { stage.vex = +v; $("vex").value = v; syncVex(); } } });
links.register("stn", { order: 40, write: () => ($("show-stations").checked ? null : "0"), read: (v) => { $("show-stations").checked = v !== "0"; drawStations(); } });
links.register("sub", { order: 40, write: () => ($("show-subareas").checked ? null : "0"), read: (v) => { $("show-subareas").checked = v !== "0"; drawSubareas(); } });
links.register("gr", { order: 50, write: () => ground.toParams().land, read: (v) => ground.fromParams({ land: v }) });
links.register("water", { order: 50, write: () => (ground.toParams().water === "sea" ? null : ground.toParams().water), read: (v) => ground.fromParams({ water: v }) });
links.register("chart", { order: 51, write: () => ground.toParams().chart, read: (v) => ground.fromParams({ chart: v }) });
links.register("du", { order: 49, write: () => ground.toParams().du, read: (v) => ground.fromParams({ du: v }) });
links.register("m", { order: 60, write: () => model.toParam(), read: (v) => model.fromParam(v) });
links.register("pt", { order: 61, write: () => model.ptParam(), read: (v) => model.fromPtParam(v) });
links.register("turb", { order: 62, write: () => ($("show-turb").checked ? [1, $("turb-pockets").checked ? 1 : 0, $("turb-pbl").checked ? 1 : 0, $("turb-style").value].join(",") : null),
  read: (v) => { const [on, pk, pb, sty] = v.split(","); $("show-turb").checked = on === "1"; $("turb-pockets").checked = pk !== "0"; $("turb-pbl").checked = pb !== "0"; if (sty === "fog" || sty === "dots") $("turb-style").value = sty; model.drawTurbulence(); } });
links.register("slab", { order: 63, write: () => ($("show-curtain").checked ? [$("slab-mode").value, $("slab-pos").value, $("slab-turn").value].join(",") : null),
  read: (v) => { const [m, p, t] = v.split(","); model.fillSlabModes(); if ([...$("slab-mode").options].some((o) => o.value === m)) $("slab-mode").value = m;
                 $("slab-pos").value = p; $("slab-turn").value = t; model.redraw(); } });
// Over water only: on by default (owner, 2026-09-27), so the link says only when it's off. Old links' "wo=1" still means on.
links.register("wo", { order: 62, write: () => ($("water-only").checked ? null : "0"), read: (v) => { const on = v !== "0"; $("water-only").checked = on; model.clip.on = on; model.updateParticles(); model.redraw(); stage.markDirty(); } });
links.register("sm", { order: 62, write: () => ($("smooth").checked ? "1" : null), read: (v) => { $("smooth").checked = v === "1"; model.redraw(); } });
links.register("inv", { order: 62, write: () => ($("show-inversion").checked ? "1" : null), read: (v) => { $("show-inversion").checked = v === "1"; model.redraw(); } });
links.register("u", { order: 45, write: () => (speedUnits() === "kt" ? null : speedUnits()), read: (v) => { setSpeedUnits(v); $("units-select").value = speedUnits(); } });
links.register("obs", { order: 41, write: () => ($("show-obs").checked ? null : "0"), read: (v) => { $("show-obs").checked = v !== "0"; drawObs(); } });
// Barbs / streamlines: "barbs,stream,density,size,opacity,colour"
links.register("wg", { order: 64, write: () => ($("wind-barbs").checked || $("wind-stream").checked
    ? [$("wind-barbs").checked ? 1 : 0, $("wind-stream").checked ? 1 : 0, $("glyph-density").value, $("glyph-size").value, $("glyph-opacity").value, $("glyph-colour").value].join(",") : null),
  read: (v) => {
    const [b, s, d, z, o, c] = v.split(",");
    if ([...$("glyph-colour").options].some((q) => q.value === c)) $("glyph-colour").value = c;
    $("wind-barbs").checked = b === "1"; $("wind-stream").checked = s === "1";
    if (isFinite(+d) && d) $("glyph-density").value = d;
    if (isFinite(+z) && z) $("glyph-size").value = z;
    if (isFinite(+o) && o) $("glyph-opacity").value = o;
    model.redraw();
  } });
links.register("ca", { order: 66, write: () => model.channel.toParam(), read: (v) => { model.channel.fromParam(v); model.checkNeeds(); model.channel.update(true); } });
links.register("cl", { order: 62, write: () => ($("show-clouds").checked ? "1" : null), read: (v) => { $("show-clouds").checked = v === "1"; model.redraw(); } });
links.register("fog", { order: 62, write: () => ($("show-fog").checked ? "1" : null), read: (v) => { $("show-fog").checked = v === "1"; model.redraw(); } });
links.register("sat", { order: 62, write: () => ($("show-sat").checked ? $("sat-product").value : null), read: (v) => { $("show-sat").checked = !!v; if (["geocolor", "ir", "vis"].includes(v)) $("sat-product").value = v; model.drawSatellite(); } });
links.register("sea", { order: 62, write: () => ($("show-sea").checked ? ($("sea-duration").value === "43200" ? "1" : `1,${$("sea-duration").value}`) : null),
  read: (v) => { const [on, d] = v.split(","); $("show-sea").checked = on === "1"; if (d && [...$("sea-duration").options].some((o) => o.value === d)) $("sea-duration").value = d; $("sea-duration").dispatchEvent(new Event("change")); model.redraw(); } });
links.register("cam", { order: 90, write: () => links.camToParam(stage.camera.position, stage.controls.target),
  read: (v) => { const c = links.paramToCam(v); if (c) return stage.flyTo(c, { instant: true }); } });

// ---------- controls ----------
function syncVex() { $("vex-val").textContent = `${stage.vex}×`; ground.onVex(); redrawHeights(); model.redraw(); }
$("vex").addEventListener("input", (e) => {
  const k = +e.target.value / stage.vex;                     // keep the camera on the same heights
  stage.camera.position.z *= k; stage.controls.target.z *= k;
  stage.vex = +e.target.value; syncVex();
});
$("region-select").addEventListener("change", (e) => setRegion(e.target.value, { instant: true }).then(autoLoad).catch(fail));
$("view-select").addEventListener("change", (e) => goView(e.target.value));
$("view-home").addEventListener("click", () => goView(homeView(state.region)));
$("view-top").addEventListener("click", () => goView(currentSubId() ? `${currentSubId()}-top` : "region-top"));
$("view-3d").addEventListener("click", () => goView(currentSubId() ? `${currentSubId()}-3d` : "region-3d"));
$("show-subareas").addEventListener("change", () => { drawSubareas(); stage.markDirty(); });
$("show-stations").addEventListener("change", () => { drawStations(); drawObs(); stage.markDirty(); });
$("show-places").addEventListener("change", drawPlaces);
$("show-route").addEventListener("change", drawRoute);
$("show-subareas").addEventListener("change", drawPlaces);
$("show-obs").addEventListener("change", drawObs);
$("units-select").value = speedUnits();
$("units-select").addEventListener("change", (e) => { setSpeedUnits(e.target.value); obs.drawnKey = null; drawObs(); model.redraw(); model.updateParticles(); });
// On open (and on a region change) the newest complete run loads by itself, as "Surface wind &
// gusts" in the current view; a link with a model state (m=) loads that instead.
function autoLoad() {
  if (!model.model || model.vol) return;
  model.applyPreset("surface", { keepView: true });
  model.loadLatest();
}
$("ui-hide").addEventListener("click", () => togglePanel(false));
// Theme: Auto → Light → Dark, kept in localStorage "prefs" (the sibling pages' convention).
function readPrefs() { try { return JSON.parse(localStorage.getItem("prefs") || "{}") || {}; } catch { return {}; } }
function showTheme() { const t = readPrefs().theme; $("theme-btn").textContent = t === "dark" ? "Dark" : t === "light" ? "Light" : "Auto"; }
$("theme-btn").addEventListener("click", () => {
  const p = readPrefs(), next = { undefined: "light", light: "dark", dark: undefined }[p.theme] ;
  if (next) p.theme = next; else delete p.theme;
  try { localStorage.setItem("prefs", JSON.stringify(p)); } catch { /* storage blocked: this visit only */ }
  if (next) document.documentElement.setAttribute("data-theme", next); else document.documentElement.removeAttribute("data-theme");
  $("theme-btn").textContent = next === "dark" ? "Dark" : next === "light" ? "Light" : "Auto";
});
showTheme();
$("ui-show").addEventListener("click", () => togglePanel(true));
// Hide / show the controls. Desktop: the panel goes away. Phone: the sheet folds to its time bar.
const phone = () => window.matchMedia("(max-width: 700px)").matches;
function togglePanel(show) {
  document.body.classList.toggle("ui-hidden", !show);
  $("panel").hidden = !show && !phone();
  $("ui-show").hidden = show;
  stage.updateViewOffset();
}
$("ui-fold").addEventListener("click", () => togglePanel(false));
window.addEventListener("resize", () => model.drawSky());
window.matchMedia("(max-width: 700px)").addEventListener("change", () => togglePanel(!document.body.classList.contains("ui-hidden")));

window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === "h" || e.key === "H") togglePanel(document.body.classList.contains("ui-hidden"));
  // Time bar: space plays / pauses, ← → step 15 min (shift: an hour).
  if (!$("timebar").hidden && (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    if (e.key === " ") { $("play").click(); return; }
    const f = $("fhr"), step = (e.shiftKey ? 1 : 0.25) * (e.key === "ArrowLeft" ? -1 : 1);
    f.value = String(Math.max(+f.min, Math.min(+f.max, Math.round((+f.value + step) * 4) / 4)));
    f.dispatchEvent(new Event("input"));
    return;
  }
  const n = +e.key;
  if (n >= 1 && n <= 9 && state.views[n - 1]) goView(state.views[n - 1].id);
});

tour.onChange = () => {
  const n = tour.stops.length;
  $("tour-count").textContent = n ? `${n} stop${n > 1 ? "s" : ""}. Kept in this browser, per region.` : "No stops yet. Kept in this browser, per region.";
  $("tour-play").disabled = n < 2;
  $("tour-play").textContent = tour.playing ? "■ Stop" : "▶ Play";
  $("tour-clear").disabled = !n;
};
$("tour-add").addEventListener("click", () => tour.add());
$("tour-play").addEventListener("click", () => tour.play());
$("tour-clear").addEventListener("click", () => tour.clear());

$("copy-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?${links.toQuery()}`;
  history.replaceState(null, "", url);
  try { await navigator.clipboard.writeText(url); status("Link copied."); } catch { status("Link is in the address bar."); }
});

// ---------- export ----------
const CREDITS = "Coastline: Natural Earth. Stations: NDBC, NWS, IEM; Environment and Climate Change Canada (Open Government Licence – Canada). Wind Volume Explorer. Not for navigation.";
const exportParts = () => ({ gl: stage.renderer.domElement, labelsRoot: stage.labels.domElement,
  title: `Wind Volume Explorer · ${state.region.label}`, time: model.validLabel() || "no model loaded",
  legend: model.legend, legends: [ground.legend()].filter(Boolean),
  credits: [model.sat?.group.visible && $("show-sat").checked ? "Satellite: NOAA GOES-West via NASA GIBS" : null, $("show-sea").checked ? "Swell: NOAA GFS-Wave (WAVEWATCH III)" : null, model.vol ? `Model: NOAA/NCEP ${model.modelName()}${model.model?.source === "hrrrzarr" ? " via the University of Utah HRRR Zarr archive" : " via NOAA Open Data Dissemination (AWS)"}` : null, ground.credits(), CREDITS].filter(Boolean).join(". ") });

$("save-png").addEventListener("click", () => {
  stage.renderNow();
  const { W, H } = outputSize(2 * window.innerWidth);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  composite(c.getContext("2d"), exportParts(), W, H);
  c.toBlob((b) => saveBlob(b, `wind-volume-${state.region.id}-${state.viewId}.png`), "image/png");
});

$("export-go").addEventListener("click", async () => {
  const what = $("export-what").value, format = $("export-format").value, note = $("export-note");
  if (what === "tour" && tour.stops.length < 2) { note.textContent = "Add at least two tour stops first."; return; }
  const cam = stage.camera, ctl = stage.controls;
  const saved = { pos: cam.position.clone(), target: ctl.target.clone() };
  ctl.enabled = false;
  cam.clearViewOffset(); cam.updateProjectionMatrix();         // the file has no panels: centre on the whole picture
  const off = saved.pos.clone().sub(saved.target), R = Math.hypot(off.x, off.y);
  const a0 = Math.atan2(off.y, off.x);
  const legs = what === "tour" ? tour.stops.map((s) => tour.stop(s)) : [];
  const perLeg = 50;
  const steps = what === "orbit" ? (format === "gif" ? 60 : 120) : legs.length * (perLeg + 1);
  const V = (p) => new THREE.Vector3(p.x, p.y, p.z);
  try {
    const blob = await record({
      format, width: 1280, steps,
      holdMs: (i) => (what === "tour" && i % (perLeg + 1) === perLeg ? HOLD_MS : 1000 / 20),
      drawStep: async (i, ctx, W, H) => {
        if (what === "orbit") {
          const a = a0 + (2 * Math.PI * i) / steps;
          cam.position.set(saved.target.x + R * Math.cos(a), saved.target.y + R * Math.sin(a), saved.pos.z);
          ctl.target.copy(saved.target);
        } else {
          const leg = Math.floor(i / (perLeg + 1)), k = Math.min(1, (i % (perLeg + 1)) / perLeg);
          const to = legs[leg], from = leg ? legs[leg - 1] : { pos: saved.pos, target: saved.target };
          cam.position.lerpVectors(V(from.pos), V(to.pos), ease(k));
          ctl.target.lerpVectors(V(from.target), V(to.target), ease(k));
        }
        cam.lookAt(ctl.target);
        if (model.particles.group.visible) model.particles.step(1 / 20);   // particles keep moving in the file
        stage.renderNow();
        composite(ctx, exportParts(), W, H);
      },
      onProgress: (i, n) => { note.textContent = `Recording ${i} / ${n}…`; },
    });
    saveBlob(blob, `wind-volume-${state.region.id}-${what}.${blob.type.includes("gif") ? "gif" : blob.type.includes("webm") ? "webm" : "mp4"}`);
    note.textContent = `Saved (${(blob.size / 1e6).toFixed(1)} MB).`;
  } catch (e) {
    note.textContent = `Export failed: ${e.message}`;
  } finally {
    cam.position.copy(saved.pos); ctl.target.copy(saved.target);
    ctl.enabled = true; stage.updateViewOffset();
  }
});

// ---------- start ----------
function fail(e) { console.error(e); status(`Couldn't load: ${e.message}`, true); }

(async () => {
  const r = await fetch("data/regions.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`regions.json: ${r.status}. Run: .venv/bin/python -m pipeline.build_web`);
  state.regions = (await r.json()).regions;
  const rm = await fetch("data/models.json", { cache: "no-cache" });
  if (!rm.ok) throw new Error(`models.json: ${rm.status}. Run: .venv/bin/python -m pipeline.build_web`);
  state.models = (await rm.json()).models;
  $("region-select").innerHTML = state.regions
    .map((g) => `<option value="${g.id}"${g.enabled ? "" : " disabled"}>${g.label}${g.enabled ? "" : " (not set up yet)"}</option>`).join("");
  $("vex-val").textContent = `${stage.vex}×`;
  const q = new URLSearchParams(location.search);
  if (!q.has("region")) await setRegion(null);
  await links.apply(q);                 // region → view → vex → camera: a link's camera wins
  if (!q.has("m")) autoLoad();
})().catch(fail);
