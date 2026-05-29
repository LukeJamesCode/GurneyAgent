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
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { freemem, networkInterfaces, totalmem } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { open as openDb, type DB } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createOllama } from '../../src/core/llm.js';
import { probeOllama } from '../../src/cli/ollama-probe.js';
import { collectDoctorChecks } from '../../src/cli/doctor.js';
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
  status: ExtensionReadiness['status'];
  reasons: string[];
  nextAction?: string;
  capabilities: string[];
  needsAuth: boolean;
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
    .filter((r) => r.name !== EXT_NAME)
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
      const tools: ExtView['tools'] = ep.tools
        ? [{ name: 'tools', desc: 'Adds AI-callable tools' }]
        : [];
      const jobs: string[] = ep.jobs ? ['Runs scheduled background jobs'] : [];
      return {
        name: r.name,
        version: r.version,
        description: manifest?.description ?? '',
        source: r.source,
        installed: true,
        enabled: r.enabled,
        status: r.status,
        reasons: r.reasons,
        ...(r.nextAction ? { nextAction: r.nextAction } : {}),
        capabilities: caps,
        needsAuth: !!ep.auth || caps.includes('auth:oauth'),
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
// Direct chat (no daemon required): stream a reply straight from Ollama using
// the configured chat model. This mirrors what you'd say in Telegram but
// without tools/history — it's the honest "talk to the model" surface.
// ---------------------------------------------------------------------------
interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  time: string;
  tool?: string;
}
const chatHistory: ChatMsg[] = [];

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

  const log = createLogger({ level: 'warn' });
  const llm = createOllama({ baseUrl: cfg.ollama.url, profiles: {}, log, idleEvictionMs: 0 });
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let full = '';
  try {
    const history = chatHistory.slice(-12).map((m) => ({ role: m.role, content: m.text }));
    for await (const chunk of llm.chat({
      profile: { model: cfg.models.chat },
      messages: [
        {
          role: 'system',
          content:
            'You are Gurney, a small private assistant running locally on the user’s own machine. Be concise and warm.',
        },
        ...history,
      ],
      signal: controller.signal,
      maxTokens: 512,
    })) {
      if (chunk.delta) {
        full += chunk.delta;
        sse('delta', { delta: chunk.delta });
      }
      if (chunk.done) break;
    }
    chatHistory.push({ role: 'assistant', text: full, time: hhmm() });
    sse('done', { text: full });
  } catch (e) {
    sse('error', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    llm.stopIdleEviction();
    res.end();
  }
}

function hhmm(): string {
  return new Date().toTimeString().slice(0, 5);
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
      /^\/api\/extensions\/([a-z0-9._-]+)\/(enable|disable|install|uninstall|settings)$/i.exec(
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
      if (method === 'POST') {
        const args =
          action === 'uninstall'
            ? ['ext', 'uninstall', name, ...(url.searchParams.get('purge') ? ['--purge'] : [])]
            : ['ext', action, name];
        const r = await runGurney(opts, args);
        return sendJson(res, r.code === 0 ? 200 : 500, {
          ok: r.code === 0,
          output: r.out + r.err,
        });
      }
    }

    if (path === '/api/commands' && method === 'GET') {
      return sendJson(res, 200, commandReference());
    }

    if (path === '/api/chat' && method === 'POST') {
      return streamChat(req, res);
    }

    if (path === '/api/chat/clear' && method === 'POST') {
      chatHistory.length = 0;
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
    server.once('error', reject);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
