// LLM interface. Pluggable by design; only Ollama HTTP is wired in Phase 1.
//
// Responsibilities:
// - Profile routing: callers ask for "chat" | "reason" | "tools" | a literal
//   model name, the interface picks the right backing model. The "tools"
//   profile is what the orchestrator uses for any chat call that has tool
//   schemas attached — splitting it out lets the user point a tool-fluent
//   model (often a different size or family from chat) at every tool turn.
// - Eviction: only one heavy model resident at a time (PLAN North Star /
//   "Heavy-model eviction"). When a profile other than the resident heavy one
//   is asked for, we ask Ollama to unload the previous one (keep_alive=0).
//   On top of that an optional idle sweep proactively unloads heavy models
//   that haven't been used for `idleEvictionMs` so a one-shot reasoning turn
//   doesn't pin RAM forever on a Pi-class host.
// - Circuit breaker: trips after N consecutive failures, opens for a cooldown,
//   then half-opens. While open we fail fast with a typed error. The half-
//   open phase requires `halfOpenGrace` consecutive successes before the
//   breaker fully closes — single-probe re-opens were chattering against a
//   real-world transient blip (Ollama's first cold-load on a Pi).
// - Streaming: chat() yields a stream of deltas the orchestrator forwards
//   to Telegram in chunks.

import type { Logger } from '../util/log.js';
import { composeAbort } from '../util/abort.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ProfileName = 'chat' | 'reason' | 'tools';

export interface ProfileConfig {
  // Ollama model tag, e.g. "qwen3.5:0.8b".
  model: string;
  // Approx max prompt tokens (`num_ctx` and the budget the context manager
  // targets).
  contextTokens: number;
  // If true, this profile occupies the heavy slot — only one heavy profile is
  // resident at a time.
  heavy: boolean;
  // keep_alive forwarded to Ollama. "0" unloads immediately; default "5m".
  keepAlive?: string;
  // Cap on completion tokens (`num_predict`). Without this Ollama lets the
  // model ramble up to the context window — a single tool-flow turn was
  // observed generating 694 completion tokens for what should have been a
  // ~25-token confirmation, costing ~80s on CPU. Per-profile because the
  // reasoning model genuinely needs more headroom than the tool model does.
  numPredict?: number;
  // Prompt-processing batch size (`num_batch`). Larger batches keep the CPU
  // better fed while ingesting the prompt, cutting time-to-first-token on long
  // prompts — which matter more once the context window is widened. Costs a
  // little RAM per batch (trivial on a 16/32 GB host). Omitted => Ollama's
  // default (512). Per-profile because only the bigger tiers raise it.
  numBatch?: number;
  // Controls the /no_think hint we inject for Qwen3-family models.
  //   'auto' (default) — disable thinking when the model name matches qwen3.
  //   'on'             — never inject /no_think; let the model think.
  //   'off'            — always inject /no_think regardless of model family.
  // Reasoning profiles on bigger hosts may want 'on'; tool-call profiles want 'off'.
  thinkMode?: 'auto' | 'on' | 'off';
}

export interface ChatOptions {
  profile: ProfileName | { model: string };
  messages: ChatMessage[];
  tools?: ToolSchema[];
  // AbortSignal forwarded to fetch so /stop can cancel a streaming reply.
  signal?: AbortSignal;
  // Per-call timeout override in ms. Defaults to the instance inferenceTimeoutMs
  // (120s). Pass a higher value for long-running generation (e.g. Tudor lessons).
  timeoutMs?: number;
  // Stop the model after this many tokens. Soft cap; Ollama also enforces.
  maxTokens?: number;
  // Optional caller context for non-Ollama providers that need to meter or
  // attribute a turn. Ollama ignores this.
  context?: {
    chatId?: number;
    conversationId?: number;
  };
}

export interface ChatChunk {
  // Delta of assistant text since the previous chunk, or '' when the chunk
  // contains only tool calls / metadata.
  delta: string;
  // Final chunk with usage / model info. Tool calls and the resolved model
  // name only appear here.
  done: boolean;
  model?: string;
  toolCalls?: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

export type BreakerStatePublic = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  state: BreakerStatePublic;
  failures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  // When the breaker is open, when callers can next try.
  retryAt: number | null;
}

export interface LLMProviderChatOptions extends ChatOptions {
  // The fully resolved configured model reference, e.g. "codex" or
  // "codex:gpt-5-codex".
  model: string;
}

export interface LLMProvider {
  id: string;
  models?: () => string[];
  health?: () => Promise<{ ok: boolean; models: string[] }>;
  chat(opts: LLMProviderChatOptions): AsyncIterable<ChatChunk>;
}

export interface LLM {
  chat(opts: ChatOptions): AsyncIterable<ChatChunk>;
  health(): Promise<{
    ok: boolean;
    models: string[];
    providers?: Record<string, { ok: boolean; models: string[] }>;
  }>;
  listProfiles(): Record<ProfileName, ProfileConfig | null>;
  resolveModel(profile: ProfileName | { model: string }): string;
  // Diagnostic surface for `gurney status` / health JSON. Returns a snapshot
  // of the breaker so the CLI can render the current resilience state.
  breakerSnapshot(): BreakerSnapshot;
  // Stop the idle-eviction timer. Test/teardown hook.
  stopIdleEviction(): void;
  // Optional extension hook. Routed LLMs expose this so an enabled extension can
  // contribute a model alias without core importing extension code.
  registerProvider?: (provider: LLMProvider) => () => void;
}

export class CircuitOpenError extends Error {
  constructor(public retryAt: number) {
    super('llm circuit breaker open');
    this.name = 'CircuitOpenError';
  }
}

export class LLMHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LLMHttpError';
  }
}

// Thrown when Ollama returns an empty stream (no content + no tool calls).
// Distinct from a transport error: the call succeeded, the model just
// produced nothing useful. Surfacing this lets the orchestrator turn it
// into an explicit error message instead of streaming silence.
export class LLMEmptyResponseError extends Error {
  constructor() {
    super('model returned an empty response');
    this.name = 'LLMEmptyResponseError';
  }
}

interface BreakerState {
  failures: number;
  // Successes counted while the breaker is half-open. Required to be
  // >= halfOpenGrace before the breaker fully closes — a single flaky
  // probe success used to declare the backend healthy and re-open on the
  // next blip, which produced visible "circuit open" thrash during
  // ordinary cold-starts.
  consecutiveSuccesses: number;
  openedAt: number | null;
  // True between the cooldown ending and halfOpenGrace successes.
  halfOpen: boolean;
}

export interface OllamaOptions {
  baseUrl: string;
  profiles: Partial<Record<ProfileName, ProfileConfig | null>>;
  log: Logger;
  // For tests.
  fetchImpl?: typeof fetch;
  now?: () => number;
  // Circuit breaker: trip after N consecutive failures, cool down for ms.
  failureThreshold?: number;
  cooldownMs?: number;
  // How many consecutive successful calls during half-open are required to
  // fully close the breaker. Default 2 — atlas's `CB_HALFOPEN_GRACE`. The
  // first success alone isn't enough to call the backend healthy on a slow
  // Pi where Ollama's first cold-load can succeed and the next blip be a
  // genuine outage; demanding two in a row gives the system a smoothing
  // window without dragging on indefinitely.
  halfOpenGrace?: number;
  // Hard ceiling for a single inference. Without this a hung Ollama hangs the
  // whole user queue. Defaults to 120s — long enough for cold-start of a
  // 9b heavy model on CPU, short enough that a real outage surfaces fast.
  inferenceTimeoutMs?: number;
  // Periodic check that unloads heavy profiles which haven't been called in
  // this many ms. 0 disables the sweep. Default 10 minutes — matches atlas.
  // The check itself is cheap (just compares timestamps); the eviction call
  // is only made when something is actually idle.
  idleEvictionMs?: number;
  // How often the idle sweep wakes up. Default 60s. Test-only knob —
  // production callers leave it on the default.
  idleEvictionTickMs?: number;
}

export function createOllama(opts: OllamaOptions): LLM {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const failureThreshold = opts.failureThreshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const halfOpenGrace = Math.max(1, opts.halfOpenGrace ?? 2);
  const inferenceTimeoutMs = opts.inferenceTimeoutMs ?? 120_000;
  const idleEvictionMs = opts.idleEvictionMs ?? 10 * 60_000;
  const idleEvictionTickMs = opts.idleEvictionTickMs ?? 60_000;
  const log = opts.log.child({ mod: 'llm' });

  const breaker: BreakerState = {
    failures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    halfOpen: false,
  };
  // Tracks which heavy model is currently resident, so we can evict it before
  // loading a different heavy model.
  let residentHeavy: string | null = null;
  // Last-used timestamps per profile name. The idle sweep reads this to
  // decide whether to unload a heavy profile.
  const lastCallAt = new Map<string, number>();
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  // Serializes eviction. Two concurrent chat() calls onto different heavy
  // profiles would otherwise both see `residentHeavy === X` and race the
  // unload — Ollama then has to cope with overlapping unload/load on the
  // same model, which has been observed to wedge it on Pi-class hardware.
  let evictionLock: Promise<void> = Promise.resolve();

  function resolveProfile(p: ProfileName | { model: string }): {
    model: string;
    cfg: ProfileConfig | null;
    profileName: string;
  } {
    if (typeof p === 'object') return { model: p.model, cfg: null, profileName: p.model };
    const cfg = opts.profiles[p];
    if (!cfg) {
      throw new Error(`profile '${p}' is not configured`);
    }
    return { model: cfg.model, cfg, profileName: p };
  }

  function checkBreaker(): void {
    if (breaker.openedAt === null) return;
    if (now() - breaker.openedAt < cooldownMs) {
      throw new CircuitOpenError(breaker.openedAt + cooldownMs);
    }
    // Cooldown elapsed — enter half-open. We don't reset openedAt yet
    // because a failure during half-open should slide back into open with
    // a fresh cooldown.
    if (!breaker.halfOpen) {
      breaker.halfOpen = true;
      breaker.consecutiveSuccesses = 0;
      log.info('circuit breaker half-open', { graceProbes: halfOpenGrace });
    }
  }

  function recordFailure(err: unknown): void {
    breaker.failures += 1;
    breaker.consecutiveSuccesses = 0;
    // While half-open, any failure trips back to open with a fresh cooldown
    // window so we don't hammer a still-broken backend.
    if (breaker.halfOpen) {
      breaker.openedAt = now();
      breaker.halfOpen = false;
      log.warn('circuit breaker re-opened from half-open', {
        cause: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (breaker.failures >= failureThreshold && breaker.openedAt === null) {
      breaker.openedAt = now();
      log.warn('circuit breaker opened', {
        failures: breaker.failures,
        cooldownMs,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function recordSuccess(): void {
    if (breaker.halfOpen) {
      breaker.consecutiveSuccesses += 1;
      if (breaker.consecutiveSuccesses >= halfOpenGrace) {
        log.info('circuit breaker closed', { successes: breaker.consecutiveSuccesses });
        breaker.failures = 0;
        breaker.openedAt = null;
        breaker.halfOpen = false;
        breaker.consecutiveSuccesses = 0;
      }
      return;
    }
    if (breaker.failures > 0 || breaker.openedAt !== null) {
      log.debug('circuit breaker reset');
    }
    breaker.failures = 0;
    breaker.openedAt = null;
    breaker.consecutiveSuccesses = 0;
  }

  function breakerSnapshot(): BreakerSnapshot {
    let state: BreakerStatePublic = 'closed';
    if (breaker.halfOpen) state = 'half-open';
    else if (breaker.openedAt !== null) state = 'open';
    return {
      state,
      failures: breaker.failures,
      consecutiveSuccesses: breaker.consecutiveSuccesses,
      openedAt: breaker.openedAt,
      retryAt: breaker.openedAt !== null ? breaker.openedAt + cooldownMs : null,
    };
  }

  async function evictIfNeeded(target: {
    model: string;
    cfg: ProfileConfig | null;
  }): Promise<void> {
    if (!target.cfg?.heavy) return;
    const run = async (): Promise<void> => {
      if (residentHeavy === null || residentHeavy === target.model) {
        residentHeavy = target.model;
        return;
      }
      await unloadModel(residentHeavy, 'switching heavy profiles');
      residentHeavy = target.model;
    };
    evictionLock = evictionLock.then(run, run);
    await evictionLock;
  }

  async function unloadModel(model: string, reason: string): Promise<void> {
    log.info('unloading heavy model', { model, reason });
    try {
      // Ollama's "unload" idiom: a generate call with keep_alive=0 and an
      // empty prompt instructs the server to drop the model from RAM.
      await fetchImpl(`${opts.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
      });
    } catch (e) {
      log.warn('unload call failed (continuing)', {
        model,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function ensureIdleSweep(): void {
    if (idleTimer || idleEvictionMs <= 0) return;
    idleTimer = setInterval(() => {
      void runIdleSweep().catch((e) => {
        log.warn('idle sweep failed', {
          error: e instanceof Error ? e.message : 'idle sweep error',
        });
      });
    }, idleEvictionTickMs);
    // Don't pin the event loop just for the eviction timer. unref() returns
    // the timer; older Node had it on the Timeout but we guard the call.
    idleTimer.unref?.();
  }

  async function runIdleSweep(): Promise<void> {
    if (!residentHeavy) return;
    // Find the profile name that maps to residentHeavy so we can read its
    // last-call time. There's only ever one heavy resident at a time, so the
    // search is a no-op past the first hit.
    let profileName: string | null = null;
    for (const [name, cfg] of Object.entries(opts.profiles)) {
      if (cfg && cfg.model === residentHeavy && cfg.heavy) {
        profileName = name;
        break;
      }
    }
    if (!profileName) return;
    const last = lastCallAt.get(profileName);
    if (last === undefined) return;
    if (now() - last < idleEvictionMs) return;
    log.info('idle eviction firing', {
      model: residentHeavy,
      idleMs: now() - last,
      thresholdMs: idleEvictionMs,
    });
    const evicted = residentHeavy;
    residentHeavy = null;
    await unloadModel(evicted, 'idle eviction');
  }

  function stopIdleEviction(): void {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  async function* chat(o: ChatOptions): AsyncIterable<ChatChunk> {
    checkBreaker();
    ensureIdleSweep();
    const target = resolveProfile(o.profile);
    await evictIfNeeded(target);
    lastCallAt.set(target.profileName, now());

    // /no_think for qwen3 family. qwen3 is a thinking model: by default it
    // emits <think>…</think> blocks of hidden reasoning that count toward
    // eval_count but never reach the user. On CPU this routinely burned
    // hundreds of completion tokens producing nothing visible. ATLAS pins
    // think:false at the API level AND prepends /no_think to the system
    // prompt as belt-and-suspenders — we mirror both.
    const thinkMode = target.cfg?.thinkMode ?? 'auto';
    const isQwen3 = /qwen3/i.test(target.model);
    const suppressThink = thinkMode === 'off' || (thinkMode === 'auto' && isQwen3);
    let messages = o.messages;
    if (suppressThink) {
      const sysIdx = messages.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        const sys = messages[sysIdx]!;
        if (!sys.content.startsWith('/no_think')) {
          messages = [
            ...messages.slice(0, sysIdx),
            { ...sys, content: '/no_think\n\n' + sys.content },
            ...messages.slice(sysIdx + 1),
          ];
        }
      } else {
        messages = [{ role: 'system', content: '/no_think' }, ...messages];
      }
    }

    const body: Record<string, unknown> = {
      model: target.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_name ? { name: m.tool_name } : {}),
      })),
      stream: true,
      keep_alive: target.cfg?.keepAlive ?? '5m',
      ...(suppressThink ? { think: false } : {}),
    };
    if (o.tools && o.tools.length > 0) body['tools'] = o.tools;
    // Per-call num_predict precedence: explicit maxTokens beats the profile
    // default. The profile default kicks in when the orchestrator doesn't ask
    // for anything specific, which is the common case.
    const predictCap = o.maxTokens ?? target.cfg?.numPredict;
    const numBatch = target.cfg?.numBatch;
    if (target.cfg?.contextTokens || predictCap !== undefined || numBatch !== undefined) {
      body['options'] = {
        ...(target.cfg?.contextTokens ? { num_ctx: target.cfg.contextTokens } : {}),
        ...(predictCap !== undefined ? { num_predict: predictCap } : {}),
        ...(numBatch !== undefined ? { num_batch: numBatch } : {}),
      };
    }

    // Compose the caller's signal with our own timeout. Without a hard cap a
    // hung Ollama wedges the whole user queue.
    const timeoutCtl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtl.abort(), o.timeoutMs ?? inferenceTimeoutMs);
    const composed = o.signal ? composeAbort(o.signal, timeoutCtl.signal) : timeoutCtl.signal;

    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      // A user-initiated /stop or process shutdown aborts the caller's signal,
      // which surfaces here as an AbortError. That isn't a backend failure, so
      // counting it would let three consecutive /stops trip the circuit breaker
      // and lock the bot out of its own LLM until the cooldown elapses.
      if (!(e instanceof Error && e.name === 'AbortError')) recordFailure(e);
      throw e;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timeoutId);
      recordFailure(new Error(`http ${res.status}`));
      const text = await res.text().catch(() => '');
      throw new LLMHttpError(res.status, `ollama responded ${res.status}: ${text}`);
    }

    let sawContent = false;
    let sawToolCall = false;
    try {
      for await (const chunk of parseNdjsonStream(res.body, target.model, log)) {
        if (chunk.delta) sawContent = true;
        if (chunk.toolCalls && chunk.toolCalls.length > 0) sawToolCall = true;
        yield chunk;
      }
      // Empty-response guard: a successful stream that produced neither text
      // nor a tool call is almost always a model misfire (truncated, stuck on
      // /think). Surfacing it as an error lets the orchestrator say something
      // useful instead of streaming silent "(no reply)".
      if (!sawContent && !sawToolCall) {
        throw new LLMEmptyResponseError();
      }
      recordSuccess();
    } catch (e) {
      // AbortError isn't a backend failure — don't trip the breaker for it.
      // LLMEmptyResponseError is the model's fault, not the transport's.
      if (
        !(e instanceof Error && e.name === 'AbortError') &&
        !(e instanceof LLMEmptyResponseError)
      ) {
        recordFailure(e);
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function health(): Promise<{ ok: boolean; models: string[] }> {
    try {
      const res = await fetchImpl(`${opts.baseUrl}/api/tags`);
      if (!res.ok) return { ok: false, models: [] };
      const j = (await res.json()) as { models?: Array<{ name: string }> };
      return { ok: true, models: (j.models ?? []).map((m) => m.name) };
    } catch {
      return { ok: false, models: [] };
    }
  }

  function listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return {
      chat: opts.profiles.chat ?? null,
      reason: opts.profiles.reason ?? null,
      tools: opts.profiles.tools ?? null,
    };
  }

  function resolveModel(p: ProfileName | { model: string }): string {
    return resolveProfile(p).model;
  }

  return { chat, health, listProfiles, resolveModel, breakerSnapshot, stopIdleEviction };
}

// Parse a single newline-delimited chunk. Returns null + logs on failure so
// the stream reader can skip a malformed line instead of crashing the turn.
function tryParseChunk(line: string, log?: Logger): OllamaChatChunk | null {
  try {
    return JSON.parse(line) as OllamaChatChunk;
  } catch (e) {
    log?.warn('ollama stream: malformed JSON line, skipping', {
      preview: line.slice(0, 100),
      error: e instanceof Error ? e.message : 'parse error',
    });
    return null;
  }
}

// Parse a tool-call argument JSON. Returns an empty object on failure so the
// tool runner sees a schema-validation error from the model rather than a
// thrown exception out of the stream iterator.
function tryParseToolArgs(raw: string, log?: Logger): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    log?.warn('ollama tool_call arguments JSON malformed, using empty object', {
      preview: raw.slice(0, 100),
      error: e instanceof Error ? e.message : 'parse error',
    });
    return {};
  }
}

function chunkFromParsed(parsed: OllamaChatChunk, fallbackModel: string, log?: Logger): ChatChunk {
  const chunk: ChatChunk = {
    delta: parsed.message?.content ?? '',
    done: !!parsed.done,
    model: parsed.model ?? fallbackModel,
  };
  const toolCalls = parsed.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    // Defensively skip any tool_call lacking a well-formed `function` block.
    // Ollama always sends one, but a partial/garbled line can parse as JSON
    // yet omit it; `tc.function.name` would then throw out of the stream
    // iterator and abort the whole turn. Skipping matches how tryParseChunk /
    // tryParseToolArgs tolerate other malformed stream data.
    const mapped = toolCalls
      .filter((tc) => tc?.function && typeof tc.function.name === 'string')
      .map((tc, i) => ({
        id: tc.id ?? `call_${i}_${Date.now()}`,
        name: tc.function.name,
        arguments:
          typeof tc.function.arguments === 'string'
            ? tryParseToolArgs(tc.function.arguments, log)
            : (tc.function.arguments ?? {}),
      }));
    if (mapped.length > 0) chunk.toolCalls = mapped;
  }
  if (parsed.prompt_eval_count !== undefined) chunk.promptTokens = parsed.prompt_eval_count;
  if (parsed.eval_count !== undefined) chunk.completionTokens = parsed.eval_count;
  return chunk;
}

// Parse Ollama's newline-delimited JSON stream into ChatChunks.
// Exported for tests; production code drives it via createOllama().chat().
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  log?: Logger,
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = tryParseChunk(line, log);
        if (!parsed) continue;
        yield chunkFromParsed(parsed, fallbackModel, log);
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = tryParseChunk(tail, log);
      if (parsed) {
        yield { ...chunkFromParsed(parsed, fallbackModel, log), done: true };
      }
    }
  } finally {
    // If the consumer stops early (e.g. /stop aborts mid-stream), the async
    // generator's return() runs this finally. Cancel the reader so the locked
    // body stream and its underlying connection are released promptly instead
    // of lingering until GC.
    await reader.cancel().catch(() => {});
  }
}

interface OllamaChatChunk {
  model?: string;
  done?: boolean;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: string | Record<string, unknown> };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}
