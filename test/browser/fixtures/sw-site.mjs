// A small multi-file site for service-worker-opaque.spec.mjs: served by
// `mode: 'service-worker'` under /virtual/. The page reports back to its
// parent with postMessage once its subresources have had time to arrive.
export const files = {
  '/virtual/index.html': {
    contentType: 'text/html',
    body: `<!doctype html><script>parent.postMessage({ beacon: 'document ran' }, '*')</script>
<link rel="stylesheet" href="style.css"><body>
<script src="classic.js"></script>
<script type="module" src="module.mjs"></script>
<script>
  Promise.all([
    fetch('/virtual/data.json').then((r) => r.text()).catch((e) => 'ERR ' + e.name),
    new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('ERR'); i.src = '/virtual/pixel.svg'; }),
  ]).then(([fetched, image]) => setTimeout(() => {
    let hostReadable;
    try { hostReadable = typeof parent.document.title === 'string'; } catch { hostReadable = false; }
    parent.postMessage({
      origin: String(location.origin),
      classic: self.classicLoaded === true,
      module: self.moduleLoaded === true,
      css: getComputedStyle(document.body).color,
      fetched, image, hostReadable,
    }, '*');
  }, 400));
</script></body>`,
  },
  '/virtual/style.css': { contentType: 'text/css', body: 'body { color: rgb(1, 2, 3) }' },
  '/virtual/classic.js': { contentType: 'text/javascript', body: 'self.classicLoaded = true;' },
  '/virtual/module.mjs': { contentType: 'text/javascript', body: 'self.moduleLoaded = true;' },
  '/virtual/data.json': { contentType: 'application/json', body: '{"served":"by the service worker"}' },
  '/virtual/pixel.svg': { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' },
};
