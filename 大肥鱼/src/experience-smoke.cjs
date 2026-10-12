const fs = require('node:fs');
const path = require('node:path');

// Exercises the real renderer, native menu and Chromium touch input in our own window.
module.exports = async function runExperienceSmoke({ win, work, settingsFile, getMenu, getOpenMenu,
  getPreferences, setPlacement, setSkin }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source);
  const original = structuredClone(getPreferences());
  const checks = {};
  const submenu = () => getMenu().items.find(item => item.label === '互动设置').submenu;
  const duration = seconds => submenu().items[0].submenu.items.find(item => item.label.startsWith(seconds === 0 ? '保持显示' : `${seconds} 秒`)).click();
  const toggle = (label, checked) => {
    const item = submenu().items.find(item => item.label === label);
    // MenuItem.click() applies the native checkbox toggle before our callback.
    if (item.checked !== checked) item.click();
  };
  const originalSetShape = win.setShape;
  let nativeRegions;
  win.setShape = function(regions) { nativeRegions = regions; return originalSetShape.call(this, regions); };
  let touchActive = false;
  try {
    duration(15);
    toggle('点人物继续对话', true);
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    checks.settingsSaved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).bubbleSeconds === 15
      && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).advanceOnPetTap === true;
    checks.tapSequence = await js(`(() => {
      stopReading(); closeBubble();
      document.querySelector('#pet').click();
      const firstQuota = !document.querySelector('#quota-view').inert;
      document.querySelector('#pet').click();
      const firstLine = document.querySelector('#dialogue').textContent;
      document.querySelector('#pet').click();
      return firstQuota && document.querySelector('#quota-view').inert
        && !document.querySelector('#dialogue-view').inert
        && firstLine !== document.querySelector('#dialogue').textContent;
    })()`);
    duration(0);
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    checks.keepOpen = await js('bubbleUntil === Infinity && !document.body.classList.contains("no-bubble")');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(300);
    checks.escapeCloses = await js('document.body.classList.contains("no-bubble") && document.querySelector("#bubble").inert');

    toggle('点人物继续对话', false);
    toggle('贴左侧时转向', true);
    setPlacement({ ...original.placement, anchorX: 'left', anchorY: 'bottom', bottom: 2 });
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    await js('document.querySelector("#pet").click()');
    // Inspect the resting layout after the shared compression has completed.
    await js('Promise.all([petAnimation?.finished, bubbleFollowAnimation?.finished])');
    await wait(100);
    const mirrored = await js(`({
      left: document.body.classList.contains('face-left'),
      petTransform: getComputedStyle(document.querySelector('#pet')).transform,
      textTransform: getComputedStyle(document.querySelector('#quota-view')).transform,
      petLeft: document.querySelector('#pet').getBoundingClientRect().left,
      bubbleLeft: document.querySelector('#bubble').getBoundingClientRect().left
    })`);
    checks.leftFacingReadable = mirrored.left && mirrored.petTransform.startsWith('matrix(-1,')
      && mirrored.textTransform === 'none' && Math.abs(mirrored.petLeft - 13) < 1
      && Math.abs(mirrored.bubbleLeft - 18) < 1;
    checks.mirroredInputRegion = nativeRegions?.[0].x === 0;
    fs.writeFileSync(path.join(work, 'left-quota-preview.png'), (await win.webContents.capturePage()).toPNG());

    const skinMenu = () => getMenu().items.find(item => item.label === '更换皮肤').submenu;
    skinMenu().items.find(item => item.label === '紫角玫瑰 · 半身').click();
    checks.builtInSkin = await js(`new Promise(resolve => {
      let attempts = 0;
      const check = () => {
        const image = document.querySelector('#pet-image');
        if (state.skin?.id === 'rose' && image.src === state.skin.url && image.complete && image.naturalWidth > 0) resolve(true);
        else if (++attempts > 100) resolve(false);
        else setTimeout(check, 30);
      }; check();
    })`);
    if (checks.builtInSkin) fs.writeFileSync(path.join(work, 'rose-preview.png'), (await win.webContents.capturePage()).toPNG());
    skinMenu().items[0].click();
    toggle('减少动画', true);
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    checks.reducedMotion = await js(`(() => {
      document.querySelector('#pet').click();
      return document.body.classList.contains('reduced-motion')
        && document.querySelector('#pet-image').getAnimations().length === 0
        && getComputedStyle(document.querySelector('#bubble')).transitionDuration === '0s';
    })()`);
    toggle('减少动画', false);

    await js('stopReading(); closeBubble()');
    await wait(350);
    win.webContents.debugger.attach('1.3');
    const pet = await js('document.querySelector("#pet").getBoundingClientRect().toJSON()');
    const scale = win.webContents.getZoomFactor();
    const point = { x: (pet.left + pet.width / 2) * scale, y: (pet.top + pet.height / 2) * scale, id: 0 };
    const touch = async (type, location = point) => {
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [location]
      });
      touchActive = type !== 'touchEnd' && type !== 'touchCancel';
    };
    const previousMenu = getOpenMenu();
    await touch('touchStart'); await wait(150);
    checks.nativeTouchPress = await js('pointerDrag !== null && document.body.classList.contains("pressing")');
    checks.pressFeedback = await js('reducedMotion() || getComputedStyle(document.querySelector("#pet-image")).transform !== "none"');
    await wait(1450);
    checks.nativeLongPress = getOpenMenu() !== previousMenu;
    getOpenMenu()?.closePopup(win);
    await touch('touchEnd'); await wait(150);
    checks.longPressDoesNotPat = await js('document.body.classList.contains("no-bubble") && !document.body.classList.contains("pressing")');

    const afterLongPress = getOpenMenu();
    await touch('touchStart');
    await touch('touchMove', { ...point, x: point.x + 20, y: point.y - 20 });
    await wait(1600);
    checks.touchDragCancelsLongPress = getOpenMenu() === afterLongPress
      && await js('document.body.classList.contains("dragging") && !document.body.classList.contains("pressing")');
    await touch('touchEnd'); await wait(100);
    checks.touchDragDoesNotPat = await js('document.body.classList.contains("no-bubble") && pointerDrag === null');

    // Undo the test drag via the same native menu used by the user.
    getMenu().items.find(item => item.label === '回到右下角').click();
    await wait(300);
    checks.resetPosition = getPreferences().placement.anchorX === 'right'
      && getPreferences().placement.anchorY === 'bottom'
      && await js('!document.body.classList.contains("face-left")');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    checks.resetSaved = saved.placement.right === 2 && saved.placement.bottom === 2;
    return { checks, pass: Object.values(checks).every(Boolean) };
  } finally {
    if (win.webContents.debugger.isAttached()) {
      if (touchActive) await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      win.webContents.debugger.detach();
    }
    getOpenMenu()?.closePopup(win);
    win.setShape = originalSetShape;
    duration(original.bubbleSeconds);
    toggle('点人物继续对话', original.advanceOnPetTap);
    toggle('贴左侧时转向', original.mirrorOnLeft);
    toggle('减少动画', original.reducedMotion);
    setSkin(original.skinId);
    setPlacement(original.placement);
  }
};
