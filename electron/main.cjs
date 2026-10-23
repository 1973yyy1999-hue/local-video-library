const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { Library } = require('./library.cjs');
const { Media } = require('./media.cjs');
const { parseRange } = require('./range.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
let window, library, media;
const isTest = !app.isPackaged && process.env.LVL_E2E === '1';
if (isTest && process.env.LVL_DATA) app.setPath('userData', process.env.LVL_DATA);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg' };
async function fileResponse(file, request) {
  const stat = await fs.stat(file);
  const range = parseRange(request.headers.get('range'), stat.size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(range ? range.end - range.start + 1 : stat.size), 'Cache-Control': 'no-store' };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const stream = createReadStream(file, range || {});
  const abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  stream.on('close', () => request.signal.removeEventListener('abort', abort));
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}
const report = error => {
  if (window && !window.isDestroyed()) window.webContents.send('scan-progress', { running: false, message: error.message, errors: [error.message] });
};
function handle(name, callback) {
  ipcMain.handle(`library:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('app://library/')) throw new Error('拒绝访问');
    return callback(...args);
  });
}
async function start() {
  library = new Library(app.getPath('userData'), (name, value) => {
    if (window && !window.isDestroyed()) window.webContents.send(name, value);
  });
  await library.load();
  media = new Media(library);
  const assets = new Map([
    ['/', path.join(__dirname, '../src/index.html')],
    ['/index.html', path.join(__dirname, '../src/index.html')],
    ['/app.js', path.join(__dirname, '../src/app.js')],
    ['/styles.css', path.join(__dirname, '../src/styles.css')],
    ['/search.js', path.join(__dirname, '../src/search.js')],
    ['/fuse.js', require.resolve('fuse.js').replace(/fuse\.cjs$/, 'fuse.min.js')]
  ]);
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const file = url.hostname === 'library' && assets.get(url.pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    return fileResponse(file, request);
  });
  protocol.handle('media', async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const url = new URL(request.url), id = url.pathname.slice(1);
      if (!/^[a-f0-9]{32}$/.test(id)) return new Response(null, { status: 404 });
      const video = library.get(id);
      const file = url.hostname === 'video' ? await library.verifiedPath(id) : ['thumb', 'preview'].includes(url.hostname) ? media.cachedPath(video, url.hostname) : null;
      if (!file) return new Response(null, { status: 404 });
      return await fileResponse(file, request);
    } catch { return new Response('文件不可用', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !['app:', 'media:', 'devtools:'].includes(new URL(details.url).protocol) });
  });
  handle('snapshot', () => library.snapshot());
  handle('add-folder', async () => {
    const result = isTest && process.env.LVL_FIXTURE
      ? { canceled: false, filePaths: [process.env.LVL_FIXTURE] }
      : await dialog.showOpenDialog(window, { title: '选择视频文件夹', properties: ['openDirectory', 'multiSelections'] });
    if (result.canceled) return false;
    for (const folder of result.filePaths) await library.addRoot(folder);
    library.scan().catch(report);
    return true;
  });
  handle('remove-folder', id => library.removeRoot(id));
  handle('scan', () => { library.scan().catch(report); return true; });
  handle('cancel', () => { library.cancelled = true; });
  handle('update', (id, changes) => {
    if (!changes || typeof changes !== 'object') throw new Error('无效的修改');
    return library.update(id, changes);
  });
  handle('prepare', async (id, kind) => {
    await media.asset(id, kind);
    const video = library.get(id);
    return { duration: video.duration, width: video.width, height: video.height, url: `media://${kind}/${id}?v=${video.fingerprint}` };
  });
  handle('reveal', async id => shell.showItemInFolder(await library.verifiedPath(id)));
  handle('open-external', async id => {
    const error = await shell.openPath(await library.verifiedPath(id));
    if (error) throw new Error(error);
  });
  Menu.setApplicationMenu(null);
  function createWindow() {
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 640, backgroundColor: '#10131a', title: '拾影 · 本地视频库', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadURL('app://library/');
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit(); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || isTest) app.quit(); });
app.on('before-quit', () => media?.stop());
