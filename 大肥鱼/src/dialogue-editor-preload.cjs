const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dialogueEditorAPI', {
  getSource: () => ipcRenderer.invoke('dialogue-editor:source'),
  save: draft => ipcRenderer.invoke('dialogue-editor:save', draft),
  cancel: () => ipcRenderer.send('dialogue-editor:cancel')
});
