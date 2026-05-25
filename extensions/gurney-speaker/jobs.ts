// Runtime entry for gurney-speaker. The loader calls register(host) on load;
// we use that moment to spin up the WebSocket server with every per-device
// session pre-wired against host.llm + gurney-voice's STT/TTS helpers.
//
// We intentionally keep this file thin: the moving parts (protocol, session
// machine, pipeline glue, WS server) each have their own module and tests.
// jobs.ts is just the bind point.

import type { Host } from '../../src/core/extensions.js';
import {
  makeLlmDispatch,
  makeSynth,
  makeTranscribe,
  readPipelineSettings,
} from './pipeline.js';
import { startWsServer, type WsServerHandle } from './ws-server.js';

let handle: WsServerHandle | null = null;

export function register(host: Host): void {
  const cfg = readPipelineSettings(host.settings);

  const sharedSecret = host.settings.get<string>('device_shared_secret', '') || '';
  if (!sharedSecret) {
    host.log.warn(
      'gurney-speaker not starting: device_shared_secret is empty. Run `gurney ext setup gurney-speaker` to generate one.',
    );
    return;
  }

  const listenHost = host.settings.get<string>('listen_host', '0.0.0.0') || '0.0.0.0';
  const listenPort = Number(host.settings.get<number>('listen_port', 7820)) || 7820;
  const ownerChatId = Number(host.settings.get<number>('owner_chat_id', 0)) || 0;
  const displayStyle = (host.settings.get<string>('display_style', 'minimal') === 'orb'
    ? 'orb'
    : 'minimal') as 'minimal' | 'orb';
  const volume = clamp01(Number(host.settings.get<number>('volume_default', 0.6)));
  const vadSilenceMs = Number(host.settings.get<number>('vad_silence_ms', 700)) || 700;
  const maxUtteranceSec = Number(host.settings.get<number>('max_utterance_sec', 15)) || 15;
  const voiceId = host.settings.get<string>('tts_voice_id', '') || undefined;

  handle = startWsServer({
    host: listenHost,
    port: listenPort,
    sharedSecret,
    sessionDefaults: {
      ownerChatId,
      displayStyle,
      volume,
      muted: false,
      voiceId,
      vadSilenceMs,
      maxUtteranceSec,
    },
    buildSessionDeps: (deviceId, _send) => {
      const sessionLog = host.log.child({ deviceId });
      return {
        transcribe: makeTranscribe(cfg, sessionLog),
        dispatch: makeLlmDispatch({
          llm: host.llm,
          profile: cfg.llmProfile,
          maxTokens: cfg.llmMaxTokens,
          systemPrompt: cfg.systemPrompt,
          log: sessionLog,
        }),
        synth: makeSynth(cfg, sessionLog),
      };
    },
    log: host.log,
  });
}

export async function unregister(_host: Host): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
