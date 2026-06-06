import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import {
  createWorkflowRegistry,
  validateGraph,
  topoOrder,
  parseGraph,
  WorkflowGraphError,
  type WorkflowGraph,
} from './workflows.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'gurney-workflows-'));
}

// A minimal valid linear graph: trigger -> transform -> output.
function linearGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: { mode: 'manual' } },
      {
        id: 'm1',
        type: 'transform',
        pos: { x: 1, y: 0 },
        config: { template: 'Hi {{trigger.input}}', as: 'text' },
      },
      { id: 'o1', type: 'output', pos: { x: 2, y: 0 }, config: { channel: 'none', template: '{{steps.m1.text}}' } },
    ],
    edges: [
      { from: 't1', to: 'm1' },
      { from: 'm1', to: 'o1' },
    ],
  };
}

test('validateGraph accepts a well-formed DAG', () => {
  assert.deepEqual(validateGraph(linearGraph()), []);
});

test('validateGraph rejects duplicate node ids', () => {
  const g = linearGraph();
  g.nodes[1]!.id = 't1';
  const errs = validateGraph(g);
  assert.ok(errs.some((e) => e.includes("duplicate node id 't1'")));
});

test('validateGraph requires exactly one trigger', () => {
  const none: WorkflowGraph = { nodes: [{ id: 'm', type: 'transform', pos: { x: 0, y: 0 }, config: {} }], edges: [] };
  assert.ok(validateGraph(none).some((e) => e.includes('trigger')));

  const two = linearGraph();
  two.nodes.push({ id: 't2', type: 'trigger', pos: { x: 0, y: 1 }, config: {} });
  assert.ok(validateGraph(two).some((e) => e.includes('2 trigger')));
});

test('validateGraph rejects edges to unknown nodes', () => {
  const g = linearGraph();
  g.edges.push({ from: 'o1', to: 'ghost' });
  assert.ok(validateGraph(g).some((e) => e.includes("unknown target node 'ghost'")));
});

test('validateGraph rejects cycles — a workflow must be a DAG', () => {
  // Why: the runner walks the graph once in topo order; a cycle would either
  // loop forever or silently drop nodes. Reject it at author time.
  const g = linearGraph();
  g.edges.push({ from: 'o1', to: 't1' });
  assert.ok(validateGraph(g).some((e) => e.includes('cycle')));
});

test('topoOrder returns dependencies before dependents', () => {
  const order = topoOrder(linearGraph());
  assert.ok(order.indexOf('t1') < order.indexOf('m1'));
  assert.ok(order.indexOf('m1') < order.indexOf('o1'));
});

test('parseGraph throws WorkflowGraphError on malformed JSON', () => {
  assert.throws(() => parseGraph('{not json'), WorkflowGraphError);
});

test('registry create validates and round-trips the graph', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 't.db'), log: silentLogger() });
    const reg = createWorkflowRegistry(db);
    const wf = reg.create({ name: 'demo', graph: linearGraph() });
    assert.equal(wf.name, 'demo');
    assert.equal(wf.graph.nodes.length, 3);
    const fetched = reg.get(wf.id);
    assert.deepEqual(fetched?.graph, linearGraph());
    // Invalid graph is rejected on write.
    const bad = linearGraph();
    bad.nodes = bad.nodes.filter((n) => n.type !== 'trigger');
    assert.throws(() => reg.create({ name: 'bad', graph: bad }), WorkflowGraphError);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimNextQueuedRun hands each queued run to exactly one caller', () => {
  // Why: panel and daemon are separate processes; double-claiming a run would
  // execute it twice. The atomic UPDATE...WHERE status='queued' must serialise.
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 't.db'), log: silentLogger() });
    const reg = createWorkflowRegistry(db);
    const wf = reg.create({ name: 'demo', graph: linearGraph() });
    const r1 = reg.enqueueRun(wf.id, 'a');
    const r2 = reg.enqueueRun(wf.id, 'b');
    const c1 = reg.claimNextQueuedRun();
    const c2 = reg.claimNextQueuedRun();
    const c3 = reg.claimNextQueuedRun();
    assert.ok(c1 && c2);
    assert.notEqual(c1.id, c2.id);
    assert.deepEqual([c1.id, c2.id].sort(), [r1.id, r2.id].sort());
    assert.equal(c1.status, 'running');
    assert.equal(c3, undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
