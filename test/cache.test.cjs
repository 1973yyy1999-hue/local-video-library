const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Cache, MB } = require('../electron/cache.cjs');
const name = n => `${String(n).padStart(32, '0')}-thumb.jpg`;
async function fixture(t, limit = 1) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-cache-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cache = new Cache(path.join(temp, 'cache'), limit); await cache.load(); return { temp, cache };
}
test('cache eviction respects its quota and reserves room before generation', async t => {
  const { cache } = await fixture(t);
  for (let n = 0; n < 3; n++) {
    const file = path.join(cache.directory, name(n)); await fs.writeFile(file, Buffer.alloc(400000)); await cache.add(file);
  }
  assert.ok(cache.total <= MB); assert.equal(cache.entries.size, 2);
  await cache.trim(700000); assert.ok(cache.total + 700000 <= MB);
});
test('cache startup removes empty and partial outputs without touching other files', async t => {
  const { cache } = await fixture(t);
  await fs.writeFile(path.join(cache.directory, name(1)), '');
  await fs.writeFile(path.join(cache.directory, name(2).replace('.jpg', '.tmp.jpg')), 'partial');
  await fs.writeFile(path.join(cache.directory, 'my-video.mp4'), 'untouched');
  await cache.load(); assert.equal(cache.total, 0);
  assert.deepEqual(await fs.readdir(cache.directory), ['my-video.mp4']);
});
test('moving a cache leaves no duplicate payloads in the old location', async t => {
  const { cache, temp } = await fixture(t); const old = cache.directory;
  const file = path.join(old, name(1)); await fs.writeFile(file, 'cache'); await cache.add(file);
  await cache.move(path.join(temp, 'new', 'ShiyingCache'));
  assert.equal(cache.total, 5); assert.equal((await fs.readdir(old)).length, 0);
  await cache.trim(0, new Set()); assert.equal(cache.total, 0);
});
