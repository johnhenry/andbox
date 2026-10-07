/**
 * Real browser-target bundle smoke tests for the entry (src/index.mjs) with
 * webpack 5 and Vite. The Node adapter loads node:worker_threads with a
 * non-literal specifier; a bundler that tried to resolve it would fail (or
 * warn) on the `node:` scheme. Each build runs in its own process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const NODE_RESOLUTION = /node:worker_threads|UnhandledSchemeError|Module not found|built into node|Could not resolve|externalized for browser compatibility/i;

async function build(script, outFile) {
  const { stdout } = await run(process.execPath, [fixture(script)], { maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').pop());
  try {
    const file = join(result.out, outFile);
    result.code = existsSync(file) ? readFileSync(file, 'utf8') : '';
  } finally {
    rmSync(result.out, { recursive: true, force: true });
  }
  return result;
}

function assertClean(r) {
  assert.equal(r.ok, true, `build failed:\n${r.errors.join('\n')}`);
  const noise = [...r.errors, ...r.warnings].filter((m) => NODE_RESOLUTION.test(m));
  assert.deepEqual(noise, [], `node: resolution problems:\n${noise.join('\n')}`);
  assert.ok(r.code.length > 1000, 'bundle has content');
  assert.match(r.code, /createSandbox/, 'bundle contains the public API');
}

describe('browser bundles', () => {
  it('webpack 5 (target: web) bundles src/index.mjs with no node: resolution errors', async () => {
    assertClean(await build('webpack-build.mjs', 'out.js'));
  });

  it('Vite (Rollup) bundles src/index.mjs with no node: resolution errors', async () => {
    const r = await build('vite-build.mjs', 'out.js');
    if (!r.code) r.code = ''; // vite may emit out.mjs/out.js depending on version
    assertClean(r);
  });
});
