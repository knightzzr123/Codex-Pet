const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PLUGIN_ID, readPluginState, createDisableGuard } = require('./startup-config.cjs');

function createPluginLifecycle({ root, dataDir, executable, processInfo = process,
  spawnImpl = spawn, fsImpl = fs, intervalImpl = setInterval, clearIntervalImpl = clearInterval,
  now = Date.now, onParentExit = () => process.exit(0), isEnabled = () => readPluginState(processInfo.env) }) {
  const directory = path.join(dataDir, 'plugin-sessions');
  const sessionFile = path.join(directory, `${processInfo.pid}.json`);
  const runtimeFile = path.join(dataDir, 'runtime.json');
  const suppressed = ['DAFEIYU_NO_LAUNCH', 'TEST_PET_NO_LAUNCH', 'DAFEIYU_QUOTA_ONLY']
    .some(key => processInfo.env[key] === '1');
  let started = false, interval, launching = null;
  const isDisabled = createDisableGuard(isEnabled);
  const alive = pid => { try { processInfo.kill(pid, 0); return true; } catch { return false; } };
  function ensure() {
    if (!started || suppressed) return;
    try {
      const runtime = JSON.parse(fsImpl.readFileSync(runtimeFile, 'utf8'));
      if (runtime.mode === 'plugin' && (runtime.root === root || runtime.pluginId === PLUGIN_ID)
        && now() - runtime.updatedAt < 10000 && alive(runtime.pid)) return;
    } catch {}
    if (launching && (launching.pending || alive(launching.pid)) && now() - launching.at < 15000) return launching.ready;
    const env = { ...processInfo.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const inheritedStart = Number(env.DAFEIYU_START_STARTED_AT);
    if (!inheritedStart || inheritedStart > now() || now() - inheritedStart > 10000) env.DAFEIYU_START_STARTED_AT = String(now());
    const pending = { pid: 0, at: now(), pending: true };
    launching = pending;
    const failed = error => {
      if (launching === pending) launching = null;
      processInfo.stderr.write(`大肥鱼启动失败: ${error.message}\n`);
    };
    const launched = child => {
      pending.pid = child.pid; pending.pending = false;
      child.on('error', failed);
      child.on('exit', () => { if (launching === pending) launching = null; });
      child.unref();
    };
    try {
      const child = spawnImpl(executable, [root, '--plugin'], {
        cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore'
      });
      if (child?.then) { pending.ready = child.then(launched, failed); return pending.ready; }
      else launched(child);
    } catch (error) { failed(error); }
  }
  function start() {
    if (started || suppressed || isEnabled() === false) return launching?.ready;
    started = true;
    fsImpl.mkdirSync(directory, { recursive: true });
    // Windows can end the whole Codex job before JS exit handlers run.
    // Clean dead sessions at the next native load, without a resident helper.
    for (const entry of fsImpl.readdirSync(directory)) {
      if (/^\d+\.json$/.test(entry) && !alive(Number(entry.slice(0, -5)))) {
        try { fsImpl.unlinkSync(path.join(directory, entry)); } catch {}
      }
    }
    fsImpl.writeFileSync(sessionFile, JSON.stringify({ pid: processInfo.pid }));
    // Launch when Codex creates the plugin transport, without waiting for its handshake.
    const ready = ensure();
    interval = intervalImpl(() => { if (alive(processInfo.ppid) && !isDisabled()) ensure(); else { stop(); onParentExit(); } }, 1000);
    return ready;
  }
  function stop() {
    if (!started) return;
    started = false; clearIntervalImpl(interval);
    try { fsImpl.unlinkSync(sessionFile); } catch {}
  }
  return { start, ensure, stop };
}
module.exports = { createPluginLifecycle };
