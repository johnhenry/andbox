import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWithImportMap } from '../src/import-map-resolver.mjs';

describe('resolveWithImportMap', () => {
  it('resolves exact bare specifier', () => {
    const map = { imports: { zod: 'https://esm.sh/zod@3' } };
    assert.equal(resolveWithImportMap('zod', map), 'https://esm.sh/zod@3');
  });

  it('resolves prefix match (trailing slash)', () => {
    const map = { imports: { 'lodash/': 'https://esm.sh/lodash-es/' } };
    assert.equal(
      resolveWithImportMap('lodash/debounce', map),
      'https://esm.sh/lodash-es/debounce'
    );
  });

  it('returns null for unmatched specifier', () => {
    const map = { imports: { zod: 'https://esm.sh/zod@3' } };
    assert.equal(resolveWithImportMap('unknown', map), null);
  });

  it('prefers longest prefix match', () => {
    const map = {
      imports: {
        'a/': 'https://short/',
        'a/b/': 'https://long/',
      },
    };
    assert.equal(resolveWithImportMap('a/b/c', map), 'https://long/c');
  });

  it('resolves scoped imports with parentURL', () => {
    const map = {
      imports: { zod: 'https://esm.sh/zod@3' },
      scopes: {
        'https://example.com/app/': { zod: 'https://esm.sh/zod@4' },
      },
    };
    assert.equal(
      resolveWithImportMap('zod', map, 'https://example.com/app/index.js'),
      'https://esm.sh/zod@4'
    );
  });

  it('falls through scopes to top-level imports', () => {
    const map = {
      imports: { zod: 'https://esm.sh/zod@3' },
      scopes: {
        'https://other.com/': { other: 'https://esm.sh/other' },
      },
    };
    assert.equal(
      resolveWithImportMap('zod', map, 'https://example.com/app/index.js'),
      'https://esm.sh/zod@3'
    );
  });

  it('handles null/empty import map', () => {
    assert.equal(resolveWithImportMap('zod', null), null);
    assert.equal(resolveWithImportMap('zod', {}), null);
  });
});
