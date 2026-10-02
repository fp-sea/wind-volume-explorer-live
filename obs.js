// Observed wind at buoys and coastal stations: the latest report from the NWS API
// (api.weather.gov, which allows browser requests; NDBC's own files don't), or for stations
// with obsSource "eccc" from Environment and Climate Change Canada's real-time SWOB feed
// (api.weather.gc.ca: 10-minute mean wind and gust, km/h, every few minutes), refreshed every
// 10 minutes. Drawn as an orange barb on the water at the station and a label under its
// marker. When the forecast time on screen is within 45 minutes of the report, the label
// adds the model's 10 m wind there, so the two can be compared at a glance.
//
// Heights differ: buoy anemometers sit about 4 m up, C-MAN stations often 10-20 m or more,
// the model value is at 10 m. Stations report calm, gust-only or nothing at times: shown as is.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { barb, outlinedLines } from "./layers/windglyphs.js?v=20261002173952";
import { fmtSpeed } from "./units.js?v=20261002173952";
import { edgePoint } from "./shell/geo.js?v=20261002173952";

const KMH_KT = 1 / 1.852, KT_MS = 0.514444;
const REFRESH_MS = 10 * 60e3;
const KINDS = new Set(["buoy", "cman", "coastal", "airport"]);
const KIND_NOTE = { buoy: "Buoy (anemometer ~4 m)", cman: "Coastal station (C-MAN)", coastal: "Coastal station (NOS / Environment Canada)", airport: "Airport weather station, on land: its wind is slowed and turned by the land around it, so expect it lower than over open water" };
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, "0");

export class Observations {
  constructor() {
    this.group = new THREE.Group();
    this.data = new Map();          // id → {time (ms), dir, kt, gustKt} or {error}
    this.regionId = null;
    this.timer = null;
  }

  // Start (or restart) fetching for a region's stations; onData() after each refresh.
  start(region, onData) {
    clearInterval(this.timer);
    this.regionId = region.id;
    this.data = new Map();
    // Only while the tab is visible; coming back after 10+ min away fetches straight away.
    const go = () => { this.lastFetch = Date.now(); return this.fetchAll(region).then(() => { if (this.regionId === region.id) onData(); }); };
    go();
    this.timer = setInterval(() => { if (!document.hidden) go(); }, REFRESH_MS);
    this.onVisible ||= () => { if (!document.hidden && this.regionId && Date.now() - (this.lastFetch || 0) > REFRESH_MS) this.restart?.(); };
    this.restart = go;
    if (!this.visHooked) { document.addEventListener("visibilitychange", () => this.onVisible()); this.visHooked = true; }
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async fetchAll(region) {
    const stations = (region.stations || []).filter((s) => KINDS.has(s.kind));
    await Promise.all(stations.map(async (s) => {
      if (s.obsSource === "eccc") { this.data.set(s.id, await fetchEccc(s)); return; }
      try {
        const r = await fetch(`https://api.weather.gov/stations/${encodeURIComponent(s.id)}/observations?limit=6`, { headers: { Accept: "application/geo+json" } });
        if (!r.ok) { this.data.set(s.id, { error: `HTTP ${r.status}` }); return; }
        const feats = (await r.json()).features || [];
        // Newest report with a wind speed (the very latest often has none yet).
        const f = feats.find((q) => q.properties?.windSpeed?.value != null) || feats[0];
        if (!f) { this.data.set(s.id, { error: "no reports" }); return; }
        const p = f.properties, kmh = (x) => (x?.value == null ? NaN : x.value * KMH_KT);
        this.data.set(s.id, { time: Date.parse(p.timestamp), dir: p.windDirection?.value ?? NaN, kt: kmh(p.windSpeed), gustKt: kmh(p.windGust) });
      } catch (e) { this.data.set(s.id, { error: e.message }); }
    }));
  }

  // (NWS API above; Environment Canada below, in fetchEccc.)
  clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.traverse((q) => { q.geometry?.dispose(); q.material?.dispose(); }); }
    this.drawnKey = null;
  }

  // proj: scene projection; modelAt(lat, lon, timeMs) → {dir, kt, gustKt} | null (not loaded, or
  // the forecast on screen isn't within 45 minutes of timeMs).
  draw(region, proj, { on, groundKm, modelAt }) {
    const parts = [];
    const items = [];
    if (on) for (const s of region.stations || []) {
      if (!KINDS.has(s.kind)) continue;
      const d = this.data.get(s.id);
      if (!d || d.error || !(Number.isFinite(d.kt) || Number.isFinite(d.gustKt))) continue;   // no wind reported: just the station marker
      let p = proj.toXY(s.lat, s.lon), off = false;
      if (!proj.contains(p.x, p.y)) { p = edgePoint(p.x, p.y, proj.box); off = true; }   // off the map: on its edge marker
      const m = off ? null : modelAt(s.lat, s.lon, d.time);
      const text = this.text(d, m);
      items.push({ s, d, p, text, off });
      parts.push(`${s.id}:${text.long}`);
    }
    const key = parts.join("|");
    if (key === this.drawnKey) return false;                 // nothing changed: keep the labels (no flicker)
    this.clear();
    this.drawnKey = key;
    const segs = [];
    for (const { s, d, p, text, off } of items) {
      const z0 = off ? 0.02 : (groundKm?.(p.x, p.y) || 0) + 0.02;
      if (!d.error && Number.isFinite(d.kt) && Number.isFinite(d.dir)) {
        const ms = d.kt * KT_MS, a = (d.dir * Math.PI) / 180;
        barb(segs, p.x, p.y, z0, -ms * Math.sin(a), -ms * Math.cos(a), 5);
      }
      const el = document.createElement("div");
      el.className = `label obs${s.kind === "airport" ? " land" : ""}${off ? " off" : ""}`;
      el.innerHTML = (s.kind === "airport" ? `<span class="k">▲</span>` : "") + text.short;
      // Shown in the hover readout (probe.js) when the pointer is over the label: the label itself
      // lets the mouse through, so drags and scrolls over it still move the map.
      el.dataset.tip = `${s.label}: ${KIND_NOTE[s.kind] || "station"}${off ? " (off the map: shown on its edge marker)" : ""}\n${text.long}\nLatest observation (${d.source || "NWS API"}). Sensor heights vary; the model is at 10 m.`;
      const o = new CSS2DObject(el);
      o.position.set(p.x, p.y, z0);
      this.group.add(o);
    }
    if (segs.length) this.group.add(outlinedLines(segs, 0xffa640, { width: 2, order: 22 }));   // orange over a dark outline: visible on white seas
    return true;
  }

  // {short: the on-map label ("8 G14 · 9 G12": observed, then model), long: the hover text}.
  text(d, m) {
    const ageMin = Math.round((Date.now() - d.time) / 60e3);
    const age = ageMin < 90 ? `${ageMin} min ago` : `${(ageMin / 60).toFixed(1)} h ago`;
    const sp = (kt, g) => (Number.isFinite(kt) ? fmtSpeed(kt, { unit: false }) : "–") + (Number.isFinite(g) ? ` G${fmtSpeed(g, { unit: false })}` : "");
    const w = Number.isFinite(d.kt) ? `${Number.isFinite(d.dir) ? `${pad3(d.dir)}° ` : ""}${fmtSpeed(d.kt)}` : "no wind speed";
    const g = Number.isFinite(d.gustKt) ? ` gust ${fmtSpeed(d.gustKt)}` : "";
    const stale = ageMin > 180 ? " old" : "";
    return {
      short: `<span class="o${stale}">${sp(d.kt, d.gustKt)}</span>${m ? ` · <span class="m">${sp(m.kt, m.gustKt)}</span>` : ""}`,
      long: `Observed ${w}${g}, ${age}.` + (m ? `\nModel (10 m, time on screen): ${pad3(m.dir)}° ${fmtSpeed(m.kt)}${Number.isFinite(m.gustKt) ? ` gust ${fmtSpeed(m.gustKt)}` : ""}.` : "\nModel: shown when the time on screen is within 45 min of the report."),
    };
  }
}

// Environment and Climate Change Canada SWOB (real-time surface observations) for one station,
// by its MSC id: the newest record with a wind speed. 10-minute mean and max, km/h (some
// networks name the gust max_wnd_gst_spd_10m_pst10mts).
async function fetchEccc(s) {
  try {
    const url = `https://api.weather.gc.ca/collections/swob-realtime/items?f=json&limit=8&sortby=-date_tm-value&msc_id-value=${encodeURIComponent(s.mscId)}`;
    const r = await fetch(url);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const fs = (await r.json()).features || [];
    const f = fs.find((q) => q.properties?.avg_wnd_spd_10m_pst10mts != null) || fs[0];
    if (!f) return { error: "no reports" };
    const p = f.properties, kmh = (x) => (x == null ? NaN : x * KMH_KT);
    return { time: Date.parse(p["date_tm-value"]), dir: p.avg_wnd_dir_10m_pst10mts ?? NaN, kt: kmh(p.avg_wnd_spd_10m_pst10mts), gustKt: kmh(p.max_wnd_spd_10m_pst10mts ?? p.max_wnd_gst_spd_10m_pst10mts), source: "Environment Canada" };
  } catch (e) { return { error: e.message }; }
}
