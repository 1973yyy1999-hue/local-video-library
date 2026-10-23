import Fuse from '/fuse.mjs';
import './search.js';

const $ = selector => document.querySelector(selector);
const api = window.libraryAPI;
let state = { roots: [], videos: [], status: {} }, view = 'all', rootId = '', kind = 'all', page = 1;
let current = null, removeId = null, observer, generation = 0, preview = null, previewTimer, queryTimer, toastTimer;
let lastPositionSave = 0, searchCache = null;
const PAGE_SIZE = 60;
const duration = value => !Number.isFinite(value) ? '—:—' : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const size = value => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function failure(error) { toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
async function safe(action) { try { return await action(); } catch (error) { failure(error); } }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function status(status) {
  state.status = status;
  $('#scan-status').hidden = !status.message;
  $('#scan-message').textContent = status.message || '';
  $('#scan-status').title = (status.errors || []).join('\n');
  $('#cancel-scan').hidden = !status.running;
  $('#rescan').disabled = !!status.running;
  $('#add-folder').disabled = !!status.running;
  $('#empty-add').disabled = !!status.running;
  document.querySelectorAll('.root-remove').forEach(button => button.disabled = !!status.running);
}
async function refresh() { state = await api.snapshot(); searchCache = null; status(state.status); renderSidebar(); render(); }
function renderSidebar() {
  $('#all-count').textContent = state.videos.length;
  $('#favorite-count').textContent = state.videos.filter(video => video.favorite).length;
  $('#root-count').textContent = state.roots.length;
  const container = $('#roots'); container.replaceChildren();
  if (!state.roots.length) container.append(element('p', 'root-note', '添加文件夹后，在这里切换视频来源。'));
  for (const root of state.roots) {
    const row = element('div', `root-row ${rootId === root.id ? 'active' : ''}`);
    const button = element('button', 'root-label', `${root.online ? '▱' : '◌'}  ${root.name}`);
    button.title = `${root.path}${root.online ? '' : '（离线）'}`;
    button.onclick = () => { rootId = root.id; view = 'all'; page = 1; renderSidebar(); render(); };
    const remove = element('button', 'root-remove', '×'); remove.title = '从视频库移除'; remove.setAttribute('aria-label', `移除文件夹 ${root.name}`);
    remove.disabled = !!state.status.running;
    remove.onclick = () => { removeId = root.id; $('#remove-path').textContent = root.path; $('#remove-dialog').showModal(); };
    row.append(button, remove); container.append(row);
  }
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === view && !rootId));
}
function stopPreview() {
  clearTimeout(previewTimer);
  if (preview) {
    const old = preview; preview = null;
    if (old.video) { old.video.pause(); old.video.removeAttribute('src'); old.video.load(); old.video.remove(); }
    old.label.remove();
  }
}
function startPreview(item, target) {
  stopPreview();
  if (!$('#hover-enabled').checked || $('#player-dialog').open || item.online === false) return;
  const label = element('span', 'badge preview-label', '正在准备预览…');
  const active = { id: item.id, label, video: null }; preview = active;
  previewTimer = setTimeout(async () => {
    target.append(label);
    try {
      const result = await api.prepare(item.id, 'preview');
      if (preview !== active || !target.isConnected) return;
      const video = element('video'); video.muted = true; video.loop = true; video.playsInline = true;
      video.src = result.url; active.video = video; target.append(video);
      await video.play();
      if (preview === active) label.textContent = '● 静音预览';
    } catch { if (preview === active) label.textContent = '预览不可用 · 点击尝试播放'; }
  }, 500);
}
function card(item) {
  const card = element('article', 'card'); card.dataset.id = item.id;
  const thumb = element('button', 'thumbnail'); thumb.setAttribute('aria-label', `播放 ${item.name}`);
  thumb.append(element('span', 'badge format', item.extension.toUpperCase()));
  const length = element('span', 'badge duration', item.online === false ? '文件离线' : duration(item.duration)); thumb.append(length);
  thumb.onclick = () => openPlayer(item);
  thumb.onmouseenter = () => startPreview(item, thumb); thumb.onmouseleave = stopPreview;
  thumb.onfocus = () => startPreview(item, thumb); thumb.onblur = stopPreview;
  const text = element('div', 'card-text');
  const title = element('button', 'card-title', item.name); title.title = item.name; title.onclick = () => openPlayer(item);
  const favorite = element('button', `favorite-button ${item.favorite ? 'is-favorite' : ''}`, item.favorite ? '♥' : '♡');
  favorite.title = item.favorite ? '取消收藏' : '收藏'; favorite.setAttribute('aria-label', `${favorite.title} ${item.name}`);
  favorite.onclick = () => safe(async () => { await api.update(item.id, { favorite: !item.favorite }); await refresh(); });
  text.append(title, favorite);
  card.append(thumb, text, element('div', 'card-meta', `${item.folder} · ${size(item.size)}`));
  if (item.tags?.length) card.append(element('div', 'tag-list', item.tags.map(tag => `#${tag}`).join('  ')));
  return card;
}
function render() {
  stopPreview(); observer?.disconnect(); const batch = ++generation;
  const query = $('#search').value.trim();
  if (!searchCache || searchCache.query !== query) searchCache = { query, items: window.searchVideos(state.videos, query, Fuse) };
  let items = searchCache.items.filter(video => (!rootId || video.rootId === rootId) && (view !== 'favorite' || video.favorite) && (view !== 'recent' || video.lastPlayed) && (kind === 'all' || (kind === 'other' ? !['mp4', 'mkv'].includes(video.extension) : video.extension === kind)));
  const sort = $('#sort').value;
  if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  else if (sort === 'modified') items.sort((a, b) => b.modified - a.modified);
  else if (sort === 'size') items.sort((a, b) => b.size - a.size);
  else if (view === 'recent') items.sort((a, b) => b.lastPlayed - a.lastPlayed);
  else if (!query) items.sort((a, b) => b.added - a.added);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE)); page = Math.min(page, pages);
  $('#heading').textContent = query ? '搜索结果' : rootId ? state.roots.find(root => root.id === rootId)?.name || '文件夹' : { all: '全部视频', favorite: '我的收藏', recent: '最近播放' }[view];
  $('#summary').textContent = state.roots.length ? `${items.length.toLocaleString()} 个视频 · ${state.roots.length} 个来源文件夹${query ? ' · 支持模糊匹配，多词用空格分隔' : ' · 你的收藏，只在本机'}` : '把硬盘里的视频，变成自己的影库。';
  $('#empty').hidden = state.roots.length > 0;
  $('#no-results').hidden = !state.roots.length || items.length > 0 || state.status.running;
  const grid = $('#grid'); grid.replaceChildren(...items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(card));
  $('#pagination').hidden = !items.length;
  $('#result-count').textContent = `显示 ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, items.length)} / ${items.length}`;
  $('#page-label').textContent = `${page} / ${pages}`; $('#prev-page').disabled = page <= 1; $('#next-page').disabled = page >= pages;
  // Feed only a small, visible batch to the main-process media queue.
  const queue = []; let active = 0;
  function pump() {
    while (active < 2 && queue.length && generation === batch) {
      const node = queue.shift(); active++;
      api.prepare(node.dataset.id, 'thumb').then(result => {
        if (generation !== batch || !node.isConnected) return;
        const img = element('img'); img.alt = ''; img.src = result.url;
        node.querySelector('.thumbnail').prepend(img);
        node.querySelector('.duration').textContent = duration(result.duration);
        const item = state.videos.find(video => video.id === node.dataset.id); if (item) Object.assign(item, { duration: result.duration, width: result.width, height: result.height });
      }).catch(() => { if (node.isConnected) node.querySelector('.duration').textContent = '封面不可用'; }).finally(() => { active--; pump(); });
    }
  }
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); queue.push(entry.target); }
    pump();
  }, { rootMargin: '100px' });
  grid.querySelectorAll('.card').forEach(node => observer.observe(node));
}
function syncFavorite() { $('#player-favorite').textContent = current?.favorite ? '♥ 已收藏' : '♡ 收藏'; }
function savePosition() {
  if (!current) return;
  const player = $('#player');
  if (player.readyState === 0) return;
  const position = player.ended ? 0 : Number.isFinite(player.currentTime) ? player.currentTime : 0;
  current.position = position;
  api.update(current.id, { position }).catch(failure);
}
function openPlayer(item) {
  stopPreview(); current = item; lastPositionSave = Date.now();
  $('#player-title').textContent = item.name; $('#player-folder').textContent = item.path;
  $('#player-info').textContent = `${item.extension.toUpperCase()} · ${size(item.size)}${item.width ? ` · ${item.width} × ${item.height}` : ''}`;
  $('#tags-input').value = item.tags?.join(', ') || ''; syncFavorite();
  $('#playback-error').hidden = true;
  $('#player-dialog').showModal();
  const player = $('#player'); player.src = `media://video/${item.id}`;
  player.onloadedmetadata = () => {
    if (item.position > 0 && item.position < player.duration - 3) player.currentTime = item.position;
    player.play().catch(() => {});
  };
  api.update(item.id, { played: true }).catch(failure);
}
function closePlayer() { $('#player-dialog').close(); }
$('#player-dialog').addEventListener('close', () => { savePosition(); $('#player').pause(); $('#player').removeAttribute('src'); $('#player').load(); current = null; safe(refresh); });
$('#player').addEventListener('error', () => { if (current && $('#player').getAttribute('src')) $('#playback-error').hidden = false; });
$('#player').addEventListener('timeupdate', () => { if (Date.now() - lastPositionSave > 5000) { lastPositionSave = Date.now(); savePosition(); } });
$('#player').addEventListener('ended', savePosition);
$('#player').addEventListener('pause', () => { if (current) savePosition(); });
window.addEventListener('beforeunload', savePosition);
$('#close-player').onclick = closePlayer;
$('#player-favorite').onclick = () => safe(async () => { current = await api.update(current.id, { favorite: !current.favorite }); syncFavorite(); });
$('#reveal').onclick = () => safe(() => api.reveal(current.id));
$('#external-open').onclick = $('#fallback-open').onclick = () => safe(() => api.openExternal(current.id));
$('#tags-form').onsubmit = event => { event.preventDefault(); safe(async () => { current = await api.update(current.id, { tags: $('#tags-input').value.split(/[,，]/) }); toast('标签已保存'); }); };
$('#add-folder').onclick = $('#empty-add').onclick = () => safe(async () => { if (await api.addFolder()) await refresh(); });
$('#rescan').onclick = () => safe(() => api.scan());
$('#cancel-scan').onclick = () => safe(() => api.cancelScan());
$('#cancel-remove').onclick = () => $('#remove-dialog').close();
$('#confirm-remove').onclick = () => safe(async () => { await api.removeFolder(removeId); if (rootId === removeId) rootId = ''; $('#remove-dialog').close(); await refresh(); });
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; rootId = ''; page = 1; renderSidebar(); render(); });
document.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => { kind = button.dataset.kind; page = 1; document.querySelectorAll('[data-kind]').forEach(node => node.classList.toggle('active', node === button)); render(); });
$('#search').addEventListener('input', () => { clearTimeout(queryTimer); queryTimer = setTimeout(() => { page = 1; render(); }, 160); });
$('#sort').onchange = () => { page = 1; render(); };
$('#hover-enabled').checked = localStorage.getItem('hoverPreview') !== 'false';
$('#hover-enabled').onchange = () => { stopPreview(); localStorage.setItem('hoverPreview', String($('#hover-enabled').checked)); };
$('#clear-filters').onclick = () => { $('#search').value = ''; rootId = ''; view = 'all'; kind = 'all'; page = 1; document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('active', button.dataset.kind === 'all')); renderSidebar(); render(); };
$('#prev-page').onclick = () => { page--; render(); window.scrollTo(0, 0); };
$('#next-page').onclick = () => { page++; render(); window.scrollTo(0, 0); };
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && ['k', 'f'].includes(event.key.toLowerCase()) && !$('#player-dialog').open) { event.preventDefault(); $('#search').focus(); $('#search').select(); } });
api.on('scan-progress', status);
api.on('library-changed', () => safe(refresh));
safe(refresh);
