'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  /* 主进程 -> 渲染层 */
  onBookLoaded: on('book:loaded'),
  onThemeApply: on('theme:apply'),
  onFontApply: on('font:apply'),
  onModeChanged: on('mode:changed'),
  onAlwaysOnTop: on('state:alwaysOnTop'),
  onCmd: (name, cb) => on('cmd:' + name)(cb),

  /* 渲染层 -> 主进程 */
  importBook: () => ipcRenderer.invoke('book:import'),
  pickColor: (cur) => ipcRenderer.invoke('theme:pick', cur),
  setTheme: (cfg) => ipcRenderer.send('theme:set', cfg),
  setFont: (cfg) => ipcRenderer.send('font:set', cfg),

  setSingleLine: (cfg) => ipcRenderer.send('singleline:set', cfg),
  isSingleLine: () => ipcRenderer.invoke('singleline:is'),

  showMenu: (ctx) => ipcRenderer.send('menu:show', ctx),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
    setBounds: (b) => ipcRenderer.send('win:setBounds', b),
    resizeBy: (d) => ipcRenderer.send('win:resizeBy', d),
    getBounds: () => ipcRenderer.invoke('win:getBounds'),
    center: () => ipcRenderer.send('win:center'),
    snap: (w) => ipcRenderer.send('win:snap', w),
    setAlwaysOnTop: (v) => ipcRenderer.send('win:alwaysOnTop', v),
    isAlwaysOnTop: () => ipcRenderer.invoke('win:isAlwaysOnTop'),
  },

  clipboard: {
    write: (text) => ipcRenderer.send('clipboard:write', text),
  },

  quit: () => ipcRenderer.send('app:quit'),
  reload: () => ipcRenderer.send('app:reload'),
});
