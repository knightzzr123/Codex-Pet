const { app, BrowserWindow, Menu, dialog, ipcMain, screen, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createScopeMonitor } = require('./scope-monitor.cjs');
const { createWindowLifetime } = require('./plugin-window-lifetime.cjs');
const { PLUGIN_ID, readPluginState, createDisableGuard } = require('./startup-config.cjs');
const { pathToFileURL } = require('node:url');
const { readQuota } = require('./quota.cjs');
const { scopedBounds, snapBounds, shouldShow } = require('./scope.cjs');
const { SIZE_SCALES, DEFAULT_SIZE_LEVEL, isSizeLevel, sizeLevelFromPreferences, scaleForLevel } = require('./size.cjs');
const { getDataDir, getWorkDir } = require('./paths.cjs');
const { SkinLibrary, readImageFile } = require('./skins.cjs');
const { openSkinEditor, getEditorWindow } = require('./skin-editor.cjs');
const { DialogueLibrary, defaultDialogues } = require('./dialogues.cjs');
const { openDialogueEditor, getDialogueEditorWindow } = require('./dialogue-editor.cjs');
const { BUBBLE_SECONDS, experienceFromPreferences } = require('./experience.cjs');
const { VIEWPORT, inputRegions } = require('./layout.cjs');

const smokeTest = process.argv.includes('--smoke-test');
const pluginMode = process.argv.includes('--plugin');
const project = path.join(__dirname, '..');
const work = getWorkDir(project);
const dataDir = getDataDir(project);
const startupStartedAt = Number(process.env.DAFEIYU_START_STARTED_AT) || Date.now();
const startupTiming = { pid: process.pid, startedAt: startupStartedAt };
app.setName('大肥鱼 · Codex Pet');
// Keep smoke checks independent of the live plugin's lock, cache and settings.
app.setPath('userData', smokeTest ? path.join(work, 'smoke-data') : dataDir);
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let win, interval, scopeMonitor, pluginInterval, functionMenu;
  let scope = { active: false };
  let closing = false;
  let refreshPromise = null;
  let lastAttempt = 0;
  let inputBubble = false;
  let inputRegionKey = '';
  let drag = null;
  let importingSkin = false;
  let deletingSkin = false;
  let editingDialogues = false;
  let rendererReady = false;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const windowLifetime = createWindowLifetime({ alive });
  const isDisabled = createDisableGuard(() => readPluginState());
  function logLifecycle(details) {
    try {
      fs.mkdirSync(work, { recursive: true });
      fs.appendFileSync(path.join(work, 'lifecycle.jsonl'), JSON.stringify({ time: new Date().toISOString(), petPid: process.pid, ...details }) + '\n');
    } catch {}
  }
  const skins = new SkinLibrary(app.getPath('userData'));
  const dialogueLibrary = new DialogueLibrary(app.getPath('userData'));
  const defaultSkin = { id: 'default', name: '默认 · 鲸鱼娘', url: pathToFileURL(path.join(project, 'assets', 'pet.png')).href };
  const builtInSkins = [defaultSkin, {
    id: 'rose', name: '紫角玫瑰 · 半身',
    url: pathToFileURL(path.join(project, 'assets', 'skins', '紫角玫瑰-半身-v2.png')).href
  }];
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const cacheFile = path.join(app.getPath('userData'), 'quota-cache.json');
  const initialData = smokeTest ? dataDir : app.getPath('userData');
  let preferences = { placement: { right: 2, bottom: 2 } };
  try { preferences = { ...preferences, ...JSON.parse(fs.readFileSync(path.join(initialData, 'settings.json'), 'utf8')) }; } catch {}
  preferences.sizeLevel = sizeLevelFromPreferences(preferences);
  Object.assign(preferences, experienceFromPreferences(smokeTest ? {} : preferences));
  delete preferences.scale;
  delete preferences.alwaysOnTop;
  delete preferences.enabled;
  delete preferences.bubble;
  let state = { quota: null, loading: false, stale: false, error: null, bubble: false, sizeLevel: preferences.sizeLevel };
  state.dialogues = smokeTest ? defaultDialogues() : dialogueLibrary.load();
  state.skin = skinState(preferences.skinId);
  preferences.skinId = state.skin.id;
  try { state.quota = JSON.parse(fs.readFileSync(path.join(initialData, 'quota-cache.json'), 'utf8')); state.stale = true; } catch {}

  function savePreferences() {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(preferences, null, 2));
  }
  function saveRuntime() {
    const file = path.join(app.getPath('userData'), 'runtime.json');
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({
      pid: process.pid, mode: pluginMode ? 'plugin' : 'development', root: project, pluginId: PLUGIN_ID,
      startedAt: startupStartedAt, updatedAt: Date.now()
    }));
    fs.renameSync(temporary, file);
  }
  function publish() {
    state.experience = experienceFromPreferences(preferences);
    state.anchorLeft = preferences.placement?.anchorX === 'left';
    state.refreshAvailableAt = lastAttempt ? lastAttempt + 10000 : 0;
    if (win && !win.isDestroyed() && rendererReady) win.webContents.send('pet:state', state);
  }
  function setExperience(key, value) {
    const next = experienceFromPreferences({ ...preferences, [key]: value });
    if (!Object.hasOwn(next, key) || next[key] !== value) return;
    preferences[key] = value;
    savePreferences();
    updateInputRegion();
    publish();
  }
  function resetPlacement() {
    cancelDrag();
    preferences.placement = { right: 2, bottom: 2, anchorX: 'right', anchorY: 'bottom' };
    savePreferences();
    updateScope(scope);
    publish();
  }
  function setSizeLevel(level) {
    if (!isSizeLevel(level)) return;
    cancelDrag();
    preferences.sizeLevel = level;
    state.sizeLevel = level;
    savePreferences();
    updateScope(scope);
    publish();
  }
  function skinState(id) {
    const builtIn = builtInSkins.find(skin => skin.id === id);
    if (builtIn) return { ...builtIn };
    const skin = skins.get(id);
    return skin ? { id: skin.id, name: skin.name, url: pathToFileURL(skin.file).href } : { ...defaultSkin };
  }
  function setSkin(id) {
    cancelDrag();
    state.skin = skinState(id);
    preferences.skinId = state.skin.id;
    savePreferences();
    publish();
  }
  async function validateSkinImage(bytes, mime) {
    const url = `data:${mime};base64,${bytes.toString('base64')}`;
    const valid = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const image = new Image();
      const timer = setTimeout(() => resolve(false), 10000);
      image.onload = () => {
        clearTimeout(timer);
        resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      };
      image.onerror = () => { clearTimeout(timer); resolve(false); };
      image.src = ${JSON.stringify(url)};
    })`);
    if (!valid) throw new Error('这张图片无法显示，可能已损坏。请换一张图片。');
  }
  async function importSkinFile(file) {
    const skin = await skins.import(file, validateSkinImage);
    setSkin(skin.id);
    return skin;
  }
  async function chooseSkinImage() {
    if (importingSkin || deletingSkin || editingDialogues) return;
    importingSkin = true;
    cancelDrag();
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '导入角色图片', buttonLabel: '调整这张图片', properties: ['openFile'],
        filters: [{ name: '图片皮肤', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      });
      if (!result.canceled && result.filePaths[0]) {
        const source = readImageFile(result.filePaths[0]);
        await validateSkinImage(source.bytes, source.mime);
        const edited = await openSkinEditor(win, source);
        if (edited) {
          const skin = await skins.importBytes(edited.bytes, edited.name, validateSkinImage);
          setSkin(skin.id);
        }
      }
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法导入皮肤',
        message: '皮肤导入失败', detail: error.code ? '无法读取或保存图片，请确认文件存在且目录可写。' : error.message });
    } finally { importingSkin = false; }
  }
  async function deleteImportedSkin(id) {
    if (importingSkin || deletingSkin || editingDialogues) return false;
    const skin = skins.get(id);
    if (!skin) return false;
    deletingSkin = true;
    cancelDrag();
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: '删除导入皮肤', message: `删除“${skin.name}”？`,
        detail: `删除插件中保存的这张皮肤，原始图片仍会保留。${state.skin.id === id ? '\n删除后将恢复默认角色。' : ''}`,
        buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (result.response !== 1 || !skins.remove(id)) return false;
      if (state.skin.id === id) setSkin('default');
      return true;
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法删除皮肤',
        message: '皮肤删除失败', detail: error.code ? '无法删除保存的皮肤，请检查文件是否被占用或目录是否可写。' : error.message });
      return false;
    } finally { deletingSkin = false; }
  }
  async function chooseDialogueEditor() {
    if (editingDialogues || importingSkin || deletingSkin) return;
    editingDialogues = true; cancelDrag();
    try {
      await openDialogueEditor(win, state.dialogues, saveDialogues);
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法编辑台词', message: '台词编辑窗口未能打开，请重试。' });
    } finally { editingDialogues = false; }
  }
  function saveDialogues(draft) {
    state.dialogues = dialogueLibrary.save(draft);
    publish();
  }
  function buildFunctionMenu() {
    const importedSkins = skins.list();
    return Menu.buildFromTemplate([
      { label: '角色大小', submenu: SIZE_SCALES.map((scale, index) => ({
        label: `${index + 1} 档 · ${Math.round(scale * 100)}%${index + 1 === DEFAULT_SIZE_LEVEL ? '（默认）' : ''}`,
        type: 'radio', checked: preferences.sizeLevel === index + 1,
        click: () => setSizeLevel(index + 1)
      })) },
      { label: '更换皮肤', submenu: [
        ...builtInSkins.map(skin => ({ label: skin.name, type: 'radio', checked: state.skin.id === skin.id,
          click: () => setSkin(skin.id) })),
        ...importedSkins.map(skin => ({ label: skin.name.replace(/&/g, '&&'), type: 'radio',
          checked: state.skin.id === skin.id, click: () => setSkin(skin.id) })),
        { type: 'separator' },
        { label: '删除导入皮肤', enabled: importedSkins.length > 0 && !importingSkin && !deletingSkin,
          submenu: importedSkins.map(skin => ({
            label: `${skin.name.replace(/&/g, '&&')}${state.skin.id === skin.id ? '（当前使用）' : ''}`,
            click: () => deleteImportedSkin(skin.id)
          })) },
        { label: '导入图片…', enabled: !importingSkin && !deletingSkin && !editingDialogues, click: chooseSkinImage }
      ] },
      { label: '编辑台词…', enabled: !importingSkin && !deletingSkin && !editingDialogues, click: chooseDialogueEditor },
      { label: '互动设置', submenu: [
        { label: '对话框停留', submenu: BUBBLE_SECONDS.map(seconds => ({
          label: seconds === 0 ? '保持显示（Esc 收起）' : `${seconds} 秒${seconds === 8 ? '（默认）' : ''}`,
          type: 'radio', checked: preferences.bubbleSeconds === seconds,
          click: () => setExperience('bubbleSeconds', seconds)
        })) },
        { label: '点人物继续对话', type: 'checkbox', checked: preferences.advanceOnPetTap,
          click: item => setExperience('advanceOnPetTap', item.checked) },
        { label: '贴左侧时转向', type: 'checkbox', checked: preferences.mirrorOnLeft,
          click: item => setExperience('mirrorOnLeft', item.checked) },
        { label: '减少动画', type: 'checkbox', checked: preferences.reducedMotion,
          click: item => setExperience('reducedMotion', item.checked) }
      ] },
      { label: '回到右下角', click: resetPlacement },
      { type: 'separator' },
      { label: '刷新额度', enabled: !state.loading && Date.now() - lastAttempt >= 10000, click: () => refresh() }
    ]);
  }
  function openFunctionMenu() {
    cancelDrag();
    functionMenu = buildFunctionMenu();
    functionMenu.popup({ window: win });
  }
  async function nativeWindowState(mode) {
    if (process.platform !== 'win32') return { topmost: win.isAlwaysOnTop() };
    // Inspect the actual Windows flags for our own HWND.
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
    const output = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'window-topmost.ps1'), '-WindowHandle', hwnd,
        '-Topmost', mode],
      { windowsHide: true, timeout: 30000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return JSON.parse(output.trim());
  }
  function positionWindow() {
    if (!win || win.isDestroyed() || !scope.rect) return false;
    const area = currentArea();
    const layout = scopedBounds(area, scaleForLevel(preferences.sizeLevel), preferences.placement);
    if (!layout) { win.hide(); return false; }
    const bounds = win.getBounds();
    if (!drag && Object.keys(layout.bounds).some(key => Math.abs(bounds[key] - layout.bounds[key]) > 1)) {
      win.setBounds(layout.bounds);
    }
    if (win.webContents.getZoomFactor() !== layout.scale) win.webContents.setZoomFactor(layout.scale);
    updateInputRegion();
    return true;
  }
  function currentArea() {
    return screen.screenToDipRect(null, scope.rect);
  }
  function updateScope(next) {
    const previous = scope;
    windowLifetime.observe(next);
    // A failed geometry query during a resize is not a window close. Wait for
    // the next native sample; explicit minimize/close still hides immediately.
    if (next.reason === 'geometry-unavailable' && next.hwnd === previous.hwnd) return;
    scope = next;
    if (!win || win.isDestroyed() || !rendererReady) return;
    const changed = shouldShow(previous) !== shouldShow(scope) || previous.hwnd !== scope.hwnd
      || ['width', 'height'].some(key => previous.rect?.[key] !== scope.rect?.[key]);
    if (changed) {
      cancelDrag();
      logLifecycle({ event: 'scope-change', active: next.active, reason: next.reason, hwnd: next.hwnd, codexPid: next.codexPid, ownerBound: next.ownerBound });
    }
    if (shouldShow(scope) && positionWindow()) {
      if (changed || !win.isVisible()) {
        win.setEnabled(true);
        win.setIgnoreMouseEvents(false);
        win.showInactive();
        win.webContents.invalidate();
        if (startupTiming.firstVisibleMs === undefined) {
          startupTiming.firstVisibleMs = Date.now() - startupStartedAt;
          fs.mkdirSync(work, { recursive: true });
          try { fs.writeFileSync(path.join(work, 'startup-timing.json'), JSON.stringify(startupTiming, null, 2)); } catch {}
        }
      }
    } else { cancelDrag(); win.hide(); }
    fs.mkdirSync(work, { recursive: true });
    try { fs.writeFileSync(path.join(work, 'scope-status.json'), JSON.stringify({
      ...scope, visible: win.isVisible(), enabled: win.isEnabled(),
      windowHandle: win.getNativeWindowHandle().readBigUInt64LE().toString(),
      bounds: win.getBounds(), placement: preferences.placement, sizeLevel: preferences.sizeLevel,
      skinId: state.skin.id, skinName: state.skin.name
    }, null, 2)); } catch {}
  }
  function startScopeMonitor() {
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
    scopeMonitor = createScopeMonitor({ launch: () => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'codex-scope.ps1'), '-WindowHandle', hwnd,
      '-CacheDirectory', path.join(work, 'native')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), onScope: updateScope, onDiagnostic: logLifecycle });
    scopeMonitor.start();
  }
  async function loadRenderer() {
    await win.loadFile(path.join(__dirname, 'index.html'));
    rendererReady = true;
    startupTiming.rendererReadyMs ??= Date.now() - startupStartedAt;
    updateScope(scope);
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (Date.now() - lastAttempt < 10000) return state;
    lastAttempt = Date.now();
    state.loading = true; state.error = null; publish();
    refreshPromise = (async () => {
      try {
        state.quota = await readQuota();
        state.stale = false;
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        try { fs.writeFileSync(cacheFile, JSON.stringify(state.quota, null, 2)); } catch {}
      } catch (error) {
        state.error = error.message;
        state.stale = Boolean(state.quota);
      } finally {
        state.loading = false; refreshPromise = null; publish();
      }
      return state;
    })();
    return refreshPromise;
  }
  function updateInputRegion() {
    const scale = win.webContents.getZoomFactor();
    const mirrored = preferences.mirrorOnLeft && preferences.placement?.anchorX === 'left';
    const key = JSON.stringify([scale, inputBubble, mirrored, win.getSize()]);
    if (inputRegionKey === key) return;
    win.setShape(inputRegions(scale, mirrored, inputBubble));
    inputRegionKey = key;
  }
  function pointerPoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x, y: point.y } : screen.getCursorScreenPoint();
  }
  function dragStart(point) {
    const bounds = win.getBounds();
    const layout = scope.rect ? scopedBounds(currentArea(), scaleForLevel(preferences.sizeLevel), preferences.placement) : null;
    // Keep the intended size: getBounds() can round up at fractional DPI.
    drag = { cursor: pointerPoint(point), bounds: { ...bounds,
      width: layout?.bounds.width ?? bounds.width, height: layout?.bounds.height ?? bounds.height }, moved: false };
  }
  function dragMove(point) {
    if (!drag || !scope.rect) return;
    const cursor = pointerPoint(point);
    const area = currentArea();
    const snapped = snapBounds(area, { ...drag.bounds,
      x: drag.bounds.x + cursor.x - drag.cursor.x, y: drag.bounds.y + cursor.y - drag.cursor.y });
    if (!snapped) { cancelDrag(); positionWindow(); return; }
    drag.moved = true;
    win.setBounds(snapped.bounds);
  }
  function dragEnd() {
    if (drag?.moved && scope.rect) {
      const snapped = snapBounds(currentArea(), { ...win.getBounds(),
        width: drag.bounds.width, height: drag.bounds.height });
      if (snapped) {
        win.setBounds(snapped.bounds);
        preferences.placement = snapped.placement;
        savePreferences();
      }
    }
    drag = null;
    updateInputRegion();
    publish();
  }
  function cancelDrag() {
    drag = null;
    if (win && !win.isDestroyed() && rendererReady) win.webContents.send('pet:reset-input');
  }

  async function runSnapSmoke() {
    const originalPlacement = { ...preferences.placement };
    const originalLevel = preferences.sizeLevel;
    const area = currentArea();
    const { width, height } = win.getBounds();
    const left = area.x + 2, right = area.x + area.width - width - 2;
    const top = area.y + 2, bottom = area.y + area.height - height - 2;
    const centerX = Math.round((left + right) / 2), centerY = Math.round((top + bottom) / 2);
    const checks = [];
    function moveTo(x, y) {
      const current = win.getBounds();
      dragStart({ x: 0, y: 0 });
      dragMove({ x: x - current.x, y: y - current.y });
      dragEnd();
    }
    try {
      for (const [label, x, y, anchorX, anchorY] of [
        ['left', left + 12, centerY, 'left', null], ['right', right - 12, centerY, 'right', null],
        ['top', centerX, top + 12, null, 'top'], ['bottom', centerX, bottom - 12, null, 'bottom'],
        ['top-left', left + 12, top + 12, 'left', 'top'],
        ['top-right', right - 12, top + 12, 'right', 'top'],
        ['bottom-left', left + 12, bottom - 12, 'left', 'bottom'],
        ['bottom-right', right - 12, bottom - 12, 'right', 'bottom']
      ]) {
        moveTo(x, y);
        const actual = win.getBounds();
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).placement;
        const expected = { x: anchorX === 'left' ? left : anchorX === 'right' ? right : x,
          y: anchorY === 'top' ? top : anchorY === 'bottom' ? bottom : y };
        checks.push({ label, snapped: saved.anchorX === anchorX && saved.anchorY === anchorY,
          persisted: JSON.stringify(saved) === JSON.stringify(preferences.placement),
          actual: { x: actual.x, y: actual.y, width: actual.width, height: actual.height }, expected,
          sizeStable: Math.abs(actual.width - width) <= 1 && Math.abs(actual.height - height) <= 1,
          // Windows may round the DIP/native-pixel conversion at fractional DPI.
          nativePosition: Math.abs(actual.x - expected.x) <= 1 && Math.abs(actual.y - expected.y) <= 1 });
      }
      moveTo(left + 12, top + 12);
      const sizesKeepAnchor = [];
      for (const level of [1, 10]) {
        setSizeLevel(level);
        const actual = win.getBounds();
        sizesKeepAnchor.push(actual.x === area.x + 2 && actual.y === area.y + 2);
      }
      setSizeLevel(originalLevel);
      moveTo(centerX, centerY);
      const released = preferences.placement.anchorX === null && preferences.placement.anchorY === null;
      // A click still invokes drag start/end, and must not change a free position near an edge.
      preferences.placement = { right: area.x + area.width - width - left - 12,
        bottom: area.y + area.height - height - centerY };
      positionWindow();
      const beforeTap = win.getBounds();
      dragStart({ x: 0, y: 0 }); dragEnd();
      const afterTap = win.getBounds();
      return { checks, sizesKeepAnchor, released,
        tapDoesNotSnap: beforeTap.x === afterTap.x && beforeTap.y === afterTap.y };
    } finally {
      preferences.placement = originalPlacement;
      setSizeLevel(originalLevel);
    }
  }

  async function runSkinSmoke() {
    const originalSkin = state.skin.id;
    const fixtures = path.join(work, 'skin-fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const source = path.join(fixtures, '自定义 角色.png');
    const fixture = path.join(project, 'assets', 'reference.png');
    fs.copyFileSync(fs.existsSync(fixture) ? fixture : path.join(project, 'assets', 'pet.png'), source);
    const openDialog = dialog.showOpenDialog;
    const messageDialog = dialog.showMessageBox;
    const failures = [];
    let selection = { canceled: false, filePaths: [source] };
    let chooserOptions;
    dialog.showOpenDialog = async (_window, options) => { chooserOptions = options; return selection; };
    dialog.showMessageBox = async (_window, options) => { failures.push(options); return { response: 0 }; };
    const skinMenu = () => buildFunctionMenu().items.find(item => item.label === '更换皮肤').submenu;
    const importFromMenu = async () => {
      skinMenu().items.at(-1).click();
      const deadline = Date.now() + 15000;
      while (importingSkin && Date.now() < deadline) {
        const editor = getEditorWindow();
        if (editor && !editor.isDestroyed() && !editor.webContents.isLoading()) {
          await editor.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('#original'); if (button && !button.disabled) button.click();
          })()`);
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (importingSkin) throw new Error('Skin chooser did not finish.');
    };
    const imageReady = () => win.webContents.executeJavaScript(`new Promise(resolve => {
      let attempts = 0;
      const check = () => {
        const image = document.querySelector('#pet-image');
        if (image.src === ${JSON.stringify(state.skin.url)} && image.complete && image.naturalWidth > 0)
          resolve({ width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit });
        else if (++attempts > 150) resolve(null);
        else setTimeout(check, 30);
      };
      check();
    })`);
    try {
      await importFromMenu();
      const custom = { ...state.skin };
      const loaded = await imageReady();
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).skinId === custom.id;
      const reopened = new SkinLibrary(app.getPath('userData')).get(custom.id);
      fs.unlinkSync(source);
      const copied = Boolean(reopened && fs.existsSync(reopened.file));
      fs.writeFileSync(path.join(work, 'skin-preview.png'), (await win.webContents.capturePage()).toPNG());
      const count = skins.list().length;
      await importSkinFile(reopened.file);
      const deduplicated = skins.list().length === count;
      selection = { canceled: true, filePaths: [] };
      await importFromMenu();
      const canceledKeepsSkin = state.skin.id === custom.id;
      const broken = path.join(fixtures, '损坏图片.png');
      fs.writeFileSync(broken, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      selection = { canceled: false, filePaths: [broken] };
      await importFromMenu();
      const invalidKeepsSkin = state.skin.id === custom.id && failures.length === 1 && skins.list().length === count;
      const formats = [];
      const gif = Buffer.from('R0lGODlhDAASAIEAAHi+9QAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAEgAAACwAAAAADAASAAAIGgABCBxIsKDBgwgTKlzIsKHDhxAjSpxI0WBAACH5BAESAAEALAAAAAAMABIAgfqqeAAAAAAAAAAAAAgaAAEIHEiwoMGDCBMqXMiwocOHECNKnEjRYEAAOw==', 'base64');
      const webp = Buffer.from('UklGRuQAAABXRUJQVlA4WAoAAAASAAAACwAAEQAAQU5JTQYAAAAAAAAAAABBTk1GYgAAAAAAAAAAAAsAABEAALQAAAJBTFBICgAAAAEHUNqICERE/wNWUDggOAAAADADAJ0BKgwAEgA+bSySRaQioZgEAEAGxKALsugH4AAIRQAA/u+JB/8Qz0epku//FnIxHZfInIAAQU5NRk4AAAAAAAAAAAALAAARAAC0AAAAVlA4IDYAAADUAgCdASoMABIAPm0skkWDAIAAANiUAOwB+AAJuovgAP7w8av//izkYjs83//xu7cy7UAAAAA=', 'base64');
      const bmp = Buffer.alloc(54 + 12 * 18 * 3, 120);
      bmp.fill(0, 0, 54); bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(12, 18); bmp.writeInt32LE(18, 22);
      bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(12 * 18 * 3, 34);
      for (const [extension, bytes] of [['jpg', nativeImage.createFromPath(path.join(project, 'assets', 'pet.png')).toJPEG(80)],
        ['gif', gif], ['webp', webp], ['bmp', bmp]]) {
        const fixture = path.join(fixtures, `格式检查.${extension}`);
        fs.writeFileSync(fixture, bytes);
        const imported = await importSkinFile(fixture);
        formats.push({ extension, loaded: Boolean(await imageReady()), preserved: fs.readFileSync(imported.file).equals(bytes) });
      }
      const checked = skinMenu().items.filter(item => item.type === 'radio' && item.checked).length === 1;
      skinMenu().items[0].click();
      const restoredDefault = state.skin.id === 'default' && Boolean(await imageReady());
      setSkin(custom.id);
      await imageReady();
      const interactions = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#pet').click();
        const quotaOnly = !document.querySelector('#quota-view').inert && document.querySelector('#dialogue-view').inert;
        document.querySelector('#bubble').click();
        return quotaOnly && document.querySelector('#quota-view').inert && !document.querySelector('#dialogue-view').inert;
      })()`);
      return { imported: custom.id !== 'default' && Boolean(loaded), aspectRatioPreserved: loaded?.fit === 'contain',
        chooserFilters: chooserOptions.filters[0].extensions, saved, copied, deduplicated,
        canceledKeepsSkin, invalidKeepsSkin, formats, checked, restoredDefault, interactions };
    } finally {
      dialog.showOpenDialog = openDialog;
      dialog.showMessageBox = messageDialog;
      setSkin(originalSkin);
    }
  }

  async function runSmoke() {
    fs.mkdirSync(work, { recursive: true });
    const errors = [];
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    await refresh();
    const lifecycleRecovery = await require('./lifecycle-smoke.cjs').checkLifecycleRecovery({
      win, monitor: scopeMonitor, getScope: () => scope,
      isRendererReady: () => rendererReady, nativeWindowState
    });
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const before = await win.webContents.executeJavaScript(`({
      text: document.querySelector('#bubble').innerText,
      imageReady: document.querySelector('#pet-image').complete && document.querySelector('#pet-image').naturalWidth > 0,
      scrollWidth: document.documentElement.scrollWidth,
      width: innerWidth,
      petBounds: document.querySelector('#pet').getBoundingClientRect().toJSON(),
      bubbleBounds: document.querySelector('#bubble').getBoundingClientRect().toJSON()
    })`);
    let dragReport = null;
    if (shouldShow(scope)) {
      const originalPlacement = { ...preferences.placement };
      const initialBounds = win.getBounds();
      dragStart();
      drag.cursor.x += 48; drag.cursor.y += 32;
      dragMove(); dragEnd();
      const movedBounds = win.getBounds();
      const area = currentArea();
      dragReport = { moved: movedBounds.x < initialBounds.x || movedBounds.y < initialBounds.y,
        withinCodex: movedBounds.x >= area.x && movedBounds.y >= area.y
          && movedBounds.x + movedBounds.width <= area.x + area.width + 1
          && movedBounds.y + movedBounds.height <= area.y + area.height + 1,
        placementUpdated: preferences.placement.right > originalPlacement.right || preferences.placement.bottom > originalPlacement.bottom };
      preferences.placement = originalPlacement;
      positionWindow();
    }
    const inputStates = [];
    for (const [label, x, y] of [['blank', 1, 1], ['face', 220, 390], ['blank-again', 1, 1]]) {
      await win.webContents.executeJavaScript(`(async () => {
        document.elementFromPoint(${x}, ${y}).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${x}, clientY: ${y} }));
        await window.petAPI.getState();
      })()`);
      inputStates.push({ label, ...(await nativeWindowState('inspect')) });
    }
    const recovery = [];
    const activeScope = { ...scope };
    for (let attempt = 0; attempt < 3 && shouldShow(activeScope); attempt++) {
      updateScope({ active: false });
      await new Promise(resolve => setTimeout(resolve, 50));
      updateScope(activeScope);
      await win.webContents.executeJavaScript('window.petAPI.getState()');
      // A real native focus change reproduces clicking this frameless window.
      // Merely dispatching DOM pointer events cannot exercise the scope monitor.
      win.focus();
      // The monitor also publishes a heartbeat when its foreground payload
      // stays unchanged; wait for that fresh native observation after restore.
      await new Promise(resolve => setTimeout(resolve, 1200));
      const scale = win.webContents.getZoomFactor();
      const x = Math.round(220 * scale), y = Math.round(390 * scale);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));
      const tap = await win.webContents.executeJavaScript(`({
        animated: document.querySelector('#pet-image').getAnimations().length > 0,
        bubble: !document.body.classList.contains('no-bubble'),
        dragging: document.body.classList.contains('dragging')
      })`);
      recovery.push({ attempt, enabled: win.isEnabled(), visible: win.isVisible(),
        focused: win.isFocused(), foregroundIsPet: scope.foregroundIsPet === true,
        codexStillActive: shouldShow(scope), ...tap });
      await new Promise(resolve => setTimeout(resolve, 850));
    }
    const animation = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#pet').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const active = document.querySelector('#pet-image').getAnimations();
      const frames = active[0]?.effect.getKeyframes();
      await Promise.all(active.map(item => item.finished));
      await Promise.all(document.querySelector('#reaction').getAnimations().map(item => item.finished));
      return { count: active.length, frames, transformAfter: getComputedStyle(document.querySelector('#pet-image')).transform };
    })()`);
    const clickViews = await win.webContents.executeJavaScript(`(async () => {
      bubbleUntil = 0; dialogueStarted = false; render();
      document.querySelector('#pet').click();
      await new Promise(resolve => setTimeout(resolve, 350));
      const quota = document.querySelector('#quota-view');
      const speech = document.querySelector('#dialogue-view');
      const bubble = document.querySelector('#bubble');
      return { quotaOnly: !quota.inert && speech.inert
          && getComputedStyle(quota).opacity === '1' && getComputedStyle(speech).opacity === '0',
        ellipse: getComputedStyle(bubble).borderTopLeftRadius === '50%',
        animatedTransition: getComputedStyle(bubble).transitionDuration.includes('0.22s') };
    })()`);
    const quotaPreview = await win.webContents.capturePage();
    fs.writeFileSync(path.join(work, 'quota-preview.png'), quotaPreview.toPNG());
    clickViews.repeatedPetQuotaOnly = await win.webContents.executeJavaScript(`(async () => {
      for (let count = 0; count < 5; count++) document.querySelector('#pet').click();
      await new Promise(resolve => setTimeout(resolve, 350));
      return !document.querySelector('#quota-view').inert && document.querySelector('#dialogue-view').inert;
    })()`);
    clickViews.dialogueOnly = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#bubble').click();
      await new Promise(resolve => setTimeout(resolve, 350));
      const quota = document.querySelector('#quota-view');
      const speech = document.querySelector('#dialogue-view');
      return quota.inert && !speech.inert && getComputedStyle(quota).opacity === '0'
        && getComputedStyle(speech).opacity === '1' && !document.querySelector('#bubble').title;
    })()`);
    const dialogue = await win.webContents.executeJavaScript(`(() => {
      const lines = [], layoutProblems = [];
      const button = document.querySelector('#dialogue-next');
      const text = document.querySelector('#dialogue');
      for (let index = 0; index < speechLines.length; index++) {
        button.click();
        lines.push(text.textContent);
        const bubble = document.querySelector('#bubble').getBoundingClientRect();
        const content = button.getBoundingClientRect();
        if (content.bottom > bubble.bottom - 25 || content.right > bubble.right - 25
          || text.scrollHeight > text.clientHeight + 1) layoutProblems.push(index);
      }
      const beforeClick = text.textContent;
      button.click();
      return { count: new Set(lines).size, changed: text.textContent !== beforeClick,
        chineseOnly: lines.every(line => !/[a-z]/i.test(line)), layoutProblems,
        current: text.textContent };
    })()`);
    await win.webContents.executeJavaScript(`Promise.all([
      ...document.querySelector('#pet-image').getAnimations(),
      ...document.querySelector('#reaction').getAnimations(),
      ...document.querySelector('#dialogue').getAnimations()
    ].map(item => item.finished))`);
    const preview = await win.webContents.capturePage();
    fs.writeFileSync(path.join(work, 'preview.png'), preview.toPNG());
    fs.writeFileSync(path.join(work, 'dialogue-preview.png'), preview.toPNG());
    const menuScale = win.webContents.getZoomFactor();
    const menuX = Math.round(220 * menuScale), menuY = Math.round(390 * menuScale);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: menuX, y: menuY, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: menuX, y: menuY, button: 'right', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 350));
    const menu = { openedByRightClick: Boolean(functionMenu),
      sizeChoices: functionMenu?.items[0].submenu.items.length,
      hasRefresh: functionMenu?.items.some(item => item.label === '刷新额度') === true };
    functionMenu?.closePopup(win);
    const originalLevel = preferences.sizeLevel;
    const sizes = [];
    for (let level = 1; level <= SIZE_SCALES.length; level++) {
      const choices = buildFunctionMenu().items[0].submenu.items;
      choices[level - 1].click();
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const area = scope.rect ? currentArea() : null;
      const bounds = win.getBounds();
      const checked = buildFunctionMenu().items[0].submenu.items.filter(item => item.checked);
      const expected = area ? scopedBounds(area, scaleForLevel(level), preferences.placement) : null;
      sizes.push({ level, selected: state.sizeLevel === level,
        saved: sizeLevelFromPreferences(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) === level,
        menuCount: choices.length, checkedCount: checked.length,
        checkedLabel: checked[0]?.label, scale: win.webContents.getZoomFactor(), bounds, expectedBounds: expected?.bounds,
        sizeApplied: Boolean(expected) && Math.abs(win.webContents.getZoomFactor() - expected.scale) < 0.001
          && Math.abs(bounds.width - expected.bounds.width) <= 1 && Math.abs(bounds.height - expected.bounds.height) <= 1,
        withinCodex: Boolean(area) && bounds.x >= area.x && bounds.y >= area.y
          && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height });
      if (level === 1 || level === 10) {
        fs.writeFileSync(path.join(work, `size-${level}-preview.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    setSizeLevel(originalLevel);
    const skinChecks = await runSkinSmoke();
    const editorChecks = await require('./skin-editor-smoke.cjs')({ win, work, settingsFile,
      chooseSkinImage, getEditorWindow, getSkin: () => state.skin, setSkin });
    const deleteChecks = await require('./skin-delete-smoke.cjs')({ win, work, settingsFile, skins,
      getMenu: buildFunctionMenu, getSkin: () => state.skin, setSkin, importSkinFile, deleteImportedSkin });
    const snapChecks = await runSnapSmoke();
    const experienceChecks = await require('./experience-smoke.cjs')({ win, work, settingsFile,
      getMenu: buildFunctionMenu, getOpenMenu: () => functionMenu, getPreferences: () => preferences, setSkin,
      setPlacement: placement => { preferences.placement = placement; savePreferences(); positionWindow(); publish(); } });
    const bubbleChecks = await require('./bubble-smoke.cjs')({ win, work, getPreferences: () => preferences,
      setPlacement: placement => { preferences.placement = placement; savePreferences(); positionWindow(); publish(); },
      dragStart, dragMove, dragEnd });
    const dialogueEditorChecks = await require('./dialogue-editor-smoke.cjs')({ win, work, getMenu: buildFunctionMenu,
      chooseDialogueEditor, getDialogueEditorWindow, getDialogues: () => state.dialogues,
      saveDialogues, dialogueFile: dialogueLibrary.file });
    const bounds = win.getBounds();
    const area = scope.rect ? currentArea() : null;
    const native = await nativeWindowState('inspect');
    const report = {
      quotaAvailable: Boolean(state.quota) && !state.error,
      remaining: state.quota?.buckets[0]?.windows[0]?.remaining,
      transparent: preview.getBitmap()[3] === 0, globalTopmost: native.topmost,
      scope, native, bounds, codexClientArea: area,
      bottomRight: area ? Math.abs(bounds.x + bounds.width - (area.x + area.width - 2)) <= 1
        && Math.abs(bounds.y + bounds.height - (area.y + area.height - 2)) <= 1 : null,
      boundToCodex: shouldShow(scope) ? native.visible && native.owner === scope.hwnd : !native.visible,
      before, animation, clickViews, dialogue, menu, sizes, skinChecks, editorChecks, deleteChecks, snapChecks, experienceChecks, bubbleChecks, dialogueEditorChecks, lifecycleRecovery, inputStates, recovery, drag: dragReport, errors
    };
    const pass = report.quotaAvailable && report.transparent && !report.globalTopmost && report.boundToCodex && before.imageReady
      && animation.count > 0 && animation.transformAfter === 'none' && !errors.length;
    report.pass = pass && inputStates.every(item => !item.topmost)
      && inputStates.every(item => item.clickThrough === false);
    // Focus requests may be declined by Windows when another application is
    // foreground. Visibility and interaction must work in either foreground.
    report.pass = report.pass && recovery.every(item => item.enabled && item.visible
      && item.codexStillActive && item.animated && item.bubble && !item.dragging);
    report.pass = report.pass && dialogue.count === 24 && dialogue.changed
      && dialogue.chineseOnly && dialogue.layoutProblems.length === 0;
    report.pass = report.pass && Object.values(clickViews).every(Boolean);
    report.pass = report.pass && menu.openedByRightClick && menu.sizeChoices === 10 && menu.hasRefresh;
    report.pass = report.pass && sizes.every(item => item.selected && item.saved && item.menuCount === 10
      && item.checkedCount === 1 && item.checkedLabel.startsWith(`${item.level} 档`) && item.sizeApplied && item.withinCodex);
    report.pass = report.pass && ['imported', 'aspectRatioPreserved', 'saved', 'copied', 'deduplicated',
      'canceledKeepsSkin', 'invalidKeepsSkin', 'checked', 'restoredDefault', 'interactions'].every(key => skinChecks[key])
      && skinChecks.formats.every(item => item.loaded && item.preserved);
    report.pass = report.pass && snapChecks.checks.every(item => item.snapped && item.persisted && item.nativePosition && item.sizeStable)
      && snapChecks.sizesKeepAnchor.every(Boolean) && snapChecks.released && snapChecks.tapDoesNotSnap;
    if (dragReport) report.pass = report.pass && dragReport.moved && dragReport.withinCodex && dragReport.placementUpdated;
    report.pass = report.pass && experienceChecks.pass;
    report.pass = report.pass && bubbleChecks.pass;
    report.pass = report.pass && editorChecks.pass;
    report.pass = report.pass && deleteChecks.pass;
    report.pass = report.pass && dialogueEditorChecks.pass;
    report.pass = report.pass && lifecycleRecovery.bindingRecovered && lifecycleRecovery.rendererRecovered
      && lifecycleRecovery.ownerPreserved && !lifecycleRecovery.afterBinding.topmost && !lifecycleRecovery.afterRenderer.topmost;
    fs.writeFileSync(path.join(work, 'smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.pass ? 0 : 1);
  }

  app.whenReady().then(async () => {
    startupTiming.appReadyMs = Date.now() - startupStartedAt;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    saveRuntime();
    win = new BrowserWindow({ ...VIEWPORT, title: '大肥鱼 · Codex Pet',
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, show: false, focusable: true, alwaysOnTop: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    win.setMenu(null);
    win.setAlwaysOnTop(false);
    win.setIgnoreMouseEvents(false);
    updateInputRegion();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    publish();
    ipcMain.handle('pet:state', () => state);
    ipcMain.handle('pet:refresh', () => refresh());
    ipcMain.on('pet:menu', openFunctionMenu);
    ipcMain.on('pet:skin-load-failed', (_event, id) => {
      if (state.skin.id === id && id !== 'default') setSkin('default');
    });
    ipcMain.on('pet:drag-start', (_event, point) => dragStart(point));
    ipcMain.on('pet:drag-move', (_event, point) => dragMove(point));
    ipcMain.handle('pet:drag-end', dragEnd);
    ipcMain.on('pet:drag-cancel', cancelDrag);
    ipcMain.on('pet:input-region', (_event, bubble) => {
      inputBubble = bubble;
      updateInputRegion();
    });
    // Compile/load the native binding while Chromium loads the renderer.
    startScopeMonitor();
    win.on('closed', () => { logLifecycle({ event: 'window-closed', closing }); app.quit(); });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (closing || win.isDestroyed()) return;
      rendererReady = false; cancelDrag(); win.hide();
      logLifecycle({ event: 'renderer-reload', reason: details.reason, exitCode: details.exitCode });
      setTimeout(() => {
        if (!closing && !win.isDestroyed()) loadRenderer().catch(error => {
          logLifecycle({ event: 'renderer-reload-failed', detail: error.message }); app.quit();
        });
      }, 250);
    });
    win.on('blur', cancelDrag);
    screen.on('display-metrics-changed', positionWindow);
    screen.on('display-removed', positionWindow);
    screen.on('display-added', positionWindow);
    await loadRenderer();
    if (smokeTest) {
      // Native monitoring first compiles its interop helper. Wait for a usable
      // Codex observation before exercising size changes and focus recovery.
      const scopeDeadline = Date.now() + 30000;
      while (!shouldShow(scope) && Date.now() < scopeDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!shouldShow(scope)) throw new Error('Smoke 检查需要可见且未最小化的 Codex 窗口。');
      await runSmoke();
    } else {
      refresh();
      interval = setInterval(refresh, 120000);
      if (pluginMode) pluginInterval = setInterval(() => {
        let active = false;
        const directory = path.join(app.getPath('userData'), 'plugin-sessions');
        try {
          for (const file of fs.readdirSync(directory)) {
            if (!/^\d+\.json$/.test(file)) continue;
            if (alive(Number.parseInt(file, 10))) active = true;
          }
        } catch {}
        if (isDisabled() || windowLifetime.shouldExit(active)) {
          logLifecycle({ event: 'plugin-exit', reason: active ? 'plugin-disabled-or-codex-exited' : 'codex-exited-or-never-bound' });
          app.quit();
        } else { try { saveRuntime(); } catch {} }
      }, 1500);
    }
  }).catch(error => {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'startup-error.txt'), error.stack);
    console.error(error); app.exit(1);
  });
  app.on('second-instance', () => { if (win) updateScope(scope); });
  app.on('before-quit', () => { closing = true; clearInterval(interval); clearInterval(pluginInterval); scopeMonitor?.stop(); });
}
