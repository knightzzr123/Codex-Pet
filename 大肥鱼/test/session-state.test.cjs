const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSessionStateTracker, sessionPresentation, normalizeSessionState
} = require('../src/session-state.cjs');
const { createCodexSessionProbe } = require('../src/codex-session-probe.cjs');

test('会话态默认空闲、非法值回落为空闲', () => {
  assert.equal(normalizeSessionState('busy'), 'busy');
  assert.equal(normalizeSessionState('error'), 'error');
  assert.equal(normalizeSessionState('nope'), 'idle');
  assert.equal(sessionPresentation({ state: 'busy' }).label, '忙碌中');
  assert.equal(sessionPresentation({ state: 'error' }).state, 'error');
});

test('探测失败、通道不可用或探测抛错都降级为空闲且不抛出', () => {
  const started = 1000;
  const tracker = createSessionStateTracker({ now: () => started, probe: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => tracker.sample());
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.degraded, true);
  assert.match(snapshot.reason, /boom/);

  const unavailable = createSessionStateTracker({ now: () => started, probe: () => ({ state: 'busy', channel: 'unavailable' }) });
  unavailable.sample();
  snapshot = unavailable.snapshot();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.degraded, true);
});

test('忙碌超时回落空闲；报错优先于忙碌但会被后续活动覆盖', () => {
  let now = 1000;
  let sample = { state: 'busy', channel: 'rollout-mtime', activityAt: now - 100 };
  const tracker = createSessionStateTracker({ now: () => now, probe: () => sample, busyWindowMs: 1000 });
  tracker.sample();
  assert.equal(tracker.snapshot().state, 'busy');
  now += 5000; sample = { ...sample, activityAt: now - 5000 };
  tracker.sample();
  assert.equal(tracker.snapshot().state, 'idle');

  now = 20000;
  sample = { state: 'error', channel: 'rollout-mtime+logs-sqlite', activityAt: now - 9000, errorAt: now - 1000 };
  tracker.sample();
  assert.equal(tracker.snapshot().state, 'error');
  sample = { ...sample, state: 'error', activityAt: now - 100, errorAt: now - 5000 };
  tracker.sample();
  assert.equal(tracker.snapshot().state, 'busy');
});

test('首次报错即使时钟很小也触发一次气泡', () => {
  const tracker = createSessionStateTracker({ now: () => 1000,
    probe: () => ({ state: 'error', channel: 'logs-sqlite', errorAt: 900 }) });
  tracker.sample();
  assert.ok(tracker.snapshot().toastId >= 1);
});

test('报错气泡节流：首次出现一次，持续报错不会每 5 秒重复', () => {
  let now = 100000;
  const tracker = createSessionStateTracker({ now: () => now,
    probe: () => ({ state: 'error', channel: 'logs-sqlite', errorAt: now - 100 }), errorToastCooldownMs: 60000 });
  tracker.sample();
  const first = tracker.snapshot().toastId;
  assert.ok(first >= 1);
  now += 5000; tracker.sample();
  assert.equal(tracker.snapshot().toastId, first);
  now += 45000; tracker.sample();
  assert.equal(tracker.snapshot().toastId, first);
  now += 10000; tracker.sample();
  assert.equal(tracker.snapshot().toastId, first + 1);
});

test('真实只读探测：rollout 只取 mtime，近期活动为忙碌，过期为空闲', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-session-home-'));
  const directory = path.join(home, 'sessions', '2026', '11', '15');
  fs.mkdirSync(directory, { recursive: true });
  const rollout = path.join(directory, 'rollout-2026-11-15T22-00-00-demo.jsonl');
  fs.writeFileSync(rollout, '{"do":"not read"}\n');
  const now = Date.now();
  fs.utimesSync(rollout, now / 1000, now / 1000);
  try {
    const probe = createCodexSessionProbe({ home, now: () => now, sqliteLoader: () => null });
    const sample = probe.sample();
    assert.equal(sample.state, 'busy');
    assert.equal(sample.channel, 'rollout-mtime');
    assert.equal(sample.degraded, false);

    const stale = createCodexSessionProbe({ home, now: () => now + 60000, sqliteLoader: () => null });
    assert.equal(stale.sample().state, 'idle');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('真实只读探测：日志库只读查询 ts/level，错误状态可用；数据库异常不崩溃', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-session-log-'));
  fs.writeFileSync(path.join(home, 'logs_2.sqlite'), 'fixture');
  const now = 1000 * 1000;
  const fakeSqlite = { DatabaseSync: class {
    constructor() {}
    prepare() { return { get: () => ({ ts: 990 }) }; }
    close() {}
  } };
  try {
    const probe = createCodexSessionProbe({ home, now: () => now, sqliteLoader: () => fakeSqlite });
    const sample = probe.sample();
    assert.equal(sample.state, 'error');
    assert.match(sample.channel, /logs-sqlite/);
    assert.equal(sample.errorAt, 990000);

    const broken = createCodexSessionProbe({ home, now: () => now,
      sqliteLoader: () => ({ DatabaseSync: class { constructor() { throw new Error('locked'); } } }) });
    assert.doesNotThrow(() => broken.sample());
    assert.equal(broken.sample().degraded, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
