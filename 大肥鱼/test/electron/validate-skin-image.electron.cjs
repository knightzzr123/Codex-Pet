// Real-Chromium regression test for src/main.cjs:validateSkinImage.
//
// It starts an Electron browser window, extracts the production
// validateSkinImage function from main.cjs, and runs it against the committed
// PNG fixtures. Nothing about image decoding is mocked: createImageBitmap is
// the same renderer API the packaged app uses.
//
// Run from 大肥鱼/ (Linux headless):
//   xvfb-run -a <electron> --no-sandbox --disable-gpu \
//     test/electron/validate-skin-image.electron.cjs
// On Windows/macOS:
//   <electron> test/electron/validate-skin-image.electron.cjs
//
// The npm test suite still covers the PNG fixtures with Node's zlib decoder, so
// this script is an optional real-runtime check for release verification.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'src', 'main.cjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'skin-image');
const PNG_BROKEN = '这张图片无法显示，可能已损坏。请换一张图片。';

app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), `dafeiyu-electron-skin-decode-${process.pid}`));

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

// The function is module-scoped in main.cjs and needs Electron's app lifecycle,
// so the test evaluates the exact shipped source with stubbed dependencies
// (`win` and `logLifecycle`) instead of copying its body into the test.
function extractValidateSkinImage(source) {
  const start = source.indexOf('async function validateSkinImage(bytes, mime) {');
  const end = source.indexOf('async function importSkinFile', start);
  if (start < 0 || end < 0) throw new Error('cannot locate validateSkinImage in main.cjs');
  return source.slice(start, end).trim();
}

function srcRequire(id) {
  if (id === './errors.cjs') return require(path.join(ROOT, 'src', 'errors.cjs'));
  throw new Error(`unexpected require from validateSkinImage: ${id}`);
}

function makeValidator(win, logs) {
  // `userError` is injected explicitly: main.cjs imports it at module scope,
  // which a function body extracted from that module cannot see. Passing it
  // here keeps this test running the exact shipped validateSkinImage source.
  const factory = new Function('win', 'logLifecycle', 'require', 'userError',
    `${extractValidateSkinImage(fs.readFileSync(MAIN, 'utf8'))}\nreturn validateSkinImage;`);
  return factory(win, entry => logs.push(entry), srcRequire, srcRequire('./errors.cjs').userError);
}

// Reproduces the old check (Image.onload) so the test can show why it passed.
async function headerOnlyAccepts(win, bytes) {
  const url = `data:image/png;base64,${bytes.toString('base64')}`;
  return win.webContents.executeJavaScript(`new Promise(resolve => {
    const image = new Image();
    const timer = setTimeout(() => resolve(false), 10000);
    image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0 && image.naturalHeight > 0); };
    image.onerror = () => { clearTimeout(timer); resolve(false); };
    image.src = ${JSON.stringify(url)};
  })`);
}

const passed = [];
function ok(name) { passed.push(name); console.log(`PASS ${name}`); }

async function rejectsBroken(win, fixtureName, expectedCode) {
  const bytes = fixture(fixtureName);
  // Informational: on Electron 33/44 this header-only check wrongly accepts
  // the fixture. It is not asserted so the test stays valid if Chromium later
  // makes Image.onload stricter for damaged PNGs.
  console.log(`INFO ${fixtureName}: old Image.onload accepted=${await headerOnlyAccepts(win, bytes)}`);
  const logs = [];
  const validate = makeValidator(win, logs);
  await assert.rejects(() => validate(bytes, 'image/png'), error => {
    assert.equal(error.name, 'UserFacingError');
    assert.equal(error.userFacing, true);
    // The thrown error carries the decode code so both import paths can report
    // it; the UI still shows the same Chinese sentence.
    assert.equal(error.code, expectedCode);
    assert.equal(error.message, PNG_BROKEN);
    return true;
  });
  assert.equal(logs.length, 1, `${fixtureName} must append exactly one lifecycle entry`);
  assert.equal(logs[0].event, 'skin-pack-error');
  assert.equal(logs[0].code, expectedCode);
  assert.match(logs[0].detail, /InvalidStateError/);
  assert.match(logs[0].detail, /mime=image\/png/);
  assert.equal(logs[0].detail.includes(FIXTURES), false, 'diagnostic detail must not contain a file path');
  assert.equal(logs[0].detail.includes(os.tmpdir()), false, 'diagnostic detail must not contain a temp path');
  return { error: true, logs };
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 320, height: 240 });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body>skin decode</body>');

  const goodBytes = fixture('good.png');
  const goodLogs = [];
  await makeValidator(win, goodLogs)(goodBytes, 'image/png');
  assert.equal(goodLogs.length, 0, 'a decodable image must not log an error');
  ok('正常 PNG 通过 createImageBitmap 解码，不写错误日志');

  await rejectsBroken(win, 'bad-idat.png', 'SKIN_IMAGE_UNDECODABLE');
  ok('IDAT 损坏的 PNG：旧 Image 检查误放行，新校验拒绝并写 skin-pack-error');

  await rejectsBroken(win, 'truncated-idat.png', 'SKIN_IMAGE_UNDECODABLE');
  ok('IDAT 截断的 PNG：新校验拒绝并写 skin-pack-error');

  await rejectsBroken(win, 'truncated-file.png', 'SKIN_IMAGE_UNDECODABLE');
  ok('文件在 IDAT 中间截断：新校验拒绝并写 skin-pack-error');

  const hangingWin = { webContents: { executeJavaScript: () => new Promise(() => {}) } };
  const timeoutLogs = [];
  const started = Date.now();
  await assert.rejects(() => makeValidator(hangingWin, timeoutLogs)(goodBytes, 'image/png'),
    { name: 'UserFacingError', code: 'SKIN_IMAGE_TIMEOUT', message: PNG_BROKEN });
  assert.ok(Date.now() - started >= 9900, 'decode timeout must wait about 10 seconds');
  assert.equal(timeoutLogs.length, 1);
  assert.equal(timeoutLogs[0].event, 'skin-pack-error');
  assert.equal(timeoutLogs[0].code, 'SKIN_IMAGE_TIMEOUT');
  assert.match(timeoutLogs[0].detail, /timed out after 10000 ms/);
  ok('渲染进程忙住时 10 秒超时按失败处理并写 skin-pack-error');

  win.destroy();
  console.log(`\nElectron ${process.versions.electron} / Chromium ${process.versions.chrome}: ${passed.length} checks passed.`);
}

app.whenReady().then(main)
  .then(() => app.exit(0))
  .catch(error => {
    console.error('ELECTRON SKIN DECODE TEST FAILED');
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  });
