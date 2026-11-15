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
  previewZip: filePath => ipcRenderer.invoke('settings:preview-zip', filePath),
  importZip: payload => ipcRenderer.invoke('settings:import-zip', payload),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  about: () => ipcRenderer.invoke('settings:about')
});
