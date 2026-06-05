import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import { createAgentScheduleStore } from './agent-schedules.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'gurney-agent-schedules-'));
}

test('agent schedules: a one-shot schedule can enqueue the same task for multiple agents', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const writer = reg.create({ name: 'writer', systemPrompt: 'write', toolAllowlist: [] });
    const critic = reg.create({ name: 'critic', systemPrompt: 'critic', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const now = Date.now();

    const schedule = store.create({
      agentIds: [writer.id, critic.id],
      prompt: 'Draft and review the note',
      nextRunAt: now - 1,
      recurrence: 'once',
    });
    const fired = store.sweepDue(
      (agentId, prompt) => reg.enqueue({ agentId, prompt }),
      new Date(now),
    );

    assert.equal(fired.length, 1);
    const tasks = reg.listTasks({ status: 'queued' });
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((t) => t.agentId).sort((a, b) => a - b),
      [writer.id, critic.id],
    );
    assert.equal(store.get(schedule.id)?.active, false);
    assert.equal(store.get(schedule.id)?.lastTaskIds.length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: recurring schedules advance after firing', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const planner = reg.create({ name: 'planner', systemPrompt: 'plan', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const first = Date.parse('2026-06-01T09:00:00Z');
    const sweepAt = Date.parse('2026-06-04T10:00:00Z');

    const schedule = store.create({
      agentIds: [planner.id],
      prompt: 'Morning planning',
      nextRunAt: first,
      recurrence: 'daily',
    });
    store.sweepDue((agentId, prompt) => reg.enqueue({ agentId, prompt }), new Date(sweepAt));

    const updated = store.get(schedule.id)!;
    assert.equal(updated.active, true);
    assert.equal(updated.nextRunAt, Date.parse('2026-06-05T09:00:00Z'));
    assert.equal(reg.listTasks({ status: 'queued' }).length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
