const SIZE_SCALES = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4]);
const DEFAULT_SIZE_LEVEL = 4;

function isSizeLevel(level) {
  return Number.isInteger(level) && level >= 1 && level <= SIZE_SCALES.length;
}

function sizeLevelFromPreferences(preferences = {}) {
  if (isSizeLevel(preferences.sizeLevel)) return preferences.sizeLevel;
  // Keep the same size when loading settings saved before size levels existed.
  const legacyIndex = SIZE_SCALES.findIndex(scale => Math.abs(scale - preferences.scale) < 0.001);
  return legacyIndex >= 0 ? legacyIndex + 1 : DEFAULT_SIZE_LEVEL;
}

function scaleForLevel(level) {
  return SIZE_SCALES[(isSizeLevel(level) ? level : DEFAULT_SIZE_LEVEL) - 1];
}

module.exports = { SIZE_SCALES, DEFAULT_SIZE_LEVEL, isSizeLevel, sizeLevelFromPreferences, scaleForLevel };
