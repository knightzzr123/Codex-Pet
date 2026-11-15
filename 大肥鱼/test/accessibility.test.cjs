const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const dialogueSource = fs.readFileSync(path.join(root, 'src', 'dialogue-data.js'), 'utf8');

function fixture() {
  let now = 1000000, sequence = 0;
  const timers = new Map(), elements = new Map(), listeners = new Map();
  const doc = {
    activeElement: null,
    hidden: false,
    body: { classList: classes() },
    getElementById: id => get(id),
    createElement: () => new Element('created'),
    querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn)
  };
  function classes() {
    const values = new Set();
    return { add: name => values.add(name), remove: name => values.delete(name),
      contains: name => values.has(name), toggle(name, force) {
        const active = force ?? !values.has(name);
        if (active) values.add(name); else values.delete(name);
      } };
  }
  class Element {
    constructor(id) {
      this.id = id; this.handlers = new Map(); this.classList = classes();
      this.textContent = ''; this.scrollTop = 0; this.replacements = 0; this.captures = new Set();
      this.attrs = new Map(); this.style = {}; this.hidden = false; this.focused = false; this.focusables = [];
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, extra = {}) {
      this.handlers.get(name)?.({ type: name, target: this, preventDefault() {},
        button: 0, pointerId: 1, isPrimary: true, screenX: 200, screenY: 390, detail: 0, ...extra });
    }
    animate() { const animation = { canceled: false, cancel() { this.canceled = true; } }; return animation; }
    replaceChildren() { this.replacements++; }
    append(...children) { this.children = (this.children || []).concat(children); }
    contains(target) { return target === this; }
    closest() { return null; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    focus() { this.focused = true; doc.activeElement = this; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name); }
    querySelectorAll(selector) { return this.focusables; }
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const media = { matches: false, addEventListener(_name, fn) { this.change = fn; } };
  const api = {
    refresh() {}, openMenu() {}, startDrag() {}, moveDrag() {}, endDrag() {}, cancelDrag() {},
    skinLoadFailed() {}, setInputRegion() {}, setReducedMotion() {},
    onState(fn) { this.state = fn; }, onResetInput(fn) { this.reset = fn; },
    onOpenSettings(fn) { this.openSettings = fn; },
    getState: () => new Promise(() => {})
  };
  const window = { petAPI: api, matchMedia: () => media, addEventListener: (name, fn) => listeners.set(name, fn) };
  const context = vm.createContext({ window, petAPI: api, document: doc,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { timers.set(++sequence, { fn, due: now + delay }); return sequence; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { api.tick = fn; return 1; }, clearInterval() {}
  });
  vm.runInContext(dialogueSource, context);
  // Mirrors the `hidden` attribute in index.html before the panel is opened.
  get('settings-panel').hidden = true;
  vm.runInContext(source, context);
  api.state({ experience: { bubbleSeconds: 8, idleIntervalSec: 45 }, loading: false });
  return {
    get, api, doc, media,
    emitWindow: (name, extra = {}) => listeners.get(name)?.({ preventDefault() {}, ...extra }),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; timers.delete(next[0]); next[1].fn();
      }
      now = end; api.tick?.();
    }
  };
}

test('设置面板是带名称和说明的模态对话框，打开后聚焦关闭按钮，Esc 后回到角色', () => {
  const f = fixture();
  const panel = f.get('settings-panel'), close = f.get('settings-close');
  assert.equal(panel.hidden, true);
  f.api.openSettings();
  assert.equal(panel.hidden, false);
  assert.equal(panel.ariaHidden, 'false');
  assert.equal(close.focused, true);
  assert.equal(f.doc.activeElement, close);
  f.emitWindow('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(panel.ariaHidden, 'true');
  assert.equal(f.get('pet').focused, true);
});

test('Tab 与 Shift+Tab 在设置面板内循环，不把焦点丢到窗口外', () => {
  const f = fixture();
  const panel = f.get('settings-panel'), close = f.get('settings-close'), action = f.get('settings-import-skin');
  f.api.openSettings();
  panel.focusables = [close, action];
  close.focus();
  panel.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(action.focused, true);
  action.focus();
  panel.emit('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(close.focused, true);
});

test('HTML 补齐读屏名称、单选语义与范围控件标签', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="settings-title"/);
  assert.match(html, /aria-describedby="settings-intro"/);
  assert.match(html, /id="settings-title"/);
  for (const id of ['settings-bubble-x', 'settings-bubble-y', 'settings-idle', 'settings-opacity']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-label=`), id);
  }
  assert.match(html, /id="settings-skins"[^>]*role="radiogroup"/);
  assert.match(html, /aria-checked="true"[^>]*data-bubble-seconds="8"/);
  assert.match(html, /id="settings-close"[^>]*aria-label="关闭设置"/);
});

test('渲染层维护返回焦点、aria-checked 与皮肤按钮读屏状态', () => {
  assert.match(source, /settingsReturnFocus/);
  assert.match(source, /settings-close'\)\?\.focus/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /aria-checked/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /aria-label', `\$\{active \? '当前角色' : '切换到'\}/);
});

test('高对比使用 forced-colors 系统色、真实边框与焦点环，并说明皮肤图限制', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /CanvasText/);
  assert.match(css, /Highlight/);
  assert.match(css, /border: 4px solid CanvasText/);
  assert.match(css, /#pet-image \{ forced-color-adjust: none; \}/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /#bubble:focus-visible/);
  // Reduced motion was delivered with P1; accessibility here must not duplicate it.
  assert.match(css, /prefers-reduced-motion: reduce/);
});
