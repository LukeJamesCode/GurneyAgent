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
// Dispatch has two flavours:
//   - makeOrchestratorDispatch: routes the device turn through host.orchestrator
//     so it picks up tools, conversation history, and the hallucination guard.
//     This is the default when host.orchestrator is wired AND an owner_chat_id
//     is configured — the device then shares history with the Telegram chat.
//   - makeLlmDispatch: legacy v0.1 path. No tools, no memory, no history;
//     direct system+user round trip with host.llm. Used as a fallback when the
//     orchestrator isn't available (test harnesses) or when owner_chat_id is
//     unset (treat the device as isolated chatter).

import { readFileSync } from 'node:fs';
import type { LLM, ChatMessage } from '../../src/core/llm.js';
import type {
  ExtensionSettings,
  HostOrchestrator,
  HostReplyChunk,
} from '../../src/core/extensions.js';
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

// Legacy dispatch: no tools, no memory, no conversation history. Direct
// system+user round trip. Used when the orchestrator isn't available (tests)
// or when owner_chat_id isn't configured (device kept isolated).
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

export interface OrchestratorDispatchDeps {
  orchestrator: HostOrchestrator;
  // Chat the device's turns join. Typically the user's Telegram chat id so
  // history is shared across surfaces.
  chatId: number;
  // Synthetic user id for the device. The core only uses this for logging and
  // multi-user attribution; sticking a stable device-derived value here is
  // fine.
  userId: number;
  log: Logger;
}

// Submit the transcribed turn to the core orchestrator and collect the
// streamed reply. The orchestrator handles conversation history, tool
// dispatch, intent-pruned manifest, and the hallucination guard, so the
// device gets feature-parity with the Telegram surface — calendar, reminders,
// weather, briefings, etc. all fire from voice.
//
// Spoken replies should be short; the system prompt the orchestrator applies
// is the Telegram-tuned one, which can ramble. The caller post-processes the
// reply via shortenForSpeech() to keep TTS latency bounded.
export function makeOrchestratorDispatch(
  deps: OrchestratorDispatchDeps,
): (text: string) => Promise<string> {
  return async (text: string) => {
    let buffer = '';
    try {
      await deps.orchestrator.handleUserMessage({
        chatId: deps.chatId,
        userId: deps.userId,
        text,
        send: (chunk: HostReplyChunk) => {
          if (chunk.delta) buffer += chunk.delta;
          // Mirror the Telegram adapter's hallucination-guard handling: on
          // the final chunk, an explicit `replace` overrides whatever
          // streamed text we've accumulated.
          if (chunk.done && chunk.replace !== undefined) buffer = chunk.replace;
        },
      });
    } catch (e) {
      deps.log.warn('orchestrator dispatch failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return '';
    }
    return buffer.trim();
  };
}

// Strip markup that doesn't read well aloud and clip overlong replies so
// voice latency stays bounded. The orchestrator is tuned for Telegram, where
// bullet lists and bolds are normal — over voice they're noise.
//
//   *bold*           → bold
//   `code`           → code
//   - bullet line    → bullet line
//   |table|         → dropped (rare; Piper says "vertical bar")
//   ---             → dropped
//   newlines        → spaces (Piper inserts long pauses on \n\n)
//
// A hard length cap matches `llm_max_tokens` in spirit: well-behaved replies
// rarely exceed a few hundred characters; if the model writes a paragraph we
// trim it. 600 chars ≈ 30 seconds spoken.
export function shortenForSpeech(text: string, maxChars: number = 600): string {
  let out = text;
  // Drop fenced code blocks entirely — reading "triple backtick javascript"
  // aloud is worse than dropping the snippet.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  // Strip inline markdown decoration.
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/_([^_]+)_/g, '$1');
  // Bullets / numbered list markers → plain text.
  out = out.replace(/^\s*[-*•]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');
  // Markdown links [label](url) → label
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Newlines → space; collapse runs.
  out = out.replace(/\r\n|\n|\r/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length <= maxChars) return out;
  // Try to cut on a sentence boundary near the cap; fall back to a hard cut
  // with an ellipsis so the model's verb stays attached to its subject.
  const slice = out.slice(0, maxChars);
  const lastBoundary = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastBoundary > maxChars * 0.5) return slice.slice(0, lastBoundary + 1).trim();
  return slice.trim() + '…';
}

// Async-iterable wrapper around gurney-voice's synthesize(). The function
// produces an OGG file on disk; we read it, chunk it, yield, then clean up.
// Streaming chunks before synth finishes would let the device start playing
// sooner — that's a later optimization; for now correctness beats latency.
export function makeSynth(
  cfg: Pick<PipelineSettings, 'piperBin' | 'ffmpegBin' | 'voiceModelPath' | 'ttsChunkBytes'>,
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
