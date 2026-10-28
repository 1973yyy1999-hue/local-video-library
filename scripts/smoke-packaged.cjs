const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = path.join(__dirname, '..');
  const executablePath = path.join(root, 'dist', 'win-unpacked', '影库.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath, env });
  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle('影库');
    await expect(page.locator('#sidebar-toggle')).toBeVisible();
    const settings = await page.evaluate(() => window.libraryAPI.settings());
    expect(settings.version).toBe('1.1.0');
    const dataName = await application.evaluate(({ app }) => require('node:path').basename(app.getPath('userData')));
    expect(dataName).toBe('local-video-library');
    const files = await fs.readdir(path.join(root, 'dist', 'win-unpacked', 'resources', 'third-party'));
    expect(files.some(file => file.startsWith('ffmpeg-static-LICENSE'))).toBe(true);
    expect(files).toContain('FFmpeg-build-and-license.txt');
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'windows-packaged.png') });
    console.log('Packaged executable loads with compatible data directory and bundled notices.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
