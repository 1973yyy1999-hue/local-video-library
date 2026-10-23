const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRange } = require('../electron/range.cjs');
test('video seeking supports explicit, open ended, and suffix byte ranges', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=20-', 100), { start: 20, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
});
test('malformed and unsatisfiable ranges do not read past file bounds', () => {
  for (const value of ['bytes=100-', 'bytes=50-20', 'bytes=-0', 'bytes=-', 'bytes=a-b', 'bytes=0-1,5-6', 'bytes=999999999999999999-']) assert.equal(parseRange(value, 100), false, value);
  assert.equal(parseRange('bytes=0-', 0), false);
});
