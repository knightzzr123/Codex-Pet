const test = require('node:test');
const assert = require('node:assert/strict');
const { SIZE_SCALES, DEFAULT_SIZE_LEVEL, isSizeLevel, sizeLevelFromPreferences, scaleForLevel } = require('../src/size.cjs');

test('十档大小 level 与 scale 一一对应，默认第 4 档', () => {
  assert.equal(SIZE_SCALES.length, 10);
  assert.equal(DEFAULT_SIZE_LEVEL, 4);
  assert.equal(scaleForLevel(4), 0.8);
  assert.equal(scaleForLevel(1), 0.5);
  assert.equal(scaleForLevel(10), 1.4);
  assert.equal(scaleForLevel(99), scaleForLevel(DEFAULT_SIZE_LEVEL));
});

test('非法 sizeLevel 回退默认；旧版 scale 字段可映射到档位', () => {
  assert.equal(isSizeLevel(0), false);
  assert.equal(isSizeLevel(11), false);
  assert.equal(isSizeLevel(4.5), false);
  assert.equal(sizeLevelFromPreferences({}), DEFAULT_SIZE_LEVEL);
  assert.equal(sizeLevelFromPreferences({ sizeLevel: 7 }), 7);
  assert.equal(sizeLevelFromPreferences({ sizeLevel: 99 }), DEFAULT_SIZE_LEVEL);
  assert.equal(sizeLevelFromPreferences({ scale: 1.2 }), 8);
  assert.equal(sizeLevelFromPreferences({ scale: 0.123 }), DEFAULT_SIZE_LEVEL);
});
