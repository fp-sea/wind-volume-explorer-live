// Wind speed display units. Values are computed in knots throughout (the UW wind colour bands
// are knot thresholds); this only changes what's written: readouts, key ticks, particle and
// observation text. Barbs stay in knots, as barbs always are.

const UNITS = {
  kt: { label: "kt", perKt: 1 },
  mph: { label: "mph", perKt: 1.150779 },
  ms: { label: "m/s", perKt: 0.514444 },
  kmh: { label: "km/h", perKt: 1.852 },
};
let current = "kt";
try { const v = localStorage.getItem("wve-units"); if (UNITS[v]) current = v; } catch { /* storage blocked: kt */ }

export const speedUnits = () => current;
export const unitLabel = () => UNITS[current].label;
export function setSpeedUnits(u) {
  if (!UNITS[u]) return;
  current = u;
  try { localStorage.setItem("wve-units", u); } catch { /* fine */ }
}
// kt → the display unit (number)
export const fromKt = (kt) => kt * UNITS[current].perKt;
// "12 kt" / "14 mph" / "6.2 m/s"
export function fmtSpeed(kt, { unit = true } = {}) {
  if (!Number.isFinite(kt)) return "–";
  const x = fromKt(kt), s = current === "ms" && x < 10 ? x.toFixed(1) : String(Math.round(x));
  return unit ? `${s} ${UNITS[current].label}` : s;
}
