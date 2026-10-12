const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { version } = require('../package.json');

function findCodex() {
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name, 'codex.exe'))
      .filter(file => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  } catch {}
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

// A short-lived, read-only connection; Codex manages its own existing login.
// No tokens, auth files, or account identifiers enter the renderer or project.
async function readQuota({ timeoutMs = 20000, spawnImpl = spawn, executable = findCodex() } = {}) {
  const child = spawnImpl(executable, ['app-server', '--listen', 'stdio://',
    '-c', 'plugins."test-codex-pet@test-local".enabled=false',
    '-c', 'plugins."dafeiyu-codex-pet@dafeiyu-plugins".enabled=false'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    // Suppress mascot launch even if this plugin comes from another marketplace.
    env: { ...process.env, DAFEIYU_QUOTA_ONLY: '1' }
  });
  const pending = new Map();
  let id = 0;
  let closed = false;
  const lines = readline.createInterface({ input: child.stdout });
  const fail = error => {
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', error => fail(new Error(error.code === 'ENOENT'
    ? '未找到 Codex，请安装 Codex 桌面版或设置 CODEX_EXE。' : '无法连接本机 Codex。')));
  child.on('exit', () => fail(new Error('Codex 连接已结束，请重试。')));
  child.stdin.on('error', () => fail(new Error('Codex 连接不可用，请重试。')));
  child.stderr.resume();
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only quota client' } }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error('无法读取账户额度，请确认 Codex 已使用 ChatGPT 账户登录。'));
    } else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Codex 连接不可用。'));
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await request('initialize', { clientInfo: { name: 'dafeiyu_codex_pet', title: '大肥鱼 Codex Pet', version } });
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        return normalizeQuota(await request('account/rateLimits/read'));
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取额度超时，请检查网络后重试。')), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
    fail(new Error('连接关闭。'));
  }
}

function durationLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '额度周期';
  if (minutes === 10080) return '每周';
  if (minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function normalizeQuota(result, now = Date.now()) {
  const map = result?.rateLimitsByLimitId;
  const entries = map && Object.keys(map).length ? Object.entries(map)
    : result?.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  entries.sort(([a], [b]) => Number(b === 'codex') - Number(a === 'codex'));
  const buckets = entries.map(([id, bucket]) => {
    const windows = ['primary', 'secondary'].flatMap(kind => {
      const window = bucket?.[kind];
      if (!window) return [];
      const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : null;
      const reset = typeof window.resetsAt === 'number' && window.resetsAt > 0 ? window.resetsAt : null;
      return [{ kind, label: durationLabel(window.windowDurationMins),
        remaining: used === null ? null : Math.max(0, Math.min(100, 100 - used)), resetsAt: reset }];
    });
    return { id, name: bucket?.limitName || (id === 'codex' ? 'Codex' : id),
      plan: bucket?.planType || null, windows,
      credits: bucket?.credits ? { unlimited: bucket.credits.unlimited === true, balance: bucket.credits.balance ?? null } : null };
  });
  if (!buckets.length) throw new Error('账户暂未返回额度信息。');
  return { fetchedAt: now, buckets };
}

module.exports = { findCodex, readQuota, normalizeQuota, durationLabel };
