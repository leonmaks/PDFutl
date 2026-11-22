const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: message => ipcRenderer.send('pdfutl-test', message),
  getState: () => JSON.parse(sessionStorage.getItem('pdfutl-view') ?? 'null'),
  setState: state => sessionStorage.setItem('pdfutl-view', JSON.stringify(state)),
}));
ipcRenderer.on('pdfutl-test-host', (_, data) => window.postMessage(data, '*'));
