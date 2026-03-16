/**
 * Network policy — gated fetch with URL allowlist.
 */

/**
 * Create a fetch function that enforces a URL allowlist.
 *
 * @param {string[]} [allowedHosts] - Array of allowed hostnames. If empty/null, all hosts allowed.
 * @param {typeof fetch} [fetchFn] - The fetch implementation to wrap (defaults to globalThis.fetch).
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
 */
export function createNetworkFetch(allowedHosts, fetchFn) {
  const realFetch = fetchFn || globalThis.fetch?.bind(globalThis);

  if (!allowedHosts || allowedHosts.length === 0) {
    return async (url, init) => {
      if (!realFetch) throw new Error('fetch is not available');
      return realFetch(url, init);
    };
  }

  const hostSet = new Set(allowedHosts.map(h => h.toLowerCase()));

  return async (url, init) => {
    if (!realFetch) throw new Error('fetch is not available');
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (!hostSet.has(hostname)) {
      throw new Error(`Network access denied: ${hostname} is not in the allowlist`);
    }
    return realFetch(url, init);
  };
}
