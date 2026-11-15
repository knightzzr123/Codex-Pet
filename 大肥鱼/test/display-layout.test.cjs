const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  scaleFactorOf, displayForRect, crossedDisplay, noteDisplay, relocateToVisibleDisplay, dipAreaForScope
} = require('../src/display-layout.cjs');

const laptop = { id: 1, scaleFactor: 1.5, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const external = { id: 2, scaleFactor: 1, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, workArea: { x: 1920, y: -200, width: 2560, height: 1400 } };

test('屏幕事件用显示器自己的 scaleFactor，缺失时回退为 1', () => {
  assert.equal(scaleFactorOf(laptop), 1.5);
  assert.equal(scaleFactorOf(external), 1);
  assert.equal(scaleFactorOf({ scaleFactor: 0 }), 1);
  assert.equal(scaleFactorOf(null), 1);
});

test('跨屏时能分清两块屏，并记下 scaleFactor 变化', () => {
  const onLaptop = displayForRect([laptop, external], { x: 100, y: 80, width: 800, height: 600 });
  const onExternal = displayForRect([laptop, external], { x: 2000, y: 10, width: 900, height: 700 });
  assert.equal(onLaptop.id, 1);
  assert.equal(onExternal.id, 2);
  assert.equal(crossedDisplay(1, 2), true);
  assert.equal(crossedDisplay(2, 2), false);
  const first = noteDisplay({ displayId: null, scaleFactor: null }, [laptop, external], { x: 100, y: 80, width: 400, height: 300 });
  assert.equal(first.crossed, false);
  assert.equal(first.scaleFactor, 1.5);
  const moved = noteDisplay(first, [laptop, external], { x: 2200, y: 40, width: 400, height: 300 });
  assert.equal(moved.crossed, true);
  assert.equal(moved.scaleChanged, true);
  assert.equal(moved.scaleFactor, 1);
});

test('display-removed 后把完全看不见的窗口拉回主屏工作区', () => {
  const visible = relocateToVisibleDisplay({ x: 40, y: 40, width: 200, height: 120 }, [laptop, external]);
  assert.equal(visible, null);
  const stranded = relocateToVisibleDisplay({ x: 4000, y: 40, width: 300, height: 180 }, [laptop]);
  assert.equal(stranded.displayId, 1);
  assert.equal(stranded.scaleFactor, 1.5);
  assert.ok(stranded.x >= laptop.workArea.x);
  assert.ok(stranded.x + stranded.width <= laptop.workArea.x + laptop.workArea.width);
  assert.ok(stranded.y + stranded.height <= laptop.workArea.y + laptop.workArea.height);
});

test('currentArea 仍调用 screenToDipRect(null, scopeRect)，不改成窗口', () => {
  const rect = { x: 8, y: 16, width: 100, height: 50 };
  let args = null;
  const area = dipAreaForScope({
    screenToDipRect: (...received) => { args = received; return { x: 1, y: 2, width: 3, height: 4 }; }
  }, rect);
  assert.deepEqual(area, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(args[0], null);
  assert.equal(args[1], rect);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(main, /screen\.screenToDipRect\(null, scope\.rect\)/);
  assert.match(main, /onScreenTopology\('removed'\)/);
  assert.match(main, /onScreenTopology\('metrics'\)/);
  assert.match(main, /relocateToVisibleDisplay/);
});
