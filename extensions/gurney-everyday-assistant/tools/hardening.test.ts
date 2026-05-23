import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import type { Host } from '../../../src/core/extensions.js';
import { register as registerTasks } from './tasks.js';
import { register as registerReminders } from './reminders.js';
import { register as registerCalendar } from './calendar.js';

type ToolInvoke = (
  args: Record<string, unknown>,
  ctx: { chatId?: number; log: unknown; signal?: AbortSignal; userMessage?: string },
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

test('calendar_add_event defaults end when the model omits it (timed event = +1h)', async () => {
  // qwen3.5:0.8b/2b routinely call calendar_add_event without `end`. The
  // schema used to mark it required, so the validator rejected the call
  // before invoke ran and the event was never created. Now the tool fills
  // end = start + 1h so a single missed arg doesn't fail the whole turn.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-cal-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e1',
              summary: 'Camping',
              start: { dateTime: '2026-05-23T12:00:00-06:00' },
              end: { dateTime: '2026-05-23T13:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('calendar_add_event')!(
        { summary: 'Camping', start: '2026-05-23T12:00:00-06:00' },
        { log: fakeLog },
      );
      assert.match(String(result), /Added/i);
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const end = (eventBody['end'] as { dateTime?: string } | undefined)?.dateTime;
      assert.ok(end, 'end should have been filled in');
      // +1h from the start ISO above
      assert.equal(end, '2026-05-23T19:00:00.000Z');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event defaults end for all-day events (end = start)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-cal-allday-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e2',
              summary: 'Birthday',
              start: { date: '2026-05-25' },
              end: { date: '2026-05-25' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('calendar_add_event')!(
        { summary: 'Birthday', start: '2026-05-25', all_day: true },
        { log: fakeLog },
      );
      assert.match(String(result), /Added/i);
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const end = (eventBody['end'] as { date?: string } | undefined)?.date;
      assert.equal(end, '2026-05-25');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event rewrites the model start/end to match the user clock time', async () => {
  // qwen3.5:2b on "9pm to 10pm" routinely emits 20:00-21:00 or 09:00-10:00.
  // The verbatim am/pm tokens in the user message are deterministic ground
  // truth, so the tool overrides the model's ISO when they disagree.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-clock-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e3',
              summary: 'Eating pizza',
              start: { dateTime: '2026-05-30T21:00:00-06:00' },
              end: { dateTime: '2026-05-30T22:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      await tools.get('calendar_add_event')!(
        {
          summary: 'Eating pizza',
          // Model produced 09:00 AM instead of 21:00 — see the screenshot
          // that motivated this fix.
          start: '2026-05-30T09:00:00-06:00',
          end: '2026-05-30T10:00:00-06:00',
        },
        {
          log: fakeLog,
          userMessage: 'Schedule an event for may 30th for eating pizza 9pm to 10pm',
        },
      );
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const start = (eventBody['start'] as { dateTime?: string } | undefined)?.dateTime;
      const end = (eventBody['end'] as { dateTime?: string } | undefined)?.dateTime;
      assert.equal(start, '2026-05-30T21:00:00-06:00');
      assert.equal(end, '2026-05-30T22:00:00-06:00');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event leaves the start alone when no am/pm in the user message', async () => {
  // Don't second-guess a 24h clock or vague "tomorrow morning" phrasing.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-clock-noop-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e4',
              summary: 'Standup',
              start: { dateTime: '2026-05-30T09:00:00-06:00' },
              end: { dateTime: '2026-05-30T10:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      await tools.get('calendar_add_event')!(
        {
          summary: 'Standup',
          start: '2026-05-30T09:00:00-06:00',
          end: '2026-05-30T10:00:00-06:00',
        },
        { log: fakeLog, userMessage: 'Schedule a standup tomorrow morning' },
      );
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const start = (eventBody['start'] as { dateTime?: string } | undefined)?.dateTime;
      assert.equal(start, '2026-05-30T09:00:00-06:00');
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
