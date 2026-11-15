const path = require('node:path');

let active = null;

function getSettingsWindow() {
  return active && active.isDestroyed?.() !== true ? active : null;
}

// Singleton decision is independent of Electron so tests can pin it:
// an existing live window is focused; otherwise the caller creates one.
function resolveSettingsWindow(existing, create) {
  if (existing && existing.isDestroyed?.() !== true) {
    try { if (existing.isMinimized?.()) existing.restore?.(); } catch { /* already visible */ }
    try { existing.show?.(); } catch { /* show is best-effort when the window is already open */ }
    try { existing.focus?.(); } catch { /* focus can fail if the OS rejects it */ }
    return { window: existing, created: false };
  }
  return { window: create(), created: true };
}

function centeredBounds(screen, anchorWindow) {
  const display = anchorWindow && !anchorWindow.isDestroyed?.()
    ? screen.getDisplayMatching(anchorWindow.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(980, Math.max(720, area.width - 48));
  const height = Math.min(720, Math.max(560, area.height - 48));
  return {
    width, height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  };
}

function openSettingsWindow(options = {}) {
  const { BrowserWindow, screen } = require('electron');
  const resolved = resolveSettingsWindow(getSettingsWindow(), () => {
    const bounds = centeredBounds(screen, options.anchor);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: Math.min(680, bounds.width),
      minHeight: Math.min(520, bounds.height),
      title: '设置 · 大肥鱼',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f4f6fb',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => {
      if (active === win) active = null;
      try { options.onClosed?.(); } catch { /* the pet window may already be gone */ }
    });
    win.loadFile(path.join(__dirname, 'settings.html')).catch(() => {
      if (!win.isDestroyed()) win.close();
    });
    return win;
  });
  if (resolved.created) active = resolved.window;
  return resolved.window;
}

module.exports = { openSettingsWindow, getSettingsWindow, resolveSettingsWindow, centeredBounds };
