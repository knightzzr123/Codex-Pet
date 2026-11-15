const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  IDLE_BUDGET, sessionProbeDelay, pluginPollDelay, shouldSaveRuntime, rendererTickPlan
} = require('../src/idle-budget.js');

test('空闲预算写入常量：CPU <1%，无高频轮询', () => {
  assert.equal(IDLE_BUDGET.idleCpuPercentMax, 1);
  assert.equal(IDLE_BUDGET.rendererTickMs, 1000);
  assert.equal(IDLE_BUDGET.rendererPausesWhenHidden, true);
  assert.equal(IDLE_BUDGET.sessionProbeVisibleMs, 5000);
  assert.equal(IDLE_BUDGET.sessionProbeHiddenMs, 30000);
  assert.equal(IDLE_BUDGET.pluginPollMs, 3000);
  assert.equal(IDLE_BUDGET.runtimeSaveMs, 30000);
  assert.equal(IDLE_BUDGET.quotaRefreshMs, 120000);
  assert.equal(IDLE_BUDGET.scopeHeartbeatMs, 2000);
  assert.equal(sessionProbeDelay({ visible: true }), 5000);
  assert.equal(sessionProbeDelay({ visible: false }), 30000);
  assert.equal(pluginPollDelay(), 3000);
});

test('运行态元数据写入最多每 30 秒一次，避免每次轮询都写盘', () => {
  assert.equal(shouldSaveRuntime({ now: 29_999, lastSavedAt: 0 }), false);
  assert.equal(shouldSaveRuntime({ now: 30_000, lastSavedAt: 0 }), true);
  assert.equal(shouldSaveRuntime({ now: 50_000, lastSavedAt: 30_000 }), false);
  assert.equal(shouldSaveRuntime({ now: 60_000, lastSavedAt: 30_000 }), true);
});

test('渲染层空闲时跳过 DOM 工作，气泡/设置/加载/闲置动作到期时唤醒', () => {
  assert.deepEqual(rendererTickPlan({ hidden: true, bubbleOpen: true }), { wake: false, reason: 'hidden' });
  assert.deepEqual(rendererTickPlan({ bubbleOpen: true }), { wake: true, reason: 'bubble-open' });
  assert.deepEqual(rendererTickPlan({ settingsOpen: true }), { wake: true, reason: 'settings-open' });
  assert.deepEqual(rendererTickPlan({ loading: true }), { wake: true, reason: 'loading' });
  assert.deepEqual(rendererTickPlan({ now: 10_000, lastIdleAt: 5_000, idleIntervalMs: 45_000 }),
    { wake: false, reason: 'idle-skip' });
  assert.deepEqual(rendererTickPlan({ now: 50_000, lastIdleAt: 5_000, idleIntervalMs: 45_000 }),
    { wake: true, reason: 'idle-action' });
  // 5s is the floor so a very small configured interval cannot become a busy loop.
  assert.equal(rendererTickPlan({ now: 1_000, lastIdleAt: 0, idleIntervalMs: 1 }).reason, 'idle-skip');
});

test('主进程会话探测按可见性自适应，插件轮询降频且不再每秒写 runtime', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const monitor = fs.readFileSync(path.join(root, 'src', 'scope-monitor.cjs'), 'utf8');
  const diagnose = fs.readFileSync(path.join(root, 'tools', 'diagnose.cjs'), 'utf8');
  assert.match(main, /sessionProbeDelay\(\{ visible \}\)/);
  assert.match(main, /scheduleSessionProbe/);
  assert.match(main, /clearTimeout\(sessionTimer\)/);
  assert.match(main, /pluginPollDelay\(\)/);
  assert.match(main, /shouldSaveRuntime\(\{ now: Date\.now\(\), lastSavedAt: lastRuntimeSavedAt \}\)/);
  assert.match(main, /writeIdleBudgetSnapshot\('startup'\)/);
  assert.doesNotMatch(main, /sessionInterval/);
  assert.doesNotMatch(main, /\}, 1500\);/);
  assert.match(renderer, /rendererTickPlan/);
  assert.match(renderer, /idleTicksSkipped/);
  assert.match(renderer, /visibilitychange/);
  assert.match(renderer, /function startTicker/);
  assert.match(monitor, /heartbeatMs = 2000/);
  assert.match(diagnose, /idleBudget: IDLE_BUDGET/);
  assert.match(diagnose, /idle-budget\.json/);
});
