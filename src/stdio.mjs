/**
 * Async iterable stdout/stderr streams for sandbox console output.
 */

/**
 * Create an async iterable stdio stream.
 * Push messages via `push()`, close via `end()`.
 *
 * @returns {{ push: (msg: string) => void, end: () => void, stream: AsyncIterable<string> }}
 */
export function createStdio() {
  const buffer = [];
  let resolve = null;
  let done = false;

  function push(msg) {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  }

  function end() {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined, done: true });
    }
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(r => { resolve = r; });
        },
        return() {
          done = true;
          buffer.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { push, end, stream };
}
