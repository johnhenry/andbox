#!/usr/bin/env node
/**
 * 11 — run the Chrome AI bridge demo in headless Chromium against the fake
 * model (`?fake`; CI has no on-device model), clicking the consent prompt.
 * Exits non-zero if a check failed. Not part of `npm run examples`: it needs a browser.
 *
 *   npm run example:11:headless
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8989 + Math.floor(Math.random() * 200);
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
  await page.goto(`http://127.0.0.1:${PORT}/examples/11-chrome-ai-browser/index.html?fake`);
  await page.click('#allow'); // the consent prompt for languageModel.create (a model "download")
  await page.waitForFunction(() => /PASSED|FAILED/.test(document.title), null, { timeout: 30_000 });
  console.log(await page.textContent('#output'));
  console.log(await page.textContent('#result'));
  code = /PASSED/.test(await page.title()) ? 0 : 1;
} finally {
  await browser?.close();
  server.kill();
}
process.exit(code);
