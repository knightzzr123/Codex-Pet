const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectPackageTree, writeFixturePackage, runSelfCheck, simulateInstall, simulateUninstall, simulateUpgrade, verifySha256Sums
} = require('../tools/release-check.cjs');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('SHA256SUMS 同时接受 LF 与 CRLF 换行，并继续校验内容', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-sums-'));
  try {
    const root = writeFixturePackage(path.join(base, 'package'), '1.0.0');
    const artifact = path.join(base, '大肥鱼-3.4.0.zip');
    fs.writeFileSync(artifact, 'release-bytes');
    const sums = path.join(base, 'SHA256SUMS');
    const digest = sha256(artifact);
    fs.writeFileSync(sums, `${digest}  ${path.basename(artifact)}\n`);
    let result = verifySha256Sums(root);
    assert.equal(result.checked, true);
    assert.equal(result.verified, 1);
    assert.deepEqual(result.errors, []);

    fs.writeFileSync(sums, `${digest}  ${path.basename(artifact)}\r\n`);
    result = verifySha256Sums(root);
    assert.equal(result.checked, true);
    assert.equal(result.verified, 1);
    assert.deepEqual(result.errors, []);

    fs.writeFileSync(sums, `${'0'.repeat(64)}  ${path.basename(artifact)}\r\n`);
    result = verifySha256Sums(root);
    assert.ok(result.errors.some(error => /不一致/.test(error)));

    fs.writeFileSync(sums, `${digest}  missing.zip\r\n`);
    result = verifySha256Sums(root);
    assert.ok(result.errors.some(error => /不存在/.test(error)));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('打包脚本各自写 LF 的 .sha256，由汇总脚本生成唯一 SHA256SUMS', () => {
  const tools = path.join(__dirname, '..', 'tools');
  const packagePy = fs.readFileSync(path.join(tools, 'package.py'), 'utf8');
  assert.match(packagePy, /output\.name \+ '\.sha256'/);
  assert.match(packagePy, /newline='\\n'/);
  assert.doesNotMatch(packagePy, /['"]SHA256SUMS['"]/);
  const sourcePy = fs.readFileSync(path.join(tools, 'package-source.py'), 'utf8');
  assert.match(sourcePy, /output\.name \+ '\.sha256'/);
  assert.doesNotMatch(sourcePy, /'SHA256SUMS'/);
  const aggregator = fs.readFileSync(path.join(tools, 'write-sha256sums.py'), 'utf8');
  assert.match(aggregator, /dafeiyu-codex-pet-/);
  assert.match(aggregator, /windows-x64/);
  assert.match(aggregator, /source\.zip/);
  assert.match(aggregator, /write_bytes\('\.join|encod/);
});

test('Release 自检覆盖安装、卸载、升级保留数据三条路径', () => {
  const report = runSelfCheck({ keep: true });
  try {
    assert.equal(report.ok, true);
    assert.equal(report.paths.install.ok, true);
    assert.equal(report.paths.uninstall.ok, true);
    assert.equal(report.paths.upgrade.ok, true);
    assert.equal(report.paths.uninstall.dataPreserved, true);
    assert.equal(report.paths.upgrade.dataPreserved, true);
    assert.notEqual(report.paths.upgrade.oldVersion, report.paths.upgrade.newVersion);
    assert.equal(report.packageChecks.checks.type, 'complete');
    const dataFiles = require('../tools/release-check.cjs').DATA_FILES;
    assert.ok(dataFiles.some(name => name.startsWith('skin-packs/')));
    assert.ok(dataFiles.includes('settings.json'));
    assert.equal(dataFiles.includes('dafeiyu-preferences.json'), false);
  } finally { fs.rmSync(report.baseDir, { recursive: true, force: true }); }
});

test('源码包或被篡改的包不能通过 Release 自检', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-release-invalid-'));
  try {
    writeFixturePackage(root, '1.0.0');
    fs.writeFileSync(path.join(root, 'PACKAGE-TYPE.json'), JSON.stringify({ packageType: 'source', installable: false }) + '\n');
    let result = inspectPackageTree(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /packageType=complete/.test(error)));

    writeFixturePackage(root, '1.0.0');
    fs.writeFileSync(path.join(root, 'src', 'plugin-server.cjs'), 'tampered');
    result = inspectPackageTree(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /FILES\.sha256 校验失败/.test(error)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('模拟卸载误删用户数据会被自检拒绝；升级保留设置/皮肤/台词', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-release-paths-'));
  try {
    const oldRoot = writeFixturePackage(path.join(base, 'old'), '1.0.0');
    const newRoot = writeFixturePackage(path.join(base, 'new'), '1.1.0');
    const installDir = path.join(base, 'install'); const dataDir = path.join(base, 'data');
    const install = simulateInstall({ packageRoot: oldRoot, installDir, dataDir });
    assert.equal(install.ok, true);
    const uninstall = simulateUninstall({ installDir, dataDir, expectedData: install.data, deleteData: true });
    assert.equal(uninstall.ok, false);
    assert.equal(uninstall.dataPreserved, false);

    const upgrade = simulateUpgrade({ oldPackageRoot: oldRoot, newPackageRoot: newRoot,
      installDir: path.join(base, 'upgraded'), dataDir: path.join(base, 'upgrade-data') });
    assert.equal(upgrade.ok, true);
    assert.equal(upgrade.oldVersion, '1.0.0');
    assert.equal(upgrade.newVersion, '1.1.0');
    assert.equal(upgrade.dataPreserved, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
