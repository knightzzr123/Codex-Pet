const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

async function registerNativeStartup(executable, root = path.resolve(__dirname, '..')) {
  const electron = path.join(root, 'runtime', 'electron.exe');
  if (!fs.existsSync(electron)) throw new Error('Prepare the bundled runtime before registering native startup.');
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DAFEIYU_NO_LAUNCH: '1' }
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  let id = 0;
  child.stderr.resume();
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex ended before native startup registration completed.')));
  child.stdin.on('error', fail);
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Codex timed out: ${method}`)); }, 15000);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
    });
  }
  try {
    await request('initialize', { clientInfo: { name: 'dafeiyu-native-startup', version: '3.3.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const current = await request('config/read', { cwd: root, includeLayers: false });
    const previous = current.config?.mcp_servers?.['codex-pet'];
    if (previous && !previous.args?.some(arg => /[\\/]src[\\/]plugin-server\.cjs$/i.test(arg)) ) {
      throw new Error('The native MCP name codex-pet is already used by another server.');
    }
    const server = { command: electron, args: [path.join(root, 'src', 'plugin-server.cjs')], cwd: root,
      enabled: true, startup_timeout_sec: 10,
      env: { ELECTRON_RUN_AS_NODE: '1', DAFEIYU_DESKTOP_ONLY: '1' } };
    await request('config/value/write', { keyPath: 'mcp_servers.codex-pet', value: server, mergeStrategy: 'replace' });
    const checked = await request('config/read', { cwd: root, includeLayers: false });
    const saved = checked.config?.mcp_servers?.['codex-pet'];
    if (saved?.command !== electron || saved.cwd !== root || saved.env?.DAFEIYU_DESKTOP_ONLY !== '1') {
      throw new Error('Codex did not retain the native startup configuration.');
    }
    return { serverName: 'codex-pet', command: electron, cwd: root, desktopOnly: true };
  } finally {
    lines.close(); child.kill(); fail(new Error('Registration complete.'));
  }
}

module.exports = { registerNativeStartup };
if (require.main === module) {
  registerNativeStartup(process.argv[2]).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
