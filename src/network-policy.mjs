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
    // Fetch with redirect: 'manual' so an allowlisted host can't silently
    // redirect the request to a non-allowlisted host (SSRF via redirect).
    // We don't re-validate and follow the redirect target -- we just reject
    // it outright, since that's the safer default and callers can retry
    // against the redirect target explicitly if they trust it.
    const response = await realFetch(url, { ...init, redirect: 'manual' });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new Error(
        `Network access denied: ${hostname} attempted to redirect the request; redirects are not followed by the network policy`
      );
    }
    return response;
  };
}
