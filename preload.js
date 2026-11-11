'use strict';

/**
 * 宿主页面 preload：以最小 API 面向渲染层暴露 IPC 通道
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tr', {
  getState: () => ipcRenderer.invoke('get-state'),
  getPaths: () => ipcRenderer.invoke('get-paths'),

  setOpacity: (v) => ipcRenderer.send('set-opacity', v),
  setBgTransparent: (on) => ipcRenderer.invoke('set-bg-transparent', on),
  captureSample: (p) => ipcRenderer.invoke('capture-sample', p),
  setAlwaysOnTop: (on) => ipcRenderer.send('set-always-on-top', on),
  setClickThrough: (on) => ipcRenderer.send('set-click-through', on),
  setAutoHide: (on) => ipcRenderer.send('set-auto-hide', on),
  setTyping: (on) => ipcRenderer.send('typing-changed', on),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  resizeBy: (dx, dy) => ipcRenderer.send('resize-by', dx, dy),
  reportUrl: (u) => ipcRenderer.send('report-url', u),
  // v1.5.0：智能后退/前进（跳过 SPA 同页垃圾条目；原生历史耗尽时用跨会话后退链兜底）
  smartBack: () => ipcRenderer.send('smart-back'),
  smartForward: () => ipcRenderer.send('smart-forward'),
  showBackMenu: () => ipcRenderer.send('show-back-menu'),
  getGuestHistory: () => ipcRenderer.invoke('get-guest-history'),
  onNavNotice: (cb) => ipcRenderer.on('nav-notice', (_e, msg) => cb(msg)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  toggleDevtools: () => ipcRenderer.send('toggle-devtools'),
  quit: () => ipcRenderer.send('quit-app'),

  onState: (cb) => ipcRenderer.on('state-changed', (_e, s) => cb(s)),
  onZoom: (cb) => ipcRenderer.on('zoom-request', (_e, dir) => cb(dir)),
  onFocusUrl: (cb) => ipcRenderer.on('focus-url', () => cb()),
  smokeReport: (msg) => ipcRenderer.send('smoke-report', msg)
});
