const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildReport } = require('../tools/diagnose.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-diagnose-'));
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'prepare-runtime.ps1', 'runtime-manifest.json', 'src/plugin-server.cjs', '.agents/plugins/marketplace.json', 'README.md']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith('.json') ? JSON.stringify({ version: '3.3.1' }) : 'fixture');
  }
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({ bytes: 0, sha256: crypto.createHash('sha256').update('').digest('hex') }));
  return root;
}
const inspect = (root) => buildReport(root, { env: { PATH: '', DAFEIYU_WORK_DIR: path.join(root, 'work'), DAFEIYU_DATA_DIR: path.join(root, 'data') }, findCodex: () => null, platform: 'linux' });

test('source tree without runtime is a passing diagnostic', () => {
  const root = fixture(); const report = inspect(root);
  assert.equal(report.ok, true); assert.equal(report.checks.packageType, 'source');
  assert.match(report.warnings.join(' '), /源码树，运行时未准备/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('complete marker without runtime archive is an error', () => {
  const root = fixture(); fs.writeFileSync(path.join(root, 'PACKAGE-TYPE.json'), JSON.stringify({ packageType: 'complete' }));
  assert.equal(inspect(root).ok, false); fs.rmSync(root, { recursive: true, force: true });
});

test('runtime size and hash mismatch are errors', () => {
  const root = fixture(); fs.writeFileSync(path.join(root, 'runtime.7z'), 'wrong');
  const report = inspect(root); assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => /大小/.test(entry)));
  assert.ok(report.errors.some((entry) => /SHA-256/.test(entry)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing required file is an error', () => {
  const root = fixture(); fs.rmSync(path.join(root, 'prepare-runtime.ps1'));
  assert.ok(inspect(root).errors.some((entry) => /prepare-runtime.ps1/.test(entry)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('diagnostics do not modify existing files and skip absent Codex', () => {
  const root = fixture(); const work = path.join(root, 'work'); fs.mkdirSync(work);
  const reportPath = path.join(work, 'smoke-report.json'); fs.writeFileSync(reportPath, '{"ok":true}\n');
  const before = fs.readFileSync(reportPath); const report = inspect(root);
  assert.deepEqual(fs.readFileSync(reportPath), before);
  assert.equal(report.codex.status, 'not-found'); assert.match(report.codex.inspection, /未执行命令/);
  assert.equal(report.artifacts.length, 1); fs.rmSync(root, { recursive: true, force: true });
});

test('versions that disagree are an error', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const report = inspect(root);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => /版本不一致/.test(entry)));
  fs.rmSync(root, { recursive: true, force: true });
});
