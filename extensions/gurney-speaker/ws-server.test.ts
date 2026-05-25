import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { startWsServer, type WsServerOptions } from './ws-server.js';
import {
  OP,
  decodeFrame,
  decodeJson,
  encodeJson,
  encodeEmpty,
  encodeBytes,
  type HelloPayload,
  type WelcomePayload,
} from './protocol.js';

// Minimal stand-in for the `ws` WebSocket. We only use these members:
//   readyState, send, close, plus EventEmitter semantics for message/close/error.
// Casting to WebSocket is intentional — the server code never reaches for the
// real grammar-defined methods.
class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: Buffer[] = [];
  closed = false;
  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
  // Helpers
  rxBinary(frame: Buffer): void {
    this.emit('message', frame, true);
  }
  rxText(text: string): void {
    this.emit('message', Buffer.from(text), false);
  }
}

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

function makeServer(over: Partial<WsServerOptions> = {}) {
  const transcribeCalls: Buffer[] = [];
  const dispatchCalls: string[] = [];

  const opts: WsServerOptions = {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: 'topsecret',
    sessionDefaults: {
      ownerChatId: 1,
      displayStyle: 'minimal',
      volume: 0.5,
      muted: false,
      vadSilenceMs: 100,
      maxUtteranceSec: 5,
    },
    buildSessionDeps: (_deviceId, _send) => ({
      transcribe: async (pcm) => {
        transcribeCalls.push(pcm);
        return 'hi';
      },
      dispatch: async (text) => {
        dispatchCalls.push(text);
        return 'hello back';
      },
      synth: async function* (): AsyncGenerator<Buffer> {
        // No chunks — keep the test focused on routing, not synth shape.
        // The `if` short-circuits before reaching yield, but its presence
        // keeps eslint's require-yield rule happy without disabling.
        if (false as boolean) yield Buffer.alloc(0);
      },
    }),
    log: silentLog,
    noBind: true, // skip the real TCP listen
    ...over,
  };
  const handle = startWsServer(opts);
  return { handle, transcribeCalls, dispatchCalls };
}

test('hello with correct secret triggers welcome + initial state', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);

  sock.rxBinary(
    encodeJson<HelloPayload>(OP.HELLO, {
      deviceId: 'puck-1',
      secret: 'topsecret',
      fwVersion: '0.1.0',
    }),
  );

  // Expect WELCOME and STATE frames sent back.
  const ops = sock.sent.map((f) => f[0]);
  assert.ok(ops.includes(OP.WELCOME));
  assert.ok(ops.includes(OP.STATE));

  const welcomeFrame = sock.sent.find((f) => f[0] === OP.WELCOME)!;
  const welcome = decodeJson<WelcomePayload>(decodeFrame(welcomeFrame).payload);
  assert.equal(welcome.ok, true);
  assert.equal(welcome.displayStyle, 'minimal');
});

test('hello with wrong secret sends rejection and closes', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);

  sock.rxBinary(encodeJson<HelloPayload>(OP.HELLO, { deviceId: 'puck-1', secret: 'wrong' }));

  const welcomeFrame = sock.sent.find((f) => f[0] === OP.WELCOME)!;
  const welcome = decodeJson<WelcomePayload>(decodeFrame(welcomeFrame).payload);
  assert.equal(welcome.ok, false);
  assert.equal(welcome.reason, 'auth');
  assert.equal(sock.closed, true);
});

test('pre-hello frames are dropped without crashing the server', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);

  // PCM before HELLO — should be silently ignored.
  sock.rxBinary(encodeBytes(OP.PCM_FRAME, Buffer.alloc(320)));
  assert.equal(sock.sent.length, 0);
  assert.equal(sock.closed, false);
});

test('text-frame clients are kicked', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);

  sock.rxText('hello there');
  assert.equal(sock.closed, true);
});

test('PCM frames after hello reach the session (transcribe sees the buffer)', async () => {
  const { handle, transcribeCalls } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);

  sock.rxBinary(encodeJson<HelloPayload>(OP.HELLO, { deviceId: 'puck-1', secret: 'topsecret' }));
  sock.rxBinary(encodeEmpty(OP.WAKE));

  // Push a loud PCM frame, then end-of-utterance hint to flush immediately.
  const loud = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) loud.writeInt16LE(8000, i * 2);
  sock.rxBinary(encodeBytes(OP.PCM_FRAME, loud));
  sock.rxBinary(encodeEmpty(OP.UTTERANCE_END));

  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));

  assert.equal(transcribeCalls.length, 1);
  assert.equal(transcribeCalls[0]!.length, loud.length);
});

test('ping is echoed back', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);
  sock.rxBinary(encodeJson(OP.HELLO, { deviceId: 'p', secret: 'topsecret' }));
  // Clear send buffer of welcome frames so we only check the ping echo.
  const before = sock.sent.length;
  sock.rxBinary(encodeEmpty(OP.PING));
  const after = sock.sent.slice(before);
  assert.equal(after.length, 1);
  assert.equal(after[0]![0], OP.PING);
});

test('close after hello shuts down the session cleanly', async () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);
  sock.rxBinary(encodeJson(OP.HELLO, { deviceId: 'p', secret: 'topsecret' }));
  sock.close();
  await handle.close();
  // No throw == success. The internal sessions set was cleared.
});

test('buildDeviceContext overrides volume + muted in the welcome frame', () => {
  const persistCalls: Array<{ kind: string; args: unknown[] }> = [];
  const { handle } = makeServer({
    buildDeviceContext: (deviceId) => {
      assert.equal(deviceId, 'puck-stored');
      return {
        config: { volume: 0.25, muted: true },
        persist: {
          onStateChanged: (v, m) => persistCalls.push({ kind: 'changed', args: [v, m] }),
          onShutdown: () => persistCalls.push({ kind: 'shutdown', args: [] }),
        },
      };
    },
  });

  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);
  sock.rxBinary(encodeJson(OP.HELLO, { deviceId: 'puck-stored', secret: 'topsecret' }));

  const welcomeFrame = sock.sent.find((f) => f[0] === OP.WELCOME)!;
  const welcome = decodeJson<WelcomePayload>(decodeFrame(welcomeFrame).payload);
  assert.equal(welcome.volume, 0.25);
  assert.equal(welcome.muted, true);

  // Initial state must reflect muted, since cfg.muted=true short-circuits to
  // GS_STATE_MUTED in the session constructor.
  const stateFrame = sock.sent.find((f) => f[0] === OP.STATE)!;
  const state = decodeJson<{ state: string }>(decodeFrame(stateFrame).payload);
  assert.equal(state.state, 'muted');

  // A real change triggers onStateChanged.
  sock.rxBinary(encodeJson(OP.STATE_SYNC_C, { volume: 0.5 }));
  assert.ok(
    persistCalls.some((c) => c.kind === 'changed'),
    'expected onStateChanged after volume update',
  );

  sock.close();
  assert.ok(
    persistCalls.some((c) => c.kind === 'shutdown'),
    'expected onShutdown on close',
  );
});

test('without buildDeviceContext the schema defaults still drive the welcome', () => {
  const { handle } = makeServer();
  const sock = new FakeSocket();
  handle._handleConnection(sock as unknown as WebSocket);
  sock.rxBinary(encodeJson(OP.HELLO, { deviceId: 'puck-default', secret: 'topsecret' }));

  const welcomeFrame = sock.sent.find((f) => f[0] === OP.WELCOME)!;
  const welcome = decodeJson<WelcomePayload>(decodeFrame(welcomeFrame).payload);
  // sessionDefaults.volume is 0.5 in makeServer's helper.
  assert.equal(welcome.volume, 0.5);
  assert.equal(welcome.muted, false);
});
