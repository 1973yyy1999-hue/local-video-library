const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const unpack = value => value.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');

class Media {
  constructor(library) {
    this.library = library;
    this.directory = path.join(library.directory, 'cache');
    this.ffmpeg = unpack(require('ffmpeg-static'));
    this.ffprobe = unpack(require('ffprobe-static').path);
    this.queue = [];
    this.pending = new Map();
    this.active = 0;
    this.children = new Set();
    this.stopped = false;
  }
  run(binary, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new Error('应用正在退出'));
      const child = execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        this.children.delete(child);
        error ? reject(new Error('无法处理这个视频，文件可能损坏、尚未下载完成或磁盘已断开')) : resolve(stdout);
      });
      this.children.add(child);
    });
  }
  enqueue(key, task, priority = false) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      const job = { task, resolve, reject };
      priority ? this.queue.unshift(job) : this.queue.push(job);
    });
    this.pending.set(key, promise);
    const cleanup = () => this.pending.delete(key);
    promise.then(cleanup, cleanup);
    this.drain();
    return promise;
  }
  drain() {
    while (!this.stopped && this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.active--; this.drain(); });
    }
  }
  cachedPath(video, kind) { return path.join(this.directory, `${video.fingerprint}-${kind}.${kind === 'thumb' ? 'jpg' : 'mp4'}`); }
  async info(video, full) {
    if (video.duration !== undefined) return;
    const json = JSON.parse(await this.run(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', full]));
    const stream = json.streams?.find(item => item.codec_type === 'video');
    video.duration = Math.max(0, Number(json.format?.duration) || 0);
    video.width = stream?.width || 0;
    video.height = stream?.height || 0;
  }
  async asset(id, kind) {
    if (!['thumb', 'preview'].includes(kind)) throw new Error('无效的预览类型');
    const video = this.library.get(id);
    const target = this.cachedPath(video, kind);
    try { await fs.access(target); return target; } catch {}
    return this.enqueue(`${video.fingerprint}:${kind}`, async () => {
      const full = await this.library.verifiedPath(id);
      await fs.mkdir(this.directory, { recursive: true });
      await this.info(video, full);
      const seek = Math.min(video.duration * 0.2, 120);
      const temp = target.replace(/\.(jpg|mp4)$/, '.tmp.$1');
      const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-ss', String(seek), '-i', full, '-map', '0:v:0', '-an', '-sn'];
      const args = kind === 'thumb'
        ? [...common, '-frames:v', '1', '-vf', "scale=480:-2", '-q:v', '4', '-threads', '1', temp]
        : [...common, '-t', '6', '-vf', "scale=480:-2,fps=12", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '1', temp];
      try {
        await this.run(this.ffmpeg, args, kind === 'preview' ? 60000 : 30000);
        await fs.rename(temp, target);
        await this.library.save();
        return target;
      } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
    }, kind === 'preview');
  }
  stop() {
    this.stopped = true;
    for (const child of this.children) child.kill();
    for (const job of this.queue.splice(0)) job.reject(new Error('应用正在退出'));
  }
}
module.exports = { Media };
