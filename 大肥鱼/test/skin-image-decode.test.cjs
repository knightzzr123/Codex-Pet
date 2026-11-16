const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { SkinPackLibrary } = require('../src/skin-packs.cjs');
const { userError } = require('../src/errors.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'skin-image');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BROKEN = '这张图片无法显示，可能已损坏。请换一张图片。';

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

// A small, real PNG decoder: it parses the chunk table, verifies every CRC,
// inflates IDAT with zlib and rebuilds the filtered scanlines. It does not use
// any of the project's image helpers, so a broken fixture can only pass by
// actually decoding.
function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let header = null;
  const idat = [];
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('truncated chunk header');
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) throw new Error('truncated chunk data');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expected = bytes.readUInt32BE(offset + 8 + length);
    const actual = zlib.crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0;
    if (expected !== actual) throw new Error(`chunk CRC mismatch: ${type}`);
    if (!header) {
      if (type !== 'IHDR' || length !== 13) throw new Error('missing IHDR');
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9] };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('missing IHDR');
  if (!ended) throw new Error('missing IEND');
  if (!idat.length) throw new Error('missing IDAT');
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0;
  if (header.bitDepth !== 8 || !channels) throw new Error('unsupported fixture format');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  if (raw.length !== header.height * (stride + 1)) {
    throw new Error(`scanline length mismatch: ${raw.length}`);
  }
  const pixels = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const previous = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    const target = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? target[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      if (filter === 0) target[i] = row[i];
      else if (filter === 1) target[i] = (row[i] + left) & 0xff;
      else if (filter === 2) target[i] = (row[i] + up) & 0xff;
      else if (filter === 3) target[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) target[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`unsupported filter: ${filter}`);
    }
  }
  return { width: header.width, height: header.height, pixels };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

// Mirrors what validateSkinImage does for the import pipeline: decode for real,
// and translate a decode failure into the sentence shown in the settings window.
async function decodeOrThrow(bytes) {
  try {
    decodePng(bytes);
  } catch (error) {
    throw Object.assign(userError(PNG_BROKEN), { cause: error });
  }
}

function writePack(root, imageName, imageBytes) {
  const directory = fs.mkdtempSync(path.join(root, 'pack-'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifestVersion: 1, id: 'real-decode', name: '真解码测试包', version: '1.0.0',
    characters: [{ id: 'fish', name: '鱼', image: imageName }]
  }));
  fs.writeFileSync(path.join(directory, imageName), imageBytes);
  return directory;
}

test('真实 PNG 解码正常夹具，得到声明的尺寸和首个像素', () => {
  const decoded = decodePng(fixture('good.png'));
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
  assert.deepEqual([...decoded.pixels.subarray(0, 4)], [255, 140, 0, 255]);
});

test('文件头合法、IDAT 内容损坏的 PNG 在真实解码时失败', () => {
  const bytes = fixture('bad-idat.png');
  // The header is intact, so the old Image.onload check accepted it.
  assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true);
  assert.equal(bytes.readUInt32BE(16), 256);
  assert.throws(() => decodePng(bytes), /unknown compression method|invalid/i);
});

test('文件头合法、IDAT 被截断的 PNG 在真实解码时失败', () => {
  const bytes = fixture('truncated-idat.png');
  assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true);
  assert.throws(() => decodePng(bytes), /unexpected end of file|truncated|mismatch/i);
});

test('文件在 IDAT 中间被截断的 PNG 在真实解码时失败', () => {
  const bytes = fixture('truncated-file.png');
  assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true);
  assert.throws(() => decodePng(bytes), /truncated chunk data|missing IEND/i);
});

test('真实解码失败的图片不会生成空白皮肤包，正常图片仍可导入', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-real-decode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new SkinPackLibrary(root);

  const broken = writePack(root, 'broken.png', fixture('bad-idat.png'));
  await assert.rejects(() => library.importDirectory(broken, decodeOrThrow), { message: PNG_BROKEN });
  assert.deepEqual(library.list(), []);

  const good = writePack(root, 'good.png', fixture('good.png'));
  const pack = await library.importDirectory(good, decodeOrThrow);
  assert.equal(pack.name, '真解码测试包');
  assert.equal(pack.characters.length, 1);
  assert.equal(library.list().length, 1);
});

test('main.cjs 用 createImageBitmap 真实解码，并保留 10 秒超时和诊断日志', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const start = main.indexOf('async function validateSkinImage(bytes, mime) {');
  const end = main.indexOf('async function importSkinFile', start);
  assert.ok(start > 0 && end > start, '找不到 validateSkinImage');
  const block = main.slice(start, end);
  assert.match(block, /createImageBitmap\(new Blob\(\[data\]/);
  assert.match(block, /bitmap\.width > 0 && bitmap\.height > 0/);
  assert.match(block, /10000/);
  assert.match(block, /event: 'skin-pack-error'/);
  assert.match(block, /code/);
  assert.match(block, /detail/);
  assert.match(block, /SKIN_IMAGE_TIMEOUT/);
  assert.match(block, /SKIN_IMAGE_UNDECODABLE/);
  assert.doesNotMatch(block, /new Image\(\)/);
  assert.doesNotMatch(block, /image\.onload/);
  assert.match(block, /throw userError\('这张图片无法显示，可能已损坏。请换一张图片。'\);/);
});
