/**
 * #7: sandboxImport() must not load arbitrary remote code. Remote http(s)
 * specifiers are denied unless the host lists the hostname in
 * `allowedImportHosts`; import-map targets are host-authored and trusted.
 * (Node cannot import http(s) URLs at all, so "allowed" is observed as "got
 * past the policy and failed in the loader", never as "denied".)
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
const imp = (spec) => `return await sandboxImport(${JSON.stringify(spec)})`;

describe('#7 sandboxImport remote policy', () => {
  it('denies an absolute http(s) import by default', async () => {
    const sb = await make();
    await assert.rejects(() => sb.evaluate(imp('https://evil.example/x.js')), /Import denied.*evil\.example/);
    await assert.rejects(() => sb.evaluate(imp('http://evil.example:8080/x.js')), /Import denied/);
  });

  it('denies protocol-relative and host-escaping specifiers', async () => {
    const sb = await make();
    await assert.rejects(() => sb.evaluate(imp('//evil.example/x.js')), /Import denied.*evil\.example/);
    await assert.rejects(() => sb.evaluate(imp('//EVIL.example/x.js')), /Import denied/);
  });

  it('allows only listed hostnames (case-insensitive), still denies others', async () => {
    const sb = await make({ allowedImportHosts: ['Cdn.Example'] });
    await assert.rejects(() => sb.evaluate(imp('https://evil.example/x.js')), /Import denied/);
    await assert.rejects(
      () => sb.evaluate(imp('https://cdn.example/x.js')),
      (e) => !/Import denied/.test(e.message),
      'listed host passes the policy (the loader then fails: Node cannot import https)',
    );
  });

  it('an empty list means deny all', async () => {
    const sb = await make({ allowedImportHosts: [] });
    await assert.rejects(() => sb.evaluate(imp('https://cdn.example/x.js')), /Import denied/);
  });

  it('import-map targets are host-authored and not subject to the list', async () => {
    const sb = await make({ importMap: { imports: { remote: 'https://esm.example/x.js' } } });
    await assert.rejects(
      () => sb.evaluate(imp('remote')),
      (e) => !/Import denied/.test(e.message),
    );
  });

  it('virtual modules are unaffected', async () => {
    const sb = await make();
    await sb.defineModule('std/one', 'export default 1');
    assert.equal(await sb.evaluate(`return (await sandboxImport('std/one')).default`), 1);
  });

  it('rejects a malformed allowedImportHosts', async () => {
    await assert.rejects(() => createSandbox({ allowedImportHosts: 'cdn.example' }), /allowedImportHosts/);
    await assert.rejects(() => createSandbox({ allowedImportHosts: [1] }), /allowedImportHosts/);
  });
});
