// Lambert conformal grid geometry (GRIB2 template 3.30): HRRR and RRFS over the continental US.
// Same interface as MercatorGrid (ij, latLon, check, cellSizeM, toGrid).
//
// Forward projection: radar-explorer web/model/hrrr.js@20a7d31 (tangent cone; SYNC below).
// The inverse, the map scale factor and the wind turn are added here. Winds in packs are
// already true east/north (turned in pipeline/packs/build.py); toGrid() turns them back to
// grid axes so particles can move in grid cells.

const RADIUS = { 0: 6367470, 6: 6371229 };
const rad = Math.PI / 180;
const lon180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

export class LambertGrid {
  constructor(g) {
    if (g.tpl !== 30) throw new Error(`not a Lambert grid (3.${g.tpl})`);
    const R = RADIUS[g.shape];
    if (!R) throw new Error(`GRIB earth shape ${g.shape} not handled`);
    if (Math.abs(g.latin1 - g.latin2) > 1e-6) throw new Error("secant Lambert (Latin1 ≠ Latin2) not handled");
    Object.assign(this, { ni: g.ni, nj: g.nj, R, dx: g.dx, la1: g.la1, lo1: lon180(g.lo1) });
    // SYNC: radar-explorer web/model/hrrr.js@20a7d31 lcc forward projection. Same formulas, constants from the header.
    const PHI1 = g.latin1 * rad, LAM0 = lon180(g.lov) * rad;
    const n = Math.sin(PHI1);
    const F = Math.cos(PHI1) * Math.tan(Math.PI / 4 + PHI1 / 2) ** n / n;
    const rho = (phi) => R * F / Math.tan(Math.PI / 4 + phi / 2) ** n;
    const RHO0 = rho(PHI1);
    const lcc = (lat, lon) => { const phi = lat * rad, th = n * (lon * rad - LAM0), r = rho(phi); return [r * Math.sin(th), RHO0 - r * Math.cos(th)]; };
    // END SYNC
    Object.assign(this, { n, F, RHO0, LAM0, PHI1, lcc });
    [this.x1, this.y1] = lcc(g.la1, this.lo1);
    this.sj = g.scan & 0x40 ? 1 : -1;
    if (g.scan & 0xa0) throw new Error(`GRIB scan mode ${g.scan} not handled`);
  }
  ij(lat, lon) { const [x, y] = this.lcc(lat, lon); return { i: (x - this.x1) / this.dx, j: this.sj * (y - this.y1) / this.dx }; }
  latLon(i, j) {
    const x = this.x1 + i * this.dx, y = this.y1 + this.sj * j * this.dx, n = this.n;
    const dy = this.RHO0 - y, r = Math.sign(n) * Math.hypot(x, dy), th = Math.atan2(Math.sign(n) * x, Math.sign(n) * dy);
    const lat = 2 * Math.atan((this.R * this.F / r) ** (1 / n)) - Math.PI / 2;
    return { lat: lat / rad, lon: lon180((this.LAM0 + th / n) / rad) };
  }
  // Ground size of a cell (m): Dx divided by the map scale factor at that latitude.
  cellSizeM(i, j) {
    const phi = this.latLon(i, j).lat * rad, P = this.PHI1;
    const k = (Math.cos(P) / Math.cos(phi)) * (Math.tan(Math.PI / 4 + P / 2) / Math.tan(Math.PI / 4 + phi / 2)) ** this.n;
    return this.dx / k;
  }
  // Angle (radians) between grid north and true north at cell (i, j): n·(λ − λ0).
  turnAt(i, j) { return this.n * (this.latLon(i, j).lon * rad - this.LAM0); }
  // True east/north → grid x/y components (angle n·(λ − λ0), as the pack turned them the other way).
  toGrid(ue, ve, i, j) {
    const a = this.turnAt(i, j), c = Math.cos(a), s = Math.sin(a);
    return [c * ue - s * ve, s * ue + c * ve];
  }
  check() {
    const p = this.latLon(0, 0);
    if (Math.abs(p.lat - this.la1) > 1e-4 || Math.abs(lon180(p.lon - this.lo1)) > 1e-4) throw new Error("Lambert grid check failed");
    return true;
  }
}
