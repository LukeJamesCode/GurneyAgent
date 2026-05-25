// Per-device session machine.
//
// State graph (all transitions explicit, no implicit "fall through"):
//
//     ┌──── mute ─────┐
//     ▼               │
//   muted          (any state) ── unmute ──► idle
//     ▲
//     │ mute
//     │
//   idle ── wake ──► listening ── silence/cap/utterance-end ──► thinking
//                       ▲                                          │
//                       │ another wake while listening = ignored   │
//                       │                                          ▼
//                    speaking ◄── transcript dispatched ── orchestrator
//                       │
//                       │ tts-end
//                       ▼
//                     idle
//
// Side-effects (transcribe / dispatch / synth) are injected as
// dependencies so the whole machine can be exercised without whisper / ollama
// / piper installed. The session is also intentionally synchronous about
// "what op the device just sent" — async I/O happens inside the injected
// functions, not inside the dispatch routing, so reasoning about ordering is
// cheap.

import type { Logger } from '../../src/util/log.js';
import { OP, encodeBytes, encodeEmpty, encodeJson, type DeviceState } from './protocol.js';

export interface SessionConfig {
  deviceId: string;
  ownerChatId: number;
  displayStyle: 'minimal' | 'orb';
  volume: number;
  muted: boolean;
  voiceId?: string;
  vadSilenceMs: number;
  maxUtteranceSec: number;
}

export interface TranscribeFn {
  (pcm: Buffer): Promise<string>;
}

export interface DispatchFn {
  (text: string, ctx: { deviceId: string; ownerChatId: number }): Promise<string>;
}

export interface SynthFn {
  // Returns an async iterable of OGG/Opus byte chunks. Streaming-friendly so a
  // long reply can start playing before synthesis fully finishes.
  (text: string, voiceId?: string): AsyncIterable<Buffer>;
}

export interface SendFn {
  (frame: Buffer): void;
}

export interface SessionDeps {
  transcribe: TranscribeFn;
  dispatch: DispatchFn;
  synth: SynthFn;
  send: SendFn;
  log: Logger;
  // Injected so tests can run virtual time. Real callers omit it.
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

// Approx threshold: count a 20 ms frame as "silent" if its mean absolute
// 16-bit sample value falls below this. ~600 corresponds to roughly -30 dBFS
// in 16-bit terms, which is well below room-tone noise on the INMP441.
const SILENCE_MEAN_ABS = 600;

export class DeviceSession {
  state: DeviceState;
  private cfg: SessionConfig;
  private deps: Required<Omit<SessionDeps, 'log'>> & { log: Logger };
  private pcm: Buffer[] = [];
  private pcmBytes = 0;
  private listeningStart = 0;
  private silenceMs = 0;
  private lastFrameAt = 0;
  private silenceTimer: unknown = null;
  private maxTimer: unknown = null;
  // Bumped when we kick off a turn pipeline; lets us short-circuit if a mute
  // arrives while we're mid-transcribe / mid-synth.
  private turnSeq = 0;

  constructor(cfg: SessionConfig, deps: SessionDeps) {
    this.cfg = cfg;
    this.deps = {
      transcribe: deps.transcribe,
      dispatch: deps.dispatch,
      synth: deps.synth,
      send: deps.send,
      log: deps.log,
      now: deps.now ?? (() => Date.now()),
      setTimeout: deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms)),
      clearTimeout: deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
    this.state = cfg.muted ? 'muted' : 'idle';
  }

  // Push the welcome frame the device expects right after authentication.
  // Exposed so the WS adapter can decide when it's safe to send (i.e. after
  // hello validation).
  sendWelcome(): void {
    this.deps.send(
      encodeJson(OP.WELCOME, {
        ok: true,
        displayStyle: this.cfg.displayStyle,
        volume: this.cfg.volume,
        muted: this.cfg.muted,
        voiceId: this.cfg.voiceId,
      }),
    );
    this.pushState(this.state);
  }

  onWake(): void {
    if (this.state === 'muted') {
      this.deps.log.debug('wake ignored while muted', { deviceId: this.cfg.deviceId });
      return;
    }
    if (this.state !== 'idle') {
      // Wake during listening/thinking/speaking = ignored. Picking up a new
      // turn mid-reply would mean tearing down the current TTS stream; defer
      // barge-in handling to a later iteration.
      this.deps.log.debug('wake ignored, not idle', { state: this.state });
      return;
    }
    this.beginListening();
  }

  onPcmFrame(payload: Buffer): void {
    if (this.state !== 'listening') return;
    if (payload.length === 0) return;

    this.pcm.push(payload);
    this.pcmBytes += payload.length;
    this.lastFrameAt = this.deps.now();

    // Reset the silence timer every time we see a non-silent frame; if the
    // frame is below the silence threshold, let the timer keep running.
    if (meanAbsInt16(payload) >= SILENCE_MEAN_ABS) {
      this.silenceMs = 0;
      this.armSilenceTimer();
    }
  }

  onUtteranceEnd(): void {
    if (this.state === 'listening') void this.closeTurn('utterance-end');
  }

  onStateSync(payload: { volume?: number; muted?: boolean }): void {
    if (typeof payload.volume === 'number') {
      this.cfg.volume = clamp01(payload.volume);
    }
    if (typeof payload.muted === 'boolean') {
      if (payload.muted) {
        this.applyMute();
      } else {
        this.applyUnmute();
      }
    }
  }

  // Called by the WS server when the device disconnects. Clears timers so we
  // don't fire into a closed socket.
  shutdown(): void {
    this.clearTimers();
  }

  // ---- internals --------------------------------------------------------

  private beginListening(): void {
    this.state = 'listening';
    this.pcm = [];
    this.pcmBytes = 0;
    this.listeningStart = this.deps.now();
    this.lastFrameAt = this.listeningStart;
    this.silenceMs = 0;
    this.armSilenceTimer();
    this.armMaxTimer();
    this.pushState('listening');
  }

  private armSilenceTimer(): void {
    if (this.silenceTimer) this.deps.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.deps.setTimeout(() => {
      if (this.state === 'listening') void this.closeTurn('silence');
    }, this.cfg.vadSilenceMs);
  }

  private armMaxTimer(): void {
    if (this.maxTimer) this.deps.clearTimeout(this.maxTimer);
    this.maxTimer = this.deps.setTimeout(() => {
      if (this.state === 'listening') void this.closeTurn('max-duration');
    }, this.cfg.maxUtteranceSec * 1000);
  }

  private clearTimers(): void {
    if (this.silenceTimer) this.deps.clearTimeout(this.silenceTimer);
    if (this.maxTimer) this.deps.clearTimeout(this.maxTimer);
    this.silenceTimer = null;
    this.maxTimer = null;
  }

  private async closeTurn(reason: 'silence' | 'utterance-end' | 'max-duration'): Promise<void> {
    if (this.state !== 'listening') return;

    const seq = ++this.turnSeq;
    const buf = Buffer.concat(this.pcm, this.pcmBytes);
    this.pcm = [];
    this.pcmBytes = 0;
    this.clearTimers();
    this.state = 'thinking';
    this.pushState('thinking');

    this.deps.log.info('speaker turn closed', {
      deviceId: this.cfg.deviceId,
      reason,
      pcmBytes: buf.length,
    });

    let transcript = '';
    try {
      transcript = (await this.deps.transcribe(buf)).trim();
    } catch (e) {
      this.deps.log.warn('transcribe failed', { error: errMsg(e) });
      this.finishTurn(seq);
      return;
    }
    if (this.aborted(seq)) return;
    if (!transcript) {
      this.deps.log.info('empty transcript, dropping turn');
      this.finishTurn(seq);
      return;
    }

    let reply = '';
    try {
      reply = await this.deps.dispatch(transcript, {
        deviceId: this.cfg.deviceId,
        ownerChatId: this.cfg.ownerChatId,
      });
    } catch (e) {
      this.deps.log.warn('dispatch failed', { error: errMsg(e) });
      this.finishTurn(seq);
      return;
    }
    if (this.aborted(seq)) return;
    if (!reply.trim()) {
      this.deps.log.info('empty reply, no TTS');
      this.finishTurn(seq);
      return;
    }

    this.state = 'speaking';
    this.pushState('speaking');

    try {
      for await (const chunk of this.deps.synth(reply, this.cfg.voiceId)) {
        if (this.aborted(seq)) return;
        this.deps.send(encodeBytes(OP.TTS_FRAME, chunk));
      }
    } catch (e) {
      this.deps.log.warn('synth failed mid-stream', { error: errMsg(e) });
    } finally {
      if (!this.aborted(seq)) {
        this.deps.send(encodeEmpty(OP.TTS_END));
        this.finishTurn(seq);
      }
    }
  }

  // Read this.state through a method call so TypeScript can't narrow across
  // await boundaries — mute can transition state at any time and the
  // narrowing-after-assignment compiler heuristic confuses things otherwise.
  private aborted(seq: number): boolean {
    return seq !== this.turnSeq || this.state === 'muted';
  }

  private finishTurn(seq: number): void {
    if (seq !== this.turnSeq) return;
    if (this.state !== 'muted') {
      this.state = 'idle';
      this.pushState('idle');
    }
  }

  private applyMute(): void {
    this.cfg.muted = true;
    this.turnSeq++; // invalidate any in-flight turn
    this.pcm = [];
    this.pcmBytes = 0;
    this.clearTimers();
    this.state = 'muted';
    this.pushState('muted');
  }

  private applyUnmute(): void {
    this.cfg.muted = false;
    if (this.state === 'muted') {
      this.state = 'idle';
      this.pushState('idle');
    }
  }

  private pushState(s: DeviceState): void {
    this.deps.send(encodeJson(OP.STATE, { state: s }));
  }

  // Test introspection — exposed for assertions, not for general use.
  _internals() {
    return {
      pcmBytes: this.pcmBytes,
      turnSeq: this.turnSeq,
      silenceMs: this.silenceMs,
      listeningStart: this.listeningStart,
      lastFrameAt: this.lastFrameAt,
    };
  }
}

function meanAbsInt16(buf: Buffer): number {
  // Tolerate odd-length buffers by ignoring the trailing odd byte (shouldn't
  // happen — every PCM frame is sample-aligned — but defensive).
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) return 0;
  let acc = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    acc += Math.abs(s);
  }
  return acc / samples;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
