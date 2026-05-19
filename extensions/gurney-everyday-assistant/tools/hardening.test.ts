import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import type { Host } from '../../../src/core/extensions.js';
import { register as registerTasks } from './tasks.js';
import { register as registerReminders } from './reminders.js';

type ToolInvoke = (
  args: Record<string, unknown>,
  ctx: { chatId?: number; log: unknown; signal?: AbortSignal },
) => Promise<unknown>;

function registerTools(register: (host: Host) => void, host: Host): Map<string, ToolInvoke> {
  const handlers = new Map<string, ToolInvoke>();
  register({
    ...host,
    tools: {
      register(def: { name: string; invoke: ToolInvoke }) {
        handlers.set(def.name, def.invoke);
      },
    },
  } as unknown as Host);
  return handlers;
}

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeHost(db: ReturnType<typeof open>): Host {
  const settings = new Map<string, string>([
    ['google_client_id', 'cid'],
    ['google_client_secret', 'csec'],
    ['google_refresh_token', 'rtok'],
    ['default_tasklist', '@default'],
  ]);
  return {
    settings: {
      get<T>(key: string, def?: T): T | undefined {
        return (settings.get(key) as T) ?? def;
      },
      set() {},
      all: () => Object.fromEntries(settings),
    },
    db,
    telegram: { chatId: 100, defaultChatId: 100, knownChats: () => [] },
  } as unknown as Host;
}

test('tasks_add omits due when the user did not name a deadline', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-task-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerTasks, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : { id: 't1', title: 'Buy milk', status: 'needsAction' };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('tasks_add')!({ title: 'Buy milk' }, { log: fakeLog });
      assert.match(String(result), /Added/i);
      const taskBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      assert.equal(taskBody['title'], 'Buy milk');
      assert.equal('due' in taskBody, false);
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reminder_cancel is scoped to the originating chat', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-reminder-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    db.prepare(
      `CREATE TABLE reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id INTEGER NOT NULL,
         text TEXT NOT NULL,
         fire_at INTEGER NOT NULL,
         fired INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
    ).run();
    db.prepare(`INSERT INTO reminders (chat_id, text, fire_at, created_at) VALUES (?,?,?,?)`).run(
      222,
      'private',
      Date.now() + 60_000,
      Date.now(),
    );
    const host = makeHost(db);
    const tools = registerTools(registerReminders, host);
    const result = await tools.get('reminder_cancel')!({ id: 1 }, { chatId: 111, log: fakeLog });
    assert.match(String(result), /not found/i);
    const row = db.prepare(`SELECT chat_id FROM reminders WHERE id=1`).get() as
      | { chat_id: number }
      | undefined;
    assert.equal(row?.chat_id, 222);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
