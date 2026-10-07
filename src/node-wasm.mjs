/**
 * Node-only helper for `mode: 'wasm'`: locate the engine entry and the `.wasm`
 * file from the installed optional peer dependencies. Loaded with a
 * non-literal dynamic `import()` (see sandbox.mjs) so browser bundles never
 * follow it.
 */

const INSTALL_HINT =
  "mode: 'wasm' needs the optional engine packages. Install them with:\n" +
  '  npm install --save-exact quickjs-emscripten-core@0.32.0 @jitl/quickjs-ng-wasmfile-release-sync@0.32.0';

/**
 * @returns {{ engineURL: string, wasmURL: string }} `file:` URLs.
 * @throws {Error} with an install hint when the packages are missing.
 */
export function resolveNodeWasmEngine() {
  try {
    import.meta.resolve('quickjs-emscripten-core');
    const wasmURL = import.meta.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm');
    return { engineURL: new URL('./wasm-engine.mjs', import.meta.url).href, wasmURL };
  } catch (e) {
    const err = new Error(`${INSTALL_HINT}\n(${e?.message ?? e})`);
    err.code = 'ERR_ANDBOX_ENGINE_MISSING';
    throw err;
  }
}
