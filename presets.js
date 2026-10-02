// Presets: one question you might be asking, and the settings that answer it (the full
// explanation, for learning, is presetinfo.js: the preset guide window). Picking one
// sets everything at once; any change afterwards turns the picker to "Custom". The same idea
// as radar-explorer's situation presets (web/presets.js there).
//
// set: { slice: {on, h (m), ref, gusty?}, curtain: {on}, field, view: region => view id, waterOnly? (default true),
//        sea?: {on, fill}, inspect?: open the surface viewer at the region's main channel }.
// particles: {on, range: column|low|slice, colour: speed|height|updown|rotation, vertical?, wBoost?}. Rotation/turbulence
// and inversion join these as they're built.
// The surface scene (2026-09-29): glyphs {barbs, stream}, sliceOp (the wind fill's opacity), currents {fill, arrows
// (grid|stations|none), parts, lines, marks (rings|dots|none), flag, waves (current effects on waves)}, sea {on, fill,
// crests, arrows, mode}, fog, clouds, sat, flat (2D). Anything a preset doesn't name is switched off (or back to its
// default), so each preset is the whole picture. group: where it sits in the list; regions: only there (all when absent).

const axisSub = (region) => region.subareas.find((s) => s.axis)?.id;

export const PRESETS = [
  {
    id: "volume", group: "air", label: "Wind through the volume",
    tip: "The wind through the whole column as particles, rising and sinking with the terrain. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-3d",
           particles: { on: true, range: "column", colour: "speed" } },
  },
  {
    id: "surface", group: "air", label: "Surface wind & gusts",
    tip: "The 10 m wind you'd feel on the water, with particles and barbs. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-top",
           particles: { on: true, range: "slice", colour: "speed" }, glyphs: { barbs: true } },
  },
  {
    id: "gapflow", group: "air", label: "Gap flow: along the channel",
    tip: "The channel's jet in a cross-section down its axis, with particles around it. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 320, ref: "agl" }, curtain: { on: true }, field: "speed", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           particles: { on: true, range: "xslab", colour: "speed" } },
  },
  {
    id: "sail", group: "water", label: "Sail conditions simulator",
    tip: "Gusty surface wind and the surface viewer, sailing in the channel. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl", gusty: true }, curtain: { on: false }, field: "speed", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           particles: { on: true, range: "slice", colour: "speed", gusty: true }, sea: { on: true, fill: false, crests: false }, inspect: true },
  },
  {
    id: "aloft", group: "air", label: "Winds aloft (≈ 850 mb)",
    tip: "The wind about 1.5 km up, above the surface friction. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 1500, ref: "msl" }, curtain: { on: false }, field: "speed", view: () => "region-3d" },
  },
  {
    id: "drafts", group: "air", label: "Up & down drafts",
    tip: "Rising and sinking air about 1.5 km up. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 1500, ref: "msl" }, curtain: { on: true }, field: "w", view: () => "region-3d",
           particles: { on: true, range: "hslab", colour: "updown" } },
  },
  {
    id: "convergence", group: "air", label: "Convergence & lift",
    tip: "Where the surface winds meet and the air must rise. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "conv", view: (r) => (r.subareas.some((s) => s.id === "puget-sound") ? "puget-sound-3d" : "region-3d"),
           particles: { on: true, range: "low", colour: "updown", vertical: true, wBoost: 10 }, waterOnly: false },
  },
  {
    id: "eddies", group: "air", label: "Eddies & rotation",
    tip: "Spin (vorticity) about 1 km up: eddies and shear lines behind islands and points. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 1000, ref: "msl" }, curtain: { on: false }, field: "vort", view: () => "region-top",
           particles: { on: true, range: "slice", colour: "rotation" } },
  },
  {
    id: "turbulence", group: "air", label: "Turbulence & shear",
    tip: "Where shear and weak stability point to turbulence, and the mixed layer's top. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: true }, field: "shear", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           particles: { on: true, range: "low", colour: "turbulence" }, turbulence: true },
  },
  {
    id: "moisture", group: "weather", label: "Inversion & moisture",
    tip: "Humidity with the inversion band: the lid and the dry air above it. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 1000, ref: "msl" }, curtain: { on: true }, field: "rh", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           inversion: true },
  },
  // ---------- vertical mixing ----------
  {
    id: "mixing", group: "air", label: "Vertical mixing & gusts",
    tip: "How much of the wind aloft can reach the water as gusts. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl", gusty: true }, curtain: { on: false }, field: "mixdown", view: () => "region-3d",
           particles: { on: true, range: "low", colour: "turbulence", gusty: true }, turbulence: true, glyphs: { barbs: true } },
  },
  {
    id: "stability", group: "air", label: "Stability over the water",
    tip: "Sea minus air temperature: stirred and gusty, or cut off and smooth. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "airsea", view: () => "region-top",
           particles: { on: true, range: "slice", colour: "speed", gusty: true }, glyphs: { barbs: true } },
  },
  // ---------- on the water ----------
  {
    id: "water", group: "water", label: "Everything on the water",
    tip: "Wind, waves and current together, from above. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, sliceOp: 0.3, curtain: { on: false }, field: "speed", view: () => "region-top", flat: true,
           glyphs: { barbs: true }, sea: { on: true, fill: true, crests: true }, currents: { fill: false, arrows: "none", parts: true, marks: "none", flag: true, waves: true } },
  },
  {
    id: "currents", group: "water", label: "Currents & tide",
    tip: "The tidal current: speed, particles, streamlines and NOAA's stations. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-top", flat: true,
           currents: { fill: true, arrows: "none", parts: true, lines: true, marks: "rings", flag: false } },
  },
  {
    id: "wac", group: "water", label: "Wind against current",
    tip: "Where wind against current stands up steep or dangerous chop. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, sliceOp: 0.25, curtain: { on: false }, field: "speed", view: () => "region-top", flat: true,
           glyphs: { barbs: true }, sea: { on: true, fill: true, crests: true }, currents: { fill: false, arrows: "grid", parts: false, marks: "rings", flag: true, waves: true } },
  },
  {
    id: "seastate", group: "water", label: "Sea state",
    tip: "Wave height with moving crests, direction arrows and wind barbs. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-top", flat: true,
           glyphs: { barbs: true }, sea: { on: true, fill: true, crests: true, arrows: true, mode: "total" } },
  },
  // ---------- weather ----------
  {
    id: "fog", group: "weather", label: "Fog, visibility & stability",
    tip: "Fog and visibility over sea minus air temperature. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, sliceOp: 0.55, curtain: { on: false }, field: "airsea", view: () => "region-3d", fog: true, glyphs: { barbs: true } },
  },
  {
    id: "clouds", group: "weather", label: "Clouds & satellite",
    tip: "The model's clouds against the GOES-West satellite. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-3d", clouds: true, sat: true },
  },
  // ---------- more for the water, Hawaiʻi and the Pacific Northwest ----------
  {
    id: "wakes", group: "water", label: "Island wakes & lee calms",
    tip: "Calms, shifts and eddies in the islands' lee. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "speed", view: () => "region-top", flat: true,
           glyphs: { stream: true }, particles: { on: true, range: "slice", colour: "speed" } },
  },
  {
    id: "breeze", group: "air", label: "Sea & land breezes",
    tip: "Sea and land breezes and where they meet the wind (play through the day). (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "conv", view: () => "region-top",
           glyphs: { stream: true }, particles: { on: true, range: "slice", colour: "speed" }, waterOnly: false },
  },
  {
    id: "lid", group: "weather", label: "Inversion lid & mixed layer",
    tip: "The inversion (the lid) and the mixed layer (the stirring) beneath it. (ⓘ for the full guide.)",
    set: { slice: { on: false, h: 10, ref: "agl" }, curtain: { on: true }, field: "rh", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           inversion: true, turbulence: true, particles: { on: true, range: "low", colour: "turbulence" } },
  },
  {
    id: "outflow", group: "weather", label: "Cold outflow winds (winter)", regions: ["salish-sea"],
    tip: "Cold arctic air pouring out of the gaps in winter. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, curtain: { on: false }, field: "temp", view: () => "region-top",
           glyphs: { barbs: true }, particles: { on: true, range: "slice", colour: "speed" } },
  },
  {
    id: "push", group: "weather", label: "Marine push (summer)", regions: ["salish-sea"],
    tip: "The summer marine push through the Strait, with fog behind it. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl" }, sliceOp: 0.6, curtain: { on: true }, field: "speed", view: (r) => (axisSub(r) ? `${axisSub(r)}-3d` : "region-3d"),
           inversion: true, fog: true, glyphs: { barbs: true } },
  },
  {
    id: "fronts", group: "weather", label: "Fronts & wind shifts", regions: ["salish-sea"],
    tip: "A front coming through: the gust band and the wind shift. (ⓘ for the full guide.)",
    set: { slice: { on: true, h: 10, ref: "agl", gusty: true }, curtain: { on: false }, field: "gust", view: () => "region-top",
           glyphs: { barbs: true }, particles: { on: true, range: "slice", colour: "speed", gusty: true } },
  },
];
