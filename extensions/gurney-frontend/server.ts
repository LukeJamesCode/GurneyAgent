// gurney-frontend HTTP server.
//
// Runs as its OWN process (launched by `gurney start`, which spawns the
// internal `gurney __panel` entry as a sibling — see src/cli/panel.ts), not
// inside the agent daemon. That separation is deliberate: the panel's
// Start/Stop buttons control the daemon (`gurney start --detach` / `gurney
// stop --agent-only`), and if the server lived inside the daemon then "Stop"
// would also kill the UI you were clicking it from.
//
// It serves the static browser UI from ./web and a small JSON API under /api
// that reuses the same core helpers the CLI does (effectiveConfig, probeOllama,
// collectDoctorChecks, collectExtensionReadiness, the SQLite settings store)
// and shells out to the `gurney` CLI for actions that have to mutate the
// install (start/stop, ext install/enable/disable/uninstall).

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { freemem, networkInterfaces, tmpdir, totalmem } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { open as openDb, type DB } from '../../src/storage/db.js';
import {
  createAgentRegistry,
  type AgentExecutionMode,
  type CreateAgentInput,
} from '../../src/core/agents.js';
import type { ProfileName } from '../../src/core/llm.js';
import { createLogger } from '../../src/util/log.js';
import { createOllama } from '../../src/core/llm.js';
import { createRoutedLLM } from '../../src/core/llm-router.js';
import { createOrchestrator, type Orchestrator } from '../../src/core/orchestrator.js';
import { createToolRegistry, type ToolContext, type ToolHandler } from '../../src/core/tools.js';
import { createScheduler, type Nudge } from '../../src/core/scheduler.js';
import { createPrefsStore, formatWindow } from '../../src/core/prefs.js';
import { parseCron, nextFireAfter } from '../../src/core/cron.js';
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
import { availableModelTags } from '../../src/cli/model-options.js';
import { collectDoctorChecks } from '../../src/cli/doctor.js';
import { configureNativeDepsForExtension } from '../../src/cli/ext-setup.js';
import { discover as discoverExt, runAuthForExt, type AuthRunnerIO } from '../../src/cli/auth.js';
import {
  collectExtensionReadiness,
  type ExtensionReadiness,
} from '../../src/core/extension-readiness.js';
import { readMetrics } from '../../src/core/metrics.js';
import {
  ensurePrivateDir,
  ensurePrivateFile,
  effectiveConfig,
  homeDir,
  loadConfig,
  saveConfig,
  validateOllamaUrl,
  type GurneyConfig,
} from '../../src/cli/config-store.js';
import {
  frontendPidFilePath,
  isAlive,
  logFilePath,
  metricsFilePath,
  readPid,
} from '../../src/cli/daemon.js';
import type { Manifest, SettingsSchema } from '../../src/core/extensions.js';
import * as tudor from '../gurney-tudor/lib/service.js';

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
// Agent command center — request normalization
// ---------------------------------------------------------------------------
const AGENT_PROFILES: readonly ProfileName[] = ['chat', 'reason', 'tools'];

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Map an untrusted JSON body from the panel into a validated CreateAgentInput.
// toolAllowlist === null means "all tools"; an array is an explicit allowlist
// of extension and/or tool names.
function normalizeAgentInput(body: Record<string, unknown>): CreateAgentInput {
  const profile = AGENT_PROFILES.includes(body['profile'] as ProfileName)
    ? (body['profile'] as ProfileName)
    : 'chat';
  const executionMode: AgentExecutionMode =
    body['executionMode'] === 'parallel' ? 'parallel' : 'sequential';
  const allow = body['toolAllowlist'];
  const toolAllowlist: string[] | null = Array.isArray(allow)
    ? allow.map((s) => String(s).trim()).filter(Boolean)
    : null;
  const delegatableAgents = Array.isArray(body['delegatableAgents'])
    ? body['delegatableAgents'].map((s) => String(s).trim()).filter(Boolean)
    : [];
  const rawBudget = body['budgetTokens'];
  return {
    name: String(body['name'] ?? '').trim(),
    role: String(body['role'] ?? '').trim(),
    systemPrompt: String(body['systemPrompt'] ?? '').trim(),
    profile,
    toolAllowlist,
    maxToolRounds: clampInt(body['maxToolRounds'], 1, 12, 4),
    budgetTokens: rawBudget === null || rawBudget === undefined || rawBudget === ''
      ? null
      : clampInt(rawBudget, 256, 32768, 4096),
    executionMode,
    maxConcurrency: clampInt(body['maxConcurrency'], 1, 8, 1),
    canDelegate: !!body['canDelegate'],
    delegatableAgents,
  };
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

// Streaming variant: pipes the child's stdout/stderr to `onChunk` as it arrives
// instead of buffering the whole thing. Used by the wizard's voice-setup modal,
// where the downloads take long enough that the user needs to see progress (a
// 150 MB whisper model on a Pi otherwise looks like a hang).
function runGurneyStreaming(
  opts: FrontendRunOptions,
  args: string[],
  onChunk: (text: string) => void,
  timeoutMs = 600_000,
): Promise<{ code: number }> {
  return new Promise((resolveRun) => {
    const entry = cliEntryPath(opts);
    const child = spawn(process.execPath, [...(opts.execArgv ?? []), entry, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();
    const safeChunk = (d: Buffer): void => {
      try {
        onChunk(d.toString('utf8'));
      } catch {
        /* a dead SSE client must not kill the child */
      }
    };
    child.stdout.on('data', safeChunk);
    child.stderr.on('data', safeChunk);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      try {
        onChunk(String(e));
      } catch {
        /* ignore */
      }
      resolveRun({ code: -1 });
    });
  });
}

type SystemCommandName = 'status' | 'doctor' | 'logs' | 'commands';

const SYSTEM_COMMANDS: Record<SystemCommandName, { args: string[]; timeoutMs: number }> = {
  status: { args: ['status'], timeoutMs: 30_000 },
  doctor: { args: ['doctor'], timeoutMs: 60_000 },
  logs: { args: ['logs'], timeoutMs: 30_000 },
  commands: { args: ['--help'], timeoutMs: 30_000 },
};

function formatGurneyCommand(args: readonly string[]): string {
  return ['gurney', ...args].join(' ');
}

async function runSystemCommand(
  opts: FrontendRunOptions,
  name: SystemCommandName,
): Promise<{ ok: boolean; code: number; command: string; output: string }> {
  const spec = SYSTEM_COMMANDS[name];
  const r = await runGurney(opts, spec.args, spec.timeoutMs);
  return {
    ok: r.code === 0,
    code: r.code,
    command: formatGurneyCommand(spec.args),
    output: (r.out + r.err).trimEnd(),
  };
}

function restorePanelPidfileAfterFresh(): void {
  const home = homeDir();
  const file = frontendPidFilePath(home);
  ensurePrivateDir(dirname(file));
  writeFileSync(file, String(process.pid), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(file);
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
  const enabledList = readiness.filter((e) => e.enabled);
  const enabledCount = enabledList.length;
  const enabledNames = enabledList.map((e) => e.name);
  // Enabled extensions whose readiness check is failing — typically missing
  // auth (e.g. codex) or required settings (e.g. gurney-everyday-assistant).
  // Surfaced as a badge on the Extensions nav so first-run users know to
  // finish setup.
  const needsSetup = enabledList
    .filter((e) => e.status === 'needs_auth' || e.status === 'needs_settings')
    .map((e) => ({ name: e.name, status: e.status, nextAction: e.nextAction }));
  const metrics = readMetrics(metricsFilePath(home));
  const { tier: suggestedTier, ramGb } = suggestTier();
  const fe = frontendSettings();

  // Real daemon activity, sourced from the metrics snapshot the daemon writes
  // under ~/.gurney/ every ~60s (see src/core/metrics.ts). The panel runs in a
  // separate process and can't read the daemon's live counters, so this file is
  // the only honest window into what the background loop is doing. `metricsAt`
  // lets the UI mark the data stale when the daemon stops writing.
  const sched = metrics?.scheduler;
  const activity = metrics
    ? {
        startedAt: metrics.startedAt,
        metricsAt: metrics.updatedAt,
        uptimeMs: metrics.uptimeMs,
        lastTickAt: sched?.lastTickAt ?? null,
        ticks: sched?.ticks ?? 0,
        nudgesSent: sched?.nudgesSent ?? 0,
        nudgesDropped: sched ? Object.values(sched.nudgesDropped).reduce((a, b) => a + b, 0) : 0,
        cacheHits: sched?.cache?.hits ?? 0,
        cacheMisses: sched?.cache?.misses ?? 0,
      }
    : null;

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
    extensions: {
      installed: readiness.length,
      enabled: enabledCount,
      enabledNames,
      needsSetup,
    },
    proactive: fe['proactive'] !== 'false',
    queueDepth: 0,
    scheduler: metrics
      ? { jobs: metrics.scheduler.jobsRegistered, nudgesSent: metrics.scheduler.nudgesSent }
      : null,
    activity,
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

    const llm = createRoutedLLM(
      createOllama({
        baseUrl: cfg.ollama.url,
        profiles,
        log,
        idleEvictionMs,
        ...(inferenceTimeoutMs !== undefined ? { inferenceTimeoutMs } : {}),
      }),
    );
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
  const instantReplies: string[] = [];

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
        instantReplies.push(t);
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
    if (!controller.signal.aborted) {
      if (!orchestratorRan && instantReplies.length > 0) {
        // Instant-only turn (intercept handled it fully) — speak the reply.
        await runAfterReplies(runtime, runtime.chatId, runtime.userId, instantReplies.join('\n'));
      } else if (orchestratorRan && full) {
        await runAfterReplies(runtime, runtime.chatId, runtime.userId, full);
        if (afterTurnBase) {
          await runAfterTurns(runtime, {
            ...afterTurnBase,
            assistantText: full,
            finishedAt: Date.now(),
          });
        }
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
// Scheduler timeline: the registered cron jobs and the next time each fires,
// plus the owner chat's proactive state (quiet window / snooze).
//
// Jobs are only discoverable once extensions have registered them, so this
// reuses the direct-chat runtime (which has already run loader.loadAll()). The
// panel's own scheduler is never started — the daemon is what actually fires
// these — so this is a read-only projection. Next-fire is computed with the
// same parseCron/nextFireAfter the scheduler uses, in the process-local TZ
// (the default for jobs that don't override timeZone).
// ---------------------------------------------------------------------------
interface SchedulerView {
  configured: boolean;
  proactive?: boolean;
  nowMs?: number;
  jobs?: Array<{ extension: string; name: string; cron: string; nextFireMs: number | null }>;
  quietWindow?: string | null;
  pausedUntilMs?: number | null;
  quiet?: { quiet: boolean; reason: string | null; until: number | null };
}

async function schedulerView(): Promise<SchedulerView> {
  let cfg: GurneyConfig;
  try {
    cfg = effectiveConfig(homeDir());
  } catch {
    return { configured: false };
  }
  if (cfg.telegram.allowedIds.length === 0) return { configured: false };

  const runtime = await getDirectChatRuntime(cfg);
  const now = new Date();
  const jobs = runtime.scheduler
    .list()
    .map((j) => {
      let nextFireMs: number | null = null;
      try {
        nextFireMs = nextFireAfter(parseCron(j.cron), now).getTime();
      } catch {
        nextFireMs = null; // unparseable cron — surface the job without a time
      }
      return { extension: j.extension, name: j.name, cron: j.cron, nextFireMs };
    })
    .sort((a, b) => (a.nextFireMs ?? Infinity) - (b.nextFireMs ?? Infinity));

  const prefs = createPrefsStore(runtime.db);
  const p = prefs.get(runtime.chatId);
  const q = prefs.isQuiet(runtime.chatId, now);
  const fe = frontendSettings();
  return {
    configured: true,
    proactive: fe['proactive'] !== 'false',
    nowMs: now.getTime(),
    jobs,
    quietWindow: formatWindow(p.quietStartMinute, p.quietEndMinute),
    pausedUntilMs: p.pausedUntilMs,
    quiet: { quiet: q.quiet, reason: q.reason ?? null, until: q.until ?? null },
  };
}

// Snooze (or clear) proactive nudges for the owner chat. `ms` is a duration
// from now; 0/absent clears the snooze. The daemon reads chat_prefs on every
// dispatch, so this takes effect immediately without restarting the agent.
async function snoozeProactive(ms: number): Promise<{ ok: boolean; pausedUntilMs: number | null }> {
  const cfg = effectiveConfig(homeDir());
  const runtime = await getDirectChatRuntime(cfg);
  const prefs = createPrefsStore(runtime.db);
  const until = ms && ms > 0 ? Date.now() + ms : null;
  prefs.setPausedUntil(runtime.chatId, until);
  return { ok: true, pausedUntilMs: until };
}

// ---------------------------------------------------------------------------
// Metrics dashboard payload. Reads the daemon's metrics snapshot (cumulative
// counters only — there is no per-turn token/latency series in core, so the
// dashboard derives its trends by sampling this endpoint over time in the
// browser). RAM is read live from the OS here, not from the snapshot.
// ---------------------------------------------------------------------------
function metricsView(): unknown {
  const metrics = readMetrics(metricsFilePath(homeDir()));
  const { running } = agentRunning();
  const totalGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const freeGb = Math.round((freemem() / 1024 ** 3) * 10) / 10;
  if (!metrics) {
    return { hasMetrics: false, agentRunning: running, ram: { totalGb, freeGb } };
  }
  const s = metrics.scheduler;
  const hits = s.cache?.hits ?? 0;
  const misses = s.cache?.misses ?? 0;
  const total = hits + misses;
  return {
    hasMetrics: true,
    agentRunning: running,
    startedAt: metrics.startedAt,
    metricsAt: metrics.updatedAt,
    uptimeMs: metrics.uptimeMs,
    scheduler: {
      jobsRegistered: s.jobsRegistered,
      ticks: s.ticks,
      lastTickAt: s.lastTickAt,
      nudgesSent: s.nudgesSent,
      nudgesDropped: s.nudgesDropped,
    },
    cache: {
      hits,
      misses,
      size: s.cache?.size ?? 0,
      hitRate: total > 0 ? Math.round((hits / total) * 100) : null,
    },
    ram: { totalGb, freeGb },
  };
}

// ---------------------------------------------------------------------------
// Conversation history. Read-only views over the same conversations/messages
// tables the orchestrator writes — so a transcript here spans both Telegram and
// the panel's direct chat (they share the owner chatId). No runtime needed;
// these are plain SQLite reads.
// ---------------------------------------------------------------------------
interface ConversationRow {
  id: number;
  chatId: number;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  lastAt: number | null;
  preview: string | null;
}

function listConversations(): { conversations: Array<ConversationRow & { current: boolean }> } {
  const rows = withDb((db) => {
    const convs = db
      .prepare(
        `SELECT c.id AS id, c.telegram_chat_id AS chatId, c.started_at AS startedAt,
                c.ended_at AS endedAt, COUNT(m.id) AS messageCount, MAX(m.created_at) AS lastAt,
                (SELECT content FROM messages
                   WHERE conversation_id = c.id AND role = 'user'
                   ORDER BY id LIMIT 1) AS preview
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
          GROUP BY c.id
          ORDER BY COALESCE(MAX(m.created_at), c.started_at) DESC
          LIMIT 50`,
      )
      .all() as ConversationRow[];
    const current = db
      .prepare(
        `SELECT current_conversation_id AS id FROM telegram_chats
          WHERE current_conversation_id IS NOT NULL`,
      )
      .all() as Array<{ id: number }>;
    const currentSet = new Set(current.map((r) => r.id));
    return convs.map((c) => ({ ...c, current: currentSet.has(c.id) }));
  });
  return { conversations: rows ?? [] };
}

function conversationMessages(id: number): unknown {
  const out = withDb((db) => {
    const conv = db
      .prepare(
        `SELECT id, telegram_chat_id AS chatId, started_at AS startedAt, ended_at AS endedAt
           FROM conversations WHERE id = ?`,
      )
      .get(id) as
      | { id: number; chatId: number; startedAt: number; endedAt: number | null }
      | undefined;
    if (!conv) return null;
    // Cap at the last 500 messages so a very long conversation can't blow up the
    // response; tool rows are kept so the transcript matches what the model saw.
    const messages = db
      .prepare(
        `SELECT role, content, tool_name AS toolName, tokens, created_at AS createdAt
           FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 500`,
      )
      .all(id) as Array<{
      role: string;
      content: string;
      toolName: string | null;
      tokens: number | null;
      createdAt: number;
    }>;
    const summaryRow = db
      .prepare(`SELECT summary FROM session_memory WHERE conversation_id = ?`)
      .get(id) as { summary: string } | undefined;
    return { conversation: conv, messages, summary: summaryRow?.summary ?? null };
  });
  return out ?? { error: 'conversation not found' };
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
  // First handler that returned `{ error }` wins the user-facing message —
  // we keep iterating so a later handler can still produce a transcript, but
  // if none do, we surface the specific reason instead of a generic prompt.
  let handlerError: string | null = null;
  try {
    for (const h of handlers) {
      try {
        const r = await h.handler(msg);
        if (r && 'transcript' in r && r.transcript.trim().length > 0) {
          transcript = r.transcript.trim();
          break;
        }
        if (r && 'error' in r && r.error && !handlerError) {
          handlerError = r.error;
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
      error: handlerError ?? 'Voice transcription is off for this chat. Turn it on with /voice on.',
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
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback to index.html for unknown non-asset routes.
    const index = join(WEB_DIR, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html']!, 'referrer-policy': 'no-referrer' });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type };
  if (type === MIME['.html']) headers['referrer-policy'] = 'no-referrer';
  res.writeHead(200, headers);
  createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------------------
// Gurney-Tudor: guided-learning course generation + playback.
//
// The routes below call into the gurney-tudor extension's pure service layer
// using this panel's already-built db/llm runtime (the same one direct chat
// uses, which also runs gurney-tudor's migrations via loadAll). Generation runs
// as a background job that writes to the shared DB; the progress stream just
// polls that DB, so it survives a browser reconnect and reflects a build even
// if it was kicked off from the /learn Telegram command in another process.
// ---------------------------------------------------------------------------
async function tudorCtx(): Promise<tudor.TudorCtx> {
  const cfg = effectiveConfig(homeDir());
  const rt = await getDirectChatRuntime(cfg);
  return { db: rt.db, llm: rt.llm, log: rt.log };
}

function streamTudorEvents(req: IncomingMessage, res: ServerResponse, id: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  let last = '';
  let closed = false;
  // Unnamed `data:` events carrying a `type` field — the panel's streamSSE
  // helper only listens for the default message event, so this matches the
  // same convention the ext enable-stream uses.
  const send = (data: unknown): void => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client disconnected */
    }
  };
  const cleanup = (): void => {
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
  };
  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const snap = tudor.snapshot(await tudorCtx(), id);
      if (!snap) {
        send({ type: 'error', message: 'course not found' });
        cleanup();
        res.end();
        return;
      }
      const json = JSON.stringify(snap);
      if (json !== last) {
        last = json;
        send({ type: 'snapshot', ...snap });
      }
      if (snap.status !== 'generating') {
        send({ type: 'done', status: snap.status });
        cleanup();
        res.end();
      }
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
  const timer = setInterval(() => void tick(), 1500);
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20_000);
  req.on('close', cleanup);
  void tick(); // emit an immediate snapshot rather than waiting for the first interval
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
function requestToken(req: IncomingMessage, url: URL): string {
  return (req.headers['x-gurney-token'] as string) ?? url.searchParams.get('token') ?? '';
}

// Constant-time token comparison to avoid leaking the secret via timing.
function tokensMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
      return sendJson(res, 200, {
        ...probe,
        models: availableModelTags(probe.ok ? probe.models : [], homeDir()),
      });
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

    // ---- Agent command center -------------------------------------------
    // The panel runs in its own process, so it only does DB CRUD + enqueues;
    // the daemon's resource-aware queue (which polls the DB) actually runs the
    // tasks. That keeps task execution single-owner so the heavy-model slot is
    // never contended by two processes.
    if (path === '/api/agents' && method === 'GET') {
      const agents = withDb((db) => createAgentRegistry(db).list()) ?? [];
      return sendJson(res, 200, { agents });
    }
    if (path === '/api/agents' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      if (!String(body['name'] ?? '').trim() || !String(body['systemPrompt'] ?? '').trim()) {
        return sendJson(res, 400, { error: 'name and systemPrompt are required' });
      }
      const result = withDb((db) => {
        const reg = createAgentRegistry(db);
        if (reg.getByName(String(body['name']).trim())) return { dup: true as const };
        return { agent: reg.create(normalizeAgentInput(body)) };
      });
      if (!result) return sendJson(res, 500, { error: 'database unavailable' });
      if ('dup' in result) return sendJson(res, 409, { error: 'an agent with that name exists' });
      return sendJson(res, 200, result);
    }
    const agentIdMatch = /^\/api\/agents\/(\d+)$/.exec(path);
    if (agentIdMatch && method === 'PUT') {
      const id = Number(agentIdMatch[1]);
      const body = await readJson<Record<string, unknown>>(req);
      const updated = withDb((db) => {
        const reg = createAgentRegistry(db);
        if (!reg.get(id)) return null;
        return reg.update(id, normalizeAgentInput(body)) ?? null;
      });
      return sendJson(res, updated ? 200 : 404, updated ? { agent: updated } : { error: 'not found' });
    }
    if (agentIdMatch && method === 'DELETE') {
      const id = Number(agentIdMatch[1]);
      const ok = withDb((db) => createAgentRegistry(db).remove(id)) ?? false;
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    }
    const dispatchMatch = /^\/api\/agents\/(\d+)\/dispatch$/.exec(path);
    if (dispatchMatch && method === 'POST') {
      const id = Number(dispatchMatch[1]);
      const body = await readJson<{ prompt?: string }>(req);
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
      const task = withDb((db) => {
        const reg = createAgentRegistry(db);
        if (!reg.get(id)) return null;
        return reg.enqueue({ agentId: id, prompt });
      });
      return sendJson(res, task ? 200 : 404, task ? { task } : { error: 'agent not found' });
    }
    if (path === '/api/agents/tasks' && method === 'GET') {
      const data = withDb((db) => {
        const reg = createAgentRegistry(db);
        const names = new Map(reg.list().map((a) => [a.id, a.name]));
        return {
          tasks: reg
            .listTasks({ limit: 60 })
            .map((t) => ({ ...t, agentName: names.get(t.agentId) ?? null })),
        };
      }) ?? { tasks: [] };
      return sendJson(res, 200, data);
    }
    const taskIdMatch = /^\/api\/agents\/tasks\/(\d+)$/.exec(path);
    if (taskIdMatch && method === 'GET') {
      const id = Number(taskIdMatch[1]);
      const detail = withDb((db) => {
        const reg = createAgentRegistry(db);
        const task = reg.getTask(id);
        if (!task) return null;
        const agent = reg.get(task.agentId);
        const transcript = task.conversationId
          ? (db
              .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id`)
              .all(task.conversationId) as Array<{ role: string; content: string }>)
          : [];
        const children = reg
          .listTasks({ parentId: task.id })
          .map((c) => ({ id: c.id, agentId: c.agentId, status: c.status, prompt: c.prompt }));
        return { task, agentName: agent?.name ?? null, transcript, children };
      });
      return sendJson(res, detail ? 200 : 404, detail ?? { error: 'not found' });
    }
    const cancelMatch = /^\/api\/agents\/tasks\/(\d+)\/cancel$/.exec(path);
    if (cancelMatch && method === 'POST') {
      const id = Number(cancelMatch[1]);
      // Only a still-queued task can be cancelled from another process; a
      // running task is owned by the daemon and finishes on its own.
      const ok = withDb((db) => {
        const reg = createAgentRegistry(db);
        const t = reg.getTask(id);
        if (!t || t.status !== 'queued') return false;
        reg.updateTask(id, { status: 'cancelled', finishedAt: Date.now() });
        return true;
      });
      return sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'task is not queued' });
    }

    if (path === '/api/extensions' && method === 'GET') {
      return sendJson(res, 200, { extensions: listExtensions() });
    }

    // SSE stream of `ext enable` + native-dep setup output. The wizard's
    // voice-setup modal uses this so a user staring at a 150 MB whisper model
    // download sees lines arriving instead of a frozen "Setting up…" spinner.
    const extStream = /^\/api\/extensions\/([a-z0-9._-]+)\/enable-stream$/i.exec(path);
    if (extStream && method === 'GET') {
      const name = extStream[1]!;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // Single unnamed `data:` event with a `type` field. Cheaper than custom
      // SSE event names — the panel's streamSSE helper only listens for the
      // default 'message' event, so this avoids extending it just for here.
      const send = (data: unknown): void => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client disconnected */
        }
      };
      const sendChunk = (text: string): void => {
        for (const line of String(text).split(/\r?\n/)) {
          if (line.length > 0) send({ type: 'line', line });
        }
      };
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => clearInterval(keepAlive));
      try {
        const r = await runGurneyStreaming(opts, ['ext', 'enable', name], sendChunk);
        if (r.code !== 0) {
          send({ type: 'done', ok: false, error: `ext enable exited ${r.code}` });
          clearInterval(keepAlive);
          res.end();
          return;
        }
        const s = await runExtSetup(name, sendChunk);
        send({ type: 'done', ok: s.ok });
      } catch (e) {
        send({ type: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return;
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

    if (path === '/api/scheduler' && method === 'GET') {
      return sendJson(res, 200, await schedulerView());
    }

    if (path === '/api/scheduler/snooze' && method === 'POST') {
      const { ms } = await readJson<{ ms?: number }>(req);
      return sendJson(res, 200, await snoozeProactive(typeof ms === 'number' ? ms : 0));
    }

    if (path === '/api/metrics' && method === 'GET') {
      return sendJson(res, 200, metricsView());
    }

    if (path === '/api/conversations' && method === 'GET') {
      return sendJson(res, 200, listConversations());
    }

    const convMessages = /^\/api\/conversations\/(\d+)\/messages$/.exec(path);
    if (convMessages && method === 'GET') {
      return sendJson(res, 200, conversationMessages(Number(convMessages[1])));
    }

    const systemAction = /^\/api\/system\/(status|doctor|logs|commands)$/i.exec(path);
    if (systemAction && method === 'POST') {
      const r = await runSystemCommand(opts, systemAction[1]!.toLowerCase() as SystemCommandName);
      return sendJson(res, 200, r);
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

    // --agent-only on every panel-driven start/stop: clicking Stop in the
    // panel must not also kill the panel itself (this same process).
    if (path === '/api/agent/start' && method === 'POST') {
      const r = await runGurney(opts, ['start', '--detach', '--agent-only'], 30_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }
    if (path === '/api/agent/stop' && method === 'POST') {
      const r = await runGurney(opts, ['stop', '--agent-only'], 30_000);
      return sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.out + r.err });
    }
    if (path === '/api/agent/restart' && method === 'POST') {
      await runGurney(opts, ['stop', '--agent-only'], 30_000);
      const r = await runGurney(opts, ['start', '--detach', '--agent-only'], 30_000);
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
      const r = await runGurney(opts, ['update'], 1_800_000);
      return sendJson(res, r.code === 0 ? 200 : 500, {
        ok: r.code === 0,
        code: r.code,
        command: 'gurney update',
        output: r.out + r.err,
      });
    }

    if (path === '/api/maintenance/fresh' && method === 'POST') {
      const { confirm } = await readJson<{ confirm?: string }>(req);
      if (confirm !== 'RESET') {
        return sendJson(res, 400, {
          ok: false,
          error: 'type RESET to confirm a fresh install',
        });
      }
      const args = ['fresh', '--yes', '--skip-init', '--keep-panel'];
      const r = await runGurney(opts, args, 1_800_000);
      if (r.code === 0) restorePanelPidfileAfterFresh();
      return sendJson(res, r.code === 0 ? 200 : 500, {
        ok: r.code === 0,
        code: r.code,
        command: formatGurneyCommand(args),
        output: r.out + r.err,
      });
    }

    // --- Gurney-Tudor (guided learning) ---
    if (path === '/api/tudor/status' && method === 'GET') {
      return sendJson(res, 200, tudor.status(await tudorCtx()));
    }
    if (path === '/api/tudor/courses' && method === 'GET') {
      return sendJson(res, 200, { courses: tudor.listCourses(await tudorCtx()) });
    }
    if (path === '/api/tudor/research/preview' && method === 'POST') {
      const { topic } = await readJson<{ topic?: string }>(req);
      const t = (topic ?? '').trim();
      if (!t) return sendJson(res, 400, { error: 'a topic is required' });
      const sources = await tudor.previewSources(await tudorCtx(), t);
      return sendJson(res, 200, { sources });
    }

    if (path === '/api/tudor/courses' && method === 'POST') {
      const body = await readJson<{
        topic?: string;
        depth?: string;
        generator?: string;
        localModel?: string;
        cloudModel?: string;
        useWebsearch?: boolean;
        approvedSources?: Array<{
          title?: string;
          url?: string;
          domain?: string;
          snippet?: string;
        }>;
      }>(req);
      const topic = (body.topic ?? '').trim();
      if (!topic) return sendJson(res, 400, { error: 'a topic is required' });
      const depthRaw = body.depth ?? 'standard';
      const depth = (['quick', 'standard', 'deep'].includes(depthRaw) ? depthRaw : 'standard') as
        | 'quick'
        | 'standard'
        | 'deep';
      const generator: 'local' | 'codex' | 'cloud' =
        body.generator === 'codex'
          ? 'codex'
          : body.generator === 'cloud'
            ? 'cloud'
            : 'local';
      // Keep only well-formed http(s) sources the client sent back as approved.
      const approvedSources = Array.isArray(body.approvedSources)
        ? body.approvedSources
            .filter(
              (s) =>
                s &&
                typeof s.url === 'string' &&
                /^https?:\/\//i.test(s.url) &&
                typeof s.title === 'string',
            )
            .slice(0, 8)
            .map((s) => ({
              title: String(s.title),
              url: String(s.url),
              ...(s.domain ? { domain: String(s.domain) } : {}),
              ...(s.snippet ? { snippet: String(s.snippet) } : {}),
            }))
        : undefined;
      const id = tudor.startCourse(await tudorCtx(), {
        topic,
        depth,
        generator,
        ...(typeof body.localModel === 'string' && body.localModel.trim()
          ? { localModel: body.localModel.trim() }
          : {}),
        ...(typeof body.cloudModel === 'string' && body.cloudModel.trim()
          ? { cloudModel: body.cloudModel.trim() }
          : {}),
        useWebsearch: body.useWebsearch === true,
        ...(approvedSources ? { approvedSources } : {}),
      });
      return sendJson(res, 200, { ok: true, id });
    }

    const courseGet = /^\/api\/tudor\/courses\/([a-f0-9-]+)$/i.exec(path);
    if (courseGet && method === 'GET') {
      const tree = tudor.getCourse(await tudorCtx(), courseGet[1]!);
      if (!tree) return sendJson(res, 404, { error: 'course not found' });
      return sendJson(res, 200, tree);
    }

    const courseEvents = /^\/api\/tudor\/courses\/([a-f0-9-]+)\/events$/i.exec(path);
    if (courseEvents && method === 'GET') {
      return streamTudorEvents(req, res, courseEvents[1]!);
    }

    const courseDelete = /^\/api\/tudor\/courses\/([a-f0-9-]+)\/delete$/i.exec(path);
    if (courseDelete && method === 'POST') {
      tudor.deleteCourse(await tudorCtx(), courseDelete[1]!);
      return sendJson(res, 200, { ok: true });
    }

    const courseCancel = /^\/api\/tudor\/courses\/([a-f0-9-]+)\/cancel$/i.exec(path);
    if (courseCancel && method === 'POST') {
      tudor.cancelCourse(await tudorCtx(), courseCancel[1]!);
      return sendJson(res, 200, { ok: true });
    }

    const courseProgress = /^\/api\/tudor\/courses\/([a-f0-9-]+)\/progress$/i.exec(path);
    if (courseProgress && method === 'POST') {
      const b = await readJson<{ lessonId?: string; state?: string; confidence?: number }>(req);
      if (!b.lessonId) return sendJson(res, 400, { error: 'lessonId is required' });
      const stateRaw = b.state ?? 'in_progress';
      const state = (
        ['unseen', 'in_progress', 'done'].includes(stateRaw) ? stateRaw : 'in_progress'
      ) as 'unseen' | 'in_progress' | 'done';
      tudor.recordProgress(
        await tudorCtx(),
        courseProgress[1]!,
        b.lessonId,
        state,
        typeof b.confidence === 'number' ? b.confidence : 0,
      );
      return sendJson(res, 200, { ok: true });
    }

    const lessonRegen = /^\/api\/tudor\/lessons\/([a-f0-9-]+)\/regenerate$/i.exec(path);
    if (lessonRegen && method === 'POST') {
      const r = await tudor.regenerateLesson(await tudorCtx(), lessonRegen[1]!);
      return sendJson(res, 200, r);
    }

    const lessonVisualize = /^\/api\/tudor\/lessons\/([a-f0-9-]+)\/visualize$/i.exec(path);
    if (lessonVisualize && method === 'POST') {
      const b = await readJson<{ force?: boolean }>(req);
      const r = await tudor.visualizeLesson(await tudorCtx(), lessonVisualize[1]!, {
        force: b.force === true,
      });
      return sendJson(res, 200, { ok: true, ...r });
    }

    const lessonVisualizeClear = /^\/api\/tudor\/lessons\/([a-f0-9-]+)\/visualize\/clear$/i.exec(
      path,
    );
    if (lessonVisualizeClear && method === 'POST') {
      tudor.clearLessonVisualization(await tudorCtx(), lessonVisualizeClear[1]!);
      return sendJson(res, 200, { ok: true });
    }

    const segRephrase = /^\/api\/tudor\/segments\/([a-f0-9-]+)\/rephrase$/i.exec(path);
    if (segRephrase && method === 'POST') {
      const b = await readJson<{ mode?: string }>(req);
      const mode: 'simpler' | 'deeper' = b.mode === 'deeper' ? 'deeper' : 'simpler';
      const r = await tudor.rephraseSegment(await tudorCtx(), segRephrase[1]!, mode);
      return sendJson(res, 200, { ok: true, ...r });
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
async function runExtSetup(
  name: string,
  onChunk?: (text: string) => void,
): Promise<{ ok: boolean; output: string }> {
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
        if (onChunk) {
          try {
            onChunk(text);
          } catch {
            /* SSE peer disconnected; keep capturing */
          }
        }
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
      // Never overwrite a stored secret with its masked placeholder or with an
      // empty/whitespace-only value (a blank field means "leave unchanged").
      if (decl.secret && typeof raw === 'string' && (raw.includes('•') || raw.trim() === ''))
        continue;
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
// HTTPS support. The browser only exposes getUserMedia (microphone) on
// localhost or a secure origin, so a LAN-facing panel needs TLS for the
// Voice Hub to record. We accept user-supplied cert/key paths or, when
// missing, generate a self-signed pair under ~/.gurney/ via openssl.
// ---------------------------------------------------------------------------
const DEFAULT_CERT_FILE = 'frontend-cert.pem';
const DEFAULT_KEY_FILE = 'frontend-key.pem';

function defaultCertPaths(): { cert: string; key: string } {
  const home = homeDir();
  return { cert: join(home, DEFAULT_CERT_FILE), key: join(home, DEFAULT_KEY_FILE) };
}

function hasOpenssl(): boolean {
  try {
    const r = spawnSync('openssl', ['version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Generate a 10-year self-signed RSA cert + key with subjectAltName covering
// the bind host and the LAN address, so the same cert works for both the
// `localhost` and the `192.168.x.y` URL the panel prints. Quiet on success.
function generateSelfSignedCert(certPath: string, keyPath: string, host: string): void {
  if (!hasOpenssl()) {
    throw new Error(
      'openssl is required to generate a TLS certificate for the panel.\n' +
        '  Install it (apt install openssl / brew install openssl) and retry,\n' +
        '  or set https_cert_path and https_key_path to an existing PEM pair.',
    );
  }
  const lan = lanAddress();
  const altNames = new Set<string>(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
  if (host && host !== '0.0.0.0' && host !== '127.0.0.1' && host !== '::1') {
    altNames.add(/^[0-9.:]+$/.test(host) ? `IP:${host}` : `DNS:${host}`);
  }
  if (lan) altNames.add(`IP:${lan}`);
  const subj = '/CN=gurney-frontend';
  const ext = `subjectAltName=${[...altNames].join(',')}`;
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '3650',
      '-nodes',
      '-subj',
      subj,
      '-addext',
      ext,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.status !== 0) {
    throw new Error(
      `openssl failed to generate a TLS cert: ${r.stderr?.toString() || 'unknown error'}`,
    );
  }
  // The private key should not be world-readable. chmod is a no-op on Windows
  // but harmless; Pi/mini-PC deployments do enforce it.
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* ignore */
  }
}

function loadTlsMaterial(fe: Record<string, string>, host: string): { key: Buffer; cert: Buffer } {
  const defaults = defaultCertPaths();
  const certPath = fe['https_cert_path']?.trim() || defaults.cert;
  const keyPath = fe['https_key_path']?.trim() || defaults.key;
  const usingDefaults = certPath === defaults.cert && keyPath === defaults.key;

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    if (!usingDefaults) {
      throw new Error(
        `TLS cert or key not found:\n  cert: ${certPath}\n  key:  ${keyPath}\n` +
          `Check https_cert_path / https_key_path, or clear them to use the auto-generated pair.`,
      );
    }
    process.stdout.write(`gurney-frontend: generating self-signed TLS cert at ${certPath}\n`);
    generateSelfSignedCert(certPath, keyPath, host);
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
export async function run(opts: FrontendRunOptions = {}): Promise<Server> {
  const fe = frontendSettings();
  const host = fe['listen_host'] || '127.0.0.1';
  const port = Number(fe['listen_port']) || 7777;
  const authToken = fe['auth_token'] || '';
  // Default-on: only an explicit 'false' falls back to plain HTTP. Matches the
  // settings.schema.json default so a fresh install (no row in extension_settings)
  // gets HTTPS without the user having to flip a toggle.
  const httpsEnabled = fe['https_enabled'] !== 'false';

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const proto = httpsEnabled ? 'https' : 'http';
    const url = new URL(req.url ?? '/', `${proto}://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      // Auth gate: when a token is configured, require it for the API unless
      // the request comes from loopback (the operator on this machine).
      if (authToken && !isLoopback(req) && !tokensMatch(requestToken(req, url), authToken)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      void handleApi(opts, req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  };

  const server: Server = httpsEnabled
    ? createHttpsServer(loadTlsMaterial(fe, host), handler)
    : createServer(handler);

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // A stale/orphaned panel sometimes holds the port. `gurney stop` now
        // kills both the tracked pid and any orphan still on this port (see
        // src/cli/panel.ts), so the standard recovery is just stop+start.
        reject(
          new Error(
            `port ${port} on ${host} is already in use — another gurney-frontend may be running.\n` +
              `  Recover with:  gurney stop && gurney start\n` +
              `  Or find it:    lsof -i :${port}`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, host, () => resolveListen());
  });

  const scheme = httpsEnabled ? 'https' : 'http';
  const shown = host === '0.0.0.0' ? (lanAddress() ?? 'localhost') : host;
  const tokenQs = authToken ? `?token=${authToken}` : '';
  const certNote = httpsEnabled
    ? '  Self-signed cert: your browser will warn the first time — accept to continue.\n'
    : '';
  process.stdout.write(
    `gurney-frontend listening on ${scheme}://${shown}:${port}\n` +
      `  Open: ${scheme}://${shown}:${port}/${tokenQs}\n` +
      certNote +
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
