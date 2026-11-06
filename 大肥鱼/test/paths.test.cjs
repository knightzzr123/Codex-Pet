const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDataDir, getWorkDir } = require('../src/paths.cjs');

test('已安装包写入 LOCALAPPDATA\\DafeiyuCodexPet，源码检出写项目 data', () => {
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-installed-'));
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-checkout-'));
  try {
    fs.writeFileSync(path.join(installed, 'plugin.json'), '{}');
    const local = 'C:\\Users\\u\\AppData\\Local';
    assert.equal(getDataDir(installed, { LOCALAPPDATA: local }), path.join(local, 'DafeiyuCodexPet'));
    assert.equal(getWorkDir(installed, { LOCALAPPDATA: local }), path.join(local, 'DafeiyuCodexPet', 'work'));
    assert.equal(getDataDir(checkout, {}), path.join(checkout, 'data'));
    assert.equal(getWorkDir(checkout, {}), path.join(checkout, 'work'));
    assert.equal(getDataDir(checkout, { DAFEIYU_DATA_DIR: '/tmp/custom-data' }), path.resolve('/tmp/custom-data'));
  } finally {
    fs.rmSync(installed, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
