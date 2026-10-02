// Stylised sailboats for the surface inspector, for scale: proportions from published
// dimensions (length on deck, beam, draft); rig heights approximate; hull lines simplified
// (a canoe-sterned double-ender with a full keel, which both of these are in spirit).
// Built along +x (bow) with z up; sails set for a close reach and heeled by the caller.

import * as THREE from "three";
import { BOATS, PLANS, sailShapes } from "./sailplan.js?v=20261002173952";
export { BOATS };

export const boatForRegion = (id) => (id === "hawaii" ? "cg31" : "ps37");

// plan: a PLANS entry (sailplan.js); sheet: trim (radians); twa: true wind angle (°), for which
// headsails fly and the spinnaker pole.
export function buildBoat(key, { sheet = 0.3, plan = PLANS[key][0], twa = 60 } = {}) {
  const b = BOATS[key], L = b.lod, B = b.beam, g = new THREE.Group();
  const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, ...opts });
  // Hull: rings along the length (u = 0 bow … 1 stern), each from port sheer round the bottom to starboard.
  const NU = 28, NV = 14, pos = [], idx = [];
  const sheer = (u) => { const [a, m, s] = b.fb; return u < 0.5 ? a + (m - a) * (u / 0.5) ** 1.4 : m + (s - m) * ((u - 0.5) / 0.5) ** 1.6; };
  const half = (u) => (B / 2) * Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), 0.62);
  const body = (u) => 0.55 * Math.pow(Math.sin(Math.PI * u), 0.8);        // canoe body depth below the waterline
  for (let i = 0; i <= NU; i++) {
    const u = i / NU, x = L / 2 - u * L, hb = half(u), zs = sheer(u), zb = -body(u);
    for (let j = 0; j <= NV; j++) {
      const ph = (j / NV) * Math.PI;
      pos.push(x, hb * Math.cos(ph), zs - (zs - zb) * Math.pow(Math.sin(ph), 0.85));
    }
  }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * (NV + 1) + j, c = a + NV + 1;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.setIndex(idx); hullGeo.computeVertexNormals();
  g.add(new THREE.Mesh(hullGeo, mat(b.hull)));
  // Deck: a strip between the two sheers.
  const dpos = [], didx = [];
  for (let i = 0; i <= NU; i++) { const u = i / NU, x = L / 2 - u * L, hb = half(u), z = sheer(u); dpos.push(x, hb, z, x, -hb, z); }
  for (let i = 0; i < NU; i++) { const a = 2 * i; didx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute("position", new THREE.Float32BufferAttribute(dpos, 3)); deckGeo.setIndex(didx); deckGeo.computeVertexNormals();
  g.add(new THREE.Mesh(deckGeo, mat(b.deck)));
  // Full keel: a plate under the middle, down to the draft.
  const ks = new THREE.Shape();
  ks.moveTo(L * 0.34, -0.3); ks.lineTo(L * 0.1, -b.draft); ks.lineTo(-L * 0.36, -b.draft); ks.lineTo(-L * 0.44, -0.3);
  const keel = new THREE.Mesh(new THREE.ExtrudeGeometry(ks, { depth: 0.28, bevelEnabled: false }), mat(b.hull));
  keel.rotation.x = Math.PI / 2; keel.position.y = 0.14;
  g.add(keel);
  // Cabin trunk.
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(L * 0.34, B * 0.58, 0.55), mat(0xe9e6dc));
  cabin.position.set(-L * 0.02, 0, sheer(0.5) + 0.27);
  g.add(cabin);
  // Rig: mast, boom, bowsprit.
  const mx = L / 2 - b.mastAt * L, deckZ = sheer(b.mastAt), spar = mat(0xb9b3a5);
  const cyl = (len, r) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), spar);
  const mast = cyl(b.mastH - deckZ, 0.08); mast.rotation.x = Math.PI / 2; mast.position.set(mx, 0, deckZ + (b.mastH - deckZ) / 2);
  g.add(mast);
  const boomLen = L * 0.42, boomZ = deckZ + 1.2;
  const sprit = cyl(b.sprit, 0.06); sprit.rotation.z = Math.PI / 2; sprit.position.set(L / 2 + b.sprit / 2, 0, sheer(0) - 0.1);
  g.add(sprit);
  // Sails on port tack: clews to starboard (-y), the leeward side; the caller heels the boat to
  // starboard to match, and mirrors the whole boat (scale.y = −1) for starboard tack.
  for (const sl of sailShapes(key, { plan, sheet, twa })) {
    const geo = new THREE.BufferGeometry().setFromPoints(sl.tris.flat().map((p) => new THREE.Vector3(...p)));
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, mat(sl.color, { transparent: true, opacity: 0.94 })));
  }
  const boomSheet = plan.main === "trysail" ? 0.05 : sheet;                 // under trysail the boom is lashed on the centreline
  const boom = cyl(boomLen, 0.06); boom.rotation.z = Math.PI / 2 + boomSheet; boom.position.set(mx - (boomLen / 2) * Math.cos(boomSheet), -(boomLen / 2) * Math.sin(boomSheet), boomZ);
  g.add(boom);
  g.userData = { spec: b, waterline: 0 };
  return g;
}
