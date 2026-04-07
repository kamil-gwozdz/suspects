// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 120000,
    retries: 0,
    workers: 1, // sequential — one server
    use: {
        headless: true,
        screenshot: 'off', // we take manual screenshots
        trace: 'off',
    },
    reporter: [['list']],
});
