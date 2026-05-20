// Two-queue orchestrator. Owns the conversation pipeline.
//
//  user-facing queue   — per chat, FIFO, one in-flight reply at a time. The
//                        Telegram adapter calls handleUserMessage(); the
//                        orchestrator serializes per-chat work, makes /stop
//                        possible via AbortController, and streams the LLM
//                        reply back through the supplied sink.
//  after-turn hooks    — the Telegram adapter forwards post-turn metadata to
//                        extensions after the visible reply is done, so
//                        learning/routine work stays off the hot path.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM, ChatChunk, ProfileName, ToolCall } from './llm.js';
import type { ToolRegistry } from './tools.js';
import { build as buildContext, type HistoryMessage } from './context.js';
import type { AfterTurnContext, AfterTurnToolCallSummary } from './extensions.js';

// Cap on how much of a tool's output we re-feed to the model on the next
// round. Verbose tool output (a 5KB web-search dump, a 30-event calendar
// listing) otherwise blows the chat profile's 4096-token budget for several
// turns — atlas hit this exact failure mode and pinned the cap at 2000.
// The truncation marker is appended so the model can tell its context was
// clipped and ask the user / re-query if it really needs the rest.
export const TOOL_RESULT_MAX_CHARS = 2000;
const TOOL_RESULT_TRUNCATION_MARKER = '\n…[truncated]';
export const AFTER_TURN_TOOL_RESULT_SUMMARY_MAX_CHARS = 500;

export interface ReplyChunk {
  delta: string;
  done: boolean;
  // Set once on the final chunk.
  meta?: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs: number;
    afterTurn?: AfterTurnContext;
  };
}

export interface UserMessage {
  chatId: number;
  userId: number;
  text: string;
  // Sink for streamed reply chunks. The Telegram adapter wires this to a
  // chunked-edit Telegram message.
  send: (chunk: ReplyChunk) => void | Promise<void>;
}

export interface OrchestratorOptions {
  db: DB;
  llm: LLM;
  tools: ToolRegistry;
  log: Logger;
  systemPrompt?: string;
  defaultProfile?: ProfileName;
  // Profile to use for chat calls that include tool schemas. Falls back to
  // defaultProfile when unset, so deployments that haven't configured a
  // dedicated tool-use model keep their old behaviour.
  toolProfile?: ProfileName;
  budgetTokens?: number;
  // Cap on chained tool-call rounds per user turn. qwen3.5:0.8b is over-eager
  // about tool-calling, so the orchestrator needs both a real loop (single
  // round wasn't enough — chained calls left assistantText empty) and a hard
  // stop so it can't spin forever. Surface as a config knob because long
  // calendar conflict resolution can want 5–6 rounds while plain Q&A bots
  // want 2.
  maxToolRounds?: number;
  // Returns the concatenated prompt fragments contributed by extensions.
  // Called fresh on each turn so hot-reloaded extensions show up without an
  // orchestrator restart. The filter (when supplied) limits the fragments to
  // a subset of extensions — used to keep the system prompt aligned with the
  // intent-pruned tool manifest.
  promptFragmentProvider?: (extensionFilter?: ReadonlySet<string>) => string;
  // Per-turn intent filter for the tool manifest. Returns the names of
  // extensions whose tools should be exposed to the model for this message,
  // or null to expose every tool (legacy behaviour). An empty array means
  // "no tools" — used for trivial chatter like "hi", "thanks".
  // Without this provider, the orchestrator always exposes every tool.
  toolIntentFilter?: (message: string) => string[] | null;
}

export interface Orchestrator {
  handleUserMessage(msg: UserMessage): Promise<void>;
  stop(chatId: number): boolean;
  // Reset the conversation for a chat. Closes the current conversation row
  // and leaves the next message to open a fresh one.
  newChat(chatId: number): void;
  lastError(chatId: number): string | undefined;
  // Stop accepting new work, wait for in-flight chats to finish.
  shutdown(): Promise<void>;
}

interface ChatSlot {
  // Pending messages in arrival order. The head is in flight.
  queue: QueuedUserMessage[];
  inFlight: boolean;
  abort: AbortController | null;
}

interface QueuedUserMessage extends UserMessage {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const DEFAULT_SYSTEM = `You are Gurney, a concise AI assistant chatting with the user over Telegram. When the user asks you to do something you have a tool for, call the tool — never tell the user to do it themselves. Be direct.`;
const DEFAULT_MAX_TOOL_ROUNDS = 4;

// Per-turn world-state anchor injected at the end of the system prompt. Two
// jobs:
//
// 1. Date math. The model needs an explicit "today is X" to resolve relative
//    phrases like "tomorrow" or "may 5th" into ISO timestamps for tools.
//    Tomorrow's date is included because small models (0.8b) routinely got
//    the math wrong when only TODAY was anchored — "tomorrow at 9" would land
//    on the day after tomorrow because the model second-guessed its own date
//    arithmetic. Atlas added the explicit tomorrow anchor and it eliminated
//    that whole class of off-by-ones.
//
// 2. Temporal awareness. Current local time + time-since-last-user-message
//    let the model behave like an agent that *exists in time* rather than a
//    stateless responder. "I see it's been three days since we last talked"
//    or "good evening" only work if the model is told the wall clock and the
//    gap. The cost is tiny (one extra line of prompt) and the cache penalty
//    is minutes-granular, so the prefix only invalidates once a minute.
//
// `lastUserAt` is the timestamp of the *previous* user message in this
// conversation, in epoch ms. Undefined means this is the first turn.
function dailyContext(now: Date = new Date(), lastUserAt?: number): string {
  // Round to the nearest 5 minutes so Ollama's KV slot cache survives across
  // turns within the same 5-minute window. The previous behaviour included
  // wall-clock minutes in the system prompt, which busted the cache every 60s
  // for no user-visible benefit — the model never actually needed sub-5-min
  // precision and the cost on a Pi is real (each cache miss re-runs prompt
  // eval over the whole system block).
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const rounded = new Date(Math.floor(now.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
  const tzMin = -rounded.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzh = String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, '0');
  const tzm = String(Math.abs(tzMin) % 60).padStart(2, '0');
  const offset = `${sign}${tzh}:${tzm}`;
  const isoDate = isoDay(rounded);
  const weekday = rounded.toLocaleDateString('en-US', { weekday: 'long' });
  const hh = String(rounded.getHours()).padStart(2, '0');
  const mm = String(rounded.getMinutes()).padStart(2, '0');
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = isoDay(tomorrow);
  const tomorrowWeekday = tomorrow.toLocaleDateString('en-US', { weekday: 'long' });
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = isoDay(yesterday);
  const yesterdayWeekday = yesterday.toLocaleDateString('en-US', { weekday: 'long' });
  const sinceLine =
    lastUserAt !== undefined
      ? ` Time since the user's previous message: ${humanGap(now.getTime() - lastUserAt)}.`
      : ' This is the first message in the conversation.';
  // The "authoritative clock" wording exists because qwen3.5:0.8b would
  // otherwise paraphrase or invent times when asked "what time is it" — it
  // saw the date line as flavour text, not a fact to report. Telling it
  // explicitly to quote these values fixes that. Yesterday is included for
  // the same off-by-one reason as tomorrow (see header comment).
  return (
    `Current local time: ${weekday} ${isoDate} ${hh}:${mm} (offset ${offset}). ` +
    `Today: ${weekday} ${isoDate}. Tomorrow: ${tomorrowWeekday} ${tomorrowIso}. Yesterday: ${yesterdayWeekday} ${yesterdayIso}.` +
    sinceLine +
    ` This line is the authoritative source for the current date and time. When the user asks what time it is, what day it is, what today/tomorrow/yesterday is, or any date-related question, answer using these exact values — do not estimate, round, or invent. Use the same dates and offset when constructing ISO 8601 timestamps for tool arguments (e.g. resolving "today", "tomorrow", or "may 5th").`
  );
}

// Render a millisecond gap as a short human phrase the model can read. Kept
// coarse on purpose — exact seconds add noise to the prompt and don't change
// behaviour. Negative or zero gaps (clock skew, same-millisecond) collapse to
// "just now".
export function humanGap(ms: number): string {
  if (ms <= 1000) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'}`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'}`;
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Truncate a tool's output before it gets re-injected into the model's
// context. Long outputs blow the prompt budget for several turns; the
// marker tells the model the trailing bytes were dropped so it can ask
// the user to narrow the query if needed.
export function truncateToolResult(output: string, max: number = TOOL_RESULT_MAX_CHARS): string {
  if (output.length <= max) return output;
  // Keep the head; trailing context is usually less informative for the
  // small chat model. Marker is appended *after* the slice so the total
  // length stays close to `max`.
  return output.slice(0, max) + TOOL_RESULT_TRUNCATION_MARKER;
}

function summarizeToolResult(output: string): string {
  return truncateToolResult(output, AFTER_TURN_TOOL_RESULT_SUMMARY_MAX_CHARS);
}

export function createOrchestrator(opts: OrchestratorOptions): Orchestrator {
  const log = opts.log.child({ mod: 'orchestrator' });
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
  const defaultProfile: ProfileName = opts.defaultProfile ?? 'chat';
  // Resolve once at startup. If `toolProfile` was passed but isn't actually
  // configured on the LLM, fall back to defaultProfile so we don't crash on
  // first turn.
  const toolProfile: ProfileName = (() => {
    const requested = opts.toolProfile ?? defaultProfile;
    if (requested === defaultProfile) return defaultProfile;
    const profiles = opts.llm.listProfiles();
    return profiles[requested] ? requested : defaultProfile;
  })();
  const budgetTokens = opts.budgetTokens ?? 4096;
  const maxToolRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

  const slots = new Map<number, ChatSlot>();
  const lastErrors = new Map<number, string>();
  let shuttingDown = false;

  function getSlot(chatId: number): ChatSlot {
    let s = slots.get(chatId);
    if (!s) {
      s = { queue: [], inFlight: false, abort: null };
      slots.set(chatId, s);
    }
    return s;
  }

  // --- conversation persistence -------------------------------------------
  //
  // Prepared statements hoisted so better-sqlite3 reuses the compiled query
  // across every turn instead of re-parsing on each call. Lazy because some
  // tests construct an orchestrator against a fresh DB and we want any schema
  // errors to surface on first use, not at module load.

  type Stmt = {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
  let stmts: {
    selectCurrentConversation: Stmt;
    insertConversation: Stmt;
    upsertChat: Stmt;
    selectHistory: Stmt;
    insertMessage: Stmt;
    selectLastUserAt: Stmt;
  } | null = null;
  function getStmts(): NonNullable<typeof stmts> {
    if (stmts) return stmts;
    stmts = {
      selectCurrentConversation: opts.db.prepare(
        `SELECT current_conversation_id AS id FROM telegram_chats WHERE chat_id = ?`,
      ),
      insertConversation: opts.db.prepare(
        `INSERT INTO conversations (telegram_chat_id, started_at) VALUES (?, ?)`,
      ),
      upsertChat: opts.db.prepare(
        `INSERT INTO telegram_chats (chat_id, user_id, current_conversation_id, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           current_conversation_id = excluded.current_conversation_id,
           user_id = excluded.user_id,
           last_seen_at = excluded.last_seen_at`,
      ),
      // LIMIT 500: defense in depth against a runaway conversation. The
      // context manager already truncates to the prompt budget further down;
      // this is the OOM safety net for a chat that somehow accumulated
      // millions of rows. Ordered DESC then reversed so we get the most
      // recent 500 messages, not the oldest 500.
      selectHistory: opts.db.prepare(
        `SELECT role, content, tool_call_id, tool_name FROM messages
         WHERE conversation_id = ? ORDER BY id DESC LIMIT 500`,
      ),
      insertMessage: opts.db.prepare(
        `INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_name, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectLastUserAt: opts.db.prepare(
        `SELECT created_at AS t FROM messages
         WHERE conversation_id = ? AND role = 'user'
         ORDER BY id DESC LIMIT 1`,
      ),
    };
    return stmts;
  }

  function ensureConversation(chatId: number, userId: number): number {
    const s = getStmts();
    const row = s.selectCurrentConversation.get(chatId) as { id: number | null } | undefined;
    if (row?.id) return row.id;
    const ins = s.insertConversation.run(chatId, Date.now());
    const conversationId = Number(ins.lastInsertRowid);
    s.upsertChat.run(chatId, userId, conversationId, Date.now());
    return conversationId;
  }

  function loadHistory(conversationId: number): HistoryMessage[] {
    const rows = getStmts().selectHistory.all(conversationId) as Array<{
      role: HistoryMessage['role'];
      content: string;
      tool_call_id: string | null;
      tool_name: string | null;
    }>;
    rows.reverse();
    return rows.map((r) => {
      const m: HistoryMessage = { role: r.role, content: r.content };
      if (r.tool_call_id) m.tool_call_id = r.tool_call_id;
      if (r.tool_name) m.tool_name = r.tool_name;
      return m;
    });
  }

  function appendMessage(
    conversationId: number,
    role: HistoryMessage['role'],
    content: string,
    extra: { tool_call_id?: string; tool_name?: string; tokens?: number } = {},
  ): void {
    getStmts().insertMessage.run(
      conversationId,
      role,
      content,
      extra.tool_call_id ?? null,
      extra.tool_name ?? null,
      extra.tokens ?? null,
      Date.now(),
    );
  }

  // Most-recent user-message timestamp in this conversation. Undefined when
  // the conversation has no user messages yet (first turn). Called *before*
  // we append the current turn so the value reflects the previous turn.
  function lastUserMessageTimestamp(conversationId: number): number | undefined {
    const row = getStmts().selectLastUserAt.get(conversationId) as { t: number } | undefined;
    return row?.t;
  }

  // --- user-facing pipeline -----------------------------------------------

  async function process(msg: UserMessage, slot: ChatSlot): Promise<void> {
    const startedAt = Date.now();
    const cl = log.child({ chatId: msg.chatId });
    const conversationId = ensureConversation(msg.chatId, msg.userId);
    // Capture the previous user message's timestamp BEFORE we insert the
    // current one — feeds the world-state ticker so the model can read "the
    // user last spoke 3 hours ago" and behave accordingly. Undefined on the
    // first turn of a conversation.
    const lastUserAt = lastUserMessageTimestamp(conversationId);
    appendMessage(conversationId, 'user', msg.text);

    // Track history in memory and append-as-we-persist so we don't reload
    // the entire conversation from SQLite on every tool round (was: 1 load
    // up front + 1 load per followup + 1 load per safety-net retry).
    const history = loadHistory(conversationId);
    // Pending DB writes for this round. Buffering + flushing in one
    // transaction means a crash mid-round (e.g. SIGTERM after writing the
    // assistant's tool-call request but before its tool results land) can no
    // longer leave the conversation with orphan rows that confuse the next
    // load. Writes always go into `history` immediately so the in-flight LLM
    // call still sees a consistent in-memory view.
    type PendingWrite = {
      role: HistoryMessage['role'];
      content: string;
      extra: { tool_call_id?: string; tool_name?: string; tokens?: number };
    };
    let pendingRound: PendingWrite[] = [];
    const flushRound = (): void => {
      if (pendingRound.length === 0) return;
      const batch = pendingRound;
      pendingRound = [];
      opts.db.transaction(() => {
        for (const w of batch) appendMessage(conversationId, w.role, w.content, w.extra);
      })();
    };
    const trackingAppend = (
      role: HistoryMessage['role'],
      content: string,
      extra: { tool_call_id?: string; tool_name?: string; tokens?: number } = {},
    ): void => {
      pendingRound.push({ role, content, extra });
      const entry: HistoryMessage = { role, content };
      if (extra.tool_call_id) entry.tool_call_id = extra.tool_call_id;
      if (extra.tool_name) entry.tool_name = extra.tool_name;
      history.push(entry);
    };

    // Compute intent up front so both the prompt fragment and the tool
    // manifest below filter on the same set.
    const intent = opts.toolIntentFilter?.(msg.text) ?? null;
    const intentSet = intent && intent.length > 0 ? new Set(intent) : undefined;
    const toolPrompt = opts.promptFragmentProvider?.(intentSet) || undefined;
    const systemForTurn = `${systemPrompt}\n\n${dailyContext(new Date(), lastUserAt)}`;

    // One helper, three callers: initial chat, tool-loop followup, safety-net
    // followup. Optional `omitToolPrompt` lets the safety net drop the tool
    // fragment so the model isn't told about tools that aren't on the wire.
    const buildPromptForTurn = (omitToolPrompt = false) =>
      buildContext({
        systemPrompt: systemForTurn,
        history,
        ...(!omitToolPrompt && toolPrompt ? { toolPrompt } : {}),
        budgetTokens,
      });

    const built = buildPromptForTurn();
    if (built.truncated) cl.debug('history truncated to fit budget');

    const abort = new AbortController();
    slot.abort = abort;

    // Tool manifest pruning. Pruning by message intent cuts prompt size
    // dramatically on every tool round — Ollama re-sends the schema block on
    // each follow-up, so over a 2-round tool flow the savings compound. Falls
    // back to all tools when no filter is wired or the filter can't decide.
    const toolSchemas =
      intent === null
        ? opts.tools.schemas()
        : intentSet === undefined
          ? []
          : opts.tools.schemasFor(intentSet, msg.text);
    if (intent && intent.length > 0) {
      cl.debug('tool manifest pruned by intent', {
        kept: toolSchemas.length,
        extensions: intent,
      });
    } else if (intent && intent.length === 0) {
      cl.debug('tool manifest skipped — message looks like trivial chatter');
    }
    let assistantText = '';
    let lastChunk: ChatChunk | null = null;
    const afterTurnToolCalls: AfterTurnToolCallSummary[] = [];

    // Drains one streamed chat round into msg.send + assistantText. Returns
    // the final chunk so the caller can inspect tool_calls / usage.
    const drain = async (s: AsyncIterable<ChatChunk>): Promise<ChatChunk | null> => {
      let final: ChatChunk | null = null;
      // Ollama streams tool calls on their own chunk (done=false, empty
      // content) and then ships a separate done=true chunk with no tool_calls.
      // If we only kept `final`, the tool calls would be lost — the orchestrator
      // would skip the tool loop and the user would see "(no reply)".
      let pendingToolCalls: ToolCall[] | undefined;
      for await (const chunk of s) {
        final = chunk;
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          pendingToolCalls = chunk.toolCalls;
        }
        // Forward the delta whether or not this is the done chunk — Ollama
        // sometimes ships the last token alongside done=true, and dropping it
        // gave the Telegram adapter an empty buffer (→ "(no reply)").
        if (chunk.delta) {
          assistantText += chunk.delta;
          await msg.send({ delta: chunk.delta, done: false });
        }
        if (chunk.done) break;
      }
      if (final && pendingToolCalls && (!final.toolCalls || final.toolCalls.length === 0)) {
        final = { ...final, toolCalls: pendingToolCalls };
      }
      return final;
    };

    try {
      const profileForTurn: ProfileName = toolSchemas.length > 0 ? toolProfile : defaultProfile;
      cl.debug('selected model profile', { profile: profileForTurn });
      const initial = opts.llm.chat({
        profile: profileForTurn,
        messages: built.messages,
        ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
        signal: abort.signal,
      });
      lastChunk = await drain(initial);

      let round = 0;
      while (lastChunk?.toolCalls && lastChunk.toolCalls.length > 0) {
        if (round >= maxToolRounds) {
          cl.warn('tool-call loop hit max rounds — forcing a no-tools final reply', {
            round,
            maxToolRounds,
          });
          break;
        }
        round += 1;
        cl.debug('handling tool calls', {
          round,
          n: lastChunk.toolCalls.length,
          names: lastChunk.toolCalls.map((c) => c.name),
        });
        // Persist the assistant turn that requested the tool calls.
        if (assistantText) trackingAppend('assistant', assistantText);
        // Track whether every tool in this round is self-replying. When all
        // are, the orchestrator can ship the concatenated tool outputs as
        // the final reply and skip the follow-up LLM round-trip — that round
        // is otherwise spent re-phrasing "Added: <event>" into "I added the
        // event!", which doubles wall-clock for an action turn.
        let allSelfReplying = true;
        const selfReplyingOutputs: string[] = [];
        for (const call of lastChunk.toolCalls) {
          const handler = opts.tools.get(call.name);
          const isSelfReplying = handler?.selfReplying === true;
          const result = await opts.tools.execute(call, {
            chatId: msg.chatId,
            conversationId,
            log: cl.child({ tool: call.name }),
            signal: abort.signal,
          });
          afterTurnToolCalls.push({
            name: call.name,
            arguments: call.arguments,
            ok: result.ok,
            resultSummary: summarizeToolResult(result.output),
          });
          // Truncate before persisting / re-injecting. Self-replying tools
          // ship the FULL output to the user (we capture that below before
          // truncating), so the user never sees the truncation marker for
          // the action-confirmation case — only the next-round LLM context
          // gets the trimmed version.
          if (isSelfReplying && result.ok) {
            selfReplyingOutputs.push(result.output);
          } else {
            allSelfReplying = false;
          }
          const persisted = truncateToolResult(result.output);
          if (persisted.length < result.output.length) {
            cl.debug('tool result truncated for re-injection', {
              tool: call.name,
              original: result.output.length,
              kept: persisted.length,
            });
          }
          trackingAppend('tool', persisted, {
            tool_call_id: call.id,
            tool_name: call.name,
          });
        }
        // Flush the assistant-tool-call row and every tool-result row of this
        // round in one transaction. A crash before this point loses the round
        // entirely (safe — no orphans); a crash after has the whole round
        // durable.
        flushRound();
        if (allSelfReplying) {
          cl.debug('tool result short-circuit — skipping LLM follow-up', {
            outputs: selfReplyingOutputs.length,
          });
          const text = selfReplyingOutputs.join('\n');
          assistantText = text;
          await msg.send({ delta: text, done: false });
          // Synthesize a "done with no tool calls" chunk so the outer while
          // loop exits cleanly; the post-loop block then persists the
          // assistant turn once with the carried-over completion tokens. (We
          // intentionally do NOT persist here — earlier versions did, which
          // double-wrote the row and re-fed it to the model on the next turn.)
          lastChunk = {
            delta: '',
            done: true,
            ...(lastChunk.model ? { model: lastChunk.model } : {}),
            ...(lastChunk.promptTokens !== undefined
              ? { promptTokens: lastChunk.promptTokens }
              : {}),
            ...(lastChunk.completionTokens !== undefined
              ? { completionTokens: lastChunk.completionTokens }
              : {}),
          };
          break;
        }
        assistantText = '';
        const followup = opts.llm.chat({
          profile: profileForTurn,
          messages: buildPromptForTurn().messages,
          ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
          signal: abort.signal,
        });
        lastChunk = await drain(followup);
      }

      // Safety net: if the model burned all its rounds on tool calls and still
      // hasn't produced any text, ask once more with tools disabled so it has
      // to answer in plain language. Without this the user sees "(no reply)".
      // The tool-prompt fragment is dropped along with the schemas so the
      // model isn't told about tools that aren't on the wire this round.
      if (
        !assistantText &&
        lastChunk?.toolCalls &&
        lastChunk.toolCalls.length > 0 &&
        round >= maxToolRounds
      ) {
        const noToolsFollowup = opts.llm.chat({
          profile: defaultProfile,
          messages: buildPromptForTurn(true).messages,
          signal: abort.signal,
        });
        lastChunk = await drain(noToolsFollowup);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        cl.info('reply cancelled by /stop');
        await msg.send({ delta: '', done: true });
        return;
      }
      const m = e instanceof Error ? e.message : String(e);
      lastErrors.set(msg.chatId, m);
      cl.warn('llm chat failed', { error: m });
      await msg.send({
        delta: assistantText ? '' : `Sorry — I hit an error: ${m}`,
        done: true,
      });
      return;
    } finally {
      slot.abort = null;
    }

    if (assistantText) {
      trackingAppend('assistant', assistantText, {
        ...(lastChunk?.completionTokens !== undefined
          ? { tokens: lastChunk.completionTokens }
          : {}),
      });
    }
    flushRound();

    const meta: ReplyChunk['meta'] = {
      model: lastChunk?.model ?? opts.llm.resolveModel(defaultProfile),
      ...(lastChunk?.promptTokens !== undefined ? { promptTokens: lastChunk.promptTokens } : {}),
      ...(lastChunk?.completionTokens !== undefined
        ? { completionTokens: lastChunk.completionTokens }
        : {}),
      elapsedMs: Date.now() - startedAt,
      afterTurn: {
        chatId: msg.chatId,
        userId: msg.userId,
        conversationId,
        userText: msg.text,
        assistantText,
        startedAt,
        finishedAt: Date.now(),
        toolCalls: afterTurnToolCalls,
      },
    };
    await msg.send({ delta: '', done: true, meta });
  }

  async function pump(chatId: number): Promise<void> {
    const slot = slots.get(chatId);
    if (!slot || slot.inFlight) return;
    slot.inFlight = true;
    try {
      while (slot.queue.length > 0 && !shuttingDown) {
        const next = slot.queue.shift()!;
        try {
          await process(next, slot);
          next.resolve();
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          lastErrors.set(chatId, m);
          log.error('orchestrator pump error', { chatId, error: m });
          next.reject(e);
        }
      }
    } finally {
      slot.inFlight = false;
    }
  }

  // Per-chat queue depth ceiling. A user spamming the bot can otherwise back
  // up arbitrarily many turns behind a slow tool call. 5 is loose enough that
  // legitimate "hold on, also do X" follow-ups still queue, but tight enough
  // that a burst doesn't pin memory or stretch reply latency past anything
  // useful.
  const MAX_QUEUE_PER_CHAT = 5;

  async function handleUserMessage(msg: UserMessage): Promise<void> {
    if (shuttingDown) {
      await msg.send({ delta: 'Shutting down — try again later.', done: true });
      return;
    }
    const slot = getSlot(msg.chatId);
    if (slot.queue.length >= MAX_QUEUE_PER_CHAT) {
      log.warn('chat queue at cap, dropping message', {
        chatId: msg.chatId,
        depth: slot.queue.length,
      });
      await msg.send({
        delta: "I'm still catching up — try again once I've replied.",
        done: true,
      });
      return;
    }
    const done = new Promise<void>((resolve, reject) => {
      slot.queue.push({ ...msg, resolve, reject });
    });
    void pump(msg.chatId);
    await done;
  }

  function stop(chatId: number): boolean {
    const slot = slots.get(chatId);
    if (!slot) return false;
    // Drain pending queue first.
    const pending = slot.queue.splice(0);
    for (const queued of pending) queued.resolve();
    if (slot.abort) {
      slot.abort.abort();
      return true;
    }
    return pending.length > 0;
  }

  function newChat(chatId: number): void {
    const row = opts.db
      .prepare(`SELECT current_conversation_id AS id FROM telegram_chats WHERE chat_id = ?`)
      .get(chatId) as { id: number | null } | undefined;
    if (row?.id) {
      opts.db.prepare(`UPDATE conversations SET ended_at = ? WHERE id = ?`).run(Date.now(), row.id);
    }
    opts.db
      .prepare(
        `UPDATE telegram_chats SET current_conversation_id = NULL, last_seen_at = ? WHERE chat_id = ?`,
      )
      .run(Date.now(), chatId);
    lastErrors.delete(chatId);
  }

  function lastError(chatId: number): string | undefined {
    return lastErrors.get(chatId);
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    // Wait for in-flight chats to drain. Pending entries are released below:
    // once shutdown starts, pump() will not pick up another queued turn.
    const waits: Promise<void>[] = [];
    for (const [chatId, s] of slots.entries()) {
      const pending = s.queue.splice(0);
      for (const queued of pending) queued.resolve();
      if (s.inFlight) {
        waits.push(
          new Promise((resolve) => {
            const t = setInterval(() => {
              if (!s.inFlight) {
                clearInterval(t);
                resolve();
              }
            }, 25);
            t.unref?.();
            // safety: never wait more than 5s
            setTimeout(() => {
              clearInterval(t);
              resolve();
            }, 5000).unref?.();
          }),
        );
      }
      // Cancel any abortable in-flight call so shutdown isn't blocked on the
      // model.
      s.abort?.abort();
      log.debug('shutdown: cancelling chat', { chatId });
    }
    await Promise.all(waits);
  }

  return {
    handleUserMessage,
    stop,
    newChat,
    lastError,
    shutdown,
  };
}
