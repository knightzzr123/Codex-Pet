const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { getWorkDir, getElectronExecutable } = require('./paths.cjs');
const root = path.resolve(__dirname, '..'), work = getWorkDir(root), electron = getElectronExecutable(root);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const checks = {};
const timings = {};
async function until(condition, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return true; await wait(50); }
  return false;
}

async function protocolCheck() {
  const data = path.join(work, 'startup-mcp-smoke-data');
  const startedAt = Date.now();
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start-mcp.cmd'], { windowsHide: true, cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DAFEIYU_DATA_DIR: data, DAFEIYU_NO_LAUNCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map(); let id = 0;
  child.stderr.resume();
  lines.on('line', line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 15000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, ...(params ? { params } : {}) }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'dafeiyu-startup-smoke', version: '3.3.0' } });
    timings.preparedLauncherInitializeMs = Date.now() - startedAt;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request('tools/list');
    const quota = await request('tools/call', { name: 'get_codex_remaining_quota', arguments: {} });
    checks.mcpProtocol = initialized.serverInfo.name === 'dafeiyu-codex-pet'
      && tools.tools.some(tool => tool.name === 'get_codex_remaining_quota');
    checks.mcpQuota = !quota.isError && quota.structuredContent?.buckets?.length > 0;
    checks.suppression = !fs.existsSync(path.join(data, 'plugin-sessions', `${child.pid}.json`));
  } finally {
    child.stdin.end();
    for (let attempt = 0; alive(child.pid) && attempt < 40; attempt++) await wait(50);
    checks.mcpCleanExit = !alive(child.pid);
    if (alive(child.pid)) child.kill();
    lines.close(); for (const item of pending.values()) clearTimeout(item.timer);
  }
}

async function nativeSessionCheck() {
  const base = path.join(work, 'startup-reconnect-smoke', String(Date.now())), data = path.join(base, 'data'), diagnostic = path.join(base, 'work');
  const home = path.join(base, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, '[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled = true\n');
  fs.mkdirSync(diagnostic, { recursive: true });
  const sessionFile = path.join(diagnostic, 'native-mcp-session.json');
  const closeFile = path.join(diagnostic, 'close-native-session');
  // Test a Codex-style stdio owner directly; no external listener or bridge.
  const hostSource = `
    const fs = require('node:fs'), { spawn } = require('node:child_process'), readline = require('node:readline');
    const server = spawn(process.execPath, [${JSON.stringify(path.join(__dirname, 'plugin-server.cjs'))}],
      { windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const report = { ownerPid: process.pid, serverPid: server.pid, connected: false };
    const save = () => fs.writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(report));
    save();
    const lines = readline.createInterface({ input: server.stdout });
    lines.on('line', line => { try {
      const reply = JSON.parse(line);
      if (reply.id === 1 && reply.result) {
        server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
        report.connected = true; save();
      }
    } catch {} });
    server.stdin.on('error', () => {});
    const closing = setInterval(() => { if (fs.existsSync(${JSON.stringify(closeFile)})) server.stdin.end(); }, 50);
    server.on('exit', () => { clearInterval(closing); report.connected = false; save(); lines.close(); process.exit(0); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dafeiyu-native-session-smoke', version: '3.3.0' }
    } }) + '\\n');
  `;
  const hostOptions = {
    windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: home,
      DAFEIYU_DATA_DIR: data, DAFEIYU_WORK_DIR: diagnostic }, stdio: 'ignore' };
  const owner = spawn(electron, ['-e', hostSource], hostOptions);
  let runtime, session, reopened, reopenedSession;
  try {
    checks.nativeSessionStarts = await until(() => {
      runtime = read(path.join(data, 'runtime.json')); session = read(sessionFile);
      const scope = read(path.join(diagnostic, 'scope-status.json'));
      return runtime?.pid && session?.connected && alive(runtime.pid) && scope?.visible && scope?.ownerBound && scope?.codexPid;
    });
    if (!checks.nativeSessionStarts) throw new Error('原生插件连接未启动并绑定测试人物');
    timings.nativeFirstVisibleMs = read(path.join(diagnostic, 'startup-timing.json'))?.firstVisibleMs;
    owner.kill();
    checks.deadTransportExits = await until(() => !alive(owner.pid) && !alive(session.serverPid), 7000);
    await wait(3500);
    checks.transportGapKeepsPet = alive(runtime.pid) && read(path.join(diagnostic, 'scope-status.json'))?.visible === true;
    if (checks.deadTransportExits) {
      reopened = spawn(electron, ['-e', hostSource], hostOptions);
      checks.reconnectKeepsSamePet = await until(() => {
        reopenedSession = read(sessionFile);
        return reopenedSession?.connected && reopenedSession.serverPid !== session.serverPid
          && read(path.join(data, 'runtime.json'))?.pid === runtime.pid && alive(runtime.pid);
      });
      checks.staleSessionRemoved = !fs.existsSync(path.join(data, 'plugin-sessions', `${session.serverPid}.json`));
      // Config can be atomically replaced by Codex. An unreadable save must not
      // be mistaken for an explicit plugin disable.
      fs.renameSync(config, config + '.saving'); await wait(4500);
      checks.configSaveKeepsPetAndTransport = alive(runtime.pid) && alive(reopenedSession.serverPid);
      fs.renameSync(config + '.saving', config);
      fs.writeFileSync(closeFile, 'close');
      checks.gracefulTransportExit = await until(() => !alive(reopened.pid) && !alive(reopenedSession.serverPid), 7000);
      checks.gracefulSessionRemoved = !fs.existsSync(path.join(data, 'plugin-sessions', `${reopenedSession.serverPid}.json`));
      await wait(3500);
      checks.gracefulDisconnectKeepsPet = alive(runtime.pid) && read(path.join(diagnostic, 'scope-status.json'))?.visible === true;
    }
    fs.writeFileSync(config, '[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled = false\n');
    checks.disableWithoutTransportExitsPet = await until(() => !alive(runtime.pid), 7000);
  } finally {
    for (const pid of [owner.pid, runtime?.pid, session?.serverPid, reopened?.pid, reopenedSession?.serverPid])
      if (pid && alive(pid)) { try { process.kill(pid); } catch {} }
  }
}
(async () => {
  await protocolCheck(); await nativeSessionCheck();
  const report = { checks, timings, pass: Object.values(checks).every(Boolean) };
  fs.writeFileSync(path.join(work, 'startup-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.pass ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
