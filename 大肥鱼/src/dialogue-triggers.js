// Pure dialogue trigger rules. The renderer only passes explicit triggers
// (`click` / `idle`) and never inspects typed text, clipboard or chat content,
// so there is deliberately no keyword matching and no privacy-sensitive input.
(function (root) {
  const TRIGGERS = Object.freeze(['click', 'idle']);
  const IDLE_COOLDOWN_MS = 5 * 60 * 1000;
  const IDLE_SUPPRESSED_STATES = Object.freeze(['busy', 'error']);
  const DEFAULT_IDLE_SECONDS = 45;
  const MIN_IDLE_MS = 5000;
  const HISTORY_LIMIT = 20;

  function normalizeLines(lines) {
    const source = Array.isArray(lines) ? lines : lines && Array.isArray(lines.speech) ? lines.speech : [];
    return source.filter(line => typeof line === 'string' && line.trim()).map(line => line.trim());
  }

  function nextLine(lines, index, previous) {
    const count = lines.length;
    for (let offset = 0; offset < count; offset += 1) {
      const candidate = (index + offset) % count;
      if (count === 1 || lines[candidate] !== previous) {
        return { text: lines[candidate], next: candidate + 1 };
      }
    }
    return null;
  }

  function createDialogueTrigger({
    now = Date.now,
    idleCooldownMs = IDLE_COOLDOWN_MS,
    clickCooldownMs = 0,
    historyLimit = HISTORY_LIMIT
  } = {}) {
    let clickIndex = 0;
    let idleIndex = 0;
    let lastText = '';
    let lastKind = '';
    let lastAt = -Infinity;
    let lastIdleAt = -Infinity;
    let lastUserAt = -Infinity;
    let history = [];

    function trigger(kind, context = {}) {
      const at = now();
      if (!TRIGGERS.includes(kind)) return { ok: false, reason: 'unknown-trigger', trigger: kind };
      const lines = normalizeLines(context.lines);
      if (!lines.length) return { ok: false, reason: 'empty', trigger: kind };

      if (kind === 'idle') {
        if (context.bubbleOpen) return { ok: false, reason: 'bubble-open', trigger: kind };
        const sessionState = context.sessionState || 'idle';
        if (IDLE_SUPPRESSED_STATES.includes(sessionState)) {
          return { ok: false, reason: `session-${sessionState}`, trigger: kind };
        }
        const seconds = Number(context.idleIntervalSec);
        const idleInterval = Math.max(MIN_IDLE_MS,
          (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_IDLE_SECONDS) * 1000);
        const interactionAt = Number(context.interactionAt);
        if (!Number.isFinite(interactionAt) || at - interactionAt < idleInterval) {
          return { ok: false, reason: 'not-idle-enough', trigger: kind };
        }
        if (at - lastIdleAt < idleCooldownMs) return { ok: false, reason: 'idle-cooldown', trigger: kind };
      } else if (at - lastAt < clickCooldownMs) {
        return { ok: false, reason: 'click-cooldown', trigger: kind };
      }

      const previous = lastText;
      const picked = kind === 'click'
        ? nextLine(lines, clickIndex, previous)
        : nextLine(lines, idleIndex, previous);
      if (!picked) return { ok: false, reason: 'duplicate', trigger: kind };
      if (kind === 'idle' && previous && picked.text === previous) {
        return { ok: false, reason: 'duplicate', trigger: kind };
      }
      if (kind === 'click') clickIndex = picked.next;
      else idleIndex = picked.next;

      lastText = picked.text;
      lastKind = kind;
      lastAt = at;
      if (kind === 'idle') lastIdleAt = at;
      else lastUserAt = at;
      history = history.concat({ text: picked.text, kind, at }).slice(-historyLimit);
      return { ok: true, trigger: kind, text: picked.text, at };
    }

    function reset() {
      clickIndex = 0;
      idleIndex = 0;
      lastText = '';
      lastKind = '';
      lastAt = -Infinity;
      lastIdleAt = -Infinity;
      lastUserAt = -Infinity;
      history = [];
    }

    return {
      trigger,
      reset,
      snapshot: () => ({
        clickIndex, idleIndex, lastText, lastKind, lastAt, lastIdleAt, lastUserAt,
        history: history.slice()
      })
    };
  }

  const api = {
    TRIGGERS, IDLE_COOLDOWN_MS, IDLE_SUPPRESSED_STATES, MIN_IDLE_MS,
    createDialogueTrigger, normalizeLines
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DafeiyuDialogueTriggers = api;
})(globalThis);
