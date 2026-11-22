const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const { userInfo } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const scheme = 'pdfutl-test';
const [input, output, profile] = process.argv.slice(-3);
const assets = join(__dirname, '..', 'extension', 'dist');
const files = new Set(['pdf-worker.js', 'pdfium.wasm', 'viewer.css', 'viewer.js']);
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(async () => {
  protocol.handle(scheme, request => {
    const asset = new URL(request.url).pathname.slice(1);
    if (files.has(asset)) return net.fetch(pathToFileURL(join(assets, asset)).href);
    if (asset !== 'index.html') return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html lang="en"><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src blob: data:; connect-src 'self';">
      <link rel="stylesheet" href="viewer.css"></head><body>
      <div id="app" data-worker="${scheme}://local/pdf-worker.js" data-wasm="${scheme}://local/pdfium.wasm"></div>
      <script src="viewer.js"></script></body></html>`, { headers: { 'content-type': 'text/html' } });
  });
  let current = input;
  let commentEdits = [];
  ipcMain.on('pdfutl-test', async (event, message) => {
    switch (message.type) {
      case 'ready': {
        const bytes = await readFile(current);
        event.reply('pdfutl-test-host', { type: 'open', name: current, bytes: new Uint8Array(bytes).buffer,
          user: userInfo().username, highlights: [], commentEdits });
        break;
      }
      case 'annotationSaved':
        if (message.commentEdit) commentEdits = [{ ...message.commentEdit, editor: 'Historical reviewer' }];
        break;
      case 'exportedPdf':
        await writeFile(output, Buffer.from(message.bytes));
        current = output;
        commentEdits = [];
        event.reply('pdfutl-test-host', { type: 'saved', name: 'review-copy.pdf' });
        break;
      case 'exportFailed':
        event.reply('pdfutl-test-host', { type: 'error', message: message.message });
        break;
    }
  });
  const window = new BrowserWindow({ width: 1150, height: 920, title: 'PDF Viewer Test', webPreferences: {
    preload: join(__dirname, 'viewer-test-preload.cjs'),
    sandbox: true,
  } });
  await window.loadURL(`${scheme}://local/index.html`);
});

app.on('window-all-closed', () => app.quit());
