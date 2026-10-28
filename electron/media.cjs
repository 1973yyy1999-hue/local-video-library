const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Cache, MB } = require('./cache.cjs');
const unpack = value => value.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
class Media {
  constructor(library, options = {}) {
    this.library = library;
    this.cache = new Cache(options.directory || path.join(library.directory, 'cache'), options.limitMB || 512);
    this.ffmpeg = options.ffmpeg || unpack(require('ffmpeg-static'));
    this.ffprobe = options.ffprobe || unpack(require('ffprobe-static').path);
    this.queue = []; this.pending = new Map(); this.active = 0; this.children = new Set();
    this.stopped = false; this.paused = false; this.concurrency = [1, 2, 4].includes(options.concurrency) ? options.concurrency : 1;
    this.reserved = 0; this.cacheQueue = Promise.resolve(); this.epoch = 0;
  }
  get directory() { return this.cache.directory; }
  run(binary, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this.stopped || this.paused) return reject(Object.assign(new Error('后台任务已暂停'), { cancelled: true }));
      const child = execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 2 * MB }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (error) {
          if (child.cancelled || this.paused || this.stopped) return reject(Object.assign(new Error('播放优先，后台任务已暂停'), { cancelled: true }));
          const summary = String(stderr || error.message).slice(-1500);
          fs.writeFile(path.join(this.library.directory, 'media-last-error.log'), summary).catch(() => {});
          const permanent = !error.killed && /Invalid data found when processing input|moov atom not found/i.test(summary);
          reject(Object.assign(new Error(permanent ? '无法识别视频内容，请检查文件或使用系统播放器' : '暂时无法读取视频，将稍后重试，也可右键立即重试'), { permanent }));
        } else resolve(stdout);
      });
      this.children.add(child);
    });
  }
  enqueue(key, task, priority = false) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      const job = { key, task, resolve, reject };
      priority ? this.queue.unshift(job) : this.queue.push(job);
    });
    this.pending.set(key, promise);
    promise.then(() => this.pending.delete(key), () => this.pending.delete(key));
    this.drain(); return promise;
  }
  drain() {
    if (this.stopped || this.paused || this.library.scanning) return;
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.active--; this.drain(); });
    }
  }
  withCache(action) { this.cacheQueue = this.cacheQueue.catch(() => {}).then(action); return this.cacheQueue; }
  setConcurrency(value) { if (![1, 2, 4].includes(value)) throw new Error('无效的任务数量'); this.concurrency = value; this.drain(); }
  cancelQueued() {
    for (const job of this.queue.splice(0)) job.reject(Object.assign(new Error('页面已切换'), { cancelled: true }));
  }
  setPlaying(playing) {
    this.paused = playing; this.library.playing = playing;
    if (playing) { this.epoch++; this.cancelQueued(); for (const child of this.children) { child.cancelled = true; child.kill(); } }
    else this.drain();
  }
  async idle() { while (this.active) await new Promise(resolve => setTimeout(resolve, 30)); }
  cachedPath(video, kind) { return path.join(this.directory, `${video.fingerprint}-${kind}.${kind === 'thumb' ? 'jpg' : 'mp4'}`); }
  async info(video, full) {
    if (video.mediaFingerprint === video.fingerprint) return;
    const json = JSON.parse(await this.run(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,index,codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json', full]));
    const stream = json.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream) throw Object.assign(new Error('没有可播放的视频流'), { permanent: true });
    const audio = json.streams?.filter(item => item.codec_type === 'audio').map(item => item.codec_name).filter(Boolean) || [];
    this.library.patch(video.id, { duration: Math.max(0, Number(json.format?.duration) || 0), width: stream.width || 0, height: stream.height || 0, videoCodec: stream.codec_name || '', audioCodecs: audio, mediaFingerprint: video.fingerprint });
  }
  async asset(id, kind, retry = false) {
    if (!['thumb', 'preview'].includes(kind)) throw new Error('无效的预览类型');
    const video = this.library.get(id), target = this.cachedPath(video, kind);
    if (await this.cache.hit(target)) return target;
    if (video.online === false) throw new Error('文件离线');
    const failure = video.mediaFailures?.[kind];
    if (!retry && failure?.fingerprint === video.fingerprint && (failure.permanent || failure.manualRetry || failure.attempts >= 5 || failure.retryAt > Date.now())) throw new Error(failure.message);
    if (this.paused) throw Object.assign(new Error('正在播放，后台预览已暂停'), { cancelled: true });
    return this.enqueue(`${video.fingerprint}:${kind}`, async () => {
      const temp = target.replace(/\.(jpg|mp4)$/, '.tmp.$1');
      const epoch = this.epoch; let reserved = false;
      const check = () => { if (this.paused || this.stopped || epoch !== this.epoch) throw Object.assign(new Error('后台任务已暂停'), { cancelled: true }); };
      try {
        check();
        const full = await this.library.verifiedPath(id);
        await this.withCache(async () => { this.reserved += 20 * MB; reserved = true; await this.cache.trim(this.reserved); });
        check();
        await this.info(video, full);
        check();
        // Near the start for thumbnails; hover is the only operation that seeks deeper.
        const seek = kind === 'thumb' ? Math.min(3, video.duration * 0.1) : Math.min(video.duration * 0.2, 90);
        const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-ss', String(seek), '-i', full, '-map', '0:V:0', '-an', '-sn'];
        const args = kind === 'thumb'
          ? [...common, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '5', '-threads', '1', '-fs', String(2 * MB), temp]
          : [...common, '-t', '6', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '1', '-fs', String(16 * MB), temp];
        await this.run(this.ffmpeg, args, kind === 'preview' ? 60000 : 30000);
        check();
        if (!(await fs.stat(temp)).size) throw new Error('没有生成有效的预览');
        await this.withCache(async () => { await fs.rename(temp, target); this.reserved -= 20 * MB; reserved = false; await this.cache.add(target); await this.cache.trim(this.reserved); });
        if (video.mediaFailures?.[kind]) { const failures = { ...video.mediaFailures }; delete failures[kind]; this.library.patch(id, { mediaFailures: failures }); }
        return target;
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        if (!error.cancelled && !this.paused && epoch === this.epoch) {
          const attempts = failure?.fingerprint === video.fingerprint ? (failure.attempts || 0) + 1 : 1;
          const manualRetry = attempts >= 5;
          const retryAt = error.permanent || manualRetry ? 0 : Date.now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4));
          const message = manualRetry ? '已暂停自动重试，请检查文件后手动重试' : error.message;
          this.library.patch(id, { mediaFailures: { ...video.mediaFailures, [kind]: { fingerprint: video.fingerprint, message, permanent: !!error.permanent, manualRetry, retryAt, attempts } } });
        }
        throw error;
      } finally { if (reserved) await this.withCache(() => { this.reserved -= 20 * MB; }); }
    }, kind === 'preview');
  }
  async retry(id) {
    const video = this.library.get(id); this.library.patch(id, { mediaFailures: {} });
    return this.asset(video.id, 'thumb', true);
  }
  async resetFailures() {
    for (const video of this.library.state.videos) if (Object.keys(video.mediaFailures || {}).length) this.library.patch(video.id, { mediaFailures: {} });
    await this.library.flush();
  }
  stop() { this.stopped = true; this.cancelQueued(); for (const child of this.children) child.kill(); }
}
module.exports = { Media };
