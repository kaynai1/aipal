'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (patch) => ipcRenderer.invoke('config:save', patch),
    reset: () => ipcRenderer.invoke('config:reset'),
  },

  check: {
    asr: () => ipcRenderer.invoke('check:asr'),
    tts: () => ipcRenderer.invoke('check:tts'),
    llm: () => ipcRenderer.invoke('check:llm'),
    models: () => ipcRenderer.invoke('llm:models'),
  },

  voices: () => ipcRenderer.invoke('voice:list'),

  turn: {
    start: (payload) => ipcRenderer.invoke('turn:start', payload),
    abort: () => ipcRenderer.invoke('turn:abort'),
  },

  vision: {
    test: () => ipcRenderer.invoke('vision:test'),
  },

  game: () => ipcRenderer.invoke('game:current'),

  memory: {
    snapshot: () => ipcRenderer.invoke('memory:snapshot'),
    forget: () => ipcRenderer.invoke('memory:forget'),
    remember: (note) => ipcRenderer.invoke('memory:remember', note),
  },

  win: {
    setClickThrough: (on) => ipcRenderer.invoke('win:setClickThrough', on),
    size: (h) => ipcRenderer.invoke('win:size', h),
    hide: () => ipcRenderer.invoke('win:hide'),
    show: () => ipcRenderer.invoke('win:show'),
    openSettings: (section) => ipcRenderer.invoke('win:openSettings', section),
    minimize: () => ipcRenderer.invoke('settings:minimize'),
    toggleMax: () => ipcRenderer.invoke('settings:toggleMax'),
    close: () => ipcRenderer.invoke('settings:close'),
  },

  app: {
    openConfigDir: () => ipcRenderer.invoke('app:openConfigDir'),
    copy: (text) => ipcRenderer.invoke('app:copy', text),
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (asset) => ipcRenderer.invoke('update:download', asset),
    apply: (zipPath) => ipcRenderer.invoke('update:apply', zipPath),
  },

  on: {
    updateProgress: (cb) => on('update:progress', cb),
    updateAvailable: (cb) => on('update:available', cb),
    goto: (cb) => on('goto', cb),
    hotkey: (cb) => on('hotkey', cb),
    config: (cb) => on('config', cb),
    game: (cb) => on('game', cb),
    turnEvent: (cb) => on('turn:event', cb),
    turnAudio: (cb) => on('turn:audio', cb),
    warn: (cb) => on('warn', cb),
    toggleWindow: (cb) => on('toggle-window', cb),
  },
});