'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('colorPicker', {
  onInit: (cb) => ipcRenderer.on('colorpicker:init', (_e, cfg) => cb(cfg)),
  done: (result) => ipcRenderer.send('colorpicker:done', result),
  cancel: () => ipcRenderer.send('colorpicker:cancel'),
});
