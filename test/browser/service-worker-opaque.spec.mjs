// andbox#60: does `mode: 'service-worker'` serve a multi-file site to the
// frame that `mode: 'iframe'` uses (`<iframe sandbox="allow-scripts">`, an
// opaque origin)? Measured answer: no. A Service Worker only sees navigations
// and subresource requests of clients that have a real origin, so a sandboxed
// frame's navigation goes straight to the network. What works is a *dedicated
// sandbox origin*: a second origin that registers the Service Worker for
// itself and is framed cross-origin. README ("Serving a multi-file site to a
// sandboxed frame") states the result; these tests pin it.
//
// Measured in Chromium and Firefox. WebKit does not launch on every dev
// machine (missing system libraries), so the file is skipped there until it
// has been measured.
import { test, expect } from '@playwright/test';
import { files } from './fixtures/sw-site.mjs';

test.setTimeout(90_000); // Firefox starts slowly on a loaded machine
test.skip(({ browserName }) => browserName === 'webkit', 'not measured in WebKit');

const PORT = Number(process.env.ANDBOX_TEST_PORT) || 47391;
// Same server, different origin: localhost vs the page's 127.0.0.1.
const OTHER_ORIGIN = `http://localhost:${PORT}`;

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ready === true);
});

/** Embed `src` in an iframe with `sandboxAttr` (null: no attribute); resolve with the site's report. */
function frameReport(page, src, sandboxAttr) {
  return page.evaluate(async ([src, attr]) => {
    const frame = document.createElement('iframe');
    if (attr !== null) frame.setAttribute('sandbox', attr);
    const report = new Promise((resolve) => {
      addEventListener('message', (e) => {
        if (e.source !== frame.contentWindow || e.data?.beacon) return;
        resolve(e.data);
      });
      setTimeout(() => resolve("no report"), 4000);
    });
    frame.src = src;
    document.body.append(frame);
    const out = await report;
    frame.remove();
    return out;
  }, [src, sandboxAttr]);
}

/** Register the Service Worker in the host page's own origin, run `fn`, unregister. */
async function withHostServiceWorker(page, fn) {
  await page.evaluate(async (files) => {
    window.sw = await window.andbox.createSandbox({ mode: 'service-worker', scriptURL: '/andbox-sw.js', scope: '/virtual/', files });
  }, files);
  try {
    return await fn();
  } finally {
    await page.evaluate(() => window.sw.dispose());
  }
}

const WHOLE_SITE = { classic: true, module: true, css: 'rgb(1, 2, 3)', fetched: '{"served":"by the service worker"}', image: 'ok' };

test('baseline: a same-origin frame gets the whole served site', async ({ page }) => {
  const r = await withHostServiceWorker(page, () => frameReport(page, '/virtual/index.html', null));
  expect(r).toMatchObject(WHOLE_SITE);
});

test('an opaque-origin frame (sandbox="allow-scripts") is NOT served by the host-origin Service Worker', async ({ page }) => {
  const navigations = [];
  page.on('response', (res) => {
    if (res.url().endsWith('/virtual/index.html')) navigations.push({ status: res.status(), fromServiceWorker: res.fromServiceWorker() });
  });
  const r = await withHostServiceWorker(page, () => frameReport(page, '/virtual/index.html', 'allow-scripts'));
  // The navigation never reached the worker: it went to the network, where the path does not exist.
  expect(navigations).toEqual([{ status: 404, fromServiceWorker: false }]);
  expect(r).toBe('no report');
});

test('a dedicated sandbox origin serves the whole site, and the host page stays out of reach', async ({ page }) => {
  // The other origin registers the Service Worker for itself (sw-origin.html), then shows the site.
  const r = await frameReport(page, `${OTHER_ORIGIN}/test/browser/sw-origin.html`, 'allow-scripts allow-same-origin');
  expect(r).toMatchObject({ ...WHOLE_SITE, origin: OTHER_ORIGIN, hostReadable: false });
});
