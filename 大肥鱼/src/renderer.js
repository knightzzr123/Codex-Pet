const $ = id => document.getElementById(id);
let state = { quota: null, stale: false, loading: false };
let petAnimation, bubbleFollowAnimation, reactionAnimation, speechAnimation, numberAnimation;
let bubbleUntil = 0;
let pointerDrag = null;
let suppressClick = false;
let inputBubble = null;
let inputHideTimer = null;
let bubbleMode = 'quota';
let speechIndex = 0;
let sleepyIndex = 0;
let dialogueStarted = false;
let sleepyReplyShown = false;
let currentSkinUrl = '';
let longPressTimer = null;
let previousRemaining = null;
let otherRowsText = '';
let pauseStarted = null;
let settingsOpen = false;
let settingsReturnFocus = null;
let idleTimer = null;
let lastIdleAt = Date.now();
let lastInteractionAt = Date.now();
let lastSessionToastId = 0;
let sessionToastTimer = null;
const reading = new Set();
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const MOTION = Object.freeze({
  ease: 'cubic-bezier(.22, 1, .36, 1)',
  micro: 200,
  panel: 320,
  reaction: 760
});
const reducedMotion = () => Boolean(state.experience?.reducedMotion || motionPreference.matches);
let reportedReducedMotion = null;
function reportReducedMotion() {
  const reduced = reducedMotion();
  if (reportedReducedMotion === reduced) return;
  reportedReducedMotion = reduced;
  window.petAPI.setReducedMotion?.(reduced);
}
const bubbleSeconds = () => state.experience?.bubbleSeconds ?? 8;
const idleIntervalMs = () => Math.max(5000, (state.experience?.idleIntervalSec ?? 45) * 1000);
const bubbleIsOpen = () => Boolean(state.bubble) || Date.now() < bubbleUntil || pauseStarted !== null;

function cancelPetMotion() {
  petAnimation?.cancel();
  bubbleFollowAnimation?.cancel();
}

function renewBubble() {
  bubbleUntil = bubbleSeconds() === 0 ? Infinity : Date.now() + bubbleSeconds() * 1000;
  pauseStarted = reading.size ? Date.now() : null;
}
function setReading(reason, active) {
  if (active) {
    if (!reading.size && bubbleIsOpen()) pauseStarted = Date.now();
    reading.add(reason);
  } else {
    reading.delete(reason);
    if (!reading.size && pauseStarted !== null) {
      if (Number.isFinite(bubbleUntil)) bubbleUntil += Date.now() - pauseStarted;
      pauseStarted = null;
    }
  }
}
function stopReading() {
  for (const reason of [...reading]) setReading(reason, false);
}
function closeBubble() {
  bubbleUntil = 0;
  dialogueStarted = false;
  sleepyReplyShown = false;
  pauseStarted = null;
  render();
}
const { DEFAULT_DIALOGUES, fitDialogue } = globalThis.DafeiyuDialogue;
let speechLines = [...DEFAULT_DIALOGUES.speech];
let sleepyLines = [...DEFAULT_DIALOGUES.sleepy];
let dialogueKey = '';
const dialogueTrigger = globalThis.DafeiyuDialogueTriggers?.createDialogueTrigger?.() || null;
const emptySpeech = '还没有日常台词，右键打开“编辑台词”添加一句吧。';

function markInteraction() {
  lastInteractionAt = Date.now();
}

function setSpeech(text) {
  speechAnimation?.cancel();
  $('dialogue').textContent = text;
  fitDialogue($('dialogue'));
  if (reducedMotion()) return;
  speechAnimation = $('dialogue').animate([
    { opacity: 0, transform: 'translateY(4px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: MOTION.micro, easing: MOTION.ease });
}
function speak(trigger = 'click') {
  const decision = dialogueTrigger?.trigger?.(trigger, {
    lines: speechLines,
    sessionState: state.session?.state || 'idle',
    idleIntervalSec: state.experience?.idleIntervalSec,
    interactionAt: lastInteractionAt,
    bubbleOpen: bubbleIsOpen()
  });
  // Idle chatter yields to cooldowns, session busy/error and duplicate lines;
  // an explicit click always still does something.
  if (trigger === 'idle' && !decision?.ok) return false;
  const text = decision?.ok
    ? decision.text
    : speechLines.length ? speechLines[speechIndex++ % speechLines.length] : emptySpeech;
  bubbleMode = 'dialogue';
  setSpeech(text);
  dialogueStarted = true;
  sleepyReplyShown = false;
  renewBubble();
  render();
  return true;
}
function showQuota() {
  bubbleMode = 'quota';
  dialogueStarted = false;
  sleepyReplyShown = false;
  renewBubble();
  render();
  window.petAPI.refresh();
}
function tick() {
  // TIMEOUTSIGNAL becomes an in-character sleepy sign-off before closing.
  if (pauseStarted === null && dialogueStarted && !sleepyReplyShown && Date.now() >= bubbleUntil) {
    if (!sleepyLines.length) { closeBubble(); return; }
    setSpeech(sleepyLines[sleepyIndex++ % sleepyLines.length]);
    sleepyReplyShown = true;
    bubbleUntil = Date.now() + 3000;
  }
  maybeIdleAction();
  render();
}

function remainingValue(window) {
  if (!window || window.remaining === null || window.remaining === undefined) return null;
  if (window.resetsAt && window.resetsAt * 1000 <= Date.now()) return null;
  return window.remaining;
}
function formatPercent(value) {
  return value === null ? '—' : Number(value.toFixed(1)).toString();
}
function countdown(timestamp) {
  if (!timestamp) return '重置时间暂未返回';
  const seconds = Math.max(0, Math.ceil(timestamp - Date.now() / 1000));
  if (!seconds) return '周期已结束，等待刷新';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (days) return `${days}天 ${hours}小时后重置`;
  if (hours) return `${hours}小时 ${minutes}分钟后重置`;
  return `${minutes}分 ${seconds % 60}秒后重置`;
}

function showSessionToast(line) {
  const toast = $('session-toast');
  if (!toast) return;
  clearTimeout(sessionToastTimer);
  toast.textContent = line || 'Codex 状态有变化。';
  toast.hidden = false;
  sessionToastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

function applySessionState() {
  const session = state.session;
  const mascot = $('mascot');
  if (mascot?.dataset) mascot.dataset.session = session?.state || 'idle';
  const chip = $('session-state');
  const text = $('session-state-text');
  if (chip) {
    if (!session) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      if (chip.dataset) chip.dataset.state = session.state;
      chip.classList.toggle('is-degraded', session.degraded === true);
      if (text) text.textContent = session.label || '空闲';
      chip.title = session.title || '';
      chip.setAttribute?.('aria-label', `Codex 状态：${session.label || '空闲'}`);
    }
  }
  const toast = $('session-toast');
  if (!toast) return;
  if (session?.state === 'error' && Number(session.toastId) > lastSessionToastId) {
    lastSessionToastId = Number(session.toastId);
    showSessionToast(session.line);
  } else if (session?.state !== 'error') {
    clearTimeout(sessionToastTimer);
    sessionToastTimer = null;
    toast.hidden = true;
  }
}

function applyExperienceStyles() {
  const experience = state.experience || {};
  const root = document.documentElement?.style;
  if (!root || typeof root.setProperty !== 'function') return;
  root.setProperty('--bubble-offset-x', `${experience.bubbleOffsetX || 0}px`);
  root.setProperty('--bubble-offset-y', `${experience.bubbleOffsetY || 0}px`);
  // Opacity is primarily applied via BrowserWindow.setOpacity; CSS keeps the panel readable locally.
  const opacity = experience.opacity ?? 1;
  root.setProperty('--pet-opacity', String(Math.max(0.35, Math.min(1, opacity))));
}

function syncSettingsControls() {
  const panel = $('settings-panel');
  if (!panel || typeof document.createElement !== 'function') return;
  try {
    const experience = state.experience || {};
    const sizeLevel = state.sizeLevel || 4;
    const skins = state.skins || [{ id: state.skin?.id || 'default', name: state.skin?.name || '默认' }];
    const skinBox = $('settings-skins');
    if (skinBox && typeof skinBox.replaceChildren === 'function') {
      skinBox.replaceChildren(...skins.map(skin => {
        const button = document.createElement('button');
        const active = state.skin?.id === skin.id;
        button.type = 'button';
        button.className = `settings-chip${active ? ' is-active' : ''}`;
        button.title = skin.name;
        button.setAttribute?.('role', 'radio');
        button.setAttribute?.('aria-checked', String(active));
        button.setAttribute?.('aria-pressed', String(active));
        button.setAttribute?.('aria-label', `${active ? '当前角色' : '切换到'}：${skin.name}`);
        if (skin.thumbnailUrl && typeof button.append === 'function') {
          const image = document.createElement('img');
          image.className = 'settings-chip-thumb';
          image.src = skin.thumbnailUrl;
          image.alt = '';
          image.loading = 'lazy';
          image.setAttribute?.('aria-hidden', 'true');
          const label = document.createElement('span');
          label.textContent = skin.name;
          button.append(image, label);
        } else {
          button.textContent = skin.name;
        }
        button.addEventListener('click', () => window.petAPI.setSkin?.(skin.id));
        return button;
      }));
    }
    const sizeBox = $('settings-size');
    if (sizeBox && !sizeBox.childElementCount && typeof sizeBox.append === 'function') {
      for (let level = 1; level <= 10; level += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-size-btn';
        button.setAttribute('data-level', String(level));
        button.textContent = `${level}`;
        button.setAttribute('aria-label', `大小 ${level} 档`);
        button.addEventListener('click', () => window.petAPI.setSizeLevel?.(level));
        sizeBox.append(button);
      }
    }
    if (sizeBox && typeof sizeBox.querySelectorAll === 'function') {
      for (const button of sizeBox.querySelectorAll('.settings-size-btn')) {
        button.classList.toggle('is-active', Number(button.getAttribute('data-level')) === sizeLevel);
      }
    }
    const setRange = (id, valueId, value, format = v => v) => {
      const input = $(id); const label = $(valueId);
      if (!input) return;
      if (document.activeElement !== input) input.value = String(value);
      if (label) label.textContent = format(value);
    };
    setRange('settings-bubble-x', 'settings-bubble-x-value', experience.bubbleOffsetX || 0);
    setRange('settings-bubble-y', 'settings-bubble-y-value', experience.bubbleOffsetY || 0);
    setRange('settings-idle', 'settings-idle-value', experience.idleIntervalSec || 45);
    setRange('settings-opacity', 'settings-opacity-value', experience.opacity ?? 1, v => `${Math.round(Number(v) * 100)}%`);
    const setToggle = (id, value) => { const input = $(id); if (input) input.checked = Boolean(value); };
    setToggle('settings-advance', experience.advanceOnPetTap);
    setToggle('settings-mirror', experience.mirrorOnLeft !== false);
    setToggle('settings-reduced', experience.reducedMotion);
    const seconds = experience.bubbleSeconds ?? 8;
    const secondsValue = $('settings-bubble-seconds-value');
    if (secondsValue) secondsValue.textContent = seconds === 0 ? '保持显示' : `${seconds} 秒`;
    const sizeValue = $('settings-size-value');
    if (sizeValue) sizeValue.textContent = `${sizeLevel} 档`;
    for (const button of panel.querySelectorAll?.('[data-bubble-seconds]') || []) {
      button.classList.toggle('is-active', Number(button.getAttribute('data-bubble-seconds')) === seconds);
    }
  } catch {
    // Unit fixture DOM is intentionally incomplete.
  }
}

function setSettingsOpen(open) {
  settingsOpen = Boolean(open);
  const panel = $('settings-panel');
  if (!panel) return;
  panel.hidden = !settingsOpen;
  panel.ariaHidden = String(!settingsOpen);
  document.body.classList.toggle('settings-open', settingsOpen);
  // Keep native hit-testing large enough for the panel without blocking pet drag when closed.
  globalThis.petAPI.setInputRegion(settingsOpen || bubbleIsOpen());
  if (settingsOpen) {
    $('settings-close')?.focus?.({ preventScroll: true });
  } else {
    const target = settingsReturnFocus && settingsReturnFocus !== document.body ? settingsReturnFocus : $('pet');
    try { target?.focus?.({ preventScroll: true }); } catch {}
    settingsReturnFocus = null;
  }
}

function maybeIdleAction() {
  if (reducedMotion() || settingsOpen || pointerDrag || bubbleIsOpen()) return;
  if (Date.now() - lastIdleAt < idleIntervalMs()) return;
  lastIdleAt = Date.now();
  playIdleNudge();
  // Idle speech is optional: the trigger module applies the long cooldown,
  // session-state suppression and line deduplication.
  speak('idle');
}

function playIdleNudge() {
  cancelPetMotion();
  if (reducedMotion()) return;
  petAnimation = $('pet-image').animate([
    { transform: 'translateY(0) scale(1, 1)' },
    { transform: 'translateY(-6px) scale(.98, 1.03)', offset: .45 },
    { transform: 'translateY(0) scale(1, 1)' }
  ], { duration: MOTION.panel, easing: MOTION.ease });
  bubbleFollowAnimation = $('speech-anchor').animate([
    { transform: 'translateY(0)' },
    { transform: 'translateY(-3px)', offset: .45 },
    { transform: 'translateY(0)' }
  ], { duration: MOTION.panel, easing: MOTION.ease });
}

function render() {
  reportReducedMotion();
  applyExperienceStyles();
  const skinUrl = state.skin?.url || '../assets/pet.png';
  if (skinUrl !== currentSkinUrl) {
    cancelPetMotion();
    currentSkinUrl = skinUrl;
    $('pet-image').src = skinUrl;
    $('pet-image').alt = state.skin?.name || '鲸鱼娘';
  }
  const buckets = state.quota?.buckets || [];
  const first = buckets[0];
  const window = first?.windows?.[0];
  const remaining = remainingValue(window);
  const bubbleVisible = bubbleIsOpen();
  document.body.classList.toggle('no-bubble', !bubbleVisible);
  document.body.classList.toggle('face-left', Boolean(state.anchorLeft && state.experience?.mirrorOnLeft !== false));
  document.body.classList.toggle('reduced-motion', reducedMotion());
  $('bubble').inert = !bubbleVisible;
  $('bubble').ariaHidden = String(!bubbleVisible);
  const quotaVisible = bubbleMode === 'quota';
  for (const [id, active] of [['quota-view', quotaVisible], ['dialogue-view', !quotaVisible]]) {
    $(id).classList.toggle('is-active', active);
    $(id).inert = !active;
    $(id).ariaHidden = String(!active);
  }
  if (bubbleVisible || settingsOpen) {
    clearTimeout(inputHideTimer);
    inputHideTimer = null;
    if (inputBubble !== true) {
      inputBubble = true;
      globalThis.petAPI.setInputRegion(true);
    }
  } else if (inputBubble === true && inputHideTimer === null) {
    // Keep the native region until the CSS fade-out has finished.
    inputHideTimer = setTimeout(() => {
      inputHideTimer = null;
      inputBubble = false;
      globalThis.petAPI.setInputRegion(false);
    }, 260);
  } else if (inputBubble === null) {
    inputBubble = false;
    globalThis.petAPI.setInputRegion(false);
  }
  document.body.classList.toggle('error', Boolean(state.error) && !state.quota);
  document.body.classList.toggle('low', remaining !== null && remaining <= 20);
  const nextRemaining = formatPercent(remaining);
  if ($('remaining').textContent !== nextRemaining) {
    numberAnimation?.cancel();
    $('remaining').textContent = nextRemaining;
    if (previousRemaining !== null && remaining !== null && bubbleVisible && quotaVisible && !reducedMotion()) {
      numberAnimation = $('remaining').animate([
        { transform: 'translateY(12px)', opacity: .2 },
        { transform: 'translateY(0)', opacity: 1 }
      ], { duration: MOTION.panel, easing: MOTION.ease });
    }
  }
  previousRemaining = remaining;
  $('percent').hidden = remaining === null;
  $('period').textContent = window
    ? `${window.label} · ${state.stale ? '上次剩余' : '可用额度'}${first.name !== 'Codex' ? ` · ${first.name}` : ''}`
    : state.loading ? '正在读取账户额度' : '暂时无法读取额度';
  const others = [];
  buckets.forEach((bucket, index) => bucket.windows.forEach((other, winIndex) => {
    if (!index && !winIndex) return;
    const value = remainingValue(other);
    others.push(`${bucket.name} ${other.label} 剩余 ${formatPercent(value)}${value === null ? '' : '%'} · ${countdown(other.resetsAt)}`);
  }));
  document.body.classList.toggle('multiple', others.length > 0);
  const nextRowsText = others.join('\n');
  if (nextRowsText !== otherRowsText) {
    otherRowsText = nextRowsText;
    const oldScroll = $('other-windows').scrollTop;
    $('other-windows').replaceChildren(...others.map(text => {
      const row = document.createElement('div'); row.className = 'other-row'; row.textContent = text; return row;
    }));
    $('other-windows').scrollTop = oldScroll;
  }
  $('reset').textContent = window ? countdown(window.resetsAt)
    : state.error ? '点击 ↻ 重试' : '连接本机 Codex…';
  const clock = state.quota ? new Date(state.quota.fetchedAt).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }) : '';
  $('updated').textContent = state.loading ? '刷新中…' : state.error
    ? state.quota ? `刷新失败 · 上次 ${clock}` : '读取失败 · 可重试'
    : state.quota ? `${(first.plan || '').toUpperCase()} · 更新 ${clock}` : '首次读取';
  $('bubble').title = !quotaVisible ? '' : state.error || [
    '账户共享额度，每 2 分钟自动刷新',
    ...buckets.flatMap(bucket => bucket.windows.map(item => `${bucket.name} ${item.label}：剩余 ${formatPercent(remainingValue(item))}%`)),
    window?.resetsAt ? `重置：${new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）` : ''
  ].filter(Boolean).join('\n');
  $('status-dot').className = `status-dot ${state.stale || state.error ? 'stale' : state.quota ? 'live' : ''}`;
  const cooldown = Math.max(0, Math.ceil(((state.refreshAvailableAt || 0) - Date.now()) / 1000));
  $('refresh').disabled = state.loading || cooldown > 0;
  $('refresh').classList.toggle('loading', state.loading);
  $('refresh').ariaBusy = String(state.loading);
  $('refresh').title = state.loading ? '正在刷新额度' : cooldown ? `${cooldown} 秒后可再次刷新` : '刷新额度';
  applySessionState();
  syncSettingsControls();
}

function pat() {
  lastIdleAt = Date.now();
  markInteraction();
  if (state.experience?.advanceOnPetTap && bubbleIsOpen()) speak();
  else showQuota();
  playReaction();
}
function playReaction() {
  cancelPetMotion();
  reactionAnimation?.cancel();
  lastIdleAt = Date.now();
  markInteraction();
  if (reducedMotion()) return;
  petAnimation = $('pet-image').animate([
    { transform: 'translateY(0) scale(1, 1)', offset: 0 },
    { transform: 'translateY(6px) scale(1.15, .83)', offset: .15 },
    { transform: 'translateY(-20px) scale(.91, 1.13)', offset: .34 },
    { transform: 'translateY(3px) scale(1.08, .93)', offset: .54 },
    { transform: 'translateY(-7px) scale(.97, 1.04)', offset: .72 },
    { transform: 'translateY(1px) scale(1.025, .98)', offset: .88 },
    { transform: 'translateY(0) scale(1, 1)', offset: 1 }
  ], { duration: MOTION.reaction, easing: 'ease-in-out' });
  // A separate anchor preserves the ellipse's own show/hide transition.
  bubbleFollowAnimation = $('speech-anchor').animate([
    { transform: 'translateY(0) scale(1, 1)', offset: 0 },
    { transform: 'translateY(2px) scale(1.035, .83)', offset: .15 },
    { transform: 'translateY(-8px) scale(.98, 1.015)', offset: .34 },
    { transform: 'translateY(1px) scale(1.02, .93)', offset: .54 },
    { transform: 'translateY(-3px) scale(.99, 1.012)', offset: .72 },
    { transform: 'translateY(.5px) scale(1.005, .98)', offset: .88 },
    { transform: 'translateY(0) scale(1, 1)', offset: 1 }
  ], { duration: MOTION.reaction, easing: 'ease-in-out' });
  reactionAnimation = $('reaction').animate([
    { opacity: 0, transform: 'translateY(8px) scale(.5)' },
    { opacity: 1, transform: 'translateY(-4px) scale(1.12)', offset: .3 },
    { opacity: 0, transform: 'translateY(-40px) scale(.9)' }
  ], { duration: 900, easing: MOTION.ease });
}
$('pet').addEventListener('click', event => {
  if (suppressClick) { suppressClick = false; return; }
  if (event.detail === 0) pat();
});
$('pet-image').addEventListener('error', () => {
  if (state.skin?.id && state.skin.id !== 'default') window.petAPI.skinLoadFailed(state.skin.id);
});
for (const id of ['pet', 'bubble']) {
  $(id).addEventListener('contextmenu', event => {
    event.preventDefault();
    cancelDrag();
    window.petAPI.cancelDrag();
    window.petAPI.openMenu();
  });
}
$('pet').addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.isPrimary === false) return;
  // Settings panel stays open; dragging the pet must still work (panel does not capture pet).
  cancelDrag();
  cancelPetMotion();
  markInteraction();
  suppressClick = false;
  pointerDrag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false, menuOpened: false };
  setReading('drag', true);
  document.body.classList.add('pressing');
  $('pet').setPointerCapture(event.pointerId);
  window.petAPI.startDrag({ x: event.screenX, y: event.screenY });
  if (event.pointerType === 'touch' || event.pointerType === 'pen') {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pointerDrag || pointerDrag.moved) return;
      pointerDrag.menuOpened = true;
      suppressClick = true;
      document.body.classList.remove('pressing');
      window.petAPI.cancelDrag();
      window.petAPI.openMenu();
    }, 1500);
  }
});
$('pet').addEventListener('pointermove', event => {
  if (!pointerDrag || event.pointerId !== pointerDrag.id || pointerDrag.menuOpened) return;
  if (Math.hypot(event.screenX - pointerDrag.x, event.screenY - pointerDrag.y) >= 6) pointerDrag.moved = true;
  if (pointerDrag.moved) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    document.body.classList.remove('pressing');
    document.body.classList.add('dragging');
    window.petAPI.moveDrag({ x: event.screenX, y: event.screenY });
  }
});
function releaseDrag(event) {
  if (!pointerDrag || event.pointerId !== pointerDrag.id) return;
  const tapped = event.type === 'pointerup' && !pointerDrag.moved && !pointerDrag.menuOpened;
  clearTimeout(longPressTimer);
  longPressTimer = null;
  suppressClick = true;
  pointerDrag = null;
  setReading('drag', false);
  document.body.classList.remove('dragging');
  document.body.classList.remove('pressing');
  window.petAPI.endDrag();
  if ($('pet').hasPointerCapture(event.pointerId)) $('pet').releasePointerCapture(event.pointerId);
  if (tapped) pat();
}
function cancelDrag() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  const id = pointerDrag?.id;
  pointerDrag = null;
  setReading('drag', false);
  suppressClick = false;
  document.body.classList.remove('dragging');
  document.body.classList.remove('pressing');
  if (id !== undefined && $('pet').hasPointerCapture(id)) $('pet').releasePointerCapture(id);
}
$('pet').addEventListener('pointerup', releaseDrag);
$('pet').addEventListener('pointercancel', releaseDrag);
$('pet').addEventListener('lostpointercapture', releaseDrag);
$('refresh').addEventListener('click', () => window.petAPI.refresh());
$('bubble').addEventListener('click', event => {
  if (event.target.closest('#refresh, #other-windows')) return;
  markInteraction();
  speak();
  playReaction();
});
$('bubble').addEventListener('pointerenter', event => {
  if (event.pointerType === 'mouse') setReading('hover', true);
});
$('bubble').addEventListener('pointerleave', () => setReading('hover', false));
$('bubble').addEventListener('focusin', () => setReading('focus', true));
$('bubble').addEventListener('focusout', event => {
  if (!$('bubble').contains(event.relatedTarget)) setReading('focus', false);
});
$('bubble').addEventListener('keydown', event => {
  if (event.target !== $('bubble') || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  markInteraction();
  speak();
  playReaction();
});
$('other-windows').addEventListener('scroll', () => { if (bubbleIsOpen()) renewBubble(); });
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (settingsOpen) { setSettingsOpen(false); return; }
  closeBubble();
  $('pet').focus({ preventScroll: true });
});
window.petAPI.onResetInput(() => { cancelDrag(); stopReading(); });
window.addEventListener('blur', () => { cancelDrag(); stopReading(); window.petAPI.cancelDrag(); });
motionPreference.addEventListener('change', () => {
  if (reducedMotion()) for (const animation of [petAnimation, bubbleFollowAnimation, reactionAnimation, speechAnimation, numberAnimation]) animation?.cancel();
  render();
});

$('settings-close')?.addEventListener('click', () => setSettingsOpen(false));
// The panel is a modal dialog: keep Tab/Shift+Tab inside it until it closes.
$('settings-panel')?.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !settingsOpen) return;
  const panel = $('settings-panel');
  const focusable = typeof panel.querySelectorAll === 'function'
    ? [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.hidden)
    : [];
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus?.({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus?.({ preventScroll: true });
  }
});
$('settings-import-skin')?.addEventListener('click', () => window.petAPI.importSkin());
$('settings-import-pack')?.addEventListener('click', () => window.petAPI.importSkinPack());
$('settings-edit-dialogues')?.addEventListener('click', () => window.petAPI.editDialogues());
$('settings-export-preferences')?.addEventListener('click', () => window.petAPI.exportPreferences());
$('settings-import-preferences')?.addEventListener('click', () => window.petAPI.importPreferences());
for (const [id, key, cast] of [
  ['settings-bubble-x', 'bubbleOffsetX', Number],
  ['settings-bubble-y', 'bubbleOffsetY', Number],
  ['settings-idle', 'idleIntervalSec', Number],
  ['settings-opacity', 'opacity', Number]
]) {
  $(id)?.addEventListener('input', event => {
    const value = cast(event.target.value);
    window.petAPI.setExperience(key, value);
    // Apply the visible part immediately; the main process persists the same
    // value and returns the canonical (clamped) state a moment later.
    if (key === 'bubbleOffsetX') {
      document.documentElement?.style?.setProperty('--bubble-offset-x', `${value}px`);
      $('settings-bubble-x-value').textContent = String(value);
    }
    if (key === 'bubbleOffsetY') {
      document.documentElement?.style?.setProperty('--bubble-offset-y', `${value}px`);
      $('settings-bubble-y-value').textContent = String(value);
    }
    if (key === 'idleIntervalSec') $('settings-idle-value').textContent = String(value);
    if (key === 'opacity') {
      document.documentElement?.style?.setProperty('--pet-opacity', String(Math.max(0.35, Math.min(1, value))));
      $('settings-opacity-value').textContent = `${Math.round(value * 100)}%`;
    }
  });
}
const setToggle = (id, key) => $(id)?.addEventListener('change', event => {
  window.petAPI.setExperience?.(key, event.target.checked);
});
setToggle('settings-advance', 'advanceOnPetTap');
setToggle('settings-mirror', 'mirrorOnLeft');
setToggle('settings-reduced', 'reducedMotion');
for (const button of document.querySelectorAll?.('[data-bubble-seconds]') || []) {
  button.addEventListener('click', () => window.petAPI.setExperience?.('bubbleSeconds', Number(button.getAttribute('data-bubble-seconds'))));
}
for (const button of document.querySelectorAll?.('[data-reset-key]') || []) {
  button.addEventListener('click', () => window.petAPI.resetSetting?.(button.getAttribute('data-reset-key')));
}
for (const button of document.querySelectorAll?.('[data-reset-group]') || []) {
  button.addEventListener('click', () => window.petAPI.resetGroup?.(button.getAttribute('data-reset-group')));
}
$('settings-reset-all')?.addEventListener('click', () => window.petAPI.resetAll?.());
window.petAPI.onOpenSettings?.(() => setSettingsOpen(true));

function receiveState(next) {
  const oldSeconds = bubbleSeconds();
  const wasOpen = bubbleIsOpen();
  state = next;
  const library = state.dialogues;
  if (library && Array.isArray(library.speech) && Array.isArray(library.sleepy)) {
    const nextKey = JSON.stringify(library);
    if (nextKey !== dialogueKey) {
      dialogueKey = nextKey;
      speechLines = [...library.speech]; sleepyLines = [...library.sleepy];
      speechIndex = 0; sleepyIndex = 0;
      dialogueTrigger?.reset?.();
      if (wasOpen && bubbleMode === 'dialogue') {
        setSpeech(sleepyReplyShown && sleepyLines.length ? sleepyLines[sleepyIndex++ % sleepyLines.length]
          : speechLines.length ? speechLines[speechIndex++ % speechLines.length] : emptySpeech);
      }
    }
  }
  if (wasOpen && oldSeconds !== bubbleSeconds()) renewBubble();
  if (reducedMotion()) for (const animation of [petAnimation, bubbleFollowAnimation, reactionAnimation, speechAnimation, numberAnimation]) animation?.cancel();
  render();
}
window.petAPI.onState(receiveState);
window.petAPI.getState().then(receiveState);
setInterval(tick, 1000);
