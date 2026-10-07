import { createSandbox } from '../../src/index.mjs';
const [, , unref, dispose] = process.argv;
const sb = await createSandbox({ unref: unref === 'true' });
console.log('result', await sb.evaluate('return 6 * 7'));
if (dispose === 'true') await sb.dispose();
console.log('done-main');
