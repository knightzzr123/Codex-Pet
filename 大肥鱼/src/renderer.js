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
const reading = new Set();
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => Boolean(state.experience?.reducedMotion || motionPreference.matches);
const bubbleSeconds = () => state.experience?.bubbleSeconds ?? 8;
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
const emptySpeech = '还没有日常台词，右键打开“编辑台词”添加一句吧。';

function setSpeech(text) {
  speechAnimation?.cancel();
  $('dialogue').textContent = text;
  fitDialogue($('dialogue'));
  if (reducedMotion()) return;
  speechAnimation = $('dialogue').animate([
    { opacity: 0, transform: 'translateY(4px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 240, easing: 'ease-out' });
}
function speak() {
  bubbleMode = 'dialogue';
  setSpeech(speechLines.length ? speechLines[speechIndex++ % speechLines.length] : emptySpeech);
  dialogueStarted = true;
  sleepyReplyShown = false;
  renewBubble();
  render();
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
function render() {
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
  if (bubbleVisible) {
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
      ], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
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
}

function pat() {
  if (state.experience?.advanceOnPetTap && bubbleIsOpen()) speak();
  else showQuota();
  playReaction();
}
function playReaction() {
  cancelPetMotion();
  reactionAnimation?.cancel();
  if (reducedMotion()) return;
  petAnimation = $('pet-image').animate([
    { transform: 'translateY(0) scale(1, 1)', offset: 0 },
    { transform: 'translateY(6px) scale(1.15, .83)', offset: .15 },
    { transform: 'translateY(-20px) scale(.91, 1.13)', offset: .34 },
    { transform: 'translateY(3px) scale(1.08, .93)', offset: .54 },
    { transform: 'translateY(-7px) scale(.97, 1.04)', offset: .72 },
    { transform: 'translateY(1px) scale(1.025, .98)', offset: .88 },
    { transform: 'translateY(0) scale(1, 1)', offset: 1 }
  ], { duration: 760, easing: 'ease-in-out' });
  // A separate anchor preserves the ellipse's own show/hide transition.
  bubbleFollowAnimation = $('speech-anchor').animate([
    { transform: 'translateY(0) scale(1, 1)', offset: 0 },
    { transform: 'translateY(2px) scale(1.035, .83)', offset: .15 },
    { transform: 'translateY(-8px) scale(.98, 1.015)', offset: .34 },
    { transform: 'translateY(1px) scale(1.02, .93)', offset: .54 },
    { transform: 'translateY(-3px) scale(.99, 1.012)', offset: .72 },
    { transform: 'translateY(.5px) scale(1.005, .98)', offset: .88 },
    { transform: 'translateY(0) scale(1, 1)', offset: 1 }
  ], { duration: 760, easing: 'ease-in-out' });
  reactionAnimation = $('reaction').animate([
    { opacity: 0, transform: 'translateY(8px) scale(.5)' },
    { opacity: 1, transform: 'translateY(-4px) scale(1.12)', offset: .3 },
    { opacity: 0, transform: 'translateY(-40px) scale(.9)' }
  ], { duration: 900, easing: 'ease-out' });
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
  cancelDrag();
  cancelPetMotion();
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
  speak();
  playReaction();
});
$('other-windows').addEventListener('scroll', () => { if (bubbleIsOpen()) renewBubble(); });
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeBubble();
  $('pet').focus({ preventScroll: true });
});
window.petAPI.onResetInput(() => { cancelDrag(); stopReading(); });
window.addEventListener('blur', () => { cancelDrag(); stopReading(); window.petAPI.cancelDrag(); });
motionPreference.addEventListener('change', () => {
  if (reducedMotion()) for (const animation of [petAnimation, bubbleFollowAnimation, reactionAnimation, speechAnimation, numberAnimation]) animation?.cancel();
  render();
});

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

