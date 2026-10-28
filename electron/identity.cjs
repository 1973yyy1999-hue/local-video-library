const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const SAMPLE_BYTES = 64 * 1024;

// Persist while the source still exists. A missing old path cannot be hashed later.
async function contentKey(file, expected) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) throw new Error('文件正在变化');
    const hash = crypto.createHash('sha256').update(`head-tail-v1:${before.size}:`);
    const offsets = before.size <= SAMPLE_BYTES ? [0] : [0, Math.max(SAMPLE_BYTES, before.size - SAMPLE_BYTES)];
    for (const offset of offsets) {
      const buffer = Buffer.alloc(Math.min(SAMPLE_BYTES, before.size - offset));
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, offset + read);
        if (!result.bytesRead) throw new Error('文件读取不完整');
        read += result.bytesRead;
      }
      hash.update(buffer);
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('文件正在变化');
    return `ht1:${hash.digest('hex')}`;
  } finally { await handle.close(); }
}

function uniqueMoves(oldRecords, found) {
  const group = records => {
    const groups = new Map();
    for (const video of records) if (video.contentKey) {
      const key = `${video.size}:${video.contentKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(video);
    }
    return groups;
  };
  const old = group(oldRecords.values()), next = group(found.values()), pairs = [];
  for (const [key, before] of old) {
    const after = next.get(key);
    if (before.length !== 1 || after?.length !== 1) continue;
    const existing = oldRecords.get(after[0].id);
    if (found.has(before[0].id) || existing && (existing.contentKey || existing.favorite || existing.tags?.length || existing.position || existing.watched || existing.lastPlayed)) continue;
    pairs.push([before[0], after[0]]);
  }
  return pairs;
}

module.exports = { contentKey, uniqueMoves, SAMPLE_BYTES };
