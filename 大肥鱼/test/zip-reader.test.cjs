const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readZipBuffer, readZipFile, writeEntries, ZIP_LIMITS, ZipError } = require('../src/zip-reader.cjs');
const { SkinPackLibrary, sweepTransientDirs } = require('../src/skin-packs.cjs');

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const method = entry.method ?? 0;
    const raw = entry.data ?? Buffer.alloc(0);
    const stored = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const flags = entry.flags ?? (Buffer.isBuffer(entry.name) ? 0 : 0x800);
    const compressedSize = entry.compressedSize ?? stored.length;
    const uncompressedSize = entry.uncompressedSize ?? raw.length;
    const versionMadeBy = entry.versionMadeBy ?? 20;
    const externalAttributes = entry.externalAttributes ?? 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const localOffset = offset;
    locals.push(local, stored);
    offset += local.length + stored.length;
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
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

const GBK_ROLE_PNG = Buffer.from([189, 199, 201, 171, 46, 112, 110, 103]); // 角色.png

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('默认上限与皮肤包清单一致：64 条、单文件 20 MB、总量 200 MB、压缩比 100', () => {
  assert.equal(ZIP_LIMITS.maxEntries, 64);
  assert.equal(ZIP_LIMITS.maxEntryBytes, 20 * 1024 * 1024);
  assert.equal(ZIP_LIMITS.maxTotalBytes, 200 * 1024 * 1024);
  assert.equal(ZIP_LIMITS.maxRatio, 100);
});

test('合法 stored ZIP 保留 UTF-8 中文文件名', async () => {
  const entries = await readZipBuffer(buildZip([
    { name: '包装/角色.png', data: Buffer.from('png-bytes') },
    { name: '包装/manifest.json', data: Buffer.from('{}') }
  ]));
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['包装/manifest.json', '包装/角色.png']);
  assert.equal(entries.find(entry => entry.name.endsWith('角色.png')).bytes.toString(), 'png-bytes');
});

test('无 UTF-8 标志的 CP936 文件名按简体中文解码', async () => {
  const entries = await readZipBuffer(buildZip([
    { name: GBK_ROLE_PNG, flags: 0, data: Buffer.from('whale') }
  ]));
  assert.equal(entries[0].name, '角色.png');
  assert.equal(entries[0].bytes.toString(), 'whale');
});

test('无法识别的文件名编码直接拒绝，不生成乱码文件', async t => {
  const root = temporary(t);
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: Buffer.from([0xff, 0xff]), flags: 0, data: Buffer.from('x') }
  ])), /无法识别压缩包内的文件名编码/);
  assert.equal(fs.readdirSync(root).length, 0);
});

test('拒绝 ../、绝对路径和盘符', async () => {
  await assert.rejects(() => readZipBuffer(buildZip([{ name: '../evil.txt', data: Buffer.from('x') }])), /越界路径/);
  await assert.rejects(() => readZipBuffer(buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }])), /绝对路径/);
  await assert.rejects(() => readZipBuffer(buildZip([{ name: 'C:/Windows/evil.txt', data: Buffer.from('x') }])), /盘符/);
  await assert.rejects(() => readZipBuffer(buildZip([{ name: 'foo/../../evil.txt', data: Buffer.from('x') }])), /越界路径/);
});

test('拒绝符号链接条目', async () => {
  await assert.rejects(() => readZipBuffer(buildZip([{
    name: 'link.txt', data: Buffer.from('../outside'),
    versionMadeBy: (3 << 8) | 20, externalAttributes: Number(0o120777n << 16n)
  }])), /符号链接/);
});

test('拒绝加密条目和非 stored/deflate 压缩方法', async () => {
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: 'secret.txt', flags: 0x800 | 0x1, data: Buffer.from('nope') }
  ])), /加密/);
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: 'lzma.bin', method: 14, data: Buffer.from('nope') }
  ])), /stored/);
});

test('按实际解压字节拒绝超过 100:1 的压缩炸弹，不信任头里声明的未压缩大小', async () => {
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: 'bomb.bin', method: 8, data: Buffer.alloc(200 * 1024, 0), uncompressedSize: 10 }
  ])), /压缩比|大小/);
});

test('条目数、单文件和解压总量上限可拒绝异常包', async () => {
  const many = Array.from({ length: 65 }, (_value, index) => ({ name: `f${index}.txt`, data: Buffer.from('x') }));
  await assert.rejects(() => readZipBuffer(buildZip(many)), /64/);
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: 'big.bin', data: Buffer.alloc(80, 1) }
  ]), { limits: { maxEntryBytes: 32, maxTotalBytes: 200, maxEntries: 64, maxRatio: 100, maxArchiveBytes: 1000 } }), /大小|上限/);
  await assert.rejects(() => readZipBuffer(buildZip([
    { name: 'a.bin', data: Buffer.alloc(40, 1) },
    { name: 'b.bin', data: Buffer.alloc(40, 2) }
  ]), { limits: { maxEntryBytes: 100, maxTotalBytes: 50, maxEntries: 64, maxRatio: 100, maxArchiveBytes: 1000 } }), /总量/);
});

test('拒绝 ZIP64 定位头，普通文件内容里的字节不会被误判', async () => {
  const zip = buildZip([{ name: 'ok.txt', data: Buffer.from([0x50, 0x4b, 0x06, 0x06, 0x01, 0x00]) }]);
  const entries = await readZipBuffer(zip);
  assert.equal(entries[0].bytes[0], 0x50);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  const zipped64 = Buffer.concat([zip.subarray(0, eocd), locator, zip.subarray(eocd)]);
  await assert.rejects(() => readZipBuffer(zipped64), /ZIP64/);
});

test('解压写入临时目录时再次挡住越界路径和符号链接', async t => {
  const root = temporary(t);
  assert.throws(() => writeEntries(root, [{ name: '../evil.txt', bytes: Buffer.from('x') }]), /越界/);
  const link = path.join(root, 'link');
  fs.symlinkSync(root, link);
  assert.throws(() => writeEntries(root, [{ name: 'link/owned.txt', bytes: Buffer.from('x') }]), /符号链接/);
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
});

test('从文件读取时拒绝符号链接和非 ZIP', async t => {
  const root = temporary(t);
  const file = path.join(root, 'pack.zip');
  fs.writeFileSync(file, buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]));
  const read = await readZipFile(file);
  assert.equal(read[0].bytes.toString(), 'hi');
  const link = path.join(root, 'link.zip');
  fs.symlinkSync(file, link);
  await assert.rejects(() => readZipFile(link), (error) => error instanceof ZipError && /普通 ZIP/.test(error.message));
  fs.writeFileSync(path.join(root, 'nope.zip'), 'hello');
  await assert.rejects(() => readZipFile(path.join(root, 'nope.zip')), /不是有效的 ZIP/);
});

function png(width, height, seed = 1) {
  const bytes = Buffer.alloc(48);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[40] = seed & 0xff;
  return bytes;
}

function manifestZip({ prefix = '', image = '角色.png', flags } = {}) {
  const imageName = Buffer.from(`${prefix}${image}`);
  const manifestName = Buffer.from(`${prefix}manifest.json`);
  const manifest = Buffer.from(JSON.stringify({
    manifestVersion: 1, id: 'whale-pack', name: '鲸鱼包装', version: '1.0.0',
    characters: [{ id: 'whale', name: '鲸鱼娘', image: '角色.png', thumbnail: 'thumb.png' }]
  }));
  const entries = [
    { name: manifestName, data: manifest, flags: flags ?? 0x800 },
    { name: imageName, data: png(80, 80, 4), flags: flags ?? 0x800 },
    { name: Buffer.from(`${prefix}thumb.png`), data: png(64, 64, 2), flags: flags ?? 0x800 }
  ];
  return buildZip(entries);
}

test('ZIP 皮肤包可预览并导入，manifest 放在子目录时也能找到', async t => {
  const root = temporary(t);
  const zip = path.join(root, 'pack.zip');
  fs.writeFileSync(zip, manifestZip({ prefix: '外套/' }));
  const library = new SkinPackLibrary(root);
  const preview = await library.previewZip(zip);
  assert.equal(preview.name, '鲸鱼包装');
  assert.equal(preview.characters[0].name, '鲸鱼娘');
  assert.match(preview.characters[0].thumbnailUrl, /^data:image\/png;base64,/);
  assert.equal(preview.needsConfirm, false);
  assert.equal(library.list().length, 0);
  const imported = await library.importZip(zip, async () => {});
  assert.equal(imported.characters.length, 1);
  assert.equal(library.list().length, 1);
  assert.equal(fs.readdirSync(library.directory).some(name => name.startsWith('.unzip-')), false);
});

test('同一皮肤包 ID 未确认时不改动，确认后才导入', async t => {
  const root = temporary(t);
  const zip = path.join(root, 'pack.zip');
  fs.writeFileSync(zip, manifestZip());
  const library = new SkinPackLibrary(root);
  await library.importZip(zip, async () => {});
  await assert.rejects(() => library.importZip(zip, async () => {}), error => error.code === 'PACK_CONFIRM');
  assert.equal(library.list().length, 1);
  const again = await library.importZip(zip, async () => {}, { confirmSame: true });
  assert.equal(again.id, library.list()[0].id);
  assert.equal(library.list().length, 1);
});

test('CP936 文件名的 ZIP 能导入，坏 ZIP 留下的解压目录会在下次启动清掉', async t => {
  const root = temporary(t);
  const zip = path.join(root, 'gbk.zip');
  const prefix = Buffer.concat([Buffer.from([205, 226, 204, 215]), Buffer.from('/')]); // 外套/
  const image = Buffer.concat([prefix, Buffer.from([189, 199, 201, 171, 46, 112, 110, 103])]);
  fs.writeFileSync(zip, buildZip([
    { name: Buffer.concat([prefix, Buffer.from('manifest.json')]), flags: 0, data: Buffer.from(JSON.stringify({
      manifestVersion: 1, name: '中文包', characters: [{ id: 'whale', name: '鲸鱼娘', image: '角色.png' }]
    })) },
    { name: image, flags: 0, data: png(96, 96, 9) }
  ]));
  const library = new SkinPackLibrary(root);
  const imported = await library.importZip(zip, async () => {});
  assert.equal(imported.name, '中文包');
  const stale = path.join(library.directory, `.staging-1-${'a'.repeat(8)}`);
  const unzip = path.join(library.directory, `.unzip-1-${'b'.repeat(8)}`);
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'half.png'), 'partial');
  fs.mkdirSync(unzip);
  assert.deepEqual(sweepTransientDirs(library.directory).sort(), [path.basename(stale), path.basename(unzip)].sort());
  assert.equal(fs.existsSync(imported.directory), true);
  const restarted = new SkinPackLibrary(root);
  fs.mkdirSync(path.join(restarted.directory, '.staging-2-leftover'));
  const cleaned = new SkinPackLibrary(root);
  assert.equal(fs.existsSync(path.join(cleaned.directory, '.staging-2-leftover')), false);
  assert.equal(cleaned.list().length, 1);
});
