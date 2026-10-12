const test = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../src/crop-geometry.js');

test('角色裁剪框在横向和竖向窗口中都保持比例和边距', () => {
  for (const [width, height, aspect] of [[600, 360, 258 / 250], [240, 600, .75], [500, 500, 4 / 3]]) {
    const frame = geometry.frame(width, height, aspect);
    assert.ok(frame.width <= width - 40 && frame.height <= height - 40);
    assert.ok(Math.abs(frame.width / frame.height - aspect) < .0001);
  }
});

test('滚轮缩放保持鼠标指向的原图像素位置', () => {
  const point = { x: 135, y: 96 }, original = { x: .1, y: -.05 };
  const before = geometry.placement(640, 480, 300, 300, 100, original);
  const offset = geometry.zoomAt(640, 480, 300, 300, 100, 180, original, point);
  const after = geometry.placement(640, 480, 300, 300, 180, offset);
  assert.ok(Math.abs((point.x - before.x) / before.scale - (point.x - after.x) / after.scale) < .001);
  assert.ok(Math.abs((point.y - before.y) / before.scale - (point.y - after.y) / after.scale) < .001);
});

test('拖动不能把整张图片移出裁剪框，仍允许透明边距', () => {
  for (const zoom of [25, 100, 400]) {
    for (const extreme of [-100, 100]) {
      const offset = geometry.constrain(300, 900, 320, 320, zoom, { x: extreme, y: extreme });
      const box = geometry.placement(300, 900, 320, 320, zoom, offset);
      assert.ok(box.x < 320 && box.x + box.width > 0);
      assert.ok(box.y < 320 && box.y + box.height > 0);
    }
  }
  const box = geometry.placement(600, 300, 300, 300, 100, { x: 0, y: 0 });
  assert.equal(box.y, 75);
});

test('保存尺寸有上限且维持预览比例', () => {
  for (const aspect of [.75, 1, 258 / 250, 4 / 3, 10]) {
    const size = geometry.outputSize(aspect);
    assert.equal(Math.max(size.width, size.height), 768);
    assert.ok(Math.abs(size.width / size.height - aspect) < aspect * .01);
  }
});
