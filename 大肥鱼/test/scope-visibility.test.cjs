const test = require('node:test');
const assert = require('node:assert/strict');
const { createDebouncedShowHide, createDebouncedDiskStatus } = require('../src/scope-visibility.cjs');
const { clampBounds, snapBounds, SNAP_DISTANCE } = require('../src/scope.cjs');

test('show/hide 防抖：快速切换只应用最终可见性，不狂闪', () => {
  const events = [];
  const timers = [];
  const visibility = createDebouncedShowHide({
    delayMs: 40,
    onShow: () => events.push('show'),
    onHide: () => events.push('hide'),
    setTimer: (fn, ms) => {
      const id = { fn, ms, cleared: false };
      timers.push(id);
      return id;
    },
    clearTimer: id => { id.cleared = true; }
  });
  visibility.request(true);
  visibility.request(false);
  visibility.request(true);
  visibility.request(false);
  assert.deepEqual(events, []);
  timers.filter(item => !item.cleared).at(-1).fn();
  assert.deepEqual(events, ['hide']);
  visibility.request(true);
  const showTimer = timers.filter(item => !item.cleared).at(-1);
  showTimer.fn();
  showTimer.cleared = true;
  assert.deepEqual(events, ['hide', 'show']);
  // Same desired state does not schedule another transition.
  const before = timers.length;
  visibility.request(true);
  assert.equal(timers.length, before);
  assert.equal(visibility.current, true);
});

test('scope-status 合并写盘：相同快照不重复，拖动场景可跳过强制写', () => {
  const writes = [];
  const timers = [];
  const status = createDebouncedDiskStatus({
    delayMs: 20,
    write: snapshot => writes.push(snapshot),
    setTimer: (fn, ms) => {
      const id = { fn, ms, cleared: false };
      timers.push(id);
      return id;
    },
    clearTimer: id => { id.cleared = true; }
  });
  status.publish({ hwnd: 1, active: true });
  status.publish({ hwnd: 1, active: true });
  status.publish({ hwnd: 1, active: false });
  assert.equal(writes.length, 0);
  timers.filter(item => !item.cleared).at(-1).fn();
  assert.deepEqual(writes, [{ hwnd: 1, active: false }]);
});

test('拖动中 clampBounds 不吸附边缘；松手 snapBounds 一次贴边', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const width = 200, height = 300;
  const near = { x: 5, y: 100, width, height };
  const clamped = clampBounds(area, near);
  assert.equal(clamped.placement.anchorX, null);
  assert.equal(clamped.bounds.x, 5);
  const snapped = snapBounds(area, near);
  assert.equal(snapped.placement.anchorX, 'left');
  assert.equal(snapped.bounds.x, 2);
  assert.ok(SNAP_DISTANCE >= 8);
});
