const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const gzip = promisify(require('node:zlib').gzip), gunzip = promisify(require('node:zlib').gunzip);

// Snapshot only on structural changes. Routine metadata/progress writes append
// small, coalesced patches instead of serializing the complete video library.
class Store {
  constructor(directory, onError = () => {}) {
    this.file = path.join(directory, 'library.json');
    this.journal = path.join(directory, 'changes.jsonl');
    this.dirty = new Map(); this.queue = Promise.resolve(); this.onError = onError; this.journalBytes = 0; this.sequence = 0;
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
    this.sequence = Number.isSafeInteger(data.journalSequence) ? data.journalSequence : 0;
    const snapshotSequence = this.sequence;
    const records = new Map(data.videos.map((video, index) => [video?.id || `invalid-${index}`, video]));
    try {
      const text = await fs.readFile(this.journal, 'utf8'); this.journalBytes = Buffer.byteLength(text);
      const lines = text.split('\n'); let valid = '';
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) continue;
        try {
          const parsed = JSON.parse(lines[index]);
          const updates = Array.isArray(parsed) ? parsed : parsed.updates;
          const sequence = Array.isArray(parsed) ? ++this.sequence : parsed.sequence;
          if (!Array.isArray(updates) || !Number.isSafeInteger(sequence)) throw new Error('无效的增量记录');
          this.sequence = Math.max(this.sequence, sequence);
          for (const update of sequence > snapshotSequence ? updates : []) {
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
        const line = `${JSON.stringify({ sequence: ++this.sequence, updates: batch })}\n`;
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
  async captureHistory(getState, allowEmpty = false) {
    await this.flush();
    return this.enqueue(async () => {
      if (!allowEmpty && !getState().videos.length) return;
      const payload = await gzip(JSON.stringify({ savedAt: Date.now(), state: getState() }), { level: 1 });
      // Two bounded, compressed generations; this is separate from crash recovery.
      if (payload.length > 32 * 1024 * 1024) throw new Error('历史索引备份超过 32 MB，请先精简视频库后重试');
      const file = `${this.file}.history-1.gz`;
      await fs.writeFile(`${file}.tmp`, payload);
      await fs.copyFile(file, `${this.file}.history-2.gz`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rename(`${file}.tmp`, file);
    });
  }
  async readHistory() {
    let payload;
    try { payload = JSON.parse(await gunzip(await fs.readFile(`${this.file}.history-1.gz`), { maxOutputLength: 512 * 1024 * 1024 })); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('尚无历史备份，已有视频库再次扫描前会自动建立'); throw error; }
    if (payload.state?.version !== 1 || !Array.isArray(payload.state.roots) || !Array.isArray(payload.state.videos)) throw new Error('历史备份格式无效');
    return payload;
  }
  async checkpoint(getState) {
      const text = JSON.stringify({ ...getState(), journalSequence: this.sequence });
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, text, 'utf8');
      await fs.writeFile(`${this.file}.bak.tmp`, text, 'utf8');
      await fs.rename(temp, this.file);
      await fs.rename(`${this.file}.bak.tmp`, `${this.file}.bak`);
      // Sequence numbers make recovery safe even if a crash occurs before truncation.
      await fs.writeFile(this.journal, '', 'utf8'); this.journalBytes = 0;
  }
}
module.exports = { Store };
