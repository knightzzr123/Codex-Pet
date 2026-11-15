const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');
const css = read('settings.css');
const html = read('settings.html');
const script = read('settings.js');

function block(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed ${selector}`);
}

const at = needle => {
  const index = html.indexOf(needle);
  assert.ok(index >= 0, `missing ${needle}`);
  return index;
};

test('V1 外观页首屏紧凑：皮肤卡片、导入区、大小按钮与间距', () => {
  const card = block(css, '.settings-skin-card {');
  assert.match(card, /width: 112px/);
  assert.match(card, /min-height: 0/);
  assert.match(card, /padding: 8px/);
  assert.match(card, /gap: 4px/);
  assert.match(card, /position: relative/);
  assert.match(css, /\.settings-skin-card img \{ width: 56px; height: 56px/);
  const badge = block(css, '.settings-skin-card.is-active::after');
  assert.match(badge, /content: "✓"/);
  assert.match(badge, /position: absolute/);
  assert.match(badge, /top: 4px/);
  assert.match(badge, /right: 6px/);
  assert.match(badge, /font-size: 12px/);

  const drop = block(css, '.settings-drop {');
  assert.match(drop, /min-height: 56px/);
  assert.match(drop, /padding: 8px 12px/);
  assert.match(drop, /display: flex/);
  assert.match(drop, /flex-wrap: wrap/);
  assert.match(drop, /align-items: center/);
  assert.match(drop, /gap: var\(--space-1\) var\(--space-3\)/);
  // Dragging and terminal states still expand to the roomy layout.
  assert.match(css, /\.settings-drop\[data-state="hover"\], \.settings-drop\[data-state="illegal"\],/);
  assert.match(css, /\.settings-drop\[data-state="error"\], \.settings-drop\[data-state="success"\] \{/);
  for (const state of ['idle', 'hover', 'illegal', 'busy', 'success', 'error']) {
    assert.match(script, new RegExp(`\\b${state}: \\['`), state);
  }

  const sizeButton = block(css, '.settings-size-btn {');
  assert.match(sizeButton, /width: 32px/);
  assert.match(sizeButton, /height: 32px/);
  assert.match(sizeButton, /min-height: 32px/);
  assert.match(sizeButton, /font-size: 13px/);
  const sizeBox = block(css, '.settings-size {');
  assert.match(sizeBox, /display: flex/);
  assert.match(sizeBox, /flex-wrap: wrap/);
  assert.match(sizeBox, /gap: 6px/);

  assert.match(block(css, '.settings-content {'), /padding: var\(--space-4\) var\(--space-5\) var\(--space-6\)/);
  assert.match(block(css, '.settings-kicker-title'), /margin: var\(--space-4\) 0 var\(--space-2\)/);

  const reset = block(css, '.settings-reset[data-reset-key]');
  assert.match(reset, /width: 32px/);
  assert.match(reset, /height: 32px/);
  assert.match(block(css, '.settings-reset-group'), /min-height: 32px/);
  assert.match(html, /data-reset-key="opacity" aria-label="重置透明度"/);
  assert.match(html, /data-reset-key="sizeLevel" aria-label="重置大小"/);
  assert.match(css, /button:focus-visible, input:focus-visible, \.settings-drop:focus-visible \{/);

  // The drop zone moved directly under the skin grid, still before 透明度.
  assert.ok(at('id="settings-skins"') < at('id="settings-zip-drop"'));
  assert.ok(at('id="settings-zip-drop"') < at('id="settings-zip-preview"'));
  assert.ok(at('id="settings-zip-preview"') < at('id="settings-opacity"'));
});

function fixture() {
  const elements = new Map();
  const listeners = new Map();
  const doc = {
    activeElement: null,
    body: { classList: { toggle() {} } },
    documentElement: { dataset: {} },
    getElementById: id => get(id),
    createElement: tag => Object.assign(new Element('created'), { tag }),
    querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn)
  };
  class Element {
    constructor(id) {
      this.id = id; this.handlers = new Map(); this.classList = { add() {}, remove() {}, toggle() {} };
      this.textContent = ''; this.className = ''; this.hidden = false; this.focused = false; this.children = [];
      this.dataset = {}; this.attrs = new Map(); this.focusables = [];
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    querySelectorAll(selector) {
      if (selector.startsWith('.')) {
        const name = selector.slice(1);
        return this.children.filter(child => String(child.className).split(' ').includes(name));
      }
      return this.focusables;
    }
    focus() { this.focused = true; doc.activeElement = this; }
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const vm = require('node:vm');
  const window = {
    settingsAPI: undefined,
    addEventListener: (name, fn) => listeners.set(name, fn),
    location: { search: '' }
  };
  const context = vm.createContext({
    window, document: doc, URLSearchParams, setTimeout, clearTimeout,
    globalThis: { location: window.location }
  });
  vm.runInContext(script, context);
  return { get, doc, window, applyState: window.__settingsTest.applyState };
}

test('V2 卡片主行只放名称，来源进小号副行，完整名留在 title/aria-label', () => {
  const nameRule = block(css, '.settings-skin-name');
  assert.match(nameRule, /word-break: keep-all/);
  assert.match(nameRule, /overflow-wrap: anywhere/);
  assert.match(nameRule, /-webkit-line-clamp: 2/);
  assert.match(nameRule, /-webkit-box-orient: vertical/);
  assert.match(nameRule, /text-align: center/);
  assert.match(nameRule, /line-height: 1.3/);
  const originRule = block(css, '.settings-skin-origin');
  assert.match(originRule, /font-size: 11px/);
  assert.match(originRule, /color: var\(--muted\)/);

  const f = fixture();
  f.applyState({
    sizeLevel: 4,
    skin: { id: 'rose', name: '紫角玫瑰 · 半身', kind: 'builtin' },
    skins: [
      { id: 'default', name: '默认 · 鲸鱼娘', kind: 'builtin', thumbnailUrl: 'data:image/svg+xml,<svg/>' },
      { id: 'rose', name: '紫角玫瑰 · 半身', kind: 'builtin', thumbnailUrl: 'data:image/svg+xml,<svg/>' },
      { id: 'pack:abc:whale', name: '海洋包 · 鲸鱼娘', kind: 'pack' },
      { id: 'image:one', name: '自定义图', kind: 'image' }
    ],
    experience: {}
  });
  const cards = f.get('settings-skins').children;
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(card => card.children.find(child => child.className === 'settings-skin-origin')?.textContent),
    ['默认', '内置', '导入', '导入']);
  for (const card of cards) {
    const name = card.children.find(child => child.className === 'settings-skin-name');
    assert.ok(name, 'card has a .settings-skin-name line');
    assert.equal(name.textContent, card.title);
    assert.match(card.getAttribute('aria-label'), new RegExp(card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(card.getAttribute('role'), 'radio');
  }
  assert.equal(cards[1].getAttribute('aria-checked'), 'true');
  assert.equal(cards[1].className, 'settings-skin-card is-active');
  assert.equal(cards[0].getAttribute('aria-checked'), 'false');
  assert.equal(cards[2].children[0].tag, 'span', 'a card without thumbnail starts with the name line');
  assert.equal(cards[1].children[0].tag, 'img');
  assert.equal(cards[1].children[0].className, 'settings-chip-thumb');
  assert.equal(cards[1].children[0].getAttribute('aria-hidden'), 'true');
  assert.match(script, /const name = document\.createElement\('span'\);\s*name\.className = 'settings-skin-name';/);
  assert.match(script, /name\.textContent = skin\.name;/);
});

test('V3 删除重复区块标题，控件行用 label/for 与 radiogroup 关联', () => {
  for (const title of ['>透明度<', '>大小<']) {
    assert.equal(html.split(title).length - 1, 1, `${title} appears once in the control row only`);
  }
  assert.doesNotMatch(html, /settings-kicker-title">透明度</);
  assert.doesNotMatch(html, /settings-kicker-title">大小</);
  assert.match(html, /<label class="settings-label" for="settings-opacity">透明度<\/label>/);
  assert.match(html, /<span class="settings-label" id="settings-size-label">大小<\/span>/);
  assert.match(html, /id="settings-size" class="settings-size" role="radiogroup" aria-labelledby="settings-size-label"/);

  const field = block(css, '.settings-field {');
  assert.match(field, /display: grid/);
  assert.match(field, /grid-template-columns: auto auto 1fr/);
  assert.match(field, /align-items: center/);
  assert.match(field, /gap: var\(--space-1\) var\(--space-2\)/);
  assert.match(block(css, '.settings-field .settings-value'), /justify-self: end/);
  // Every cell is pinned to the first row so the range starts on row two; an
  // auto-placed reset would otherwise push the slider into a third row.
  assert.match(block(css, '.settings-field .settings-label'), /grid-row: 1/);
  assert.match(block(css, '.settings-field .settings-reset'), /grid-row: 1/);
  const range = block(css, '.settings-field input[type="range"]');
  assert.match(range, /grid-row: 2/);
  assert.match(range, /margin: 0/);

  // Size radios keep role=radio + aria-checked, driven from settings.js.
  const f = fixture();
  f.applyState({ sizeLevel: 7, skin: { id: 'default', name: '默认 · 鲸鱼娘', kind: 'builtin' }, skins: [], experience: {} });
  const radios = f.get('settings-size').children;
  assert.equal(radios.length, 10);
  for (const radio of radios) {
    assert.equal(radio.getAttribute('role'), 'radio');
    assert.match(radio.getAttribute('aria-label'), /大小 \d+ 档/);
    assert.equal(radio.getAttribute('aria-checked'), String(radio.getAttribute('data-level') === '7'));
  }
  assert.match(script, /button\.setAttribute\('role', 'radio'\)/);
  assert.match(script, /button\.setAttribute\('aria-checked', String\(active\)\)/);
});
