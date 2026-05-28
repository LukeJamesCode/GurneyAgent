// Tests for the confirm-tier tool gate wired into the Telegram adapter.
// Uses a minimal fake Bot (via botFactory) so we can drive the Yes/No flow
// without a live grammY connection.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTelegram, type TelegramOptions } from './telegram.js';
import type { Logger } from '../util/log.js';
import type { ToolHandler, ToolContext } from '../core/tools.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  const l: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
  };
  return l;
}

interface FakeBot {
  bot: unknown;
  handlers: Map<string, (ctx: unknown) => Promise<void> | void>;
  sent: Array<{ chatId: number; text: string }>;
  edits: Array<{ messageId: number; text: string }>;
}

function fakeBot(): FakeBot {
  const handlers = new Map<string, (ctx: unknown) => Promise<void> | void>();
  const sent: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  let msgId = 100;
  const api = {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: ++msgId };
    },
    editMessageText: async (_chatId: number, messageId: number, text: string) => {
      edits.push({ messageId, text });
    },
    setMyCommands: async () => {},
  };
  const bot = {
    use: () => {},
    command: () => {},
    callbackQuery: () => {},
    on: (event: string, fn: (ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, fn);
    },
    catch: () => {},
    api,
    start: async () => {},
    stop: async () => {},
  };
  return { bot, handlers, sent, edits };
}

function makeAdapter(fb: FakeBot): ReturnType<typeof createTelegram> {
  const opts = {
    token: 'test-token',
    allowedUserIds: [1],
    log: silentLogger(),
    orchestrator: {} as unknown,
    llm: {} as unknown,
    tools: { list: () => [] } as unknown,
    db: {} as unknown,
    followups: {} as unknown,
    botFactory: () => fb.bot as never,
  } as unknown as TelegramOptions;
  return createTelegram(opts);
}

const handler: ToolHandler = {
  name: 'codex_handoff',
  description: 'escalate',
  parameters: {},
  tier: 'confirm',
  confirmPrompt: (args) => `Spend a Codex call on: ${String(args['task'])}?`,
  invoke: async () => '',
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function pressButton(fb: FakeBot, data: string): Promise<void> {
  const cb = fb.handlers.get('callback_query:data');
  assert.ok(cb, 'callback_query:data handler should be registered');
  await cb({
    chat: { id: 5 },
    from: { id: 1 },
    callbackQuery: { data },
    answerCallbackQuery: async () => {},
  });
}

test('confirmToolCall resolves true when the user taps Yes', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'refactor X' }, ctx);
  await tick();
  assert.equal(fb.sent.length, 1);
  assert.match(fb.sent[0]!.text, /Spend a Codex call on: refactor X\?/);
  await pressButton(fb, 'confirm:1:yes');
  assert.equal(await p, true);
});

test('confirmToolCall resolves false when the user taps No', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'do thing' }, ctx);
  await tick();
  await pressButton(fb, 'confirm:1:no');
  assert.equal(await p, false);
});

test('confirmToolCall fails closed when there is no chat to ask in', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { log: silentLogger() }; // no chatId
  assert.equal(await adapter.confirmToolCall(handler, { task: 'x' }, ctx), false);
  assert.equal(fb.sent.length, 0, 'no prompt should be sent');
});

test('confirmToolCall fails closed when the turn is already aborted', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctl = new AbortController();
  ctl.abort();
  const ctx: ToolContext = { chatId: 5, log: silentLogger(), signal: ctl.signal };
  assert.equal(await adapter.confirmToolCall(handler, { task: 'x' }, ctx), false);
  assert.equal(fb.sent.length, 0);
});

test('aborting the turn (/stop) while waiting resolves false', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctl = new AbortController();
  const ctx: ToolContext = { chatId: 5, log: silentLogger(), signal: ctl.signal };
  const p = adapter.confirmToolCall(handler, { task: 'x' }, ctx);
  await tick();
  assert.equal(fb.sent.length, 1);
  ctl.abort();
  assert.equal(await p, false);
});

test('a stale button press (unknown id) is ignored without throwing', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'keep' }, ctx);
  await tick();
  await pressButton(fb, 'confirm:999:yes'); // wrong id — should be a no-op
  await pressButton(fb, 'confirm:1:yes'); // correct id
  assert.equal(await p, true);
});
