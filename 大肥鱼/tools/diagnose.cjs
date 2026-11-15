#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const readline = require('node:readline');
const { execFileSync, spawnSync } = require('node:child_process');
const { getDataDir, getWorkDir } = require('../src/paths.cjs');
const { IDLE_BUDGET } = require('../src/idle-budget.js');

const requiredFiles = ['plugin.json', 'prepare-runtime.ps1', 'runtime-manifest.json', 'src/plugin-server.cjs', '.agents/plugins/marketplace.json', 'package.json', 'README.md'];
const artifactNames = ['session-state.json', 'smoke-report.json', 'startup-smoke-report.json', 'startup-error.txt', 'scope-status.json', 'runtime.json', 'startup-timing.json', 'idle-budget.json', '.dafeiyu-ready.json'];
const exists = (file) => { try { return fs.existsSync(file); } catch { return false; } };
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function findCodex(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const dir of (env.PATH || '').split(path.delimiter)) for (const name of names) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function normalizeMcpServers(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.servers)) return parsed.servers;
  if (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    return Object.entries(parsed.mcpServers).map(([name, value]) => ({ name, ...(value || {}) }));
  }
  return [];
}

function isExpectedMcpServer(server) {
  if (!server || typeof server !== 'object') return false;
  const command = Array.isArray(server.command) ? server.command.join(' ') : String(server.command || '');
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const env = server.env && typeof server.env === 'object' ? server.env : {};
  const electron = /electron(?:\.exe)?$/i.test(command) || args.some(arg => /electron(?:\.exe)?$/i.test(arg));
  const plugin = args.some(arg => /plugin-server\.cjs$/i.test(arg)) || command.includes('plugin-server.cjs');
  return electron && plugin && String(env.DAFEIYU_DESKTOP_ONLY) === '1';
}

// Read-only: `codex mcp list --json` never writes configuration. On machines
// without Codex (or an older CLI) this degrades to "unavailable".
function inspectMcpRegistration(codexPath, options = {}) {
  const run = options.execFileSyncImpl || execFileSync;
  try {
    const output = run(codexPath, ['mcp', 'list', '--json'], {
      encoding: 'utf8', timeout: options.timeoutMs || 8000, windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(String(codexPath)),
      env: { ...(options.env || process.env), DAFEIYU_NO_LAUNCH: '1' }
    });
    const servers = normalizeMcpServers(JSON.parse(String(output).replace(/^\uFEFF/, '')));
    const server = servers.find(entry => (entry.name || entry.id || entry.serverName) === 'codex-pet') || null;
    // Do not echo full MCP entries: they can contain environment secrets.
    return { status: server ? (isExpectedMcpServer(server) ? 'ok' : 'mismatch') : 'missing', serverName: server?.name || null, readOnly: true };
  } catch (error) {
    return { status: 'unavailable', serverName: null, error: String(error?.message || error), readOnly: true };
  }
}

function buildReport(root, options = {}) {
  const env = options.env || process.env;
  const report = { root: path.resolve(root), ok: true, errors: [], warnings: [], checks: { idleBudget: IDLE_BUDGET }, artifacts: [], codex: {} };
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
  const codexPath = options.codexPath || (options.findCodex || findCodex)(env, options.platform || process.platform);
  report.codex = codexPath ? { status: 'found', path: codexPath, inspection: '仅只读查询 MCP 登记；未修改配置' } : { status: 'not-found', inspection: '未找到/跳过；未执行命令' };
  if (codexPath && options.inspectMcp !== false) {
    try {
      const inspect = options.inspectMcp || inspectMcpRegistration;
      report.codex.mcp = inspect(codexPath, { root, env, platform: options.platform || process.platform });
      if (!report.codex.mcp || typeof report.codex.mcp !== 'object') throw new Error('invalid MCP inspection result');
      report.checks.mcp = { status: report.codex.mcp.status, readOnly: true };
      if (report.codex.mcp.status === 'missing' || report.codex.mcp.status === 'mismatch') {
        report.warnings.push('Codex 中的 codex-pet MCP 登记缺失或不匹配（可用 --fix 修复）');
      }
      if (report.codex.mcp.status === 'unavailable') report.warnings.push('无法只读查询 Codex MCP 登记');
    } catch (error) {
      report.codex.mcp = { status: 'unavailable', error: String(error?.message || error), readOnly: true };
      report.checks.mcp = { status: 'unavailable', readOnly: true };
      report.warnings.push('无法只读查询 Codex MCP 登记');
    }
  }
  if (options.platform === 'win32' || (!options.platform && process.platform === 'win32')) report.warnings.push('Codex 配置检查属于 Windows 专用项目');
  report.ok = report.errors.length === 0;
  return report;
}

function codexConfigFile(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function markerPayload(root) {
  const archive = path.join(root, 'runtime.7z');
  if (!exists(archive)) return {
    packageType: 'source', installable: false,
    warning: '源码包不包含运行时，不能作为完整安装包直接安装。'
  };
  const manifest = readJson(path.join(root, 'runtime-manifest.json'));
  const bytes = fs.statSync(archive).size;
  const sha256 = hashFile(archive);
  if (bytes !== manifest.bytes || sha256 !== manifest.sha256) {
    throw new Error('runtime.7z 与 runtime-manifest.json 不一致，拒绝写入 complete 标记');
  }
  const version = readJson(path.join(root, 'plugin.json')).version || readJson(path.join(root, 'package.json')).version;
  return {
    packageType: 'complete', installable: true,
    description: 'Win64 完整安装包，包含经过 manifest 校验的运行时。',
    version, runtimeBytes: bytes, runtimeSha256: sha256
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

function backupFile(file, backupDir) {
  if (!exists(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `${path.basename(file)}.${stamp}.bak`);
  fs.copyFileSync(file, target);
  if (!fs.readFileSync(file).equals(fs.readFileSync(target))) throw new Error('备份校验失败：' + target);
  return target;
}

function buildRepairPlan(report, options = {}) {
  const root = report.root;
  const platform = options.platform || process.platform;
  const actions = [];
  const markerPath = path.join(root, 'PACKAGE-TYPE.json');
  const markerExists = exists(markerPath);
  const runtimeDir = path.join(root, 'runtime');
  const archive = path.join(root, 'runtime.7z');
  const extractor = path.join(root, 'tools', '7zip', '7zr.exe');
  const missingFiles = report.errors.filter(message => message.startsWith('缺少必需文件：')).map(message => message.slice('缺少必需文件：'.length));
  const markerBroken = report.errors.some(message => /PACKAGE-TYPE\.json|类型标记/.test(message));
  if (missingFiles.length) {
    actions.push({ id: 'install', title: '安装文件', status: 'blocked',
      reason: `缺少 ${missingFiles.join('、')}；请重新解压完整安装包，诊断不会伪造缺失文件` });
  } else if (markerBroken) {
    actions.push({ id: 'install', title: '安装类型标记', status: 'blocked', reason: 'PACKAGE-TYPE.json 已损坏或与 runtime 资产冲突，需重新解压或手动检查' });
  } else if (!markerExists) {
    if (exists(runtimeDir) && !exists(archive)) {
      actions.push({ id: 'install', title: '安装类型标记', status: 'blocked', reason: '存在 runtime/ 但缺少 runtime.7z，无法判断包类型，请重新解压完整包' });
    } else if (exists(archive)) {
      actions.push({ id: 'install', title: '安装类型标记', status: 'available',
        reason: '补写已校验完整包的 PACKAGE-TYPE.json', apply: 'write-marker' });
    } else {
      actions.push({ id: 'install', title: '安装文件', status: 'ok', reason: '源码树通常不带 PACKAGE-TYPE.json，无需修复' });
    }
  } else {
    actions.push({ id: 'install', title: '安装文件', status: 'ok', reason: '必需文件与类型标记完整' });
  }
  const complete = report.checks.packageType === 'complete';
  if (!complete) {
    actions.push({ id: 'runtime', title: '运行时', status: 'ok', reason: '源码树，无需展开 runtime' });
  } else if (exists(path.join(runtimeDir, 'electron.exe'))) {
    actions.push({ id: 'runtime', title: '运行时', status: 'ok', reason: 'runtime/electron.exe 已就绪' });
  } else if (!exists(archive)) {
    actions.push({ id: 'runtime', title: '运行时', status: 'blocked', reason: '缺少 runtime.7z，无法自动修复' });
  } else if (platform !== 'win32') {
    actions.push({ id: 'runtime', title: '运行时', status: 'blocked', reason: '当前系统不能运行 Windows 的 7zr.exe；请在 Windows 上执行修复' });
  } else if (!exists(extractor)) {
    actions.push({ id: 'runtime', title: '运行时', status: 'blocked', reason: '缺少 tools/7zip/7zr.exe，无法自动解包' });
  } else {
    actions.push({ id: 'runtime', title: '运行时', status: 'available',
      reason: '用 7zr.exe 沙箱解包 runtime.7z，校验 electron.exe 后替换不完整目录', apply: 'extract-runtime' });
  }

  const mcp = report.codex?.mcp;
  if (!report.codex?.path) {
    actions.push({ id: 'mcp', title: 'MCP 登记', status: 'blocked', reason: '未找到 Codex CLI，无法登记 MCP' });
  } else if (mcp?.status === 'ok') {
    actions.push({ id: 'mcp', title: 'MCP 登记', status: 'ok', reason: 'codex-pet 已指向本包的运行时与 plugin-server' });
  } else if (mcp?.status === 'unavailable') {
    actions.push({ id: 'mcp', title: 'MCP 登记', status: 'blocked', reason: `无法只读查询 Codex 配置：${mcp.error || '未知原因'}` });
  } else if (!exists(path.join(runtimeDir, 'electron.exe')) && !actions.some(action => action.id === 'runtime' && action.status === 'available')) {
    actions.push({ id: 'mcp', title: 'MCP 登记', status: 'blocked', reason: '运行时未就绪，先修复 runtime 再登记 MCP' });
  } else {
    actions.push({ id: 'mcp', title: 'MCP 登记', status: 'available',
      reason: '先备份 Codex 配置，再用官方 app-server 登记 codex-pet（幂等，失败回滚）', apply: 'register-mcp' });
  }

  return {
    root, actions,
    available: actions.filter(action => action.status === 'available'),
    blocked: actions.filter(action => action.status === 'blocked')
  };
}

function defaultExtractRuntime(root) {
  const extractor = path.join(root, 'tools', '7zip', '7zr.exe');
  const archive = path.join(root, 'runtime.7z');
  const runtimeDir = path.join(root, 'runtime');
  const manifest = readJson(path.join(root, 'runtime-manifest.json'));
  if (hashFile(extractor) !== manifest.extractorSha256) throw new Error('7zr.exe 校验失败，拒绝执行解包');
  if (hashFile(archive) !== manifest.sha256) throw new Error('runtime.7z 校验失败，拒绝执行解包');
  const stage = path.join(root, `.diagnose-runtime-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stage, { recursive: true });
  try {
    const result = spawnSync(extractor, ['x', archive, '-o' + stage, '-y', '-bd', '-bb0', '-bso0', '-bse2', '-bsp0'],
      { cwd: root, windowsHide: true, timeout: 5 * 60 * 1000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`7zr 解包失败（退出码 ${result.status}）`);
    const staged = path.join(stage, 'runtime');
    if (!exists(path.join(staged, 'electron.exe'))) throw new Error('解包结果缺少 runtime/electron.exe');
    let backup = null;
    if (exists(runtimeDir)) {
      backup = `${runtimeDir}.dafeiyu-backup-${Date.now()}`;
      fs.renameSync(runtimeDir, backup);
    }
    try { fs.renameSync(staged, runtimeDir); }
    catch (error) { if (backup) fs.renameSync(backup, runtimeDir); throw error; }
    return { runtime: runtimeDir, backup };
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

async function defaultRegisterMcp(root, context = {}) {
  const { registerNativeStartup } = require('../src/register-native-startup.cjs');
  return registerNativeStartup(context.codexPath, root);
}

async function applyRepairAction(action, context) {
  if (action.apply === 'write-marker' || action.id === 'install') {
    const markerPath = path.join(context.root, 'PACKAGE-TYPE.json');
    if (exists(markerPath)) return { skipped: true, path: markerPath };
    const payload = markerPayload(context.root);
    writeJsonAtomic(markerPath, payload);
    return { path: markerPath, packageType: payload.packageType };
  }
  if (action.apply === 'extract-runtime' || action.id === 'runtime') {
    return (context.extractRuntime || defaultExtractRuntime)(context.root, context);
  }
  if (action.apply === 'register-mcp' || action.id === 'mcp') {
    const config = context.configFile || codexConfigFile(context.env || process.env);
    const backupDir = context.backupDir || path.join(getDataDir(context.root, context.env || process.env), 'backups');
    const backup = backupFile(config, backupDir);
    try {
      const result = await (context.registerMcp || defaultRegisterMcp)(context.root, context);
      return { ...result, backup };
    } catch (error) {
      if (backup && exists(backup)) {
        try { fs.copyFileSync(backup, config); } catch {}
      }
      throw error;
    }
  }
  throw new Error('未知修复动作：' + action.id);
}

function createRepairLog(file, log) {
  const write = line => {
    const text = `${new Date().toISOString()} ${line}`;
    log?.(text);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text + '\n'); } catch {}
  };
  return write;
}

async function ask(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise(resolve => terminal.question(question, resolve)); }
  finally { terminal.close(); }
}

async function applyRepairPlan(plan, options = {}) {
  const actions = plan.available || [];
  if (!actions.length) return { ok: true, applied: [], reason: 'nothing-to-fix' };
  if (!options.yes) {
    if (!options.interactive) return { ok: false, aborted: true, error: '需要显式确认：在终端交互确认，或加 --yes' };
    const answer = await (options.ask || ask)(`即将执行 ${actions.length} 项修复，是否继续？输入 yes 继续：`);
    if (!/^(y|yes|是)$/i.test(String(answer).trim())) return { ok: false, aborted: true, error: '已取消修复' };
  }
  const logFile = options.logFile || path.join(getWorkDir(plan.root, options.env || process.env), `diagnose-repair-${Date.now()}.log`);
  const log = createRepairLog(logFile, options.log);
  log(`开始修复：${actions.map(action => action.id).join(', ')}`);
  const applied = [];
  for (const action of actions) {
    log(`[start] ${action.id}: ${action.reason}`);
    try {
      const result = await applyRepairAction(action, { ...options, root: plan.root });
      applied.push({ id: action.id, result });
      log(`[ok] ${action.id}: ${JSON.stringify(result)}`);
    } catch (error) {
      log(`[fail] ${action.id}: ${error.message}`);
      return { ok: false, error: error.message, applied, logFile };
    }
  }
  log('修复完成');
  return { ok: true, applied, logFile };
}

function printReport(report) {
  console.log(`大肥鱼只读诊断：${report.ok ? '通过' : '发现错误'}（${report.checks.packageType}）`);
  for (const warning of report.warnings) console.log(`警告：${warning}`);
  for (const error of report.errors) console.log(`错误：${error}`);
  console.log(JSON.stringify(report, null, 2));
}

function printPlan(plan) {
  console.log('修复计划（默认只检查，不写配置）：');
  for (const action of plan.actions) {
    const status = action.status === 'available' ? '可修复' : action.status === 'blocked' ? '无法自动修复' : '无需修复';
    console.log(`- [${status}] ${action.title}：${action.reason}`);
  }
  if (!plan.available.length) console.log('没有可自动执行的修复项。');
}

async function run(argv = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..');
  let fix = false, yes = false, logFile = null, codexPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (argv[i] === '--fix') fix = true;
    else if (argv[i] === '--yes') yes = true;
    else if (argv[i] === '--log' && argv[i + 1]) logFile = path.resolve(argv[++i]);
    else if (argv[i] === '--codex' && argv[i + 1]) codexPath = argv[++i];
    else if (argv[i] === '--help') { console.log('用法：node tools/diagnose.cjs [--root DIR] [--fix [--yes]] [--log FILE] [--codex PATH]'); return 0; }
  }
  const report = buildReport(root, { codexPath });
  printReport(report);
  if (!fix) return report.ok ? 0 : 1;
  const plan = buildRepairPlan(report, { platform: process.platform });
  printPlan(plan);
  if (!plan.available.length) return report.ok ? 0 : 1;
  const result = await applyRepairPlan(plan, {
    yes, interactive: Boolean(process.stdin.isTTY), logFile,
    codexPath: report.codex.path, configFile: codexConfigFile(), env: process.env,
    ask
  });
  if (!result.ok) {
    console.error(result.error);
    if (result.logFile) console.error(`修复日志：${result.logFile}`);
    return result.aborted ? 2 : 1;
  }
  console.log(`已执行 ${result.applied.length} 项修复${result.logFile ? `，日志：${result.logFile}` : ''}`);
  const after = buildReport(root, { codexPath });
  printReport(after);
  // A successful partial repair still needs a non-zero exit so release/CI
  // cannot mistake an unrepaired runtime or MCP registration for success.
  return after.ok && !plan.blocked.length ? 0 : 1;
}

if (require.main === module) {
  run().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = {
  buildReport, findCodex, inspectMcpRegistration, buildRepairPlan, applyRepairPlan,
  markerPayload, backupFile, codexConfigFile, run
};
