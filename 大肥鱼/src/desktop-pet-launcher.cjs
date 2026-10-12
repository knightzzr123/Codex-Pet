const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');

function createDesktopPetSpawner({ host, dataDir, execFileImpl = execFile, fsImpl = fs }) {
  if (!Number.isInteger(host?.pid) || host.pid <= 0 || !host.executable) throw new Error('Missing Codex desktop host.');
  if (!Number.isInteger(host.server?.pid) || host.server.pid <= 0 || !host.server.executable) throw new Error('Missing native Codex app-server.');
  return (executable, args, options) => new Promise((resolve, reject) => {
    const powershell = path.join(options.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = execFileImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'launch-desktop-pet.ps1')], {
      windowsHide: true, cwd: options.cwd, env: options.env, timeout: 15000, maxBuffer: 64 * 1024
    }, (error, stdout) => {
      // execFile.error.message includes stderr; never echo a request or its
      // inherited environment if a PowerShell parser fails.
      if (error) return reject(new Error(`Native Codex launch failed (code ${error.code ?? 'unknown'}).`));
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!Number.isInteger(result.pid) || result.pid <= 0 || result.desktopPid !== host.pid
          || result.parentPid !== host.server.pid) throw new Error('Invalid native launch result.');
        const child = new EventEmitter(); child.pid = result.pid; child.unref = () => {};
        try {
          const work = options.env.DAFEIYU_WORK_DIR || path.join(dataDir, 'work');
          fsImpl.mkdirSync(work, { recursive: true });
          fsImpl.appendFileSync(path.join(work, 'lifecycle.jsonl'), JSON.stringify({ time: new Date().toISOString(),
            event: 'desktop-owned-launch', petPid: child.pid, desktopPid: host.pid,
            nativeHostPid: host.server.pid, mcpPid: process.pid }) + '\n');
        } catch {}
        resolve(child);
      } catch { reject(new Error('Invalid native launch result.')); }
    });
    helper.stdin.on('error', () => reject(new Error('Native Codex launch input closed.')));
    helper.stdin.end(JSON.stringify({ desktopPid: host.pid, desktopExecutable: host.executable,
      parentPid: host.server.pid, parentExecutable: host.server.executable, executable, args,
      cwd: options.cwd, environment: options.env, cacheDirectory: path.join(dataDir, 'work', 'native-cache') }));
  });
}
module.exports = { createDesktopPetSpawner };
