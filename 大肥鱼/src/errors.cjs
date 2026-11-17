// Errors whose message is written for the user. The settings window shows this
// copy as-is; anything else that reaches an import result is a technical detail
// (Node fs, a parser, a library) and is replaced by the code's own wording and
// written to the diagnostic log instead. Marking the errors at their source is
// what makes that split reliable: a Node fs error message can contain a Chinese
// path, so looking at the message is not enough to decide it is ours.
class UserFacingError extends Error {
  constructor(message, code = 'PACK_INVALID') {
    super(message);
    this.name = 'UserFacingError';
    this.code = code;
    this.userFacing = true;
  }
}

function userError(message, code) {
  return new UserFacingError(message, code);
}

function isUserFacingError(error) {
  return Boolean(error) && (error instanceof UserFacingError || error.userFacing === true);
}

// Node fs failures: the message is English and embeds the absolute path, so it
// must never reach the settings window. `errno`/`syscall` are the markers Node
// sets on every fs error; the code set also catches errors that were re-wrapped
// without them. EACCES/EPERM mean "cannot read or write it now"; EBUSY usually
// means a browser or antivirus still holds the file open, so saying only "no
// permission" would send the user looking for the wrong problem.
// The skin-pack session and the image import share these sets so the two code
// lists cannot drift apart.
const ACCESS_ERROR_CODES = new Set(['EACCES', 'EPERM']);
const BUSY_ERROR_CODES = new Set(['EBUSY']);
const MISSING_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);
const SYSTEM_ERROR_CODES = new Set([
  ...ACCESS_ERROR_CODES,
  ...BUSY_ERROR_CODES,
  ...MISSING_ERROR_CODES,
  'EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'ENAMETOOLONG',
  'EEXIST', 'EISDIR', 'ELOOP', 'ENOTEMPTY', 'EXDEV', 'EINVAL', 'UNKNOWN'
]);

function isSystemErrorShape(error) {
  if (!error || typeof error !== 'object') return false;
  if (typeof error.syscall === 'string' || error.errno !== undefined) return true;
  return typeof error.code === 'string' && SYSTEM_ERROR_CODES.has(error.code);
}

const IMAGE_MESSAGES = Object.freeze({
  BUSY: '文件被占用或没有权限读取，请稍后重试。',
  ACCESS: '没有权限读取这张图片。',
  MISSING: '找不到这张图片，请重新选择。',
  IO: '无法读取或保存图片，请确认文件存在且目录可写。',
  UNKNOWN: '无法导入这张图片，请重试。'
});

function imageFailureLog(log, entry) {
  if (typeof log !== 'function') return;
  try {
    log({
      event: 'skin-image-error',
      code: entry.code,
      syscall: entry.syscall || '',
      detail: entry.detail || ''
    });
  } catch { /* diagnostics must never replace the user's result */ }
}

// Turn any image import failure into the structure the settings window reads:
// a code plus the one Chinese sentence the user should see. A UserFacingError
// already carries that sentence; an fs error is logged and replaced by copy
// chosen from its errno, so its English text and absolute path stay local.
function imageImportFailure(error, log) {
  if (isUserFacingError(error)) {
    return { ok: false, code: error.code || 'PACK_INVALID', error: error.message };
  }
  if (isSystemErrorShape(error)) {
    const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
    const syscall = typeof error.syscall === 'string' ? error.syscall : '';
    imageFailureLog(log, {
      code, syscall, detail: typeof error.message === 'string' ? error.message : ''
    });
    if (BUSY_ERROR_CODES.has(code)) return { ok: false, code: 'IMAGE_ACCESS', error: IMAGE_MESSAGES.BUSY };
    if (ACCESS_ERROR_CODES.has(code)) return { ok: false, code: 'IMAGE_ACCESS', error: IMAGE_MESSAGES.ACCESS };
    if (MISSING_ERROR_CODES.has(code)) return { ok: false, code: 'IMAGE_MISSING', error: IMAGE_MESSAGES.MISSING };
    return { ok: false, code: 'IMAGE_IO', error: IMAGE_MESSAGES.IO };
  }
  // An unexpected error (TypeError, a library error): keep its message out of
  // the UI, but leave the detail in the diagnostic log for a bug report.
  imageFailureLog(log, {
    code: 'IMAGE_FAILED',
    syscall: '',
    detail: error && typeof error.message === 'string' ? error.message : String(error ?? '')
  });
  return { ok: false, code: 'IMAGE_FAILED', error: IMAGE_MESSAGES.UNKNOWN };
}

module.exports = {
  UserFacingError,
  userError,
  isUserFacingError,
  isSystemErrorShape,
  imageImportFailure,
  ACCESS_ERROR_CODES,
  BUSY_ERROR_CODES,
  MISSING_ERROR_CODES,
  SYSTEM_ERROR_CODES
};
