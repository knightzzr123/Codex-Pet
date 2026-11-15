#!/usr/bin/env node
// Generate malicious / abnormal ZIP fixtures for Codex-Pet V1.4 skin-pack import QA.
// This script only writes files under its output directory. It does not import or execute them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function png(width = 80, height = 80, seed = 1) {
  const bytes = Buffer.alloc(48);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[40] = seed & 0xff;
  return bytes;
}

function validManifest(extra = {}) {
  return Buffer.from(JSON.stringify({
    manifestVersion: 1,
    id: extra.id || 'qa-pack',
    name: extra.name || 'QA包装',
    version: extra.version || '1.0.0',
    characters: extra.characters || [{ id: 'whale', name: '鲸鱼娘', image: extra.image || 'role.png' }]
  }));
}

function encodeName(name) {
  return Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const centralName = encodeName(entry.centralName ?? entry.name);
    const localName = encodeName(entry.localName ?? entry.name);
    const method = entry.method ?? 0;
    const raw = entry.data ?? Buffer.alloc(0);
    const stored = entry.compressedData ?? (method === 8 ? zlib.deflateRawSync(raw) : raw);
    const flags = entry.flags ?? 0x800;
    const versionMadeBy = entry.versionMadeBy ?? 20;
    const externalAttributes = entry.externalAttributes ?? 0;
    const localCrc = entry.localCrc ?? entry.crc ?? crc32(raw);
    const centralCrc = entry.centralCrc ?? entry.crc ?? crc32(raw);
    const localComp = entry.localCompressedSize ?? entry.compressedSize ?? stored.length;
    const localUncomp = entry.localUncompressedSize ?? entry.uncompressedSize ?? raw.length;
    const centralComp = entry.centralCompressedSize ?? entry.compressedSize ?? stored.length;
    const centralUncomp = entry.centralUncompressedSize ?? entry.uncompressedSize ?? raw.length;
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30 + localName.length + localExtra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(localCrc, 14);
    local.writeUInt32LE(localComp, 18);
    local.writeUInt32LE(localUncomp, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localName.copy(local, 30);
    if (localExtra.length) localExtra.copy(local, 30 + localName.length);

    const localOffset = offset;
    locals.push(local, stored);
    offset += local.length + stored.length;

    const central = Buffer.alloc(46 + centralName.length + centralExtra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(centralCrc, 16);
    central.writeUInt32LE(centralComp, 20);
    central.writeUInt32LE(centralUncomp, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(entry.localOffset ?? localOffset, 42);
    centralName.copy(central, 46);
    if (centralExtra.length) centralExtra.copy(central, 46 + centralName.length);
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

const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'fixtures'));
fs.mkdirSync(outDir, { recursive: true });

const catalog = [];
function writeFixture(id, fileName, zip, note) {
  const dest = path.join(outDir, fileName);
  fs.writeFileSync(dest, zip);
  catalog.push({ id, file: fileName, bytes: zip.length, note });
  console.log(`${fileName}\t${zip.length} B\t${note}`);
}

const image = png(80, 80, 4);
const manifest = validManifest();

writeFixture('CTRL', '00-valid-pack.zip', buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'role.png', data: image }
]), '合法对照：manifest v1 + 一张 PNG');

writeFixture('Z2-TRAVERSAL', '01-path-traversal.zip', buildZip([
  { name: '../evil.png', data: image },
  { name: 'manifest.json', data: manifest }
]), '路径穿越 ../evil.png');

writeFixture('Z2-TRAVERSAL-NESTED', '02-path-traversal-nested.zip', buildZip([
  { name: 'pack/foo/../../outside.png', data: image },
  { name: 'manifest.json', data: manifest }
]), '嵌套路径穿越 pack/foo/../../outside.png');

writeFixture('Z2-ABSOLUTE', '03-absolute-unix.zip', buildZip([
  { name: '/tmp/evil.png', data: image },
  { name: 'manifest.json', data: manifest }
]), 'Unix 绝对路径');

writeFixture('Z2-DRIVE', '04-absolute-drive.zip', buildZip([
  { name: 'C:/Windows/evil.png', data: image },
  { name: 'manifest.json', data: manifest }
]), 'Windows 盘符绝对路径');

writeFixture('B1-CON', '05-reserved-CON.zip', buildZip([
  { name: 'manifest.json', data: validManifest({ image: 'CON.png' }) },
  { name: 'CON.png', data: image }
]), 'Windows 保留名 CON.png');

writeFixture('B1-NUL', '06-reserved-NUL.zip', buildZip([
  { name: 'NUL/manifest.json', data: manifest },
  { name: 'NUL/role.png', data: image }
]), 'Windows 保留名目录 NUL/');

writeFixture('B1-COM1', '07-reserved-COM1.zip', buildZip([
  { name: 'manifest.json', data: validManifest({ image: 'COM1.png' }) },
  { name: 'COM1.png', data: image }
]), 'Windows 保留名 COM1.png');

writeFixture('B1-LPT1', '08-reserved-LPT1.zip', buildZip([
  { name: 'manifest.json', data: validManifest({ image: 'LPT1.png' }) },
  { name: 'LPT1.png', data: image }
]), 'Windows 保留名 LPT1.png');

writeFixture('B1-TRAILING-DOT', '09-trailing-dot.zip', buildZip([
  { name: 'manifest.json', data: validManifest({ image: 'role.png.' }) },
  { name: 'role.png.', data: image }
]), '文件名尾随点 role.png.');

writeFixture('B1-TRAILING-SPACE', '10-trailing-space.zip', buildZip([
  { name: 'manifest.json', data: validManifest({ image: 'role.png ' }) },
  { name: 'role.png ', data: image }
]), '文件名尾随空格 role.png[space]');

writeFixture('Z2-SYMLINK', '11-symlink.zip', buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'role.png', data: image },
  {
    name: 'link.png',
    data: Buffer.from('../outside.png'),
    versionMadeBy: (3 << 8) | 20,
    externalAttributes: Number(0o120777n << 16n)
  }
]), '符号链接条目（Unix mode S_IFLNK）');

writeFixture('B2-DEEP-FS', '12-deep-fs-manifest.zip', buildZip([
  { name: `${'nest/'.repeat(80)}manifest.json`, data: manifest },
  { name: `${'nest/'.repeat(80)}role.png`, data: image }
]), '文件系统深度 80 层后放置 manifest.json');

const deepJson = '{"a":'.repeat(2500) + '1' + '}'.repeat(2500);
writeFixture('B2-DEEP-JSON', '13-deep-json-manifest.zip', buildZip([
  { name: 'manifest.json', data: Buffer.from(deepJson) },
  { name: 'role.png', data: image }
]), 'manifest.json 为 2500 层嵌套 JSON（探测解析深度限制）');

writeFixture('B3-BAD-CRC', '14-bad-crc32.zip', buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'role.png', data: image, crc: 0xdeadbeef, localCrc: 0xdeadbeef, centralCrc: 0xdeadbeef }
]), 'PNG 条目 CRC32 故意写成 0xDEADBEEF，内容本身可解压');

writeFixture('B4-NAME-MISMATCH', '15-local-central-name-mismatch.zip', buildZip([
  { name: 'role.png', localName: 'role.png', centralName: 'other.png', data: image },
  { name: 'manifest.json', data: manifest }
]), '本地头文件名与中央目录文件名不一致');

writeFixture('B4-SIZE-MISMATCH', '16-local-central-size-mismatch.zip', buildZip([
  {
    name: 'role.png',
    data: image,
    localUncompressedSize: 3,
    centralUncompressedSize: image.length
  },
  { name: 'manifest.json', data: manifest }
]), '本地头与中央目录声明的未压缩大小不一致');

writeFixture('B4-EMPTY-SEGMENTS', '17-empty-segments.zip', buildZip([
  { name: 'pack//role.png', data: image },
  { name: 'pack//manifest.json', data: validManifest({ image: 'role.png' }) }
]), '空路径段 pack//role.png 与 pack//manifest.json');

const bombRaw = Buffer.alloc(300 * 1024, 0);
writeFixture('Z3-BOMB', '18-zip-bomb-ratio.zip', buildZip([
  { name: 'bomb.png', method: 8, data: bombRaw }
]), 'deflate 压缩炸弹（约 300 KiB 零字节的 PNG 条目，压缩比超过 100:1）');

writeFixture('B4-OVERLAP', '21-data-overlap.zip', buildZip([
  { name: 'role.png', data: image },
  { name: 'other.png', data: image, localOffset: 0 }
]), '两个 PNG 条目的数据区重叠');

writeFixture('BIT3-DESCRIPTOR', '22-data-descriptor.zip', buildZip([
  { name: 'manifest.json', data: manifest, flags: 0x800 | 0x8, localCrc: 0, localCompressedSize: 0, localUncompressedSize: 0 },
  { name: 'role.png', data: image, flags: 0x800 | 0x8, localCrc: 0, localCompressedSize: 0, localUncompressedSize: 0 }
]), 'data descriptor：本地头大小和 CRC 为 0，以中央目录为准');

writeFixture('Z2-EXTRA-EXE', '19-nonwhitelist-exe.zip', buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'role.png', data: image },
  { name: 'payload.exe', data: Buffer.from('MZ-not-a-real-exe') }
]), '合法皮肤包附加非白名单扩展名 payload.exe');

writeFixture('Z4-BAD-MANIFEST', '20-bad-manifest-version.zip', buildZip([
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({
    manifestVersion: 99, name: '坏版本', characters: [{ id: 'whale', name: '鲸', image: 'role.png' }]
  })) },
  { name: 'role.png', data: image }
]), 'manifestVersion 不是 1，应中文报错且不导入');

fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`\nWrote ${catalog.length} fixtures to ${outDir}`);
