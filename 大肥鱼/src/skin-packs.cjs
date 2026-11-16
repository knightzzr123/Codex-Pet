const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { imageFormat } = require('./skins.cjs');
const { inspectZipFile, writeEntries } = require('./zip-reader.cjs');
const {
  MANIFEST_VERSION, THUMBNAIL_SPEC, SKIN_PACK_LIMITS, assertManifestVersion, assertSlug, optionalText,
  referencedPathLimitMessage
} = require('./manifests.cjs');

const FORMATS = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' });
const STORED_FILE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const PACK_ID = /^[a-f0-9]{64}$/;
const CHARACTER_LINK = /^pack:([a-f0-9]{64}):([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})$/;
const PACKS_INDEX_VERSION = 1;

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPackId(value) {
  return typeof value === 'string' && PACK_ID.test(value);
}

function packCharacterId(packId, characterId) {
  if (!isPackId(packId)) throw new Error('皮肤包 ID 无效。');
  assertSlug(characterId, '角色 ID');
  return `pack:${packId}:${characterId}`;
}

function parsePackCharacterId(value) {
  const match = typeof value === 'string' ? CHARACTER_LINK.exec(value) : null;
  return match ? { packId: match[1], characterId: match[2] } : null;
}

function firstCharacterLink(pack) {
  const first = Array.isArray(pack?.characters) ? pack.characters[0] : null;
  return first && isPackId(pack.id) ? packCharacterId(pack.id, first.id) : null;
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
  if (value.includes('\u0000')) throw new Error(`${label}包含无法识别的字符。`);
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error(`${label}必须是皮肤包内的相对路径。`);
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label}不能跳出皮肤包目录。`);
  return normalized;
}

function imageDimensions(bytes) {
  const format = imageFormat(bytes);
  try {
    if (format === 'png') return { format, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (format === 'gif') return { format, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (format === 'bmp') return { format, width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
    if (format === 'jpg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { format, height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (format === 'webp' && bytes.length >= 30) {
      const chunk = bytes.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { format, width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { format, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
        return { format, width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
      }
    }
  } catch {}
  return null;
}

function validateThumbnail(bytes) {
  const format = imageFormat(bytes);
  if (!format || !THUMBNAIL_SPEC.formats.includes(format)) throw new Error('缩略图请使用 PNG、JPG 或 WebP。');
  if (bytes.length > THUMBNAIL_SPEC.maxBytes) throw new Error('缩略图不能超过 512 KB。');
  const size = imageDimensions(bytes);
  if (!size || !size.width || !size.height) throw new Error('缩略图无法解析，请换一张。');
  if (THUMBNAIL_SPEC.square && size.width !== size.height) throw new Error('缩略图必须是正方形。');
  if (size.width < THUMBNAIL_SPEC.minSide || size.width > THUMBNAIL_SPEC.maxSide) {
    throw new Error(`缩略图边长需在 ${THUMBNAIL_SPEC.minSide}–${THUMBNAIL_SPEC.maxSide} 像素之间。`);
  }
  return { format, width: size.width, height: size.height };
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest.json 需要是对象。');
  assertManifestVersion(value.manifestVersion, '皮肤包清单');
  const name = optionalText(value.name, '皮肤包名称', 80);
  if (!name) throw new Error('皮肤包名称不能为空。');
  const id = value.id === undefined ? '' : assertSlug(value.id, '皮肤包 ID');
  const version = optionalText(value.version, '皮肤包版本', 32) || '1.0.0';
  let store;
  // Reserved for a future store only; this build never downloads or validates
  // listings, and does not act on anything but the schema version.
  if (value.store !== undefined) {
    if (!value.store || typeof value.store !== 'object' || Array.isArray(value.store)) throw new Error('store 字段需要是对象。');
    if (!Number.isInteger(value.store.version) || value.store.version !== 1) throw new Error('store.version 当前仅支持 1。');
    store = { version: 1 };
  }
  if (!Array.isArray(value.characters) || !value.characters.length) throw new Error('皮肤包至少需要 1 个角色。');
  if (value.characters.length > SKIN_PACK_LIMITS.maxCharacters) throw new Error(`皮肤包最多包含 ${SKIN_PACK_LIMITS.maxCharacters} 个角色。`);
  const ids = new Set();
  const characters = value.characters.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index + 1} 个角色格式无效。`);
    const characterId = assertSlug(entry.id, `第 ${index + 1} 个角色 ID`);
    if (ids.has(characterId)) throw new Error(`角色 ID 重复：${characterId}`);
    ids.add(characterId);
    const characterName = optionalText(entry.name, `第 ${index + 1} 个角色名称`, 80);
    if (!characterName) throw new Error(`第 ${index + 1} 个角色名称不能为空。`);
    const image = safeRelativePath(entry.image, `第 ${index + 1} 个角色图片`);
    const thumbnail = entry.thumbnail === undefined || entry.thumbnail === null || entry.thumbnail === ''
      ? null : safeRelativePath(entry.thumbnail, `第 ${index + 1} 个角色缩略图`);
    return { id: characterId, name: characterName, image, thumbnail };
  });
  return { manifestVersion: MANIFEST_VERSION, id, name, version, store, characters };
}

function readJsonFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw codedError('manifest.json 不能是符号链接或目录联接。', 'ZIP_SYMLINK');
  if (!stat.isFile()) throw new Error('manifest.json 不是文件。');
  if (stat.size > maxBytes) throw new Error('manifest.json 过大。');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// Every file a pack actually reads: the manifest itself plus each referenced
// image and thumbnail. Unreferenced files are never opened, so they never need
// a symlink check.
function referencedFiles(manifest) {
  const files = ['manifest.json'];
  for (const character of manifest.characters) {
    files.push(character.image);
    if (character.thumbnail) files.push(character.thumbnail);
  }
  return [...new Set(files)];
}

function packContentId(manifest, sources) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify(manifest));
  for (const source of sources) {
    digest.update('\n').update(source.character.id).update('\n');
    digest.update(createHash('sha256').update(source.imageBytes).digest('hex')).update('\n');
    if (source.thumbnailBytes) digest.update(createHash('sha256').update(source.thumbnailBytes).digest('hex'));
  }
  return digest.digest('hex');
}

function sweepTransientDirs(directory, log = () => {}) {
  if (!directory || !fs.existsSync(directory)) return [];
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(directory); }
  catch (error) { log(error); return removed; }
  for (const name of names) {
    if (!/^\.staging(-zip)?-/.test(name) && !/^\.unzip-/.test(name)) continue;
    try {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      removed.push(name);
    } catch (error) { log(error); }
  }
  return removed;
}

function assertJsonDepth(text, maxDepth = 32) {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') { index += 1; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > maxDepth) throw new Error('manifest.json 嵌套过深。');
    } else if (char === '}' || char === ']') depth = Math.max(0, depth - 1);
  }
}

function findManifestDirectory(root) {
  const skip = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db']);
  let names;
  try { names = fs.readdirSync(root); }
  catch { throw codedError('没有权限读取皮肤包文件夹。', 'ZIP_ACCESS'); }
  // Lstat every top-level entry once, up front. A sibling we cannot inspect
  // (EBUSY, EACCES, a vanished entry, a junction that cannot be resolved) is
  // simply skipped: it is not the pack, so it must never surface an OS error or
  // an English message. The path segments that actually lead to manifest.json
  // are still checked below.
  const top = [];
  for (const name of names) {
    if (skip.has(name)) continue;
    const full = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch { continue; }
    top.push({ name, full, stat });
  }
  const found = [];
  // A link/junction is looked at with lstat only, never followed with stat():
  // a UNC link must not trigger an SMB round trip just to decide whether it is
  // a directory. A linked directory that holds a manifest is remembered, but
  // it only becomes an error when it is the sole candidate — an unrelated link
  // next to a real pack must not reject the import (D-A4-SIBLING).
  const linked = [];
  const manifestEntry = top.find(item => item.name === 'manifest.json');
  if (manifestEntry) {
    if (manifestEntry.stat.isSymbolicLink()) {
      throw codedError('皮肤包里的 manifest.json 不能是符号链接或目录联接。', 'ZIP_SYMLINK');
    }
    if (manifestEntry.stat.isFile()) found.push(root);
  }
  // Only the selected root and its direct children are examined: a pack lives
  // at the root or in its single top-level directory. Subdirectories are never
  // entered here, so an unreadable or huge sibling cannot fail or stall preview.
  for (const item of top) {
    if (item.name === 'manifest.json') continue;
    if (item.stat.isSymbolicLink()) {
      let nestedStat;
      try { nestedStat = fs.lstatSync(path.join(item.full, 'manifest.json')); } catch { continue; }
      if (nestedStat.isSymbolicLink() || nestedStat.isFile()) linked.push(item.full);
      continue;
    }
    if (!item.stat.isDirectory()) continue;
    let nestedStat;
    try { nestedStat = fs.lstatSync(path.join(item.full, 'manifest.json')); }
    catch { continue; }
    if (nestedStat.isSymbolicLink()) {
      throw codedError('皮肤包里的 manifest.json 不能是符号链接或目录联接。', 'ZIP_SYMLINK');
    }
    if (nestedStat.isFile()) found.push(item.full);
  }
  if (!found.length && linked.length) {
    // No real pack anywhere: the only candidate manifest sits behind a link,
    // so the path we would read runs through that link.
    throw codedError('皮肤包所在目录不能是符号链接或目录联接。', 'ZIP_SYMLINK');
  }
  if (!found.length) {
    // No manifest at an allowed depth. Look one level deeper only to keep the
    // specific "manifest.json 只能放在..." message; every directory read is
    // guarded, so an unreadable tree still ends in "没找到 manifest.json"
    // instead of an unclassified permission error.
    for (const item of top) {
      if (item.name === 'manifest.json' || !item.stat.isDirectory()) continue;
      let children = [];
      try { children = fs.readdirSync(item.full); } catch { continue; }
      for (const child of children) {
        if (skip.has(child)) continue;
        const childPath = path.join(item.full, child);
        let childStat;
        try { childStat = fs.lstatSync(childPath); } catch { continue; }
        if (!childStat.isDirectory()) continue;
        let deeperManifest = null;
        try { deeperManifest = fs.lstatSync(path.join(childPath, 'manifest.json')); } catch { continue; }
        if (deeperManifest.isSymbolicLink() || deeperManifest.isFile()) {
          throw codedError('manifest.json 只能放在皮肤包根目录，或唯一一层顶层目录下；图片可按 manifest 的相对路径放在子目录里。', 'ZIP_MANIFEST_LOCATION');
        }
      }
    }
  }
  if (!found.length) throw codedError('没找到 manifest.json；请选择包含 manifest.json 的皮肤包文件夹。', 'ZIP_MANIFEST_MISSING');
  if (found.length > 1) throw codedError('皮肤包里有多份 manifest.json。', 'ZIP_MANIFEST_MULTIPLE');
  return found[0];
}

function previewDataUrl(bytes) {
  if (!bytes || bytes.length > 512 * 1024) return null;
  const format = imageFormat(bytes);
  if (!format || !FORMATS[format]) return null;
  return `data:${FORMATS[format]};base64,${bytes.toString('base64')}`;
}

function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

// path.relative() is the only containment test used for real paths: a result
// that is absolute or climbs out with ".." means the target left the pack.
// Windows is not case sensitive and accepts both separators, so the comparison
// folds case there (path.win32.relative already does this itself, but doing it
// explicitly keeps drive-letter casing and "/" vs "\" from ever faking an
// escape) and normalises separators before looking for a leading "..".
function insideDirectory(directory, target) {
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  const relative = path.relative(fold(directory), fold(target));
  if (path.isAbsolute(relative)) return false;
  const normalized = relative.replace(/[\\/]+/g, '/');
  return normalized !== '..' && !normalized.startsWith('../');
}

function missingPackFile(label) {
  return codedError(`皮肤包缺少文件：${label}`, 'ZIP_FORMAT');
}

// Resolve the real path of a referenced file and refuse it unless it still
// sits inside the real path of the pack. The lstat/normal-file checks above are
// a separate (and still required) guard: realpath() also collapses a file that
// was swapped for a symlink *after* those checks ran, so a pack that is edited
// between preview and import cannot make us read a file from outside the pack.
function packFileRealPath(root, resolved, label) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw missingPackFile(label);
    if (error?.code === 'ELOOP') throw codedError(`${label}不能是符号链接或目录联接。`, 'ZIP_SYMLINK');
    throw codedError(`没有权限读取皮肤包文件夹：${label}`, 'ZIP_ACCESS');
  }
  let realTarget;
  try { realTarget = fs.realpathSync(resolved); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw missingPackFile(label);
    if (error?.code === 'ELOOP') throw codedError(`${label}不能是符号链接或目录联接。`, 'ZIP_SYMLINK');
    throw codedError(`没有权限读取皮肤包里的文件：${label}`, 'ZIP_ACCESS');
  }
  if (!insideDirectory(realRoot, realTarget)) {
    throw codedError(`${label}不能指向皮肤包外的符号链接或目录联接。`, 'ZIP_SYMLINK');
  }
  return realTarget;
}

function readPackFile(root, relative, maxBytes, label) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (!insideDirectory(base, resolved)) throw codedError(`${label}不能跳出皮肤包目录。`, 'ZIP_FORMAT');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw missingPackFile(label);
    throw codedError(`没有权限读取皮肤包里的文件：${label}`, 'ZIP_ACCESS');
  }
  if (stat.isSymbolicLink()) throw codedError(`${label}不能是符号链接或目录联接。`, 'ZIP_SYMLINK');
  if (!stat.isFile()) throw codedError(`${label}需要是普通文件。`, 'ZIP_FORMAT');
  if (stat.size > maxBytes) throw codedError(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`, 'ZIP_LIMIT');
  // Read through the resolved real path, not the manifest-provided path.
  const realTarget = packFileRealPath(base, resolved, label);
  const bytes = fs.readFileSync(realTarget);
  if (bytes.length > maxBytes) throw codedError(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`, 'ZIP_LIMIT');
  return bytes;
}

// 方案 ①：不遍历整棵树。只对 manifest 引用到的每个文件逐段 lstat——从选中根
// 到该文件的每一级父目录都不能是符号链接或目录联接，引用文件本身也不能是。
// 未引用到的子目录（再大、再深、无权限）永远不会被 readdir/lstat，所以误选
// C:\、用户目录或大型仓库时预览/导入不会卡住，也不会抛出未分类错误。
// 条目上限只统计真正检查过的路径段/引用文件，不会为了计数去扫描目录树。
function assertNoSymlinks(root, options = {}) {
  const source = path.resolve(root);
  const maxPaths = options.maxEntries ?? SKIN_PACK_LIMITS.maxReferencedPathSegments;
  const references = Array.isArray(options.references) ? options.references : ['manifest.json'];
  let rootStat;
  try { rootStat = fs.lstatSync(source); }
  catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw codedError('文件夹不存在，请重新选择皮肤包文件夹。', 'PACK_INVALID');
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      throw codedError('没有权限读取皮肤包文件夹。', 'ZIP_ACCESS');
    }
    throw codedError('皮肤包文件夹无法读取。', 'ZIP_ACCESS');
  }
  if (rootStat.isSymbolicLink()) throw codedError('皮肤包文件夹不能是符号链接或目录联接。', 'ZIP_SYMLINK');
  if (!rootStat.isDirectory()) throw codedError('皮肤包需要选择文件夹。', 'PACK_INVALID');
  const checked = new Set();
  let count = 0;
  for (const reference of references) {
    const parts = String(reference).replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      throw new Error('皮肤包文件路径不能跳出皮肤包目录。');
    }
    let current = source;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      // Parent directories shared by several references are lstat'ed once.
      if (checked.has(current)) continue;
      checked.add(current);
      count += 1;
      if (count > maxPaths) {
        throw codedError(referencedPathLimitMessage(maxPaths), 'ZIP_ENTRY_LIMIT');
      }
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          throw codedError(`皮肤包缺少文件：${reference}`, 'ZIP_FORMAT');
        }
        throw codedError(`没有权限读取皮肤包里的文件：${reference}`, 'ZIP_ACCESS');
      }
      if (stat.isSymbolicLink()) {
        throw codedError(`皮肤包文件夹包含符号链接或目录联接：${path.relative(source, current)}，已拒绝。`, 'ZIP_SYMLINK');
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw codedError(`皮肤包缺少文件：${reference}`, 'ZIP_FORMAT');
      }
    }
  }
}

function writePackFile(root, relative, bytes) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('皮肤包文件不能跳出隔离目录。');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function parseManifestBytes(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('manifest.json 无法解析或已损坏。'); }
  return normalizeManifest(parsed);
}

class SkinPackLibrary {
  constructor(dataDirectory, options = {}) {
    this.directory = path.join(dataDirectory, 'skin-packs');
    this.indexFile = path.join(this.directory, 'index.json');
    this.entries = [];
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : null;
    sweepTransientDirs(this.directory, error => {
      try { console.error('清理皮肤包临时目录失败：' + error.message); } catch { /* logging must not block startup */ }
    });
    try {
      const saved = JSON.parse(fs.readFileSync(this.indexFile, 'utf8').replace(/^\uFEFF/, ''));
      if (saved.version === PACKS_INDEX_VERSION && Array.isArray(saved.packs)) {
        const ids = new Set();
        this.entries = saved.packs.filter(item => {
          if (!item || !isPackId(item.id) || ids.has(item.id) || item.manifestVersion !== MANIFEST_VERSION
            || typeof item.name !== 'string' || !item.name.trim()
            || !Array.isArray(item.characters) || !item.characters.length
            || item.characters.length > SKIN_PACK_LIMITS.maxCharacters) return false;
          const characterIds = new Set();
          for (const character of item.characters) {
            if (!character || typeof character.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(character.id)
              || characterIds.has(character.id) || typeof character.name !== 'string' || !character.name.trim()
              || typeof character.image !== 'string' || !STORED_FILE.test(character.image)
              || (character.thumbnail !== null && character.thumbnail !== undefined
                && (typeof character.thumbnail !== 'string' || !STORED_FILE.test(character.thumbnail)))) return false;
            characterIds.add(character.id);
          }
          ids.add(item.id);
          return true;
        }).map(item => ({
          id: item.id, manifestVersion: MANIFEST_VERSION,
          name: item.name.slice(0, 80), version: String(item.version || '1.0.0').slice(0, 32),
          importedAt: typeof item.importedAt === 'string' ? item.importedAt : '',
          sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 40) : '',
          characters: item.characters.map(character => ({
            id: character.id, name: character.name.slice(0, 80),
            image: character.image, thumbnail: character.thumbnail || null
          }))
        }));
      }
    } catch {}
  }

  list() {
    return this.entries.flatMap(entry => {
      // Index paths are constrained to generated file names, never user paths.
      const directory = path.join(this.directory, entry.id);
      const characters = entry.characters.flatMap(character => {
        const file = path.join(directory, character.image);
        const thumbnailFile = character.thumbnail ? path.join(directory, character.thumbnail) : null;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || !stat.size || stat.size > SKIN_PACK_LIMITS.maxImageBytes) return [];
          if (thumbnailFile) {
            const thumb = fs.statSync(thumbnailFile);
            if (!thumb.isFile() || !thumb.size || thumb.size > THUMBNAIL_SPEC.maxBytes) return [];
          }
        } catch { return []; }
        return [{ ...character, file, thumbnailFile }];
      });
      if (!characters.length) return [];
      return [{ ...entry, directory, characters }];
    });
  }

  get(id) {
    return isPackId(id) ? this.list().find(entry => entry.id === id) || null : null;
  }

  character(packId, characterId) {
    const pack = this.get(packId);
    if (!pack || typeof characterId !== 'string') return null;
    return pack.characters.find(character => character.id === characterId) || null;
  }

  remove(id) {
    if (!isPackId(id)) return false;
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return false;
    const remaining = this.entries.filter(item => item.id !== id);
    atomicWrite(this.indexFile, JSON.stringify({ version: PACKS_INDEX_VERSION, packs: remaining }, null, 2));
    try {
      // Only a content-addressed, validated directory can be removed.
      fs.rmSync(path.join(this.directory, id), { recursive: true, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        atomicWrite(this.indexFile, JSON.stringify({ version: PACKS_INDEX_VERSION, packs: this.entries }, null, 2));
        throw error;
      }
    }
    this.entries = remaining;
    return true;
  }

  nextDisplayName(manifest) {
    const base = String(manifest.name);
    const sourceKey = typeof manifest.id === 'string' ? manifest.id.toLowerCase() : '';
    const names = new Set(this.entries.map(entry => String(entry.name).normalize('NFC')));
    const sameSource = Boolean(sourceKey)
      && this.entries.some(entry => String(entry.sourceId || '').toLowerCase() === sourceKey);
    if (!sameSource && !names.has(base.normalize('NFC'))) return base;
    // Same source ID (or the same display name from another source) never
    // overwrites: keep every version and disambiguate with （2）, （3） …
    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${base}（${index}）`;
      if (!names.has(candidate.normalize('NFC'))) return candidate;
    }
    throw new Error('同名皮肤包过多，无法生成新的显示名称。');
  }

  // Folder imports are snapshotted before installation to close the
  // preview/commit race. Copy only the files the manifest references: never
  // `cpSync` a user folder wholesale, because unreferenced giant files or
  // symlinks/junctions must not be pulled into the data directory. The same
  // referenced-path symlink check as preview/identify runs here before any read.
  copyReferencedDirectory(sourceDirectory, targetDirectory) {
    const source = path.resolve(sourceDirectory);
    const target = path.resolve(targetDirectory);
    if (target === source || target.startsWith(source + path.sep)) {
      throw new Error('皮肤包临时目录不能位于源文件夹内。');
    }
    assertNoSymlinks(source, { references: ['manifest.json'] });
    const manifestBytes = readPackFile(source, 'manifest.json', SKIN_PACK_LIMITS.maxManifestBytes, 'manifest.json');
    const manifest = parseManifestBytes(manifestBytes);
    assertNoSymlinks(source, { references: referencedFiles(manifest) });
    fs.mkdirSync(target, { recursive: true });
    writePackFile(target, 'manifest.json', manifestBytes);
    let totalBytes = 0;
    for (const character of manifest.characters) {
      const imageBytes = readPackFile(source, character.image, SKIN_PACK_LIMITS.maxImageBytes, `角色“${character.name}”的图片`);
      totalBytes += imageBytes.length;
      if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) {
        throw codedError('皮肤包总大小超过 200 MB。', 'ZIP_LIMIT');
      }
      writePackFile(target, character.image, imageBytes);
      if (character.thumbnail) {
        const thumbnailBytes = readPackFile(source, character.thumbnail, THUMBNAIL_SPEC.maxBytes, `角色“${character.name}”的缩略图`);
        totalBytes += thumbnailBytes.length;
        if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) {
          throw codedError('皮肤包总大小超过 200 MB。', 'ZIP_LIMIT');
        }
        writePackFile(target, character.thumbnail, thumbnailBytes);
      }
    }
    return manifest;
  }

  async importDirectory(sourceDirectory, validateImage = async () => {}) {
    const root = path.resolve(sourceDirectory);
    const manifestFile = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('皮肤包缺少 manifest.json。');
    assertNoSymlinks(root, { references: ['manifest.json'] });
    const manifest = normalizeManifest(readJsonFile(manifestFile, SKIN_PACK_LIMITS.maxManifestBytes));
    assertNoSymlinks(root, { references: referencedFiles(manifest) });
    const sources = [];
    let totalBytes = 0;
    for (const character of manifest.characters) {
      const imageBytes = readPackFile(root, character.image, SKIN_PACK_LIMITS.maxImageBytes, `角色“${character.name}”的图片`);
      const extension = imageFormat(imageBytes);
      if (!extension) throw new Error(`角色“${character.name}”的图片格式不受支持。`);
      totalBytes += imageBytes.length;
      await validateImage(imageBytes, FORMATS[extension]);
      let thumbnailBytes = null;
      let thumbnailFormat = null;
      if (character.thumbnail) {
        thumbnailBytes = readPackFile(root, character.thumbnail, THUMBNAIL_SPEC.maxBytes, `角色“${character.name}”的缩略图`);
        thumbnailFormat = validateThumbnail(thumbnailBytes).format;
        totalBytes += thumbnailBytes.length;
        await validateImage(thumbnailBytes, FORMATS[thumbnailFormat]);
      }
      if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) throw codedError('皮肤包总大小超过 200 MB。', 'ZIP_LIMIT');
      sources.push({ character, imageBytes, extension, thumbnailBytes, thumbnailFormat });
    }
    const id = packContentId(manifest, sources);
    const existing = this.get(id);
    if (existing) {
      return {
        ...existing,
        reused: true,
        duplicate: { kind: 'content', existingId: existing.id, existingName: existing.name, switchTo: firstCharacterLink(existing) }
      };
    }
    const displayName = this.nextDisplayName(manifest);

    const staging = path.join(this.directory, `.staging-${process.pid}-${randomUUID()}`);
    const finalDirectory = path.join(this.directory, id);
    let createdFinal = false;
    try {
      fs.mkdirSync(staging, { recursive: true });
      const characters = sources.map((source, index) => {
        const imageName = `c-${index}-${source.character.id}.${source.extension}`;
        fs.writeFileSync(path.join(staging, imageName), source.imageBytes);
        let thumbnailName = null;
        if (source.thumbnailBytes) {
          thumbnailName = `t-${index}-${source.character.id}.${source.thumbnailFormat}`;
          fs.writeFileSync(path.join(staging, thumbnailName), source.thumbnailBytes);
        }
        return { id: source.character.id, name: source.character.name, image: imageName, thumbnail: thumbnailName };
      });
      const installed = {
        manifestVersion: MANIFEST_VERSION, name: displayName, version: manifest.version,
        sourceId: manifest.id || null, store: manifest.store || null,
        characters: characters.map((character, index) => ({
          id: character.id, name: character.name, image: character.image, thumbnail: character.thumbnail,
          source: { image: manifest.characters[index].image, thumbnail: manifest.characters[index].thumbnail }
        }))
      };
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(installed, null, 2) + '\n');
      if (fs.existsSync(finalDirectory)) {
        // A concurrent/previous install with identical content wins; staging is discarded.
        fs.rmSync(staging, { recursive: true, force: true });
        const winner = this.get(id);
        return winner
          ? { ...winner, reused: true, duplicate: { kind: 'content', existingId: winner.id, existingName: winner.name, switchTo: firstCharacterLink(winner) } }
          : winner;
      }
      fs.renameSync(staging, finalDirectory);
      createdFinal = true;
      const entry = {
        id, manifestVersion: MANIFEST_VERSION, name: displayName, version: manifest.version,
        importedAt: new Date().toISOString(), sourceId: manifest.id || '', characters
      };
      const entries = this.entries.concat(entry);
      try {
        atomicWrite(this.indexFile, JSON.stringify({ version: PACKS_INDEX_VERSION, packs: entries }, null, 2));
      } catch (error) {
        if (createdFinal) { try { fs.rmSync(finalDirectory, { recursive: true, force: true }); } catch {} }
        throw error;
      }
      this.entries = entries;
      return this.get(id);
    } catch (error) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      if (createdFinal && !this.entries.some(entry => entry.id === id)) {
        try { fs.rmSync(finalDirectory, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  }

  sourceIds() {
    const ids = [];
    for (const entry of this.entries) {
      if (entry.sourceId) { ids.push(entry.sourceId); continue; }
      try {
        const installed = JSON.parse(fs.readFileSync(path.join(this.directory, entry.id, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (typeof installed.sourceId === 'string' && installed.sourceId) ids.push(installed.sourceId);
      } catch { /* index without a readable manifest still works for listing */ }
    }
    return ids;
  }

  identifyDirectory(root) {
    assertNoSymlinks(root, { references: ['manifest.json'] });
    const manifest = normalizeManifest(readJsonFile(path.join(root, 'manifest.json'), SKIN_PACK_LIMITS.maxManifestBytes));
    // Preview and commit both identify the pack through this method, so the
    // referenced-path symlink check is identical for both phases.
    assertNoSymlinks(root, { references: referencedFiles(manifest) });
    const sources = [];
    let totalBytes = 0;
    for (const character of manifest.characters) {
      const imageBytes = readPackFile(root, character.image, SKIN_PACK_LIMITS.maxImageBytes, `角色“${character.name}”的图片`);
      if (!imageFormat(imageBytes)) throw new Error(`角色“${character.name}”的图片格式不受支持。`);
      totalBytes += imageBytes.length;
      let thumbnailBytes = null;
      if (character.thumbnail) {
        thumbnailBytes = readPackFile(root, character.thumbnail, THUMBNAIL_SPEC.maxBytes, `角色“${character.name}”的缩略图`);
        validateThumbnail(thumbnailBytes);
        totalBytes += thumbnailBytes.length;
      }
      if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) throw codedError('皮肤包总大小超过 200 MB。', 'ZIP_LIMIT');
      sources.push({ character, imageBytes, thumbnailBytes });
    }
    const id = packContentId(manifest, sources);
    const sourceKey = typeof manifest.id === 'string' ? manifest.id.toLowerCase() : '';
    const content = this.get(id);
    let duplicate = null;
    if (content) {
      duplicate = {
        kind: 'content', existingId: content.id, existingName: content.name, switchTo: firstCharacterLink(content)
      };
    } else if (sourceKey) {
      const match = this.entries.find(entry => String(entry.sourceId || '').toLowerCase() === sourceKey);
      if (match) duplicate = { kind: 'sourceId', existingId: match.id, existingName: match.name, switchTo: '' };
    }
    if (!duplicate) {
      const named = this.entries.find(entry => entry.name === manifest.name);
      if (named) duplicate = { kind: 'name', existingId: named.id, existingName: named.name, switchTo: '' };
    }
    const packedBytes = sources.reduce((sum, source) => sum + source.imageBytes.length + (source.thumbnailBytes?.length || 0), 0);
    return {
      id, manifest, sources, duplicate,
      installedName: content ? content.name : this.nextDisplayName(manifest),
      totalBytes: packedBytes
    };
  }

  previewFromIdentified(identified) {
    const reused = identified.duplicate?.kind === 'content';
    return {
      id: identified.id,
      name: identified.manifest.name,
      installedName: identified.installedName || identified.manifest.name,
      version: identified.manifest.version,
      sourceId: identified.manifest.id || '',
      reused,
      switchTo: reused ? (identified.duplicate.switchTo || '') : '',
      duplicate: identified.duplicate || null,
      totalBytes: identified.totalBytes || 0,
      characterCount: identified.sources.length,
      characters: identified.sources.map(source => ({
        id: source.character.id,
        name: source.character.name,
        thumbnailUrl: previewDataUrl(source.thumbnailBytes)
          || (source.imageBytes.length <= 256 * 1024 ? previewDataUrl(source.imageBytes) : null)
      }))
    };
  }

  filesForManifest(files) {
    const manifestFile = files.find(file => file.name === 'manifest.json');
    if (!manifestFile) throw new Error('皮肤包缺少 manifest.json。');
    const text = manifestFile.bytes.toString('utf8').replace(/^\uFEFF/, '');
    assertJsonDepth(text);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('manifest.json 无法解析或已损坏。'); }
    const manifest = normalizeManifest(parsed);
    const allowed = new Set(['manifest.json']);
    for (const character of manifest.characters) {
      allowed.add(character.image);
      if (character.thumbnail) allowed.add(character.thumbnail);
    }
    const kept = files.filter(file => allowed.has(file.name));
    if (kept.length !== allowed.size) {
      const missing = [...allowed].filter(name => !kept.some(file => file.name === name));
      throw new Error(`皮肤包缺少文件：${missing[0]}`);
    }
    return { manifest, files: kept };
  }

  // Ignored README/LICENSE entries are logged through the same diagnostic sink
  // used by the main process. The UI itself stays silent.
  reportDiagnostic(entry) {
    try { this.onDiagnostic?.(entry); } catch { /* diagnostics must not block imports */ }
  }

  inspectZipFile(zipPath, options = {}) {
    return inspectZipFile(zipPath, {
      ...options,
      onSkip: entry => {
        this.reportDiagnostic(entry);
        try { options.onSkip?.(entry); } catch { /* a consumer callback must not block imports */ }
      }
    });
  }

  async inspectZip(zipPath) {
    const inspected = await this.inspectZipFile(zipPath);
    const selected = this.filesForManifest(inspected.files);
    const temp = path.join(this.directory, `.staging-zip-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(this.directory, { recursive: true });
    fs.mkdirSync(temp);
    try {
      writeEntries(temp, selected.files);
      const identified = this.identifyDirectory(temp);
      identified.files = selected.files;
      return identified;
    } finally {
      try { fs.rmSync(temp, { recursive: true, force: true }); }
      catch (error) { try { console.error('清理皮肤包临时目录失败：' + error.message); } catch { /* ignore */ } }
    }
  }

  previewZip(zipPath) {
    return this.inspectZip(zipPath).then(identified => this.previewFromIdentified(identified));
  }

  async importPrepared(files, validateImage = async () => {}) {
    const selected = this.filesForManifest(files);
    fs.mkdirSync(this.directory, { recursive: true });
    const temp = path.join(this.directory, `.staging-zip-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(temp);
    try {
      writeEntries(temp, selected.files);
      return await this.importDirectory(temp, validateImage);
    } finally {
      try { fs.rmSync(temp, { recursive: true, force: true }); }
      catch (error) { try { console.error('清理皮肤包临时目录失败：' + error.message); } catch { /* ignore */ } }
    }
  }

  async importZip(zipPath, validateImage = async () => {}) {
    const inspected = await this.inspectZipFile(zipPath);
    return this.importPrepared(inspected.files, validateImage);
  }
}

module.exports = {
  SkinPackLibrary,
  THUMBNAIL_SPEC,
  PACKS_INDEX_VERSION,
  isPackId,
  packCharacterId,
  parsePackCharacterId,
  firstCharacterLink,
  normalizeManifest,
  validateThumbnail,
  imageDimensions,
  safeRelativePath,
  sweepTransientDirs,
  findManifestDirectory,
  assertNoSymlinks,
  packContentId
};
