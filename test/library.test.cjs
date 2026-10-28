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
  assert.notEqual(library.state.videos[0].fingerprint, oldFingerprint);
  assert.notEqual(library.state.videos[0].id, video.id);
  assert.equal(library.state.videos[0].duration, undefined);
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

test('relocation rejects empty and mismatched folders without changing any paths', async t => {
  const { library, temp } = await fixture(t); await library.scan();
  const before = JSON.stringify(library.state), rootId = library.state.roots[0].id;
  const empty = path.join(temp, 'wrong'); await fs.mkdir(empty);
  await assert.rejects(library.relocateRoot(rootId, empty), /没有匹配/);
  assert.equal(JSON.stringify(library.state), before);
  await fs.writeFile(path.join(empty, '教程.mkv'), 'wrong-size');
  await assert.rejects(library.relocateRoot(rootId, empty), /内容不匹配/);
  assert.equal(JSON.stringify(library.state), before);
});
test('relocation preview reports partial matches and never mutates the library', async t => {
  const { library, temp } = await fixture(t); await library.scan();
  const before = JSON.stringify(library.state), folder = path.join(temp, 'partial'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, '教程.mkv'), 'video2');
  const match = await library.inspectRelocation(library.state.roots[0].id, folder);
  assert.equal(match.matched, 1); assert.equal(match.total, 2); assert.equal(JSON.stringify(library.state), before);
});
test('pre-scan history survives an empty completed scan and can restore user records', async t => {
  const { library } = await fixture(t); await library.scan();
  const id = library.state.videos[0].id; await library.update(id, { favorite: true, watched: true, position: 50 });
  for (const video of library.state.videos) await fs.unlink(video.path);
  await library.scan(); assert.equal(library.state.videos.length, 1); assert.equal(library.get(id).online, false);
  const history = await library.store.readHistory(); assert.equal(history.state.videos.length, 2);
  await library.restoreHistory(); assert.equal(library.get(id).favorite, true); assert.equal(library.get(id).watched, true); assert.equal(library.get(id).position, 50);
  await library.scan(); await library.scan();
  const files = await fs.readdir(library.directory); assert.equal(files.filter(file => /history-\d+\.gz$/.test(file)).length, 2);
});

test('rename and cross-folder moves preserve identity, metadata and cached assets after reopening', async t => {
  const { library, root } = await fixture(t); await library.scan();
  const video = library.state.videos.find(item => item.name === '海边 日落');
  const { id, fingerprint } = video;
  await library.update(id, { favorite: true, tags: ['收藏'], position: 42, watched: true });
  const destination = path.join(root, 'B'); await fs.mkdir(destination);
  const renamed = path.join(destination, '改名后的影片.MP4'); await fs.rename(video.path, renamed);
  const reopened = new Library(library.directory); await reopened.load(); await reopened.scan();
  const moved = reopened.get(id);
  assert.equal(moved.path, await fs.realpath(renamed)); assert.equal(moved.favorite, true); assert.deepEqual(moved.tags, ['收藏']);
  assert.equal(moved.position, 42); assert.equal(moved.watched, true); assert.equal(moved.fingerprint, fingerprint);
  assert.equal(reopened.state.videos.length, 2);
  await reopened.scan(); assert.equal(reopened.state.videos.length, 2);
});
test('copied files and ambiguous content never steal metadata from the original', async t => {
  const { library, root } = await fixture(t); await library.scan();
  const video = library.state.videos[0]; await library.update(video.id, { favorite: true });
  const duplicate = path.join(root, `copy.${video.extension}`); await fs.copyFile(video.path, duplicate);
  await library.scan(); assert.equal(library.get(video.id).path, video.path);
  const canonical = await fs.realpath(duplicate); const copy = library.state.videos.find(item => item.path === canonical); assert.equal(copy.favorite, false);
  await fs.rename(video.path, `${video.path}.old`);
  await fs.rename(duplicate, path.join(root, `moved.${video.extension}`));
  await library.scan(); assert.equal(library.get(video.id).online, false); assert.equal(library.get(video.id).favorite, true);
  assert.equal(library.state.videos.find(item => item.online).favorite, false);
});
test('unmatched annotated records survive and reconnect on a later scan', async t => {
  const { library, root, temp } = await fixture(t); await library.scan(); const video = library.state.videos[0];
  await library.update(video.id, { tags: ['keep'], position: 12 });
  const outside = path.join(temp, 'parked'); await fs.rename(video.path, outside);
  await library.scan(); assert.equal(library.get(video.id).online, false);
  const destination = path.join(root, `back.${video.extension}`); await fs.rename(outside, destination);
  await library.scan(); assert.equal(library.get(video.id).path, await fs.realpath(destination)); assert.equal(library.get(video.id).position, 12);
});
test('legacy records without a fingerprint are retained but never guessed by size', async t => {
  const { library, root } = await fixture(t); await library.scan(); const video = library.state.videos[0];
  delete video.contentKey; await library.update(video.id, { favorite: true }); await library.save();
  await fs.rename(video.path, path.join(root, `legacy-moved.${video.extension}`));
  await library.scan(); assert.equal(library.get(video.id).online, false); assert.equal(library.get(video.id).favorite, true);
});
test('TypeScript and ambiguous transport-stream extensions are not indexed or opened', async t => {
  const { library, root } = await fixture(t);
  for (const name of ['index.ts', 'module.mts', 'camera.m2ts']) await fs.writeFile(path.join(root, name), 'export const x = 1;');
  await library.scan(); assert.equal(library.state.videos.length, 2);
  const video = library.state.videos[0]; video.path = path.join(root, 'index.ts');
  await assert.rejects(library.verifiedPath(video.id), /不在已添加/);
});
test('relocation rejects equal-size files with a different sampled fingerprint', async t => {
  const { library, temp } = await fixture(t); await library.scan(); const wrong = path.join(temp, 'wrong-same-size'); await fs.mkdir(wrong);
  await fs.writeFile(path.join(wrong, '教程.mkv'), 'xxxxxx');
  await assert.rejects(library.inspectRelocation(library.state.roots[0].id, wrong), /内容不匹配/);
});
