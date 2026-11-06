const test = require('node:test');
const assert = require('node:assert/strict');
const { VIEWPORT, inputRegions } = require('../src/layout.cjs');

test('输入区域随缩放与镜像变化，气泡可见时包含上半区', () => {
  const closed = inputRegions(1, false, false);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].x, 64);
  const mirrored = inputRegions(0.8, true, true);
  assert.equal(mirrored.length, 2);
  assert.equal(mirrored[0].x, 0);
  assert.equal(mirrored[1].width, Math.ceil(VIEWPORT.width * 0.8));
  assert.equal(mirrored[1].height, Math.ceil(360 * 0.8));
});
