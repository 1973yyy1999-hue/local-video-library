const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp']);
const idFor = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

class Library {
  constructor(directory, notify = () => {}) {
    this.directory = directory;
    this.file = path.join(directory, 'library.json');
    this.state = { version: 1, roots: [], videos: [] };
    this.notify = notify;
    this.saveQueue = Promise.resolve();
    this.scanning = false;
    this.cancelled = false;
    this.status = { running: false, count: 0, message: '', errors: [] };
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.roots) || !Array.isArray(data.videos)) throw new Error('索引格式不受支持');
      this.state = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法读取视频索引，原文件已保留：${error.message}`);
    }
  }
  save() {
    const json = JSON.stringify(this.state);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, json, 'utf8');
      await fs.rename(temp, this.file);
    });
    return this.saveQueue;
  }
  snapshot() { return { ...this.state, status: this.status }; }
  progress(message) {
    this.status.message = message;
    this.notify('scan-progress', { ...this.status });
  }
  async addRoot(folder) {
    if (this.scanning) throw new Error('请等待扫描结束后再添加文件夹');
    const full = await fs.realpath(folder);
    if (!(await fs.stat(full)).isDirectory()) throw new Error('请选择文件夹');
    if (this.state.roots.some(root => inside(root.path, full))) return;
    this.state.roots.push({ id: idFor(full), name: path.basename(full) || full, path: full, online: true });
    await this.save();
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
    await this.save();
  }
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.cancelled = false;
    this.status = { running: true, count: 0, message: '正在扫描文件夹…', errors: [] };
    this.progress(this.status.message);
    const old = new Map(this.state.videos.map(video => [video.id, video]));
    const found = new Map();
    const incomplete = [];
    try {
      for (const root of this.state.roots) {
        if (this.cancelled) break;
        root.online = true;
        const stack = [root.path];
        while (stack.length && !this.cancelled) {
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
            if (this.cancelled) break;
            if (entry.isSymbolicLink()) continue;
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !['$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) stack.push(full); continue; }
            if (!entry.isFile() || !EXTENSIONS.has(path.extname(full).toLowerCase())) continue;
            try {
              const stat = await fs.stat(full);
              const id = idFor(full);
              if (found.has(id)) continue;
              const previous = old.get(id);
              const fingerprint = idFor(`${full}|${stat.size}|${stat.mtimeMs}`);
              found.set(id, {
                ...previous, id, fingerprint, path: full, name: path.basename(full, path.extname(full)),
                folder: path.relative(root.path, folder) || root.name, rootId: root.id,
                extension: path.extname(full).slice(1).toLowerCase(), size: stat.size, modified: stat.mtimeMs,
                added: previous?.added || Date.now(), favorite: previous?.favorite || false,
                tags: previous?.tags || [], position: previous?.position || 0, online: true,
                duration: previous?.fingerprint === fingerprint ? previous.duration : undefined,
                width: previous?.fingerprint === fingerprint ? previous.width : undefined,
                height: previous?.fingerprint === fingerprint ? previous.height : undefined
              });
              this.status.count++;
              if (this.status.count % 50 === 0) this.progress(`已找到 ${this.status.count} 个视频`);
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
        for (const field of ['favorite', 'tags', 'position', 'lastPlayed']) video[field] = latest[field];
        if (latest.fingerprint === video.fingerprint) {
          for (const field of ['duration', 'width', 'height']) if (latest[field] !== undefined) video[field] = latest[field];
        }
      }
      this.state.videos = [...found.values()];
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
    const video = this.state.videos.find(item => item.id === id);
    if (!video) throw new Error('找不到这个视频，请重新扫描');
    return video;
  }
  async verifiedPath(id) {
    const video = this.get(id);
    const full = await fs.realpath(video.path);
    if (!this.state.roots.some(root => inside(root.path, full)) || !EXTENSIONS.has(path.extname(full).toLowerCase())) throw new Error('视频不在已添加的文件夹中');
    return full;
  }
  async update(id, changes) {
    const video = this.get(id);
    if (typeof changes.favorite === 'boolean') video.favorite = changes.favorite;
    if (Array.isArray(changes.tags)) video.tags = [...new Set(changes.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim().slice(0, 50)).filter(Boolean))].slice(0, 30);
    if (Number.isFinite(changes.position) && changes.position >= 0) video.position = changes.position;
    if (changes.played === true) video.lastPlayed = Date.now();
    await this.save();
    return video;
  }
}
module.exports = { Library, inside, idFor, EXTENSIONS };
