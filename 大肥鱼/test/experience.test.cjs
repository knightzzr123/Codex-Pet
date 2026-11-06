const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUBBLE_SECONDS, experienceFromPreferences, OPACITY_MIN, BUBBLE_OFFSET_MAX, IDLE_INTERVAL_DEFAULT
} = require('../src/experience.cjs');

test('体验偏好只接受白名单停留秒数，布尔项有安全默认', () => {
  assert.deepEqual(BUBBLE_SECONDS, [5, 8, 15, 0]);
  assert.deepEqual(experienceFromPreferences({}), {
    bubbleSeconds: 8, advanceOnPetTap: false, mirrorOnLeft: true, reducedMotion: false,
    bubbleOffsetX: 0, bubbleOffsetY: 0, idleIntervalSec: IDLE_INTERVAL_DEFAULT, opacity: 1
  });
  assert.deepEqual(experienceFromPreferences({
    bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false, reducedMotion: true,
    bubbleOffsetX: 12, bubbleOffsetY: -4, idleIntervalSec: 60, opacity: 0.8
  }), {
    bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false, reducedMotion: true,
    bubbleOffsetX: 12, bubbleOffsetY: -4, idleIntervalSec: 60, opacity: 0.8
  });
});

test('非法自定义输入被钳制，透明度下限仍可恢复面板', () => {
  const bad = experienceFromPreferences({
    bubbleSeconds: 3, advanceOnPetTap: 'yes', mirrorOnLeft: 0, reducedMotion: 'true',
    bubbleOffsetX: 99, bubbleOffsetY: -100, opacity: 0.05, idleInterval: 1
  });
  assert.equal(bad.bubbleSeconds, 8);
  assert.equal(bad.advanceOnPetTap, false);
  assert.equal(bad.mirrorOnLeft, true);
  assert.equal(bad.reducedMotion, false);
  assert.equal(bad.bubbleOffsetX, BUBBLE_OFFSET_MAX);
  assert.equal(bad.bubbleOffsetY, -48);
  assert.equal(bad.opacity, OPACITY_MIN);
  assert.ok(bad.opacity >= OPACITY_MIN);
  assert.equal(bad.idleIntervalSec, 5);
});
