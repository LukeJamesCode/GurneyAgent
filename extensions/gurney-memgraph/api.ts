// Thin HTTP client for the gurney-memgraph bridge — a separate Python service
// that owns FalkorDB + Graphiti. The bridge does the embedding, graph upsert,
// and cross-encoder rerank; we just hand it text and read back facts.
//
// PLAN explicitly cuts the IPC and EmbeddedBridge transports ATLAS shipped, so
// HTTP is the only wire format. Endpoints (matched by the Python bridge):
//   POST /memory/recall  { namespace, query, top_k }   -> { facts: Fact[] }
//   POST /memory/store   { namespace, source, episodes } -> { stored: number }
//   POST /memory/forget  { namespace }                  -> { ok: true }
//   GET  /health                                        -> { ok: true }
//
// Recall results are cached client-side (LRU, capped entries, TTL'd) so a
// busy turn — e.g. orchestrator's parallel context fetch landing the same
// query as a /recall slash command — doesn't hit the bridge twice. Cache is
// dropped wholesale on store/forget so writes invalidate stale reads. Atlas
// uses the same shape and dimensions (128 entries, 60s TTL).

export interface MemoryFact {
  text: string;
  // Higher = more relevant. Bridge reranks server-side.
  score?: number;
  // Optional metadata the bridge returns. Free-form by design — the LLM only
  // sees the text but the slash command surfaces score for diagnostics.
  source?: string;
  created_at?: number;
}

export interface MemoryEpisode {
  // Free-form text the bridge will fact-extract from. Typically one or two
  // turns of conversation, not the entire session — Graphiti chunks at this
  // granularity.
  text: string;
  // Wall-clock when the episode was observed. Bridge uses this to order facts.
  created_at: number;
  // Optional speaker label. Lets the bridge keep "user said X" vs
  // "assistant said X" distinct.
  role?: 'user' | 'assistant' | 'tool' | 'system';
}

export interface BridgeCredentials {
  url: string;
  token?: string;
  namespace: string;
}

export class MemoryBridgeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryBridgeError';
  }
}

interface FetchLike {
  (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface MemoryClientOptions {
  creds: BridgeCredentials;
  fetchImpl?: FetchLike;
  // Per-call timeout. Recall sits on the user-facing path so a slow bridge
  // must not hang the bot.
  timeoutMs?: number;
  // Recall cache size (entries). 0 disables the cache.
  cacheMax?: number;
  // Recall cache TTL.
  cacheTtlMs?: number;
  now?: () => number;
}

export interface MemoryClient {
  health(): Promise<boolean>;
  recall(query: string, topK: number): Promise<MemoryFact[]>;
  store(source: string, episodes: MemoryEpisode[]): Promise<number>;
  forget(): Promise<void>;
  // Test/diagnostic surface — drop the recall cache without doing a write.
  clearCache(): void;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_CACHE_MAX = 128;
const DEFAULT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: MemoryFact[];
  expiresAt: number;
}

export function createMemoryClient(opts: MemoryClientOptions): MemoryClient {
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.creds.url.replace(/\/+$/, '');
  const cacheMax = opts.cacheMax ?? DEFAULT_CACHE_MAX;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;

  // Insertion-ordered Map gives us LRU for free: re-set on hit, delete oldest
  // (first key) when over cap. Avoids dragging in an LRU dep for ~10 lines.
  const cache = new Map<string, CacheEntry>();

  function cacheKey(query: string, topK: number): string {
    return `${topK} ${opts.creds.namespace} ${query}`;
  }

  function cacheGet(key: string): MemoryFact[] | undefined {
    if (cacheMax <= 0) return undefined;
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    // LRU touch: re-insert so this becomes the most-recent.
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  function cacheSet(key: string, value: MemoryFact[]): void {
    if (cacheMax <= 0) return;
    cache.set(key, { value, expiresAt: now() + cacheTtlMs });
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function clearCache(): void {
    cache.clear();
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.creds.token) h['authorization'] = `Bearer ${opts.creds.token}`;
    return h;
  }

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(),
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        throw new MemoryBridgeError(res.status, `bridge ${method} ${path}: ${await res.text()}`);
      }
      if (res.status === 204) return null;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async health() {
      try {
        const j = (await request('GET', '/health')) as { ok?: boolean };
        return Boolean(j?.ok);
      } catch {
        return false;
      }
    },
    async recall(query, topK) {
      const key = cacheKey(query, topK);
      const cached = cacheGet(key);
      if (cached) return cached;
      const j = (await request('POST', '/memory/recall', {
        namespace: opts.creds.namespace,
        query,
        top_k: topK,
      })) as { facts?: MemoryFact[] };
      const facts = j.facts ?? [];
      cacheSet(key, facts);
      return facts;
    },
    async store(source, episodes) {
      if (episodes.length === 0) return 0;
      const j = (await request('POST', '/memory/store', {
        namespace: opts.creds.namespace,
        source,
        episodes,
      })) as { stored?: number };
      // Writes invalidate the read cache. Atlas does the same — there's no
      // reasonable way to know which cached recall queries the new episode
      // would have changed, so blow them all away.
      clearCache();
      return Number(j.stored ?? episodes.length);
    },
    async forget() {
      await request('POST', '/memory/forget', { namespace: opts.creds.namespace });
      clearCache();
    },
    clearCache,
  };
}
