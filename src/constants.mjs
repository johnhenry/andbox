/**
 * Default constants for andbox sandboxes.
 */

/** Default timeout for evaluate() in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default resource limits. */
export const DEFAULT_LIMITS = Object.freeze({
  /** Max capability calls per sandbox lifetime (0 = unlimited). */
  maxCalls: 0,
  /** Max total argument bytes across all calls (0 = unlimited). */
  maxArgBytes: 0,
  /** Max concurrent pending capability calls. */
  maxConcurrent: 16,
});

/** Default per-capability limits. */
export const DEFAULT_CAPABILITY_LIMITS = Object.freeze({
  /** Max argument bytes for a single call to this capability. */
  maxArgBytes: 0,
  /** Max calls to this specific capability (0 = unlimited). */
  maxCalls: 0,
});
