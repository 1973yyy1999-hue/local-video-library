const fs = require('node:fs/promises');
const path = require('node:path');

const defaults = { cacheLimitMB: 512, autoScan: false, playerPath: '', concurrency: 1, theme: 'system', hoverPreview: true, sort: 'relevance', volume: 1, muted: false, sidebarCollapsed: false, uiMigrated: false };
const sorts = ['relevance', 'name', 'modified', 'size', 'duration'];
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
  const next = { ...defaults };
  for (const key of ['autoScan', 'hoverPreview', 'muted', 'sidebarCollapsed', 'uiMigrated']) if (typeof value[key] === 'boolean') next[key] = value[key];
  if ([128, 256, 512, 1024, 2048].includes(value.cacheLimitMB)) next.cacheLimitMB = value.cacheLimitMB;
  if ([1, 2, 4].includes(value.concurrency)) next.concurrency = value.concurrency;
  if (['system', 'light', 'dark'].includes(value.theme)) next.theme = value.theme;
  if (sorts.includes(value.sort)) next.sort = value.sort;
  if (Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1) next.volume = value.volume;
  for (const key of ['playerPath', 'cacheDirectory']) if (typeof value[key] === 'string' && value[key] && path.isAbsolute(value[key]) && !value[key].includes('\0')) next[key] = value[key];
  return next;
}
class Settings {
  constructor(directory) { this.file = path.join(directory, 'settings.json'); this.queue = Promise.resolve(); }
  async read() { try { return validate(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch { return { ...defaults }; } }
  write(value) {
    const text = JSON.stringify(validate(value));
    this.queue = this.queue.catch(() => {}).then(async () => {
      const temp = `${this.file}.tmp`, handle = await fs.open(temp, 'w');
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.file);
    });
    return this.queue;
  }
}
module.exports = { Settings, validate, sorts };
