// Bundle src/index.mjs for the browser with Vite (Rollup); print JSON { ok, errors, warnings, out }.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'andbox-vite-'));
const warnings = [];
try {
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      lib: { entry: 'src/index.mjs', formats: ['es'], fileName: 'out' },
      rollupOptions: { onwarn: (w) => warnings.push(w.message) },
    },
  });
  console.log(JSON.stringify({ ok: true, errors: [], warnings, out }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, errors: [String(e?.message ?? e)], warnings, out }));
}
