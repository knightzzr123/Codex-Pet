const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildReport, buildRepairPlan, applyRepairPlan, markerPayload, backupFile, inspectMcpRegistration
} = require('../tools/diagnose.cjs');

function fixture({ complete = false, withRuntime = false, marker = 'source' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-repair-'));
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'prepare-runtime.ps1', 'runtime-manifest.json', 'src/plugin-server.cjs', '.agents/plugins/marketplace.json', 'README.md']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith('.json') ? JSON.stringify({ version: '3.3.2' }) : 'fixture');
  }
  const archive = complete ? Buffer.from('test') : null;
  const manifest = { bytes: archive ? archive.length : 0, sha256: archive ? crypto.createHash('sha256').update(archive).digest('hex') : crypto.createHash('sha256').update('').digest('hex') };
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest));
  if (archive) fs.writeFileSync(path.join(root, 'runtime.7z'), archive);
  if (withRuntime) {
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', 'electron.exe'), 'fixture');
  }
  if (marker !== null) {
    fs.writeFileSync(path.join(root, 'PACKAGE-TYPE.json'), JSON.stringify(complete ? {
      packageType: 'complete', installable: true, version: '3.3.2', runtimeBytes: manifest.bytes, runtimeSha256: manifest.sha256
    } : { packageType: marker, installable: false }));
  }
  return root;
}

function inspect(root, { mcp = 'missing', codex = '/fake/codex' } = {}) {
  return buildReport(root, {
    env: { PATH: '', DAFEIYU_WORK_DIR: path.join(root, 'work'), DAFEIYU_DATA_DIR: path.join(root, 'data') },
    findCodex: () => codex, inspectMcp: () => ({ status: mcp, readOnly: true }), platform: 'linux'
  });
}

test('修复计划区分安装、运行时和 MCP；缺失文件不会伪造', () => {
  const source = fixture();
  const sourcePlan = buildRepairPlan(inspect(source));
  assert.equal(sourcePlan.available.length, 0);
  assert.equal(sourcePlan.actions.find(action => action.id === 'install').status, 'ok');
  assert.equal(sourcePlan.actions.find(action => action.id === 'runtime').status, 'ok');
  assert.equal(sourcePlan.actions.find(action => action.id === 'mcp').status, 'blocked');

  const missing = fixture();
  fs.rmSync(path.join(missing, 'prepare-runtime.ps1'));
  const missingPlan = buildRepairPlan(inspect(missing));
  assert.equal(missingPlan.actions.find(action => action.id === 'install').status, 'blocked');
  assert.match(missingPlan.actions.find(action => action.id === 'install').reason, /重新解压/);

  const complete = fixture({ complete: true, withRuntime: true });
  const completePlan = buildRepairPlan(inspect(complete, { mcp: 'missing' }));
  assert.equal(completePlan.actions.find(action => action.id === 'runtime').status, 'ok');
  assert.equal(completePlan.actions.find(action => action.id === 'mcp').status, 'available');
});

test('完整包缺类型标记可补写；写入后计划变为无需修复', async () => {
  const root = fixture({ complete: true, marker: null });
  const before = inspect(root);
  const plan = buildRepairPlan(before);
  const install = plan.actions.find(action => action.id === 'install');
  assert.equal(install.status, 'available');
  const logFile = path.join(root, 'work', 'repair.log');
  const result = await applyRepairPlan(plan, { yes: true, root, logFile });
  assert.equal(result.ok, true);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'PACKAGE-TYPE.json'), 'utf8'));
  assert.equal(marker.packageType, 'complete');
  assert.equal(marker.installable, true);
  assert.match(fs.readFileSync(logFile, 'utf8'), /\[ok\] install/);
  const again = buildRepairPlan(inspect(root));
  assert.equal(again.available.length, 0);
});

test('显式确认缺失时不做任何修改', async () => {
  const root = fixture({ complete: true, marker: null });
  const plan = buildRepairPlan(inspect(root));
  const result = await applyRepairPlan(plan, { yes: false, interactive: false, root, logFile: path.join(root, 'work', 'nope.log') });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(fs.existsSync(path.join(root, 'PACKAGE-TYPE.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'work', 'nope.log')), false);
});

test('MCP 修复先备份 Codex 配置，失败时回滚并写日志', async () => {
  const root = fixture({ complete: true, withRuntime: true });
  const configFile = path.join(root, 'codex', 'config.toml');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, 'original = true\n');
  const plan = buildRepairPlan(inspect(root, { mcp: 'mismatch' }));
  const mcp = plan.actions.find(action => action.id === 'mcp');
  assert.equal(mcp.status, 'available');
  let receivedBackup = null;
  const result = await applyRepairPlan(plan, {
    yes: true, root, configFile, backupDir, codexPath: '/fake/codex', logFile: path.join(root, 'work', 'mcp.log'),
    registerMcp: async (_root, context) => { receivedBackup = context.backupDir; throw new Error('simulated failure'); }
  });
  assert.equal(result.ok, false);
  assert.equal(receivedBackup, backupDir);
  assert.equal(fs.readFileSync(configFile, 'utf8'), 'original = true\n');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), /original/);
  assert.match(fs.readFileSync(path.join(root, 'work', 'mcp.log'), 'utf8'), /\[fail\] mcp/);
});

test('完整包缺类型标记时按 manifest 生成 complete 标记；备份文件可校验', () => {
  const root = fixture({ complete: true, marker: null });
  const marker = markerPayload(root);
  assert.equal(marker.packageType, 'complete');
  assert.equal(marker.installable, true);
  assert.equal(marker.version, '3.3.2');
  const source = path.join(root, 'source.txt'); fs.writeFileSync(source, 'backup me');
  const backup = backupFile(source, path.join(root, 'backups'));
  assert.ok(backup && fs.existsSync(backup));
  assert.equal(fs.readFileSync(backup, 'utf8'), 'backup me');
});

test('Windows 完整包缺 runtime/ 时可用 7zr 解包动作，失败前不覆盖现有目录', async () => {
  const root = fixture({ complete: true });
  fs.mkdirSync(path.join(root, 'tools', '7zip'), { recursive: true });
  const extractor = path.join(root, 'tools', '7zip', '7zr.exe');
  fs.writeFileSync(extractor, 'fixture');
  const report = buildReport(root, {
    env: { PATH: '', DAFEIYU_WORK_DIR: path.join(root, 'work'), DAFEIYU_DATA_DIR: path.join(root, 'data') },
    findCodex: () => '/fake/codex', inspectMcp: () => ({ status: 'ok', readOnly: true }), platform: 'win32'
  });
  const plan = buildRepairPlan(report, { platform: 'win32' });
  assert.equal(plan.actions.find(action => action.id === 'runtime').status, 'available');
  assert.equal(plan.actions.find(action => action.id === 'mcp').status, 'ok');
  let called = 0;
  const result = await applyRepairPlan(plan, {
    yes: true, root, logFile: path.join(root, 'work', 'runtime.log'),
    extractRuntime: () => {
      called += 1;
      fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
      fs.writeFileSync(path.join(root, 'runtime', 'electron.exe'), 'stub');
      return { runtime: path.join(root, 'runtime') };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(called, 1);
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'electron.exe')), true);
});

test('MCP 只读检查只返回状态，不泄露 MCP 配置或环境密钥', () => {
  const result = inspectMcpRegistration('/fake/codex', {
    execFileSyncImpl: () => JSON.stringify([{ name: 'codex-pet', command: 'electron.exe',
      args: ['src/plugin-server.cjs'], env: { DAFEIYU_DESKTOP_ONLY: '1', SECRET_TOKEN: 'do-not-print' } }])
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.serverName, 'codex-pet');
  assert.equal(result.server, undefined);
  assert.equal(result.servers, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN|do-not-print/);
});
