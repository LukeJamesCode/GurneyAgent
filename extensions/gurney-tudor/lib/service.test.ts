import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type {
  ChatChunk,
  ChatOptions,
  LLM,
  ProfileConfig,
  ProfileName,
} from '../../../src/core/llm.js';
import type { DB } from '../../../src/storage/db.js';
import { createLogger } from '../../../src/util/log.js';
import { cancelCourse, snapshot, startCourse, type TudorCtx } from './service.js';
import * as store from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const STOPPED_MESSAGE = 'Generation stopped by user.';
const OUTLINE = 'TITLE: Tides\nMODULE: Gravity\nSUMMARY: Basics\n- Pull of the moon';

function freshDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return db as unknown as DB;
}

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

class FakeLLM implements LLM {
  calls: ChatOptions[] = [];
  private readonly profile: ProfileConfig = {
    model: 'qwen3.5:0.8b',
    contextTokens: 4096,
    heavy: false,
  };
  private readonly started: Array<() => void> = [];
  private readonly startWaiters: Array<() => void> = [];

  constructor(private readonly scripts: Array<'outline' | 'block'>) {}

  async waitForCall(count: number): Promise<void> {
    if (this.started.length >= count) return;
    await new Promise<void>((resolve) => this.startWaiters.push(resolve));
    if (this.started.length < count) await this.waitForCall(count);
  }

  chat(opts: ChatOptions): AsyncIterable<ChatChunk> {
    this.calls.push(opts);
    const script = this.scripts.shift() ?? 'block';
    this.started.push(() => {});
    for (const resolve of this.startWaiters.splice(0)) resolve();

    return (async function* () {
      if (script === 'outline') {
        yield { delta: OUTLINE, done: false };
        yield { delta: '', done: true };
        return;
      }

      await new Promise<never>((_, reject) => {
        if (!opts.signal) {
          reject(new Error('expected AbortSignal'));
          return;
        }
        const rejectAbort = () => {
          reject(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error('aborted'));
        };
        if (opts.signal.aborted) {
          rejectAbort();
          return;
        }
        opts.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    })();
  }

  health() {
    return Promise.resolve({ ok: true, models: [this.profile.model] });
  }

  listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return { chat: this.profile, reason: null, tools: null };
  }

  resolveModel(): string {
    return this.profile.model;
  }

  breakerSnapshot() {
    return {
      state: 'closed' as const,
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    };
  }

  stopIdleEviction(): void {}
}

function makeCtx(llm: LLM): TudorCtx {
  return { db: freshDb(), llm, log: silentLogger() };
}

test('cancelCourse aborts the active outline stream and keeps the course stopped', async () => {
  const llm = new FakeLLM(['block']);
  const ctx = makeCtx(llm);
  const id = startCourse(ctx, { topic: 'tides', depth: 'quick', generator: 'local' });

  await llm.waitForCall(1);
  cancelCourse(ctx, id);

  assert.equal(llm.calls[0]!.signal?.aborted, true);
  await waitFor(() => snapshot(ctx, id)?.active === false, 'outline job to settle');

  const course = store.getCourse(ctx.db, id);
  const job = store.getJob(ctx.db, id);
  assert.equal(course?.status, 'failed');
  assert.equal(job?.error, STOPPED_MESSAGE);
  assert.equal(store.getCourseTree(ctx.db, id)?.modules.length, 0);
});

test('cancelCourse aborts the active lesson stream and does not mark the course ready', async () => {
  const llm = new FakeLLM(['outline', 'block']);
  const ctx = makeCtx(llm);
  const id = startCourse(ctx, { topic: 'tides', depth: 'quick', generator: 'local' });

  await llm.waitForCall(2);
  cancelCourse(ctx, id);

  assert.equal(llm.calls[1]!.signal?.aborted, true);
  await waitFor(() => snapshot(ctx, id)?.active === false, 'lesson job to settle');

  const course = store.getCourse(ctx.db, id);
  const job = store.getJob(ctx.db, id);
  const tree = store.getCourseTree(ctx.db, id);
  assert.equal(course?.status, 'failed');
  assert.equal(job?.error, STOPPED_MESSAGE);
  assert.equal(tree?.modules.length, 1);
  assert.equal(tree?.modules[0]?.lessons[0]?.status, 'generating');
});
