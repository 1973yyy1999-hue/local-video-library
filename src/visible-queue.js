// Small shared scheduler: visibility is checked both when queued and when started.
// Exported for Node tests as well as the sandboxed renderer.
(function (root) {
  class VisibleQueue {
    constructor({ run, isVisible, limit = 1, onError = () => {} }) { this.run = run; this.isVisible = isVisible; this.limit = limit; this.onError = onError; this.queue = new Set(); this.running = new Set(); this.paused = false; this.closed = false; }
    add(item) { if (this.closed || this.running.has(item)) return; this.queue.delete(item); this.queue.add(item); this.pump(); }
    remove(item) { this.queue.delete(item); }
    pause(value) { this.paused = value; this.pump(); }
    close() { this.closed = true; this.queue.clear(); }
    pump() {
      while (!this.closed && !this.paused && this.running.size < this.limit && this.queue.size) {
        const item = [...this.queue].at(-1); this.queue.delete(item);
        if (!this.isVisible(item)) continue;
        this.running.add(item);
        Promise.resolve().then(() => this.isVisible(item) && !this.closed && !this.paused ? this.run(item) : undefined)
          .catch(this.onError).finally(() => { this.running.delete(item); this.pump(); });
      }
    }
  }
  if (typeof module !== 'undefined') module.exports = { VisibleQueue }; else root.VisibleQueue = VisibleQueue;
})(globalThis);
