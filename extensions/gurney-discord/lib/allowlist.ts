// Inbound-message gating for gurney-discord. Decisions live here so the
// Discord client wrapper stays a thin transport.
//
// Rules:
//   * DMs are allowed only when the sender's user id is in
//     `allowed_dm_user_ids`. Empty list = no DM access.
//   * Guild channels respond only to @-mentions of the bot, and only when
//     `<guild_id>:<channel_id>` is in `allowed_channel_keys`. This is the
//     per-chat opt-in the safety doc requires for non-DM intercept.
//   * Bot messages and webhook messages are always ignored.
//
// Returns a structured decision so the caller can log why something was
// dropped (without leaking message content to logs).

export interface AllowlistConfig {
  allowedDmUserIds: Set<string>;
  allowedChannelKeys: Set<string>;
  botUserId: string;
}

export type AllowDecision =
  | { allow: true; kind: 'dm' | 'mention' }
  | { allow: false; reason: AllowDenialReason };

export type AllowDenialReason =
  | 'is_bot'
  | 'is_webhook'
  | 'dm_not_allowed'
  | 'guild_not_mentioned'
  | 'channel_not_opted_in'
  | 'self_message';

export interface InboundMessageMeta {
  authorId: string;
  authorIsBot: boolean;
  isWebhook: boolean;
  channelId: string;
  guildId: string | null;
  // The ids of users explicitly @-mentioned in the message. Required for
  // mention detection in guild channels — content-string regex would be
  // wrong (a stale @everyone, an embedded mention, etc.).
  mentionedUserIds: ReadonlySet<string>;
}

export function decide(cfg: AllowlistConfig, m: InboundMessageMeta): AllowDecision {
  if (m.authorIsBot) return { allow: false, reason: 'is_bot' };
  if (m.isWebhook) return { allow: false, reason: 'is_webhook' };
  if (m.authorId === cfg.botUserId) return { allow: false, reason: 'self_message' };

  const isDm = m.guildId === null;
  if (isDm) {
    if (cfg.allowedDmUserIds.has(m.authorId)) return { allow: true, kind: 'dm' };
    return { allow: false, reason: 'dm_not_allowed' };
  }

  // Guild channel: require both an opt-in for this channel AND an explicit
  // @-mention of the bot. The mention requirement is non-negotiable — the
  // safety doc forbids default-on group-chat intercept.
  if (!m.mentionedUserIds.has(cfg.botUserId)) {
    return { allow: false, reason: 'guild_not_mentioned' };
  }
  const key = `${m.guildId}:${m.channelId}`;
  if (!cfg.allowedChannelKeys.has(key)) {
    return { allow: false, reason: 'channel_not_opted_in' };
  }
  return { allow: true, kind: 'mention' };
}

// Parses a comma-separated settings value into a Set, ignoring whitespace
// and empty fragments. Both allowlist settings are stored as plain CSV in
// the SQLite settings table; this is the single normaliser.
export function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
