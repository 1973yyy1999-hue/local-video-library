const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VisibleQueue } = require('../src/visible-queue.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
test('rapid scrolling skips departed cards and prioritizes the newest visible card', async () => {
  const visible = new Set(['first', 'old', 'new']), started = [], release = {};
  const queue = new VisibleQueue({ isVisible: item => visible.has(item), run: item => new Promise(resolve => { started.push(item); release[item] = resolve; }) });
  queue.add('first'); await turn(); queue.add('old'); queue.add('new'); visible.delete('old');
  release.first(); await turn(); assert.deepEqual(started, ['first', 'new']);
  release.new(); await turn(); assert.deepEqual(started, ['first', 'new']); queue.close();
});
test('visibility is rechecked immediately before running, paused work resumes without re-observation', async () => {
  const visible = new Set(['card']), started = [];
  const queue = new VisibleQueue({ isVisible: item => visible.has(item), run: async item => started.push(item) });
  queue.add('card'); visible.clear(); await turn(); assert.deepEqual(started, []);
  visible.add('card'); queue.pause(true); queue.add('card'); await turn(); assert.deepEqual(started, []);
  queue.pause(false); await turn(); assert.deepEqual(started, ['card']); queue.close();
});
