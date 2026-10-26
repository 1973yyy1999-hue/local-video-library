const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store.cjs');

const EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp']);
const idFor = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

class Library {
  constructor(directory, notify = () => {}) {
    this.directory = directory;
    this.file = path.join(directory, 'library.json');
    this.state = { version: 1, roots: [], videos: [] };
    this.notify = notify;
    this.store = new Store(directory, error => this.notify('storage-error', error.message));
    this.store.getState = () => this.state;
    this.byId = new Map();
    this.byPath = new Map();
    this.playing = false;
    this.scanning = false;
    this.cancelled = false;
    this.status = { running: false, count: 0, message: '', errors: [] };
  }
  async load() {
    const { data, recovery } = await this.store.read();
    this.state = data;
    this.recovery = recovery;
    this.state.roots = data.roots.filter(root => typeof root?.id === 'string' && typeof root.path === 'string' && typeof root.name === 'string');
    const invalid = [];
    this.state.videos = data.videos.filter(video => {
      const valid = video && /^[a-f0-9]{32}$/.test(video.id) && typeof video.path === 'string' && typeof video.name === 'string' && typeof video.extension === 'string' && typeof video.fingerprint === 'string' && Number.isFinite(video.size);
      if (!valid) invalid.push(video);
      else { video.tags = Array.isArray(video.tags) ? video.tags.filter(tag => typeof tag === 'string') : []; video.folder = typeof video.folder === 'string' ? video.folder : ''; }
      return valid;
    });
    if (invalid.length) {
      await fs.writeFile(path.join(this.directory, `invalid-records-${Date.now()}.json`), JSON.stringify(invalid));
      this.recovery += ` 已隔离 ${invalid.length} 条无效记录。`;
    }
    this.reindex();
  }
  reindex() { this.byId = new Map(this.state.videos.map(video => [video.id, video])); this.byPath = new Map(this.state.videos.map(video => [video.path, video])); }
  save() { return this.store.snapshot(() => this.state); }
  flush() { return this.store.flush(); }
  patch(id, changes, notify = true) {
    const video = this.get(id); Object.assign(video, changes); this.store.patch(id, { ...video });
    if (notify) this.notify('video-changed', { id, changes });
    return video;
  }
  snapshot() { return { ...this.state, status: this.status, recovery: this.recovery }; }
  progress(message) {
    this.status.message = message;
    this.notify('scan-progress', { ...this.status });
  }
  async addRoot(folder) {
    if (this.scanning) throw new Error('请等待扫描结束后再添加文件夹');
    const full = await fs.realpath(folder);
    if (!(await fs.stat(full)).isDirectory()) throw new Error('请选择文件夹');
    if (this.state.roots.some(root => inside(root.path, full))) return { added: false, message: '这个文件夹已经包含在现有视频库中' };
    this.state.roots = this.state.roots.filter(root => !inside(full, root.path));
    this.state.roots.push({ id: idFor(full), name: path.basename(full) || full, path: full, online: true });
    this.assignRoots();
    await this.save();
    return { added: true, message: '已添加文件夹，开始扫描' };
  }
  assignRoots() {
    for (const video of this.state.videos) {
      const root = this.state.roots.find(root => inside(root.path, video.path));
      if (root) { video.rootId = root.id; video.folder = path.relative(root.path, path.dirname(video.path)) || root.name; }
    }
  }
  async inspectRelocation(id, folder) {
    if (this.scanning) throw new Error('请先停止扫描');
    const root = this.state.roots.find(item => item.id === id);
    if (!root) throw new Error('找不到文件夹');
    const full = await fs.realpath(folder);
    if (!(await fs.stat(full)).isDirectory()) throw new Error('请选择文件夹');
    if (this.state.roots.some(item => item.id !== id && (inside(item.path, full) || inside(full, item.path)))) throw new Error('新位置与其他来源重叠');
    const updates = [];
    for (const video of this.state.videos.filter(item => item.rootId === id)) {
      const next = path.join(full, path.relative(root.path, video.path));
      let online = false;
      try { const stat = await fs.stat(next); if (!stat.isFile() || stat.size !== video.size) throw new Error('文件大小不一致'); online = true; } catch (error) { if (error.code !== 'ENOENT') throw new Error('新文件夹内容不匹配，请选择原文件夹的新位置'); }
      updates.push({ video, next, online });
    }
    const matched = updates.filter(item => item.online).length;
    if (updates.length && !matched) throw new Error('没有匹配到任何视频，未修改原路径。请选择原来源文件夹的新位置');
    return { root, full, updates, matched, total: updates.length };
  }
  async relocateRoot(id, folder) {
    const { root, full, updates } = await this.inspectRelocation(id, folder);
    await this.store.captureHistory(() => this.state);
    for (const { video, next, online } of updates) Object.assign(video, { path: next, online });
    root.path = full; root.name = path.basename(full) || full; root.online = true;
    this.assignRoots(); this.reindex(); await this.save();
  }
  async removeRoot(id) {
    if (this.scanning) throw new Error('请等待扫描结束后再移除文件夹');
    this.state.roots = this.state.roots.filter(root => root.id !== id);
    this.state.videos = this.state.videos.filter(video => this.state.roots.some(root => inside(root.path, video.path)));
    for (const video of this.state.videos) {
      const root = this.state.roots.find(root => inside(root.path, video.path));
      video.rootId = root.id;
      video.folder = path.relative(root.path, path.dirname(video.path)) || root.name;
    }
    this.reindex();
    await this.save();
  }
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.cancelled = false;
    this.status = { running: true, count: 0, message: '正在扫描文件夹…', errors: [] };
    this.progress(this.status.message);
    const old = new Map(this.byId);
    const changedBatch = [];
    const publish = () => { if (changedBatch.length) this.notify('scan-batch', changedBatch.splice(0)); };
    const found = new Map();
    const incomplete = [];
    try {
      await this.store.captureHistory(() => this.state);
      for (const root of this.state.roots) {
        if (this.cancelled) break;
        root.online = true;
        const stack = [root.path];
        while (stack.length && !this.cancelled) {
          while (this.playing && !this.cancelled) await new Promise(resolve => setTimeout(resolve, 250));
          if (this.cancelled) break;
          const folder = stack.pop();
          let entries;
          try { entries = await fs.readdir(folder, { withFileTypes: true }); }
          catch {
            incomplete.push(folder);
            if (folder === root.path) root.online = false;
            if (this.status.errors.length < 20) this.status.errors.push(`无法读取：${folder}`);
            continue;
          }
          for (const entry of entries) {
            while (this.playing && !this.cancelled) await new Promise(resolve => setTimeout(resolve, 250));
            if (this.cancelled) break;
            if (entry.isSymbolicLink()) continue;
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !['$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) stack.push(full); continue; }
            if (!entry.isFile() || !EXTENSIONS.has(path.extname(full).toLowerCase())) continue;
            try {
              const stat = await fs.stat(full);
              const previous = this.byPath.get(full);
              const id = previous?.id || idFor(full);
              if (found.has(id)) continue;
              const fingerprint = previous && previous.size === stat.size && previous.modified === stat.mtimeMs ? previous.fingerprint : idFor(`${full}|${stat.size}|${stat.mtimeMs}`);
              const entry = {
                ...previous, id, fingerprint, path: full, name: path.basename(full, path.extname(full)),
                folder: path.relative(root.path, folder) || root.name, rootId: root.id,
                extension: path.extname(full).slice(1).toLowerCase(), size: stat.size, modified: stat.mtimeMs,
                added: previous?.added || stat.birthtimeMs || stat.mtimeMs, favorite: previous?.favorite || false,
                tags: previous?.tags || [], position: previous?.position || 0, online: true,
                duration: previous?.fingerprint === fingerprint ? previous.duration : undefined,
                width: previous?.fingerprint === fingerprint ? previous.width : undefined,
                height: previous?.fingerprint === fingerprint ? previous.height : undefined
              };
              found.set(id, entry);
              if (previous) Object.assign(previous, entry);
              else { this.state.videos.push(entry); this.byId.set(id, entry); this.byPath.set(full, entry); }
              changedBatch.push(entry);
              this.status.count++;
              if (this.status.count % 100 === 0) { publish(); this.progress(`已找到 ${this.status.count} 个视频`); }
            } catch { incomplete.push(full); }
          }
        }
      }
      // An interrupted scan or disconnected drive must not discard previous entries.
      for (const [id, video] of old) {
        if (!found.has(id) && (this.cancelled || incomplete.some(folder => inside(folder, video.path)))) {
          found.set(id, { ...video, online: this.cancelled ? video.online : false });
        }
      }
      // Preserve edits made while asynchronous traversal was in progress.
      for (const video of found.values()) {
        const latest = old.get(video.id);
        if (!latest) continue;
        for (const field of ['favorite', 'tags', 'position', 'lastPlayed', 'watched']) video[field] = latest[field];
        if (latest.fingerprint === video.fingerprint) {
          for (const field of ['duration', 'width', 'height']) if (latest[field] !== undefined) video[field] = latest[field];
        }
      }
      publish();
      this.state.videos = [...found.values()];
      this.reindex();
      await this.save();
      this.progress(this.cancelled ? '扫描已停止，已有索引已保留' : `扫描完成 · ${found.size} 个视频${incomplete.length ? ' · 部分路径无法读取' : ''}`);
    } finally {
      this.scanning = false;
      this.status.running = false;
      this.notify('scan-progress', { ...this.status });
      this.notify('library-changed', null);
    }
  }
  get(id) {
    if (typeof id !== 'string') throw new Error('无效的视频编号');
    const video = this.byId.get(id);
    if (!video) throw new Error('找不到这个视频，请重新扫描');
    return video;
  }
  async restoreHistory() {
    if (this.scanning || this.playing) throw new Error('请先停止扫描并关闭播放器');
    const previous = await this.store.readHistory();
    await this.store.captureHistory(() => this.state, true);
    const current = this.state;
    this.state = previous.state; this.reindex();
    try { await this.save(); } catch (error) { this.state = current; this.reindex(); throw error; }
    this.notify('library-changed');
  }
  async verifiedPath(id) {
    const video = this.get(id);
    const full = await fs.realpath(video.path);
    if (!this.state.roots.some(root => inside(root.path, full)) || !EXTENSIONS.has(path.extname(full).toLowerCase())) throw new Error('视频不在已添加的文件夹中');
    return full;
  }
  async update(id, changes) {
    const patch = {};
    if (typeof changes.favorite === 'boolean') patch.favorite = changes.favorite;
    if (Array.isArray(changes.tags)) patch.tags = [...new Set(changes.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim().slice(0, 50)).filter(Boolean))].slice(0, 30);
    if (Number.isFinite(changes.position) && changes.position >= 0) patch.position = changes.position;
    if (typeof changes.watched === 'boolean') patch.watched = changes.watched;
    if (changes.played === true) patch.lastPlayed = Date.now();
    const video = this.patch(id, patch);
    // User edits are durable before acknowledging; periodic position writes coalesce.
    if ('favorite' in patch || 'tags' in patch) await this.flush();
    return video;
  }
}
module.exports = { Library, inside, idFor, EXTENSIONS };
