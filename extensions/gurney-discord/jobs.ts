// Long-running gateway connection. The Discord client lives for as long as
// the Gurney process does; this entrypoint owns the lifecycle and wires
// everything in lib/ together.
//
// On register():
//   * Read the bot token from settings. No token → log and return; the
//     extension is "installed but not configured" until `gurney auth
//     gurney-discord` runs.
//   * Build the identity store, allowlist accessor, bridge, confirm
//     renderer, and client wrapper (uses late-bound getters so we can
//     compose in any order without a circular dep).
//   * Register the chat surface with host.chat so the core router can
//     dispatch confirm-tier prompts to our buttons.
//   * Begin the gateway connection (do not await — login takes a few
//     seconds and we don't want to block other extensions' load).
//
// On unregister(): stop the client. In-flight confirm prompts then resolve
// false (their AbortSignals fire via the orchestrator's per-turn signals).

import type { Host } from '../../src/core/extensions.js';
import { createIdentityStore, isDiscordChatId } from './lib/identity.js';
import { createBridge, createRateLimiter, type Bridge } from './lib/bridge.js';
import { parseCsvSet, type AllowlistConfig } from './lib/allowlist.js';
import { createConfirmRenderer, type ConfirmRenderer } from './lib/confirm.js';
import { createDiscordClient, type SlashCommandSpec } from './lib/client.js';

let stop: (() => Promise<void>) | null = null;

export async function register(host: Host): Promise<void> {
  const log = host.log.child({ mod: 'gurney-discord' });
  const token = host.settings.get<string>('bot_token', '');
  if (!token) {
    log.info(
      'gurney-discord installed but no bot_token set — run `gurney auth gurney-discord` to bring the bridge up',
    );
    return;
  }
  if (!host.orchestrator) {
    log.warn('host.orchestrator unavailable — gurney-discord bridge not started');
    return;
  }

  const identity = createIdentityStore(host.db);
  const ratePerMinute = Number(host.settings.get<number>('rate_limit_per_minute', 10)) || 10;
  const rateLimiter = createRateLimiter(ratePerMinute);

  // Forward refs for composition. The client wraps discord.js and needs a
  // bridge + a confirm-button handler; the bridge needs the client's
  // outbound transport; the confirm renderer needs the client's
  // sendPrompt/editPrompt. We tie the knot with let-slots populated below.
  let bridgeRef: Bridge | null = null;
  let confirmRef: ConfirmRenderer | null = null;
  let botUserId = '';

  // Allowlist is read on every inbound message so a `gurney config` edit
  // takes effect without restarting the bridge.
  const allowlistAccessor = (): AllowlistConfig => ({
    allowedDmUserIds: parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', '')),
    allowedChannelKeys: parseCsvSet(host.settings.get<string>('allowed_channel_keys', '')),
    botUserId,
  });

  const client = createDiscordClient({
    token,
    log,
    bridge: () => bridgeRef,
    allowlist: allowlistAccessor,
    handleConfirmButton: (customId, by) => (confirmRef ? confirmRef.onButton(customId, by) : false),
  });

  // Patch the resolveChat half of the confirm transport now that the
  // identity store exists. The send/edit halves are already wired to
  // discord.js inside client.ts.
  client.confirmTransport.resolveChat = (chatId) => identity.resolve(chatId);

  confirmRef = createConfirmRenderer({
    transport: client.confirmTransport,
    log,
  });

  bridgeRef = createBridge({
    orchestrator: host.orchestrator,
    identity,
    transport: client.outbound,
    rateLimiter,
    log,
    // The bot's own id isn't known until `ready` fires; the bridge reads
    // this via the captured reference below. Pass an empty string here
    // (treated as "no mention to strip") so the initial value is harmless;
    // we update botUserId on ready and stripBotMention closes over the
    // module's local — but `botUserId` is a primitive, so it gets copied.
    // To keep the strip live, we provide it via a getter through the bot
    // id string at construction time and re-create the bridge on ready.
    botUserId: '',
  });

  // Register the chat surface with core so confirm-tier tools targeting a
  // Discord chatId pop our buttons instead of routing back to Telegram.
  host.chat.registerConfirm({
    ownsChat: (chatId) => isDiscordChatId(chatId),
    confirm: (req) => confirmRef!.handle(req),
  });

  // Tiny opt-in slash surface. Task brief: only /gurney enable / disable,
  // and even those go through the host operator. Here we expose a single
  // /gurney command that explains current state — the actual allow/deny
  // edits happen via `gurney config gurney-discord` on the host (terminal,
  // human present), matching the "no model-driven allowlist edits" rule.
  const slashCommands: SlashCommandSpec[] = [
    {
      name: 'gurney',
      description: 'Check whether this channel is opted into Gurney',
      handle: async (ctx) => {
        if (ctx.guildId === null) {
          await ctx.replyEphemeral(
            'I respond in DMs only when your Discord user id is on the allowlist. ' +
              'Ask the bridge operator to add it via `gurney config gurney-discord`.',
          );
          return;
        }
        const key = `${ctx.guildId}:${ctx.channelId}`;
        const allowed = parseCsvSet(host.settings.get<string>('allowed_channel_keys', ''));
        const self = client.selfId() ?? 'me';
        if (allowed.has(key)) {
          await ctx.replyEphemeral(
            `This channel is opted in. Mention <@${self}> to chat. ` +
              'To opt out, remove this channel from `allowed_channel_keys` via `gurney config gurney-discord` on the host.',
          );
        } else {
          await ctx.replyEphemeral(
            "This channel isn't opted in. Ask the bridge operator to add " +
              `\`${key}\` to allowed_channel_keys via \`gurney config gurney-discord\` on the host.`,
          );
        }
      },
    },
  ];
  client.registerSlashCommands(slashCommands);

  // Start the gateway. Don't await — login takes a few seconds and other
  // extensions are still loading. Once `ready` fires we patch in the bot's
  // own user id; messages arriving before then are gated out by the
  // mention-required rule (empty botUserId means no message can match).
  void client.start().then(
    () => {
      botUserId = client.selfId() ?? '';
      // Re-build the bridge with the now-known bot id so stripBotMention
      // works for guild mentions. Lighter-weight than re-constructing the
      // client; nothing closes over `bridgeRef` directly except the
      // client's getter above, which sees the new reference next inbound.
      bridgeRef = createBridge({
        orchestrator: host.orchestrator!,
        identity,
        transport: client.outbound,
        rateLimiter,
        log,
        botUserId,
      });
      log.info('gurney-discord bridge online', {
        botUserId,
        dmAllowlistSize: parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', '')).size,
        channelOptInCount: parseCsvSet(host.settings.get<string>('allowed_channel_keys', '')).size,
      });
    },
    (e) => {
      log.warn('discord gateway login failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    },
  );

  stop = async () => {
    await client.stop();
    stop = null;
  };
}

export async function unregister(_host: Host): Promise<void> {
  if (stop) {
    await stop();
  }
}
