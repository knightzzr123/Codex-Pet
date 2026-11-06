const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { experienceFromPreferences } = require('../src/experience.cjs');
const { sizeLevelFromPreferences } = require('../src/size.cjs');
const { writeJsonAtomic, createCoalescedWriter } = require('../src/persist.cjs');

function loadPreferences(file) {
  let preferences = { placement: { right: 2, bottom: 2 } };
  try { preferences = { ...preferences, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  preferences.sizeLevel = sizeLevelFromPreferences(preferences);
  Object.assign(preferences, experienceFromPreferences(preferences));
  delete preferences.scale;
  delete preferences.alwaysOnTop;
  delete preferences.enabled;
  delete preferences.bubble;
  return preferences;
}

test('settings.json 往返保留 placement/sizeLevel/skinId/体验与自定义字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-prefs-'));
  const file = path.join(dir, 'settings.json');
  try {
    const saved = {
      placement: { right: 40, bottom: 18, anchorX: 'left', anchorY: null },
      sizeLevel: 6, skinId: 'rose',
      bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false, reducedMotion: true,
      bubbleOffsetX: 8, bubbleOffsetY: -6, idleIntervalSec: 30, opacity: 0.7
    };
    writeJsonAtomic(file, saved);
    const loaded = loadPreferences(file);
    assert.deepEqual(loaded.placement, saved.placement);
    assert.equal(loaded.sizeLevel, 6);
    assert.equal(loaded.skinId, 'rose');
    assert.deepEqual(experienceFromPreferences(loaded), {
      bubbleSeconds: 15, advanceOnPetTap: true, mirrorOnLeft: false, reducedMotion: true,
      bubbleOffsetX: 8, bubbleOffsetY: -6, idleIntervalSec: 30, opacity: 0.7
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏 settings 与非法自定义字段钳制；缺失文件回默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-prefs-bad-'));
  const file = path.join(dir, 'settings.json');
  try {
    fs.writeFileSync(file, '{broken');
    const broken = loadPreferences(file);
    assert.equal(broken.sizeLevel, 4);
    assert.deepEqual(broken.placement, { right: 2, bottom: 2 });
    assert.equal(broken.bubbleSeconds, 8);

    const missing = loadPreferences(path.join(dir, 'nope.json'));
    assert.equal(missing.sizeLevel, 4);

    writeJsonAtomic(file, {
      sizeLevel: 'huge', bubbleSeconds: -1, opacity: 0, bubbleOffsetX: 99, idleIntervalMs: 1
    });
    const clamped = loadPreferences(file);
    assert.equal(clamped.sizeLevel, 4);
    assert.equal(clamped.bubbleSeconds, 8);
    assert.equal(clamped.opacity, 0.35);
    assert.equal(clamped.bubbleOffsetX, 48);
    assert.equal(clamped.idleIntervalSec, 45);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.cjs 使用合并写入 + 原子落盘，并在退出时 flush', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(source, /createCoalescedWriter/);
  assert.match(source, /writeJsonAtomic\(settingsFile/);
  assert.match(source, /flushPersistentState/);
  assert.match(source, /createDebouncedShowHide/);
  assert.match(source, /scopeStatusWriter/);
  assert.match(source, /clampBounds/);
  assert.doesNotMatch(source, /function savePreferences\(\) \{\s*fs\.mkdirSync\([\s\S]*?fs\.writeFileSync\(settingsFile/);
});

test('合并写入器在多次 schedule 后只保留最后快照', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-coal-'));
  const file = path.join(dir, 'settings.json');
  try {
    const writer = createCoalescedWriter({
      delayMs: 10_000,
      write: snapshot => writeJsonAtomic(file, snapshot)
    });
    writer.schedule({ opacity: 0.4 });
    writer.schedule({ opacity: 0.9, bubbleOffsetX: 3 });
    writer.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { opacity: 0.9, bubbleOffsetX: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
