const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('settings:state', listener);
    return () => ipcRenderer.removeListener('settings:state', listener);
  },
  close: () => ipcRenderer.send('settings:close'),
  setSizeLevel: level => ipcRenderer.send('pet:size-level', level),
  setSkin: id => ipcRenderer.send('pet:set-skin', id),
  importSkin: () => ipcRenderer.send('pet:import-skin'),
  importSkinPack: () => ipcRenderer.send('pet:import-skin-pack'),
  editDialogues: () => ipcRenderer.send('pet:edit-dialogues'),
  exportPreferences: () => ipcRenderer.send('pet:export-preferences'),
  importPreferences: () => ipcRenderer.send('pet:import-preferences'),
  setExperience: (key, value) => ipcRenderer.send('pet:set-experience', key, value),
  resetSetting: key => ipcRenderer.send('pet:reset-setting', key),
  resetGroup: groupId => ipcRenderer.send('pet:reset-group', groupId),
  resetAll: () => ipcRenderer.send('pet:reset-all'),
  chooseZip: () => ipcRenderer.invoke('settings:choose-zip'),
  registerDrop: file => {
    let filePath = '';
    try { filePath = webUtils.getPathForFile(file); } catch { filePath = ''; }
    return ipcRenderer.invoke('settings:register-drop', filePath);
  },
  previewZip: token => ipcRenderer.invoke('settings:preview-zip', token),
  importZip: payload => ipcRenderer.invoke('settings:import-zip', payload),
  onShowGroup: callback => {
    const listener = (_event, groupId) => callback(groupId);
    ipcRenderer.on('settings:show-group', listener);
    return () => ipcRenderer.removeListener('settings:show-group', listener);
  },
  about: () => ipcRenderer.invoke('settings:about')
});
