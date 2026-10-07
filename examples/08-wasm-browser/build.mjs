#!/usr/bin/env node
/**
 * 08 — build the same-origin engine assets for `mode: 'wasm'` in a browser.
 *
 * Writes into ./public/:
 *   andbox-quickjs.mjs   the QuickJS engine entry (src/wasm-engine.mjs) bundled into ONE ES module
 *   andbox-quickjs.wasm  the QuickJS-ng WebAssembly binary
 *
 * Both are then served from your own origin, so booting a wasm sandbox needs no CDN.
 * This is the whole recipe; copy it into your own build.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'public');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src/wasm-engine.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  outfile: join(out, 'andbox-quickjs.mjs'),
  logLevel: 'warning',
});

const require = createRequire(import.meta.url);
copyFileSync(
  require.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm'),
  join(out, 'andbox-quickjs.wasm'),
);

for (const f of ['andbox-quickjs.mjs', 'andbox-quickjs.wasm']) {
  console.log(`${f}: ${statSync(join(out, f)).size} bytes`);
}
