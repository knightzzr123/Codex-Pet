// Regenerates the small PNG regression fixtures used by
// test/skin-image-decode.test.cjs. Run from this directory:
//   node make-fixtures.cjs
// The bad fixtures keep a valid PNG signature and IHDR (so the old
// Image.onload check accepted them) but their IDAT payload is damaged,
// truncated or missing scanlines.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const out = __dirname;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crc = buffer => zlib.crc32(buffer) >>> 0;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc(typed));
  return Buffer.concat([length, typed, checksum]);
}

function header(width, height) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width, 0);
  bytes.writeUInt32BE(height, 4);
  bytes[8] = 8; // bit depth
  bytes[9] = 6; // RGBA
  return bytes;
}

function scanlines(width, height, rgba = [255, 140, 0, 255]) {
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) Buffer.from(rgba).copy(row, 1 + x * 4);
  return Buffer.concat(Array.from({ length: height }, () => row));
}

function goodPng(width, height, rgba) {
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', header(width, height)),
    chunk('IDAT', zlib.deflateSync(scanlines(width, height, rgba))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Valid signature + IHDR CRC, IDAT CRC also correct, but the payload is not
// deflate data at all. Chromium's header-only Image check accepts this one.
function badIdatPng(width, height) {
  const junk = Buffer.alloc(512);
  for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37 + 11) & 0xff;
  junk[0] = 0;
  junk[1] = 0;
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', header(width, height)),
    chunk('IDAT', junk), chunk('IEND', Buffer.alloc(0))
  ]);
}

function splitPng(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ start: offset, type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

const good = goodPng(256, 256);
const chunks = splitPng(good);
const idat = Buffer.concat(chunks.filter(item => item.type === 'IDAT').map(item => item.data));
const idatStart = chunks.find(item => item.type === 'IDAT').start;
const cut = Math.floor(idat.length * 0.6);

fs.writeFileSync(path.join(out, 'good.png'), good);
fs.writeFileSync(path.join(out, 'bad-idat.png'), badIdatPng(256, 256));
// Chunk framing is intact and the IDAT CRC matches the shortened payload, but
// the zlib stream stops early, so no decoder can rebuild all scanlines.
fs.writeFileSync(path.join(out, 'truncated-idat.png'), Buffer.concat([
  good.subarray(0, idatStart), chunk('IDAT', idat.subarray(0, cut)), chunk('IEND', Buffer.alloc(0))
]));
// The file itself stops inside the IDAT payload: there is no complete chunk
// and no IEND, only a legal signature and IHDR.
fs.writeFileSync(path.join(out, 'truncated-file.png'), good.subarray(0, idatStart + 8 + cut));
console.log('fixtures written to', out);
