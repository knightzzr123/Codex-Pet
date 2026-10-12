const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { defaultDialogues } = require('./dialogues.cjs');
let active = null, registered = false;

function getDialogueEditorWindow() { return active?.window || null; }
function registerHandlers() {
  if (registered) return;
  registered = true;
  ipcMain.handle('dialogue-editor:source', event => {
    if (!active || event.sender !== active.window.webContents) return null;
    return { current: active.current, defaults: defaultDialogues() };
  });
  ipcMain.handle('dialogue-editor:save', (event, draft) => {
    if (!active || event.sender !== active.window.webContents || active.finishing) return { ok: false };
    const session = active;
    try {
      session.save(draft);
      session.finishing = true;
      setImmediate(() => { if (!session.window.isDestroyed()) session.window.close(); });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.code ? '无法保存台词，请检查数据目录是否可写，然后重试。' : error.message };
    }
  });
  ipcMain.on('dialogue-editor:cancel', event => {
    if (active && event.sender === active.window.webContents && !active.finishing) active.window.close();
  });
}
function openDialogueEditor(parent, current, save) {
  if (active) { active.window.focus(); return Promise.resolve(); }
  registerHandlers();
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(820, area.width), height = Math.min(660, area.height);
  const editor = new BrowserWindow({ parent, modal: true, width, height,
    minWidth: Math.min(600, width), minHeight: Math.min(580, height),
    x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2),
    title: '编辑台词 · 大肥鱼', backgroundColor: '#f5f7fc', show: false, autoHideMenuBar: true, alwaysOnTop: false,
    webPreferences: { preload: path.join(__dirname, 'dialogue-editor-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  editor.setMenu(null);
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.webContents.on('will-navigate', event => event.preventDefault());
  return new Promise((resolve, reject) => {
    const session = active = { window: editor, current, save, finishing: false };
    editor.once('closed', () => { if (active === session) active = null; resolve(); });
    editor.once('ready-to-show', () => editor.show());
    editor.loadFile(path.join(__dirname, 'dialogue-editor.html')).catch(error => {
      reject(error); if (!editor.isDestroyed()) editor.close();
    });
  });
}
module.exports = { openDialogueEditor, getDialogueEditorWindow };
