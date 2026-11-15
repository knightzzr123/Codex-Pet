// Shared idle-work budget. These values are the contract checked by tests and
// reported by `npm run diagnose`; the renderer and main process both use the
// same helper so the numbers cannot drift apart.
(function (root) {
  const IDLE_BUDGET = Object.freeze({
    // Measured target for the whole pet while Codex is idle and the pet window
    // is visible: <1% average CPU over a 60s sample.
    idleCpuPercentMax: 1,
    // Renderer still owns a 1s interval for bubble countdowns, but skips DOM
    // work when no bubble/settings/idle action is due and pauses while hidden.
    rendererTickMs: 1000,
    rendererPausesWhenHidden: true,
    // 4.5s busy window in session-state.cjs needs a <=5s visible cadence.
    sessionProbeVisibleMs: 5000,
    sessionProbeHiddenMs: 30000,
    // Plugin liveness does not need 1.5s polling; runtime.json is also written
    // at most once per 30s instead of on every poll.
    pluginPollMs: 3000,
    runtimeSaveMs: 30000,
    quotaRefreshMs: 120000,
    // Scope child watchdog checks for missing output every 2s (stale at 5s).
    scopeHeartbeatMs: 2000
  });

  function sessionProbeDelay({ visible = true } = {}) {
    return visible ? IDLE_BUDGET.sessionProbeVisibleMs : IDLE_BUDGET.sessionProbeHiddenMs;
  }

  function pluginPollDelay() {
    return IDLE_BUDGET.pluginPollMs;
  }

  function shouldSaveRuntime({ now = Date.now(), lastSavedAt = 0 } = {}) {
    return !Number.isFinite(lastSavedAt) || now - lastSavedAt >= IDLE_BUDGET.runtimeSaveMs;
  }

  function rendererTickPlan({
    now = Date.now(), bubbleOpen = false, settingsOpen = false, loading = false,
    lastIdleAt = now, idleIntervalMs = 45000, hidden = false
  } = {}) {
    if (hidden) return { wake: false, reason: 'hidden' };
    if (bubbleOpen) return { wake: true, reason: 'bubble-open' };
    if (settingsOpen) return { wake: true, reason: 'settings-open' };
    if (loading) return { wake: true, reason: 'loading' };
    const interval = Math.max(IDLE_BUDGET.sessionProbeVisibleMs, Number(idleIntervalMs) || 45000);
    if (now - Number(lastIdleAt) >= interval) return { wake: true, reason: 'idle-action' };
    return { wake: false, reason: 'idle-skip' };
  }

  const api = { IDLE_BUDGET, sessionProbeDelay, pluginPollDelay, shouldSaveRuntime, rendererTickPlan };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DafeiyuIdleBudget = api;
})(globalThis);
