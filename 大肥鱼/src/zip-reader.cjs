// Minimal ZIP reader for skin packs. Stored and deflate only, no new dependencies.
// Counts bytes actually inflated and never trusts the sizes declared in the headers.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const ZIP_LIMITS = Object.freeze({
  maxEntries: 64,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxRatio: 100,
  // A pack cannot be useful once the archive itself exceeds the unpacked budget.
  maxArchiveBytes: 200 * 1024 * 1024 + 1024 * 1024
});

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    this.code = 'ZIP_REJECTED';
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
  throw new ZipError('这不是有效的 ZIP 文件。');
}

function assertNoZip64Extra(extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === 1) throw new ZipError('不支持 ZIP64 压缩包。');
    if (size < 0 || offset + 4 + size > extra.length) return;
    offset += 4 + size;
  }
}

function assertNotZip64(buffer, eocd) {
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 压缩包。');
  }
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === 0x07064b50) {
    throw new ZipError('不支持 ZIP64 压缩包。');
  }
  return { entries, cdSize, cdOffset };
}

function decodeEntryName(bytes, flags) {
  if (!bytes.length) throw new ZipError('压缩包条目名称为空。');
  if (flags & 0x800) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ZipError('无法识别压缩包内的文件名编码（已标记为 UTF-8，但内容无效）。'); }
  }
  const printableAscii = [...bytes].every(byte => byte === 0x09 || (byte >= 0x20 && byte < 0x7f));
  if (printableAscii) return Buffer.from(bytes).toString('utf8');
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (Buffer.from(utf8, 'utf8').equals(Buffer.from(bytes))) return utf8;
  } catch { /* not UTF-8; try the Windows Chinese code page below */ }
  try { return new TextDecoder('gbk', { fatal: true }).decode(bytes); }
  catch { throw new ZipError('无法识别压缩包内的文件名编码。请使用 UTF-8 或简体中文（CP936）重新压缩，不能导入乱码文件名。'); }
}

function safeEntryName(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\u0000')) {
    throw new ZipError('压缩包包含无效条目名称。');
  }
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//')) throw new ZipError('压缩包包含绝对路径，已拒绝。');
  if (/^[a-zA-Z]:/.test(normalized) || normalized.includes(':')) throw new ZipError('压缩包包含盘符或绝对路径，已拒绝。');
  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '..') throw new ZipError('压缩包包含越界路径，已拒绝。');
    if (!part || part === '.') continue;
    parts.push(part);
  }
  if (!parts.length) throw new ZipError('压缩包包含无效条目名称。');
  const directory = normalized.endsWith('/');
  return { name: parts.join('/') + (directory ? '/' : ''), parts, directory };
}

function isSymlink(versionMadeBy, externalAttributes) {
  const mode = externalAttributes >>> 16;
  return (mode & 0o170000) === 0o120000;
}

function isDirectoryEntry(versionMadeBy, externalAttributes, directoryName) {
  if (directoryName) return true;
  const mode = externalAttributes >>> 16;
  return (mode & 0o170000) === 0o040000;
}

function parseCentralDirectory(buffer, limits) {
  const eocd = findEocd(buffer);
  const { entries, cdSize, cdOffset } = assertNotZip64(buffer, eocd);
  if (entries > limits.maxEntries) throw new ZipError(`压缩包条目超过 ${limits.maxEntries} 个，已拒绝。`);
  if (cdOffset + cdSize > buffer.length) throw new ZipError('压缩包目录损坏。');
  const parsed = [];
  let cursor = cdOffset;
  const end = cdOffset + cdSize;
  while (cursor + 46 <= end) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ZipError('压缩包目录损坏。');
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
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
    const nameBytes = buffer.subarray(nameStart, nameStart + nameLength);
    if (nameStart + nameLength + extraLength + commentLength > end) throw new ZipError('压缩包目录损坏。');
    const extra = buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    assertNoZip64Extra(extra);
    if (flags & 0x1) throw new ZipError('不支持加密的压缩包条目。');
    if (method !== 0 && method !== 8) throw new ZipError('只支持存储（stored）和 deflate 压缩，其他压缩方法已拒绝。');
    if (isSymlink(versionMadeBy, externalAttributes)) throw new ZipError('压缩包包含符号链接，已拒绝。');
    if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError('不支持 ZIP64 压缩包。');
    }
    const decoded = decodeEntryName(nameBytes, flags);
    const safe = safeEntryName(decoded);
    parsed.push({
      name: safe.name, parts: safe.parts, directory: isDirectoryEntry(versionMadeBy, externalAttributes, safe.directory),
      flags, method, crc, compressedSize, uncompressedSize, localOffset
    });
    if (parsed.length > limits.maxEntries) throw new ZipError(`压缩包条目超过 ${limits.maxEntries} 个，已拒绝。`);
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (parsed.length !== entries && entries !== 0) {
    // Trust the records we could parse, but a short directory is corrupt.
    if (parsed.length < entries) throw new ZipError('压缩包目录损坏。');
  }
  return parsed;
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
      reject(error);
    };
    inflate.on('data', chunk => {
      if (settled) return;
      if (total + chunk.length > maxBytes) {
        fail(new ZipError('解压后的条目超过大小或压缩比上限，已拒绝。'));
        return;
      }
      total += chunk.length;
      chunks.push(chunk);
    });
    inflate.on('error', () => fail(new ZipError('压缩数据无法解压，已拒绝。')));
    inflate.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    inflate.end(input);
  });
}

async function readEntryPayload(buffer, entry, limits) {
  if (entry.localOffset + 30 > buffer.length) throw new ZipError('压缩包本地文件头损坏。');
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new ZipError('压缩包本地文件头损坏。');
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new ZipError('压缩包条目数据不完整。');
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.directory) return Buffer.alloc(0);
  const ratioCap = Math.min(limits.maxEntryBytes, Math.max(1, compressed.length) * limits.maxRatio);
  if (entry.method === 0) {
    if (compressed.length > limits.maxEntryBytes || compressed.length > ratioCap) {
      throw new ZipError('解压后的条目超过大小或压缩比上限，已拒绝。');
    }
    return Buffer.from(compressed);
  }
  if (!compressed.length) throw new ZipError('压缩数据为空，已拒绝。');
  const output = await inflateRawLimited(compressed, ratioCap + 1);
  if (output.length > limits.maxEntryBytes) throw new ZipError('单个文件解压后超过 20 MB，已拒绝。');
  if (compressed.length > 0 && output.length / compressed.length > limits.maxRatio) {
    throw new ZipError('单个条目压缩比超过 100:1，已拒绝。');
  }
  return output;
}

async function readZipBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError('这不是有效的 ZIP 文件。');
  const limits = limitsFrom(options);
  if (buffer.length > limits.maxArchiveBytes) throw new ZipError('压缩包超过大小上限。');
  const entries = parseCentralDirectory(buffer, limits);
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const bytes = await readEntryPayload(buffer, entry, limits);
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new ZipError('解压后总量超过 200 MB，已拒绝。');
    files.push({ name: entry.directory ? entry.name : entry.name.replace(/\/$/, ''), bytes, directory: entry.directory });
  }
  return files;
}

async function readZipFile(filePath, options = {}) {
  const limits = limitsFrom(options);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ZipError('只能导入普通 ZIP 文件。');
  if (stat.size > limits.maxArchiveBytes) throw new ZipError('压缩包超过大小上限。');
  return readZipBuffer(fs.readFileSync(filePath), options);
}

function destinationFor(root, parts) {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\u0000') || part.includes('/') || part.includes('\\')) {
      throw new ZipError('压缩包包含越界路径，已拒绝。');
    }
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new ZipError('压缩包包含符号链接，已拒绝。');
    }
  }
  const relative = path.relative(resolvedRoot, current);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ZipError('压缩包包含越界路径，已拒绝。');
  return current;
}

function writeEntries(root, entries) {
  fs.mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const rawParts = String(entry.name || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    if (!rawParts.length || rawParts.some(part => part === '..')) throw new ZipError('压缩包包含越界路径，已拒绝。');
    if (entry.directory || String(entry.name).endsWith('/')) {
      fs.mkdirSync(destinationFor(root, rawParts), { recursive: true });
      continue;
    }
    const target = destinationFor(root, rawParts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new ZipError('压缩包包含符号链接，已拒绝。');
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
  writeEntries,
  decodeEntryName,
  safeEntryName
};
