const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveSettingsWindow, settingsCloseBlocked } = require('../src/settings-window.cjs');

const Module = require('node:module');

const root = path.join(__dirname, '..');
// Loaded only so the fixture can execute settings.js in a VM; assertions below
// are on the resulting behavior and DOM, never on this text.
const settingsSource = fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8');

// A tiny HTML tokenizer: the tests assert on the parsed element tree and its
// attributes instead of matching the settings.html source text.
function loadSettingsDom() {
  const html = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');
  const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  const all = [];
  const stack = [];
  let last = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    const text = html.slice(last, match.index);
    if (stack.length) stack[stack.length - 1].text += text;
    last = tagPattern.lastIndex;
    if (match[1] === '/') {
      const name = match[2].toLowerCase();
      while (stack.length && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length) stack.pop();
      continue;
    }
    const attrs = {};
    const attrPattern = /([^\s=/>]+)(?:="([^"]*)")?/g;
    let attribute;
    while ((attribute = attrPattern.exec(match[3] || ''))) {
      attrs[attribute[1]] = attribute[2] === undefined ? '' : attribute[2];
    }
    const node = { tag: match[2].toLowerCase(), attrs, children: [], text: '', parent: stack[stack.length - 1] || null };
    all.push(node);
    if (stack.length) stack[stack.length - 1].children.push(node);
    if (!voidTags.has(node.tag) && !match[4]) stack.push(node);
  }
  const textContent = node => node.text + node.children.map(textContent).join('');
  return {
    all,
    byId: id => all.find(node => node.attrs.id === id) || null,
    byRole: role => all.filter(node => node.attrs.role === role),
    text: () => (all.length ? textContent(all[0]) : '')
  };
}

// Replace electron for one test so openSettingsWindow's real BrowserWindow
// options can be asserted without launching a window.
function fakeElectron(t) {
  const windows = [];
  class FakeWebContents {
    setWindowOpenHandler() {}
    on() {}
    once() {}
    send() {}
    isDestroyed() { return false; }
  }
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      windows.push(this);
    }
    setMenu() {}
    on() {}
    once() {}
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return false; }
    focus() {}
    show() {}
    close() {}
  }
  const screen = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    getPrimaryDisplay() { return { workArea: this.workArea }; },
    getDisplayMatching() { return { workArea: this.workArea }; }
  };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: FakeWindow, screen };
    return originalLoad.call(Module, request, parent, isMain);
  });
  return { windows };
}

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
  vm.runInContext(settingsSource, context);
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

  // B12 / G0-2: main.cjs cannot be loaded here without Electron, so the one
  // invariant quit depends on is checked on its source: the flag must be set
  // before close(), otherwise the close guard blocks app.quit forever.
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
  const dom = loadSettingsDom();
  const categories = dom.byRole('tab').filter(node => node.attrs['data-category']);
  assert.deepEqual(categories.map(node => node.attrs['data-category']),
    ['appearance', 'dialogue', 'behavior', 'accessibility', 'preferences', 'about']);
  for (const label of ['外观/皮肤', '对话/台词', '行为/待机', '无障碍', '偏好导入导出', '诊断/关于']) {
    assert.ok(dom.text().includes(label), label);
  }
  const panel = dom.byId('settings-panel');
  assert.equal(panel.attrs.role, 'dialog');
  assert.equal(panel.attrs['aria-modal'], undefined);
  assert.equal(panel.attrs['aria-labelledby'], 'settings-title');
  assert.equal(dom.byId('settings-nav').attrs['aria-orientation'], 'vertical');
  assert.ok(dom.byId('settings-zip-drop'));
  assert.ok(dom.byId('settings-zip-preview'));
  assert.equal(dom.byId('settings-close').attrs['aria-label'], '关闭设置');
  for (const id of ['settings-bubble-x', 'settings-bubble-y', 'settings-idle', 'settings-opacity']) {
    assert.ok(dom.all.some(node => node.tag === 'label' && node.attrs.for === id), id);
    const input = dom.byId(id);
    assert.ok(input, id);
    assert.equal(input.tag, 'input', id);
    assert.equal(input.attrs.type, 'range', id);
  }
  // A2: the preview section is not a live region; only #settings-live announces.
  assert.equal(dom.byId('settings-zip-preview').attrs['aria-live'], undefined);
  assert.equal(dom.byId('settings-zip-preview').attrs['aria-label'], '皮肤包导入预览');
});

test('皮肤卡片暴露 radio、当前选中和切换语义', () => {
  const f = fixture();
  seedSkins(f, ['default', 'rose']);
  const active = skinCard(f, 'default');
  const other = skinCard(f, 'rose');
  assert.equal(active.getAttribute('role'), 'radio');
  assert.equal(active.getAttribute('aria-checked'), 'true');
  assert.equal(active.getAttribute('aria-pressed'), 'true');
  assert.match(active.getAttribute('aria-label'), /当前角色/);
  assert.equal(other.getAttribute('aria-checked'), 'false');
  assert.match(other.getAttribute('aria-label'), /切换到/);
  f.get('settings-import-skin').focus();
  f.window.__settingsTest.focusClose();
  assert.equal(f.doc.activeElement, f.get('settings-close'), 'focusClose 把焦点移到关闭按钮');
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

const tick = () => new Promise(resolve => setImmediate(resolve));

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
  // A switch is not an import: the drop zone says where it moved to.
  assert.equal(f.get('settings-zip-drop').dataset.state, 'switched');
  assert.equal(f.get('settings-drop-title').textContent, '已切换到「QA包装」');
  assert.notEqual(f.get('settings-drop-title').textContent, '导入成功');
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
  assert.equal(f.get('settings-zip-drop').dataset.state, 'existing');
  assert.equal(f.get('settings-drop-title').textContent, '已有这个皮肤包');
  assert.notEqual(f.get('settings-drop-title').textContent, '导入成功');
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
  assert.equal(f.get('settings-zip-drop').dataset.state, 'existing');
  assert.equal(f.get('settings-drop-title').textContent, '已有这个皮肤包');
  const action = f.get('settings-notice-action');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, '切换到它');
  assert.equal(f.doc.activeElement, action, '带「切换到它」的提示把焦点放在该按钮');
  assert.deepEqual(polite.writes, ['这个皮肤包已经导入过。可以切换到「QA包装」。']);
  action.emit('click');
  assert.equal(f.api.skinId, switchTo);
  assert.equal(f.get('settings-notice').hidden, true);
  assert.equal(f.get('settings-zip-drop').dataset.state, 'switched');
  assert.equal(f.get('settings-drop-title').textContent, '已切换到「QA包装」');
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
  assert.equal(f.get('settings-zip-drop').dataset.state, 'existing');
  assert.equal(f.get('settings-drop-title').textContent, '已有这个皮肤包');
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

test('取消预览后拖放区回到空闲标题', async () => {
  const f = fixture();
  f.get('settings-notice').hidden = true;
  f.api.previewSkinPack = async () => freshPreview({
    duplicate: { kind: 'sourceId', existingName: 'QA包装', existingId: 'old', switchTo: '' }
  });
  await f.window.__settingsTest.previewToken('a'.repeat(32));
  assert.equal(f.get('settings-zip-drop').hidden, true);
  f.get('settings-zip-cancel').emit('click');
  await tick();
  assert.equal(f.api.canceled, 'a'.repeat(32));
  assert.equal(f.get('settings-zip-drop').dataset.state, 'idle');
  assert.equal(f.get('settings-drop-title').textContent, '将 .zip 或皮肤包文件夹拖到此处');
});

test('内容相同的提示被取消（未切换）后拖放区回到空闲标题', async () => {
  const f = fixture();
  const switchTo = `pack:${'f'.repeat(64)}:whale`;
  seedSkins(f, ['default', switchTo]);
  f.get('settings-notice').hidden = true;
  f.api.previewSkinPack = async () => freshPreview();
  await f.window.__settingsTest.previewToken('b'.repeat(32));
  f.api.commitResult = {
    ok: true, reused: true, renamed: false, switchTo,
    duplicate: { kind: 'content', existingName: 'QA包装', existingId: 'f'.repeat(64) },
    pack: { id: 'f'.repeat(64), name: 'QA包装', characterCount: 1 }
  };
  await f.window.__settingsTest.submitZip();
  assert.equal(f.get('settings-drop-title').textContent, '已有这个皮肤包');
  assert.equal(f.get('settings-notice').hidden, false);
  f.get('settings-notice-close').emit('click');
  assert.equal(f.get('settings-zip-drop').dataset.state, 'idle');
  assert.equal(f.get('settings-drop-title').textContent, '将 .zip 或皮肤包文件夹拖到此处');
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
});

test('预览失败时焦点回到拖拽区并只播报一次错误', async () => {
  const f = fixture();
  const assertive = liveRecorder(f, 'settings-live-assertive');
  const polite = liveRecorder(f, 'settings-live');
  f.api.previewSkinPack = async () => { throw new Error('读取皮肤包失败'); };
  await f.window.__settingsTest.previewToken('c'.repeat(32));
  assert.equal(f.get('settings-zip-drop').dataset.state, 'error');
  assert.equal(f.get('settings-drop-title').textContent, '导入失败');
  assert.equal(f.get('settings-drop-detail').textContent, '读取皮肤包失败');
  assert.deepEqual(assertive.writes, ['读取皮肤包失败']);
  assert.equal(polite.writes.length, 0);
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
});

test('「选择文件…」选坏图时给同一句中文提示并恢复可再次选择（D-16CB-CHOOSE-UNHANDLED）', async () => {
  const f = fixture();
  const assertive = liveRecorder(f, 'settings-live-assertive');
  const failed = '这张图片无法显示，可能已损坏。请换一张图片。';
  f.api.chooseSkinPack = async () => {
    // Electron rejects ipcRenderer.invoke with an English wrapper; the path
    // comes from the native dialog / fs error. Neither may reach the UI.
    throw new Error("Error invoking remote method 'skin-pack:choose': Error: "
      + "ENOENT: no such file or directory, open '/home/qa/private/bad.png'");
  };
  f.get('settings-import-zip').emit('click', { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  const drop = f.get('settings-zip-drop');
  assert.equal(drop.dataset.state, 'error');
  assert.equal(f.get('settings-drop-title').textContent, '导入失败');
  assert.equal(f.get('settings-drop-detail').textContent, failed);
  assert.deepEqual(assertive.writes, [failed]);
  assert.equal(f.get('settings-zip-status').textContent, failed);
  const visible = [f.get('settings-drop-title').textContent, f.get('settings-drop-detail').textContent,
    f.get('settings-zip-status').textContent, assertive.value()].join('\n');
  assert.doesNotMatch(visible, /ENOENT|Error|invoking|\/home\/qa|bad\.png/);
  for (const id of ['settings-import-zip', 'settings-import-pack', 'settings-import-skin']) {
    assert.equal(f.get(id).disabled, false, id);
  }
  assert.equal(f.doc.activeElement, drop);

  // The same buttons can start another selection: the state must not stay busy.
  f.api.chooseSkinPack = async () => ({ ok: true, image: true, canceled: true });
  f.get('settings-import-zip').emit('click', { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(drop.dataset.state, 'idle');
  assert.equal(f.get('settings-drop-title').textContent, '将 .zip 或皮肤包文件夹拖到此处');
  assert.equal(f.get('settings-live').textContent, '已取消图片导入');
});

test('预览返回错误码时焦点回到拖拽区，损坏格式只显示统一中文', async () => {
  const f = fixture();
  const assertive = liveRecorder(f, 'settings-live-assertive');
  f.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_CRC', error: '压缩包条目 CRC 校验失败。' });
  await f.window.__settingsTest.previewToken('d'.repeat(32));
  assert.equal(f.get('settings-zip-drop').dataset.state, 'error');
  assert.equal(f.get('settings-drop-title').textContent, '导入失败');
  assert.equal(f.get('settings-drop-detail').textContent, '压缩包已损坏或格式不受支持，请重新打包后再试。');
  assert.deepEqual(assertive.writes, ['压缩包已损坏或格式不受支持，请重新打包后再试。']);
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
});

test('非普通 ZIP 显示「只能导入普通 ZIP 文件。」，不显示成压缩包损坏', async () => {
  const damaged = '压缩包已损坏或格式不受支持，请重新打包后再试。';
  const f = fixture();
  f.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_UNSUPPORTED', error: '只能导入普通 ZIP 文件。' });
  await f.window.__settingsTest.previewToken('f'.repeat(32));
  assert.equal(f.get('settings-zip-drop').dataset.state, 'error');
  assert.equal(f.get('settings-drop-detail').textContent, '只能导入普通 ZIP 文件。');
  assert.notEqual(f.get('settings-drop-detail').textContent, damaged);

  // The renderer keeps its own copy for the code, so a result without a
  // message field still reads as the specific sentence.
  const fallback = fixture();
  fallback.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_UNSUPPORTED' });
  await fallback.window.__settingsTest.previewToken('9'.repeat(32));
  assert.equal(fallback.get('settings-drop-detail').textContent, '只能导入普通 ZIP 文件。');
  assert.notEqual(fallback.get('settings-drop-detail').textContent, damaged);
});

test('皮肤包校验失败显示具体原因，不显示「压缩包已损坏」', async () => {
  const reasons = [
    '皮肤包缺少文件：whale.png',
    '皮肤包至少需要 1 个角色。',
    '皮肤包清单版本不支持：99（本版本仅支持 1）。',
    '角色“鲸鱼”的图片格式不受支持。',
    '文件夹不存在，请重新选择皮肤包文件夹。'
  ];
  for (const reason of reasons) {
    const f = fixture();
    const assertive = liveRecorder(f, 'settings-live-assertive');
    f.api.previewSkinPack = async () => ({ ok: false, code: 'PACK_INVALID', error: reason });
    await f.window.__settingsTest.previewToken('1'.repeat(32));
    assert.equal(f.get('settings-drop-detail').textContent, reason);
    assert.notEqual(f.get('settings-drop-detail').textContent, '压缩包已损坏或格式不受支持，请重新打包后再试。');
    assert.deepEqual(assertive.writes, [reason]);
    assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
  }
});

test('manifest 缺失与重复各有独立文案，不显示成压缩包损坏', async () => {
  const missing = fixture();
  missing.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_MANIFEST_MISSING' });
  await missing.window.__settingsTest.previewToken('2'.repeat(32));
  assert.equal(missing.get('settings-drop-detail').textContent,
    '没有找到 manifest.json，请确认皮肤包里有一份 manifest.json。');

  const multiple = fixture();
  multiple.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_MANIFEST_MULTIPLE' });
  await multiple.window.__settingsTest.previewToken('3'.repeat(32));
  assert.equal(multiple.get('settings-drop-detail').textContent,
    '皮肤包里有多个 manifest.json，请只保留一份。');

  assert.notEqual(missing.get('settings-drop-detail').textContent,
    multiple.get('settings-drop-detail').textContent);
  for (const f of [missing, multiple]) {
    assert.notEqual(f.get('settings-drop-detail').textContent,
      '压缩包已损坏或格式不受支持，请重新打包后再试。');
  }
});

test('大小超限提示追加「请减小图片后再试」，技术错误不外泄', async () => {
  const f = fixture();
  f.api.previewSkinPack = async () => ({ ok: false, code: 'ZIP_LIMIT', error: '皮肤包总大小超过 200 MB。' });
  await f.window.__settingsTest.previewToken('e'.repeat(32));
  assert.equal(f.get('settings-drop-detail').textContent, '皮肤包总大小超过 200 MB。请减小图片后再试。');
  assert.equal(f.doc.activeElement, f.get('settings-zip-drop'));
});

test('提示不是 live region，播报只走 polite #settings-live', async () => {
  const dom = loadSettingsDom();
  const notice = dom.byId('settings-notice');
  assert.ok(notice);
  assert.equal(notice.attrs.role, undefined);
  assert.equal(notice.attrs['aria-live'], undefined);
  assert.equal(notice.attrs['aria-atomic'], undefined);
  const polite = dom.byId('settings-live');
  assert.equal(polite.attrs.role, 'status');
  assert.equal(polite.attrs['aria-live'], 'polite');
  const assertive = dom.byId('settings-live-assertive');
  assert.equal(assertive.attrs.role, 'alert');

  // The duplicate/renamed import results never go through the assertive
  // region: they are announced once by #settings-live.
  const f = fixture();
  f.get('settings-notice').hidden = true;
  const politeRecorder = liveRecorder(f, 'settings-live');
  const assertiveRecorder = liveRecorder(f, 'settings-live-assertive');
  f.api.previewSkinPack = async () => reusedSwitchPreview('');
  await f.window.__settingsTest.previewToken('1'.repeat(32));
  await f.window.__settingsTest.submitZip();
  assert.equal(politeRecorder.writes.length, 1);
  assert.equal(assertiveRecorder.writes.length, 0);
});

test('导入预览只有「导入/取消」，没有覆盖确认对话框', async () => {
  const dom = loadSettingsDom();
  const preview = dom.byId('settings-zip-preview');
  assert.ok(preview);
  const within = node => {
    for (let current = node?.parent; current; current = current.parent) if (current === preview) return true;
    return false;
  };
  assert.ok(within(dom.byId('settings-zip-confirm')), '导入按钮在预览区内');
  assert.ok(within(dom.byId('settings-zip-cancel')), '取消按钮在预览区内');
  assert.equal(dom.all.some(node => /PACK_CONFIRM|needsConfirm|acceptSameName/.test(node.attrs.id || '')), false);

  const f = fixture();
  f.api.previewSkinPack = async () => freshPreview();
  await f.window.__settingsTest.previewToken('2'.repeat(32));
  assert.equal(f.get('settings-zip-confirm').textContent, '导入');
  assert.equal(f.get('settings-zip-preview').hidden, false);
});

test('设置窗口不挂在宠物窗口下，并保留自己的任务栏按钮', t => {
  const { windows } = fakeElectron(t);
  const { openSettingsWindow } = require('../src/settings-window.cjs');
  const win = openSettingsWindow({ anchor: null });
  assert.equal(windows.length, 1);
  const options = windows[0].options;
  assert.equal('parent' in options, false, '设置窗不挂在宠物窗口下');
  assert.equal(options.modal, false);
  assert.equal(options.skipTaskbar, false, '保留自己的任务栏按钮');
  assert.equal(options.fullscreenable, false);
  assert.equal(win, windows[0]);
});

test('主进程不用托盘，Ctrl+, 与菜单项都打开同一个设置窗口', () => {
  // Electron-only main process: these are minimal source invariants, not DOM
  // or renderer assertions.
  const main = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /new Tray/, '不再使用托盘入口');
  assert.match(main, /before-input-event/);
  const shortcut = main.slice(main.indexOf("win.webContents.on('before-input-event'"));
  const handlerEnd = shortcut.indexOf('publish();');
  assert.ok(handlerEnd > 0, 'before-input-event 处理器紧接着 publish()');
  const handler = shortcut.slice(0, handlerEnd);
  assert.match(handler, /input\.control/);
  assert.match(handler, /input\.key === ','/);
  assert.match(handler, /openSettingsPanel\(\)/);
  assert.match(main, /\{ label: '打开设置…', enabled: !busySkin, click: openSettingsPanel \}/);
});
