/**
 * 11 — Chrome AI bridge, in a real browser.
 *
 * The sandbox (a Worker) has no LanguageModel; Chrome exposes the built-in AI
 * APIs to Window contexts only. The page bridges them in with chromeAI(), and
 * every model call goes through a consent prompt. When the model still has
 * to be downloaded, Chrome needs a user gesture: the "Allow" click is it,
 * because onRequest resolves from inside the click handler.
 *
 * Uses the browser's real LanguageModel when present; `?fake` (or a browser
 * without the API) uses the test fake (test/fixtures/fake-chrome-ai.mjs).
 * Serve the repo root (node test/browser/serve.mjs 8790) and open
 * http://127.0.0.1:8790/examples/11-chrome-ai-browser/index.html
 */
import { createSandbox } from '../../src/index.mjs';
import { chromeAI } from '../../src/bridges/chrome-ai.mjs';

const $ = (id) => document.getElementById(id);
const useFake = new URLSearchParams(location.search).has('fake') || typeof globalThis.LanguageModel !== 'function';
let scope = globalThis;
if (useFake) {
  const { createFakeChromeAI } = await import('../../test/fixtures/fake-chrome-ai.mjs');
  scope = createFakeChromeAI({ availability: 'downloadable' }).scope;
}
$('source').textContent = useFake ? 'fake (test fixture)' : 'Chrome built-in';

// The app's consent UI. Resolving from the click handler means the page has
// user activation when the bridge calls LanguageModel.create().
function askUser(request) {
  if (request.method !== 'languageModel.create' && !request.requiresUserActivation) return true; // prompts are pre-approved here
  return new Promise((resolve) => {
    $('consent-text').textContent = `Sandboxed code wants ${request.bridge}.${request.method}` +
      (request.requiresUserActivation ? ' (this downloads the on-device model).' : '.');
    $('consent').classList.add('open');
    const done = (ok) => { $('consent').classList.remove('open'); resolve(ok); };
    $('allow').onclick = () => done(true);
    $('deny').onclick = () => done(false);
    request.signal.addEventListener('abort', () => done(false), { once: true });
  });
}

const sandbox = await createSandbox({
  bridges: { ai: chromeAI({ scope, onRequest: askUser, budgets: { maxInputTokens: 2000 }, apis: ['languageModel'] }) },
  defaultTimeoutMs: 10 * 60_000, // a first download can take minutes
  onConsole: (level, ...args) => { $('output').textContent += args.join(' ') + '\n'; },
});

const checks = [];
try {
  const r = await sandbox.evaluate(`
    const availability = await ai.languageModel.availability();
    if (availability === 'unavailable') return { availability };
    const session = await ai.languageModel.create({
      initialPrompts: [{ role: 'system', content: 'Answer in one short sentence.' }],
      monitor(m) { m.addEventListener('downloadprogress', (e) => console.log('download', Math.round(e.loaded * 100) + '%')); },
    });
    let answer = '';
    for await (const chunk of session.promptStreaming('What is a sandbox, in one sentence?')) answer += chunk;
    const usage = session.contextUsage ?? session.inputUsage;
    session.destroy();
    return { availability, answer, usage, workerHasOwnAPI: typeof globalThis.LanguageModel };
  `);
  $('output').textContent += JSON.stringify(r, null, 2) + '\n';
  checks.push(['the sandbox reached the model through the page', r.availability === 'unavailable' || typeof r.answer === 'string']);
  checks.push(["the Worker has no LanguageModel of its own", r.workerHasOwnAPI === 'undefined' || r.availability === 'unavailable']);
} catch (e) {
  checks.push([`evaluate failed: ${e.name}: ${e.message}`, false]);
}
checks.push(['tokens are counted on the host', typeof sandbox.stats().bridges.ai.inputTokens === 'number']);
await sandbox.dispose();

const ok = checks.every(([, pass]) => pass);
$('result').textContent = checks.map(([name, pass]) => `${pass ? 'PASS' : 'FAIL'} ${name}`).join('\n');
$('status').textContent = ok ? 'passed' : 'failed';
document.title = `andbox — Chrome AI bridge (${ok ? 'PASSED' : 'FAILED'})`;
