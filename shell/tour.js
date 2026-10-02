// Tour of views: camera stops you add, flown between in order. Kept per region in
// this browser only (localStorage; a convenience, not saved state).
//
// Adapted from radar-explorer web/app.js@7439092 (loadTour/saveTour/tourStop/playTour).
// Same legs and timings: 2.5 s eased flight, then 1.2 s hold. Stops store the
// exaggeration they were taken at, and heights are rescaled to the one in use now.

export const LEG_MS = 2500, HOLD_MS = 1200;

export class Tour {
  constructor(stage, keyFn) {
    this.stage = stage;
    this.keyFn = keyFn;          // () => storage key for the current region
    this.stops = [];
    this.playing = false;
    this.onChange = () => {};
  }
  load() {
    try { this.stops = JSON.parse(localStorage.getItem(this.keyFn())) || []; } catch { this.stops = []; }
    this.onChange();
  }
  save() {
    try { localStorage.setItem(this.keyFn(), JSON.stringify(this.stops)); } catch { /* not kept: private window etc. */ }
    this.onChange();
  }
  add() {
    const { camera, controls, vex } = this.stage;
    const p = camera.position, t = controls.target;
    if (![p.x, p.y, p.z, t.x, t.y, t.z].every(Number.isFinite)) return;
    this.stops.push({ pos: [p.x, p.y, p.z], target: [t.x, t.y, t.z], vex });
    this.save();
  }
  clear() { this.stops = []; this.save(); }

  // A stop's camera, its heights rescaled to the exaggeration in use now.
  stop(st) {
    const k = this.stage.vex / (st.vex || this.stage.vex);
    return { pos: { x: st.pos[0], y: st.pos[1], z: st.pos[2] * k }, target: { x: st.target[0], y: st.target[1], z: st.target[2] * k } };
  }

  async play() {
    if (this.playing) { this.playing = false; this.onChange(); return; }
    if (this.stops.length < 2) return;
    this.playing = true;
    this.onChange();
    for (const st of this.stops) {
      if (!this.playing) break;
      await this.stage.flyTo(this.stop(st), { ms: LEG_MS });
      await new Promise((r) => setTimeout(r, HOLD_MS));
    }
    this.playing = false;
    this.onChange();
  }
}
