const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.mkdirSync(directory, { recursive: true });
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createCoalescedWriter({
  write,
  delayMs = 120,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write function required');
  let timer = null;
  let pending = null;
  let writes = 0;
  let lastError = null;

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function flush() {
    clear();
    if (pending === null) return false;
    const payload = pending;
    pending = null;
    try {
      write(payload);
      writes += 1;
      lastError = null;
    } catch (error) {
      lastError = error;
      throw error;
    }
    return true;
  }

  function schedule(payload) {
    pending = payload;
    clear();
    timer = setTimer(() => {
      timer = null;
      try { flush(); } catch {}
    }, delayMs);
  }

  return {
    schedule,
    flush,
    clear,
    get pending() { return pending; },
    get writes() { return writes; },
    get lastError() { return lastError; },
    get delayMs() { return delayMs; }
  };
}

module.exports = { writeJsonAtomic, createCoalescedWriter };
