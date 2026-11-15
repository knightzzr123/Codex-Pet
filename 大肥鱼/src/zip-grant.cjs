const { randomUUID } = require('node:crypto');

function assertGrantableZipPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    const error = new Error('请选择 .zip 皮肤包。');
    error.code = 'ZIP_UNREGISTERED';
    throw error;
  }
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    const error = new Error('不接受以 \\\\ 或 // 开头的网络路径。');
    error.code = 'ZIP_UNC';
    throw error;
  }
  if (!filePath.toLowerCase().endsWith('.zip')) {
    const error = new Error('请选择 .zip 皮肤包。');
    error.code = 'ZIP_FORMAT';
    throw error;
  }
  return filePath;
}

function createZipGrants() {
  const grants = new Map();
  return {
    grant(filePath, options = {}) {
      const kind = options.kind === 'directory' ? 'directory' : 'zip';
      if (typeof filePath === 'string' && (filePath.startsWith('\\\\') || filePath.startsWith('//'))) {
        const error = new Error('不接受以 \\\\ 或 // 开头的网络路径。');
        error.code = 'ZIP_UNC';
        throw error;
      }
      const safe = kind === 'directory' ? filePath : assertGrantableZipPath(filePath);
      const token = randomUUID();
      grants.set(token, { filePath: safe, kind, used: false });
      return token;
    },
    resolve(token) {
      if (typeof token !== 'string' || /[\\/:]/.test(token) || token.toLowerCase().endsWith('.zip') || !grants.has(token)) {
        const error = new Error('导入只接受一次性登记凭证，不接受文件路径。');
        error.code = 'ZIP_UNREGISTERED';
        throw error;
      }
      return grants.get(token);
    },
    forget(token) { grants.delete(token); },
    forgetAll() { grants.clear(); }
  };
}

module.exports = { assertGrantableZipPath, createZipGrants };
