const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchVideos } = require('../src/search.js');
let Fuse;
try { Fuse = require('fuse.js'); } catch {}
const records = [
  { id: 'a', name: '海边日落', folder: '旅行', tags: ['风景'] },
  { id: 'b', name: 'Javascript tutorial', folder: '教程', tags: ['编程'] },
  { id: 'c', name: '城市夜景', folder: '旅行', tags: ['街拍'] }
];
test('Chinese partial terms and multi-field tokens find matching video', { skip: !Fuse && 'Install dependencies to test Fuse.js' }, () => {
  assert.deepEqual(searchVideos(records, '日落', Fuse).map(item => item.id), ['a']);
  assert.deepEqual(searchVideos(records, '旅行 风景', Fuse).map(item => item.id), ['a']);
  assert.equal(searchVideos(records, '旅行 编程', Fuse).length, 0);
});
test('typo-tolerant search finds misspelled titles', { skip: !Fuse && 'Install dependencies to test Fuse.js' }, () => {
  assert.equal(searchVideos(records, 'Javscript', Fuse)[0].id, 'b');
  assert.equal(searchVideos(records, '', Fuse).length, 3);
});

test('direct substring searches do not construct the fuzzy index', () => {
  class NoFuse { constructor() { assert.fail('Exact matches must not build Fuse'); } }
  assert.deepEqual(searchVideos(records, 'JAVASCRIPT', NoFuse).map(item => item.id), ['b']);
  assert.deepEqual(searchVideos(records, '旅行 风景', NoFuse).map(item => item.id), ['a']);
});
