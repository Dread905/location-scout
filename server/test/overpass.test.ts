import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overpassQuery } from '../src/sources/overpass.js';

const resp = (status: number, body: string) => new Response(body, { status });

test('overpassQuery: retries a transient status, then falls back to the next mirror', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return url.includes('a.test') ? resp(429, 'busy') : resp(200, '{"elements":[1]}');
  }) as unknown as typeof fetch;
  const out = await overpassQuery<{ elements: number[] }>('q', { mirrors: ['https://a.test/i', 'https://b.test/i'], fetchImpl, retryDelayMs: 0 });
  assert.deepEqual(out.elements, [1]);
  assert.deepEqual(calls, ['https://a.test/i', 'https://a.test/i', 'https://b.test/i']);
});

test('overpassQuery: a 200 with a non-JSON error page counts as a failure; all failing throws with details', async () => {
  const fetchImpl = (async () => resp(200, '<html>runtime error</html>')) as unknown as typeof fetch;
  await assert.rejects(overpassQuery('q', { mirrors: ['https://a.test/i'], fetchImpl, retryDelayMs: 0 }), /Overpass unavailable \(a\.test non-JSON/);
});
