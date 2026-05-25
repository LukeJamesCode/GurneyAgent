// WebSocket adapter for gurney-speaker.
//
// Responsibilities are deliberately thin:
//   1. Bind to host:port and accept WS connections.
//   2. Wait for the device's HELLO frame, validate the shared secret.
//   3. Spin up a DeviceSession; route every subsequent inbound frame to it.
//   4. Expose a `close()` for clean shutdown (e.g. extension disable).
//
// Anything more interesting — VAD, state transitions, TTS streaming — lives
// in session.ts. That split keeps the WS layer testable on its own and lets
// the session machine be exercised without a real socket (as session.test.ts
// already does).

import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  OP,
  decodeFrame,
  decodeJson,
  encodeJson,
  type ButtonPayload,
  type HelloPayload,
  type StateSyncPayload,
} from './protocol.js';
import { DeviceSession, type SessionConfig, type SessionDeps } from './session.js';
import type { Logger } from '../../src/util/log.js';

export interface WsServerOptions {
  host: string;
  port: number;
  sharedSecret: string;
  // Session defaults pulled from settings. Each connecting device gets its
  // own DeviceSession built from these.
  sessionDefaults: Omit<SessionConfig, 'deviceId'>;
  // How a session turns PCM into a transcript and a transcript into a reply
  // + synthesised audio. Injected so tests can stub them and so the real
  // wiring lives in pipeline.ts (next slice), not here.
  buildSessionDeps: (
    deviceId: string,
    send: (frame: Buffer) => void,
  ) => Pick<SessionDeps, 'transcribe' | 'dispatch' | 'synth'>;
  log: Logger;
  // Optional, mainly for tests: skip the real server bind and let the caller
  // drive sockets directly.
  noBind?: boolean;
}

export interface WsServerHandle {
  port: number;
  close(): Promise<void>;
  // Test-only hook to inject a fake WebSocket and exercise the routing
  // without an actual TCP listener.
  _handleConnection(socket: WebSocket): void;
}

const HELLO_TIMEOUT_MS = 5_000;

export function startWsServer(opts: WsServerOptions): WsServerHandle {
  const httpServer: HttpServer | null = opts.noBind ? null : createServer();
  const wss = new WebSocketServer({ noServer: opts.noBind, server: httpServer ?? undefined });
  const sessions = new Set<DeviceSession>();

  function handleConnection(socket: WebSocket): void {
    const log = opts.log.child({ component: 'gurney-speaker/ws' });
    let session: DeviceSession | null = null;
    let helloDeadline: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      log.warn('hello timeout, dropping socket');
      try {
        socket.close(1008, 'hello timeout');
      } catch {
        /* ignore */
      }
    }, HELLO_TIMEOUT_MS);

    const send = (frame: Buffer) => {
      if (socket.readyState !== 1 /* OPEN */) return;
      socket.send(frame);
    };

    socket.on('message', (data, isBinary) => {
      if (!isBinary || !(data instanceof Buffer)) {
        // We only speak binary frames. Text frames likely indicate a buggy
        // client or a probe — close the connection rather than silently
        // accept it.
        log.warn('non-binary frame received, dropping socket');
        try {
          socket.close(1003, 'binary frames only');
        } catch {
          /* ignore */
        }
        return;
      }

      let decoded;
      try {
        decoded = decodeFrame(data);
      } catch (e) {
        log.warn('frame decode failed', { error: e instanceof Error ? e.message : String(e) });
        return;
      }

      // Before HELLO, only HELLO is accepted. Everything else is dropped.
      if (!session) {
        if (decoded.op !== OP.HELLO) {
          log.warn('pre-hello frame ignored', { op: decoded.op });
          return;
        }
        let hello: HelloPayload;
        try {
          hello = decodeJson<HelloPayload>(decoded.payload);
        } catch (e) {
          log.warn('hello payload invalid', { error: e instanceof Error ? e.message : String(e) });
          send(encodeJson(OP.WELCOME, { ok: false, reason: 'bad-hello' }));
          try {
            socket.close(1008, 'bad hello');
          } catch {
            /* ignore */
          }
          return;
        }
        if (!hello.secret || hello.secret !== opts.sharedSecret) {
          log.warn('hello rejected: secret mismatch', { deviceId: hello.deviceId });
          send(encodeJson(OP.WELCOME, { ok: false, reason: 'auth' }));
          try {
            socket.close(1008, 'auth');
          } catch {
            /* ignore */
          }
          return;
        }
        if (helloDeadline) {
          clearTimeout(helloDeadline);
          helloDeadline = null;
        }

        const sessionLog = log.child({ deviceId: hello.deviceId, fwVersion: hello.fwVersion });
        const stubs = opts.buildSessionDeps(hello.deviceId, send);
        session = new DeviceSession(
          { ...opts.sessionDefaults, deviceId: hello.deviceId },
          { ...stubs, send, log: sessionLog },
        );
        sessions.add(session);
        session.sendWelcome();
        sessionLog.info('device connected');
        return;
      }

      // Post-hello routing.
      switch (decoded.op) {
        case OP.WAKE:
          session.onWake();
          break;
        case OP.PCM_FRAME:
          session.onPcmFrame(decoded.payload);
          break;
        case OP.UTTERANCE_END:
          session.onUtteranceEnd();
          break;
        case OP.STATE_SYNC_C:
          try {
            session.onStateSync(decodeJson<StateSyncPayload>(decoded.payload));
          } catch (e) {
            log.warn('state-sync payload invalid', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
          break;
        case OP.BUTTON:
          try {
            const btn = decodeJson<ButtonPayload>(decoded.payload);
            log.info('device button', { button: btn.button });
            // Volume/mute originate from button presses on the device side,
            // but the device echoes its resulting state via STATE_SYNC. We
            // just log here.
          } catch (e) {
            log.warn('button payload invalid', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
          break;
        case OP.PING:
          send(Buffer.from([OP.PING]));
          break;
        default:
          log.warn('unknown opcode', { op: decoded.op });
      }
    });

    socket.on('close', () => {
      if (helloDeadline) clearTimeout(helloDeadline);
      if (session) {
        session.shutdown();
        sessions.delete(session);
      }
      log.info('socket closed');
    });

    socket.on('error', (e) => {
      log.warn('socket error', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  wss.on('connection', handleConnection);

  // Without these, a transport-level error (bind failure, malformed
  // listen_host setting) throws an unhandled 'error' event and kills the
  // whole Gurney process. Log and continue instead.
  wss.on('error', (e) => {
    opts.log.warn('ws server error', {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  if (httpServer) {
    // Forgive a `host:port` value in listen_host — earlier setup wizards let
    // users paste a combined string here, which Node then tries to DNS-resolve
    // verbatim and dies on. Split it out and prefer the explicit listen_port.
    let host = opts.host;
    let port = opts.port;
    const colon = host.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      const parsedPort = Number(host.slice(colon + 1));
      host = host.slice(0, colon);
      if (!port) port = parsedPort;
      opts.log.warn('listen_host contained a port — split into host + port', {
        original: opts.host,
        host,
        port,
      });
    }
    httpServer.on('error', (e) => {
      opts.log.warn('ws http server error', {
        error: e instanceof Error ? e.message : String(e),
        host,
        port,
      });
    });
    httpServer.listen(port, host, () => {
      opts.log.info('gurney-speaker ws server listening', { host, port });
    });
  }

  return {
    port: opts.port,
    async close(): Promise<void> {
      for (const s of sessions) s.shutdown();
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
    _handleConnection: handleConnection,
  };
}
