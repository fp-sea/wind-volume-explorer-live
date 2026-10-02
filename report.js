// The route report: a floating window (drag by its title bar, resize from the corner, minimise,
// maximise, close; where it was is remembered) with the whole plan in one document: the passage
// in brief, cautions, charts along the passage, the legs, why this route, where the wind came
// from, the sensitivity, the model comparison and the hour-by-hour table; export and print.
//
// Reads the planner's last result (passage.result, .summary, .exportData, .compare, .sensRows);
// re-renders when the route changes while it's open.

import { stationSpeed } from "./model/currents.js?v=20261002173952";
import { wxLine, rainWord, cloudWord, fF, visText } from "./route/weather.js?v=20261002173952";

const $ = (id) => document.getElementById(id);
const NM = 1.852, KT = 1.943844;
const hm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KEY = "wve.report.geom";

// Series colours (fixed order, never cycled): primary, secondary; fair/foul for the current.
// Theme tokens (style.css), checked for colour-blind separation and contrast in light and dark.
const C1 = "var(--rr-c1)", C2 = "var(--rr-c2)", FAIR = "var(--rr-fair)", FOUL = "var(--rr-foul)", FOG = "var(--rr-fog)", CLOUD = "var(--rr-cloud)";

export class RouteReport {
  constructor(passage) {
    this.ps = passage;
    const el = (this.el = document.createElement("div"));
    el.id = "rr"; el.className = "rr"; el.hidden = true;
    el.innerHTML = `<div class="rr-h" title="Drag to move"><b>Route report</b><span class="rr-sub"></span><span class="rr-btns">
        <button class="btn mini" data-a="pdf" title="The full report as a clean document for printing or saving as PDF (Save as PDF in the print dialog)">PDF</button>
        <button class="btn mini" data-a="doc" title="Open the full report as a page in a new tab (to read, print or save)">Open ↗</button>
        <button class="btn mini" data-a="min" title="Minimise (keep it to its title bar)">▁</button>
        <button class="btn mini" data-a="max" title="Fill the window / back">⤢</button>
        <button class="btn mini" data-a="close" title="Close (open it again from the Passage tab)">✕</button></span></div>
      <nav class="rr-nav"></nav><div class="rr-body"></div>`;
    document.body.append(el);
    this.body = el.querySelector(".rr-body"); this.nav = el.querySelector(".rr-nav");
    el.querySelector(".rr-btns").addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "close") this.close();
      else if (a === "min") { el.classList.toggle("min"); el.classList.remove("max"); this.save(); }
      else if (a === "max") { el.classList.toggle("max"); el.classList.remove("min"); this.save(); }
      else if (a === "pdf") this.printDoc();
      else if (a === "doc") this.openDoc();
    });
    this.drag();
    new ResizeObserver(() => { if (!el.hidden && !el.classList.contains("min") && !el.classList.contains("max")) this.save(); }).observe(el);
    this.restore();
  }

  // ---------- window ----------
  drag() {
    const h = this.el.querySelector(".rr-h");
    h.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || this.el.classList.contains("max")) return;
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      h.setPointerCapture(e.pointerId);
      const move = (q) => { this.place(q.clientX - dx, q.clientY - dy); };
      const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); this.save(); };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }
  // Kept on screen: at least the title bar stays reachable.
  place(x, y) {
    const w = this.el.offsetWidth;
    this.el.style.left = `${Math.min(innerWidth - 80, Math.max(80 - w, x))}px`;
    this.el.style.top = `${Math.min(innerHeight - 36, Math.max(0, y))}px`;
  }
  save() {
    try { const s = this.el.style; localStorage.setItem(KEY, JSON.stringify({ l: s.left, t: s.top, w: this.el.offsetWidth, h: this.el.offsetHeight, min: this.el.classList.contains("min"), max: this.el.classList.contains("max") })); } catch { /* no storage */ }
  }
  restore() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* no storage */ }
    const w = Math.min(g?.w || 720, innerWidth - 16), h = Math.min(g?.h || Math.round(innerHeight * 0.8), innerHeight - 16);
    this.el.style.width = `${w}px`; this.el.style.height = `${h}px`;
    this.el.style.left = g?.l || `${Math.max(8, innerWidth - w - 24)}px`; this.el.style.top = g?.t || "56px";
    this.el.classList.toggle("max", !!g?.max);
  }
  open() {
    this.el.hidden = false; this.el.classList.remove("min");
    this.place(parseFloat(this.el.style.left) || 8, parseFloat(this.el.style.top) || 56);
    this.render();
  }
  close() { this.el.hidden = true; }
  status(msg) { this.el.querySelector(".rr-sub").textContent = msg ? ` · ${msg}` : ""; }
  routeChanged() { if (!this.el.hidden) this.render(); }
  // (the sensitivity finished, by itself or asked for here: shown, keeping the reading place)
  sensDone() { if (!this.el.hidden) { this.sensRunning = false; const y = this.body.scrollTop; this.render(); this.body.scrollTop = y; } }
  print() {
    document.body.classList.add("print-report");
    const done = () => { document.body.classList.remove("print-report"); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    print();
  }

  // ---------- the document ----------
  render() {
    const ps = this.ps, S = ps.summary, R = ps.result;
    this.el.querySelector(".rr-sub").textContent = "";
    if (!S || !R) { this.nav.innerHTML = ""; this.body.innerHTML = `<p class="note">No route yet: plan one in the Passage tab, then open the report.</p>`; return; }
    const res = R.res, pts = R.pts, boat = ps.exportData.boat, fixed = res.fixedKn;
    const rows = []; for (let i = 1; i < pts.length; i++) rows.push({ p: pts[i], r: ps.row(pts[i], pts[i - 1], boat), w: ps.wx ? ps.wxAt(pts[i].t) : null });
    const names = ps.wps.map((w) => ps.spotName(w).replace(/^(near|at) /, ""));
    this.el.querySelector(".rr-sub").textContent = ` · ${names[0]} → ${names.at(-1)}`;
    const sec = [];
    const add = (id, title, html) => { if (html) sec.push({ id, title, html }); };
    this.items = this.cautionItems(S, res, pts, rows);
    add("rr-brief", "The passage", this.brief(S, res, names, boat));
    add("rr-map", "Route map", `<div class="rr-mapbox"><p class="note">Drawing the route on the NOAA chart…</p></div>`);
    add("rr-caut", "Cautions", this.cautions(this.items));
    this.stations = this.stationList();
    add("rr-wp", "Waypoint to waypoint", this.wpTable(names));
    add("rr-turn", "Turn points", this.turnTable());
    add("rr-cur", "Currents at stations along the way", this.stationTable(this.stations));
    add("rr-charts", "Along the passage", this.charts(pts, rows, fixed));
    add("rr-legs", "Legs", this.legs(res, pts, names));
    add("rr-why", "Why this route", S.whyList.length ? `<ul>${S.whyList.map((w) => `<li>${w}</li>`).join("")}</ul>` : "");
    add("rr-src", "Where the wind came from", fixed ? "" : `${S.prov.replace(/<b>Wind from<\/b>/, "")}<p class="note">${S.curLabel ? `Currents: ${S.curLabel}.` : S.fieldStations ? `Currents: NOAA predictions at ${S.fieldStations} stations, blended between them.` : "No currents."}${S.wx ? ` Weather (temperature, visibility, rain, cloud): ${S.wx.labels.join(", then ")}.` : ""}</p>`);
    add("rr-sens", "Sensitivity", fixed || res.partial ? "" : this.sens());
    add("rr-cmp", "Models compared", this.models());
    add("rr-table", "Hour by hour", this.table());
    add("rr-exp", "Export", `<p>${[["gpx", "GPX route"], ["track", "GPX track"], ["csv", "CSV"]].map(([k, l]) => `<button class="btn mini" data-dl="${k}">${l}</button>`).join(" ")} <button class="btn mini" data-a="print2">PDF (print)</button> <button class="btn mini" data-a="doc2">Open as a page ↗</button></p><p class="note">Planning, not navigation: a model forecast and predicted currents on a charted water mask. Check the chart, the Coast Pilot and the latest forecast before you go.</p>`);
    this.nav.innerHTML = sec.map((s) => `<a href="#${s.id}">${s.title}</a>`).join("");
    this.body.innerHTML = sec.map((s) => `<section id="${s.id}"><h3>${s.title}</h3>${s.html}</section>`).join("");
    for (const a of this.nav.querySelectorAll("a")) a.addEventListener("click", (e) => { e.preventDefault(); this.body.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" }); });
    for (const b of this.body.querySelectorAll("[data-dl]")) b.addEventListener("click", () => ps.download(b.dataset.dl));
    this.body.querySelector("[data-a=print2]")?.addEventListener("click", () => this.printDoc());
    this.body.querySelector("[data-a=doc2]")?.addEventListener("click", () => this.openDoc());
    const gen = (this.gen = (this.gen || 0) + 1);
    this.buildMap(760).then((m) => { if (gen === this.gen) { const box = this.body.querySelector(".rr-mapbox"); if (box) box.innerHTML = m; } }).catch((e) => { console.warn("report map", e); const box = this.body.querySelector(".rr-mapbox"); if (box) box.innerHTML = `<p class="note">The map couldn't be drawn (${esc(e.message)}).</p>`; });
    this.body.querySelector("#rr-run-sens")?.addEventListener("click", () => this.runSens());
    for (const tr of this.body.querySelectorAll("tr[data-t]")) tr.addEventListener("click", () => ps.goTo(+tr.dataset.t));
    for (const tr of this.body.querySelectorAll("tr[data-cmp]")) tr.addEventListener("click", () => ps.showCompared(ps.compare.ok[+tr.dataset.cmp]));
    this.hover();
  }

  brief(S, res, names, boat) {
    const ps = this.ps, fixed = res.fixedKn, lim = ps.opts().limits;
    const tile = (k, v, i) => `<div><span>${k}</span><b>${v}</b><i>${i}</i></div>`;
    let stwS = 0, T = 0, narrowH = 0;
    const pts = ps.result.pts;
    for (let i = 1; i < pts.length; i++) { const m = pts[i].m, d = pts[i].t - pts[i - 1].t; if (!m || m.hold) continue; stwS += (m.bsp || 0) * d; T += d; if (m.narrow) narrowH += d / 3600e3; }
    const route = names.map(esc).join(" → ");
    return `<p class="rr-route">${route}${res.partial ? ` <span class="warn">(incomplete: ${esc(res.reason || "")})</span>` : ""}</p>
      <div class="ps-sum">${tile("Depart", ps.fmt(S.t0, true), ps.utc(S.t0))}${tile("Arrive (ETA)", ps.fmt(S.t1, true), ps.utc(S.t1))}
      ${tile("Passage", hm(S.hours), `${(S.dist / NM).toFixed(1)} nm sailed · ${(S.rhumb / NM).toFixed(1)} nm straight${S.water ? ` · ${(S.water / NM).toFixed(1)} nm shortest by water` : ""}`)}
      ${tile("Average under way", `SOG ${(S.dist / NM / Math.max(0.1, S.hours - S.waitH)).toFixed(1)} kn`, `${T ? `STW ${(stwS / T).toFixed(1)} kn · ` : ""}made good ${(S.rhumb / NM / S.hours).toFixed(1)} kn`)}
      ${fixed ? tile("Speed through water", `${fixed} kn`, "steady (currents only)") : tile("Wind", `max ${Math.round(S.maxTws)} kt`, `gusts to ${Math.round(S.maxG)} kt (limit ${lim.maxGustKt})`) + tile("Seas", `max ${S.maxHs.toFixed(1)} ft`, `limit ${(lim.maxHsM * 3.28084).toFixed(0)} ft · ${S.nT} tacks, ${S.nG} gybes`)}
      ${tile("Motoring", hm(S.motorH), `${narrowH > 0.02 ? `${hm(narrowH)} in narrow channels` : "no narrow channels"}${S.motorH - narrowH > 0.02 ? ` · ${hm(S.motorH - narrowH)} in light air` : ""}`)}
      ${S.waitH > 0.05 ? tile("Wait first", hm(S.waitH), `in harbour, ${ps.waitWhy(pts, boat)}`) : ""}
      ${S.holdH > 0.05 ? tile("Hold for the tide", hm(S.holdH), S.holds.map((h) => `${hm(h.h)} ${esc(h.where)}`).join("; ")) : ""}
      ${tile("Current", `${hm(S.fair)} fair`, `${hm(S.foul)} foul${S.maxFoul > 0.3 ? `, worst ${S.maxFoul.toFixed(1)} kt against` : ""}`)}
      ${tile("Darkness", hm(S.darkH), S.sunEv.length ? S.sunEv.join(", ") : "no sunrise or sunset on the way")}
      ${S.wx && Number.isFinite(S.wx.tmin) ? tile("Weather", `${fF(S.wx.tmin)}–${fF(S.wx.tmax)} °F`, [S.wx.fogH >= 0.1 ? `fog ${hm(S.wx.fogH)}` : S.wx.mistH >= 0.1 ? `mist or haze ${hm(S.wx.mistH)}` : "no fog", S.wx.minVis < 9 * 1852 ? `vis down to ${visText(S.wx.minVis)}` : "", S.wx.thunder.length ? "thunderstorms" : S.wx.rainH >= 0.1 ? `rain ${hm(S.wx.rainH)}` : "dry", cloudWord(S.wx.cloud)].filter(Boolean).join(" · ")) : ""}</div>
      <p class="note">Boat: ${esc(boat.key === "cg31" ? "Cape George 31" : boat.key === "ps37" ? "Pacific Seacraft 37" : boat.key)} (approximate polars). Limits: gusts ${lim.maxGustKt} kt, seas ${(lim.maxHsM * 3.28084).toFixed(0)} ft, ${(lim.clearKm / NM).toFixed(2)} nm off land${lim.avoidDanger ? ", avoid dangerous wind-against-current" : ""}. Motor ${$("ps-motor").checked ? `in light air (under ${$("ps-mbelow").value} kn under sail)` : "not in light air"}${$("ps-narrow").checked ? `, through channels narrower than ${$("ps-narrow-w").value} nm` : ""}, at ${$("ps-mkn").value} kn.${S.easedTxt ? `<br>${S.easedTxt.replace(/^<br>/, "")}` : ""}</p>`;
  }

  // Things to look at before going: where and when.
  cautionItems(S, res, pts, rows) {
    const ps = this.ps, lim = ps.opts().limits, out = [], add = (html, p = null) => out.push({ html, p });
    const runs = (test) => { const r = []; let cur = null; for (const q of rows) { if (test(q)) { if (!cur) r.push((cur = { a: q, b: q })); else cur.b = q; } else cur = null; } return r; };
    const at = (q) => `${ps.fmt(q.p.t)} ${ps.spotName(q.p)}`;
    // (narrow water away from the start and end: channels, not the way in and out of harbour)
    const nearWp = (p) => [ps.wps[0], ps.wps.at(-1)].some((w) => Math.hypot(w.x - p.x, w.y - p.y) < 2);
    const span = (g) => (g.b.p.t - g.a.p.t > 60e3 ? `${at(g.a)} to ${ps.fmt(g.b.p.t)}` : at(g.a));
    for (const h of S.holds || []) add(`<b>Hold for the tide</b> ${hm(h.h)} ${esc(h.where)}, ${ps.fmt(h.t0)} to ${ps.fmt(h.t1)}, ${esc(h.why)}: anchor or stand off out of the stream, then go on. (It's the quicker choice here: pushing on against the current gets there later.)`, h);
    for (const g of runs((q) => q.p.m?.narrow && !nearWp(q.p))) add(`<b>Narrow channel</b>, motoring: ${span(g)}. Check the tidal current there (often strongest in the narrows) and any traffic.`, g.a.p);
    const gusty = runs((q) => q.r.gust >= 0.85 * lim.maxGustKt);
    if (gusty.length) add(`<b>Gusts near your ${lim.maxGustKt} kt limit</b>: ${gusty.slice(0, 4).map((g) => `${span(g)} (to ${Math.round(Math.max(...rows.filter((q) => q.p.t >= g.a.p.t && q.p.t <= g.b.p.t).map((q) => q.r.gust)))} kt)`).join("; ")}.`, gusty[0].a.p);
    const wac = runs((q) => (q.p.c?.rating || 0) >= 1);
    if (wac.length) add(`<b>Wind against current</b> (steep${wac.some((g) => rows.some((q) => q.p.t >= g.a.p.t && q.p.t <= g.b.p.t && q.p.c?.rating > 1)) ? " to dangerous" : ""} chop): ${wac.slice(0, 4).map((g) => at(g.a)).join("; ")}.`, wac[0].a.p);
    const foul = runs((q) => q.r.along < -1.5);
    if (foul.length) add(`<b>Strong foul current</b> (over 1.5 kt against): ${foul.slice(0, 4).map((g) => `${span(g)}`).join("; ")}.`, foul[0].a.p);
    if (rows.some((q) => q.w)) {
      const fog = runs((q) => q.w?.vis < 1852);
      if (fog.length) add(`<b>Fog</b> (visibility under 1 nm): ${fog.slice(0, 4).map((g) => `${span(g)} (down to ${visText(Math.min(...rows.filter((q) => q.p.t >= g.a.p.t && q.p.t <= g.b.p.t).map((q) => q.w.vis)))})`).join("; ")}. Radar, AIS, sound signals and a plan for the traffic lanes; the model's fog timing is uncertain by hours.`, fog[0].a.p);
      const tst = runs((q) => rainWord(q.w) === "thunderstorm");
      if (tst.length) add(`<b>Thunderstorms</b> possible: ${tst.slice(0, 4).map(span).join("; ")}. Sudden strong gusts and wind shifts, lightning; the wind forecast won't show a storm's own gusts.`, tst[0].a.p);
      const heavy = runs((q) => rainWord(q.w) === "heavy rain");
      if (heavy.length) add(`<b>Heavy rain</b>: ${heavy.slice(0, 4).map(span).join("; ")}: visibility drops in the showers.`, heavy[0].a.p);
      const cold = rows.filter((q) => q.w?.t2 < 7);
      if (cold.length) add(`<b>Cold</b>: air down to ${fF(Math.min(...cold.map((q) => q.w.t2)))}°F${rows.some((q) => q.w && rainWord(q.w)) ? " with rain" : ""}: dress for it, and for cold water if you go in.`);
    }
    if (S.darkH > 0.1) add(`<b>Darkness</b> ${hm(S.darkH)} of the passage${S.sunEv.length ? ` (${S.sunEv.join(", ")})` : ""}: lights, and a plan for the approaches after dark.`);
    const glob = (S.sources || []).filter((s) => /GFS|ECMWF/.test(s.label));
    if (glob.length && rows.some((q) => glob.some((s) => (q.p.c?.src || "").includes(s.label)))) add(`<b>Long-range wind</b> (${glob.map((s) => s.label).join(", ")}, ~25 km grid) for part of the passage: gap winds, sea breezes and wind shadows are smoothed out. Re-plan as the high-resolution runs reach those hours.`);
    const oldest = (S.sources || []).map((s) => (Date.now() - s.cycle.getTime()) / 3600e3).filter((h) => rows.length);
    if (oldest.length && Math.min(...oldest) > 8) add(`<b>Forecast age</b>: the newest run used is ${Math.round(Math.min(...oldest))} h old; a newer one may be out.`);
    for (const e of res.eased || []) if (e.spots?.length) add(`<b>Close to land</b> on leg ${e.leg}: within ${(e.to / NM).toFixed(2)} nm of the shore ${e.spots.map((s) => ps.spotName(s)).join(", ")} (narrow water).`, e.spots[0]);
    if (res.partial) add(`<b>No complete route</b>: ${esc(res.reason || "")}. The report covers the part routed.`);
    return out;
  }
  // Numbered to match the markers on the route map (those with a place).
  cautions(items) {
    return items.length ? `<ol class="rr-caut">${items.map((o) => `<li>${o.html}</li>`).join("")}</ol>` : `<p class="note">Nothing stands out: within your limits all the way, no narrow channels, strong foul current or wind against current.</p>`;
  }

  // Small multiples on one time axis (no dual axes): wind, boat speed, current along the track,
  // seas. Shaded: darkness; strip along the bottom: motoring (grey) and waiting (blue).
  charts(pts, rows, fixed) {
    const ps = this.ps, t0 = pts[0].t, t1 = pts.at(-1).t, lim = ps.opts().limits;
    this.series = { t0, t1, rows };
    const dark = []; { let a = null; for (let t = t0; t <= t1 + 1; t += 600e3) { const q = pts.find((p) => p.t >= t) || pts.at(-1), ll = ps.ex.proj.toLatLon(q.x, q.y), d = ps.sunAlt(t, ll) < -6; if (d && a == null) a = t; if (!d && a != null) { dark.push([a, t]); a = null; } } if (a != null) dark.push([a, t1]); }
    const V = (f) => rows.map((q) => [q.p.t, f(q)]);
    const specs = [];
    if (!fixed) specs.push({ title: "Wind", unit: "kt", series: [{ name: "TWS", color: C1, v: V((q) => q.r.tws) }, { name: "gust", color: C2, v: V((q) => q.r.gust), dash: true }], limit: [lim.maxGustKt, "gust limit"], dark });
    specs.push({ title: "Boat speed", unit: "kn", series: [{ name: "STW", color: C1, v: V((q) => (q.p.m?.hold ? 0 : q.r.bsp || 0)) }, { name: "SOG", color: C2, v: V((q) => q.r.sog || 0) }], dark, strip: rows.map((q) => [q.p.t, q.p.m?.hold ? "hold" : q.p.m?.motor ? "motor" : null]) });
    specs.push({ title: "Current along the track", unit: "kt", signed: true, series: [{ name: "fair +", color: FAIR, neg: FOUL, v: V((q) => q.r.along), area: true }, ...[]], negName: "foul −", dark });
    if (!fixed) specs.push({ title: "Seas (chop and swell)", unit: "ft", series: [{ name: "height", color: C1, v: V((q) => q.r.hs), area: true }], limit: [lim.maxHsM * 3.28084, "seas limit"], dark });
    // Weather (when loaded): air and dewpoint, visibility, cloud, rain.
    if (rows.some((q) => q.w)) {
      const W = (f) => rows.map((q) => [q.p.t, q.w ? f(q.w) : NaN]), temps = rows.flatMap((q) => (q.w ? [fF(q.w.t2), fF(q.w.td)] : [])).filter(Number.isFinite);
      if (temps.length) specs.push({ title: "Air temperature", unit: "°F", series: [{ name: "air", color: C2, v: W((w) => fF(w.t2)) }, { name: "dewpoint", color: C1, v: W((w) => fF(w.td)), dash: true }], range: [Math.floor(Math.min(...temps) / 5) * 5 - 5, Math.ceil(Math.max(...temps) / 5) * 5 + 5], dark });
      specs.push({ title: "Visibility", unit: "nm (10+ at the top)", series: [{ name: "visibility", color: FOG, v: W((w) => Math.min(10, w.vis / 1852)), area: true }], limit: [1, "fog under"], range: [0, 10.5], dark });
      specs.push({ title: "Cloud cover", unit: "%", series: [{ name: "total", color: CLOUD, v: W((w) => w.tcc), area: true }, { name: "low", color: C2, v: W((w) => w.lcc), dash: true }], range: [0, 105], dark });
      const rmax = Math.max(0, ...rows.map((q) => q.w?.rain || 0));
      if (rmax >= 0.1) specs.push({ title: "Rain", unit: "mm/h", series: [{ name: "rate", color: C1, v: W((w) => w.rain || 0), area: true }], dark });
    }
    specs.at(-1).axis = true;                                   // (time labels under the last chart)
    const out = specs.map((q) => this.chart(q));
    return `<div class="rr-charts">${out.join("")}</div><div class="rr-read note" id="rr-read">Hover the charts for the values at a time; click to show that time on the map.</div>
      <p class="note">Shaded: darkness. The strip under boat speed: grey motoring, blue waiting (in harbour, or holding for the tide).</p>`;
  }
  chart({ title, unit, series, limit, dark = [], strip, signed = false, axis = false, negName = null, range = null }) {
    const W = 640, H = axis ? 118 : 100, L = 34, Rr = 8, T = 16, B = axis ? 20 : 6, { t0, t1 } = this.series;
    const all = series.flatMap((s) => s.v.map((q) => q[1])).filter(Number.isFinite).concat(limit ? [limit[0]] : []);
    let lo = signed ? -Math.max(0.5, ...all.map(Math.abs)) : 0, hi = signed ? -lo : Math.max(1, ...all) * 1.08;
    if (range) [lo, hi] = range;
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - Rr), Y = (v) => T + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - T - B);
    const g = [];
    for (const [a, b] of dark) g.push(`<rect x="${X(a).toFixed(1)}" y="${T}" width="${Math.max(0.5, X(b) - X(a)).toFixed(1)}" height="${H - T - B}" class="rr-dark"/>`);
    const ticks = niceTicks(lo, hi, 3);
    for (const v of ticks) g.push(`<line x1="${L}" x2="${W - Rr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="rr-grid${v === 0 && signed ? " zero" : ""}"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" class="rr-ax" text-anchor="end">${fmtN(v)}</text>`);
    for (const [t, lab] of this.timeTicks()) g.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${T}" y2="${H - B}" class="rr-grid"/>${axis ? `<text x="${X(t).toFixed(1)}" y="${H - 6}" class="rr-ax" text-anchor="middle">${lab}</text>` : ""}`);
    if (limit && limit[0] < hi) g.push(`<line x1="${L}" x2="${W - Rr}" y1="${Y(limit[0]).toFixed(1)}" y2="${Y(limit[0]).toFixed(1)}" class="rr-lim"/><text x="${W - Rr - 2}" y="${(Y(limit[0]) - 3).toFixed(1)}" class="rr-ax lim" text-anchor="end">${limit[1]} ${fmtN(limit[0])}</text>`);
    for (const s of series) {
      const pts = s.v.filter((q) => Number.isFinite(q[1]));
      if (!pts.length) continue;
      const d = pts.map((q, i) => `${i ? "L" : "M"}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join("");
      if (s.area) {
        const base = Y(signed ? 0 : lo), a = `${d}L${X(pts.at(-1)[0]).toFixed(1)},${base.toFixed(1)}L${X(pts[0][0]).toFixed(1)},${base.toFixed(1)}Z`;
        if (s.neg) { g.push(`<clipPath id="cp-${title.length}-a"><rect x="0" y="0" width="${W}" height="${Y(0).toFixed(1)}"/></clipPath><clipPath id="cp-${title.length}-b"><rect x="0" y="${Y(0).toFixed(1)}" width="${W}" height="${H}"/></clipPath>`
          + `<path d="${a}" fill="${s.color}" fill-opacity=".35" clip-path="url(#cp-${title.length}-a)"/><path d="${a}" fill="${s.neg}" fill-opacity=".35" clip-path="url(#cp-${title.length}-b)"/>`); }
        else g.push(`<path d="${a}" fill="${s.color}" fill-opacity=".22"/>`);
      }
      g.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 3"' : ""} stroke-linejoin="round"/>`);
    }
    if (strip) for (let i = 1; i < strip.length; i++) { const k = strip[i][1]; if (k) g.push(`<rect x="${X(strip[i - 1][0]).toFixed(1)}" y="${H - B - 4}" width="${Math.max(0.5, X(strip[i][0]) - X(strip[i - 1][0])).toFixed(1)}" height="4" class="rr-${k}"/>`); }
    const legend = series.map((s) => `<span class="rr-key"><i style="background:${s.color}"></i>${s.name}${s.dash ? " (dashed)" : ""}</span>`).join("") + (negName ? `<span class="rr-key"><i style="background:${FOUL}"></i>${negName}</span>` : "");
    return `<div class="rr-chart"><div class="rr-ct"><b>${title}</b> <span class="note">${unit}</span> ${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" data-l="${L}" data-r="${Rr}" data-w="${W}" data-axis="${axis ? 1 : 0}">${g.join("")}<line class="rr-x" x1="-9" x2="-9" y1="${T}" y2="${H - B}"/></svg></div>`;
  }
  timeTicks() {
    const { t0, t1 } = this.series, span = (t1 - t0) / 3600e3, step = [1, 2, 3, 6, 12, 24].find((s) => span / s <= 8) || 24, out = [];
    const tz = this.ps.ex.region?.tz || "UTC", f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }), fd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric" });
    for (let t = Math.ceil(t0 / (step * 3600e3)) * step * 3600e3; t <= t1; t += step * 3600e3) out.push([t, (out.length ? f : fd).format(new Date(t)).replace(" ", "")]);
    return out;
  }
  // A crosshair across all the charts, the values at that time, and click to go there on the map.
  hover() {
    const svgs = [...this.body.querySelectorAll(".rr-chart svg")], read = $("rr-read");
    if (!svgs.length || !this.series) return;
    const { t0, t1, rows } = this.series, ps = this.ps;
    const tAt = (svg, e) => { const r = svg.getBoundingClientRect(), W = +svg.dataset.w, L = +svg.dataset.l, R = +svg.dataset.r, x = ((e.clientX - r.left) / r.width) * W; return t0 + Math.min(1, Math.max(0, (x - L) / (W - L - R))) * (t1 - t0); };
    const show = (t) => {
      for (const s of svgs) { const W = +s.dataset.w, L = +s.dataset.l, R = +s.dataset.r, x = L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), ln = s.querySelector(".rr-x"); ln.setAttribute("x1", x); ln.setAttribute("x2", x); }
      let q = rows[0]; for (const r of rows) { if (r.p.t <= t) q = r; else break; }
      const r = q.r, m = q.p.m || {};
      read.innerHTML = `<b>${ps.fmt(q.p.t)}</b> · ${m.hold ? (m.gate ? "holding for the tide" : "waiting in harbour") : m.narrow ? "motoring, narrow channel" : m.motor ? "motoring" : `TWA ${Number.isFinite(r.twa) ? `${Math.round(Math.abs(r.twa))}° ${r.twa < 0 ? "P" : "S"}` : "–"}`}`
        + ` · TWS ${Math.round(r.tws || 0)} kt (gust ${Math.round(r.gust || 0)}) · STW ${(m.hold ? 0 : r.bsp || 0).toFixed(1)} · SOG ${(r.sog || 0).toFixed(1)} kn · current ${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)} kt · seas ${r.hs.toFixed(1)} ft${q.w ? ` · ${wxLine(q.w)}` : ""} · ${ps.spotName(q.p)}`;
    };
    for (const s of svgs) {
      s.addEventListener("pointermove", (e) => show(tAt(s, e)));
      s.addEventListener("click", (e) => ps.goTo(tAt(s, e)));
    }
  }

  // ---------- the route map ----------
  // The route on the stored NOAA chart (paper-chart style, pipeline/noaachart.py; the planner's
  // water mask underneath where there's no US chart), lightened so the route reads: sailing (blue),
  // motoring (grey, dashed), tacks and gybes, hourly times, the waypoints by name, numbered
  // cautions, other models' routes (after a compare); a lat/lon grid, scale and north arrow.
  async buildMap(W = 760) {
    const ps = this.ps, pts = ps.result.pts, proj = ps.ex.proj, main = pts;
    const alts = (ps.compare?.ok || []).filter((q) => q.res.pts !== main && ps.layer.alts?.visible !== false);
    const all = [...pts, ...ps.wps, ...alts.flatMap((q) => q.res.pts)];
    let x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x)), y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
    const pad = Math.max(1.5, 0.08 * Math.max(x1 - x0, y1 - y0)); x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const ar = Math.min(1.3, Math.max(0.6, (y1 - y0) / (x1 - x0)));                  // frame height / width
    if ((y1 - y0) / (x1 - x0) > ar) { const w = (y1 - y0) / ar, c = (x0 + x1) / 2; x0 = c - w / 2; x1 = c + w / 2; } else { const h = (x1 - x0) * ar, c = (y0 + y1) / 2; y0 = c - h / 2; y1 = c + h / 2; }
    const H = Math.round(W * ar), X = (x) => ((x - x0) / (x1 - x0)) * W, Y = (y) => ((y1 - y) / (y1 - y0)) * H, P = (p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
    const base = await this.chartBase(x0, y0, x1, y1, W, H);
    const g = [`<image href="${base.url}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`];
    // Lat/lon grid in degrees and minutes.
    const a = proj.toLatLon(x0, y0), b = proj.toLatLon(x1, y1), spanMin = (b.lat - a.lat) * 60, step = [1, 2, 5, 10, 15, 20, 30, 60].find((m) => spanMin / m <= 6) || 60;
    for (let la = Math.ceil((a.lat * 60) / step) * step; la <= b.lat * 60; la += step) { const y = Y(proj.toXY(la / 60, a.lon).y); g.push(`<line x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="rm-grid"/><text x="3" y="${(y - 3).toFixed(1)}" class="rm-gl">${dmShort(la / 60, "N", "S")}</text>`); }
    for (let lo = Math.ceil((a.lon * 60) / step) * step; lo <= b.lon * 60; lo += step) { const x = X(proj.toXY(a.lat, lo / 60).x); g.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${H}" class="rm-grid"/><text x="${(x + 3).toFixed(1)}" y="${H - 4}" class="rm-gl">${dmShort(lo / 60, "E", "W")}</text>`); }
    // Other models' routes, then the route: a white casing, sailing blue, motoring grey dashed.
    for (const q of alts) g.push(`<polyline points="${q.res.pts.map(P).join(" ")}" fill="none" stroke="${q.color}" stroke-width="2" stroke-opacity=".85" stroke-dasharray="1 0"/>`);
    // (each model's route named by its arrival, the plan's too, after a compare)
    const mainQ = (ps.compare?.ok || []).find((q) => q.res.pts === main), mainLabel = mainQ?.label || "";
    if (alts.length) {
      alts.forEach((q, k) => { const e = q.res.pts.at(-1); g.push(`<circle cx="${X(e.x).toFixed(1)}" cy="${Y(e.y).toFixed(1)}" r="3.5" fill="${q.color}" stroke="#fff"/>`); });
      this.altTags = [...alts.map((q, k) => [q.res.pts, q.label, q.color, k]), [main, mainLabel || "this plan", "#1f6fb2", -1]];
    } else this.altTags = null;
    g.push(`<polyline points="${pts.map(P).join(" ")}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-opacity=".9"/>`);
    let seg = [pts[0]], kind = null;
    const flush = () => { if (seg.length > 1) g.push(`<polyline points="${seg.map(P).join(" ")}" fill="none" class="${kind === "motor" ? "rm-motor" : "rm-sail"}" stroke-linejoin="round"/>`); };
    for (let i = 1; i < pts.length; i++) { const k = pts[i].m?.motor ? "motor" : "sail"; if (k !== kind && seg.length > 1) { flush(); seg = [pts[i - 1]]; } kind = k; seg.push(pts[i]); }
    flush();
    for (const tk of ps.exportData.tacks) g.push(tk.kind === "gybe" ? `<circle cx="${X(tk.x).toFixed(1)}" cy="${Y(tk.y).toFixed(1)}" r="2.6" class="rm-gybe"/>` : `<rect x="${(X(tk.x) - 2.4).toFixed(1)}" y="${(Y(tk.y) - 2.4).toFixed(1)}" width="4.8" height="4.8" transform="rotate(45 ${X(tk.x).toFixed(1)} ${Y(tk.y).toFixed(1)})" class="rm-tack"/>`);
    // Hourly marks (every 1–12 h, up to ~12 of them).
    const t0 = pts[0].t, t1 = pts.at(-1).t, hs = [1, 2, 3, 4, 6, 12].find((h) => (t1 - t0) / 3600e3 / h <= 12) || 24;
    const tz = ps.ex.region?.tz || "UTC", fH = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }), fD = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric" });
    let lastDay = "";
    for (let t = Math.ceil(t0 / (hs * 3600e3)) * hs * 3600e3; t < t1; t += hs * 3600e3) {
      const s = ps.stateAt(t), day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(t);
      g.push(`<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.y).toFixed(1)}" r="2.4" class="rm-hr"/><text x="${(X(s.x) + 5).toFixed(1)}" y="${(Y(s.y) + 3).toFixed(1)}" class="rm-t">${(day !== lastDay ? fD : fH).format(t).replace(" ", "")}</text>`);
      lastDay = day;
    }
    // Waypoints by name.
    const names = ps.wps.map((w) => ps.spotName(w).replace(/^(near|at) /, ""));
    ps.wps.forEach((w, i) => {
      const cls = i === 0 ? "rm-start" : i === ps.wps.length - 1 ? "rm-end" : "rm-via", x = X(w.x), y = Y(w.y), right = x < W * 0.7;
      g.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" class="${cls}"/><text x="${(x + (right ? 9 : -9)).toFixed(1)}" y="${(y - 7).toFixed(1)}" class="rm-wp" text-anchor="${right ? "start" : "end"}">${i === 0 ? "Start: " : i === ps.wps.length - 1 ? "End: " : `${i}. `}${esc(names[i])}</text>`);
    });
    // Current stations in the table (S1…): small teal triangles.
    (this.stations || []).forEach((q, k) => {
      const x = X(q.st.x), y = Y(q.st.y);
      if (x < 0 || y < 0 || x > W || y > H) return;
      g.push(`<path d="M${x.toFixed(1)},${(y - 5).toFixed(1)} l4.5,8 h-9 Z" class="rm-stn"/><text x="${(x + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" class="rm-sn">S${k + 1}</text>`);
    });
    // Route labels (after a compare): at each route's arrival, stacked so they don't overlap.
    if (this.altTags) { const used = []; for (const [Q, label, color] of this.altTags) { const e = Q.at(-1); let x = X(e.x) + 8, y = Y(e.y) + 14; while (used.some((u) => Math.abs(u - y) < 12)) y += 12; used.push(y); g.push(`<text x="${Math.min(x, W - 150).toFixed(1)}" y="${y.toFixed(1)}" class="rm-t" style="fill:${color};font-weight:700">${esc(label)} → ${ps.fmt(e.t).replace(/^\w+ /, "")}</text>`); } }
    // Numbered cautions.
    const placed = [];
    (this.items || []).forEach((c, k) => {
      if (!c.p) return;
      let x = X(c.p.x), y = Y(c.p.y);
      while (placed.some((q) => Math.hypot(q[0] - x, q[1] - y) < 14)) { x += 10; y -= 10; }
      placed.push([x, y]);
      g.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7.5" class="rm-caut"/><text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" class="rm-cn" text-anchor="middle">${k + 1}</text>`);
    });
    // Scale (nm) and north arrow.
    const kmPx = W / (x1 - x0), nmLen = [0.5, 1, 2, 5, 10, 20, 50].find((n) => n * NM * kmPx >= W * 0.14) || 50, sl = nmLen * NM * kmPx;
    g.push(`<g transform="translate(12 ${H - 26})"><rect x="-6" y="-14" width="${(sl + 40).toFixed(0)}" height="24" rx="3" class="rm-plate"/><line x1="0" x2="${sl.toFixed(1)}" y1="0" y2="0" class="rm-scale"/><line x1="0" x2="0" y1="-4" y2="4" class="rm-scale"/><line x1="${sl.toFixed(1)}" x2="${sl.toFixed(1)}" y1="-4" y2="4" class="rm-scale"/><text x="${(sl + 5).toFixed(1)}" y="4" class="rm-t">${nmLen} nm</text></g>`);
    g.push(`<g transform="translate(${W - 22} 30)"><path d="M0,-18 L7,6 L0,1 L-7,6 Z" class="rm-north"/><text x="0" y="18" class="rm-t" text-anchor="middle">N</text></g>`);
    const legend = `<div class="rm-legend">${alts.length ? `<b>${esc(mainLabel || "This plan")}:</b>` : ""}<span><i class="k-sail"></i>sailing</span><span><i class="k-motor"></i>motoring</span><span><i class="k-tack"></i>tack</span><span><i class="k-gybe"></i>gybe</span><span><i class="k-hr"></i>every ${hs} h</span><span><i class="k-caut"></i>caution (numbered below)</span>${(this.stations || []).length ? `<span><i class="k-stn"></i>current station (S1… in its table)</span>` : ""}${alts.length ? `<span style="flex-basis:100%"></span><b>Other models:</b>${alts.map((q) => `<span><i style="background:${q.color}"></i>${esc(q.label)} (arrives ${ps.fmt(q.res.pts.at(-1).t).replace(/^\w+ /, "")})</span>`).join("")}` : ""}</div>`;
    return `<figure class="rr-map"><svg viewBox="0 0 ${W} ${H}" class="rm">${g.join("")}</svg>${legend}<figcaption class="note">${esc(base.credit)} Bearings and positions are planning estimates, not for navigation.</figcaption></figure>`;
  }
  // The map's background as an image: the planner's water mask (land tan, water pale), with the
  // stored NOAA chart tiles on top where they cover, lightened. → {url, credit}
  async chartBase(x0, y0, x1, y1, W, H) {
    const ps = this.ps, proj = ps.ex.proj, rid = ps.ex.region.id, k = 2, cw = W * k, ch = H * k;
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    const g = cv.getContext("2d"), img = g.createImageData(cw, ch), L = ps.ex.routeGridCache?.grid || ps.ex.landGrid();
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const x = x0 + ((i + 0.5) / cw) * (x1 - x0), y = y1 - ((j + 0.5) / ch) * (y1 - y0), a = Math.round((x - L.x0) / L.dxy), b = Math.round((y - L.y0) / L.dxy);
      const land = a < 0 || b < 0 || a >= L.nx || b >= L.ny || L.mask[b * L.nx + a] === 1, o = (j * cw + i) * 4;
      if (land) { img.data[o] = 236; img.data[o + 1] = 229; img.data[o + 2] = 210; } else { img.data[o] = 238; img.data[o + 1] = 245; img.data[o + 2] = 248; }
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    let credit = "Land and water: the planner's chart-based water mask.";
    try {
      const idx = (this.chartIdx ||= {})[rid] ||= await fetch(`data/${rid}/noaachart/index.json`).then((r) => (r.ok ? r.json() : null));
      if (idx) {
        const A = proj.toLatLon(x0, y0), B = proj.toLatLon(x1, y1);
        const rect = (bb) => { const p = proj.toXY(bb.latMin, bb.lonMin), q = proj.toXY(bb.latMax, bb.lonMax); return [((p.x - x0) / (x1 - x0)) * cw, ((y1 - q.y) / (y1 - y0)) * ch, ((q.x - p.x) / (x1 - x0)) * cw, ((q.y - p.y) / (y1 - y0)) * ch]; };
        const hit = (bb) => bb.lonMax > A.lon && bb.lonMin < B.lon && bb.latMax > A.lat && bb.latMin < B.lat;
        const bmp = async (f) => ((this.bmps ||= new Map()).get(`${rid}/${f}`) || this.bmps.set(`${rid}/${f}`, fetch(`data/${rid}/noaachart/${f}`).then((r) => r.blob()).then((b) => createImageBitmap(b))).get(`${rid}/${f}`));
        if (idx.base && hit(idx.base.bbox)) g.drawImage(await bmp(idx.base.file), ...rect(idx.base.bbox));
        const tiles = (idx.tiles || []).filter((t) => hit(t.bbox));
        if (tiles.length <= 12) for (const t of tiles) g.drawImage(await bmp(t.file), ...rect(t.bbox));
        g.fillStyle = "rgba(255,255,255,0.28)"; g.fillRect(0, 0, cw, ch);
        credit = `Chart: NOAA Chart Display Service (ENC in paper-chart style, depths in ${idx.depthUnits || "ft"}; stored ${idx.fetched || ""}), lightened; the planner's water mask where there's no US chart.`;
      }
    } catch (e) { console.warn("report chart", e); }
    return { url: cv.toDataURL("image/jpeg", 0.86), credit };
  }

  // ---------- navigation tables ----------
  // Between your waypoints: the straight track, the course to steer on average (the heading that
  // made the track good, allowing for current and leeway), distances, times and speed.
  wpTable(names) {
    const ps = this.ps, res = ps.result.res, pts = ps.result.pts, L = res.legs || [];
    if (!L.length) return "";
    const rowsH = L.map((g) => {
      const a = ps.wps[g.from], b = ps.wps[g.to], P = pts.filter((p) => p.t >= g.t0 && p.t <= g.t1);
      let d = 0, sx = 0, sy = 0; for (let i = 1; i < P.length; i++) { const m = P[i].m || {}, dt = P[i].t - P[i - 1].t; d += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); if (!m.hold && Number.isFinite(P[i].h)) { sx += Math.sin((P[i].h * Math.PI) / 180) * dt; sy += Math.cos((P[i].h * Math.PI) / 180) * dt; } }
      const straight = Math.hypot(b.x - a.x, b.y - a.y), brg = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360, cts = sx || sy ? ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360 : NaN, h = (g.t1 - g.t0) / 3600e3;
      return `<tr><td>${g.from === 0 ? "Start" : g.from}. ${esc(names[g.from])}</td><td>${g.to === ps.wps.length - 1 ? "End" : g.to}. ${esc(names[g.to])}</td><td>${ps.brg(brg)}</td><td>${ps.brg(cts)}</td><td>${(straight / NM).toFixed(1)}</td><td>${(d / NM).toFixed(1)}</td><td>${ps.fmt(g.t0)}</td><td>${ps.fmt(g.t1)}</td><td>${hm(h)}</td><td>${(d / NM / Math.max(0.05, h)).toFixed(1)}</td></tr>`;
    }).join("");
    return `<div class="ps-tbl"><table><thead><tr><th>From</th><th>To</th><th title="The straight line between the waypoints">Track</th><th title="Course to steer, on average over the leg: the heading that made the track good, allowing for current and leeway (the route tacks or bends round land, so it varies along the way: see the turn points)">CTS (avg)</th><th>nm straight</th><th>nm sailed</th><th>Leave</th><th>Arrive</th><th>Time</th><th title="Average speed over the ground">SOG</th></tr></thead><tbody>${rowsH}</tbody></table></div><p class="note">Bearings ${this.brgNote()}.</p>`;
  }
  // Each turn point (start, tacks and gybes, course changes, waypoints, end) with its position and
  // ETA, and to the next one: the track over the ground, the heading to steer and the distance.
  turnTable() {
    const ps = this.ps, T = ps.turnPoints(), pts = ps.result.pts;
    const steerTo = (k) => { const q = T[k + 1]; if (!q) return NaN; const p = pts.find((z) => z.t > T[k].t && z.t <= q.t && Number.isFinite(z.h)); return p ? p.h : NaN; };
    const rowsH = T.map((q, k) => `<tr><td>${q.name}</td><td>${q.kind}</td><td>${dm(q.lat, "N", "S")}</td><td>${dm(q.lon, "E", "W")}</td><td>${ps.fmt(q.t)}</td><td>${q.cog == null ? "–" : ps.brg(q.cog)}</td><td>${q.cog == null ? "–" : ps.brg(steerTo(k))}</td><td>${q.nm == null ? "–" : q.nm.toFixed(2)}</td></tr>`).join("");
    return `<div class="ps-tbl"><table><thead><tr><th>Point</th><th>Kind</th><th>Latitude</th><th>Longitude</th><th>ETA</th><th title="Course over the ground to the next point">Track to next</th><th title="The heading to steer to make that track good (current and leeway allowed for)">Steer</th><th>nm to next</th></tr></thead><tbody>${rowsH}</tbody></table></div><p class="note">The same points as the GPX route export. Bearings ${this.brgNote()}.</p>`;
  }
  brgNote() { const mag = $("ps-brg")?.value === "mag"; return mag ? `magnetic (°M, variation ${this.ps.variation()}° E, approximate: check the chart's compass rose)` : "true (°T)"; }
  // The hour-by-hour table, built afresh (for the document).
  hourTable() {
    const ps = this.ps, res = ps.result.res, boat = ps.exportData.boat, fixed = res.fixedKn, side = (v) => (Number.isFinite(v) ? `${Math.round(Math.abs(v))}${v < 0 ? "P" : "S"}` : "–");
    const wxOn = !!ps.wx, wxTds = (t) => { if (!wxOn) return ""; const w = ps.wxAt(t); return w ? `<td>${fF(w.t2)}</td><td>${visText(w.vis)}</td><td>${rainWord(w) || "–"}</td><td>${Number.isFinite(w.tcc) ? Math.round(w.tcc) : "–"}${Number.isFinite(w.ceil) ? ` / ${(Math.round((w.ceil * 3.28084) / 100) * 100).toLocaleString("en-US")}` : ""}</td>` : "<td colspan=\"4\">–</td>"; };
    const rowsH = ps.analyse(ps.result.pts, boat).rows.map(({ p, prev }) => {
      const r = ps.row(p, prev, boat);
      if (p.m?.hold) return `<tr><td>${ps.fmt(r.t)}</td><td colspan="${fixed ? 5 : 11}">${p.m.gate ? "holding for the tide" : "waiting in harbour"}</td>${wxTds(r.t)}</tr>`;
      return `<tr><td>${ps.fmt(r.t)}</td><td>${ps.brg(r.cog)}</td><td>${ps.brg(r.hdg)}</td><td>${r.sog.toFixed(1)}</td><td>${Number.isFinite(r.bsp) ? r.bsp.toFixed(1) : "–"}</td>`
        + (fixed ? "" : `<td>${r.motor ? (p.m?.narrow ? "motor (narrow)" : "motor") : `${Math.round(r.tws)}/${Math.round(r.gust)}`}</td><td>${r.motor ? "–" : side(r.twa)}</td><td>${Number.isFinite(r.aws) && !r.motor ? `${Math.round(r.aws)} ${side(r.awa)}` : "–"}</td><td>${r.hs.toFixed(1)}</td>`)
        + `<td>${r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)}` : "–"}</td>${fixed ? "" : `<td>${r.sails}</td><td>${esc((p.c?.src || "").replace(/ \(long run\)/, " long"))}</td>`}${wxTds(r.t)}</tr>`;
    }).join("");
    return `<div class="ps-tbl"><table class="hr"><thead><tr><th>Time</th><th>COG</th><th>HDG</th><th>SOG</th><th>STW</th>${fixed ? "" : "<th>TWS/gust</th><th>TWA</th><th>AWS AWA</th><th>Seas ft</th>"}<th>Cur kt</th>${fixed ? "" : "<th>Sails</th><th>Wind from</th>"}${wxOn ? "<th>Air °F</th><th>Vis</th><th>Rain</th><th>Cloud % / ceiling ft</th>" : ""}</tr></thead><tbody>${rowsH}</tbody></table></div>`;
  }

  // ---------- the document (PDF / page) ----------
  // A clean, self-contained report for paper: light, Letter pages with numbers, every section in
  // full (not the window's view).
  async documentHTML() {
    const ps = this.ps, S = ps.summary, R = ps.result;
    if (!S || !R) return null;
    const res = R.res, pts = R.pts, boat = ps.exportData.boat, fixed = res.fixedKn;
    const rows = []; for (let i = 1; i < pts.length; i++) rows.push({ p: pts[i], r: ps.row(pts[i], pts[i - 1], boat), w: ps.wx ? ps.wxAt(pts[i].t) : null });
    const names = ps.wps.map((w) => ps.spotName(w).replace(/^(near|at) /, "")), title = names.map(esc).join(" → ");
    this.items = this.cautionItems(S, res, pts, rows);
    this.stations = this.stationList();
    // (the sensitivity is part of the document: run it now if it hasn't been)
    if ((!ps.sensRows || ps.sensPartial) && !fixed && !res.partial && ps.lastEnv) { this.status?.("Running the sensitivity for the report…"); await ps.sensitivity(ps.lastEnv, boat, document.createElement("div")); }
    const map = await this.buildMap(900);
    const charts = this.charts(pts, rows, fixed).replace(/<div class="rr-read[^]*$/, "");
    const src = S.sources.map((s) => `${esc(s.label)} (run ${Math.round((Date.now() - s.cycle.getTime()) / 3600e3)} h old)`).join(", ");
    const sec = (t, h, cls = "") => (h ? `<section class="${cls}"><h2>${t}</h2>${h}</section>` : "");
    const now = new Date(), tz = ps.ex.region?.tz || "UTC", gen = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(now);
    const body = `<header class="doc-h"><div class="kicker">Passage plan · Wind Volume Explorer</div><h1>${title}</h1>
        <div class="meta"><span><b>Depart</b> ${ps.fmt(S.t0, true)}</span><span><b>ETA</b> ${ps.fmt(S.t1, true)}</span><span><b>Passage</b> ${hm(S.hours)}</span><span><b>Boat</b> ${esc(boatName(boat))}</span><span><b>Bearings</b> ${$("ps-brg")?.value === "mag" ? "°Magnetic" : "°True"}</span></div>
        <div class="meta small">${fixed ? `Currents only, ${fixed} kn through the water.` : `Wind: ${src || "–"}.`} ${S.curLabel ? `Currents: ${S.curLabel}.` : S.fieldStations ? `Currents: NOAA predictions (${S.fieldStations} stations).` : "No currents."} Generated ${gen}.</div></header>
      ${sec("The passage", this.brief(S, res, names, boat).replace(/<p class="rr-route">[^]*?<\/p>/, ""))}
      ${sec("Route map", map, "fig")}
      ${sec("Cautions", this.cautions(this.items))}
      ${sec("Waypoint to waypoint", this.wpTable(names))}
      ${sec("Turn points", this.turnTable(), "brk")}
      ${sec("Currents at stations along the way", this.stationTable(this.stations))}
      ${sec("Along the passage", charts, "fig")}
      ${sec("Legs", this.legs(res, pts, names))}
      ${sec("Why this route", S.whyList.length ? `<ul>${S.whyList.map((w) => `<li>${w}</li>`).join("")}</ul>` : "")}
      ${sec("Where the wind came from", fixed ? "" : S.prov.replace(/<b>Wind from<\/b>/, ""))}
      ${sec("Sensitivity", ps.sensRows && !fixed ? this.sens(true) : "", "brk")}
      ${sec("Models compared", this.models())}
      ${sec("Hour by hour", this.hourTable(), "brk")}
      <footer class="doc-f">Planning, not navigation: model forecasts and predicted tidal currents on a chart-based water mask, with approximate polars. Check the chart, the Coast Pilot, the Light List and the latest forecast before you go. Sources: NOAA (HRRR, RRFS, GFS, CO-OPS current predictions, ENC and Chart Display Service), ECMWF open data (CC BY 4.0) where used.</footer>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Passage plan: ${names.map(esc).join(" to ")}</title><style>${DOC_CSS.replace("%FOOT%", `${names[0]} → ${names.at(-1)} · planning, not navigation`.replace(/"/g, "'"))}</style></head><body>${body}</body></html>`;
  }
  // Print the document (the browser's dialog: choose Save as PDF) from a hidden frame.
  async printDoc() {
    this.status("Preparing the PDF…");
    const html = await this.documentHTML();
    this.render();
    if (!html) return;
    this.frame?.remove();
    const f = (this.frame = document.createElement("iframe"));
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.append(f);
    f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
    await new Promise((r) => (f.contentDocument.readyState === "complete" ? r() : f.contentWindow.addEventListener("load", r, { once: true })));
    await Promise.all([...f.contentDocument.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    f.contentWindow.focus(); f.contentWindow.print();
  }
  // The document as a page in a new tab.
  async openDoc() {
    const w = open("", "_blank");                               // (opened at once, so it isn't blocked)
    w?.document.write("<p style='font:14px system-ui;padding:20px'>Preparing the passage plan…</p>");
    this.status("Preparing the report…");
    const html = await this.documentHTML();
    this.render();
    if (!html) { w?.close(); return; }
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "text/html" })); a.target = "_blank"; a.click(); }
  }

  // Current stations within 1.5 nm of the route, in the order passed: NOAA's prediction as the boat
  // passes, fair or foul for it, and the slack and max times either side, to check against NOAA's
  // tables (linked). (Estimated stations, e.g. the Swinomish Channel, are marked as such.)
  stationList() {
    const ps = this.ps, F = ps.routeField, pts = ps.result?.pts;
    if (!F || !pts?.length) return [];
    const out = [];
    for (const st of F.stations) {
      let best = null;
      for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - st.x, pts[i].y - st.y); if (!best || d < best.d) best = { d, i }; }
      if (best && best.d <= 1.5 * NM) out.push({ st, ...best });
    }
    return out.sort((a, b) => pts[a.i].t - pts[b.i].t).slice(0, 40);
  }
  stationTable(list) {
    const ps = this.ps, pts = ps.result.pts;
    if (!list.length) return ps.routeField ? `<p class="note">No current prediction station within 1.5 nm of the route.</p>` : "";
    const ev = (e) => (!e ? "–" : `${e.type === "slack" ? "slack" : `max ${e.type} ${Math.abs(e.v).toFixed(1)} kt`} ${ps.fmt(e.t).replace(/^\w+ /, "")}`);
    const kind = (st) => (st.type === "H" ? "reference" : st.type === "S" ? "subordinate" : "estimated");
    const S = ps.routeField?.sscofs;                                // (SSCOFS in use: its current at the station then, beside NOAA's)
    const sc = (st, t) => { const q = S?.covers(t) && S.sample(st.x, st.y, t); if (!q) return "–"; const kt = Math.hypot(q.u, q.v) / 0.514444; return kt < 0.1 ? "slack" : `${kt.toFixed(1)} kt → ${ps.brg(((Math.atan2(q.u, q.v) * 180) / Math.PI + 360) % 360)}`; };
    const rowsH = list.map((q, k) => {
      const st = q.st, p = pts[q.i], a = pts[q.i - 1], t = p.t, v = stationSpeed(st, t), dir = v >= 0 ? st.flood : st.ebb;
      const cog = (Math.atan2(p.x - a.x, p.y - a.y) * 180) / Math.PI, along = Math.abs(v) * Math.cos(((dir - cog) * Math.PI) / 180);
      const i = st.ev.findIndex((e) => e.t > t), before = st.ev[i - 1], after = st.ev[i];
      const id = st.type === "E" ? `<span class="note">${esc(st.note || "estimated")}</span>` : `<a href="https://tidesandcurrents.noaa.gov/noaacurrents/predictions.html?id=${st.id}_${st.bin ?? 1}" target="_blank" rel="noopener">${st.id}${st.bin ? ` bin ${st.bin}` : ""}</a>`;
      return `<tr><td><b>S${k + 1}</b></td><td>${esc(st.name)}<br><span class="note">${kind(st)} · ${id}</span></td><td>${ps.fmt(t)}<br><span class="note">${(q.d / NM).toFixed(1)} nm off</span></td>`
        + `<td>${Math.abs(v) < 0.1 ? "slack" : `${v >= 0 ? "flood" : "ebb"} ${Math.abs(v).toFixed(1)} kt → ${ps.brg(dir)}`}</td>`
        + `<td class="${along > 0.3 ? "fair" : along < -0.3 ? "foul" : ""}">${Math.abs(along) < 0.3 ? "across / slack" : `${along > 0 ? "fair" : "foul"} ${Math.abs(along).toFixed(1)} kt`}</td><td>${ev(before)}<br>${ev(after)}</td>${S ? `<td>${sc(st, t)}</td>` : ""}</tr>`;
    }).join("");
    return `<div class="ps-tbl"><table><thead><tr><th>#</th><th>Station</th><th>Boat passes</th><th title="NOAA's predicted current at the station then: flood or ebb, speed, and the direction it sets toward">Predicted current</th><th title="The part along the boat's course there">For the boat</th><th>Before · after</th>${S ? `<th title="SSCOFS (the model the plan used here) at the station, then: to compare with NOAA's prediction">SSCOFS then</th>` : ""}</tr></thead><tbody>${rowsH}</tbody></table></div>
      <p class="note">NOAA's tidal current predictions at the stations within 1.5 nm of the route, in the order the boat passes them (numbered S1… on the map), with the slack or maximum just before and after, to check against NOAA's tables (station links). Reference stations have their own harmonic predictions; subordinate ones are offsets from a reference. Between stations the planner blends the nearest (within 5 km, over water); the plan uses the same values. Estimated stations aren't NOAA's (see their note). Directions ${this.brgNote()}.</p>`;
  }

  legs(res, pts, names) {
    const L = res.legs || [];
    if (L.length < 1) return "";
    const ps = this.ps, rowsH = L.map((g) => {
      const P = pts.filter((p) => p.t >= g.t0 && p.t <= g.t1); let d = 0, mot = 0;
      for (let i = 1; i < P.length; i++) { d += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); if (P[i].m?.motor) mot += (P[i].t - P[i - 1].t) / 3600e3; }
      const h = (g.t1 - g.t0) / 3600e3;
      return `<tr><td>${g.from + 1}. ${esc(names[g.from])} → ${esc(names[g.to])}</td><td>${ps.fmt(g.t0)}</td><td>${ps.fmt(g.t1)}</td><td>${hm(h)}</td><td>${(d / NM).toFixed(1)}</td><td>${(d / NM / Math.max(0.05, h)).toFixed(1)}</td><td>${mot > 0.02 ? hm(mot) : "–"}</td></tr>`;
    }).join("");
    return `<div class="ps-tbl"><table><thead><tr><th>Leg</th><th>Leave</th><th>Arrive</th><th>Time</th><th>nm sailed</th><th title="Average speed over the ground">SOG</th><th>Motoring</th></tr></thead><tbody>${rowsH}</tbody></table></div>`;
  }

  sens(forDoc = false) {
    const ps = this.ps;
    if (this.sensRunning) return `<p class="note">Routing the variations…</p><div id="rr-sens-live"></div>`;
    if (!ps.sensRows) return `<p><button class="btn mini" id="rr-run-sens">Run the sensitivity</button></p><p class="note">Routes the passage again with the wind 15% lighter and stronger, the boat sailing 10% and 20% slower and faster, without the currents, and leaving an hour at a time up to 6 h later (and earlier while that's still ahead of now), loading a longer forecast where one is needed: how much the plan depends on each (about 20–40 seconds).</p>`;
    const rows = ps.sensRows, b0 = rows[0]?.h, plan = rows[0];
    if (!Number.isFinite(b0)) return `<p class="note">The baseline couldn't be routed at the coarser resolution.</p>`;
    const other = [plan, ...rows.slice(1).filter((r) => r.dep == null)], deps = rows.filter((r) => r.dep != null);
    const d = (r) => (r === plan ? "–" : `${r.h >= b0 ? "+" : "−"}${hm(Math.abs(r.h - b0))}`);
    // 1. The changes: bars from a centre line (the plan), faster left, slower right.
    const ok = other.slice(1).filter((r) => Number.isFinite(r.h)), maxD = Math.max(0.25, ...ok.map((r) => Math.abs(r.h - b0)));
    const W = 640, row = 24, L = 150, mid = L + (W - L - 70) / 2, half = (W - L - 70) / 2, H = other.length * row + 26;
    const g = [`<line x1="${mid}" x2="${mid}" y1="4" y2="${H - 18}" class="rr-grid zero"/>`, `<text x="${mid - 6}" y="${H - 4}" class="rr-ax" text-anchor="end">◂ faster</text><text x="${mid + 6}" y="${H - 4}" class="rr-ax">slower ▸</text>`];
    other.forEach((r, i) => {
      const y = 6 + i * row;
      g.push(`<text x="${L - 8}" y="${y + 13}" class="rr-lab" text-anchor="end">${esc(r.name)}</text>`);
      if (r.fail) { g.push(`<text x="${mid + 6}" y="${y + 13}" class="rr-ax">no route</text>`); return; }
      if (i === 0) { g.push(`<text x="${mid + 6}" y="${y + 13}" class="rr-ax">${hm(r.h)} (the plan)</text>`); return; }
      const dd = r.h - b0, w = (Math.abs(dd) / maxD) * half, x = dd > 0 ? mid : mid - w;
      g.push(`<rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(1, w).toFixed(1)}" height="${row - 8}" rx="3" fill="${dd > 0 ? FOUL : FAIR}"/><text x="${(dd > 0 ? mid + w + 5 : mid - w - 5).toFixed(1)}" y="${y + 13}" class="rr-val" text-anchor="${dd > 0 ? "start" : "end"}">${d(r)}</text>`);
    });
    // 2. Departures: passage time for each (the plan's highlighted), arrival under each bar.
    let depSvg = "";
    if (deps.length) {
      const all = [...deps, { ...plan, dep: 0 }].sort((p, q) => p.dep - q.dep), okD = all.filter((r) => Number.isFinite(r.h));
      const W2 = 640, H2 = 170, L2 = 34, T2 = 18, B2 = 44, hi = Math.max(1, ...okD.map((r) => r.h)) * 1.12, bw = (W2 - L2 - 8) / all.length;
      const Y = (v) => T2 + (1 - v / hi) * (H2 - T2 - B2), best = okD.reduce((p, q) => (q.h < p.h ? q : p), okD[0]);
      const gd = [];
      for (const v of niceTicks(0, hi, 3)) gd.push(`<line x1="${L2}" x2="${W2 - 8}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="rr-grid"/><text x="${L2 - 4}" y="${(Y(v) + 3).toFixed(1)}" class="rr-ax" text-anchor="end">${fmtN(v)} h</text>`);
      all.forEach((r, i) => {
        const x = L2 + i * bw, cx = x + bw / 2, dep = ps.fmt(r.start ?? plan.start + r.dep * 3600e3).replace(/^\w+ /, "");
        if (Number.isFinite(r.h)) gd.push(`<rect x="${(x + 3).toFixed(1)}" y="${Y(r.h).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${(Y(0) - Y(r.h)).toFixed(1)}" rx="3" fill="${r.dep === 0 ? C2 : C1}" fill-opacity="${r === best || r.dep === 0 ? 1 : 0.55}"/><text x="${cx.toFixed(1)}" y="${(Y(r.h) - 4).toFixed(1)}" class="rr-val" text-anchor="middle">${hm(r.h).replace(/m$/, "")}</text>`);
        else gd.push(`<text x="${cx.toFixed(1)}" y="${(Y(0) - 6).toFixed(1)}" class="rr-ax" text-anchor="middle">none</text>`);
        gd.push(`<text x="${cx.toFixed(1)}" y="${H2 - B2 + 14}" class="rr-ax" text-anchor="middle">${r.dep === 0 ? "plan" : `${r.dep > 0 ? "+" : "−"}${Math.abs(r.dep)} h`}</text><text x="${cx.toFixed(1)}" y="${H2 - B2 + 26}" class="rr-ax" text-anchor="middle">${esc(dep)}</text>${Number.isFinite(r.h) ? `<text x="${cx.toFixed(1)}" y="${H2 - B2 + 38}" class="rr-ax" text-anchor="middle">→ ${esc(ps.fmt(r.eta).replace(/^\w+ /, ""))}</text>` : ""}`);
      });
      depSvg = `<h4>Departure time</h4><svg viewBox="0 0 ${W2} ${H2}" class="rr-sens">${gd.join("")}</svg><p class="note">Passage time for each departure (bar height, the number on top), with the departure and the arrival under it. The plan's departure in orange; the quickest in full blue.${deps.some((r) => r.dep < 0) ? "" : " No earlier departures: they'd be in the past or before the forecast."}</p>`;
    }
    const table = (list, first) => `<div class="ps-tbl"><table><thead><tr><th>${first}</th><th>Leave</th><th>Passage</th><th>ETA</th><th>vs plan</th><th>Max gust</th><th>Tacks</th></tr></thead><tbody>${list.map((r) => (r.fail ? `<tr><td>${esc(r.name)}</td><td colspan="6">no route: ${esc(r.fail)}</td></tr>` : `<tr><td>${esc(r.name)}</td><td>${ps.fmt(r.start)}</td><td>${hm(r.h)}</td><td>${ps.fmt(r.eta)}</td><td>${d(r)}</td><td>${Math.round(r.g)} kt</td><td>${r.tk}</td></tr>`)).join("")}</tbody></table></div>`;
    return `${ps.sensSummary(rows)}<h4>What if</h4><svg viewBox="0 0 ${W} ${H}" class="rr-sens">${g.join("")}</svg>${table(other, "Change")}
      ${depSvg}${deps.length ? table([plan, ...deps.sort((p, q) => p.dep - q.dep)], "Departure") : ""}
      <p class="note">Each routed again the same way as the plan (same time step and headings) with one change. A plan that moves a lot with small changes deserves a margin.${forDoc ? "" : ` <button class="btn mini" id="rr-run-sens">Run again</button>`}</p>`;
  }
  async runSens() {
    const ps = this.ps;
    this.sensRunning = true; this.render();
    const live = this.body.querySelector("#rr-sens-live") || document.createElement("div");
    try { await ps.sensitivity(ps.lastEnv, ps.exportData.boat, live); } finally { if (this.sensRunning) { this.sensRunning = false; this.render(); } }
  }

  models() {
    const C = this.ps.compare;
    if (!C?.out?.length) return "";
    const src = document.querySelector("#ps-out .ps-cmp");
    return src ? src.innerHTML.replace(/<b>Compare models<\/b>/, "") : "";
  }
  table() {
    const t = $("ps-hourly");
    return t ? `<div class="ps-tbl">${t.innerHTML}</div><p class="note">Click a row to show that time on the map.</p>` : "";
  }
}

function niceTicks(lo, hi, n) {
  const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n + 0.5) || mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
const fmtN = (v) => (Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : String(Math.round(v)));

const dm = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return `${d}° ${m.toFixed(2).padStart(5, "0")}′ ${v >= 0 ? pos : neg}`; };
const dmShort = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 60); return `${d}°${m ? `${String(m).padStart(2, "0")}′` : ""}${v >= 0 ? pos : neg}`; };
const boatName = (b) => (b.key === "cg31" ? "Cape George 31" : b.key === "ps37" ? "Pacific Seacraft 37" : b.key);

// The document's own styles: light, for paper (Letter, margins, page numbers in the footer).
const DOC_CSS = `
@page { size: letter; margin: 13mm 12mm 15mm; @bottom-left { content: "%FOOT%"; font: 8pt system-ui, sans-serif; color: #667; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt system-ui, sans-serif; color: #667; } }
:root { --rr-c1: #1f6fb2; --rr-c2: #c2620f; --rr-fair: #1c8c74; --rr-foul: #c8452f; --rr-fog: #6a4fc2; --rr-cloud: #62767d; --ink: #16232a; --soft: #56666e; --grid: #d5dde0; --caution: #b5471f; }
* { box-sizing: border-box; } html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 10pt/1.4 "Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); max-width: 7.6in; margin: 0 auto; padding: 16px; background: #fff; }
@media print { body { padding: 0; max-width: none; } }
.doc-h { border-bottom: 2px solid var(--ink); padding-bottom: 8px; margin-bottom: 10px; }
.kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 8pt; color: var(--soft); }
h1 { font-size: 17pt; margin: 2px 0 6px; line-height: 1.2; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 9.5pt; } .meta.small { font-size: 8.5pt; color: var(--soft); margin-top: 4px; }
h2 { font-size: 12pt; margin: 14px 0 6px; padding-bottom: 2px; border-bottom: 1px solid var(--grid); }
section { break-inside: auto; } section.fig, figure, .rr-chart, .ps-sum { break-inside: avoid; } section.brk { break-before: page; }
h2 { break-after: avoid; }
.note { color: var(--soft); font-size: 8.5pt; } .warn { color: var(--caution); }
.ps-sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 4px 0 6px; }
.ps-sum > div { border: 1px solid var(--grid); border-radius: 4px; padding: 4px 6px; }
.ps-sum span { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--soft); }
.ps-sum b { display: block; font-size: 10.5pt; } .ps-sum i { display: block; font-style: normal; font-size: 8pt; color: var(--soft); }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; font-variant-numeric: tabular-nums; }
th { text-align: left; background: #eef2f3; border-bottom: 1px solid #b9c4c8; padding: 3px 4px; font-weight: 600; }
td { border-bottom: 1px solid #e3e8ea; padding: 2.5px 4px; vertical-align: top; } tr { break-inside: avoid; }
table.hr { font-size: 7.8pt; } thead { display: table-header-group; }
ol.rr-caut, ul { margin: 4px 0; padding-left: 20px; } li { margin: 2px 0; }
figure { margin: 4px 0; } svg { width: 100%; height: auto; display: block; }
.rm { border: 1px solid #9fb0b6; }
.rm-grid { stroke: #7c8f96; stroke-width: .5; stroke-opacity: .55; } .rm-gl { font: 8px system-ui, sans-serif; fill: #3d5058; paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.rm-sail { stroke: var(--rr-c1); stroke-width: 3; fill: none; } .rm-motor { stroke: #59646a; stroke-width: 3; stroke-dasharray: 6 4; fill: none; }
.rm-tack { fill: #fff; stroke: #16232a; stroke-width: 1; } .rm-gybe { fill: var(--rr-c1); stroke: #fff; stroke-width: 1; } .rm-hr { fill: #16232a; stroke: #fff; stroke-width: 1; }
.rm-t { font: 9px system-ui, sans-serif; fill: #16232a; paint-order: stroke; stroke: #fff; stroke-width: 3px; }
.rm-wp { font: 600 10.5px system-ui, sans-serif; fill: #16232a; paint-order: stroke; stroke: #fff; stroke-width: 3.5px; }
.rm-start { fill: #2e9e5b; stroke: #fff; stroke-width: 2; } .rm-end { fill: #c8452f; stroke: #fff; stroke-width: 2; } .rm-via { fill: #d9a31a; stroke: #fff; stroke-width: 2; }
.rm-caut { fill: #b5471f; stroke: #fff; stroke-width: 1.5; } .rm-cn { font: 700 9px system-ui, sans-serif; fill: #fff; }
.rm-stn { fill: #1c8c74; stroke: #fff; stroke-width: 1; } .rm-sn { font: 700 8.5px system-ui, sans-serif; fill: #135e4e; paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.k-stn { width: 0 !important; height: 0 !important; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid #1c8c74; background: none !important; border-radius: 0 !important; }
td.fair { color: #1c8c74; font-weight: 600; } td.foul { color: #c8452f; font-weight: 600; } a { color: #1f6fb2; }
.rm-scale { stroke: #16232a; stroke-width: 2; } .rm-plate { fill: #fff; fill-opacity: .8; } .rm-north { fill: #16232a; }
.rm-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 8.5pt; margin: 4px 0 2px; } .rm-legend i { display: inline-block; width: 18px; height: 4px; margin-right: 4px; vertical-align: middle; border-radius: 2px; }
.k-sail { background: var(--rr-c1); } .k-motor { background: repeating-linear-gradient(90deg, #59646a 0 6px, transparent 6px 10px); } .k-tack { width: 7px !important; height: 7px !important; background: #fff; border: 1px solid #16232a; transform: rotate(45deg); } .k-gybe { width: 7px !important; height: 7px !important; border-radius: 50% !important; background: var(--rr-c1); } .k-hr { width: 6px !important; height: 6px !important; border-radius: 50% !important; background: #16232a; } .k-caut { width: 10px !important; height: 10px !important; border-radius: 50% !important; background: #b5471f; }
.rr-charts { display: grid; gap: 2px; } .rr-ct { font-size: 8.5pt; display: flex; gap: 10px; align-items: baseline; } .rr-key { color: var(--soft); } .rr-key i { display: inline-block; width: 12px; height: 3px; margin-right: 3px; vertical-align: middle; }
.rr-grid { stroke: var(--grid); stroke-width: 1; } .rr-grid.zero { stroke: #8a979c; } .rr-ax { fill: var(--soft); font: 9px system-ui, sans-serif; } .rr-ax.lim { fill: var(--caution); }
.rr-lim { stroke: var(--caution); stroke-dasharray: 4 3; stroke-width: 1.2; } .rr-dark { fill: #16232a; fill-opacity: .07; } .rr-motor { fill: #6d7a80; } .rr-hold { fill: var(--rr-c1); } .rr-x { display: none; }
.rr-lab { fill: var(--ink); font: 10px system-ui, sans-serif; } .rr-val { fill: var(--ink); font: 10px system-ui, sans-serif; }
.ps-prov ul { margin: 2px 0; } .doc-f { margin-top: 16px; border-top: 1px solid var(--grid); padding-top: 6px; font-size: 8pt; color: var(--soft); }
`;
