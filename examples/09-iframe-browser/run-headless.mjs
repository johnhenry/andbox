#!/usr/bin/env node
/**
 * 09 — run the iframe-mode demo in headless Chromium and print its results.
 *
 * Starts the repo's static test server (test/browser/serve.mjs), opens the
 * page with Playwright (a devDependency; `npx playwright install chromium`
 * once), waits for the checks, and exits non-zero if any failed.
 * Not part of `npm run examples` or CI's examples step: it needs a browser.
 *
 *   npm run example:09:headless
 *   # or by hand: node test/browser/serve.mjs 8789, then open
 *   # http://127.0.0.1:8789/examples/09-iframe-browser/index.html
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8789 + Math.floor(Math.random() * 200);
const server = spawn(process.execPath, [join(here, '../../test/browser/serve.mjs'), String(PORT)], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let code = 1;
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/package.json`); break; } catch { await sleep(100); }
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/examples/09-iframe-browser/index.html`);
  await page.waitForFunction(() => /PASSED|FAILED/.test(document.title), null, { timeout: 30_000 });
  console.log(await page.textContent('#result'));
  code = /PASSED/.test(await page.title()) ? 0 : 1;
} finally {
  await browser?.close();
  server.kill();
}
process.exit(code);
