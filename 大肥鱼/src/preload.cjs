const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('pet:state'),
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  openMenu: () => ipcRenderer.send('pet:menu'),
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
  }
});
