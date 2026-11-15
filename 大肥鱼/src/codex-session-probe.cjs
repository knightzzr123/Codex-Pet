const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Best-effort, read-only observation of Codex's local state. We intentionally
// never open rollout JSONL bodies or the log message column: only file metadata
// (mtime/size) and the numeric timestamp/level columns are inspected.
function findCodexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function findNewestFile(root, predicate, { maxEntries = 5000 } = {}) {
  let best = null;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < maxEntries) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > maxEntries) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { stack.push(file); continue; }
      if (!entry.isFile() || !predicate(entry.name)) continue;
      try {
        const stat = fs.statSync(file);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {}
    }
  }
  return best;
}

function findNewestRollout(home) {
  return findNewestFile(path.join(home, 'sessions'), name => /^rollout-.*\.jsonl$/i.test(name));
}

function findNewestLogDatabase(home) {
  let best = null;
  let entries;
  try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^logs_\d+\.sqlite$/i.test(entry.name)) continue;
    const file = path.join(home, entry.name);
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best;
}

function createCodexSessionProbe({
  env = process.env, fsImpl = fs, now = Date.now, busyWindowMs = 4500, errorWindowMs = 60000,
  home = findCodexHome(env), sqliteLoader
} = {}) {
  let sqliteModule;
  let sqliteLoaded = false;
  function loadSqlite() {
    if (sqliteLoaded) return sqliteModule;
    sqliteLoaded = true;
    try {
      sqliteModule = sqliteLoader ? sqliteLoader() : require('node:sqlite');
    } catch { sqliteModule = null; }
    return sqliteModule;
  }

  function lastErrorAt(databaseFile) {
    const sqlite = loadSqlite();
    if (!sqlite?.DatabaseSync) return null;
    let database;
    try {
      database = new sqlite.DatabaseSync(databaseFile, { readOnly: true });
      // Metadata only: no feedback_log_body, thread titles, prompts or previews.
      const row = database.prepare("select max(ts) as ts from logs where level = 'ERROR'").get();
      return Number(row?.ts) || 0;
    } catch { return null; }
    finally { try { database?.close(); } catch {} }
  }

  function sample() {
    const at = now();
    let rollout = null;
    let logDatabase = null;
    try { rollout = findNewestRollout(home); } catch {}
    try { logDatabase = findNewestLogDatabase(home); } catch {}
    const activityAt = rollout ? Number(rollout.mtimeMs) || 0 : 0;
    let errorAt = 0;
    let logReadable = false;
    if (logDatabase) {
      const seconds = lastErrorAt(logDatabase.file);
      if (seconds !== null) { logReadable = true; errorAt = seconds * 1000; }
    }
    const channels = [];
    if (rollout) channels.push('rollout-mtime');
    if (logReadable) channels.push('logs-sqlite');
    const channel = channels.join('+') || 'unavailable';
    let state = 'idle';
    if (errorAt && at - errorAt <= errorWindowMs && errorAt >= activityAt) state = 'error';
    else if (activityAt && at - activityAt <= busyWindowMs) state = 'busy';
    return {
      state,
      channel,
      degraded: channels.length === 0,
      activityAt,
      errorAt,
      source: rollout?.file || logDatabase?.file || null,
      home,
      reason: channels.length ? '' : 'no-codex-metadata'
    };
  }

  return { sample, home };
}

module.exports = {
  findCodexHome,
  findNewestFile,
  findNewestRollout,
  findNewestLogDatabase,
  createCodexSessionProbe
};
