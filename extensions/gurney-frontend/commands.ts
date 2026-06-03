// Telegram slash commands for gurney-frontend.
//
//   /web   — reply with the link to the web control panel so you can open it
//            from your phone. Telegram-only by nature: it's the bridge from the
//            chat surface to the browser UI.
//
// The URL is rebuilt from the same settings the panel binds to (mirrors
// setup.ts and src/cli/panel.ts) so the link stays in lockstep with what the
// server actually serves.

import { networkInterfaces } from 'node:os';
import type { Host } from '../../src/core/extensions.js';

function firstLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Build the URL a browser can open to reach the panel, mirroring setup.ts.
function panelUrl(host: Host): string {
  const listenHost = host.settings.get<string>('listen_host', '127.0.0.1') || '127.0.0.1';
  const port = Number(host.settings.get<number>('listen_port', 7777)) || 7777;
  // Mirror server.ts: HTTPS is on unless explicitly set to false.
  const httpsEnabled = host.settings.get<boolean>('https_enabled', true) !== false;
  const token = host.settings.get<string>('auth_token', '') || '';

  const shownHost = listenHost === '0.0.0.0' ? (firstLanAddress() ?? 'localhost') : listenHost;
  const scheme = httpsEnabled ? 'https' : 'http';
  const tokenQs = token ? `?token=${token}` : '';
  return `${scheme}://${shownHost}:${port}/${tokenQs}`;
}

export function register(host: Host): void {
  host.telegram.command(
    'web',
    async (ctx) => {
      const url = panelUrl(host);
      const listenHost = host.settings.get<string>('listen_host', '127.0.0.1') || '127.0.0.1';
      const lines = [`Open the Gurney web panel:`, url];
      if (listenHost !== '0.0.0.0') {
        lines.push(
          '',
          `(Bound to ${listenHost} — this machine only. Set listen_host to 0.0.0.0 via 'gurney config' to reach it from your phone.)`,
        );
      }
      await ctx.reply(lines.join('\n'));
    },
    'Get the link to the web control panel',
  );

  void host;
}
