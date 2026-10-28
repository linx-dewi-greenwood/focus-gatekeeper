// 中控窗口与主进程之间的桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hubBridge', {
  send: msg => ipcRenderer.invoke('hub:msg', msg),
  layout: info => ipcRenderer.send('hub:layout', info),
  hidePanel: () => ipcRenderer.send('hub:hidePanel'),
  onCard: cb => ipcRenderer.on('hub:card', (_e, card) => cb(card)),
  onState: cb => ipcRenderer.on('hub:state', (_e, state) => cb(state)),
  onRefresh: cb => ipcRenderer.on('hub:refresh', () => cb())
});
