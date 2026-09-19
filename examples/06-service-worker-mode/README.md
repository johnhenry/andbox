# 06 — Service Worker mode demo

Demonstrates `createSandbox({ mode: 'service-worker' })` (andbox#14): a
Service Worker, backed by an in-memory `path → content` map, serving
synthesized `Response`s for requests inside its scope and falling
everything else through to the network -- real HTTP-shaped navigation into
in-memory content, no `blob:` URL and no content rewriting required.

## Why this isn't `node examples/06-....mjs` like the others

Examples 01-05 run under plain Node. This one can't: Node has no Service
Worker API at all -- no `navigator.serviceWorker`, no
`ServiceWorkerGlobalScope`, nothing (confirmed by hand; see the doc
comments in `src/service-worker-source.mjs` and `src/service-worker-response.mjs`).
Running this for real needs an actual browser with a Service Worker to
register into. So it's a small static site instead:

- `serve.mjs` -- a minimal, zero-dependency (`node:http`/`node:fs` only)
  static file server. It serves this directory's `index.html`/`main.mjs`,
  the rest of the andbox library under `src/` (so `main.mjs`'s plain
  `import '../../src/index.mjs'` resolves with no bundler), and the
  generated Service Worker script at `/andbox-sw.js` -- produced **live**
  from `makeServiceWorkerSource()` on every request, not hand-copied into
  a static file that could drift out of sync with the real generator.
- `index.html` / `main.mjs` -- registers the Service Worker, defines two
  in-memory pages under `/virtual/`, and points an iframe at one of them.

## Running it

```sh
node examples/06-service-worker-mode/serve.mjs
# then open the printed URL (http://localhost:8787/examples/06-service-worker-mode/)
# in a real browser
```

What to expect: the page registers, the iframe loads
`/virtual/hello.html` -- a path that does not exist on `serve.mjs`'s
filesystem at all -- served entirely from the in-memory file map. The
"check pass-through" button fetches a path that's genuinely absent from
the map and shows the dev server's own real 404, proving the Service
Worker falls through instead of swallowing unknown requests.

## Not wired into `npm run examples`

Every other example is plain-Node-runnable and part of CI's `npm run
examples` smoke test (see `.github/workflows/ci.yml`). This one needs a
real browser and a running local server, so it's deliberately **excluded**
from that script -- `npm run examples` will not touch this directory.

If real Service-Worker-registration testing (not just this manual demo)
is wanted in CI later, that's a genuine, separate infrastructure decision
(a headless-browser test runner like Playwright) outside the scope of the
andbox#14 PR that added this mode -- flagged there as a follow-up, not
silently added here.
