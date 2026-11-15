const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { imageFormat } = require('./skins.cjs');
const { inspectZipFile, writeEntries } = require('./zip-reader.cjs');
const {
  MANIFEST_VERSION, THUMBNAIL_SPEC, SKIN_PACK_LIMITS, assertManifestVersion, assertSlug, optionalText
} = require('./manifests.cjs');

const FORMATS = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' });
const STORED_FILE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const PACK_ID = /^[a-f0-9]{64}$/;
const CHARACTER_LINK = /^pack:([a-f0-9]{64}):([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})$/;
const PACKS_INDEX_VERSION = 1;

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
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('manifest.json 不是文件。');
  if (stat.size > maxBytes) throw new Error('manifest.json 过大。');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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
  const top = fs.readdirSync(root).filter(name => !skip.has(name));
  const found = [];
  if (top.includes('manifest.json')) {
    const full = path.join(root, 'manifest.json');
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('皮肤包里包含符号链接。');
    if (stat.isFile()) found.push(root);
  }
  for (const name of top) {
    const full = path.join(root, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('皮肤包里包含符号链接。');
    if (!stat.isDirectory()) continue;
    const nested = path.join(full, 'manifest.json');
    if (fs.existsSync(nested) && fs.lstatSync(nested).isFile()) found.push(full);
    for (const child of fs.readdirSync(full)) {
      const childPath = path.join(full, child);
      if (child === 'manifest.json' || skip.has(child)) continue;
      let childStat;
      try { childStat = fs.lstatSync(childPath); } catch { continue; }
      if (!childStat.isDirectory()) continue;
      if (fs.existsSync(path.join(childPath, 'manifest.json'))) {
        const error = new Error('皮肤包里的文件只能放在根目录，或唯一一层顶层目录下。manifest.json 也只能在这两个位置。');
        error.code = 'ZIP_MANIFEST_LOCATION';
        throw error;
      }
    }
  }
  if (!found.length) throw new Error('皮肤包缺少 manifest.json。');
  if (found.length > 1) throw new Error('皮肤包里有多份 manifest.json。');
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

function readPackFile(root, relative, maxBytes, label) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`${label}不能跳出皮肤包目录。`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}需要是普通文件。`);
  if (stat.size > maxBytes) throw new Error(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > maxBytes) throw new Error(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  return bytes;
}

class SkinPackLibrary {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, 'skin-packs');
    this.indexFile = path.join(this.directory, 'index.json');
    this.entries = [];
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

  async importDirectory(sourceDirectory, validateImage = async () => {}) {
    const root = path.resolve(sourceDirectory);
    const manifestFile = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('皮肤包缺少 manifest.json。');
    const manifest = normalizeManifest(readJsonFile(manifestFile, SKIN_PACK_LIMITS.maxManifestBytes));
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
      if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) throw new Error('皮肤包总大小超过 200 MB。');
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
    const manifest = normalizeManifest(readJsonFile(path.join(root, 'manifest.json'), SKIN_PACK_LIMITS.maxManifestBytes));
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
      if (totalBytes > SKIN_PACK_LIMITS.maxTotalBytes) throw new Error('皮肤包总大小超过 200 MB。');
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

  async inspectZip(zipPath) {
    const inspected = await inspectZipFile(zipPath);
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
    const inspected = await inspectZipFile(zipPath);
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
  packContentId
};
