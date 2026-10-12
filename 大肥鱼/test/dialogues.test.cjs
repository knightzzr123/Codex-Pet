const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DialogueLibrary, defaultDialogues, validateDialogues } = require('../src/dialogues.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-dialogue-test-'));
  t.after(() => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dafeiyu-dialogue-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test('默认台词保持原有 24 句与 3 句，副本修改不会改变默认内容', () => {
  const first = defaultDialogues(), second = defaultDialogues();
  assert.equal(first.speech.length, 24); assert.equal(first.sleepy.length, 3);
  first.speech.splice(0, 1); first.sleepy[0] = 'changed';
  assert.deepEqual(second, defaultDialogues());
});
test('修改、新增、删除与多语言多行台词保存后重新打开仍保留', t => {
  const dir = directory(t), library = new DialogueLibrary(dir);
  const draft = defaultDialogues();
  draft.speech[0] = '  主人，今天一起加油！\r\nHello, master 🐋  ';
  draft.speech.splice(1, 1); draft.speech.push('<img src=x onerror=alert(1)>');
  draft.sleepy.splice(0, 1);
  const saved = library.save(draft);
  assert.equal(saved.speech[0], '主人，今天一起加油！\nHello, master 🐋');
  assert.equal(saved.speech.at(-1), '<img src=x onerror=alert(1)>');
  assert.deepEqual(new DialogueLibrary(dir).load(), saved);
});
test('两类台词允许删空，重新加载不会把已删除台词恢复', t => {
  const dir = directory(t), library = new DialogueLibrary(dir), empty = { speech: [], sleepy: [] };
  library.save(empty); assert.deepEqual(new DialogueLibrary(dir).load(), empty);
});
test('超过数量、字数、行数或空白台词拒绝保存，保留旧文件', t => {
  const library = new DialogueLibrary(directory(t)); library.save(defaultDialogues());
  const before = fs.readFileSync(library.file, 'utf8');
  for (const bad of [null, {}, { speech: [''], sleepy: [] }, { speech: [14], sleepy: [] },
    { speech: ['鲸'.repeat(121)], sleepy: [] }, { speech: Array(101).fill('hello'), sleepy: [] },
    { speech: ['1\n2\n3\n4\n5'], sleepy: [] }, { speech: ['bad\u0000text'], sleepy: [] }]) {
    assert.throws(() => library.save(bad)); assert.equal(fs.readFileSync(library.file, 'utf8'), before);
  }
  assert.equal(validateDialogues({ speech: ['🐋'.repeat(120)], sleepy: [] }).speech[0], '🐋'.repeat(120));
});
test('磁盘提交失败时旧台词不丢失且清理临时文件', t => {
  const dir = directory(t), library = new DialogueLibrary(dir); library.save(defaultDialogues());
  const before = fs.readFileSync(library.file, 'utf8');
  const failing = new DialogueLibrary(dir, { ...fs, renameSync() { throw new Error('disk busy'); } });
  assert.throws(() => failing.save({ speech: ['changed'], sleepy: [] }), /disk busy/);
  assert.equal(fs.readFileSync(library.file, 'utf8'), before);
  assert.equal(fs.existsSync(library.file + '.tmp'), false);
});
test('文件缺失或损坏时使用默认台词，不自动覆盖原文件', t => {
  const library = new DialogueLibrary(directory(t)); assert.deepEqual(library.load(), defaultDialogues());
  fs.writeFileSync(library.file, 'broken'); assert.deepEqual(library.load(), defaultDialogues());
  assert.equal(fs.readFileSync(library.file, 'utf8'), 'broken');
});
