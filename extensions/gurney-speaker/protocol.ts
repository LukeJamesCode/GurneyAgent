// Wire protocol for the gurney-speaker WebSocket connection.
//
// One binary message = one frame. Byte 0 is the opcode; bytes 1.. are the
// payload. Text-shaped payloads (hello, welcome, state, button events) are
// UTF-8 JSON; audio payloads are raw bytes. Keeping it byte-prefixed instead
// of using separate WS text/binary frames means the firmware only has to
// implement one parser path.
//
// Decode is forgiving on opcode (returns the byte even if it's not in our
// enum) so the session can log and drop unknown frames without panicking the
// connection. Encoders refuse unknown ops at compile time via the union.

export const OP = {
  // Client → server
  HELLO: 0x01, // JSON {deviceId, secret, fwVersion}
  WAKE: 0x10, // empty
  PCM_FRAME: 0x11, // raw int16le PCM @ 16 kHz mono
  UTTERANCE_END: 0x12, // empty (button release / manual end)
  STATE_SYNC_C: 0x30, // JSON {volume?, muted?}
  BUTTON: 0x31, // JSON {button}

  // Server → client
  WELCOME: 0x02, // JSON {ok, displayStyle, volume, muted, voiceId}
  STATE: 0x20, // JSON {state}
  TTS_FRAME: 0x21, // OGG/Opus bytes
  TTS_END: 0x22, // empty
  STATE_SYNC_S: 0x30, // JSON {volume?, muted?}   (same byte, mirror direction)

  // Both
  PING: 0x7f, // empty
} as const;

export type Op = (typeof OP)[keyof typeof OP];

// Hello frame the firmware sends right after connecting.
export interface HelloPayload {
  deviceId: string;
  secret: string;
  fwVersion?: string;
}

// Welcome the server pushes back. Drives the device's initial UI + volume.
export interface WelcomePayload {
  ok: boolean;
  reason?: string;
  displayStyle?: 'minimal' | 'orb';
  volume?: number;
  muted?: boolean;
  voiceId?: string;
}

export type DeviceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted';

export interface StatePayload {
  state: DeviceState;
}

export interface StateSyncPayload {
  volume?: number;
  muted?: boolean;
}

export interface ButtonPayload {
  button: 'vol_up' | 'vol_down' | 'mute' | 'spare';
}

export interface DecodedFrame {
  op: number;
  payload: Buffer;
}

export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < 1) {
    throw new Error('empty frame');
  }
  return { op: buf[0]!, payload: buf.subarray(1) };
}

export function encodeJson(op: Op, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.alloc(1 + body.length);
  out[0] = op;
  body.copy(out, 1);
  return out;
}

export function encodeBytes(op: Op, payload: Buffer): Buffer {
  const out = Buffer.alloc(1 + payload.length);
  out[0] = op;
  payload.copy(out, 1);
  return out;
}

export function encodeEmpty(op: Op): Buffer {
  return Buffer.from([op]);
}

export function decodeJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf8')) as T;
}
