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

  assert.match(block(css, '.settings-content {'), /padding: var\(--space-5\) var\(--space-5\) var\(--space-6\)/);
  assert.match(block(css, '.settings-kicker-title'), /margin: var\(--space-4\) 0 var\(--space-2\)/);

  const reset = block(css, '.settings-reset[data-reset-key]');
  assert.match(reset, /width: 32px/);
  assert.match(reset, /height: 32px/);
  assert.match(html, /data-reset-key="opacity" aria-label="重置透明度"/);
  assert.match(html, /data-reset-key="sizeLevel" aria-label="重置大小"/);
  assert.match(css, /button:focus-visible, input:focus-visible, \.settings-drop:focus-visible \{/);

  // The drop zone moved directly under the skin grid, still before 透明度.
  assert.ok(at('id="settings-skins"') < at('id="settings-zip-drop"'));
  assert.ok(at('id="settings-zip-drop"') < at('id="settings-zip-preview"'));
  assert.ok(at('id="settings-zip-preview"') < at('id="settings-opacity"'));
});
