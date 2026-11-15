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

test('角色窗口不再内嵌设置对话框，Esc 仍收起气泡并回到角色', () => {
  const f = fixture();
  assert.equal(f.get('settings-panel').hidden, true);
  f.emitWindow('keydown', { key: 'Escape' });
  assert.equal(f.get('pet').focused, true);
  assert.doesNotMatch(source, /id="settings-panel"|settings-panel/);
});

test('设置对话框的读屏名称和焦点循环在独立设置窗口里', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8');
  assert.match(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-labelledby="settings-title"/);
  assert.match(html, /aria-describedby="settings-intro"/);
  assert.match(html, /id="settings-title"/);
  for (const id of ['settings-bubble-x', 'settings-bubble-y', 'settings-idle', 'settings-opacity']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), id);
    assert.match(html, new RegExp(`id="${id}"[^>]*type="range"`), id);
  }
  assert.match(html, /id="settings-skins"[^>]*role="radiogroup"/);
  assert.match(html, /aria-checked="true"[^>]*data-bubble-seconds="8"/);
  assert.match(html, /id="settings-close"[^>]*aria-label="关闭设置"/);
  assert.match(settings, /settingsReturnFocus/);
  assert.match(settings, /settings-close'\)\?\.focus/);
  assert.match(settings, /event\.key !== 'Tab'/);
  assert.match(settings, /aria-checked/);
  assert.match(settings, /aria-pressed/);
  assert.match(settings, /aria-label', `\$\{active \? '当前角色' : '切换到'\}/);
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
