const { BrowserWindow, ipcMain, screen, nativeImage } = require('electron');
const path = require('node:path');
const { MAX_IMAGE_BYTES, imageFormat } = require('./skins.cjs');

let active = null;
let registered = false;

function getEditorWindow() { return active?.window || null; }

function registerHandlers() {
  if (registered) return;
  registered = true;
  ipcMain.handle('skin-editor:source', event => {
    if (!active || event.sender !== active.window.webContents) return null;
    const source = active.source;
    return { name: source.name, dataUrl: `data:${source.mime};base64,${source.bytes.toString('base64')}`,
      mayAnimate: source.extension === 'gif' || source.extension === 'webp' };
  });
  ipcMain.handle('skin-editor:finish', (event, payload) => {
    if (!active || event.sender !== active.window.webContents || active.finishing) return { ok: false };
    const session = active;
    try {
      if (payload?.mode === 'original') session.result = { bytes: session.source.bytes, name: session.source.name };
      else if (payload?.mode === 'crop') {
        const prefix = 'data:image/png;base64,';
        if (typeof payload.dataUrl !== 'string' || !payload.dataUrl.startsWith(prefix)
          || payload.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + prefix.length) throw new Error('裁剪图片过大，请缩小后再试。');
        const bytes = Buffer.from(payload.dataUrl.slice(prefix.length), 'base64');
        if (bytes.length > MAX_IMAGE_BYTES || imageFormat(bytes) !== 'png' || bytes.length < 24) throw new Error('无法保存裁剪图片，请重试。');
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (!width || !height || width > 2048 || height > 2048 || nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('无法保存裁剪图片，请重试。');
        session.result = { bytes, name: `${session.source.name} · 裁剪` };
      } else if (payload?.mode !== 'cancel') throw new Error('请选择导入方式。');
      session.finishing = true;
      setImmediate(() => { if (!session.window.isDestroyed()) session.window.close(); });
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}

function openSkinEditor(parent, source) {
  if (active) { active.window.focus(); return Promise.resolve(null); }
  registerHandlers();
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(650, area.width), height = Math.min(740, area.height);
  const editor = new BrowserWindow({ parent, modal: true, width, height,
    minWidth: Math.min(500, width), minHeight: Math.min(560, height),
    x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2),
    title: '调整角色图片 · 大肥鱼', backgroundColor: '#f5f7fc', show: false,
    autoHideMenuBar: true, alwaysOnTop: false,
    webPreferences: { preload: path.join(__dirname, 'skin-editor-preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true }
  });
  editor.setMenu(null);
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.webContents.on('will-navigate', event => event.preventDefault());
  return new Promise((resolve, reject) => {
    const session = active = { window: editor, source, result: null, finishing: false };
    editor.once('closed', () => { if (active === session) active = null; resolve(session.result); });
    editor.once('ready-to-show', () => editor.show());
    editor.loadFile(path.join(__dirname, 'skin-editor.html')).catch(error => {
      reject(error);
      if (!editor.isDestroyed()) editor.close();
    });
  });
}

module.exports = { openSkinEditor, getEditorWindow };
