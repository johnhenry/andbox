/**
 * Engine entry for `mode: 'wasm'` (andbox#21).
 *
 * This is the module the Worker `import()`s to get QuickJS-ng. It re-exports
 * exactly what the Worker needs from the two OPTIONAL peer dependencies
 * (`quickjs-emscripten-core` and `@jitl/quickjs-ng-wasmfile-release-sync`,
 * both pinned to an exact version).
 *
 * Under Node, andbox imports this file directly. In a browser, bundle it into
 * one same-origin ES module and serve it next to the `.wasm` file -- see the
 * README's "mode: 'wasm'" section -- then pass `engineURL` and `wasmURL`:
 *
 *   npx esbuild node_modules/@johnhenry/andbox/src/wasm-engine.mjs \
 *     --bundle --format=esm --minify --outfile=public/andbox-quickjs.mjs
 *
 * Nothing here is imported by the main entry (`src/index.mjs`), so the
 * default entry stays dependency-free.
 */
export { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
export { default as variant } from '@jitl/quickjs-ng-wasmfile-release-sync';
