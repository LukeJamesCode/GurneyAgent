// Extension loader. Discovery, manifest validation, capability gating, and
// hot-reload. The loader is what turns Gurney from "a bot that talks to
// Ollama" into "a bot that does anything".
//
// Lifecycle for one extension:
//   1. discover    — find <root>/<name>/manifest.json
//   2. validate    — parse manifest, check name + version + gurney range
//   3. migrate     — run extension-owned migrations against the shared DB
//                    using a private `_ext_<name>_migrations` table
//   4. settings    — load settings.schema.json (if present), merge defaults
//   5. prompt      — load prompt.md (if present)
//   6. import      — dynamic-import each entrypoint and call register(host)
//   7. enabled     — record state row, mark "loaded" in registries
//
// Hot-reload: a chokidar-style watch on the root. Add a folder → load it.
// Remove a folder → unload its registrations. Edit a manifest or entrypoint
// file → reload. Cache busts via a `?v=<mtime>` query string on import URL.
//
// Partial-load safety. Every host.* call records a disposer on the staging
// load record. If any entrypoint throws mid-load we run the disposers in
// LIFO order before bailing out — that way a half-loaded extension can't
// leave stale Telegram commands, intercepts, prompt fragments, or scheduler
// jobs behind. Without this rollback the previous loader could leak commands
// from a broken extension and the only way out was a process restart.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  watch,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from '../storage/db.js';
import { migrate as runMigrations } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM } from './llm.js';
import type { AfterExecuteListener, ToolHandler, ToolRegistry } from './tools.js';
import type { Scheduler, JobHandler, ScheduledJob } from './scheduler.js';
import type { FastCache } from './fast-cache.js';
import { namespacedCache } from './fast-cache.js';

// ---------------------------------------------------------------------------
// Manifest + Host API
// ---------------------------------------------------------------------------

export interface Manifest {
  name: string;
  version: string;
  description?: string;
  // Semver range understood by the host. Phase 2 supports `>=X.Y.Z` only.
  gurney: string;
  deps?: string[];
  // Declarative — the host doesn't sandbox these in v1, but it logs anything
  // unrecognised so we surface drift.
  capabilities?: string[];
  entrypoints?: {
    tools?: string;
    commands?: string;
    jobs?: string;
    auth?: string;
    setup?: string;
  };
  // Telegram slash commands the extension contributes. Used for setMyCommands.
  telegram_commands?: Array<{ command: string; description: string }>;
  // Optional case-insensitive regex (as a string) that flags messages this
  // extension's tools are relevant to. The orchestrator uses it to prune the
  // tool manifest sent to the LLM per turn — a smaller manifest cuts prompt
  // tokens and gives small models fewer tools to confuse themselves with.
  // When NO extension's pattern matches, the orchestrator falls back to
  // exposing every tool (preserves the pre-filter behaviour).
  intent_pattern?: string;
}

export interface SettingsSchema {
  // JSON-Schema-ish but tiny: only object root with typed keys, defaults,
  // required[], description. Enough for the TUI in Phase 3 to render.
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean';
      default?: string | number | boolean;
      description?: string;
      secret?: boolean;
    }
  >;
  required?: string[];
}

export interface ExtensionSettings {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: string | number | boolean): void;
  all(): Record<string, string | number | boolean>;
}

// What a Telegram command handler looks like from an extension's perspective.
// Extensions don't depend on grammY directly — the adapter wraps grammY's
// Context into this richer, neutral shape.
export interface TelegramCommandContext {
  chatId: number;
  userId: number;
  args: string;
  reply: (text: string) => Promise<void>;
}

export type TelegramCommandHandler = (ctx: TelegramCommandContext) => Promise<void>;

export interface TelegramInterceptContext extends TelegramCommandContext {
  text: string;
  // True if calling next() should let the orchestrator handle the message.
  next: () => Promise<void>;
}

export type TelegramInterceptHandler = (ctx: TelegramInterceptContext) => Promise<void>;

// Fired after the orchestrator finishes streaming an assistant reply. Used by
// gurney-tts to synthesize and send a voice note alongside the text reply.
// Handlers run sequentially after the user-facing send completes; they must
// not throw the orchestrator off the rails so the Telegram adapter catches errors.
export interface AfterReplyContext {
  chatId: number;
  userId: number;
  text: string;
  log: Logger;
}

export type AfterReplyHandler = (ctx: AfterReplyContext) => Promise<void>;

export interface AfterTurnToolCallSummary {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  resultSummary: string;
}

// Rich post-turn hook for learning/routine extensions. Unlike afterReply,
// this includes the user text, conversation id, timing, and tool activity so
// extensions can learn patterns outside the hot reply path.
export interface AfterTurnContext {
  chatId: number;
  userId: number;
  conversationId: number;
  userText: string;
  assistantText: string;
  startedAt: number;
  finishedAt: number;
  toolCalls: AfterTurnToolCallSummary[];
}

export type AfterTurnHandler = (ctx: AfterTurnContext) => Promise<void>;

// Voice-note payload an extension hands the Telegram adapter. Either an
// in-memory buffer or a path to a file the adapter can stream from disk.
export interface VoicePayload {
  data?: Buffer;
  path?: string;
  caption?: string;
}

export interface KnownTelegramChat {
  chatId: number;
  userId: number;
  devmode: boolean;
  lastSeenAt: number;
}

export interface AuthFlow {
  // User-visible label for `gurney auth <ext>`.
  label: string;
  // The runner returns a settings patch that the loader writes back into the
  // extension_settings table. CLI orchestrates the I/O (prompts, callback
  // server). Phase 2 ships the declaration; Phase 3 ships the prompt UI.
  run: (io: AuthFlowIO) => Promise<Record<string, string | number | boolean>>;
}

export interface AuthFlowIO {
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  print: (line: string) => void;
}

export interface ExtensionSetupContext {
  name: string;
  folder: string;
  home: string;
  db: DB;
  interactive: boolean;
  stdout: (text: string) => void;
  settings: ExtensionSettings;
}

export interface SetupEntrypointModule {
  setup?: (ctx: ExtensionSetupContext) => void | Promise<void>;
  run?: (ctx: ExtensionSetupContext) => void | Promise<void>;
}

export interface Host {
  // Identity + filesystem
  name: string;
  version: string;
  log: Logger;
  dataDir: string;

  // Shared core services
  db: DB;
  llm: LLM;

  // Per-extension config / settings store
  settings: ExtensionSettings;

  // Registries the extension can hook into
  tools: {
    register: (h: ToolHandler) => void;
    unregister: (name: string) => void;
    // Hook fired after a successful tool run. The common use case is
    // invalidating fast-cache entries after a write (e.g. busting the
    // today's-events cache once add_event completes). Returns a disposer
    // that drops the listener; the loader also drops it automatically when
    // the extension is unloaded so callers rarely have to invoke it.
    onAfterExecute: (toolName: string, listener: AfterExecuteListener) => void;
  };
  telegram: {
    command: (name: string, handler: TelegramCommandHandler, description?: string) => void;
    intercept: (handler: TelegramInterceptHandler) => void;
    // After-reply hook: fires once the orchestrator finishes a streamed reply.
    // Wired by core; extensions opt in. Handler errors are caught by the adapter.
    afterReply: (handler: AfterReplyHandler) => void;
    // Rich post-turn hook for learning/routine extensions. Fires after the
    // visible Telegram reply is sent and carries user text, conversation id,
    // timing, and summarized tool activity. Use afterReply for simple TTS.
    afterTurn: (handler: AfterTurnHandler) => void;
    // Send a voice note. Backed by the Telegram adapter when available, or a
    // no-op stub during tests so extensions can register without grammY in scope.
    sendVoice: (chatId: number, voice: VoicePayload) => Promise<void>;
    // The default Telegram chat ID from core config. Prefer per-chat or per-routine
    // state when available; keep this as the backward-compatible fallback.
    defaultChatId: number;
    // Backward-compatible alias for older extensions. New code should use
    // defaultChatId or knownChats().
    chatId: number;
    // Chats that have talked to the bot and belong to allowlisted Telegram users.
    // This is safe for proactive jobs because rows are sourced from the core
    // telegram_chats table after the adapter allowlist gate.
    knownChats: () => KnownTelegramChat[];
  };
  scheduler: {
    cron: (
      name: string,
      expr: string,
      handler: JobHandler,
      opts?: Pick<ScheduledJob, 'timeZone'>,
    ) => void;
  };
  // Shared TTL cache namespaced to this extension. Useful for memoizing per-
  // tick work in cron jobs (e.g. "list today's events" once even if three
  // sweeps run within a minute). Stats are reported globally in /status.
  cache: FastCache;
  prompts: {
    contribute: (fragment: string) => void;
  };
  auth: {
    flow: (flow: AuthFlow) => void;
  };
}

export interface EntrypointModule {
  register?: (host: Host) => void | Promise<void>;
  unregister?: (host: Host) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry surfaces the loader exposes to the rest of core
// ---------------------------------------------------------------------------

export interface ExtensionCommandRecord {
  extension: string;
  name: string;
  description: string;
  handler: TelegramCommandHandler;
}

export interface ExtensionInterceptRecord {
  extension: string;
  handler: TelegramInterceptHandler;
}

export interface ExtensionAfterReplyRecord {
  extension: string;
  handler: AfterReplyHandler;
}

export interface ExtensionAfterTurnRecord {
  extension: string;
  handler: AfterTurnHandler;
}

export interface ExtensionAuthRecord {
  extension: string;
  flow: AuthFlow;
}

export interface LoadedExtension {
  name: string;
  version: string;
  enabled: boolean;
  manifest: Manifest;
  promptFragment?: string;
  // Live for diagnostics.
  registeredTools: string[];
  registeredCommands: string[];
  registeredJobs: number;
  registeredIntercepts: number;
  hasAuthFlow: boolean;
  loadedAt: number;
  error?: string;
}

export interface ExtensionLoaderOptions {
  // Search paths for extension folders. Each path is scanned non-recursively;
  // each subdirectory containing a manifest.json is one extension. Multiple
  // roots let core ship first-party extensions from <repo>/extensions while
  // users also drop folders in ~/.gurney/extensions.
  roots: string[];
  // Where extension scratch state lives. The loader makes
  // <stateRoot>/<name>/ for each extension on first load.
  stateRoot: string;

  db: DB;
  llm: LLM;
  log: Logger;
  scheduler: Scheduler;
  tools: ToolRegistry;

  // Host's own version — used to validate `manifest.gurney` ranges.
  hostVersion: string;
  // The default Telegram chat ID. Passed into each extension's host so older
  // nudge jobs keep their single-chat behavior when no chat-aware state exists.
  chatId: number;
  // Telegram users allowed to talk to the bot. knownChats() filters SQLite rows
  // to this set; omitted in tests means the default chat remains the only
  // allowlisted identity.
  allowedUserIds?: number[];
  // Disable hot-reload (e.g. tests).
  watch?: boolean;
  // Optional sink for voice notes. The Telegram adapter wires its grammY-backed
  // implementation here; tests leave it undefined and the loader hands a no-op
  // to extensions so registration still succeeds.
  sendVoice?: (chatId: number, voice: VoicePayload) => Promise<void>;
  // Fired after an explicit or watched hot-reload completes. Startup calls
  // loadAll() directly and handles its own notification after Telegram is up.
  onDidReload?: () => void | Promise<void>;
}

export interface ExtensionLoader {
  loadAll(): Promise<void>;
  reload(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  list(): LoadedExtension[];
  // The Telegram adapter calls these to drive its dispatcher. They return the
  // *current* registrations — fresh on every call so hot-reload is visible.
  commands(): ExtensionCommandRecord[];
  intercepts(): ExtensionInterceptRecord[];
  afterReplies(): ExtensionAfterReplyRecord[];
  afterTurns(): ExtensionAfterTurnRecord[];
  authFlows(): ExtensionAuthRecord[];
  // Concatenated prompt fragments, in stable order (alpha by extension name).
  // Pass a filter set to include only those extensions' fragments — pairs
  // with `relevantExtensions` so the orchestrator can prune system-prompt
  // weight on the same axis it prunes the tool manifest.
  promptFragment(extensionFilter?: ReadonlySet<string>): string;
  // Names of extensions whose `intent_pattern` matches the given message.
  // Returns null when nothing matched — caller should treat that as "expose
  // every tool" rather than "expose no tools". An empty array means the
  // message looks trivial or low-signal and tools should be skipped entirely.
  relevantExtensions(message: string): string[] | null;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const KNOWN_CAPABILITIES = new Set([
  'network',
  'storage',
  'telegram',
  'scheduler',
  'auth:oauth',
  'auth:token',
  'llm',
]);

interface RegistrationsForExtension {
  toolNames: string[];
  commands: ExtensionCommandRecord[];
  intercepts: ExtensionInterceptRecord[];
  afterReplies: ExtensionAfterReplyRecord[];
  afterTurns: ExtensionAfterTurnRecord[];
  jobsRegistered: number;
  authFlow?: AuthFlow;
  promptFragment?: string;
  // Compiled intent_pattern from the manifest. Compiled once at load time so
  // we don't pay the regex cost on every user turn.
  intentPattern?: RegExp;
  // LIFO list of cleanup callbacks captured during host.* calls. Run on a
  // failed mid-load to fully roll back a partially-registered extension.
  // Also reused at unload time so the unload path can undo every host call
  // without remembering each surface (commands, intercepts, etc.) explicitly.
  disposers: Array<() => void | Promise<void>>;
}

// Trivial-chatter regex. Messages matching this almost never need a tool
// (greetings, thanks, simple acknowledgements) and the orchestrator can skip
// the tool manifest entirely on these turns. Lifted from ATLAS's keyword
// router — the words and shape have already been tuned in production.
const TRIVIAL_CHATTER_RE =
  /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nah|bye|good|nice|cool|lol|haha|please|yo|sup|gm|gn|what's up|whats up)[\s!?.]*$/i;

function isTrivialChatter(message: string): boolean {
  return TRIVIAL_CHATTER_RE.test(message.trim());
}

function isLowSignalMessage(message: string): boolean {
  const compact = message.trim().replace(/[^a-z0-9]/gi, '');
  if (!compact) return true;
  if (compact.length >= 3 && new Set([...compact.toLowerCase()]).size === 1) return true;
  return false;
}

export function createExtensionLoader(opts: ExtensionLoaderOptions): ExtensionLoader {
  const allowedUserIds = opts.allowedUserIds ?? [opts.chatId];
  const log = opts.log.child({ mod: 'extensions' });
  const loaded = new Map<string, LoadedExtension>();
  const registrations = new Map<string, RegistrationsForExtension>();
  const dirs = new Map<string, string>(); // extension name -> resolved folder
  const watchers: Array<() => void> = [];
  const extensionWatchers = new Map<string, () => void>();
  const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeReloads = new Set<Promise<void>>();
  let shuttingDown = false;

  function ensureStateRow(manifest: Manifest): boolean {
    const existing = opts.db
      .prepare(`SELECT enabled, version FROM extension_state WHERE name = ?`)
      .get(manifest.name) as { enabled: number; version: string } | undefined;
    if (!existing) {
      opts.db
        .prepare(
          `INSERT INTO extension_state (name, version, enabled, installed_at, last_loaded_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(manifest.name, manifest.version, Date.now(), Date.now());
      return true;
    }
    if (existing.version !== manifest.version) {
      opts.db
        .prepare(`UPDATE extension_state SET version = ?, last_loaded_at = ? WHERE name = ?`)
        .run(manifest.version, Date.now(), manifest.name);
    } else {
      opts.db
        .prepare(`UPDATE extension_state SET last_loaded_at = ? WHERE name = ?`)
        .run(Date.now(), manifest.name);
    }
    return existing.enabled !== 0;
  }

  function makeSettings(name: string, schema: SettingsSchema | undefined): ExtensionSettings {
    const defaults: Record<string, string | number | boolean> = {};
    if (schema) {
      for (const [k, v] of Object.entries(schema.properties)) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
    }
    // Cache the merged (defaults + DB rows) view. The previous behaviour did
    // a SELECT * + decode on every host.settings.get(), which a chatty
    // extension can do dozens of times per turn. Invalidated whenever set()
    // mutates a value — all writes flow through this same instance because
    // each extension gets its own makeSettings() call.
    let cache: Record<string, string | number | boolean> | null = null;
    function readAll(): Record<string, string | number | boolean> {
      if (cache) return cache;
      const rows = opts.db
        .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
        .all(name) as Array<{ key: string; value: string }>;
      const out: Record<string, string | number | boolean> = { ...defaults };
      for (const r of rows) {
        const decl = schema?.properties[r.key];
        if (decl?.type === 'number') out[r.key] = Number(r.value);
        else if (decl?.type === 'boolean') out[r.key] = r.value === 'true';
        else out[r.key] = r.value;
      }
      cache = out;
      return out;
    }
    return {
      get<T = unknown>(key: string, fallback?: T): T {
        const all = readAll();
        if (key in all) return all[key] as unknown as T;
        return fallback as T;
      },
      set(key, value) {
        opts.db
          .prepare(
            `INSERT INTO extension_settings (extension, key, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(name, key, String(value), Date.now());
        cache = null;
      },
      // Defensive copy so callers can't mutate the cached object.
      all: () => ({ ...readAll() }),
    };
  }

  function validateManifest(raw: unknown, source: string): Manifest {
    if (!raw || typeof raw !== 'object') throw new Error(`${source}: manifest is not an object`);
    const m = raw as Record<string, unknown>;
    if (typeof m['name'] !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(m['name'])) {
      throw new Error(`${source}: invalid manifest.name`);
    }
    if (typeof m['version'] !== 'string') throw new Error(`${source}: missing manifest.version`);
    if (typeof m['gurney'] !== 'string') throw new Error(`${source}: missing manifest.gurney`);

    if (!satisfiesGurneyRange(opts.hostVersion, m['gurney'] as string)) {
      throw new Error(
        `${source}: extension requires gurney ${m['gurney']}, host is ${opts.hostVersion}`,
      );
    }
    const caps = Array.isArray(m['capabilities']) ? (m['capabilities'] as string[]) : [];
    for (const c of caps) {
      if (!KNOWN_CAPABILITIES.has(c)) {
        log.warn('extension declares unknown capability', { name: m['name'], capability: c });
      }
    }
    return m as unknown as Manifest;
  }

  async function importEntrypoint(folder: string, rel: string): Promise<EntrypointModule> {
    const abs = resolve(folder, rel);
    // Containment: a manifest with `"entrypoint": "../../etc/passwd.js"` must
    // not let an extension import code outside its own folder.
    const within = relative(folder, abs);
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error(`entrypoint escapes extension folder: ${rel}`);
    }
    if (!existsSync(abs)) throw new Error(`entrypoint missing: ${abs}`);
    const mtime = statSync(abs).mtimeMs;
    // Cache-bust via query string so hot-reload picks up code changes.
    const url = `${pathToFileURL(abs).href}?v=${Math.floor(mtime)}`;
    return (await import(url)) as EntrypointModule;
  }

  async function runDisposers(reg: RegistrationsForExtension, name: string): Promise<void> {
    // LIFO: undoing in reverse insertion order means a disposer that depends
    // on something installed earlier still has it around.
    for (let i = reg.disposers.length - 1; i >= 0; i--) {
      try {
        await reg.disposers[i]!();
      } catch (e) {
        // error (not warn) — a failing disposer can leave the extension in
        // an inconsistent state; operators must see this when grepping logs.
        log.error('extension disposer failed', {
          ext: name,
          error: e instanceof Error ? e.message : 'disposer error',
        });
      }
    }
    reg.disposers.length = 0;
  }

  async function loadOne(folder: string): Promise<void> {
    const manifestPath = join(folder, 'manifest.json');
    if (!existsSync(manifestPath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      log.warn('extension manifest is not valid JSON — skipping', {
        path: manifestPath,
        error: e instanceof Error ? e.message : 'parse error',
      });
      return;
    }
    const manifest = validateManifest(raw, manifestPath);

    // Tear down any prior load so re-entering loadOne is a clean reload.
    if (loaded.has(manifest.name)) await unloadInternal(manifest.name);

    const enabled = ensureStateRow(manifest);
    dirs.set(manifest.name, folder);
    if (opts.watch !== false && !shuttingDown) watchExtensionFolder(manifest.name, folder);

    const cl = log.child({ ext: manifest.name });
    if (!enabled) {
      cl.info('extension is disabled — skipping load');
      loaded.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        enabled: false,
        manifest,
        registeredTools: [],
        registeredCommands: [],
        registeredJobs: 0,
        registeredIntercepts: 0,
        hasAuthFlow: false,
        loadedAt: Date.now(),
      });
      return;
    }

    // Per-extension migrations
    const migDir = join(folder, 'migrations');
    if (existsSync(migDir)) {
      runMigrations(opts.db, migDir, cl, { table: tableNameFor(manifest.name) });
    }

    // settings + prompt + state dir
    const schemaPath = join(folder, 'settings.schema.json');
    let schema: SettingsSchema | undefined;
    if (existsSync(schemaPath)) {
      try {
        schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SettingsSchema;
      } catch (e) {
        cl.warn('settings.schema.json is not valid JSON — using no schema', {
          path: schemaPath,
          error: e instanceof Error ? e.message : 'parse error',
        });
      }
    }

    const promptPath = join(folder, 'prompt.md');
    const promptFragment = existsSync(promptPath)
      ? readFileSync(promptPath, 'utf8').trim() || undefined
      : undefined;

    const dataDir = join(opts.stateRoot, manifest.name);
    // 0o700: extension state can hold tokens (e.g. gurney-everyday-assistant's
    // OAuth tokens). On a shared Pi/host, other local users shouldn't read it.
    // Mode is a no-op on Windows. recursive: true tolerates existing dirs.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    let intentPattern: RegExp | undefined;
    if (manifest.intent_pattern) {
      // Hard length cap defends against ReDoS: a malicious extension can
      // otherwise ship a pattern like `(a+)+b` that pegs CPU on every user
      // message on the Pi target. 256 chars is far more than any legitimate
      // intent pattern needs.
      if (manifest.intent_pattern.length > 256) {
        cl.warn('manifest.intent_pattern exceeds 256 chars; ignoring', {
          length: manifest.intent_pattern.length,
        });
      } else {
        try {
          intentPattern = new RegExp(manifest.intent_pattern, 'i');
        } catch (e) {
          cl.warn('manifest.intent_pattern is not a valid regex; ignoring', {
            pattern: manifest.intent_pattern,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const reg: RegistrationsForExtension = {
      toolNames: [],
      commands: [],
      intercepts: [],
      afterReplies: [],
      afterTurns: [],
      jobsRegistered: 0,
      promptFragment: promptFragment ?? '',
      ...(intentPattern ? { intentPattern } : {}),
      disposers: [],
    };

    const settings = makeSettings(manifest.name, schema);

    // Every host method that mutates a registry pushes a disposer onto
    // reg.disposers. This is the safety net for partial-load failures: if
    // any entrypoint throws after, say, registering two commands and one
    // tool, we still tear all three down before bailing out.
    const host: Host = {
      name: manifest.name,
      version: manifest.version,
      log: cl,
      dataDir,
      db: opts.db,
      llm: opts.llm,
      settings,
      tools: {
        register: (h) => {
          opts.tools.register({ ...h, extension: manifest.name });
          reg.toolNames.push(h.name);
          reg.disposers.push(() => {
            opts.tools.unregister(h.name);
            reg.toolNames = reg.toolNames.filter((n) => n !== h.name);
          });
        },
        unregister: (name) => {
          opts.tools.unregister(name);
          reg.toolNames = reg.toolNames.filter((n) => n !== name);
        },
        onAfterExecute: (toolName, listener) => {
          const off = opts.tools.onAfterExecute(toolName, listener);
          reg.disposers.push(off);
        },
      },
      telegram: {
        command: (name, handler, description = '') => {
          const record: ExtensionCommandRecord = {
            extension: manifest.name,
            name,
            description,
            handler,
          };
          reg.commands.push(record);
          reg.disposers.push(() => {
            const idx = reg.commands.indexOf(record);
            if (idx >= 0) reg.commands.splice(idx, 1);
          });
        },
        intercept: (handler) => {
          const record: ExtensionInterceptRecord = { extension: manifest.name, handler };
          reg.intercepts.push(record);
          reg.disposers.push(() => {
            const idx = reg.intercepts.indexOf(record);
            if (idx >= 0) reg.intercepts.splice(idx, 1);
          });
        },
        afterReply: (handler) => {
          const record: ExtensionAfterReplyRecord = { extension: manifest.name, handler };
          reg.afterReplies.push(record);
          reg.disposers.push(() => {
            const idx = reg.afterReplies.indexOf(record);
            if (idx >= 0) reg.afterReplies.splice(idx, 1);
          });
        },
        afterTurn: (handler) => {
          const record: ExtensionAfterTurnRecord = { extension: manifest.name, handler };
          reg.afterTurns.push(record);
          reg.disposers.push(() => {
            const idx = reg.afterTurns.indexOf(record);
            if (idx >= 0) reg.afterTurns.splice(idx, 1);
          });
        },
        sendVoice: async (chatId, voice) => {
          if (!opts.sendVoice) {
            cl.warn('sendVoice called but adapter has no voice sink');
            return;
          }
          await opts.sendVoice(chatId, voice);
        },
        defaultChatId: opts.chatId,
        chatId: opts.chatId,
        knownChats: () => knownTelegramChats(opts.db, allowedUserIds),
      },
      scheduler: {
        cron: (name, expr, handler, schedulerOpts) => {
          opts.scheduler.register({
            extension: manifest.name,
            name,
            cron: expr,
            handler,
            ...(schedulerOpts?.timeZone ? { timeZone: schedulerOpts.timeZone } : {}),
          });
          reg.jobsRegistered += 1;
          reg.disposers.push(() => {
            // Scheduler doesn't support per-job unregister; we tear all
            // of this extension's jobs down at unload time. Recording the
            // disposer so it counts as an undo step keeps the rollback
            // trace symmetric across surfaces.
            reg.jobsRegistered = Math.max(0, reg.jobsRegistered - 1);
          });
        },
      },
      cache: namespacedCache(manifest.name, opts.scheduler.cache),
      prompts: {
        contribute: (fragment) => {
          const before = reg.promptFragment ?? '';
          reg.promptFragment = (before ? before + '\n\n' : '') + fragment;
          reg.disposers.push(() => {
            reg.promptFragment = before;
          });
        },
      },
      auth: {
        flow: (flow) => {
          const before = reg.authFlow;
          reg.authFlow = flow;
          reg.disposers.push(() => {
            reg.authFlow = before;
          });
        },
      },
    };

    const entrypoints = manifest.entrypoints ?? {};
    const order: Array<[keyof typeof entrypoints, string | undefined]> = [
      ['tools', entrypoints.tools],
      ['commands', entrypoints.commands],
      ['jobs', entrypoints.jobs],
      ['auth', entrypoints.auth],
    ];

    try {
      for (const [kind, rel] of order) {
        if (!rel) continue;
        const mod = await importEntrypoint(folder, rel);
        if (typeof mod.register === 'function') {
          await mod.register(host);
        } else {
          cl.warn('entrypoint has no register() export', { kind, file: rel });
        }
        if (typeof mod.unregister === 'function') {
          const fn = mod.unregister;
          // The extension's own unregister hook runs first on the next
          // unload (LIFO disposer order). Wrapped in try/catch by runDisposers.
          reg.disposers.push(() => fn(host));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cl.error('extension load failed — rolling back', { error: msg });
      // Run every disposer collected so far. After this completes the
      // tools, commands, intercepts, jobs, prompt fragment, and any auth
      // flow registered before the error are all cleaned up.
      await runDisposers(reg, manifest.name);
      // Defensive: also drop scheduler jobs by extension in case the cron
      // disposer above missed any (e.g. an extension that registered jobs
      // through a different path in a future refactor).
      opts.scheduler.unregisterByExtension(manifest.name);
      loaded.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        enabled: true,
        manifest,
        registeredTools: [],
        registeredCommands: [],
        registeredJobs: 0,
        registeredIntercepts: 0,
        hasAuthFlow: false,
        loadedAt: Date.now(),
        error: msg,
      });
      return;
    }

    registrations.set(manifest.name, reg);
    const entry: LoadedExtension = {
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      manifest,
      registeredTools: [...reg.toolNames],
      registeredCommands: reg.commands.map((c) => c.name),
      registeredJobs: reg.jobsRegistered,
      registeredIntercepts: reg.intercepts.length,
      hasAuthFlow: reg.authFlow !== undefined,
      loadedAt: Date.now(),
    };
    if (reg.promptFragment) entry.promptFragment = reg.promptFragment;
    loaded.set(manifest.name, entry);
    cl.info('extension loaded', {
      version: manifest.version,
      tools: reg.toolNames.length,
      commands: reg.commands.length,
      jobs: reg.jobsRegistered,
    });
  }

  async function unloadInternal(name: string): Promise<void> {
    const reg = registrations.get(name);
    if (reg) {
      // The disposer list is the symmetric undo for everything the
      // extension's host calls did during load. Running it here means we
      // don't have to enumerate every registry surface separately.
      await runDisposers(reg, name);
      // Belt-and-braces: tools and scheduler are the two surfaces with
      // a "sweep by extension" API, so call them too in case anything
      // slipped past the disposer trail.
      for (const t of reg.toolNames) opts.tools.unregister(t);
      opts.scheduler.unregisterByExtension(name);
    }
    registrations.delete(name);
    loaded.delete(name);
    const close = extensionWatchers.get(name);
    if (close) {
      close();
      extensionWatchers.delete(name);
    }
    const timer = reloadTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      reloadTimers.delete(name);
    }
  }

  async function loadAll(): Promise<void> {
    for (const root of opts.roots) {
      mkdirSync(root, { recursive: true });
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const folder = join(root, entry);
        try {
          if (!statSync(folder).isDirectory()) continue;
          await loadOne(folder);
        } catch (e) {
          log.warn('extension discovery failed', {
            folder,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    if (opts.watch !== false) startWatching();
  }

  async function reload(name: string): Promise<void> {
    const folder = dirs.get(name);
    if (!folder) {
      // It might be a brand-new extension folder.
      for (const root of opts.roots) {
        const candidate = join(root, name);
        if (existsSync(join(candidate, 'manifest.json'))) {
          await loadOne(candidate);
          await opts.onDidReload?.();
          return;
        }
      }
      throw new Error(`extension '${name}' not found`);
    }
    await loadOne(folder);
    await opts.onDidReload?.();
  }

  async function unload(name: string): Promise<void> {
    await unloadInternal(name);
  }

  function scheduleReload(name: string, folder: string): void {
    if (shuttingDown) return;
    const existing = reloadTimers.get(name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      reloadTimers.delete(name);
      const reloadTask = (async () => {
        if (shuttingDown) return;
        if (!existsSync(folder) || !existsSync(join(folder, 'manifest.json'))) {
          await unloadInternal(name);
          return;
        }
        log.info('extension change detected, reloading', { ext: name });
        await loadOne(folder);
        if (!shuttingDown) await opts.onDidReload?.();
      })();
      activeReloads.add(reloadTask);
      reloadTask
        .catch((e) => {
          log.warn('reload failed', {
            ext: name,
            error: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => {
          activeReloads.delete(reloadTask);
        });
    }, 100);
    timer.unref?.();
    reloadTimers.set(name, timer);
  }

  function watchExtensionFolder(name: string, folder: string): void {
    if (shuttingDown) return;
    if (extensionWatchers.has(name)) return;
    try {
      const closes: Array<() => void> = [];
      const watchDir = (dir: string): void => {
        const w = watch(dir, { persistent: false }, () => {
          scheduleReload(name, folder);
        });
        closes.push(() => w.close());
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          const child = join(dir, entry);
          try {
            // lstatSync: never follow symlinks. Otherwise a symlink loop or
            // a link pointing outside the extension folder would cause the
            // watcher to recurse forever / watch arbitrary directories.
            const st = lstatSync(child);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) watchDir(child);
          } catch {
            /* ignore vanished paths */
          }
        }
      };
      watchDir(folder);
      extensionWatchers.set(name, () => {
        for (const close of closes) close();
      });
    } catch (e) {
      log.warn('failed to watch extension folder', {
        ext: name,
        folder,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function startWatching(): void {
    for (const root of opts.roots) {
      try {
        const w = watch(root, { persistent: false }, (_event, file) => {
          if (!file) return;
          // We only react to top-level folder changes — nested file edits get
          // detected by the per-folder watcher below if we add one. For now
          // a coarse rescan is fine and simpler than walking event types.
          const seg = String(file).split(/[\\/]/);
          const top = seg[0];
          if (!top) return;
          const folder = join(root, top);
          (async () => {
            if (!existsSync(folder) || !statSync(folder).isDirectory()) {
              const found = [...dirs.entries()].find(([, f]) => f === folder);
              if (found) {
                log.info('extension folder removed', { ext: found[0] });
                await unloadInternal(found[0]);
              }
              return;
            }
            if (!existsSync(join(folder, 'manifest.json'))) return;
            log.info('extension change detected, reloading', { folder: top });
            try {
              await loadOne(folder);
              await opts.onDidReload?.();
            } catch (e) {
              log.warn('reload failed', {
                folder: top,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          })().catch(() => {});
        });
        watchers.push(() => w.close());
      } catch (e) {
        log.warn('failed to watch extensions root', {
          root,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  function list(): LoadedExtension[] {
    return [...loaded.values()];
  }

  function commands(): ExtensionCommandRecord[] {
    const out: ExtensionCommandRecord[] = [];
    for (const r of registrations.values()) out.push(...r.commands);
    return out;
  }
  function intercepts(): ExtensionInterceptRecord[] {
    const out: ExtensionInterceptRecord[] = [];
    for (const r of registrations.values()) out.push(...r.intercepts);
    return out;
  }
  function afterReplies(): ExtensionAfterReplyRecord[] {
    const out: ExtensionAfterReplyRecord[] = [];
    for (const r of registrations.values()) out.push(...r.afterReplies);
    return out;
  }
  function afterTurns(): ExtensionAfterTurnRecord[] {
    const out: ExtensionAfterTurnRecord[] = [];
    for (const r of registrations.values()) out.push(...r.afterTurns);
    return out;
  }
  function authFlows(): ExtensionAuthRecord[] {
    const out: ExtensionAuthRecord[] = [];
    for (const [name, r] of registrations.entries()) {
      if (r.authFlow) out.push({ extension: name, flow: r.authFlow });
    }
    return out;
  }

  function promptFragment(extensionFilter?: ReadonlySet<string>): string {
    const parts: string[] = [];
    for (const name of [...registrations.keys()].sort()) {
      if (extensionFilter && !extensionFilter.has(name)) continue;
      const f = registrations.get(name)?.promptFragment;
      if (f) parts.push(f);
    }
    return parts.join('\n\n');
  }

  function relevantExtensions(message: string): string[] | null {
    if (!message) return null;
    const hasAnyPattern = [...registrations.values()].some((reg) => reg.intentPattern);
    if (!hasAnyPattern) return null;
    if (isTrivialChatter(message)) return [];
    if (isLowSignalMessage(message)) return [];
    const matched: string[] = [];
    for (const [name, reg] of registrations.entries()) {
      if (!reg.intentPattern) continue;
      // ReDoS budget: a single .test() over 50ms means the pattern is
      // catastrophic backtracking territory. We disable it for the rest of
      // the extension's lifetime and skip this turn. Length-cap at load is
      // the first line of defense; this is the second.
      const startNs = process.hrtime.bigint();
      let matched_ = false;
      try {
        matched_ = reg.intentPattern.test(message);
      } catch (e) {
        log.warn('intent_pattern threw on test; disabling', {
          ext: name,
          error: e instanceof Error ? e.message : 'regex error',
        });
        reg.intentPattern = undefined;
        continue;
      }
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      if (elapsedMs > 50) {
        log.warn('intent_pattern exceeded 50ms budget; disabling', {
          ext: name,
          elapsedMs,
        });
        reg.intentPattern = undefined;
        continue;
      }
      if (matched_) matched.push(name);
    }
    // No extensions declared a pattern → caller should fall back to all tools.
    // Patterns existed but none matched → treat as chatter and skip the tool
    // manifest. Routing every "dang im tired today" through the heavy
    // tool-use profile (with the full schema block re-shipped each time) was
    // burning tokens and forcing chit-chat onto the slow model. False
    // negatives — a tool-needing phrase that no extension's regex caught —
    // are fixed by widening that extension's intent_pattern, not by spraying
    // tools at every unmatched line.
    if (matched.length === 0) return [];
    return matched;
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const timer of reloadTimers.values()) clearTimeout(timer);
    reloadTimers.clear();
    for (const close of watchers) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
    for (const close of extensionWatchers.values()) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    extensionWatchers.clear();
    await Promise.allSettled([...activeReloads]);
    for (const name of [...loaded.keys()]) await unloadInternal(name);
  }

  return {
    loadAll,
    reload,
    unload,
    list,
    commands,
    intercepts,
    afterReplies,
    afterTurns,
    authFlows,
    promptFragment,
    relevantExtensions,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableNameFor(extensionName: string): string {
  // _ext_<safe>_migrations. Map any character outside [a-z0-9_] to underscore.
  const safe = extensionName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `_ext_${safe}_migrations`;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

export function satisfiesGurneyRange(host: string, range: string): boolean {
  const r = range.trim();
  // Accepted forms: ">=X.Y.Z", "X.Y.Z", "*"
  if (r === '*') return true;
  const m = SEMVER_RE.exec(host);
  if (!m) return false;
  const hostV = [Number(m[1]), Number(m[2]), Number(m[3])];
  let target = r;
  let op: '>=' | '=' = '>=';
  if (r.startsWith('>=')) {
    op = '>=';
    target = r.slice(2).trim();
  } else if (/^\d/.test(r)) {
    op = '=';
  } else {
    return false;
  }
  const tm = SEMVER_RE.exec(target);
  if (!tm) return false;
  const tv = [Number(tm[1]), Number(tm[2]), Number(tm[3])];
  if (op === '=') return hostV.every((v, i) => v === tv[i]);
  for (let i = 0; i < 3; i++) {
    if (hostV[i]! > tv[i]!) return true;
    if (hostV[i]! < tv[i]!) return false;
  }
  return true; // equal
}

function knownTelegramChats(db: DB, allowedUserIds: number[]): KnownTelegramChat[] {
  if (allowedUserIds.length === 0) return [];
  const placeholders = allowedUserIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT chat_id, user_id, devmode, last_seen_at
       FROM telegram_chats
       WHERE user_id IN (${placeholders})
       ORDER BY last_seen_at DESC`,
    )
    .all(...allowedUserIds) as Array<{
    chat_id: number;
    user_id: number;
    devmode: number;
    last_seen_at: number;
  }>;

  return rows.map((row) => ({
    chatId: row.chat_id,
    userId: row.user_id,
    devmode: row.devmode !== 0,
    lastSeenAt: row.last_seen_at,
  }));
}
