#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED_FILES = ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'src/plugin-server.cjs', 'mcp.json', '.mcp.json', 'PACKAGE-TYPE.json'];
const PACK_ID = 'ab'.repeat(32);
const DATA_FILES = [
  'settings.json', 'dialogues.json', 'skins/custom.png',
  'skin-packs/index.json',
  `skin-packs/${PACK_ID}/manifest.json`,
  `skin-packs/${PACK_ID}/c-0-whale.png`
];

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function safeRelative(name) {
  const normalized = String(name).replace(/\\/g, '/');
  return normalized && !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

function inspectPackageTree(root, { requireComplete = true } = {}) {
  const errors = [];
  const checks = { root: path.resolve(root), required: false, type: null, versions: {}, filesSha256: false, runtime: false };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, errors: [`不是目录：${root}`], checks };
  }
  for (const relative of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`缺少必需文件：${relative}`);
  }
  checks.required = errors.length === 0;
  try {
    const marker = readJson(path.join(root, 'PACKAGE-TYPE.json'));
    checks.type = marker.packageType;
    if (requireComplete && marker.packageType !== 'complete') errors.push('Release 自检要求 packageType=complete');
    if (requireComplete && marker.installable !== true) errors.push('完整包必须标记 installable=true');
    if (marker.packageType === 'complete' && !fs.existsSync(path.join(root, 'runtime.7z'))) errors.push('完整包缺少 runtime.7z');
    if (marker.runtimeSha256 && fs.existsSync(path.join(root, 'runtime.7z'))
      && hashFile(path.join(root, 'runtime.7z')) !== marker.runtimeSha256) errors.push('runtime.7z SHA-256 与包标记不符');
    if (marker.version) checks.markerVersion = marker.version;
  } catch (error) {
    errors.push('PACKAGE-TYPE.json 无法解析：' + error.message);
  }
  for (const relative of ['plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    try { checks.versions[relative] = readJson(path.join(root, relative)).version; }
    catch { errors.push(`${relative} 无法解析`); }
  }
  const versions = Object.values(checks.versions).filter(Boolean);
  if (versions.length && new Set(versions).size !== 1) errors.push('三个元数据文件的版本不一致');
  if (checks.markerVersion && versions.length && versions.some(version => version !== checks.markerVersion)) {
    errors.push('PACKAGE-TYPE.json 版本与元数据版本不一致');
  }
  checks.runtime = fs.existsSync(path.join(root, 'runtime.7z'));
  const checksumFile = path.join(root, 'FILES.sha256');
  if (fs.existsSync(checksumFile)) {
    try {
      const lines = fs.readFileSync(checksumFile, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
        if (!match) { errors.push('FILES.sha256 行格式无效'); break; }
        const [, expected, relative] = match;
        if (!safeRelative(relative)) { errors.push('FILES.sha256 含不安全路径：' + relative); break; }
        const file = path.join(root, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { errors.push('FILES.sha256 指向的文件缺失：' + relative); break; }
        if (hashFile(file) !== expected.toLowerCase()) { errors.push('FILES.sha256 校验失败：' + relative); break; }
      }
      checks.filesSha256 = errors.length === 0;
    } catch (error) { errors.push('FILES.sha256 无法读取：' + error.message); }
  } else {
    errors.push('缺少 FILES.sha256');
  }
  return { ok: errors.length === 0, errors, checks };
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true, dereference: false,
    filter: file => !file.split(path.sep).includes('.git') });
}

function seedUserData(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'skins'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    placement: { right: 2, bottom: 2 }, sizeLevel: 4, skinId: 'rose',
    bubbleSeconds: 15, opacity: 0.7
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'dialogues.json'), JSON.stringify({ speech: ['升级也要保留我'], sleepy: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'skins', 'custom.png'), Buffer.from('fake-png-bytes'));
  const packDir = path.join(dataDir, 'skin-packs', PACK_ID);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({
    manifestVersion: 1, name: '升级保留包', sourceId: 'kept-pack',
    characters: [{ id: 'whale', name: '鲸鱼娘', image: 'c-0-whale.png', thumbnail: null }]
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(packDir, 'c-0-whale.png'), Buffer.from('pack-image-bytes'));
  fs.writeFileSync(path.join(dataDir, 'skin-packs', 'index.json'), JSON.stringify({
    version: 1, packs: [{ id: PACK_ID, name: '升级保留包', manifestVersion: 1 }]
  }, null, 2) + '\n');
}

function snapshotData(dataDir) {
  const snapshot = {};
  for (const relative of DATA_FILES) {
    const file = path.join(dataDir, relative);
    snapshot[relative] = fs.existsSync(file) ? hashFile(file) : null;
  }
  return snapshot;
}

function verifyData(dataDir, expected) {
  const errors = [];
  for (const relative of DATA_FILES) {
    const file = path.join(dataDir, relative);
    if (!fs.existsSync(file)) errors.push('用户数据丢失：' + relative);
    else if (hashFile(file) !== expected[relative]) errors.push('用户数据被改写：' + relative);
  }
  return errors;
}

function simulateInstall({ packageRoot, installDir, dataDir }) {
  const errors = [];
  if (fs.existsSync(installDir)) errors.push('安装目录必须为新目录');
  copyTree(packageRoot, installDir);
  seedUserData(dataDir);
  const inspected = inspectPackageTree(installDir);
  errors.push(...inspected.errors);
  const data = snapshotData(dataDir);
  return { ok: errors.length === 0, errors, data, checkedPackage: inspected };
}

function simulateUninstall({ installDir, dataDir, expectedData, deleteData = false }) {
  const errors = [];
  fs.rmSync(installDir, { recursive: true, force: true });
  if (deleteData) { fs.rmSync(dataDir, { recursive: true, force: true }); errors.push('模拟卸载误删了用户数据'); }
  if (fs.existsSync(installDir)) errors.push('卸载后安装目录仍存在');
  if (!deleteData) errors.push(...verifyData(dataDir, expectedData));
  return { ok: errors.length === 0, errors, dataPreserved: !deleteData && fs.existsSync(dataDir) };
}

function simulateUpgrade({ oldPackageRoot, newPackageRoot, installDir, dataDir }) {
  const errors = [];
  copyTree(oldPackageRoot, installDir);
  seedUserData(dataDir);
  const data = snapshotData(dataDir);
  copyTree(newPackageRoot, installDir);
  const inspected = inspectPackageTree(installDir);
  errors.push(...inspected.errors);
  errors.push(...verifyData(dataDir, data));
  const oldVersion = readJson(path.join(oldPackageRoot, 'plugin.json')).version;
  const newVersion = readJson(path.join(installDir, 'plugin.json')).version;
  if (oldVersion === newVersion) errors.push('升级夹具版本没有变化，无法验证升级路径');
  return { ok: errors.length === 0, errors, oldVersion, newVersion, dataPreserved: errors.length === 0 };
}

function writeFixturePackage(root, version) {
  fs.mkdirSync(root, { recursive: true });
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  write('plugin.json', JSON.stringify({ name: 'dafeiyu-codex-pet', version }, null, 2) + '\n');
  write('.codex-plugin/plugin.json', JSON.stringify({ name: 'dafeiyu-codex-pet', version }, null, 2) + '\n');
  write('package.json', JSON.stringify({ name: 'dafeiyu-codex-pet', version, private: true }, null, 2) + '\n');
  write('src/plugin-server.cjs', '// release-check fixture\n');
  write('mcp.json', JSON.stringify({ mcpServers: { 'codex-pet': { type: 'stdio', command: 'cmd.exe' } } }, null, 2) + '\n');
  write('.mcp.json', JSON.stringify({ mcpServers: { 'codex-pet': { command: 'cmd.exe' } } }, null, 2) + '\n');
  write('runtime.7z', Buffer.from('fixture-runtime'));
  const runtimeSha256 = hashFile(path.join(root, 'runtime.7z'));
  write('PACKAGE-TYPE.json', JSON.stringify({
    packageType: 'complete', installable: true, description: 'fixture', version,
    runtimeBytes: fs.statSync(path.join(root, 'runtime.7z')).size, runtimeSha256
  }, null, 2) + '\n');
  const files = ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'src/plugin-server.cjs', 'mcp.json', '.mcp.json', 'runtime.7z', 'PACKAGE-TYPE.json'];
  write('FILES.sha256', files.sort().map(relative => `${hashFile(path.join(root, relative))}  ${relative}\n`).join(''));
  return root;
}

function verifySha256Sums(packageRoot) {
  const errors = [];
  const root = path.resolve(packageRoot);
  const candidates = [path.join(path.dirname(root), 'SHA256SUMS'), path.join(root, 'SHA256SUMS')];
  const sumsFile = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!sumsFile) return { checked: false, errors };
  const text = fs.readFileSync(sumsFile, 'utf8');
  if (text.includes('\r')) errors.push('SHA256SUMS 必须使用 LF 换行');
  const dir = path.dirname(sumsFile);
  let verified = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) { errors.push('SHA256SUMS 行格式无效'); continue; }
    const file = path.join(dir, match[2]);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errors.push('SHA256SUMS 指向的产物不存在：' + match[2]);
      continue;
    }
    verified += 1;
    if (hashFile(file) !== match[1]) errors.push('SHA256SUMS 与产物不一致：' + match[2]);
  }
  if (!verified) errors.push('SHA256SUMS 没有可校验的产物');
  return { checked: true, errors, verified };
}

function runSelfCheck({ packageRoot, oldPackageRoot, baseDir, keep = false, requireComplete = true } = {}) {
  const ownsTemp = !baseDir;
  const temp = baseDir ? path.resolve(baseDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-release-check-'));
  fs.mkdirSync(temp, { recursive: true });
  const generated = !packageRoot;
  const oldRoot = oldPackageRoot ? path.resolve(oldPackageRoot) : writeFixturePackage(path.join(temp, 'old-package'), '0.0.0-check-old');
  const newRoot = packageRoot ? path.resolve(packageRoot) : writeFixturePackage(path.join(temp, 'new-package'), '0.0.0-check-new');
  const installDir = path.join(temp, 'install');
  const dataDir = path.join(temp, 'data');
  const report = { ok: false, baseDir: temp, package: newRoot, oldPackage: oldRoot, generated, paths: {}, errors: [] };
  try {
    const inspected = inspectPackageTree(newRoot, { requireComplete });
    report.packageChecks = inspected;
    if (packageRoot) {
      const sums = verifySha256Sums(newRoot);
      report.sha256sums = sums;
      if (sums.checked) report.errors.push(...sums.errors);
    }
    if (!inspected.ok) { report.errors.push(...inspected.errors); return report; }

    const install = simulateInstall({ packageRoot: newRoot, installDir, dataDir });
    report.paths.install = { ok: install.ok, errors: install.errors };
    if (!install.ok) report.errors.push(...install.errors.map(error => `安装：${error}`));

    const data = install.data;
    const uninstall = simulateUninstall({ installDir, dataDir, expectedData: data });
    report.paths.uninstall = { ok: uninstall.ok, errors: uninstall.errors, dataPreserved: uninstall.dataPreserved };
    if (!uninstall.ok) report.errors.push(...uninstall.errors.map(error => `卸载：${error}`));

    const upgrade = simulateUpgrade({ oldPackageRoot: oldRoot, newPackageRoot: newRoot, installDir, dataDir });
    report.paths.upgrade = { ok: upgrade.ok, errors: upgrade.errors, oldVersion: upgrade.oldVersion,
      newVersion: upgrade.newVersion, dataPreserved: upgrade.dataPreserved };
    if (!upgrade.ok) report.errors.push(...upgrade.errors.map(error => `升级：${error}`));

    report.ok = report.errors.length === 0 && report.paths.install.ok && report.paths.uninstall.ok && report.paths.upgrade.ok;
    return report;
  } finally {
    if (!keep && ownsTemp) {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    }
  }
}

function run(argv = process.argv.slice(2)) {
  let packageRoot = null, oldPackageRoot = null, keep = false, reportFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) packageRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--old' && argv[i + 1]) oldPackageRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--keep') keep = true;
    else if (argv[i] === '--report' && argv[i + 1]) reportFile = path.resolve(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('用法：node tools/release-check.cjs [--package 解压后的完整包] [--old 旧包] [--keep] [--report JSON]');
      return 0;
    }
  }
  if (packageRoot && fs.existsSync(packageRoot) && fs.statSync(packageRoot).isFile()) {
    console.error('请先解压完整包，再传入解压目录；Release 自检不直接解 ZIP。');
    return 1;
  }
  const report = runSelfCheck({ packageRoot, oldPackageRoot, keep });
  for (const [name, result] of Object.entries(report.paths)) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.dataPreserved === false ? '（用户数据未保留）' : ''}`);
    for (const error of result.errors || []) console.log(`  ${error}`);
  }
  for (const error of report.errors || []) console.log(`错误：${error}`);
  console.log(JSON.stringify({ ok: report.ok, package: report.package, oldPackage: report.oldPackage,
    paths: Object.fromEntries(Object.entries(report.paths).map(([key, value]) => [key, value.ok])),
    packageChecks: report.packageChecks?.checks, errors: report.errors }, null, 2));
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = run();
module.exports = {
  REQUIRED_FILES, DATA_FILES, inspectPackageTree, copyTree, seedUserData, snapshotData,
  simulateInstall, simulateUninstall, simulateUpgrade, writeFixturePackage, runSelfCheck, run
};
