// SYNC: radar-explorer web/export.js@7439092. Copied verbatim below this header; scripts/check_sync.py reports upstream changes.
// Used here for picture/orbit/tour exports. It has no imports and relies only on the parts object passed to composite().

// Export the picture as an animated GIF or an MP4 video, made in the browser.
//
// Each output frame is composited on a 2D canvas: the 3D render, then the map
// labels (they are page text over the 3D view, so they are redrawn here from
// where they sit on screen), the title and time, the colour legend, and the
// data credits, which the sources' licences ask for.
//
// GIF: gifenc, one 256-colour palette per frame. MP4: the browser's own H.264
// encoder (WebCodecs) and mp4-muxer, frame-exact and faster than real time;
// where WebCodecs is missing, MediaRecorder records in real time instead
// (MP4 if the browser can, else WebM). Both libraries load only when used.

const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
const MP4MUX = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs";
const FPS = 20;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Output size for a width, keeping the window's shape.
export function outputSize(width) {
  const W = even(Math.min(width, window.innerWidth * (window.devicePixelRatio || 1)));
  return { W, H: even(W * window.innerHeight / window.innerWidth) };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

// Draw one frame. parts: { gl, labelsRoot, title, time, badge, legend: {title, bar, ticks}, credits }.
export function composite(ctx, parts, W, H) {
  const s = W / window.innerWidth;                 // page px -> output px
  const fs = Math.max(s, W / 1100);                 // text never shrinks past legible
  ctx.fillStyle = "#0b0f16";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(parts.gl, 0, 0, W, H);

  // Map labels where the page shows them.
  for (const el of parts.labelsRoot.querySelectorAll(".label, .metar")) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const size = parseFloat(cs.fontSize) * fs;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    const text = el.textContent.trim();
    const padL = parseFloat(cs.paddingLeft) * fs, w = ctx.measureText(text).width + padL * 2, h = size * 1.45;
    const x = r.left * s + (r.width * s - w) / 2, y = r.top * s + (r.height * s - h) / 2;
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
      ctx.fillStyle = cs.backgroundColor;
      roundRect(ctx, x, y, w, h, 3 * fs);
      ctx.fill();
    }
    if (parseFloat(cs.borderTopWidth) > 0) { ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = fs; roundRect(ctx, x, y, w, h, 3 * fs); ctx.stroke(); }
    if (parseFloat(cs.borderLeftWidth) > 1) { ctx.fillStyle = cs.borderLeftColor; ctx.fillRect(x, y, 3 * fs, h); }
    ctx.fillStyle = cs.color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padL, y + h / 2);
  }

  // Title and time across the top.
  const band = ctx.createLinearGradient(0, 0, 0, 60 * fs);
  band.addColorStop(0, "rgba(11,15,22,0.9)");
  band.addColorStop(1, "rgba(11,15,22,0)");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, 60 * fs);
  ctx.textBaseline = "top";
  ctx.font = `600 ${16 * fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = "#dfe6ef";
  ctx.fillText(parts.title, 12 * fs, 9 * fs);
  const tw = ctx.measureText(parts.title).width;
  ctx.font = `400 ${15 * fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = "#ffcc4d";
  ctx.fillText(parts.time, 12 * fs + tw + 14 * fs, 10 * fs);
  if (parts.badge) {
    ctx.font = `500 ${11.5 * fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = "#ffe38a";
    ctx.fillText(parts.badge, 12 * fs, 31 * fs);
  }

  // Legends, bottom right (the model's above the radar's).
  let stackY = H - 10 * fs;
  for (const lg of [parts.legend, ...(parts.legends || [])]) {
    if (!lg?.bar) continue;
    const lw = 260 * fs, lh = 52 * fs, lx = W - lw - 10 * fs, ly = stackY - lh;
    stackY = ly - 6 * fs;
    ctx.fillStyle = "rgba(16,22,32,0.85)";
    roundRect(ctx, lx, ly, lw, lh, 8 * fs);
    ctx.fill();
    ctx.font = `${10.5 * fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = "#8b97a8";
    ctx.fillText(lg.title, lx + 10 * fs, ly + 6 * fs);
    const bx = lx + 10 * fs, bw = lw - 20 * fs, by = ly + 21 * fs;
    ctx.drawImage(lg.bar, bx, by, bw, 11 * fs);
    ctx.textAlign = "center";
    for (const [text, frac] of lg.ticks) ctx.fillText(text, bx + bw * frac, by + 14 * fs);
    ctx.textAlign = "left";
  }

  // Credits, bottom left, wrapped.
  if (parts.credits) {
    ctx.font = `${9 * fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(223,230,239,0.75)";
    const maxW = W - 300 * fs, lines = [];
    let line = "";
    for (const word of parts.credits.split(" ")) {
      if (line && ctx.measureText(`${line} ${word}`).width > maxW) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    ctx.textBaseline = "bottom";
    lines.forEach((l, i) => ctx.fillText(l, 10 * fs, H - 6 * fs - (lines.length - 1 - i) * 11 * fs));
  }
}

// Make the file. drawStep(i, ctx, W, H) renders and composites step i;
// holdMs(i) is how long step i stays on screen.
export async function record({ format, width, steps, drawStep, holdMs, onProgress }) {
  const { W, H } = outputSize(width);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: format === "gif" });

  if (format === "gif") {
    const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
    const gif = GIFEncoder();
    for (let i = 0; i < steps; i++) {
      await drawStep(i, ctx, W, H);
      const { data } = ctx.getImageData(0, 0, W, H);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: holdMs(i) });
      onProgress?.(i + 1, steps);
      await new Promise((r) => setTimeout(r, 0));        // let the page breathe
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: "image/gif" });
  }

  if ("VideoEncoder" in window) {
    const codec = await firstSupported(["avc1.640028", "avc1.4d0028", "avc1.42001f"], W, H);
    if (codec) {
      const { Muxer, ArrayBufferTarget } = await import(MP4MUX);
      const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
      let failure = null;
      const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
      enc.configure({ codec, width: W, height: H, bitrate: Math.round(W * H * 4), framerate: FPS });
      let n = 0;
      for (let i = 0; i < steps; i++) {
        await drawStep(i, ctx, W, H);
        // A fixed frame rate, holding each step for its time: plays the same everywhere.
        const repeats = Math.max(1, Math.round(holdMs(i) / 1000 * FPS));
        for (let k = 0; k < repeats; k++, n++) {
          const frame = new VideoFrame(canvas, { timestamp: n * 1e6 / FPS, duration: 1e6 / FPS });
          enc.encode(frame, { keyFrame: n % (FPS * 2) === 0 });
          frame.close();
        }
        if (failure) throw failure;
        onProgress?.(i + 1, steps);
        await new Promise((r) => setTimeout(r, 0));
      }
      await enc.flush();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: "video/mp4" });
    }
  }

  // Fallback: record the canvas in real time.
  const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error("this browser can't record video");
  const stream = canvas.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: W * H * 4 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start();
  for (let i = 0; i < steps; i++) {
    await drawStep(i, ctx, W, H);
    onProgress?.(i + 1, steps);
    await new Promise((r) => setTimeout(r, holdMs(i)));
  }
  rec.stop();
  await done;
  return new Blob(chunks, { type: type.split(";")[0] });
}

async function firstSupported(codecs, W, H) {
  for (const codec of codecs) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: W * H * 4, framerate: FPS });
      if (supported) return codec;
    } catch { /* try the next */ }
  }
  return null;
}

// Hand the file to the viewer.
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}
