const test = require('node:test');
const assert = require('node:assert/strict');
const { scopedBounds, snapBounds, clampBounds, SNAP_DISTANCE, shouldShow } = require('../src/scope.cjs');
const { VIEWPORT } = require('../src/layout.cjs');

const area = { x: 100, y: 50, width: 800, height: 600 };

test('scopedBounds 按 placement 贴边并限制在窗口内', () => {
  const rightBottom = scopedBounds(area, 0.8, { right: 2, bottom: 2, anchorX: 'right', anchorY: 'bottom' });
  assert.equal(rightBottom.scale, 0.8);
  assert.equal(rightBottom.bounds.width, Math.round(VIEWPORT.width * 0.8));
  assert.equal(rightBottom.bounds.x, area.x + area.width - rightBottom.bounds.width - 2);
  assert.equal(rightBottom.bounds.y, area.y + area.height - rightBottom.bounds.height - 2);

  const leftTop = scopedBounds(area, 0.8, { right: 40, bottom: 40, anchorX: 'left', anchorY: 'top' });
  assert.equal(leftTop.bounds.x, area.x + 2);
  assert.equal(leftTop.bounds.y, area.y + 2);
});

test('窗口过小会自动降缩放，过小则不显示', () => {
  const tight = scopedBounds({ x: 0, y: 0, width: 320, height: 280 }, 1.4, { right: 2, bottom: 2 });
  assert.ok(tight);
  assert.ok(tight.scale < 1.4);
  assert.ok(tight.scale >= 0.35);
  assert.equal(scopedBounds({ x: 0, y: 0, width: 40, height: 40 }, 0.8), null);
  assert.equal(scopedBounds(null, 0.8), null);
});

test('snapBounds 靠近边缘一次吸附到对应边/角，不越过边界', () => {
  const width = 288, height = 448;
  const free = snapBounds(area, { x: area.x + 100, y: area.y + 100, width, height });
  assert.equal(free.placement.anchorX, null);
  assert.equal(free.placement.anchorY, null);
  assert.equal(free.bounds.x, area.x + 100);

  const nearLeft = snapBounds(area, { x: area.x + 2 + SNAP_DISTANCE - 1, y: area.y + 120, width, height });
  assert.equal(nearLeft.placement.anchorX, 'left');
  assert.equal(nearLeft.bounds.x, area.x + 2);

  const corner = snapBounds(area, {
    x: area.x + area.width - width - 2 - (SNAP_DISTANCE - 1),
    y: area.y + area.height - height - 2 - (SNAP_DISTANCE - 1),
    width, height
  });
  assert.deepEqual([corner.placement.anchorX, corner.placement.anchorY], ['right', 'bottom']);
  assert.equal(corner.bounds.x, area.x + area.width - width - 2);
  assert.equal(corner.bounds.y, area.y + area.height - height - 2);
});

test('snapBounds 距离边缘超过阈值时不吸附，非法区域返回 null', () => {
  const width = 288, height = 448;
  const far = snapBounds(area, { x: area.x + 2 + SNAP_DISTANCE + 5, y: area.y + 2 + SNAP_DISTANCE + 5, width, height });
  assert.equal(far.placement.anchorX, null);
  assert.equal(far.placement.anchorY, null);
  assert.equal(snapBounds(area, null), null);
  assert.equal(snapBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width, height }), null);
});

test('跨屏矩形各自落在目标区域内，125% 与 150% 连续钳制漂移不超过 1px', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1080 };
  const right = { x: 1920, y: -240, width: 1280, height: 800 };
  const placement = { right: 2, bottom: 2, anchorX: 'right', anchorY: 'bottom' };
  for (const [area, scale] of [[left, 1.25], [right, 1.5]]) {
    const layout = scopedBounds(area, scale, placement);
    assert.equal(layout.bounds.width, Math.round(VIEWPORT.width * layout.scale));
    assert.equal(layout.bounds.height, Math.round(VIEWPORT.height * layout.scale));
    assert.ok(layout.bounds.x >= area.x + 2);
    assert.ok(layout.bounds.y >= area.y + 2);
    assert.ok(layout.bounds.x + layout.bounds.width <= area.x + area.width - 2);
    assert.ok(layout.bounds.y + layout.bounds.height <= area.y + area.height - 2);
    let bounds = layout.bounds;
    for (let i = 0; i < 20; i += 1) {
      const next = clampBounds(area, { ...bounds, x: bounds.x + (i % 2 ? 0.4 : -0.4), y: bounds.y + 0.2 });
      assert.ok(Math.abs(next.bounds.width - layout.bounds.width) <= 1);
      assert.ok(Math.abs(next.bounds.height - layout.bounds.height) <= 1);
      assert.ok(Math.abs(next.bounds.x - bounds.x) <= 1);
      assert.ok(Math.abs(next.bounds.y - bounds.y) <= 1);
      bounds = next.bounds;
    }
  }
  const fractional = scopedBounds({ x: 10, y: 20, width: 500, height: 900 }, 2, placement);
  assert.equal(fractional.bounds.width, Math.round(VIEWPORT.width * fractional.scale));
  assert.ok(fractional.scale < 2);
});

test('shouldShow 要求 active、ownerBound 且有 rect', () => {
  assert.equal(shouldShow({ active: true, ownerBound: true, rect: area }), true);
  assert.equal(shouldShow({ active: true, ownerBound: false, rect: area }), false);
  assert.equal(shouldShow({ active: false, ownerBound: true, rect: area }), false);
  assert.equal(shouldShow({ active: true, ownerBound: true, rect: null }), false);
});
