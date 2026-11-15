const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('settings:state', listener);
    return () => ipcRenderer.removeListener('settings:state', listener);
  },
  close: () => ipcRenderer.send('settings:close'),
  onRequestClose: callback => {
    const listener = () => callback();
    ipcRenderer.on('settings:request-close', listener);
    return () => ipcRenderer.removeListener('settings:request-close', listener);
  },
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
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  cancelPreview: token => ipcRenderer.invoke('settings:cancel-preview', token),
  copyDiagnostics: () => ipcRenderer.invoke('settings:copy-diagnostics'),
  resetPlacement: () => ipcRenderer.send('settings:reset-placement'),
  deleteCurrentSkin: () => ipcRenderer.send('settings:delete-current-skin'),
  registerDrop: file => {
    let filePath = '';
    try { filePath = webUtils.getPathForFile(file); } catch { filePath = ''; }
    return ipcRenderer.invoke('settings:register-drop', filePath);
  },
  previewZip: token => ipcRenderer.invoke('settings:preview-zip', token),
  importZip: payload => ipcRenderer.invoke('settings:import-zip', payload),
  onPreviewToken: callback => {
    const listener = (_event, token) => callback(token);
    ipcRenderer.on('settings:preview-token', listener);
    return () => ipcRenderer.removeListener('settings:preview-token', listener);
  },
  onShowGroup: callback => {
    const listener = (_event, groupId) => callback(groupId);
    ipcRenderer.on('settings:show-group', listener);
    return () => ipcRenderer.removeListener('settings:show-group', listener);
  },
  about: () => ipcRenderer.invoke('settings:about')
});

contextBridge.exposeInMainWorld('dialogueEditorAPI', {
  getSource: () => ipcRenderer.invoke('settings:dialogue-source'),
  save: draft => ipcRenderer.invoke('settings:dialogue-save', draft),
  cancel: () => ipcRenderer.send('settings:dialogue-cancel')
});
