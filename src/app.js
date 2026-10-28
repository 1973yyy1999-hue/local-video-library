import Fuse from '/fuse.mjs';
import './search.js';
import './format.js';
import './visible-queue.js';
import { showMenu, hideMenu } from './menus.js';
import { icon, decorate } from './icons.js';
const $ = selector => document.querySelector(selector), api = window.libraryAPI;
const { duration, size } = window.mediaFormat;
let state = { roots: [], videos: [], status: {} }, byId = new Map(), searcher;
let view = 'all', rootId = '', kind = 'all', tagFilter = '', page = 1, current = null, removeId = null;
let observer, generation = 0, preview = null, previewTimer, queryTimer, toastTimer, batchTimer;
let lastPositionSave = 0, nativeFullscreen = false, closing = false;
const PAGE_SIZE = 60;
let preferencesReady = false, volumeTimer;
let preferences = { concurrency: 1, theme: 'system' }, thumbnails, retryTimer, pendingAction, watchedOverride = false;
decorate();
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 5000); }
function failure(error) { toast(String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
async function safe(action) { try { return await action(); } catch (error) { failure(error); } }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function rebuildSearch() { searcher = window.createSearcher(state.videos, Fuse); }
function status(value) {
  state.status = value; thumbnails?.pause(!!value.running || !!current); $('#scan-status').hidden = !value.message; $('#scan-message').textContent = value.message || '';
  $('#cancel-scan').hidden = !value.running; $('#rescan').disabled = !!value.running; $('#add-folder').disabled = !!value.running; $('#empty-add').disabled = !!value.running;
  $('#scan-errors').hidden = !value.errors?.length; $('#scan-errors pre').textContent = (value.errors || []).join('\n');
  document.querySelectorAll('.root-remove,.root-relocate').forEach(button => button.disabled = !!value.running);
}
async function refresh() {
  clearTimeout(batchTimer); batchTimer = null;
  const fresh = await api.snapshot();
  // Preserve object identity for card handlers and an open player.
  for (const item of fresh.videos) if (byId.has(item.id)) Object.assign(byId.get(item.id), item); else byId.set(item.id, item);
  fresh.videos = fresh.videos.map(item => byId.get(item.id)); byId = new Map(fresh.videos.map(item => [item.id, item])); state = fresh;
  rebuildSearch(); status(state.status); renderSidebar(); render();
}
function counts() {
  $('#all-count').textContent = state.videos.length; $('#favorite-count').textContent = state.videos.filter(video => video.favorite).length;
}
function renderSidebar() {
  counts(); $('#root-count').textContent = state.roots.length;
  const container = $('#roots'); container.replaceChildren();

  for (const root of state.roots) {
    const row = element('div', `root-row ${rootId === root.id ? 'active' : ''}`);
    const button = element('button', 'root-label', root.name); button.prepend(icon(root.online ? 'folder' : 'disk'));
    button.setAttribute('aria-label', root.name); button.title = `${root.path}${root.online ? '' : '（离线）'}`;
    button.onclick = () => { rootId = root.id; view = 'all'; page = 1; renderSidebar(); render(); };
    const relocate = element('button', 'root-relocate'); relocate.append(icon('more')); relocate.setAttribute('aria-label', `重新定位 ${root.name}`); relocate.title = '盘符变了？重新定位文件夹';
    relocate.onclick = () => safe(async () => {
      const match = await api.relocateFolder(root.id); if (!match) return;
      confirmAction('确认重新定位文件夹', `匹配 ${match.matched} / ${match.total} 个视频。${match.total - match.matched} 个未匹配的视频会保留为离线。将使用新位置：${match.path}。`, () => api.confirmRelocation(match.token));
    });
    const remove = element('button', 'root-remove'); remove.append(icon('close')); remove.title = '从视频库移除'; remove.setAttribute('aria-label', `移除文件夹 ${root.name}`);
    remove.disabled = relocate.disabled = !!state.status.running;
    remove.onclick = () => { removeId = root.id; $('#remove-path').textContent = root.path; $('#remove-dialog').showModal(); };
    row.append(button, relocate, remove); container.append(row);
  }
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === view && !rootId));
}
function stopPreview() {
  clearTimeout(previewTimer);
  if (!preview) return;
  const old = preview; preview = null;
  if (old.video) { old.video.pause(); old.video.removeAttribute('src'); old.video.load(); old.video.remove(); }
  old.label.remove();
}
function startPreview(item, target) {
  stopPreview();
  if (!$('#hover-enabled').checked || current || item.online === false || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const label = element('span', 'badge preview-label', state.status.running ? '扫描后准备预览…' : '正在准备预览…');
  const active = { id: item.id, label, video: null }; preview = active;
  previewTimer = setTimeout(async () => {
    target.append(label);
    try {
      const result = await api.prepare(item.id, 'preview');
      if (result.error) throw new Error(result.error);
      if (preview !== active || !target.isConnected) return;
      const video = element('video'); video.muted = true; video.loop = true; video.playsInline = true; video.src = result.url;
      active.video = video; target.append(video); await video.play();
      if (preview === active) label.textContent = '静音预览';
    } catch (error) { if (preview === active) { label.textContent = '预览暂不可用 · 右键重试'; label.title = error.message; } }
  }, 650);
}
function patchCard(item, card = document.querySelector(`.card[data-id="${item.id}"]`)) {
  if (!card) return;
  if (card.dataset.fingerprint && card.dataset.fingerprint !== item.fingerprint) card.querySelector('img')?.remove();
  card.dataset.fingerprint = item.fingerprint;
  const title = card.querySelector('.card-title'); title.textContent = title.title = item.name;
  card.querySelector('.card-meta').textContent = `${item.folder} · ${size(item.size)}`;
  card.querySelector('.thumbnail').setAttribute('aria-label', `播放 ${item.name}`);
  const favorite = card.querySelector('.favorite-button'); favorite.classList.toggle('is-favorite', !!item.favorite);
  favorite.title = item.favorite ? '取消收藏' : '收藏'; favorite.setAttribute('aria-label', `${favorite.title} ${item.name}`);
  card.querySelector('.duration').textContent = item.online === false ? '文件离线' : duration(item.duration);
  const progress = card.querySelector('.watch-progress'); progress.hidden = !item.position && !item.watched; progress.value = item.watched ? 100 : Math.min(100, item.duration ? item.position / item.duration * 100 : 0);
  card.querySelector('.watched').hidden = !item.watched;
  const tags = card.querySelector('.tag-list'); tags.replaceChildren();
  for (const tag of item.tags || []) {
    const button = element('button', 'tag', tag); button.onclick = () => { tagFilter = tag; page = 1; render(); }; tags.append(button);
  }
}
function card(item) {
  const node = element('article', 'card'); node.dataset.id = item.id;
  const thumb = element('button', 'thumbnail'); thumb.setAttribute('aria-label', `播放 ${item.name}`);
  const placeholder = element('span', 'placeholder'); placeholder.append(icon('play'));
  const progress = element('progress', 'watch-progress'); progress.max = 100;
  thumb.append(placeholder, element('span', 'thumbnail-status', item.online === false ? '文件离线' : '等待封面'), element('span', 'badge format', item.extension.toUpperCase()), element('span', 'badge duration'), element('span', 'badge watched', '已看完'), progress);
  thumb.onclick = () => safe(() => openPlayer(item)); thumb.onmouseenter = () => startPreview(item, thumb); thumb.onmouseleave = stopPreview;
  // Tab navigation deliberately never starts FFmpeg.
  node.oncontextmenu = event => videoMenu(event, item);
  const text = element('div', 'card-text'), title = element('button', 'card-title', item.name); title.title = item.name; title.onclick = () => safe(() => openPlayer(item));
  const favorite = element('button', 'favorite-button'); favorite.append(icon('heart'));
  favorite.onclick = () => safe(() => api.update(item.id, { favorite: !item.favorite }));
  text.append(title, favorite); node.append(thumb, text, element('div', 'card-meta', `${item.folder} · ${size(item.size)}`), element('div', 'tag-list'));
  patchCard(item, node); return node;
}
function render() {
  stopPreview(); hideMenu(); observer?.disconnect(); thumbnails?.close(); clearTimeout(retryTimer); api.cancelMedia().catch(failure); const batch = ++generation;
  const query = $('#search').value.trim();
  let items = searcher(query).filter(video => (!rootId || video.rootId === rootId) && (view !== 'favorite' || video.favorite) && (view !== 'recent' || video.lastPlayed) && (!tagFilter || video.tags.includes(tagFilter)) && (kind === 'all' || (kind === 'other' ? !['mp4', 'mkv'].includes(video.extension) : video.extension === kind)));
  const sort = $('#sort').value;
  if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  else if (sort === 'modified') items.sort((a, b) => b.modified - a.modified);
  else if (sort === 'size') items.sort((a, b) => b.size - a.size);
  else if (sort === 'duration') items.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  else if (view === 'recent') items.sort((a, b) => b.lastPlayed - a.lastPlayed);
  else if (!query) items.sort((a, b) => b.added - a.added);
  const scopeName = rootId ? state.roots.find(root => root.id === rootId)?.name || '文件夹' : { all: '全部视频', favorite: '我的收藏', recent: '最近播放' }[view];
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE)); page = Math.min(page, pages);
  $('#heading').textContent = query ? '搜索结果' : scopeName;
  $('#scope-label').textContent = `搜索范围：${scopeName}${tagFilter ? ` · 标签 ${tagFilter}` : ''}${kind !== 'all' ? ` · ${kind.toUpperCase()}` : ''}`;
  $('#search-all').hidden = !rootId && view === 'all' && !tagFilter && kind === 'all';
  $('#summary').textContent = state.roots.length ? `${items.length.toLocaleString()} 个视频 · ${state.roots.length} 个来源文件夹${state.status.running ? ' · 扫描中，结束后补充封面' : ''}` : '';
  $('#empty').hidden = state.roots.length > 0; $('#no-results').hidden = !state.roots.length || items.length > 0 || state.status.running;
  $('#empty-title').textContent = query || kind !== 'all' || tagFilter ? '没有找到匹配的视频' : view === 'favorite' ? '还没有收藏的视频' : view === 'recent' ? '还没有播放记录' : '这个文件夹里还没有视频';
  $('#empty-description').textContent = view === 'favorite' && !query ? '点一下视频旁的爱心，把喜欢的内容收在这里。' : view === 'recent' && !query ? '播放过的视频会出现在这里。' : '可以重新扫描文件夹，或调整搜索条件。';
  const grid = $('#grid'), existing = new Map([...grid.children].map(node => [node.dataset.id, node]));
  const visible = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  grid.replaceChildren(...visible.map(item => { const node = existing.get(item.id) || card(item); patchCard(item, node); return node; }));
  $('#pagination').hidden = !items.length; $('#result-count').textContent = `显示 ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, items.length)} / ${items.length}`;
  $('#page-label').textContent = `${page} / ${pages}`; $('#prev-page').disabled = page <= 1; $('#next-page').disabled = page >= pages;
  const inViewport = node => {
    const rect = node.getBoundingClientRect();
    return node.isConnected && rect.bottom > 42 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  const ready = node => {
    const item = byId.get(node.dataset.id), fail = item?.mediaFailures?.thumb;
    return item && item.online !== false && inViewport(node) && !node.querySelector('img') && !(fail?.fingerprint === item.fingerprint && (fail.permanent || fail.manualRetry || fail.attempts >= 5 || fail.retryAt > Date.now()));
  };
  function scheduleRetry() {
    clearTimeout(retryTimer);
    const times = [...grid.children].filter(inViewport).map(node => byId.get(node.dataset.id)?.mediaFailures?.thumb?.retryAt).filter(time => time > Date.now());
    if (times.length) retryTimer = setTimeout(() => { if (generation !== batch) return; for (const node of grid.children) if (ready(node)) thumbnails.add(node); scheduleRetry(); }, Math.min(...times) - Date.now() + 50);
  }
  thumbnails = new window.VisibleQueue({ limit: preferences.concurrency, isVisible: ready, onError: failure, run: async node => {
    const item = byId.get(node.dataset.id); thumbnailState(node, '正在加载封面…');
    try {
      const result = await api.prepare(item.id, 'thumb');
      if (generation !== batch || !node.isConnected) return;
      if (result.error) { thumbnailState(node, result.cancelled ? '等待封面' : result.manualRetry ? '需手动重试' : result.permanent ? '封面不可用 · 右键重试' : '暂时不可用 · 稍后重试', result.error); return; }
      const img = element('img'); img.alt = '';
      img.onload = () => thumbnailState(node, '');
      img.onerror = () => { img.remove(); thumbnailState(node, '封面已失效 · 右键重试', '缓存可能已经被清理，可右键重新生成'); };
      img.src = result.url; node.querySelector('.thumbnail').prepend(img);
      Object.assign(item, { duration: result.duration, width: result.width, height: result.height }); patchCard(item, node);
    } catch (error) { if (generation === batch) thumbnailState(node, '封面不可用 · 右键重试', error.message); }
    finally { if (generation === batch) scheduleRetry(); }
  }});
  thumbnails.pause(!!current || !!state.status.running);
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) thumbnails.add(entry.target);
      else { thumbnails.remove(entry.target); if (preview?.id === entry.target.dataset.id) stopPreview(); }
    }
    scheduleRetry();
  }, { rootMargin: '0px' });
  grid.querySelectorAll('.card').forEach(node => {
    const item = byId.get(node.dataset.id), fail = item.mediaFailures?.thumb;
    if (!node.querySelector('img')) thumbnailState(node, item.online === false ? '文件离线' : fail?.fingerprint === item.fingerprint ? fail.manualRetry || fail.attempts >= 5 ? '需手动重试' : fail.permanent ? '封面不可用 · 右键重试' : '暂时不可用 · 稍后重试' : '等待封面', fail?.message);
    observer.observe(node);
  });
}
function thumbnailState(node, message, detail = '') { const label = node.querySelector('.thumbnail-status'); label.textContent = message; label.title = detail || ''; label.hidden = !message; node.dataset.thumbnailState = message; }
function videoMenu(event, item) { stopPreview(); showMenu(event, () => api.contextMenu(item.id), action => api.contextAction(item.id, action), failure); }
function confirmAction(title, description, action) { pendingAction = action; $('#action-title').textContent = title; $('#action-description').textContent = description; $('#action-dialog').showModal(); }
$('#action-cancel').onclick = () => $('#action-dialog').close();
$('#action-confirm').onclick = () => safe(async () => { $('#action-confirm').disabled = true; try { await pendingAction?.(); $('#action-dialog').close(); } finally { $('#action-confirm').disabled = false; } });
$('#action-dialog').addEventListener('close', () => { pendingAction = null; });
function applyPatch({ id, changes }) {
  const item = byId.get(id); if (!item) return;
  Object.assign(item, changes); patchCard(item); counts();
  if ('tags' in changes) rebuildSearch();
  if (current?.id === id) { current = item; syncFavorite(); codecWarning(item); }
  if (view === 'favorite' && 'favorite' in changes || tagFilter && 'tags' in changes) render();
}
function syncFavorite() { $('#player-favorite').textContent = current?.favorite ? '已收藏' : '收藏'; }
async function savePosition(force = false) {
  const player = $('#player'); if (!current || player.readyState === 0) return;
  const id = current.id, watched = player.ended || (Number.isFinite(player.duration) && player.currentTime / player.duration > .95);
  const position = player.ended ? 0 : Number.isFinite(player.currentTime) ? player.currentTime : 0;
  await api.update(id, { position, ...(watched && !watchedOverride ? { watched: true } : {}) }); if (force) await api.flush();
}
function codecWarning(item) {
  const questionable = (item.audioCodecs || []).filter(codec => !['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'].includes(codec));
  const videoWarning = item.videoCodec && !['h264', 'vp8', 'vp9', 'av1', 'theora'].includes(item.videoCodec);
  const unknown = item.mediaFingerprint !== item.fingerprint;
  $('#codec-warning').hidden = !unknown && !questionable.length && !videoWarning;
  $('#codec-warning').textContent = unknown ? '此文件尚未检测编码。若播放无声或无法播放，请右键使用系统播放器。' : `此文件使用 ${[videoWarning ? item.videoCodec : '', ...questionable].filter(Boolean).join(' / ')} 编码，内置播放器可能无声或无法解码。可右键选择系统默认播放器。`;
}
async function openPlayer(item) {
  stopPreview();
  if (current && current.id !== item.id) await savePosition(true);
  current = item; watchedOverride = false; thumbnails?.pause(true); lastPositionSave = Date.now(); await api.playing(true);
  $('#player-title').textContent = item.name; $('#player-folder').textContent = item.path;
  $('#player-info').textContent = `${item.extension.toUpperCase()} · ${size(item.size)}${item.width ? ` · ${item.width} × ${item.height}` : ''}`;
  $('#tags-input').value = item.tags?.join(', ') || ''; syncFavorite(); codecWarning(item); $('#playback-error').hidden = true;
  if (!$('#player-dialog').open) $('#player-dialog').showModal();
  const player = $('#player');
  player.onloadedmetadata = () => { if (item.position > 0 && item.position < player.duration - 3) player.currentTime = item.position; player.play().catch(() => {}); };
  player.src = `media://video/${item.id}`;
  await api.update(item.id, { played: true });
}
async function exitFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  if (nativeFullscreen) await api.fullscreen(false);
  document.body.classList.remove('native-fullscreen'); nativeFullscreen = false;
}
async function toggleFullscreen() {
  if (document.fullscreenElement || nativeFullscreen) return exitFullscreen();
  try { await $('#player-stage').requestFullscreen(); }
  catch { await api.fullscreen(true); document.body.classList.add('native-fullscreen'); nativeFullscreen = true; }
}
async function closePlayer() {
  if (closing || !current) return; closing = true;
  try {
    await savePosition(true); await exitFullscreen();
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    const player = $('#player'); player.pause(); player.onloadedmetadata = null; player.removeAttribute('src'); player.load();
    current = null; $('#player-dialog').close(); await api.playing(false); thumbnails?.pause(!!state.status.running);
    if (view === 'recent') render();
    // Re-observe unprepared visible cards without replacing existing DOM/images.
    document.querySelectorAll('.card').forEach(node => { if (!node.querySelector('img') && byId.get(node.dataset.id)?.online !== false) thumbnails?.add(node); });
  } finally { closing = false; }
}
$('#player-dialog').addEventListener('cancel', event => { event.preventDefault(); safe(() => document.fullscreenElement || nativeFullscreen ? exitFullscreen() : closePlayer()); });
$('#player').addEventListener('error', () => { if (current && $('#player').getAttribute('src')) $('#playback-error').hidden = false; });
$('#player').addEventListener('timeupdate', () => { if (Date.now() - lastPositionSave > 15000) { lastPositionSave = Date.now(); safe(() => savePosition()); } });
$('#player').addEventListener('ended', () => safe(() => savePosition(true)));
$('#player').addEventListener('pause', () => { if (!closing) safe(() => savePosition(true)); });
$('#player').addEventListener('volumechange', () => { if (!preferencesReady) return; clearTimeout(volumeTimer); volumeTimer = setTimeout(() => safe(saveVolume), 350); });
$('#player-stage').oncontextmenu = event => { if (current) videoMenu(event, current); };
$('#close-player').onclick = () => safe(closePlayer);
$('#fullscreen').onclick = () => safe(toggleFullscreen); $('#exit-fullscreen').onclick = () => safe(exitFullscreen);
$('#pip').onclick = () => safe(async () => { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await $('#player').requestPictureInPicture(); });
$('#player-favorite').onclick = () => safe(() => api.update(current.id, { favorite: !current.favorite }));
$('#reveal').onclick = () => safe(() => api.reveal(current.id));
$('#external-open').onclick = $('#fallback-open').onclick = () => safe(() => api.openExternal(current.id));
$('#tags-form').onsubmit = event => { event.preventDefault(); safe(async () => { await api.update(current.id, { tags: $('#tags-input').value.split(/[,，]/) }); toast('标签已保存'); }); };
$('#add-folder').onclick = $('#empty-add').onclick = () => safe(async () => { const results = await api.addFolder(); if (results) { toast(results.map(item => item.message).join('；')); await refresh(); } });
$('#rescan').onclick = () => safe(() => api.scan()); $('#cancel-scan').onclick = () => safe(() => api.cancelScan());
$('#cancel-remove').onclick = () => $('#remove-dialog').close();
$('#confirm-remove').onclick = () => safe(async () => { await api.removeFolder(removeId); if (rootId === removeId) rootId = ''; $('#remove-dialog').close(); await refresh(); });
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; rootId = ''; page = 1; renderSidebar(); render(); });
document.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => { kind = button.dataset.kind; page = 1; document.querySelectorAll('[data-kind]').forEach(node => node.classList.toggle('active', node === button)); render(); });
$('#search').addEventListener('input', () => { clearTimeout(queryTimer); queryTimer = setTimeout(() => { page = 1; render(); }, 180); });
$('#sort').onchange = () => { safe(() => persistUi({ sort: $('#sort').value })); page = 1; render(); };
$('#hover-enabled').onchange = () => { stopPreview(); safe(() => persistUi({ hoverPreview: $('#hover-enabled').checked })); };
function clearFilters(keepQuery = false) { if (!keepQuery) $('#search').value = ''; rootId = ''; view = 'all'; tagFilter = ''; kind = 'all'; page = 1; document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('active', button.dataset.kind === 'all')); renderSidebar(); render(); }
$('#clear-filters').onclick = () => clearFilters(); $('#search-all').onclick = () => clearFilters(true);
$('#prev-page').onclick = () => { page--; render(); window.scrollTo(0, 0); }; $('#next-page').onclick = () => { page++; render(); window.scrollTo(0, 0); };
function applyPreferences(settings) {
  preferences = { ...preferences, ...settings };
  document.documentElement.dataset.theme = settings.theme;
  applyAppearance();
  applySidebar();
}
function applySidebar() {
  const collapsed = !!preferences.sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle'); button.setAttribute('aria-expanded', String(!collapsed)); button.title = collapsed ? '展开侧栏' : '收起侧栏'; button.setAttribute('aria-label', button.title);
}
async function persistUi(changes) { Object.assign(preferences, changes); await api.saveSettings(changes); }
async function saveVolume() { clearTimeout(volumeTimer); if (preferencesReady) await persistUi({ volume: $('#player').volume, muted: $('#player').muted }); }
$('#sidebar-toggle').onclick = () => { preferences.sidebarCollapsed = !preferences.sidebarCollapsed; applySidebar(); safe(() => persistUi({ sidebarCollapsed: preferences.sidebarCollapsed })); };
function applyAppearance() { document.documentElement.dataset.appearance = preferences.theme === 'dark' || preferences.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
function displaySettings(settings) { applyPreferences(settings); $('#cache-usage').textContent = `已用 ${size(settings.cache.bytes)} / 上限 ${settings.cache.limitMB} MB`; $('#cache-path').textContent = settings.cache.directory; $('#cache-limit').value = settings.cache.limitMB; $('#auto-scan').checked = settings.autoScan; $('#concurrency').value = settings.concurrency; $('#theme').value = settings.theme; }
$('#open-settings').onclick = () => safe(async () => { stopPreview(); displaySettings(await api.settings()); $('#settings-dialog').showModal(); });
$('#close-settings').onclick = () => $('#settings-dialog').close();
$('#save-settings').onclick = () => safe(async () => { displaySettings(await api.saveSettings({ cacheLimitMB: Number($('#cache-limit').value), autoScan: $('#auto-scan').checked, concurrency: Number($('#concurrency').value), theme: $('#theme').value })); toast('设置已保存'); });
$('#clear-cache').onclick = () => safe(async () => { await api.clearCache(); displaySettings(await api.settings()); $('#grid').replaceChildren(); toast('缓存已清理；浏览时会按需重新生成'); });
$('#retry-failures').onclick = () => safe(async () => { await api.retryFailures(); await refresh(); toast('失败记录已重置，将优先重试可见视频'); });
$('#restore-history').onclick = () => safe(async () => { const info = await api.historyInfo(); confirmAction('恢复历史索引？', `将恢复到 ${new Date(info.savedAt).toLocaleString('zh-CN')} 的 ${info.videos} 个视频记录；当前收藏和进度会回到当时的状态。当前索引会先保存为另一代历史，原视频不会修改。`, () => api.restoreHistory()); });
$('#move-cache').onclick = () => safe(async () => { await api.moveCache(); displaySettings(await api.settings()); toast('缓存位置已更新'); });
$('#settings-dialog').addEventListener('close', () => render());
document.addEventListener('fullscreenchange', () => { $('#exit-fullscreen').hidden = !document.fullscreenElement; });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && ['k', 'f'].includes(event.key.toLowerCase()) && !current) { event.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (current && !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) {
    if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); safe(toggleFullscreen); }
    if (event.key === 'Escape' && nativeFullscreen) { event.preventDefault(); safe(exitFullscreen); }
  }
});
api.on('scan-progress', status); api.on('library-changed', () => safe(refresh)); api.on('video-changed', applyPatch); api.on('storage-error', toast);
api.on('scan-batch', batch => {
  for (const item of batch) if (byId.has(item.id)) Object.assign(byId.get(item.id), item); else { byId.set(item.id, item); state.videos.push(item); }
  if (!batchTimer) batchTimer = setTimeout(() => { batchTimer = null; rebuildSearch(); counts(); render(); }, 1500);
});
api.on('fullscreen-changed', enabled => { if (!enabled) { nativeFullscreen = false; document.body.classList.remove('native-fullscreen'); } });
api.on('media-retry', id => { const card = document.querySelector(`.card[data-id="${id}"]`); if (card) { card.querySelector('img')?.remove(); thumbnails?.add(card); } });
api.on('player-action', value => {
  if (value.action === 'watch-status' && current?.id === value.id) watchedOverride = true;
  if (value.action === 'pause' && current?.id === value.id) $('#player').pause();
  if (value.action === 'tags' && byId.has(value.id)) safe(async () => { if (current?.id !== value.id) await openPlayer(byId.get(value.id)); $('#tags-input').focus(); });
});
api.on('prepare-quit', () => { safe(async () => { await savePosition(true); await saveVolume(); await api.quitReady(); }); });
window.addEventListener('unhandledrejection', event => { event.preventDefault(); failure(event.reason); });
safe(async () => {
  let settings = await api.settings();
  if (!settings.uiMigrated) {
    await api.saveSettings({ hoverPreview: localStorage.getItem('hoverPreview') !== 'false', sort: localStorage.getItem('sort') || 'relevance', volume: Math.max(0, Math.min(1, Number(localStorage.getItem('volume') ?? 1))), muted: localStorage.getItem('muted') === 'true', uiMigrated: true });
    settings = await api.settings();
  }
  applyPreferences(settings); $('#hover-enabled').checked = settings.hoverPreview; $('#sort').value = settings.sort;
  $('#player').volume = settings.volume; $('#player').muted = settings.muted; preferencesReady = true;
  await refresh(); $('#version').textContent = `v${settings.version}`; if (state.recovery) toast(state.recovery);
});

function windowState(value) { const button = $('#window-maximize'); button.replaceChildren(icon(value.maximized ? 'restore' : 'maximize')); button.title = value.maximized ? '还原窗口' : '最大化'; button.setAttribute('aria-label', button.title); }
for (const action of ['minimize', 'maximize', 'close']) $(`#window-${action}`).onclick = () => safe(() => api.windowAction(action));
api.on('window-state', windowState); safe(async () => windowState(await api.windowState()));
