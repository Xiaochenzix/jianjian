const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['floatingState', 'floatingList', 'floatingSend', 'copy', 'floatingHide', 'showMain']);
contextBridge.exposeInMainWorld('jianjian', {
  invoke(method, value) {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('jianjian', method, value);
  },
  onEvent(callback) { ipcRenderer.removeAllListeners('jianjian:event'); ipcRenderer.on('jianjian:event', (_, value) => callback(value)); }
});
