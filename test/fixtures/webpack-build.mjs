// Bundle src/index.mjs for the browser with webpack 5; print JSON { ok, errors, warnings, size }.
import webpack from 'webpack';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'andbox-webpack-'));
const compiler = webpack({
  mode: 'production',
  target: 'web',
  context: root,
  entry: './src/index.mjs',
  output: { path: out, filename: 'out.js', library: { type: 'module' } },
  experiments: { outputModule: true },
});
compiler.run((err, stats) => {
  if (err) { console.log(JSON.stringify({ ok: false, errors: [String(err)], warnings: [], out })); process.exit(0); }
  const j = stats.toJson({ all: false, errors: true, warnings: true });
  console.log(JSON.stringify({
    ok: !stats.hasErrors(),
    errors: j.errors.map((e) => e.message),
    warnings: j.warnings.map((e) => e.message),
    out,
  }));
  compiler.close(() => {});
});
