const path = require('node:path');
const { createPluginLifecycle } = require('./plugin-lifecycle.cjs');
const { getDataDir, getElectronExecutable } = require('./paths.cjs');
const { readQuota } = require('./quota.cjs');
const { name, version } = require('../package.json');
const { findDesktopHost } = require('./native-host.cjs');
const { createDesktopPetSpawner } = require('./desktop-pet-launcher.cjs');

module.exports = function startPlugin({ Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema },
  { findHost = findDesktopHost } = {}) {
  const root = path.resolve(__dirname, '..');
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  const dataDir = getDataDir(root);
  let lifecycle = createPluginLifecycle({ root, dataDir, executable: getElectronExecutable(root) });
  let startupReady = Promise.resolve();
  server.oninitialized = () => lifecycle.ensure();
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A catalog connection may be disposed as soon as tools/list completes.
    // Finish creating the desktop-owned GUI before that temporary job closes.
    await startupReady;
    return { tools: [{
    name: 'get_codex_remaining_quota', description: '读取当前 Codex 账户的剩余百分比、额度周期和重置时间。无需控制角色。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== 'get_codex_remaining_quota') throw new Error('Unknown tool');
    try {
      const result = await readQuota();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  const exit = () => { lifecycle.stop(); process.exit(0); };
  server.onclose = exit;
  process.stdin.once('end', exit); process.stdin.once('close', exit);
  process.on('SIGTERM', exit); process.on('SIGINT', exit); process.on('exit', () => lifecycle.stop());
  const suppressed = ['DAFEIYU_NO_LAUNCH', 'TEST_PET_NO_LAUNCH', 'DAFEIYU_QUOTA_ONLY']
    .some(key => process.env[key] === '1');
  if (process.env.DAFEIYU_DESKTOP_ONLY === '1' && !suppressed) {
    // Global MCP discovery is native Codex startup. A CLI or quota client must
    // never open the desktop mascot, even when a Codex window exists elsewhere.
    startupReady = findHost().then(host => {
      if (!host) return;
      lifecycle = createPluginLifecycle({ root, dataDir, executable: getElectronExecutable(root),
        spawnImpl: createDesktopPetSpawner({ host, dataDir }) });
      return lifecycle.start();
    });
  } else lifecycle.start();
  server.connect(new StdioServerTransport()).catch(error => { process.stderr.write(error.message + '\n'); exit(); });
};
