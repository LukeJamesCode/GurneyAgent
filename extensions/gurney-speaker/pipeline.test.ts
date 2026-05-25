import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeTranscribe,
  makeLlmDispatch,
  makeOrchestratorDispatch,
  makeSynth,
  shortenForSpeech,
  type PipelineSettings,
} from './pipeline.js';
import type { LLM, ChatChunk } from '../../src/core/llm.js';
import type { HostOrchestrator } from '../../src/core/extensions.js';

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLog;
  },
};

test('makeTranscribe returns "" when whisper_model_path is unset (does not throw)', async () => {
  const fn = makeTranscribe({ whisperBin: 'whisper-cli', whisperModelPath: '' }, silentLog);
  assert.equal(await fn(Buffer.alloc(320 * 2)), '');
});

test('makeTranscribe forwards to whisper via injected runShell', async () => {
  const fn = makeTranscribe(
    { whisperBin: 'whisper-cli', whisperModelPath: '/m.bin' },
    silentLog,
    async (cmd, args) => {
      assert.equal(cmd, 'whisper-cli');
      // The temp wav path passed via -f; whisper writes <wav>.txt.
      const wavPath = args[args.indexOf('-f') + 1]!;
      writeFileSync(`${wavPath}.txt`, 'hello from puck\n');
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
    },
  );
  assert.equal(await fn(Buffer.alloc(320 * 2)), 'hello from puck');
});

test('makeLlmDispatch aggregates streamed deltas into a trimmed reply', async () => {
  // Stub LLM streaming three deltas and a done chunk.
  const llm: LLM = {
    async *chat() {
      const chunks: ChatChunk[] = [
        { delta: 'Hi ', done: false },
        { delta: 'there', done: false },
        { delta: '!', done: false },
        { delta: '', done: true },
      ];
      for (const c of chunks) yield c;
    },
    async health() {
      return { ok: true, models: [] };
    },
    listProfiles() {
      return {} as Record<'chat' | 'reason' | 'tools', null>;
    },
    resolveModel() {
      return 'stub';
    },
    breakerSnapshot() {
      return { state: 'closed', openedAt: 0, failures: 0, lastError: null } as never;
    },
    stopIdleEviction() {},
  };

  const fn = makeLlmDispatch({
    llm,
    profile: 'chat',
    maxTokens: 100,
    systemPrompt: 'be brief',
    log: silentLog,
  });
  const reply = await fn('hello');
  assert.equal(reply, 'Hi there!');
});

test('makeLlmDispatch swallows errors and returns "" so the session can recover', async () => {
  const llm: LLM = {
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error('boom');
    },
    async health() {
      return { ok: true, models: [] };
    },
    listProfiles() {
      return {} as Record<'chat' | 'reason' | 'tools', null>;
    },
    resolveModel() {
      return 'stub';
    },
    breakerSnapshot() {
      return { state: 'closed', openedAt: 0, failures: 0, lastError: null } as never;
    },
    stopIdleEviction() {},
  };
  const fn = makeLlmDispatch({
    llm,
    profile: 'chat',
    maxTokens: 100,
    systemPrompt: '',
    log: silentLog,
  });
  assert.equal(await fn('x'), '');
});

test('makeSynth yields chunks from the piper-generated ogg and cleans up', async () => {
  // Build a fake "ogg" file via a stub runShell. The synth helper from
  // gurney-voice writes WAV via piper, then runs ffmpeg to produce ogg; both
  // shells can be stubbed.
  const tmp = mkdtempSync(join(tmpdir(), 'speaker-pipeline-'));
  const cfg: Pick<PipelineSettings, 'piperBin' | 'ffmpegBin' | 'voiceModelPath' | 'ttsChunkBytes'> =
    {
      piperBin: 'piper',
      ffmpegBin: 'ffmpeg',
      voiceModelPath: '/v.onnx',
      ttsChunkBytes: 4,
    };

  // synthesize() runs piper then ffmpeg; we satisfy both and produce a real
  // ogg-shaped file at the expected output path.
  const fn = makeSynth(cfg, silentLog, async (cmd, args) => {
    if (cmd === 'piper') {
      // piper writes wav to --output_file
      const out = args[args.indexOf('--output_file') + 1]!;
      writeFileSync(out, Buffer.from('WAV-STUB'));
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
    }
    if (cmd === 'ffmpeg') {
      // ffmpeg writes ogg to the last positional arg
      const out = args[args.length - 1]!;
      writeFileSync(out, Buffer.from('OggS' + 'X'.repeat(9))); // 13 bytes
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
    }
    throw new Error(`unexpected cmd: ${cmd}`);
  });

  const chunks: Buffer[] = [];
  for await (const c of fn('hello world')) chunks.push(c);
  rmSync(tmp, { recursive: true, force: true });

  assert.ok(chunks.length >= 2, 'expected chunked output');
  const joined = Buffer.concat(chunks);
  assert.equal(joined.length, 13);
  assert.equal(joined.subarray(0, 4).toString('ascii'), 'OggS');
});

test('makeSynth yields nothing when voice_model_path is unset', async () => {
  const fn = makeSynth(
    { piperBin: 'piper', ffmpegBin: 'ffmpeg', voiceModelPath: '', ttsChunkBytes: 16 },
    silentLog,
  );
  const chunks: Buffer[] = [];
  for await (const c of fn('hi')) chunks.push(c);
  assert.equal(chunks.length, 0);
});

// ---- makeOrchestratorDispatch -----------------------------------------------

test('makeOrchestratorDispatch accumulates streamed deltas into the reply', async () => {
  const orchestrator: HostOrchestrator = {
    async handleUserMessage(msg) {
      await msg.send({ delta: 'one ', done: false });
      await msg.send({ delta: 'two ', done: false });
      await msg.send({ delta: 'three', done: true });
    },
  };
  const fn = makeOrchestratorDispatch({
    orchestrator,
    chatId: 1,
    userId: 2,
    log: silentLog,
  });
  assert.equal(await fn('hi'), 'one two three');
});

test('makeOrchestratorDispatch honours the hallucination-guard replace on done', async () => {
  const orchestrator: HostOrchestrator = {
    async handleUserMessage(msg) {
      await msg.send({ delta: 'I cancelled your 9am meeting.', done: false });
      await msg.send({
        delta: '',
        done: true,
        replace: "I can't cancel that without a calendar tool — please confirm what you want.",
      });
    },
  };
  const fn = makeOrchestratorDispatch({
    orchestrator,
    chatId: 1,
    userId: 2,
    log: silentLog,
  });
  const reply = await fn('cancel my 9am');
  assert.equal(
    reply,
    "I can't cancel that without a calendar tool — please confirm what you want.",
  );
});

test('makeOrchestratorDispatch passes through chatId and userId', async () => {
  const seen: Array<{ chatId: number; userId: number; text: string }> = [];
  const orchestrator: HostOrchestrator = {
    async handleUserMessage(msg) {
      seen.push({ chatId: msg.chatId, userId: msg.userId, text: msg.text });
      await msg.send({ delta: 'ok', done: true });
    },
  };
  const fn = makeOrchestratorDispatch({
    orchestrator,
    chatId: 555,
    userId: 999,
    log: silentLog,
  });
  await fn('hello');
  assert.deepEqual(seen, [{ chatId: 555, userId: 999, text: 'hello' }]);
});

test('makeOrchestratorDispatch returns "" when handleUserMessage throws', async () => {
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async () => {
      throw new Error('boom');
    },
  };
  const fn = makeOrchestratorDispatch({
    orchestrator,
    chatId: 1,
    userId: 2,
    log: silentLog,
  });
  assert.equal(await fn('x'), '');
});

// ---- shortenForSpeech -------------------------------------------------------

test('shortenForSpeech strips markdown decorations', () => {
  assert.equal(shortenForSpeech('**bold** and `code` and *em*'), 'bold and code and em');
});

test('shortenForSpeech drops fenced code blocks entirely', () => {
  const input = "Here's the snippet:\n```js\nconst x = 1;\n```\nThat's it.";
  const out = shortenForSpeech(input);
  // The fenced block is gone; the surrounding prose stays.
  assert.ok(!out.includes('const x'));
  assert.ok(out.includes("Here's the snippet"));
  assert.ok(out.includes("That's it"));
});

test('shortenForSpeech collapses newlines + bullets into one line', () => {
  const input = '- item one\n- item two\n- item three';
  assert.equal(shortenForSpeech(input), 'item one item two item three');
});

test('shortenForSpeech keeps short replies untouched', () => {
  assert.equal(shortenForSpeech('Yes, eight pm.'), 'Yes, eight pm.');
});

test('shortenForSpeech truncates near a sentence boundary when over the cap', () => {
  const longText = 'This is a sentence. '.repeat(60); // ~1200 chars
  const out = shortenForSpeech(longText, 100);
  assert.ok(out.length <= 100, `expected ≤100 chars, got ${out.length}: "${out}"`);
  // Should cut on a period, not mid-word.
  assert.ok(out.endsWith('.') || out.endsWith('…'));
});

test('shortenForSpeech adds an ellipsis when no sentence boundary is near the cap', () => {
  // A single long sentence with no period inside the cap window.
  const input = 'word '.repeat(500); // 2500 chars
  const out = shortenForSpeech(input, 100);
  assert.ok(out.length <= 101); // 100 chars + ellipsis
  assert.ok(out.endsWith('…'));
});

test('shortenForSpeech rewrites markdown links to their label', () => {
  assert.equal(
    shortenForSpeech('Check the [docs](https://example.com/x) for more.'),
    'Check the docs for more.',
  );
});
