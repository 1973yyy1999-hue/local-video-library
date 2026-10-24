const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Media } = require('../electron/media.cjs');
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-media-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const video = { id: 'a'.repeat(32), fingerprint: 'b'.repeat(32), online: true };
  const library = { directory: temp, get: () => video, verifiedPath: async () => 'fixture.mp4', patch: (_id, changes) => Object.assign(video, changes) };
  const media = new Media(library, { ffmpeg: 'encoder', ffprobe: 'probe' }); await media.cache.load();
  return { video, library, media };
}
test('bad media fails once until explicit retry, and failures do not rewrite the index', async t => {
  const { video, media } = await fixture(t); let calls = 0;
  media.run = async () => { calls++; throw new Error('corrupt fixture'); };
  await assert.rejects(media.asset(video.id, 'thumb')); await assert.rejects(media.asset(video.id, 'thumb'));
  assert.equal(calls, 1); assert.equal(video.mediaFailures.thumb.fingerprint, video.fingerprint);
  await assert.rejects(media.retry(video.id)); assert.equal(calls, 2);
});
test('cache hits avoid source reads; attached cover streams are excluded from preview', async t => {
  const { video, library, media } = await fixture(t); let reads = 0, args;
  library.verifiedPath = async () => { reads++; return 'fixture.mp4'; };
  media.run = async (binary, values) => {
    if (binary === 'probe') return JSON.stringify({ format: { duration: 125 }, streams: [{ codec_type: 'video', width: 100, height: 100, disposition: { attached_pic: 1 } }, { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'ac3' }] });
    args = values; await fs.writeFile(values.at(-1), 'valid');
  };
  await media.asset(video.id, 'preview'); await media.asset(video.id, 'preview');
  assert.equal(reads, 1); assert.ok(args.includes('0:V:0')); assert.equal(video.width, 1920); assert.deepEqual(video.audioCodecs, ['ac3']);
});
test('media processing is serial and queued work is cancelled when playback starts', async t => {
  const { media } = await fixture(t); let unblock;
  const first = media.enqueue('one', () => new Promise(resolve => { unblock = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const next = media.enqueue('two', () => assert.fail('must not start competing HDD work'));
  const rejected = assert.rejects(next, /页面已切换/);
  media.setPlaying(true); unblock(); await first; await rejected;
  assert.equal(media.paused, true);
});
