// `gurney abilitytest` — scripted end-to-end tests of every Gurney ability.
//
// Boots the same in-process stack as `gurney start` (db, llm, tools, prefs,
// scheduler, extension loader, orchestrator) MINUS the Telegram adapter, then
// pumps catalog messages through the same dispatch ladder telegram.ts uses:
// slash → core command handler or extension command; freeform → intercept
// chain → orchestrator. Captures intercept replies, the streamed assistant
// reply, tool calls from afterTurn, and any voice payloads. Prints a row per
// test, a summary, and writes a markdown report.
//
// No cleanup. Events, tasks, reminders and quiet windows the model creates
// remain in the user's real accounts and SQLite. The runner refuses to start
// if a daemon is already running so the two don't fight over the heavy model
// slot and the SQLite writer.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { open as openDb } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createOllama, type ProfileConfig, type ProfileName } from '../../src/core/llm.js';
import { createToolRegistry } from '../../src/core/tools.js';
import { createOrchestrator, type ReplyChunk } from '../../src/core/orchestrator.js';
import { createScheduler, type Nudge } from '../../src/core/scheduler.js';
import { setupFollowups } from '../../src/core/followups.js';
import {
  createExtensionLoader,
  type AfterTurnContext,
  type TelegramCommandContext,
  type TelegramInterceptContext,
  type VoicePayload,
} from '../../src/core/extensions.js';
import { collectExtensionReadiness } from '../../src/core/extension-readiness.js';
import { createPrefsStore } from '../../src/core/prefs.js';
import { effectiveConfig, ensurePrivateDir, homeDir } from '../../src/cli/config-store.js';
import { logFilePath, readPid, isAlive } from '../../src/cli/daemon.js';
import {
  buildTelegramHelp,
  formatExtensionsText,
  formatPendingFollowups,
  formatProactiveText,
  handleFollowupCancel,
  handleFollowupClear,
  handleLogs,
  handleNudges,
  handleQuiet,
  handleWhy,
} from '../../src/adapters/telegram.js';
import { collectDoctorReply } from '../../src/adapters/telegram-maintenance.js';

import { loadCatalog, type TestCase, type TestTier } from './catalog.js';
import {
  formatRow,
  judgeTest,
  renderMarkdown,
  renderSummary,
  type ReportContext,
  type TurnRecord,
} from './report.js';

const HOST_VERSION = '0.1.0';
const DEFAULT_PAUSE_MS = 250;

export interface RunOptions {
  tier: TestTier;
  filter?: string;
  outFile?: string;
  pauseMs?: number;
}

interface RunnerCtx {
  db: ReturnType<typeof openDb>;
  prefs: ReturnType<typeof createPrefsStore>;
  loader: ReturnType<typeof createExtensionLoader>;
  scheduler: ReturnType<typeof createScheduler>;
  orchestrator: ReturnType<typeof createOrchestrator>;
  followups: ReturnType<typeof setupFollowups>;
  llm: ReturnType<typeof createOllama>;
  tools: ReturnType<typeof createToolRegistry>;
  chatId: number;
  userId: number;
  logPath: string;
  extensionsRoots: string[];
  log: ReturnType<typeof createLogger>;
}

export async function run(opts: RunOptions): Promise<void> {
  const home = homeDir();
  ensurePrivateDir(home);

  const existingPid = readPid(home);
  if (existingPid && isAlive(existingPid)) {
    throw new Error(
      `gurney is running (pid ${existingPid}). Stop it first with 'gurney stop' — the test runner needs the heavy model slot and the SQLite writer to itself.`,
    );
  }

  const cfg = effectiveConfig(home);
  if (cfg.telegram.allowedIds.length === 0) {
    throw new Error(
      "No Telegram user IDs are allowlisted. Run 'gurney init' first so the test runner has a chat id to drive.",
    );
  }

  const log = createLogger({
    level: cfg.logLevel ?? 'info',
    file: logFilePath(home),
  });

  const db = openDb({ path: join(home, 'gurney.db'), log });

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
    profiles.tools = {
      model: cfg.models.tools,
      contextTokens: 4096,
      heavy: false,
      numPredict: 2048,
      keepAlive: '10m',
    };
  }

  const llm = createOllama({ baseUrl: cfg.ollama.url, profiles, log });
  const tools = createToolRegistry({ log });
  const prefs = createPrefsStore(db);

  // Scheduler is wired but nudges go nowhere — there's no Telegram. Followup
  // sweeps and routine discovery still need a tick loop.
  const dropNudge: (n: Nudge) => Promise<void> = async () => {};
  const scheduler = createScheduler({
    log,
    dispatch: (n) => dropNudge(n),
    prefs,
    db,
  });

  const followups = setupFollowups({ db, scheduler, tools, log });

  // sendVoice recorder — counts payloads so freeform tests with `voice: true`
  // can be judged. We don't write the audio to disk.
  const voiceLog: Array<{ chatId: number; at: number; caption?: string | undefined }> = [];

  const here = dirname(fileURLToPath(import.meta.url));
  const repoExt = resolve(here, '..', '..', 'extensions');
  const userExt = join(home, 'extensions');
  const extensionsRoots = [userExt, repoExt];
  const stateRoot = join(home, 'extension_state');
  ensurePrivateDir(stateRoot);

  const chatId = cfg.telegram.allowedIds[0]!;
  const userId = chatId;

  const loader = createExtensionLoader({
    roots: extensionsRoots,
    stateRoot,
    db,
    llm,
    log,
    scheduler,
    tools,
    hostVersion: HOST_VERSION,
    chatId,
    allowedUserIds: cfg.telegram.allowedIds,
    watch: false,
    sendVoice: async (cid, voice: VoicePayload) => {
      voiceLog.push({ chatId: cid, at: Date.now(), caption: voice.caption });
    },
  });
  await loader.loadAll();

  const orchestrator = createOrchestrator({
    db,
    llm,
    tools,
    log,
    promptFragmentProvider: (filter) => loader.promptFragment(filter),
    toolIntentFilter: (m) => loader.relevantExtensions(m),
    ...(cfg.models.tools ? { toolProfile: 'tools' as const } : {}),
  });

  const ctx: RunnerCtx = {
    db,
    prefs,
    loader,
    scheduler,
    orchestrator,
    followups,
    llm,
    tools,
    chatId,
    userId,
    logPath: logFilePath(home),
    extensionsRoots,
    log,
  };

  const tests = loadCatalog(extensionsRoots, here, {
    tier: opts.tier,
    filter: opts.filter,
  });

  const startedAt = Date.now();

  writeLine('');
  writeLine('══ Gurney ability test ══════════════════════════════════════════════════════');
  writeLine(
    `tier: ${opts.tier} · ${tests.length} tests · started ${new Date(startedAt).toISOString()}`,
  );
  writeLine(
    `chat: ${chatId} · NO CLEANUP — created events, tasks, reminders and quiet windows remain in your accounts`,
  );
  if (opts.filter) writeLine(`filter: /${opts.filter}/`);
  writeLine('');

  if (tests.length === 0) {
    writeLine('No tests matched. Adjust --tier or --filter.');
    await teardown(ctx);
    return;
  }

  // Group consecutive tests by ability so we can /newchat between abilities
  // (keeps history clean for the LLM) but keep variations of the same ability
  // in one conversation so the model can build on context where natural.
  const records: TurnRecord[] = [];
  let lastAbility: string | null = null;

  for (const test of tests) {
    if (lastAbility !== null && test.ability !== lastAbility) {
      orchestrator.newChat(chatId);
    }
    lastAbility = test.ability;

    const voicesBefore = voiceLog.length;
    const tStart = Date.now();
    let record: TurnRecord;
    try {
      if (test.kind === 'slash') {
        const reply = await dispatchSlash(test.message, ctx);
        record = makeRecord(test, {
          interceptReplies: [],
          reply,
          toolsCalled: [],
          voiceEmitted: voiceLog.length > voicesBefore,
          elapsedMs: Date.now() - tStart,
        });
      } else {
        const r = await dispatchFreeform(test.message, ctx);
        // Give afterReply/afterTurn hooks a tick to emit voice payloads.
        await sleep(50);
        record = makeRecord(test, {
          interceptReplies: r.interceptReplies,
          reply: r.orchestratorReply,
          toolsCalled: (r.meta?.afterTurn?.toolCalls ?? []).map((t) => ({
            name: t.name,
            ok: t.ok,
          })),
          voiceEmitted: voiceLog.length > voicesBefore,
          elapsedMs: Date.now() - tStart,
          ...(r.meta?.model !== undefined ? { model: r.meta.model } : {}),
          ...(r.meta?.promptTokens !== undefined ? { promptTokens: r.meta.promptTokens } : {}),
          ...(r.meta?.completionTokens !== undefined
            ? { completionTokens: r.meta.completionTokens }
            : {}),
        });
      }
    } catch (e) {
      record = makeRecord(test, {
        interceptReplies: [],
        reply: '',
        toolsCalled: [],
        voiceEmitted: voiceLog.length > voicesBefore,
        elapsedMs: Date.now() - tStart,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    writeLine(formatRow(record));
    writeLine('');
    records.push(record);

    await sleep(opts.pauseMs ?? DEFAULT_PAUSE_MS);
  }

  const finishedAt = Date.now();
  const reportCtx: ReportContext = {
    startedAt,
    finishedAt,
    tier: opts.tier,
    chatId,
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
  };

  writeLine(renderSummary(records, reportCtx));
  writeLine('');

  const outPath =
    opts.outFile ??
    join(home, `ability-test-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(outPath, renderMarkdown(records, reportCtx), 'utf8');
  writeLine(`report saved: ${outPath}`);
  writeLine('');

  await teardown(ctx);
}

async function teardown(ctx: RunnerCtx): Promise<void> {
  try {
    ctx.scheduler.stop();
  } catch {
    /* ignore */
  }
  try {
    ctx.llm.stopIdleEviction();
  } catch {
    /* ignore */
  }
  try {
    await ctx.loader.shutdown();
  } catch {
    /* ignore */
  }
  try {
    await ctx.orchestrator.shutdown();
  } catch {
    /* ignore */
  }
  try {
    ctx.db.close();
  } catch {
    /* ignore */
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

interface FreeformResult {
  interceptReplies: string[];
  orchestratorReply: string;
  meta: ReplyChunk['meta'] | undefined;
}

async function dispatchFreeform(text: string, ctx: RunnerCtx): Promise<FreeformResult> {
  const interceptReplies: string[] = [];
  let orchestratorReply = '';
  let meta: ReplyChunk['meta'] | undefined;
  let orchestratorStarted = false;
  let orchestratorDone: Promise<void> = Promise.resolve();

  const startOrchestrator = (): void => {
    orchestratorStarted = true;
    orchestratorDone = new Promise<void>((res, rej) => {
      let acc = '';
      let resolved = false;
      void ctx.orchestrator
        .handleUserMessage({
          chatId: ctx.chatId,
          userId: ctx.userId,
          text,
          send: async (chunk) => {
            if (chunk.delta) acc += chunk.delta;
            if (chunk.done) {
              meta = chunk.meta;
              orchestratorReply = acc.length > 0 ? acc : '(no reply)';
              // Mirror telegram.ts: run afterReply + afterTurn hooks now.
              await runAfterReplies(ctx, orchestratorReply);
              if (chunk.meta?.afterTurn) {
                await runAfterTurns(ctx, {
                  ...chunk.meta.afterTurn,
                  assistantText: orchestratorReply,
                  finishedAt: Date.now(),
                });
              }
              if (!resolved) {
                resolved = true;
                res();
              }
            }
          },
        })
        .catch((e) => {
          if (!resolved) {
            resolved = true;
            rej(e);
          }
        });
    });
  };

  const intercepts = ctx.loader.intercepts();
  let i = 0;
  const runNext = async (): Promise<void> => {
    const item = intercepts[i++];
    if (!item) {
      startOrchestrator();
      return;
    }
    const ictx: TelegramInterceptContext = {
      chatId: ctx.chatId,
      userId: ctx.userId,
      text,
      args: text,
      reply: async (t) => {
        interceptReplies.push(t);
        await runAfterReplies(ctx, t);
      },
      next: runNext,
    };
    try {
      await item.handler(ictx);
    } catch (e) {
      ctx.log.warn('intercept failed', {
        ext: item.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await runNext();
  if (orchestratorStarted) await orchestratorDone;

  return { interceptReplies, orchestratorReply, meta };
}

async function runAfterReplies(ctx: RunnerCtx, reply: string): Promise<void> {
  if (!reply || reply === '(no reply)') return;
  const hooks = ctx.loader.afterReplies();
  for (const h of hooks) {
    try {
      await h.handler({
        chatId: ctx.chatId,
        userId: ctx.userId,
        text: reply,
        log: ctx.log.child({ ext: h.extension, hook: 'afterReply' }),
      });
    } catch (e) {
      ctx.log.warn('afterReply hook failed', {
        ext: h.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function runAfterTurns(ctx: RunnerCtx, turn: AfterTurnContext): Promise<void> {
  const hooks = ctx.loader.afterTurns();
  for (const h of hooks) {
    try {
      await h.handler(turn);
    } catch (e) {
      ctx.log.warn('afterTurn hook failed', {
        ext: h.extension,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function dispatchSlash(rawText: string, ctx: RunnerCtx): Promise<string> {
  const t = rawText.trim();
  if (!t.startsWith('/')) {
    throw new Error(`slash test message must start with '/': ${rawText}`);
  }
  const space = t.indexOf(' ');
  const head = (space === -1 ? t.slice(1) : t.slice(1, space)).split('@')[0]!;
  const args = space === -1 ? '' : t.slice(space + 1).trim();

  switch (head) {
    case 'devmode': {
      const a = args.toLowerCase();
      if (a !== 'on' && a !== 'off') return 'Usage: /devmode on|off';
      setDevmode(ctx, a === 'on');
      return `devmode ${a}`;
    }
    case 'newchat':
      ctx.orchestrator.newChat(ctx.chatId);
      return 'Conversation reset.';
    case 'stop':
      return ctx.orchestrator.stop(ctx.chatId) ? 'Stopped.' : 'Nothing to stop.';
    case 'status':
      return await statusText(ctx);
    case 'model':
      return modelText(ctx);
    case 'help':
      return buildTelegramHelp({
        extensions: collectExtensionReadiness(ctx.extensionsRoots, ctx.db),
        extensionCommands: ctx.loader.commands(),
      });
    case 'lasterror': {
      const e = ctx.orchestrator.lastError(ctx.chatId);
      return e ? `Last error: ${e}` : 'No recent errors.';
    }
    case 'extensions':
      return formatExtensionsText(collectExtensionReadiness(ctx.extensionsRoots, ctx.db));
    case 'quiet':
      return handleQuiet(ctx.prefs, ctx.chatId, args);
    case 'proactive':
      return formatProactiveText([...ctx.scheduler.list()], ctx.prefs, ctx.chatId);
    case 'nudges':
      return handleNudges(ctx.db, ctx.chatId);
    case 'why':
      return handleWhy(ctx.db, ctx.chatId);
    case 'doctor':
      return await collectDoctorReply();
    case 'logs': {
      const n = args ? Math.max(1, Math.min(200, Number.parseInt(args, 10) || 30)) : 30;
      return handleLogs({ file: ctx.logPath, lines: n });
    }
    case 'followups':
      return formatPendingFollowups(ctx.followups.listPending(ctx.chatId));
    case 'followup_cancel':
      return handleFollowupCancel(ctx.followups, ctx.chatId, args);
    case 'followup_clear':
      return handleFollowupClear(ctx.followups, ctx.chatId);
  }

  const extCmd = ctx.loader.commands().find((c) => c.name === head);
  if (!extCmd) return `Unknown command: /${head}`;
  const replies: string[] = [];
  const cctx: TelegramCommandContext = {
    chatId: ctx.chatId,
    userId: ctx.userId,
    args,
    reply: async (txt) => {
      replies.push(txt);
    },
  };
  try {
    await extCmd.handler(cctx);
  } catch (e) {
    return `Command /${head} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return replies.join('\n\n');
}

// ── small helpers ────────────────────────────────────────────────────────────

function setDevmode(ctx: RunnerCtx, on: boolean): void {
  ctx.db
    .prepare(
      `INSERT INTO telegram_chats (chat_id, user_id, devmode, last_seen_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET devmode = excluded.devmode, last_seen_at = excluded.last_seen_at`,
    )
    .run(ctx.chatId, on ? 1 : 0, Date.now());
}

async function statusText(ctx: RunnerCtx): Promise<string> {
  const health = await ctx.llm.health();
  const exts = collectExtensionReadiness(ctx.extensionsRoots, ctx.db);
  return [
    `llm: ${health.ok ? 'ok' : 'down'} (${health.models.length} models)`,
    `tools: ${ctx.tools.list().length}`,
    `extensions: ${exts.length === 0 ? 'none' : exts.map((e) => e.name).join(', ')}`,
  ].join('\n');
}

function modelText(ctx: RunnerCtx): string {
  const profiles = ctx.llm.listProfiles();
  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(profiles)) {
    lines.push(
      cfg ? `${name}: ${cfg.model} (ctx ${cfg.contextTokens})` : `${name}: (not configured)`,
    );
  }
  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function writeLine(s: string): void {
  process.stdout.write(s + '\n');
}

interface PartialRecord {
  interceptReplies: string[];
  reply: string;
  toolsCalled: Array<{ name: string; ok: boolean }>;
  voiceEmitted: boolean;
  elapsedMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export function makeRecord(test: TestCase, p: PartialRecord): TurnRecord {
  const base: Omit<TurnRecord, 'status' | 'notes'> = {
    test,
    interceptReplies: p.interceptReplies,
    reply: p.reply,
    toolsCalled: p.toolsCalled,
    voiceEmitted: p.voiceEmitted,
    elapsedMs: p.elapsedMs,
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.promptTokens !== undefined ? { promptTokens: p.promptTokens } : {}),
    ...(p.completionTokens !== undefined ? { completionTokens: p.completionTokens } : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
  };
  const j = judgeTest(base);
  return { ...base, status: j.status, notes: j.notes };
}

