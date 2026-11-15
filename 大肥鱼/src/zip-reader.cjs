// Minimal ZIP reader for skin packs. Stored and deflate only, no new dependencies.
// Reads the central directory from the tail (at most 64KB + 22 bytes) and does
// not trust local-header sizes. Output bytes are counted while inflating.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const ZIP_LIMITS = Object.freeze({
  maxEntries: 64,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxRatio: 100,
  // The archive is buffered in the main process, so the cap is tighter than the
  // 220MB ceiling in the spec. Anything larger is rejected before it is read.
  maxArchiveBytes: 100 * 1024 * 1024
});

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'json']);

class ZipError extends Error {
  constructor(message, code = 'ZIP_REJECTED') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function limitsFrom(options = {}) {
  return { ...ZIP_LIMITS, ...(options.limits || {}) };
}

function findEocd(buffer) {
  const signature = 0x06054b50;
  const min = Math.max(0, buffer.length - (22 + 0xffff));
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new ZipError('这不是有效的 ZIP 文件。', 'ZIP_FORMAT');
}

function assertNoZip64Extra(extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === 1) throw new ZipError('不支持 ZIP64 压缩包。', 'ZIP64');
    if (offset + 4 + size > extra.length) return;
    offset += 4 + size;
  }
}

function unicodePathName(extra, nameBytes) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) return null;
    if (id === 0x7075 && size >= 5) {
      const body = extra.subarray(offset + 4, offset + 4 + size);
      const crc = body.readUInt32LE(1);
      if ((zlib.crc32(nameBytes) >>> 0) === crc) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(5)); }
        catch { throw new ZipError('无法识别压缩包内的文件名编码。', 'ZIP_NAME_ENCODING'); }
      }
    }
    offset += 4 + size;
  }
  return null;
}

function assertNotZip64(buffer, eocd) {
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || disk === 0xffff || cdDisk === 0xffff) {
    throw new ZipError('不支持 ZIP64 压缩包。', 'ZIP64');
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('不支持分卷压缩包。', 'ZIP_SPLIT');
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === 0x07064b50) {
    throw new ZipError('不支持 ZIP64 压缩包。', 'ZIP64');
  }
  if (cdOffset > buffer.length || cdSize > buffer.length - cdOffset) {
    throw new ZipError('压缩包目录损坏。', 'ZIP_FORMAT');
  }
  return { entries, cdSize, cdOffset };
}

function decodeEntryName(bytes, flags) {
  if (!bytes.length) throw new ZipError('压缩包条目名称为空。', 'ZIP_NAME_ENCODING');
  if (flags & 0x800) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ZipError('无法识别压缩包内的文件名编码（已标记为 UTF-8，但内容无效）。', 'ZIP_NAME_ENCODING'); }
  }
  if ([...bytes].every(byte => byte <= 0x7f)) return Buffer.from(bytes).toString('utf8');
  try { return new TextDecoder('gbk', { fatal: true }).decode(bytes); }
  catch { throw new ZipError('无法识别压缩包内的文件名编码。请使用 UTF-8 或简体中文（CP936）重新压缩，不能导入乱码文件名。', 'ZIP_NAME_ENCODING'); }
}

function safeEntryName(name) {
  const { safeRelativePath } = require('./skin-packs.cjs');
  if (typeof name !== 'string' || name.includes('\u0000')) {
    throw new ZipError('压缩包包含无效条目名称。', 'ZIP_PATH');
  }
  if (name.includes(':')) throw new ZipError('压缩包包含盘符或绝对路径，已拒绝。', 'ZIP_PATH');
  const slashed = name.replace(/\\/g, '/');
  if (slashed.startsWith('/')) throw new ZipError('压缩包包含绝对路径，已拒绝。', 'ZIP_PATH');
  const directory = slashed.endsWith('/');
  const trimmed = directory ? slashed.slice(0, -1) : slashed;
  let normalized;
  try { normalized = safeRelativePath(trimmed, '压缩包条目'); }
  catch (error) {
    const message = String(error.message || '');
    if (message.includes('空') || message.includes('跳出') || trimmed.includes('//') || trimmed.includes('/./') || trimmed.includes('..')) {
      throw new ZipError('压缩包包含越界路径，已拒绝。', 'ZIP_PATH');
    }
    throw new ZipError(message || '压缩包包含无效条目名称。', 'ZIP_PATH');
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part.endsWith('.') || part.endsWith(' ') || part.endsWith('\t')) {
      throw new ZipError('压缩包条目名称不能以点或空格结尾。', 'ZIP_RESERVED_NAME');
    }
    if (RESERVED_NAME.test(part)) throw new ZipError(`压缩包包含 Windows 保留名“${part}”，已拒绝。`, 'ZIP_RESERVED_NAME');
  }
  return { name: normalized + (directory ? '/' : ''), parts, directory };
}

function isSymlink(externalAttributes) {
  return ((externalAttributes >>> 16) & 0o170000) === 0o120000;
}

function isDirectoryEntry(externalAttributes, directoryName) {
  if (directoryName) return true;
  return ((externalAttributes >>> 16) & 0o170000) === 0o040000;
}

const IGNORED_EXTENSIONS = new Set(['txt', 'md']);
const IGNORED_BARE_NAMES = new Set(['license', 'licence', 'readme']);

function isIgnoredEntry(entry) {
  const parts = entry.parts || [];
  if (parts[0] === '__MACOSX') return true;
  const base = String(parts[parts.length - 1] || '');
  const lower = base.toLowerCase();
  if (lower === '.ds_store' || lower === 'thumbs.db') return true;
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (IGNORED_EXTENSIONS.has(ext)) return true;
  if (!ext && IGNORED_BARE_NAMES.has(lower)) return true;
  return false;
}

function assertAllowedExtension(safe) {
  if (safe.directory) return;
  const base = safe.parts[safe.parts.length - 1];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXT.has(ext)) {
    throw new ZipError('压缩包内有不受支持的文件类型。皮肤包只能包含 manifest.json 与 PNG、JPG、GIF、WebP 或 BMP 图片。', 'ZIP_EXTENSION');
  }
}

function parseCentralDirectory(buffer, limits) {
  const eocd = findEocd(buffer);
  const { entries, cdSize, cdOffset } = assertNotZip64(buffer, eocd);
  if (entries > limits.maxEntries) throw new ZipError(`压缩包条目超过 ${limits.maxEntries} 个，已拒绝。`, 'ZIP_LIMIT');
  const parsed = [];
  const folded = new Set();
  let skipped = 0;
  let cursor = cdOffset;
  const end = cdOffset + cdSize;
  while (cursor + 46 <= end) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ZipError('压缩包目录损坏。', 'ZIP_FORMAT');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength + commentLength > end) throw new ZipError('压缩包目录损坏。', 'ZIP_FORMAT');
    const nameBytes = buffer.subarray(nameStart, nameStart + nameLength);
    const extra = buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    assertNoZip64Extra(extra);
    if (flags & 0x1) throw new ZipError('不支持加密的压缩包条目。', 'ZIP_ENCRYPTED');
    if (method !== 0 && method !== 8) throw new ZipError('只支持存储（stored）和 deflate 压缩，其他压缩方法已拒绝。', 'ZIP_METHOD');
    if (isSymlink(externalAttributes)) throw new ZipError('压缩包包含符号链接，已拒绝。', 'ZIP_SYMLINK');
    if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError('不支持 ZIP64 压缩包。', 'ZIP64');
    }
    const decoded = unicodePathName(extra, nameBytes) || decodeEntryName(nameBytes, flags);
    const safe = safeEntryName(decoded);
    if (isIgnoredEntry({ parts: safe.parts })) {
      skipped += 1;
      cursor = nameStart + nameLength + extraLength + commentLength;
      continue;
    }
    assertAllowedExtension(safe);
    const fold = safe.name.normalize('NFC').toLowerCase();
    if (folded.has(fold)) throw new ZipError('压缩包内存在大小写重名的条目。', 'ZIP_DUPLICATE_NAME');
    folded.add(fold);
    parsed.push({
      name: safe.name, parts: safe.parts, directory: isDirectoryEntry(externalAttributes, safe.directory),
      flags, method, crc, compressedSize, uncompressedSize, localOffset, nameBytes
    });
    if (parsed.length > limits.maxEntries) throw new ZipError(`压缩包条目超过 ${limits.maxEntries} 个，已拒绝。`, 'ZIP_LIMIT');
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (entries !== 0 && parsed.length + skipped < entries) throw new ZipError('压缩包目录损坏。', 'ZIP_FORMAT');
  return parsed;
}

function locatePackManifest(entries) {
  const manifests = entries.filter(entry => !entry.directory && !isIgnoredEntry(entry) && entry.parts.at(-1) === 'manifest.json');
  if (manifests.length !== 1) {
    throw new ZipError(manifests.length ? '压缩包里有多份 manifest.json。' : '皮肤包缺少 manifest.json。', 'ZIP_MANIFEST_LOCATION');
  }
  const prefix = manifests[0].parts.slice(0, -1);
  if (prefix.length > 1) {
    throw new ZipError('manifest.json 只能放在皮肤包根目录，或唯一一层顶层目录下；图片可按 manifest 的相对路径放在子目录里。', 'ZIP_MANIFEST_LOCATION');
  }
  return { entry: manifests[0], prefix };
}

function inflateRawLimited(input, maxBytes) {
  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw();
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      reject(error instanceof ZipError ? error : new ZipError('压缩数据无法解压，已拒绝。', 'ZIP_LIMIT'));
    };
    inflate.on('data', chunk => {
      if (settled) return;
      if (total + chunk.length > maxBytes) {
        fail(new ZipError('解压后的条目超过大小或压缩比上限，已拒绝。', 'ZIP_LIMIT'));
        return;
      }
      total += chunk.length;
      chunks.push(chunk);
    });
    inflate.on('error', () => fail(new ZipError('压缩数据无法解压，已拒绝。', 'ZIP_FORMAT')));
    inflate.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    inflate.end(input);
  });
}

// A bit-3 entry may carry a trailing data descriptor. The central directory
// stays authoritative, but a descriptor that is present must agree with it,
// otherwise a tampered archive could hide mismatched sizes/CRC behind bit 3.
function assertDataDescriptor(buffer, entry, dataEnd, nextBoundary) {
  if (entry.directory) return;
  const room = nextBoundary - dataEnd;
  if (room < 12) return;
  let start = dataEnd;
  if (room >= 16 && buffer.readUInt32LE(dataEnd) === 0x08074b50) start = dataEnd + 4;
  if (start + 12 > nextBoundary) return;
  const crc = buffer.readUInt32LE(start);
  const compressed = buffer.readUInt32LE(start + 4);
  const uncompressed = buffer.readUInt32LE(start + 8);
  if (crc !== entry.crc || compressed !== entry.compressedSize || uncompressed !== entry.uncompressedSize) {
    throw new ZipError('数据描述符与中央目录的 CRC 或大小不一致。', 'ZIP_HEADER');
  }
}

async function readEntryPayload(buffer, entry, limits) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new ZipError('压缩包本地文件头损坏。', 'ZIP_FORMAT');
  }
  const flags = buffer.readUInt16LE(entry.localOffset + 6);
  const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
  const localCompressed = buffer.readUInt32LE(entry.localOffset + 18);
  const localUncompressed = buffer.readUInt32LE(entry.localOffset + 22);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const localName = buffer.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength);
  if (localName.length !== entry.nameBytes.length || !localName.equals(entry.nameBytes)) {
    throw new ZipError('本地文件头与中央目录的文件名不一致。', 'ZIP_HEADER');
  }
  if (localMethod !== entry.method) {
    throw new ZipError('本地文件头与中央目录的压缩方法不一致。', 'ZIP_HEADER');
  }
  const dataDescriptor = (flags & 0x8) !== 0 || (entry.flags & 0x8) !== 0;
  if ((flags & ~0x8) !== (entry.flags & ~0x8)) {
    throw new ZipError('本地文件头与中央目录的标志不一致。', 'ZIP_HEADER');
  }
  const sizesMatch = localCompressed === entry.compressedSize && localUncompressed === entry.uncompressedSize;
  const descriptorSizes = localCompressed === 0 && localUncompressed === 0;
  if (dataDescriptor) {
    if (!descriptorSizes && !sizesMatch) {
      throw new ZipError('本地文件头与中央目录的大小不一致。', 'ZIP_HEADER');
    }
  } else if (!sizesMatch) {
    throw new ZipError('本地文件头与中央目录的大小不一致。', 'ZIP_HEADER');
  }
  if (flags & 0x1) throw new ZipError('不支持加密的压缩包条目。', 'ZIP_ENCRYPTED');
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new ZipError('压缩包条目数据不完整。', 'ZIP_FORMAT');
  if (dataDescriptor && !entry.directory) assertDataDescriptor(buffer, entry, dataEnd, entry.nextBoundary ?? dataEnd);
  if (entry.directory) return Buffer.alloc(0);
  const compressed = buffer.subarray(dataStart, dataEnd);
  const maxOutput = Math.min(entry.uncompressedSize, limits.maxEntryBytes);
  if (entry.method === 0) {
    if (compressed.length === 0 && entry.uncompressedSize > 0) {
      throw new ZipError('压缩后大小为 0 但条目不是空文件，已拒绝。', 'ZIP_LIMIT');
    }
    if (compressed.length !== entry.uncompressedSize) {
      throw new ZipError('存储条目的长度与中央目录不一致。', 'ZIP_CRC');
    }
    if (compressed.length > maxOutput || compressed.length > limits.maxEntryBytes) {
      throw new ZipError('解压后的条目超过大小或压缩比上限，已拒绝。', 'ZIP_LIMIT');
    }
    const output = Buffer.from(compressed);
    if ((zlib.crc32(output) >>> 0) !== entry.crc) throw new ZipError('压缩包条目 CRC 校验失败。', 'ZIP_CRC');
    return output;
  }
  if (!compressed.length) throw new ZipError('压缩后大小为 0 但条目不是空文件，已拒绝。', 'ZIP_LIMIT');
  const output = await inflateRawLimited(compressed, maxOutput);
  if (output.length > maxOutput) throw new ZipError('解压后的条目超过大小或压缩比上限，已拒绝。', 'ZIP_LIMIT');
  if (output.length !== entry.uncompressedSize) {
    throw new ZipError('压缩包条目的大小与中央目录不一致。', 'ZIP_HEADER');
  }
  if (output.length / compressed.length > limits.maxRatio) {
    throw new ZipError('单个条目压缩比超过 100:1，已拒绝。', 'ZIP_LIMIT');
  }
  if ((zlib.crc32(output) >>> 0) !== entry.crc) throw new ZipError('压缩包条目 CRC 校验失败。', 'ZIP_CRC');
  return output;
}

function assertNoOverlap(buffer, entries) {
  const eocd = findEocd(buffer);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const ranges = [];
  for (const entry of entries) {
    if (entry.directory) continue;
    if (entry.localOffset + 30 > buffer.length) throw new ZipError('压缩包本地文件头损坏。', 'ZIP_FORMAT');
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > cdOffset) throw new ZipError('压缩包条目数据与中央目录重叠，已拒绝。', 'ZIP_FORMAT');
    for (const range of ranges) {
      if (dataStart < range.end && range.start < dataEnd) {
        throw new ZipError('压缩包条目数据区重叠，已拒绝。', 'ZIP_FORMAT');
      }
    }
    ranges.push({ start: dataStart, end: dataEnd });
  }
  return cdOffset;
}

function attachDescriptorBoundaries(buffer, entries, cdOffset) {
  const offsets = entries.map(entry => entry.localOffset).sort((a, b) => a - b);
  for (const entry of entries) {
    if (entry.directory) { entry.nextBoundary = cdOffset; continue; }
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataEnd = entry.localOffset + 30 + nameLength + extraLength + entry.compressedSize;
    entry.nextBoundary = offsets.find(offset => offset > entry.localOffset) ?? cdOffset;
    if (entry.nextBoundary < dataEnd) entry.nextBoundary = dataEnd;
  }
}

function openZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ZipError('这不是有效的 ZIP 文件。', 'ZIP_FORMAT');
  }
  const limits = limitsFrom(options);
  if (buffer.length > limits.maxArchiveBytes) throw new ZipError('压缩包超过大小上限。', 'ZIP_LIMIT');
  const entries = parseCentralDirectory(buffer, limits);
  const cdOffset = assertNoOverlap(buffer, entries);
  attachDescriptorBoundaries(buffer, entries, cdOffset);
  return {
    entries,
    limits,
    read: entry => readEntryPayload(buffer, entry, limits)
  };
}

async function readZipBuffer(buffer, options = {}) {
  const zip = openZip(buffer, options);
  const files = [];
  let total = 0;
  for (const entry of zip.entries) {
    const bytes = await zip.read(entry);
    total += bytes.length;
    if (total > zip.limits.maxTotalBytes) throw new ZipError('解压后总量超过 200 MB，已拒绝。', 'ZIP_LIMIT');
    if (!entry.directory) files.push({ name: entry.name, bytes, directory: false });
  }
  return files;
}

function readZipBufferSyncSize(filePath, limits) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ZipError('只能导入普通 ZIP 文件。', 'ZIP_FORMAT');
  if (stat.size > limits.maxArchiveBytes) throw new ZipError('压缩包超过大小上限。', 'ZIP_LIMIT');
  return fs.readFileSync(filePath);
}

async function readZipFile(filePath, options = {}) {
  return readZipBuffer(readZipBufferSyncSize(filePath, limitsFrom(options)), options);
}

function relativeToManifest(entry, prefix) {
  if (prefix.length && (entry.parts.length <= prefix.length || prefix.some((part, index) => entry.parts[index] !== part))) return null;
  return entry.parts.slice(prefix.length).join('/');
}

async function inspectZipBuffer(buffer, options = {}) {
  const zip = openZip(buffer, options);
  const located = locatePackManifest(zip.entries);
  let total = 0;
  const manifestBytes = await zip.read(located.entry);
  total += manifestBytes.length;
  const files = [{ name: 'manifest.json', bytes: manifestBytes }];
  const referenced = options.referencedNames instanceof Set ? options.referencedNames : null;
  for (const entry of zip.entries) {
    if (entry === located.entry || entry.directory) continue;
    const bytes = await zip.read(entry);
    total += bytes.length;
    if (total > zip.limits.maxTotalBytes) throw new ZipError('解压后总量超过 200 MB，已拒绝。', 'ZIP_LIMIT');
    if (isIgnoredEntry(entry)) continue;
    const relative = relativeToManifest(entry, located.prefix);
    if (!relative || (referenced && !referenced.has(relative))) continue;
    files.push({ name: relative, bytes });
  }
  return { files, prefix: located.prefix };
}

async function inspectZipFile(filePath, options = {}) {
  const limits = limitsFrom(options);
  return inspectZipBuffer(readZipBufferSyncSize(filePath, limits), options);
}

function destinationFor(root, parts) {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === '.' || part === '..' || part.includes('\u0000') || part.includes('/') || part.includes('\\') || part.includes(':')) {
      throw new ZipError('压缩包包含越界路径，已拒绝。', 'ZIP_PATH');
    }
    current = path.resolve(resolvedRoot, ...parts.slice(0, index + 1));
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new ZipError('压缩包包含符号链接，已拒绝。', 'ZIP_SYMLINK');
    }
  }
  const resolved = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ZipError('压缩包包含越界路径，已拒绝。', 'ZIP_PATH');
  }
  return resolved;
}

function writeEntries(root, entries) {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const seen = new Set();
  for (const entry of entries) {
    if (entry.directory || String(entry.name || '').endsWith('/')) continue;
    const safe = safeEntryName(String(entry.name || ''));
    const fold = safe.name.normalize('NFC').toLowerCase();
    if (seen.has(fold)) throw new ZipError('压缩包内存在大小写重名的条目。', 'ZIP_DUPLICATE_NAME');
    seen.add(fold);
    const target = destinationFor(resolvedRoot, safe.parts);
    if (!target.startsWith(resolvedRoot + path.sep)) throw new ZipError('压缩包包含越界路径，已拒绝。', 'ZIP_PATH');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    try { fs.writeFileSync(handle, entry.bytes); }
    finally { fs.closeSync(handle); }
  }
}

module.exports = {
  ZIP_LIMITS,
  ZipError,
  readZipBuffer,
  readZipFile,
  openZip,
  inspectZipBuffer,
  inspectZipFile,
  locatePackManifest,
  writeEntries,
  decodeEntryName,
  safeEntryName,
  isIgnoredEntry
};
