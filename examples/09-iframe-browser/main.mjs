// Notebook-style panes on mode: 'iframe'. Each pane's code gets the frame's
// own document (so it can draw), reaches the host only through host.call, and
// cannot touch this page. Results go to #result (JSON), #status and
// document.title so run-headless.mjs can read them.
import { createSandbox } from '../../src/index.mjs';

const results = [];
const check = async (name, fn) => {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, detail: `${e?.name}: ${e?.message}` });
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Host data the panes may read, and nothing else.
const capabilities = { series: () => [3, 7, 4, 9, 6, 2, 8] };
const log = [];

const chart = await createSandbox({
  mode: 'iframe',
  container: document.getElementById('chart-pane'),
  html: '<style>body{margin:0;font:12px system-ui}</style>',
  capabilities,
  onConsole: (level, ...args) => log.push(`[chart:${level}] ${args.join(' ')}`),
});

const clock = await createSandbox({
  mode: 'iframe',
  container: document.getElementById('clock-pane'),
  capabilities,
  // Keep the pane styled across restarts (a timeout replaces the element).
  onFrame: (frame) => { frame.dataset.pane = 'clock'; },
});

await check('a pane draws a bar chart into its own document', async () => {
  const bars = await chart.evaluate(`
    const data = await host.call('series');
    const canvas = document.createElement('canvas');
    canvas.width = 700; canvas.height = 150;
    const ctx = canvas.getContext('2d');
    data.forEach((v, i) => { ctx.fillStyle = 'steelblue'; ctx.fillRect(10 + i * 95, 150 - v * 15, 80, v * 15); });
    document.body.append(canvas);
    console.log('drew', data.length, 'bars');
    return data.length;
  `);
  expect(bars === 7, `bars ${bars}`);
  expect(log.includes('[chart:log] drew 7 bars'), 'console not forwarded');
  return `${bars} bars`;
});

await check('a pane animates with requestAnimationFrame', async () => {
  const frames = await clock.evaluate(`
    const p = document.createElement('p');
    document.body.append(p);
    let n = 0;
    await new Promise((done) => {
      const tick = () => { p.textContent = 'frame ' + (++n); n < 10 ? requestAnimationFrame(tick) : done(); };
      requestAnimationFrame(tick);
    });
    return n;
  `);
  expect(frames === 10, `frames ${frames}`);
  return `${frames} frames`;
});

await check('the pane cannot read this page or its storage (opaque origin)', async () => {
  localStorage.setItem('host-secret', 'do-not-leak');
  const seen = await chart.evaluate(`
    const tryRead = (f) => { try { return String(f()); } catch (e) { return e.name; } };
    return [self.origin, tryRead(() => parent.document.title), tryRead(() => localStorage.length)];
  `);
  expect(seen[0] === 'null' && seen[1] === 'SecurityError' && seen[2] === 'SecurityError', seen.join());
  return seen.join(' | ');
});

await check('a hung pane times out and comes back with a fresh frame', async () => {
  const before = clock.iframe;
  try {
    await clock.evaluate('await new Promise(() => {})', { timeoutMs: 200 });
    expect(false, 'should time out');
  } catch (e) {
    expect(e.name === 'TimeoutError', e.name);
  }
  expect(clock.iframe !== before && clock.iframe.dataset.pane === 'clock', 'frame not replaced');
  expect((await clock.evaluate('return document.body.children.length')) === 0, 'not a fresh document');
  return 'restarted';
});

const passed = results.every((r) => r.ok);
document.getElementById('result').textContent = JSON.stringify(results, null, 2);
document.getElementById('status').textContent = passed ? 'PASSED' : 'FAILED';
document.title = `andbox — iframe mode (${passed ? 'PASSED' : 'FAILED'})`;
