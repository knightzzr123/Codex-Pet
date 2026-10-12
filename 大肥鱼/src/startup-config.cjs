const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_ID = 'dafeiyu-codex-pet@dafeiyu-plugins';
function pluginState(text) {
  if (!String(text).trim()) return null;
  let selected = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const table = line.match(/^\[\s*plugins\s*\.\s*(["'])([^"']+)\1\s*\]\s*(?:#.*)?$/);
      selected = table?.[2] === PLUGIN_ID;
    } else if (selected && /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/.test(line)) {
      return /^enabled\s*=\s*true\b/.test(line);
    }
  }
  return selected ? null : false;
}
function pluginEnabled(text) { return pluginState(text) === true; }
function readPluginState(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try { return pluginState(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch { return null; }
}
function isPluginEnabled(env = process.env) { return readPluginState(env) === true; }
function createDisableGuard(readState, confirmations = 3) {
  let disabled = 0;
  return () => {
    disabled = readState() === false ? disabled + 1 : 0;
    return disabled >= confirmations;
  };
}
module.exports = { PLUGIN_ID, pluginState, pluginEnabled, readPluginState, isPluginEnabled, createDisableGuard };
