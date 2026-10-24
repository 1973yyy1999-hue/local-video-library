const fs = require('node:fs/promises');
const path = require('node:path');

// Snapshot only on structural changes. Routine metadata/progress writes append
// small, coalesced patches instead of serializing the complete video library.
class Store {
  constructor(directory, onError = () => {}) {
    this.file = path.join(directory, 'library.json');
    this.journal = path.join(directory, 'changes.jsonl');
    this.dirty = new Map(); this.queue = Promise.resolve(); this.onError = onError; this.journalBytes = 0;
  }
  async read() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let data, recovery = '';
    const parse = text => {
      const value = JSON.parse(text);
      if (value.version !== 1 || !Array.isArray(value.roots) || !Array.isArray(value.videos)) throw new Error('索引格式不受支持');
      return value;
    };
    try { data = parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') data = { version: 1, roots: [], videos: [] };
      else {
        try { data = parse(await fs.readFile(`${this.file}.bak`, 'utf8')); }
        catch { throw new Error(`无法读取视频索引，原文件已保留：${error.message}`); }
        const damaged = `${this.file}.damaged-${Date.now()}`;
        await fs.rename(this.file, damaged);
        await fs.copyFile(`${this.file}.bak`, this.file);
        recovery = '索引异常，已从备份恢复；损坏文件已保留。请重新扫描以补全最近新增的视频。';
      }
    }
    const records = new Map(data.videos.map((video, index) => [video?.id || `invalid-${index}`, video]));
    try {
      const text = await fs.readFile(this.journal, 'utf8'); this.journalBytes = Buffer.byteLength(text);
      const lines = text.split('\n'); let valid = '';
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) continue;
        try {
          const updates = JSON.parse(lines[index]);
          if (!Array.isArray(updates)) throw new Error('无效的增量记录');
          for (const update of updates) {
            if (!update.patch || typeof update.patch !== 'object') continue;
            if (records.has(update.id)) Object.assign(records.get(update.id), update.patch);
            else if (update.patch.id === update.id) records.set(update.id, update.patch);
          }
          valid += `${lines[index]}\n`;
        } catch {
          // Keep evidence and every intact batch, including later valid lines.
          recovery = '部分增量记录异常，已保留完整备份并恢复可读取的记录。';
        }
      }
      if (valid !== text) {
        await fs.copyFile(this.journal, `${this.journal}.damaged-${Date.now()}`);
        await fs.writeFile(this.journal, valid);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    data.videos = [...records.values()];
    return { data, recovery };
  }
  enqueue(task) { this.queue = this.queue.catch(() => {}).then(task); return this.queue; }
  patch(id, patch) {
    this.dirty.set(id, { ...this.dirty.get(id), ...patch });
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush().catch(this.onError); }, 1500); this.timer.unref?.(); }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    const batch = [...this.dirty].map(([id, patch]) => ({ id, patch })); this.dirty.clear();
    if (!batch.length) return this.queue;
    return this.enqueue(async () => {
      try {
        const line = `${JSON.stringify(batch)}\n`;
        await fs.appendFile(this.journal, line, 'utf8'); this.journalBytes += Buffer.byteLength(line);
        if (this.journalBytes >= 8 * 1024 * 1024 && this.getState) await this.checkpoint(this.getState);
      }
      catch (error) {
        for (const { id, patch } of batch) this.dirty.set(id, { ...patch, ...this.dirty.get(id) });
        throw error;
      }
    });
  }
  async snapshot(getState) {
    await this.flush();
    return this.enqueue(() => this.checkpoint(getState));
  }
  async checkpoint(getState) {
      const text = JSON.stringify(getState());
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, text, 'utf8');
      try { await fs.copyFile(this.file, `${this.file}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temp, this.file);
      await fs.writeFile(this.journal, '', 'utf8'); this.journalBytes = 0;
      // A first snapshot must also have a recoverable backup.
      try { await fs.access(`${this.file}.bak`); } catch { await fs.copyFile(this.file, `${this.file}.bak`); }
  }
}
module.exports = { Store };
