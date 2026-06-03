// Inbound→orchestrator→outbound glue.
//
// For every inbound Discord message that survives the allowlist gate, we:
//   1. Resolve the (user, channel) pair to a synthetic Gurney chatId.
//   2. Strip the bot @-mention so the model sees a clean user message.
//   3. Push the text into host.orchestrator.handleUserMessage with a
//      streaming sink that buffers deltas and ships a single reply on done.
//
// Why buffer-then-send: Discord rate-limits message edits aggressively
// (5/5s per channel typical); a token-by-token editMessage stream is the
// fastest way to draw a hard 429. This mirrors what the Telegram adapter
// does — one send on done — and avoids burning the rate budget on partials.
//
// Multi-part splitting: Discord's per-message cap is 2000 chars. We split
// on paragraph boundaries when possible, then on hard length otherwise.

import type { Logger } from '../../../src/util/log.js';
import type { HostOrchestrator, HostReplyChunk } from '../../../src/core/extensions.js';
import type { IdentityStore } from './identity.js';

export const DISCORD_MESSAGE_MAX = 2_000;

// Cheap per-user token bucket. Defends against an allowlisted user
// (or compromised account) hammering the bot into a model burn.
export interface RateLimiter {
  // Returns true if the call is allowed; false if the user is over budget
  // for this minute. Side effect: increments the counter on allow.
  consume(userId: string): boolean;
}

export function createRateLimiter(perMinute: number): RateLimiter {
  if (perMinute <= 0) {
    return { consume: () => true };
  }
  const windowMs = 60_000;
  const seen = new Map<string, { count: number; resetAt: number }>();
  return {
    consume(userId): boolean {
      const now = Date.now();
      const entry = seen.get(userId);
      if (!entry || entry.resetAt <= now) {
        seen.set(userId, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (entry.count >= perMinute) return false;
      entry.count += 1;
      return true;
    },
  };
}

export interface OutboundTransport {
  // Send a fresh message to the given Discord channel. Resolves once
  // Discord has accepted the send (best-effort — the caller swallows
  // errors and logs).
  send: (channelId: string, text: string) => Promise<void>;
  // Mark the channel as "typing" while a long reply is being produced.
  // No-op on failure.
  startTyping?: (channelId: string) => Promise<void>;
}

export interface BridgeOptions {
  orchestrator: HostOrchestrator;
  identity: IdentityStore;
  transport: OutboundTransport;
  rateLimiter: RateLimiter;
  log: Logger;
  // The bot's own Discord user id. Used to strip the leading @-mention so
  // the orchestrator doesn't see "<@123456789> hi" as the user message.
  botUserId: string;
}

export interface InboundTurn {
  userId: string;
  channelId: string;
  guildId: string | null;
  rawContent: string;
}

export interface Bridge {
  handle(turn: InboundTurn): Promise<void>;
}

// Strip "<@botid>" / "<@!botid>" mentions of the bot from the message.
// Discord renders user mentions as `<@123>`; the `!` variant is the legacy
// nickname-mention form. Multiple leading/trailing mentions are stripped
// so "@gurney @gurney hello" still reads as "hello" to the model.
export function stripBotMention(content: string, botUserId: string): string {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<@!?${escaped}>`, 'g');
  return content.replace(re, '').replace(/\s+/g, ' ').trim();
}

// Split a long string into <=2000-char chunks, preferring paragraph
// boundaries. Falls back to hard slicing for content that has no paragraph
// breaks (e.g. a 3000-char code block).
export function splitForDiscord(text: string, max = DISCORD_MESSAGE_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let split = remaining.lastIndexOf('\n\n', max);
    if (split < max / 2) split = remaining.lastIndexOf('\n', max);
    if (split < max / 4) split = max;
    out.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

export function createBridge(opts: BridgeOptions): Bridge {
  return {
    async handle(turn): Promise<void> {
      const text = stripBotMention(turn.rawContent, opts.botUserId);
      if (text.length === 0) {
        // Bare mention with no content — friendly nudge, no LLM round-trip.
        await opts.transport
          .send(turn.channelId, 'Hi — send a message after the mention and I’ll respond.')
          .catch((e) => opts.log.warn('discord empty-mention reply failed', { error: errStr(e) }));
        return;
      }
      if (!opts.rateLimiter.consume(turn.userId)) {
        opts.log.info('discord rate-limited turn', { userId: turn.userId });
        await opts.transport
          .send(
            turn.channelId,
            '⏱ You’re sending messages faster than the per-minute limit. Slow down and try again shortly.',
          )
          .catch(() => {});
        return;
      }

      const gurneyChatId = opts.identity.chatIdFor({
        userId: turn.userId,
        channelId: turn.channelId,
        isDm: turn.guildId === null,
      });

      // Number() the userId for HostUserMessage.userId. Discord ids exceed
      // MAX_SAFE_INTEGER, but userId is only used by core for logging /
      // attribution; precision loss in the bottom ~10 bits doesn't change
      // any safety behaviour. The full string id is what we keep in the
      // identity table for accurate lookups.
      const userIdNum = Number(turn.userId);

      // Best-effort typing indicator — gives users feedback during the
      // multi-second cold-path. Discord ratelimits typing too, so this is
      // fire-and-forget.
      void opts.transport.startTyping?.(turn.channelId).catch(() => {});

      let buffered = '';
      const send = async (chunk: HostReplyChunk): Promise<void> => {
        if (chunk.delta) buffered += chunk.delta;
        if (chunk.done) {
          if (chunk.replace !== undefined) buffered = chunk.replace;
          const final = buffered.trim();
          if (final.length === 0) return;
          const parts = splitForDiscord(final);
          for (const part of parts) {
            try {
              await opts.transport.send(turn.channelId, part);
            } catch (e) {
              opts.log.warn('discord outbound send failed', {
                channelId: turn.channelId,
                error: errStr(e),
              });
              break;
            }
          }
        }
      };

      try {
        await opts.orchestrator.handleUserMessage({
          chatId: gurneyChatId,
          userId: userIdNum,
          text,
          send,
        });
      } catch (e) {
        opts.log.warn('discord orchestrator handleUserMessage threw', {
          chatId: gurneyChatId,
          error: errStr(e),
        });
        await opts.transport
          .send(
            turn.channelId,
            '⚠ Something went wrong handling that message. Check `gurney status` on the host.',
          )
          .catch(() => {});
      }
    },
  };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
