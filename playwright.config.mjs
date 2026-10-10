// Browser tests (test/browser/): `mode: 'iframe'` in every engine.
// `npm test` (node --test) cannot exercise it: it needs a real DOM, a real
// sandboxed <iframe> and the browser's origin checks.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ANDBOX_TEST_PORT) || 47391;

export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  // The page is served from 127.0.0.1; tests import "remote" modules from
  // localhost on the same port, a different origin.
  use: { baseURL: `http://127.0.0.1:${PORT}/` },
  webServer: {
    command: `node test/browser/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/package.json`,
    // Never reuse whatever already listens on the port: another project's
    // server there would silently serve the wrong files.
    reuseExistingServer: false,
  },
  projects: [
    // --site-per-process: desktop Chrome's default, which Playwright's
    // Chromium build lacks. With it a sandboxed frame runs out of process, so
    // the host can hard-kill a synchronous infinite loop (see README).
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--site-per-process'] } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
