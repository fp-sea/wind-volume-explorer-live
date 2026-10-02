// Colour ramps for model fields, drawn over the dark scene.
//
// Rules (dataviz skill): sequential = one hue, dark → light here, so low values sink into the
// dark background; diverging = two hues with a neutral grey midpoint, never a rainbow. Blue
// steps are the dataviz reference ramp; orange and teal follow the same lightness steps.
// Only one field shows at a time for now. The inversion band will get its own hue, never one
// of these (brief 4.7), and so will ensemble spread.

const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
const ramp = (list) => list.map(hex);

export const RAMPS = {
  blue: ramp(["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"]),
  orange: ramp(["#5a2a0c", "#8a3f12", "#b95a1c", "#e07a2e", "#f09d5c", "#f7c095", "#fbe0c9"]),
  teal: ramp(["#0b3f4a", "#0e5a66", "#0e7c8b", "#2c9cab", "#5dbac6", "#98d5dd", "#d0ecef"]),
  diverging: ramp(["#184f95", "#3987e5", "#9ec5f4", "#383835", "#f4b2a2", "#e0604a", "#a8261b"]),
  gold: ramp(["#3d2e05", "#6b5210", "#9c7a17", "#c9a227", "#e8c65a", "#f5e3a1", "#fdf6dc"]),     // shear, gust factor
};

// Turbulence proxy classes (Richardson number). Hazard colours, used only for this.
export const RI_CLASSES = [
  { max: 0.25, colour: hex("#e0443a"), label: "likely (Ri < 0.25)" },
  { max: 1, colour: hex("#f2b33d"), label: "possible (Ri 0.25–1)" },
];
export const riClass = (ri) => (Number.isFinite(ri) ? RI_CLASSES.findIndex((k) => ri < k.max) : -1);

// Wind speed (kt): UW WRF's 10 m wind palette, as the Salish Sea briefing and the Alenuihāhā
// model maps use it (alenuihaha_wx model_maps.py SPEED_BANDS / BAND_COLORS): ten 5 kt bands
// centred on 0, 5, ... 45 kt, red above 47.5. Banded so the speed can be named from the colour,
// and the same colour means the same speed on all three sites. (Not perceptually ordered: it
// turns back to cool colours above 30 kt. Kept for consistency across the family.)
export const UW_WIND = {
  bounds: [0, 2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5],
  colors: ["#ffffff", "#bfbfff", "#bfffbf", "#ffcc99", "#ffff7f", "#ff7f7f", "#cecece", "#7fff91", "#aaefef", "#7791ef"].map(hex),
  over: hex("#ef1616"),
  labels: [5, 10, 15, 20, 25, 30, 35, 40, 45],
};
export function uwWind(kt) {
  if (!Number.isFinite(kt)) return [0, 0, 0];
  const b = UW_WIND.bounds;
  if (kt >= b[b.length - 1]) return UW_WIND.over;
  for (let i = b.length - 2; i >= 0; i--) if (kt >= b[i]) return UW_WIND.colors[i];
  return UW_WIND.colors[0];
}
// Its legend: a banded bar (bands equal width) plus the over colour, ticks at band centres.
export function uwLegend(w = 256, h = 12) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), n = UW_WIND.colors.length + 1;
  [...UW_WIND.colors, UW_WIND.over].forEach((col, i) => { g.fillStyle = `rgb(${col.map((x) => x * 255 | 0)})`; g.fillRect((i * w) / n, 0, w / n + 1, h); });
  const ticks = UW_WIND.labels.map((v, i) => [String(v), (i + 1.5) / n]).concat([["48+", (n - 0.5) / n]]);
  return { bar: c, ticks };
}

// Colour for t in [0, 1] along a ramp (linear between stops).
export function sample(stops, t) {
  t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// A legend bar as a canvas (also what export.js draws into files).
export function legendBar(stops, w = 256, h = 12) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  for (let x = 0; x < w; x++) {
    const [r, gg, b] = sample(stops, x / (w - 1));
    g.fillStyle = `rgb(${r * 255 | 0},${gg * 255 | 0},${b * 255 | 0})`;
    g.fillRect(x, 0, 1, h);
  }
  return c;
}
