// Glue between the runtime Host and the protocol-agnostic DeviceSession.
//
// The session asks for three injected functions:
//   - transcribe(pcm) → text
//   - dispatch(text)  → reply text
//   - synth(text)     → async iterable of OGG/Opus chunks
//
// We build each one in isolation here so jobs.ts stays small and so each
// adapter can be tested without spinning up the WebSocket layer.
//
// Important: this file intentionally does NOT touch core. dispatch() talks
// directly to host.llm rather than going through the orchestrator (which
// today only ships through the Telegram adapter). That means tool calls
// (calendar, reminders, etc.) won't fire from the device in v0.1. Wiring
// the orchestrator path requires a small new core helper and is deferred to
// a future release; the protocol and session don't need to change when it
// lands — only this file does.

import { readFileSync } from 'node:fs';
import type { LLM, ChatMessage } from '../../src/core/llm.js';
import type { ExtensionSettings } from '../../src/core/extensions.js';
import type { Logger } from '../../src/util/log.js';
import { transcribePcm, type RunShell as SttRunShell } from '../gurney-voice/stt.js';
import { synthesize, type RunShell as SynthRunShell } from '../gurney-voice/synth.js';

export interface PipelineSettings {
  whisperBin: string;
  whisperModelPath: string;
  piperBin: string;
  ffmpegBin: string;
  voiceModelPath: string;
  llmProfile: 'chat' | 'reason' | 'tools';
  llmMaxTokens: number;
  systemPrompt: string;
  ttsChunkBytes: number;
}

export function readPipelineSettings(settings: ExtensionSettings): PipelineSettings {
  const whisperModelPath = settings.get<string>('whisper_model_path', '') || '';
  const voiceModelPath = settings.get<string>('voice_model_path', '') || '';
  return {
    whisperBin: settings.get<string>('whisper_bin', 'whisper-cli') || 'whisper-cli',
    whisperModelPath,
    piperBin: settings.get<string>('piper_bin', 'piper') || 'piper',
    ffmpegBin: settings.get<string>('ffmpeg_bin', 'ffmpeg') || 'ffmpeg',
    voiceModelPath,
    llmProfile: (settings.get<string>('llm_profile', 'chat') || 'chat') as
      | 'chat'
      | 'reason'
      | 'tools',
    llmMaxTokens: Number(settings.get<number>('llm_max_tokens', 200)) || 200,
    systemPrompt:
      settings.get<string>(
        'system_prompt',
        'You are Gurney, a friendly voice assistant speaking through a small home device. Reply in one or two short spoken sentences. No code blocks, no markdown.',
      ) || '',
    ttsChunkBytes: 4096,
  };
}

export function makeTranscribe(
  cfg: Pick<PipelineSettings, 'whisperBin' | 'whisperModelPath'>,
  log: Logger,
  runShell?: SttRunShell,
): (pcm: Buffer) => Promise<string> {
  return async (pcm: Buffer) => {
    if (!cfg.whisperModelPath) {
      log.warn(
        'transcribe skipped: whisper_model_path is unset — point this at the model gurney-voice downloaded',
      );
      return '';
    }
    try {
      const { transcript } = await transcribePcm(
        {
          pcm,
          sampleRate: 16000,
          whisperBin: cfg.whisperBin,
          modelPath: cfg.whisperModelPath,
        },
        runShell,
      );
      return transcript;
    } catch (e) {
      log.warn('transcribe failed', { error: e instanceof Error ? e.message : String(e) });
      return '';
    }
  };
}

export interface LlmDispatchDeps {
  llm: LLM;
  profile: 'chat' | 'reason' | 'tools';
  maxTokens: number;
  systemPrompt: string;
  log: Logger;
}

// v0.1 dispatch: no tools, no memory, no conversation history. Direct
// system+user round trip. Replaces the orchestrator only for the device chat
// surface — Telegram still uses the full orchestrator path unchanged.
export function makeLlmDispatch(deps: LlmDispatchDeps): (text: string) => Promise<string> {
  return async (text: string) => {
    const messages: ChatMessage[] = [
      { role: 'system', content: deps.systemPrompt },
      { role: 'user', content: text },
    ];
    let out = '';
    try {
      for await (const chunk of deps.llm.chat({
        profile: deps.profile,
        messages,
        maxTokens: deps.maxTokens,
      })) {
        if (chunk.delta) out += chunk.delta;
      }
    } catch (e) {
      deps.log.warn('llm dispatch failed', { error: e instanceof Error ? e.message : String(e) });
      return '';
    }
    return out.trim();
  };
}

// Async-iterable wrapper around gurney-voice's synthesize(). The function
// produces an OGG file on disk; we read it, chunk it, yield, then clean up.
// Streaming chunks before synth finishes would let the device start playing
// sooner — that's a later optimization; for now correctness beats latency.
export function makeSynth(
  cfg: Pick<
    PipelineSettings,
    'piperBin' | 'ffmpegBin' | 'voiceModelPath' | 'ttsChunkBytes'
  >,
  log: Logger,
  runShell?: SynthRunShell,
): (text: string) => AsyncIterable<Buffer> {
  return (text: string) => ({
    async *[Symbol.asyncIterator]() {
      if (!cfg.voiceModelPath) {
        log.warn(
          'synth skipped: voice_model_path is unset — point this at the Piper voice gurney-voice downloaded',
        );
        return;
      }
      let result: { oggPath: string; cleanup(): void } | null = null;
      try {
        result = await synthesize(
          {
            text,
            piperBin: cfg.piperBin,
            ffmpegBin: cfg.ffmpegBin,
            voiceModelPath: cfg.voiceModelPath,
          },
          runShell,
        );
        const bytes = readFileSync(result.oggPath);
        for (let i = 0; i < bytes.length; i += cfg.ttsChunkBytes) {
          yield bytes.subarray(i, Math.min(i + cfg.ttsChunkBytes, bytes.length));
        }
      } catch (e) {
        log.warn('synth failed', { error: e instanceof Error ? e.message : String(e) });
      } finally {
        result?.cleanup();
      }
    },
  });
}
