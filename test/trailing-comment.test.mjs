/**
 * Regression tests for andbox#23: code whose last line ends in a `//` comment
 * used to swallow the wrapper's closing `})();` and fail with a SyntaxError.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

describe('evaluate(): trailing line comments (andbox#23)', () => {
  it('single line ending in a // comment', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return 1 // trailing comment'), 1);
  });

  it('multi-line code whose last line ends in a // comment', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('const x = 2\nreturn x // done'), 2);
  });

  it('code with a trailing newline still works', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return 1 // trailing comment\n'), 1);
  });

  it('code that is only a comment evaluates to undefined', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('// nothing to do'), undefined);
  });

  it('an unterminated block comment is still a SyntaxError', async () => {
    const sb = await make();
    await assert.rejects(() => sb.evaluate('return 1 /* oops'), (e) => e.name === 'SyntaxError');
  });
});

describe('inline and data-uri modes: trailing line comments', () => {
  it('inline', async () => {
    const sb = createSandbox({ mode: 'inline' });
    const r = await sb.execute('return 1 // c');
    assert.equal(r.success, true);
    assert.equal(r.returnValue, 1);
  });

  it('data-uri', async () => {
    const sb = createSandbox({ mode: 'data-uri' });
    const r = await sb.execute('export default 1 // c');
    assert.equal(r.success, true);
    assert.equal(r.returnValue, 1);
  });
});
