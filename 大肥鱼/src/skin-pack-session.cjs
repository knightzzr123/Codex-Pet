const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { ZIP_LIMITS, writeEntries, ZipError } = require('./zip-reader.cjs');
const { findManifestDirectory, firstCharacterLink } = require('./skin-packs.cjs');
const { referencedPathLimitMessage } = require('./manifests.cjs');
const {
  isUserFacingError, isSystemErrorShape, ACCESS_ERROR_CODES, BUSY_ERROR_CODES, MISSING_ERROR_CODES
} = require('./errors.cjs');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 4;

// One wording for a damaged or unsupported archive. The technical detail stays
// in the diagnostic log so the settings window never shows an English parser
// message, a CRC byte count or another implementation detail.
const DAMAGED_ARCHIVE = '压缩包已损坏或格式不受支持，请重新打包后再试。';

const MESSAGES = Object.freeze({
  PATH_REJECTED: '只能导入 .zip 或皮肤包文件夹。',
  ZIP_SYMLINK: '不接受符号链接。',
  ZIP_LIMIT: '压缩包超过大小上限，请减小图片后再试。',
  ZIP_ENTRY_LIMIT: referencedPathLimitMessage(),
  ZIP_ACCESS: '没有权限读取皮肤包里的文件。',
  ZIP_SENDER: '只有设置窗口可以导入皮肤包。',
  TOKEN_INVALID: '这个导入凭证无效、已过期或已使用。',
  PACK_CHANGED: '皮肤包在预览之后被改过，请重新选择。',
  // Pack layout / manifest validation is a different failure from a damaged
  // archive: its exact Chinese reason is handed through, and this is only the
  // fallback for an error that carries no readable message.
  PACK_INVALID: '这个皮肤包不符合导入要求，请检查后重试。',
  ZIP_MANIFEST_MISSING: '没有找到 manifest.json，请确认皮肤包里有一份 manifest.json。',
  ZIP_MANIFEST_MULTIPLE: '皮肤包里有多个 manifest.json，请只保留一份。',
  ZIP_HEADER: DAMAGED_ARCHIVE,
  ZIP_CRC: DAMAGED_ARCHIVE,
  ZIP_FORMAT: DAMAGED_ARCHIVE,
  // The selected thing is not a regular ZIP (a folder, device or link). That
  // is a different problem from a damaged archive, so this code is not opaque
  // and its own sentence reaches the settings window.
  ZIP_UNSUPPORTED: '只能导入普通 ZIP 文件。'
});

// Only the zip-reader's structural errors are opaque: their parser detail is
// logged instead of shown, and the UI reads one fixed sentence for all three.
// Every other code keeps its specific Chinese reason (PACK_INVALID included).
const OPAQUE_CODES = new Set(['ZIP_HEADER', 'ZIP_CRC', 'ZIP_FORMAT']);

// System-error code sets and the shape check live in errors.cjs so the image
// import and the skin-pack import cannot drift apart.
const BUSY_IO_ERROR = '文件被占用或没有权限读取，请稍后重试。';
// The data dir is technical wording: what the user can act on is the file and
// the disk, so the generic sentence names those instead.
const GENERIC_IO_ERROR = '无法读取或保存皮肤包，请确认文件能打开，且磁盘有空间。';

// Zip failures and `UserFacingError`s are thrown by this project with Chinese
// copy meant for the user. A Node fs error is not: it is logged and replaced.
function carriesUserMessage(error) {
  return isUserFacingError(error) || error instanceof ZipError;
}

function isSystemError(error) {
  // Our own errors win: they were written for the user even when a message
  // happens to mention a path or an errno-like word.
  if (carriesUserMessage(error)) return false;
  return isSystemErrorShape(error);
}

function systemFailure(error, context = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (BUSY_ERROR_CODES.has(code)) return { code: 'ZIP_ACCESS', message: BUSY_IO_ERROR };
  if (ACCESS_ERROR_CODES.has(code)) return { code: 'ZIP_ACCESS', message: MESSAGES.ZIP_ACCESS };
  if (MISSING_ERROR_CODES.has(code)) {
    // commit writes into the data directory; if an entry disappears while that
    // write is in flight, the selected folder still exists, so telling the user
    // to pick it again would be misleading. Report the generic IO reason.
    if (context.writing) return { code: 'ZIP_ACCESS', message: GENERIC_IO_ERROR };
    return context.kind === 'zip'
      ? { code: 'PACK_INVALID', message: '文件不存在，请重新选择皮肤包文件。' }
      : { code: 'PACK_INVALID', message: '文件夹不存在，请重新选择皮肤包文件夹。' };
  }
  return { code: 'ZIP_ACCESS', message: GENERIC_IO_ERROR };
}

function limitMessage(detail) {
  const base = detail || MESSAGES.ZIP_LIMIT;
  if (base.includes('请减小图片')) return base;
  return `${base.replace(/[。.]?$/, '。')}请减小图片后再试。`;
}

function fail(code, detail) {
  if (OPAQUE_CODES.has(code)) return { ok: false, code, error: MESSAGES[code] };
  const message = typeof detail === 'string' ? detail : '';
  if (code === 'ZIP_LIMIT') return { ok: false, code, error: limitMessage(message) };
  // Every call site passes either its own literal copy or a message from one of
  // our user-facing errors; an empty detail falls back to the code's copy.
  return { ok: false, code, error: message || MESSAGES[code] || MESSAGES.PACK_INVALID };
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
  catch (error) {
    // The parent can exist yet deny lstat (EACCES/EPERM). That is an access
    // problem, not "the selected path is the wrong kind of thing".
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return { ok: false, code: 'ZIP_ACCESS', error: MESSAGES.ZIP_ACCESS };
    }
    return fail('PATH_REJECTED');
  }
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
  // Technical details never reach the renderer. They are appended to the
  // diagnostic stream (lifecycle log in the packaged app) instead.
  const onDiagnostic = typeof options.onDiagnostic === 'function'
    ? options.onDiagnostic
    : entry => {
      try { console.error('皮肤包导入诊断：' + JSON.stringify(entry)); }
      catch { /* logging must not change the import result */ }
    };
  const tokens = new Map();
  let order = 0;

  function diagnostic(entry) {
    try { onDiagnostic(entry); }
    catch { /* diagnostics must never block the result */ }
  }

  function errorCode(error, fallback = 'PACK_INVALID') {
    const code = typeof error?.code === 'string' ? error.code : fallback;
    return code.startsWith('ZIP_') || code === 'PACK_CHANGED' || code === 'PACK_INVALID'
      ? code
      : fallback;
  }

  // Split a thrown value into the code the UI reads and the copy it shows. The
  // technical detail of a system failure (English message, absolute path) only
  // ever goes to the diagnostic log.
  function describe(error, context = {}) {
    if (isSystemError(error)) {
      diagnostic({
        event: 'skin-pack-error',
        code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
        syscall: typeof error.syscall === 'string' ? error.syscall : '',
        detail: typeof error.message === 'string' ? error.message : ''
      });
      return systemFailure(error, context);
    }
    const code = errorCode(error);
    if (OPAQUE_CODES.has(code)) {
      diagnostic({ event: 'skin-pack-error', code, detail: typeof error?.message === 'string' ? error.message : '' });
    }
    const message = carriesUserMessage(error) && typeof error.message === 'string' ? error.message : '';
    return { code, message };
  }

  function failure(error, context = {}) {
    const described = describe(error, context);
    return fail(described.code, described.message);
  }

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
        // Preview reads manifest-referenced images from the user's folder.
        // identifyDirectory() lstats only the manifest and every referenced
        // file's path segments (via assertNoSymlinks), so unreferenced
        // subdirectories are never entered or checked. commit() repeats the
        // same check, including whole-path validation before the snapshot copy.
        record.dir = findManifestDirectory(record.filePath);
        record.ownsDir = false;
      }
      const identified = library.identifyDirectory(record.dir);
      record.id = identified.id;
      record.preview = publicPreview(library.previewFromIdentified(identified));
      return { ok: true, ...record.preview };
    } catch (error) {
      drop(record.token);
      return failure(error, { kind: record.kind });
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
      // A zip-reader or fs failure is the real reason the re-check failed; any
      // other validation error means the pack changed since the preview.
      if ((typeof error?.code === 'string' && error.code.startsWith('ZIP_')) || isSystemError(error)) {
        return failure(error, { kind: record.kind });
      }
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
      // Reaching here means commit was writing into the data directory (the
      // snapshot or the pack files). A missing path is not the selected folder,
      // so the not-found copy above must not be used.
      return failure(error, { kind: record.kind, writing: true });
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
