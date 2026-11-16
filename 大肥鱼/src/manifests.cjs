// Shared, versioned on-disk formats. Both local skin packs and preference
// bundles are local-only documents: there is no store, payment or review code,
// and `store` is reserved metadata that this build never acts on.
const MANIFEST_VERSION = 1;

const SKIN_PACK_KIND = 'dafeiyu.skin-pack';
const PREFERENCES_BUNDLE_KIND = 'dafeiyu.preferences';

const THUMBNAIL_SPEC = Object.freeze({
  // A pack thumbnail is a small square preview. It is optional; when absent the
  // UI falls back to the character image itself.
  formats: Object.freeze(['png', 'jpg', 'webp']),
  square: true,
  minSide: 64,
  maxSide: 256,
  maxBytes: 512 * 1024
});

const SKIN_PACK_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxCharacters: 12,
  maxImageBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  // Folder imports no longer walk the selected tree. Only the manifest and the
  // files it references are lstat'ed (each path segment), and this cap counts
  // those checked paths so a pathological manifest still has a bounded cost.
  maxReferencedPathSegments: 256
});

// One wording for both the folder check and the session fallback; the number
// comes from the constant so it never drifts from the enforced limit.
function referencedPathLimitMessage(limit = SKIN_PACK_LIMITS.maxReferencedPathSegments) {
  return `皮肤包引用的文件或目录路径超过 ${limit} 个，已拒绝导入；请只选择包含 manifest.json 和角色图片的文件夹。`;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

function assertManifestVersion(value, label = '清单') {
  if (!Number.isInteger(value) || value !== MANIFEST_VERSION) {
    throw new Error(`${label}版本不支持：${value === undefined ? '缺少版本号' : value}（本版本仅支持 ${MANIFEST_VERSION}）。`);
  }
}

function assertSlug(value, label) {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw new Error(`${label}只能使用 1–40 位字母、数字、下划线或短横线。`);
  }
  return value;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label}需要是文字。`);
  const text = value.trim();
  if (!text) return '';
  if ([...text].length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 字。`);
  return text;
}

module.exports = {
  MANIFEST_VERSION,
  SKIN_PACK_KIND,
  PREFERENCES_BUNDLE_KIND,
  THUMBNAIL_SPEC,
  SKIN_PACK_LIMITS,
  referencedPathLimitMessage,
  SLUG_PATTERN,
  assertManifestVersion,
  assertSlug,
  optionalText
};
