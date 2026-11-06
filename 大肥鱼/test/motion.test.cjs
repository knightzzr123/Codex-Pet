const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scaleForLevel } = require('../src/size.cjs');
const {
  MOTION, SNAP_MS, ZOOM_MS, motionProgress, interpolateZoom, interpolateBounds,
  settleDurationMs, createSettlePlayer
} = require('../src/motion.cjs');

function framesOf(durationMs, sample) {
  const frames = [];
  for (let elapsed = 16; elapsed < durationMs; elapsed += 16) {
    frames.push(sample(motionProgress(elapsed, durationMs)));
  }
  frames.push(sample(motionProgress(durationMs, durationMs)));
  return frames;
}

test('共享缓动令牌与样式一致：200ms / 320ms，cubic-bezier(.22, 1, .36, 1)', () => {
  assert.deepEqual([...MOTION.ease], [0.22, 1, 0.36, 1]);
  assert.equal(MOTION.micro, 200);
  assert.equal(MOTION.panel, 320);
  assert.equal(SNAP_MS, MOTION.panel);
  assert.equal(ZOOM_MS, MOTION.micro);
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
  assert.match(css, /--motion-ease:\s*cubic-bezier\(\.22,\s*1,\s*\.36,\s*1\)/);
  assert.match(css, /--motion-micro:\s*200ms/);
  assert.match(css, /--motion-panel:\s*320ms/);
  assert.equal(settleDurationMs({ boundsDiffer: true }), SNAP_MS);
  assert.equal(settleDurationMs({ zoomDiffer: true }), ZOOM_MS);
  assert.equal(settleDurationMs({ boundsDiffer: true, zoomDiffer: true }), Math.max(SNAP_MS, ZOOM_MS));
  assert.equal(settleDurationMs({ boundsDiffer: true, reduced: true }), 0);
  assert.equal(settleDurationMs({}), 0);
});

test('进度单调、不超调，减少动画立即为 1', () => {
  assert.equal(motionProgress(0, SNAP_MS), 0);
  assert.equal(motionProgress(SNAP_MS, SNAP_MS), 1);
  assert.equal(motionProgress(SNAP_MS + 50, SNAP_MS), 1);
  assert.equal(motionProgress(0, SNAP_MS, { reduced: true }), 1);
  assert.equal(motionProgress(10, 0), 1);
  let last = 0;
  for (let elapsed = 0; elapsed <= SNAP_MS; elapsed += 8) {
    const progress = motionProgress(elapsed, SNAP_MS);
    assert.ok(progress >= last - 1e-9);
    assert.ok(progress >= 0 && progress <= 1);
    last = progress;
  }
  assert.equal(last, 1);
  assert.ok(motionProgress(SNAP_MS / 2, SNAP_MS) > 0.5);
});

test('吸附缓动单调贴边且只落定一次，减少动画瞬时到位', () => {
  const from = { x: 30, y: 48, width: 200, height: 280 };
  const to = { x: 2, y: 2, width: 200, height: 280 };
  const frames = framesOf(SNAP_MS, progress => interpolateBounds(from, to, progress));
  assert.deepEqual(frames.at(-1), to);
  assert.notDeepEqual(frames[0], from);
  assert.notDeepEqual(frames[0], to);
  let previous = Math.hypot(from.x - to.x, from.y - to.y);
  for (const frame of frames) {
    assert.ok(frame.x >= to.x && frame.x <= from.x);
    assert.ok(frame.y >= to.y && frame.y <= from.y);
    assert.equal(frame.width, 200);
    assert.equal(frame.height, 280);
    const distance = Math.hypot(frame.x - to.x, frame.y - to.y);
    assert.ok(distance <= previous + 1e-6);
    previous = distance;
  }
  assert.equal(previous, 0);
  const arrived = frames.findIndex(frame => frame.x === to.x && frame.y === to.y);
  assert.ok(arrived > 0);
  assert.ok(frames.slice(arrived).every(frame => frame.x === to.x && frame.y === to.y));
  assert.deepEqual(interpolateBounds(from, to, motionProgress(0, SNAP_MS, { reduced: true })), to);
});

test('缩放系数在档位之间连续插值，终点精确等于目标档', () => {
  const from = scaleForLevel(4);
  const to = scaleForLevel(7);
  assert.equal(from, 0.8);
  assert.equal(to, 1.1);
  const frames = framesOf(ZOOM_MS, progress => interpolateZoom(from, to, progress));
  assert.equal(frames.at(-1), to);
  assert.ok(frames[0] > from && frames[0] < to);
  for (let index = 1; index < frames.length; index++) assert.ok(frames[index] >= frames[index - 1]);
  assert.ok(new Set(frames.map(value => value.toFixed(4))).size >= 4);
  const down = framesOf(ZOOM_MS, progress => interpolateZoom(scaleForLevel(10), scaleForLevel(2), progress));
  assert.equal(down.at(-1), scaleForLevel(2));
  assert.ok(down[0] < scaleForLevel(10) && down[0] > scaleForLevel(2));
  for (let index = 1; index < down.length; index++) assert.ok(down[index] <= down[index - 1]);
  assert.equal(interpolateZoom(from, to, motionProgress(1, ZOOM_MS, { reduced: true })), to);
});

test('播放器按帧推进且只完成一次，取消后不再落定', () => {
  let time = 0;
  const queue = [];
  const player = createSettlePlayer({
    now: () => time,
    schedule(fn) {
      const id = { fn, cleared: false, ran: false };
      queue.push(id);
      return id;
    },
    clear(id) { id.cleared = true; },
    frameMs: 16
  });
  const frames = [];
  let done = 0;
  player.play({
    durationMs: SNAP_MS,
    onFrame: progress => frames.push(progress),
    onDone: () => { done += 1; }
  });
  assert.equal(frames.length, 0);
  while (done === 0) {
    const job = queue.find(item => !item.cleared && !item.ran);
    assert.ok(job, 'settle timer stalled');
    job.ran = true;
    time += 16;
    job.fn();
    assert.ok(time < 2000);
  }
  assert.equal(done, 1);
  assert.equal(frames.at(-1), 1);
  for (let index = 1; index < frames.length; index++) assert.ok(frames[index] >= frames[index - 1]);
  assert.ok(frames.length > 4);

  time = 0;
  let doneAfterCancel = 0;
  const handle = player.play({
    durationMs: ZOOM_MS,
    onFrame() { throw new Error('cancelled settle should not frame'); },
    onDone: () => { doneAfterCancel += 1; }
  });
  handle.cancel();
  for (const job of queue) {
    if (!job.cleared && !job.ran) {
      job.ran = true;
      job.fn();
    }
  }
  assert.equal(doneAfterCancel, 0);

  const instant = [];
  player.play({
    durationMs: SNAP_MS,
    reduced: true,
    onFrame: progress => instant.push(progress),
    onDone: () => instant.push('done')
  });
  assert.deepEqual(instant, [1, 'done']);
});

test('main 松手吸附与换档缩放走共享缓动，减少动画时瞬时完成', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(source, /startSettle\(/);
  assert.match(source, /interpolateBounds/);
  assert.match(source, /interpolateZoom/);
  assert.match(source, /settleDurationMs/);
  assert.match(source, /motionReduced\(/);
  assert.match(source, /snapBounds\(/);
  assert.match(source, /clampBounds/);
  assert.match(source, /setZoomFactor/);
});
