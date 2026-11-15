const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildPreferencesBundle, parsePreferencesBundle, publicCatalog,
  PREFERENCES_FILE_NAME, PREFERENCES_FILE_MAX_BYTES
} = require('../src/preferences-bundle.cjs');
const { MANIFEST_VERSION, PREFERENCES_BUNDLE_KIND } = require('../src/manifests.cjs');

const catalog = [
  { id: 'default', name: '默认 · 鲸鱼娘', kind: 'builtin', url: 'file:///secret/pet.png' },
  { id: 'rose', name: '紫角玫瑰 · 半身', kind: 'image', url: 'file:///secret/rose.png' },
  { id: `pack:${'a'.repeat(64)}:whale`, name: '测试包 · 鲸鱼', kind: 'pack', thumbnailUrl: 'file:///secret/thumb.png' }
];

const preferences = {
  placement: { right: 9, bottom: 8, anchorX: 'left' },
  dialogues: { speech: ['私人台词'], sleepy: ['收尾'] },
  skinId: 'rose', sizeLevel: 7, bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false,
  reducedMotion: true, bubbleOffsetX: 12, bubbleOffsetY: -6, idleIntervalSec: 60, opacity: 0.7,
  unknownInternalField: 'do-not-export'
};

test('导出只包含白名单设置与皮肤清单，不含图片、路径、台词或窗口位置', () => {
  const bundle = buildPreferencesBundle(preferences, catalog, { exportedAt: '2026-11-16T00:00:00.000Z' });
  assert.equal(bundle.kind, PREFERENCES_BUNDLE_KIND);
  assert.equal(bundle.manifestVersion, MANIFEST_VERSION);
  assert.deepEqual(bundle.settings, {
    skinId: 'rose', sizeLevel: 7, bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false,
    reducedMotion: true, bubbleOffsetX: 12, bubbleOffsetY: -6, idleIntervalSec: 60, opacity: 0.7
  });
  assert.equal(bundle.skins.selected, 'rose');
  assert.deepEqual(bundle.skins.catalog, catalog.map(({ id, name, kind }) => ({ id, name, kind })));
  const text = JSON.stringify(bundle);
  for (const forbidden of ['placement', 'dialogues', '私人台词', 'base64', 'data:', 'file://', 'secret', 'unknownInternalField']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('导入时重新钳制设置，忽略台词/位置/未知字段，越界值回默认', () => {
  const parsed = parsePreferencesBundle(JSON.stringify({
    kind: PREFERENCES_BUNDLE_KIND, manifestVersion: 1,
    settings: {
      skinId: 'rose', sizeLevel: 99, bubbleSeconds: 3, opacity: 0.05, idleIntervalSec: 1,
      bubbleOffsetX: 999, advanceOnPetTap: 'yes', idleInterval: 20,
      dialogues: { speech: ['不应导入'] }, placement: { right: 1 }, extra: 'ignored'
    }
  }), { catalog });
  assert.equal(parsed.settings.sizeLevel, 4);
  assert.equal(parsed.settings.bubbleSeconds, 8);
  assert.equal(parsed.settings.opacity, 0.35);
  assert.equal(parsed.settings.idleIntervalSec, 5);
  assert.equal(parsed.settings.bubbleOffsetX, 48);
  assert.equal(parsed.settings.advanceOnPetTap, false);
  assert.equal(parsed.settings.skinId, 'rose');
  assert.ok(parsed.ignoredKeys.includes('dialogues'));
  assert.ok(parsed.ignoredKeys.includes('placement'));
  assert.equal(parsed.skins.catalog.length, 3);
});

test('本机没有导出文件中的皮肤时回退默认并给出提示', () => {
  const parsed = parsePreferencesBundle({
    kind: PREFERENCES_BUNDLE_KIND, manifestVersion: 1, settings: { skinId: 'missing-pack', opacity: 0.8 }
  }, { catalog });
  assert.equal(parsed.settings.skinId, 'default');
  assert.equal(parsed.settings.opacity, 0.8);
  assert.match(parsed.warnings.join(' '), /不存在/);
});

test('拒绝错误类型、缺失版本、新版本和损坏 JSON，且不返回部分设置', () => {
  for (const bad of [
    '{broken', '[]', {},
    { kind: 'other', manifestVersion: 1 },
    { kind: PREFERENCES_BUNDLE_KIND, manifestVersion: 2 },
    { kind: PREFERENCES_BUNDLE_KIND, manifestVersion: '1' }
  ]) assert.throws(() => parsePreferencesBundle(bad, { catalog }));
  assert.equal(PREFERENCES_FILE_NAME, 'dafeiyu-preferences.json');
  assert.ok(PREFERENCES_FILE_MAX_BYTES <= 256 * 1024);
});

test('皮肤清单去重并丢弃路径字段，清单版本与皮肤包 manifest 对齐', () => {
  const cleaned = publicCatalog([...catalog, ...catalog, { id: '', name: 'x' }, { id: 'x', name: '  ' }]);
  assert.equal(cleaned.length, catalog.length);
  assert.equal(cleaned.every(entry => !('url' in entry) && !('thumbnailUrl' in entry)), true);
  assert.equal(MANIFEST_VERSION, 1);
});

test('设置面板、preload 与主进程接线导入导出，且不打包图片', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src', 'settings-preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8');
  for (const id of ['settings-export-preferences', 'settings-import-preferences']) assert.match(html, new RegExp(id));
  assert.match(main, /buildPreferencesBundle/);
  assert.match(main, /parsePreferencesBundle/);
  assert.match(main, /pet:export-preferences/);
  assert.match(main, /pet:import-preferences/);
  assert.match(preload, /exportPreferences/);
  assert.match(preload, /importPreferences/);
  assert.match(renderer, /settings-export-preferences/);
  assert.match(renderer, /settings-import-preferences/);
  assert.doesNotMatch(main, /showSaveDialog[\s\S]{0,400}readFileSync\(skin/);
});
