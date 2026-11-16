const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkinLibrary } = require('../src/skins.cjs');
const {
  SkinPackLibrary, normalizeManifest, validateThumbnail, packCharacterId, parsePackCharacterId,
  findManifestDirectory
} = require('../src/skin-packs.cjs');
const { MANIFEST_VERSION } = require('../src/manifests.cjs');

function png(width, height, seed = 0) {
  const bytes = Buffer.alloc(48);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[40] = seed & 0xff;
  return bytes;
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-skin-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePack(root, { name = '测试皮肤包', characters, store = { version: 1 } } = {}) {
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  const manifest = {
    manifestVersion: MANIFEST_VERSION, name, version: '1.2.0', store,
    characters: characters.map(character => ({
      id: character.id, name: character.name,
      image: character.image, ...(character.thumbnail ? { thumbnail: character.thumbnail } : {})
    }))
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const character of characters) {
    fs.writeFileSync(path.join(directory, character.image), character.bytes || png(300, 300, character.seed || 0));
    if (character.thumbnail) fs.writeFileSync(path.join(directory, character.thumbnail), character.thumbnailBytes || png(128, 128, 3));
  }
  return directory;
}

test('manifest v1 接受多角色、缩略图与保留的 store.version', () => {
  const manifest = normalizeManifest({
    manifestVersion: 1, id: 'demo-pack', name: '示例', version: '2.0.0', store: { version: 1 },
    characters: [
      { id: 'whale', name: '鲸鱼娘', image: 'images/whale.png', thumbnail: 'thumbs/whale.png' },
      { id: 'rose', name: '玫瑰', image: 'images/rose.webp' }
    ]
  });
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.characters.length, 2);
  assert.equal(manifest.characters[0].thumbnail, 'thumbs/whale.png');
  assert.equal(manifest.characters[1].thumbnail, null);
  assert.deepEqual(manifest.store, { version: 1 });
  assert.equal(manifest.id, 'demo-pack');
});

test('manifest 拒绝缺版本、新版本、越界路径、重复角色与未知 store 版本', () => {
  const base = { manifestVersion: 1, name: 'x', characters: [{ id: 'a', name: 'A', image: 'a.png' }] };
  for (const bad of [
    { ...base, manifestVersion: undefined }, { ...base, manifestVersion: 2 },
    { ...base, characters: [{ id: 'a', name: 'A', image: '../a.png' }] },
    { ...base, characters: [{ id: 'a', name: 'A', image: '/etc/a.png' }] },
    { ...base, characters: [{ id: 'a', name: 'A', image: 'C:\\a.png' }] },
    { ...base, characters: [{ id: 'a', name: 'A', image: 'a.png' }, { id: 'a', name: 'B', image: 'b.png' }] },
    { ...base, store: { version: 2 } }, { ...base, characters: [] }
  ]) assert.throws(() => normalizeManifest(bad));
});

test('缩略图规格：正方形 64–256 像素，仅 PNG/JPG/WebP，且不超过 512 KB', () => {
  assert.deepEqual(validateThumbnail(png(128, 128)).width, 128);
  assert.throws(() => validateThumbnail(png(32, 32)), /64/);
  assert.throws(() => validateThumbnail(png(512, 512)), /256/);
  assert.throws(() => validateThumbnail(png(128, 64)), /正方形/);
  assert.throws(() => validateThumbnail(Buffer.concat([png(64, 64), Buffer.alloc(512 * 1024)])), /512 KB/);
  assert.throws(() => validateThumbnail(Buffer.from('GIF89a')), /PNG/);
});

test('导入多角色皮肤包、复制缩略图并可重复导入去重', async t => {
  const root = temporary(t);
  const source = writePack(root, {
    characters: [
      { id: 'whale', name: '鲸鱼娘', image: 'whale.png', thumbnail: 'whale-thumb.png' },
      { id: 'rose', name: '玫瑰', image: 'rose.png' }
    ]
  });
  const library = new SkinPackLibrary(root);
  const validated = [];
  const imported = await library.importDirectory(source, async (bytes, mime) => {
    validated.push(mime);
    assert.ok(bytes.length > 0);
  });
  assert.equal(imported.characters.length, 2);
  assert.equal(validated.length, 3); // 两张角色图 + 一张缩略图
  assert.equal(library.list().length, 1);
  assert.ok(fs.existsSync(imported.characters[0].file));
  assert.ok(fs.existsSync(imported.characters[0].thumbnailFile));
  assert.equal(imported.characters[1].thumbnailFile, null);
  assert.ok(fs.existsSync(path.join(imported.directory, 'manifest.json')));
  const installed = JSON.parse(fs.readFileSync(path.join(imported.directory, 'manifest.json'), 'utf8'));
  assert.equal(installed.manifestVersion, MANIFEST_VERSION);
  assert.equal(installed.characters[0].source.image, 'whale.png');

  const again = await library.importDirectory(source, async () => {});
  assert.equal(again.id, imported.id);
  assert.equal(library.list().length, 1);
});

test('坏图片或坏缩略图拒绝导入，索引和暂存目录都不留残留', async t => {
  const root = temporary(t);
  const source = writePack(root, {
    characters: [
      { id: 'bad', name: '坏图', image: 'bad.png', bytes: Buffer.from('not an image') }
    ]
  });
  const library = new SkinPackLibrary(root);
  await assert.rejects(() => library.importDirectory(source, async () => {}), /格式/);
  assert.equal(library.list().length, 0);
  assert.equal(fs.existsSync(library.indexFile), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.staging-')), []);

  const thumbSource = writePack(root, {
    characters: [{ id: 'thumb', name: '坏缩略图', image: 'ok.png', thumbnail: 'thumb.png', thumbnailBytes: png(20, 20) }]
  });
  await assert.rejects(() => library.importDirectory(thumbSource, async () => {}), /64/);
  assert.equal(library.list().length, 0);
});

test('索引写入失败时回滚已复制目录，旧皮肤包仍可用', async t => {
  const root = temporary(t);
  const first = writePack(root, { name: '旧包', characters: [{ id: 'old', name: '旧', image: 'old.png', seed: 1 }] });
  const second = writePack(root, { name: '新包', characters: [{ id: 'new', name: '新', image: 'new.png', seed: 2 }] });
  const library = new SkinPackLibrary(root);
  const installed = await library.importDirectory(first, async () => {});
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === library.indexFile) throw Object.assign(new Error('index locked'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(() => library.importDirectory(second, async () => {}), /index locked/);
  assert.deepEqual(new SkinPackLibrary(root).list().map(pack => pack.id), [installed.id]);
  const directories = fs.readdirSync(library.directory).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.deepEqual(directories, [installed.id]);
});

test('删除皮肤包只删除已登记的内容寻址目录，非法 ID 不触碰文件', async t => {
  const root = temporary(t);
  const source = writePack(root, { characters: [{ id: 'whale', name: '鲸鱼娘', image: 'whale.png' }] });
  const library = new SkinPackLibrary(root);
  const installed = await library.importDirectory(source, async () => {});
  for (const bad of ['../x', 'a'.repeat(64), null]) assert.equal(library.remove(bad), false);
  assert.ok(fs.existsSync(installed.directory));
  assert.equal(library.remove(installed.id), true);
  assert.equal(fs.existsSync(installed.directory), false);
  assert.equal(new SkinPackLibrary(root).list().length, 0);
});

test('兼容原有单张图片皮肤：skins 目录与皮肤包目录互不影响', async t => {
  const root = temporary(t);
  const image = path.join(root, 'legacy.png');
  fs.writeFileSync(image, png(300, 300, 7));
  const images = new SkinLibrary(root);
  const legacy = await images.import(image, async () => {});
  const packSource = writePack(root, { characters: [{ id: 'whale', name: '鲸鱼娘', image: 'whale.png' }] });
  const packs = new SkinPackLibrary(root);
  await packs.importDirectory(packSource, async () => {});
  assert.deepEqual(new SkinLibrary(root).list().map(skin => skin.id), [legacy.id]);
  assert.equal(new SkinPackLibrary(root).list().length, 1);
});


test('findManifestDirectory 对顶层符号链接给出 ZIP_SYMLINK', t => {
  const root = temporary(t);
  const directory = writePack(root, {
    name: '链接包',
    characters: [{ id: 'whale', name: '鲸鱼', image: 'whale.png' }]
  });
  const outside = fs.mkdtempSync(path.join(root, 'outside-'));
  fs.symlinkSync(outside, path.join(directory, 'linked'), 'dir');
  assert.throws(() => findManifestDirectory(directory),
    error => error.code === 'ZIP_SYMLINK' && /符号链接/.test(error.message));
});

test('findManifestDirectory 对符号链接的 manifest.json 给出 ZIP_SYMLINK', t => {
  const root = temporary(t);
  const wrapper = fs.mkdtempSync(path.join(root, 'wrapper-'));
  const real = path.join(root, 'real-manifest.json');
  fs.writeFileSync(real, JSON.stringify({ manifestVersion: MANIFEST_VERSION, name: '链接包', characters: [] }));
  fs.symlinkSync(real, path.join(wrapper, 'manifest.json'));
  assert.throws(() => findManifestDirectory(wrapper),
    error => error.code === 'ZIP_SYMLINK' && /符号链接/.test(error.message));
});

test('多角色选择链接可稳定解析，非法链接返回 null', () => {
  const id = packCharacterId('a'.repeat(64), 'whale');
  assert.equal(id, `pack:${'a'.repeat(64)}:whale`);
  assert.deepEqual(parsePackCharacterId(id), { packId: 'a'.repeat(64), characterId: 'whale' });
  assert.equal(parsePackCharacterId('default'), null);
  assert.equal(parsePackCharacterId(`pack:${'A'.repeat(64)}:whale`), null);
  assert.throws(() => packCharacterId('nope', 'whale'));
});

test('主进程接入皮肤包导入、同窗口多角色切换与单实例锁', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src', 'settings-preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8');
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /new SkinPackLibrary/);
  assert.match(main, /pet:import-skin-pack/);
  assert.match(main, /packCharacterId\(pack\.id, character\.id\)/);
  assert.match(main, /setSkin\(packCharacterId\(pack\.id, first\.id\)\)/);
  assert.match(main, /skin-pack:commit/);
  assert.match(fs.readFileSync(path.join(root, 'src', 'skin-pack-session.cjs'), 'utf8'), /importDirectory/);
  assert.equal((main.match(/new BrowserWindow/g) || []).length, 1);
  assert.match(html, /id="settings-import-pack"/);
  assert.match(html, /id="settings-import-zip"/);
  assert.match(html, /id="settings-zip-drop"/);
  assert.match(main, /extensions: \['zip', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'\]/);
  assert.match(preload, /importSkinPack/);
  assert.match(preload, /previewSkinPack/);
  assert.doesNotMatch(preload, /settings:preview-zip|settings:import-zip|settings:choose-zip/);
  assert.match(renderer, /settings-import-pack/);
  assert.match(renderer, /settings-zip-drop/);
});
