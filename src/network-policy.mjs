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

// ── allowedHosts: required, three forms (andbox#43) ──

/** The explicit opt-in for "any http(s) host; my `fetch` is the whole policy". */
const ANY_HOST = '*';

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Request headers that describe the body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

const ALLOWED_HOSTS_EXAMPLE =
  "  network: { allowedHosts: ['api.example.com'] }                     // only these hosts\n" +
  '  network: { fetch, allowedHosts: (url) => policy.allows(url.host) } // decided per request\n' +
  "  network: { fetch, allowedHosts: '*' }                              // any host: your fetch is the whole policy";

const ENTRY_HINT =
  "entries are hostnames without a scheme, port, path or wildcard, e.g. 'api.example.com', '127.0.0.1', '[::1]'";

/**
 * Normalise one `allowedHosts` array entry to the form `URL#hostname` has
 * (lowercase, punycode, canonical IPv4, bracketed IPv6), so it can be
 * compared with a request URL's hostname. Throws on anything that would
 * silently never match (a port, a scheme, a path, a wildcard).
 */
function normalizeHostEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new TypeError(`network.allowedHosts: ${ENTRY_HINT} (got ${JSON.stringify(entry)})`);
  }
  if (entry === ANY_HOST) {
    throw new TypeError("network.allowedHosts: to allow any host pass the string '*' itself, not inside an array");
  }
  const bare = entry.startsWith('[') ? entry.replace(/^\[[^\]]*\]/, '') : entry;
  if (/[/?#@\s*\\]/.test(entry) || bare.includes(':')) {
    throw new TypeError(`network.allowedHosts: ${ENTRY_HINT} (got '${entry}')`);
  }
  let hostname;
  try {
    hostname = new URL(`http://${entry}/`).hostname;
  } catch {
    throw new TypeError(`network.allowedHosts: '${entry}' is not a valid hostname; ${ENTRY_HINT}`);
  }
  return hostname;
}

/**
 * Validate `createSandbox({ network })` without building anything, so
 * `createSandbox()` can refuse a bad option before it starts a Worker.
 *
 * @returns {{ hostFetch?: Function, allowedHosts: string[] | '*' | ((url: URL) => unknown), credentials: RequestCredentials }}
 */
export function validateNetworkOptions(network) {
  if (network === null || typeof network !== 'object' || Array.isArray(network)) {
    throw new TypeError('network must be an object: { allowedHosts, fetch?, credentials? }');
  }
  for (const key of Object.keys(network)) {
    if (!NETWORK_KEYS.has(key)) {
      throw new TypeError(`network.${key} is not a known option (expected allowedHosts, fetch, credentials)`);
    }
  }
  const { fetch: hostFetch, allowedHosts, credentials = 'omit' } = network;
  if (hostFetch !== undefined && typeof hostFetch !== 'function') {
    throw new TypeError('network.fetch must be a function (url, init) => Response');
  }
  if (allowedHosts === undefined) {
    throw new TypeError(
      'network.allowedHosts is required: the sandbox gets no network unless you say which hosts it may reach. ' +
      `For example:\n${ALLOWED_HOSTS_EXAMPLE}`
    );
  }
  let hosts;
  if (allowedHosts === ANY_HOST || typeof allowedHosts === 'function') {
    hosts = allowedHosts;
  } else if (Array.isArray(allowedHosts)) {
    if (allowedHosts.length === 0) {
      throw new TypeError(
        'network.allowedHosts must list at least one host; to give the sandbox no network, omit `network`. ' +
        `For example:\n${ALLOWED_HOSTS_EXAMPLE}`
      );
    }
    hosts = [...new Set(allowedHosts.map(normalizeHostEntry))];
  } else {
    throw new TypeError(
      "network.allowedHosts must be an array of hostnames, a function (url: URL) => boolean, or '*' " +
      `(got ${typeof allowedHosts === 'string' ? `'${allowedHosts}'` : typeof allowedHosts}). For example:\n${ALLOWED_HOSTS_EXAMPLE}`
    );
  }
  if (!CREDENTIALS.includes(credentials)) {
    throw new TypeError(`network.credentials must be one of ${CREDENTIALS.map((c) => `'${c}'`).join(', ')}`);
  }
  return { hostFetch, allowedHosts: hosts, credentials };
}

/** The host's fetch, or the platform's, called without a `this`. */
function resolveFetch(hostFetch) {
  if (hostFetch) return (url, init) => hostFetch(url, init);
  return (url, init) => {
    const platformFetch = globalThis.fetch;
    if (typeof platformFetch !== 'function') throw new Error('fetch is not available');
    return platformFetch.call(globalThis, url, init);
  };
}

async function askPolicy(policy, href) {
  // A fresh URL each time: the policy cannot change the URL andbox requests.
  const verdict = await policy(new URL(href));
  if (verdict !== true) {
    throw new Error(`Network access denied: ${new URL(href).host} is not allowed by network.allowedHosts`);
  }
}

function responseHeaders(res) {
  if (res?.headers && typeof res.headers.get === 'function') return res.headers;
  try {
    return new Headers(res?.headers ?? undefined);
  } catch {
    return new Headers();
  }
}

function discardBody(res) {
  try {
    res?.body?.cancel?.().catch(() => {});
  } catch {
    // nothing to release
  }
}

/**
 * `allowedHosts` as a function: ask it about every URL andbox is about to
 * request, the first one and every redirect hop. Redirects are followed by
 * andbox itself (`redirect: 'manual'` underneath), re-asking the function for
 * each `Location`, with the Fetch standard's method/body rewriting and
 * `Authorization` dropped on a cross-origin hop. Where the platform hides the
 * target (a browser's `opaqueredirect`), the request fails closed.
 */
function createPolicyFetch(policy, hostFetch) {
  const send = resolveFetch(hostFetch);
  return async function policyFetch(url, init) {
    const { body: firstBody, headers: firstHeaders, method: firstMethod, ...rest } = init;
    const mode = init.redirect ?? 'follow';
    let href = url;
    let method = firstMethod;
    let headers = new Headers(firstHeaders);
    let body = firstBody;
    for (let hop = 0; ; hop++) {
      await askPolicy(policy, href);
      const res = await send(href, {
        ...rest,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
      });
      if (mode === 'manual') return res;
      if (res?.type === 'opaqueredirect') {
        throw new Error(
          `Network access denied: ${new URL(href).host} answered with a redirect whose target this platform's fetch hides, ` +
          "so network.allowedHosts cannot check it; pass a network.fetch that returns the redirect response, or use allowedHosts: '*'"
        );
      }
      const location = REDIRECT_STATUSES.has(res?.status) ? responseHeaders(res).get('location') : null;
      if (location === null) {
        if (hop === 0) return res;
        return { status: res.status, statusText: res.statusText, headers: responseHeaders(res), body: await readBody(res), url: href, redirected: true };
      }
      discardBody(res);
      if (mode === 'error') throw new Error(`fetch: ${new URL(href).host} redirected and the request's redirect mode is 'error'`);
      if (hop + 1 > MAX_REDIRECTS) throw new Error(`fetch: more than ${MAX_REDIRECTS} redirects`);
      let next;
      try {
        next = new URL(location, href);
      } catch {
        throw new Error(`fetch: ${new URL(href).host} redirected to an invalid URL`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`Network access denied: ${new URL(href).host} redirected to a ${next.protocol} URL`);
      }
      const status = res.status;
      if ((status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = new Headers(headers);
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      if (next.origin !== new URL(href).origin) {
        headers = new Headers(headers);
        headers.delete('authorization');
      }
      href = next.href;
    }
  };
}

async function readBody(res) {
  if (res == null) return null;
  if (typeof res.arrayBuffer === 'function') return res.arrayBuffer();
  return res.body ?? null;
}

/**
 * The host-side sender for a validated `network`: the policy in front of the
 * host's (or the platform's) fetch.
 */
function createNetworkSender({ hostFetch, allowedHosts }) {
  if (allowedHosts === ANY_HOST) return resolveFetch(hostFetch);
  if (typeof allowedHosts === 'function') return createPolicyFetch(allowedHosts, hostFetch);
  return createNetworkFetch(allowedHosts, hostFetch);
}

/**
 * Validate `createSandbox({ network })` and build the host-side `fetch`
 * capability behind the sandbox's global `fetch` shim.
 *
 * Everything that arrives from the sandbox is treated as untrusted input
 * (evaluated code can also call `host.call('fetch', url, init)` directly):
 * the URL must be http(s) and pass `allowedHosts` before the host's `fetch`
 * is called, only method/headers/body/redirect are taken from the request,
 * and `credentials` and `signal` are always set by the host.
 *
 * @param {{ allowedHosts: string[] | '*' | ((url: URL) => boolean | Promise<boolean>), fetch?: Function, credentials?: RequestCredentials }} network
 * @returns {(this: { signal?: AbortSignal }, url: unknown, init?: unknown) => Promise<object>}
 */
export function createFetchCapability(network) {
  const options = validateNetworkOptions(network);
  const { credentials } = options;
  const send = createNetworkSender(options);

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
