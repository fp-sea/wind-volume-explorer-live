// Sun and moon positions and the moon's phase, for lighting the surface inspector at the time on
// screen. Low-precision formulas (as in the widely used SunCalc, after Meeus and the Astronomical
// Almanac's approximations): sun within ~0.1°, moon within ~0.5°, plenty for lighting and a sky.
// Angles in radians unless named deg. azimuth: compass bearing (0 north, clockwise); altitude:
// above the horizon.

const rad = Math.PI / 180, e = rad * 23.4397;
const days = (date) => date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
const raOf = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const decOf = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
function horizontal(ra, dec, d, lat, lon) {
  const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra, phi = rad * lat;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));   // from south, westward
  return { altitude: alt, azimuth: (azS + Math.PI) % (2 * Math.PI) };
}
function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  return { ra: raOf(L, 0), dec: decOf(L, 0) };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
  return { ra: raOf(l, b), dec: decOf(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

export function sunPosition(date, lat, lon) { const d = days(date), c = sunCoords(d); return horizontal(c.ra, c.dec, d, lat, lon); }
export function moonPosition(date, lat, lon) { const d = days(date), c = moonCoords(d); return horizontal(c.ra, c.dec, d, lat, lon); }

// The moon's lit fraction (0 new … 1 full) and phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter).
export function moonIllumination(date) {
  const d = days(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

export const phaseName = (p) => ["new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon", "waning gibbous", "last quarter", "waning crescent"][Math.round(p * 8) % 8];

// A unit vector (x east, y north, z up) toward a body at {altitude, azimuth}.
export const toVec = (p) => [Math.cos(p.altitude) * Math.sin(p.azimuth), Math.cos(p.altitude) * Math.cos(p.azimuth), Math.sin(p.altitude)];
