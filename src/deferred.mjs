/**
 * Deferred promise utilities for andbox.
 */

/** Create a deferred promise with external resolve/reject. */
export function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Create an AbortError. */
export function makeAbortError(message = 'Operation aborted') {
  const err = new DOMException(message, 'AbortError');
  return err;
}

/** Create a timeout Error. */
export function makeTimeoutError(ms) {
  const err = new Error(`Sandbox execution timed out after ${ms}ms`);
  err.name = 'TimeoutError';
  return err;
}
