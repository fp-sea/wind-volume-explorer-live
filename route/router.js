// Passage routing: the fastest way through a list of waypoints in changing conditions.
//
// Method: isochrones, the standard one for weather routing. From the start, every few minutes
// (the time step), each point on the current front tries headings in a fan (every few degrees
// round the bearing to the next waypoint); where each would get to comes from the boat's speed
// in the conditions there and then (polar speed at the true wind angle, less the waves, or the
// engine) plus the current's set and drift. The new front steps on until one reaches the waypoint
// (heading straight for it, allowing for the current, once it's in reach). Pruning: one point
// per ~0.8 km cell (the one with the least distance to go by water, round the land), and a beam
// of the best few hundred; in waters full of islands this finds the way round where the textbook
// "farthest from the start in each direction" loses it. Moves that cross land,
// come closer to shore than the clearance, or end in conditions past the limits (gust, sea
// height, a dangerous wind-against-current spot) are dropped. A tack or gybe costs time.
// Legs are routed in turn, each starting when the last arrives.
//
// env (built from the explorer, route/env.js), all in scene km, times in ms:
//   cond(x, y, t) → {u, v (10 m wind m/s, toward), g (gust m/s), cu, cv (current m/s), hs, tp,
//                    from (° the chop comes from), rating (0-2 wind against current)} or null
//   water(x, y) → bool;  clear(x, y) → km to land;  tMax: the forecast's end (ms)
// boat: {key, polar(tws kt, twa °) → kn, lwl m, motorKn, motorBelow, tackS, gybeS, noGo °}

const KNKM = 1.852 / 3600;                        // knots → km/s
const rad = Math.PI / 180;
const wrap = (a) => ((a % 360) + 360) % 360;
const signedDiff = (a, b) => ((a - b + 540) % 360) - 180;          // a − b in −180…180
const bearing = (x0, y0, x1, y1) => wrap(Math.atan2(x1 - x0, y1 - y0) / rad);

// Leeway (°) sailing at twa (°): a few degrees on the wind, none off it (a heavy full keel).
const leewayAt = (twa) => { const a = Math.abs(twa); return a >= 110 ? 0 : 5 * Math.min(1, (110 - a) / 60); };

// The boat's best speed under sail in true wind tws (kt), on its fastest point of sail (per boat,
// by the half knot).
const best = new WeakMap();
export function bestSail(boat, tws) {
  let m = best.get(boat); if (!m) best.set(boat, (m = new Map()));
  const k = Math.round(tws * 2);
  let v = m.get(k);
  if (v === undefined) { v = 0; for (let a = Math.max(45, boat.noGo || 0); a <= 180; a += 7.5) v = Math.max(v, boat.polar(k / 2, a)); m.set(k, v); }
  return v;
}

// The boat through the water from a point with conditions c, on heading h (°): speed (kn), the
// course through the water (°), whether motoring, and which side the wind is on (+1 starboard).
export function boatMove(boat, c, h, opts) {
  if (opts.fixedKn) return { bsp: opts.fixedKn, cogW: h, motor: false, side: 0, twa: NaN, tws: NaN, loss: 0 };
  const wu = c.u - (opts.currents ? c.cu : 0), wv = c.v - (opts.currents ? c.cv : 0);           // wind over the water
  const tws = Math.hypot(wu, wv) * 1.943844, from = wrap(Math.atan2(-wu, -wv) / rad);
  const twa = signedDiff(from, h), side = twa >= 0 ? 1 : -1;
  let bsp = Math.abs(twa) < boat.noGo ? 0 : boat.polar(tws, Math.abs(twa));
  // Waves: speed lost in proportion to height² over waterline length, full in head seas.
  const head = Math.cos(signedDiff(c.from ?? from, h) * rad), f = ((1 + head) / 2) ** 2;
  const loss = Math.min(0.45, (0.5 * ((c.hs || 0) ** 2 * f + (c.swell2 || 0) * 0.25)) / boat.lwl);
  bsp *= 1 - loss;
  // Motoring: when the boat can't sail at motorBelow on any point of sail in this wind (light air),
  // not merely on this heading (to windward it would otherwise motor whenever that beat tacking).
  if (opts.motor && bestSail(boat, tws) * (1 - loss) < boat.motorBelow) return { bsp: boat.motorKn * (1 - loss * 0.5), cogW: h, motor: true, side: 0, twa, tws, loss };
  // Narrow channels (under opts.narrowKm wide: Agate Passage, Port Townsend Canal, Deception Pass,
  // the Swinomish Channel, tight harbour entrances): no room to sail or tack, so the engine, even
  // with light-air motoring off. (c.shore: the distance to shore here, so the width is about twice it.)
  if (opts.narrowKm > 0 && c.shore != null && c.shore * 2 < opts.narrowKm) return { bsp: boat.motorKn * (1 - loss * 0.5), cogW: h, motor: true, narrow: true, side: 0, twa, tws, loss };
  return { bsp, cogW: h - side * leewayAt(twa), motor: false, side, twa, tws, loss };
}

// Is the straight move from (x0, y0) to (x1, y1) on water and clear of the shore? (sampled every
// 0.1 km; in narrow passes the clearance narrows (env.clearOk); within the clearance + 1.5 km of a waypoint it's waived: harbours are near land)
function clearPath(env, x0, y0, x1, y1, clearKm, wps, ease = null) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / 0.1));
  const pm = env.passMask ? env.passMask(clearKm, wps, ease) : null;
  for (let k = 1; k <= n; k++) {
    const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
    if (pm) { if (!env.passable(x, y, pm)) return env.water(x, y) ? "clearance" : "land"; continue; }
    if (!env.water(x, y)) return "land";
    if (clearKm > 0 && !(env.clearOk ? env.clearOk(x, y, clearKm) : env.clear(x, y) >= clearKm) && !wps.some((w) => Math.hypot(w.x - x, w.y - y) < clearKm + 1.5)) return "clearance";
  }
  return true;
}

// Conditions past the limits? → the limit's name, or "" if within them.
function tooMuch(c, lim) {
  if (!c) return "outside the forecast";
  if (lim.maxGustKt && (c.g ?? Math.hypot(c.u, c.v)) * 1.943844 > lim.maxGustKt) return "gust";
  if (lim.maxHsM && Math.sqrt((c.hs || 0) ** 2 + (c.swell2 || 0)) > lim.maxHsM) return "seas";
  if (lim.avoidDanger && c.rating >= 2) return "dangerous wind against current";
  return "";
}
const WHY = { land: "land", clearance: "the clearance off land", gust: "gusts over the limit", seas: "seas over the limit", "dangerous wind against current": "dangerous wind against current", "outside the forecast": "the edge of the forecast area" };

// One leg, from `a` at time t0 to `b`. → {ok, pts: [{x, y, t, ...conditions and move}], reason}
// gateKm: for a waypoint to be rounded rather than touched: arriving anywhere within it (the leg
// then ends where it passed). → also, when it can't finish, `partial` (the route to the point that
// got nearest) and `why` (what stopped the last moves most, and where).
export async function routeLeg(env, boat, opts, a, b, t0, { wps = [a, b], onStep, signal, gateKm = 0, first = true, last = true } = {}) {
  const dt = (opts.dtMin || 10) * 60e3, dh = opts.dhDeg || 5, lim = opts.limits || {}, cellKm = opts.cellKm || 0.8, beam = opts.beam || 400;
  // Progress is measured as distance to go by water (round the land) when env knows it.
  const togo = env.toGo ? env.toGo(b.x, b.y, lim.clearKm || 0, wps, lim.ease) : (x, y) => Math.hypot(x - b.x, y - b.y);
  // Tide gates on this leg (narrow water on the way by water): the boat may hold at their
  // approaches for the current to ease or turn. Holding and pushing on both go forward, and
  // whichever gets there first wins: through against a foul current when the boat still makes good
  // progress, waiting when the turn comes soon enough to pay.
  const gates = opts.allowGateHold === false ? [] : findGates(env, togo, a, b, Math.max(opts.narrowKm || 0, GATE_KM), { first, last });
  const start = { x: a.x, y: a.y, t: t0, parent: null, side: 0, c: env.cond(a.x, a.y, t0) };
  if (!start.c) return { ok: false, reason: "no forecast at the start (outside the model's area or time)" };
  let front = [start], rej = {}, recent = [], bestD2 = Infinity, bestAt = 0;
  const nearest = () => front.reduce((q, p) => (p.d2 ?? Infinity) < (q.d2 ?? Infinity) ? p : q, front[0]);
  const fail = (reason) => { const n = nearest(), all = {}; for (const r of [...recent, rej]) for (const [k, v] of Object.entries(r)) all[k] = (all[k] || 0) + v; const top = Object.entries(all).sort((p, q) => q[1] - p[1])[0]; return { ok: false, reason, partial: n && n !== start ? trace(n) : null, why: top ? { what: WHY[top[0]] || top[0], x: n?.x, y: n?.y, t: n?.t } : null }; };
  const maxSteps = Math.ceil((opts.maxHours || 96) * 3600e3 / dt);
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { ok: false, reason: "stopped" };
    const t = t0 + step * dt;
    if (t + dt > env.tMax) return fail(`the passage runs past the end of the forecast (${new Date(env.tMax).toISOString().slice(0, 16).replace("T", " ")} UTC)`);
    const next = new Map();
    recent.push(rej); if (recent.length > Math.max(2, 3600e3 / dt)) recent.shift();   // (the last hour's rejections, for the "why")
    rej = {};
    let arrive = null;
    for (const p of front) {
      const c = p.c, brg = bearing(p.x, p.y, b.x, b.y), dist = Math.hypot(b.x - p.x, b.y - p.y);
      // Waiting in harbour (at anchor or alongside) near the leg's start, for a fair tide or a
      // better wind: kept when sailing about gets no nearer.
      if (opts.allowWait !== false && Math.hypot(p.x - a.x, p.y - a.y) < 1.5) {
        const d2 = togo(p.x, p.y), k = `${Math.floor(p.x / cellKm)},${Math.floor(p.y / cellKm)}`, prev = next.get(k), c1 = env.cond(p.x, p.y, t + dt);
        if (c1 && (!prev || prev.d2 > d2 - 0.2)) next.set(k, { x: p.x, y: p.y, t: t + dt, parent: p, h: p.h, m: { hold: true, bsp: 0, motor: false, side: p.side }, side: p.side, c: c1, d2, sog: 0 });
      }
      // Holding (anchored, or standing off out of the stream) for the current to ease or turn: at a
      // tide gate's approach, or wherever a strong current (0.8 kt+) is foul along the way within
      // ~2 nm of shore; never in narrow water itself; up to 7 h (about a tide) at a time, and as
      // often as it pays. One holding point per cell, apart from the moving ones.
      if (opts.allowHold !== false && Math.hypot(p.x - a.x, p.y - a.y) >= 1.5) {
        const roomy = c.shore == null || c.shore * 2 >= HOLD_ROOM_KM, since = p.m?.gate ? p.holdT0 : t;
        if (roomy && t + dt - since <= 7 * 3600e3) {
          const gate = gates.find((g) => Math.hypot(g.x - p.x, g.y - p.y) < 3);
          let foul = false;
          // (strong enough to matter: a third of the boat's motoring speed, and at least 0.8 kt)
          const strong = Math.max(0.41, 0.35 * (boat.motorKn || 5) * KNKM * 1000);
          if (!gate && opts.currents && c.shore != null && c.shore <= 3.7 && Math.hypot(c.cu, c.cv) > strong) {
            const e = 0.3, gx = togo(p.x + e, p.y) - togo(p.x - e, p.y), gy = togo(p.x, p.y + e) - togo(p.x, p.y - e), gl = Math.hypot(gx, gy);
            foul = Number.isFinite(gl) && gl > 0 && (c.cu * -gx + c.cv * -gy) / gl < -strong;   // (the way on is down the guide)
          }
          if (gate || foul) {
            const d2 = togo(p.x, p.y), k = `${Math.floor(p.x / cellKm)},${Math.floor(p.y / cellKm)}|h`, prev = next.get(k), c1 = env.cond(p.x, p.y, t + dt);
            if (c1 && Number.isFinite(d2) && (!prev || prev.d2 > d2)) next.set(k, { x: p.x, y: p.y, t: t + dt, parent: p, h: p.h, m: { hold: true, gate: true, gateAt: gate ? { x: gate.x, y: gate.y } : null, bsp: 0, motor: false, side: p.side }, side: p.side, c: c1, d2, sog: 0, holdT0: since });
          }
        }
      }
      const hs = [];
      for (let o = -150; o <= 150; o += dh) hs.push(wrap(brg + o));
      // Straight for the waypoint, allowing for the current, when it's within a step or two.
      let direct = null;
      if (dist < 2.5 * 9 * KNKM * (dt / 1000)) {                    // (within 2½ steps at 9 kn)
        let h = brg;
        for (let k = 0; k < 3; k++) {
          const m = boatMove(boat, c, h, opts);
          if (!(m.bsp > 0)) break;
          const vx = Math.sin(m.cogW * rad) * m.bsp * KNKM + (opts.currents ? c.cu / 1000 : 0), vy = Math.cos(m.cogW * rad) * m.bsp * KNKM + (opts.currents ? c.cv / 1000 : 0);
          h = wrap(h + signedDiff(brg, bearing(0, 0, vx, vy)));
        }
        direct = h; hs.push(h);
      }
      // In a narrow channel: motor along it, following the way by water (the guide), for the
      // distance this step covers (with the current along the way), not in straight lines that
      // can't stay in a winding channel (the Swinomish Channel).
      if (opts.narrowKm > 0 && c.shore != null && c.shore * 2 < opts.narrowKm) {
        const m = boatMove(boat, c, brg, opts), st = 0.2;
        let x = p.x, y = p.y, h0 = null, gone = 0, total = null;
        for (let n = 0; n < 200; n++) {
          let bx = null, bd = togo(x, y) - 0.05;
          for (let o = 0; o < 360; o += 22.5) { const nx = x + Math.sin(o * rad) * st, ny = y + Math.cos(o * rad) * st, d = togo(nx, ny); if (d < bd) { bd = d; bx = [nx, ny, o]; } }
          if (!bx) break;
          if (h0 == null) { h0 = bx[2]; const along = opts.currents ? (c.cu * Math.sin(h0 * rad) + c.cv * Math.cos(h0 * rad)) / 1000 : 0; total = Math.max(0.3 * KNKM, m.bsp * KNKM + along) * (dt / 1000); }
          if (gone + st > total) break;
          [x, y] = bx; gone += st;
          if (Math.hypot(x - b.x, y - b.y) < 0.25) {
            const ta = t + (gone / total) * dt;
            if (!arrive || ta < arrive.t) arrive = { x: b.x, y: b.y, t: ta, parent: p, h: h0, m: { ...m, motor: true, narrow: true, side: 0 }, side: p.side, sog: (total / (dt / 1000)) / KNKM };
            break;
          }
        }
        if (gone > 0 && !arrive) {
          const d2 = togo(x, y), k = `${Math.floor(x / cellKm)},${Math.floor(y / cellKm)}`, prev = next.get(k), c1 = env.cond(x, y, t + dt);
          if (c1 && Number.isFinite(d2) && (!prev || prev.d2 > d2)) next.set(k, { x, y, t: t + dt, parent: p, h: h0, m: { ...m, motor: true, narrow: true, side: 0 }, side: p.side, c: c1, d2, sog: (gone / (dt / 1000)) / KNKM });
        }
      }
      for (const h of hs) {
        const m = boatMove(boat, c, h, opts);
        if (!(m.bsp > 0.2)) continue;
        const pen = !m.motor && p.side && m.side && m.side !== p.side ? (Math.abs(m.twa) < 90 ? boat.tackS : boat.gybeS) * 1000 : 0;
        const run = Math.max(0, dt - pen) / 1000;
        const vx = Math.sin(m.cogW * rad) * m.bsp * KNKM + (opts.currents ? c.cu / 1000 : 0), vy = Math.cos(m.cogW * rad) * m.bsp * KNKM + (opts.currents ? c.cv / 1000 : 0);
        const x = p.x + vx * run, y = p.y + vy * run;
        // Reaching the waypoint on this move: the closest approach of the track to it.
        const L2 = (x - p.x) ** 2 + (y - p.y) ** 2, u = L2 > 0 ? Math.max(0, Math.min(1, ((b.x - p.x) * (x - p.x) + (b.y - p.y) * (y - p.y)) / L2)) : 0;
        const miss = Math.hypot(p.x + u * (x - p.x) - b.x, p.y + u * (y - p.y) - b.y);
        // (Caught when the move passes within ~60% of its own length; tacking up to a waypoint the
        // moves step past it otherwise. The small gap left is covered at the boat's speed.)
        const segLen = Math.sqrt(L2), catchKm = Math.max(gateKm, h === direct ? 0.12 : Math.max(0.35, 0.6 * segLen)), sogKmS = segLen / Math.max(1, run);
        if (u < 1 && miss < catchKm) {
          // A gate: the leg ends where the move passes it; a waypoint: at the point itself.
          const gx = p.x + u * (x - p.x), gy = p.y + u * (y - p.y), within = gateKm > 0 && miss <= gateKm;
          const ta = t + pen + u * run * 1000 + (within ? 0 : (miss / Math.max(1e-4, sogKmS)) * 1000);
          if (!arrive || ta < arrive.t) {
            if (clearPath(env, p.x, p.y, within ? gx : b.x, within ? gy : b.y, 0, wps) === true) arrive = { x: within ? gx : b.x, y: within ? gy : b.y, t: ta, parent: p, h, m, side: m.side || p.side, sog: Math.hypot(vx, vy) / KNKM };
          }
          continue;
        }
        // One point per ~0.8 km cell: the one with the least distance to go.
        const d2 = togo(x, y);
        if (!Number.isFinite(d2)) continue;
        const k = `${Math.floor(x / cellKm)},${Math.floor(y / cellKm)}`, prev = next.get(k);
        if (prev && (prev.d2 <= d2 || (prev.m?.hold && prev.d2 <= d2 + 0.2))) continue;
        const cp = clearPath(env, p.x, p.y, x, y, lim.clearKm || 0, wps, lim.ease);
        if (cp !== true) { rej[cp] = (rej[cp] || 0) + 1; continue; }
        const c1 = env.cond(x, y, t + dt), bad = tooMuch(c1, lim);
        if (bad) { rej[bad] = (rej[bad] || 0) + 1; continue; }
        next.set(k, { x, y, t: t + dt, parent: p, h, m, side: m.side || p.side, c: c1, d2, sog: Math.hypot(vx, vy) / KNKM });
      }
    }
    if (arrive) { arrive.c = env.cond(arrive.x, arrive.y, arrive.t) || arrive.parent.c; return { ok: true, pts: trace(arrive) }; }
    // The beam: the best points by distance to go, and none that have wandered far behind the best.
    const prevFront = front;
    front = [...next.values()].sort((p, q) => p.d2 - q.d2);
    if (front.length) {
      const lim2 = front[0].d2 + 30;
      // (at most 40 of the beam holding: where currents run strong along many shores (SSCOFS) the
      // holds would otherwise crowd out the moving points and slow the search right down)
      let held = 0; front = front.filter((p) => p.d2 <= lim2 && (!(p.m?.hold && p.m.gate) || ++held <= 40)).slice(0, beam);
    }
    if (!front.length) { front = prevFront; const f = fail("no way through"); return f; }
    // Stuck: no nearer by 0.5 km in 6 hours (other than waiting in harbour).
    const moving = front.find((p) => !p.m?.hold), waiting = front.some((p) => p.m?.hold);
    if (moving && moving.d2 < bestD2 - 0.5) { bestD2 = moving.d2; bestAt = step; }
    else if (moving && !waiting && (step - bestAt) * dt > 6 * 3600e3) return fail("stuck: no progress for 6 hours");
    onStep?.(step, front);
    if (step % 4 === 3) await new Promise((r) => setTimeout(r, 0));   // keep the page responsive
  }
  return fail(`not there after ${opts.maxHours || 96} h`);
}
// Narrow water (under wKm wide) on the way by water from a to b, away from both ends: the first
// point of each stretch (its approach from a), following the guide's descent in 0.2 km steps.
const GATE_KM = 0.926, HOLD_ROOM_KM = 0.55;
// (Harbour entrances at the passage's start and end aren't gates; a pass at a via waypoint is.)
function findGates(env, togo, a, b, wKm, { first = true, last = true } = {}) {
  if (!env.clear) return [];
  const out = []; let x = a.x, y = a.y, prev = null;
  for (let n = 0; n < 4000; n++) {
    let bx = null, bd = togo(x, y) - 0.05;
    for (let o = 0; o < 360; o += 22.5) { const nx = x + Math.sin(o * rad) * 0.2, ny = y + Math.cos(o * rad) * 0.2, d = togo(nx, ny); if (d < bd) { bd = d; bx = [nx, ny]; } }
    if (!bx) break;
    [x, y] = bx;
    if ((first && Math.hypot(x - a.x, y - a.y) < 2) || (last && Math.hypot(x - b.x, y - b.y) < 2)) continue;
    if (env.clear(x, y) * 2 < wKm) { if (!prev || Math.hypot(x - prev.x, y - prev.y) > 2) out.push({ x, y }); prev = { x, y }; }
  }
  return out;
}
function trace(p) { const out = []; for (let q = p; q; q = q.parent) out.push(q); return out.reverse().map(({ parent, d2, ...q }) => q); }

// The whole route through the waypoints. → {ok, pts, legs: [{from, to, t0, t1}], reason}
// The clearance for a leg: the one asked for, unless it closes the passes the natural way goes
// through; then the largest of ½, 0.1 nm, 0.05 nm (or none) whose way by water is within ~15%
// (+1 km) of the way with no clearance at all, eased only near the narrow places (env.easeFor:
// within 1.5 km of them; the full clearance holds elsewhere), or for the whole leg where that
// can't be found. → {clearKm, ease, eased: {from, to, extraKm, spots} | null}
export function legClearance(env, a, b, clearKm, wps) {
  if (!env.toGo || !(clearKm > 0)) return { clearKm: clearKm || 0, eased: null };
  const d = (c) => env.toGo(b.x, b.y, c, wps)(a.x, a.y), d0 = d(0), dc = d(clearKm);
  if (!Number.isFinite(d0) || dc <= d0 * 1.15 + 1) return { clearKm, eased: null };
  const extraKm = Number.isFinite(dc) ? dc - d0 : Infinity;
  for (const c of [clearKm / 2, 0.185, 0.093, 0].filter((c) => c < clearKm)) {
    const dcc = c ? d(c) : d0;
    if (dcc > d0 * 1.15 + 1) continue;
    const ease = env.easeFor?.(a, b, clearKm, c, wps);
    if (ease && env.toGo(b.x, b.y, clearKm, wps, ease)(a.x, a.y) <= dcc * 1.15 + 1) return { clearKm, ease, eased: { from: clearKm, to: c, extraKm, spots: ease.spots } };
    return { clearKm: c, eased: { from: clearKm, to: c, extraKm } };
  }
  return { clearKm: 0, eased: { from: clearKm, to: 0, extraKm } };
}

export async function planRoute(env, boat, opts, wps, t0, { onProgress, signal } = {}) {
  let t = t0, pts = [];
  const legs = [], eased = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const from = i ? pts.at(-1) : wps[0], last = i === wps.length - 2;
    const lc = legClearance(env, from, wps[i + 1], opts.limits?.clearKm || 0, wps);
    if (lc.eased) eased.push({ leg: i + 1, ...lc.eased });
    const legOpts = lc.eased ? { ...opts, limits: { ...opts.limits, clearKm: lc.clearKm, ease: lc.ease || null } } : opts;
    const r = await routeLeg(env, boat, legOpts, { x: from.x, y: from.y }, wps[i + 1], t, { wps, signal, gateKm: last ? 0 : opts.gateKm || 0, first: i === 0, last, onStep: (s) => onProgress?.({ leg: i, step: s }) });
    if (!r.ok) return { ok: false, reason: `leg ${i + 1}: ${r.reason}`, why: r.why, legs, pts, eased, partial: r.partial ? (pts.length ? pts.concat(r.partial.slice(1)) : r.partial) : pts.length ? pts : null };
    legs.push({ from: i, to: i + 1, t0: t, t1: r.pts[r.pts.length - 1].t });
    pts = pts.length ? pts.concat(r.pts.slice(1)) : r.pts;
    t = r.pts[r.pts.length - 1].t;
  }
  return { ok: true, pts, legs, eased };
}

// Along a fixed track (points {x, y}), at a steady speed through the water (kn), holding the track
// against the current's cross-set: the time taken, starting at t0. → {t1, foulMin, fairMin, maxFoulKt}
// (ms, minutes against / with more than ½ kt of current). null if a stretch can't be made good
// (a cross-set stronger than the boat, or a foul current faster than it).
export function alongTrack(env, track, kn, t0, { currents = true } = {}) {
  let t = t0, foul = 0, fair = 0, maxFoul = 0;
  const V = kn * 0.514444;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1], d = Math.hypot(b.x - a.x, b.y - a.y) * 1000;
    if (d < 1) continue;
    const n = Math.max(1, Math.ceil(d / 600)), ex = (b.x - a.x) / (d / 1000), ey = (b.y - a.y) / (d / 1000);
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      const c = currents ? env.current(x, y, t) : null, cu = c?.u || 0, cv = c?.v || 0;
      const along = cu * ex + cv * ey, cross = -cu * ey + cv * ex;
      if (Math.abs(cross) >= V) return null;
      const sog = Math.sqrt(V * V - cross * cross) + along;
      if (sog <= 0.1) return null;
      const s = d / n / sog;
      if (along < -0.257) foul += s; else if (along > 0.257) fair += s;
      maxFoul = Math.max(maxFoul, -along * 1.943844);
      t += s * 1000;
    }
  }
  return { t1: t, foulMin: foul / 60, fairMin: fair / 60, maxFoulKt: maxFoul };
}
