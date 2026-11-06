function createDebouncedShowHide({
  onShow,
  onHide,
  delayMs = 100,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof onShow !== 'function' || typeof onHide !== 'function') {
    throw new TypeError('onShow and onHide are required');
  }
  let timer = null;
  let pending = null;
  let current = null;
  let showCount = 0;
  let hideCount = 0;

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function apply(visible) {
    if (current === visible) return;
    current = visible;
    if (visible) {
      showCount += 1;
      onShow();
    } else {
      hideCount += 1;
      onHide();
    }
  }

  function request(visible) {
    const next = Boolean(visible);
    pending = next;
    if (current === next) {
      clear();
      return;
    }
    clear();
    timer = setTimer(() => {
      timer = null;
      if (pending === null) return;
      apply(pending);
    }, delayMs);
  }

  function flush() {
    clear();
    if (pending === null) return current;
    apply(pending);
    return current;
  }

  function reset() {
    clear();
    pending = null;
    current = null;
  }

  return {
    request,
    flush,
    reset,
    get pending() { return pending; },
    get current() { return current; },
    get showCount() { return showCount; },
    get hideCount() { return hideCount; },
    get delayMs() { return delayMs; }
  };
}

function createDebouncedDiskStatus({
  write,
  delayMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const writer = require('./persist.cjs').createCoalescedWriter({ write, delayMs, setTimer, clearTimer });
  let lastKey = null;
  return {
    publish(snapshot, { force = false } = {}) {
      const key = JSON.stringify(snapshot);
      if (!force && key === lastKey) return false;
      lastKey = key;
      writer.schedule(snapshot);
      return true;
    },
    flush() { return writer.flush(); },
    clear() { writer.clear(); lastKey = null; },
    get writes() { return writer.writes; },
    get pending() { return writer.pending; }
  };
}

module.exports = { createDebouncedShowHide, createDebouncedDiskStatus };
