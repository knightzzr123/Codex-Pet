const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { getWorkDir } = require('./paths.cjs');
const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await wait(50); }
  throw new Error(message);
}
function nativeRead(args) {
  return new Promise((resolve, reject) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', ...args],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('Native smoke inspection failed.'));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(new Error('Invalid native inspection result.')); }
    }));
}

async function checkNativeCatalogHandoff() {
  const work = getWorkDir(root);
  const scope = await nativeRead(['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'codex-scope.ps1'),
    '-Once', '-CacheDirectory', path.join(work, 'native-cache')]);
  if (!scope.active) throw new Error('Native handoff smoke requires a visible Codex window.');
  const desktop = await nativeRead(['-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(scope.codexPid)}' | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`]);
  const host = { pid: Number(desktop.ProcessId), executable: desktop.ExecutablePath };
  const nativeServers = await nativeRead(['-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${host.pid}' | Where-Object { $_.ExecutablePath -match '\\\\OpenAI\\\\Codex\\\\bin\\\\[^\\\\]+\\\\codex\\.exe$' } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`]);
  const nativeServer = (Array.isArray(nativeServers) ? nativeServers : [nativeServers])[0];
  if (!nativeServer?.ProcessId) throw new Error('Native handoff smoke requires the desktop app-server.');
  host.server = { pid: Number(nativeServer.ProcessId), executable: nativeServer.ExecutablePath };
  const base = path.join(work, 'native-catalog-handoff', String(Date.now()));
  const home = path.join(base, 'home'), data = path.join(base, 'data'), diagnostics = path.join(base, 'work');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(diagnostics, { recursive: true });
  const fixture = path.join(base, 'plugin-server.cjs');
  fs.copyFileSync(path.join(__dirname, 'plugin-server.cjs'), fixture);
  // Supply only the verified desktop identity in this isolated SDK fixture.
  // Production still obtains it exclusively from its native parent process.
  fs.writeFileSync(path.join(base, 'plugin-entry.cjs'), `module.exports = sdk => require(${JSON.stringify(path.join(__dirname, 'plugin-entry.cjs'))})(sdk, { findHost: async () => (${JSON.stringify(host)}) });\n`);
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, `[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled=true\n[mcp_servers.codex-pet]\ncommand=${JSON.stringify(path.join(root, 'runtime', 'electron.exe'))}\nargs=[${JSON.stringify(fixture)}]\ncwd=${JSON.stringify(root)}\n[mcp_servers.codex-pet.env]\nELECTRON_RUN_AS_NODE="1"\nDAFEIYU_DESKTOP_ONLY="1"\nDAFEIYU_DATA_DIR=${JSON.stringify(data)}\nDAFEIYU_WORK_DIR=${JSON.stringify(diagnostics)}\nCODEX_HOME=${JSON.stringify(home)}\n`);
  const hosts = [], checks = {};
  let petPid = 0, samples = 0, interruptions = 0, monitoring;
  function connect() {
    const child = spawn(host.server.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: root, windowsHide: true, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe']
    });
    hosts.push(child); child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout }), pending = new Map(); let id = 0;
    const fail = error => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear(); lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    };
    child.on('error', fail); child.on('exit', () => fail(new Error('Test catalog closed.')));
    child.stdin.on('error', fail);
    lines.on('line', line => { let value; try { value = JSON.parse(line); } catch { return; }
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timer);
      value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error(`Catalog timeout: ${method}`)); }, 20000);
      pending.set(key, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
    });
    return { child, async catalog() {
      await request('initialize', { clientInfo: { name: 'dafeiyu-native-handoff-smoke', version: '3.3.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      return request('mcpServerStatus/list', { limit: 100 });
    } };
  }
  try {
    const first = connect(), catalog = await first.catalog();
    checks.nativeCatalogConnected = catalog.data.some(server => server.name === 'codex-pet' && server.tools?.get_codex_remaining_quota);
    await until(() => read(path.join(diagnostics, 'scope-status.json'))?.visible, 'Catalog GUI was not shown.');
    petPid = read(path.join(data, 'runtime.json'))?.pid;
    const parent = await nativeRead(['-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(petPid)}' | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`]);
    checks.nativeDesktopHostOwnsProcess = parent.ParentProcessId === host.server.pid;
    const window = read(path.join(diagnostics, 'scope-status.json'));
    checks.nativeWindowBound = window.codexPid === host.pid && window.ownerBound === true && window.rect.width >= 240;
    monitoring = setInterval(() => {
      samples++;
      if (!alive(petPid) || read(path.join(data, 'runtime.json'))?.pid !== petPid
        || read(path.join(diagnostics, 'scope-status.json'))?.visible !== true) interruptions++;
    }, 50);
    first.child.kill(); await until(() => !alive(first.child.pid), 'First test host did not close.'); await wait(2500);
    checks.catalogJobCloseKeepsPet = alive(petPid) && read(path.join(diagnostics, 'scope-status.json'))?.visible === true;
    const second = connect(); await second.catalog(); await wait(1200);
    checks.reconnectReusesPet = read(path.join(data, 'runtime.json'))?.pid === petPid && alive(petPid);
    second.child.kill(); await until(() => !alive(second.child.pid), 'Second test host did not close.'); await wait(1800);
    clearInterval(monitoring); monitoring = null;
    checks.continuouslyVisible = samples > 50 && interruptions === 0;
    fs.writeFileSync(config, '[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled=false\n');
    await until(() => !alive(petPid), 'Disabled test pet did not exit.', 8000);
    checks.pluginDisableStillExits = true;
    checks.realCodexUntouched = alive(host.pid);
    const report = { checks, samples, interruptions, petPid, desktopPid: host.pid, base, pass: Object.values(checks).every(Boolean) };
    fs.writeFileSync(path.join(work, 'native-catalog-handoff-report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    clearInterval(monitoring);
    for (const child of hosts) if (alive(child.pid)) child.kill();
    if (petPid && alive(petPid)) process.kill(petPid);
  }
}
module.exports = { checkNativeCatalogHandoff };
if (require.main === module) checkNativeCatalogHandoff().then(report => {
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.pass ? 0 : 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
