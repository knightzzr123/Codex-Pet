const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { ZIP_LIMITS, writeEntries } = require('./zip-reader.cjs');
const { findManifestDirectory, assertNoSymlinks, firstCharacterLink } = require('./skin-packs.cjs');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 4;

const MESSAGES = Object.freeze({
  PATH_REJECTED: '只能导入 .zip 或皮肤包文件夹。',
  ZIP_SYMLINK: '不接受符号链接。',
  ZIP_LIMIT: '压缩包超过大小上限。',
  ZIP_ENTRY_LIMIT: '皮肤包文件夹里的文件或目录太多，已拒绝导入。',
  ZIP_SENDER: '只有设置窗口可以导入皮肤包。',
  TOKEN_INVALID: '这个导入凭证无效、已过期或已使用。',
  PACK_CHANGED: '皮肤包在预览之后被改过，请重新选择。',
  ZIP_FORMAT: '无法读取这个皮肤包。'
});

function fail(code, error) {
  return { ok: false, code, error: error || MESSAGES[code] || MESSAGES.ZIP_FORMAT };
}

function isRejectedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const text = value.trim();
  if (text.startsWith('\\\\?\\') || text.startsWith('\\\\.\\')) return true;
  if (text.startsWith('\\\\') || text.startsWith('//')) return true;
  const windows = text.replace(/\//g, '\\');
  return windows.startsWith('\\\\?\\') || windows.startsWith('\\\\.\\') || windows.startsWith('\\\\');
}

function classifySkinPackPath(filePath, options = {}) {
  const maxArchiveBytes = options.maxArchiveBytes ?? ZIP_LIMITS.maxArchiveBytes;
  if (isRejectedPath(filePath)) return fail('PATH_REJECTED');
  let resolved;
  try { resolved = path.resolve(filePath); }
  catch { return fail('PATH_REJECTED'); }
  if (isRejectedPath(resolved)) return fail('PATH_REJECTED');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { return fail('PATH_REJECTED'); }
  if (stat.isSymbolicLink()) return fail('ZIP_SYMLINK');
  if (stat.isDirectory()) return { ok: true, filePath: resolved, kind: 'directory' };
  if (stat.isFile() && resolved.toLowerCase().endsWith('.zip')) {
    if (stat.size > maxArchiveBytes) return fail('ZIP_LIMIT');
    return { ok: true, filePath: resolved, kind: 'zip' };
  }
  return fail('PATH_REJECTED');
}

function publicPreview(preview) {
  return {
    name: preview.name,
    installedName: preview.installedName || preview.name,
    version: preview.version,
    sourceId: preview.sourceId || '',
    reused: preview.reused === true,
    switchTo: preview.switchTo || '',
    duplicate: preview.duplicate ? {
      kind: preview.duplicate.kind,
      existingName: preview.duplicate.existingName || '',
      existingId: preview.duplicate.existingId || '',
      switchTo: preview.duplicate.switchTo || ''
    } : null,
    totalBytes: preview.totalBytes || 0,
    characterCount: preview.characterCount || 0,
    characters: (preview.characters || []).map(character => ({
      id: character.id,
      name: character.name,
      thumbnailUrl: character.thumbnailUrl || null
    }))
  };
}

function createSkinPackSession(options = {}) {
  const library = options.library;
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const validateImage = options.validateImage || (async () => {});
  const onImported = options.onImported || (() => {});
  const tokens = new Map();
  let order = 0;

  function drop(token) {
    const record = tokens.get(token);
    if (!record) return;
    tokens.delete(token);
    if (record.ownsDir && record.unzipRoot) {
      try { fs.rmSync(record.unzipRoot, { recursive: true, force: true }); }
      catch { /* a later startup sweep removes anything left behind */ }
    }
    record.ownsDir = false;
    record.unzipRoot = null;
  }

  function sweep(at = now()) {
    for (const record of [...tokens.values()]) {
      if (at - record.createdAt >= ttlMs) drop(record.token);
    }
  }

  function enforceCap() {
    while (tokens.size > maxTokens) {
      let oldest = null;
      for (const record of tokens.values()) {
        if (!oldest || record.order < oldest.order) oldest = record;
      }
      if (!oldest) break;
      drop(oldest.token);
    }
  }

  function lookup(token, senderId) {
    sweep();
    if (senderId === undefined || senderId === null || senderId === '') return fail('ZIP_SENDER');
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return fail('TOKEN_INVALID');
    const record = tokens.get(token);
    if (!record || record.senderId !== senderId) return fail('TOKEN_INVALID');
    if (now() - record.createdAt >= ttlMs) {
      drop(token);
      return fail('TOKEN_INVALID');
    }
    return { ok: true, record };
  }

  function register(filePath, senderId) {
    sweep();
    if (senderId === undefined || senderId === null || senderId === '') return fail('ZIP_SENDER');
    const checked = classifySkinPackPath(filePath, { maxArchiveBytes: options.maxArchiveBytes });
    if (!checked.ok) return checked;
    const token = randomBytes(16).toString('hex');
    tokens.set(token, {
      token,
      senderId,
      order: ++order,
      filePath: checked.filePath,
      kind: checked.kind,
      createdAt: now(),
      preview: null,
      id: null,
      dir: null,
      unzipRoot: null,
      ownsDir: false
    });
    enforceCap();
    if (!tokens.has(token)) return fail('TOKEN_INVALID');
    return { ok: true, token };
  }

  async function preview(token, senderId) {
    const found = lookup(token, senderId);
    if (!found.ok) return found;
    const record = found.record;
    if (record.preview) return { ok: true, ...record.preview };
    try {
      if (record.kind === 'zip') {
        const inspected = await library.inspectZipFile(record.filePath);
        const selected = library.filesForManifest(inspected.files);
        const root = path.join(library.directory, `.unzip-${process.pid}-${randomUUID()}`);
        fs.mkdirSync(library.directory, { recursive: true });
        fs.mkdirSync(root);
        record.unzipRoot = root;
        record.ownsDir = true;
        try {
          writeEntries(root, selected.files);
          record.dir = findManifestDirectory(root);
        } catch (error) {
          drop(record.token);
          throw error;
        }
      } else {
        // Preview reads manifest-referenced images from the user's folder. A
        // symlinked image or a symlinked parent directory would let that read
        // escape the selected folder, so reject the whole tree before reading
        // anything; commit() repeats the walk on the manifest directory.
        assertNoSymlinks(record.filePath);
        record.dir = findManifestDirectory(record.filePath);
        record.ownsDir = false;
      }
      const identified = library.identifyDirectory(record.dir);
      record.id = identified.id;
      record.preview = publicPreview(library.previewFromIdentified(identified));
      return { ok: true, ...record.preview };
    } catch (error) {
      drop(record.token);
      const code = typeof error.code === 'string' && (error.code.startsWith('ZIP_') || error.code === 'PACK_CHANGED')
        ? error.code : 'ZIP_FORMAT';
      return fail(code, error.message);
    }
  }

  async function commit(token, senderId) {
    const found = lookup(token, senderId);
    if (!found.ok) return found;
    const record = found.record;
    if (!record.preview || !record.dir || !record.id) return fail('TOKEN_INVALID', '请先预览这个皮肤包，再确认导入。');
    let again;
    try { again = library.identifyDirectory(record.dir); }
    catch (error) {
      drop(token);
      if (typeof error.code === 'string' && error.code.startsWith('ZIP_')) return fail(error.code, error.message);
      return fail('PACK_CHANGED');
    }
    if (again.id !== record.id) {
      drop(token);
      return fail('PACK_CHANGED');
    }
    if (record.committing) return fail('TOKEN_INVALID');
    record.committing = true;
    let importDir = record.dir;
    try {
      if (record.kind === 'directory') {
        const snap = path.join(library.directory, `.unzip-${process.pid}-${randomUUID()}`);
        fs.mkdirSync(library.directory, { recursive: true });
        record.unzipRoot = snap;
        record.ownsDir = true;
        // Copy only manifest-referenced files; symlinks and unreferenced large
        // files are never written into the snapshot.
        library.copyReferencedDirectory(record.dir, snap);
        importDir = snap;
        const snapId = library.identifyDirectory(importDir);
        if (snapId.id !== record.id) {
          drop(token);
          return fail('PACK_CHANGED');
        }
      }
      const pack = await library.importDirectory(importDir, validateImage);
      const reused = pack.reused === true;
      const renamed = !reused && pack.name !== again.manifest.name;
      // Z-5: the settings window needs the duplicate kind ('content' | 'sourceId'
      // | 'name') with the commit result to word the result announcement; a
      // freshly installed pack does not carry it, so it comes from the re-check.
      const duplicate = again.duplicate
        ? {
          kind: again.duplicate.kind,
          existingName: again.duplicate.existingName || '',
          existingId: again.duplicate.existingId || ''
        }
        : null;
      drop(token);
      // Identical content is never written twice and never switched silently;
      // the settings window offers a "switch to it" action instead.
      if (!reused) {
        try { onImported(pack); } catch { /* the pet window can apply the skin after the import result returns */ }
      }
      return {
        ok: true,
        reused,
        renamed,
        switchTo: reused ? (pack.duplicate?.switchTo || again.duplicate?.switchTo || firstCharacterLink(pack) || '') : '',
        duplicate,
        pack: {
          id: pack.id,
          name: pack.name,
          characterCount: Array.isArray(pack.characters) ? pack.characters.length : 0
        }
      };
    } catch (error) {
      if (record.kind === 'directory' && record.ownsDir) drop(token);
      else record.committing = false;
      const code = typeof error.code === 'string' ? error.code : 'ZIP_FORMAT';
      return fail(code, error.message);
    }
  }

  function cancel(token, senderId) {
    const found = lookup(token, senderId);
    if (!found.ok) return found;
    drop(token);
    return { ok: true };
  }

  function releaseSender(senderId) {
    for (const record of [...tokens.values()]) {
      if (record.senderId === senderId) drop(record.token);
    }
  }

  function releaseAll() {
    for (const token of [...tokens.keys()]) drop(token);
  }

  return { register, preview, commit, cancel, releaseSender, releaseAll, classify: classifySkinPackPath };
}

module.exports = {
  TOKEN_TTL_MS,
  MAX_TOKENS,
  classifySkinPackPath,
  createSkinPackSession
};
