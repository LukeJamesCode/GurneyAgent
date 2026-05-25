import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  OP,
  decodeFrame,
  encodeJson,
  encodeBytes,
  encodeEmpty,
  decodeJson,
  type HelloPayload,
  type WelcomePayload,
  type StatePayload,
} from './protocol.js';

test('encodeJson + decodeFrame + decodeJson round-trip the hello payload', () => {
  const hello: HelloPayload = { deviceId: 'puck-01', secret: 'abc123', fwVersion: '0.1.0' };
  const frame = encodeJson(OP.HELLO, hello);
  assert.equal(frame[0], OP.HELLO);

  const decoded = decodeFrame(frame);
  assert.equal(decoded.op, OP.HELLO);
  assert.deepEqual(decodeJson<HelloPayload>(decoded.payload), hello);
});

test('encodeBytes preserves PCM payload byte-for-byte', () => {
  // Two samples: 0x0001 (1) and 0xFFFE (-2) in little-endian int16.
  const pcm = Buffer.from([0x01, 0x00, 0xfe, 0xff]);
  const frame = encodeBytes(OP.PCM_FRAME, pcm);

  const decoded = decodeFrame(frame);
  assert.equal(decoded.op, OP.PCM_FRAME);
  assert.equal(decoded.payload.length, 4);
  assert.deepEqual(Array.from(decoded.payload), [0x01, 0x00, 0xfe, 0xff]);
});

test('encodeEmpty produces a single opcode byte for control ops', () => {
  for (const op of [OP.WAKE, OP.UTTERANCE_END, OP.TTS_END, OP.PING] as const) {
    const frame = encodeEmpty(op);
    assert.equal(frame.length, 1);
    assert.equal(frame[0], op);

    const decoded = decodeFrame(frame);
    assert.equal(decoded.op, op);
    assert.equal(decoded.payload.length, 0);
  }
});

test('welcome and state frames round-trip cleanly', () => {
  const welcome: WelcomePayload = {
    ok: true,
    displayStyle: 'orb',
    volume: 0.42,
    muted: false,
    voiceId: 'en_GB-northern_english_male-medium',
  };
  const f1 = encodeJson(OP.WELCOME, welcome);
  assert.deepEqual(decodeJson<WelcomePayload>(decodeFrame(f1).payload), welcome);

  const state: StatePayload = { state: 'listening' };
  const f2 = encodeJson(OP.STATE, state);
  assert.deepEqual(decodeJson<StatePayload>(decodeFrame(f2).payload), state);
});

test('decodeFrame rejects empty buffers', () => {
  assert.throws(() => decodeFrame(Buffer.alloc(0)), /empty frame/);
});

test('decodeFrame preserves unknown opcodes for graceful drop by the session', () => {
  // 0xAB isn't in the OP table; we should still get the byte back rather than
  // crashing — the session is responsible for logging+ignoring.
  const frame = Buffer.from([0xab, 0x01, 0x02]);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.op, 0xab);
  assert.deepEqual(Array.from(decoded.payload), [0x01, 0x02]);
});
