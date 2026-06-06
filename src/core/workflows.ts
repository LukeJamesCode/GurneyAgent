// Authored multi-agent workflows (n8n-style).
//
// A workflow is a design-time DAG of nodes a user wires on a canvas. Unlike
// agent delegation — where the model decides routing at run time via spawn_agent
// — a workflow is walked deterministically by code (workflow-runner.ts); the
// model only runs *inside* agent nodes. This module owns the definitions, the
// run/step-run rows, and graph validation. It is a thin DB layer with no
// execution logic, so the control panel can instantiate it the same way it does
// createAgentRegistry (via withDb) without pulling in the live runtime.

import type { DB } from '../storage/db.js';

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export const WORKFLOW_NODE_TYPES = [
  'trigger',
  'agent',
  'tool',
  'transform',
  'condition',
  'loop',
  'output',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  // Canvas position; persisted so the editor reopens where the user left it.
  pos: { x: number; y: number };
  // Per-type configuration (agentId/promptTemplate, tool/args, op/left/right,
  // template/as, items/bodyEntry, channel/template, mode). Validated lightly
  // here; the runner reads the fields it needs per node type.
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  // For a condition node's outgoing edges: 'true' | 'false'. Unset on a normal
  // edge (always live).
  branch?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type WorkflowRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type WorkflowStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface WorkflowDefinition {
  id: number;
  name: string;
  description: string;
  graph: WorkflowGraph;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  status: WorkflowRunStatus;
  input: string | null;
  output: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowStepRun {
  id: number;
  runId: number;
  nodeId: string;
  nodeType: string;
  status: WorkflowStepStatus;
  output: string | null;
  error: string | null;
  agentTaskId: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  graph: WorkflowGraph;
  active?: boolean;
}

export type UpdateWorkflowInput = Partial<CreateWorkflowInput>;

// ---------------------------------------------------------------------------
// Graph parsing + validation
// ---------------------------------------------------------------------------

export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowGraphError';
  }
}

// Coerce unknown JSON into a WorkflowGraph, normalising shapes but not
// asserting semantic validity (that's validateGraph). Throws only on
// structurally unusable input.
export function parseGraph(value: unknown): WorkflowGraph {
  const obj = typeof value === 'string' ? safeJson(value) : value;
  if (!obj || typeof obj !== 'object') {
    throw new WorkflowGraphError('graph must be an object');
  }
  const rawNodes = (obj as { nodes?: unknown }).nodes;
  const rawEdges = (obj as { edges?: unknown }).edges;
  if (!Array.isArray(rawNodes)) throw new WorkflowGraphError('graph.nodes must be an array');
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    throw new WorkflowGraphError('graph.edges must be an array');
  }
  const nodes: WorkflowNode[] = rawNodes.map((n, i) => {
    if (!n || typeof n !== 'object') throw new WorkflowGraphError(`node ${i} is not an object`);
    const r = n as Record<string, unknown>;
    const id = String(r['id'] ?? '').trim();
    const type = String(r['type'] ?? '').trim() as WorkflowNodeType;
    const posRaw = (r['pos'] ?? {}) as Record<string, unknown>;
    return {
      id,
      type,
      pos: { x: Number(posRaw['x']) || 0, y: Number(posRaw['y']) || 0 },
      config: (r['config'] && typeof r['config'] === 'object'
        ? (r['config'] as Record<string, unknown>)
        : {}),
    };
  });
  const edges: WorkflowEdge[] = (rawEdges ?? []).map((e, i) => {
    if (!e || typeof e !== 'object') throw new WorkflowGraphError(`edge ${i} is not an object`);
    const r = e as Record<string, unknown>;
    const edge: WorkflowEdge = { from: String(r['from'] ?? ''), to: String(r['to'] ?? '') };
    if (r['branch'] !== undefined && r['branch'] !== null) edge.branch = String(r['branch']);
    return edge;
  });
  return { nodes, edges };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new WorkflowGraphError('graph is not valid JSON');
  }
}

// Return a list of human-readable problems with the graph. Empty == valid.
// Enforces the invariants the runner relies on so a malformed graph is rejected
// at author time rather than blowing up mid-run.
export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];
  if (graph.nodes.length === 0) errors.push('workflow has no nodes');

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id) errors.push('a node is missing an id');
    else if (ids.has(n.id)) errors.push(`duplicate node id '${n.id}'`);
    else ids.add(n.id);
    if (!WORKFLOW_NODE_TYPES.includes(n.type)) {
      errors.push(`node '${n.id || '?'}' has unknown type '${n.type}'`);
    }
  }

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) errors.push('workflow needs exactly one trigger node (has none)');
  else if (triggers.length > 1) errors.push(`workflow has ${triggers.length} trigger nodes; needs exactly one`);

  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`edge references unknown source node '${e.from}'`);
    if (!ids.has(e.to)) errors.push(`edge references unknown target node '${e.to}'`);
  }

  // Cycle detection: a successful topological sort means the graph is acyclic.
  if (errors.length === 0 && hasCycle(graph)) {
    errors.push('workflow graph has a cycle; it must be a DAG');
  }
  return errors;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const out = adjacency(graph);
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=in-stack,2=done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of graph.nodes) {
    if (visit(n.id)) return true;
  }
  return false;
}

export function adjacency(graph: WorkflowGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  return out;
}

// Kahn topological order. Assumes the graph is acyclic (validateGraph rejects
// cycles before a run). Nodes unreachable from any root still appear (stable by
// insertion order) so the runner can mark them skipped.
export function topoOrder(graph: WorkflowGraph): string[] {
  const out = adjacency(graph);
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, 0);
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  // Append any node a cycle would have starved (defensive; shouldn't happen).
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n.id);
  return order;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: number;
  name: string;
  description: string;
  graph_json: string;
  active: number;
  created_at: number;
  updated_at: number;
}

function rowToWorkflow(r: WorkflowRow): WorkflowDefinition {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    graph: parseGraph(r.graph_json),
    active: r.active !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RunRow {
  id: number;
  workflow_id: number;
  status: string;
  input_json: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToRun(r: RunRow): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    status: r.status as WorkflowRunStatus,
    input: r.input_json === null ? null : extractInput(r.input_json),
    output: r.output,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// input_json is stored as { input: "..." }; surface the string for convenience.
function extractInput(json: string): string | null {
  try {
    const v = JSON.parse(json) as { input?: unknown };
    return v && typeof v.input === 'string' ? v.input : null;
  } catch {
    return null;
  }
}

interface StepRow {
  id: number;
  run_id: number;
  node_id: string;
  node_type: string;
  status: string;
  output: string | null;
  error: string | null;
  agent_task_id: number | null;
  started_at: number;
  finished_at: number | null;
}

function rowToStep(r: StepRow): WorkflowStepRun {
  return {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    nodeType: r.node_type,
    status: r.status as WorkflowStepStatus,
    output: r.output,
    error: r.error,
    agentTaskId: r.agent_task_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// ---------------------------------------------------------------------------
// WorkflowRegistry — CRUD over workflows + runs + step runs
// ---------------------------------------------------------------------------

export interface RunFilter {
  workflowId?: number;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
}

export interface WorkflowRegistry {
  create(input: CreateWorkflowInput): WorkflowDefinition;
  get(id: number): WorkflowDefinition | undefined;
  list(): WorkflowDefinition[];
  update(id: number, patch: UpdateWorkflowInput): WorkflowDefinition | undefined;
  remove(id: number): boolean;

  enqueueRun(workflowId: number, input?: string | null): WorkflowRun;
  // Atomically claim the oldest queued run (UPDATE ... WHERE status='queued').
  // Returns it flipped to 'running', or undefined when none are waiting. Safe
  // across processes: only one caller wins a given row.
  claimNextQueuedRun(): WorkflowRun | undefined;
  getRun(id: number): WorkflowRun | undefined;
  listRuns(filter?: RunFilter): WorkflowRun[];
  updateRun(
    id: number,
    patch: Partial<Pick<WorkflowRun, 'status' | 'output' | 'error'>> & {
      startedAt?: number;
      finishedAt?: number;
    },
  ): void;

  addStepRun(input: {
    runId: number;
    nodeId: string;
    nodeType: string;
    status?: WorkflowStepStatus;
    output?: string | null;
    error?: string | null;
    agentTaskId?: number | null;
  }): WorkflowStepRun;
  updateStepRun(
    id: number,
    patch: Partial<Pick<WorkflowStepRun, 'status' | 'output' | 'error' | 'agentTaskId'>> & {
      finishedAt?: number;
    },
  ): void;
  listStepRuns(runId: number): WorkflowStepRun[];
}

export function createWorkflowRegistry(db: DB): WorkflowRegistry {
  const insertWorkflow = db.prepare(
    `INSERT INTO workflows (name, description, graph_json, active, created_at, updated_at)
     VALUES (@name, @description, @graph_json, @active, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM workflows WHERE id = ?`);
  const selectAll = db.prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`);
  const deleteById = db.prepare(`DELETE FROM workflows WHERE id = ?`);

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (workflow_id, status, input_json, created_at)
     VALUES (@workflow_id, 'queued', @input_json, @created_at)`,
  );
  const selectRunById = db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`);

  const insertStep = db.prepare(
    `INSERT INTO workflow_step_runs
       (run_id, node_id, node_type, status, output, error, agent_task_id, started_at)
     VALUES (@run_id, @node_id, @node_type, @status, @output, @error, @agent_task_id, @started_at)`,
  );
  const selectStepsByRun = db.prepare(`SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY id`);

  function get(id: number): WorkflowDefinition | undefined {
    const row = selectById.get(id) as WorkflowRow | undefined;
    return row ? rowToWorkflow(row) : undefined;
  }

  function assertValid(graph: WorkflowGraph): void {
    const errs = validateGraph(graph);
    if (errs.length) throw new WorkflowGraphError(errs.join('; '));
  }

  function create(input: CreateWorkflowInput): WorkflowDefinition {
    assertValid(input.graph);
    const now = Date.now();
    const info = insertWorkflow.run({
      name: input.name,
      description: input.description ?? '',
      graph_json: JSON.stringify(input.graph),
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function update(id: number, patch: UpdateWorkflowInput): WorkflowDefinition | undefined {
    const current = get(id);
    if (!current) return undefined;
    const next: WorkflowDefinition = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.graph !== undefined ? { graph: patch.graph } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedAt: Date.now(),
    };
    assertValid(next.graph);
    db.prepare(
      `UPDATE workflows SET name = @name, description = @description,
         graph_json = @graph_json, active = @active, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      name: next.name,
      description: next.description,
      graph_json: JSON.stringify(next.graph),
      active: next.active ? 1 : 0,
      updated_at: next.updatedAt,
    });
    return get(id);
  }

  function remove(id: number): boolean {
    return deleteById.run(id).changes > 0;
  }

  function getRun(id: number): WorkflowRun | undefined {
    const row = selectRunById.get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  function enqueueRun(workflowId: number, input?: string | null): WorkflowRun {
    const info = insertRun.run({
      workflow_id: workflowId,
      input_json: input == null ? null : JSON.stringify({ input }),
      created_at: Date.now(),
    });
    return getRun(Number(info.lastInsertRowid))!;
  }

  // Atomic claim: flip exactly one queued row to running and return it. The
  // UPDATE ... WHERE id = (SELECT ... LIMIT 1) AND status='queued' guard means
  // a concurrent caller (or a second daemon) can't grab the same row.
  const claimStmt = db.prepare(
    `UPDATE workflow_runs SET status = 'running', started_at = @now
       WHERE id = (SELECT id FROM workflow_runs WHERE status = 'queued' ORDER BY id LIMIT 1)
         AND status = 'queued'
     RETURNING id`,
  );
  function claimNextQueuedRun(): WorkflowRun | undefined {
    const row = claimStmt.get({ now: Date.now() }) as { id: number } | undefined;
    return row ? getRun(row.id) : undefined;
  }

  function listRuns(filter: RunFilter = {}): WorkflowRun[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.workflowId !== undefined) {
      where.push('workflow_id = ?');
      params.push(filter.workflowId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    const rows = db
      .prepare(`SELECT * FROM workflow_runs ${clause} ORDER BY id DESC ${limit}`)
      .all(...params) as RunRow[];
    return rows.map(rowToRun);
  }

  function updateRun(
    id: number,
    patch: Partial<Pick<WorkflowRun, 'status' | 'output' | 'error'>> & {
      startedAt?: number;
      finishedAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.output !== undefined) add('output', 'output', patch.output);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.startedAt !== undefined) add('started_at', 'started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  function addStepRun(input: {
    runId: number;
    nodeId: string;
    nodeType: string;
    status?: WorkflowStepStatus;
    output?: string | null;
    error?: string | null;
    agentTaskId?: number | null;
  }): WorkflowStepRun {
    const info = insertStep.run({
      run_id: input.runId,
      node_id: input.nodeId,
      node_type: input.nodeType,
      status: input.status ?? 'running',
      output: input.output ?? null,
      error: input.error ?? null,
      agent_task_id: input.agentTaskId ?? null,
      started_at: Date.now(),
    });
    const row = db
      .prepare(`SELECT * FROM workflow_step_runs WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as StepRow;
    return rowToStep(row);
  }

  function updateStepRun(
    id: number,
    patch: Partial<Pick<WorkflowStepRun, 'status' | 'output' | 'error' | 'agentTaskId'>> & {
      finishedAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.output !== undefined) add('output', 'output', patch.output);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.agentTaskId !== undefined) add('agent_task_id', 'agent_task_id', patch.agentTaskId);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    db.prepare(`UPDATE workflow_step_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  return {
    create,
    get,
    list: () => (selectAll.all() as WorkflowRow[]).map(rowToWorkflow),
    update,
    remove,
    enqueueRun,
    claimNextQueuedRun,
    getRun,
    listRuns,
    updateRun,
    addStepRun,
    updateStepRun,
    listStepRuns: (runId: number) => (selectStepsByRun.all(runId) as StepRow[]).map(rowToStep),
  };
}
