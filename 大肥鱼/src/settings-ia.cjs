const {
  BUBBLE_SECONDS, BUBBLE_OFFSET_MIN, BUBBLE_OFFSET_MAX, IDLE_INTERVAL_MIN, IDLE_INTERVAL_MAX,
  OPACITY_MIN, OPACITY_MAX, experienceFromPreferences
} = require('./experience.cjs');
const { DEFAULT_SIZE_LEVEL } = require('./size.cjs');

const DEFAULT_SKIN_ID = 'default';
const COLOR_SCHEMES = Object.freeze(['system', 'light', 'dark']);
const DEFAULT_COLOR_SCHEME = 'system';
const DEFAULT_EXPERIENCE = Object.freeze(experienceFromPreferences({}));
const EXPERIENCE_KEYS = Object.freeze(Object.keys(DEFAULT_EXPERIENCE));
const SETTINGS_GROUPS = Object.freeze([
  Object.freeze({
    id: 'appearance', title: '外观/皮肤', description: '皮肤、大小、透明度与窗口色方案',
    keys: Object.freeze(['skinId', 'sizeLevel', 'opacity', 'colorScheme']),
    items: Object.freeze([
      Object.freeze({ key: 'skinId', label: '皮肤', kind: 'skin' }),
      Object.freeze({ key: 'sizeLevel', label: '大小', kind: 'size' }),
      Object.freeze({ key: 'opacity', label: '透明度', kind: 'range', min: OPACITY_MIN, max: OPACITY_MAX, step: 0.05 }),
      Object.freeze({ key: 'colorScheme', label: '窗口外观', kind: 'segmented', values: COLOR_SCHEMES })
    ])
  }),
  Object.freeze({
    id: 'dialogue', title: '对话/台词', description: '台词、气泡停留与位置',
    keys: Object.freeze(['bubbleSeconds', 'advanceOnPetTap', 'bubbleOffsetX', 'bubbleOffsetY']),
    items: Object.freeze([
      Object.freeze({ key: 'bubbleSeconds', label: '气泡停留', kind: 'enum', values: BUBBLE_SECONDS }),
      Object.freeze({ key: 'advanceOnPetTap', label: '点人物继续对话', kind: 'boolean' }),
      Object.freeze({ key: 'bubbleOffsetX', label: '气泡偏移 X', kind: 'range', min: BUBBLE_OFFSET_MIN, max: BUBBLE_OFFSET_MAX, step: 1 }),
      Object.freeze({ key: 'bubbleOffsetY', label: '气泡偏移 Y', kind: 'range', min: BUBBLE_OFFSET_MIN, max: BUBBLE_OFFSET_MAX, step: 1 })
    ])
  }),
  Object.freeze({
    id: 'behavior', title: '行为/待机', description: '闲置动作与转向',
    keys: Object.freeze(['idleIntervalSec', 'mirrorOnLeft']),
    items: Object.freeze([
      Object.freeze({ key: 'idleIntervalSec', label: '闲置动作间隔', kind: 'range', min: IDLE_INTERVAL_MIN, max: IDLE_INTERVAL_MAX, step: 5 }),
      Object.freeze({ key: 'mirrorOnLeft', label: '贴左侧时转向', kind: 'boolean' })
    ])
  }),
  Object.freeze({
    id: 'accessibility', title: '无障碍', description: '减少动画与读屏说明',
    keys: Object.freeze(['reducedMotion']),
    items: Object.freeze([
      Object.freeze({ key: 'reducedMotion', label: '减少动画', kind: 'boolean' })
    ])
  })
]);
const GROUP_KEYS = Object.freeze({
  ...Object.fromEntries(SETTINGS_GROUPS.map(group => [group.id, group.keys])),
  // Older callers still reset opacity through the retired visibility id.
  visibility: Object.freeze(['opacity'])
});
const ALL_RESET_KEYS = Object.freeze([...new Set(SETTINGS_GROUPS.flatMap(group => group.keys))]);

function keysForGroup(groupId) {
  return GROUP_KEYS[groupId] || [];
}

function normalizeColorScheme(value) {
  return COLOR_SCHEMES.includes(value) ? value : DEFAULT_COLOR_SCHEME;
}

function settingsKeyDefault(key) {
  if (key === 'skinId') return DEFAULT_SKIN_ID;
  if (key === 'sizeLevel') return DEFAULT_SIZE_LEVEL;
  if (key === 'colorScheme') return DEFAULT_COLOR_SCHEME;
  return Object.hasOwn(DEFAULT_EXPERIENCE, key) ? DEFAULT_EXPERIENCE[key] : undefined;
}

// Reset is intentionally non-destructive: placement and user dialogue content
// are kept; only the visual/interaction keys in the selected group change.
function resetPreferenceKeys(preferences = {}, keys = []) {
  const next = { ...preferences };
  const changed = [];
  for (const key of keys) {
    const value = settingsKeyDefault(key);
    if (value === undefined || key === 'dialogues') continue;
    if (next[key] !== value) { next[key] = value; changed.push(key); }
  }
  return { preferences: next, changed };
}

function resetGroup(preferences, groupId) {
  return resetPreferenceKeys(preferences, keysForGroup(groupId));
}

function resetAll(preferences) {
  return resetPreferenceKeys(preferences, ALL_RESET_KEYS);
}

function isDefaultSetting(preferences = {}, key) {
  const value = settingsKeyDefault(key);
  return value === undefined ? true : preferences[key] === value;
}

module.exports = {
  DEFAULT_SKIN_ID,
  DEFAULT_COLOR_SCHEME,
  COLOR_SCHEMES,
  normalizeColorScheme,
  DEFAULT_EXPERIENCE,
  DEFAULT_SIZE_LEVEL,
  EXPERIENCE_KEYS,
  SETTINGS_GROUPS,
  GROUP_KEYS,
  ALL_RESET_KEYS,
  keysForGroup,
  settingsKeyDefault,
  resetPreferenceKeys,
  resetGroup,
  resetAll,
  isDefaultSetting
};
