// The preset guide: a window that opens when a preset is picked (move it, minimise it, close it;
// ⓘ beside the list opens it again), with the same sections for every preset, for learning as
// much as for using it:
//   the question it answers · on screen (the actual settings, written out from the preset itself,
//   so it can't drift from what's drawn) · how to read it · try this · where it matters (Hawaiʻi,
//   the Pacific Northwest) · limits · learn more (the guide's teaching section).

import { COLOUR_BY } from "./layers/slice.js?v=20261002173952";
import { PARTICLE_COLOURS } from "./layers/particles.js?v=20261002173952";

const KEY = "wve.presetinfo", $ = (id) => document.getElementById(id);
const G = "guide.html";

// ---------- the content ----------
// question; read, tryit, where, limits: lists (HTML allowed); learn: [anchor, title].
export const INFO = {
  volume: {
    question: "How is the wind moving through the whole column of air: over, around and through the terrain?",
    read: ["Each streak is a particle carried by the model's wind, coloured by its speed (the key at the top: the same bands as the wind colours).", "Streaks climb and sink with the model's vertical motion, stretched by the vertical exaggeration so you can see it.", "Where streaks bunch and brighten, the flow is squeezed and fast (gaps, points, over ridges); where they spread and slow, it's blocked or in a lee."],
    tryit: ["Tilt and turn the view (drag; right-drag to pan).", "Particles → Where: the lowest 2 km, to see the flow the terrain shapes.", "Turn on the slice or the cross-section to read the numbers under your cursor.", "Play the forecast and watch the flow change through the day."],
    where: ["Hawaiʻi: the trades splitting round Mauna Kea and Mauna Loa, racing through the ʻAlenuihāhā and round ʻUpolu Point, rising over the windward slopes.", "Salish Sea: westerlies pouring through the Strait of Juan de Fuca and over the Olympics; southerlies funnelled up Puget Sound."],
    limits: ["The model's wind on a ~3 km grid (HRRR) or 2.5 km (RRFS): smaller terrain effects aren't there.", "Particles show the flow at the time on screen, not where air really goes over hours."],
    learn: ["vertical", "Vertical motion"],
  },
  surface: {
    question: "What wind will I feel on the water, and where is it strongest?",
    read: ["The colour is the 10 m wind speed in knots (key at the top).", "Barbs point into the wind: a long feather is 10 kt, a short one 5, a pennant 50.", "Particles drift with the wind at 10 m, faster where it's faster."],
    tryit: ["Colour by → Surface gust (the model's gust) or Gust factor (gust ÷ wind: 1.3–1.5 and up is gusty).", "Hover the water: wind, gust, chop, swell and the NWS forecast for the zone.", "Play the forecast to see when it builds and eases."],
    where: ["Hawaiʻi: the channels (ʻAlenuihāhā, Pailolo, Kalohi) accelerate the trades; the leeward coasts sit in calms.", "Salish Sea: the Strait's afternoon westerlies, Admiralty Inlet, the gap winds out of the Fraser and Howe Sound."],
    limits: ["The model's 10 m wind is a ~10-minute mean over a 3 km cell: gusts, lulls and very local shifts are smaller than that.", "The gust is the model's own estimate, not a measured gust."],
    learn: ["barbs", "Reading a wind barb"],
  },
  gapflow: {
    question: "How strong and how deep is the jet through the channel, and where does it spread out downstream?",
    read: ["The cross-section runs down the channel's axis, coloured by wind speed; heights are stretched by the vertical exaggeration.", "The fast core (the jet) sits in the lowest few hundred metres to ~1 km; its top often lies near the inversion.", "Particles in a slab around the section show the jet speeding up in the narrows and fanning out at the exit."],
    tryit: ["Slide the section sideways with [ and ] (or the Position slider): the particle slab follows.", "The Channel tab: pressure difference, Bernoulli speed, Froude number and the regime.", "Compare the core with the 10 m wind (Surface wind & gusts)."],
    where: ["Hawaiʻi: the ʻAlenuihāhā between Maui and Hawaiʻi Island: the trades squeezed under the inversion, strongest near the throat off ʻUpolu Point.", "Salish Sea: the Strait of Juan de Fuca (westerlies in, easterlies out in winter), the Fraser and Howe Sound outflows."],
    limits: ["The model's grid resolves big gaps well; narrow passes (Deception Pass) are too small for it.", "The jet's depth depends on the model's inversion, which can be off by a few hundred metres."],
    learn: ["gap", "Gap winds"],
  },
  sail: {
    question: "What would it feel like to sail in the channel right now?",
    read: ["The surface viewer shows the sea at true scale with the region's boat, sailing the tack and point of sail you choose: instruments (TWS, TWA, AWS, AWA, STW, SOG, heel), the sails set, and the waves.", "The map's wind colours shimmer toward the model's gust in drifting puffs; the particles surge with them.", "Sea state is on for the hover readout and the NWS comparison, without colouring the water, so the wind colours show."],
    tryit: ["Pick port or starboard and a point of sail; try the cockpit view.", "Move the viewer's time slider through the day.", "Click the water anywhere on the map to sail there instead."],
    where: ["Hawaiʻi: the ʻAlenuihāhā's throat, where the trades and the channel sea are at their strongest.", "Salish Sea: the middle of the Strait of Juan de Fuca."],
    limits: ["Boat speeds come from approximate polars; the waves are an illustration of the forecast heights and periods, not a forecast of each wave."],
    learn: ["inspector", "The surface inspector"],
  },
  aloft: {
    question: "What's the wind doing about 1.5 km up (≈ 850 mb), above the surface friction?",
    read: ["The colour is the wind speed at about 1,500 m above sea level; mountains higher than that show as holes.", "Compare it with the surface wind: much stronger aloft means gusts if the air mixes it down."],
    tryit: ["Try Vertical mixing & gusts to see how much of this reaches the water.", "Change the height (Wind tab) to follow the wind up or down."],
    where: ["Hawaiʻi: the trade flow above the inversion is often lighter or even turned: the trades live below it.", "Salish Sea: southwesterlies aloft ahead of fronts, much stronger than at the surface under a stable layer."],
    limits: ["One height at a time; the model's winds aloft are smoother than reality."],
    learn: ["mixing", "Vertical mixing, stability and the lid"],
  },
  drafts: {
    question: "Where is the air rising, and where is it sinking?",
    read: ["Colour: vertical velocity at about 1.5 km, red rising, blue sinking (m/s).", "Rising air on windward slopes and in convergence lines (clouds and showers form there); sinking air in the lee (clear skies, warm dry downslope wind).", "Particles in a layer around the slice rise and sink through it."],
    tryit: ["Slide the cross-section across a ridge: the up- and down-slope motion shows as a wave.", "Play the forecast: afternoon heating adds rising air over land."],
    where: ["Hawaiʻi: lift on the windward (Hilo) side and sinking in the Kona lee; lee waves off Haleakalā.", "Salish Sea: lift where westerlies meet the Cascades, sinking in the Olympic rain shadow (Sequim)."],
    limits: ["Vertical motion is small (cm/s to a few m/s) and the model's is smoothed; it's a pattern, not a measurement."],
    learn: ["vertical", "Vertical motion"],
  },
  convergence: {
    question: "Where are the surface winds meeting, forcing air to rise?",
    read: ["Colour: convergence at 10 m, red where air piles in and must rise, blue where it spreads out and sinks (10⁻⁴ s⁻¹).", "Particles in the lowest 2 km are coloured by up (red) and down (blue), their vertical motion boosted ×10.", "Land is shown too: convergence zones often sit over it."],
    tryit: ["Play through a front: watch a convergence line form behind it.", "Hover for the value; turn on Clouds or the satellite to see showers along the line."],
    where: ["Salish Sea: the Puget Sound Convergence Zone, when post-frontal westerlies split round the Olympics and meet again over the Sound between Seattle and Everett: a band of showers, heavy snow in winter, sudden wind shifts on the water.", "Hawaiʻi: afternoon convergence over the Kona slopes where the sea breeze meets the trades."],
    limits: ["Computed from the model's wind across ~12 km: narrow lines are smoothed."],
    learn: ["convergence", "Convergence zones"],
  },
  eddies: {
    question: "Where does the flow spin: eddies and shear lines behind islands and headlands?",
    read: ["Colour: relative vorticity at about 1 km: red spins counter-clockwise (cyclonic), blue clockwise.", "Paired red and blue streaks trail from islands and points: the edges of the wake, where wind speed changes sharply.", "Particles are coloured by the rotation they're in."],
    tryit: ["Island wakes & lee calms shows the same wakes at the surface, from above."],
    where: ["Hawaiʻi: the long wake behind Hawaiʻi Island and the eddies off Kawaihae and Maui's corners.", "Salish Sea: eddies behind Point Wilson, the San Juans and Vancouver Island in strong flow."],
    limits: ["The model's grid only resolves eddies several kilometres across."],
    learn: ["vort", "Vorticity and eddies"],
  },
  turbulence: {
    question: "Where are the winds and stability likely to make the air turbulent?",
    read: ["Dots: turbulence likely (red) or possible (amber) by the Richardson number: strong shear against weak stability.", "The faint sheet: the top of the mixed layer, the stirred air next to the ground.", "The cross-section is coloured by wind shear (kt per 1000 ft)."],
    tryit: ["Colour by → Turbulence: model TKE (full HRRR only): the model's own turbulence.", "Slide the section across a ridge in strong wind: rotors and shear show on its lee."],
    where: ["Hawaiʻi: shear at the top of the trades and in the lee of the big mountains.", "Salish Sea: strong southerlies over the Cascades and Olympics; the edge of outflow jets."],
    limits: ["These are proxies from the model's winds and temperatures, not observed turbulence."],
    learn: ["ri", "Richardson number and turbulence"],
  },
  moisture: {
    question: "Where is the inversion, and how dry is the air above it?",
    read: ["The cross-section is coloured by relative humidity; the inversion band shows as a bright line at its base and a fill up to its top.", "Moist below and dry above: the cap holding the moist layer down."],
    tryit: ["Inversion lid & mixed layer adds the mixed layer and turbulence beneath the cap."],
    where: ["Hawaiʻi: the trade-wind inversion at ~1.5–2.5 km: dry air above, trade cumulus below it.", "Salish Sea: the summer marine inversion, a few hundred metres up, over the cool moist marine layer."],
    limits: ["The detector needs enough model levels: the light HRRR (Salish Sea) can't resolve it; the bar offers the full one."],
    learn: ["inversion", "The capping inversion"],
  },
  mixing: {
    question: "How much of the wind aloft can reach the water as gusts?",
    read: ["The colour is the strongest wind anywhere in the model's mixed layer (the air stirred from the surface up to its top), in knots.", "The barbs are the wind at 10 m. Where the colour is much stronger than the barbs, the stirring can bring that stronger wind down in gusts.", "Particles in the lowest 2 km surge with the gustiness and are coloured by the turbulence proxy (red likely, amber possible); the faint sheet is the top of the mixed layer.", "Hover the water for the Mixing line: its depth, the wind in it against the wind at 10 m, and whether the sea is warmer than the air."],
    tryit: ["Colour by → Mixed-layer depth: how deep the stirring goes.", "Colour by → Sea minus air temperature (or the Stability preset): why it's deep or shallow over the water.", "Play through a front, or a day: the mixed layer deepens with heating and behind fronts."],
    where: ["Salish Sea: behind a cold front the sea is warmer than the air, the mixed layer deepens, and 20 kt at 10 m can gust 30+. Under a summer marine layer it's shallow: the surface wind can be light under a stiff breeze aloft.", "Hawaiʻi: the trades mix up to the inversion; where the inversion lowers or strengthens, the mixed layer and the gusts are capped."],
    limits: ["The mixed-layer depth is the model's diagnosis, good to a few hundred metres; very shallow and noisy over cold water.", "The wind in the mixed layer is a ceiling for gusts, not a forecast of each one."],
    learn: ["mixing", "Vertical mixing, stability and the lid"],
  },
  stability: {
    question: "Is the air over the water stirred up (gusty) or cut off from the wind aloft (smooth)?",
    read: ["The colour is the sea temperature minus the air temperature (°C). Red: the sea is warmer, heats the air from below, so it's unstable, well mixed and gusty, with a lumpy sea. Blue: the air is warmer, so it's stable, the surface wind is cut off from the wind above (smoother, often lighter), and fog forms easily. Grey: within about 1 °C, near neutral.", "Barbs: the 10 m wind; particles surge where the model's gusts are strong."],
    tryit: ["Hover for the Mixing line (depth, wind in it, sea minus air).", "Compare with Vertical mixing & gusts and Fog, visibility & stability."],
    where: ["Salish Sea: red behind cold fronts and in winter cold outbreaks; blue in spring and summer (warm air over ~10 °C water), when fog is common.", "Hawaiʻi: usually near neutral (warm sea, warm air); slightly unstable in the trades."],
    limits: ["The sea temperature is the model's analysis, updated slowly: it misses tidal mixing in the passes (cold water at Deception Pass, Admiralty Inlet, Haro Strait) and upwelling.", "The air temperature is the model's at 2 m."],
    learn: ["mixing", "Vertical mixing, stability and the lid"],
  },
  breeze: {
    question: "Where are sea and land breezes pushing in and out, and where do they meet the wind?",
    read: ["Colour: convergence at 10 m (red: air meeting and rising, often where clouds build; blue: spreading and sinking).", "Streamlines and particles show the 10 m wind; land is included (over water only is off)."],
    tryit: ["Play from morning to evening: the sea breeze turns onshore as the land heats, the convergence line moves inland; at night a weak land breeze drains offshore.", "Turn on Clouds or the satellite to see the afternoon clouds on the convergence lines."],
    where: ["Hawaiʻi: the Kona coast's afternoon sea breeze (the trades are blocked there) with clouds building upslope; Maui's upcountry and the Hāmākua.", "Salish Sea: the summer afternoon westerly surge up the Strait and inland, strongest late afternoon, easing overnight."],
    limits: ["Sea breezes a few kilometres wide are near the model's limit; timing can be off by an hour or two."],
    learn: ["convergence", "Convergence zones"],
  },
  water: {
    question: "What does the whole surface look like at once: wind, waves and current?",
    read: ["A light colour fill of the 10 m wind (30%) with barbs; the sea state as wave height (navy calm to lilac rough) with moving crests; the current as particles (SSCOFS on the Salish Sea).", "Orange or red pulsing on the water: the wind is against the current and the chop is steep or dangerous.", "Seen from above in 2D."],
    tryit: ["Sea & weather → Surface layers: each layer's switch, opacity and ⚙ settings.", "Play the forecast; hover anywhere for wind, sea, current and zone forecast."],
    where: ["Anywhere you're planning a day on the water; the Passage tab routes through the same forecast."],
    limits: ["Each layer's own limits apply (model wind, model chop and swell, SSCOFS or predicted tidal currents)."],
    learn: ["presets", "Presets"],
  },
  currents: {
    question: "Which way and how fast is the tidal current running, and where does it eddy?",
    read: ["Colour: the current's speed (blue under 1 kt, green, yellow, to red over 4 kt: key at the top).", "Particles drift with it (sped up so it reads); streamlines show its paths, with arrowheads, and the eddies behind points.", "Rings: NOAA's prediction stations (click one for its current graph through the run)."],
    tryit: ["Play the forecast to watch the current turn with the tide.", "Zoom into a pass (Deception Pass, Admiralty Inlet): particles and streamlines follow the view.", "Surface layers → Currents from: SSCOFS (the model, everywhere on the water) or NOAA stations."],
    where: ["Salish Sea: Admiralty Inlet, Deception Pass, Rosario and Haro Straits, Point Wilson's eddies, the Swinomish Channel.", "Hawaiʻi: the channels' tidal streams (weaker; stations only)."],
    limits: ["SSCOFS is a model (48 h); station predictions are tides only (no wind-driven or river current) and blend between stations up to 5 km away."],
    learn: ["tidal", "Tidal currents"],
  },
  wac: {
    question: "Where will the wind against the current stand the chop up?",
    read: ["The sea state includes the current: waves against it get shorter and steeper. Orange pulsing: steep; red: dangerous (near breaking, or the current stopping the waves).", "Arrows show the current; rings flag NOAA stations the same way; barbs show the wind."],
    tryit: ["Play through a tide change: the flags come and go as the current turns.", "Hover a flagged spot for the chop height, spacing and steepness."],
    where: ["Salish Sea: Admiralty Inlet and Point Wilson on an ebb against a westerly or northerly, the east end of the Strait, Rosario Strait, Deception Pass.", "Hawaiʻi: the ʻAlenuihāhā when the tidal stream runs against the trades."],
    limits: ["Local chop only (swell changes little); the current is the model's or the predictions', and steepness thresholds are rules of thumb."],
    learn: ["tidal", "Tidal currents"],
  },
  seastate: {
    question: "How big and how steep are the seas, and which way are they going?",
    read: ["Colour: wave height (total of the local chop and NOAA's swell), navy calm through blue and violet to pale lilac for rough (key at the top).", "Moving crests along the waves; arrows along their direction of travel, longer for bigger seas; barbs for the wind."],
    tryit: ["Sea state → Show: chop only or swell only.", "Hover for chop and swell (height, period, direction) and the NWS zone forecast; click the water for the true-scale surface viewer.", "Wind for: 6 h, 12 h, 24 h (how long the wind has blown)."],
    where: ["Hawaiʻi: the channel seas and the north swell wrapping into the coasts.", "Salish Sea: short steep chop in the Strait and Admiralty Inlet; ocean swell only at the western entrance."],
    limits: ["Chop is computed from the model's wind and the fetch (no shallow-water effects); swell comes from NOAA's ~18 km wave model."],
    learn: ["waves", "How wind builds waves"],
  },
  wakes: {
    question: "Where do the islands leave calms, shifts and eddies in their lee?",
    read: ["The 10 m wind as a colour fill with streamlines and particles, from above.", "Light colours and wandering streamlines in the lee: calms and shifty wind; the sharp edge between calm and fresh wind is the wake's shear line."],
    tryit: ["Play the forecast: the wake swings with the wind direction; afternoon sea breezes fill it in.", "Eddies & rotation shows the spin along the edges."],
    where: ["Hawaiʻi: the Kona coast in the lee of Mauna Kea and Mauna Loa, Maui's lee off Lahaina and Maʻalaea; the acceleration round ʻUpolu Point.", "Salish Sea: the lee of the Olympics and Vancouver Island in a westerly or southerly."],
    limits: ["Wakes narrower than a few kilometres are smoothed."],
    learn: ["vort", "Vorticity and eddies"],
  },
  lid: {
    question: "How do the inversion (the lid) and the mixed layer (the stirring) fit together?",
    read: ["The cross-section is coloured by humidity, with the inversion band (bright line at its base): the lid, where it gets warmer with height.", "The faint sheet beneath: the top of the mixed layer. Particles in the lowest 2 km are coloured by the turbulence proxy.", "The mixed layer usually reaches up to the inversion and stops: a low lid means shallow mixing and less wind brought down."],
    tryit: ["Play through the day: over land the mixed layer deepens with heating and may reach the lid.", "Vertical mixing & gusts for what the stirring brings down."],
    where: ["Hawaiʻi: the trade-wind inversion at ~1.5–2.5 km keeps the trades in a layer the mountains block and the channels squeeze.", "Salish Sea: the summer marine inversion a few hundred metres up, over a cool, moist, often foggy layer."],
    limits: ["Needs the full-column HRRR on the Salish Sea (the bar offers it); the inversion and mixed-layer heights are the model's."],
    learn: ["mixing", "Vertical mixing, stability and the lid"],
  },
  fog: {
    question: "Where is fog likely, and why there?",
    read: ["The fog layer (soft white near the water) and the visibility map (how far you'd see).", "Underneath: sea minus air temperature. Blue: warm moist air over colder water, the recipe for sea fog."],
    tryit: ["Hover for the visibility; play the night into the morning.", "Clouds & satellite to compare with the real sky."],
    where: ["Salish Sea: spring and summer fog in the Strait and along the coast; advection fog riding in with the marine push.", "Hawaiʻi: rare at sea level; cloud and fog on the upper slopes."],
    limits: ["Needs the full-column HRRR on the Salish Sea (the bar offers it); model fog timing is uncertain by hours."],
    learn: ["fog", "Fog"],
  },
  clouds: {
    question: "Are the model's clouds where the real ones are?",
    read: ["The model's cloud water and ice as translucent volumes; GOES-West satellite beneath (GeoColor: true colour by day, infrared at night)."],
    tryit: ["Satellite → Clean infrared at night; step through hours to compare."],
    where: ["Hawaiʻi: trade cumulus under the inversion; afternoon clouds over the slopes.", "Salish Sea: frontal bands, the Convergence Zone, marine stratus."],
    limits: ["Needs the full-column HRRR on the Salish Sea; the satellite is observed, the clouds are the model's."],
    learn: ["clouds-teach", "Clouds and the inversion"],
  },
  push: {
    question: "When and how strongly will the marine air surge in through the Strait?",
    read: ["The 10 m wind with barbs: the westerly surge down the Strait of Juan de Fuca.", "The cross-section along the Strait: the moist marine layer under the inversion band.", "The fog layer where the marine air brings fog or low cloud."],
    tryit: ["Play the afternoon into the evening: the surge usually peaks late afternoon.", "Stability over the water for why the fog forms."],
    where: ["Salish Sea: the Strait of Juan de Fuca (westerly gales in summer afternoons), spilling into Admiralty Inlet and the eastern Strait."],
    limits: ["Needs the full-column HRRR (inversion, fog)."],
    learn: ["inversion", "The capping inversion"],
  },
  outflow: {
    question: "Where will cold arctic air pour out of the gaps, and how strong?",
    read: ["The colour is the temperature at 10 m: cold (blue) air lying in the valleys and spilling out over the water.", "Barbs and particles: the outflow wind, fastest where the cold air leaves the gaps."],
    tryit: ["Play the forecast as an outbreak starts; check Surface wind & gusts for the gusts."],
    where: ["Salish Sea: the Fraser outflow into the Strait of Georgia, Bellingham and the San Juans (a short steep sea on the northeast fetch; freezing spray), Howe Sound's Squamish winds, easterlies out the Strait of Juan de Fuca."],
    limits: ["The cold pool's depth and edge are hard for models; the strongest outflow is often underdone."],
    learn: ["gap", "Gap winds"],
  },
  fronts: {
    question: "When will the front come through, and how will the wind shift?",
    read: ["The colour is the model's surface gust; barbs show the wind's direction; particles surge with the gustiness.", "Ahead of the front, southerlies build (southeasterly in the Strait); as it passes, the wind veers southwest to west; behind it, gusty showery west-northwesterlies."],
    tryit: ["Play it through and watch the gust band and the wind shift sweep across.", "Vertical mixing & gusts and Stability over the water for the gustiness behind the front."],
    where: ["Salish Sea: autumn and winter fronts; Puget Sound southerlies, the Strait's westerlies behind them."],
    limits: ["Timing can be off by a few hours; the model's gust is an estimate."],
    learn: ["gusts", "Gusts and the boundary layer"],
  },
};

// ---------- what's on screen, written out from the preset's settings ----------
const RANGE = { column: "through the whole column", low: "in the lowest 2 km", slice: "on the slice", xslab: "in a slab around the cross-section", hslab: "in a layer around the slice" };
export function onScreen(p, region) {
  const s = p.set, L = [], f = COLOUR_BY[s.field] || {};
  const at = s.slice.ref === "agl" ? `${s.slice.h} m above the ground (the water)` : `${s.slice.h.toLocaleString("en-US")} m above sea level`;
  const vid = s.view(region), sub = region?.subareas?.find((q) => vid.startsWith(`${q.id}-`)), where = sub ? (sub.name || sub.label || sub.id) : "the whole region";
  L.push(`<b>View:</b> ${s.flat ? `${where}, in 2D from straight above (press 2 or the 3D button for 3D)` : vid.endsWith("-top") ? `${where}, from above` : `${where}, in 3D`}.`);
  if (s.slice.on) L.push(`<b>Colour fill:</b> the slice at ${at}, coloured by <i>${f.label}</i>${f.units ? ` (${f.units})` : ""}${s.sliceOp ? ` at ${Math.round(s.sliceOp * 100)}% opacity` : ""}${s.slice.gusty ? ", with the gust shimmer" : ""}.`);
  else L.push("<b>Colour fill:</b> none for the wind.");
  if (s.curtain.on) L.push(`<b>Cross-section:</b> down the channel's axis, coloured by <i>${f.label}</i>.`);
  const pt = s.particles;
  if (pt?.on) L.push(`<b>Particles:</b> ${RANGE[pt.range] || pt.range}, coloured by ${PARTICLE_COLOURS[pt.colour]?.label || pt.colour}${pt.vertical ? `, rising and sinking with the model's vertical motion${pt.wBoost > 1 ? ` (×${pt.wBoost})` : ""}` : ""}${pt.gusty ? ", surging with the gustiness" : ""}.`);
  const gl = s.glyphs || {};
  if (gl.barbs || gl.stream) L.push(`<b>Wind symbols:</b> ${[gl.barbs && "barbs", gl.stream && "streamlines"].filter(Boolean).join(" and ")} at the slice's height.`);
  if (s.sea?.on) L.push(`<b>Sea state:</b> ${[s.sea.fill !== false && `wave height (${s.sea.mode || "total"}) as a colour fill`, s.sea.crests !== false && "moving crests", s.sea.arrows && "direction arrows"].filter(Boolean).join(", ") || "on for the hover readout only"}.`);
  const c = s.currents;
  if (c) L.push(`<b>Currents:</b> ${[c.fill !== false && "speed as a colour fill", c.arrows && c.arrows !== "none" && `arrows ${c.arrows === "grid" ? "on a grid" : "at the stations"}`, c.parts !== false && "particles", c.lines && "streamlines", c.marks && c.marks !== "none" && `stations as ${c.marks}`, c.flag !== false && "wind against current flagged", c.waves && "their effect on the waves"].filter(Boolean).join(", ")}.`);
  const extra = [s.turbulence && "turbulence proxy dots and the mixed layer's top", s.inversion && "the inversion band", s.fog && "the fog layer and visibility map", s.clouds && "the model's clouds", s.sat && "GOES-West satellite"].filter(Boolean);
  if (extra.length) L.push(`<b>Also:</b> ${extra.join(", ")}.`);
  L.push(`<b>Land:</b> ${s.waterOnly === false ? "shown too (over water only is off)" : "the wind drawn over the water only"}.`);
  if (s.inspect) L.push("<b>Surface viewer:</b> opens in the main channel.");
  return L;
}

// ---------- the window ----------
export class PresetInfo {
  constructor() {
    const el = (this.el = document.createElement("div"));
    el.id = "pi"; el.className = "rr pi"; el.hidden = true;
    el.innerHTML = `<div class="rr-h" title="Drag to move"><b>Preset guide</b><span class="rr-sub"></span><span class="rr-btns">
        <button class="btn mini" data-a="min" title="Minimise (keep it to its title bar)">▁</button>
        <button class="btn mini" data-a="close" title="Close (ⓘ beside the preset list opens it again)">✕</button></span></div>
      <div class="rr-body"></div>
      <label class="row pi-auto" title="Open this window each time a preset is picked"><input type="checkbox" id="pi-auto"> Show when a preset is picked</label>`;
    document.body.append(el);
    this.body = el.querySelector(".rr-body");
    el.querySelector(".rr-btns").addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "close") this.close(); else if (a === "min") { el.classList.toggle("min"); this.save(); }
    });
    let auto = true; try { auto = localStorage.getItem(`${KEY}.auto`) !== "off"; } catch { /* no storage */ }
    $("pi-auto").checked = auto;
    $("pi-auto").addEventListener("change", (e) => { try { localStorage.setItem(`${KEY}.auto`, e.target.checked ? "on" : "off"); } catch { /* no storage */ } });
    this.drag();
    new ResizeObserver(() => { if (!el.hidden && !el.classList.contains("min")) this.save(); }).observe(el);
    this.restore();
  }
  get auto() { return $("pi-auto").checked; }
  drag() {
    const h = this.el.querySelector(".rr-h");
    h.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      h.setPointerCapture(e.pointerId);
      const move = (q) => this.place(q.clientX - dx, q.clientY - dy);
      const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); this.save(); };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }
  place(x, y) { const w = this.el.offsetWidth; this.el.style.left = `${Math.min(innerWidth - 80, Math.max(80 - w, x))}px`; this.el.style.top = `${Math.min(innerHeight - 36, Math.max(0, y))}px`; }
  save() { try { const s = this.el.style; localStorage.setItem(KEY, JSON.stringify({ l: s.left, t: s.top, w: this.el.offsetWidth, h: this.el.offsetHeight, min: this.el.classList.contains("min") })); } catch { /* no storage */ } }
  restore() {
    let g = null; try { g = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* no storage */ }
    const w = Math.min(g?.w || 440, innerWidth - 16), h = Math.min(g?.h || Math.round(innerHeight * 0.62), innerHeight - 16);
    this.el.style.width = `${w}px`; this.el.style.height = `${h}px`;
    this.el.style.left = g?.l || `${Math.max(8, innerWidth - w - 24)}px`; this.el.style.top = g?.t || "64px";
  }
  // Show preset p (from presets.js) for this region.
  show(p, region) {
    const i = INFO[p.id] || {}, list = (a) => (a?.length ? `<ul>${a.map((x) => `<li>${x}</li>`).join("")}</ul>` : "");
    this.el.querySelector(".rr-sub").textContent = ` · ${p.label}`;
    this.body.innerHTML = `<p class="pi-q">${i.question || p.tip}</p>`
      + `<h4>On screen</h4>${list(onScreen(p, region))}`
      + (i.read ? `<h4>How to read it</h4>${list(i.read)}` : "")
      + (i.tryit ? `<h4>Try this</h4>${list(i.tryit)}` : "")
      + (i.where ? `<h4>Where it matters</h4>${list(i.where)}` : "")
      + (i.limits ? `<h4>Limits</h4>${list(i.limits)}` : "")
      + (i.learn ? `<p class="pi-learn">Learn more: <a href="${G}#${i.learn[0]}" target="_blank" rel="noopener">${i.learn[1]} ↗</a> (the guide)</p>` : "");
    this.el.hidden = false; this.el.classList.remove("min");
    this.place(parseFloat(this.el.style.left) || 8, parseFloat(this.el.style.top) || 64);
    this.body.scrollTop = 0;
  }
  close() { this.el.hidden = true; }
}
