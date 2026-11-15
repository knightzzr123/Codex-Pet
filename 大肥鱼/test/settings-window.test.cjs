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
      this.attrs = new Map(); this.children = [];
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
  const api = { closed: false, close() { this.closed = true; }, imported: null, previewed: null };
  const window = {
    settingsAPI: api,
    addEventListener: (name, fn) => listeners.set(name, fn),
    location: { search: '' }
  };
  const context = vm.createContext({ window, document: doc, URLSearchParams, globalThis: { location: window.location } });
  vm.runInContext(source, context);
  return {
    get, api, doc,
    emitWindow: (name, extra = {}) => listeners.get(name)?.({ preventDefault() {}, ...extra })
  };
}

test('设置窗开着时 app.quit 能完成', () => {
  const settings = {
    __allowClose: false,
    closed: false,
    requested: false,
    isDestroyed() { return this.closed; },
    close() {
      if (settingsCloseBlocked(this)) {
        this.requested = true;
        return;
      }
      this.closed = true;
    }
  };
  settings.close();
  assert.equal(settings.closed, false);
  assert.equal(settings.requested, true);
  settings.__allowClose = true;
  settings.close();
  assert.equal(settings.closed, true);
  assert.equal(settingsCloseBlocked({ __loadFailed: true }), false);
  assert.equal(settingsCloseBlocked({ __rendererGone: true }), false);
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  assert.match(main, /before-quit/);
  assert.match(main, /settingsWindow\.__allowClose = true/);
  assert.match(main, /settingsWindow\.close\(\)/);
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
