// Setup entry point for gurney-frontend.
//
// Runs during `gurney ext install gurney-frontend` (or `gurney ext setup`).
// It makes sure an auth token exists and prints the URL the user can open in
// a browser, plus how to launch the server. The server itself runs as its own
// process (`gurney frontend`) so it can start/stop the agent daemon without
// taking itself down — see server.ts.

import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { ExtensionSetupContext } from '../../src/core/extensions.js';

function firstLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

export async function setup(ctx: ExtensionSetupContext): Promise<void> {
  const host = ctx.settings.get<string>('listen_host', '127.0.0.1') || '127.0.0.1';
  const port = Number(ctx.settings.get<number>('listen_port', 7777)) || 7777;

  let token = ctx.settings.get<string>('auth_token', '') || '';
  if (token.length < 24) {
    token = randomBytes(24).toString('base64url');
    ctx.settings.set('auth_token', token);
    ctx.stdout('gurney-frontend: generated a panel access token.\n');
  }

  const shownHost = host === '0.0.0.0' ? (firstLanAddress() ?? 'localhost') : host;
  const base = `http://${shownHost}:${port}`;

  ctx.stdout(
    `\ngurney-frontend is configured.\n` +
      `  Start the panel:   gurney frontend\n` +
      `  Then open:         ${base}/?token=${token}\n`,
  );
  if (host === '0.0.0.0') {
    ctx.stdout(
      `  (Bound to 0.0.0.0 — reachable from other devices on your LAN. The token above is required.)\n`,
    );
  } else {
    ctx.stdout(
      `  (Bound to ${host} — this machine only. Set listen_host to 0.0.0.0 via 'gurney config' to reach it from your phone.)\n`,
    );
  }
}
