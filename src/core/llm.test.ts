import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createOllama, CircuitOpenError, LLMHttpError, type ChatChunk } from './llm.js';
import { createLogger } from '../util/log.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function streamingResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l + '\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test('chat() streams ndjson chunks and records prompt/completion tokens', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return streamingResponse([
      JSON.stringify({ model: 'qwen3.5:0.8b', message: { content: 'Hello ' }, done: false }),
      JSON.stringify({ model: 'qwen3.5:0.8b', message: { content: 'world.' }, done: false }),
      JSON.stringify({
        model: 'qwen3.5:0.8b',
        message: { content: '' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 4,
      }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: {
      chat: { model: 'qwen3.5:0.8b', contextTokens: 4096, heavy: false },
    },
  });
  const chunks = await collect(
    llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
  );
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.delta, 'Hello ');
  assert.equal(chunks[2]!.done, true);
  assert.equal(chunks[2]!.promptTokens, 10);
  assert.equal(chunks[2]!.completionTokens, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/chat$/);
  llm.stopIdleEviction();
});

test('chat() forwards tool_calls in the final chunk', async () => {
  const fetchImpl = async () =>
    streamingResponse([
      JSON.stringify({
        model: 'm',
        message: {
          tool_calls: [{ function: { name: 'add', arguments: { a: 1, b: 2 } } }],
        },
        done: true,
      }),
    ]);
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
  });
  const chunks = await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]!.toolCalls?.[0]!.arguments, { a: 1, b: 2 });
  assert.equal(chunks[0]!.toolCalls?.[0]!.name, 'add');
  llm.stopIdleEviction();
});

test('circuit breaker trips after threshold failures and fails fast', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return new Response('boom', { status: 500 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 0,
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  }
  // Third call should fail fast without hitting fetch.
  const before = n;
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), CircuitOpenError);
  assert.equal(n, before);
  llm.stopIdleEviction();
});

test('half-open requires `halfOpenGrace` consecutive successes before fully closing', async () => {
  // Sequence: 2 failures (trip), cooldown elapses, 1 success (still half-open),
  // 1 failure (re-opens immediately even though we haven't hit failureThreshold
  // again — half-open should be strict).
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  let nowVal = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 1000,
    halfOpenGrace: 2,
    now: () => nowVal,
  });
  // Trip the breaker.
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  assert.equal(llm.breakerSnapshot().state, 'open');
  // Cooldown elapses; first success enters half-open and counts 1.
  nowVal = 2000;
  mode = 'ok';
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'half-open');
  assert.equal(llm.breakerSnapshot().consecutiveSuccesses, 1);
  // One more success closes the breaker.
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'closed');
  llm.stopIdleEviction();
});

test('caller-aborted fetch does not count as a circuit-breaker failure', async () => {
  // /stop and shutdown abort the caller's signal; the resulting AbortError
  // would otherwise trip the breaker after a few cancels and lock the bot
  // out of its own LLM until the cooldown elapsed.
  const fetchImpl = async (_: string | URL | Request, init?: RequestInit) => {
    const sig = init?.signal;
    if (sig?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return new Response('boom', { status: 500 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) {
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      collect(llm.chat({ profile: 'chat', messages: [], signal: ctl.signal })),
      /aborted/i,
    );
  }
  assert.equal(llm.breakerSnapshot().state, 'closed');
  assert.equal(llm.breakerSnapshot().failures, 0);
  llm.stopIdleEviction();
});

test('a failure during half-open immediately re-opens with a fresh cooldown', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  let nowVal = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 1,
    cooldownMs: 1000,
    halfOpenGrace: 2,
    now: () => nowVal,
  });
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  // Cooldown elapses → half-open.
  nowVal = 2000;
  mode = 'ok';
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'half-open');
  // Now the next call fails again — should re-open with a fresh window.
  mode = 'fail';
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  const snap = llm.breakerSnapshot();
  assert.equal(snap.state, 'open');
  assert.equal(snap.openedAt, 2000);
  llm.stopIdleEviction();
});

test('heavy-model eviction unloads the previous heavy model before loading a new one', async () => {
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      keep_alive?: number | string;
    };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) {
      return new Response('{}', { status: 200 });
    }
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: {
      chat: { model: 'qwen3.5:0.8b', contextTokens: 2048, heavy: true },
      reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true },
    },
  });
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  await collect(llm.chat({ profile: 'reason', messages: [] }));
  const evict = calls.find((c) => c.url.endsWith('/api/generate'));
  assert.ok(evict, 'expected an eviction call');
  assert.equal(evict!.body.model, 'qwen3.5:0.8b');
  assert.equal(evict!.body.keep_alive, 0);
  llm.stopIdleEviction();
});

test('idle sweep unloads a heavy profile that has not been used recently', async () => {
  // Drive the LLM through one chat call so a heavy profile becomes resident,
  // then advance the clock past the idle threshold and trigger the sweep.
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      keep_alive?: number | string;
    };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) return new Response('{}', { status: 200 });
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  let t = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true } },
    idleEvictionMs: 1000,
    // Tick fast so the sweep fires inside the test window.
    idleEvictionTickMs: 5,
    now: () => t,
  });
  await collect(llm.chat({ profile: 'reason', messages: [] }));
  // Advance virtual clock past the idle window. The real setInterval still
  // ticks against wall time, but `now` is what the sweep compares.
  t = 10_000;
  // Wait a few ticks for the sweep to fire.
  await new Promise((r) => setTimeout(r, 30));
  const unload = calls.find((c) => c.url.endsWith('/api/generate') && c.body.keep_alive === 0);
  assert.ok(unload, 'idle sweep should have issued an unload');
  assert.equal(unload!.body.model, 'qwen3.5:9b');
  llm.stopIdleEviction();
});
