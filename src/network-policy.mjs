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

// ── createSandbox({ network }) (andbox#39) ──

const NETWORK_KEYS = new Set(['fetch', 'allowedHosts', 'credentials']);
const CREDENTIALS = ['omit', 'same-origin', 'include'];
const REDIRECTS = ['follow', 'error', 'manual'];
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Response header names the sandbox never sees (a browser's fetch hides them too). */
const HIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function headerPairs(headers) {
  const out = [];
  for (const [name, value] of headers) {
    if (!HIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) out.push([name, value]);
  }
  return out;
}

async function bodyToArrayBuffer(body) {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body).buffer;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  if (typeof body.arrayBuffer === 'function') return body.arrayBuffer(); // Blob
  throw new TypeError('network.fetch: a returned body must be a string, ArrayBuffer, typed array or Blob');
}

/**
 * Turn what the host function returned (a `Response`, or a plain
 * `{ status, statusText, headers, body, url, redirected }`) into the reply the
 * sandbox rebuilds its `Response` from.
 */
async function toWireResponse(res, requestURL) {
  if (res === null || typeof res !== 'object') {
    throw new TypeError('network.fetch must return a Response or { status, statusText, headers, body }');
  }
  const isResponse = typeof res.arrayBuffer === 'function' && res.headers && typeof res.headers.get === 'function';
  if (isResponse && (res.type === 'opaqueredirect' || res.type === 'error' || res.type === 'opaque')) {
    throw new TypeError(`the host's fetch returned an unreadable '${res.type}' response`);
  }
  const status = res.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new TypeError(`the host's fetch returned status ${String(status)}; a response needs 200-599`);
  }
  return {
    status,
    statusText: typeof res.statusText === 'string' ? res.statusText : '',
    headers: headerPairs(isResponse ? res.headers : new Headers(res.headers ?? undefined)),
    body: isResponse ? await res.arrayBuffer() : await bodyToArrayBuffer(res.body),
    url: typeof res.url === 'string' && res.url ? res.url : requestURL,
    redirected: res.redirected === true,
  };
}

/**
 * Validate `createSandbox({ network })` and build the host-side `fetch`
 * capability behind the sandbox's global `fetch` shim.
 *
 * Everything that arrives from the sandbox is treated as untrusted input
 * (evaluated code can also call `host.call('fetch', url, init)` directly):
 * the URL must be http(s), only method/headers/body/redirect are taken from
 * the request, and `credentials` and `signal` are always set by the host.
 *
 * @param {{ fetch?: Function, allowedHosts?: string[], credentials?: RequestCredentials }} network
 * @returns {(this: { signal?: AbortSignal }, url: unknown, init?: unknown) => Promise<object>}
 */
export function createFetchCapability(network) {
  if (network === null || typeof network !== 'object' || Array.isArray(network)) {
    throw new TypeError('network must be an object: { fetch?, allowedHosts?, credentials? }');
  }
  for (const key of Object.keys(network)) {
    if (!NETWORK_KEYS.has(key)) {
      throw new TypeError(`network.${key} is not a known option (expected fetch, allowedHosts, credentials)`);
    }
  }
  const { fetch: hostFetch, allowedHosts, credentials = 'omit' } = network;
  if (hostFetch !== undefined && typeof hostFetch !== 'function') {
    throw new TypeError('network.fetch must be a function (url, init) => Response');
  }
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || !allowedHosts.every((h) => typeof h === 'string' && h.length > 0)) {
      throw new TypeError('network.allowedHosts must be an array of hostname strings');
    }
    if (allowedHosts.length === 0) {
      throw new TypeError('network.allowedHosts must list at least one host; to give the sandbox no network, omit `network`');
    }
  }
  if (hostFetch === undefined && allowedHosts === undefined) {
    throw new TypeError('network needs `fetch` (a host function) and/or `allowedHosts`');
  }
  if (!CREDENTIALS.includes(credentials)) {
    throw new TypeError(`network.credentials must be one of ${CREDENTIALS.map((c) => `'${c}'`).join(', ')}`);
  }

  const send = allowedHosts ? createNetworkFetch(allowedHosts, hostFetch) : hostFetch;

  return async function fetchCapability(url, init) {
    if (typeof url !== 'string') throw new TypeError('fetch: the URL must be a string');
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new TypeError(`fetch: invalid URL: ${url}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new TypeError(`fetch: only http(s) URLs are allowed (got ${target.protocol})`);
    }
    const req = init === undefined || init === null ? {} : init;
    if (typeof req !== 'object') throw new TypeError('fetch: init must be an object');

    const method = req.method ?? 'GET';
    if (typeof method !== 'string' || !METHOD_TOKEN.test(method)) throw new TypeError('fetch: invalid method');
    const pairs = req.headers ?? [];
    if (!Array.isArray(pairs) || !pairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'string'))) {
      throw new TypeError('fetch: headers must be an array of [name, value] string pairs');
    }
    let body;
    if (req.body !== undefined && req.bodyBase64 !== undefined) throw new TypeError('fetch: body and bodyBase64 are exclusive');
    if (req.body !== undefined) {
      if (typeof req.body !== 'string') throw new TypeError('fetch: body must be a string (binary goes in bodyBase64)');
      body = req.body;
    } else if (req.bodyBase64 !== undefined) {
      if (typeof req.bodyBase64 !== 'string') throw new TypeError('fetch: bodyBase64 must be a string');
      body = decodeBase64(req.bodyBase64);
    }
    if (req.redirect !== undefined && !REDIRECTS.includes(req.redirect)) throw new TypeError('fetch: invalid redirect mode');

    const hostInit = {
      method,
      headers: new Headers(pairs),
      ...(body !== undefined ? { body } : {}),
      ...(req.redirect !== undefined ? { redirect: req.redirect } : {}),
      // Always the host's choice; nothing from the sandbox can change it.
      credentials,
      ...(this?.signal ? { signal: this.signal } : {}),
    };
    // Called without a `this`, so the platform's own fetch can be passed as
    // network.fetch (it throws "Illegal invocation" on any other receiver).
    const res = await send(target.href, hostInit);
    return toWireResponse(res, target.href);
  };
}
