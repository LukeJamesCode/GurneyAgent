// Runtime entry for gurney-speaker. The loader calls register(host) on load;
// we use that moment to spin up the WebSocket server with every per-device
// session pre-wired against host.llm + gurney-voice's STT/TTS helpers.
//
// We intentionally keep this file thin: the moving parts (protocol, session
// machine, pipeline glue, WS server, device persistence) each have their own
// module and tests. jobs.ts is just the bind point.

import type { Host } from '../../src/core/extensions.js';
import { createDeviceStore } from './devices.js';
import {
  makeLlmDispatch,
  makeOrchestratorDispatch,
  makeSynth,
  makeTranscribe,
  readPipelineSettings,
  shortenForSpeech,
} from './pipeline.js';
import { startWsServer, type DeviceContext, type WsServerHandle } from './ws-server.js';

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
  const displayStyle = (
    host.settings.get<string>('display_style', 'minimal') === 'orb' ? 'orb' : 'minimal'
  ) as 'minimal' | 'orb';
  const volumeDefault = clamp01(Number(host.settings.get<number>('volume_default', 0.6)));
  const vadSilenceMs = Number(host.settings.get<number>('vad_silence_ms', 700)) || 700;
  const maxUtteranceSec = Number(host.settings.get<number>('max_utterance_sec', 15)) || 15;
  const voiceId = host.settings.get<string>('tts_voice_id', '') || undefined;
  const speechCap = Number(host.settings.get<number>('speech_max_chars', 600)) || 600;

  const devices = createDeviceStore(host.db);

  // Orchestrator dispatch is preferred — it gives the device the same
  // calendar / reminders / weather tools the Telegram surface has, plus
  // shared conversation history. We fall back to the direct-LLM path when:
  //   - host.orchestrator isn't wired (older harnesses / tests), or
  //   - owner_chat_id is unset (treat the device as a stateless chatter).
  // The fallback keeps the v0.1 behaviour intact for users who haven't yet
  // pointed the device at a Telegram chat.
  const orchestratorAvailable = Boolean(host.orchestrator) && ownerChatId !== 0;
  if (host.orchestrator && ownerChatId === 0) {
    host.log.info(
      'gurney-speaker: owner_chat_id unset — using direct LLM dispatch (no tools / history). Set owner_chat_id to your Telegram chat id to enable tool calls from voice.',
    );
  }

  handle = startWsServer({
    host: listenHost,
    port: listenPort,
    sharedSecret,
    sessionDefaults: {
      ownerChatId,
      displayStyle,
      volume: volumeDefault,
      muted: false,
      voiceId,
      vadSilenceMs,
      maxUtteranceSec,
    },
    buildSessionDeps: (deviceId, _send) => {
      const sessionLog = host.log.child({ deviceId });
      const baseDispatch =
        orchestratorAvailable && host.orchestrator
          ? makeOrchestratorDispatch({
              orchestrator: host.orchestrator,
              chatId: ownerChatId,
              // Synthetic user id derived from the device id. Stays stable
              // across reconnects so the orchestrator's per-(chat,user) state
              // (currently unused, but documented) doesn't churn.
              userId: deviceUserId(deviceId, ownerChatId),
              log: sessionLog,
            })
          : makeLlmDispatch({
              llm: host.llm,
              profile: cfg.llmProfile,
              maxTokens: cfg.llmMaxTokens,
              systemPrompt: cfg.systemPrompt,
              log: sessionLog,
            });
      const dispatch = async (text: string): Promise<string> => {
        const raw = await baseDispatch(text);
        return shortenForSpeech(raw, speechCap);
      };
      return {
        transcribe: makeTranscribe(cfg, sessionLog),
        dispatch,
        synth: makeSynth(cfg, sessionLog),
      };
    },
    buildDeviceContext: (deviceId): DeviceContext => {
      // Upsert and read the row back so the welcome we send the device
      // matches what we have on disk for it.
      const row = devices.touch(deviceId);
      return {
        config: { volume: row.lastVolume, muted: row.muted },
        persist: {
          onStateChanged: (volume, muted) => devices.saveVolumeMuted(deviceId, volume, muted),
          onShutdown: () => devices.markSeen(deviceId),
        },
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

// Map a device id (string) to a stable positive 32-bit integer so it can sit
// in the orchestrator's userId slot without colliding with real Telegram
// user ids (which fit in 64 bits but in practice are well under 2^31). The
// hash is content-addressable: same device id → same userId across reboots.
//
// We OR in 0x40000000 so the result is always > 2^30, which keeps it well
// clear of small-integer test fixtures and visibly tagged when scanning logs.
function deviceUserId(deviceId: string, ownerChatId: number): number {
  // If no per-device disambiguation is needed, just reuse the owner chat id.
  if (!deviceId) return ownerChatId;
  let h = 2166136261; // FNV-1a seed
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) | 0x40000000;
}
