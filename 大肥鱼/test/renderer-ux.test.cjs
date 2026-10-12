const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const dialogueSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dialogue-data.js'), 'utf8');

function fixture() {
  let now = 1000000, sequence = 0;
  const timers = new Map(), elements = new Map(), listeners = new Map();
  const calls = { refresh: 0, menu: 0, move: 0, cancel: 0 };
  const classes = () => {
    const values = new Set();
    return { add: name => values.add(name), remove: name => values.delete(name),
      contains: name => values.has(name), toggle(name, force) {
        const active = force ?? !values.has(name);
        if (active) values.add(name); else values.delete(name);
      } };
  };
  class Element {
    constructor(id) {
      this.id = id; this.handlers = new Map(); this.classList = classes();
      this.textContent = ''; this.scrollTop = 0; this.animations = []; this.replacements = 0;
      this.captures = new Set();
      this.style = {};
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, extra = {}) {
      this.handlers.get(name)?.({ type: name, target: this, preventDefault() {},
        button: 0, pointerId: 1, isPrimary: true, screenX: 200, screenY: 390, detail: 0, ...extra });
    }
    animate(frames, options) {
      const animation = { frames, options, canceled: false, cancel() { this.canceled = true; } };
      this.animations.push(animation); return animation;
    }
    replaceChildren() { this.replacements++; }
    contains(target) { return target === this; }
    closest() { return this.id === 'refresh' || this.id === 'other-windows' ? this : null; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
    focus() { this.focused = true; }
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const media = { matches: false, addEventListener(_name, fn) { this.change = fn; } };
  const api = {
    refresh() { calls.refresh++; }, openMenu() { calls.menu++; },
    startDrag() {}, moveDrag() { calls.move++; }, endDrag() {}, cancelDrag() { calls.cancel++; },
    skinLoadFailed() {}, setInputRegion(open) { calls.input = open; },
    onState(fn) { this.state = fn; }, onResetInput(fn) { this.reset = fn; },
    getState: () => new Promise(() => {})
  };
  const window = { petAPI: api, matchMedia: () => media, addEventListener: (name, fn) => listeners.set(name, fn) };
  const context = vm.createContext({ window, petAPI: api,
    document: { body: { classList: classes() }, getElementById: get, createElement: () => new Element('row') },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { timers.set(++sequence, { fn, due: now + delay }); return sequence; },
    clearTimeout: id => timers.delete(id), setInterval: fn => { calls.tick = fn; }
  });
  vm.runInContext(dialogueSource, context);
  vm.runInContext(source, context);
  const state = { quota: { fetchedAt: now, buckets: [{ name: 'Codex', plan: 'plus',
    windows: [{ label: '每周', remaining: 84, resetsAt: now / 1000 + 200000 }] }] },
    experience: { bubbleSeconds: 8, advanceOnPetTap: false, mirrorOnLeft: true, reducedMotion: false },
    loading: false, stale: false, error: null };
  api.state(structuredClone(state));
  function update(next) { Object.assign(state, next); api.state(structuredClone(state)); }
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due; timers.delete(next[0]); next[1].fn();
    }
    now = end; calls.tick();
  }
  return { get, calls, state, update, advance, api, context, media,
    emitWindow: (name, extra = {}) => listeners.get(name)?.({ preventDefault() {}, ...extra }),
    body: context.document.body.classList };
}

test('触摸长按只打开一次菜单，松手不误触额度', () => {
  const f = fixture(), pet = f.get('pet');
  pet.emit('pointerdown', { pointerType: 'touch' });
  assert.equal(f.body.contains('pressing'), true);
  f.advance(1499); assert.equal(f.calls.menu, 0);
  f.advance(1); assert.equal(f.calls.menu, 1);
  pet.emit('pointerup'); pet.emit('click', { detail: 1 });
  assert.equal(f.calls.refresh, 0);
  assert.equal(f.body.contains('pressing'), false);
  f.advance(2000); assert.equal(f.calls.menu, 1);
});

test('触摸短按仍显示额度，移动后取消长按', () => {
  const f = fixture(), pet = f.get('pet');
  pet.emit('pointerdown', { pointerType: 'touch' }); f.advance(100); pet.emit('pointerup');
  assert.equal(f.calls.refresh, 1);
  pet.emit('pointerdown', { pointerType: 'touch' });
  pet.emit('pointermove', { screenX: 211 }); f.advance(2000); pet.emit('pointerup');
  assert.equal(f.calls.move, 1); assert.equal(f.calls.menu, 0); assert.equal(f.calls.refresh, 1);
});

test('切换、取消触摸和丢失捕获都清理按压状态并允许再次点击', () => {
  for (const exit of ['reset', 'blur', 'pointercancel', 'lostpointercapture']) {
    const f = fixture(), pet = f.get('pet');
    pet.emit('pointerdown', { pointerType: 'pen' });
    if (exit === 'reset') f.api.reset();
    else if (exit === 'blur') f.emitWindow('blur');
    else pet.emit(exit);
    f.advance(2000);
    assert.equal(f.calls.menu, 0, exit);
    assert.equal(f.body.contains('pressing'), false, exit);
    pet.emit('pointerdown', { pointerType: 'touch' }); pet.emit('pointerup');
    assert.equal(f.calls.refresh, 1, exit);
  }
});

test('非主触摸与右键不会启动拖动或长按', () => {
  const f = fixture(), pet = f.get('pet');
  pet.emit('pointerdown', { pointerType: 'touch', isPrimary: false });
  pet.emit('pointerdown', { button: 2 }); f.advance(2000);
  assert.equal(f.calls.menu, 0); assert.equal(pet.captures.size, 0);
});

test('自定义台词按顺序循环，保存更新重置顺序，收尾使用已编辑内容', () => {
  const f = fixture(), bubble = f.get('bubble');
  f.update({ dialogues: { speech: ['第一句', 'Hello 🐋'], sleepy: ['先睡一会儿。'] } });
  bubble.emit('click'); assert.equal(f.get('dialogue').textContent, '第一句');
  bubble.emit('click'); assert.equal(f.get('dialogue').textContent, 'Hello 🐋');
  bubble.emit('click'); assert.equal(f.get('dialogue').textContent, '第一句');
  f.update({ dialogues: { speech: ['修改后的第一句', '新添加的一句'], sleepy: ['新的收尾'] } });
  assert.equal(f.get('dialogue').textContent, '修改后的第一句');
  bubble.emit('click'); assert.equal(f.get('dialogue').textContent, '新添加的一句');
  f.advance(8000); assert.equal(f.get('dialogue').textContent, '新的收尾');
  f.advance(3000); assert.equal(f.body.contains('no-bubble'), true);
});

test('删空日常台词给出编辑入口提示，删空收尾后直接收起，额度点击照常显示', () => {
  const f = fixture();
  f.update({ dialogues: { speech: [], sleepy: [] } });
  f.get('bubble').emit('click'); assert.match(f.get('dialogue').textContent, /编辑台词/);
  f.advance(8000); assert.equal(f.body.contains('no-bubble'), true);
  f.get('pet').emit('click'); assert.equal(f.get('quota-view').inert, false);
  assert.equal(f.calls.refresh, 1);
});

test('保持显示可用 Esc 收起，再次点按恢复；可配置点人物推进纯对话', () => {
  const f = fixture(), pet = f.get('pet');
  f.update({ experience: { ...f.state.experience, bubbleSeconds: 0, advanceOnPetTap: true } });
  pet.emit('click'); f.advance(60000);
  assert.equal(f.body.contains('no-bubble'), false);
  pet.emit('click'); assert.equal(f.get('quota-view').inert, true);
  const first = f.get('dialogue').textContent;
  pet.emit('click'); assert.notEqual(f.get('dialogue').textContent, first);
  f.emitWindow('keydown', { key: 'Escape' }); f.advance(260);
  assert.equal(f.body.contains('no-bubble'), true); assert.equal(f.calls.input, false);
  pet.emit('click'); assert.equal(f.get('quota-view').inert, false);
});

test('阅读期间暂停收起，鼠标与键盘焦点都离开后才继续计时', () => {
  const f = fixture(), bubble = f.get('bubble');
  f.get('pet').emit('click'); f.advance(3000);
  bubble.emit('pointerenter', { pointerType: 'mouse' }); bubble.emit('focusin');
  f.advance(10000); assert.equal(f.body.contains('no-bubble'), false);
  bubble.emit('pointerleave'); f.advance(10000); assert.equal(f.body.contains('no-bubble'), false);
  bubble.emit('focusout', { relatedTarget: null }); f.advance(4999);
  assert.equal(f.body.contains('no-bubble'), false);
  f.advance(1); assert.equal(f.body.contains('no-bubble'), true);
});

test('触摸进入气泡不会留下鼠标悬停；对话超时先收尾再关闭', () => {
  const f = fixture();
  f.get('pet').emit('click'); f.get('bubble').emit('pointerenter', { pointerType: 'touch' });
  f.get('bubble').emit('click'); const text = f.get('dialogue').textContent;
  f.advance(8000); assert.notEqual(f.get('dialogue').textContent, text);
  assert.equal(f.body.contains('no-bubble'), false);
  f.advance(3000); assert.equal(f.body.contains('no-bubble'), true);
});

test('更改停留时间立即作用于当前气泡', () => {
  const f = fixture(); f.get('pet').emit('click'); f.advance(4000);
  f.update({ experience: { ...f.state.experience, bubbleSeconds: 5 } });
  f.advance(4999); assert.equal(f.body.contains('no-bubble'), false);
  f.advance(1); assert.equal(f.body.contains('no-bubble'), true);
});

test('气泡在拖动期间保持显示，松手后才继续剩余倒计时', () => {
  const f = fixture(), pet = f.get('pet');
  pet.emit('click'); f.advance(3000);
  pet.emit('pointerdown', { pointerType: 'mouse' });
  pet.emit('pointermove', { screenX: 230 }); f.advance(20000);
  assert.equal(f.body.contains('no-bubble'), false);
  pet.emit('pointerup'); f.advance(4999);
  assert.equal(f.body.contains('no-bubble'), false);
  f.advance(1); assert.equal(f.body.contains('no-bubble'), true);
});

test('人物动画与气泡跟随动画同时取消，减少动画不会留下偏移', () => {
  const f = fixture(), pet = f.get('pet');
  pet.emit('click');
  const firstPet = f.get('pet-image').animations[0];
  const firstBubble = f.get('speech-anchor').animations[0];
  pet.emit('pointerdown', { pointerType: 'mouse' });
  assert.equal(firstPet.canceled, true); assert.equal(firstBubble.canceled, true);
  pet.emit('pointerup');
  const nextBubble = f.get('speech-anchor').animations.at(-1);
  f.update({ experience: { ...f.state.experience, reducedMotion: true } });
  assert.equal(nextBubble.canceled, true);
});

test('人物和气泡在相同时间压扁并一起恢复', () => {
  const f = fixture(); f.get('pet').emit('click');
  const pet = f.get('pet-image').animations[0], bubble = f.get('speech-anchor').animations[0];
  assert.equal(pet.options.duration, bubble.options.duration);
  const vertical = frame => Number(frame.transform.match(/scale\([^,]+,\s*([\d.]+)/)[1]);
  const peakPet = pet.frames.reduce((a, b) => vertical(a) < vertical(b) ? a : b);
  const peakBubble = bubble.frames.reduce((a, b) => vertical(a) < vertical(b) ? a : b);
  assert.equal(peakPet.offset, peakBubble.offset);
  assert.equal(vertical(peakPet), vertical(peakBubble));
  assert.equal(vertical(pet.frames.at(-1)), 1);
  assert.equal(vertical(bubble.frames.at(-1)), 1);
});

test('额度变化才播放动画，失败保留缓存，过期显示未知', () => {
  const f = fixture(); f.get('pet').emit('click');
  f.state.quota.buckets[0].windows[0].remaining = 83; f.update({});
  assert.equal(f.get('remaining').textContent, '83'); assert.equal(f.get('remaining').animations.length, 1);
  f.advance(1000); assert.equal(f.get('remaining').animations.length, 1);
  f.update({ error: '连接暂时中断', stale: true });
  assert.equal(f.get('remaining').textContent, '83'); assert.match(f.get('updated').textContent, /刷新失败/);
  f.state.quota.buckets[0].windows[0].resetsAt = 1; f.update({});
  assert.equal(f.get('remaining').textContent, '—'); assert.equal(f.get('percent').hidden, true);
});

test('刷新冷却和加载状态能正确恢复，后台更新不重建未变化的周期列表', () => {
  const f = fixture();
  f.state.quota.buckets[0].windows.push({ label: '5 小时', remaining: 99, resetsAt: 14000 }); f.update({});
  const rows = f.get('other-windows').replacements;
  f.update({ loading: true, refreshAvailableAt: 1010000 });
  assert.equal(f.get('refresh').disabled, true); assert.match(f.get('refresh').title, /刷新/);
  f.update({ loading: false }); assert.match(f.get('refresh').title, /10 秒/);
  f.advance(10000); assert.equal(f.get('refresh').disabled, false);
  assert.equal(f.get('other-windows').replacements, rows);
});

test('减少动画设置与系统设置都会取消动画，贴左侧转向不会改台词', () => {
  const f = fixture(); f.get('pet').emit('click');
  const animation = f.get('pet-image').animations[0];
  f.update({ anchorLeft: true, experience: { ...f.state.experience, reducedMotion: true } });
  assert.equal(animation.canceled, true); assert.equal(f.body.contains('face-left'), true);
  f.get('bubble').emit('click'); assert.equal(f.get('dialogue').animations.length, 0);
  f.update({ experience: { ...f.state.experience, reducedMotion: false, mirrorOnLeft: false } });
  assert.equal(f.body.contains('face-left'), false);
  f.media.matches = true; f.media.change();
  f.get('pet').emit('click'); assert.equal(f.get('pet-image').animations.length, 1);
});
