// Control-panel tabs: View · Wind · Sea & weather · Channel · Data. One panel shows at a time;
// the choice is remembered in this browser. The Channel tab appears only where the region has a
// channel (channelpanel.js un-hides #ca), and opening it switches the analysis on (#ca open),
// as expanding the old section did. reveal(el) switches to the tab holding an element (used when
// a note links to a control in another tab).

const KEY = "wve-tab";
const $ = (id) => document.getElementById(id);
let buttons = [], panels = [], current = null;

export function selectTab(name, { save = true, focus = false } = {}) {
  const b = buttons.find((x) => x.dataset.tab === name && !x.hidden) || buttons.find((x) => !x.hidden);
  if (!b) return;
  current = b.dataset.tab;
  for (const x of buttons) { const on = x === b; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; x.classList.toggle("on", on); }
  for (const p of panels) p.hidden = p.dataset.tab !== current;
  if (current === "channel" && $("ca") && !$("ca").open) $("ca").open = true;       // the analysis runs while it's open
  if (focus) b.focus();
  if (save) try { localStorage.setItem(KEY, current); } catch { /* private mode */ }
  const panel = $("panel"), tabs = document.querySelector("#panel .tabs");
  if (panel && tabs && panel.scrollTop > tabs.offsetTop) panel.scrollTop = tabs.offsetTop - 40;   // back to the top of the new tab
}

export function reveal(el) {
  const p = el?.closest?.("section.tab");
  if (p && p.dataset.tab !== current) selectTab(p.dataset.tab);
}

export function initTabs() {
  buttons = [...document.querySelectorAll("#panel .tabs [role=tab]")];
  panels = [...document.querySelectorAll("#panel section.tab")];
  buttons.forEach((b, i) => {
    const panel = panels.find((p) => p.dataset.tab === b.dataset.tab);
    b.id = `tab-${b.dataset.tab}`; panel.id = `panel-${b.dataset.tab}`;
    b.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", b.id);
    b.addEventListener("click", () => selectTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const vis = buttons.filter((x) => !x.hidden), k = vis.indexOf(b), n = vis[(k + (e.key === "ArrowRight" ? 1 : vis.length - 1)) % vis.length];
      selectTab(n.dataset.tab, { focus: true });
    });
  });
  // The Channel tab follows #ca: shown where there's a channel; a link that opens the analysis selects it.
  const ca = $("ca"), cb = buttons.find((b) => b.dataset.tab === "channel");
  if (ca && cb) {
    const sync = () => {
      cb.hidden = ca.hidden;
      if (ca.hidden && current === "channel") selectTab("wind", { save: false });
    };
    new MutationObserver((ms) => {
      sync();
      if (ms.some((m) => m.attributeName === "open") && ca.open && !ca.hidden && current !== "channel") selectTab("channel", { save: false });
    }).observe(ca, { attributes: true, attributeFilter: ["hidden", "open"] });
    sync();
  }
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  selectTab(saved || "wind", { save: false });
}
