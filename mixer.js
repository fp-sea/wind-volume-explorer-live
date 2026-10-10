// "Surface layers": everything drawn on the water's surface in one place, as three cards (the
// wind at the surface, the currents, the sea state), each with the same kinds of rows: a colour
// fill, symbols (particles, streamlines, barbs or arrows), and animation where there is some, each
// row with its switch, its choices and its own opacity. Fills stack (each with its opacity).
// The rows mirror the full controls (the Wind tab, and further down Sea & weather): changing
// either changes both, so there's one set of settings. A card's own layer (Tidal currents, Sea
// state) is switched on with its first row and off with its last.

const $ = (id) => document.getElementById(id);
const CARDS = [
  { title: "Wind at the surface", wind: true, rows: [
    { label: "Colour fill", on: "show-slice", op: "op-slice", sel: "field-select", checks: [["slice-gusty", "gust shimmer"]], more: [["smooth", "smooth colours"]], title: "The slice's colours: wind speed, gust or another field (Colour by). Gust shimmer: the colours surge toward the model's gust in drifting puffs where it's gusty (10 m, wind speed)" },
    { label: "Particles", on: "show-particles", op: "op-particles", checks: [["pt-gusty", "gust surges"]], more: [["pt-density", "density"], ["pt-width", "width"], ["pt-colour", "colour by"], ["pt-range", "where"], ["pt-heads", "bright heads"]], title: "Streaks drifting with the wind (where, colour and density in the Wind tab). Gust surges: near the surface they surge and lull around the mean in proportion to the model's gust factor" },
    { label: "Streamlines", on: "wind-stream", op: "glyph-opacity", more: [["glyph-density", "density"], ["glyph-size", "size"], ["glyph-colour", "colour"]], title: "Streamlines of the wind on the slice, with arrowheads (shares its opacity with the barbs)" },
    { label: "Barbs", on: "wind-barbs", op: "glyph-opacity", more: [["glyph-density", "density"], ["glyph-size", "size"], ["glyph-colour", "colour"]], title: "Wind barbs on the slice, in knots (shares its opacity with the streamlines)" },
  ] },
  { title: "Currents", master: "show-cur", head: "cur-src", rows: [
    { label: "Colour fill", on: "cur-fill", op: "op-cur", title: "The current's speed everywhere on the water (SSCOFS, or blended between the stations)" },
    { label: "Arrows", onSel: "cur-arrows", op: "op-curarrows", more: [["cur-scale", "size"]], title: "Where it sets and how fast: on a ~2.5 km grid, or at the NOAA stations (opacity shared with the station markers)" },
    { label: "Particles", on: "cur-parts", op: "op-curparts", more: [["cur-density", "density"], ["cur-speed", "flow speed"]], title: "Particles drifting with the current, placed and paced for the view (density and speed below)" },
    { label: "Streamlines", on: "cur-lines", op: "op-curlines", more: [["cur-density", "density"]], title: "Evenly spaced streamlines with arrowheads, eddies included" },
    { label: "Stations", onSel: "cur-marks", checks: [["cur-flag", "wind vs current"]], more: [["cur-scale", "size"], ["cur-names", "label primary stations"]], title: "NOAA's stations as rings or coloured dots (click one for its current graph); rings where the wind against the current makes steep or dangerous chop" },
  ] },
  { title: "Sea state", master: "show-sea", rows: [
    { label: "Colour fill", on: "sea-fill", op: "op-sea", sel: "sea-mode", more: [["sea-duration", "wind for"]], title: "The water coloured by wave height: total, chop or swell (the opacity also sets the moving waves')" },
    { label: "Moving waves", on: "sea-crests", checks: [["sea-anim", "animate"]], title: "Crests moving along the waves, bigger and whiter as the sea builds, whitecaps where it's rough (white over the map when the colour is off)" },
    { label: "Direction arrows", on: "sea-arrows", op: "op-seaarrows", title: "Arrows along the waves' travel, longer and paler for bigger seas" },
  ] },
];

function fire(el) { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);
const mirrorSelect = (src) => { const m = mk("select", { className: "mini" }); m.innerHTML = src.innerHTML; m.addEventListener("change", () => { src.value = m.value; fire(src); }); return m; };

export function mountMixer(host) {
  if (!host) return;
  const syncs = [];
  host.innerHTML = "";
  for (const card of CARDS) {
    const box = mk("div", { className: "mix-card" }), head = mk("div", { className: "mix-head" });
    head.append(mk("b", { textContent: card.title }));
    const master = card.master && $(card.master), hsrc = card.head && $(card.head);
    let hsel = null;
    if (hsrc) { hsel = mirrorSelect(hsrc); hsel.title = hsrc.closest("[title]")?.title || ""; head.append(hsel); }
    box.append(head);
    // (the wind card: where the slice is, with a way back to 10 m)
    let where = null;
    if (card.wind) {
      where = mk("div", { className: "note mix-where" });
      box.append(where);
      where.addEventListener("click", (e) => { if (!e.target.closest("button")) return; $("ref-agl")?.click(); const h = $("height"); h.value = "0"; fire(h); });
    }
    const rowsOn = [];
    for (const r of card.rows) {
      const on = r.on && $(r.on), sel = (r.sel && $(r.sel)) || null, onSel = r.onSel && $(r.onSel), op = r.op && $(r.op);
      if (!on && !onSel) continue;
      const row = mk("div", { className: "mix-row", title: r.title }), cb = mk("input", { type: "checkbox" }), lab = mk("label", { className: "row mix-on" });
      lab.append(cb, ` ${r.label}`); row.append(lab);
      // A select that also switches the row (its "none" option off).
      let mSel = null, lastSel = null;
      if (onSel) {
        mSel = mk("select", { className: "mini" }); mSel.innerHTML = [...onSel.options].filter((o) => o.value !== "none").map((o) => o.outerHTML).join("");
        mSel.addEventListener("change", () => { onSel.value = mSel.value; lastSel = mSel.value; fire(onSel); ensureMaster(); });
        row.append(mSel);
      } else if (sel) { mSel = mirrorSelect(sel); row.append(mSel); }
      const checks = (r.checks || []).map(([id, name]) => {
        const o = $(id); if (!o) return null;
        const c = mk("input", { type: "checkbox" }), l = mk("label", { className: "row mix-sub" });
        l.append(c, ` ${name}`); row.append(l);
        c.addEventListener("change", () => { o.checked = c.checked; fire(o); });
        return [o, c];
      }).filter(Boolean);
      // ⚙: the row's own settings (density, size, width, colour…), mirrors of the full controls.
      const more = (r.more || []).map(([id, name]) => [$(id), name]).filter(([o]) => o);
      let mores = [];
      if (more.length) {
        const gear = mk("button", { className: "btn mini mix-gear", textContent: "⚙", title: "Settings: " + more.map(([, n]) => n).join(", ") });
        const pane = mk("div", { className: "mix-more", hidden: true });
        for (const [o, name] of more) {
          const l = mk("label", { className: "mix-set" }); l.append(mk("span", { textContent: name }));
          let c;
          if (o.type === "checkbox") { c = mk("input", { type: "checkbox" }); c.addEventListener("change", () => { o.checked = c.checked; fire(o); }); l.prepend(c); }
          else if (o.tagName === "SELECT") { c = mk("select", { className: "mini" }); c.innerHTML = o.innerHTML; c.addEventListener("change", () => { o.value = c.value; fire(o); }); l.append(c); }
          else { c = mk("input", { type: "range", min: o.min, max: o.max, step: o.step }); c.addEventListener("input", () => { o.value = c.value; fire(o); }); l.append(c); }
          c.title = o.title || o.closest("[title]")?.title || name;
          pane.append(l); mores.push([o, c]);
        }
        gear.addEventListener("click", () => { pane.hidden = !pane.hidden; gear.classList.toggle("on", !pane.hidden); });
        row.append(gear); row._pane = pane;
      }
      let mOp = null;
      if (op) { mOp = mk("input", { type: "range", min: op.min, max: op.max, step: op.step, className: "op", title: "Opacity" }); mOp.addEventListener("input", () => { op.value = mOp.value; fire(op); }); row.append(mOp); }
      box.append(row);
      if (row._pane) box.append(row._pane);
      const isOn = () => (onSel ? onSel.value !== "none" : on.checked);
      rowsOn.push(isOn);
      const ensureMaster = () => { if (master && !master.checked && rowsOn.some((f) => f())) { master.checked = true; fire(master); } };
      cb.addEventListener("change", () => {
        const want = cb.checked;                                         // (firing the change re-syncs this row)
        if (onSel) { onSel.value = want ? lastSel || onSel.querySelector("option:not([value=none])")?.value : "none"; fire(onSel); }
        else { on.checked = want; fire(on); }
        if (want) ensureMaster();
        else if (master?.checked && !rowsOn.some((f) => f())) { master.checked = false; fire(master); }   // (the last one off: the layer off)
      });
      const sync = () => {
        const shown = isOn() && (!master || master.checked);
        cb.checked = shown;
        if (onSel) { if (onSel.value !== "none") { mSel.value = onSel.value; lastSel = onSel.value; } }
        else if (mSel && sel) { if (mSel.innerHTML !== sel.innerHTML) mSel.innerHTML = sel.innerHTML; mSel.value = sel.value; }   // (options filled in later, per model)
        if (mOp) mOp.value = op.value;
        for (const [o, c] of checks) c.checked = o.checked;
        for (const [o, c] of mores) { if (c.type === "checkbox") c.checked = o.checked; else { if (c.tagName === "SELECT" && c.innerHTML !== o.innerHTML) c.innerHTML = o.innerHTML; c.value = o.value; } }
        for (const x of [mOp, mSel, ...checks.map(([, c]) => c)]) if (x) x.disabled = !shown;
        row.classList.toggle("off", !shown);
      };
      for (const el of [on, onSel, sel, op, master, ...checks.map(([o]) => o), ...mores.map(([o]) => o)]) el?.addEventListener("input", sync), el?.addEventListener("change", sync);
      syncs.push(sync);
    }
    // (a card hidden where the region or model doesn't have it: no currents in the region)
    const cardSync = () => {
      const any = card.rows.map((r) => $(r.on || r.onSel)).find(Boolean);
      box.hidden = !!(any?.closest(".layer[hidden], .needs-model[hidden]") || (master && master.closest(".layer[hidden]")));
      if (hsel && hsrc) { if (hsel.innerHTML !== hsrc.innerHTML) hsel.innerHTML = hsrc.innerHTML; hsel.value = hsrc.value; hsel.hidden = !!hsrc.closest("[hidden]:not(.subbox)") || hsrc.closest(".inline")?.hidden; }
      if (where) {
        const hv = $("height-val")?.textContent || "", agl = $("ref-agl")?.classList.contains("on"), low = agl && +$("height")?.value === 0;
        where.innerHTML = low ? "At 10 m above the water (the slice's height)." : `The fill, particles on the slice, streamlines and barbs are at the slice's height${hv ? `: ${hv}` : ""}. <button class="btn mini">Put at 10 m</button>`;
      }
    };
    syncs.push(cardSync);
    host.append(box);
  }
  const syncAll = () => syncs.forEach((f) => f());
  syncAll();
  // (settings changed by presets, the region or the model don't always fire events: look again
  // when the tab is opened and now and then while it's open)
  document.querySelector('[role=tab][data-tab="sea"]')?.addEventListener("click", syncAll);
  setInterval(() => { if (host.offsetParent) syncAll(); }, 1500);
  return syncAll;
}
