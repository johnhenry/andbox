/**
 * Process-lifetime semantics: a live worker thread keeps the host process
 * alive unless dispose()d or created with { unref: true }.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/unref-child.mjs', import.meta.url));

function runChild(unref, dispose, waitMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [child, String(unref), String(dispose)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    let exited = null;
    p.on('exit', (code) => { exited = code; resolve({ exited, out }); });
    setTimeout(() => {
      if (exited === null) { p.kill('SIGKILL'); }
    }, waitMs);
  });
}

describe('sandbox lifetime', () => {
  it('a live sandbox keeps the process alive by default (killed after the wait)', async () => {
    const r = await runChild(false, false, 1500);
    assert.match(r.out, /result 42/);
    assert.notEqual(r.exited, 0);
  });

  it('dispose() lets the process exit', async () => {
    const r = await runChild(false, true, 8000);
    assert.equal(r.exited, 0);
    assert.match(r.out, /done-main/);
  });

  it('unref: true lets the process exit without dispose()', async () => {
    const r = await runChild(true, false, 8000);
    assert.equal(r.exited, 0);
    assert.match(r.out, /result 42/);
  });
});
