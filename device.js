// Lighter defaults for phones and modest machines (performance review, 2026-09-28): a
// phone-width screen, 4 GB of memory or less, or 4 CPU cores or fewer. Used for the renderer's
// pixel density, the starting particle density, and the cloud/fog/visibility grids.
export const LITE = (typeof window !== "undefined") && (
  window.matchMedia?.("(max-width: 700px)").matches
  || (navigator.deviceMemory && navigator.deviceMemory <= 4)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4));
