const $ = id => document.getElementById(id);
let state = {};
let settingsReturnFocus = null;
let pendingToken = '';
let currentPreview = null;

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
      button.type = 'button';
        button.className = `settings-skin-card${active ? ' is-active' : ''}`;
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
        image.setAttribute?.('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = skin.name;
        button.append(image, label);
      } else button.textContent = skin.name;
      button.addEventListener('click', () => window.settingsAPI?.setSkin?.(skin.id));
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
  const title = $('settings-zip-preview-title');
  if (title) title.textContent = preview?.name ? `导入预览 · ${preview.name}` : '导入预览';
  const summary = $('settings-zip-preview-summary');
  const count = preview?.characters?.length || 0;
  const sizeText = formatBytes(preview?.totalBytes || 0);
  if (summary) summary.textContent = `${preview?.name || '皮肤包'} · ${count} 个角色${preview?.version ? ` · ${preview.version}` : ''} · ${sizeText}`;
  const warning = $('settings-zip-preview-warning');
  const duplicate = preview?.duplicate;
  if (warning) {
    warning.hidden = !duplicate;
    if (duplicate?.kind === 'content') warning.textContent = `已有同名内容「${duplicate.existingName || preview.name}」。确认后使用已有文件，不会复制第二份。`;
    else if (duplicate) warning.textContent = `已有同名皮肤包「${duplicate.existingName}」。导入将作为新包保留，旧包不会被覆盖。`;
    else warning.textContent = '';
  }
  const confirm = $('settings-zip-confirm');
  if (confirm) confirm.textContent = preview?.needsConfirm ? '确认并导入' : '导入';
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
    error: ['导入失败', detail || '请重试。']
  };
  const pair = labels[state] || labels.idle;
  if (title) title.textContent = pair[0];
  if (text) text.textContent = detail || pair[1];
  drop.setAttribute('aria-label', pair[0]);
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

function rejectPack(result) {
  const message = result?.error || '无法导入这个皮肤包。';
  if (result?.code === 'PATH_REJECTED') {
    setDropState('illegal', '只能导入 .zip 或皮肤包文件夹');
    liveAssert(message);
    return;
  }
  setDropState('error', message);
  liveAssert(message);
  setStatus(message);
}

async function previewToken(token) {
  if (!token || !window.settingsAPI?.previewSkinPack) return;
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
    live(`皮肤包「${preview.name || ''}」已就绪，请确认导入`);
    setStatus('');
  } catch (error) {
    setDropState('error', error?.message || '无法预览这个皮肤包。');
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
async function submitZip() {
  if (importingZip || !pendingToken || !window.settingsAPI?.commitSkinPack) return;
  importingZip = true;
  setDropState('busy');
  try {
    const result = await window.settingsAPI.commitSkinPack({
      token: pendingToken,
      acceptSameName: currentPreview?.needsConfirm === true
    });
    if (result?.code === 'PACK_CHANGED') {
      clearPreview();
      setDropState('error', result.error || '皮肤包在预览之后被改过，请重新选择。');
      liveAssert(result.error || '皮肤包在预览之后被改过，请重新选择。');
      return;
    }
    if (result?.code === 'PACK_CONFIRM') {
      showPreview({
        ...(currentPreview || {}),
        needsConfirm: true,
        duplicate: { kind: 'content', existingName: currentPreview?.duplicate?.existingName || currentPreview?.name || '这个皮肤包' }
      });
      setDropState('preview');
      liveAssert(result.error || '已有同名皮肤包。确认后才会继续。');
      return;
    }
    if (!result?.ok) {
      rejectPack(result);
      return;
    }
    const done = result.pack?.name ? `已导入皮肤包「${result.pack.name}」。` : '皮肤包已导入。';
    setStatus(done);
    live(done);
    clearPreview();
    setDropState('success', done);
  } finally {
    importingZip = false;
  }
}

function bindStaticControls() {
  $('settings-close')?.addEventListener('click', () => { beginClose(); });
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
    skin: { id: 'default', name: '默认 · 鲸鱼娘' },
    skins: [
      { id: 'default', name: '默认 · 鲸鱼娘', thumbnailUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="16" fill="#d7e3ff"/><text x="36" y="46" text-anchor="middle" font-size="32">🐟</text></svg>') },
      { id: 'rose', name: '紫角玫瑰 · 半身', thumbnailUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="16" fill="#f3d7e4"/><text x="36" y="46" text-anchor="middle" font-size="32">🌹</text></svg>') }
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
  window.__settingsTest = { selectCategory, showPreview, clearPreview, applyState, focusClose };
}
