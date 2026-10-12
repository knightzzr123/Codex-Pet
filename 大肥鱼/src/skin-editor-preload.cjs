const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('skinEditorAPI', {
  getSource: () => ipcRenderer.invoke('skin-editor:source'),
  finish: payload => ipcRenderer.invoke('skin-editor:finish', payload)
});
