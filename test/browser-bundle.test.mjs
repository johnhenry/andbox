/**
 * The browser entry must bundle for the browser with no `node:` resolution.
 * Bundlers (webpack 5 especially) fail on a literal `import('node:...')`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const esbuild = fileURLToPath(new URL('../node_modules/.bin/esbuild', import.meta.url));

describe('browser bundle', () => {
  it('bundles src/index.mjs with --platform=browser and no node: resolution error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andbox-bundle-'));
    let out;
    try {
      out = await run(esbuild, [
        'src/index.mjs', '--bundle', '--platform=browser', '--format=esm', `--outfile=${join(dir, 'out.js')}`,
      ], { cwd: root });
    } catch (e) {
      assert.fail(`esbuild browser bundle failed:\n${e.stderr || e.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.doesNotMatch(out.stderr, /node:|built into node/);
  });

  it('bundles the wasm engine entry into one browser ES module with no node: imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andbox-engine-bundle-'));
    const outfile = join(dir, 'andbox-quickjs.mjs');
    try {
      await run(esbuild, [
        'src/wasm-engine.mjs', '--bundle', '--platform=browser', '--format=esm', '--minify', `--outfile=${outfile}`,
      ], { cwd: root });
      const code = readFileSync(outfile, 'utf8');
      assert.doesNotMatch(code, /["']node:/, 'browser bundle must not reference node: builtins');
      assert.match(code, /newQuickJSWASMModuleFromVariant/);
      assert.ok(statSync(outfile).size < 150_000, `engine bundle is ${statSync(outfile).size} bytes`);
    } catch (e) {
      if (e.name === 'AssertionError') throw e;
      assert.fail(`esbuild engine bundle failed:\n${e.stderr || e.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
