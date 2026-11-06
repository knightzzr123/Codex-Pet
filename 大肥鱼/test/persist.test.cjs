const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, createCoalescedWriter } = require('../src/persist.cjs');

test('writeJsonAtomic 使用临时文件再 rename，最终内容完整', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-atomic-'));
  const file = path.join(dir, 'settings.json');
  try {
    writeJsonAtomic(file, { a: 1, b: 'ok' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 'ok' });
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createCoalescedWriter 合并连续 schedule，flush 立刻落盘且只写最后一次', async () => {
  const writes = [];
  const timers = [];
  const writer = createCoalescedWriter({
    delayMs: 30,
    write: payload => writes.push(payload),
    setTimer: (fn, ms) => {
      const id = { fn, ms, cleared: false };
      timers.push(id);
      return id;
    },
    clearTimer: id => { id.cleared = true; }
  });
  writer.schedule({ n: 1 });
  writer.schedule({ n: 2 });
  writer.schedule({ n: 3 });
  assert.equal(writes.length, 0);
  assert.deepEqual(writer.pending, { n: 3 });
  assert.equal(timers.filter(item => !item.cleared).length, 1);
  writer.flush();
  assert.deepEqual(writes, [{ n: 3 }]);
  assert.equal(writer.pending, null);
  writer.schedule({ n: 4 });
  timers.filter(item => !item.cleared).at(-1).fn();
  assert.deepEqual(writes, [{ n: 3 }, { n: 4 }]);
});

test('flush 可在进程退出路径保留最近偏好（杀进程前落盘）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-flush-'));
  const file = path.join(dir, 'settings.json');
  try {
    const writer = createCoalescedWriter({
      delayMs: 60_000,
      write: snapshot => writeJsonAtomic(file, snapshot)
    });
    writer.schedule({ opacity: 0.8, bubbleOffsetX: 12 });
    assert.equal(fs.existsSync(file), false);
    writer.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { opacity: 0.8, bubbleOffsetX: 12 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
