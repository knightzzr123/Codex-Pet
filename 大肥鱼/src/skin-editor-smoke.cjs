const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { dialog, nativeImage, screen } = require('electron');

module.exports = async function runEditorSmoke({ win, work, settingsFile, chooseSkinImage,
  getEditorWindow, getSkin, setSkin }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const originalSkin = getSkin().id;
  const originalDialog = dialog.showOpenDialog;
  const originalMessage = dialog.showMessageBox;
  const errors = [], checks = {};
  const file = path.join(work, 'skin-fixtures', '缩放裁剪测试.png');
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f093a4'; ctx.fillRect(80, 50, 240, 200);
    ctx.fillStyle = '#637fd0'; ctx.fillRect(150, 90, 100, 80);
    return canvas.toDataURL('image/png');
  })()`);
  const originalBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(file, originalBytes);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  dialog.showMessageBox = async (_window, options) => { errors.push(options.detail); return { response: 0 }; };
  let pending = null, editor = null;
  const start = async () => {
    pending = chooseSkinImage();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      editor = getEditorWindow();
      if (editor && !editor.isDestroyed() && !editor.webContents.isLoading()
        && await editor.webContents.executeJavaScript(`Boolean(document.querySelector('#save') && !document.querySelector('#save').disabled)`)) return editor;
      await wait(30);
    }
    throw new Error('图片编辑器未就绪。');
  };
  const js = code => editor.webContents.executeJavaScript(code);
  const click = async selector => {
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    editor.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    editor.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await wait(60);
  };
  try {
    await start();
    editor.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    const bounds = editor.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    checks.ownedModal = editor.getParentWindow() === win && editor.isModal() && !editor.isAlwaysOnTop();
    checks.onScreen = bounds.x >= area.x && bounds.y >= area.y
      && bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1;
    editor.setSize(500, 560);
    await wait(120);
    checks.compactLayout = await js(`(() => {
      const main = document.querySelector('main'), button = document.querySelector('#save').getBoundingClientRect();
      return main.scrollHeight <= main.clientHeight + 1 && button.bottom <= innerHeight
        && button.right <= innerWidth && canvas.getBoundingClientRect().height >= 80;
    })()`);
    editor.setBounds(bounds);
    await wait(120);
    const rejected = await js(`window.skinEditorAPI.finish({ mode: 'crop', dataUrl: 'data:image/png;base64,broken' })`);
    checks.invalidSaveKeepsEditor = rejected.ok === false && !editor.isDestroyed() && getSkin().id === originalSkin;
    await js(`document.querySelector('#aspect').value = '1'; document.querySelector('#aspect').dispatchEvent(new Event('change'))`);
    await click('#zoom-in');
    checks.zoomButton = await js('zoom === 110');
    await click('#zoom');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await wait(50);
    checks.zoomSlider = await js('zoom > 110 && document.querySelector("#zoom-value").value === `${zoom}%`');
    const center = await js(`(() => { const r = canvas.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const beforeWheel = await js('zoom');
    editor.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(center.x), y: Math.round(center.y), deltaY: 60, deltaX: 0 });
    await wait(70);
    checks.wheelZoom = await js(`zoom !== ${beforeWheel}`);
    editor.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(center.x), y: Math.round(center.y), button: 'left', clickCount: 1 });
    editor.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(center.x + 30), y: Math.round(center.y + 20), movementX: 30, movementY: 20 });
    editor.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(center.x + 30), y: Math.round(center.y + 20), button: 'left', clickCount: 1 });
    await wait(80);
    checks.mousePan = await js('offset.x > 0 && offset.y > 0 && dragging === null');
    await click('#reset');
    checks.reset = await js('zoom === 100 && offset.x === 0 && offset.y === 0');
    editor.webContents.debugger.attach('1.3');
    try {
      const touch = (x, y) => ({ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 });
      await editor.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(center.x, center.y)] });
      await editor.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(center.x + 20, center.y + 15)] });
      await wait(40);
      await editor.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(50);
      checks.touchPan = await js('offset.x > 0 && offset.y > 0 && dragging === null');
    } finally { editor.webContents.debugger.detach(); }
    await click('#zoom-in');
    fs.writeFileSync(path.join(work, 'skin-editor-preview.png'), (await editor.webContents.capturePage()).toPNG());
    await click('#save');
    await pending;
    const cropped = getSkin();
    const bytes = fs.readFileSync(fileURLToPath(cropped.url));
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    const pixels = image.toBitmap();
    checks.savedCrop = cropped.id !== originalSkin && cropped.name.endsWith('· 裁剪')
      && size.width === 768 && size.height === 768 && !bytes.equals(originalBytes);
    checks.transparency = pixels[3] === 0 && pixels.some((alpha, index) => index % 4 === 3 && alpha > 0);
    checks.persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).skinId === cropped.id;
    const croppedId = cropped.id;

    await start();
    await click('#zoom-in');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await pending;
    checks.escapeKeepsSkin = getSkin().id === croppedId && !getEditorWindow();
    await start();
    await click('#cancel');
    await pending;
    checks.cancelKeepsSkin = getSkin().id === croppedId && !getEditorWindow();
    await start();
    editor.close();
    await pending;
    checks.closeKeepsSkin = getSkin().id === croppedId && !getEditorWindow();
    await start();
    await click('#original');
    await pending;
    checks.originalPreserved = fs.readFileSync(fileURLToPath(getSkin().url)).equals(originalBytes);
    return { checks, errors, pass: Object.values(checks).every(Boolean) && !errors.length };
  } finally {
    const open = getEditorWindow();
    if (open && !open.isDestroyed()) open.close();
    if (pending) await pending;
    dialog.showOpenDialog = originalDialog;
    dialog.showMessageBox = originalMessage;
    setSkin(originalSkin);
  }
};
