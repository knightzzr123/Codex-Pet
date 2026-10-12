const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pluginEnabled, pluginState, createDisableGuard } = require('../src/startup-config.cjs');
const { createPluginLifecycle } = require('../src/plugin-lifecycle.cjs');
const { createWindowLifetime } = require('../src/plugin-window-lifetime.cjs');
const { createScopeMonitor } = require('../src/scope-monitor.cjs');
const { PassThrough } = require('node:stream');
const { findDesktopAncestor, findDesktopHost } = require('../src/native-host.cjs');
const { createDesktopPetSpawner } = require('../src/desktop-pet-launcher.cjs');

test('原生默认入口只允许 Codex 桌面宿主启动人物，独立 CLI 不能借用已打开的窗口', () => {
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, ExecutablePath: 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1_x64/app/ChatGPT.exe' },
    { ProcessId: 20, ParentProcessId: 10, ExecutablePath: 'C:/Users/u/AppData/Local/OpenAI/Codex/bin/hash/codex.exe' },
    { ProcessId: 21, ParentProcessId: 20, ExecutablePath: 'C:/Windows/System32/cmd.exe' },
    { ProcessId: 30, ParentProcessId: 40, ExecutablePath: 'C:/Users/u/AppData/Local/OpenAI/Codex/bin/hash/codex.exe' },
    { ProcessId: 40, ParentProcessId: 20, ExecutablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }
  ];
  assert.equal(findDesktopAncestor(rows, 20)?.pid, 10);
  assert.equal(findDesktopAncestor(rows, 21)?.pid, 10);
  assert.equal(findDesktopAncestor(rows, 21)?.server?.pid, 20);
  assert.equal(findDesktopAncestor(rows, 10), null);
  assert.equal(findDesktopAncestor(rows, 30), null);
  assert.equal(findDesktopAncestor(rows, 99), null);
  assert.equal(findDesktopAncestor([{ ProcessId: 1, ParentProcessId: 2 }, { ProcessId: 2, ParentProcessId: 1 }], 1), null);
});

test('宿主查询失败或输出损坏时保持 MCP 可用且不启动人物', async () => {
  for (const [error, output] of [[new Error('denied'), ''], [null, 'invalid'], [null, '[]']]) {
    assert.equal(await findDesktopHost({ parentPid: 20, execFileImpl(_exe, _args, options, callback) {
      assert.equal(options.windowsHide, true); callback(error, output);
    } }), null);
  }
});

test('插件服务只识别本插件的明确启用设置', () => {
  assert.equal(pluginEnabled('[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled = true # enabled'), true);
  assert.equal(pluginEnabled("[ plugins . 'dafeiyu-codex-pet@dafeiyu-plugins' ]\nenabled = true"), true);
  for (const source of ['', '[plugins."other"]\nenabled = true',
    '[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled = false',
    '[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\n[features]\nenabled = true']) assert.equal(pluginEnabled(source), false);
});

function fixture(env = {}, { asyncSpawn = false } = {}) {
  const root = path.resolve('startup-fixture'), dataDir = path.join(root, 'data');
  const files = new Map(), spawned = [], live = new Set([100, 101]);
  let time = 20000, timer, cleared = false, exited = false, enabled = true;
  const processInfo = { pid: 101, ppid: 100, env: { ELECTRON_RUN_AS_NODE: '1', ...env },
    stderr: { write() {} }, kill(pid) { if (!live.has(pid)) throw new Error('not alive'); } };
  const fsImpl = {
    mkdirSync() {}, writeFileSync(file, bytes) { files.set(file, bytes); },
    readdirSync(directory) { return [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)); },
    readFileSync(file) { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    unlinkSync(file) { files.delete(file); }
  };
  const lifecycle = createPluginLifecycle({ root, dataDir, executable: 'electron.exe', processInfo, fsImpl,
    now: () => time, intervalImpl: callback => { timer = callback; return 1; },
    clearIntervalImpl: () => { cleared = true; }, onParentExit: () => { exited = true; }, isEnabled: () => enabled,
    spawnImpl(executable, args, options) {
      assert.ok(files.has(path.join(dataDir, 'plugin-sessions', '101.json')), 'session exists before launching');
      const child = new EventEmitter(); child.pid = 500 + spawned.length; child.unref = () => {};
      const entry = { executable, args, options, child }; spawned.push(entry);
      if (asyncSpawn) return new Promise((resolve, reject) => {
        entry.resolve = () => { live.add(child.pid); resolve(child); };
        entry.reject = reject;
      });
      live.add(child.pid); return child;
    }
  });
  return { lifecycle, files, spawned, live, root, dataDir,
    tick(ms = 1000) { time += ms; timer(); }, status: () => ({ cleared, exited }),
    disable() { enabled = false; },
    enable() { enabled = true; }, unreadable() { enabled = null; },
    runtime(value) { files.set(path.join(dataDir, 'runtime.json'), JSON.stringify(value)); } };
}

test('MCP 服务创建时立即启动，无需等待初始化，重复通知不会重复拉起', () => {
  const f = fixture(); f.lifecycle.start();
  assert.equal(f.spawned.length, 1);
  f.lifecycle.start(); f.lifecycle.ensure(); f.tick();
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.spawned[0].options.windowsHide, true);
  assert.deepEqual(f.spawned[0].args, [f.root, '--plugin']);
});

test('原生创建尚未完成时复用等待状态，心跳和初始化不会重复拉起', async () => {
  const f = fixture({}, { asyncSpawn: true }), ready = f.lifecycle.start();
  let finished = false; ready.then(() => { finished = true; });
  assert.equal(f.lifecycle.ensure(), ready);
  assert.equal(f.lifecycle.start(), ready);
  f.tick(4000); f.tick(3000); await Promise.resolve();
  assert.equal(f.spawned.length, 1); assert.equal(finished, false);
  f.spawned[0].resolve(); await ready;
  assert.equal(finished, true); f.tick();
  assert.equal(f.spawned.length, 1);
});

test('原生异步创建失败不产生未处理拒绝，后续心跳可以重试', async () => {
  const f = fixture({}, { asyncSpawn: true }), ready = f.lifecycle.start();
  f.spawned[0].reject(new Error('native failure')); await ready;
  f.tick(); assert.equal(f.spawned.length, 2);
  const retried = f.lifecycle.ensure(); f.spawned[1].resolve(); await retried;
  f.tick(); assert.equal(f.spawned.length, 2);
});

test('原生创建只接受对应宿主的有效 PID，并清除 GUI 的 Node 模式', async () => {
  const host = { pid: 10, executable: 'desktop.exe', server: { pid: 20, executable: 'codex.exe' } };
  let received, diagnostic;
  const create = createDesktopPetSpawner({ host, dataDir: 'unused',
    fsImpl: { mkdirSync() {}, appendFileSync(_file, value) { diagnostic = JSON.parse(value); } },
    execFileImpl(_exe, args, options, callback) {
    assert.equal(options.windowsHide, true); assert.ok(args.includes('-NonInteractive'));
    const input = new PassThrough(); let bytes = '';
    input.on('data', chunk => { bytes += chunk; });
    input.on('finish', () => { received = JSON.parse(bytes); callback(null, JSON.stringify({ pid: 300, desktopPid: 10, parentPid: 20 })); });
    return { stdin: input };
  } });
  const f = fixture(); f.lifecycle.start();
  const options = f.spawned[0].options;
  const testRoot = 'D:\\fixture\\鲸鱼 角色';
  const child = await create('electron.exe', [testRoot, '--plugin'], options);
  assert.equal(child.pid, 300); assert.equal(received.environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(received.parentPid, 20); assert.equal(received.desktopPid, 10);
  assert.equal(diagnostic.nativeHostPid, 20); assert.equal(diagnostic.petPid, 300);
  assert.deepEqual(received.args, [testRoot, '--plugin']);
});

test('原生辅助程序失败时不泄漏 stderr 环境；非法 PID 和宿主不匹配不能成功', async () => {
  const host = { pid: 10, executable: 'desktop.exe', server: { pid: 20, executable: 'codex.exe' } };
  const leaked = 'PRIVATE_TEST_VALUE';
  for (const [error, output] of [
    [Object.assign(new Error(leaked), { code: 1 }), ''], [null, leaked],
    [null, '{"pid":0,"desktopPid":10,"parentPid":20}'],
    [null, '{"pid":300,"desktopPid":99,"parentPid":20}'],
    [null, '{"pid":300,"desktopPid":10,"parentPid":99}']
  ]) {
    const create = createDesktopPetSpawner({ host, dataDir: 'unused', execFileImpl(_exe, _args, _options, callback) {
      const input = new PassThrough(); input.resume();
      input.on('finish', () => callback(error, output)); return { stdin: input };
    } });
    await assert.rejects(create('electron.exe', [], { env: {}, cwd: '.' }), failure => !failure.message.includes(leaked));
  }
  assert.throws(() => createDesktopPetSpawner({ host: { pid: 10, executable: 'desktop.exe' }, dataDir: 'unused' }));
});

test('额度读取和明确禁止启动的连接不创建角色会话', () => {
  for (const key of ['DAFEIYU_QUOTA_ONLY', 'DAFEIYU_NO_LAUNCH', 'TEST_PET_NO_LAUNCH']) {
    const f = fixture({ [key]: '1' }); f.lifecycle.start(); f.lifecycle.ensure();
    assert.equal(f.spawned.length, 0); assert.equal(f.files.size, 0);
  }
});

test('正在运行的角色不重复启动，过期 PID 记录不能阻止启动', () => {
  const f = fixture(); f.live.add(700);
  f.runtime({ pid: 700, mode: 'plugin', root: f.root, updatedAt: 20000 });
  f.lifecycle.start(); assert.equal(f.spawned.length, 0);
  f.tick(12000); assert.equal(f.spawned.length, 1);
});

test('角色退出后及时恢复，父连接退出时清理会话', () => {
  const f = fixture(); f.lifecycle.start();
  f.live.delete(f.spawned[0].child.pid); f.spawned[0].child.emit('exit');
  f.tick(); assert.equal(f.spawned.length, 2);
  f.live.delete(100); f.tick();
  assert.equal(f.files.size, 0); assert.deepEqual(f.status(), { cleared: true, exited: true });
});

test('插件未启用时不创建角色，运行中停用后清理会话并退出', () => {
  const disabled = fixture(); disabled.disable(); disabled.lifecycle.start();
  assert.equal(disabled.spawned.length, 0); assert.equal(disabled.files.size, 0);
  const running = fixture(); running.lifecycle.start(); running.disable(); running.tick();
  running.tick(); running.tick();
  assert.equal(running.files.size, 0);
  assert.deepEqual(running.status(), { cleared: true, exited: true });
  assert.equal(running.spawned.length, 1);
});

test('配置暂时无法读取或保存中缺少 enabled 不退出，明确停用连续确认后生效', () => {
  assert.equal(pluginState(''), null);
  assert.equal(pluginState('[plugins."dafeiyu-codex-pet@dafeiyu-plugins"]\nenabled ='), null);
  let state = true;
  const disabled = createDisableGuard(() => state);
  state = false; assert.equal(disabled(), false);
  state = null; assert.equal(disabled(), false);
  state = false; assert.equal(disabled(), false); assert.equal(disabled(), false); assert.equal(disabled(), true);
  state = true; assert.equal(disabled(), false);
  const f = fixture(); f.lifecycle.start(); f.unreadable();
  f.tick(); f.tick(); f.tick(); assert.equal(f.status().exited, false);
  f.disable(); f.tick(); f.enable(); f.tick(); assert.equal(f.status().exited, false);
});

test('项目和缓存入口复用同一插件的活动角色，不连续拉起重复进程', () => {
  const f = fixture(); f.live.add(700);
  f.runtime({ pid: 700, mode: 'plugin', root: 'installed-cache', pluginId: 'dafeiyu-codex-pet@dafeiyu-plugins', updatedAt: 20000 });
  f.lifecycle.start(); f.tick(); assert.equal(f.spawned.length, 0);
});

test('绑定后的角色跟随 Codex 进程，而非临时 MCP 连接；最小化不退出', () => {
  const live = new Set([200]);
  const lifetime = createWindowLifetime({ alive: pid => live.has(pid) });
  lifetime.observe({ targetExists: true, codexPid: 200, active: true });
  assert.equal(lifetime.shouldExit(false), false);
  lifetime.observe({ targetExists: true, codexPid: 200, active: false, reason: 'minimized' });
  assert.equal(lifetime.shouldExit(false), false);
  live.delete(200); assert.equal(lifetime.shouldExit(true), true);
});

test('尚未绑定时允许原生窗口加载，宿主结束且没有 Codex 窗口时退出', () => {
  let time = 0;
  const lifetime = createWindowLifetime({ alive: () => false, now: () => time });
  assert.equal(lifetime.shouldExit(false), false);
  time = 30001; assert.equal(lifetime.shouldExit(false), true);
  assert.equal(lifetime.shouldExit(true), false);
});

function monitorFixture() {
  const children = [], timers = [], observations = [], diagnostics = [];
  let time = 0, watchdog;
  const monitor = createScopeMonitor({
    launch() {
      const child = new EventEmitter(); child.pid = 400 + children.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; child.emit('exit', 1, null); };
      children.push(child); return child;
    },
    now: () => time, onScope: scope => observations.push(scope), onDiagnostic: event => diagnostics.push(event),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cancelled = true; },
    setWatch(callback) { watchdog = callback; return 1; }, clearWatch() { watchdog = null; }
  });
  return { monitor, children, timers, observations, diagnostics,
    restart() { const timer = timers.shift(); assert.ok(!timer.cancelled); timer.callback(); },
    advance(ms) { time += ms; watchdog?.(); } };
}

test('绑定进程意外退出自动恢复，旧输出无效，不发送虚假隐藏状态', () => {
  const f = monitorFixture(); f.monitor.start();
  f.children[0].stdout.write('{"active":true,"ownerBound":true}\n');
  f.children[0].stderr.write('native failure'); f.children[0].emit('exit', 1, null);
  assert.equal(f.timers.length, 1); assert.equal(f.observations.length, 1);
  assert.equal(f.diagnostics.at(-1).detail.stderr, 'native failure');
  f.restart(); assert.equal(f.children.length, 2);
  f.children[0].stdout.write('{"active":false}\n');
  assert.equal(f.observations.length, 1);
  f.children[1].stdout.write('{"active":true,"ownerBound":true}\n');
  assert.equal(f.observations.length, 2);
  f.monitor.stop(); assert.equal(f.timers.length, 0);
});

test('绑定进程没有心跳时恢复，初次编译给足时间，退出时取消恢复', () => {
  const f = monitorFixture(); f.monitor.start(); f.advance(10000);
  assert.equal(f.timers.length, 0);
  f.children[0].stdout.write('{"active":true}\n'); f.advance(5001);
  assert.equal(f.children[0].killed, true); assert.equal(f.timers.length, 1);
  f.monitor.stop(); assert.equal(f.timers[0].cancelled, true);
  f.timers[0].callback(); assert.equal(f.children.length, 1);
});

test('重新加载清理被 Windows 强制终止的旧会话，保留其他活动连接', () => {
  const f = fixture(), directory = path.join(f.dataDir, 'plugin-sessions');
  f.files.set(path.join(directory, '999.json'), '{}');
  f.files.set(path.join(directory, '100.json'), '{}');
  f.files.set(path.join(directory, 'notes.json'), '{}');
  f.runtime({ pid: 999, mode: 'plugin', root: f.root, updatedAt: 20000 });
  f.lifecycle.start();
  assert.equal(f.files.has(path.join(directory, '999.json')), false);
  assert.equal(f.files.has(path.join(directory, '100.json')), true);
  assert.equal(f.files.has(path.join(directory, 'notes.json')), true);
  assert.equal(f.spawned.length, 1);
});
