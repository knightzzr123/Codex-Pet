const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZipBuffer } = require('../src/zip-reader.cjs');
const { SkinPackLibrary } = require('../src/skin-packs.cjs');
const { classifySkinPackPath } = require('../src/skin-pack-session.cjs');

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-malicious-zip-'));
  const script = path.join(__dirname, 'gen-malicious-zips.cjs');
  const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  return { dir, catalog };
}

test('21 个恶意或边界 ZIP 在运行时生成，不把二进制夹具写进仓库', async () => {
  const { dir, catalog } = generate();
  try {
    assert.equal(catalog.length, 21);
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-malicious-lib-'));
    const library = new SkinPackLibrary(libraryRoot);
    const acceptedRead = new Set(['CTRL', 'Z4-BAD-MANIFEST', 'B2-DEEP-JSON']);
    for (const item of catalog) {
      const buffer = fs.readFileSync(path.join(dir, item.file));
      let readError = null;
      try { await readZipBuffer(buffer); }
      catch (error) { readError = error; }
      if (acceptedRead.has(item.id)) assert.equal(readError, null, item.id);
      else assert.ok(readError, `${item.id} 应该在读取时拒绝`);
    }
    const good = fs.readFileSync(path.join(dir, '00-valid-pack.zip'));
    fs.writeFileSync(path.join(libraryRoot, 'good.zip'), good);
    const imported = await library.importZip(path.join(libraryRoot, 'good.zip'), async () => {});
    assert.equal(imported.name, 'QA包装');
    const bad = path.join(dir, '20-bad-manifest-version.zip');
    await assert.rejects(() => library.importZip(bad, async () => {}), /版本不支持/);
    const deepJson = path.join(dir, '13-deep-json-manifest.zip');
    await assert.rejects(() => library.importZip(deepJson, async () => {}), /嵌套过深|版本不支持|无法解析/);
    assert.equal(library.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未登记路径和 UNC / \\\\?\\ 不能进入导入', () => {
  assert.equal(classifySkinPackPath('\\\\server\\share\\pack.zip').code, 'PATH_REJECTED');
  assert.equal(classifySkinPackPath('//server/share/pack.zip').code, 'PATH_REJECTED');
  assert.equal(classifySkinPackPath('\\\\?\\C:\\Temp\\pack.zip').code, 'PATH_REJECTED');
  assert.equal(classifySkinPackPath('\\\\.\\C:\\Temp\\pack.zip').code, 'PATH_REJECTED');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(main, /assertSettingsSender/);
  assert.match(main, /skin-pack:preview/);
  assert.doesNotMatch(main, /function assertZipSelection/);
  assert.doesNotMatch(main, /settings:preview-zip|settings:import-zip|settings:choose-zip/);
});
