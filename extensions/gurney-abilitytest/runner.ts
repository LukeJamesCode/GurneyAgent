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

import {
  createCalendarClient,
  type CalendarClient,
  type CalendarCredentials,
} from '../gurney-everyday-assistant/api/calendar.js';
import {
  createTasksClient,
  type TasksClient,
  type TasksCredentials,
} from '../gurney-everyday-assistant/api/tasks.js';

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
      numPredict: 1024,
      keepAlive: '10m',
    };
  }

  const llm = createOllama({ baseUrl: cfg.ollama.url, profiles, log });
  // Auto-confirm any `tier: 'confirm'` tool call in the test runner — in real
  // Telegram the user taps a button; here there's no user, so without this
  // every confirm-tier call would fail with "not confirmed" and tests like
  // `cal.delete.std` would never reflect whether the model routed correctly.
  const tools = createToolRegistry({
    log,
    confirm: async () => true,
  });
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

  const baseline = await captureBaseline(ctx);

  // Pre-warm both LLM profiles before timed tests begin. Without this the
  // first chat-only turn and the first tool turn each pay a 30–60s cold-load
  // tax that bleeds into the wall time of whichever test happens to be first
  // (last run: chat.plain.std1 99s, followup.create.full 96s). The warmup
  // sends a 1-token completion through each profile so Ollama keeps them
  // resident through the rest of the suite.
  await preWarm(ctx, profiles);

  writeLine('');
  writeLine('══ Gurney ability test ══════════════════════════════════════════════════════');
  writeLine(
    `tier: ${opts.tier} · ${tests.length} tests · started ${new Date(startedAt).toISOString()}`,
  );
  writeLine(
    `chat: ${chatId} · cleanup ON — reminders, followups, tasks, events created during this run will be deleted at the end`,
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

  await cleanup(ctx, baseline);

  await teardown(ctx);
}

// ── pre-warm ───────────────────────────────────────────────────────────────

async function preWarm(
  ctx: RunnerCtx,
  profiles: Partial<Record<ProfileName, ProfileConfig | null>>,
): Promise<void> {
  const names = (Object.keys(profiles) as ProfileName[]).filter((n) => profiles[n]);
  const tStart = Date.now();
  writeLine(`pre-warming ${names.length} model profile(s): ${names.join(', ')}…`);
  for (const name of names) {
    try {
      const stream = ctx.llm.chat({
        profile: name,
        messages: [
          { role: 'system', content: 'You are warming up.' },
          { role: 'user', content: 'ping' },
        ],
        maxTokens: 1,
      });
      // Drain to completion so the model load actually finishes before we
      // return — without consuming the stream Ollama may not have loaded yet.
      for await (const _chunk of stream) {
        void _chunk;
      }
    } catch (e) {
      ctx.log.warn('pre-warm failed', {
        profile: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  writeLine(`pre-warm done in ${Math.round((Date.now() - tStart) / 1000)}s`);
}

// ── cleanup ─────────────────────────────────────────────────────────────────
//
// The runner exercises real tools against real Google accounts and the local
// SQLite db. Without cleanup, every run leaves duplicate "Buy milk" tasks,
// half a dozen "Camping" events and orphan reminders behind — which then
// poisons the next run (the model gets "matches multiple tasks" on every
// complete, the calendar listing fills with junk, etc.).
//
// Strategy: snapshot pre-existing artifact ids before the test loop runs,
// then after the loop, delete everything created since. Pre-existing junk
// is left alone — the runner only cleans up what THIS run added.

interface Baseline {
  reminderMaxId: number;
  followupMaxId: number;
  routineMaxId: number;
  smartLinks: Set<string>;
  calClient: CalendarClient | null;
  tasksClient: TasksClient | null;
  calendarEventIds: Set<string>;
  taskIds: Set<string>;
  prefs: {
    quietStartMinute: number | null;
    quietEndMinute: number | null;
    pausedUntilMs: number | null;
  };
}

function readAssistantCreds(ctx: RunnerCtx): {
  calendar: CalendarCredentials | null;
  tasks: TasksCredentials | null;
} {
  const rows = ctx.db
    .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
    .all('gurney-everyday-assistant') as Array<{ key: string; value: string }>;
  const s = new Map(rows.map((r) => [r.key, r.value]));
  const id = s.get('google_client_id');
  const secret = s.get('google_client_secret');
  const refresh = s.get('google_refresh_token');
  if (!id || !secret || !refresh) return { calendar: null, tasks: null };
  return {
    calendar: {
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      calendar_id: s.get('calendar_id') ?? 'primary',
    },
    tasks: {
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      default_tasklist: s.get('default_tasklist') ?? '@default',
    },
  };
}

function cleanupWindow(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const end = new Date(now);
  end.setDate(end.getDate() + 90);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function captureBaseline(ctx: RunnerCtx): Promise<Baseline> {
  const reminderMaxId = pickMaxId(ctx, 'reminders', ctx.chatId);
  const followupMaxId = pickMaxId(ctx, 'followups', ctx.chatId);
  const routineMaxId = pickRoutineMaxId(ctx);

  const smartLinks = new Set<string>();
  try {
    const rows = ctx.db
      .prepare(`SELECT task_id, event_id FROM smart_scheduled_links`)
      .all() as Array<{ task_id: string; event_id: string }>;
    for (const r of rows) smartLinks.add(`${r.task_id}|${r.event_id}`);
  } catch {
    /* table may not exist on a partial install */
  }

  const creds = readAssistantCreds(ctx);
  let calClient: CalendarClient | null = null;
  let tasksClient: TasksClient | null = null;
  const calendarEventIds = new Set<string>();
  const taskIds = new Set<string>();

  if (creds.calendar) {
    try {
      calClient = createCalendarClient({ creds: creds.calendar });
      const events = await calClient.listEvents({ ...cleanupWindow(), max: 2500 });
      for (const ev of events) calendarEventIds.add(ev.id);
    } catch (e) {
      ctx.log.warn('baseline: calendar snapshot failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      calClient = null;
    }
  }

  if (creds.tasks) {
    try {
      tasksClient = createTasksClient({ creds: creds.tasks });
      const tasks = await tasksClient.listTasks(true);
      for (const t of tasks) taskIds.add(t.id);
    } catch (e) {
      ctx.log.warn('baseline: tasks snapshot failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      tasksClient = null;
    }
  }

  const p = ctx.prefs.get(ctx.chatId);
  const prefs = {
    quietStartMinute: p.quietStartMinute,
    quietEndMinute: p.quietEndMinute,
    pausedUntilMs: p.pausedUntilMs,
  };

  return {
    reminderMaxId,
    followupMaxId,
    routineMaxId,
    smartLinks,
    calClient,
    tasksClient,
    calendarEventIds,
    taskIds,
    prefs,
  };
}

function pickMaxId(ctx: RunnerCtx, table: 'reminders' | 'followups', chatId: number): number {
  try {
    const row = ctx.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table} WHERE chat_id = ?`)
      .get(chatId) as { m: number } | undefined;
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

function pickRoutineMaxId(ctx: RunnerCtx): number {
  try {
    const row = ctx.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM routine_rules WHERE chat_id = ?`)
      .get(ctx.chatId) as { m: number } | undefined;
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

async function cleanup(ctx: RunnerCtx, baseline: Baseline): Promise<void> {
  const lines: string[] = ['🧹 Cleanup'];

  // Reminders
  try {
    const r = ctx.db
      .prepare(`DELETE FROM reminders WHERE chat_id = ? AND id > ?`)
      .run(ctx.chatId, baseline.reminderMaxId);
    lines.push(`  reminders deleted: ${r.changes}`);
  } catch (e) {
    lines.push(`  reminders: failed (${e instanceof Error ? e.message : String(e)})`);
  }

  // Followups
  try {
    const r = ctx.db
      .prepare(`DELETE FROM followups WHERE chat_id = ? AND id > ?`)
      .run(ctx.chatId, baseline.followupMaxId);
    lines.push(`  followups deleted: ${r.changes}`);
  } catch (e) {
    lines.push(`  followups: failed (${e instanceof Error ? e.message : String(e)})`);
  }

  // Learned routines (the runner only LISTS / DELETES, but be defensive)
  try {
    const r = ctx.db
      .prepare(`DELETE FROM routine_rules WHERE chat_id = ? AND id > ?`)
      .run(ctx.chatId, baseline.routineMaxId);
    if (r.changes > 0) lines.push(`  learned routines deleted: ${r.changes}`);
  } catch {
    /* table may not exist */
  }

  // smart_scheduled_links — also drop the calendar events they reference
  // (those will already be caught by the calendar diff below, but the link
  // rows must go regardless so the table doesn't grow unbounded).
  try {
    const rows = ctx.db
      .prepare(`SELECT task_id, event_id FROM smart_scheduled_links`)
      .all() as Array<{ task_id: string; event_id: string }>;
    let removed = 0;
    for (const r of rows) {
      const key = `${r.task_id}|${r.event_id}`;
      if (baseline.smartLinks.has(key)) continue;
      ctx.db
        .prepare(`DELETE FROM smart_scheduled_links WHERE task_id = ? AND event_id = ?`)
        .run(r.task_id, r.event_id);
      removed += 1;
    }
    if (removed > 0) lines.push(`  smart-schedule links deleted: ${removed}`);
  } catch {
    /* ignore */
  }

  // Calendar events created during the run
  if (baseline.calClient) {
    let deleted = 0;
    let failed = 0;
    try {
      const after = await baseline.calClient.listEvents({ ...cleanupWindow(), max: 2500 });
      for (const ev of after) {
        if (baseline.calendarEventIds.has(ev.id)) continue;
        try {
          await baseline.calClient.deleteEvent(ev.id);
          deleted += 1;
        } catch (e) {
          failed += 1;
          ctx.log.warn('cleanup: delete event failed', {
            id: ev.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      lines.push(
        `  calendar events deleted: ${deleted}` + (failed > 0 ? ` (${failed} failed)` : ''),
      );
    } catch (e) {
      lines.push(`  calendar: list failed (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    lines.push('  calendar: not configured — skipped');
  }

  // Tasks created during the run (default list only — that's where tasks_add writes)
  if (baseline.tasksClient) {
    let deleted = 0;
    let failed = 0;
    try {
      const after = await baseline.tasksClient.listTasks(true);
      for (const t of after) {
        if (baseline.taskIds.has(t.id)) continue;
        try {
          await baseline.tasksClient.deleteTask(t.id);
          deleted += 1;
        } catch (e) {
          failed += 1;
          ctx.log.warn('cleanup: delete task failed', {
            id: t.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      lines.push(`  tasks deleted: ${deleted}` + (failed > 0 ? ` (${failed} failed)` : ''));
    } catch (e) {
      lines.push(`  tasks: list failed (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    lines.push('  tasks: not configured — skipped');
  }

  // Quiet window / snooze prefs — restore to whatever the user had before.
  try {
    const now = ctx.prefs.get(ctx.chatId);
    let changed = 0;
    if (
      now.quietStartMinute !== baseline.prefs.quietStartMinute ||
      now.quietEndMinute !== baseline.prefs.quietEndMinute
    ) {
      ctx.prefs.setQuietWindow(
        ctx.chatId,
        baseline.prefs.quietStartMinute,
        baseline.prefs.quietEndMinute,
      );
      changed += 1;
    }
    if (now.pausedUntilMs !== baseline.prefs.pausedUntilMs) {
      ctx.prefs.setPausedUntil(ctx.chatId, baseline.prefs.pausedUntilMs);
      changed += 1;
    }
    if (changed > 0) lines.push(`  quiet/snooze prefs: restored (${changed} fields)`);
  } catch (e) {
    lines.push(`  prefs: failed (${e instanceof Error ? e.message : String(e)})`);
  }

  writeLine(lines.join('\n'));
  writeLine('');
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

