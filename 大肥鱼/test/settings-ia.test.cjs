const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_EXPERIENCE, DEFAULT_SIZE_LEVEL, SETTINGS_GROUPS, GROUP_KEYS, ALL_RESET_KEYS,
  resetGroup, resetAll, resetPreferenceKeys, isDefaultSetting, settingsKeyDefault
} = require('../src/settings-ia.cjs');
const { OPACITY_MIN } = require('../src/experience.cjs');

test('IA 2.0 分组包含外观/对话/行为/显示且覆盖可重置项', () => {
  assert.deepEqual(SETTINGS_GROUPS.map(group => group.id), ['appearance', 'dialogue', 'behavior', 'visibility']);
  assert.deepEqual(GROUP_KEYS.appearance, ['skinId', 'sizeLevel']);
  assert.ok(GROUP_KEYS.dialogue.includes('bubbleSeconds'));
  assert.ok(GROUP_KEYS.behavior.includes('idleIntervalSec'));
  assert.deepEqual(GROUP_KEYS.visibility, ['opacity']);
  assert.ok(ALL_RESET_KEYS.includes('opacity'));
  assert.ok(ALL_RESET_KEYS.includes('reducedMotion'));
  assert.equal(settingsKeyDefault('opacity'), 1);
  assert.ok(settingsKeyDefault('opacity') >= OPACITY_MIN);
  assert.equal(settingsKeyDefault('sizeLevel'), DEFAULT_SIZE_LEVEL);
  assert.equal(settingsKeyDefault('skinId'), 'default');
});

test('单项重置只改目标键，保留位置、台词和其他分组', () => {
  const preferences = {
    placement: { right: 40, bottom: 18, anchorX: 'left' }, skinId: 'rose', sizeLevel: 9,
    dialogues: { speech: ['自定义'], sleepy: [] }, bubbleSeconds: 15, advanceOnPetTap: true,
    bubbleOffsetX: 12, bubbleOffsetY: -8, idleIntervalSec: 90, mirrorOnLeft: false,
    reducedMotion: true, opacity: 0.5
  };
  const single = resetPreferenceKeys(preferences, ['opacity']);
  assert.deepEqual(single.changed, ['opacity']);
  assert.equal(single.preferences.opacity, 1);
  assert.deepEqual(single.preferences.placement, preferences.placement);
  assert.deepEqual(single.preferences.dialogues, preferences.dialogues);
  assert.equal(single.preferences.bubbleSeconds, 15);

  const dialogue = resetGroup(preferences, 'dialogue');
  assert.deepEqual(dialogue.preferences.dialogues, preferences.dialogues);
  assert.equal(dialogue.preferences.bubbleSeconds, 8);
  assert.equal(dialogue.preferences.advanceOnPetTap, false);
  assert.equal(dialogue.preferences.bubbleOffsetX, 0);
  assert.equal(dialogue.preferences.skinId, 'rose');
});

test('恢复默认覆盖全部可调项但保留位置和自定义台词', () => {
  const preferences = {
    placement: { right: 12, bottom: 8 }, skinId: 'rose', sizeLevel: 10,
    dialogues: { speech: ['保留我'], sleepy: ['也保留'] }, bubbleSeconds: 0, advanceOnPetTap: true,
    bubbleOffsetX: 30, bubbleOffsetY: 30, idleIntervalSec: 300, mirrorOnLeft: false,
    reducedMotion: true, opacity: 0.35
  };
  const result = resetAll(preferences);
  assert.equal(result.preferences.skinId, 'default');
  assert.equal(result.preferences.sizeLevel, DEFAULT_SIZE_LEVEL);
  assert.equal(result.preferences.bubbleSeconds, DEFAULT_EXPERIENCE.bubbleSeconds);
  assert.equal(result.preferences.opacity, 1);
  assert.ok(result.preferences.opacity >= OPACITY_MIN);
  assert.deepEqual(result.preferences.placement, preferences.placement);
  assert.deepEqual(result.preferences.dialogues, preferences.dialogues);
  assert.deepEqual(result.changed.length, ALL_RESET_KEYS.filter(key => key !== 'dialogues').length);
});

test('默认值可重复应用且非法键不产生改动', () => {
  const preferences = { ...DEFAULT_EXPERIENCE, skinId: 'default', sizeLevel: DEFAULT_SIZE_LEVEL };
  const again = resetAll(preferences);
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.preferences, preferences);
  assert.equal(isDefaultSetting(preferences, 'opacity'), true);
  assert.equal(isDefaultSetting(preferences, 'nope'), true);
  assert.deepEqual(resetPreferenceKeys(preferences, ['nope']).changed, []);
});

test('面板与主进程接线包含单项重置、分组重置和恢复默认', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  for (const group of ['appearance', 'dialogue', 'behavior', 'visibility']) {
    assert.match(html, new RegExp(`data-reset-group="${group}"`));
  }
  assert.match(html, /id="settings-reset-all"/);
  assert.match(html, /data-bubble-seconds="15"/);
  assert.match(main, /pet:reset-setting/);
  assert.match(main, /pet:reset-group/);
  assert.match(main, /pet:reset-all/);
  assert.match(preload, /resetSetting/);
  assert.match(preload, /resetGroup/);
  assert.match(preload, /resetAll/);
  assert.match(renderer, /data-reset-key/);
  assert.match(renderer, /data-reset-group/);
});
