const { app, BrowserWindow, Menu, dialog, ipcMain, screen, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createScopeMonitor } = require('./scope-monitor.cjs');
const { createWindowLifetime } = require('./plugin-window-lifetime.cjs');
const { PLUGIN_ID, readPluginState, createDisableGuard } = require('./startup-config.cjs');
const { pathToFileURL } = require('node:url');
const { readQuota } = require('./quota.cjs');
const { scopedBounds, snapBounds, clampBounds, shouldShow } = require('./scope.cjs');
const { writeJsonAtomic, createCoalescedWriter } = require('./persist.cjs');
const { DEFAULT_SKIN_ID, EXPERIENCE_KEYS, GROUP_KEYS, ALL_RESET_KEYS, resetPreferenceKeys, settingsKeyDefault, normalizeColorScheme } = require('./settings-ia.cjs');
const { createDebouncedShowHide, createDebouncedDiskStatus } = require('./scope-visibility.cjs');
const { SIZE_SCALES, DEFAULT_SIZE_LEVEL, isSizeLevel, sizeLevelFromPreferences, scaleForLevel } = require('./size.cjs');
const { getDataDir, getWorkDir } = require('./paths.cjs');
const { SkinLibrary, readImageFile } = require('./skins.cjs');
const { SkinPackLibrary, packCharacterId, parsePackCharacterId } = require('./skin-packs.cjs');
const {
  buildPreferencesBundle, parsePreferencesBundle, PREFERENCES_FILE_NAME, PREFERENCES_FILE_MAX_BYTES
} = require('./preferences-bundle.cjs');
const { IDLE_BUDGET, sessionProbeDelay, pluginPollDelay, shouldSaveRuntime } = require('./idle-budget.js');
const { openSkinEditor, getEditorWindow } = require('./skin-editor.cjs');
const { DialogueLibrary, defaultDialogues } = require('./dialogues.cjs');
const { openDialogueEditor, getDialogueEditorWindow } = require('./dialogue-editor.cjs');
const { BUBBLE_SECONDS, experienceFromPreferences } = require('./experience.cjs');
const { createCodexSessionProbe } = require('./codex-session-probe.cjs');
const { createSessionStateTracker, sessionPresentation } = require('./session-state.cjs');
const { VIEWPORT, inputRegions } = require('./layout.cjs');
const { openSettingsWindow, getSettingsWindow } = require('./settings-window.cjs');
const { noteDisplay, relocateToVisibleDisplay, planScreenEvent, nearestDisplay, SCREEN_EVENT_DELAY_MS } = require('./display-layout.cjs');
const { createSkinPackSession } = require('./skin-pack-session.cjs');
const { version: APP_VERSION, DISPLAY_VERSION } = require('./version-info.cjs');
const {
  interpolateBounds, interpolateZoom, boundsDiffer, zoomDiffer, settleDurationMs, createSettlePlayer
} = require('./motion.cjs');

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
  let win, interval, scopeMonitor, pluginInterval, sessionTimer, sessionTracker, functionMenu;
  let screenTimer = null;
  let refreshScalePending = false;
  let displayMemory = { displayId: null, scaleFactor: null, crossed: false, scaleChanged: false };
  let forceDisplayLayout = false;
  let scope = { active: false };
  let closing = false;
  let refreshPromise = null;
  let lastAttempt = 0;
  let lastRuntimeSavedAt = 0;
  let lastSessionVisible = null;
  let inputBubble = false;
  let inputRegionKey = '';
  let drag = null;
  let settle = null;
  let geometrySettled = Promise.resolve();
  let rendererReducedMotion = false;
  const settlePlayer = createSettlePlayer();
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
  const skinPacks = new SkinPackLibrary(app.getPath('userData'));
  const skinPackSession = createSkinPackSession({
    library: skinPacks,
    validateImage: (...args) => validateSkinImage(...args),
    onImported(pack) {
      const first = pack?.characters?.[0];
      if (first) setSkin(packCharacterId(pack.id, first.id));
    }
  });
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
  const sessionProbe = createCodexSessionProbe({ now: Date.now });
  sessionTracker = createSessionStateTracker({
    probe: () => sessionProbe.sample(),
    onUpdate: snapshot => { writeSessionStatus(snapshot); publish(); }
  });
  state.session = sessionPresentation(sessionTracker.snapshot());
  try { state.quota = JSON.parse(fs.readFileSync(path.join(initialData, 'quota-cache.json'), 'utf8')); state.stale = true; } catch {}

  const preferencesWriter = createCoalescedWriter({
    delayMs: 120,
    write(snapshot) { writeJsonAtomic(settingsFile, snapshot); }
  });
  const scopeStatusWriter = createDebouncedDiskStatus({
    delayMs: 250,
    write(snapshot) {
      fs.mkdirSync(work, { recursive: true });
      writeJsonAtomic(path.join(work, 'scope-status.json'), snapshot);
    }
  });
  function savePreferences({ immediate = false } = {}) {
    const snapshot = { ...preferences };
    if (immediate) {
      preferencesWriter.schedule(snapshot);
      preferencesWriter.flush();
      return;
    }
    preferencesWriter.schedule(snapshot);
  }
  function writeSessionStatus(snapshot) {
    try {
      fs.mkdirSync(work, { recursive: true });
      writeJsonAtomic(path.join(work, 'session-state.json'), { ...sessionPresentation(snapshot), activityAt: snapshot.activityAt, errorAt: snapshot.errorAt, checkedAt: new Date().toISOString() });
    } catch {}
  }
  function sessionVisible() {
    return Boolean(win && !win.isDestroyed() && win.isVisible() && shouldShow(scope));
  }
  function scheduleSessionProbe({ immediate = false } = {}) {
    if (smokeTest || !sessionTracker) return;
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
    const visible = sessionVisible();
    lastSessionVisible = visible;
    const delay = immediate ? 0 : sessionProbeDelay({ visible });
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      try { if (!closing) sessionTracker.sample(); } catch {}
      scheduleSessionProbe();
    }, delay);
  }
  function startSessionProbe() {
    if (!sessionTracker) return;
    writeSessionStatus(sessionTracker.snapshot());
    sessionTracker.sample();
    scheduleSessionProbe();
  }
  // Only hidden->visible changes need an immediate sample; ordinary scope
  // updates must not turn this into a 1s foreground probe.
  function refreshSessionSchedule() {
    if (smokeTest || !sessionTracker) return;
    const visible = sessionVisible();
    if (visible === lastSessionVisible) return;
    scheduleSessionProbe({ immediate: visible });
  }
  function flushPersistentState() {
    try { preferencesWriter.flush(); } catch {}
    try { scopeStatusWriter.flush(); } catch {}
  }
  function saveRuntime() {
    const file = path.join(app.getPath('userData'), 'runtime.json');
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({
      pid: process.pid, mode: pluginMode ? 'plugin' : 'development', root: project, pluginId: PLUGIN_ID,
      startedAt: startupStartedAt, updatedAt: Date.now()
    }));
    fs.renameSync(temporary, file);
    lastRuntimeSavedAt = Date.now();
  }
  function writeIdleBudgetSnapshot(reason) {
    try {
      const visible = sessionVisible();
      fs.mkdirSync(work, { recursive: true });
      writeJsonAtomic(path.join(work, 'idle-budget.json'), {
        budget: IDLE_BUDGET, reason, visible,
        sessionProbeMs: sessionProbeDelay({ visible }),
        pluginPollMs: pluginPollDelay(),
        updatedAt: new Date().toISOString()
      });
    } catch {}
  }
  function applyExperienceChrome() {
    const experience = experienceFromPreferences(preferences);
    if (win && !win.isDestroyed() && typeof win.setOpacity === 'function') {
      try { win.setOpacity(experience.opacity); } catch {}
    }
  }
  function publish() {
    if (sessionTracker) state.session = sessionPresentation(sessionTracker.snapshot());
    state.experience = experienceFromPreferences(preferences);
    state.sizeLevel = preferences.sizeLevel;
    state.skins = listSkins();
    state.anchorLeft = preferences.placement?.anchorX === 'left';
    state.refreshAvailableAt = lastAttempt ? lastAttempt + 10000 : 0;
    state.settingsOpen = Boolean(getSettingsWindow());
    state.version = APP_VERSION;
    state.displayVersion = DISPLAY_VERSION;
    state.colorScheme = normalizeColorScheme(preferences.colorScheme);
    try { applyExperienceChrome(); } catch {}
    if (win && !win.isDestroyed() && rendererReady) win.webContents.send('pet:state', state);
    const settingsWindow = getSettingsWindow();
    if (settingsWindow) {
      try { settingsWindow.webContents.send('settings:state', state); } catch {}
    }
  }
  function settingsBackground() {
    const scheme = normalizeColorScheme(preferences.colorScheme);
    let dark = scheme === 'dark';
    if (scheme === 'system') {
      try { dark = require('electron').nativeTheme.shouldUseDarkColors === true; } catch { dark = false; }
    }
    return dark ? '#161b2c' : '#f5f7fc';
  }
  function setExperience(key, value) {
    if (key === 'colorScheme') {
      preferences.colorScheme = normalizeColorScheme(value);
      savePreferences();
      const settingsWindow = getSettingsWindow();
      if (settingsWindow) { try { settingsWindow.setBackgroundColor(settingsBackground()); } catch {} }
      publish();
      return;
    }
    const mapped = key === 'idleInterval' ? 'idleIntervalSec' : key;
    const next = experienceFromPreferences({ ...preferences, [mapped]: value });
    if (!Object.hasOwn(next, mapped)) return;
    if (preferences[mapped] === next[mapped]) {
      applyExperienceChrome();
      publish();
      return;
    }
    preferences[mapped] = next[mapped];
    savePreferences();
    if (motionReduced()) cancelSettle({ apply: true });
    applyExperienceChrome();
    updateInputRegion();
    publish();
  }
  function setExperiences( partial = {} ) {
    const next = experienceFromPreferences({ ...preferences, ...partial });
    let changed = false;
    for (const key of Object.keys(next)) {
      if (preferences[key] !== next[key]) {
        preferences[key] = next[key];
        changed = true;
      }
    }
    if (changed) savePreferences();
    if (motionReduced()) cancelSettle({ apply: true });
    applyExperienceChrome();
    updateInputRegion();
    publish();
  }
  function resetPreferences(keys = []) {
    const result = resetPreferenceKeys(preferences, keys);
    if (!result.changed.length) { publish(); return false; }
    const changed = new Set(result.changed);
    if (changed.has('skinId')) setSkin(DEFAULT_SKIN_ID);
    if (changed.has('sizeLevel')) setSizeLevel(DEFAULT_SIZE_LEVEL);
    const experience = {};
    for (const key of result.changed) {
      if (EXPERIENCE_KEYS.includes(key)) experience[key] = settingsKeyDefault(key);
    }
    if (Object.keys(experience).length) setExperiences(experience);
    return true;
  }
  function resetPlacement() {
    cancelDrag();
    preferences.placement = { right: 2, bottom: 2, anchorX: 'right', anchorY: 'bottom' };
    savePreferences({ immediate: true });
    updateScope(scope);
    publish();
  }
  function setSizeLevel(level) {
    if (!isSizeLevel(level)) return Promise.resolve();
    cancelDrag();
    const changed = preferences.sizeLevel !== level;
    preferences.sizeLevel = level;
    state.sizeLevel = level;
    if (!changed) {
      updateScope(scope);
      publish();
      return geometrySettled;
    }
    savePreferences({ immediate: true });
    if (win && !win.isDestroyed() && scope.rect && shouldShow(scope)) {
      const area = currentArea();
      const layout = scopedBounds(area, scaleForLevel(level), preferences.placement);
      if (layout) {
        const pending = startSettle({
          fromBounds: win.getBounds(),
          toBounds: layout.bounds,
          fromZoom: win.webContents.getZoomFactor(),
          toZoom: layout.scale,
          area
        });
        pending.then(() => {
          if (!closing && !drag) {
            try { publishScopeStatus(false); } catch {}
          }
        });
        publish();
        return pending;
      }
    }
    updateScope(scope);
    publish();
    return geometrySettled;
  }
  function allSkins() {
    const builtIns = builtInSkins.map(skin => ({ ...skin, kind: 'builtin' }));
    const images = skins.list().map(skin => ({
      id: skin.id, name: skin.name, kind: 'image', url: pathToFileURL(skin.file).href
    }));
    // A pack may contain several characters. Each character is addressed by a
    // stable `pack:<packId>:<characterId>` key stored in the same skinId field
    // as legacy images, so switching never starts another window or process.
    const packed = skinPacks.list().flatMap(pack => pack.characters.map(character => ({
      id: packCharacterId(pack.id, character.id),
      name: `${pack.name} · ${character.name}`,
      kind: 'pack', packId: pack.id, characterId: character.id,
      url: pathToFileURL(character.file).href,
      thumbnailUrl: pathToFileURL(character.thumbnailFile || character.file).href
    })));
    return [...builtIns, ...images, ...packed];
  }
  function skinState(id) {
    const found = allSkins().find(skin => skin.id === id);
    return found ? { ...found } : { ...defaultSkin, kind: 'builtin' };
  }
  function setSkin(id) {
    cancelDrag();
    state.skin = skinState(id);
    preferences.skinId = state.skin.id;
    savePreferences({ immediate: true });
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
  function bindSkinPackWindow(settingsWindow) {
    if (!settingsWindow || settingsWindow.__skinPackBound || settingsWindow.isDestroyed?.()) return;
    settingsWindow.__skinPackBound = true;
    const senderId = settingsWindow.webContents.id;
    settingsWindow.webContents.once('destroyed', () => skinPackSession.releaseSender(senderId));
  }
  async function deleteImportedPack(id) {
    if (importingSkin || deletingSkin || editingDialogues) return false;
    const pack = skinPacks.get(id);
    if (!pack) return false;
    deletingSkin = true;
    cancelDrag();
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: '删除皮肤包', message: `删除“${pack.name}”？`,
        detail: `删除插件中保存的整个皮肤包（${pack.characters.length} 个角色），原始文件夹仍会保留。`,
        buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (result.response !== 1 || !skinPacks.remove(id)) return false;
      const selected = parsePackCharacterId(state.skin.id);
      if (selected?.packId === id) setSkin('default');
      return true;
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法删除皮肤包',
        message: '皮肤包删除失败', detail: error.code ? '无法删除保存的皮肤包，请检查文件是否被占用或目录是否可写。' : error.message });
      return false;
    } finally { deletingSkin = false; }
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
  async function applyPreferencesSettings(settings = {}) {
    if (settings.sizeLevel !== undefined && settings.sizeLevel !== preferences.sizeLevel) {
      await setSizeLevel(settings.sizeLevel);
    }
    const experience = {};
    for (const key of EXPERIENCE_KEYS) if (Object.hasOwn(settings, key)) experience[key] = settings[key];
    if (Object.keys(experience).length) setExperiences(experience);
    if (typeof settings.skinId === 'string' && settings.skinId && settings.skinId !== state.skin.id) {
      setSkin(settings.skinId);
    }
    if (settings.colorScheme) preferences.colorScheme = normalizeColorScheme(settings.colorScheme);
    savePreferences({ immediate: true });
  }
  async function exportPreferences() {
    cancelDrag();
    try {
      const result = await dialog.showSaveDialog(win, {
        title: '导出偏好', defaultPath: PREFERENCES_FILE_NAME,
        filters: [{ name: '大肥鱼偏好', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return false;
      const bundle = buildPreferencesBundle(preferences, listSkins());
      writeJsonAtomic(result.filePath, bundle);
      await dialog.showMessageBox(win, {
        type: 'info', title: '偏好已导出', message: '已导出设置与皮肤清单',
        detail: '文件不包含任何图片、缩略图、本地路径或自定义台词。'
      });
      return true;
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法导出偏好',
        message: '偏好导出失败', detail: error.code ? '无法写入所选位置，请换一个文件夹或检查权限。' : error.message });
      return false;
    }
  }
  async function importPreferences() {
    cancelDrag();
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '导入偏好', properties: ['openFile'],
        filters: [{ name: '大肥鱼偏好', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const file = result.filePaths[0];
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > PREFERENCES_FILE_MAX_BYTES) throw new Error('偏好文件过大。');
      const parsed = parsePreferencesBundle(fs.readFileSync(file, 'utf8'), { catalog: listSkins() });
      await applyPreferencesSettings(parsed.settings);
      await dialog.showMessageBox(win, {
        type: 'info', title: '偏好已导入', message: '设置与皮肤选择已应用',
        detail: ['未包含图片或台词；本机缺失的皮肤会回退到默认角色。', ...parsed.warnings].join('\n')
      });
      return true;
    } catch (error) {
      await dialog.showMessageBox(win, { type: 'error', title: '无法导入偏好',
        message: '偏好导入失败', detail: error.code ? '无法读取所选文件，请确认文件存在且可读。' : error.message });
      return false;
    }
  }
  function chooseDialogueEditor() {
    openSettingsPanel('dialogue');
  }
  function saveDialogues(draft) {
    state.dialogues = dialogueLibrary.save(draft);
    publish();
  }
  function listSkins() {
    return allSkins().map(({ id, name, kind, thumbnailUrl }) => ({ id, name, kind, thumbnailUrl }));
  }
  function dialogOwner(event) {
    try {
      const owner = BrowserWindow.fromWebContents(event?.sender);
      if (owner && !owner.isDestroyed()) return owner;
    } catch {}
    return win && !win.isDestroyed() ? win : undefined;
  }
  function zipFailure(error) {
    if (!error) return '无法导入皮肤包。';
    if (error.code === 'PACK_CONFIRM' || (typeof error.code === 'string' && error.code.startsWith('ZIP_'))) return error.message;
    if (error.code) return '无法读取或保存皮肤包，请确认文件可读、数据目录可写。';
    return error.message || '无法导入皮肤包。';
  }
  function assertSettingsSender(event) {
    const settingsWindow = getSettingsWindow();
    const owner = dialogOwner(event);
    if (!settingsWindow || !owner || owner !== settingsWindow) {
      const error = new Error('只有设置窗口可以导入皮肤包。');
      error.code = 'ZIP_SENDER';
      throw error;
    }
  }
  function skinPackSender(event) {
    try { assertSettingsSender(event); }
    catch (error) { return { ok: false, code: error.code || 'ZIP_SENDER', error: error.message }; }
    return { ok: true, id: event.sender.id };
  }
  function isImageSelection(filePath) {
    return typeof filePath === 'string' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath);
  }
  async function importImageFromPath(filePath, parent) {
    const source = readImageFile(filePath);
    await validateSkinImage(source.bytes, source.mime);
    const edited = await openSkinEditor(parent || win, source);
    if (!edited) return { image: true, canceled: true };
    const skin = await skins.importBytes(edited.bytes, edited.name, validateSkinImage);
    setSkin(skin.id);
    return { image: true, canceled: false };
  }
  async function chooseSkinPackSource(event, mode) {
    const sender = skinPackSender(event);
    if (!sender.ok) return sender;
    const directory = mode === 'directory';
    const result = await dialog.showOpenDialog(dialogOwner(event), directory ? {
      title: '导入皮肤包文件夹', buttonLabel: '预览', properties: ['openDirectory'],
      message: '选择包含 manifest.json、角色图片和缩略图的文件夹'
    } : {
      title: '导入皮肤包或图片', buttonLabel: '继续', properties: ['openFile'],
      filters: [{ name: 'ZIP 或图片', extensions: ['zip', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true };
    const filePath = result.filePaths[0];
    if (!directory && isImageSelection(filePath)) {
      const imported = await importImageFromPath(filePath, dialogOwner(event));
      return { ok: true, image: true, canceled: imported.canceled === true };
    }
    return skinPackSession.register(filePath, sender.id);
  }
  function openSettingsPanel(groupId) {
    cancelDrag();
    const existed = Boolean(getSettingsWindow());
    const settingsWindow = openSettingsWindow({
      anchor: win,
      groupId: typeof groupId === 'string' ? groupId : undefined,
      backgroundColor: settingsBackground(),
      onClosed: () => {
        publish();
        if (win && !win.isDestroyed()) win.focus();
      }
    });
    bindSkinPackWindow(settingsWindow);
    if (typeof groupId === 'string' && settingsWindow && !settingsWindow.isDestroyed?.()) {
      const send = () => {
        if (!settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:show-group', groupId);
      };
      if (existed) send();
      else settingsWindow.webContents.once('did-finish-load', send);
    }
    publish();
  }
  function buildFunctionMenu() {
    const importedSkins = skins.list();
    const importedPacks = skinPacks.list();
    const busySkin = importingSkin || deletingSkin;
    // Skin / size / dialogues live in the dedicated settings panel. Menu keeps
    // a single entry plus a few advanced toggles so drag is never blocked.
    return Menu.buildFromTemplate([
      { label: '打开设置…', enabled: !busySkin, click: openSettingsPanel },
      { label: '互动选项', submenu: [
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
      { label: '删除导入皮肤', enabled: (importedSkins.length > 0 || importedPacks.length > 0) && !busySkin,
        submenu: [
          ...importedSkins.map(skin => ({
            label: `${skin.name.replace(/&/g, '&&')}${state.skin.id === skin.id ? '（当前使用）' : ''}`,
            click: () => deleteImportedSkin(skin.id)
          })),
          ...importedPacks.map(pack => ({
            label: `皮肤包：${pack.name.replace(/&/g, '&&')}（${pack.characters.length} 个角色）`,
            click: () => deleteImportedPack(pack.id)
          }))
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
  function motionReduced() {
    return preferences.reducedMotion === true || rendererReducedMotion === true;
  }
  function areaClose(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4
      && Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4;
  }
  function applyGeometry(bounds, zoom) {
    if (!win || win.isDestroyed()) return;
    if (bounds) {
      const current = win.getBounds();
      if (bounds.x !== current.x || bounds.y !== current.y || bounds.width !== current.width || bounds.height !== current.height) {
        win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      }
    }
    if (typeof zoom === 'number' && Number.isFinite(zoom) && zoomDiffer(win.webContents.getZoomFactor(), zoom, 0.0005)) {
      win.webContents.setZoomFactor(zoom);
    }
    updateInputRegion();
  }
  function cancelSettle({ apply = false } = {}) {
    const current = settle;
    if (!current || current.settled) {
      settle = null;
      return;
    }
    current.settled = true;
    current.cancel?.();
    settle = null;
    if (apply) applyGeometry(current.targetBounds, current.targetZoom);
    current.resolve();
  }
  function startSettle({ fromBounds, toBounds, fromZoom, toZoom, area }) {
    cancelSettle();
    const move = boundsDiffer(fromBounds, toBounds);
    const zooming = zoomDiffer(fromZoom, toZoom);
    const reduced = motionReduced();
    const durationMs = settleDurationMs({ boundsDiffer: move, zoomDiffer: zooming, reduced });
    if (durationMs <= 0) {
      applyGeometry(toBounds, toZoom);
      geometrySettled = Promise.resolve();
      return geometrySettled;
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    geometrySettled = promise;
    const handle = settlePlayer.play({
      durationMs,
      onFrame(progress) {
        applyGeometry(
          interpolateBounds(fromBounds, toBounds, progress),
          zooming ? interpolateZoom(fromZoom, toZoom, progress) : null
        );
      },
      onDone() {
        if (!settle || settle.settled) return;
        settle.settled = true;
        const done = settle.resolve;
        const finalBounds = settle.targetBounds;
        const finalZoom = settle.targetZoom;
        settle = null;
        applyGeometry(finalBounds, finalZoom);
        done();
      }
    });
    settle = {
      targetBounds: toBounds, targetZoom: toZoom, area, resolve, settled: false, cancel: handle.cancel
    };
    return promise;
  }
  function positionWindow() {
    if (!win || win.isDestroyed() || !scope.rect) return false;
    const area = currentArea();
    const refreshScale = refreshScalePending || displayMemory.crossed || displayMemory.scaleChanged;
    const layout = scopedBounds(area, scaleForLevel(preferences.sizeLevel), preferences.placement);
    if (!layout) {
      cancelSettle();
      win.hide();
      return false;
    }
    if (drag) {
      if (zoomDiffer(win.webContents.getZoomFactor(), layout.scale) || refreshScale) win.webContents.setZoomFactor(layout.scale);
      updateInputRegion();
      return true;
    }
    if (!refreshScale && settle && !settle.settled && areaClose(settle.area, area)
      && !boundsDiffer(settle.targetBounds, layout.bounds) && !zoomDiffer(settle.targetZoom, layout.scale)) {
      updateInputRegion();
      return true;
    }
    if (settle) cancelSettle();
    if (boundsDiffer(win.getBounds(), layout.bounds) || displayMemory.crossed) win.setBounds(layout.bounds);
    if (zoomDiffer(win.webContents.getZoomFactor(), layout.scale) || refreshScale) win.webContents.setZoomFactor(layout.scale);
    updateInputRegion();
    return true;
  }
  function currentArea() {
    // Keep the nearest-display scale. Passing the pet window would use the
    // screen the pet is still on when Codex has already crossed to another one.
    const area = screen.screenToDipRect(null, scope.rect);
    let displays = [];
    try { displays = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : []; }
    catch { displays = []; }
    const noted = noteDisplay(displayMemory, displays, area);
    displayMemory = {
      displayId: noted.displayId,
      scaleFactor: noted.scaleFactor,
      crossed: noted.crossed,
      scaleChanged: noted.scaleChanged
    };
    return area;
  }
  function applyScreenEvent(payload) {
    if (!win || win.isDestroyed()) return;
    const plan = planScreenEvent({
      kind: payload.kind,
      changedMetrics: payload.changedMetrics,
      dragging: Boolean(drag),
      scopeValid: Boolean(scope.rect)
    });
    if (plan.ignore) return;
    if (plan.cancelDrag) cancelDrag();
    if (plan.cancelSettle) cancelSettle();
    if (plan.hide || (payload.kind === 'removed' && !scope.rect)) {
      win.hide();
      return;
    }
    refreshScalePending = Boolean(payload.changedMetrics?.includes('scaleFactor') || payload.kind === 'removed');
    try { positionWindow(); }
    finally { refreshScalePending = false; }
    try {
      const settingsWindow = getSettingsWindow();
      if (settingsWindow) {
        const display = screen.getDisplayMatching(settingsWindow.getBounds());
        const area = display.workArea;
        const bounds = settingsWindow.getBounds();
        const width = Math.min(bounds.width, area.width);
        const height = Math.min(bounds.height, area.height);
        const x = Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width));
        const y = Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height));
        if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) {
          settingsWindow.setBounds({ x, y, width, height });
        }
      }
    } catch { /* settings window follows the pet's screen events */ }
    if (!plan.relocate || !win.isVisible()) return;
    const bounds = win.getBounds();
    let displays = [];
    try { displays = screen.getAllDisplays(); } catch { displays = []; }
    const center = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    let nearest = null;
    try { nearest = screen.getDisplayNearest(center); } catch { nearest = nearestDisplay(bounds, displays); }
    const relocated = relocateToVisibleDisplay(bounds, displays, nearest);
    if (relocated) win.setBounds({ x: relocated.x, y: relocated.y, width: relocated.width, height: relocated.height });
  }
  function scheduleScreenEvent(kind, changedMetrics) {
    if (screenTimer) clearTimeout(screenTimer);
    const payload = { kind, changedMetrics };
    screenTimer = setTimeout(() => {
      screenTimer = null;
      applyScreenEvent(payload);
    }, SCREEN_EVENT_DELAY_MS);
  }
  let scopeVisibility;
  function ensureScopeVisibility() {
    if (scopeVisibility) return scopeVisibility;
    scopeVisibility = createDebouncedShowHide({
      delayMs: 100,
      onShow() {
        if (!win || win.isDestroyed() || !rendererReady) return;
        if (!positionWindow()) return;
        win.setEnabled(true);
        win.setIgnoreMouseEvents(false);
        win.showInactive();
        win.webContents.invalidate();
        if (startupTiming.firstVisibleMs === undefined) {
          startupTiming.firstVisibleMs = Date.now() - startupStartedAt;
          fs.mkdirSync(work, { recursive: true });
          try { writeJsonAtomic(path.join(work, 'startup-timing.json'), startupTiming); } catch {}
        }
      },
      onHide() {
        if (!win || win.isDestroyed()) return;
        cancelSettle();
        cancelDrag();
        win.hide();
      }
    });
    return scopeVisibility;
  }
  function publishScopeStatus(force = false) {
    if (!win || win.isDestroyed()) return;
    try {
      scopeStatusWriter.publish({
        ...scope, visible: win.isVisible(), enabled: win.isEnabled(),
        windowHandle: win.getNativeWindowHandle().readBigUInt64LE().toString(),
        bounds: win.getBounds(), placement: preferences.placement, sizeLevel: preferences.sizeLevel,
        skinId: state.skin.id, skinName: state.skin.name
      }, { force });
    } catch {}
  }
  function updateScope(next) {
    const previous = scope;
    windowLifetime.observe(next);
    // A failed geometry query during a resize is not a window close. Wait for
    // the next native sample; explicit minimize/close still hides immediately.
    if (next.reason === 'geometry-unavailable' && next.hwnd === previous.hwnd) return;
    scope = next;
    if (!win || win.isDestroyed() || !rendererReady) return;
    const visibility = ensureScopeVisibility();
    const wantShow = shouldShow(scope);
    const hwndChanged = previous.hwnd !== scope.hwnd;
    const sizeChanged = ['width', 'height'].some(key => previous.rect?.[key] !== scope.rect?.[key]);
    const visibilityFlipped = shouldShow(previous) !== wantShow;
    if (hwndChanged || (visibilityFlipped && !wantShow)) {
      cancelDrag();
      logLifecycle({ event: 'scope-change', active: next.active, reason: next.reason, hwnd: next.hwnd, codexPid: next.codexPid, ownerBound: next.ownerBound });
    } else if (visibilityFlipped || sizeChanged) {
      logLifecycle({ event: 'scope-change', active: next.active, reason: next.reason, hwnd: next.hwnd, codexPid: next.codexPid, ownerBound: next.ownerBound });
    }
    // Reposition immediately when we intend to stay/become visible; show/hide itself is debounced.
    if (wantShow) {
      if (!drag) positionWindow();
      visibility.request(true);
    } else {
      visibility.request(false);
    }
    // Skip disk I/O while the user is dragging to avoid frame drops.
    if (!drag) publishScopeStatus(false);
    try { refreshSessionSchedule(); } catch {}
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
    cancelSettle();
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
    // Clamp only while dragging — snap once on release to avoid edge jitter / flash.
    const clamped = clampBounds(area, { ...drag.bounds,
      x: drag.bounds.x + cursor.x - drag.cursor.x, y: drag.bounds.y + cursor.y - drag.cursor.y });
    if (!clamped) { cancelDrag(); positionWindow(); return; }
    drag.moved = true;
    win.setBounds(clamped.bounds);
  }
  function dragEnd() {
    let pending = Promise.resolve();
    if (drag?.moved && scope.rect && win && !win.isDestroyed()) {
      const area = currentArea();
      const snapped = snapBounds(area, { ...win.getBounds(),
        width: drag.bounds.width, height: drag.bounds.height });
      if (snapped) {
        preferences.placement = snapped.placement;
        savePreferences({ immediate: true });
        const fromZoom = win.webContents.getZoomFactor();
        const fitted = scopedBounds(area, scaleForLevel(preferences.sizeLevel), snapped.placement);
        const toZoom = fitted?.scale ?? fromZoom;
        pending = startSettle({
          fromBounds: win.getBounds(),
          toBounds: zoomDiffer(fromZoom, toZoom) && fitted ? fitted.bounds : snapped.bounds,
          fromZoom,
          toZoom,
          area
        });
      }
    }
    drag = null;
    updateInputRegion();
    publish();
    return pending;
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
    async function moveTo(x, y) {
      const current = win.getBounds();
      dragStart({ x: 0, y: 0 });
      dragMove({ x: x - current.x, y: y - current.y });
      await dragEnd();
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
        await moveTo(x, y);
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
      await moveTo(left + 12, top + 12);
      const sizesKeepAnchor = [];
      for (const level of [1, 10]) {
        await setSizeLevel(level);
        const actual = win.getBounds();
        sizesKeepAnchor.push(actual.x === area.x + 2 && actual.y === area.y + 2);
      }
      await setSizeLevel(originalLevel);
      await moveTo(centerX, centerY);
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
      await setSizeLevel(originalLevel);
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
    const importFromMenu = async () => {
      chooseSkinImage();
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
      const checked = 1;
      setSkin('default');
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
      dragMove(); await dragEnd();
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
      await new Promise(resolve => setTimeout(resolve, 160));
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
        animatedTransition: /0\.2\d*s/.test(getComputedStyle(bubble).transitionDuration) };
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
      sizeChoices: SIZE_SCALES.length,
      hasSettings: functionMenu?.items.some(item => item.label === '打开设置…') === true,
      hasRefresh: functionMenu?.items.some(item => item.label === '刷新额度') === true };
    functionMenu?.closePopup(win);
    const originalLevel = preferences.sizeLevel;
    const sizes = [];
    for (let level = 1; level <= SIZE_SCALES.length; level++) {
      await setSizeLevel(level);
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const area = scope.rect ? currentArea() : null;
      const bounds = win.getBounds();
      const expected = area ? scopedBounds(area, scaleForLevel(level), preferences.placement) : null;
      sizes.push({ level, selected: state.sizeLevel === level,
        saved: sizeLevelFromPreferences(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) === level,
        menuCount: SIZE_SCALES.length, checkedCount: 1,
        checkedLabel: `${level}`, scale: win.webContents.getZoomFactor(), bounds, expectedBounds: expected?.bounds,
        sizeApplied: Boolean(expected) && Math.abs(win.webContents.getZoomFactor() - expected.scale) < 0.001
          && Math.abs(bounds.width - expected.bounds.width) <= 1 && Math.abs(bounds.height - expected.bounds.height) <= 1,
        withinCodex: Boolean(area) && bounds.x >= area.x && bounds.y >= area.y
          && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height });
      if (level === 1 || level === 10) {
        fs.writeFileSync(path.join(work, `size-${level}-preview.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await setSizeLevel(originalLevel);
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
      chooseDialogueEditor: () => openDialogueEditor(win, state.dialogues, saveDialogues), getDialogueEditorWindow, getDialogues: () => state.dialogues,
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
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && !input.alt && !input.meta && input.key === ',') {
        event.preventDefault();
        openSettingsPanel();
      }
    });
    publish();
    ipcMain.handle('pet:state', () => state);
    ipcMain.handle('pet:refresh', () => refresh());
    ipcMain.on('pet:menu', openFunctionMenu);
    ipcMain.on('pet:settings-open', openSettingsPanel);
    ipcMain.handle('settings:get-state', () => state);
    ipcMain.handle('settings:about', () => ({
      version: APP_VERSION,
      displayVersion: DISPLAY_VERSION,
      electron: process.versions.electron || '',
      platform: process.platform,
      dataDir: app.getPath('userData'),
      workDir: work
    }));
    ipcMain.on('settings:close', event => {
      const owner = dialogOwner(event);
      if (owner && owner !== win && !owner.isDestroyed()) {
        owner.__allowClose = true;
        owner.close();
      }
    });
    ipcMain.handle('skin-pack:choose', (event, mode) => chooseSkinPackSource(event, mode));
    ipcMain.handle('skin-pack:register-drop', (event, filePath) => {
      const sender = skinPackSender(event);
      if (!sender.ok) return sender;
      return skinPackSession.register(filePath, sender.id);
    });
    ipcMain.handle('skin-pack:preview', (event, token) => {
      const sender = skinPackSender(event);
      if (!sender.ok) return sender;
      return skinPackSession.preview(token, sender.id);
    });
    ipcMain.handle('skin-pack:commit', (event, payload) => {
      const sender = skinPackSender(event);
      if (!sender.ok) return sender;
      const body = payload && typeof payload === 'object' ? payload : {};
      return skinPackSession.commit(body.token, sender.id, { acceptSameName: body.acceptSameName === true });
    });
    ipcMain.handle('skin-pack:cancel', (event, token) => {
      const sender = skinPackSender(event);
      if (!sender.ok) return sender;
      return skinPackSession.cancel(token, sender.id);
    });
    ipcMain.handle('settings:copy-diagnostics', event => {
      try {
        assertSettingsSender(event);
        const { clipboard } = require('electron');
        const text = [
          `版本 ${APP_VERSION}`,
          `展示标签 ${DISPLAY_VERSION}`,
          `Electron ${process.versions.electron || '未随 Electron 启动'}`,
          `平台 ${process.platform}`,
          `数据目录 ${app.getPath('userData')}`,
          `工作目录 ${work}`
        ].join('\n');
        clipboard.writeText(text);
        return { ok: true, text };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    ipcMain.handle('settings:dialogue-source', event => {
      assertSettingsSender(event);
      return { current: state.dialogues, defaults: defaultDialogues() };
    });
    ipcMain.handle('settings:dialogue-save', (event, draft) => {
      try {
        assertSettingsSender(event);
        saveDialogues(draft);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    ipcMain.on('settings:reset-placement', event => { try { assertSettingsSender(event); resetPlacement(); } catch {} });
    ipcMain.on('settings:delete-current-skin', event => {
      try {
        assertSettingsSender(event);
        const parsed = parsePackCharacterId(state.skin.id);
        if (parsed) deleteImportedPack(parsed.packId);
        else deleteImportedSkin(state.skin.id);
      } catch {}
    });
    ipcMain.on('pet:size-level', (_event, level) => setSizeLevel(Number(level)));
    ipcMain.on('pet:set-skin', (_event, id) => setSkin(id));
    ipcMain.on('pet:import-skin', () => { chooseSkinImage(); });
    ipcMain.on('pet:import-skin-pack', () => { openSettingsPanel('appearance'); });
    ipcMain.on('pet:delete-skin-pack', (_event, id) => { deleteImportedPack(id); });
    ipcMain.on('pet:edit-dialogues', () => { openSettingsPanel('dialogue'); });
    ipcMain.on('pet:export-preferences', () => { exportPreferences(); });
    ipcMain.on('pet:import-preferences', () => { importPreferences(); });
    ipcMain.on('pet:set-experience', (_event, key, value) => setExperience(key, value));
    ipcMain.on('pet:set-experiences', (_event, partial) => setExperiences(partial || {}));
    ipcMain.on('pet:reset-setting', (_event, key) => { if (typeof key === 'string') resetPreferences([key]); });
    ipcMain.on('pet:reset-group', (_event, groupId) => { if (typeof groupId === 'string') resetPreferences(GROUP_KEYS[groupId] || []); });
    ipcMain.on('pet:reset-all', () => resetPreferences(ALL_RESET_KEYS));
    ipcMain.on('pet:reduced-motion', (_event, value) => {
      rendererReducedMotion = value === true;
      if (motionReduced()) cancelSettle({ apply: true });
    });
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
    if (!smokeTest) startSessionProbe();
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
    try {
      const { nativeTheme } = require('electron');
      nativeTheme.on('updated', () => {
        if (normalizeColorScheme(preferences.colorScheme) !== 'system') return;
        const settingsWindow = getSettingsWindow();
        if (settingsWindow) { try { settingsWindow.setBackgroundColor(settingsBackground()); } catch {} }
        publish();
      });
    } catch { /* native theme is unavailable outside Electron */ }
    screen.on('display-metrics-changed', (_event, _display, changedMetrics) => scheduleScreenEvent('metrics', changedMetrics));
    screen.on('display-removed', () => scheduleScreenEvent('removed'));
    screen.on('display-added', () => scheduleScreenEvent('added'));
    await loadRenderer();
    writeIdleBudgetSnapshot('startup');
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
        } else if (shouldSaveRuntime({ now: Date.now(), lastSavedAt: lastRuntimeSavedAt })) {
          try { saveRuntime(); } catch {}
        }
      }, pluginPollDelay());
    }
  }).catch(error => {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'startup-error.txt'), error.stack);
    console.error(error); app.exit(1);
  });
  app.on('second-instance', () => { if (win) updateScope(scope); });
  app.on('before-quit', () => { closing = true; try { skinPackSession.releaseAll(); } catch {} try { cancelSettle({ apply: true }); } catch {} clearInterval(interval); clearInterval(pluginInterval); if (sessionTimer) clearTimeout(sessionTimer); scopeMonitor?.stop(); try { scopeVisibility?.flush(); } catch {}; flushPersistentState(); });
  app.on('will-quit', flushPersistentState);
}
