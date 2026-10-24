const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library, inside } = require('../electron/library.cjs');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, '中文 视频');
  await fs.mkdir(path.join(root, '旅行'), { recursive: true });
  await fs.writeFile(path.join(root, '旅行', '海边 日落.MP4'), 'video');
  await fs.writeFile(path.join(root, '教程.mkv'), 'video2');
  await fs.writeFile(path.join(root, 'ignore.txt'), 'not a video');
  const library = new Library(path.join(temp, 'data'));
  await library.load();
  await library.addRoot(root);
  return { temp, root, library };
}
test('recursive scan handles Chinese paths, filters extensions, and persists edits', async t => {
  const { library, temp } = await fixture(t);
  await library.scan();
  assert.equal(library.state.videos.length, 2);
  const video = library.state.videos.find(video => video.name === '海边 日落');
  assert.equal(video.folder, '旅行');
  await library.update(video.id, { favorite: true, tags: ['  旅行', '旅行', ''], position: 23, played: true });
  await library.scan();
  const reopened = new Library(path.join(temp, 'data')); await reopened.load();
  assert.equal(reopened.get(video.id).favorite, true);
  assert.deepEqual(reopened.get(video.id).tags, ['旅行']);
  assert.equal(reopened.get(video.id).position, 23);
  assert.ok(reopened.get(video.id).lastPlayed);
});
test('changed file invalidates thumbnail identity, deletion removes only missing records', async t => {
  const { library } = await fixture(t); await library.scan();
  const video = library.state.videos[0], other = library.state.videos[1];
  const oldFingerprint = video.fingerprint;
  video.duration = 100;
  await fs.appendFile(video.path, 'changed');
  await fs.unlink(other.path);
  await library.scan();
  assert.equal(library.state.videos.length, 1);
  assert.notEqual(library.get(video.id).fingerprint, oldFingerprint);
  assert.equal(library.get(video.id).duration, undefined);
});
test('offline drive preserves records and favorites; reconnection restores availability', async t => {
  const { library, root } = await fixture(t); await library.scan();
  const video = library.state.videos[0]; await library.update(video.id, { favorite: true });
  await fs.rename(root, `${root}-offline`);
  await library.scan();
  assert.equal(library.state.videos.length, 2);
  assert.equal(library.get(video.id).online, false);
  assert.equal(library.get(video.id).favorite, true);
  assert.equal(library.state.roots[0].online, false);
  await fs.rename(`${root}-offline`, root); await library.scan();
  assert.equal(library.get(video.id).online, true);
});
test('removing a library never removes its source files', async t => {
  const { library } = await fixture(t); await library.scan();
  const file = library.state.videos[0].path;
  await library.removeRoot(library.state.roots[0].id);
  assert.equal(library.state.videos.length, 0);
  assert.ok((await fs.stat(file)).isFile());
});
test('overlapping roots do not duplicate videos and retain correct root after removal', async t => {
  const { library, temp } = await fixture(t); await library.scan();
  const firstRoot = library.state.roots[0].id;
  await library.addRoot(temp); await library.scan();
  assert.equal(library.state.videos.length, 2);
  await library.removeRoot(firstRoot);
  assert.equal(library.state.videos.length, 2);
  assert.ok(library.state.videos.every(video => video.rootId === library.state.roots[0].id));
});
test('cancelled scan preserves existing unseen records', async t => {
  const { library } = await fixture(t); await library.scan();
  library.notify = (name, status) => { if (name === 'scan-progress' && status.running) library.cancelled = true; };
  await library.scan();
  assert.equal(library.state.videos.length, 2);
  assert.equal(library.status.running, false);
});
test('media access rejects records outside registered roots and path prefix siblings', async t => {
  const { library, temp, root } = await fixture(t); await library.scan();
  assert.equal(inside(root, `${root}-other/a.mp4`), false);
  const outside = path.join(temp, 'outside.mp4'); await fs.writeFile(outside, 'data');
  const video = library.state.videos[0]; video.path = outside;
  await assert.rejects(library.verifiedPath(video.id), /不在已添加/);
});
test('invalid JSON without a backup is preserved rather than silently overwritten', async t => {
  const { library } = await fixture(t);
  await fs.unlink(`${library.file}.bak`);
  await fs.writeFile(library.file, 'broken data');
  await assert.rejects(new Library(library.directory).load(), /原文件已保留/);
  assert.equal(await fs.readFile(library.file, 'utf8'), 'broken data');
});

test('damaged main index recovers a backup and retains damaged evidence', async t => {
  const { library } = await fixture(t); await library.scan(); await library.save();
  await fs.writeFile(library.file, '{broken');
  const reopened = new Library(library.directory); await reopened.load();
  assert.equal(reopened.state.videos.length, 2);
  assert.match(reopened.recovery, /备份恢复/);
  const files = await fs.readdir(library.directory);
  assert.ok(files.some(name => name.startsWith('library.json.damaged-')));
});
test('folder relocation preserves identity, favorites, progress and cached fingerprint', async t => {
  const { library, root } = await fixture(t); await library.scan();
  const video = library.state.videos[0], fingerprint = video.fingerprint;
  await library.update(video.id, { favorite: true, position: 42, tags: ['旅行'] });
  const moved = `${root}-moved`; await fs.rename(root, moved);
  await library.relocateRoot(library.state.roots[0].id, moved); await library.scan();
  const relocated = library.get(video.id);
  assert.equal(relocated.favorite, true); assert.equal(relocated.position, 42);
  assert.equal(relocated.fingerprint, fingerprint); assert.ok(relocated.path.startsWith(await fs.realpath(moved)));
});
test('scan publishes usable batches before finishing and keeps metadata edits', async t => {
  const { library, root } = await fixture(t);
  for (let i = 0; i < 105; i++) await fs.writeFile(path.join(root, `clip-${i}.mp4`), 'x');
  let sawBatch = false, edited;
  library.notify = (name, batch) => {
    if (name === 'scan-batch' && !sawBatch) {
      sawBatch = true; assert.equal(library.scanning, true); assert.ok(library.state.videos.length >= 100);
      edited = batch[0].id; library.patch(edited, { favorite: true });
    }
  };
  await library.scan(); assert.ok(sawBatch); assert.equal(library.get(edited).favorite, true);
});
test('routine progress writes do not rewrite or serialize the whole index', async t => {
  const { library } = await fixture(t); await library.scan();
  const original = await fs.readFile(library.file, 'utf8'), video = library.state.videos[0];
  for (let i = 0; i < 100; i++) await library.update(video.id, { position: i });
  await library.flush();
  assert.equal(await fs.readFile(library.file, 'utf8'), original);
  const journal = await fs.readFile(library.store.journal, 'utf8');
  assert.equal(journal.trim().split('\n').length, 1); assert.ok(journal.length < 3000);
  const reopened = new Library(library.directory); await reopened.load(); assert.equal(reopened.get(video.id).position, 99);
});
test('truncated journal recovers intact batches and keeps subsequent writes replayable', async t => {
  const { library } = await fixture(t); await library.scan(); const video = library.state.videos[0];
  await library.update(video.id, { favorite: true }); await fs.appendFile(library.store.journal, '{partial');
  const reopened = new Library(library.directory); await reopened.load(); assert.equal(reopened.get(video.id).favorite, true);
  await reopened.update(video.id, { tags: ['kept'] });
  const final = new Library(library.directory); await final.load(); assert.deepEqual(final.get(video.id).tags, ['kept']);
});

test('checkpoint recovery does not replay already incorporated journal records', async t => {
  const { library } = await fixture(t); await library.scan(); const video = library.state.videos[0];
  await library.update(video.id, { favorite: true });
  const oldJournal = await fs.readFile(library.store.journal, 'utf8');
  await library.update(video.id, { favorite: false }); await library.save();
  // Simulate a crash after publishing the snapshot, before truncating the old log.
  await fs.writeFile(library.store.journal, oldJournal);
  const reopened = new Library(library.directory); await reopened.load(); assert.equal(reopened.get(video.id).favorite, false);
});
