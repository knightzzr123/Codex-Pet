// Session state is deliberately small and pure: a probe may fail or disappear
// at any time, and the pet must keep working as if Codex were idle.
const SESSION_STATES = Object.freeze(['idle', 'busy', 'error']);
const SESSION_TEXT = Object.freeze({
  idle: Object.freeze({ label: '空闲', line: '我在等你，随时可以开工～' }),
  busy: Object.freeze({ label: '忙碌中', line: '正在忙，稍等一下～' }),
  error: Object.freeze({ label: '出错了', line: '呜，Codex 刚刚报错了，先别急。' })
});

function normalizeSessionState(value) {
  return SESSION_STATES.includes(value) ? value : 'idle';
}

function sessionPresentation(snapshot = {}) {
  const state = normalizeSessionState(snapshot.state);
  const text = SESSION_TEXT[state];
  return {
    state,
    label: text.label,
    line: text.line,
    channel: typeof snapshot.channel === 'string' ? snapshot.channel : 'unavailable',
    degraded: snapshot.degraded === true,
    since: Number(snapshot.since) || 0,
    updatedAt: Number(snapshot.updatedAt) || 0,
    toastId: Number(snapshot.toastId) || 0,
    title: snapshot.degraded === true ? '状态探测不可用，按空闲显示' : `Codex 当前${text.label}`
  };
}

function createSessionStateTracker({
  probe = null, now = Date.now, busyWindowMs = 4500, errorWindowMs = 60000,
  errorToastCooldownMs = 60000, onUpdate = () => {}
} = {}) {
  const startedAt = now();
  let current = {
    state: 'idle', channel: 'unavailable', degraded: true, since: startedAt,
    updatedAt: startedAt, toastId: 0, activityAt: 0, errorAt: 0, reason: 'probe-unavailable'
  };
  let lastToastAt = 0;

  function sample() {
    const at = now();
    let raw = null;
    try {
      raw = typeof probe === 'function' ? probe() : null;
      if (raw && typeof raw.then === 'function') raw = null; // probes must never block the UI
    } catch (error) {
      raw = { state: 'idle', channel: 'unavailable', degraded: true, reason: String(error?.message || error) };
    }

    let state = normalizeSessionState(raw?.state);
    const channel = typeof raw?.channel === 'string' && raw.channel ? raw.channel : 'unavailable';
    const degraded = raw?.degraded === true || channel === 'unavailable';
    const activityAt = Number(raw?.activityAt) || 0;
    const errorAt = Number(raw?.errorAt) || 0;
    if (state === 'busy' && (!activityAt || at - activityAt > busyWindowMs)) state = 'idle';
    if (state === 'error' && (!errorAt || at - errorAt > errorWindowMs)) state = 'idle';
    if (state === 'error' && activityAt && at - activityAt <= busyWindowMs && activityAt > errorAt) state = 'busy';

    const changed = state !== current.state;
    let toast = false;
    if (state === 'error' && at - lastToastAt >= errorToastCooldownMs) {
      lastToastAt = at;
      toast = true;
    }
    const toastId = current.toastId + (toast ? 1 : 0);
    const next = {
      state, channel, degraded, since: changed ? at : current.since, updatedAt: at,
      toastId, activityAt, errorAt, reason: typeof raw?.reason === 'string' ? raw.reason : ''
    };
    current = next;
    if (changed || toast) {
      try { onUpdate({ ...next }); } catch {}
    }
    return changed || toast;
  }

  return {
    sample,
    snapshot: () => ({ ...current }),
    get state() { return current.state; }
  };
}

module.exports = {
  SESSION_STATES,
  SESSION_TEXT,
  normalizeSessionState,
  sessionPresentation,
  createSessionStateTracker
};
