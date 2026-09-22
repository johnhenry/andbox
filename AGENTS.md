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
3. A genuinely fresh clone:
   `git clone . /tmp/andbox-verifyN && cd $_ && npm ci && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs
   (missing files in `package.json`'s `files`, undeclared deps).
4. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs `npm ci` then `npm test`; match it
locally.

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
for this package; the README documents these as the reason to pair andbox
with OS-level isolation instead of treating it as one.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry, merge,
then `gh release create v<version>` -- the release event triggers
`.github/workflows/publish.yml`, which is idempotent (skips if the version is
already on npm).
