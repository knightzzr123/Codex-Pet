const test = require('node:test');
const assert = require('node:assert/strict');
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

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-skin-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePack(root, seed = 1, name = '会话包') {
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  const manifest = {
    manifestVersion: MANIFEST_VERSION, name, version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
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
    ...extras
  });
  return { library, session, advance: ms => { clock += ms; } };
}

function unzipNames(library) {
  return fs.readdirSync(library.directory).filter(name => name.startsWith('.unzip-'));
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

test('重复 commit', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const registered = session.register(writePack(root, 3, '第一次'), 1);
  assert.equal((await session.preview(registered.token, 1)).ok, true);
  const first = await session.commit(registered.token, 1, { acceptSameName: false });
  assert.equal(first.ok, true);
  assert.equal(library.list().length, 1);
  const second = await session.commit(registered.token, 1, { acceptSameName: true });
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
  const again = await session.preview(registered.token, 3);
  assert.equal(again.ok, true);
  assert.equal(again.name, preview.name);
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

test('PACK_CONFIRM 不写入，确认后不复制第二份', async t => {
  const root = temporary(t);
  const { library, session } = sessionFor(root);
  const directory = writePack(root, 7, '重复包');
  const first = session.register(directory, 1);
  assert.equal((await session.preview(first.token, 1)).ok, true);
  assert.equal((await session.commit(first.token, 1)).ok, true);
  const again = session.register(directory, 1);
  const preview = await session.preview(again.token, 1);
  assert.equal(preview.needsConfirm, true);
  const refused = await session.commit(again.token, 1, { acceptSameName: false });
  assert.equal(refused.code, 'PACK_CONFIRM');
  assert.equal(library.list().length, 1);
  const accepted = await session.commit(again.token, 1, { acceptSameName: true });
  assert.equal(accepted.ok, true);
  assert.equal(library.list().length, 1);
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
