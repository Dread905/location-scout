import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERPASS_ENDPOINT,
  DEFAULT_OVERPASS_PACE_MS,
  OverpassClient,
  OverpassError,
  resolveOverpassEndpoints,
  resolveOverpassPaceMs,
  validateOverpassEndpoint,
} from '../src/sources/overpass.js';

test('resolveOverpassEndpoints: defaults to canonical endpoint when not configured', () => {
  const endpoints = resolveOverpassEndpoints(undefined, undefined);
  assert.deepEqual(endpoints, [DEFAULT_OVERPASS_ENDPOINT]);
  assert.equal(DEFAULT_OVERPASS_ENDPOINT, 'https://overpass-api.de/api/interpreter');
});

test('resolveOverpassEndpoints: parses ordered comma-separated list and trims whitespace', () => {
  const raw = '  https://overpass-api.de/api/interpreter , https://maps.mail.ru/osm/tools/overpass/api/interpreter  ';
  const endpoints = resolveOverpassEndpoints(raw, undefined);
  assert.deepEqual(endpoints, [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ]);
});

test('resolveOverpassEndpoints: ignores empty entries in list', () => {
  const raw = 'https://overpass-api.de/api/interpreter, , https://maps.mail.ru/osm/tools/overpass/api/interpreter,';
  const endpoints = resolveOverpassEndpoints(raw, undefined);
  assert.deepEqual(endpoints, [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ]);
});

test('resolveOverpassEndpoints: falls back to legacy OVERPASS_URL when OVERPASS_ENDPOINTS is not set', () => {
  const legacy = 'https://custom-mirror.example.org/api/interpreter';
  const endpoints = resolveOverpassEndpoints(undefined, legacy);
  assert.deepEqual(endpoints, [legacy]);
});

test('validateOverpassEndpoint: rejects invalid URL syntax', () => {
  assert.throws(
    () => validateOverpassEndpoint('not a valid url'),
    /Invalid Overpass endpoint URL/
  );
});

test('validateOverpassEndpoint: rejects non-http/https protocols', () => {
  assert.throws(
    () => validateOverpassEndpoint('ftp://overpass.example.com/api'),
    /scheme must be http: or https:/
  );
  assert.throws(
    () => validateOverpassEndpoint('javascript:alert(1)'),
    /scheme must be http: or https:/
  );
});

// OverpassClient tests

test('OverpassClient: successful query returns elements', async () => {
  const fakeResponse = { elements: [{ type: 'node', id: 1, lat: 10, lon: 20 }] };
  let requestedUrl = '';
  let requestedBody = '';

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedBody = String(init?.body);
    return new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
  });

  const res = await client.query('node(1);');
  assert.deepEqual(res.elements, fakeResponse.elements);
  assert.equal(requestedUrl, 'https://overpass-api.de/api/interpreter');
  assert.equal(requestedBody, 'data=' + encodeURIComponent('node(1);'));
});

test('OverpassClient: non-retryable HTTP 400 fails immediately without retrying or failing over', async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    return new Response('Query syntax error or bbox too large', { status: 400 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 2,
  });

  await assert.rejects(
    async () => {
      await client.query('invalid syntax query', { category: 'rail' });
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.errorClass, 'http');
      assert.equal(err.diagnostic.status, 400);
      assert.equal(err.diagnostic.endpoint, 'primary.example.com');
      assert.equal(err.diagnostic.attempts, 1);
      assert.equal(err.diagnostic.category, 'rail');
      assert.match(err.diagnostic.hint, /HTTP 400/);
      return true;
    }
  );

  // Exactly 1 attempt made: no retry and no failover to fallback
  assert.equal(callCount, 1);
});

test('OverpassClient: transient HTTP 5xx retries and fails over sequentially', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];

  const mockFetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.includes('primary.example.com')) {
      return new Response('Gateway Timeout', { status: 504 });
    }
    return new Response(JSON.stringify({ elements: [{ type: 'way', id: 42 }] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetriesPerEndpoint: 1, // 1 retry = 2 attempts on primary, then fallback
  });

  const res = await client.query('way(42);', { category: 'candidates' });
  assert.equal(res.elements.length, 1);
  assert.equal(res.elements[0].id, 42);
  assert.deepEqual(calls, [
    'https://primary.example.com/api/interpreter',
    'https://primary.example.com/api/interpreter',
    'https://fallback.example.com/api/interpreter',
  ]);
  assert.equal(sleeps.length, 2); // 1 sleep before retry on primary, 1 sleep before failover to fallback
  assert.equal(sleeps[0], 1000);
  assert.equal(sleeps[1], 1000);
});

test('OverpassClient: network error / timeout fails over sequentially to next endpoint', async () => {
  const calls: string[] = [];
  const mockFetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.includes('primary.example.com')) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 1,
  });

  const res = await client.query('node(1);');
  assert.deepEqual(res.elements, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], 'https://primary.example.com/api/interpreter');
  assert.equal(calls[1], 'https://primary.example.com/api/interpreter');
  assert.equal(calls[2], 'https://fallback.example.com/api/interpreter');
});

test('OverpassClient: exhaust all endpoints with transient errors stops at capped attempts', async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    return new Response('Rate limited', { status: 429 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 1, // 2 endpoints * 2 attempts = 4 total
  });

  await assert.rejects(
    async () => {
      await client.query('node(1);', { category: 'viewpoints' });
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.errorClass, 'http');
      assert.equal(err.diagnostic.status, 429);
      assert.equal(err.diagnostic.attempts, 4);
      assert.equal(err.diagnostic.category, 'viewpoints');
      assert.match(err.diagnostic.hint, /429/);
      return true;
    }
  );

  assert.equal(callCount, 4);
});

test('OverpassClient: redacts credentials, path secrets, and query body from diagnostics', async () => {
  const secretBody = 'node["secret"="TOP_SECRET_COORDINATES"](bbox);';
  const mockFetch = (async () => {
    return new Response('Internal Server Error', { status: 500 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://user:supersecretpass@overpass.example.com/secret/path?token=apikey123'],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 0,
  });

  await assert.rejects(
    async () => {
      await client.query(secretBody, { category: 'secret_test' });
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.endpoint, 'overpass.example.com');
      // Verify message and string representation does not leak secrets or query body
      const str = String(err);
      assert(!str.includes('supersecretpass'), 'Must not leak basic auth password');
      assert(!str.includes('apikey123'), 'Must not leak query string token');
      assert(!str.includes('TOP_SECRET_COORDINATES'), 'Must not leak query body');
      return true;
    }
  );
});

test('OverpassClient: HTML response on 200 classified as parse error', async () => {
  const mockFetch = (async () => {
    return new Response('<html><body>Gateway error</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 0,
  });

  await assert.rejects(
    async () => {
      await client.query('node(1);');
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.errorClass, 'parse');
      assert.match(err.diagnostic.hint, /JSON/i);
      return true;
    }
  );
});

test('OverpassClient: 200 response with invalid JSON is a parse failure and makes only one fetch call without retrying or failing over', async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    return new Response('<html><body>Gateway HTML Error</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 2,
  });

  await assert.rejects(
    async () => {
      await client.query('node(1);', { category: 'candidates' });
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.errorClass, 'parse');
      assert.equal(err.diagnostic.attempts, 1);
      assert.equal(err.diagnostic.endpoint, 'primary.example.com');
      assert.equal(err.diagnostic.category, 'candidates');
      return true;
    }
  );

  // Exactly one fetch call made even when multiple endpoints/retries are configured
  assert.equal(callCount, 1);
});

test('OverpassClient: 200 response with JSON missing elements is a parse failure and makes only one fetch call without retrying or failing over', async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    return new Response(JSON.stringify({ error: 'runtime error' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 2,
  });

  await assert.rejects(
    async () => {
      await client.query('node(1);');
    },
    (err: unknown) => {
      assert(err instanceof OverpassError);
      assert.equal(err.diagnostic.errorClass, 'parse');
      assert.equal(err.diagnostic.attempts, 1);
      assert.equal(err.diagnostic.endpoint, 'primary.example.com');
      return true;
    }
  );

  assert.equal(callCount, 1);
});

test('OverpassClient: sequential normal queries wait by default interval using injected clock and sleep', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
  } as any);

  // First query: no wait expected
  await client.query('node(1);');
  assert.equal(sleepCalls.length, 0);

  // Second sequential query: must wait by default interval (1000ms)
  await client.query('node(2);');
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 1000);

  // Third sequential query: must wait again
  await client.query('node(3);');
  assert.equal(sleepCalls.length, 2);
  assert.equal(sleepCalls[1], 1000);
});

test('OverpassClient: sequential normal queries wait by configured pace interval and accounts for elapsed time', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 500,
  } as any);

  await client.query('node(1);');
  assert.equal(sleepCalls.length, 0);

  // Advance time by 200ms (e.g. processing between requests)
  currentTime += 200;

  // Second query: waits remaining interval (500 - 200 = 300ms)
  await client.query('node(2);');
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 300);

  // Advance time past the configured pace interval (e.g. 600ms >= 500ms)
  currentTime += 600;

  // Third query: no wait needed since sufficient time has elapsed
  await client.query('node(3);');
  assert.equal(sleepCalls.length, 1);
});

test('resolveOverpassPaceMs: defaults to DEFAULT_OVERPASS_PACE_MS (1000)', () => {
  assert.equal(resolveOverpassPaceMs(undefined), 1000);
  assert.equal(DEFAULT_OVERPASS_PACE_MS, 1000);
});

test('resolveOverpassPaceMs: parses numeric string and handles edge cases (zero, negative, NaN fallback to safe default)', () => {
  // Preserves positive intervals
  assert.equal(resolveOverpassPaceMs('2500'), 2500);
  assert.equal(resolveOverpassPaceMs(' 1500 '), 1500);
  assert.equal(resolveOverpassPaceMs('500'), 500);
  assert.equal(resolveOverpassPaceMs(2500 as any), 2500);
  // Zero resolves to non-zero safe default (1000ms)
  assert.equal(resolveOverpassPaceMs('0'), 1000);
  assert.equal(resolveOverpassPaceMs(' 0 '), 1000);
  assert.equal(resolveOverpassPaceMs(0 as any), 1000);
  // Negative resolves to non-zero safe default (1000ms)
  assert.equal(resolveOverpassPaceMs('-100'), 1000);
  assert.equal(resolveOverpassPaceMs('-1'), 1000);
  assert.equal(resolveOverpassPaceMs(-100 as any), 1000);
  // NaN / invalid resolves to non-zero safe default (1000ms)
  assert.equal(resolveOverpassPaceMs('not-a-number'), 1000);
  assert.equal(resolveOverpassPaceMs('NaN'), 1000);
  assert.equal(resolveOverpassPaceMs(NaN as any), 1000);
  // Empty or whitespace resolves to safe default
  assert.equal(resolveOverpassPaceMs('   '), 1000);
  assert.equal(resolveOverpassPaceMs(''), 1000);
});

test('OverpassClient: direct paceMs and minRequestIntervalMs <= 0 or NaN resolve to safe default', () => {
  // paceMs <= 0 or NaN resolves to 1000ms
  assert.equal(new OverpassClient({ paceMs: 0 }).paceMs, 1000);
  assert.equal(new OverpassClient({ paceMs: -500 }).paceMs, 1000);
  assert.equal(new OverpassClient({ paceMs: NaN }).paceMs, 1000);

  // minRequestIntervalMs <= 0 or NaN resolves to 1000ms
  assert.equal(new OverpassClient({ minRequestIntervalMs: 0 }).paceMs, 1000);
  assert.equal(new OverpassClient({ minRequestIntervalMs: -200 }).paceMs, 1000);
  assert.equal(new OverpassClient({ minRequestIntervalMs: NaN }).paceMs, 1000);

  // Configurable positive intervals are preserved
  assert.equal(new OverpassClient({ paceMs: 500 }).paceMs, 500);
  assert.equal(new OverpassClient({ minRequestIntervalMs: 750 }).paceMs, 750);
});

test('OverpassClient: explicit paceMs: 0 enforces safe default pacing (1000ms) between sequential queries', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 0,
  });

  await client.query('node(1);');
  assert.equal(sleepCalls.length, 0);

  // Second sequential query must enforce safe default interval (1000ms), not skip pacing
  await client.query('node(2);');
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 1000);
});

test('OverpassClient: explicit minRequestIntervalMs: 0 enforces safe default pacing (1000ms) between sequential queries', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    minRequestIntervalMs: 0,
  });

  await client.query('node(1);');
  assert.equal(sleepCalls.length, 0);

  // Second sequential query must enforce safe default interval (1000ms), not skip pacing
  await client.query('node(2);');
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 1000);
});


test('OverpassClient: failed query still records timestamp so subsequent query honours pacing', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response('Bad Request', { status: 400 });
    }
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 800,
  });

  // Query 1 fails with non-retryable 400
  await assert.rejects(async () => {
    await client.query('bad query');
  });
  assert.equal(sleepCalls.length, 0);

  // Query 2 immediately after failed Query 1: must wait 800ms
  await client.query('node(2);');
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 800);
});

test('OverpassClient: serializes concurrent queries without parallel requests', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    // Simulate slight runtime delay
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 500,
  });

  // Launch two queries concurrently without awaiting sequentially
  await Promise.all([client.query('node(1);'), client.query('node(2);')]);

  // Must remain strictly serial (no parallel requests)
  assert.equal(maxConcurrent, 1);
  // Second query waited the configured interval
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 500);
});

test('OverpassClient: transient 5xx retry waits configured pace before next fetch', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  let attempt = 0;
  const mockFetch = (async () => {
    attempt++;
    if (attempt === 1) {
      return new Response('Internal Server Error', { status: 500 });
    }
    return new Response(JSON.stringify({ elements: [{ type: 'node', id: 101 }] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 800,
    maxRetriesPerEndpoint: 1,
  });

  const res = await client.query('node(101);');
  assert.equal(res.elements.length, 1);
  assert.equal(res.elements[0].id, 101);
  assert.equal(attempt, 2);
  // Attempt 1 makes initial fetch with no prior request, so 0 wait.
  // Attempt 2 (transient 5xx retry) must wait the configured pace (800ms) before its next fetch.
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 800);
});

test('OverpassClient: network-error failover waits configured pace before next fetch', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const calls: string[] = [];
  const mockFetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.includes('primary.example.com')) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ elements: [{ type: 'node', id: 202 }] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: [
      'https://primary.example.com/api/interpreter',
      'https://fallback.example.com/api/interpreter',
    ],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 600,
    maxRetriesPerEndpoint: 0,
  });

  const res = await client.query('node(202);');
  assert.equal(res.elements.length, 1);
  assert.equal(res.elements[0].id, 202);
  assert.deepEqual(calls, [
    'https://primary.example.com/api/interpreter',
    'https://fallback.example.com/api/interpreter',
  ]);
  // Primary fetch fails immediately with network error.
  // Failover attempt must wait the configured pace (600ms) before its next fetch.
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 600);
});
