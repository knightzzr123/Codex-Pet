const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const expected = '3.3.2';

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

test('package and plugin metadata versions are 3.3.2 and consistent', () => {
  const versions = [
    readJson('package.json').version,
    readJson('plugin.json').version,
    readJson('.codex-plugin/plugin.json').version,
  ];
  assert.deepEqual(versions, [expected, expected, expected]);
});

test('MCP clientInfo versions and package.py default match 3.3.2', () => {
  const files = {
    'src/quota.cjs': "const { version } = require('../package.json');",
    'src/register-native-startup.cjs': "version: '3.3.2'",
    'src/startup-smoke.cjs': "version: '3.3.2'",
    'src/native-catalog-smoke.cjs': "version: '3.3.2'",
    'src/plugin-server.cjs': 'name:"dafeiyu-codex-pet",version:"3.3.2"',
    'tools/package.py': "parser.add_argument('--version', default='3.3.2')",
  };
  for (const [relative, needle] of Object.entries(files)) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(text.includes(needle), `${relative} should contain ${needle}`);
    if (relative !== 'src/quota.cjs') {
      assert.equal((text.match(/3\.3\.0/g) || []).length, 0, `${relative} still mentions 3.3.0`);
    }
  }
  // quota.cjs must keep reading package.json rather than a stale literal
  assert.equal(readJson('package.json').version, expected);
});
