const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SkinLibrary } = require('../src/skins.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-skin-delete-'));
  const library = new SkinLibrary(root);
  t.after(() => {
    t.mock.restoreAll();
    // These folders contain only this test's files; no recursive deletion.
    for (const directory of [library.directory, root]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    }
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=', 'base64');
  const source = path.join(root, '原图.png');
  fs.writeFileSync(source, png);
  const first = await library.import(source, async () => {});
  const second = await library.importBytes(Buffer.concat([png, Buffer.from('second')]), '另一张皮肤', async () => {});
  return { library, root, source, first, second };
}

test('删除导入副本并保存结果，保留原图与其他皮肤', async t => {
  const { library, root, source, first, second } = await fixture(t);
  assert.equal(library.remove(first.id), true);
  assert.equal(fs.existsSync(first.file), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(second.file), true);
  assert.deepEqual(new SkinLibrary(root).list().map(skin => skin.id), [second.id]);
  assert.equal(library.remove(first.id), false);
});

test('内置名称、未知 ID 和路径不能选择删除文件', async t => {
  const { library, root, first } = await fixture(t);
  for (const id of ['default', 'rose', '../原图.png', 'a'.repeat(64), null]) assert.equal(library.remove(id), false);
  assert.ok(fs.existsSync(first.file));
  assert.equal(new SkinLibrary(root).list().length, 2);
});

test('写入列表失败时保留文件和原列表', async t => {
  const { library, root, first } = await fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === library.indexFile) throw Object.assign(new Error('index locked'), { code: 'EACCES' });
    return rename(from, to);
  });
  assert.throws(() => library.remove(first.id), /index locked/);
  assert.ok(fs.existsSync(first.file));
  assert.equal(library.list().length, 2);
  assert.equal(new SkinLibrary(root).list().length, 2);
});

test('图片被占用时回滚列表，皮肤仍可选择', async t => {
  const { library, root, first } = await fixture(t);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === first.file) throw Object.assign(new Error('image locked'), { code: 'EBUSY' });
    return unlink(file);
  });
  assert.throws(() => library.remove(first.id), /image locked/);
  assert.ok(library.get(first.id));
  assert.ok(new SkinLibrary(root).get(first.id));
});

test('已丢失的皮肤文件可移除残留记录', async t => {
  const { library, root, first, second } = await fixture(t);
  fs.unlinkSync(first.file);
  assert.equal(library.remove(first.id), true);
  assert.deepEqual(new SkinLibrary(root).entries.map(skin => skin.id), [second.id]);
});
