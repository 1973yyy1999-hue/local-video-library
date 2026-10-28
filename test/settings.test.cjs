const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Settings, validate } = require('../electron/settings.cjs');
test('concurrent settings saves serialize and persist the last complete record', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-settings-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = new Settings(directory);
  await Promise.all(Array.from({ length: 30 }, (_, index) => settings.write({ volume: index / 30, sidebarCollapsed: index === 29, hoverPreview: false })));
  const read = await settings.read(); assert.equal(read.volume, 29 / 30); assert.equal(read.sidebarCollapsed, true); assert.equal(read.hoverPreview, false);
});
test('settings validates booleans, paths, enum values and volume', () => {
  const value = validate({ autoScan: 'yes', playerPath: {}, cacheDirectory: '../outside', concurrency: 500, theme: 'weird', volume: Infinity, muted: 123 });
  assert.equal(value.autoScan, false); assert.equal(value.playerPath, ''); assert.equal(value.cacheDirectory, undefined);
  assert.equal(value.concurrency, 1); assert.equal(value.theme, 'system'); assert.equal(value.volume, 1); assert.equal(value.muted, false);
});
