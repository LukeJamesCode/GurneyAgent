// gurney-frontend HTTP server.
//
// Runs as its OWN process (launched by `gurney frontend`), not inside the
// agent daemon. That separation is deliberate: the panel's Start/Stop buttons
// control the daemon (`gurney start --detach` / `gurney stop`), and if the
// server lived inside the daemon then "Stop" would also kill the UI you were
// clicking it from.
//
// It serves the static browser UI from ./web and a small JSON API under /api
// that reuses the same core helpers the CLI does (effectiveConfig, probeOllama,
// collectDoctorChecks, collectExtensionReadiness, the SQLite settings store)
// and shells out to the `gurney` CLI for actions that have to mutate the
// install (start/stop, ext install/enable/disable/uninstall).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { freemem, networkInterfaces, tmpdir, totalmem } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { open as openDb, type DB } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createOllama } from '../../src/core/llm.js';
import { createOrchestrator, type Orchestrator } from '../../src/core/orchestrator.js';
import { createToolRegistry, type ToolContext, type ToolHandler } from '../../src/core/tools.js';
import { createScheduler, type Nudge } from '../../src/core/scheduler.js';
import { createPrefsStore } from '../../src/core/prefs.js';
import { setupFollowups } from '../../src/core/followups.js';
import {
  createExtensionLoader,
  type AfterTurnContext,
  type ExtensionLoader,
  type HostOrchestrator,
  type TelegramCommandContext,
  type TelegramInterceptContext,
  type TelegramVoiceMessage,
  type VoicePayload,
} from '../../src/core/extensions.js';
import { profilesForTier } from '../../src/cli/profiles.js';
import { probeOllama } from '../../src/cli/ollama-probe.js';
import { collectDoctorChecks } from '../../src/cli/doctor.js';
import { configureNativeDepsForExtension } from '../../src/cli/ext-setup.js';
import { discover as discoverExt, runAuthForExt, type AuthRunnerIO } from '../../src/cli/auth.js';
import {
  collectExtensionReadiness,
  type ExtensionReadiness,
} from '../../src/core/extension-readiness.js';
import { readMetrics } from '../../src/core/metrics.js';
import {
  effectiveConfig,
  homeDir,
  loadConfig,
  saveConfig,
  validateOllamaUrl,
  type GurneyConfig,
} from '../../src/cli/config-store.js';
import { isAlive, logFilePath, metricsFilePath, readPid } from '../../src/cli/daemon.js';
import type { Manifest, SettingsSchema } from '../../src/core/extensions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, 'web');
const REPO_ROOT = resolve(HERE, '..', '..');
const EXT_NAME = 'gurney-frontend';
const VERSION = '0.1.0';
const HOST_VERSION = '0.1.0';

// How long a confirm-tier prompt waits for a Yes/No before giving up and
// failing closed. Mirrors the Telegram adapter's CONFIRM_TIMEOUT_MS.
const CONFIRM_TIMEOUT_MS = 2 * 60_000;

// SSE event emitter for the currently-streaming chat request. Confirm prompts
// (mid-turn) and voice clips (post-turn) are pushed through it.
type ChatSink = (event: string, data: unknown) => void;

// Synthesized voice replies waiting to be fetched once by the browser. Kept in
// memory (clips are small OGGs) and dropped on first GET or after a TTL so a
// reload can't accumulate audio. Module-global because the GET that serves a
// clip is a different request than the chat stream that produced it.
interface VoiceClip {
  bytes: Buffer;
  mime: string;
  at: number;
}
const voiceClips = new Map<string, VoiceClip>();
const VOICE_CLIP_TTL_MS = 5 * 60_000;
function reapVoiceClips(): void {
  const cutoff = Date.now() - VOICE_CLIP_TTL_MS;
  for (const [id, clip] of voiceClips) if (clip.at < cutoff) voiceClips.delete(id);
}

export interface FrontendRunOptions {
  // The CLI entry script to re-exec when spawning `gurney` subcommands. Passed
  // down from src/cli/frontend.ts (process.argv[1]). Falls back to the built
  // CLI under the repo root.
  cliEntry?: string;
  // Forwarded to the re-exec so tsx-based dev runs keep their loader.
  execArgv?: string[];
}

// ---------------------------------------------------------------------------
// Small DB helper (open briefly, query, close). Mirrors src/cli/ext.ts.
// ---------------------------------------------------------------------------
function withDb<T>(fn: (db: DB) => T): T | null {
  const dbPath = join(homeDir(), 'gurney.db');
  if (!existsSync(dbPath)) return null;
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: dbPath, log });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function extensionsRoots(): [string, string] {
  return [join(homeDir(), 'extensions'), join(REPO_ROOT, 'extensions')];
}

// Read a single extension's persisted settings (key -> string value).
function readExtSettings(db: DB, ext: string): Map<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
    .all(ext) as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

function frontendSettings(): Record<string, string> {
  const out = withDb((db) => Object.fromEntries(readExtSettings(db, EXT_NAME)));
  return out ?? {};
}

// ---------------------------------------------------------------------------
// JSON / response helpers
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

// Collect a binary request body (e.g. a recorded voice note) into a Buffer.
function readRawBody(req: IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return '••••••';
  return `${token.slice(0, 8)}${'•'.repeat(18)}${token.slice(-4)}`;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// ---------------------------------------------------------------------------
// Spawn the gurney CLI for mutating actions, capturing its output.
// ---------------------------------------------------------------------------
function cliEntryPath(opts: FrontendRunOptions): string {
  if (opts.cliEntry && existsSync(opts.cliEntry)) return opts.cliEntry;
  const built = join(REPO_ROOT, 'dist', 'cli', 'index.js');
  if (existsSync(built)) return built;
  return join(REPO_ROOT, 'src', 'cli', 'index.ts');
}

function runGurney(
  opts: FrontendRunOptions,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveRun) => {
    const entry = cliEntryPath(opts);
    const child = spawn(process.execPath, [...(opts.execArgv ?? []), entry, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ code: -1, out, err: err + String(e) });
    });
  });
}

// ---------------------------------------------------------------------------
// Aggregated state for the hub + activity strip.
// ---------------------------------------------------------------------------
function agentRunning(): { running: boolean; pid: number | null } {
  const pid = readPid();
  return { running: pid !== null && isAlive(pid), pid };
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function envLocks(): Record<string, boolean> {
  const e = process.env;
  return {
    token: !!e['TELEGRAM_BOT_TOKEN']?.trim(),
    allowlist: !!e['TELEGRAM_ALLOWED_IDS']?.trim(),
    ollamaUrl: !!e['OLLAMA_URL']?.trim(),
    chatModel: !!e['GURNEY_CHAT_MODEL']?.trim(),
    reasonModel: !!e['GURNEY_REASON_MODEL']?.trim(),
    toolsModel: !!e['GURNEY_TOOLS_MODEL']?.trim(),
    tier: !!e['GURNEY_TIER']?.trim(),
    logLevel: !!e['GURNEY_LOG_LEVEL']?.trim(),
  };
}

function suggestTier(): { tier: GurneyConfig['tier']; ramGb: number } {
  const ramGb = totalmem() / 1024 ** 3;
  const tier: GurneyConfig['tier'] = ramGb <= 4 ? 'small' : ramGb >= 16 ? 'heavy' : 'standard';
  return { tier, ramGb };
}

async function buildState(): Promise<unknown> {
  const home = homeDir();
  let cfg: GurneyConfig | null = null;
  let cfgError: string | null = null;
  try {
    cfg = effectiveConfig(home);
  } catch (e) {
    cfgError = e instanceof Error ? e.message : String(e);
  }
  const { running, pid } = agentRunning();
  const probe = cfg ? await probeOllama(cfg.ollama.url) : { ok: false, models: [] };
  const readiness = withDb((db) => collectExtensionReadiness(extensionsRoots(), db)) ?? [];
  const enabledCount = readiness.filter((e) => e.enabled).length;
  const metrics = readMetrics(metricsFilePath(home));
  const { tier: suggestedTier, ramGb } = suggestTier();
  const fe = frontendSettings();

  return {
    configured: !!cfg && !!cfg.telegram.token && cfg.telegram.allowedIds.length > 0,
    cfgError,
    agent: { running, pid, starting: false },
    health: {
      ollama: probe.ok,
      ollamaUrl: cfg?.ollama.url ?? null,
      telegram: running, // long-poll is live only while the daemon runs
      modelCount: probe.models.length,
    },
    models: {
      chat: cfg?.models.chat ?? null,
      reason: cfg?.models.reason ?? null,
      tools: cfg?.models.tools ?? null,
      loaded: [cfg?.models.chat, cfg?.models.tools].filter(Boolean).length,
    },
    allowlistCount: cfg?.telegram.allowedIds.length ?? 0,
    tier: cfg?.tier ?? suggestedTier,
    suggestedTier,
    ramGb: Math.round(ramGb * 10) / 10,
    freeRamGb: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    logLevel: cfg?.logLevel ?? 'info',
    extensions: { installed: readiness.length, enabled: enabledCount },
    proactive: fe['proactive'] !== 'false',
    queueDepth: 0,
    scheduler: metrics
      ? { jobs: metrics.scheduler.jobsRegistered, nudgesSent: metrics.scheduler.nudgesSent }
      : null,
    version: VERSION,
    lan: lanAddress(),
  };
}

// ---------------------------------------------------------------------------
// Extensions listing (manifest + readiness + schema + current settings).
// ---------------------------------------------------------------------------
interface ExtView {
  name: string;
  version: string;
  description: string;
  source: 'user' | 'repo';
  installed: boolean;
  enabled: boolean;
  // True only for the panel extension itself — the UI renders it read-only
  // since you're using it right now.
  self: boolean;
  // Whether `gurney ext uninstall` can remove it. Bundled (repo) extensions
  // can only be disabled, not uninstalled.
  removable: boolean;
  // Whether the extension declares a setup entrypoint (native deps to bootstrap
  // when it's enabled).
  hasSetup: boolean;
  status: ExtensionReadiness['status'];
  reasons: string[];
  nextAction?: string;
  capabilities: string[];
  needsAuth: boolean;
  authConnected: boolean;
  deps: string[];
  tools: Array<{ name: string; desc: string }>;
  commands: Array<{ cmd: string; desc: string }>;
  jobs: string[];
  schema: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'secret' | 'enum';
    value: string | number | boolean;
    help?: string;
    options?: string[];
    required?: boolean;
  }>;
}

function readManifest(folder: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

function readSchema(folder: string): SettingsSchema | null {
  const p = join(folder, 'settings.schema.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SettingsSchema;
  } catch {
    return null;
  }
}

function schemaToFields(
  schema: SettingsSchema | null,
  current: Map<string, string>,
): ExtView['schema'] {
  if (!schema) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, decl]) => {
    const raw = current.get(key);
    const isSecret = decl.secret === true;
    const stored = raw !== undefined ? raw : decl.default;
    let value: string | number | boolean = stored ?? '';
    let type: ExtView['schema'][number]['type'] = decl.type;
    if (isSecret) {
      type = 'secret';
      value = raw ? maskToken(raw) : '';
    } else if (decl.type === 'boolean') {
      value = raw !== undefined ? raw === 'true' : decl.default === true;
    } else if (decl.type === 'number') {
      value = raw !== undefined ? Number(raw) : ((decl.default as number) ?? 0);
    }
    return {
      key,
      label: humanize(key),
      type,
      value,
      ...(decl.description ? { help: decl.description } : {}),
      required: required.has(key),
    };
  });
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function listExtensions(): ExtView[] {
  const readiness = withDb((db) => collectExtensionReadiness(extensionsRoots(), db)) ?? [];
  const settingsByExt =
    withDb((db) => {
      const map = new Map<string, Map<string, string>>();
      for (const r of readiness) map.set(r.name, readExtSettings(db, r.name));
      return map;
    }) ?? new Map<string, Map<string, string>>();

  return readiness
    .map((r) => {
      const manifest = readManifest(r.folder);
      const schema = readSchema(r.folder);
      const current = settingsByExt.get(r.name) ?? new Map<string, string>();
      const caps = manifest?.capabilities ?? [];
      const commands = (manifest?.telegram_commands ?? []).map((c) => ({
        cmd: `/${c.command}`,
        desc: c.description,
      }));
      const ep = manifest?.entrypoints ?? {};
      const needsAuth = !!ep.auth || caps.includes('auth:oauth');
      const tools: ExtView['tools'] = ep.tools
        ? [{ name: 'tools', desc: 'Adds AI-callable tools' }]
        : [];
      const jobs: string[] = ep.jobs ? ['Runs scheduled background jobs'] : [];
      const isSelf = r.name === EXT_NAME;
      return {
        name: r.name,
        version: r.version,
        description: manifest?.description ?? '',
        source: r.source,
        installed: true,
        // The panel is always "on" while you're looking at it.
        enabled: isSelf ? true : r.enabled,
        self: isSelf,
        removable: r.source === 'user' && !isSelf,
        hasSetup: !!ep.setup,
        status: r.status,
        reasons: r.reasons,
        ...(r.nextAction ? { nextAction: r.nextAction } : {}),
        capabilities: caps,
        needsAuth,
        authConnected: needsAuth && r.status !== 'needs_auth',
        deps: manifest?.deps ?? [],
        tools,
        commands,
        jobs,
        schema: schemaToFields(schema, current),
      } satisfies ExtView;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Core + extension Telegram command reference.
// ---------------------------------------------------------------------------
const CORE_COMMANDS = [
  { cmd: '/start', desc: 'Welcome message and quick how-to' },
  { cmd: '/help', desc: 'List all installed commands, grouped by extension' },
  { cmd: '/newchat', desc: 'Reset conversation context and start fresh' },
  { cmd: '/stop', desc: 'Cancel an in-flight reply' },
  { cmd: '/model', desc: 'Show the active model profiles (chat / reason / tools)' },
  { cmd: '/status', desc: 'Bot uptime, Ollama health, extensions, queue depth' },
  { cmd: '/lasterror', desc: 'Show the last orchestrator error for this chat' },
  { cmd: '/extensions', desc: 'List installed extensions and their state' },
  { cmd: '/devmode', desc: 'Append per-reply diagnostics to each response' },
  { cmd: '/setup', desc: 'Owner-only setup wizard inside Telegram' },
  { cmd: '/fresh', desc: 'Owner-only destructive fresh rebuild from Telegram' },
];

function commandReference(): { core: typeof CORE_COMMANDS; extensions: ExtView['commands'] } {
  const exts = listExtensions().filter((e) => e.enabled);
  const extension = exts.flatMap((e) => e.commands);
  return { core: CORE_COMMANDS, extensions: extension };
}

// ---------------------------------------------------------------------------
// Direct chat: route through the same orchestrator path Telegram uses. That
// gives the browser chat configured profile routing, extension tools, prompt
// fragments, conversation history, and the same hallucination guards.
// ---------------------------------------------------------------------------
interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  time: string;
  tool?: string;
}
const chatHistory: ChatMsg[] = [];

interface DirectChatRuntime {
  signature: string;
  chatId: number;
  userId: number;
  db: DB;
  llm: ReturnType<typeof createOllama>;
  loader: ExtensionLoader;
  scheduler: ReturnType<typeof createScheduler>;
  orchestrator: Orchestrator;
  log: ReturnType<typeof createLogger>;
  // SSE emitter for the in-flight chat request, or null when idle. The
  // confirm-tier tool gate and the voice sink push events through it.
  sink: { current: ChatSink | null };
  // Parked confirm-tier prompts keyed by id; resolved by POST /api/chat/confirm
  // (or fail-closed on timeout/abort/disconnect).
  pendingConfirms: Map<string, (ok: boolean) => void>;
}

let directChatRuntime: Promise<DirectChatRuntime> | null = null;
let directChatRuntimeValue: DirectChatRuntime | null = null;

function directChatSignature(cfg: GurneyConfig): string {
  return JSON.stringify({
    home: homeDir(),
    ollama: cfg.ollama.url,
    models: cfg.models,
    tier: cfg.tier ?? 'small',
    logLevel: cfg.logLevel ?? 'warn',
    allowedIds: cfg.telegram.allowedIds,
  });
}

function envInt(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function directChatIds(db: DB, cfg: GurneyConfig): { chatId: number; userId: number } {
  const fallback = cfg.telegram.allowedIds[0];
  if (fallback === undefined) throw new Error('No Telegram user IDs are allowlisted.');

  const placeholders = cfg.telegram.allowedIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT chat_id AS chatId, user_id AS userId
       FROM telegram_chats
       WHERE user_id IN (${placeholders})
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get(...cfg.telegram.allowedIds) as { chatId: number; userId: number } | undefined;
  return row ?? { chatId: fallback, userId: fallback };
}

async function closeDirectChatRuntime(): Promise<void> {
  const rt = directChatRuntimeValue;
  directChatRuntime = null;
  directChatRuntimeValue = null;
  if (!rt) return;
  try {
    rt.scheduler.stop();
  } catch {
    /* ignore */
  }
  try {
    await rt.loader.shutdown();
  } catch {
    /* ignore */
  }
  try {
    rt.llm.stopIdleEviction();
  } catch {
    /* ignore */
  }
  try {
    await rt.orchestrator.shutdown();
  } catch {
    /* ignore */
  }
  try {
    rt.db.close();
  } catch {
    /* ignore */
  }
}

async function getDirectChatRuntime(cfg: GurneyConfig): Promise<DirectChatRuntime> {
  const signature = directChatSignature(cfg);
  if (directChatRuntimeValue?.signature === signature) return directChatRuntimeValue;
  if (directChatRuntime) {
    const rt = await directChatRuntime;
    if (rt.signature === signature) return rt;
    await closeDirectChatRuntime();
  }

  directChatRuntime = (async () => {
    const home = homeDir();
    const log = createLogger({ level: cfg.logLevel ?? 'warn' });
    const db = openDb({ path: join(home, 'gurney.db'), log });
    const ids = directChatIds(db, cfg);
    const {
      profiles,
      budgetTokens,
      idleEvictionMs: tierIdleMs,
      toolResultMaxChars,
    } = profilesForTier(cfg.tier, cfg.models);
    const idleEvictionMs = envInt('GURNEY_HEAVY_IDLE_MS') ?? tierIdleMs;
    const inferenceTimeoutMs = envInt('GURNEY_INFERENCE_TIMEOUT_MS');

    const llm = createOllama({
      baseUrl: cfg.ollama.url,
      profiles,
      log,
      idleEvictionMs,
      ...(inferenceTimeoutMs !== undefined ? { inferenceTimeoutMs } : {}),
    });
    // Shared mutable state between the live chat stream and the tool/voice
    // hooks created below. `sink.current` is the SSE emitter while a chat
    // request is in flight (null when idle); pendingConfirms parks confirm-tier
    // prompts until the browser answers them.
    const sink: { current: ChatSink | null } = { current: null };
    const pendingConfirms = new Map<string, (ok: boolean) => void>();

    // Confirm-tier tool gate for the web UI — the parity of telegram.ts's
    // confirmToolCall. Pops a Yes/No prompt in the browser chat and resolves to
    // the user's choice. Fails closed when there's no live stream to ask in, the
    // turn was cancelled, or the user doesn't answer in time.
    const confirm = async (
      handler: ToolHandler,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<boolean> => {
      const emit = sink.current;
      if (!emit || ctx.signal?.aborted) return false;
      const id = randomUUID();
      let preview: string;
      try {
        preview = handler.confirmPrompt ? handler.confirmPrompt(args) : `Run ${handler.name}?`;
      } catch {
        preview = `Run ${handler.name}?`;
      }
      emit('confirm', { id, prompt: preview, tool: handler.name });
      return await new Promise<boolean>((resolveConfirm) => {
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          pendingConfirms.delete(id);
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolveConfirm(ok);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
        timer.unref?.();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        pendingConfirms.set(id, finish);
      });
    };

    const tools = createToolRegistry({
      log,
      confirm,
      isOwner: (ctx) => ctx.chatId === ids.chatId,
    });
    const prefs = createPrefsStore(db);
    const scheduler = createScheduler({
      log,
      dispatch: async (_nudge: Nudge) => {
        void _nudge;
      },
      prefs,
      db,
    });
    setupFollowups({ db, scheduler, tools, log });

    const stateRoot = join(home, 'extension_state');
    let orchestratorImpl: Orchestrator | null = null;
    const orchestratorBridge: HostOrchestrator = {
      handleUserMessage: async (msg) => {
        if (!orchestratorImpl) {
          await msg.send({ delta: '', done: true });
          return;
        }
        await orchestratorImpl.handleUserMessage(msg);
      },
    };
    const loader = createExtensionLoader({
      roots: extensionsRoots(),
      stateRoot,
      db,
      llm,
      log,
      scheduler,
      tools,
      hostVersion: HOST_VERSION,
      chatId: ids.chatId,
      allowedUserIds: cfg.telegram.allowedIds,
      watch: false,
      orchestrator: orchestratorBridge,
      // Voice replies (gurney-voice Piper TTS) land here via afterReply. Read
      // the synthesized OGG into memory, stash it for one-shot fetch, and tell
      // the browser to play it. No-op when no chat stream is live.
      sendVoice: async (_chatId: number, voice: VoicePayload) => {
        const emit = sink.current;
        if (!emit) return;
        let bytes: Buffer | null = voice.data ?? null;
        if (!bytes && voice.path) {
          try {
            bytes = readFileSync(voice.path);
          } catch (e) {
            log.warn('failed to read synthesized voice file', {
              error: e instanceof Error ? e.message : String(e),
            });
            return;
          }
        }
        if (!bytes || bytes.length === 0) return;
        reapVoiceClips();
        const id = randomUUID();
        voiceClips.set(id, { bytes, mime: 'audio/ogg', at: Date.now() });
        emit('voice', { id, mime: 'audio/ogg' });
      },
    });
    await loader.loadAll();

    const maxToolRounds = envInt('GURNEY_MAX_TOOL_ROUNDS');
    const orchestrator = createOrchestrator({
      db,
      llm,
      tools,
      log,
      promptFragmentProvider: (filter) => loader.promptFragment(filter),
      toolIntentFilter: (message) => loader.relevantExtensions(message),
      budgetTokens,
      toolResultMaxChars,
      ...(cfg.models.tools ? { toolProfile: 'tools' as const } : {}),
      ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
    });
    orchestratorImpl = orchestrator;

    const rt: DirectChatRuntime = {
      signature,
      chatId: ids.chatId,
      userId: ids.userId,
      db,
      llm,
      loader,
      scheduler,
      orchestrator,
      log,
      sink,
      pendingConfirms,
    };
    directChatRuntimeValue = rt;
    return rt;
  })();
  return directChatRuntime;
}

async function streamChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ text?: string }>(req);
  const text = (body.text ?? '').trim();
  if (!text) {
    sendJson(res, 400, { error: 'empty message' });
    return;
  }
  let cfg: GurneyConfig;
  try {
    cfg = effectiveConfig(homeDir());
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  chatHistory.push({ role: 'user', text, time: hhmm() });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const sse = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const runtime = await getDirectChatRuntime(cfg);
  // Route confirm prompts and voice clips emitted during this turn to this
  // request's SSE stream.
  runtime.sink.current = sse;
  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
    runtime.orchestrator.stop(runtime.chatId);
    // Fail closed: a disconnect mid-confirm must never leave a confirm-tier
    // tool waiting (and thus eligible to run) on a dead stream.
    for (const finish of [...runtime.pendingConfirms.values()]) finish(false);
  });

  // Mirror the Telegram adapter: run the registered intercept chain first so
  // extensions like gurney-instant-responses get a crack at the message before
  // the orchestrator does. An intercept that fully handles the turn (a trivial
  // or deterministic reply) sends its text via `reply` and never calls next(),
  // so the LLM never runs. One that just acks ("On it.") calls next() and we
  // fall through to the orchestrator. Each `reply` lands as its own chat bubble.
  let full = '';
  let orchestratorRan = false;
  let afterTurnBase: AfterTurnContext | undefined;

  const runOrchestrator = async (): Promise<void> => {
    orchestratorRan = true;
    await runtime.orchestrator.handleUserMessage({
      chatId: runtime.chatId,
      userId: runtime.userId,
      text,
      send: (chunk) => {
        if (controller.signal.aborted) return;
        if (chunk.delta) {
          full += chunk.delta;
          sse('delta', { delta: chunk.delta });
        }
        if (chunk.done && chunk.replace !== undefined) {
          full = chunk.replace;
          sse('replace', { text: full });
        }
        if (chunk.done && chunk.meta) {
          afterTurnBase = chunk.meta.afterTurn;
          sse('meta', {
            model: chunk.meta.model,
            elapsedMs: chunk.meta.elapsedMs,
            promptTokens: chunk.meta.promptTokens,
            completionTokens: chunk.meta.completionTokens,
            tools: chunk.meta.afterTurn?.toolCalls ?? [],
          });
        }
      },
    });
    chatHistory.push({ role: 'assistant', text: full, time: hhmm() });
  };

  const intercepts = runtime.loader.intercepts();
  let i = 0;
  const runNext = async (): Promise<void> => {
    const item = intercepts[i++];
    if (!item) {
      await runOrchestrator();
      return;
    }
    const ictx: TelegramInterceptContext = {
      chatId: runtime.chatId,
      userId: runtime.userId,
      text,
      args: text,
      reply: async (t) => {
        if (controller.signal.aborted) return;
        chatHistory.push({ role: 'assistant', text: t, time: hhmm() });
        sse('instant', { text: t });
      },
      next: runNext,
    };
    try {
      await item.handler(ictx);
    } catch (e) {
      runtime.log.warn('direct-chat intercept failed', {
        ext: item.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  try {
    await runNext();
    sse('done', { text: orchestratorRan ? full : '' });
    // Post-turn hooks, same as the Telegram adapter. afterReply is what drives
    // gurney-voice's spoken reply (its sendVoice lands on this still-open
    // stream as a `voice` event); afterTurn feeds learning/routine extensions.
    // Keep the stream open until they settle so the voice clip is delivered.
    if (orchestratorRan && full && !controller.signal.aborted) {
      await runAfterReplies(runtime, runtime.chatId, runtime.userId, full);
      if (afterTurnBase) {
        await runAfterTurns(runtime, {
          ...afterTurnBase,
          assistantText: full,
          finishedAt: Date.now(),
        });
      }
    }
  } catch (e) {
    sse('error', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    runtime.sink.current = null;
    res.end();
  }
}

// Run extension afterReply hooks (gurney-voice TTS, etc.) for a finished web
// chat turn. Errors are isolated so one extension can't abort the others.
async function runAfterReplies(
  runtime: DirectChatRuntime,
  chatId: number,
  userId: number,
  reply: string,
): Promise<void> {
  if (!reply || reply === '(no reply)') return;
  for (const h of runtime.loader.afterReplies()) {
    try {
      await h.handler({
        chatId,
        userId,
        text: reply,
        log: runtime.log.child({ ext: h.extension, hook: 'afterReply' }),
      });
    } catch (e) {
      runtime.log.warn('afterReply hook failed', {
        ext: h.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// Run rich afterTurn hooks (learning/routine extensions) for a finished turn.
async function runAfterTurns(runtime: DirectChatRuntime, turn: AfterTurnContext): Promise<void> {
  if (!turn.assistantText || turn.assistantText === '(no reply)') return;
  for (const h of runtime.loader.afterTurns()) {
    try {
      await h.handler(turn);
    } catch (e) {
      runtime.log.warn('afterTurn hook failed', {
        ext: h.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function hhmm(): string {
  return new Date().toTimeString().slice(0, 5);
}

// ---------------------------------------------------------------------------
// Command execution: the web parity of the Telegram adapter's slash-command
// dispatch. Core text commands are answered from local state; everything else
// is routed to an extension command handler (loader.commands()).
// ---------------------------------------------------------------------------
const CORE_TEXT_COMMANDS = new Set(['help', 'model', 'status', 'extensions', 'lasterror']);

async function coreCommandText(runtime: DirectChatRuntime, name: string): Promise<string> {
  switch (name) {
    case 'help': {
      const ref = commandReference();
      const lines = ['Core commands:', ...ref.core.map((c) => `${c.cmd} — ${c.desc}`)];
      if (ref.extensions.length > 0) {
        lines.push('', 'Extension commands:');
        for (const c of ref.extensions) lines.push(`${c.cmd}${c.desc ? ' — ' + c.desc : ''}`);
      }
      return lines.join('\n');
    }
    case 'model': {
      const profiles = runtime.llm.listProfiles();
      const lines = Object.entries(profiles).map(([n, cfg]) =>
        cfg ? `${n}: ${cfg.model} (ctx ${cfg.contextTokens})` : `${n}: (not configured)`,
      );
      return lines.join('\n') || 'No model profiles configured.';
    }
    case 'status': {
      const health = await runtime.llm.health();
      const exts = listExtensions().filter((e) => e.enabled);
      return [
        `llm: ${health.ok ? 'ok' : 'down'} (${health.models.length} models)`,
        `extensions: ${exts.length === 0 ? 'none' : exts.map((e) => e.name).join(', ')}`,
      ].join('\n');
    }
    case 'extensions': {
      const exts = listExtensions();
      if (exts.length === 0) return 'No extensions installed.';
      return [
        'Extensions:',
        ...exts.map((e) => `• ${e.name} — ${e.enabled ? e.status : 'disabled'}`),
      ].join('\n');
    }
    case 'lasterror': {
      const e = runtime.orchestrator.lastError(runtime.chatId);
      return e ? `Last error: ${e}` : 'No recent errors.';
    }
    default:
      return `Unknown command /${name}.`;
  }
}

async function runCommand(
  runtime: DirectChatRuntime,
  name: string,
  args: string,
): Promise<{ ok: boolean; replies?: string[]; error?: string }> {
  const lower = name.toLowerCase();
  if (CORE_TEXT_COMMANDS.has(lower)) {
    return { ok: true, replies: [await coreCommandText(runtime, lower)] };
  }
  const rec = runtime.loader.commands().find((c) => c.name === lower);
  if (!rec) return { ok: false, error: `/${name} is not a known command` };
  const replies: string[] = [];
  const cctx: TelegramCommandContext = {
    chatId: runtime.chatId,
    userId: runtime.userId,
    args,
    reply: async (t) => {
      replies.push(t);
    },
  };
  try {
    await rec.handler(cctx);
  } catch (e) {
    runtime.log.warn('extension command failed', {
      ext: rec.extension,
      command: lower,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, replies };
}

// Transcribe a recorded voice note via gurney-voice's onVoiceMessage handler,
// the web parity of telegram.ts's bot.on('message:voice'). Returns the
// transcript only — the browser then sends it as a normal chat turn, so a
// spoken reply (if /voice on) follows the same afterReply path.
async function voiceIn(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let cfg: GurneyConfig;
  try {
    cfg = effectiveConfig(homeDir());
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  const runtime = await getDirectChatRuntime(cfg);
  const handlers = runtime.loader.voiceMessages();
  if (handlers.length === 0) {
    return sendJson(res, 200, {
      ok: false,
      error: 'Voice transcription isn’t available — install and enable gurney-voice.',
    });
  }

  let bytes: Buffer;
  try {
    bytes = await readRawBody(req);
  } catch {
    return sendJson(res, 413, { ok: false, error: 'recording too large' });
  }
  if (bytes.length === 0) return sendJson(res, 400, { ok: false, error: 'empty recording' });

  const contentType = String(req.headers['content-type'] ?? '');
  const ms = Number(url.searchParams.get('ms'));
  const durationSec = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const fileExt = contentType.includes('ogg') ? '.ogg' : '.webm';
  const tmp = join(tmpdir(), `gurney-voicein-${randomUUID()}${fileExt}`);
  writeFileSync(tmp, bytes);

  const msg: TelegramVoiceMessage = {
    chatId: runtime.chatId,
    userId: runtime.userId,
    fileId: '',
    durationSec,
    ...(contentType ? { mimeType: contentType } : {}),
    log: runtime.log,
    downloadToFile: async (dest: string) => {
      copyFileSync(tmp, dest);
    },
  };

  let transcript: string | null = null;
  try {
    for (const h of handlers) {
      try {
        const r = await h.handler(msg);
        if (r && 'transcript' in r && r.transcript.trim().length > 0) {
          transcript = r.transcript.trim();
          break;
        }
      } catch (e) {
        runtime.log.warn('voice-in handler failed', {
          ext: h.extension,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  if (!transcript) {
    return sendJson(res, 200, {
      ok: false,
      error:
        'Couldn’t transcribe that. Make sure voice transcription is on (/voice transcribe on).',
    });
  }
  return sendJson(res, 200, { ok: true, transcript });
}

// ---------------------------------------------------------------------------
// Logs: tail the daemon log file, optionally follow via SSE.
// ---------------------------------------------------------------------------
function tailLines(file: string, max = 400): string[] {
  if (!existsSync(file)) return [];
  try {
    const txt = readFileSync(file, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

function streamLogs(req: IncomingMessage, res: ServerResponse): void {
  const file = logFilePath();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  let offset = 0;
  try {
    offset = existsSync(file) ? statSync(file).size : 0;
  } catch {
    offset = 0;
  }
  // Send the current tail first.
  for (const line of tailLines(file)) res.write(`data: ${JSON.stringify(line)}\n\n`);

  const tick = setInterval(() => {
    try {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < offset) offset = 0; // rotated/truncated
      if (size > offset) {
        const stream = createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' });
        let buf = '';
        stream.on('data', (c) => (buf += c));
        stream.on('end', () => {
          for (const line of buf.split('\n').filter(Boolean)) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
        });
        offset = size;
      }
    } catch {
      /* ignore transient read errors */
    }
  }, 1500);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(tick);
    clearInterval(keepAlive);
  });
}

// ---------------------------------------------------------------------------
// Interactive auth bridge.
//
// `gurney auth <ext>` runs an extension's OAuth/credential flow with terminal
// prompts. Those flows are just sequences of print()/prompt() over the
// AuthFlowIO, plus a callback server the flow binds itself. We run the exact
// same runner (runAuthForExt) here, but wire its io to the browser: print()
// lines stream out over SSE, and prompt() parks the flow until the user types
// an answer in the panel and POSTs it back. This gives the web UI the same
// auto-auth the CLI has, for Codex, Everyday Assistant, or any extension that
// declares an auth entrypoint.
// ---------------------------------------------------------------------------
interface AuthSseEvent {
  // Monotonic index so a reconnecting EventSource (which gets the whole buffer
  // replayed) can skip events it already processed instead of duplicating them.
  seq?: number;
  type: 'print' | 'prompt' | 'done' | 'error';
  line?: string;
  question?: string;
  secret?: boolean;
  message?: string;
}

interface AuthSession {
  id: string;
  ext: string;
  events: AuthSseEvent[]; // replay buffer for late/reconnecting subscribers
  pending: { resolve: (value: string) => void; reject: (e: Error) => void } | null;
  subscribers: Set<(e: AuthSseEvent) => void>;
  finished: boolean;
  db: DB;
}

const authSessions = new Map<string, AuthSession>();

function pushAuthEvent(session: AuthSession, evt: AuthSseEvent): void {
  evt.seq = session.events.length;
  session.events.push(evt);
  for (const sub of session.subscribers) {
    try {
      sub(evt);
    } catch {
      /* a dead subscriber must not break the others */
    }
  }
}

function closeAuthSession(session: AuthSession): void {
  if (session.pending) {
    try {
      session.pending.reject(new Error('auth session closed'));
    } catch {
      /* ignore */
    }
    session.pending = null;
  }
  try {
    session.db.close();
  } catch {
    /* ignore */
  }
  authSessions.delete(session.id);
}

function startAuthSession(
  name: string,
): { ok: true; session: string } | { ok: false; error: string } {
  const home = homeDir();
  const ext = discoverExt(home, name);
  if (!ext) return { ok: false, error: `extension '${name}' not found` };
  if (!ext.manifest.entrypoints?.auth) {
    return { ok: false, error: `'${name}' does not have an auth flow` };
  }

  // Only one live auth session per extension — replace any stale one.
  for (const s of authSessions.values()) {
    if (s.ext === name && !s.finished) closeAuthSession(s);
  }

  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'gurney.db'), log });
  const session: AuthSession = {
    id: randomUUID(),
    ext: name,
    events: [],
    pending: null,
    subscribers: new Set(),
    finished: false,
    db,
  };
  authSessions.set(session.id, session);

  const io: AuthRunnerIO = {
    print: (line) => pushAuthEvent(session, { type: 'print', line }),
    announce: (line) => pushAuthEvent(session, { type: 'print', line }),
    prompt: (question, opts) =>
      new Promise<string>((resolve, reject) => {
        session.pending = { resolve, reject };
        pushAuthEvent(session, { type: 'prompt', question, secret: !!opts?.secret });
      }),
  };

  void runAuthForExt(ext, db, io)
    .then(async () => {
      await closeDirectChatRuntime();
      pushAuthEvent(session, { type: 'done' });
    })
    .catch((e: unknown) =>
      pushAuthEvent(session, {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      }),
    )
    .finally(() => {
      session.finished = true;
      session.pending = null;
      try {
        db.close();
      } catch {
        /* ignore */
      }
      // Keep the finished session around briefly so the SSE delivers the final
      // event to whoever is watching, then drop it.
      setTimeout(() => authSessions.delete(session.id), 60_000).unref();
    });

  return { ok: true, session: session.id };
}

function answerAuthSession(id: string, value: string): boolean {
  const session = authSessions.get(id);
  if (!session || !session.pending) return false;
  const { resolve } = session.pending;
  session.pending = null;
  resolve(value);
  return true;
}

function streamAuthSession(req: IncomingMessage, res: ServerResponse, id: string): void {
  const session = authSessions.get(id);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  if (!session) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'auth session expired' })}\n\n`);
    res.end();
    return;
  }
  const send = (evt: AuthSseEvent): void => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  // Replay everything so far (a prompt or the final result may predate this
  // connection), then subscribe to live events.
  for (const evt of session.events) send(evt);
  session.subscribers.add(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    session.subscribers.delete(send);
  });
}

// ---------------------------------------------------------------------------
// Static file serving from ./web
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/babel; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback to index.html for unknown non-asset routes.
    const index = join(WEB_DIR, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
function requestToken(req: IncomingMessage, url: URL): string {
  return (req.headers['x-gurney-token'] as string) ?? url.searchParams.get('token') ?? '';
}

async function handleApi(
  opts: FrontendRunOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  try {
    if (path === '/api/state' && method === 'GET') {
      return sendJson(res, 200, await buildState());
    }

    if (path === '/api/config' && method === 'GET') {
      const cfg = effectiveConfig(homeDir());
      return sendJson(res, 200, {
        token: maskToken(cfg.telegram.token),
        hasToken: !!cfg.telegram.token,
        allowlist: cfg.telegram.allowedIds.map(String),
        ollamaUrl: cfg.ollama.url,
        chatModel: cfg.models.chat,
        reasoningModel: cfg.models.reason ?? '',
        toolsModel: cfg.models.tools ?? '',
        tier: cfg.tier ?? suggestTier().tier,
        logLevel: cfg.logLevel ?? 'info',
        envLocks: envLocks(),
      });
    }

    if (path === '/api/config' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      return saveCoreConfig(res, body);
    }

    if (path === '/api/ollama/test' && method === 'POST') {
      const { url: ollamaUrl } = await readJson<{ url?: string }>(req);
      const target = ollamaUrl?.trim() || effectiveConfig(homeDir()).ollama.url;
      try {
        validateOllamaUrl(target);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: (e as Error).message });
      }
      const probe = await probeOllama(target);
      return sendJson(res, 200, probe);
    }

    if (path === '/api/models' && method === 'GET') {
      const probe = await probeOllama(effectiveConfig(homeDir()).ollama.url);
      return sendJson(res, 200, probe);
    }

    if (path === '/api/telegram/validate' && method === 'POST') {
      const { token } = await readJson<{ token?: string }>(req);
      return validateTelegram(res, token ?? '');
    }

    if (path === '/api/doctor' && method === 'GET') {
      const checks = await collectDoctorChecks();
      return sendJson(res, 200, {
        checks: checks.map((c) => ({
          id: c.name,
          label: humanize(c.name),
          status: c.ok ? 'pass' : 'fail',
          detail: c.msg,
        })),
      });
    }

    if (path === '/api/extensions' && method === 'GET') {
      return sendJson(res, 200, { extensions: listExtensions() });
    }

    const extAction =
      /^\/api\/extensions\/([a-z0-9._-]+)\/(enable|disable|install|uninstall|settings|setup)$/i.exec(
        path,
      );
    if (extAction) {
      const name = extAction[1]!;
      const action = extAction[2]!;
      if (action === 'settings' && method === 'GET') {
        return getExtSettings(res, name);
      }
      if (action === 'settings' && method === 'POST') {
        return saveExtSettings(res, name, await readJson<Record<string, unknown>>(req));
      }
      if (action === 'setup' && method === 'POST') {
        const r = await runExtSetup(name);
        return sendJson(res, r.ok ? 200 : 500, r);
      }
      if (method === 'POST') {
        const args =
          action === 'uninstall'
            ? ['ext', 'uninstall', name, ...(url.searchParams.get('purge') ? ['--purge'] : [])]
            : ['ext', action, name];
        const r = await runGurney(opts, args);
        // Enabling an extension should also bootstrap its native dependencies,
        // mirroring `gurney init`'s post-selection setup. Best-effort: a failed
        // setup doesn't undo the enable (the user can retry from settings).
        let setupOutput = '';
        if (r.code === 0 && action === 'enable') {
          try {
            const s = await runExtSetup(name);
            setupOutput = s.output;
          } catch (e) {
            setupOutput = e instanceof Error ? e.message : String(e);
          }
        }
        return sendJson(res, r.code === 0 ? 200 : 500, {
          ok: r.code === 0,
          output: r.out + r.err + setupOutput,
        });
      }
    }

    const authAction =
      /^\/api\/extensions\/([a-z0-9._-]+)\/auth\/(start|stream|answer|cancel)$/i.exec(path);
    if (authAction) {
      const name = authAction[1]!;
      const action = authAction[2]!;
      if (action === 'start' && method === 'POST') {
        const r = startAuthSession(name);
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      if (action === 'stream' && method === 'GET') {
        return streamAuthSession(req, res, url.searchParams.get('session') ?? '');
      }
      if (action === 'answer' && method === 'POST') {
        const { session, value } = await readJson<{ session?: string; value?: string }>(req);
        const ok = answerAuthSession(session ?? '', value ?? '');
        return sendJson(res, ok ? 200 : 409, {
          ok,
          ...(ok ? {} : { error: 'no question is waiting for an answer' }),
        });
      }
      if (action === 'cancel' && method === 'POST') {
        const { session } = await readJson<{ session?: string }>(req);
        const s = session ? authSessions.get(session) : undefined;
        if (s) closeAuthSession(s);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (path === '/api/commands' && method === 'GET') {
      return sendJson(res, 200, commandReference());
    }

    // Run a core text command or an extension command (the codex buttons, etc.).
    if (path === '/api/command' && method === 'POST') {
      const { name, args } = await readJson<{ name?: string; args?: string }>(req);
      if (!name || !name.trim()) return sendJson(res, 400, { ok: false, error: 'missing command' });
      const cfg = effectiveConfig(homeDir());
      const runtime = await getDirectChatRuntime(cfg);
      const r = await runCommand(runtime, name.trim(), (args ?? '').trim());
      return sendJson(res, r.ok ? 200 : r.error?.includes('not a known') ? 404 : 500, r);
    }

    if (path === '/api/chat' && method === 'POST') {
      return streamChat(req, res);
    }

    // Resolve a parked confirm-tier prompt (fail-closed everywhere else).
    if (path === '/api/chat/confirm' && method === 'POST') {
      const { id, ok } = await readJson<{ id?: string; ok?: boolean }>(req);
      const rt = directChatRuntimeValue;
      const finish = rt && id ? rt.pendingConfirms.get(id) : undefined;
      if (!finish) {
        return sendJson(res, 409, { ok: false, error: 'no confirmation is waiting' });
      }
      finish(!!ok);
      return sendJson(res, 200, { ok: true });
    }

    // Transcribe a recorded voice note (gurney-voice / whisper.cpp).
    if (path === '/api/chat/voice-in' && method === 'POST') {
      return voiceIn(req, res, url);
    }

    // Serve a synthesized voice reply once, then drop it.
    const voiceServe = /^\/api\/chat\/voice\/([a-f0-9-]+)$/i.exec(path);
    if (voiceServe && method === 'GET') {
      const clip = voiceClips.get(voiceServe[1]!);
      if (!clip) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      voiceClips.delete(voiceServe[1]!);
      res.writeHead(200, {
        'content-type': clip.mime,
        'content-length': String(clip.bytes.length),
        'cache-control': 'no-store',
      });
      res.end(clip.bytes);
      return;
    }

    if (path === '/api/chat/clear' && method === 'POST') {
      chatHistory.length = 0;
      directChatRuntimeValue?.orchestrator.newChat(directChatRuntimeValue.chatId);
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/logs/stream' && method === 'GET') {
      return streamLogs(req, res);
    }

    if (path === '/api/agent/start' && method === 'POST') {
      const r = await runGurney(opts, ['start', '--detach'], 30_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }
    if (path === '/api/agent/stop' && method === 'POST') {
      const r = await runGurney(opts, ['stop'], 30_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }
    if (path === '/api/agent/restart' && method === 'POST') {
      await runGurney(opts, ['stop'], 30_000);
      const r = await runGurney(opts, ['start', '--detach'], 30_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }
    if (path === '/api/agent/proactive' && method === 'POST') {
      const { on } = await readJson<{ on?: boolean }>(req);
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO extension_settings (extension, key, value, updated_at)
             VALUES (?, 'proactive', ?, ?)
             ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(EXT_NAME, on ? 'true' : 'false', Date.now()),
      );
      return sendJson(res, 200, { ok: true, proactive: !!on });
    }

    if (path === '/api/maintenance/update' && method === 'POST') {
      const r = await runGurney(opts, ['update'], 600_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }

    return sendJson(res, 404, { error: `no route for ${method} ${path}` });
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

function saveCoreConfig(res: ServerResponse, body: Record<string, unknown>): void {
  const home = homeDir();
  const current = loadConfig(home);
  const next: GurneyConfig = JSON.parse(JSON.stringify(current)) as GurneyConfig;

  if (typeof body['token'] === 'string' && body['token'] && !body['token'].includes('•')) {
    next.telegram.token = body['token'];
  }
  if (Array.isArray(body['allowlist'])) {
    next.telegram.allowedIds = (body['allowlist'] as unknown[])
      .map((v) => Number.parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof body['ollamaUrl'] === 'string' && body['ollamaUrl']) {
    try {
      validateOllamaUrl(body['ollamaUrl']);
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
    next.ollama.url = body['ollamaUrl'];
  }
  if (typeof body['chatModel'] === 'string' && body['chatModel'])
    next.models.chat = body['chatModel'];
  if (typeof body['reasoningModel'] === 'string') {
    if (body['reasoningModel']) next.models.reason = body['reasoningModel'];
    else delete next.models.reason;
  }
  if (typeof body['toolsModel'] === 'string') {
    if (body['toolsModel']) next.models.tools = body['toolsModel'];
    else delete next.models.tools;
  }
  if (typeof body['tier'] === 'string' && ['small', 'standard', 'heavy'].includes(body['tier'])) {
    next.tier = body['tier'] as GurneyConfig['tier'];
  }
  if (
    typeof body['logLevel'] === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(body['logLevel'])
  ) {
    next.logLevel = body['logLevel'] as GurneyConfig['logLevel'];
  }

  saveConfig(next, home);
  sendJson(res, 200, { ok: true });
}

async function validateTelegram(res: ServerResponse, token: string): Promise<void> {
  const t = token.trim();
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(t)) {
    return sendJson(res, 200, { ok: false, error: 'Token has an invalid shape.' });
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/getMe`);
    const j = (await r.json()) as {
      ok?: boolean;
      result?: { first_name?: string; username?: string };
    };
    if (!j.ok || !j.result)
      return sendJson(res, 200, { ok: false, error: 'getMe returned ok=false' });
    return sendJson(res, 200, {
      ok: true,
      botName: j.result.first_name ?? 'Gurney',
      botUser: j.result.username ? `@${j.result.username}` : '',
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// Run an extension's `setup` entrypoint (native-dependency bootstrap) the same
// way `gurney init` does after the user picks extensions, but non-interactively
// so it can never block on a terminal prompt. No-ops for extensions without a
// setup entrypoint. Used when an extension is enabled from the panel/wizard.
async function runExtSetup(name: string): Promise<{ ok: boolean; output: string }> {
  let folder: string | null = null;
  for (const root of extensionsRoots()) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'manifest.json'))) {
      folder = candidate;
      break;
    }
  }
  if (!folder) return { ok: false, output: `extension '${name}' not found` };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
  if (!manifest.entrypoints?.setup) return { ok: true, output: '' };
  const home = homeDir();
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'gurney.db'), log });
  let captured = '';
  try {
    await configureNativeDepsForExtension({ name, folder, manifest }, db, home, {
      interactive: false,
      stdout: (text) => {
        captured += text;
      },
    });
    return { ok: true, output: captured };
  } catch (e) {
    return { ok: false, output: captured + (e instanceof Error ? e.message : String(e)) };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function getExtSettings(res: ServerResponse, name: string): void {
  const roots = extensionsRoots();
  let folder: string | null = null;
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'manifest.json'))) {
      folder = candidate;
      break;
    }
  }
  if (!folder) return sendJson(res, 404, { error: `extension '${name}' not found` });
  const schema = readSchema(folder);
  const current = withDb((db) => readExtSettings(db, name)) ?? new Map<string, string>();
  sendJson(res, 200, { name, schema: schemaToFields(schema, current) });
}

function saveExtSettings(res: ServerResponse, name: string, body: Record<string, unknown>): void {
  const roots = extensionsRoots();
  let folder: string | null = null;
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'manifest.json'))) {
      folder = candidate;
      break;
    }
  }
  if (!folder) return sendJson(res, 404, { error: `extension '${name}' not found` });
  const schema = readSchema(folder);
  if (!schema) return sendJson(res, 400, { error: 'extension has no settings schema' });

  const ok = withDb((db) => {
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [key, decl] of Object.entries(schema.properties)) {
      if (!(key in body)) continue;
      const raw = body[key];
      // Never overwrite a stored secret with its masked placeholder.
      if (decl.secret && typeof raw === 'string' && raw.includes('•')) continue;
      let value: string;
      if (decl.type === 'boolean') value = raw ? 'true' : 'false';
      else value = String(raw ?? '');
      stmt.run(name, key, value, now);
    }
    return true;
  });
  if (ok === null)
    return sendJson(res, 500, { error: 'database not initialized — run gurney init' });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
export async function run(opts: FrontendRunOptions = {}): Promise<Server> {
  const fe = frontendSettings();
  const host = fe['listen_host'] || '127.0.0.1';
  const port = Number(fe['listen_port']) || 7777;
  const authToken = fe['auth_token'] || '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      // Auth gate: when a token is configured, require it for the API unless
      // the request comes from loopback (the operator on this machine).
      if (authToken && !isLoopback(req) && requestToken(req, url) !== authToken) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      void handleApi(opts, req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // A stale/orphaned panel often holds the port without being tracked in
        // frontend.pid, so `gurney frontend stop` can't see it. Tell the user
        // how to find and free it rather than surfacing the raw errno.
        reject(
          new Error(
            `port ${port} on ${host} is already in use — another gurney-frontend may be running.\n` +
              `  Find it:  lsof -i :${port}\n` +
              `  Free it:  fuser -k ${port}/tcp   (or kill the PID it shows)\n` +
              `  Then retry: gurney frontend`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, host, () => resolveListen());
  });

  const shown = host === '0.0.0.0' ? (lanAddress() ?? 'localhost') : host;
  const tokenQs = authToken ? `?token=${authToken}` : '';
  process.stdout.write(
    `gurney-frontend listening on http://${shown}:${port}\n` +
      `  Open: http://${shown}:${port}/${tokenQs}\n` +
      `  Stop with Ctrl-C.\n`,
  );

  const shutdown = (): void => {
    for (const session of [...authSessions.values()]) closeAuthSession(session);
    void closeDirectChatRuntime().finally(() => {
      server.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
