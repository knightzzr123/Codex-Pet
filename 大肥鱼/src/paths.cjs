const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function getDataDir(root, env = process.env) {
  if (env.DAFEIYU_DATA_DIR) return path.resolve(env.DAFEIYU_DATA_DIR);
  // Source checkouts keep their existing settings; installed packages keep
  // writable state outside the plugin cache so upgrades do not erase it.
  if (!fs.existsSync(path.join(root, 'plugin.json'))) return path.join(root, 'data');
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DafeiyuCodexPet');
}

function getWorkDir(root, env = process.env) {
  if (env.DAFEIYU_WORK_DIR) return path.resolve(env.DAFEIYU_WORK_DIR);
  return fs.existsSync(path.join(root, 'plugin.json'))
    ? path.join(getDataDir(root, env), 'work') : path.join(root, 'work');
}

function getElectronExecutable(root) {
  const bundled = path.join(root, 'runtime', 'electron.exe');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
}

module.exports = { getDataDir, getWorkDir, getElectronExecutable };
