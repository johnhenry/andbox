/**
 * Capability gate — rate-limits and validates host.call() invocations.
 *
 * Wraps a capabilities object with a Proxy that enforces:
 * - Global call count limits
 * - Global argument byte limits
 * - Per-capability call count and argument byte limits
 * - Concurrent call limits
 */

import { DEFAULT_LIMITS, DEFAULT_CAPABILITY_LIMITS } from './constants.mjs';

/**
 * @typedef {Object} GatePolicy
 * @property {{ maxCalls?: number, maxArgBytes?: number, maxConcurrent?: number }} [limits]
 * @property {Record<string, { maxArgBytes?: number, maxCalls?: number }>} [capabilities]
 */

/**
 * Gate capabilities with rate limiting and payload caps.
 *
 * @param {Record<string, Function>} capabilities - Raw capability functions.
 * @param {GatePolicy} [policy] - Rate limit policy.
 * @returns {{ gated: Record<string, Function>, stats: () => object }}
 */
export function gateCapabilities(capabilities, policy = {}) {
  const limits = { ...DEFAULT_LIMITS, ...policy.limits };
  const capPolicies = policy.capabilities || {};

  let totalCalls = 0;
  let totalArgBytes = 0;
  let concurrent = 0;
  const perCap = new Map(); // name -> { calls, argBytes }

  function getCapStats(name) {
    if (!perCap.has(name)) perCap.set(name, { calls: 0, argBytes: 0 });
    return perCap.get(name);
  }

  const gated = {};

  for (const [name, fn] of Object.entries(capabilities)) {
    const capLimits = { ...DEFAULT_CAPABILITY_LIMITS, ...capPolicies[name] };

    gated[name] = async (...args) => {
      // Measure argument bytes
      const argStr = JSON.stringify(args);
      const argBytes = new TextEncoder().encode(argStr).byteLength;

      // Global limits
      if (limits.maxCalls > 0 && totalCalls >= limits.maxCalls) {
        throw new Error(`Global call limit exceeded (${limits.maxCalls})`);
      }
      if (limits.maxArgBytes > 0 && totalArgBytes + argBytes > limits.maxArgBytes) {
        throw new Error(`Global argument byte limit exceeded (${limits.maxArgBytes})`);
      }
      if (limits.maxConcurrent > 0 && concurrent >= limits.maxConcurrent) {
        throw new Error(`Concurrent call limit exceeded (${limits.maxConcurrent})`);
      }

      // Per-capability limits
      const stats = getCapStats(name);
      if (capLimits.maxCalls > 0 && stats.calls >= capLimits.maxCalls) {
        throw new Error(`Capability '${name}' call limit exceeded (${capLimits.maxCalls})`);
      }
      if (capLimits.maxArgBytes > 0 && argBytes > capLimits.maxArgBytes) {
        throw new Error(`Capability '${name}' argument size exceeded (${capLimits.maxArgBytes} bytes)`);
      }

      // Track
      totalCalls++;
      totalArgBytes += argBytes;
      stats.calls++;
      stats.argBytes += argBytes;
      concurrent++;

      try {
        return await fn(...args);
      } finally {
        concurrent--;
      }
    };
  }

  function stats() {
    return {
      totalCalls,
      totalArgBytes,
      concurrent,
      perCapability: Object.fromEntries(perCap),
    };
  }

  return { gated, stats };
}
