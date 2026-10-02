// "Channel analysis (experimental)": the panel for model/channel.js's diagnostics. Collapsed by
// default; only for subareas with a channelAnalysis block in regions.json (the ʻAlenuihāhā,
// the Strait of Juan de Fuca, Puget Sound). Nothing else on the page depends on it: closed, it
// loads nothing and draws nothing.
//
//   profile   four small charts sharing the along-channel distance (upstream on the left):
//             10 m wind, sea-level pressure, cap depth, two-layer Froude number (the chosen cap
//             definition bold, the other three thin: the sensitivity band). Hover for values
//             and a marker on the map.
//   numbers   speed-up, along-channel Δp and the Bernoulli estimates, Froude and jumps, the
//             upstream regime per bordering barrier, the 10 kt/mb pressure rule (model and
//             observed pressures), and the cap-definition sensitivity table with advice.
// The explainer: channel-analysis.html.

import * as THREE from "three";
import { ChannelFrame } from "./shell/geo.js?v=20261002173952";
import { compass } from "./shell/views.js?v=20261002173952";
import { CAP_DEFS, DEFAULT_PARAMS, channelProfile, summarize, mslpAt, froudeField } from "./model/channel.js?v=20261002173952";
import { DYN } from "./layers/slice.js?v=20261002173952";
import { fmtSpeed, fromKt, unitLabel } from "./units.js?v=20261002173952";

const $ = (id) => document.getElementById(id);
const KT = 1.943844;
const n0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "–");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export class ChannelPanel {
  constructor(explore) {
    this.x = explore;
    this.obs = new Map();                    // station id → {p (mb), time}
    this.marker = new THREE.Group();
    explore.stage.scene.add(this.marker);
    $("ca").addEventListener("toggle", () => { this.x.checkNeeds(); this.update(true); if ($("ca").open) this.fetchObs(); this.saveLink(); });
    $("ca-sub").addEventListener("change", () => { this.update(true); this.fetchObs(); });
    $("ca-def").addEventListener("change", () => { this.showSliders(); this.changed(); });
    for (const id of ["ca-lapse", "ca-offset", "ca-rh", "ca-window"]) $(id).addEventListener("input", () => { this.showSliders(); clearTimeout(this.t); this.t = setTimeout(() => this.changed(), 120); });
    $("ca-reset").addEventListener("click", () => { this.applyDefaults(); this.changed(); });
    const cv = $("ca-chart");
    cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); this.hoverX = (e.clientX - r.left) / r.width; this.drawChart(); });
    cv.addEventListener("pointerleave", () => { this.hoverX = null; this.drawChart(); });
    // Station pressures: every 10 min while open and the tab is visible; on return after 10+ min.
    setInterval(() => { if ($("ca").open && !document.hidden) this.fetchObs(); }, 10 * 60e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && $("ca").open && Date.now() - (this.lastObs || 0) > 10 * 60e3) this.fetchObs(); });
  }

  get sub() { return this.subs?.find((s) => s.id === $("ca-sub").value) || null; }
  get active() { return !!(this.sub && $("ca").open); }
  // The Froude colouring needs the same fields even with the panel shut.
  get wantsFields() { return this.active || this.x.spec.field === "froude"; }

  setRegion(region) {
    this.region = region;
    this.subs = (region.subareas || []).filter((s) => s.axis && s.channelAnalysis);
    $("ca").hidden = !this.subs.length;
    $("ca-sub").innerHTML = this.subs.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
    this.applyDefaults();
    this.pts = null; this.sum = null;
    this.clearMarker();
    this.obs.clear();
  }
  // A view of a subarea with an analysis selects it.
  onView(subId) { if (subId && this.subs?.some((s) => s.id === subId) && $("ca-sub").value !== subId) { $("ca-sub").value = subId; this.applyDefaults(); this.update(true); } }

  applyDefaults() {
    const d = { ...DEFAULT_PARAMS, def: "detector", ...(this.sub?.channelAnalysis.capDefault || {}) };
    $("ca-def").innerHTML = Object.entries(CAP_DEFS).map(([k, l]) => `<option value="${k}">${l}${k === d.def ? " (default here)" : ""}</option>`).join("");
    $("ca-def").value = d.def;
    $("ca-lapse").value = d.lapseKkm; $("ca-offset").value = d.thetaOffsetK; $("ca-rh").value = d.rhPct; $("ca-window").value = d.windowM;
    this.showSliders();
  }
  params() { return { lapseKkm: +$("ca-lapse").value, thetaOffsetK: +$("ca-offset").value, rhPct: +$("ca-rh").value, windowM: +$("ca-window").value }; }
  showSliders() {
    const def = $("ca-def").value;
    $("ca-lapse-row").hidden = def !== "detector";
    $("ca-offset-row").hidden = def !== "isentrope";
    $("ca-rh-row").hidden = def !== "rh";
    $("ca-window-row").hidden = def === "detector";
    $("ca-lapse-val").textContent = `${(+$("ca-lapse").value).toFixed(1)} K/km`;
    $("ca-offset-val").textContent = `+${(+$("ca-offset").value).toFixed(1)} K`;
    $("ca-rh-val").textContent = `${$("ca-rh").value}%`;
    $("ca-window-val").textContent = `${$("ca-window").value} m`;
  }
  changed() {
    DYN.froude = null; DYN.froudeKey = null;               // the Froude colouring follows the cap choice
    this.update(true);
    if (this.x.spec.field === "froude") this.x.redraw();
    this.saveLink();
  }
  saveLink() { this.x.onChange?.(); }

  // The Froude field for the slice colouring (nearest hour; cached per hour and cap settings).
  ensureField() {
    const V = this.x.nearest?.();
    if (!V) return;
    const def = $("ca-def").value, key = `${V.raw.fhr}|${V.raw.cycle?.getTime?.()}|${def}|${JSON.stringify(this.params())}|${V.raw.version ?? ""}`;
    if (DYN.froudeKey === key) return;
    DYN.froude = froudeField(V, def, this.params());
    DYN.froudeKey = key;
  }

  // Recompute for the time on screen (throttled while playing).
  update(force = false) {
    const X = this.x;
    if (!this.active || !X.vol) { if (!this.active) this.clearMarker(); return; }
    if (!force && X.playing && this.lastT && performance.now() - this.lastT < 500) return;
    this.lastT = performance.now();
    const s = this.sub, ca = s.channelAnalysis;
    this.frame = new ChannelFrame(s);
    this.pts = channelProfile(X.vol, this.frame, s.viewBox, { surf: X.surf, prm: this.params() });
    this.sum = summarize(this.pts, { def: $("ca-def").value, barriers: ca.barriers });
    this.pairs = (ca.pressurePairs || []).map((pp) => {
      const pa = mslpAt(X.vol, pp.a.lat, pp.a.lon), pb = mslpAt(X.vol, pp.b.lat, pp.b.lon);
      const oa = this.obs.get(pp.a.id), ob = this.obs.get(pp.b.id);
      return { ...pp, model: pa - pb, obs: oa && ob ? oa.p - ob.p : NaN, obsAge: oa && ob ? Math.max(Date.now() - oa.time, Date.now() - ob.time) : NaN };
    });
    this.render();
  }

  // Latest station pressure (NWS API: sea-level pressure, else the barometric value it gives).
  async fetchObs() {
    this.lastObs = Date.now();
    const ids = new Set();
    for (const s of this.subs || []) for (const pp of s.channelAnalysis.pressurePairs || []) { ids.add(pp.a.id); ids.add(pp.b.id); }
    await Promise.all([...ids].map(async (id) => {
      try {
        const r = await fetch(`https://api.weather.gov/stations/${encodeURIComponent(id)}/observations?limit=6`, { headers: { Accept: "application/geo+json" } });
        if (!r.ok) return;
        const f = ((await r.json()).features || []).find((q) => (q.properties?.seaLevelPressure?.value ?? q.properties?.barometricPressure?.value) != null);
        if (!f) return;
        const p = f.properties;
        this.obs.set(id, { p: (p.seaLevelPressure?.value ?? p.barometricPressure.value) / 100, time: Date.parse(p.timestamp) });
      } catch { /* offline or blocked: model only */ }
    }));
    if (this.active) this.update(true);
  }

  render() {
    const s = this.sum, sub = this.sub, ca = sub.channelAnalysis, def = $("ca-def").value, u = unitLabel();
    this.drawChart();
    if (!s) { $("ca-numbers").innerHTML = `<p class="note">Not enough of the channel is inside the model domain.</p>`; return; }
    const flowBrg = s.down ? sub.axis.downstreamBearingDeg : (sub.axis.downstreamBearingDeg + 180) % 360;
    const hasP = Number.isFinite(s.dp);
    const sel = s.byDef[def];
    const rows = [];
    rows.push(["Flow", `toward ${compass(flowBrg)} (${String(Math.round(flowBrg)).padStart(3, "0")}°) along the axis`]);
    rows.push(["Upstream 10 m wind", fmtSpeed(s.u0 * KT)]);
    rows.push(["Fastest 10 m wind", `${fmtSpeed(s.umax * KT)} at ${n0(s.atAlong)} km · speed-up ×${f2(s.ratio)}`]);
    rows.push(["Δp upstream → fastest", hasP ? `${f1(s.dp)} mb` : "no sea-level pressure in this model"]);
    if (hasP) rows.push(["Bernoulli (from Δp)", `≤ ${fmtSpeed(s.bern * KT)} · with friction (×0.55) ${fmtSpeed(s.bern55 * KT)}${s.warmExit ? ` <span class="caution">· exit warmer than upstream: unreliable</span>` : ""}`]);
    rows.push([`Froude (${CAP_DEFS[def].toLowerCase()})`, sel ? `${f2(sel.fr)} at the fastest point · ${Number.isFinite(s.superFrac) ? `${Math.round(s.superFrac * 100)}% of the axis supercritical` : ""}${s.jumps.length ? ` · jump${s.jumps.length > 1 ? "s" : ""} near ${s.jumps.map((a) => `${n0(a)} km`).join(", ")}` : ""}` : "no cap found here by this definition"]);
    for (const r of s.regimes) rows.push([`Regime: ${r.name} (${n0(r.heightM)} m)`, `${Number.isFinite(r.eps) ? `ε = Nh/U ${f1(r.eps)} · ${r.cls}` : "–"}${r.aboveCap ? ` · above the cap (${n0(r.capUp)} m): blocks the flow below it` : r.aboveCap === false ? " · below the cap" : ""}`]);
    for (const p of this.pairs) {
      const est = (dp) => (Number.isFinite(dp) ? `${Math.round(Math.abs(dp) * p.ktPerMb)} kt ${dp >= 0 ? p.positive : opposite(p.positive)}` : "–");
      rows.push([`${p.ktPerMb} kt/mb: ${p.a.id} − ${p.b.id}`, `model ${f1(p.model)} mb → ${est(p.model)}${Number.isFinite(p.obs) ? ` · observed ${f1(p.obs)} mb → ${est(p.obs)}` : " · observed: –"}`]);
    }
    // Sensitivity: the four cap definitions at the fastest point.
    const sens = Object.entries(CAP_DEFS).map(([k, l]) => {
      const c = s.byDef[k];
      return `<tr class="${k === def ? "sel" : ""}"><td>${l}${k === ca.capDefault?.def ? " ★" : ""}</td><td>${c ? n0(c.D) : "–"}</td><td>${c ? f1(c.dth) : "–"}</td><td>${c ? f2(c.fr) : "–"}</td></tr>`;
    }).join("");
    const advice = [];
    const found = Object.values(s.byDef).filter(Boolean).length;
    if (!found) advice.push("No definition finds a cap at the fastest point: the flow is well mixed here, and the two-layer Froude number doesn't apply. Use the regime line and the pressure numbers instead.");
    else if (s.robust) advice.push(`The definitions that find a cap (${found} of 4) all put the fastest point on the same side of Fr = 1${Number.isFinite(s.spread) ? ` (spread ${f2(s.spread)})` : ""}: the sub/supercritical call is <b>robust</b>.`);
    else advice.push(`The definitions disagree about Fr = 1 at the fastest point (spread ${f2(s.spread)}): treat the sub/supercritical call as <b>uncertain</b> this hour.`);
    if (!s.byDef.detector && found) advice.push("The detector finds no sharp inversion; the isentrope and humidity definitions can then latch onto weak gradients.");
    if (def !== ca.capDefault?.def) advice.push(`The default here is the ${CAP_DEFS[ca.capDefault.def].toLowerCase()} (★).`);
    advice.push(ca.capNote);
    $("ca-numbers").innerHTML = `<dl class="ca-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="ca-h">Cap-layer sensitivity at the fastest point</div>
      <table class="ca-sens"><tr><th>Definition</th><th>Depth m</th><th>Δθ K</th><th>Fr</th></tr>${sens}</table>
      <p class="note">${advice.join(" ")}</p>
      <p class="note">Experimental: diagnostics from the literature, computed from this model hour. Models can underestimate the along-strait pressure difference (~30% in Colle &amp; Mass 2000). Speeds in ${u}; barbs and the rule itself are in knots. <a href="channel-analysis.html" target="_blank" rel="noopener">How this works ↗</a></p>`;
  }

  // Four small multiples on one shared x (distance along the axis, upstream on the left).
  drawChart() {
    const cv = $("ca-chart"), s = this.sum, pts = this.pts;
    const W = cv.clientWidth || 260, lab = 14, rowH = 44, gap = 8, top = 2, H = top + 4 * (lab + rowH) + 3 * gap + 18, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
    const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    if (!pts || !s) return;
    const ink = css("--ink") || "#132A32", soft = css("--ink-soft") || "#4C626B", grid = css("--grid") || "#D3DBDE", sea = css("--sea") || "#0E7C8B", caution = css("--caution") || "#C15A2B";
    const order = s.down ? pts : [...pts].reverse(), n = order.length, L = 40, R = W - 6;
    const xOf = (k) => L + ((R - L) * k) / (n - 1);
    const def = $("ca-def").value;
    const rowsDef = [
      { label: `10 m wind (${unitLabel()})`, series: [{ v: order.map((p) => fromKt(p.wind * KT)), c: sea, w: 2 }], ref: null },
      { label: "Sea-level pressure (mb)", series: [{ v: order.map((p) => p.mslp), c: ink, w: 1.6 }], ref: null },
      { label: "Cap depth (m)", series: [...Object.keys(CAP_DEFS).filter((d) => d !== def).map((d) => ({ v: order.map((p) => p.caps[d]?.D ?? NaN), c: soft, w: 1, a: 0.55 })),
        { v: order.map((p) => p.caps[def]?.D ?? NaN), c: sea, w: 2 }], ref: null },
      { label: "Froude number", series: [...Object.keys(CAP_DEFS).filter((d) => d !== def).map((d) => ({ v: order.map((p) => p.caps[d]?.fr ?? NaN), c: soft, w: 1, a: 0.55 })),
        { v: order.map((p) => p.caps[def]?.fr ?? NaN), c: sea, w: 2 }], ref: 1, clamp: [0, 2.5] },
    ];
    g.font = "10px 'IBM Plex Mono', monospace"; g.textBaseline = "middle";
    rowsDef.forEach((row, ri) => {
      const yl = top + ri * (lab + rowH + gap), y0 = yl + lab, y1 = y0 + rowH;
      g.textAlign = "left"; g.fillStyle = ink; g.fillText(row.label, L, yl + lab / 2);          // the row's title, above its plot
      let lo = Infinity, hi = -Infinity;
      for (const sr of row.series) for (const x of sr.v) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      if (row.clamp) { lo = row.clamp[0]; hi = Math.min(row.clamp[1], Math.max(hi, 1.5)); }
      if (!Number.isFinite(lo)) { g.fillStyle = soft; g.fillText("none by any definition", L, y0 + rowH / 2); return; }
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      const yOf = (v) => y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * rowH;
      g.strokeStyle = grid; g.lineWidth = 1; g.beginPath(); g.moveTo(L, y1 + 0.5); g.lineTo(R, y1 + 0.5); g.stroke();
      if (row.ref != null && row.ref > lo && row.ref < hi) {                    // Fr = 1, and supercritical shaded
        g.fillStyle = caution; g.globalAlpha = 0.08; g.fillRect(L, y0, R - L, yOf(row.ref) - y0); g.globalAlpha = 1;
        g.setLineDash([3, 3]); g.strokeStyle = caution; g.beginPath(); g.moveTo(L, yOf(row.ref)); g.lineTo(R, yOf(row.ref)); g.stroke(); g.setLineDash([]);
      }
      for (const sr of row.series) {
        g.strokeStyle = sr.c; g.lineWidth = sr.w; g.globalAlpha = sr.a ?? 1; g.beginPath();
        let pen = false;
        sr.v.forEach((v, k) => { if (!Number.isFinite(v)) { pen = false; return; } if (pen) g.lineTo(xOf(k), yOf(v)); else { g.moveTo(xOf(k), yOf(v)); pen = true; } });
        g.stroke(); g.globalAlpha = 1;
      }
      g.fillStyle = soft; g.textAlign = "right";
      g.fillText(fmtAxis(hi - pad), L - 4, y0 + 5); g.fillText(fmtAxis(lo + pad), L - 4, y1 - 4);
      if (row.ref != null && row.ref > lo && row.ref < hi) g.fillText("1", L - 4, yOf(row.ref));
    });
    // x axis: km along, ends named by compass direction.
    const yb = H - 8, sub = this.sub, upBrg = s.down ? (sub.axis.downstreamBearingDeg + 180) % 360 : sub.axis.downstreamBearingDeg;
    g.fillStyle = soft; g.textAlign = "left"; g.fillText(`${compass(upBrg)} (upstream)`, L, yb);
    g.textAlign = "right"; g.fillText(`${compass((upBrg + 180) % 360)} · ${n0(Math.abs(order[n - 1].along - order[0].along))} km`, R, yb);
    // Hover: crosshair, values and a marker on the map.
    this.clearMarker();
    if (this.hoverX != null) {
      const k = Math.max(0, Math.min(n - 1, Math.round(((this.hoverX * W - L) / (R - L)) * (n - 1))));
      const x = xOf(k), p = order[k], cap = p.caps[def];
      g.strokeStyle = ink; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(x + 0.5, top); g.lineTo(x + 0.5, H - 16); g.stroke(); g.globalAlpha = 1;
      $("ca-hover").textContent = `${n0(p.along)} km: ${fmtSpeed(p.wind * KT)} · ${f1(p.mslp)} mb · cap ${cap ? `${n0(cap.D)} m, Δθ ${f1(cap.dth)} K, Fr ${f2(cap.fr)}` : "none"}`;
      this.placeMarker(p);
    } else $("ca-hover").textContent = "Hover the charts for values here and a marker on the map.";
  }

  placeMarker(p) {
    const X = this.x, q = X.proj.toXY(p.lat, p.lon), vex = X.stage.vex;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(q.x, q.y, 0), new THREE.Vector3(q.x, q.y, 4 * vex)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffa640, depthTest: false }));
    l.renderOrder = 30;
    this.marker.add(l);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffa640, depthTest: false }));
    dot.position.set(q.x, q.y, 0.05); dot.renderOrder = 30;
    this.marker.add(dot);
    X.stage.markDirty();
  }
  clearMarker() {
    for (const o of [...this.marker.children]) { this.marker.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.x.stage.markDirty();
  }

  // Link: "sub,def,lapse,offset,rh,window" when open.
  toParam() { return $("ca").open && this.sub ? [this.sub.id, $("ca-def").value, ...Object.values(this.params())].join(",") : null; }
  fromParam(v) {
    const [id, def, lapse, off, rh, win] = String(v).split(",");
    if (!this.subs?.some((s) => s.id === id)) return;
    $("ca-sub").value = id; this.applyDefaults();
    if (CAP_DEFS[def]) $("ca-def").value = def;
    const set = (el, x) => { if (x !== undefined && isFinite(+x)) $(el).value = x; };
    set("ca-lapse", lapse); set("ca-offset", off); set("ca-rh", rh); set("ca-window", win);
    this.showSliders();
    $("ca").open = true;
  }
}

const opposite = (w) => ({ westerly: "easterly", easterly: "westerly", southerly: "northerly", northerly: "southerly" }[w] || `not ${w}`);
const fmtAxis = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
