// Telegram slash commands for gurney-codex.
//
//   /codex <task>   — explicit, user-initiated handoff. Because the user typed
//                     it, this is unambiguous consent: the raw Codex output is
//                     sent straight back (truncated to Telegram's limit) rather
//                     than summarised.
//   /codexstatus    — today's usage against the daily ceiling.
//   /codexlogout    — forget stored credentials.

import type { Host } from '../../src/core/extensions.js';
import { runHandoff, readSettings } from './lib/run.js';
import { localDay, usageToday } from './lib/budget.js';
import { readTokens, clearTokens } from './lib/store.js';

// Telegram hard-caps a message at 4096 chars. Leave headroom for a header.
const TELEGRAM_LIMIT = 3900;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_LIMIT) return text;
  return text.slice(0, TELEGRAM_LIMIT) + '\n\n…(truncated — the full answer was longer)';
}

export function register(host: Host): void {
  host.telegram.command(
    'codex',
    async (ctx) => {
      const task = ctx.args.trim();
      if (!task) {
        await ctx.reply(
          'Usage: /codex <task>\nExample: /codex write a Python function that parses an ISO 8601 duration',
        );
        return;
      }
      await ctx.reply('Handing this to Codex…');
      const outcome = await runHandoff(host, { task, source: 'command', chatId: ctx.chatId });
      if (!outcome.ok) {
        await ctx.reply(outcome.message);
        return;
      }
      await ctx.reply(truncateForTelegram(outcome.result.text));
    },
    'Send a task straight to Codex: /codex <task>',
  );

  host.telegram.command(
    'codexstatus',
    async (ctx) => {
      const cfg = readSettings(host);
      const authed = readTokens(host) !== null;
      const day = localDay(Date.now(), cfg.timeZone);
      const u = usageToday(host.db, day);
      const lines = [
        `Codex status (${day})`,
        `  Auth:      ${authed ? 'connected' : 'NOT connected — run `gurney auth gurney-codex`'}`,
        `  Model:     ${cfg.model}`,
        `  Calls:     ${u.calls}/${cfg.ceiling} used today`,
        `  Tokens:    ${u.promptTokens} in / ${u.completionTokens} out`,
      ];
      await ctx.reply(lines.join('\n'));
    },
    "Today's Codex usage and remaining budget",
  );

  host.telegram.command(
    'codexlogout',
    async (ctx) => {
      if (readTokens(host) === null) {
        await ctx.reply('Codex is not connected — nothing to forget.');
        return;
      }
      clearTokens(host);
      await ctx.reply(
        'Forgot the stored Codex credentials. Run `gurney auth gurney-codex` to reconnect.',
      );
    },
    'Forget stored Codex credentials',
  );

  void host;
}
