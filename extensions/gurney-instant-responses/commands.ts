// Instant responses — templated replies shipped before the orchestrator runs
// the LLM. Lifted directly from ATLAS's instant-reply table.
//
// Two modes, both running off the same Telegram intercept:
//
//  1. TRIVIAL REPLIES — the message IS chatter ("hi", "thanks", "ok"). We
//     ship a templated reply and skip the orchestrator entirely. On a
//     Pi-class device that's <5ms vs 8-15s for an LLM turn.
//
//  2. OFFLOAD ACKS — the message has tool/query intent ("set an event",
//     "what's the weather"). The LLM still has to run, but we send a quick
//     "On it." / "Checking." ack first so the user isn't staring at a blank
//     chat for the 30-90s the model takes on CPU. Then we call ctx.next()
//     and the orchestrator processes normally.
//
// Each pattern maps to a pool of variants. We pick a random one, avoiding
// repetition within the same chat, so it doesn't feel canned. Greeting
// variants are time-of-day aware (e.g. "Morning." vs "Evening.").

import type { Host, TelegramInterceptContext } from '../../src/core/extensions.js';

type ReplyPool = string[] | ((hour: number) => string[]);

// ── Trivial replies — message IS the answer, no orchestrator follow-up ────
const TRIVIAL_REPLIES: Array<[RegExp, ReplyPool]> = [
  [
    /^(hi|hey|hello)[\s!?.]*$/i,
    (h) => {
      if (h < 5) return ['Up late?', 'Hey — still up?'];
      if (h < 10) return ['Morning.', 'Hey, morning.'];
      if (h < 17) return ['Hey.', 'Yo.', 'Hey — what do you need?'];
      return ['Hey.', 'Evening.'];
    },
  ],
  [
    /^(thanks|thank you|ty|cheers)[\s!?.]*$/i,
    ['Anytime.', 'You got it.', 'No problem.', 'Sure thing.'],
  ],
  [/^(ok|okay|alright|k|got it)[\s!?.]*$/i, ['Got it.', 'Cool.', 'Alright.', 'Noted.']],
  [/^(yes|yeah|yep|yup|absolutely|definitely)[\s!?.]*$/i, ['Yeah.', 'Right.', 'Cool.']],
  [/^(no|nah|nope|naw)[\s!?.]*$/i, ['Fair.', 'OK.', 'Alright.', 'No worries.']],
  [/^(bye|goodbye|cya|see ya|later)[\s!?.]*$/i, ['See you.', 'Later.', 'Catch you later.']],
  [
    /^(good|nice|cool|great|awesome|perfect|sick)[\s!?.]*$/i,
    ['Nice.', 'Good.', 'Glad to hear it.'],
  ],
  [/^(lol|haha|lmao|hehe|ha)[\s!?.]*$/i, ['Ha.', 'Heh.', 'Yeah.']],
  [
    /^(yo|sup|what'?s up|whats up)[\s!?.]*$/i,
    ['Not much. You?', "All good — what's up?", 'Hey. What do you need?'],
  ],
  [
    /^(hey|hi|hello)\s+(gurney\s*)?(how'?s?\s+it\s+going|how\s+are\s+you|how\s+you\s+doing)[?!.]*$/i,
    [
      'Doing alright. You?',
      'Not bad. How about you?',
      "Good — what's going on with you?",
      'All good over here. You?',
    ],
  ],
  [
    /^(hey|hi|hello)\s+(gurney\s*)?(what'?s\s+up|you\s+good|all\s+good)[?!.]*$/i,
    ['All good. What do you need?', 'Yeah, all good. You?', "Running fine. What's up?"],
  ],
  [/^(gm|good morning)[\s!?.]*$/i, ['Morning.', 'Hey, morning.']],
  [/^(gn|good night|goodnight)[\s!?.]*$/i, ['Night.', 'Sleep well.']],
  [/^(sure|sounds good|of course)[\s!?.]*$/i, ['Cool.', 'Alright.', 'Of course.']],
  [/^(i'?m (back|home)|home)[\s!?.]*$/i, ['Welcome back.', 'Hey — how was it?', 'Back already?']],
];

// ── Offload acks — quick "I'm working on it" while the LLM runs ───────────
//
// QUERY_RE catches information-seeking phrasings ("what's", "show", "list",
// "check the weather"). Anything else with TOOL_INTENT_RE is treated as an
// action ("add", "schedule", "remind me").

const QUERY_RE =
  /\b(what|when|how|show|list|check|look|get|weather|forecast|temperature|do i have|am i|is there)\b/i;

const TOOL_INTENT_RE =
  /\b(add|create|set|schedule|book|make|put|remove|delete|cancel|clear|replace|swap|move|reschedule|change|update|edit|modify|check|look up|search|find|what'?s (on|the|my)|what (are|do) (my|i)|show me|list|get|weather|temperature|timer|remind|calendar|events?|alarm|forecast|task|tasks|todo|todos|complete|completed|finish|finished|track|tracking|habit|habits|streak|log|logged|journal|entry|reflection|goal|goals|undo|revert|cancel that|delete that)\b/i;

const QUERY_ACKS = ['Checking.', 'Looking now.', 'One sec.', 'On it — checking.'];
const ACTION_ACKS = ['On it.', 'Got it.', 'Doing that now.', 'Sure thing.', 'Yeah, on it.'];

// Per-chat memory of the last reply we sent, so a user who sends "hi" twice
// in a row doesn't get the same variant verbatim. Keyed by chatId so chats
// don't bleed into each other; a Map keeps it bounded by active conversation.
const lastReplyByChat = new Map<number, string>();

function pickVariant(pool: string[], chatId: number): string {
  if (pool.length === 1) return pool[0]!;
  const last = lastReplyByChat.get(chatId);
  let pick: string;
  let attempts = 0;
  do {
    pick = pool[Math.floor(Math.random() * pool.length)]!;
    attempts += 1;
  } while (pick === last && attempts < 4);
  lastReplyByChat.set(chatId, pick);
  return pick;
}

function trivialReplyFor(message: string, chatId: number, hour: number): string | null {
  const m = message.trim();
  if (!m) return null;
  for (const [re, replyOrFn] of TRIVIAL_REPLIES) {
    if (re.test(m)) {
      const pool = typeof replyOrFn === 'function' ? replyOrFn(hour) : replyOrFn;
      return pickVariant(pool, chatId);
    }
  }
  return null;
}

function offloadAckFor(message: string, chatId: number): string | null {
  const m = message.trim();
  if (!m) return null;
  if (!TOOL_INTENT_RE.test(m)) return null;
  const pool = QUERY_RE.test(m) ? QUERY_ACKS : ACTION_ACKS;
  return pickVariant(pool, chatId);
}

export function register(host: Host): void {
  host.telegram.intercept(async (ctx: TelegramInterceptContext) => {
    // Slash commands have already been routed by the adapter — we only see
    // free-form text here. Skip anything starting with "/" defensively.
    if (ctx.text.startsWith('/')) {
      await ctx.next();
      return;
    }

    const hour = new Date().getHours();

    // Mode 1 — trivial chatter. Reply and stop; LLM never runs.
    const trivial = trivialReplyFor(ctx.text, ctx.chatId, hour);
    if (trivial !== null) {
      host.log.debug('instant trivial reply', { chatId: ctx.chatId, reply: trivial });
      await ctx.reply(trivial);
      return;
    }

    // Mode 2 — tool/query intent. Send a quick ack so the user knows we
    // heard them, then hand off to the orchestrator. The ack and the real
    // reply both land in chat: "On it." → 30s later → "Event created: …".
    const ack = offloadAckFor(ctx.text, ctx.chatId);
    if (ack !== null) {
      host.log.debug('instant ack', { chatId: ctx.chatId, ack });
      await ctx.reply(ack);
    }

    await ctx.next();
  });
}
