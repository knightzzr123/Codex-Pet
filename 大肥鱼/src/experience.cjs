const BUBBLE_SECONDS = Object.freeze([5, 8, 15, 0]);
const BUBBLE_OFFSET_MIN = -48;
const BUBBLE_OFFSET_MAX = 48;
const IDLE_INTERVAL_MIN = 5;
const IDLE_INTERVAL_MAX = 300;
const IDLE_INTERVAL_DEFAULT = 45;
const OPACITY_MIN = 0.35;
const OPACITY_MAX = 1;
const OPACITY_DEFAULT = 1;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function experienceFromPreferences(saved = {}) {
  return {
    bubbleSeconds: BUBBLE_SECONDS.includes(saved.bubbleSeconds) ? saved.bubbleSeconds : 8,
    advanceOnPetTap: saved.advanceOnPetTap === true,
    mirrorOnLeft: saved.mirrorOnLeft !== false,
    reducedMotion: saved.reducedMotion === true,
    bubbleOffsetX: Math.round(clampNumber(saved.bubbleOffsetX, BUBBLE_OFFSET_MIN, BUBBLE_OFFSET_MAX, 0)),
    bubbleOffsetY: Math.round(clampNumber(saved.bubbleOffsetY, BUBBLE_OFFSET_MIN, BUBBLE_OFFSET_MAX, 0)),
    idleIntervalSec: Math.round(clampNumber(saved.idleIntervalSec ?? saved.idleInterval, IDLE_INTERVAL_MIN, IDLE_INTERVAL_MAX, IDLE_INTERVAL_DEFAULT)),
    opacity: Math.round(clampNumber(saved.opacity, OPACITY_MIN, OPACITY_MAX, OPACITY_DEFAULT) * 100) / 100
  };
}

module.exports = {
  BUBBLE_SECONDS,
  BUBBLE_OFFSET_MIN,
  BUBBLE_OFFSET_MAX,
  IDLE_INTERVAL_MIN,
  IDLE_INTERVAL_MAX,
  IDLE_INTERVAL_DEFAULT,
  OPACITY_MIN,
  OPACITY_MAX,
  OPACITY_DEFAULT,
  experienceFromPreferences
};
