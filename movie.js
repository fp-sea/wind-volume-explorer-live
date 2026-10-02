// A movie of the passage: the replay recorded frame by frame to an MP4 (H.264), with its own
// settings (not whatever happens to be on screen): how fast the passage plays, the picture size,
// the layout (the 3D map, the surface viewer as an inset, gauges, a small route map, a title
// bar), the map camera (following the boat or the whole route), the viewer's camera, and which
// particles and textures are drawn. The forecast on the map blends continuously between hours;
// the viewer's waves and boat motion run at real-time pace whatever the speed-up.
//
// Encoded in the browser (WebCodecs VideoEncoder + mp4-muxer, MIT); nothing is uploaded.

import * as THREE from "three";

const $ = (id) => document.getElementById(id);
const MUXER = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm";
const SIZES = { "720p": [1280, 720], "1080p": [1920, 1080], square: [1080, 1080], vertical: [1080, 1920] };
const hm = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`; };
const KT = 1.943844;

export class PassageMovie {
  constructor(passage) { this.ps = passage; }

  // ---------- the settings block (in the Passage results) ----------
  panelHTML() {
    const s = this.settings();
    const opt = (id, list, v) => `<select id="${id}" class="mini">${list.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    const chk = (id, label, on, title = "") => `<label class="row" title="${title}"><input id="${id}" type="checkbox"${on ? " checked" : ""}> ${label}</label>`;
    return `<details class="pm" id="pm"><summary>🎬 Movie of the passage</summary>
      <div class="pm-grid">
        <div class="inline"><span class="lab">Speed</span>${opt("pm-speed", [[1, "1 min of passage a second"], [2, "2 min/s"], [5, "5 min/s"], [10, "10 min/s"], [15, "15 min/s"], [30, "30 min/s"], [60, "1 h/s"]].map(([k, l]) => [String(k), l]), s.speed)}</div>
        <div class="inline"><span class="lab">Size</span>${opt("pm-size", [["720p", "1280×720 (HD)"], ["1080p", "1920×1080 (Full HD)"], ["square", "1080×1080 (square)"], ["vertical", "1080×1920 (phone, vertical)"]], s.size)}</div>
        <div class="inline"><span class="lab">Picture</span>${opt("pm-layout", [["panels", "map, with viewer, gauges and route map beside it"], ["inset", "map full, the rest over it"], ["split", "map and viewer side by side"], ["map", "map only"], ["viewer", "viewer only"]], s.layout)}</div>
        <div class="inline"><span class="lab">Map camera</span>${opt("pm-cam", [["follow", "follow the boat (the zoom on screen)"], ["route", "the whole route"], ["fixed", "as it is on screen"]], s.cam)}</div>
        <div class="inline"><span class="lab">Viewer camera</span>${opt("pm-vcam", [["chase", "chase (behind the boat)"], ["sails", "sail view"], ["cockpit", "cockpit"]], s.vcam)}</div>
        <div class="pm-row">${chk("pm-gauges", "gauges", s.gauges, "Time, STW, SOG, HDG, COG, true and apparent wind, the tack, the current, seas, sails and notes")}${chk("pm-mini", "route map", s.mini, "A small route map with the boat")}${chk("pm-title", "title bar", s.title, "The route, the date and time, the speed-up")}${chk("pm-key", "map colour key", s.key, "The key to the colours on the map: what is shown, its units and scale")}</div>
        <div class="pm-row"><span class="lab">Draw</span>${chk("pm-parts", "wind particles (map)", s.parts)}${chk("pm-wp", "wind streaks (viewer)", s.wp)}${chk("pm-sflow", "sail flow", s.sflow)}${chk("pm-bft", "Beaufort texture", s.bft)}${chk("pm-spray", "spray", s.spray)}${chk("pm-night", "night lights (viewer)", s.night, "After dark, brighten the viewer so the sea and boat show")}</div>
        <p class="note" id="pm-est"></p>
        <p><button class="btn" id="pm-go">Record the movie</button> <button class="btn mini" id="pm-stop" hidden>Stop</button> <span id="pm-prog" class="note"></span></p>
        <p id="pm-out"></p>
      </div></details>`;
  }
  settings() {
    const d = { speed: "5", size: "720p", layout: "panels", cam: "follow", vcam: "chase", gauges: true, mini: true, title: true, key: true, parts: true, wp: true, sflow: false, bft: true, spray: true, night: true };
    let v = d; try { v = { ...d, ...JSON.parse(localStorage.getItem("wve.movie") || "{}") }; } catch { /* no storage */ }
    if (v.layout === "both") v.layout = "panels";                 // (the first version's layout)
    return v;
  }
  bind() {
    const ids = ["speed", "size", "layout", "cam", "vcam", "gauges", "mini", "title", "key", "parts", "wp", "sflow", "bft", "spray", "night"];
    const read = () => Object.fromEntries(ids.map((k) => { const el = $(`pm-${k}`); return [k, el.type === "checkbox" ? el.checked : el.value]; }));
    const est = () => {
      const s = read(), P = this.ps.result?.pts; if (!P) return;
      const secs = (P.at(-1).t - P[0].t) / 1000 / (+s.speed * 60), [w, h] = SIZES[s.size], mbps = (w * h) / (1280 * 720) * 5;
      $("pm-est").textContent = `About ${hm(secs)} of video at 30 frames a second (${Math.round(secs * 30)} frames), ~${Math.max(1, Math.round((secs * mbps) / 8))} MB as MP4. Recording takes a few times longer than the video; the page stays on the passage meanwhile.`;
      try { localStorage.setItem("wve.movie", JSON.stringify(s)); } catch { /* no storage */ }
    };
    for (const k of ids) $(`pm-${k}`).addEventListener("change", est);
    est();
    $("pm-go").addEventListener("click", () => this.record(read()));
    $("pm-stop").addEventListener("click", () => { this.stop = true; });
  }

  // ---------- recording ----------
  async record(s) {
    const ps = this.ps, ex = ps.ex, P = ps.result?.pts;
    if (!P?.length || this.busy) return;
    if (typeof VideoEncoder === "undefined") { $("pm-out").textContent = "This browser can't encode video (WebCodecs). Chrome, Edge or Safari 17+ can."; return; }
    const [W, H] = SIZES[s.size], fps = 30, perFrame = (+s.speed * 60 * 1000) / fps;   // passage ms per video frame
    const t0 = P[0].t, t1 = P.at(-1).t, n = Math.ceil((t1 - t0) / perFrame) + fps;   // (+1 s held on the arrival)
    const codec = await pickCodec(W, H, fps);
    if (!codec) { $("pm-out").textContent = "This browser can't encode H.264 at that size: try a smaller one."; return; }
    this.busy = true; this.stop = false;
    $("pm-go").disabled = true; $("pm-stop").hidden = false; $("pm-out").textContent = "";
    const restore = this.apply(s);
    const { Muxer, ArrayBufferTarget } = await import(MUXER);
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: W, height: H, frameRate: fps }, fastStart: "in-memory" });
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    enc.configure({ codec, width: W, height: H, bitrate: Math.round((W * H) / (1280 * 720) * 5e6), framerate: fps });
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const R = rects(s, W, H), mini = R.mini ? await this.miniMap(R.mini[2], R.mini[3]) : null;
    const began = performance.now();
    try {
      for (let i = 0; i < n && !this.stop && !encErr; i++) {
        const t = Math.min(t1, t0 + i * perFrame);
        await this.frameAt(t, i, fps, s);
        this.compose(g, W, H, t, s, mini, R);
        const vf = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
        if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
        if (i % 10 === 0) {
          const el = (performance.now() - began) / 1000, left = (el / (i + 1)) * (n - i - 1);
          $("pm-prog").textContent = `Recording: frame ${i + 1} of ${n} (${Math.round(((i + 1) / n) * 100)}%), about ${hm(left)} left`;
          await new Promise((r) => setTimeout(r, 0));             // (the page breathes)
        }
      }
      await enc.flush(); enc.close();
      if (encErr) throw encErr;
      if (this.stop) { $("pm-out").textContent = "Stopped."; return; }
      muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: "video/mp4" }), url = URL.createObjectURL(blob);
      const names = ps.wps.map((w) => ps.spotName(w).replace(/^(near|at) /, "")), file = `passage ${names[0]} to ${names.at(-1)} ${new Date(t0).toISOString().slice(0, 10)}.mp4`.replace(/[\/\\:*?"<>|]/g, "-");
      $("pm-out").innerHTML = `<a class="btn" href="${url}" download="${file}">Download the movie</a> <span class="note">${file} · ${(blob.size / 1e6).toFixed(1)} MB · ${hm(n / fps)} · ${W}×${H}</span>`;
      $("pm-prog").textContent = `Recorded ${n} frames in ${hm((performance.now() - began) / 1000)}.`;
    } catch (e) { console.error(e); $("pm-out").textContent = `Couldn't record: ${e.message || e}`; }
    finally { restore(); this.busy = false; $("pm-go").disabled = false; $("pm-stop").hidden = true; }
  }

  // The recording's own settings, applied for it and put back afterwards. → restore()
  apply(s) {
    const ps = this.ps, ex = ps.ex, ins = ex.inspector, st = ex.stage, [W, H] = SIZES[s.size];
    const saved = [];
    const setChk = (id, v) => { const el = $(id); if (!el || el.checked === v) return; saved.push([el, el.checked]); el.checked = v; el.dispatchEvent(new Event("change", { bubbles: true })); };
    setChk("show-particles", !!s.parts);
    ps.stopReplay(false);
    if ($("ps-follow")) { saved.push([$("ps-follow"), $("ps-follow").checked]); $("ps-follow").checked = s.cam === "follow"; }
    const wantViewer = s.layout !== "map";          // (R.viewer)
    if ($("ps-viewer")) { saved.push([$("ps-viewer"), $("ps-viewer").checked]); $("ps-viewer").checked = wantViewer; }
    // The map at the movie's size (its main picture's share of the frame).
    const R = rects(s, W, H), mapW = R.map ? R.map[2] : W, mapH = R.map ? R.map[3] : H;
    const camWas = { pos: st.camera.position.clone(), target: st.controls.target.clone(), aspect: st.camera.aspect };
    st.renderer.setSize(mapW, mapH, false); st.camera.aspect = mapW / mapH; st.camera.updateProjectionMatrix();
    if (s.cam === "route") this.frameRoute();
    if (s.cam === "follow") this.closeIn(35);
    // The viewer: its own switches and camera, drawn only when asked; set up when it opens (a
    // start in harbour opens it once the boat is out on the water).
    const P = ps.result.pts;
    this.viewerSetup = () => {
      if (!wantViewer || ins.el.hidden || ins.manual) return;
      for (const [id, k] of [["ins-wp", "wp"], ["ins-sflow", "sflow"], ["ins-bft", "bft"], ["ins-spray", "spray"]]) setChk(id, !!s[k]);
      const nt = $("ins-night"); if (nt) { saved.push([nt, nt.value, "value"]); nt.value = s.night ? "bright" : "natural"; nt.dispatchEvent(new Event("change")); }
      const cam = { chase: "ins-cam-reset", sails: "ins-cam-sails", cockpit: "ins-cam-cockpit" }[s.vcam]; $(cam)?.click();
      const vw = R.viewer[2], vh = R.viewer[3];
      ins.renderer.setSize(vw, vh, false); ins.camera.aspect = vw / vh; ins.camera.updateProjectionMatrix();
      ins.manual = true; this.vclock = performance.now();
    };
    ps.rp.playing = false; ps.replayAt(P[0].t, true); this.viewerSetup();
    return () => {
      this.viewerSetup = null; ins.manual = false; ins.fit?.();
      for (const [el, v, prop = "checked"] of saved.reverse()) { el[prop] = v; el.dispatchEvent(new Event("change", { bubbles: true })); }
      st.camera.position.copy(camWas.pos); st.controls.target.copy(camWas.target); st.resize(); st.markDirty();
    };
  }
  // The map camera following the boat about `km` across (the replay keeps this offset as it follows).
  closeIn(km) {
    // (looking down at about 60°, from the screen's direction: low angles let the exaggerated hills
    // hide the water and the route seems to cross the land)
    const st = this.ps.ex.stage, s = this.ps.stateAt(this.ps.result.pts[0].t), dir = st.camera.position.clone().sub(st.controls.target);
    const hl = Math.hypot(dir.x, dir.y) || 1; dir.set((dir.x / hl) * 0.5, (dir.y / hl) * 0.5, 0.866);
    const d = (km / 2) / Math.tan((st.camera.fov * Math.PI) / 360);
    st.controls.target.set(s.x, s.y, 0); st.camera.position.copy(st.controls.target).addScaledVector(dir, d); st.controls.update();
  }
  // The map camera over the whole route (from above at an angle, like the default views).
  frameRoute() {
    const st = this.ps.ex.stage, P = this.ps.result.pts;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(x1 - x0, (y1 - y0) * st.camera.aspect, 4), d = span / (2 * Math.tan((st.camera.fov * Math.PI) / 360)) * 1.25;
    st.controls.target.set(cx, cy, 0); st.camera.position.set(cx, cy - d * 0.55, d * 0.85); st.controls.update();
  }
  // One frame of the passage at time t: the boat, the forecast (waiting for an hour to load), the
  // map camera, the viewer (its own clock: real time).
  async frameAt(t, i, fps, s) {
    const ps = this.ps, ex = ps.ex, fh = (t - ex.cycle.getTime()) / 3600e3;
    ps.rp.t = t; ps.replayAt(t, true);
    for (let k = 0; ex.followTime(fh, { force: true }) === false && k < 600; k++) await new Promise((r) => setTimeout(r, 100));
    // (the map's own boat disc is left out: compose draws a marker in a colour that stands out)
    const b = ps.layer.boat, was = b?.visible; if (b) b.visible = false;
    ex.stage.renderNow();
    if (b) b.visible = was;
    this.viewerSetup?.();
    if (s.layout !== "map" && ex.inspector.manual) { this.vclock += 1000 / fps; ex.inspector.frame(this.vclock); }
  }

  // ---------- the picture ----------
  compose(g, W, H, t, s, mini, R) {
    const ps = this.ps, ex = ps.ex, map = ex.stage.renderer.domElement, view = ex.inspector.renderer?.domElement, viewerOn = ex.inspector.manual;
    const u = 1.2 * Math.max(1, Math.min(W, H) / 720), over = s.layout !== "panels";   // (text scale; panels over the picture, or beside it)
    g.fillStyle = "#0b1a20"; g.fillRect(0, 0, W, H);
    const cover = (src, [x, y, w, h]) => { if (!src?.width) return; const k = Math.max(w / src.width, h / src.height), sw = w / k, sh = h / k; g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h); };
    if (R.map) { cover(map, R.map); this.boatMark(g, R.map, map, t, u); this.timeBox(g, R.map, t, s, u); if (s.key) this.mapKey(g, R.map, u); }
    if (R.viewer) {
      if (viewerOn) { if (R.inset) { g.fillStyle = "rgba(0,0,0,.5)"; g.fillRect(R.viewer[0] - 3, R.viewer[1] - 3, R.viewer[2] + 6, R.viewer[3] + 6); } cover(view, R.viewer); }
      else { panel(g, ...R.viewer, 0.9); text(g, "the surface viewer opens once the boat is out on the water", R.viewer[0] + R.viewer[2] / 2, R.viewer[1] + R.viewer[3] / 2, 12 * u, "#9fb4ba", 400, "center"); }
    }
    const row = ps.stateAt(t), P = ps.result.pts;
    let i = 1; while (i < P.length - 1 && P[i].t < t) i++;
    const r = ps.row(P[i], P[i - 1], ps.exportData.boat), m = P[i].m || {};
    if (R.title) {
      const names = ps.wps.map((w) => ps.spotName(w).replace(/^(near|at) /, ""));
      panel(g, ...R.title, 0.78);
      text(g, `${names[0]} → ${names.at(-1)}`, 12 * u, R.title[3] * 0.66, 15 * u, "#e9f1f3", 600);
      text(g, `${+s.speed >= 60 ? "1 h" : `${s.speed} min`} of passage a second`, W - 12 * u, R.title[3] * 0.66, 14 * u, "#ffd166", 600, "right");
    }
    if (R.gauges) this.gauges(g, R.gauges, r, row, m, u, over);
    if (mini && R.mini) {
      const [x, y, w, h] = R.mini, k = Math.min(w / mini.w, h / mini.h), mw = mini.w * k, mh = mini.h * k, mx = x + (w - mw) / 2, my = y + (h - mh) / 2;
      if (!over) { g.fillStyle = "#0b1a20"; g.fillRect(x, y, w, h); }
      g.drawImage(mini.img, mx, my, mw, mh);
      g.strokeStyle = "rgba(255,255,255,.8)"; g.lineWidth = 1; g.strokeRect(mx, my, mw, mh);
      const bx = mx + mini.X(row.x) * k, by = my + mini.Y(row.y) * k;
      g.fillStyle = "#ffd166"; g.strokeStyle = "#16232a"; g.lineWidth = 1.5 * u; g.beginPath(); g.arc(bx, by, 5 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    if (!over) { g.fillStyle = "rgba(255,255,255,.18)"; for (const q of [R.viewer, R.gauges, R.mini].filter(Boolean)) g.fillRect(q[0], q[1] + q[3] - 1, q[2], 1); g.fillRect(R.map[0] + R.map[2], R.map[1], 1, R.map[3]); }
  }
  // The boat on the map: an arrow along its heading, in whichever of yellow, magenta, cyan, white
  // or black differs most from the picture round it (the layers shown change what stands out),
  // outlined in the opposite tone, with a halo.
  boatMark(g, [x, y, w, h], src, t, u) {
    const ps = this.ps, st = ps.ex.stage, s = ps.stateAt(t), b = ps.layer.boat;
    if (!s || !b || !b.visible) return;
    const k = Math.max(w / src.width, h / src.height), ox = x - (src.width * k - w) / 2, oy = y - (src.height * k - h) / 2;
    const scr = (px, py) => { const v = new THREE.Vector3(px, py, b.position.z).project(st.camera); return [ox + ((v.x + 1) / 2) * src.width * k, oy + ((1 - v.y) / 2) * src.height * k]; };
    const [bx, by] = scr(s.x, s.y);
    if (bx < x || by < y || bx > x + w || by > y + h) return;
    const r = ((s.hdg ?? 0) * Math.PI) / 180, [ax, ay] = scr(s.x + Math.sin(r) * 0.5, s.y + Math.cos(r) * 0.5), ang = Math.atan2(ay - by, ax - bx);
    // The picture round the boat (a ring round it, as the marker covers the middle).
    const R0 = Math.round(48 * u), sx = Math.max(x, Math.round(bx - R0)), sy = Math.max(y, Math.round(by - R0)), sw = Math.min(x + w, Math.round(bx + R0)) - sx, sh = Math.min(y + h, Math.round(by + R0)) - sy;
    let cr = 0, cg = 0, cb = 0, n = 0;
    if (sw > 4 && sh > 4) {
      const d = g.getImageData(sx, sy, sw, sh).data;
      for (let j = 0; j < sh; j += 2) for (let i = 0; i < sw; i += 2) { const q = Math.hypot(sx + i - bx, sy + j - by); if (q < 30 * u || q > R0) continue; const o = 4 * (j * sw + i); cr += d[o]; cg += d[o + 1]; cb += d[o + 2]; n++; }
    }
    const bg = n ? [cr / n, cg / n, cb / n] : [40, 60, 70];
    const pick = markColour(bg), lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], edge = lum(pick) > 110 ? "#101418" : "#ffffff";
    const L = 20 * u;
    g.beginPath(); g.arc(bx, by, 1.35 * L, 0, Math.PI * 2); g.lineWidth = 5 * u; g.strokeStyle = edge; g.stroke();   // (a ring: finds the eye in a busy map)
    g.lineWidth = 2.5 * u; g.strokeStyle = `rgb(${pick.join(",")})`; g.stroke();
    g.save(); g.translate(bx, by); g.rotate(ang);
    g.beginPath(); g.moveTo(L, 0); g.lineTo(-0.7 * L, 0.62 * L); g.lineTo(-0.35 * L, 0); g.lineTo(-0.7 * L, -0.62 * L); g.closePath();
    g.lineJoin = "round"; g.strokeStyle = edge === "#ffffff" ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.45)"; g.lineWidth = 7 * u; g.stroke();   // (the halo)
    g.fillStyle = `rgb(${pick.join(",")})`; g.fill(); g.strokeStyle = edge; g.lineWidth = 2 * u; g.stroke();
    g.restore();
  }
  // The time in the map's top-left corner: local date and time (large), UTC, and how far along.
  timeBox(g, [x, y], t, s, u) {
    const ps = this.ps, P = ps.result.pts, tz = ps.ex.region?.tz || "UTC", d = new Date(t);
    const loc = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
    const utc = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
    const el = (t - P[0].t) / 3600e3, tot = (P.at(-1).t - P[0].t) / 3600e3, h = (v) => { const mm = Math.round(v * 60); return `${Math.floor(mm / 60)}h ${String(mm % 60).padStart(2, "0")}m`; };
    g.font = `700 ${Math.round(17 * u)}px "Noto Sans", system-ui, sans-serif`;
    const w = Math.max(g.measureText(loc).width, 170 * u) + 20 * u, bx = x + 12 * u, by = y + 12 * u;
    panel(g, bx, by, w, 56 * u, 0.72, 7 * u);
    text(g, loc, bx + 10 * u, by + 22 * u, 17 * u, "#ffffff", 700);
    text(g, `${utc} · ${h(el)} of ${h(tot)}`, bx + 10 * u, by + 44 * u, 12 * u, "#ffd166", 600);
  }
  // The map's colour key (the page draws it over the map, so it isn't in the picture): its title,
  // colour bar and ticks, bottom left of the map.
  mapKey(g, [x, y, w, h], u) {
    // (the wind's key, and the current's and wave height's when their fills are on: stacked up
    // from the bottom left)
    const keys = [];
    const box = $("legend"), bar = $("legend-bar");
    if (box && !box.hidden && bar) keys.push({ title: $("legend-title")?.textContent || "", bar, ticks: [...($("legend-ticks")?.children || [])].map((e) => [e.textContent, parseFloat(e.style.left) / 100]) });
    for (const k of document.querySelectorAll("#keys2 .key2")) keys.push({ title: k.querySelector(".lbl").textContent, bar: k.querySelector("canvas"), ticks: [...k.querySelectorAll(".ticks span")].map((e) => [e.textContent, parseFloat(e.style.left) / 100]) });
    const kw = Math.min(w * 0.42, 300 * u), kh = 58 * u, kx = x + 12 * u;
    keys.forEach((k, n) => this.oneKey(g, k, kx, y + h - (kh + 8 * u) * (n + 1) - 4 * u, kw, kh, u));
  }
  oneKey(g, { title, bar, ticks }, kx, ky, kw, kh, u) {
    panel(g, kx, ky, kw, kh, 0.72, 7 * u);
    text(g, title, kx + 10 * u, ky + 17 * u, 12 * u, "#e9f1f3", 600);
    const bw = kw - 20 * u, bh = 10 * u, bx = kx + 10 * u, by = ky + 24 * u;
    g.drawImage(bar, bx, by, bw, bh);
    // (each tick's value, unless it would run into the last one written: the last one wins, so the
    // end of the scale always shows)
    g.font = `500 ${Math.round(10.5 * u)}px "Noto Sans", system-ui, sans-serif`;
    const lab = ticks.filter(([, f]) => Number.isFinite(f)).map(([l, f]) => { const tx = bx + f * bw, tw = g.measureText(l).width, al = f < 0.05 ? "left" : f > 0.95 ? "right" : "center", x0 = al === "left" ? tx : al === "right" ? tx - tw : tx - tw / 2; return { l, tx, al, x0, x1: x0 + tw }; });
    const keep = []; for (let k = lab.length - 1; k >= 0; k--) if (!keep.length || lab[k].x1 + 4 * u < keep[0].x0) keep.unshift(lab[k]);
    for (const q of lab) { g.fillStyle = "rgba(233,241,243,.8)"; g.fillRect(q.tx, by + bh, 1, 3 * u); }
    for (const q of keep) text(g, q.l, Math.min(bx + bw, Math.max(bx, q.tx)), by + bh + 15 * u, 10.5 * u, "#e9f1f3", 500, q.al);
  }
  // The instruments as tiles, two across: label small, value large; the sails or a note below.
  gauges(g, [x, y, w, h], r, row, m, u, over) {
    const ps = this.ps, side = (v) => (Number.isFinite(v) ? `${Math.round(Math.abs(v))}° ${v < 0 ? "P" : "S"}` : "–");
    const tiles = row.hold ? [["", m.gate ? "Holding for the tide" : "Waiting in harbour"], ["Current", r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)} kt` : "slack"], ["Seas", `${r.hs.toFixed(1)} ft`], ["TWS", `${Math.round(r.tws)} kt`]]
      : [["STW", `${(r.bsp ?? 0).toFixed(1)} kn`], ["SOG", `${r.sog.toFixed(1)} kn`], ["HDG", ps.brg(r.hdg)], ["COG", ps.brg(r.cog)], ["TWS", `${Math.round(r.tws)} kt · g${Math.round(r.gust)}`], ["TWA", `${side(r.twa)}`],
        ["AWS", `${Math.round(r.aws || 0)} kt`], ["AWA", side(r.awa)], ["Current", r.curKt >= 0.1 ? `${r.along >= 0 ? "+" : "−"}${Math.abs(r.along).toFixed(1)} kt ${r.along >= 0 ? "fair" : "foul"}` : "slack"], ["Seas", `${r.hs.toFixed(1)} ft`]];
    const foot = row.hold ? "" : `${r.side ? `${r.side > 0 ? "starboard" : "port"} tack · ` : ""}${m.narrow ? "motoring: narrow channel" : m.motor ? "motoring" : r.sails}`;
    panel(g, x, y, w, h, over ? 0.72 : 0.95, over ? 8 * u : 0);
    const pad = 8 * u, rows = Math.ceil(tiles.length / 2) + (foot ? 0.8 : 0), th = (h - 2 * pad) / rows, cw = (w - 2 * pad) / 2, vs = Math.min(th * 0.5, 18 * u), ls = Math.min(th * 0.3, 11 * u);
    tiles.forEach(([k, v], j) => {
      const cx = x + pad + (j % 2) * cw, cy = y + pad + Math.floor(j / 2) * th;
      if (k) text(g, k, cx + 4 * u, cy + ls + 2, ls, "#9fb4ba", 600);
      text(g, v, cx + 4 * u, cy + (k ? ls + 4 : 0) + vs, vs, k ? "#e9f1f3" : "#ffd166", 700);
    });
    if (foot) text(g, foot, x + pad + 4 * u, y + h - pad - th * 0.25, Math.min(vs * 0.8, 14 * u), "#ffd166", 600);
  }
  // The small route map: the NOAA chart (the report's), the route, the waypoints; the boat is added each frame.
  // (sized to fill its panel, rw × rh)
  async miniMap(rw, rh) {
    const ps = this.ps, rep = ps.report, P = ps.result.pts, u = Math.max(1, Math.min(rw, rh) / 300), all = [...P, ...ps.wps];
    let x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x)), y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
    const pad = Math.max(1, 0.1 * Math.max(x1 - x0, y1 - y0)); x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const ar = Math.min(2, Math.max(0.5, rh / rw)), mw = Math.round(Math.min(rw, 900));
    if ((y1 - y0) / (x1 - x0) > ar) { const w = (y1 - y0) / ar, c = (x0 + x1) / 2; x0 = c - w / 2; x1 = c + w / 2; } else { const h = (x1 - x0) * ar, c = (y0 + y1) / 2; y0 = c - h / 2; y1 = c + h / 2; }
    const mh = Math.round(mw * ar), base = await rep.chartBase(x0, y0, x1, y1, mw, mh);
    const img = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = base.url; });
    const cv = document.createElement("canvas"); cv.width = mw; cv.height = mh;
    const g = cv.getContext("2d"), X = (x) => ((x - x0) / (x1 - x0)) * mw, Y = (y) => ((y1 - y) / (y1 - y0)) * mh;
    g.drawImage(img, 0, 0, mw, mh);
    g.lineJoin = "round"; g.strokeStyle = "#fff"; g.lineWidth = 5 * u; g.beginPath(); P.forEach((p, k) => (k ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke();
    for (let k = 1; k < P.length; k++) { g.strokeStyle = P[k].m?.motor ? "#59646a" : "#1f6fb2"; g.lineWidth = 2.6 * u; g.beginPath(); g.moveTo(X(P[k - 1].x), Y(P[k - 1].y)); g.lineTo(X(P[k].x), Y(P[k].y)); g.stroke(); }
    ps.wps.forEach((w, k) => { g.fillStyle = k === 0 ? "#2e9e5b" : k === ps.wps.length - 1 ? "#c8452f" : "#d9a31a"; g.beginPath(); g.arc(X(w.x), Y(w.y), 4 * u, 0, Math.PI * 2); g.fill(); });
    return { img: cv, w: mw, h: mh, X, Y };
  }
}

async function pickCodec(W, H, fps) {
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42002a"]) {
    try { const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 5e6, framerate: fps }); if (r.supported) return codec; } catch { /* next */ }
  }
  return null;
}
function panel(g, x, y, w, h, a = 0.6, r = 0) { g.fillStyle = `rgba(8,18,24,${a})`; if (r) { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); } else g.fillRect(x, y, w, h); }
function text(g, s, x, y, px, col, wt = 400, align = "left") { g.font = `${wt} ${Math.round(px)}px "Noto Sans", system-ui, sans-serif`; g.textAlign = align; g.fillStyle = col; g.fillText(s, x, y); g.textAlign = "left"; }

// Where each part of the picture goes, by layout and shape. → {title, map, viewer, gauges, mini, inset}
// ([x, y, w, h] each, or null). "panels": the map uncovered, the others in a column beside it
// (landscape), a row under it (square), or stacked under it (portrait); the others lay them over.
export function rects(s, W, H) {
  const u = 1.2 * Math.max(1, Math.min(W, H) / 720), T = s.title ? Math.round(34 * u) : 0, R = { title: s.title ? [0, 0, W, T] : null };
  const want = { viewer: s.layout !== "map", gauges: !!s.gauges, mini: !!s.mini };
  if (s.layout === "panels") {
    const ar = W / H;
    if (ar >= 1.2) {                                            // landscape: a column on the right
      const cw = Math.round(W * 0.36), x = W - cw; R.map = [0, T, W - cw, H - T];
      let y = T;
      if (want.viewer) { const vh = Math.round(cw * 0.6); R.viewer = [x, y, cw, vh]; y += vh; }
      const rest = H - y, gh = want.gauges ? (want.mini ? Math.round(Math.min(rest * 0.55, 230 * u)) : rest) : 0;
      if (want.gauges) { R.gauges = [x, y, cw, gh]; y += gh; }
      if (want.mini && H - y > 40) R.mini = [x, y, cw, H - y];
    } else if (ar >= 0.8) {                                     // square: a row underneath
      const mh = Math.round((H - T) * 0.58), y = T + mh, bh = H - y; R.map = [0, T, W, mh];
      const parts = ["viewer", "gauges", "mini"].filter((k) => want[k]), wts = { viewer: 0.4, gauges: 0.32, mini: 0.28 }, tot = parts.reduce((a, k) => a + wts[k], 0);
      let x = 0; for (const k of parts) { const w = Math.round((W * wts[k]) / tot); R[k] = [x, y, w, bh]; x += w; }
    } else {                                                    // portrait: stacked
      const mh = Math.round((H - T) * 0.42); R.map = [0, T, W, mh];
      let y = T + mh;
      if (want.viewer) { const vh = Math.round(W * 0.56); R.viewer = [0, y, W, vh]; y += vh; }
      const bh = H - y;
      if (want.gauges && want.mini) { R.gauges = [0, y, Math.round(W * 0.55), bh]; R.mini = [Math.round(W * 0.55), y, W - Math.round(W * 0.55), bh]; }
      else if (want.gauges) R.gauges = [0, y, W, bh]; else if (want.mini) R.mini = [0, y, W, bh];
    }
    return R;
  }
  // Laid over the picture.
  const top = T + Math.round(10 * u);
  if (s.layout === "viewer") { R.viewer = [0, T, W, H - T]; R.map = null; }
  else if (s.layout === "split") { R.map = [0, T, Math.round(W / 2), H - T]; R.viewer = [Math.round(W / 2), T, W - Math.round(W / 2), H - T]; }
  else { R.map = [0, T, W, H - T]; if (s.layout === "inset") { const vw = Math.round(W * 0.34), vh = Math.round(vw * 0.62); R.viewer = [W - vw - 16, H - vh - 16, vw, vh]; R.inset = true; } }
  if (want.gauges) { const gw = Math.round(250 * u), gh = Math.round(215 * u); R.gauges = [Math.round(14 * u), H - gh - Math.round(14 * u), gw, gh]; }
  if (want.mini) { const mw = Math.round(Math.min(W, H) * 0.3); R.mini = [W - mw - Math.round(14 * u), top, mw, Math.round(mw * 1.1)]; }
  return R;
}

// The marker colour that differs most from the background `bg` ([r, g, b] 0–255): distance in a
// roughly perceptual RGB (weighted), from a few saturated choices and white and black.
export function markColour(bg) {
  const C = [[255, 209, 102], [255, 79, 216], [0, 229, 255], [255, 255, 255], [16, 20, 24]];
  const dist = (a) => Math.sqrt(2 * (a[0] - bg[0]) ** 2 + 4 * (a[1] - bg[1]) ** 2 + 3 * (a[2] - bg[2]) ** 2);
  return C.reduce((best, c) => (dist(c) > dist(best) ? c : best));
}
