const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectPackageTree, writeFixturePackage, runSelfCheck, simulateInstall, simulateUninstall, simulateUpgrade
} = require('../tools/release-check.cjs');

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
    assert.ok(dataFiles.includes('dafeiyu-preferences.json'));
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
