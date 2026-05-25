import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTranscribe, makeLlmDispatch, makeSynth, type PipelineSettings } from './pipeline.js';
import type { LLM, ChatChunk } from '../../src/core/llm.js';

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
  const cfg: Pick<PipelineSettings, 'piperBin' | 'ffmpegBin' | 'voiceModelPath' | 'ttsChunkBytes'> = {
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
