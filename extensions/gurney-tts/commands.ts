// /voice on|off|status — toggles per-chat voice preference. The actual
// synthesis is wired in jobs.ts via host.telegram.afterReply.

import type { Host } from '../../src/core/extensions.js';
import { getPref, setPref } from './prefs.js';
import { DEFAULT_VOICE_ID } from './voice.js';

export function register(host: Host): void {
  host.telegram.command(
    'voice',
    async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const fallback = Boolean(host.settings.get<boolean>('default_enabled', false));

      if (arg === '' || arg === 'status') {
        const cur = getPref(host.db, ctx.chatId, fallback);
        await ctx.reply(`voice replies: ${cur ? 'on' : 'off'}`);
        return;
      }
      if (arg !== 'on' && arg !== 'off') {
        await ctx.reply('Usage: /voice on|off|status');
        return;
      }
      setPref(host.db, ctx.chatId, arg === 'on');
      if (arg === 'on') {
        const explicitModel = host.settings.get<string>('voice_model_path');
        const voiceId = host.settings.get<string>('voice_id', DEFAULT_VOICE_ID) || DEFAULT_VOICE_ID;
        const source = explicitModel
          ? `model: ${explicitModel}`
          : `voice: ${voiceId} (downloads on first reply)`;
        await ctx.reply(`voice replies on - ${source}`);
        return;
      }
      await ctx.reply('voice replies off');
    },
    'Toggle voice replies: /voice on|off|status',
  );
}
