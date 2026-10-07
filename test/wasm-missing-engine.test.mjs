/**
 * mode: 'wasm' is optional: with the engine packages absent, createSandbox()
 * must fail with a clear install hint, and the default mode must be
 * unaffected. A copy of src/ outside this repo has no node_modules to find.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const srcDir = fileURLToPath(new URL('../src', import.meta.url));

describe("mode: 'wasm' without the optional engine packages", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'andbox-noengine-'));
    cpSync(srcDir, join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'probe.mjs'), `
      import { createSandbox } from './src/index.mjs';
      const out = {};
      try { await createSandbox({ mode: 'wasm' }); out.wasm = 'created'; }
      catch (e) { out.wasm = { code: e.code, message: e.message }; }
      const sb = await createSandbox();
      out.plain = await sb.evaluate('return 1 + 1');
      await sb.dispose();
      console.log(JSON.stringify(out));
    `);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('throws a clear error naming the packages, and default mode still works', async () => {
    const { stdout } = await run(process.execPath, [join(dir, 'probe.mjs')], { timeout: 60_000 });
    const out = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(out.wasm.code, 'ERR_ANDBOX_ENGINE_MISSING');
    assert.match(out.wasm.message, /quickjs-emscripten-core@0\.32\.0/);
    assert.match(out.wasm.message, /@jitl\/quickjs-ng-wasmfile-release-sync@0\.32\.0/);
    assert.match(out.wasm.message, /npm install/);
    assert.equal(out.plain, 2);
  });
});
