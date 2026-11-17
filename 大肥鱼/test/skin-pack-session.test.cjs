const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { SkinPackLibrary } = require('../src/skin-packs.cjs');
const { MANIFEST_VERSION } = require('../src/manifests.cjs');
const { createSkinPackSession, TOKEN_TTL_MS, classifySkinPackPath } = require('../src/skin-pack-session.cjs');
const { userError } = require('../src/errors.cjs');

const DAMAGED_ARCHIVE = '压缩包已损坏或格式不受支持，请重新打包后再试。';

function png(seed = 1) {
  const bytes = Buffer.alloc(48);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(64, 20);
  bytes[40] = seed & 0xff;
  return bytes;
}

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = entry.data;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, raw);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// Flip one byte inside the stored data of a ZIP entry. The central directory
// still carries the original CRC, so reading the entry fails the CRC check.
function corruptEntryData(buffer, entryIndex = 0, byteIndex = 0) {
  let offset = 0;
  for (let index = 0; index <= entryIndex; index += 1) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (index === entryIndex) {
      buffer[dataStart + byteIndex] ^= 0xff;
      return buffer;
    }
    offset = dataStart + size;
  }
  throw new Error('entry index out of range');
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-skin-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePack(root, seed = 1, name = '会话包', options = {}) {
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    ...(options.id ? { id: options.id } : {}),
    name, version: '1.0.0',
    characters: options.characters || [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'whale.png'), png(seed));
  return directory;
}

function writeZip(root, seed = 4) {
  const file = path.join(root, `pack-${seed}.zip`);
  const manifest = Buffer.from(JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '压缩包', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
  }));
  fs.writeFileSync(file, buildZip([
    { name: 'manifest.json', data: manifest },
    { name: 'whale.png', data: png(seed) }
  ]));
  return file;
}

function sessionFor(root, extras = {}) {
  const library = new SkinPackLibrary(root);
  let clock = 1_000_000;
  const session = createSkinPackSession({
    library,
    now: () => clock,
    validateImage: async () => {},
    onDiagnostic: () => {},
    ...extras
  });
  return { library, session, advance: ms => { clock += ms; } };
}

function unzipNames(library) {
  if (!fs.existsSync(library.directory)) return [];
  return fs.readdirSync(library.directory).filter(name => name.startsWith('.unzip-'));
}

function directoryDigest(directory) {
  const digest = crypto.createHash('sha256');
  for (const name of fs.readdirSync(directory).sort()) {
    digest.update(name).update('\n').update(fs.readFileSync(path.join(directory, name)));
  }
  return digest.digest('hex');
}

test('未登记 token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-skin-session-'));
  try {
    const { session } = sessionFor(root);
    const missing = await session.preview('a'.repeat(32), 1);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'TOKEN_INVALID');
    const pathLike = await session.commit({ token: 'C:\\pack.zip' }.token, 1);
    assert.equal(pathLike.ok, false);
    assert.equal(pathLike.code, 'TOKEN_INVALID');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-preload.cjs'), 'utf8');
    assert.match(main, /skin-pack:preview/);
    assert.doesNotMatch(main, /settings:preview-zip|settings:import-zip|settings:choose-zip/);
    assert.match(preload, /getPathForFile/);
    assert.doesNotMatch(preload, /pathForFile\s*:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('过期 token', async t => {
  const root = temporary(t);
  const { library, session, advance } = sessionFor(root);
  const zip = writeZip(root, 8);
  const registered = session.register(zip, 7);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 7);
  assert.equal(preview.ok, true);
  assert.equal(unzipNames(library).length, 1);
  advance(TOKEN_TTL_MS);
  const expired = await session.preview(registered.token, 7);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'TOKEN_INVALID');
  assert.deepEqual(unzipNames(library), []);
});

test('跨 webContents 使用 token', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const registered = session.register(writePack(root, 2), 11);
  const foreign = await session.preview(registered.token, 12);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'TOKEN_INVALID');
  const owner = await session.preview(registered.token, 11);
  assert.equal(owner.ok, true);
  assert.equal(JSON.stringify(owner).includes(root), false);
});

test('并发 commit 第二次直接作废，不重复写入', async t => {
  const root = temporary(t);
  const library = new SkinPackLibrary(root);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const session = createSkinPackSession({
    library,
    validateImage: () => gate,
    now: () => 1_000_000
  });
  const registered = session.register(writePack(root, 12, '并发'), 1);
  assert.equal((await session.preview(registered.token, 1)).ok, true);
  const first = session.commit(registered.token, 1);
  const second = await session.commit(registered.token, 1);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'TOKEN_INVALID');
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(library.list().length, 1);
});

test('重复 commit', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const registered = session.register(writePack(root, 3, '第一次'), 1);
  assert.equal((await session.preview(registered.token, 1)).ok, true);
  const first = await session.commit(registered.token, 1);
  assert.equal(first.ok, true);
  assert.equal(library.list().length, 1);
  const second = await session.commit(registered.token, 1);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'TOKEN_INVALID');
  assert.equal(library.list().length, 1);
});

test('UNC 和设备路径', () => {
  for (const filePath of ['\\\\server\\share\\pack.zip', '//server/share/pack.zip', '\\\\?\\C:\\Temp\\pack.zip', '\\\\.\\C:\\Temp\\pack.zip']) {
    const rejected = classifySkinPackPath(filePath);
    assert.equal(rejected.ok, false, filePath);
    assert.equal(rejected.code, 'PATH_REJECTED', filePath);
  }
});

test('符号链接', t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const real = writePack(root, 5);
  const link = path.join(root, 'linked-pack');
  fs.symlinkSync(real, link, 'dir');
  const rejected = session.register(link, 1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'ZIP_SYMLINK');
  assert.equal(rejected.token, undefined);
});

test('根目录有真实 manifest 时，指向另一皮肤包的目录链接不影响导入', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const other = writePack(root, 56, '另一皮肤包', { id: 'other-pack' });
  const directory = writePack(root, 57, '主皮肤包', { id: 'main-pack' });
  fs.symlinkSync(other, path.join(directory, 'sibling-pack'), 'dir');
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true, registered.error);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.name, '主皮肤包');
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, true, committed.error);
  assert.equal(library.list().length, 1);
  assert.equal(library.list()[0].name, '主皮肤包');
});

test('preview 后目录被篡改', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 6, '会被改');
  const registered = session.register(directory, 3);
  const preview = await session.preview(registered.token, 3);
  assert.equal(preview.ok, true);
  assert.equal(JSON.stringify(preview).includes(directory), false);
  fs.writeFileSync(path.join(directory, 'whale.png'), png(99));
  const changed = await session.commit(registered.token, 3);
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'PACK_CHANGED');
  assert.match(changed.error, /重新选择/);
  const again = await session.preview(registered.token, 3);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'TOKEN_INVALID');
});

test('预览失败会作废 token 并清理临时目录', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const bad = path.join(root, 'broken.zip');
  const manifest = Buffer.from(JSON.stringify({
    manifestVersion: 1, name: '坏图', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'role.png' }]
  }));
  fs.writeFileSync(bad, buildZip([
    { name: 'manifest.json', data: manifest },
    { name: 'role.png', data: Buffer.from('not-a-png') }
  ]));
  const registered = session.register(bad, 4);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 4);
  assert.equal(preview.ok, false);
  assert.deepEqual(unzipNames(library), []);
  const again = await session.preview(registered.token, 4);
  assert.equal(again.code, 'TOKEN_INVALID');
  const kept = [];
  for (let index = 0; index < 4; index += 1) kept.push(session.register(writePack(root, 30 + index, `留${index}`), 4));
  assert.equal(kept.every(item => item.ok), true);
  assert.equal((await session.preview(kept[0].token, 4)).ok, true);
});

test('关窗后临时目录被清理', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const registered = session.register(writeZip(root, 9), 21);
  const first = await session.preview(registered.token, 21);
  const second = await session.preview(registered.token, 21);
  assert.equal(first.ok, true);
  assert.equal(second.name, first.name);
  assert.equal(unzipNames(library).length, 1);
  session.releaseSender(21);
  assert.deepEqual(unzipNames(library), []);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(main, /webContents\.once\('destroyed'/);
  assert.match(main, /skinPackSession\.releaseSender/);
  assert.match(main, /skinPackSession\.releaseAll\(\)/);
});

test('相同内容不重复导入，返回切换到它的目标且不自动切换', async t => {
  const root = temporary(t);
  const library = new SkinPackLibrary(root);
  const imported = [];
  const session = createSkinPackSession({
    library, validateImage: async () => {}, onImported: pack => imported.push(pack.id)
  });
  const first = session.register(writePack(root, 7, '重复包', { id: 'qa-pack' }), 1);
  assert.equal((await session.preview(first.token, 1)).ok, true);
  const installed = await session.commit(first.token, 1);
  assert.equal(installed.ok, true);
  assert.equal(installed.reused, false);
  assert.equal(imported.length, 1);
  const installedId = installed.pack.id;
  const directory = library.get(installedId).directory;
  const directoryBefore = directoryDigest(directory);
  const indexBefore = fs.readFileSync(library.indexFile, 'utf8');

  const again = session.register(writePack(root, 7, '重复包', { id: 'qa-pack' }), 1);
  const preview = await session.preview(again.token, 1);
  assert.equal(preview.ok, true);
  assert.equal(preview.reused, true);
  assert.equal(preview.installedName, '重复包');
  assert.equal(preview.duplicate.kind, 'content');
  assert.equal(preview.switchTo, `pack:${installedId}:whale`);
  const committed = await session.commit(again.token, 1);
  assert.equal(committed.ok, true);
  assert.equal(committed.reused, true);
  assert.equal(committed.renamed, false);
  assert.equal(committed.switchTo, `pack:${installedId}:whale`);
  // Z-5: the settings window words the result from the commit duplicate kind.
  assert.equal(committed.duplicate.kind, 'content');
  assert.equal(committed.duplicate.existingId, installedId);
  assert.equal(committed.duplicate.existingName, '重复包');
  assert.equal(committed.pack.id, installedId);
  assert.equal(library.list().length, 1);
  assert.equal(imported.length, 1, 'identical content must not switch the pet silently');
  assert.equal(directoryDigest(directory), directoryBefore);
  assert.equal(fs.readFileSync(library.indexFile, 'utf8'), indexBefore);
});

test('同 sourceId 或同名的不同内容另存为（2）（3），旧包原样保留', async t => {
  const root = temporary(t);
  const library = new SkinPackLibrary(root);
  const imported = [];
  const session = createSkinPackSession({
    library, validateImage: async () => {}, onImported: pack => imported.push(pack.id)
  });
  async function importPack(directory) {
    const registered = session.register(directory, 1);
    const preview = await session.preview(registered.token, 1);
    assert.equal(preview.ok, true, preview.error);
    const committed = await session.commit(registered.token, 1);
    assert.equal(committed.ok, true, committed.error);
    return { preview, committed };
  }

  const first = await importPack(writePack(root, 1, 'QA包装', { id: 'qa-pack' }));
  const oldId = first.committed.pack.id;
  const oldDirectory = library.get(oldId).directory;
  const oldDigest = directoryDigest(oldDirectory);
  assert.equal(first.committed.pack.name, 'QA包装');

  const second = await importPack(writePack(root, 2, 'QA包装', { id: 'qa-pack' }));
  assert.equal(second.preview.reused, false);
  assert.equal(second.preview.duplicate.kind, 'sourceId');
  assert.equal(second.preview.installedName, 'QA包装（2）');
  assert.equal(second.committed.renamed, true);
  assert.equal(second.committed.duplicate.kind, 'sourceId');
  assert.equal(second.committed.duplicate.existingId, oldId);
  assert.equal(second.committed.pack.name, 'QA包装（2）');
  assert.notEqual(second.committed.pack.id, oldId);
  assert.equal(library.list().length, 2);
  assert.equal(imported.length, 2);

  const third = await importPack(writePack(root, 3, 'QA包装', { id: 'qa-pack' }));
  assert.equal(third.preview.installedName, 'QA包装（3）');
  assert.equal(third.committed.pack.name, 'QA包装（3）');
  assert.equal(library.list().length, 3);

  const otherSource = await importPack(writePack(root, 4, 'QA包装', { id: 'other-pack' }));
  assert.equal(otherSource.preview.duplicate.kind, 'name');
  assert.equal(otherSource.preview.installedName, 'QA包装（4）');
  assert.equal(otherSource.committed.duplicate.kind, 'name');
  assert.equal(otherSource.committed.pack.name, 'QA包装（4）');
  assert.equal(library.list().length, 4);

  const old = library.get(oldId);
  assert.equal(old.name, 'QA包装');
  assert.equal(directoryDigest(old.directory), oldDigest);
  assert.deepEqual(library.list().map(pack => pack.name).sort(), ['QA包装', 'QA包装（2）', 'QA包装（3）', 'QA包装（4）']);
  assert.equal(unzipNames(library).length, 0);
});

test('超出 4 个有效 token 时淘汰最旧并清理临时目录', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const first = session.register(writeZip(root, 11), 1);
  assert.equal((await session.preview(first.token, 1)).ok, true);
  assert.equal(unzipNames(library).length, 1);
  for (let index = 0; index < 4; index += 1) {
    const registered = session.register(writePack(root, 20 + index, `包${index}`), 1);
    assert.equal(registered.ok, true);
  }
  assert.equal((await session.preview(first.token, 1)).code, 'TOKEN_INVALID');
  assert.deepEqual(unzipNames(library), []);
});

test('文件夹导入只快照 manifest 引用的文件，不复制超大或未引用文件', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 31, '只复制引用', { id: 'copy-pack' });
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'not referenced');
  const huge = path.join(directory, 'unused.bin');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, 210 * 1024 * 1024);
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, true, committed.error);
  const installed = library.list()[0];
  assert.ok(installed);
  assert.deepEqual(fs.readdirSync(installed.directory).sort(), ['c-0-whale.png', 'manifest.json']);
  assert.equal(fs.existsSync(path.join(installed.directory, 'unused.bin')), false);
  assert.equal(fs.existsSync(path.join(installed.directory, 'notes.txt')), false);
  assert.deepEqual(unzipNames(library), []);
});

test('文件夹导入在预览后出现符号链接时拒绝并清理快照', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 32, '链接包', { id: 'link-pack' });
  const image = path.join(directory, 'whale.png');
  const real = path.join(directory, 'real.png');
  const registered = session.register(directory, 1);
  assert.equal((await session.preview(registered.token, 1)).ok, true);
  fs.renameSync(image, real);
  fs.symlinkSync(real, image);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'ZIP_SYMLINK');
  assert.match(committed.error, /符号链接/);
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);
});

test('文件夹导入在预览后引用图片被换成指向包外的符号链接时拒绝为 ZIP_SYMLINK', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 45, '替换链接包', { id: 'replaced-link-pack' });
  const outside = path.join(root, 'outside-replaced.png');
  fs.writeFileSync(outside, png(46));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);

  // 预览后把引用图片换成指向包外的符号链接，再提交导入。
  const image = path.join(directory, 'whale.png');
  fs.renameSync(image, path.join(root, 'moved-inside.png'));
  fs.symlinkSync(outside, image, 'file');

  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'ZIP_SYMLINK');
  assert.match(committed.error, /符号链接|目录联接/);
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);

  // realpath 校验不能误伤普通文件：另一个正常皮肤包仍可读取并导入。
  const normal = writePack(root, 47, '正常读取包', { id: 'normal-read-pack' });
  const second = session.register(normal, 1);
  assert.equal((await session.preview(second.token, 1)).ok, true);
  const imported = await session.commit(second.token, 1);
  assert.equal(imported.ok, true, imported.error);
  assert.equal(library.list().length, 1);
  assert.deepEqual(unzipNames(library), []);
});

test('文件夹导入的单图 20 MB 上限仍然生效', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 33, '大图包', { id: 'big-pack' });
  fs.writeFileSync(path.join(directory, 'whale.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_LIMIT');
  assert.match(preview.error, /20 MB|大小/);
  assert.equal(library.list().length, 0);
});

test('未被 manifest 引用的符号链接不进入检查，预览和导入照常成功', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 34, '嵌套链接包', { id: 'nested-link-pack' });
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.symlinkSync(path.join(directory, 'whale.png'), path.join(directory, 'nested', 'link.png'));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, true, committed.error);
  assert.equal(library.list().length, 1);
  assert.deepEqual(unzipNames(library), []);
});

test('引用图片本身是符号链接时预览阶段就拒绝', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 35, '文件链接包', { id: 'file-link-pack' });
  const image = path.join(directory, 'whale.png');
  fs.renameSync(image, path.join(directory, 'real.png'));
  fs.symlinkSync(path.join(directory, 'real.png'), image);
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_SYMLINK');
  assert.match(preview.error, /符号链接|目录联接/);
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);
  // A failed preview consumes the token, so commit cannot reuse it.
  assert.equal((await session.commit(registered.token, 1)).code, 'TOKEN_INVALID');
});

test('引用路径的深层父目录是符号链接时预览阶段就拒绝', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const outside = path.join(root, 'outside-deep');
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'deep', 'whale.png'), png(36));
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '深层链接包', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'images/deep/whale.png' }]
  }));
  fs.mkdirSync(path.join(directory, 'images'));
  fs.symlinkSync(path.join(outside, 'deep'), path.join(directory, 'images', 'deep'), 'dir');
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_SYMLINK');
  assert.match(preview.error, /符号链接|目录联接/);
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);
});

test('manifest.json 本身是符号链接时预览阶段就拒绝', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 37, '清单链接包', { id: 'manifest-link-pack' });
  const manifest = path.join(directory, 'manifest.json');
  fs.renameSync(manifest, path.join(directory, 'real-manifest.json'));
  fs.symlinkSync(path.join(directory, 'real-manifest.json'), manifest);
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_SYMLINK');
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);
});

test('文件夹预览拒绝指向文件夹外的目录链接，不读取外部图片', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'whale.png'), png(41));
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '外链包', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'images/whale.png' }]
  }));
  fs.symlinkSync(outside, path.join(directory, 'images'), 'dir');
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_SYMLINK');
  assert.match(preview.error, /符号链接/);
  assert.equal(library.list().length, 0);
  assert.deepEqual(unzipNames(library), []);
});

test('无关子目录远超 256 个文件时预览和导入仍迅速成功，且不进入该目录', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 42, '大目录包', { id: 'many-entries' });
  const extra = path.join(directory, 'extra');
  fs.mkdirSync(extra);
  for (let index = 0; index < 5000; index += 1) {
    fs.writeFileSync(path.join(extra, `f-${index}.txt`), '');
  }
  const readdirCalls = [];
  const lstatCalls = [];
  const readdir = fs.readdirSync;
  const lstat = fs.lstatSync;
  const inside = target => {
    const resolved = path.resolve(String(target));
    return resolved === extra || resolved.startsWith(extra + path.sep);
  };
  t.mock.method(fs, 'readdirSync', function (target, ...args) { if (inside(target)) readdirCalls.push(path.resolve(String(target))); return readdir.call(fs, target, ...args); });
  t.mock.method(fs, 'lstatSync', function (target, ...args) { if (inside(target)) lstatCalls.push(path.resolve(String(target))); return lstat.call(fs, target, ...args); });
  const started = Date.now();
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, true, committed.error);
  assert.ok(Date.now() - started < 5000, '预览和导入不应遍历无关大目录');
  assert.deepEqual(readdirCalls, [], '无关目录不应被 readdir');
  // 找 manifest 时只允许对顶层候选目录本身及其 manifest.json 做存在性检查；
  // 目录里的 5000 个文件全部不进入、不 lstat。
  assert.deepEqual(lstatCalls.filter(call => call !== extra && !call.endsWith(`${path.sep}manifest.json`)), [],
    '无关目录里的文件不应被 lstat');
  assert.equal(library.list().length, 1);
  assert.deepEqual(unzipNames(library), []);
});

test('未引用的无权限子目录不影响预览和导入', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0
}, async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 44, '无权限包', { id: 'locked-pack' });
  // 顶层无权限目录：旧实现会在找 manifest 时 readdir 它并抛出未分类错误。
  const lockedTop = path.join(directory, 'locked-top');
  fs.mkdirSync(lockedTop);
  fs.writeFileSync(path.join(lockedTop, 'secret.txt'), 'x');
  // 更深一层的无权限目录：旧实现会整树遍历到这里。
  const lockedNested = path.join(directory, 'assets', 'locked-nested');
  fs.mkdirSync(lockedNested, { recursive: true });
  fs.writeFileSync(path.join(lockedNested, 'secret.png'), 'x');
  fs.chmodSync(lockedTop, 0o000);
  fs.chmodSync(lockedNested, 0o000);
  try {
    const registered = session.register(directory, 1);
    const preview = await session.preview(registered.token, 1);
    assert.equal(preview.ok, true, preview.error);
    const committed = await session.commit(registered.token, 1);
    assert.equal(committed.ok, true, committed.error);
    assert.equal(library.list().length, 1);
    assert.deepEqual(unzipNames(library), []);
  } finally {
    fs.chmodSync(lockedTop, 0o755);
    fs.chmodSync(lockedNested, 0o755);
  }
});

test('顶层无关符号链接不影响文件夹预览和导入', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 38, '顶层链接包', { id: 'outer-link-pack' });
  const outside = path.join(root, 'outside-unrelated');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'unrelated.png'), png(39));
  fs.symlinkSync(outside, path.join(directory, 'linked-unrelated'), 'dir');
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, true, committed.error);
  assert.equal(library.list().length, 1);
});

test('损坏的压缩包对用户只显示统一中文提示，技术细节写诊断日志', async t => {
  const root = temporary(t);
  const diagnostics = [];
  const { session } = sessionFor(root, { onDiagnostic: entry => diagnostics.push(entry) });
  const manifest = Buffer.from(JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '坏包', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
  }));
  const file = path.join(root, 'bad-crc.zip');
  fs.writeFileSync(file, corruptEntryData(buildZip([
    { name: 'manifest.json', data: manifest },
    { name: 'whale.png', data: png(40) }
  ]), 0));
  const registered = session.register(file, 1);
  assert.equal(registered.ok, true, registered.error);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_CRC');
  assert.equal(preview.error, '压缩包已损坏或格式不受支持，请重新打包后再试。');
  assert.ok(diagnostics.length >= 1);
  assert.equal(diagnostics[0].code, 'ZIP_CRC');
  assert.match(diagnostics[0].detail, /CRC/);
});

test('不是 ZIP 的文件同样只显示统一中文提示', async t => {
  const root = temporary(t);
  const diagnostics = [];
  const { session } = sessionFor(root, { onDiagnostic: entry => diagnostics.push(entry) });
  const file = path.join(root, 'not-a-zip.zip');
  fs.writeFileSync(file, 'plain text, not a zip');
  const registered = session.register(file, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_FORMAT');
  assert.equal(preview.error, '压缩包已损坏或格式不受支持，请重新打包后再试。');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'ZIP_FORMAT');
});

test('文件夹包缺少被引用图片时显示具体原因而不是压缩包损坏', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 50, '缺图包');
  fs.rmSync(path.join(directory, 'whale.png'));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.equal(preview.error, '皮肤包缺少文件：whale.png');
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('角色列表为空时显示具体原因而不是压缩包损坏', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '空角色包', version: '1.0.0', characters: []
  }));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.match(preview.error, /至少需要 1 个角色/);
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('manifestVersion=99 时显示具体原因而不是压缩包损坏', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 51, '新版本清单');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: 99, name: '新版本清单', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
  }));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.match(preview.error, /版本不支持/);
  assert.match(preview.error, /99/);
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('图片不是真图片时显示具体原因而不是压缩包损坏', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 52, '假图片包');
  fs.writeFileSync(path.join(directory, 'whale.png'), Buffer.from('still not a png'));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.match(preview.error, /图片格式不受支持/);
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('截断的 ZIP 仍只显示统一损坏文案，技术细节进诊断', async t => {
  const root = temporary(t);
  const diagnostics = [];
  const { session } = sessionFor(root, { onDiagnostic: entry => diagnostics.push(entry) });
  const file = writeZip(root, 53);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, original.subarray(0, original.length - 12));
  const registered = session.register(file, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_FORMAT');
  assert.equal(preview.error, DAMAGED_ARCHIVE);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'ZIP_FORMAT');
});

test('文件夹包缺少 manifest.json 时有独立文案', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'whale.png'), png(54));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_MANIFEST_MISSING');
  assert.match(preview.error, /没找到 manifest\.json/);
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('文件夹包有多份 manifest.json 时有独立文案', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 55, '多清单包');
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.copyFileSync(path.join(directory, 'manifest.json'), path.join(directory, 'nested', 'manifest.json'));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_MANIFEST_MULTIPLE');
  assert.match(preview.error, /多份 manifest\.json/);
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('引用文件所在目录无权限时给 ZIP_ACCESS 中文提示', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
}, async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '权限包', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'images/whale.png' }]
  }));
  const images = path.join(directory, 'images');
  fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'whale.png'), png(41));
  fs.chmodSync(images, 0o000);
  try {
    const registered = session.register(directory, 1);
    const preview = await session.preview(registered.token, 1);
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'ZIP_ACCESS');
    assert.match(preview.error, /没有权限读取皮肤包里的文件/);
    assert.equal(library.list().length, 0);
  } finally {
    fs.chmodSync(images, 0o755);
  }
});

test('文件夹总量超过 200 MB 时预览报 ZIP_LIMIT', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  const image = path.join(directory, 'whale.png');
  const fd = fs.openSync(image, 'w');
  fs.writeSync(fd, png(43), 0, 48, 0);
  fs.ftruncateSync(fd, 19 * 1024 * 1024);
  fs.closeSync(fd);
  const characters = Array.from({ length: 11 }, (_, index) => ({
    id: `c${index}`, name: `角色${index}`, image: 'whale.png'
  }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: MANIFEST_VERSION, name: '总量超限', version: '1.0.0', characters
  }));
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_LIMIT');
  assert.match(preview.error, /200 MB/);
  assert.match(preview.error, /请减小图片后再试/);
  assert.equal(library.list().length, 0);
});

test('中文路径且 ZIP 没有读权限时只显示中文，英文报错和路径不外泄', {
  // chmod is not meaningful for root and not honoured the same way on Windows.
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
}, async t => {
  const root = temporary(t);
  const folder = path.join(root, '张三-皮肤包');
  fs.mkdirSync(folder);
  const file = path.join(folder, '皮肤包.zip');
  fs.copyFileSync(writeZip(root, 60), file);
  fs.chmodSync(file, 0o000);
  const diagnostics = [];
  const { session } = sessionFor(root, { onDiagnostic: entry => diagnostics.push(entry) });
  try {
    const registered = session.register(file, 1);
    assert.equal(registered.ok, true, registered.error);
    const preview = await session.preview(registered.token, 1);
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'ZIP_ACCESS');
    assert.equal(preview.error, '没有权限读取皮肤包里的文件。');
    assert.doesNotMatch(preview.error, /EACCES|EISDIR|permission|denied|open/i);
    for (const fragment of [root, folder, '皮肤包.zip', '张三']) {
      assert.equal(preview.error.includes(fragment), false, `文案不应包含 ${fragment}`);
    }
    // The technical detail is not lost: it goes to the diagnostic log instead.
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'EACCES');
    assert.equal(diagnostics[0].syscall, 'open');
    assert.match(diagnostics[0].detail, /EACCES/);
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('注入的 fs 错误按 errno 归类并写诊断，不显示英文或路径', async t => {
  const root = temporary(t);
  const file = writeZip(root, 61);
  const cases = [
    { code: 'EACCES', errno: -13, syscall: 'open', expectCode: 'ZIP_ACCESS', expect: '没有权限读取皮肤包里的文件。' },
    { code: 'EPERM', errno: -1, syscall: 'open', expectCode: 'ZIP_ACCESS', expect: '没有权限读取皮肤包里的文件。' },
    { code: 'EBUSY', errno: -16, syscall: 'open', expectCode: 'ZIP_ACCESS', expect: '文件被占用或没有权限读取，请稍后重试。' },
    { code: 'ENOSPC', errno: -28, syscall: 'write', expectCode: 'ZIP_ACCESS', expect: '无法读取或保存皮肤包，请确认文件能打开，且磁盘有空间。' }
  ];
  for (const item of cases) {
    const diagnostics = [];
    const library = {
      directory: path.join(root, 'data'),
      inspectZipFile: async () => {
        throw Object.assign(new Error(`${item.code}: operation failed, open '/tmp/张三/皮肤包.zip'`), {
          code: item.code, errno: item.errno, syscall: item.syscall, path: '/tmp/张三/皮肤包.zip'
        });
      }
    };
    const session = createSkinPackSession({ library, onDiagnostic: entry => diagnostics.push(entry) });
    const registered = session.register(file, 1);
    assert.equal(registered.ok, true, registered.error);
    const preview = await session.preview(registered.token, 1);
    assert.equal(preview.ok, false, item.code);
    assert.equal(preview.code, item.expectCode, item.code);
    assert.equal(preview.error, item.expect, item.code);
    assert.doesNotMatch(preview.error, new RegExp(item.code));
    assert.equal(preview.error.includes('张三'), false, item.code);
    assert.equal(diagnostics.length, 1, item.code);
    assert.equal(diagnostics[0].code, item.code);
    assert.equal(diagnostics[0].event, 'skin-pack-error', item.code);
    assert.equal(diagnostics[0].syscall, item.syscall);
    assert.match(diagnostics[0].detail, new RegExp(item.code));
  }
});

test('登记后 ZIP 被删除时提示文件不存在，而不是权限问题', async t => {
  const root = temporary(t);
  const file = writeZip(root, 62);
  const { session } = sessionFor(root);
  const registered = session.register(file, 1);
  assert.equal(registered.ok, true, registered.error);
  fs.rmSync(file);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.equal(preview.error, '文件不存在，请重新选择皮肤包文件。');
  assert.doesNotMatch(preview.error, /ENOENT|no such file/i);
  assert.equal(preview.error.includes(root), false);
});

test('登记后 ZIP 被换成文件夹时显示「只能导入普通 ZIP 文件。」', async t => {
  const root = temporary(t);
  const file = writeZip(root, 63);
  const { session } = sessionFor(root);
  const registered = session.register(file, 1);
  assert.equal(registered.ok, true, registered.error);
  fs.rmSync(file);
  fs.mkdirSync(file);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'ZIP_UNSUPPORTED');
  assert.equal(preview.error, '只能导入普通 ZIP 文件。');
  assert.notEqual(preview.error, DAMAGED_ARCHIVE);
});

test('未标记的回调抛 EACCES 时仍按 errno 给 ZIP_ACCESS 并写诊断，不显示英文或路径', async t => {
  const root = temporary(t);
  const diagnostics = [];
  const { session } = sessionFor(root, {
    onDiagnostic: entry => diagnostics.push(entry),
    validateImage: async () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/tmp/张三/角色.png'"), {
        code: 'EACCES', errno: -13, syscall: 'open', path: '/tmp/张三/角色.png'
      });
    }
  });
  const file = writeZip(root, 65);
  const registered = session.register(file, 1);
  assert.equal(registered.ok, true, registered.error);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'ZIP_ACCESS');
  assert.equal(committed.error, '没有权限读取皮肤包里的文件。');
  assert.doesNotMatch(committed.error, /EACCES|permission|denied/i);
  assert.equal(committed.error.includes('张三'), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'EACCES');
  assert.match(diagnostics[0].detail, /EACCES/);
});

test('validateImage 抛 userError 时 commit 原样返回该文案', async t => {
  const root = temporary(t);
  const message = '这张图片无法显示，可能已损坏。请换一张图片。';
  const diagnostics = [];
  const { session } = sessionFor(root, {
    onDiagnostic: entry => diagnostics.push(entry),
    validateImage: async () => { throw userError(message); }
  });
  const registered = session.register(writePack(root, 70, '解码失败包'), 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, true, preview.error);
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'PACK_INVALID');
  assert.equal(committed.error, message);
  assert.equal(diagnostics.length, 0);
});

test('commit 写数据目录遇到 ENOENT 报通用 IO 文案，而不是「文件夹不存在」', async t => {
  const root = temporary(t);
  const diagnostics = [];
  const { session } = sessionFor(root, { onDiagnostic: entry => diagnostics.push(entry) });
  const registered = session.register(writeZip(root, 71), 1);
  assert.equal((await session.preview(registered.token, 1)).ok, true);
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    const target = String(file);
    if (target.includes(`${path.sep}.staging-`)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), {
        code: 'ENOENT', errno: -2, syscall: 'open', path: target
      });
    }
    return writeFile.call(fs, file, ...args);
  });
  const committed = await session.commit(registered.token, 1);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'ZIP_ACCESS');
  assert.equal(committed.error, '无法读取或保存皮肤包，请确认文件能打开，且磁盘有空间。');
  assert.doesNotMatch(committed.error, /文件夹不存在|重新选择/);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'ENOENT');
  assert.match(diagnostics[0].detail, /ENOENT/);
});

test('main.cjs 的图片解码失败改用 userError，提交阶段能给出具体原因', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(main, /throw userError\('这张图片无法显示，可能已损坏。请换一张图片。'\);/);
});

test('会话层导入链路不再直接抛出普通中文 Error（skins.cjs 单图导入除外）', () => {
  for (const name of ['skin-pack-session.cjs', 'skin-packs.cjs', 'manifests.cjs', 'zip-reader.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    assert.doesNotMatch(source, /new Error\([^)]*[\u4e00-\u9fff]/u, name);
  }
});

test('文件夹包的 manifest 不是合法 JSON 时与 ZIP 包显示同一具体原因', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 72, '坏 JSON 包');
  fs.writeFileSync(path.join(directory, 'manifest.json'), '{bad json');
  const registered = session.register(directory, 1);
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.equal(preview.error, 'manifest.json 无法解析或已损坏。');
  assert.notEqual(preview.error, '这个皮肤包不符合导入要求，请检查后重试。');

  // The ZIP path parses manifest bytes directly; both routes must read alike.
  const zip = path.join(root, 'bad-json.zip');
  fs.writeFileSync(zip, buildZip([
    { name: 'manifest.json', data: Buffer.from('{bad json') },
    { name: 'whale.png', data: png(72) }
  ]));
  const zipped = session.register(zip, 1);
  const zipPreview = await session.preview(zipped.token, 1);
  assert.equal(zipPreview.ok, false);
  assert.equal(zipPreview.code, 'PACK_INVALID');
  assert.equal(zipPreview.error, preview.error);
});

test('登记后文件夹被删除时预览提示「文件夹不存在」，而不是权限问题', async t => {
  const root = temporary(t);
  const { session } = sessionFor(root);
  const directory = writePack(root, 73, '会消失的包');
  const registered = session.register(directory, 1);
  assert.equal(registered.ok, true, registered.error);
  fs.rmSync(directory, { recursive: true, force: true });
  const preview = await session.preview(registered.token, 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'PACK_INVALID');
  assert.equal(preview.error, '文件夹不存在，请重新选择皮肤包文件夹。');
  assert.doesNotMatch(preview.error, /权限/);
});

test('登记时 lstat 报 EACCES 报 ZIP_ACCESS，而不是「只能导入 .zip 或皮肤包文件夹」', t => {
  t.mock.method(fs, 'lstatSync', () => {
    throw Object.assign(new Error('EACCES: permission denied, lstat'), {
      code: 'EACCES', errno: -13, syscall: 'lstat'
    });
  });
  const result = classifySkinPackPath(path.join(os.tmpdir(), 'locked-skin-pack'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZIP_ACCESS');
  assert.equal(result.error, '没有权限读取皮肤包里的文件。');
  assert.doesNotMatch(result.error, /只能导入/);
});

test('main.cjs 把皮肤包会话诊断接到生命周期日志（D-C4-LOG）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const start = main.indexOf('const skinPackSession = createSkinPackSession({');
  assert.ok(start > 0, '缺少会话创建');
  const block = main.slice(start, main.indexOf('const dialogueLibrary', start));
  assert.match(block, /onDiagnostic\(entry\)/);
  assert.match(block, /event: 'skin-pack-error'/);
  assert.match(block, /logLifecycle\(/);
  assert.match(block, /code: entry\?\.code/);
  assert.match(block, /detail: entry\?\.detail/);
});
