/**
 * 03 — Network allowlist blocks unapproved hosts.
 *
 * Demonstrates: createNetworkFetch() produces a fetch you can hand to a
 * sandbox as a capability. Requests to allowlisted hostnames go through;
 * anything else — other hosts, subdomain tricks, malformed URLs — is
 * denied before any network I/O happens.
 *
 * Runs under plain Node. A stub fetch is injected so the example is
 * deterministic and makes no real network requests; drop the second
 * argument to wrap the real globalThis.fetch.
 */

import assert from 'node:assert/strict';
import { createNetworkFetch } from '../src/index.mjs';

// Stub fetch: records what actually got through the policy.
const reached = [];
const stubFetch = async (url) => {
  reached.push(String(url));
  return new Response(`fake response for ${url}`, { status: 200 });
};

const guardedFetch = createNetworkFetch(['api.example.com'], stubFetch);

// 1. Allowlisted host: request goes through.
const res = await guardedFetch('https://api.example.com/v1/data');
assert.equal(res.status, 200);
console.log('allowed :', 'https://api.example.com/v1/data ->', await res.text());

// 2. Any other host is denied — the stub fetch is never invoked.
await assert.rejects(
  () => guardedFetch('https://evil.example.net/exfiltrate'),
  /Network access denied: evil\.example\.net is not in the allowlist/
);
console.log('blocked :', 'https://evil.example.net/exfiltrate');

// 3. Subdomains are NOT implicitly allowed (exact hostname match).
await assert.rejects(
  () => guardedFetch('https://sneaky.api.example.com/'),
  /Network access denied: sneaky\.api\.example\.com/
);
console.log('blocked :', 'https://sneaky.api.example.com/ (subdomain of an allowed host)');

// 4. Malformed URLs are rejected outright.
await assert.rejects(() => guardedFetch('not a url'), /Invalid URL/);
console.log('rejected: "not a url" (malformed)');

// Only the approved request ever touched the underlying fetch.
assert.deepEqual(reached, ['https://api.example.com/v1/data']);
console.log('underlying fetch saw only:', reached);
console.log('OK: unapproved hosts were blocked before any network I/O');
