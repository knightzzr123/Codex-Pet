const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const text = hex.replace('#', '');
  const red = Number.parseInt(text.slice(0, 2), 16);
  const green = Number.parseInt(text.slice(2, 4), 16);
  const blue = Number.parseInt(text.slice(4, 6), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function blockAfter(css, marker) {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, marker);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed ${marker}`);
}

function variables(block) {
  const values = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) values[match[1]] = match[2].trim();
  const resolve = name => {
    const value = values[name];
    const nested = value && value.match(/^var\((--[a-z0-9-]+)\)$/);
    return nested ? resolve(nested[1]) : value;
  };
  return resolve;
}

test('深色主题的文字、链接、边框和状态底色达到对比度', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.css'), 'utf8');
  for (const marker of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const resolve = variables(blockAfter(css, marker));
    const background = resolve('--color-bg');
    const surface = resolve('--color-surface');
    const text = resolve('--color-text');
    const secondary = resolve('--color-text-secondary');
    const accent = resolve('--color-accent');
    const focus = resolve('--color-focus');
    const danger = resolve('--color-danger');
    const dangerBg = resolve('--color-danger-bg');
    assert.ok(contrast(text, background) >= 4.5, `${marker} text ${contrast(text, background)}`);
    assert.ok(contrast(secondary, background) >= 4.5, `${marker} secondary`);
    assert.ok(contrast(focus, surface) >= 4.5, `${marker} link ${contrast(focus, surface)}`);
    assert.ok(contrast(focus, background) >= 4.5, `${marker} link on page`);
    assert.ok(contrast(accent, surface) >= 3, `${marker} selected border ${contrast(accent, surface)}`);
    assert.ok(contrast(focus, surface) >= 3, `${marker} focus ring`);
    assert.ok(contrast(danger, dangerBg) >= 4.5, `${marker} illegal state ${contrast(danger, dangerBg)}`);
    assert.equal(accent, '#8cb6ff');
    assert.equal(focus, '#8cb6ff');
  }
  assert.match(css, /data-state="illegal"\] \{ background: var\(--color-danger-bg\); border-color: var\(--color-danger\)/);
  assert.doesNotMatch(css, /data-state="illegal"\][^{]*\{[^}]*#fdeeee/);
});

test('V4 深色滚动条跟随主题：10px 轨道、thumb 对背景 ≥3:1', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.css'), 'utf8');
  for (const marker of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const resolve = variables(blockAfter(css, marker));
    const thumb = resolve('--scrollbar-thumb');
    const background = resolve('--bg');
    assert.equal(thumb, '#5c6784', `${marker} thumb`);
    assert.ok(contrast(thumb, background) >= 3, `${marker} scrollbar ${contrast(thumb, background)}`);
  }
  const light = variables(blockAfter(css, ':root {'));
  assert.equal(light('--scrollbar-thumb'), '#c3cfe6');
  assert.match(css, /:root \{ scrollbar-color: var\(--scrollbar-thumb\) transparent; \}/);
  assert.match(css, /\.settings-content::-webkit-scrollbar \{ width: 10px; height: 10px; \}/);
  assert.match(css, /\.settings-content::-webkit-scrollbar-track \{ background: transparent; \}/);
  assert.match(css, /\.settings-content::-webkit-scrollbar-thumb \{[^}]*background: var\(--scrollbar-thumb\)/);
  assert.match(css, /\.settings-content::-webkit-scrollbar-thumb \{[^}]*border-radius: 5px; border: 2px solid var\(--bg\)/);
  assert.match(css, /\.settings-content::-webkit-scrollbar-thumb:hover \{ background: var\(--muted\); \}/);
  // The real scroll container is .settings-content; body/html do not scroll.
  assert.doesNotMatch(css, /(^|\n)\s*(body|html)::-webkit-scrollbar/);
  assert.match(blockAfter(css, '.settings-content {'), /overflow: auto/);
});
