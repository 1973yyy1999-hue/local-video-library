const { test } = require('node:test');
const assert = require('node:assert/strict');
const { duration, size } = require('../src/format.js');
test('long durations and small files have readable units', () => {
  assert.equal(duration(7503), '2:05:03'); assert.equal(duration(65), '1:05'); assert.equal(duration(undefined), '—:—');
  assert.equal(size(300), '1 KB'); assert.equal(size(1024 * 1024), '1.0 MB');
});
