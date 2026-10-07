#!/usr/bin/env node
/**
 * 08 — run the browser demo headlessly and print its results.
 *
 * Starts serve.mjs, launches Chrome/Chromium with a throwaway profile and a
 * DevTools port, loads the page, and polls document.title until the checks
 * finish. Exits non-zero if any check failed. Needs a Chrome/Chromium binary
 * (set CHROME=/path/to/chrome, otherwise common names are tried) and Node's
 * global WebSocket. Not part of `npm run examples` or CI.
 *
 *   node examples/08-wasm-browser/build.mjs
 *   node examples/08-wasm-browser/run-headless.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8788 + Math.floor(Math.random() * 200);
const DEVTOOLS = 9400 + Math.floor(Math.random() * 200);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch {}
  }
  throw new Error('No Chrome/Chromium found; set CHROME=/path/to/chrome');
}

const server = spawn(process.execPath, [join(here, 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'andbox-chrome-'));
const chrome = spawn(findChrome(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEVTOOLS}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 1;
try {
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json`)).json(); break; } catch { await sleep(200); }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    pending.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && (process.env.DEBUG || ['error', 'warning'].includes(m.params.type))) console.error(`page console.${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/examples/08-wasm-browser/index.html` });
  let title = '';
  for (let i = 0; i < 300 && !/PASSED|FAILED/.test(title); i++) {
    await sleep(200);
    title = (await evalJs('document.title')) || '';
  }
  const result = await evalJs('document.getElementById("result")?.textContent');
  console.log(result || '(no result; page did not finish)');
  if (!result) console.log('title:', title, '| url:', await evalJs('location.href'), '| status:', await evalJs('document.getElementById("status")?.textContent'));
  code = /PASSED/.test(title) ? 0 : 1;
  ws.close();
} finally {
  cleanup();
}
process.exit(code);
