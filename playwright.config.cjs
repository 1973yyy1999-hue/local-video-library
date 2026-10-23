const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './test/e2e', timeout: 120000, workers: 1, retries: 0, reporter: 'list', use: { trace: 'retain-on-failure' } });
