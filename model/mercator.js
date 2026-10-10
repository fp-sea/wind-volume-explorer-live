// Mercator grid geometry (GRIB2 template 3.10), for RRFS's Hawaiʻi 2.5 km grid.
//
// A Mercator grid is regular in longitude and in the Mercator y = ln(tan(π/4 + φ/2)).
// Di and Dj are the spacing in metres at the standard latitude LaD, so the step in
// longitude is Di / (R cos LaD) radians, and likewise in y. The last grid point this
// arithmetic produces has to land on the header's own La2/Lo2; check() asserts that,
// so a wrong earth radius or scan order fails loudly instead of shifting the picture.

const RADIUS = { 0: 6367470, 6: 6371229 };        // GRIB shape of the earth → sphere radius (m)
const rad = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2));
const invY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / rad;
const lon180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

export class MercatorGrid {
  constructor(g) {
    if (g.tpl !== 10) throw new Error(`not a Mercator grid (3.${g.tpl})`);
    const R = RADIUS[g.shape];
    if (!R) throw new Error(`GRIB earth shape ${g.shape} not handled`);
    if (g.scan & 0xa0) throw new Error(`GRIB scan mode ${g.scan} not handled (only +i, ±j, rows consecutive)`);
    Object.assign(this, { ni: g.ni, nj: g.nj, la1: g.la1, lo1: lon180(g.lo1), la2: g.la2, lo2: lon180(g.lo2) });
    this.R = R;
    const k = R * Math.cos(g.lad * rad);
    this.dlon = (g.di / k) / rad;                    // degrees per column
    const sj = g.scan & 0x40 ? 1 : -1;                // 0x40: rows run south → north
    this.dy = sj * g.dj / k;                          // Mercator y per row
    this.y1 = mercY(g.la1);
  }
  // Latitude/longitude of cell (i, j); fractional indices are fine.
  latLon(i, j) { return { lat: invY(this.y1 + j * this.dy), lon: lon180(this.lo1 + i * this.dlon) }; }
  // Fractional (i, j) of a latitude/longitude (for bilinear sampling).
  ij(lat, lon) { return { i: lon180(lon - this.lo1) / this.dlon, j: (mercY(lat) - this.y1) / this.dy }; }
  // Ground size of a cell (m): Mercator cells shrink with cos(latitude).
  cellSizeM(i, j) { return (this.dlon * rad) * this.R * Math.cos(this.latLon(i, j).lat * rad); }
  // Mercator grid axes are east/north already.
  toGrid(ue, ve) { return [ue, ve]; }
  // Does the computed last point agree with the header's La2/Lo2?
  check(tol = 0.01) {
    const p = this.latLon(this.ni - 1, this.nj - 1);
    const ok = Math.abs(p.lat - this.la2) < tol && Math.abs(lon180(p.lon - this.lo2)) < tol;
    if (!ok) throw new Error(`Mercator grid check failed: last point ${p.lat.toFixed(4)},${p.lon.toFixed(4)} vs header ${this.la2},${this.lo2}`);
    return true;
  }
}
