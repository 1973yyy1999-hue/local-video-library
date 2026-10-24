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
    this.stopped = false; this.paused = false;
  }
  get directory() { return this.cache.directory; }
  run(binary, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new Error('应用正在退出'));
      const child = execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 2 * MB }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (error) {
          if (this.paused || this.stopped) return reject(Object.assign(new Error('播放优先，后台任务已暂停'), { cancelled: true }));
          const summary = String(stderr || error.message).slice(-1500);
          fs.writeFile(path.join(this.library.directory, 'media-last-error.log'), summary).catch(() => {});
          reject(new Error('无法生成预览；可右键使用系统播放器，或手动重试封面'));
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
    // Multiple HDDs still share a serial queue: no concurrent random seeking.
    if (this.stopped || this.paused || this.library.scanning || this.active || !this.queue.length) return;
    const job = this.queue.shift(); this.active = 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.active = 0; this.drain(); });
  }
  cancelQueued() {
    for (const job of this.queue.splice(0)) job.reject(Object.assign(new Error('页面已切换'), { cancelled: true }));
  }
  setPlaying(playing) {
    this.paused = playing; this.library.playing = playing;
    if (playing) { this.cancelQueued(); for (const child of this.children) child.kill(); }
    else this.drain();
  }
  async idle() { while (this.active) await new Promise(resolve => setTimeout(resolve, 30)); }
  cachedPath(video, kind) { return path.join(this.directory, `${video.fingerprint}-${kind}.${kind === 'thumb' ? 'jpg' : 'mp4'}`); }
  async info(video, full) {
    if (video.mediaFingerprint === video.fingerprint) return;
    const json = JSON.parse(await this.run(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,index,codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json', full]));
    const stream = json.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream) throw new Error('没有可播放的视频流');
    const audio = json.streams?.filter(item => item.codec_type === 'audio').map(item => item.codec_name).filter(Boolean) || [];
    this.library.patch(video.id, { duration: Math.max(0, Number(json.format?.duration) || 0), width: stream.width || 0, height: stream.height || 0, videoCodec: stream.codec_name || '', audioCodecs: audio, mediaFingerprint: video.fingerprint });
  }
  async asset(id, kind, retry = false) {
    if (!['thumb', 'preview'].includes(kind)) throw new Error('无效的预览类型');
    const video = this.library.get(id), target = this.cachedPath(video, kind);
    if (await this.cache.hit(target)) return target;
    if (video.online === false) throw new Error('文件离线');
    const failure = video.mediaFailures?.[kind];
    if (!retry && failure?.fingerprint === video.fingerprint) throw new Error(failure.message);
    if (this.paused) throw new Error('正在播放，后台预览已暂停');
    return this.enqueue(`${video.fingerprint}:${kind}`, async () => {
      const temp = target.replace(/\.(jpg|mp4)$/, '.tmp.$1');
      try {
        const full = await this.library.verifiedPath(id);
        await this.cache.trim(20 * MB);
        await this.info(video, full);
        // Near the start for thumbnails; hover is the only operation that seeks deeper.
        const seek = kind === 'thumb' ? Math.min(3, video.duration * 0.1) : Math.min(video.duration * 0.2, 90);
        const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-ss', String(seek), '-i', full, '-map', '0:V:0', '-an', '-sn'];
        const args = kind === 'thumb'
          ? [...common, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '5', '-threads', '1', '-fs', String(2 * MB), temp]
          : [...common, '-t', '6', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '1', '-fs', String(16 * MB), temp];
        await this.run(this.ffmpeg, args, kind === 'preview' ? 60000 : 30000);
        if (!(await fs.stat(temp)).size) throw new Error('没有生成有效的预览');
        await fs.rename(temp, target); await this.cache.add(target);
        if (failure) { const failures = { ...video.mediaFailures }; delete failures[kind]; this.library.patch(id, { mediaFailures: failures }, false); }
        return target;
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        if (!error.cancelled && !this.paused) this.library.patch(id, { mediaFailures: { ...video.mediaFailures, [kind]: { fingerprint: video.fingerprint, message: error.message } } }, false);
        throw error;
      }
    }, kind === 'preview');
  }
  async retry(id) {
    const video = this.library.get(id); this.library.patch(id, { mediaFailures: {} }, false);
    return this.asset(video.id, 'thumb', true);
  }
  stop() { this.stopped = true; this.cancelQueued(); for (const child of this.children) child.kill(); }
}
module.exports = { Media };
