const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDialogueTrigger, normalizeLines, TRIGGERS, IDLE_COOLDOWN_MS } = require('../src/dialogue-triggers.js');

function clock(start = 0) {
  let now = start;
  return { now: () => now, set(value) { now = value; }, advance(ms) { now += ms; } };
}

test('触发规则只有点击和闲置，未知触发（含关键词）一律拒绝', () => {
  assert.deepEqual([...TRIGGERS], ['click', 'idle']);
  const time = clock(), trigger = createDialogueTrigger({ now: time.now });
  const result = trigger.trigger('keyword', { lines: { speech: ['不应该出现'] }, interactionAt: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-trigger');
});

test('点击按顺序循环且相邻台词不重复，空台词安全返回', () => {
  const time = clock(), trigger = createDialogueTrigger({ now: time.now, clickCooldownMs: 300 });
  const context = { lines: { speech: ['第一句', '第二句'] }, interactionAt: 0 };
  assert.equal(trigger.trigger('click', context).text, '第一句');
  assert.equal(trigger.trigger('click', context).reason, 'click-cooldown');
  time.advance(300);
  assert.equal(trigger.trigger('click', context).text, '第二句');
  time.advance(300);
  assert.equal(trigger.trigger('click', context).text, '第一句');
  const empty = trigger.trigger('click', { lines: { speech: [] } });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
});

test('闲置需要足够的无交互时间，气泡打开/忙碌/报错时不自动说话', () => {
  const time = clock(10_000), trigger = createDialogueTrigger({ now: time.now, idleCooldownMs: 60_000 });
  const base = { lines: { speech: ['A', 'B'] }, interactionAt: 10_000, idleIntervalSec: 5, sessionState: 'idle' };
  assert.equal(trigger.trigger('idle', { ...base, bubbleOpen: true }).reason, 'bubble-open');
  assert.equal(trigger.trigger('idle', { ...base, sessionState: 'busy' }).reason, 'session-busy');
  assert.equal(trigger.trigger('idle', { ...base, sessionState: 'error' }).reason, 'session-error');
  time.advance(4_999);
  assert.equal(trigger.trigger('idle', base).reason, 'not-idle-enough');
  time.advance(1);
  assert.equal(trigger.trigger('idle', base).text, 'A');
});

test('闲置冷却与去重：冷却内不再说，冷却后换一句，单句不连续重复', () => {
  const time = clock(10_000), trigger = createDialogueTrigger({ now: time.now, idleCooldownMs: 60_000 });
  const context = { lines: { speech: ['A', 'B'] }, interactionAt: 10_000, idleIntervalSec: 5, sessionState: 'idle' };
  time.advance(5_000);
  assert.equal(trigger.trigger('idle', context).text, 'A');
  time.advance(30_000);
  assert.equal(trigger.trigger('idle', context).reason, 'idle-cooldown');
  time.advance(30_000);
  assert.equal(trigger.trigger('idle', context).text, 'B');
  time.advance(60_000);
  assert.equal(trigger.trigger('idle', context).text, 'A');

  const singleTime = clock(10_000), single = createDialogueTrigger({ now: singleTime.now, idleCooldownMs: 1_000 });
  const one = { ...context, lines: { speech: ['只有一句'] } };
  singleTime.advance(5_000);
  assert.equal(single.trigger('idle', one).text, '只有一句');
  singleTime.advance(1_000);
  assert.equal(single.trigger('idle', one).reason, 'duplicate');
  assert.equal(IDLE_COOLDOWN_MS, 5 * 60 * 1000);
});

test('台词更新后 reset 重置顺序，不再携带上一批台词', () => {
  const time = clock(), trigger = createDialogueTrigger({ now: time.now });
  assert.equal(trigger.trigger('click', { lines: { speech: ['旧一', '旧二'] } }).text, '旧一');
  trigger.reset();
  assert.equal(trigger.snapshot().lastText, '');
  assert.equal(trigger.trigger('click', { lines: { speech: ['新一', '新二'] } }).text, '新一');
  assert.deepEqual(normalizeLines({ speech: [' 甲 ', '', 3, '乙'] }), ['甲', '乙']);
});

test('渲染层只在点击/闲置时请求台词，没有关键词或输入监听接线', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.match(html, /dialogue-triggers\.js/);
  assert.match(renderer, /dialogueTrigger\?\.trigger/);
  assert.match(renderer, /speak\('idle'\)/);
  assert.match(renderer, /function maybeIdleAction/);
  assert.doesNotMatch(renderer, /pet:keyword|keyword-match|keywords\b/i);
  assert.doesNotMatch(renderer, /window\.addEventListener\('(?:keypress|input|beforeinput)'/);
});
