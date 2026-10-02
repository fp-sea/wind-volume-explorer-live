// Heavy per-hour work (clouds, fog, the particles' flow field) in small slices of idle time, so the
// page never freezes for hundreds of milliseconds (performance review, 2026-09-28). body(i) runs
// for i = 0 … n-1 in order; each slice stops after ~budget ms and the next waits for idle time
// (at most ~50 ms: it carries on even while playback keeps the page busy).
//
// finish() on the returned job runs whatever is left right away, for when the result is needed now.

const later = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 50 }) : setTimeout(fn, 0));

export function idleLoop(n, body, { budget = 8 } = {}) {
  let i = 0, resolve, reject, done = false;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const run = (ms) => {
    if (done) return;
    try {
      const t0 = performance.now();
      while (i < n && performance.now() - t0 < ms) body(i++);
      if (i >= n) { done = true; resolve(); } else later(() => run(budget));
    } catch (e) { done = true; reject(e); }
  };
  later(() => run(budget));
  return { promise, finish: () => run(Infinity), get done() { return done; } };
}
