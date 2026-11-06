// Shared with src/style.css (--motion-ease / --motion-micro / --motion-panel)
// and the renderer MOTION tokens. Snap settle uses the panel duration;
// zoom-factor interpolation between size levels uses the micro duration.
const MOTION = Object.freeze({
  ease: Object.freeze([0.22, 1, 0.36, 1]),
  micro: 200,
  panel: 320
});

const SNAP_MS = MOTION.panel;
const ZOOM_MS = MOTION.micro;

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function createCubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = t => ((ax * t + bx) * t + cx) * t;
  const sampleY = t => ((ay * t + by) * t + cy) * t;
  const sampleDX = t => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - x;
      const slope = sampleDX(t);
      if (Math.abs(error) < 1e-6) return clamp01(t);
      if (Math.abs(slope) < 1e-6) break;
      t = clamp01(t - error / slope);
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const estimate = sampleX(t);
      if (Math.abs(estimate - x) < 1e-6) return t;
      if (estimate < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return unit => {
    const x = clamp01(unit);
    if (x === 0 || x === 1) return x;
    return clamp01(sampleY(solveX(x)));
  };
}

const settleEase = createCubicBezier(...MOTION.ease);

function motionProgress(elapsedMs, durationMs, { reduced = false } = {}) {
  if (reduced || !(durationMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  if (elapsedMs >= durationMs) return 1;
  return settleEase(elapsedMs / durationMs);
}

function interpolateZoom(from, to, progress) {
  const t = clamp01(progress);
  if (t <= 0) return from;
  if (t >= 1) return to;
  return from + (to - from) * t;
}

function interpolateBounds(from, to, progress) {
  const t = clamp01(progress);
  if (t <= 0) return { x: from.x, y: from.y, width: from.width, height: from.height };
  if (t >= 1) return { x: to.x, y: to.y, width: to.width, height: to.height };
  const axis = key => Math.round(from[key] + (to[key] - from[key]) * t);
  return { x: axis('x'), y: axis('y'), width: axis('width'), height: axis('height') };
}

function boundsDiffer(from, to, tolerance = 1) {
  if (!from || !to) return false;
  return ['x', 'y', 'width', 'height'].some(key => Math.abs(from[key] - to[key]) > tolerance);
}

function zoomDiffer(from, to, tolerance = 0.001) {
  return Math.abs(from - to) > tolerance;
}

function settleDurationMs({ boundsDiffer: move = false, zoomDiffer: zooming = false, reduced = false } = {}) {
  if (reduced || (!move && !zooming)) return 0;
  if (move && zooming) return Math.max(SNAP_MS, ZOOM_MS);
  return zooming ? ZOOM_MS : SNAP_MS;
}

function createSettlePlayer({
  now = Date.now,
  schedule = setTimeout,
  clear = clearTimeout,
  frameMs = 16
} = {}) {
  let active = null;
  function stop() {
    if (!active) return;
    active.cancelled = true;
    if (active.handle) clear(active.handle);
    active = null;
  }
  function play({ durationMs, reduced = false, onFrame, onDone }) {
    stop();
    if (reduced || !(durationMs > 0)) {
      onFrame?.(1);
      onDone?.();
      return { cancel() {} };
    }
    const started = now();
    const state = { cancelled: false, handle: null };
    active = state;
    const tick = () => {
      if (state.cancelled || active !== state) return;
      const progress = motionProgress(now() - started, durationMs);
      onFrame?.(progress);
      if (state.cancelled || active !== state) return;
      if (progress >= 1) {
        if (active === state) active = null;
        onDone?.();
        return;
      }
      state.handle = schedule(tick, frameMs);
    };
    state.handle = schedule(tick, frameMs);
    return {
      cancel() {
        if (state.cancelled) return;
        state.cancelled = true;
        if (state.handle) clear(state.handle);
        if (active === state) active = null;
      }
    };
  }
  return { play, stop };
}

module.exports = {
  MOTION, SNAP_MS, ZOOM_MS,
  createCubicBezier, motionProgress, interpolateZoom, interpolateBounds,
  boundsDiffer, zoomDiffer, settleDurationMs, createSettlePlayer
};
