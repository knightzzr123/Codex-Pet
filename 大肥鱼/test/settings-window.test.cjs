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
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-label=`), id);
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

test('已导入过的皮肤包提示「已经导入过」，只给「切换到它」而不重复导入', async () => {
  const f = fixture();
  const switchTo = `pack:${'a'.repeat(64)}:whale`;
  f.api.previewSkinPack = async () => ({
    ok: true, name: 'QA包装', installedName: 'QA包装', version: '1.0.0', sourceId: 'qa-pack',
    reused: true, switchTo, duplicate: { kind: 'content', existingName: 'QA包装', switchTo },
    totalBytes: 0, characterCount: 1, characters: []
  });
  const token = 'b'.repeat(32);
  await f.window.__settingsTest.previewToken(token);
  const warning = f.get('settings-zip-preview-warning');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /这个皮肤包已经导入过/);
  assert.equal(f.get('settings-zip-confirm').textContent, '切换到它');

  await f.window.__settingsTest.submitZip();
  assert.equal(f.api.canceled, token);
  assert.equal(f.api.skinId, switchTo);
  assert.equal(f.api.committed, undefined, 'identical content must not be committed again');
  assert.equal(f.get('settings-zip-preview').hidden, true);
});

test('同 ID 或同名的不同内容提示另存为（2），成功后给非打断提示', async () => {
  const f = fixture();
  f.api.previewSkinPack = async () => ({
    ok: true, name: 'QA包装', installedName: 'QA包装（2）', version: '1.0.0', sourceId: 'qa-pack',
    reused: false, switchTo: '',
    duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old', switchTo: '' },
    totalBytes: 0, characterCount: 1, characters: []
  });
  const token = 'c'.repeat(32);
  await f.window.__settingsTest.previewToken(token);
  const warning = f.get('settings-zip-preview-warning');
  assert.match(warning.textContent, /QA包装（2）/);
  assert.match(warning.textContent, /旧版本保留/);
  assert.equal(f.get('settings-zip-confirm').textContent, '导入');

  f.api.commitResult = {
    ok: true, reused: false, renamed: true, switchTo: '',
    pack: { id: 'd'.repeat(64), name: 'QA包装（2）', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.equal(f.api.committed.token, token);
  const notice = f.get('settings-notice');
  assert.equal(notice.hidden, false);
  assert.match(f.get('settings-notice-text').textContent, /已作为新皮肤导入，旧版本保留/);
  assert.equal(f.get('settings-notice-action').hidden, true);
  assert.equal(f.get('settings-zip-preview').hidden, true);
});

test('提交时才发现内容已存在：显示「已经导入过」并提供切换按钮', async () => {
  const f = fixture();
  const switchTo = `pack:${'e'.repeat(64)}:whale`;
  f.api.previewSkinPack = async () => ({
    ok: true, name: 'QA包装', installedName: 'QA包装', version: '1.0.0', sourceId: 'qa-pack',
    reused: false, switchTo: '', duplicate: null, totalBytes: 0, characterCount: 1, characters: []
  });
  await f.window.__settingsTest.previewToken('f'.repeat(32));
  f.api.commitResult = {
    ok: true, reused: true, renamed: false, switchTo,
    pack: { id: 'e'.repeat(64), name: 'QA包装', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.match(f.get('settings-notice-text').textContent, /这个皮肤包已经导入过/);
  const action = f.get('settings-notice-action');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, '切换到它');
  action.emit('click');
  assert.equal(f.api.skinId, switchTo);
  assert.equal(f.get('settings-notice').hidden, true);
});

test('导入 UI 已移除 PACK_CONFIRM 覆盖确认流程', () => {
  assert.doesNotMatch(source, /PACK_CONFIRM|needsConfirm|acceptSameName|确认并导入/);
  assert.match(source, /这个皮肤包已经导入过/);
  assert.match(source, /已作为新皮肤导入，旧版本保留/);
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
