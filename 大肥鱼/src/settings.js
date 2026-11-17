const $ = id => document.getElementById(id);
let state = {};
let settingsReturnFocus = null;
let pendingToken = '';
let currentPreview = null;
// Z-5: switching a skin is confirmed by the main process asynchronously, so the
// skin card that should take focus may only exist after the next state push.
let pendingSkinFocus = null;
let noticeVisible = false;

function nodes(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  try { return [...root.querySelectorAll(selector)]; } catch { return []; }
}

function search() {
  try { return new URLSearchParams(globalThis.location?.search || ''); }
  catch { return new URLSearchParams(); }
}

function applyTheme() {
  const theme = search().get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}

// V2: the card's primary line is the bare skin name; where the skin comes from
// moves to a small secondary line ("默认" / "内置" / "导入").
function skinLabel(skin) {
  if (!skin) return '';
  const name = String(skin.name || '');
  // The built-in default is stored as "默认 · 鲸鱼娘"; the origin line already
  // says 默认, so the card's main line shows the bare name.
  return skin.id === 'default' ? name.replace(/^默认\s*[·・]\s*/, '') : name;
}

function skinOrigin(skin) {
  if (!skin) return '';
  if (skin.id === 'default') return '默认';
  if (skin.kind === 'builtin') return '内置';
  if (skin.kind === 'image' || skin.kind === 'pack') return '导入';
  return '';
}

// R3b: the card's visible name turns the space after the " · " separator into a
// no-break space, so the separator can never be the last thing on a line.
// title/aria-label keep the original name.
function skinDisplayName(skin) {
  return skinLabel(skin).replace(/ · /g, ' \u00b7\u00a0');
}

function selectCategory(id) {
  const tabs = nodes($('settings-nav'), '[role="tab"]');
  for (const tab of tabs) {
    const selected = tab.getAttribute?.('data-category') === id;
    tab.setAttribute?.('aria-selected', String(selected));
    if ('tabIndex' in tab) tab.tabIndex = selected ? 0 : -1;
    const panel = $(tab.getAttribute?.('aria-controls'));
    if (!panel) continue;
    panel.hidden = !selected;
    if (panel.setAttribute) panel.setAttribute('aria-hidden', String(!selected));
  }
}

function syncSettingsControls() {
  const experience = state.experience || {};
  const sizeLevel = state.sizeLevel || 4;
  const skins = state.skins || [{ id: state.skin?.id || 'default', name: state.skin?.name || '默认' }];
  const skinBox = $('settings-skins');
  if (skinBox && typeof skinBox.replaceChildren === 'function' && typeof document.createElement === 'function') {
    skinBox.replaceChildren(...skins.map(skin => {
      const button = document.createElement('button');
      const active = state.skin?.id === skin.id;
      const label = skinLabel(skin);
      button.type = 'button';
      button.className = `settings-skin-card${active ? ' is-active' : ''}`;
      button.title = label;
      // The card is the focus target after a successful Z-5 switch.
      button.setAttribute?.('data-skin-id', skin.id);
      button.setAttribute?.('role', 'radio');
      button.setAttribute?.('aria-checked', String(active));
      button.setAttribute?.('aria-pressed', String(active));
      button.setAttribute?.('aria-label', `${active ? '当前角色' : '切换到'}：${label}`);
      // V2: the card shows one clamped name line plus a small origin line, so
      // only whole names wrap; the full name stays in title/aria-label.
      if (typeof button.append === 'function') {
        if (skin.thumbnailUrl) {
          const image = document.createElement('img');
          image.className = 'settings-chip-thumb';
          image.src = skin.thumbnailUrl;
          image.alt = '';
          image.setAttribute?.('aria-hidden', 'true');
          button.append(image);
        }
        const name = document.createElement('span');
        name.className = 'settings-skin-name';
        name.textContent = skinDisplayName(skin);
        const origin = document.createElement('span');
        origin.className = 'settings-skin-origin';
        origin.textContent = skinOrigin(skin);
        button.append(name, origin);
      } else button.textContent = label;
      button.addEventListener('click', () => window.settingsAPI?.setSkin?.(skin.id));
      return button;
    }));
  }
  // Z-5: the switch result arrives after the state push, so the pending target
  // is resolved here, once the rebuilt cards exist. A still-connected card is
  // left alone, so an unrelated later state push never steals focus.
  if (pendingSkinFocus) {
    const pending = pendingSkinFocus;
    pendingSkinFocus = null;
    const replaced = !pending.node || pending.node.isConnected === false;
    if (replaced && !focusSkinCard(pending.id)) focusDrop();
  }
  const sizeBox = $('settings-size');
  if (sizeBox && !sizeBox.childElementCount && typeof sizeBox.append === 'function') {
    for (let level = 1; level <= 10; level += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-size-btn';
      button.setAttribute('data-level', String(level));
      button.textContent = `${level}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `大小 ${level} 档`);
      button.addEventListener('click', () => window.settingsAPI?.setSizeLevel?.(level));
      sizeBox.append(button);
    }
  }
  if (sizeBox && typeof sizeBox.querySelectorAll === 'function') {
    for (const button of sizeBox.querySelectorAll('.settings-size-btn')) {
      const active = Number(button.getAttribute('data-level')) === sizeLevel;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
  }
  const setRange = (id, valueId, value, format = valueText => valueText) => {
    const input = $(id); const label = $(valueId);
    if (!input) return;
    if (document.activeElement !== input) input.value = String(value);
    if (label) label.textContent = format(value);
  };
  setRange('settings-bubble-x', 'settings-bubble-x-value', experience.bubbleOffsetX || 0);
  setRange('settings-bubble-y', 'settings-bubble-y-value', experience.bubbleOffsetY || 0);
  setRange('settings-idle', 'settings-idle-value', experience.idleIntervalSec || 45);
  setRange('settings-opacity', 'settings-opacity-value', experience.opacity ?? 1, value => `${Math.round(Number(value) * 100)}%`);
  const setToggle = (id, value) => { const input = $(id); if (input) input.checked = Boolean(value); };
  setToggle('settings-advance', experience.advanceOnPetTap);
  setToggle('settings-mirror', experience.mirrorOnLeft !== false);
  setToggle('settings-reduced', experience.reducedMotion);
  const seconds = experience.bubbleSeconds ?? 8;
  const secondsValue = $('settings-bubble-seconds-value');
  if (secondsValue) secondsValue.textContent = seconds === 0 ? '保持显示' : `${seconds} 秒`;
  const sizeValue = $('settings-size-value');
  if (sizeValue) sizeValue.textContent = `${sizeLevel} 档`;
  for (const button of nodes($('settings-panel'), '[data-bubble-seconds]')) {
    const active = Number(button.getAttribute('data-bubble-seconds')) === seconds;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  }
  const deleteSkin = $('settings-delete-skin');
  if (deleteSkin) deleteSkin.hidden = state.skin?.kind !== 'image' && state.skin?.kind !== 'pack';
  const version = $('settings-version');
  if (version && state.version) version.textContent = `内部版本 ${state.version}`;
  const display = $('settings-display-version');
  if (display && state.displayVersion) display.textContent = state.displayVersion;
  document.body.classList.toggle('reduced-motion', Boolean(experience.reducedMotion));
  const scheme = state.colorScheme || 'system';
  for (const button of nodes($('settings-color-scheme'), '[data-color-scheme]')) {
    const active = button.getAttribute('data-color-scheme') === scheme;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('is-active', active);
  }
  if (scheme === 'light' || scheme === 'dark') document.documentElement.dataset.theme = scheme;
  else delete document.documentElement.dataset.theme;
}

function applyState(next) {
  state = next || {};
  try { syncSettingsControls(); } catch { /* the unit fixture DOM is intentionally incomplete */ }
}

function focusClose() {
  settingsReturnFocus = document.activeElement || null;
  $('settings-close')?.focus?.({ preventScroll: true });
}

function showPreview(preview) {
  currentPreview = preview;
  const box = $('settings-zip-preview');
  if (!box) return;
  box.hidden = false;
  const finalName = preview?.installedName || preview?.name || '';
  const title = $('settings-zip-preview-title');
  if (title) title.textContent = preview?.name ? `导入预览 · ${preview.name}` : '导入预览';
  const summary = $('settings-zip-preview-summary');
  const count = preview?.characters?.length || 0;
  const sizeText = formatBytes(preview?.totalBytes || 0);
  if (summary) summary.textContent = `${finalName || '皮肤包'} · ${count} 个角色${preview?.version ? ` · ${preview.version}` : ''} · ${sizeText}`;
  const warning = $('settings-zip-preview-warning');
  const duplicate = preview?.duplicate;
  const reused = preview?.reused === true;
  const switchTo = preview?.switchTo || duplicate?.switchTo || '';
  if (warning) {
    warning.hidden = !duplicate;
    if (reused) {
      warning.textContent = `这个皮肤包已经导入过（「${duplicate.existingName || preview.name}」）。不会再导入一份，可以切换到它。`;
    } else if (duplicate?.kind === 'sourceId') {
      warning.textContent = `已有这个皮肤包的另一个版本「${duplicate.existingName}」。将导入为「${finalName}」，旧版本保留。`;
    } else if (duplicate?.kind === 'name') {
      warning.textContent = `已有同名皮肤包「${duplicate.existingName}」。将另存为「${finalName}」，旧包不会被覆盖。`;
    } else warning.textContent = '';
  }
  const confirm = $('settings-zip-confirm');
  // Z-5: nothing to switch to when the identical pack has no character link.
  if (confirm) confirm.textContent = reused ? (switchTo ? '切换到它' : '知道了') : '导入';
  const list = $('settings-zip-preview-characters');
  if (list && typeof list.replaceChildren === 'function' && typeof document.createElement === 'function') {
    list.replaceChildren(...(preview?.characters || []).slice(0, 12).map(character => {
      const item = document.createElement('div');
      item.className = 'settings-chip';
      if (character.thumbnailUrl) {
        const image = document.createElement('img');
        image.className = 'settings-chip-thumb';
        image.src = character.thumbnailUrl;
        image.alt = `${character.name}的缩略图`;
        item.append(image);
      }
      const label = document.createElement('span');
      label.textContent = character.name;
      item.append(label);
      return item;
    }));
  }
}

function clearPreview() {
  pendingToken = '';
  currentPreview = null;
  const box = $('settings-zip-preview');
  if (box) box.hidden = true;
}

function setStatus(message) {
  const status = $('settings-zip-status');
  if (status) status.textContent = message || '';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function live(message) { const node = $('settings-live'); if (node) node.textContent = message || ''; }
function liveAssert(message) { const node = $('settings-live-assertive'); if (node) node.textContent = message || ''; }

// Z-5 focus: hiding the preview or the toast must never leave focus on <body>.
function focusDrop() {
  $('settings-zip-drop')?.focus?.({ preventScroll: true });
}

function skinCardFor(id) {
  const box = $('settings-skins');
  if (!box || !id) return null;
  const cards = [];
  try { cards.push(...Array.from(box.children || [])); } catch { /* not indexable */ }
  for (const selector of ['.settings-skin-card', '[data-skin-id]']) {
    for (const node of nodes(box, selector)) if (!cards.includes(node)) cards.push(node);
  }
  return cards.find(node => node?.getAttribute?.('data-skin-id') === id) || null;
}

function focusSkinCard(id) {
  const card = skinCardFor(id);
  if (!card || typeof card.focus !== 'function') return false;
  card.focus({ preventScroll: true });
  return true;
}

let noticeTimer = null;
let noticeAction = null;

function noticeHasFocus() {
  const box = $('settings-notice');
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!box || !active) return false;
  if (typeof box.contains === 'function') return box.contains(active) === true;
  return active === $('settings-notice-action') || active === $('settings-notice-close');
}

function hideNotice(options = {}) {
  const wasVisible = noticeVisible;
  const hadFocus = wasVisible && noticeHasFocus();
  noticeVisible = false;
  if (noticeTimer && typeof clearTimeout === 'function') clearTimeout(noticeTimer);
  noticeTimer = null;
  noticeAction = null;
  const box = $('settings-notice');
  if (box) box.hidden = true;
  const text = $('settings-notice-text');
  if (text) text.textContent = '';
  const button = $('settings-notice-action');
  if (button) { button.hidden = true; button.textContent = ''; }
  // Closing must return focus to the drop zone; the 8 s auto-dismiss only does
  // it when focus was actually inside the toast, so it never steals focus.
  if (wasVisible && (options.focus !== false || hadFocus)) focusDrop();
  // Dismissing a duplicate result without switching leaves no import behind, so
  // the drop zone goes back to its idle prompt instead of a stale result title.
  const drop = $('settings-zip-drop');
  if (drop?.dataset?.state === 'existing') setDropState('idle');
}

// A non-blocking toast. An action keeps it open until the user dismisses it or
// follows it; purely informational notices disappear on their own. The toast is
// not a live region any more: one polite sentence per result goes to #settings-live.
function showNotice(message, action = null) {
  const box = $('settings-notice');
  if (!box) return;
  const text = $('settings-notice-text');
  if (text) text.textContent = message || '';
  const button = $('settings-notice-action');
  noticeAction = typeof action?.run === 'function' ? action.run : null;
  if (button) {
    button.hidden = !noticeAction;
    button.textContent = noticeAction ? (action.label || '切换到它') : '';
  }
  box.hidden = false;
  noticeVisible = true;
  if (noticeTimer && typeof clearTimeout === 'function') clearTimeout(noticeTimer);
  noticeTimer = null;
  if (noticeAction) {
    // "切换到它" is the follow-up action, so it takes focus when it appears.
    if (action.focus !== false) button?.focus?.({ preventScroll: true });
  } else if (typeof setTimeout === 'function') {
    noticeTimer = setTimeout(() => { noticeTimer = null; hideNotice({ focus: false }); }, 8000);
    // Do not keep a smoke-test event loop alive just for the toast timer.
    if (noticeTimer && typeof noticeTimer.unref === 'function') noticeTimer.unref();
  }
}

function setDropState(state, detail) {
  const drop = $('settings-zip-drop');
  if (!drop) return;
  drop.dataset.state = state;
  drop.classList.toggle('is-drag', state === 'hover');
  const title = $('settings-drop-title');
  const text = $('settings-drop-detail');
  const labels = {
    idle: ['将 .zip 或皮肤包文件夹拖到此处', '一次一个。也可以选择文件。'],
    hover: ['松开以预览皮肤包', '将开始校验，写入前可以取消。'],
    illegal: ['只能导入 .zip 或皮肤包文件夹', detail || '一次只能导入一个皮肤包'],
    busy: ['正在校验…', '请稍候，完成前不能再次投放。'],
    success: ['导入成功', detail || '皮肤包已写入。'],
    // Identical content is never written a second time, so it must never say
    // "导入成功"; switching reports the skin it moved to instead.
    existing: ['已有这个皮肤包', detail || '没有重复导入。'],
    switched: [detail || '已切换到该皮肤包', '已保存为当前皮肤。'],
    error: ['导入失败', detail || '请重试。']
  };
  const pair = labels[state] || labels.idle;
  const titleText = state === 'switched' ? (detail || pair[0]) : pair[0];
  if (title) title.textContent = titleText;
  if (text) text.textContent = state === 'switched' ? pair[1] : (detail || pair[1]);
  drop.setAttribute('aria-label', titleText);
  const busy = state === 'busy';
  for (const id of ['settings-import-zip', 'settings-import-pack', 'settings-import-skin']) {
    const button = $(id);
    if (button) button.disabled = busy;
  }
  if (state === 'preview') drop.hidden = true;
  else if (state !== 'busy') drop.hidden = false;
}

function isHiddenDeep(node) {
  let current = node;
  while (current) {
    if (current.hidden) return true;
    if (typeof current.closest === 'function' && current.closest('[hidden]')) return true;
    current = current.parentElement || null;
  }
  return false;
}

const DAMAGED_ARCHIVE = '压缩包已损坏或格式不受支持，请重新打包后再试。';

// Only a zip-reader structural failure gets the one damaged-archive sentence.
// Pack validation and manifest-layout codes keep their own copy (the exact
// Chinese reason from the main process when it sent one).
const IMPORT_FALLBACKS = Object.freeze({
  PACK_INVALID: '这个皮肤包不符合导入要求，请检查后重试。',
  ZIP_MANIFEST_MISSING: '没有找到 manifest.json，请确认皮肤包里有一份 manifest.json。',
  ZIP_MANIFEST_MULTIPLE: '皮肤包里有多个 manifest.json，请只保留一份。',
  ZIP_ACCESS: '没有权限读取皮肤包里的文件。',
  ZIP_UNSUPPORTED: '只能导入普通 ZIP 文件。'
});

// The main process already maps these codes, but the renderer keeps the last
// word on what the user reads: a parser detail or an English OS error must
// never appear in the drop zone.
function importErrorMessage(result) {
  const code = result?.code || '';
  const message = typeof result?.error === 'string' ? result.error.trim() : '';
  if (code === 'ZIP_HEADER' || code === 'ZIP_CRC' || code === 'ZIP_FORMAT') return DAMAGED_ARCHIVE;
  if (code === 'ZIP_LIMIT') {
    if (message.includes('请减小图片')) return message;
    return `${message ? message.replace(/[。.]?$/, '。') : '压缩包超过大小上限，'}请减小图片后再试。`;
  }
  return message || IMPORT_FALLBACKS[code] || '无法导入这个皮肤包。';
}

function rejectPack(result) {
  const message = importErrorMessage(result);
  if (result?.code === 'PATH_REJECTED') {
    setDropState('illegal', '只能导入 .zip 或皮肤包文件夹');
    liveAssert(message);
    focusDrop();
    return;
  }
  setDropState('error', message);
  liveAssert(message);
  setStatus(message);
  focusDrop();
}

async function previewToken(token) {
  if (!token || !window.settingsAPI?.previewSkinPack) return;
  // A new preview replaces the previous result toast instead of stacking it.
  if (noticeVisible) hideNotice({ focus: false });
  pendingToken = token;
  setDropState('busy');
  setStatus('正在读取皮肤包…');
  try {
    const preview = await window.settingsAPI.previewSkinPack(token);
    if (!preview?.ok) {
      rejectPack(preview);
      return;
    }
    showPreview(preview);
    setDropState('preview');
    // The drop zone is hidden while the preview is open, so focus follows the
    // preview's primary action instead of falling back to <body>.
    $('settings-zip-confirm')?.focus?.({ preventScroll: true });
    if (preview.reused) {
      // Z-5: identical content is a "you already have this" result, announced
      // once with the switch hint instead of the generic ready message.
      const switchTo = preview.switchTo || preview.duplicate?.switchTo || '';
      const existingName = preview.duplicate?.existingName || preview.name || '';
      live(switchTo ? `这个皮肤包已经导入过。可以切换到「${existingName}」。` : '这个皮肤包已经导入过。');
    } else live(`皮肤包「${preview.name || ''}」已就绪，请确认导入`);
    setStatus('');
  } catch (error) {
    const message = importErrorMessage({ code: error?.code, error: error?.message });
    setDropState('error', message);
    liveAssert(message);
    setStatus(message);
    focusDrop();
  }
}

async function choosePack(mode) {
  setDropState('busy');
  const chosen = await window.settingsAPI?.chooseSkinPack?.(mode);
  if (chosen?.ok && chosen.token) await previewToken(chosen.token);
  else if (chosen?.ok && chosen.image) {
    setDropState('idle');
    live(chosen.canceled ? '已取消图片导入' : '图片已导入');
  } else if (chosen?.ok && chosen.canceled) setDropState('idle');
  else if (chosen && chosen.ok === false) rejectPack(chosen);
  else setDropState('idle');
}

let importingZip = false;

function switchToPack(switchTo, name) {
  if (switchTo) window.settingsAPI?.setSkin?.(switchTo);
  const message = name ? `已切换到「${name}」。` : '已切换到这个皮肤包。';
  setStatus(message);
  live(message);
  setDropState('switched', name ? `已切换到「${name}」` : '已切换到这个皮肤包');
  // Z-5 focus: the switched skin's card takes focus; if the state push has not
  // rebuilt it yet, focusSkinCard runs again from syncSettingsControls.
  const card = switchTo ? skinCardFor(switchTo) : null;
  pendingSkinFocus = switchTo ? { id: switchTo, node: card } : null;
  if (card && typeof card.focus === 'function') card.focus({ preventScroll: true });
  else focusDrop();
}

async function submitZip() {
  if (importingZip || !pendingToken || !window.settingsAPI?.commitSkinPack) return;
  const preview = currentPreview;
  if (preview?.reused) {
    // Identical content is already installed: never write a second copy. The
    // preview's primary action is "switch to it" instead of an import.
    const switchTo = preview.switchTo || preview.duplicate?.switchTo || '';
    const existingName = preview.duplicate?.existingName || preview.name || '';
    if (pendingToken) await window.settingsAPI?.cancelSkinPack?.(pendingToken);
    clearPreview();
    if (switchTo) {
      switchToPack(switchTo, existingName);
      return;
    }
    // Nothing to switch to: the preview said 知道了, so only acknowledge.
    setDropState('existing', '这个皮肤包已经导入过，没有重复导入。');
    setStatus('');
    focusDrop();
    return;
  }
  importingZip = true;
  setDropState('busy');
  try {
    const result = await window.settingsAPI.commitSkinPack({ token: pendingToken });
    if (result?.code === 'PACK_CHANGED') {
      clearPreview();
      setDropState('error', result.error || '皮肤包在预览之后被改过，请重新选择。');
      liveAssert(result.error || '皮肤包在预览之后被改过，请重新选择。');
      focusDrop();
      return;
    }
    if (!result?.ok) {
      rejectPack(result);
      return;
    }
    const name = result.pack?.name || '';
    if (result.reused) {
      const switchTo = result.switchTo || '';
      const existingName = result.duplicate?.existingName || name;
      const done = switchTo
        ? `这个皮肤包已经导入过。可以切换到「${existingName}」。`
        : '这个皮肤包已经导入过。';
      setStatus(done);
      live(done);
      clearPreview();
      setDropState('existing', done);
      // A toast with 切换到它 puts focus on that button; without a switch target
      // the result is just acknowledged and focus returns to the drop zone.
      showNotice(done, switchTo
        ? { label: '切换到它', run: () => switchToPack(switchTo, existingName) }
        : { label: '知道了', run: () => focusDrop(), focus: false });
      if (!switchTo) focusDrop();
      return;
    }
    const renamed = result.renamed === true;
    // Z-5: a different version of the same pack is kept as a new skin; the old
    // version stays installed and nothing is interrupted by a modal. Same-name
    // packs (different sourceId) keep the existing same-named skin instead.
    const done = renamed
      ? (result.duplicate?.kind === 'name'
        ? `已作为新皮肤导入「${name}」，原有同名皮肤保留。`
        : `已作为新皮肤导入「${name}」，旧版本保留。`)
      : (name ? `已导入皮肤包「${name}」。` : '皮肤包已导入。');
    setStatus(done);
    live(done);
    clearPreview();
    setDropState('success', done);
    focusDrop();
    if (renamed) showNotice(done);
  } finally {
    importingZip = false;
  }
}

function bindStaticControls() {
  $('settings-close')?.addEventListener('click', () => { beginClose(); });
  $('settings-notice-action')?.addEventListener('click', () => {
    const action = noticeAction;
    hideNotice();
    try { action?.(); } catch { /* a failed switch must not keep the toast open */ }
  });
  $('settings-notice-close')?.addEventListener('click', () => hideNotice());
  $('settings-panel')?.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const panel = $('settings-panel');
    const focusable = nodes(panel, 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
      .filter(node => !isHiddenDeep(node))
      .filter(node => node.getAttribute?.('role') !== 'tab' || node.getAttribute?.('aria-selected') === 'true');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus?.({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus?.({ preventScroll: true });
    }
  });
  $('settings-nav')?.addEventListener('keydown', event => {
    const tabs = nodes($('settings-nav'), '[role="tab"]');
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    selectCategory(tab.getAttribute('data-category'));
    tab.focus?.({ preventScroll: true });
  });
  for (const tab of nodes($('settings-nav'), '[role="tab"]')) {
    tab.addEventListener?.('click', () => selectCategory(tab.getAttribute('data-category')));
  }
  $('settings-import-skin')?.addEventListener('click', () => window.settingsAPI?.importSkin?.());
  $('settings-import-pack')?.addEventListener('click', event => { event.stopPropagation(); choosePack('directory'); });
  $('settings-import-zip')?.addEventListener('click', event => { event.stopPropagation(); choosePack('file'); });
  $('settings-delete-skin')?.addEventListener('click', () => window.settingsAPI?.deleteCurrentSkin?.());
  $('settings-reset-placement')?.addEventListener('click', () => window.settingsAPI?.resetPlacement?.());
  $('settings-copy-diagnostics')?.addEventListener('click', async () => {
    const result = await window.settingsAPI?.copyDiagnostics?.();
    live(result?.ok ? '已复制' : (result?.error || '无法复制诊断信息'));
  });
  $('settings-edit-dialogues')?.addEventListener('click', () => window.settingsAPI?.editDialogues?.());
  $('settings-export-preferences')?.addEventListener('click', () => window.settingsAPI?.exportPreferences?.());
  $('settings-import-preferences')?.addEventListener('click', () => window.settingsAPI?.importPreferences?.());
  const drop = $('settings-zip-drop');
  drop?.addEventListener('dragover', event => {
    event.preventDefault();
    if (drop.dataset.state === 'busy' || drop.hidden) return;
    setDropState('hover');
  });
  drop?.addEventListener('dragleave', () => { if (drop.dataset.state === 'hover') setDropState('idle'); });
  drop?.addEventListener('drop', async event => {
    event.preventDefault();
    if (drop.dataset.state === 'busy' || drop.hidden) return;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1) {
      setDropState('illegal', '一次只能导入一个皮肤包');
      liveAssert('一次只能导入一个皮肤包');
      return;
    }
    const file = files[0];
    const name = String(file.name || '');
    const zip = name.toLowerCase().endsWith('.zip');
    const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
    if (!zip && !image && file.type && !file.type.startsWith('image/')) {
      setDropState('illegal', '只能导入 .zip 或皮肤包文件夹');
      liveAssert('只能导入 .zip 或皮肤包文件夹');
      return;
    }
    setDropState('busy');
    const registered = await window.settingsAPI?.registerDrop?.(file);
    if (registered?.ok && registered.token) await previewToken(registered.token);
    else rejectPack(registered || { code: 'PATH_REJECTED', error: '只能导入 .zip 或皮肤包文件夹。' });
  });
  for (const groupId of ['settings-skins', 'settings-size', 'settings-bubble-seconds', 'settings-color-scheme']) {
    $(groupId)?.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const radios = nodes($(groupId), '[role="radio"]');
      if (!radios.length) return;
      event.preventDefault();
      const index = Math.max(0, radios.indexOf(document.activeElement));
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = radios[(index + delta + radios.length) % radios.length];
      next.focus?.();
      next.click?.();
    });
  }
  drop?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choosePack('file');
  });
  $('settings-zip-confirm')?.addEventListener('click', () => { submitZip(); });
  $('settings-zip-cancel')?.addEventListener('click', async () => {
    if (pendingToken) await window.settingsAPI?.cancelSkinPack?.(pendingToken);
    clearPreview();
    setDropState('idle');
    live('已取消未导入的皮肤包');
    setStatus('已取消，没有更改皮肤。');
  });
  for (const [id, key, cast] of [
    ['settings-bubble-x', 'bubbleOffsetX', Number],
    ['settings-bubble-y', 'bubbleOffsetY', Number],
    ['settings-idle', 'idleIntervalSec', Number],
    ['settings-opacity', 'opacity', Number]
  ]) {
    $(id)?.addEventListener('input', event => {
      const value = cast(event.target.value);
      window.settingsAPI?.setExperience?.(key, value);
      if (key === 'bubbleOffsetX') $('settings-bubble-x-value').textContent = String(value);
      if (key === 'bubbleOffsetY') $('settings-bubble-y-value').textContent = String(value);
      if (key === 'idleIntervalSec') $('settings-idle-value').textContent = String(value);
      if (key === 'opacity') $('settings-opacity-value').textContent = `${Math.round(value * 100)}%`;
    });
  }
  const setToggle = (id, key) => $(id)?.addEventListener('change', event => {
    window.settingsAPI?.setExperience?.(key, event.target.checked);
  });
  setToggle('settings-advance', 'advanceOnPetTap');
  setToggle('settings-mirror', 'mirrorOnLeft');
  setToggle('settings-reduced', 'reducedMotion');
  for (const button of nodes(document, '[data-bubble-seconds]')) {
    button.addEventListener('click', () => window.settingsAPI?.setExperience?.('bubbleSeconds', Number(button.getAttribute('data-bubble-seconds'))));
  }
  for (const button of nodes(document, '[data-reset-key]')) {
    button.addEventListener('click', () => window.settingsAPI?.resetSetting?.(button.getAttribute('data-reset-key')));
  }
  for (const button of nodes(document, '[data-reset-group]')) {
    button.addEventListener('click', () => {
      if (button.dataset.confirming !== '1') {
        button.dataset.confirming = '1';
        button.dataset.originalLabel = button.textContent;
        button.textContent = '确定重置？';
        setTimeout(() => {
          button.dataset.confirming = '';
          button.textContent = button.dataset.originalLabel || '重置本组';
        }, 5000);
        return;
      }
      button.dataset.confirming = '';
      button.textContent = button.dataset.originalLabel || '重置本组';
      window.settingsAPI?.resetGroup?.(button.getAttribute('data-reset-group'));
      live('已恢复本组默认设置。');
    });
  }
  for (const button of nodes($('settings-color-scheme'), '[data-color-scheme]')) {
    button.addEventListener('click', () => window.settingsAPI?.setExperience?.('colorScheme', button.getAttribute('data-color-scheme')));
  }
  $('settings-reset-all')?.addEventListener('click', () => window.settingsAPI?.resetAll?.());
  window.addEventListener?.('keydown', async event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Z-5: while the toast is open, Esc dismisses it (focus returns to the drop
    // zone) before it cancels a preview or closes the window.
    if (noticeVisible) {
      hideNotice();
      return;
    }
    if (pendingToken) {
      await window.settingsAPI?.cancelSkinPack?.(pendingToken);
      clearPreview();
      setDropState('idle');
      live('已取消未导入的皮肤包');
      return;
    }
    await beginClose();
  });
  window.settingsAPI?.onRequestClose?.(() => { beginClose(); });
}

async function beginClose() {
  if (window.__dialogueDirty) {
    const agreed = typeof window.confirm !== 'function' || window.confirm('有未保存的台词。关闭将放弃这些草稿。');
    if (!agreed) return;
    window.__dialogueDirty = false;
  }
  if (pendingToken) {
    await window.settingsAPI?.cancelSkinPack?.(pendingToken);
    clearPreview();
    setDropState('idle');
  }
  window.settingsAPI?.close?.();
}

function mockState() {
  return {
    version: '3.4.0', displayVersion: 'Codex-Pet-V1.4', sizeLevel: 4,
    skin: { id: 'default', name: '默认 · 鲸鱼娘', kind: 'builtin' },
    skins: [
      { id: 'default', name: '默认 · 鲸鱼娘', kind: 'builtin', thumbnailUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="16" fill="#d7e3ff"/><text x="36" y="46" text-anchor="middle" font-size="32">🐟</text></svg>') },
      { id: 'rose', name: '紫角玫瑰 · 半身', kind: 'builtin', thumbnailUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="16" fill="#f3d7e4"/><text x="36" y="46" text-anchor="middle" font-size="32">🌹</text></svg>') }
    ],
    experience: {
      bubbleSeconds: 8, advanceOnPetTap: false, bubbleOffsetX: 0, bubbleOffsetY: 0,
      idleIntervalSec: 45, mirrorOnLeft: true, reducedMotion: false, opacity: 1
    }
  };
}

function boot() {
  applyTheme();
  bindStaticControls();
  selectCategory('appearance');
  if (window.settingsAPI?.onState) {
    window.settingsAPI.onState(applyState);
    window.settingsAPI.getState?.().then(applyState).catch(() => {});
  } else if (search().get('preview') === '1') applyState(mockState());
  const currentTab = document.querySelector?.('#settings-nav [aria-selected="true"]') || $('tab-appearance');
  currentTab?.focus?.({ preventScroll: true });
  window.settingsAPI?.onShowGroup?.(selectCategory);
  window.settingsAPI?.about?.().then(info => {
    if (!info) return;
    if ($('settings-electron')) $('settings-electron').textContent = info.electron ? `Electron ${info.electron}` : 'Electron（当前不是 Electron 进程）';
    if ($('settings-data-dir')) $('settings-data-dir').textContent = `数据目录 ${info.dataDir || ''}`;
    if ($('settings-work-dir')) $('settings-work-dir').textContent = `工作目录 ${info.workDir || ''}`;
  }).catch(() => {});
}

boot();

if (typeof window !== 'undefined') {
  window.__settingsTest = {
    selectCategory, showPreview, clearPreview, applyState, focusClose,
    previewToken, showNotice, hideNotice, submitZip, switchToPack, focusDrop, focusSkinCard
  };
}
