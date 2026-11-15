const $ = id => document.getElementById(id);
let state = {};
let settingsReturnFocus = null;
let pendingZip = '';
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
  const version = $('settings-version');
  if (version && state.version) version.textContent = `内部版本 ${state.version}`;
  const display = $('settings-display-version');
  if (display && state.displayVersion) display.textContent = state.displayVersion;
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
  if (summary) summary.textContent = `${preview?.name || '皮肤包'} · ${count} 个角色${preview?.version ? ` · ${preview.version}` : ''}`;
  const warning = $('settings-zip-preview-warning');
  if (warning) {
    warning.hidden = !preview?.needsConfirm;
    warning.textContent = preview?.needsConfirm
      ? '已存在相同的皮肤包。取消则不会做任何更改；确认后才会继续导入。'
      : '';
  }
  const confirm = $('settings-zip-confirm');
  if (confirm) confirm.textContent = preview?.needsConfirm ? '确认并导入' : '导入';
  const list = $('settings-zip-preview-characters');
  if (list && typeof list.replaceChildren === 'function' && typeof document.createElement === 'function') {
    list.replaceChildren(...(preview?.characters || []).map(character => {
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
  pendingZip = '';
  currentPreview = null;
  const box = $('settings-zip-preview');
  if (box) box.hidden = true;
}

function setStatus(message) {
  const status = $('settings-zip-status');
  if (status) status.textContent = message || '';
}

async function previewZip(filePath) {
  if (!filePath || !window.settingsAPI?.previewZip) return;
  pendingZip = filePath;
  setStatus('正在读取皮肤包…');
  try {
    const preview = await window.settingsAPI.previewZip(filePath);
    if (!preview || preview.error) {
      clearPreview();
      setStatus(preview?.error || '无法预览这个 ZIP。');
      return;
    }
    showPreview(preview);
    setStatus('');
  } catch (error) {
    clearPreview();
    setStatus(error?.message || '无法预览这个 ZIP。');
  }
}

async function chooseZip() {
  const chosen = await window.settingsAPI?.chooseZip?.();
  if (chosen?.filePath) await previewZip(chosen.filePath);
}

async function submitZip() {
  if (!pendingZip || !window.settingsAPI?.importZip) return;
  const result = await window.settingsAPI.importZip({ filePath: pendingZip, confirmSame: currentPreview?.needsConfirm === true });
  if (result?.code === 'PACK_CONFIRM') {
    showPreview({ ...(currentPreview || {}), needsConfirm: true, name: result.name || currentPreview?.name });
    return;
  }
  if (!result?.ok) {
    setStatus(result?.error || '皮肤包导入失败。');
    return;
  }
  setStatus(result.pack?.name ? `已导入“${result.pack.name}”。` : '皮肤包已导入。');
  clearPreview();
}

function bindStaticControls() {
  $('settings-close')?.addEventListener('click', () => window.settingsAPI?.close?.());
  $('settings-panel')?.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const panel = $('settings-panel');
    const focusable = nodes(panel, 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
      .filter(node => !node.hidden);
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
  $('settings-import-pack')?.addEventListener('click', () => window.settingsAPI?.importSkinPack?.());
  $('settings-import-zip')?.addEventListener('click', () => { chooseZip(); });
  $('settings-edit-dialogues')?.addEventListener('click', () => window.settingsAPI?.editDialogues?.());
  $('settings-export-preferences')?.addEventListener('click', () => window.settingsAPI?.exportPreferences?.());
  $('settings-import-preferences')?.addEventListener('click', () => window.settingsAPI?.importPreferences?.());
  const drop = $('settings-zip-drop');
  drop?.addEventListener('dragover', event => { event.preventDefault(); drop.classList?.add('is-drag'); });
  drop?.addEventListener('dragleave', () => drop.classList?.remove('is-drag'));
  drop?.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList?.remove('is-drag');
    const file = event.dataTransfer?.files?.[0];
    const filePath = file ? (window.settingsAPI?.pathForFile?.(file) || file.path || '') : '';
    if (filePath) previewZip(filePath);
  });
  drop?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    chooseZip();
  });
  $('settings-zip-confirm')?.addEventListener('click', () => { submitZip(); });
  $('settings-zip-cancel')?.addEventListener('click', () => { clearPreview(); setStatus('已取消，没有更改皮肤。'); });
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
    button.addEventListener('click', () => window.settingsAPI?.resetGroup?.(button.getAttribute('data-reset-group')));
  }
  $('settings-reset-all')?.addEventListener('click', () => window.settingsAPI?.resetAll?.());
  window.addEventListener?.('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    window.settingsAPI?.close?.();
  });
}

function mockState() {
  return {
    version: '3.4.0', displayVersion: 'Codex-Pet-V1.4', sizeLevel: 4,
    skin: { id: 'default', name: '默认 · 鲸鱼娘' },
    skins: [
      { id: 'default', name: '默认 · 鲸鱼娘' },
      { id: 'rose', name: '紫角玫瑰 · 半身' }
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
  focusClose();
}

boot();

if (typeof window !== 'undefined') {
  window.__settingsTest = { selectCategory, showPreview, clearPreview, applyState, focusClose };
}
