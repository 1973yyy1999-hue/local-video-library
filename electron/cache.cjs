const fs = require('node:fs/promises');
const path = require('node:path');
const CACHE_FILE = /^[a-f0-9]{32}-(thumb|preview)(\.tmp)?\.(jpg|mp4)$/;
const MB = 1024 * 1024;
class Cache {
  constructor(directory, limitMB = 512) { this.directory = directory; this.limit = limitMB * MB; this.entries = new Map(); this.total = 0; }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    this.entries.clear(); this.total = 0;
    for (const name of await fs.readdir(this.directory)) {
      if (!CACHE_FILE.test(name)) continue;
      const file = path.join(this.directory, name);
      const stat = await fs.stat(file);
      if (name.includes('.tmp.') || stat.size === 0) { await fs.unlink(file); continue; }
      this.entries.set(file, { size: stat.size, touched: stat.mtimeMs, savedTouch: stat.mtimeMs }); this.total += stat.size;
    }
    await this.trim();
  }
  async hit(file) {
    const entry = this.entries.get(file);
    if (!entry) return false;
    try { const stat = await fs.stat(file); if (!stat.size) throw new Error('empty'); }
    catch { this.total -= entry.size; this.entries.delete(file); return false; }
    entry.touched = Date.now();
    if (entry.touched - (entry.savedTouch || 0) >= 60000) {
      const touched = entry.touched; entry.savedTouch = touched;
      try { await fs.utimes(file, new Date(touched), new Date(touched)); } catch { entry.savedTouch = 0; }
    }
    return true;
  }
  async trim(reserve = 0, fingerprints) {
    const ordered = [...this.entries].sort((a, b) => Number(a[0].endsWith('-thumb.jpg')) - Number(b[0].endsWith('-thumb.jpg')) || a[1].touched - b[1].touched);
    for (const [file, entry] of ordered) {
      const orphan = fingerprints && !fingerprints.has(path.basename(file).slice(0, 32));
      if (!orphan && this.total + reserve <= this.limit) continue;
      try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') continue; }
      this.entries.delete(file); this.total -= entry.size;
    }
    if (this.total + reserve > this.limit) throw new Error('缓存空间不足，请在设置里清理缓存');
  }
  async add(file) {
    const stat = await fs.stat(file);
    if (!stat.size) throw new Error('生成的缓存为空');
    this.total -= this.entries.get(file)?.size || 0;
    this.entries.set(file, { size: stat.size, touched: Date.now() }); this.total += stat.size;
    await this.trim();
  }
  async flushTouches() {
    for (const [file, entry] of this.entries) if (entry.touched > (entry.savedTouch || 0)) {
      try { await fs.utimes(file, new Date(entry.touched), new Date(entry.touched)); entry.savedTouch = entry.touched; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  stats() { return { bytes: this.total, limitMB: this.limit / MB, directory: this.directory, files: this.entries.size }; }
  async clear() { for (const file of [...this.entries.keys()]) { try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw new Error('缓存正在使用，请关闭播放器后重试'); } this.total -= this.entries.get(file).size; this.entries.delete(file); } }
  async move(directory) {
    if (path.resolve(directory) === path.resolve(this.directory)) return;
    await this.flushTouches();
    await fs.mkdir(directory, { recursive: true });
    for (const file of this.entries.keys()) {
      const target = path.join(directory, path.basename(file));
      try { await fs.rename(file, target); }
      catch (error) { if (error.code !== 'EXDEV') throw error; await fs.copyFile(file, target); await fs.unlink(file); }
    }
    this.directory = directory; await this.load();
  }
}
module.exports = { Cache, CACHE_FILE, MB };
