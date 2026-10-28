const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

(async () => {
  const directory = path.join(__dirname, '..', 'third-party');
  await fs.mkdir(directory, { recursive: true });
  for (const name of ['ffmpeg-static', 'ffprobe-static', 'fuse.js']) {
    const root = path.join(__dirname, '..', 'node_modules', name);
    const licenses = (await fs.readdir(root)).filter(file => /^(license|copying)(\.|$)/i.test(file));
    if (!licenses.length) throw new Error(`Missing bundled license for ${name}`);
    for (const license of licenses) await fs.copyFile(path.join(root, license), path.join(directory, `${name}-${license}.txt`));
  }
  for (const [name, executable] of [['FFmpeg', require('ffmpeg-static')], ['FFprobe', require('ffprobe-static').path]]) {
    const version = execFileSync(executable, ['-version'], { encoding: 'utf8', windowsHide: true });
    const license = execFileSync(executable, ['-L'], { encoding: 'utf8', windowsHide: true });
    await fs.writeFile(path.join(directory, `${name}-build-and-license.txt`), `${version}\n${license}`);
  }
  await fs.copyFile(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), path.join(directory, 'SOURCE-INFORMATION.md'));
})().catch(error => { console.error(error); process.exitCode = 1; });
