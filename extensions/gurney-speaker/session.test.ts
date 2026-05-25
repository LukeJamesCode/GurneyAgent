import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DeviceSession, type SessionConfig, type SessionDeps } from './session.js';
import { OP, decodeFrame, decodeJson, type StatePayload, type WelcomePayload } from './protocol.js';

// Flush the microtask queue fully. The session's closeTurn pipeline awaits
// transcribe + dispatch + an async-iterable synth, which together chain
// dozens of microtasks. setImmediate hops over to the macrotask queue, so by
// the time it fires every pending microtask has resolved.
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// Virtual clock + setTimeout shim. The session is built to accept these so
// tests can drive timers without sleeping.
function makeClock() {
  let now = 1_000_000; // arbitrary epoch in ms — only deltas matter
  const queued: Array<{ at: number; cb: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      const handle = { at: now + ms, cb, id: nextId++ };
      queued.push(handle);
      return handle;
    },
    clearTimeout: (h: unknown) => {
      const target = h as { id: number };
      const idx = queued.findIndex((q) => q.id === target.id);
      if (idx >= 0) queued.splice(idx, 1);
    },
    advance: async (ms: number) => {
      const target = now + ms;
      // Fire timers in chronological order.
      queued.sort((a, b) => a.at - b.at);
      while (queued.length && queued[0]!.at <= target) {
        const next = queued.shift()!;
        now = next.at;
        next.cb();
        // Let any awaited promises advance after each fired timer. Two awaits
        // here cover most one-tick chains the session uses.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

function makeRecorder() {
  const frames: Buffer[] = [];
  return {
    send: (buf: Buffer) => {
      frames.push(buf);
    },
    frames,
    states: () =>
      frames
        .filter((f) => f[0] === OP.STATE)
        .map((f) => decodeJson<StatePayload>(decodeFrame(f).payload).state),
    ttsChunks: () => frames.filter((f) => f[0] === OP.TTS_FRAME).map((f) => decodeFrame(f).payload),
    hasTtsEnd: () => frames.some((f) => f[0] === OP.TTS_END),
  };
}

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

function defaultCfg(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    deviceId: 'puck-test',
    ownerChatId: 1,
    displayStyle: 'minimal',
    volume: 0.5,
    muted: false,
    voiceId: undefined,
    vadSilenceMs: 700,
    maxUtteranceSec: 15,
    ...over,
  };
}

// 20 ms of "loud" PCM (mean abs well above the silence threshold)
function loudFrame(): Buffer {
  const samples = 320; // 20 ms * 16 kHz
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(8000, i * 2);
  return b;
}

// 20 ms of zeroes — quiet enough that the silence timer keeps running
function quietFrame(): Buffer {
  return Buffer.alloc(320 * 2);
}

function makeDeps(over: Partial<SessionDeps> = {}): {
  deps: SessionDeps;
  clock: ReturnType<typeof makeClock>;
  rec: ReturnType<typeof makeRecorder>;
} {
  const clock = makeClock();
  const rec = makeRecorder();
  const deps: SessionDeps = {
    transcribe: async () => 'hello',
    dispatch: async () => 'hi there',
    synth: async function* () {
      yield Buffer.from('OggS1');
      yield Buffer.from('OggS2');
    },
    send: rec.send,
    log: silentLog,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...over,
  };
  return { deps, clock, rec };
}

test('sendWelcome emits welcome + initial idle state', () => {
  const { deps, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();

  assert.equal(rec.frames[0]![0], OP.WELCOME);
  const welcome = decodeJson<WelcomePayload>(decodeFrame(rec.frames[0]!).payload);
  assert.equal(welcome.ok, true);
  assert.equal(welcome.displayStyle, 'minimal');
  assert.deepEqual(rec.states(), ['idle']);
});

test('wake → loud frames → silence closes turn → speaking → idle', async () => {
  const { deps, clock, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 500 }), deps);
  s.sendWelcome();

  s.onWake();
  assert.equal(s.state, 'listening');
  // Three loud 20 ms frames keep the silence timer reset.
  for (let i = 0; i < 3; i++) {
    s.onPcmFrame(loudFrame());
    await clock.advance(20);
  }
  // No more audio; the silence timer should fire after vadSilenceMs.
  await clock.advance(600);
  await settle();

  assert.deepEqual(rec.states(), ['idle', 'listening', 'thinking', 'speaking', 'idle']);
  assert.equal(rec.ttsChunks().length, 2);
  assert.equal(rec.hasTtsEnd(), true);
  assert.equal(s.state, 'idle');
});

test('max-utterance cap forces turn close even without silence', async () => {
  const { deps, clock, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 5_000, maxUtteranceSec: 2 }), deps);
  s.sendWelcome();

  s.onWake();
  // Stream 2 seconds of audio with a non-silent frame at each step so the
  // silence timer keeps getting reset — only max-utterance should fire.
  for (let i = 0; i < 100; i++) {
    s.onPcmFrame(loudFrame());
    await clock.advance(20);
  }
  // 100 * 20 ms = 2 s elapsed; cap fires.
  await clock.advance(50);
  await settle();

  assert.ok(rec.states().includes('thinking'), 'max cap should have closed the turn');
  assert.equal(s.state, 'idle');
});

test('utterance-end hint closes the turn immediately', async () => {
  const { deps, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();

  s.onWake();
  s.onPcmFrame(loudFrame());
  s.onUtteranceEnd();
  await settle();

  assert.deepEqual(rec.states().slice(-1), ['idle']);
  assert.equal(rec.hasTtsEnd(), true);
});

test('mute mid-listening drops PCM buffer and emits muted state', async () => {
  const { deps, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();

  s.onWake();
  s.onPcmFrame(loudFrame());
  s.onPcmFrame(loudFrame());
  assert.ok(s._internals().pcmBytes > 0);

  s.onStateSync({ muted: true });
  assert.equal(s.state, 'muted');
  assert.equal(s._internals().pcmBytes, 0);
  // Last emitted state must be 'muted'.
  assert.equal(rec.states().slice(-1)[0], 'muted');
});

test('mute during synth aborts the TTS stream and skips TTS_END', async () => {
  // Deferred so the test can pause the synth generator after the first chunk,
  // apply mute, then let the generator yield again. The session's for-await
  // loop checks state before sending each chunk, so the second chunk should
  // be dropped and TTS_END should never fire.
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const { deps, clock, rec } = makeDeps({
    transcribe: async () => 'hi',
    dispatch: async () => 'long winded answer',
    synth: async function* () {
      yield Buffer.from('chunk-1');
      await gate;
      yield Buffer.from('chunk-2');
    },
  });
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 100 }), deps);
  s.sendWelcome();
  s.onWake();
  s.onPcmFrame(loudFrame());
  await clock.advance(150);
  await settle();

  // First chunk has shipped; state should be 'speaking'.
  assert.equal(s.state, 'speaking');
  assert.equal(rec.ttsChunks().length, 1);

  // Apply mute, then release the synth gate so chunk-2 is offered.
  s.onStateSync({ muted: true });
  release();
  await settle();

  assert.equal(rec.ttsChunks().length, 1, 'second chunk must not be sent');
  assert.equal(rec.hasTtsEnd(), false, 'TTS_END must not fire after mute');
  assert.equal(s.state, 'muted');
});

test('empty transcript skips dispatch and ends the turn at idle', async () => {
  let dispatched = false;
  const { deps, clock, rec } = makeDeps({
    transcribe: async () => '   ',
    dispatch: async () => {
      dispatched = true;
      return 'should not run';
    },
  });
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 100 }), deps);
  s.sendWelcome();
  s.onWake();
  s.onPcmFrame(loudFrame());
  await clock.advance(150);
  await settle();

  assert.equal(dispatched, false);
  assert.equal(rec.hasTtsEnd(), false);
  assert.equal(s.state, 'idle');
});

test('wake while not idle is ignored (no extra listening state)', () => {
  const { deps, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();
  s.onWake();
  s.onWake();
  s.onWake();
  // Only one transition into 'listening' should be visible.
  const listening = rec.states().filter((x) => x === 'listening').length;
  assert.equal(listening, 1);
});

test('volume sync clamps to [0,1]', () => {
  const { deps } = makeDeps();
  const cfg = defaultCfg({ volume: 0.5 });
  const s = new DeviceSession(cfg, deps);
  s.onStateSync({ volume: 2 });
  assert.equal(cfg.volume, 1);
  s.onStateSync({ volume: -0.5 });
  assert.equal(cfg.volume, 0);
});

test('quiet frames do not reset the silence timer', async () => {
  const { deps, clock, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 300 }), deps);
  s.sendWelcome();
  s.onWake();

  // One loud frame to start the buffer, then quiet frames that should NOT
  // re-arm the silence timer. After 300 ms the turn should close.
  s.onPcmFrame(loudFrame());
  await clock.advance(50);
  s.onPcmFrame(quietFrame());
  await clock.advance(300);
  await clock.advance(0);

  // The silence timer was armed once at the loud frame and fired at +300 ms.
  assert.ok(rec.states().includes('thinking'));
});

test('wake with no spoken audio still closes via the silence VAD', async () => {
  // The silence timer is armed at beginListening(), so a user who triggers
  // the wake word but says nothing won't leave the device hung in
  // 'listening' forever — the empty turn falls through to dispatch with an
  // empty transcript, which closes back to idle.
  const { deps, clock, rec } = makeDeps({ transcribe: async () => '' });
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 200 }), deps);
  s.sendWelcome();
  s.onWake();
  s.onPcmFrame(quietFrame());
  await clock.advance(500);
  await settle();
  assert.equal(s.state, 'idle');
  assert.ok(rec.states().includes('thinking'));
});

test('shutdown clears pending timers so no orphan fires reach the closed socket', async () => {
  const { deps, clock, rec } = makeDeps();
  const s = new DeviceSession(defaultCfg({ vadSilenceMs: 200 }), deps);
  s.sendWelcome();
  s.onWake();
  s.onPcmFrame(loudFrame());
  s.shutdown();
  const stateCountBefore = rec.states().length;
  await clock.advance(500);
  assert.equal(rec.states().length, stateCountBefore);
});

test('persist.onStateChanged fires when volume or mute actually changes', () => {
  const changes: Array<[number, boolean]> = [];
  const { deps } = makeDeps();
  deps.persist = {
    onStateChanged: (v, m) => changes.push([v, m]),
  };
  const s = new DeviceSession(defaultCfg({ volume: 0.5 }), deps);
  s.sendWelcome();
  // Idempotent re-send — no row should be written for the no-op.
  s.onStateSync({ volume: 0.5 });
  assert.equal(changes.length, 0);
  // Real change.
  s.onStateSync({ volume: 0.2 });
  assert.deepEqual(changes, [[0.2, false]]);
  // Mute toggle.
  s.onStateSync({ muted: true });
  assert.deepEqual(changes[1], [0.2, true]);
  // Re-asserting the same mute state must not fire again.
  s.onStateSync({ muted: true });
  assert.equal(changes.length, 2);
});

test('persist.onShutdown fires exactly once on shutdown', () => {
  let shutdowns = 0;
  const { deps } = makeDeps();
  deps.persist = {
    onShutdown: () => {
      shutdowns += 1;
    },
  };
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();
  s.shutdown();
  assert.equal(shutdowns, 1);
});

test('persist callback errors do not propagate and are logged', () => {
  let warned = 0;
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {
      warned += 1;
    },
    error: () => {},
    child(): typeof log {
      return log;
    },
  };
  const { deps } = makeDeps({ log });
  deps.persist = {
    onStateChanged: () => {
      throw new Error('db locked');
    },
    onShutdown: () => {
      throw new Error('db gone');
    },
  };
  const s = new DeviceSession(defaultCfg(), deps);
  s.sendWelcome();
  // Both of these should not throw.
  s.onStateSync({ volume: 0.1 });
  s.shutdown();
  assert.equal(warned, 2);
});
