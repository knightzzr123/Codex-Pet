const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir, getWorkDir } = require('../src/paths.cjs');

const requiredFiles = ['plugin.json', 'prepare-runtime.ps1', 'runtime-manifest.json', 'src/plugin-server.cjs', '.agents/plugins/marketplace.json', 'package.json', 'README.md'];
const artifactNames = ['smoke-report.json', 'startup-smoke-report.json', 'startup-error.txt', 'scope-status.json', 'runtime.json', 'startup-timing.json', '.dafeiyu-ready.json'];
const exists = (file) => { try { return fs.existsSync(file); } catch { return false; } };
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function findCodex(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const dir of (env.PATH || '').split(path.delimiter)) for (const name of names) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function buildReport(root, options = {}) {
  const env = options.env || process.env;
  const report = { root: path.resolve(root), ok: true, errors: [], warnings: [], checks: {}, artifacts: [], codex: {} };
  const addError = (message) => report.errors.push(message);
  const markerPath = path.join(root, 'PACKAGE-TYPE.json');
  let marker = null;
  if (exists(markerPath)) { try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { addError('PACKAGE-TYPE.json 无法解析'); } }
  const archive = path.join(root, 'runtime.7z');
  const runtimeDir = path.join(root, 'runtime');
  const complete = marker?.packageType === 'complete';
  const source = marker?.packageType === 'source' || (!marker && !exists(archive) && !exists(runtimeDir));
  const conflicting = marker && !['source', 'complete'].includes(marker.packageType);
  if (conflicting) addError('PACKAGE-TYPE.json 的 packageType 无效');
  if (marker?.packageType === 'source' && (exists(archive) || exists(runtimeDir))) addError('源码类型标记与 runtime 资产冲突');
  if (marker?.packageType === 'complete' && !exists(archive)) addError('标记为 complete，但缺少 runtime.7z');
  if (!marker && exists(runtimeDir) && !exists(archive)) addError('存在已展开 runtime/，但缺少完整包运行时归档或类型标记');
  if (!marker && exists(archive) && !exists(runtimeDir)) report.warnings.push('存在 runtime.7z，但缺少 PACKAGE-TYPE.json');
  report.checks.packageType = source ? 'source' : complete ? 'complete' : 'ambiguous';
  if (source) report.warnings.push('源码树，运行时未准备');
  for (const relative of requiredFiles) if (!exists(path.join(root, relative))) addError(`缺少必需文件：${relative}`);
  const versions = {};
  for (const relative of ['plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    const file = path.join(root, relative);
    if (!exists(file)) continue;
    try { versions[relative] = JSON.parse(fs.readFileSync(file, 'utf8')).version; } catch { addError(`${relative} 无法解析`); }
  }
  if (Object.keys(versions).length === 3 && new Set(Object.values(versions)).size !== 1) addError('plugin.json、.codex-plugin/plugin.json 与 package.json 版本不一致');
  report.checks.versions = versions;
  const manifestFile = path.join(root, 'runtime-manifest.json');
  if (exists(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      report.checks.runtimeManifest = { bytes: manifest.bytes, sha256: manifest.sha256 };
      if (exists(archive)) {
        const actualBytes = fs.statSync(archive).size; const actualHash = hashFile(archive);
        report.checks.runtime = { bytes: actualBytes, sha256: actualHash };
        if (actualBytes !== manifest.bytes) addError('runtime.7z 大小与 manifest 不符');
        if (actualHash !== manifest.sha256) addError('runtime.7z SHA-256 与 manifest 不符');
      }
    } catch { addError('runtime-manifest.json 无法解析'); }
  }
  const dataDir = getDataDir(root, env); const workDir = getWorkDir(root, env);
  for (const base of new Set([workDir, dataDir])) for (const name of artifactNames) {
    const file = path.join(base, name);
    if (exists(file) && fs.statSync(file).isFile()) report.artifacts.push({ path: file, sha256: hashFile(file) });
  }
  const codexPath = (options.findCodex || findCodex)(env, options.platform || process.platform);
  report.codex = codexPath ? { status: 'found', path: codexPath, inspection: '未执行命令；未读取或更改配置' } : { status: 'not-found', inspection: '未找到/跳过；未执行命令' };
  if (options.platform === 'win32' || (!options.platform && process.platform === 'win32')) report.warnings.push('Codex 配置检查属于 Windows 专用项目');
  report.ok = report.errors.length === 0;
  return report;
}

function run(argv = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..');
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
  const report = buildReport(root);
  console.log(`大肥鱼只读诊断：${report.ok ? '通过' : '发现错误'}（${report.checks.packageType}）`);
  for (const warning of report.warnings) console.log(`警告：${warning}`);
  for (const error of report.errors) console.log(`错误：${error}`);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
if (require.main === module) process.exitCode = run();
module.exports = { buildReport, findCodex, run };
