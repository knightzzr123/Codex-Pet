const {
  MANIFEST_VERSION, PREFERENCES_BUNDLE_KIND, assertManifestVersion
} = require('./manifests.cjs');
const { experienceFromPreferences } = require('./experience.cjs');
const { sizeLevelFromPreferences } = require('./size.cjs');
const { DEFAULT_SKIN_ID } = require('./settings-ia.cjs');

const PREFERENCES_FILE_NAME = 'dafeiyu-preferences.json';
const PREFERENCES_FILE_MAX_BYTES = 256 * 1024;
const PORTABLE_SETTING_KEYS = Object.freeze([
  'skinId', 'sizeLevel', 'bubbleSeconds', 'advanceOnPetTap', 'mirrorOnLeft', 'reducedMotion',
  'bubbleOffsetX', 'bubbleOffsetY', 'idleIntervalSec', 'opacity'
]);
const BUNDLE_KINDS = Object.freeze(['builtin', 'image', 'pack']);

function publicCatalog(catalog = []) {
  const seen = new Set();
  return (Array.isArray(catalog) ? catalog : []).flatMap(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{
      id: entry.id.slice(0, 200),
      name: entry.name.trim().slice(0, 80),
      kind: BUNDLE_KINDS.includes(entry.kind) ? entry.kind : 'pack'
    }];
  });
}

// Exports portable preferences and the *catalog* of skin names/IDs only.
// Image bytes, thumbnail bytes, file URLs, window placement and custom
// dialogue text are deliberately outside the boundary.
function buildPreferencesBundle(preferences = {}, catalog = [], { exportedAt = new Date().toISOString() } = {}) {
  const experience = experienceFromPreferences(preferences);
  return {
    manifestVersion: MANIFEST_VERSION,
    kind: PREFERENCES_BUNDLE_KIND,
    exportedAt,
    note: '仅包含设置与皮肤/角色清单，不包含任何图片、缩略图、本地路径或自定义台词。',
    settings: {
      skinId: typeof preferences.skinId === 'string' && preferences.skinId ? preferences.skinId : DEFAULT_SKIN_ID,
      sizeLevel: sizeLevelFromPreferences(preferences),
      ...experience
    },
    skins: {
      selected: typeof preferences.skinId === 'string' && preferences.skinId ? preferences.skinId : DEFAULT_SKIN_ID,
      catalog: publicCatalog(catalog)
    }
  };
}

function parsePreferencesBundle(input, { catalog = [] } = {}) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > PREFERENCES_FILE_MAX_BYTES) throw new Error('偏好文件过大。');
    try { value = JSON.parse(input.replace(/^\uFEFF/, '')); }
    catch { throw new Error('偏好文件不是有效的 JSON。'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('偏好文件需要是对象。');
  if (value.kind !== PREFERENCES_BUNDLE_KIND) throw new Error('这不是大肥鱼偏好文件。');
  assertManifestVersion(value.manifestVersion, '偏好文件');
  const raw = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)
    ? value.settings : {};
  const picked = {};
  for (const key of PORTABLE_SETTING_KEYS) if (Object.hasOwn(raw, key)) picked[key] = raw[key];
  const experience = experienceFromPreferences(picked);
  const warnings = [];
  let skinId = typeof picked.skinId === 'string' && picked.skinId ? picked.skinId : DEFAULT_SKIN_ID;
  const ids = new Set(publicCatalog(catalog).map(entry => entry.id));
  if (ids.size && !ids.has(skinId)) {
    warnings.push(`导出文件中的皮肤“${skinId.slice(0, 80)}”在本机不存在，已回退到默认角色。`);
    skinId = DEFAULT_SKIN_ID;
  }
  const ignoredKeys = Object.keys(raw).filter(key => !PORTABLE_SETTING_KEYS.includes(key));
  return {
    manifestVersion: MANIFEST_VERSION,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    settings: { skinId, sizeLevel: sizeLevelFromPreferences(picked), ...experience },
    skins: {
      selected: skinId,
      catalog: publicCatalog(catalog),
      exportedCatalogCount: Array.isArray(value.skins?.catalog) ? value.skins.catalog.length : 0
    },
    warnings,
    ignoredKeys
  };
}

module.exports = {
  PREFERENCES_FILE_NAME,
  PREFERENCES_FILE_MAX_BYTES,
  PORTABLE_SETTING_KEYS,
  buildPreferencesBundle,
  parsePreferencesBundle,
  publicCatalog
};
