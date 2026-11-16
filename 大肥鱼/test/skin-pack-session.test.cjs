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
