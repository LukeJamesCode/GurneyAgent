import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createBridge,
  createRateLimiter,
  splitForDiscord,
  stripBotMention,
  DISCORD_MESSAGE_MAX,
  type OutboundTransport,
} from './bridge.js';
import type {
  HostOrchestrator,
  HostUserMessage,
} from '../../../src/core/extensions.js';

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => SILENT_LOG,
};

function fakeIdentity() {
  let seq = -8_000_000_000_002;
  const seen = new Map<string, number>();
  return {
    chatIdFor(opts: { userId: string; channelId: string; isDm: boolean }): number {
      const key = `${opts.userId}:${opts.channelId}`;
      const existing = seen.get(key);
      if (existing !== undefined) return existing;
      const id = seq--;
      seen.set(key, id);
      return id;
    },
    resolve: () => null,
    count: () => seen.size,
  };
}

interface CapturedSend {
  channelId: string;
  text: string;
}

function fakeTransport(): OutboundTransport & { sent: CapturedSend[] } {
  const sent: CapturedSend[] = [];
  return {
    sent,
    send: async (channelId, text) => {
      sent.push({ channelId, text });
    },
    startTyping: async () => {},
  };
}

test('stripBotMention: removes <@id> and <@!id> forms', () => {
  assert.equal(stripBotMention('<@123> hello', '123'), 'hello');
  assert.equal(stripBotMention('<@!123> hi there', '123'), 'hi there');
  assert.equal(stripBotMention('hey <@123>, do X', '123'), 'hey , do X');
  assert.equal(stripBotMention('<@999> ignore other mention', '123'), '<@999> ignore other mention');
});

test('splitForDiscord: passes short messages through unchanged', () => {
  assert.deepEqual(splitForDiscord('short'), ['short']);
});

test('splitForDiscord: breaks long messages on paragraph boundaries when possible', () => {
  const para = 'a'.repeat(500);
  const text = `${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
  const parts = splitForDiscord(text, 1100);
  for (const p of parts) assert.ok(p.length <= 1100, `part too long: ${p.length}`);
  // Joined content (whitespace-normalised) is preserved.
  const original = text.replace(/\s+/g, '');
  const joined = parts.join('').replace(/\s+/g, '');
  assert.equal(joined, original);
});

test('splitForDiscord: handles messages with no break points by hard-slicing', () => {
  const text = 'x'.repeat(DISCORD_MESSAGE_MAX * 2 + 17);
  const parts = splitForDiscord(text);
  for (const p of parts) assert.ok(p.length <= DISCORD_MESSAGE_MAX);
  assert.equal(parts.join(''), text);
});

test('bridge: empty mention reply, no LLM round-trip', async () => {
  let called = false;
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async () => {
      called = true;
    },
  };
  const transport = fakeTransport();
  const bridge = createBridge({
    orchestrator,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: 'g-1',
    rawContent: '<@bot-1>',
  });

  assert.equal(called, false);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]!.text, /send a message/i);
});

test('bridge: rate-limited turn returns a friendly nudge', async () => {
  let called = 0;
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async () => {
      called += 1;
    },
  };
  const transport = fakeTransport();
  const bridge = createBridge({
    orchestrator,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(1), // budget of 1/minute
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: 'g-1',
    rawContent: '<@bot-1> first',
  });
  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: 'g-1',
    rawContent: '<@bot-1> second',
  });

  assert.equal(called, 1);
  const last = transport.sent.at(-1)!;
  assert.match(last.text, /per-minute limit/i);
});

test('bridge: streams orchestrator deltas as a single send on done', async () => {
  const captured: HostUserMessage[] = [];
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async (msg) => {
      captured.push(msg);
      await msg.send({ delta: 'Hello' });
      await msg.send({ delta: ', world!', done: true });
    },
  };
  const transport = fakeTransport();
  const bridge = createBridge({
    orchestrator,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: null,
    rawContent: 'hi there',
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.text, 'hi there');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]!.text, 'Hello, world!');
});

test('bridge: replace chunk overrides buffered delta', async () => {
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async (msg) => {
      await msg.send({ delta: 'thinking…' });
      await msg.send({ delta: '', done: true, replace: 'Final answer.' });
    },
  };
  const transport = fakeTransport();
  const bridge = createBridge({
    orchestrator,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: null,
    rawContent: 'hello',
  });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]!.text, 'Final answer.');
});

test('bridge: identity adapter assigns stable chatId per (user, channel)', async () => {
  const seenChatIds: number[] = [];
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async (msg) => {
      seenChatIds.push(msg.chatId);
      await msg.send({ delta: 'ok', done: true });
    },
  };
  const identity = fakeIdentity();
  const transport = fakeTransport();
  const bridge = createBridge({
    orchestrator,
    identity,
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  for (let i = 0; i < 3; i++) {
    await bridge.handle({
      userId: 'u-1',
      channelId: 'c-1',
      guildId: null,
      rawContent: 'hi',
    });
  }
  assert.equal(new Set(seenChatIds).size, 1, 'same pair must collapse to one chatId');
});
