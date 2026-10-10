# Agent playbook

`@johnhenry/andbox` -- a separate-context JavaScript runtime with Worker
isolation, RPC capabilities, import maps, and timeouts. Single package,
Node >= 26, `node --test` (`npm test`), ships source directly -- no build
step, no `dist/`. Zero runtime dependencies; the library is browser code
(Web Workers, Blob URLs, `BroadcastChannel`-adjacent APIs), so Node only
runs the parts of it that don't require a real `Worker` global -- see
`examples/README.md`'s "Runtime requirements" section for exactly which
modes that excludes.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm test` -- `node --test test/*.test.mjs`. Worker-mode (`mode: 'worker'`)
   and Service-Worker-mode (`mode: 'service-worker'`) behavior is exercised
   through the pure logic modules (`resolveServiceWorkerResponse()`, the
   virtual-module-registry resolution logic) rather than a real browser --
   there is no headless-browser step in this repo's test suite, so a change
   to `src/worker-source.mjs` or `src/service-worker-source.mjs` string
   templates has no automated coverage of their actual runtime behavior in a
   Worker; verify those by hand in a browser before relying on CI green.
2. `npm run examples` -- runs examples 01-05 in sequence (see
   `examples/README.md`); each is self-verifying and exits non-zero on
   failure. Example 06 (`service-worker` mode) is deliberately excluded --
   it needs a real browser and is not part of this script or CI.
3. `npm run test:browser` -- Playwright (`playwright.config.mjs`,
   `test/browser/*.spec.mjs`) in Chromium, Firefox and WebKit; the only
   automated coverage of `mode: 'iframe'`, which needs a real DOM, and of a
   real browser Worker (`network-fetch.spec.mjs` runs the `network` fetch
   shim in both). First run:
   `npx playwright install chromium firefox webkit`. The suite serves the repo
   with `test/browser/serve.mjs` on port 47391 (`ANDBOX_TEST_PORT` overrides).
   `npm run example:09:headless` runs the iframe demo the same way.
4. A genuinely fresh clone:
   `git clone . /tmp/andbox-verifyN && cd $_ && npm ci && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs
   (missing files in `package.json`'s `files`, undeclared deps).
5. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs `npm install`, `npm test`,
`npm run examples`, then installs the Playwright browsers and runs
`npm run test:browser`; match it locally.

## Repo-specific gotchas

- **A registered path containing `#` or `?` used to be silently truncated.**
  `createVirtualModuleRegistry()`'s relative-path resolution parsed each
  path segment against a synthetic base URL without percent-encoding it
  first, so `#`/`?` were read as that URL's own fragment/query delimiters
  and everything after them was dropped. Fixed by percent-encoding each
  path segment before resolution -- see `CHANGELOG.md` `0.0.2` and
  [andbox#13](https://github.com/johnhenry/andbox/issues/13). Any new
  path-handling code in the registry must encode before building a URL,
  not after.
- **A Service Worker registration that becomes `'redundant'` used to hang
  forever.** `createSandbox({ mode: 'service-worker' })`'s activation wait
  only listened for `'activated'`; a registration whose install/activate
  threw, or that failed to parse, became `'redundant'` instead and the
  promise never settled. It now rejects on `'redundant'` and is bounded by
  `timeoutMs` as defense in depth -- see `CHANGELOG.md` `0.0.2` and
  [andbox#14](https://github.com/johnhenry/andbox/issues/14). Any new wait
  on Service Worker state needs an explicit `'redundant'` (or equivalent
  terminal-failure) branch, not just a happy-path listener.
- **Don't add a capability gate escape without re-reading `## Security
  model` first.** `gateCapabilities()` deliberately builds its gated object
  with `Object.create(null)` (closes [andbox#5](https://github.com/johnhenry/andbox/issues/5)) --
  any refactor that reintroduces a plain `{}` object reopens the
  prototype-chain bypass this fixed.

- **`network` must never mean "every host" by default.** Until 0.2.0,
  `network: { fetch }` alone let the sandbox reach whatever the host function
  would fetch; `allowedHosts` is now required (list, function, or the explicit
  `'*'`), validated in `validateNetworkOptions()` synchronously in
  `createSandbox()` before anything starts
  ([andbox#43](https://github.com/johnhenry/andbox/issues/43)). A function
  policy follows redirects hop by hop with `redirect: 'manual'` and must fail
  closed on an `opaqueredirect` (what a browser's `fetch` returns): never
  "fix" that by letting the platform follow and checking only the final URL,
  which would already have contacted the intermediate hosts.

- **`mode: 'wasm'` runs QuickJS, not the Worker's engine.** Its worker script
  (`src/wasm-worker-source.mjs`) is a real function stringified with
  `toString()`, so it must stay free of outside references. The memory limit
  of this QuickJS build only counts allocation blocks (no `malloc_usable_size`),
  which is why the heap check in the interrupt handler and the hard cap on the
  engine's `WebAssembly.Memory` exist; do not "simplify" them away. Stack caps
  above ~192 KiB overflow the *host* stack in a Chrome Worker.
  `examples/08-wasm-browser/run-headless.mjs` is the only real-browser check.

- **`mode: 'iframe'` must not register `pagehide`/`unload` listeners in the
  frame.** In Chromium they are sudden-termination disablers: the browser
  then waits for the handler before shutting the frame's process down, so a
  frame killed mid `while (true) {}` kept its (shared, per-site) renderer
  hung for seconds and the replacement frame's startup timed out. Navigation
  is detected on the host side from the element's second `load` event
  instead (`src/iframe-host.mjs`; `test/iframe-mode.test.mjs` asserts the
  srcdoc has no such listener). Chrome also groups all sandboxed frames of a
  site into one process: a looping frame can only be killed when no other
  sandboxed frame of the site is alive, which is why the sync-loop browser
  test disposes its probe sandbox first.

- **Bridges (`src/bridge-client.mjs`, `src/bridge-host.mjs`) have two halves
  that must stay in step.** The client is stringified into the runtime like
  `installNetworkFetch`, so it must not reference anything outside its body; a
  bridge definition's `client` adapter has the same rule. Every host object a
  session holds must be released in `session.close()`, which
  `terminateWorker()` calls: a new path that creates handles, streams or
  callbacks needs its cleanup there, and a test in `test/bridges.test.mjs`
  that disposes/restarts mid-flight. `test/browser/bridges.spec.mjs` is the
  only coverage of the iframe runtime's bridge client, and Playwright's
  `page.evaluate()` runs with a user gesture, so activation tests use
  `test/browser/bridges-activation.html` instead.

## Definition of done

A change is done when all of the following hold, not just when tests pass:
- A regression test exists for any bug fixed -- fixing a bug without a test
  that would have caught it means it can come back unnoticed (see the two
  gotchas above, both of which now have dedicated tests).
- Anything the feature does **not** do is stated in the README's
  `## Security model` or `## Honest limitations`-shaped caveats, not only in
  an issue comment.
- `CHANGELOG.md` has an entry citing the commit/PR or the closed issue.
- If the change affects `examples/`, `examples/README.md`'s table and the
  `examples` / `example:NN` scripts stay in sync with the files that exist.

## Non-goals

andbox is deliberately not a security sandbox against adversarial code --
see `## Security model` in the README. Adding OS-level isolation, a
Realms/Compartments-based execution strategy, or a general capability
system that closes every item under "What is still yours" is out of scope
for this package (the optional `mode: 'wasm'`, QuickJS in WebAssembly, is the
one stronger strategy that exists, and its limits are in the README's threat
model); the README documents these as the reason to pair andbox
with OS-level isolation instead of treating it as one.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry, merge,
then `gh release create v<version>` -- the release event triggers
`.github/workflows/publish.yml`, which is idempotent (skips if the version is
already on npm).
