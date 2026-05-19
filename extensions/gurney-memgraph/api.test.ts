import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMemoryClient, type MemoryFact } from './api.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(responses: Array<unknown | { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const item = responses[i++];
    if (item === undefined) throw new Error('fetch script exhausted');
    const r =
      item && typeof item === 'object' && 'status' in (item as object)
        ? (item as { status: number; body: unknown })
        : { status: 200, body: item };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() {
        return r.body;
      },
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
    };
  };
  return { impl, calls };
}

const creds = { url: 'http://bridge:8765', namespace: 'unit' };

test('recall posts namespace + query and returns the facts list', async () => {
  const fx = makeFetch([
    {
      facts: [
        { text: 'user lives in Calgary', score: 0.91 },
        { text: 'user prefers tea', score: 0.42 },
      ],
    },
  ]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  const facts = await c.recall('where does the user live?', 3);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.text, 'user lives in Calgary');
  const post = fx.calls[0]!;
  assert.equal(post.url, 'http://bridge:8765/memory/recall');
  assert.equal(post.method, 'POST');
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assert.equal(body['namespace'], 'unit');
  assert.equal(body['query'], 'where does the user live?');
  assert.equal(body['top_k'], 3);
});

test('store with empty episodes short-circuits without a network call', async () => {
  const fx = makeFetch([]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  const n = await c.store('src', []);
  assert.equal(n, 0);
  assert.equal(fx.calls.length, 0);
});

test('store posts episodes and returns the bridge-reported count', async () => {
  const fx = makeFetch([{ stored: 2 }]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  const n = await c.store('conversation:1', [
    { text: 'a', created_at: 1, role: 'user' },
    { text: 'b', created_at: 2, role: 'assistant' },
  ]);
  assert.equal(n, 2);
  const body = JSON.parse(fx.calls[0]!.body!) as { episodes: unknown[] };
  assert.equal(body.episodes.length, 2);
});

test('forget posts the namespace', async () => {
  const fx = makeFetch([{ ok: true }]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  await c.forget();
  assert.equal(fx.calls[0]!.url, 'http://bridge:8765/memory/forget');
  const body = JSON.parse(fx.calls[0]!.body!) as Record<string, unknown>;
  assert.equal(body['namespace'], 'unit');
});

test('health returns false on bridge failure instead of throwing', async () => {
  const fx = makeFetch([{ status: 503, body: 'down' }]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  const ok = await c.health();
  assert.equal(ok, false);
});

test('bearer token is forwarded when configured', async () => {
  const fx = makeFetch([{ facts: [] }]);
  const c = createMemoryClient({
    creds: { ...creds, token: 'secret' },
    fetchImpl: fx.impl,
  });
  await c.recall('q', 1);
  assert.equal(fx.calls[0]!.headers['authorization'], 'Bearer secret');
});

test('non-2xx status throws MemoryBridgeError with the bridge body', async () => {
  const fx = makeFetch([{ status: 500, body: 'boom' }]);
  const c = createMemoryClient({ creds, fetchImpl: fx.impl });
  await assert.rejects(
    () => c.recall('q', 1),
    (e: unknown) =>
      e instanceof Error &&
      e.name === 'MemoryBridgeError' &&
      (e as Error & { status: number }).status === 500 &&
      /boom/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// LRU recall cache (B9). Atlas dimensions: 128 entries, 60s TTL, cleared on
// store/forget. The makeFetch helper above scripts a fixed sequence and
// throws when exhausted, so to prove a cache HIT we configure exactly one
// response and call recall twice — if the cache misses, the second call
// hits the empty script and the test fails loudly.
// ---------------------------------------------------------------------------

interface LruCall {
  url: string;
  body?: unknown;
}

function recallFetch(handler: (url: string) => unknown) {
  const calls: LruCall[] = [];
  const impl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const result = handler(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return result;
      },
      async text() {
        return JSON.stringify(result);
      },
    };
  };
  return { impl, calls };
}

test('recall returns the LRU-cached value on repeat calls within the TTL', async () => {
  const facts: MemoryFact[] = [{ text: 'Cached fact', score: 0.9 }];
  const fx = recallFetch(() => ({ facts }));
  const t = { now: 0 };
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
    cacheTtlMs: 1000,
    now: () => t.now,
  });
  const a = await client.recall('what did I do', 5);
  const b = await client.recall('what did I do', 5);
  assert.deepEqual(a, facts);
  assert.deepEqual(b, facts);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 1);
});

test('recall expires entries after the TTL elapses', async () => {
  const fx = recallFetch(() => ({ facts: [{ text: 'a' }] }));
  const t = { now: 0 };
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
    cacheTtlMs: 1000,
    now: () => t.now,
  });
  await client.recall('q', 5);
  t.now = 2000;
  await client.recall('q', 5);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 2);
});

test('recall caches separately per (query, topK)', async () => {
  const fx = recallFetch(() => ({ facts: [{ text: 'a' }] }));
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
  });
  await client.recall('q1', 5);
  await client.recall('q1', 10);
  await client.recall('q2', 5);
  await client.recall('q1', 5);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 3);
});

test('store invalidates the recall cache so stale reads do not survive a write', async () => {
  let value: MemoryFact[] = [{ text: 'before' }];
  const fx = recallFetch((url) => {
    if (url.endsWith('/memory/recall')) return { facts: value };
    if (url.endsWith('/memory/store')) return { stored: 1 };
    return null;
  });
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
  });
  const a = await client.recall('q', 5);
  assert.deepEqual(a, [{ text: 'before' }]);
  value = [{ text: 'after' }];
  await client.store('user-turn', [{ text: 'episode', created_at: 1 }]);
  const b = await client.recall('q', 5);
  assert.deepEqual(b, [{ text: 'after' }]);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 2);
});

test('LRU evicts the oldest entry once cap is exceeded', async () => {
  const fx = recallFetch(() => ({ facts: [{ text: 'x' }] }));
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
    cacheMax: 2,
  });
  await client.recall('a', 1);
  await client.recall('b', 1);
  await client.recall('c', 1); // evicts 'a'
  await client.recall('a', 1); // miss, was evicted
  await client.recall('c', 1); // hit
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 4);
});

test('cacheMax = 0 disables caching entirely', async () => {
  const fx = recallFetch(() => ({ facts: [{ text: 'x' }] }));
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
    cacheMax: 0,
  });
  await client.recall('q', 5);
  await client.recall('q', 5);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 2);
});

test('clearCache drops entries without doing a write', async () => {
  const fx = recallFetch(() => ({ facts: [{ text: 'x' }] }));
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: fx.impl,
  });
  await client.recall('q', 5);
  client.clearCache();
  await client.recall('q', 5);
  const recallCalls = fx.calls.filter((c) => c.url.endsWith('/memory/recall'));
  assert.equal(recallCalls.length, 2);
});

test('request passes the abort signal so the timeout actually fires', async () => {
  // The bridge sits on the user-facing recall path: a hung response without
  // a wired-up signal would block the bot indefinitely instead of timing out.
  const seen: Array<AbortSignal | undefined> = [];
  const impl = async (
    _url: string,
    init?: { method?: string; signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> => {
    seen.push(init?.signal);
    return new Promise((_res, rej) => {
      const sig = init?.signal;
      if (!sig) return; // never resolves — proves the test would hang without a signal
      const onAbort = (): void => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort, { once: true });
    });
  };
  const client = createMemoryClient({
    creds: { url: 'http://bridge', namespace: 'ns' },
    fetchImpl: impl,
    timeoutMs: 5,
  });
  await assert.rejects(client.recall('q', 1), /aborted/);
  assert.ok(seen[0], 'fetch must receive an AbortSignal');
});
