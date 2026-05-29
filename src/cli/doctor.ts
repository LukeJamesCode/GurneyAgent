// `gurney doctor` — preflight diagnostics.
//
// Each check is a small, named function that returns `{ ok, msg }`. We run
// them all (no short-circuit) so the user gets a full picture in one pass.
//
// Phase 7 expanded the basic Phase-3 set with disk-space, port-conflict, and
// migrations-state checks so doctor doubles as a real triage tool, plus an
// environment-variable drift check that catches the "I exported the old
// var name and now nothing works" support case.

import { createServer } from 'node:net';
import { existsSync, statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveConfig, homeDir } from './config-store.js';
import { extensionFolders } from './extension-paths.js';
import { probeOllama } from './ollama-probe.js';
import { loadMigrations } from '../storage/db.js';
import Database from 'better-sqlite3';

export interface CheckResult {
  name: string;
  ok: boolean;
  msg: string;
}

const TELEGRAM_API = 'https://api.telegram.org';

// Recognised environment variables. Anything starting with TELEGRAM_ /
// OLLAMA_ / GURNEY_ that isn't on this list is flagged as a likely typo or
// a stale variable from a previous Gurney version. Update both this list
// and .env.example together so the check stays accurate.
const KNOWN_ENV_VARS = new Set<string>([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_IDS',
  'OLLAMA_URL',
  'OLLAMA_NUM_THREADS',
  'OLLAMA_FLASH_ATTENTION',
  'GURNEY_CHAT_MODEL',
  'GURNEY_REASON_MODEL',
  'GURNEY_TOOLS_MODEL',
  'GURNEY_TIER',
  'GURNEY_LOG_LEVEL',
  'GURNEY_HOME',
  // Tuning knobs surfaced for ops.
  'GURNEY_HEAVY_IDLE_MS',
  'GURNEY_INFERENCE_TIMEOUT_MS',
  'GURNEY_MAX_TOOL_ROUNDS',
  'GURNEY_BRANCH_ALLOWLIST',
  'GURNEY_SHELL_ALLOWLIST',
]);

// Variables we used to read but no longer do. If the user still has these
// exported, surface them explicitly so the user removes them from their
// shell rc / .env file rather than wondering why the new value isn't
// taking effect.
const DEPRECATED_ENV_VARS: Record<string, string> = {
  GURNEY_CHAT_PROVIDER: 'removed; Gurney core is Ollama-only',
  GURNEY_REASON_PROVIDER: 'removed; Gurney core is Ollama-only',
  GURNEY_TOOLS_PROVIDER: 'removed; Gurney core is Ollama-only',
  OPENAI_API_KEY: 'removed; Gurney core is Ollama-only',
  OPENAI_BASE_URL: 'removed; Gurney core is Ollama-only',
};

// Run one check so it can never reject: a thrown error becomes a failed
// CheckResult instead of taking the whole doctor run (and the panel's
// /api/doctor endpoint) down with it.
async function guard(name: string, fn: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (e) {
    return { name, ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

export async function collectDoctorChecks(): Promise<CheckResult[]> {
  const home = homeDir();
  let cfg: ReturnType<typeof effectiveConfig> | null = null;
  let cfgError: string | null = null;
  try {
    cfg = effectiveConfig(home);
  } catch (e) {
    cfgError = e instanceof Error ? e.message : String(e);
  }
  if (!cfg) {
    return [
      { name: 'config', ok: false, msg: `could not load config: ${cfgError}` },
      await guard('home', () => checkHome(home)),
    ];
  }
  const c = cfg;
  const checks: Array<Promise<CheckResult>> = [
    guard('home', () => checkHome(home)),
    guard('config', () => checkConfig(c)),
    guard('ram', () => checkRam()),
    guard('disk', () => checkDisk(home)),
    guard('extensions', () => checkExtensions(home)),
    guard('migrations', () => checkMigrations(home)),
    guard('env', () => checkEnvVars(process.env)),
    guard('ports', () => checkPorts(c.ollama.url)),
    guard('telegram', () => checkTelegram(c.telegram.token)),
    guard('ollama', () => checkOllama(c.ollama.url, c.models.chat, c.models.reason, c.models.tools)),
  ];
  return Promise.all(checks);
}

export function formatDoctorResults(results: readonly CheckResult[]): string {
  const failed = results.filter((r) => !r.ok).length;
  const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.msg}`);
  if (failed > 0) lines.push('', `${failed} check(s) failed.`);
  return lines.join('\n');
}

export async function run(): Promise<void> {
  const results = await collectDoctorChecks();
  process.stdout.write(formatDoctorResults(results) + '\n');
  if (results.some((r) => !r.ok)) process.exit(1);
}

function checkHome(home: string): CheckResult {
  if (!existsSync(home)) {
    return { name: 'home', ok: false, msg: `${home} does not exist — run 'gurney init'` };
  }
  return { name: 'home', ok: true, msg: home };
}

function checkConfig(cfg: ReturnType<typeof effectiveConfig>): CheckResult {
  const missing: string[] = [];
  if (!cfg.telegram.token) missing.push('telegram.token');
  if (cfg.telegram.allowedIds.length === 0) missing.push('telegram.allowedIds');
  if (!cfg.ollama.url) missing.push('ollama.url');
  if (!cfg.models.chat) missing.push('models.chat');
  if (missing.length > 0) {
    return { name: 'config', ok: false, msg: `missing: ${missing.join(', ')}` };
  }
  return { name: 'config', ok: true, msg: 'all required values set' };
}

function checkRam(): CheckResult {
  const totalGb = totalmem() / 1024 / 1024 / 1024;
  const freeGb = freemem() / 1024 / 1024 / 1024;
  if (totalGb < 3.5) {
    return {
      name: 'ram',
      ok: false,
      msg: `only ${totalGb.toFixed(1)} GB total — Gurney needs ≥4 GB`,
    };
  }
  return {
    name: 'ram',
    ok: true,
    msg: `${totalGb.toFixed(1)} GB total, ${freeGb.toFixed(1)} GB free`,
  };
}

function checkExtensions(home: string): CheckResult {
  let count = 0;
  let bad = 0;
  for (const { folder } of extensionFolders(home)) {
    if (existsSync(join(folder, 'manifest.json'))) count += 1;
    else bad += 1;
  }
  if (bad > 0) {
    return {
      name: 'extensions',
      ok: false,
      msg: `${count} valid, ${bad} folder(s) without manifest.json`,
    };
  }
  return { name: 'extensions', ok: true, msg: `${count} installed` };
}

// Inspect the live process environment for vars Gurney *used to* read and
// vars whose names look Gurney-shaped but aren't recognised. The check
// returns ok=true even when a variable is unrecognised — it's a hint, not
// a failure — but we still print it so the user can remove the stale entry
// or fix the typo. Deprecated vars do fail the check because they're
// almost always actively misleading the user.
export function checkEnvVars(env: NodeJS.ProcessEnv): CheckResult {
  const deprecated: string[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(env)) {
    if (key in DEPRECATED_ENV_VARS) {
      deprecated.push(key);
      continue;
    }
    if (!isGurneyShaped(key)) continue;
    if (KNOWN_ENV_VARS.has(key)) continue;
    unknown.push(key);
  }
  const parts: string[] = [];
  if (deprecated.length > 0) {
    const renamed = deprecated.map((k) => `${k} → ${DEPRECATED_ENV_VARS[k]}`).join('; ');
    parts.push(`deprecated: ${renamed}`);
  }
  if (unknown.length > 0) {
    parts.push(`unknown (likely stale or typo): ${unknown.join(', ')}`);
  }
  if (parts.length === 0) {
    return { name: 'env', ok: true, msg: 'no stale or unrecognised gurney env vars' };
  }
  return {
    name: 'env',
    ok: deprecated.length === 0,
    msg: parts.join(' | '),
  };
}

function isGurneyShaped(key: string): boolean {
  return key.startsWith('GURNEY_') || key.startsWith('TELEGRAM_') || key.startsWith('OLLAMA_');
}

async function checkTelegram(token: string): Promise<CheckResult> {
  if (!token) return { name: 'telegram', ok: false, msg: 'no token configured' };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { name: 'telegram', ok: false, msg: `getMe HTTP ${res.status}` };
    }
    const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    if (!j.ok) return { name: 'telegram', ok: false, msg: 'getMe returned ok=false' };
    return { name: 'telegram', ok: true, msg: `@${j.result?.username ?? '<unknown>'}` };
  } catch (e) {
    return { name: 'telegram', ok: false, msg: (e as Error).message };
  }
}

async function checkOllama(
  url: string,
  chatModel: string | undefined,
  reasonModel: string | undefined,
  toolsModel: string | undefined,
): Promise<CheckResult> {
  const probe = await probeOllama(url);
  if (!probe.ok) {
    return { name: 'ollama', ok: false, msg: `${url}: ${probe.error ?? 'unreachable'}` };
  }
  const missing: string[] = [];
  if (chatModel && !modelPresent(probe.models, chatModel)) missing.push(chatModel);
  if (reasonModel && !modelPresent(probe.models, reasonModel)) missing.push(reasonModel);
  if (toolsModel && !modelPresent(probe.models, toolsModel)) missing.push(toolsModel);
  if (missing.length > 0) {
    return {
      name: 'ollama',
      ok: false,
      msg: `${url} ok but missing model(s): ${missing.join(', ')}`,
    };
  }
  return { name: 'ollama', ok: true, msg: `${url} (${probe.models.length} models)` };
}

function checkDisk(home: string): CheckResult {
  // Block until we have a path that actually exists on disk; statfs needs one.
  let probe = home;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const s = statfsSync(probe);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const freeGb = freeBytes / 1024 / 1024 / 1024;
    if (freeGb < 1) {
      return {
        name: 'disk',
        ok: false,
        msg: `only ${freeGb.toFixed(2)} GB free on ${probe} — Gurney needs ≥1 GB headroom`,
      };
    }
    return { name: 'disk', ok: true, msg: `${freeGb.toFixed(1)} GB free on ${probe}` };
  } catch (e) {
    return { name: 'disk', ok: true, msg: `could not statfs ${probe}: ${(e as Error).message}` };
  }
}

function checkMigrations(home: string): CheckResult {
  // Check core migrations status. We do this read-only by opening the DB
  // without running migrations and comparing on-disk files vs. the
  // _migrations table.
  const dbPath = join(home, 'gurney.db');
  if (!existsSync(dbPath)) {
    return { name: 'migrations', ok: true, msg: 'no DB yet (will be created on first start)' };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const migDir = resolve(here, '..', 'storage', 'migrations');
  const onDisk = loadMigrations(migDir);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let applied: Array<{ version: number; checksum: string }>;
    try {
      applied = db
        .prepare(`SELECT version, checksum FROM _migrations ORDER BY version`)
        .all() as Array<{ version: number; checksum: string }>;
    } catch {
      // Table doesn't exist yet — DB is from before any migration ran.
      return {
        name: 'migrations',
        ok: false,
        msg: '_migrations table missing — DB is from a pre-Phase-1 build',
      };
    }
    const appliedVersions = new Set(applied.map((a) => a.version));
    const pending = onDisk.filter((m) => !appliedVersions.has(m.version));
    for (const a of applied) {
      const file = onDisk.find((m) => m.version === a.version);
      if (!file) {
        return {
          name: 'migrations',
          ok: false,
          msg: `migration ${a.version} applied but file is missing — checkout mismatch`,
        };
      }
      if (file.checksum !== a.checksum) {
        return {
          name: 'migrations',
          ok: false,
          msg: `migration ${a.version} (${file.name}) changed since applied — checksum mismatch`,
        };
      }
    }
    if (pending.length > 0) {
      const names = pending.map((m) => `${m.version}_${m.name}`).join(', ');
      return {
        name: 'migrations',
        ok: false,
        msg: `${pending.length} pending: ${names} — will run on next start`,
      };
    }
    return { name: 'migrations', ok: true, msg: `${applied.length} applied, none pending` };
  } finally {
    db.close();
  }
}

async function checkPorts(ollamaUrl: string): Promise<CheckResult> {
  // The only port Gurney itself opens long-term is the OAuth callback server,
  // and that picks a random free port at runtime. The thing that hurts users
  // is when Ollama's *expected* port is held by something else (so they think
  // Ollama is up but they're talking to nothing). Probe whatever port the
  // Ollama URL points at: if it parses, try to bind it. If bind succeeds,
  // nothing is listening — surface that. If it fails with EADDRINUSE, good,
  // something is there (it might be Ollama; the dedicated ollama check will
  // confirm).
  let port: number;
  let host: string;
  try {
    const u = new URL(ollamaUrl);
    port = Number.parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
    host = u.hostname;
  } catch {
    return { name: 'ports', ok: true, msg: 'no parseable ollama url; skipping' };
  }
  // Only probe localhost-ish hosts; binding to a remote address is meaningless.
  const localish = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (!localish.includes(host)) {
    return { name: 'ports', ok: true, msg: `ollama is remote (${host}); local port check skipped` };
  }
  const free = await probePortFree(host, port);
  if (free) {
    return {
      name: 'ports',
      ok: false,
      msg: `port ${port} on ${host} is FREE — Ollama is not listening (start it)`,
    };
  }
  return { name: 'ports', ok: true, msg: `port ${port} is held (likely Ollama)` };
}

function probePortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const srv = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        srv.close();
      } catch {
        /* ignore */
      }
      resolveP(free);
    };
    srv.once('error', () => finish(false));
    srv.listen(port, host, () => finish(true));
    setTimeout(() => finish(false), 1500);
  });
}

function modelPresent(available: string[], wanted: string): boolean {
  if (available.includes(wanted)) return true;
  // Ollama lists tags as "name:tag"; users sometimes type just "name" or
  // "name:latest". Be lenient.
  const aliases = new Set([wanted, `${wanted}:latest`]);
  return available.some((m) => aliases.has(m) || m.startsWith(wanted + ':'));
}
