const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session, Menu, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { Library } = require('./library.cjs');
const { Media } = require('./media.cjs');
const { Cache, MB } = require('./cache.cjs');
const { parseRange } = require('./range.cjs');
const { randomUUID } = require('node:crypto');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
// Avoid a second unbounded browser disk cache beside the explicitly capped media cache.
app.commandLine.appendSwitch('disable-http-cache');
let window, library, media, settings, scanPromise, quitting = false, quitReady;
let relocation;
const isTest = !app.isPackaged && process.env.LVL_E2E === '1';
if (isTest && process.env.LVL_DATA) app.setPath('userData', process.env.LVL_DATA);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg' };
const send = (name, data) => { if (window && !window.isDestroyed()) window.webContents.send(name, data); };
const report = error => send('storage-error', error.message);
const trusted = wc => window && !window.isDestroyed() && wc === window.webContents && wc.getURL().startsWith('app://library/');
async function fileResponse(file, request, immutable = false) {
  const stat = await fs.stat(file), range = parseRange(request.headers.get('range'), stat.size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(range ? range.end - range.start + 1 : stat.size), 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const stream = createReadStream(file, range || {}), abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  stream.on('close', () => request.signal.removeEventListener('abort', abort));
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}
function handle(name, callback) {
  ipcMain.handle(`library:${name}`, async (event, ...args) => {
    if (!trusted(event.sender) || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝访问');
    return callback(...args);
  });
}
async function saveSettings() {
  const file = path.join(library.directory, 'settings.json');
  await fs.writeFile(`${file}.tmp`, JSON.stringify(settings)); await fs.rename(`${file}.tmp`, file);
}
function scan() {
  if (library.scanning) return;
  scanPromise = library.scan().catch(report).finally(() => { media.withCache(() => media.cache.trim(media.reserved, new Set(library.state.videos.map(video => video.fingerprint)))).catch(report); media.drain(); });
}
async function external(id, custom = false) {
  const file = await library.verifiedPath(id);
  send('player-action', { action: 'pause', id });
  if (custom && settings.playerPath) {
    await new Promise((resolve, reject) => {
      const child = spawn(settings.playerPath, [file], { detached: true, stdio: 'ignore', shell: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  } else { const error = await shell.openPath(file); if (error) throw new Error(error); }
}
async function selectPlayer() {
  const result = await dialog.showOpenDialog(window, { title: '选择已安装的播放器', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: '播放器程序', extensions: ['exe'] }] : [] });
  if (!result.canceled) { settings.playerPath = result.filePaths[0]; await saveSettings(); }
  return settings.playerPath || '';
}
async function start() {
  library = new Library(app.getPath('userData'), send);
  try { await library.load(); }
  catch (error) {
    const result = await dialog.showMessageBox({ type: 'error', title: '索引需要恢复', message: error.message, detail: '可以保留损坏索引并建立空库，之后重新添加视频文件夹。原始视频不会修改。', buttons: ['退出并保留现状', '备份损坏索引并新建'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) { app.exit(); return; }
    for (const file of [library.file, library.store.journal]) await fs.rename(file, `${file}.damaged-${Date.now()}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await library.load();
  }
  settings = { cacheLimitMB: 512, autoScan: false, playerPath: '', concurrency: 1, theme: 'system' };
  try { Object.assign(settings, JSON.parse(await fs.readFile(path.join(library.directory, 'settings.json'), 'utf8'))); } catch {}
  if (![128, 256, 512, 1024, 2048].includes(settings.cacheLimitMB)) settings.cacheLimitMB = 512;
  if (![1, 2, 4].includes(settings.concurrency)) settings.concurrency = 1;
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
  const defaultCache = process.platform === 'win32' && !isTest ? path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'LocalVideoLibrary', 'MediaCache') : path.join(library.directory, 'cache');
  settings.cacheDirectory = typeof settings.cacheDirectory === 'string' ? settings.cacheDirectory : defaultCache;
  media = new Media(library, { directory: settings.cacheDirectory, limitMB: settings.cacheLimitMB, concurrency: settings.concurrency });
  await media.cache.load();
  // Consolidate v0.1 roaming cache under the same quota; never leave two copies.
  const legacy = path.join(library.directory, 'cache');
  if (legacy !== media.directory) {
    const old = new Cache(legacy, settings.cacheLimitMB); await old.load();
    for (const [file, entry] of [...old.entries].sort((a, b) => b[1].touched - a[1].touched)) {
      const target = path.join(media.directory, path.basename(file));
      if (!media.cache.entries.has(target) && media.cache.total + entry.size <= media.cache.limit) {
        try { await fs.rename(file, target); } catch (error) { if (error.code !== 'EXDEV') throw error; await fs.copyFile(file, target); await fs.unlink(file); }
      } else await fs.unlink(file);
    }
    await media.cache.load();
  }
  await media.cache.trim(0, new Set(library.state.videos.map(video => video.fingerprint)));
  const assets = new Map(['index.html', 'app.js', 'styles.css', 'search.js', 'icons.js', 'format.js', 'icon.svg', 'visible-queue.js', 'menus.js'].map(name => [`/${name}`, path.join(__dirname, '../src', name)]));
  assets.set('/', assets.get('/index.html')); assets.set('/fuse.mjs', require.resolve('fuse.js').replace(/\.cjs$/, '.mjs'));
  protocol.handle('app', async request => {
    try { const url = new URL(request.url), file = url.hostname === 'library' && assets.get(url.pathname);
      if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      return await fileResponse(file, request);
    } catch { return new Response('Not found', { status: 404 }); }
  });
  protocol.handle('media', async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const url = new URL(request.url), id = url.pathname.slice(1);
      if (!/^[a-f0-9]{32}$/.test(id)) return new Response(null, { status: 404 });
      const video = library.get(id), isVideo = url.hostname === 'video';
      const file = isVideo ? await library.verifiedPath(id) : ['thumb', 'preview'].includes(url.hostname) ? media.cachedPath(video, url.hostname) : null;
      if (!file) return new Response(null, { status: 404 });
      return await fileResponse(file, request, !isVideo && url.searchParams.get('v') === video.fingerprint);
    } catch { return new Response('文件不可用', { status: 404 }); }
  });
  // Grant only fullscreen to our own top-level document; other device/network permissions stay denied.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(trusted(wc) && permission === 'fullscreen' && details.isMainFrame !== false && (!details.requestingUrl || details.requestingUrl.startsWith('app://library/'))));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => trusted(wc) && permission === 'fullscreen' && details.isMainFrame !== false && origin.startsWith('app://library'));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['app:', 'media:', 'devtools:'].includes(new URL(details.url).protocol) }));
  handle('snapshot', () => library.snapshot());
  handle('add-folder', async () => {
    const result = isTest && process.env.LVL_FIXTURE ? { canceled: false, filePaths: [process.env.LVL_FIXTURE] } : await dialog.showOpenDialog(window, { title: '选择视频文件夹', properties: ['openDirectory', 'multiSelections'] });
    if (result.canceled) return null;
    const results = []; for (const folder of result.filePaths) results.push(await library.addRoot(folder));
    if (results.some(item => item.added)) scan();
    return results;
  });
  handle('relocate-folder', async id => {
    relocation = null;
    const result = await dialog.showOpenDialog(window, { title: '选择这个来源文件夹的新位置（保留相对目录结构）', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const match = await library.inspectRelocation(id, result.filePaths[0]);
    relocation = { id, path: match.full, token: randomUUID() };
    return { token: relocation.token, path: match.full, matched: match.matched, total: match.total };
  });
  handle('confirm-relocation', async token => {
    if (!relocation || token !== relocation.token) throw new Error('确认已失效，请重新选择文件夹');
    const selected = relocation; relocation = null;
    await library.relocateRoot(selected.id, selected.path); send('library-changed');
  });
  handle('remove-folder', id => library.removeRoot(id));
  handle('scan', () => { scan(); return true; });
  handle('cancel', () => { library.cancelled = true; });
  handle('update', (id, changes) => { if (!changes || typeof changes !== 'object') throw new Error('无效的修改'); return library.update(id, changes); });
  handle('flush', () => library.flush());
  handle('playing', playing => { if (typeof playing !== 'boolean') throw new Error('无效状态'); media.setPlaying(playing); });
  handle('cancel-media', () => media.cancelQueued());
  handle('prepare', async (id, kind) => {
    try {
      await media.asset(id, kind); const video = library.get(id);
      return { duration: video.duration, width: video.width, height: video.height, url: `media://${kind}/${id}?v=${video.fingerprint}` };
    } catch (error) {
      const failure = library.get(id).mediaFailures?.[kind];
      return { error: error.message, cancelled: !!error.cancelled, retryAt: failure?.retryAt || 0, permanent: !!failure?.permanent };
    }
  });
  handle('reveal', async id => shell.showItemInFolder(await library.verifiedPath(id)));
  handle('open-external', external);
  handle('context-menu', id => {
    const video = library.get(id);
    return [
      { id: 'external', label: '用系统默认播放器播放', icon: 'external' },
      ...(settings.playerPath ? [{ id: 'custom', label: `用 ${path.basename(settings.playerPath)} 播放`, icon: 'play' }] : []),
      { id: 'select-player', label: '选择其他播放器…', icon: 'more' },
      { type: 'separator' },
      { id: 'favorite', label: video.favorite ? '取消收藏' : '加入收藏', icon: 'heart' },
      { id: 'watched', label: video.watched ? '标记为未看' : '标记为已看完', icon: 'check' },
      { id: 'tags', label: '编辑标签', icon: 'tag' },
      { type: 'separator' },
      { id: 'reveal', label: '打开所在文件夹', icon: 'folder' },
      { id: 'copy', label: '复制文件路径', icon: 'copy' },
      { id: 'retry', label: '重试封面 / 预览', icon: 'refresh', enabled: !library.playing }
    ];
  });
  handle('context-action', async (id, action) => {
    const video = library.get(id);
    switch (action) {
      case 'external': return external(id);
      case 'custom': return external(id, true);
      case 'select-player': if (await selectPlayer()) return external(id, true); return;
      case 'favorite': return library.update(id, { favorite: !video.favorite });
      case 'watched': await library.update(id, { watched: !video.watched }); await library.flush(); return send('player-action', { action: 'watch-status', id });
      case 'tags': return send('player-action', { action, id });
      case 'reveal': return shell.showItemInFolder(await library.verifiedPath(id));
      case 'copy': return clipboard.writeText(video.path);
      case 'retry': if (library.playing) throw new Error('请先关闭播放器'); await media.retry(id); return send('media-retry', id);
      default: throw new Error('无效的菜单操作');
    }
  });
  handle('window-action', action => {
    switch (action) {
      case 'minimize': window.minimize(); break;
      case 'maximize': if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
      case 'close': app.quit(); break;
      default: throw new Error('无效的窗口操作');
    }
  });
  handle('window-state', () => ({ maximized: window.isMaximized(), fullscreen: window.isFullScreen() }));
  handle('history-info', async () => { const backup = await library.store.readHistory(); return { savedAt: backup.savedAt, videos: backup.state.videos.length }; });
  handle('restore-history', () => library.restoreHistory());
  handle('fullscreen', value => { if (typeof value !== 'boolean') throw new Error('无效状态'); window.setFullScreen(value); });
  handle('settings', () => ({ ...settings, version: app.getVersion(), cache: media.cache.stats() }));
  handle('save-settings', async changes => {
    if (!changes || typeof changes !== 'object') throw new Error('无效设置');
    if (typeof changes.autoScan === 'boolean') settings.autoScan = changes.autoScan;
    if ([128, 256, 512, 1024, 2048].includes(changes.cacheLimitMB)) {
      await media.withCache(async () => { const oldLimit = media.cache.limit; media.cache.limit = changes.cacheLimitMB * MB; try { await media.cache.trim(media.reserved); } catch (error) { media.cache.limit = oldLimit; throw error; } }); settings.cacheLimitMB = changes.cacheLimitMB;
    }
    if ([1, 2, 4].includes(changes.concurrency)) { settings.concurrency = changes.concurrency; media.setConcurrency(changes.concurrency); }
    if (['system', 'light', 'dark'].includes(changes.theme)) { settings.theme = changes.theme; nativeTheme.themeSource = changes.theme; }
    await saveSettings(); return { ...settings, cache: media.cache.stats() };
  });
  async function manageCache(action) {
    if (library.playing) throw new Error('请先关闭播放器和悬浮小窗');
    media.setPlaying(true); await media.idle();
    try { await action(); } finally { media.setPlaying(false); }
    return media.cache.stats();
  }
  handle('clear-cache', () => manageCache(async () => { await media.cache.clear(); await media.resetFailures(); }));
  handle('retry-failures', () => manageCache(() => media.resetFailures()));
  handle('move-cache', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择缓存位置（自动建立 ShiyingCache 子文件夹）', properties: ['openDirectory'] });
    if (result.canceled) return media.cache.stats();
    return manageCache(async () => { await media.cache.move(path.join(result.filePaths[0], 'ShiyingCache')); settings.cacheDirectory = media.directory; await saveSettings(); });
  });
  handle('quit-ready', () => { quitReady?.(); });
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = settings.theme;
  if (process.platform === 'win32') app.setAppUserModelId('io.github.localvideolibrary');
  function createWindow() {
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 640, frame: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#171d2a' : '#eef1f7', title: '拾影 · 本地视频库', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    // A destroyed/reloaded renderer can no longer send playing(false).
    const releasePlayback = () => { media.setPlaying(false); media.cancelQueued(); library.flush().catch(report); };
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) releasePlayback(); });
    window.webContents.on('render-process-gone', (_event, details) => {
      releasePlayback();
      if (!quitting && details.reason !== 'clean-exit') dialog.showMessageBox(window, { type: 'error', message: '界面意外退出，视频库已保留', buttons: ['重新打开界面', '退出'] }).then(result => { if (result.response === 0) window.reload(); else app.quit(); });
    });
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      if (['+', '=', '-', '0'].includes(input.key)) { event.preventDefault(); const wc = window.webContents; wc.setZoomLevel(input.key === '0' ? 0 : Math.max(-2, Math.min(4, wc.getZoomLevel() + (input.key === '-' ? -0.5 : 0.5)))); }
    });
    for (const name of ['maximize', 'unmaximize']) window.on(name, () => send('window-state', { maximized: window.isMaximized() }));
    window.on('leave-full-screen', () => send('fullscreen-changed', false));
    window.on('enter-full-screen', () => send('fullscreen-changed', true));
    window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
    window.loadURL('app://library/');
    window.webContents.once('did-finish-load', () => { if (settings.autoScan && library.state.roots.length && !isTest) scan(); });
  }
  createWindow();
}
if (!app.requestSingleInstanceLock()) app.exit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('启动失败', error.message); app.exit(1); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !library) return;
  event.preventDefault(); quitting = true;
  (async () => {
    const acknowledged = new Promise(resolve => { quitReady = resolve; });
    send('prepare-quit');
    await Promise.race([acknowledged, new Promise(resolve => setTimeout(resolve, 1500))]);
    library.cancelled = true; media?.stop();
    await Promise.race([scanPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
    await library.flush();
    app.quit();
  })().catch(error => { quitting = false; dialog.showErrorBox('保存未完成', `程序尚未退出，请检查数据盘空间后重试。${error.message}`); });
});
