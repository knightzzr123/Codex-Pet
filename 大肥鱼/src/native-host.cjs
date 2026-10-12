const path = require('node:path');
const { execFile } = require('node:child_process');

function findDesktopAncestor(rows, parentPid) {
  const processes = new Map(rows.map(row => [Number(row.ProcessId), row]));
  const visited = new Set();
  let server = null;
  for (let pid = Number(parentPid); pid > 0 && !visited.has(pid);) {
    visited.add(pid);
    const row = processes.get(pid);
    if (!row) return null;
    const executable = String(row.ExecutablePath || '').replaceAll('/', '\\');
    const app = /\\(?:ChatGPT|Codex)\.exe$/i.test(executable);
    const directory = /\\OpenAI\.Codex_[^\\]+\\app\\/i.test(executable)
      || (/\\OpenAI\\Codex\\/i.test(executable) && !/\\bin\\/i.test(executable));
    if (app && directory) return server ? { pid, executable, server } : null;
    // Only a native app-server directly owned by the desktop is eligible.
    // A CLI launched in Codex's terminal also has the desktop farther up its
    // ancestry, but must not count as a desktop plugin connection.
    if (server) return null;
    if (/\\OpenAI\\Codex\\bin\\[^\\]+\\codex\.exe$/i.test(executable)) server = { pid, executable };
    else if (!/\\cmd\.exe$/i.test(executable)) return null;
    pid = Number(row.ParentProcessId);
  }
  return null;
}

function findDesktopHost({ parentPid = process.ppid, execFileImpl = execFile } = {}) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    execFileImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        resolve(findDesktopAncestor(Array.isArray(rows) ? rows : [rows], parentPid));
      } catch { resolve(null); }
    });
  });
}

module.exports = { findDesktopAncestor, findDesktopHost };
