// /voice command: toggles per-chat voice preferences.
//
//   /voice on|off|status           — outbound TTS replies (Piper).
//   /voice transcribe on|off|status — inbound STT on voice notes (whisper.cpp).
//
// The actual synthesis + transcription is wired in jobs.ts / voice-in.ts.

import type { Host } from '../../src/core/extensions.js';
import { getPref, setPref, getSttPref, setSttPref } from './prefs.js';
import { DEFAULT_VOICE_ID } from './voice.js';

const USAGE = 'Usage: /voice on|off|status, or /voice transcribe on|off|status';

export function register(host: Host): void {
  host.telegram.command(
    'voice',
    async (ctx) => {
      const args = ctx.args.trim().toLowerCase().split(/\s+/).filter(Boolean);

      // Voice-in subcommand: `/voice transcribe …`
      if (args[0] === 'transcribe') {
        const sub = args[1] ?? 'status';
        const fallback = Boolean(host.settings.get<boolean>('stt_default_enabled', false));

        if (sub === 'status') {
          const cur = getSttPref(host.db, ctx.chatId, fallback);
          await ctx.reply(`voice transcription: ${cur ? 'on' : 'off'}`);
          return;
        }
        if (sub !== 'on' && sub !== 'off') {
          await ctx.reply(USAGE);
          return;
        }
        setSttPref(host.db, ctx.chatId, sub === 'on');
        if (sub === 'on') {
          const modelPath = host.settings.get<string>('whisper_model_path', '');
          if (!modelPath) {
            await ctx.reply(
              'voice transcription on — but no whisper model is configured. Run `gurney ext install gurney-voice` to download one.',
            );
            return;
          }
          await ctx.reply('voice transcription on — send me a voice note.');
          return;
        }
        await ctx.reply('voice transcription off');
        return;
      }

      // Outbound TTS toggle: `/voice on|off|status`
      const arg = args[0] ?? '';
      const fallback = Boolean(host.settings.get<boolean>('default_enabled', false));

      if (arg === '' || arg === 'status') {
        const cur = getPref(host.db, ctx.chatId, fallback);
        await ctx.reply(`voice replies: ${cur ? 'on' : 'off'}`);
        return;
      }
      if (arg !== 'on' && arg !== 'off') {
        await ctx.reply(USAGE);
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
    'Voice settings: /voice on|off|status, /voice transcribe on|off|status',
  );
}
