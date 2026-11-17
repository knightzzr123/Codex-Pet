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
  const width = Math.min(960, area.width);
  const height = Math.min(680, area.height);
  return {
    width, height,
    minWidth: Math.min(800, width),
    minHeight: Math.min(560, height),
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  };
}

function settingsCloseBlocked(win) {
  return !(win && (win.__allowClose || win.__loadFailed || win.__rendererGone));
}

function openSettingsWindow(options = {}) {
  const { BrowserWindow, screen } = require('electron');
  const resolved = resolveSettingsWindow(getSettingsWindow(), () => {
    const bounds = centeredBounds(screen, options.anchor);
    const win = new BrowserWindow({
      width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
      minWidth: bounds.minWidth, minHeight: bounds.minHeight,
      title: '设置 · 大肥鱼',
      modal: false,
      // Own taskbar entry: no parent window and never hidden from the taskbar.
      skipTaskbar: false,
      fullscreenable: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: options.backgroundColor || '#f5f7fc',
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
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && !input.alt && !input.meta && input.key === ',') {
        event.preventDefault();
        win.focus();
      }
    });
    win.webContents.on('render-process-gone', () => { win.__rendererGone = true; win.__allowClose = true; });
    win.on('close', event => {
      if (!settingsCloseBlocked(win)) return;
      event.preventDefault();
      try {
        if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('settings:request-close');
      } catch { win.__allowClose = true; }
    });
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => {
      if (active === win) active = null;
      try { options.onClosed?.(); } catch { /* the pet window may already be gone */ }
    });
    win.loadFile(path.join(__dirname, 'settings.html')).catch(() => {
      win.__loadFailed = true;
      win.__allowClose = true;
      if (!win.isDestroyed()) win.close();
    });
    return win;
  });
  if (resolved.created) active = resolved.window;
  return resolved.window;
}

module.exports = { openSettingsWindow, getSettingsWindow, resolveSettingsWindow, centeredBounds, settingsCloseBlocked };
