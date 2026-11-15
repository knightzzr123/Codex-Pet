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
    grant(filePath) {
      const safe = assertGrantableZipPath(filePath);
      const token = randomUUID();
      grants.set(token, safe);
      return token;
    },
    resolve(token) {
      if (typeof token !== 'string' || !grants.has(token)) {
        const error = new Error('这个压缩包没有经过文件选择或拖放登记，已拒绝。');
        error.code = 'ZIP_UNREGISTERED';
        throw error;
      }
      return grants.get(token);
    },
    forget(token) { grants.delete(token); }
  };
}

module.exports = { assertGrantableZipPath, createZipGrants };
