// Preload (node --require): model an insecure context, where
// crypto.randomUUID is missing but crypto.getRandomValues works. Worker
// threads inherit the preload, so the sandbox's worker is affected too.
Object.defineProperty(globalThis.crypto.constructor.prototype, 'randomUUID', { value: undefined, configurable: true });
