// Sail plans and the physics the surface inspector uses to sail its boats more realistically:
//
// - Inventories: each boat's sails and its reefing sequence, from the owner's descriptions
//   (Cape George 31: three main reefs, yankees, staysail, storm staysail, trysail, spinnaker;
//   Pacific Seacraft 37: two deep reefs in the Port Townsend Sails style, the first a little
//   deeper than usual and the second like a third reef, a furling 115% genoa, staysail, storm
//   staysail, trysail, asymmetric spinnaker). Sail shapes are drawn in boats.js; areas and heights
//   come from those shapes.
// - Heel: the sails' heeling moment (½ρ·AWS²·area·side-force coefficient·height of effort above
//   the keel's centre of resistance, falling off as cos² of the heel) against the righting moment
//   (displacement·g·GM·sin heel), solved for the heel where they balance.
// - Reefing ("auto"): the fullest plan in the sequence that keeps the heel at or under ~20° in the
//   model's gusts, and never less reefed than a floor set by the gust strength (for running, where
//   the heel says little: rolling, broaching and gybe loads).
// - Leeway: λ ≈ K·heel/BSP² (the usual keelboat rule of thumb), capped at 10°.
// - Speed lost in waves: added resistance grows with wave height squared over waterline length,
//   worst in head seas, nothing in following seas.
// All of it is approximate: dimensions from published figures, stability and coefficients typical
// for heavy cruising cutters, not measured for these boats.

// Published-style dimensions (m) and the stylised rig (boats.js draws them).
export const BOATS = {
  cg31: { name: "Cape George 31", note: "traditional full-keel cutter", lod: 9.45, beam: 2.9, draft: 1.47, fb: [1.35, 0.95, 1.15],
          mastH: 13.0, mastAt: 0.42, sprit: 1.8, hull: 0x1f4f6b, deck: 0xcdb892 },
  ps37: { name: "Pacific Seacraft 37", note: "canoe-stern cutter", lod: 11.25, beam: 3.3, draft: 1.67, fb: [1.55, 1.05, 1.25],
          mastH: 15.5, mastAt: 0.44, sprit: 0.75, hull: 0xf1f0ea, deck: 0xd9d3c4 },
};

// Stability and hull figures (approximate). disp: kg; gm: metacentric height (m); lwl: m;
// leeK: leeway coefficient (deg·kn²/deg of heel); reefHeel: the heel (°) the auto plan reefs to.
export const HULL = {
  cg31: { disp: 7900, gm: 1.0, lwl: 7.85, leeK: 12, reefHeel: 20 },
  ps37: { disp: 7350, gm: 1.25, lwl: 8.46, leeK: 11, reefHeel: 20 },
};

// Main reefs: fraction of the luff (hoist) and foot left set. Trysail and headsails in boats.js.
export const REEFS = {
  cg31: [{ hoist: 1, foot: 1 }, { hoist: 0.86, foot: 0.94 }, { hoist: 0.72, foot: 0.88 }, { hoist: 0.57, foot: 0.8 }],
  ps37: [{ hoist: 1, foot: 1 }, { hoist: 0.76, foot: 0.9 }, { hoist: 0.56, foot: 0.8 }],   // PT Sails: deep 1st, 2nd ≈ a 3rd reef
};

// The reefing sequence, fullest first. main: reef number (0 = full) or "trysail"; heads:
// headsails ("staysail@reach" = the staysail only on a reach, where it doesn't choke the genoa's
// slot); genoa furl: fraction of the 115% genoa's LP left out. spin: plans used only off the
// wind in moderate air (never auto-chosen past the light-air limit).
// floor: gust (kt, true) at or above which the auto plan is at least this reefed.
export const PLANS = {
  cg31: [
    { id: "full", label: "Full main, yankee, staysail", short: "full main · yankee · staysail", main: 0, heads: ["yankee", "staysail"], floor: 0 },
    { id: "r1", label: "1 reef, yankee, staysail", short: "1 reef · yankee · staysail", main: 1, heads: ["yankee", "staysail"], floor: 22 },
    { id: "r1y", label: "1 reef, small yankee, staysail", short: "1 reef · small yankee · staysail", main: 1, heads: ["yankee2", "staysail"], floor: 26 },
    { id: "r2", label: "2 reefs, staysail", short: "2 reefs · staysail", main: 2, heads: ["staysail"], floor: 30 },
    { id: "r3", label: "3 reefs, staysail", short: "3 reefs · staysail", main: 3, heads: ["staysail"], floor: 35 },
    { id: "r3s", label: "3 reefs, storm staysail", short: "3 reefs · storm staysail", main: 3, heads: ["storm"], floor: 42 },
    { id: "try", label: "Trysail, storm staysail", short: "trysail · storm staysail", main: "trysail", heads: ["storm"], floor: 50 },
    { id: "spin", label: "Full main, spinnaker", short: "full main · spinnaker", main: 0, heads: [], spin: "sym", spinOnly: true },
  ],
  ps37: [
    { id: "full", label: "Full main, 115% genoa (+ staysail reaching)", short: "full main · 115% genoa", main: 0, heads: ["genoa", "staysail@reach"], furl: 1, floor: 0 },
    { id: "g90", label: "Full main, genoa rolled to ~90%", short: "full main · genoa ~90%", main: 0, heads: ["genoa"], furl: 0.78, floor: 20 },
    { id: "r1", label: "1 reef (deep), genoa ~90%", short: "1 reef · genoa ~90%", main: 1, heads: ["genoa"], furl: 0.78, floor: 23 },
    { id: "r1s", label: "1 reef (deep), staysail", short: "1 reef · staysail", main: 1, heads: ["staysail"], floor: 28 },
    { id: "r2", label: "2 reefs (≈ a 3rd), staysail", short: "2 reefs · staysail", main: 2, heads: ["staysail"], floor: 33 },
    { id: "r2s", label: "2 reefs, storm staysail", short: "2 reefs · storm staysail", main: 2, heads: ["storm"], floor: 42 },
    { id: "try", label: "Trysail, storm staysail", short: "trysail · storm staysail", main: "trysail", heads: ["storm"], floor: 50 },
    { id: "asym", label: "Full main, asymmetric spinnaker", short: "full main · asym spinnaker", main: 0, heads: [], spin: "asym", spinOnly: true },
  ],
};
// Spinnaker off the wind in moderate air (short-handed cruising): true wind angle range and the
// strongest gust (kt) it's flown in.
export const SPIN = { cg31: { twaMin: 100, twaMax: 180, gustMax: 15 }, ps37: { twaMin: 95, twaMax: 165, gustMax: 16 } };

// The headsails actually set on a plan at this true wind angle: from a broad reach down the
// staysail is dropped when a bigger headsail flies (the main blankets it); "@reach" staysails
// only between 70° and 120°.
export function activeHeads(plan, twa) {
  const out = [];
  const big = plan.heads.some((h) => h === "yankee" || h === "yankee2" || h === "genoa");
  for (const h of plan.heads) {
    const [name, cond] = h.split("@");
    if (cond === "reach" && !(twa >= 70 && twa < 120)) continue;
    if (name === "staysail" && big && twa >= 120) continue;
    out.push(name);
  }
  return out;
}

// Side (heeling) force coefficient against apparent wind angle (°), per m² of sail: highest
// close-hauled, falling as the sails are eased and the force turns forward, small running.
const CH = [[0, 0.3], [20, 0.85], [30, 1.05], [40, 1.15], [50, 1.1], [60, 1.0], [75, 0.85], [90, 0.65], [110, 0.45], [130, 0.28], [150, 0.15], [165, 0.08], [180, 0.05]];
export function sideCoef(awa) {
  const a = Math.min(180, Math.abs(awa));
  for (let i = 0; i < CH.length - 1; i++) if (a <= CH[i + 1][0]) { const [a0, c0] = CH[i], [a1, c1] = CH[i + 1]; return c0 + (c1 - c0) * (a - a0) / (a1 - a0); }
  return CH[CH.length - 1][1];
}

// Equilibrium heel (°) for sails with Σ area·arm = am (m³: each sail's area times the height of
// its centre of effort above the keel's centre of lateral resistance), apparent wind aws (m/s) at
// awa (°). Solved where heeling moment (∝ cos² heel) meets righting moment (∝ sin heel).
export function heelFor(key, am, aws, awa) {
  const H = HULL[key] || HULL.cg31, q = 0.5 * 1.225 * aws * aws * am * sideCoef(awa), rm = H.disp * 9.80665 * H.gm;
  if (!(q > 0)) return 0;
  let lo = 0, hi = Math.PI / 2 * 0.95;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2, c = Math.cos(m); if (q * c * c > rm * Math.sin(m)) lo = m; else hi = m; }
  return (lo * 180) / Math.PI;
}

// Leeway (°) from heel (°) and boat speed (kn): λ ≈ K·heel/BSP², capped at 10°.
export function leeway(key, heelDeg, bsp) {
  const K = (HULL[key] || HULL.cg31).leeK;
  return Math.min(10, (K * Math.max(0, heelDeg)) / Math.max(1.5, bsp) ** 2);
}

// Fraction of speed lost to waves. trains: [{a, kx, ky}] (amplitude m, wavenumber, pointing where
// the wave travels); hdg (°). Each train's height counts fully in head seas, a quarter abeam,
// nothing from astern: loss ≈ 0.5·Hs_eff²/LWL, capped at 45%.
export function waveLoss(key, trains, hdg) {
  const L = (HULL[key] || HULL.cg31).lwl, r = (hdg * Math.PI) / 180, hx = Math.sin(r), hy = Math.cos(r);
  let h2 = 0;
  for (const w of trains || []) {
    const k = Math.hypot(w.kx, w.ky);
    if (!(k > 0)) continue;
    const head = -(w.kx * hx + w.ky * hy) / k, f = ((1 + head) / 2) ** 2;      // 1 head seas, ¼ abeam, 0 following
    h2 += 8 * w.a * w.a * f;                                                  // Hs² = 16·Σ a²/2
  }
  return Math.min(0.45, (0.5 * h2) / L);
}

// The auto plan: the fullest plan whose heel in the gust stays at or under the boat's reefing
// heel, not below the gust floor; a spinnaker plan instead of the full plan off the wind in
// moderate air. sails(plan) → Σ area·arm (m³) for the plan at this twa; awsGust (m/s) the apparent
// wind in the gust at the sails' height; awa (°).
export function autoPlan(key, twa, gustKt, awsGust, awa, sails) {
  const P = PLANS[key] || PLANS.cg31, H = HULL[key] || HULL.cg31, S = SPIN[key];
  const seq = P.filter((p) => !p.spinOnly);
  let first = 0;
  for (let i = 0; i < seq.length; i++) if (gustKt >= seq[i].floor) first = i;       // the gust floor: at least this reefed
  let pick = seq[seq.length - 1];
  for (let i = first; i < seq.length; i++) if (heelFor(key, sails(seq[i]), awsGust, awa) <= H.reefHeel) { pick = seq[i]; break; }
  if (pick === seq[0] && S && twa >= S.twaMin && twa <= S.twaMax && gustKt <= S.gustMax) pick = P.find((p) => p.spinOnly) || pick;
  return pick;
}

// Headsails, per boat: where the tack is ("tip" of the bowsprit, the "stem", or the "inner"
// forestay a little aft of it), the head's height (fraction of the mast), how far aft the clew is
// (fraction of the tack-to-mast distance; over 1 overlaps the mast, as a 115% genoa does) and its
// height above the sheer. storm: high-visibility orange.
const HEADS = {
  cg31: { yankee: { tack: "tip", head: 0.97, back: 0.8, clewZ: 1.3 }, yankee2: { tack: "tip", head: 0.8, back: 0.62, clewZ: 1.7 },
          staysail: { tack: "stem", head: 0.72, back: 0.85, clewZ: 0.3 }, storm: { tack: "stem", head: 0.45, back: 0.55, clewZ: 0.9, storm: true } },
  ps37: { genoa: { tack: "tip", head: 0.97, back: 1.15, clewZ: 0.45 },
          staysail: { tack: "inner", head: 0.7, back: 0.85, clewZ: 0.3 }, storm: { tack: "inner", head: 0.45, back: 0.55, clewZ: 0.9, storm: true } },
};

// The sails of a plan (sailplan.js) as triangles, on port tack (clews to starboard, −y; the
// windward side +y), trimmed out by sheet (radians off the centreline: ~0.2 close-hauled to 1.3
// running). → [{name, tris: [[p0, p1, p2], …], color, area (m²), ceZ (m above the waterline)}].
export function sailShapes(key, { plan, sheet = 0.3, twa = 60 } = {}) {
  const b = BOATS[key], L = b.lod, [fa, fm] = b.fb, out = [];
  const sheerBow = fa, mx = L / 2 - b.mastAt * L, deckZ = fa + (fm - fa) * ((b.mastAt / 0.5) ** 1.4);
  const boomZ = deckZ + 1.2, boomLen = L * 0.42, top = b.mastH * 0.95;
  const clew = (x0, y0, len, z) => [x0 - len * Math.cos(sheet), y0 - len * Math.sin(sheet), z];
  const add = (name, tris, color = 0xfbfaf5, edge = null) => {
    let area = 0, mz = 0;
    for (const [p, q, r] of tris) {
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const a = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      area += a; mz += a * (p[2] + q[2] + r[2]) / 3;
    }
    out.push({ name, tris, color, area, ceZ: area ? mz / area : 0, ...(edge || { luff: [tris[0][0], tris[0][1]], clew: tris[0][2] }) });
  };
  const ORANGE = 0xff7a2e;
  // Main (reefed: a lower head and the clew pulled forward along the boom) or the trysail.
  if (plan.main === "trysail") {
    const tz = boomZ + 0.5, hz = tz + (top - boomZ) * 0.42;
    add("trysail", [[[mx, 0, tz], [mx, 0, hz], clew(mx, 0, boomLen * 0.55, boomZ + 0.9)]], ORANGE);
  } else {
    const r = (REEFS[key] || [])[plan.main] || { hoist: 1, foot: 1 };
    add("main", [[[mx, 0, boomZ], [mx, 0, boomZ + (top - boomZ) * r.hoist], clew(mx, 0, boomLen * r.foot, boomZ)]]);
  }
  // Headsails.
  const stem = [L / 2, 0, sheerBow], tip = [L / 2 + b.sprit, 0, sheerBow - 0.1], inner = [L / 2 - 0.6, 0, sheerBow - 0.05];
  for (const name of activeHeads(plan, twa)) {
    const h = HEADS[key]?.[name];
    if (!h) continue;
    const t = h.tack === "tip" ? tip : h.tack === "inner" ? inner : stem, head = [mx + (t[0] - mx) * 0.02, 0, b.mastH * h.head];
    let c = clew(t[0], 0, (t[0] - mx) * h.back, sheerBow * 0.75 + h.clewZ);
    if (name === "genoa" && plan.furl < 1) {                               // roller-furled: the clew rolls in toward the luff
      const f = 1 - plan.furl, lz = t[2] + (head[2] - t[2]) * 0.3, lx = t[0] + (head[0] - t[0]) * 0.3;
      c = [c[0] + (lx - c[0]) * f, c[1] * (1 - f), c[2] + (lz - c[2]) * f];
    }
    add(name, [[t, head, c]], h.storm ? ORANGE : 0xfbfaf5);
  }
  // Spinnaker: a bellied sail ahead of the rig. Symmetric: tack on a pole to windward; asymmetric:
  // tack at the bowsprit end. Clew out to leeward.
  if (plan.spin) {
    const sym = plan.spin === "sym", aPole = (Math.min(85, Math.max(15, twa - 90)) * Math.PI) / 180, pole = L / 2 - mx;
    const T = sym ? [mx + pole * Math.cos(aPole), pole * Math.sin(aPole), deckZ + 1.3] : [tip[0], 0, sheerBow + 0.4];
    const H = [mx + 1.2, 0, b.mastH * 0.93], C = [mx + (sym ? 0.6 : -0.6), -(b.beam / 2 + (sym ? 3.2 : 2.4)), deckZ + (sym ? 1.8 : 1.6)];
    const chord = Math.hypot(T[0] - C[0], T[1] - C[1]), bx = 0.62, by = -0.4, depth = 0.32 * chord, NU = 8, NV = 10, P = [];
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
      const v = j / NV, u = i / NU, w = 1 - v;                             // v up to the head, u tack → clew
      const bx0 = T[0] + (C[0] - T[0]) * u, by0 = T[1] + (C[1] - T[1]) * u, bz0 = T[2] + (C[2] - T[2]) * u;
      const x = bx0 * w + H[0] * v, y = by0 * w + H[1] * v, z = bz0 * w + H[2] * v;
      const belly = depth * 4 * u * (1 - u) * Math.sin(Math.PI * Math.min(1, v * 1.15)) * w ** 0.3;
      P.push([x + bx * belly, y + by * belly, z]);
    }
    const tris = [];
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const a = j * (NU + 1) + i; tris.push([P[a], P[a + 1], P[a + NU + 1]], [P[a + 1], P[a + NU + 2], P[a + NU + 1]]); }
    add("spinnaker", tris, sym ? 0xd8453b : 0x2f6fd0, { luff: [T, H], clew: C });
  }
  return out;
}

// Σ area × height of effort above the keel's centre of lateral resistance (m³), for the heel.
export function sailMoment(key, plan, twa) {
  const clr = 0.45 * BOATS[key].draft;
  return sailShapes(key, { plan, twa }).reduce((a, s) => a + s.area * (s.ceZ + clr), 0);
}
export const sailArea = (key, plan, twa) => sailShapes(key, { plan, twa }).reduce((a, s) => a + s.area, 0);


// Lift and drag coefficients of a cruising sail plan against apparent wind angle (°), trimmed as
// the boat trims (eased with the angle): attached flow and most lift reaching; from ~110° the
// eased sails start to stall and by a run they're mostly separated (drag, not lift). sep: 0
// attached … 1 fully separated. Consistent with sideCoef (side = CL·cos β + CD·sin β).
const CLT = [[0, 0], [15, 0.4], [25, 0.95], [35, 1.25], [50, 1.4], [75, 1.4], [95, 1.3], [115, 1.05], [135, 0.75], [155, 0.45], [180, 0.25]];
export function sailCoefs(awa) {
  const a = Math.min(180, Math.abs(awa));
  let cl = 0;
  for (let i = 0; i < CLT.length - 1; i++) if (a <= CLT[i + 1][0]) { const [a0, c0] = CLT[i], [a1, c1] = CLT[i + 1]; cl = c0 + (c1 - c0) * (a - a0) / (a1 - a0); break; }
  const sep = Math.min(1, Math.max(0, (a - 105) / 55));
  const cd = 0.08 + 0.07 * cl * cl + 1.0 * sep;               // profile + induced + separated-flow drag
  return { cl, cd, sep };
}
// Sail forces (N) for area A (m²) in apparent wind aws (m/s) at awa (°): drive (forward) and
// side (heeling), from lift across and drag along the apparent wind.
export function sailForces(A, aws, awa) {
  const { cl, cd, sep } = sailCoefs(awa), b = (Math.min(180, Math.abs(awa)) * Math.PI) / 180, q = 0.5 * 1.225 * aws * aws * A;
  // (Off the wind lift turns to windward while the sails, near square to the boat, push mostly
  // forward: the heeling part is kept small but to leeward.)
  return { drive: q * (cl * Math.sin(b) - cd * Math.cos(b)), side: q * Math.max(0.05, cl * Math.cos(b) + cd * Math.sin(b)), cl, cd, sep };
}
