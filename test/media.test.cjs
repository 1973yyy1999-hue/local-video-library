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

test('transient failures expire and old v0.2 failures do not remain permanent', async t => {
  const { video, media } = await fixture(t); let calls = 0;
  media.run = async () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(video.mediaFailures.thumb.permanent, false);
  assert.ok(video.mediaFailures.thumb.retryAt > Date.now());
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(calls, 1);
  video.mediaFailures.thumb.retryAt = Date.now() - 1;
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(calls, 2);
  video.mediaFailures.thumb = { fingerprint: video.fingerprint, message: 'old failure' };
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(calls, 3);
  assert.equal(media.reserved, 0);
});
test('definitive invalid-media failures require retry, bulk reset clears them', async t => {
  const { video, library, media } = await fixture(t); let calls = 0;
  library.state = { videos: [video] }; library.flush = async () => {};
  media.run = async () => { calls++; throw Object.assign(new Error('invalid stream'), { permanent: true }); };
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(video.mediaFailures.thumb.permanent, true);
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(calls, 1);
  await media.resetFailures(); assert.deepEqual(video.mediaFailures, {});
  await assert.rejects(media.asset(video.id, 'thumb')); assert.equal(calls, 2);
});
test('optional concurrency is bounded and lowering it waits for active work', async t => {
  const { media } = await fixture(t), started = [], releases = [];
  media.setConcurrency(2);
  const jobs = [0, 1, 2].map(index => media.enqueue(String(index), () => new Promise(resolve => { started.push(index); releases[index] = resolve; })));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 1]);
  media.setConcurrency(1); releases[0](); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 1]);
  releases[1](); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 1, 2]);
  releases[2](); await Promise.all(jobs); await media.idle(); assert.equal(media.active, 0);
});
test('parallel media reservations remain inside cache quota and release on failure', async t => {
  const { media, library } = await fixture(t);
  const videos = Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1).repeat(32), fingerprint: String(index + 1).repeat(32), online: true }));
  library.get = id => videos.find(video => video.id === id);
  library.patch = (id, changes) => Object.assign(library.get(id), changes);
  media.cache.limit = 128 * 1024 * 1024; media.setConcurrency(4);
  const release = []; media.run = () => new Promise((_, reject) => release.push(() => reject(new Error('temporary'))));
  const jobs = videos.map(video => assert.rejects(media.asset(video.id, 'thumb')));
  while (release.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(media.reserved, 80 * 1024 * 1024); assert.ok(media.cache.total + media.reserved <= media.cache.limit);
  release.forEach(done => done()); await Promise.all(jobs); assert.equal(media.reserved, 0);
});
