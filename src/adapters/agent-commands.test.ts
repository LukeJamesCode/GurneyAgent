import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from '../core/agents.js';
import { formatAgentList, handleDispatch } from './agent-commands.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'gurney-agentcmd-'));
}

test('/agents: lists personas, or guides the user when there are none', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    assert.match(formatAgentList(reg), /No agents defined/);

    reg.create({ name: 'planner', role: 'plans', systemPrompt: 'x', profile: 'reason', canDelegate: true });
    const out = formatAgentList(reg);
    assert.match(out, /planner — plans \(reason\)/);
    assert.match(out, /delegates/);
    assert.match(out, /\/dispatch <agent> <task>/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/dispatch: validates input and enqueues a task for a known agent', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });

    // Usage / error paths.
    assert.match(handleDispatch(reg, undefined, ''), /Usage/);
    assert.match(handleDispatch(reg, undefined, 'researcher'), /Usage/);
    assert.match(handleDispatch(reg, undefined, 'ghost find things'), /No agent named 'ghost'/);

    // Happy path: the rest of the line becomes the task prompt.
    const reply = handleDispatch(reg, undefined, 'researcher  find the population of Mars ');
    assert.match(reply, /Dispatched task #\d+ to researcher/);
    const tasks = reg.listTasks({ agentId: agent.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prompt, 'find the population of Mars');
    assert.equal(tasks[0]!.status, 'queued');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
