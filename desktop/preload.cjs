const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['getState', 'saveSession', 'connect', 'prefs', 'copy', 'readClipboard', 'download', 'listDownloads', 'cancelDownload', 'logout', 'showFloating']);
contextBridge.exposeInMainWorld('jianjian', {
  invoke(method, value) {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('jianjian', method, value);
  },
  // 拖动是一次性手势，用 send 保持同步，主进程才能立刻发起系统拖拽
  dragFile(value) { ipcRenderer.send('jianjian:drag-file', value); },
  onEvent(callback) { ipcRenderer.removeAllListeners('jianjian:event'); ipcRenderer.on('jianjian:event', (_, value) => callback(value)); }
});
