/**
 * Unguessable id (a v4-UUID-shaped string) that works in insecure contexts.
 *
 * `crypto.randomUUID()` exists only in secure contexts, and a Blob Worker
 * created by an opaque-origin frame (or any page served over plain http) is
 * not one (andbox#55). `crypto.getRandomValues()` is available everywhere, so
 * use it when `randomUUID` is missing.
 *
 * Stringified into worker/frame runtimes with `toString()`, so it must stay
 * self-contained: no references to anything outside its own body.
 */
export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('andbox needs crypto.getRandomValues to mint unguessable ids');
  }
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
    s += (b[i] + 0x100).toString(16).slice(1);
  }
  return s;
}
