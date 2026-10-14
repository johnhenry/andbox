// Run with --require no-random-uuid.cjs: host.call() must work with no crypto.randomUUID.
import { createSandbox } from '../../src/index.mjs';
if (typeof crypto.randomUUID !== 'undefined') throw new Error('preload did not apply');
const sb = await createSandbox({ capabilities: { add: (a, b) => a + b } });
const r = await sb.evaluate('return [await host.call("add", 2, 3), typeof crypto.randomUUID]');
await sb.dispose();
console.log(JSON.stringify(r));
