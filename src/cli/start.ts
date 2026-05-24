// `gurney start` — boot the bot.
//
// Wires together (in order):
//   1. logger (with file mirror at ~/.gurney/log/gurney.log)
//   2. SQLite + migrations (~/.gurney/gurney.db)
//   3. Ollama LLM client
//   4. tool registry
//   5. core scheduler / proactive loop (cron tick + nudge dispatcher)
//   6. extension loader — discovers + loads everything in
//      <repo>/extensions and ~/.gurney/extensions, registers their hooks
//   7. orchestrator (two queues, conversation pipeline)
//   8. Telegram adapter (long-poll)
//
// Phase 3: settings come from ~/.gurney/config.json (written by `gurney init`
// or `gurney config`). Environment variables still win, so existing
// deployments that exported TELEGRAM_BOT_TOKEN etc. don't break.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createOllama, type ProfileConfig, type ProfileName } from '../core/llm.js';
import { createToolRegistry } from '../core/tools.js';
import { createOrchestrator } from '../core/orchestrator.js';
import { createScheduler, type Nudge } from '../core/scheduler.js';
import { setupFollowups } from '../core/followups.js';
import { createExtensionLoader, type VoicePayload } from '../core/extensions.js';
import {
  collectExtensionReadiness,
  formatSetupIssuesNudge,
  setupIssuesForNudge,
} from '../core/extension-readiness.js';
import { createPrefsStore } from '../core/prefs.js';
import { createMetricsWriter } from '../core/metrics.js';
import { createTelegram } from '../adapters/telegram.js';
import { effectiveConfig, ensurePrivateDir, homeDir } from './config-store.js';
import {
  clearPid,
  isAlive,
  logFilePath,
  metricsFilePath,
  pidFilePath,
  readPid,
  writePid,
} from './daemon.js';

const HOST_VERSION = '0.1.0';

export interface StartRunOptions {
  detach?: boolean;
}

function defaultExtensionRoots(home: string): string[] {
  const userDir = join(home, 'extensions');
  // First-party extensions live in <repo>/extensions in dev. Resolve relative
  // to this file, then fall back to the cwd if it doesn't exist.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoExt = resolve(here, '..', '..', 'extensions');
  return [userDir, repoExt];
}

function knownAllowedChats(
  db: ReturnType<typeof openDb>,
  allowedUserIds: readonly number[],
): number[] {
  if (allowedUserIds.length === 0) return [];
  const placeholders = allowedUserIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT chat_id
       FROM telegram_chats
       WHERE user_id IN (${placeholders})
       ORDER BY last_seen_at DESC`,
    )
    .all(...allowedUserIds) as Array<{ chat_id: number }>;
  return rows.map((row) => row.chat_id);
}

// Parse a bounded positive integer from an env var; return undefined on
// missing/invalid so callers fall back to library defaults instead of
// silently disabling the feature.

function envInt(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export async function run(options: StartRunOptions = {}): Promise<void> {
  const home = homeDir();
  ensurePrivateDir(home);

  // If a stale pid file points at a live process, refuse to double-start.
  const existing = readPid(home);
  if (existing && isAlive(existing)) {
    throw new Error(`gurney already running (pid ${existing}). Use 'gurney stop' first.`);
  }
  if (existing) clearPid(home);

  if (options.detach) {
    return detach(home);
  }

  const cfg = effectiveConfig(home);
  if (!cfg.telegram.token) {
    throw new Error("Telegram bot token is not set. Run 'gurney init' or set TELEGRAM_BOT_TOKEN.");
  }
  // Telegram tokens are <bot-id>:<secret> with a 30+ char secret. Catching a
  // truncated or wrong-format token here is cheaper than booting grammY,
  // failing the first long-poll, and chewing through the circuit breaker.
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(cfg.telegram.token)) {
    throw new Error('Telegram bot token has an invalid shape.');
  }
  if (cfg.telegram.allowedIds.length === 0) {
    throw new Error(
      "No Telegram user IDs are allowlisted. Run 'gurney init' or set TELEGRAM_ALLOWED_IDS.",
    );
  }

  const log = createLogger({
    level: cfg.logLevel ?? 'info',
    file: logFilePath(home),
  });

  const db = openDb({ path: join(home, 'gurney.db'), log });

  // num_predict / keep_alive defaults are picked from ATLAS's production
  // config — they're already tuned against qwen3.5 family models. Without a
  // num_predict cap Ollama lets the model ramble for hundreds of tokens past
  // a natural stopping point, which on CPU costs real seconds. keep_alive is
  // bumped from Ollama's 5m default so back-to-back user turns don't trigger
  // a cold reload.
  const profiles: Partial<Record<ProfileName, ProfileConfig | null>> = {
    chat: {
      model: cfg.models.chat,
      contextTokens: 4096,
      heavy: false,
      numPredict: 512,
      keepAlive: '30m',
    },
  };
  if (cfg.models.reason) {
    profiles.reason = {
      model: cfg.models.reason,
      contextTokens: 8192,
      heavy: true,
      numPredict: 2048,
      keepAlive: '10m',
    };
  }
  if (cfg.models.tools) {
    // Tool-use profile. heavy=false so it doesn't fight the reasoning model
    // for the single heavy slot. num_predict capped at 1024 — earlier 256/512
    // caps clipped mid-tool-call on 2b-class models, but 2048 left so much
    // ramble headroom that a single turn routinely cost ~60s on CPU. 1024 is
    // ~4x a typical tool-call payload (~250 tokens) and the orchestrator's
    // follow-up paraphrase round uses its own tighter per-call cap.
    profiles.tools = {
      model: cfg.models.tools,
      contextTokens: 4096,
      heavy: false,
      numPredict: 1024,
      keepAlive: '10m',
    };
  }

  // Optional resilience tunables. We surface these as env knobs (rather than
  // baking them into config.json) because they're operational levers an
  // operator might want to flip without touching the config file. Library
  // defaults handle the common case; these only kick in when set.
  const idleEvictionMs = envInt('GURNEY_HEAVY_IDLE_MS');
  const inferenceTimeoutMs = envInt('GURNEY_INFERENCE_TIMEOUT_MS');

  const llm = createOllama({
    baseUrl: cfg.ollama.url,
    profiles,
    log,
    ...(idleEvictionMs !== undefined ? { idleEvictionMs } : {}),
    ...(inferenceTimeoutMs !== undefined ? { inferenceTimeoutMs } : {}),
  });

  const tools = createToolRegistry({ log });

  const prefs = createPrefsStore(db);

  // Build a placeholder telegram dispatcher for the scheduler. The Telegram
  // adapter swaps the real one in once it's constructed.
  let dispatchNudge: (nudge: Nudge) => Promise<void> = async () => {
    log.warn('nudge dispatched before Telegram adapter ready');
  };
  const scheduler = createScheduler({
    log,
    dispatch: (n) => dispatchNudge(n),
    prefs,
    db,
  });

  // Self-scheduled followups. Registers a core tool the model can call and a
  // per-minute sweep job on the scheduler. Done before extensions load so the
  // tool is in the registry by the time anything (extension or user) touches
  // it.
  const followups = setupFollowups({ db, scheduler, tools, log });

  const extensionsRoots = defaultExtensionRoots(home);
  const stateRoot = join(home, 'extension_state');
  ensurePrivateDir(stateRoot);

  // Voice-note sink for extensions like gurney-voice. The Telegram adapter
  // hasn't been built yet, so we install a thunk that resolves to it once
  // adapter construction finishes below.
  let sendVoiceImpl: ((chatId: number, voice: VoicePayload) => Promise<void>) | null = null;
  let notifySetupIssues: (() => Promise<void>) | null = null;
  const loader = createExtensionLoader({
    roots: extensionsRoots,
    stateRoot,
    db,
    llm,
    log,
    scheduler,
    tools,
    hostVersion: HOST_VERSION,
    chatId: cfg.telegram.allowedIds[0]!,
    allowedUserIds: cfg.telegram.allowedIds,
    watch: true,
    sendVoice: async (chatId, voice) => {
      if (!sendVoiceImpl) {
        log.warn('sendVoice called before Telegram adapter ready');
        return;
      }
      await sendVoiceImpl(chatId, voice);
    },
    onDidReload: async () => {
      await notifySetupIssues?.();
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
    ...(cfg.models.tools ? { toolProfile: 'tools' as const } : {}),
    ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
  });

  const ownerId = cfg.telegram.allowedIds[0]!;
  log.info('telegram owner identified', { ownerId });
  const telegram = createTelegram({
    token: cfg.telegram.token,
    allowedUserIds: cfg.telegram.allowedIds,
    ownerId,
    log,
    orchestrator,
    llm,
    tools,
    db,
    prefs,
    followups,
    logFilePath: logFilePath(home),
    schedulerStats: () => scheduler.stats(),
    schedulerList: () => [...scheduler.list()],
    extensions: () => collectExtensionReadiness(extensionsRoots, db),
    extensionCommands: () => loader.commands(),
    extensionIntercepts: () => loader.intercepts(),
    extensionAfterReplies: () => loader.afterReplies(),
    extensionAfterTurns: () => loader.afterTurns(),
    extensionCallbacks: () => loader.callbacks(),
    extensionVoiceMessages: () => loader.voiceMessages(),
  });
  // Wire the scheduler -> Telegram nudge path.
  dispatchNudge = (nudge) => telegram.sendNudge(nudge);
  // And the voice-note path now that the adapter exists.
  sendVoiceImpl = (chatId, voice) => telegram.sendVoice(chatId, voice);
  let lastSetupIssueSignature = '';
  notifySetupIssues = async () => {
    const issues = setupIssuesForNudge(collectExtensionReadiness(extensionsRoots, db));
    const signature = JSON.stringify(
      issues.map((e) => [e.name, e.status, e.reasons, e.nextAction]).sort(),
    );
    if (issues.length === 0) {
      lastSetupIssueSignature = '';
      return;
    }
    if (signature === lastSetupIssueSignature) return;
    const chats = knownAllowedChats(db, cfg.telegram.allowedIds);
    if (chats.length === 0) return;
    lastSetupIssueSignature = signature;
    const text = formatSetupIssuesNudge(issues);
    for (const chatId of chats) await telegram.sendMessage(chatId, text);
  };

  await telegram.start();
  await notifySetupIssues();
  scheduler.start();

  const metricsWriter = createMetricsWriter({
    path: metricsFilePath(home),
    log,
    scheduler,
    startedAt: Date.now(),
  });
  metricsWriter.start();

  writePid(process.pid, home);

  // Best-effort warm-up. `/api/tags` proves Ollama is reachable, then the
  // tiny capped chat call actually loads the configured chat model so the
  // first real user turn doesn't pay cold-start latency.
  void (async () => {
    const h = await llm.health();
    if (!h.ok) {
      log.warn('Ollama health check failed at boot');
      return;
    }
    log.info('Ollama reachable', { models: h.models.length });
    try {
      let warmedModel: string | undefined;
      for await (const chunk of llm.chat({
        profile: 'chat',
        messages: [
          { role: 'system', content: 'You are Gurney. Reply with OK.' },
          { role: 'user', content: 'warm up' },
        ],
        maxTokens: 1,
      })) {
        warmedModel = chunk.model ?? warmedModel;
        if (chunk.done) break;
      }
      log.info('chat model warmed', { model: warmedModel ?? llm.resolveModel('chat') });
    } catch (e) {
      log.warn('chat model warm-up failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutdown signal received', { signal });
    // If any of the awaited stages below hangs (extension watcher, grammY
    // long-poll drain, etc.) the process would otherwise sit forever and
    // /restart's helper would wait forever. Force-exit after a budget.
    const hardExit = setTimeout(() => {
      log.warn('shutdown took too long, forcing exit');
      process.exit(1);
    }, 8_000);
    hardExit.unref();
    try {
      metricsWriter.stop();
    } catch {
      /* ignore */
    }
    try {
      scheduler.stop();
    } catch {
      /* ignore */
    }
    try {
      await loader.shutdown();
    } catch (e) {
      log.warn('extension loader shutdown failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await telegram.stop();
    } catch (e) {
      log.warn('telegram stop failed', { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      llm.stopIdleEviction();
    } catch {
      /* ignore */
    }
    try {
      await orchestrator.shutdown();
    } catch (e) {
      log.warn('orchestrator shutdown failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    clearPid(home);
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// Spawn ourselves as a detached child running `gurney start` (without
// --detach) and exit. The child writes its PID once it's fully wired up.
function detach(home: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // We're running either from dist/cli/start.js (built) or from src via tsx.
  // In both cases the parent CLI entrypoint is alongside us at ./index.{js,ts}.
  const cliEntry = join(here, 'index.js');
  const child = spawn(process.execPath, [cliEntry, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  process.stdout.write(
    `gurney started in background (pid ${child.pid}). Logs: ${logFilePath(home)}\n` +
      `Stop with 'gurney stop'. Pid file: ${pidFilePath(home)}\n`,
  );
}
