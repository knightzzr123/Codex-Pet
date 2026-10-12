const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return; await wait(50); }
  throw new Error(message);
}
async function checkLifecycleRecovery({ win, monitor, getScope, isRendererReady, nativeWindowState }) {
  const originalPid = monitor.pid, originalSamples = monitor.samples;
  const owner = getScope().hwnd, bounds = win.getBounds();
  // Only interrupt this test pet's helper and renderer, never the user's Codex.
  process.kill(originalPid);
  await until(() => monitor.pid && monitor.pid !== originalPid && monitor.samples > originalSamples,
    '窗口绑定进程中断后未恢复');
  assert.equal(getScope().ownerBound, true);
  assert.equal(getScope().hwnd, owner);
  assert.equal(win.isVisible(), true);
  const afterBinding = await nativeWindowState('inspect');
  win.webContents.forcefullyCrashRenderer();
  await until(() => !isRendererReady(), '未触发测试 renderer 中断');
  await until(() => isRendererReady() && win.isVisible(), '人物页面中断后未重新显示');
  const state = await win.webContents.executeJavaScript('window.petAPI.getState()');
  assert.equal(Boolean(state.skin?.id), true);
  assert.deepEqual(win.getBounds(), bounds);
  const afterRenderer = await nativeWindowState('inspect');
  return { bindingRecovered: true, rendererRecovered: true, ownerPreserved: getScope().hwnd === owner,
    oldHelperPid: originalPid, newHelperPid: monitor.pid, afterBinding, afterRenderer };
}
module.exports = { checkLifecycleRecovery };
