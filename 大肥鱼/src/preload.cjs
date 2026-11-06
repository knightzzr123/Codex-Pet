const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('pet:state'),
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  openMenu: () => ipcRenderer.send('pet:menu'),
  openSettings: () => ipcRenderer.send('pet:settings-open'),
  setSizeLevel: level => ipcRenderer.send('pet:size-level', level),
  setSkin: id => ipcRenderer.send('pet:set-skin', id),
  importSkin: () => ipcRenderer.send('pet:import-skin'),
  editDialogues: () => ipcRenderer.send('pet:edit-dialogues'),
  setExperience: (key, value) => ipcRenderer.send('pet:set-experience', key, value),
  setExperiences: partial => ipcRenderer.send('pet:set-experiences', partial),
  skinLoadFailed: id => ipcRenderer.send('pet:skin-load-failed', id),
  startDrag: point => ipcRenderer.send('pet:drag-start', point),
  moveDrag: point => ipcRenderer.send('pet:drag-move', point),
  endDrag: () => ipcRenderer.invoke('pet:drag-end'),
  cancelDrag: () => ipcRenderer.send('pet:drag-cancel'),
  setInputRegion: bubble => ipcRenderer.send('pet:input-region', Boolean(bubble)),
  onResetInput: callback => {
    const listener = () => callback();
    ipcRenderer.on('pet:reset-input', listener);
    return () => ipcRenderer.removeListener('pet:reset-input', listener);
  },
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
  onOpenSettings: callback => {
    const listener = () => callback();
    ipcRenderer.on('pet:open-settings', listener);
    return () => ipcRenderer.removeListener('pet:open-settings', listener);
  }
});
