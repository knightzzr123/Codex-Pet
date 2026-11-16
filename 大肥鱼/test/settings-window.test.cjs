const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveSettingsWindow, settingsCloseBlocked } = require('../src/settings-window.cjs');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8');

function fixture() {
  const elements = new Map();
  const listeners = new Map();
  const doc = {
    activeElement: null,
    body: {},
    documentElement: { dataset: {} },
    getElementById: id => get(id),
    createElement: () => new Element('created'),
    querySelectorAll: selector => query(selector),
    addEventListener: (name, fn) => listeners.set(name, fn)
  };
  class Element {
    constructor(id) {
      this.id = id; this.handlers = new Map(); this.classList = { add() {}, remove() {}, toggle() {} };
      this.textContent = ''; this.hidden = false; this.focused = false; this.focusables = [];
      this.dataset = {}; this.attrs = new Map(); this.children = [];
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, extra = {}) {
      this.handlers.get(name)?.({ type: name, target: this, preventDefault() {}, key: '', shiftKey: false, ...extra });
    }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    querySelectorAll() { return this.focusables; }
    focus() { this.focused = true; doc.activeElement = this; }
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  function query(selector) {
    if (selector === '[role="tab"]' || selector === '#settings-nav [role="tab"]') return get('settings-nav').focusables;
    if (selector === '[data-bubble-seconds]') return get('settings-panel').focusables.filter(node => node.attrs.has('data-bubble-seconds'));
    if (selector === '.settings-skin-card' || selector === '[data-skin-id]') return get('settings-skins').focusables;
    if (selector.startsWith('button')) return get('settings-panel').focusables;
    return [];
  }
  const api = {
    closed: false,
    close() { this.closed = true; },
    setSkin(id) { this.skinId = id; },
    cancelSkinPack(token) { this.canceled = token; return Promise.resolve({ ok: true }); },
    commitSkinPack(payload) { this.committed = payload; return Promise.resolve(this.commitResult); },
    imported: null, previewed: null
  };
  const window = {
    settingsAPI: api,
    addEventListener: (name, fn) => listeners.set(name, fn),
    location: { search: '' }
  };
  const context = vm.createContext({
    window, document: doc, URLSearchParams, setTimeout, clearTimeout,
    globalThis: { location: window.location }
  });
  vm.runInContext(source, context);
  return {
    get, api, doc, window,
    emitWindow: (name, extra = {}) => listeners.get(name)?.({ preventDefault() {}, ...extra })
  };
}

test('设置窗开着时 app.quit 能完成', () => {
  const settings = {
    __allowClose: false,
    closed: false,
    requested: false,
    prevented: 0,
    isDestroyed() { return this.closed; },
    close() {
      if (settingsCloseBlocked(this)) {
        this.requested = true;
        this.prevented += 1;
        return;
      }
      this.closed = true;
    }
  };
  settings.close();
  assert.equal(settings.closed, false);
  assert.equal(settings.requested, true);
  assert.equal(settings.prevented, 1);
  settings.__allowClose = true;
  settings.close();
  assert.equal(settings.closed, true);
  assert.equal(settings.prevented, 1, '退出标志设置后 close 不再 preventDefault');
  assert.equal(settingsCloseBlocked({ __loadFailed: true }), false);
  assert.equal(settingsCloseBlocked({ __rendererGone: true }), false);
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  assert.match(main, /before-quit/);
  assert.match(main, /settingsWindow\.__allowClose = true/);
  assert.match(main, /settingsWindow\.close\(\)/);
  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(quit.indexOf('settingsWindow.__allowClose = true') < quit.indexOf('settingsWindow.close()'),
    'before-quit 必须先设标志再关闭设置窗口');
});

test('已有设置窗口时只聚焦，不新建', () => {
  const existing = { focused: false, shown: false, focus() { this.focused = true; }, show() { this.shown = true; } };
  let created = 0;
  const again = resolveSettingsWindow(existing, () => { created += 1; return { id: 'new' }; });
  assert.equal(again.created, false);
  assert.equal(again.window, existing);
  assert.equal(existing.focused, true);
  assert.equal(created, 0);
  const fresh = resolveSettingsWindow(null, () => ({ id: 'created' }));
  assert.equal(fresh.created, true);
  assert.equal(fresh.window.id, 'created');
  const destroyed = resolveSettingsWindow({ isDestroyed: () => true }, () => ({ id: 'after-close' }));
  assert.equal(destroyed.created, true);
});

test('设置窗口打开后聚焦当前分类，Esc 请求关闭，Tab 在窗口内循环', () => {
  const f = fixture();
  const close = f.get('settings-close');
  const action = f.get('settings-import-skin');
  assert.equal(f.get('tab-appearance').focused, true);
  assert.equal(close.focused, false);
  f.get('settings-panel').focusables = [close, action];
  close.focus();
  f.get('settings-panel').emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(action.focused, true);
  action.focus();
  f.get('settings-panel').emit('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(close.focused, true);
  f.emitWindow('keydown', { key: 'Escape' });
  assert.equal(f.api.closed, true);
});

test('Tab 不进入隐藏面板，方向键在 radiogroup 内移动', () => {
  const f = fixture();
  const visible = f.get('settings-import-zip');
  const hiddenPanel = f.get('panel-dialogue');
  hiddenPanel.hidden = true;
  const hidden = f.get('settings-bubble-x');
  hidden.parentElement = hiddenPanel;
  f.get('settings-panel').focusables = [visible, hidden];
  visible.focus();
  f.get('settings-panel').emit('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(f.doc.activeElement, visible);
  assert.equal(hidden.focused, false);
  const radios = ['a', 'b', 'c'].map(id => {
    const button = f.get(`radio-${id}`);
    button.setAttribute('role', 'radio');
    return button;
  });
  f.get('settings-skins').focusables = radios;
  radios[0].focus();
  f.get('settings-skins').emit('keydown', { key: 'ArrowRight' });
  assert.equal(f.doc.activeElement, radios[1]);
  f.get('settings-skins').emit('keydown', { key: 'ArrowLeft' });
  assert.equal(f.doc.activeElement, radios[0]);
});

test('方向键在六个分类之间移动', () => {
  const f = fixture();
  const ids = ['appearance', 'dialogue', 'behavior', 'accessibility', 'preferences', 'about'];
  const tabs = ids.map(id => {
    const tab = f.get(`tab-${id}`);
    tab.setAttribute('data-category', id);
    tab.setAttribute('aria-controls', `panel-${id}`);
    return tab;
  });
  f.get('settings-nav').focusables = tabs;
  tabs[0].focus();
  f.get('settings-nav').emit('keydown', { key: 'ArrowDown' });
  assert.equal(f.doc.activeElement, tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(f.get('panel-appearance').hidden, true);
  assert.equal(f.get('panel-dialogue').hidden, false);
});

test('HTML 有六个分类、读屏名称、拖拽区和导入前预览', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  for (const label of ['外观/皮肤', '对话/台词', '行为/待机', '无障碍', '偏好导入导出', '诊断/关于']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-zip-drop"/);
  assert.match(html, /id="settings-zip-preview"/);
  assert.match(html, /id="settings-close"[^>]*aria-label="关闭设置"/);
  for (const id of ['settings-bubble-x', 'settings-bubble-y', 'settings-idle', 'settings-opacity']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), id);
    assert.match(html, new RegExp(`id="${id}"[^>]*type="range"`), id);
  }
  const css = fs.readFileSync(path.join(root, 'src', 'settings.css'), 'utf8');
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /border: 4px solid CanvasText/);
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /new Tray/);
  assert.match(main, /click: openSettingsPanel/);
  assert.match(main, /before-input-event/);
  assert.match(source, /settingsReturnFocus/);
  assert.match(source, /settings-close'\)\?\.focus/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /aria-checked/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /aria-label', `\$\{active \? '当前角色' : '切换到'\}/);
});

// Z-5 helpers: count every write to a live region and seed skin cards so the
// focus target after a switch can be resolved like in the real renderer.
function liveRecorder(f, id) {
  const node = f.get(id);
  const writes = [];
  let value = node.textContent;
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => value,
    set: next => { value = next; writes.push(next); }
  });
  return { node, writes, value: () => value };
}

function seedSkins(f, ids) {
  const skins = ids.map(id => ({ id, name: `皮肤 ${id}`, kind: 'pack' }));
  f.window.__settingsTest.applyState({ skins, skin: skins[0], experience: {} });
  const box = f.get('settings-skins');
  box.focusables = [...box.children];
  return skins;
}

function skinCard(f, id) {
  return f.get('settings-skins').children.find(node => node.getAttribute('data-skin-id') === id);
}

const reusedSwitchPreview = switchTo => ({
  ok: true, name: 'QA包装', installedName: 'QA包装', version: '1.0.0', sourceId: 'qa-pack',
  reused: true, switchTo, duplicate: { kind: 'content', existingName: 'QA包装', switchTo },
  totalBytes: 0, characterCount: 1, characters: []
});

const freshPreview = extra => ({
  ok: true, name: 'QA包装', installedName: 'QA包装（2）', version: '1.0.0', sourceId: 'qa-pack',
  reused: false, switchTo: '', duplicate: null, totalBytes: 0, characterCount: 1, characters: [],
  ...extra
});

test('已导入过的皮肤包提示「已经导入过」，只给「切换到它」而不重复导入，切换后焦点在皮肤卡片', async () => {
  const f = fixture();
  const switchTo = `pack:${'a'.repeat(64)}:whale`;
  seedSkins(f, ['default', switchTo]);
  f.get('settings-notice').hidden = true;
  const polite = liveRecorder(f, 'settings-live');
  const assertive = liveRecorder(f, 'settings-live-assertive');
  f.api.previewSkinPack = async () => reusedSwitchPreview(switchTo);
  const token = 'b'.repeat(32);
  await f.window.__settingsTest.previewToken(token);
  const warning = f.get('settings-zip-preview-warning');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /这个皮肤包已经导入过/);
  assert.equal(f.get('settings-zip-confirm').textContent, '切换到它');
  // 出现带「切换到它」的提示时，焦点在该按钮上。
  assert.equal(f.doc.activeElement, f.get('settings-zip-confirm'));
  assert.deepEqual(polite.writes, ['这个皮肤包已经导入过。可以切换到「QA包装」。']);

  await f.window.__settingsTest.submitZip();
  assert.equal(f.api.canceled, token);
  assert.equal(f.api.skinId, switchTo);
  assert.equal(f.api.committed, undefined, 'identical content must not be committed again');
  assert.equal(f.get('settings-zip-preview').hidden, true);
  // 切换成功后焦点移到对应皮肤卡片。
  assert.equal(f.doc.activeElement, skinCard(f, switchTo));
  assert.equal(polite.writes.at(-1), '已切换到「QA包装」。');
  assert.equal(polite.writes.length, 2, '预览一次播报、切换一次播报，每个结果只播一次');
  assert.equal(assertive.writes.length, 0, '内容相同/切换不再走 assertive');
});

test('内容相同但没有切换目标时按钮是「知道了」，确认后焦点回拖拽区且不重复播报', async () => {
  const f = fixture();
  seedSkins(f, ['default']);
  f.get('settings-notice').hidden = true;
  const polite = liveRecorder(f, 'settings-live');
  f.api.previewSkinPack = async () => reusedSwitchPreview('');
  await f.window.__settingsTest.previewToken('1'.repeat(32));
  assert.equal(f.get('settings-zip-confirm').textContent, '知道了');
  await f.window.__settingsTest.submitZip();
  assert.equal(f.api.skinId, undefined, 'no switch target means no switch');
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  assert.deepEqual(polite.writes, ['这个皮肤包已经导入过。'], '确认只清理预览，不再补播一次');
});

test('同 ID 的不同内容：预览文案改口径，导入后焦点回拖拽区并只 polite 播报一次', async () => {
  const f = fixture();
  f.get('settings-notice').hidden = true;
  const polite = liveRecorder(f, 'settings-live');
  const assertive = liveRecorder(f, 'settings-live-assertive');
  f.api.previewSkinPack = async () => freshPreview({
    duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old', switchTo: '' }
  });
  const token = 'c'.repeat(32);
  await f.window.__settingsTest.previewToken(token);
  const warning = f.get('settings-zip-preview-warning');
  assert.equal(warning.textContent, '已有这个皮肤包的另一个版本「QA包装」。将导入为「QA包装（2）」，旧版本保留。');
  assert.equal(f.get('settings-zip-confirm').textContent, '导入');
  polite.writes.length = 0;

  f.api.commitResult = {
    ok: true, reused: false, renamed: true, switchTo: '',
    duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old' },
    pack: { id: 'd'.repeat(64), name: 'QA包装（2）', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.equal(f.api.committed.token, token);
  const notice = f.get('settings-notice');
  assert.equal(notice.hidden, false);
  assert.equal(f.get('settings-notice-text').textContent, '已作为新皮肤导入「QA包装（2）」，旧版本保留。');
  assert.equal(f.get('settings-notice-action').hidden, true);
  assert.equal(f.get('settings-zip-preview').hidden, true);
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  assert.deepEqual(polite.writes, ['已作为新皮肤导入「QA包装（2）」，旧版本保留。']);
  assert.equal(assertive.writes.length, 0, '重命名导入不再走 liveAssert');
});

test('同名不同 sourceId（kind=name）用「原有同名皮肤保留」文案并带回 duplicate.kind', async () => {
  const f = fixture();
  f.get('settings-notice').hidden = true;
  const polite = liveRecorder(f, 'settings-live');
  const assertive = liveRecorder(f, 'settings-live-assertive');
  f.api.previewSkinPack = async () => freshPreview({
    installedName: 'QA包装（4）',
    duplicate: { kind: 'name', existingName: 'QA包装', existingId: 'other', switchTo: '' }
  });
  await f.window.__settingsTest.previewToken('2'.repeat(32));
  polite.writes.length = 0;
  f.api.commitResult = {
    ok: true, reused: false, renamed: true, switchTo: '',
    duplicate: { kind: 'name', existingName: 'QA包装', existingId: 'other' },
    pack: { id: '3'.repeat(64), name: 'QA包装（4）', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.equal(f.get('settings-notice-text').textContent, '已作为新皮肤导入「QA包装（4）」，原有同名皮肤保留。');
  assert.deepEqual(polite.writes, ['已作为新皮肤导入「QA包装（4）」，原有同名皮肤保留。']);
  assert.equal(assertive.writes.length, 0);
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  assert.match(source, /result\.duplicate\?\.kind === 'name'/);
});

test('提交时才发现内容已存在：显示「已经导入过」，焦点在「切换到它」', async () => {
  const f = fixture();
  const switchTo = `pack:${'e'.repeat(64)}:whale`;
  seedSkins(f, ['default', switchTo]);
  f.get('settings-notice').hidden = true;
  const polite = liveRecorder(f, 'settings-live');
  f.api.previewSkinPack = async () => freshPreview();
  await f.window.__settingsTest.previewToken('f'.repeat(32));
  assert.equal(f.doc.activeElement, f.get('settings-zip-confirm'));
  polite.writes.length = 0;
  f.api.commitResult = {
    ok: true, reused: true, renamed: false, switchTo,
    duplicate: { kind: 'content', existingName: 'QA包装', existingId: 'e'.repeat(64) },
    pack: { id: 'e'.repeat(64), name: 'QA包装', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.equal(f.get('settings-notice-text').textContent, '这个皮肤包已经导入过。可以切换到「QA包装」。');
  const action = f.get('settings-notice-action');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, '切换到它');
  assert.equal(f.doc.activeElement, action, '带「切换到它」的提示把焦点放在该按钮');
  assert.deepEqual(polite.writes, ['这个皮肤包已经导入过。可以切换到「QA包装」。']);
  action.emit('click');
  assert.equal(f.api.skinId, switchTo);
  assert.equal(f.get('settings-notice').hidden, true);
  assert.equal(f.doc.activeElement, skinCard(f, switchTo), '动作按钮切皮肤后焦点落在对应皮肤卡片');
  assert.equal(polite.writes.at(-1), '已切换到「QA包装」。');
});

test('内容相同但没有切换目标：提交后提示给「知道了」，焦点在拖拽区', async () => {
  const f = fixture();
  f.get('settings-notice').hidden = true;
  f.api.previewSkinPack = async () => freshPreview();
  await f.window.__settingsTest.previewToken('4'.repeat(32));
  f.api.commitResult = {
    ok: true, reused: true, renamed: false, switchTo: '',
    duplicate: { kind: 'content', existingName: 'QA包装' },
    pack: { id: '5'.repeat(64), name: 'QA包装', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  const action = f.get('settings-notice-action');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, '知道了');
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'), '没有「切换到它」时焦点回拖拽区');
});

test('提示关闭：「关闭」按钮、Esc、动作按钮都会把焦点放回拖拽区', async () => {
  const f = fixture();
  seedSkins(f, ['default']);
  f.get('settings-notice').hidden = true;
  f.api.previewSkinPack = async () => freshPreview();
  const open = async () => {
    f.api.previewSkinPack = async () => freshPreview({
      duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old', switchTo: '' }
    });
    await f.window.__settingsTest.previewToken('6'.repeat(32));
    f.api.commitResult = {
      ok: true, reused: false, renamed: true, switchTo: '',
      duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old' },
      pack: { id: '7'.repeat(64), name: 'QA包装（2）', characterCount: 1 }
    };
    await f.window.__settingsTest.submitZip();
    assert.equal(f.get('settings-notice').hidden, false);
  };
  // 「关闭」按钮
  await open();
  f.get('settings-notice-close').emit('click');
  assert.equal(f.get('settings-notice').hidden, true);
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  // Esc 关闭提示，不关窗
  f.api.commitResult = { ok: true, reused: true, renamed: false, switchTo: '', duplicate: { kind: 'content', existingName: 'QA包装' }, pack: { id: '8'.repeat(64), name: 'QA包装', characterCount: 1 } };
  await f.window.__settingsTest.previewToken('9'.repeat(32));
  await f.window.__settingsTest.submitZip();
  assert.equal(f.get('settings-notice').hidden, false);
  f.emitWindow('keydown', { key: 'Escape' });
  assert.equal(f.get('settings-notice').hidden, true, 'Esc 先关提示');
  assert.equal(f.api.closed, false, 'Esc 关提示时不能关窗');
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  // 第二次 Esc 才走关窗
  f.emitWindow('keydown', { key: 'Escape' });
  assert.equal(f.api.closed, true);
});

test('提示不再是 live region：重复播报只走 polite #settings-live', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  const notice = html.match(/<div id="settings-notice"[^>]*>/);
  assert.ok(notice);
  assert.doesNotMatch(notice[0], /role="(status|alert)"/);
  assert.doesNotMatch(notice[0], /aria-live/);
  assert.doesNotMatch(notice[0], /aria-atomic/);
  assert.match(html, /id="settings-live"[^>]*role="status"[^>]*aria-live="polite"/);
  // liveAssert 只留给 PACK_CHANGED 和错误。
  assert.doesNotMatch(source, /liveAssert\(`这个皮肤包已经导入过/);
  assert.doesNotMatch(source, /liveAssert\(`已作为新皮肤导入/);
  assert.match(source, /PACK_CHANGED[\s\S]*?liveAssert\(/);
  assert.match(source, /function rejectPack[\s\S]*?liveAssert\(/);
});

test('导入 UI 已移除 PACK_CONFIRM 覆盖确认流程', () => {
  assert.doesNotMatch(source, /PACK_CONFIRM|needsConfirm|acceptSameName|确认并导入/);
  assert.match(source, /这个皮肤包已经导入过/);
  assert.match(source, /已作为新皮肤导入/);
  assert.match(source, /旧版本保留/);
  assert.match(source, /原有同名皮肤保留/);
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  assert.match(html, /id="settings-notice"/);
  assert.match(html, /id="settings-notice-action"/);
});

test('设置窗口不挂在宠物窗口下，并保留自己的任务栏按钮', () => {
  const settingsWindow = fs.readFileSync(path.join(root, 'src', 'settings-window.cjs'), 'utf8');
  assert.doesNotMatch(settingsWindow, /^\s*parent\s*:/m);
  assert.match(settingsWindow, /skipTaskbar:\s*false/);
  assert.match(settingsWindow, /modal:\s*false/);
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  assert.match(main, /openSettingsWindow\(\{[\s\S]*?anchor: win/);
  assert.doesNotMatch(main, /parent:\s*win/);
});
