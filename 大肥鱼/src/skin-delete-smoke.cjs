const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const { SkinLibrary } = require('./skins.cjs');

module.exports = async function runDeleteSmoke({ win, work, settingsFile, skins, getMenu,
  getSkin, setSkin, importSkinFile, deleteImportedSkin }) {
  const originalSkin = getSkin().id;
  const originalDialog = dialog.showMessageBox;
  const checks = {}, errors = [], prompts = [];
  const source = path.join(work, 'skin-fixtures', '删除测试.png');
  // A unique fixture cannot collide with an existing saved skin in smoke-data.
  const url = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 37; canvas.height = 53;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#6880c4'; ctx.fillRect(0, 0, 37, 53);
    return canvas.toDataURL('image/png');
  })()`);
  fs.writeFileSync(source, Buffer.from(url.split(',')[1], 'base64'));
  let response = 0;
  dialog.showMessageBox = async (parent, options) => {
    if (options.type === 'error') { errors.push(options); return { response: 0 }; }
    prompts.push({ parent: parent === win, ...options });
    return { response };
  };
  const deletionMenu = () => getMenu().items.find(item => item.label === '更换皮肤').submenu.items
    .find(item => item.label === '删除导入皮肤');
  const menuDelete = async id => {
    const name = skins.get(id).name.replace(/&/g, '&&');
    await deletionMenu().submenu.items.find(item => item.label.startsWith(name)).click();
  };
  try {
    const imported = await importSkinFile(source);
    checks.importedOnly = deletionMenu().submenu.items.length === skins.list().length
      && deletionMenu().submenu.items.every(item => item.label !== '默认 · 鲸鱼娘' && item.label !== '紫角玫瑰 · 半身');
    checks.currentMarked = deletionMenu().submenu.items.some(item => item.label === `${imported.name}（当前使用）`);
    await menuDelete(imported.id);
    checks.cancelKeepsSkin = getSkin().id === imported.id && fs.existsSync(imported.file) && Boolean(skins.get(imported.id));
    response = 1;
    await menuDelete(imported.id);
    checks.currentRestoresDefault = getSkin().id === 'default'
      && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).skinId === 'default';
    checks.copyRemoved = !fs.existsSync(imported.file) && !skins.get(imported.id)
      && !new SkinLibrary(path.dirname(skins.directory)).get(imported.id);
    checks.sourcePreserved = fs.existsSync(source);
    checks.menuUpdated = !deletionMenu().submenu.items.some(item => item.label === imported.name);
    checks.prompt = prompts.every(item => item.parent && item.defaultId === 0 && item.cancelId === 0)
      && prompts[1].detail.includes('默认角色');
    const restored = await importSkinFile(source);
    checks.reimport = restored.id === imported.id && fs.existsSync(restored.file);
    setSkin('rose');
    await menuDelete(restored.id);
    checks.otherSkinKept = getSkin().id === 'rose'
      && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).skinId === 'rose';
    const count = prompts.length;
    checks.builtInsProtected = !(await deleteImportedSkin('default')) && !(await deleteImportedSkin('rose'))
      && prompts.length === count;
    checks.noSkinsDisabled = skins.list().length > 0 || deletionMenu().enabled === false;
    return { checks, errors, pass: Object.values(checks).every(Boolean) && !errors.length };
  } finally {
    dialog.showMessageBox = originalDialog;
    setSkin(originalSkin);
  }
};
