const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UserFacingError, userError, isUserFacingError, isSystemErrorShape, imageImportFailure
} = require('../src/errors.cjs');

const PNG_BROKEN = '这张图片无法显示，可能已损坏。请换一张图片。';

function neverLog() {
  throw new Error('user-facing failures must not write a diagnostic log');
}

function systemError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

test('imageImportFailure 原样透传解码失败的原文和 SKIN_IMAGE_* code', () => {
  const failure = imageImportFailure(userError(PNG_BROKEN, 'SKIN_IMAGE_UNDECODABLE'), neverLog);
  assert.deepEqual(failure, { ok: false, code: 'SKIN_IMAGE_UNDECODABLE', error: PNG_BROKEN });
});

test('imageImportFailure 原样透传每张图片自己的用户文案', () => {
  const failure = imageImportFailure(userError('图片不能超过 20 MB。', 'IMAGE_INVALID'), neverLog);
  assert.deepEqual(failure, { ok: false, code: 'IMAGE_INVALID', error: '图片不能超过 20 MB。' });
  // userError() without a code keeps the default PACK_INVALID.
  assert.equal(imageImportFailure(userError('请选择图片文件。'), neverLog).code, 'PACK_INVALID');
});

test('ENOENT 换成中文提示并写一条日志，文案不泄露 errno 或路径', () => {
  const logs = [];
  const error = systemError('ENOENT',
    "ENOENT: no such file or directory, open '/home/qa/私人/a.png'",
    { errno: -2, syscall: 'open', path: '/home/qa/私人/a.png' });
  const failure = imageImportFailure(error, entry => logs.push(entry));
  assert.deepEqual(failure, { ok: false, code: 'IMAGE_MISSING', error: '找不到这张图片，请重新选择。' });
  const visible = JSON.stringify(failure);
  assert.doesNotMatch(visible, /ENOENT|\/home|私人|no such file/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'skin-image-error');
  assert.equal(logs[0].code, 'ENOENT');
  assert.equal(logs[0].syscall, 'open');
  assert.match(logs[0].detail, /ENOENT/);
  assert.match(logs[0].detail, /\/home\/qa/);
});

test('EBUSY、EACCES、EPERM 分别给出可操作的提示', () => {
  for (const [code, expected] of [
    ['EBUSY', '文件被占用或没有权限读取，请稍后重试。'],
    ['EACCES', '没有权限读取这张图片。'],
    ['EPERM', '没有权限读取这张图片。']
  ]) {
    const logs = [];
    const failure = imageImportFailure(systemError(code, `${code}: denied`), entry => logs.push(entry));
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'IMAGE_ACCESS');
    assert.equal(failure.error, expected);
    assert.equal(logs.length, 1, code);
    assert.equal(logs[0].code, code);
  }
});

test('错误对象没有 errno/syscall 时仍按 code 集合识别系统错误', () => {
  // A re-wrapped fs error may only keep `code`. That must still use the
  // system copy instead of leaking "ENOTDIR: ..." to the user.
  const logs = [];
  const failure = imageImportFailure({ code: 'ENOTDIR', message: 'ENOTDIR: not a directory' },
    entry => logs.push(entry));
  assert.equal(failure.code, 'IMAGE_MISSING');
  assert.equal(failure.error, '找不到这张图片，请重新选择。');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].code, 'ENOTDIR');
  assert.equal(logs[0].syscall, '');
});

test('其余系统错误给通用读写提示', () => {
  const logs = [];
  const failure = imageImportFailure(systemError('ENOSPC', 'ENOSPC: no space left on device',
    { errno: -28, syscall: 'write' }), entry => logs.push(entry));
  assert.deepEqual(failure, {
    ok: false, code: 'IMAGE_IO', error: '无法读取或保存图片，请确认文件存在且目录可写。'
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].code, 'ENOSPC');
});

test('意外错误不显示英文 message，写日志并给通用提示', () => {
  const logs = [];
  const failure = imageImportFailure(new TypeError('Cannot read properties of undefined'), entry => logs.push(entry));
  assert.deepEqual(failure, { ok: false, code: 'IMAGE_FAILED', error: '无法导入这张图片，请重试。' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'skin-image-error');
  assert.equal(logs[0].code, 'IMAGE_FAILED');
  assert.equal(logs[0].syscall, '');
  assert.match(logs[0].detail, /Cannot read properties/);
});

test('isSystemErrorShape 只认系统错误标记，不误判用户错误', () => {
  assert.equal(isSystemErrorShape(systemError('ENOENT', 'x', { errno: -2 })), true);
  assert.equal(isSystemErrorShape({ code: 'EBUSY' }), true);
  assert.equal(isSystemErrorShape(new UserFacingError('图片不能超过 20 MB。', 'IMAGE_INVALID')), false);
  assert.equal(isSystemErrorShape(new TypeError('boom')), false);
  assert.equal(isSystemErrorShape(null), false);
});

test('用户错误保持 userFacing 标记，可从任意来源识别', () => {
  const error = userError('图片不能超过 20 MB。', 'IMAGE_INVALID');
  assert.equal(error.name, 'UserFacingError');
  assert.equal(error.userFacing, true);
  assert.equal(isUserFacingError(error), true);
  assert.equal(isUserFacingError({ userFacing: true, message: 'x' }), true);
  assert.equal(isUserFacingError(new Error('x')), false);
});
