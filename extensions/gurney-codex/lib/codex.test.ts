import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractText, callCodex, probeAccess, CodexApiError } from './codex.js';

test('extractText reads the output_text convenience field', () => {
  assert.equal(extractText({ output_text: 'hello' }), 'hello');
  assert.equal(extractText({ output_text: ['a', 'b'] }), 'ab');
});

test('extractText walks the structured output array', () => {
  const json = {
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'part1 ' },
          { type: 'output_text', text: 'part2' },
        ],
      },
    ],
  };
  assert.equal(extractText(json), 'part1 part2');
});

test('extractText returns empty string when there is nothing', () => {
  assert.equal(extractText({}), '');
  assert.equal(extractText({ output: [] }), '');
});

test('callCodex sends auth + account headers and parses the result', async () => {
  let seenHeaders: Record<string, string> = {};
  let seenUrl = '';
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(
      JSON.stringify({ output_text: 'done', usage: { input_tokens: 12, output_tokens: 34 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await callCodex({
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    accessToken: 'TOK',
    accountId: 'acct_1',
    model: 'gpt-5-codex',
    prompt: 'do the thing',
    maxOutputTokens: 100,
    timeoutMs: 5_000,
    fetchImpl: fakeFetch,
  });

  assert.equal(seenUrl, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seenHeaders['authorization'], 'Bearer TOK');
  assert.equal(seenHeaders['chatgpt-account-id'], 'acct_1');
  assert.equal(result.text, 'done');
  assert.equal(result.promptTokens, 12);
  assert.equal(result.completionTokens, 34);
});

test('callCodex throws CodexApiError on a 401', async () => {
  const fakeFetch = (async () =>
    new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    callCodex({
      baseUrl: 'https://x/codex',
      accessToken: 'T',
      accountId: null,
      model: 'm',
      prompt: 'p',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
      fetchImpl: fakeFetch,
    }),
    (e: unknown) => e instanceof CodexApiError && e.status === 401,
  );
});

test('probeAccess reports failure status without throwing', async () => {
  const fakeFetch = (async () =>
    new Response('no scope', { status: 403 })) as unknown as typeof fetch;
  const probe = await probeAccess({
    baseUrl: 'https://x/codex',
    accessToken: 'T',
    accountId: null,
    model: 'm',
    fetchImpl: fakeFetch,
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.status, 403);
});
