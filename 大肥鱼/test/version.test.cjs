const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { version, DISPLAY_VERSION } = require('../src/version-info.cjs');

const root = path.resolve(__dirname, '..');
const expected = '3.4.0';

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

test('package and plugin metadata versions are 3.4.0 and consistent', () => {
  const versions = [
    readJson('package.json').version,
    readJson('plugin.json').version,
    readJson('.codex-plugin/plugin.json').version,
  ];
  assert.deepEqual(versions, [expected, expected, expected]);
  assert.equal(version, expected);
  assert.equal(DISPLAY_VERSION, 'Codex-Pet-V1.4');
});

test('MCP clientInfo versions and package.py default match 3.4.0', () => {
  const files = {
    'src/quota.cjs': "const { version } = require('../package.json');",
    'src/register-native-startup.cjs': "version: '3.4.0'",
    'src/startup-smoke.cjs': "version: '3.4.0'",
    'src/native-catalog-smoke.cjs': "version: '3.4.0'",
    'src/plugin-server.cjs': 'name:"dafeiyu-codex-pet",version:"3.4.0"',
    'tools/package.py': "parser.add_argument('--version', default='3.4.0')",
  };
  for (const [relative, needle] of Object.entries(files)) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(text.includes(needle), `${relative} should contain ${needle}`);
    if (relative !== 'src/quota.cjs') {
      assert.equal((text.match(/3\.3\.2/g) || []).length, 0, `${relative} still mentions 3.3.2`);
      assert.equal((text.match(/3\.3\.0/g) || []).length, 0, `${relative} still mentions 3.3.0`);
    }
  }
  // quota.cjs must keep reading package.json rather than a stale literal
  assert.equal(readJson('package.json').version, expected);
});

test('版本规则写明展示版升次版本号、热修复升修订号', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'VERSIONING.md'), 'utf8');
  assert.match(doc, /V1\.4` = `3\.4\.0/);
  assert.match(doc, /V1\.5` = `3\.5\.0/);
  assert.match(doc, /热修复只升修订号/);
  assert.match(doc, /package\.json/);
  assert.match(doc, /plugin\.json/);
  assert.match(doc, /clientInfo/);
  assert.match(doc, /package\.py/);
});
