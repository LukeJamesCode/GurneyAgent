// Multi-agent engine. An "agent" is a named persona: a saved bundle of
// orchestrator options (system prompt, model profile, tool allowlist, tool-
// round cap) plus an execution policy and an optional delegation grant.
//
// Running an agent reuses the normal orchestrator pipeline — the persona's
// options ARE an OrchestratorOptions, and a per-agent filtered tool registry
// scopes which tools the model can see. Each run is driven against a reserved
// "virtual" chat id so its transcript lands in conversations/messages exactly
// like a Telegram turn, inheriting every guard (hallucination scrubbing,
// per-turn schema gate, tool timeouts) for free.
//
// This module owns the agent definitions + task rows (AgentRegistry) and the
// headless runner (AgentRuntime). The resource-aware queue that decides WHEN
// to run a task is a separate concern (agent-queue.ts).

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM, ProfileName, ThinkMode } from './llm.js';
import type { ToolHandler, ToolRegistry } from './tools.js';
import { createOrchestrator, type Orchestrator, type ReplyChunk } from './orchestrator.js';

// Virtual chat ids for agent runs live in a reserved band well above any real
// Telegram user id (currently < ~8e9 and growing slowly) and far below
// Number.MAX_SAFE_INTEGER (~9.0e15). virtual_chat_id = AGENT_CHAT_ID_BASE +
// task.id keeps every run on its own conversation without colliding with chat
// surfaces. The frontend history view filters this band out so agent
// transcripts don't masquerade as user chats.
export const AGENT_CHAT_ID_BASE = 7_000_000_000_000;

export function isAgentChatId(chatId: number): boolean {
  return chatId >= AGENT_CHAT_ID_BASE;
}

// Name of the built-in delegation tool. Exposed only to agents whose
// definition has canDelegate; the main (Telegram/panel) orchestrator filters
// it out entirely. Registered by setupAgentDelegation (agent-delegation.ts).
export const SPAWN_AGENT_TOOL_NAME = 'spawn_agent';

// Name of the built-in parallel fan-out/join tool. Like spawn_agent it's
// visible only to agents whose definition has canDelegate, and filtered out of
// the main (Telegram/panel) orchestrator. Dispatches several lightweight
// workers at once and waits for all of them. Registered by
// setupAgentDelegation (agent-delegation.ts).
export const SPAWN_AGENTS_TOOL_NAME = 'spawn_agents';

// Name of the built-in approval tool. A 'confirm'-tier tool any agent may call
// to pause and ask the human to sign off on a risky step it identified itself.
// Always visible to agents (independent of their tool allowlist); filtered out
// of the main chat orchestrator. Registered by setupAgentApprovals
// (agent-approvals.ts).
export const REQUEST_APPROVAL_TOOL_NAME = 'request_approval';

// Maximum delegation depth (supervisor -> worker -> ...). A top-level task is
// depth 0; spawn_agent refuses once a child would exceed this, so a buggy
// persona can't recurse without bound.
export const MAX_DELEGATION_DEPTH = 3;
export const AGENT_TASK_CANCELLED_MESSAGE = 'Agent task cancelled by user.';

// Intersect two tool grants. null means "all tools". The result never grants
// more than either input (fail-safe): the AND of two ceilings. For two
// explicit lists it's a string-set intersection — conservative if an extension
// name and one of its tool names are split across the two, which only ever
// over-restricts.
export function intersectGrants(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const bset = new Set(b);
  return a.filter((x) => bset.has(x));
}

export type AgentExecutionMode = 'sequential' | 'parallel';
export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'paused';

export interface AgentDefinition {
  id: number;
  name: string;
  role: string;
  systemPrompt: string;
  // null = every registered tool; otherwise a list of extension names and/or
  // specific tool names the agent may call.
  toolAllowlist: string[] | null;
  profile: ProfileName;
  // Whether this agent's model reasons. 'auto' = per-model default.
  thinkMode: ThinkMode;
  maxToolRounds: number;
  // null => orchestrator default.
  budgetTokens: number | null;
  executionMode: AgentExecutionMode;
  maxConcurrency: number;
  canDelegate: boolean;
  // Agent names this agent may spawn; [] with canDelegate means "any". Ignored
  // when canDelegate is false.
  delegatableAgents: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentTask {
  id: number;
  agentId: number;
  parentId: number | null;
  prompt: string;
  status: AgentTaskStatus;
  executionMode: AgentExecutionMode;
  priority: number;
  depth: number;
  conversationId: number | null;
  virtualChatId: number | null;
  // Grant ceiling inherited from the spawning task (null = none).
  toolAllowlistOverride: string[] | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  pausedUntil: number | null;
}

export interface CreateAgentInput {
  name: string;
  role?: string;
  systemPrompt: string;
  toolAllowlist?: string[] | null;
  profile?: ProfileName;
  thinkMode?: ThinkMode;
  maxToolRounds?: number;
  budgetTokens?: number | null;
  executionMode?: AgentExecutionMode;
  maxConcurrency?: number;
  canDelegate?: boolean;
  delegatableAgents?: string[];
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'name'>> & { name?: string };

export interface EnqueueTaskInput {
  agentId: number;
  prompt: string;
  parentId?: number | null;
  executionMode?: AgentExecutionMode;
  priority?: number;
  depth?: number;
  toolAllowlistOverride?: string[] | null;
}

export interface AgentTaskFilter {
  status?: AgentTaskStatus | AgentTaskStatus[];
  agentId?: number;
  parentId?: number | null;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface AgentRow {
  id: number;
  name: string;
  role: string;
  system_prompt: string;
  tool_allowlist: string | null;
  profile: string;
  think_mode: string;
  max_tool_rounds: number;
  budget_tokens: number | null;
  execution_mode: string;
  max_concurrency: number;
  can_delegate: number;
  delegatable_agents: string;
  created_at: number;
  updated_at: number;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToAgent(r: AgentRow): AgentDefinition {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    systemPrompt: r.system_prompt,
    toolAllowlist: r.tool_allowlist === null ? null : parseStringArray(r.tool_allowlist),
    profile: r.profile as ProfileName,
    thinkMode: r.think_mode as ThinkMode,
    maxToolRounds: r.max_tool_rounds,
    budgetTokens: r.budget_tokens,
    executionMode: r.execution_mode as AgentExecutionMode,
    maxConcurrency: r.max_concurrency,
    canDelegate: r.can_delegate !== 0,
    delegatableAgents: parseStringArray(r.delegatable_agents),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface TaskRow {
  id: number;
  agent_id: number;
  parent_id: number | null;
  prompt: string;
  status: string;
  execution_mode: string;
  priority: number;
  depth: number;
  conversation_id: number | null;
  virtual_chat_id: number | null;
  tool_allowlist_override: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  paused_until: number | null;
}

function rowToTask(r: TaskRow): AgentTask {
  return {
    id: r.id,
    agentId: r.agent_id,
    parentId: r.parent_id,
    prompt: r.prompt,
    status: r.status as AgentTaskStatus,
    executionMode: r.execution_mode as AgentExecutionMode,
    priority: r.priority,
    depth: r.depth,
    conversationId: r.conversation_id,
    virtualChatId: r.virtual_chat_id,
    toolAllowlistOverride:
      r.tool_allowlist_override === null ? null : parseStringArray(r.tool_allowlist_override),
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    pausedUntil: r.paused_until ?? null,
  };
}

// ---------------------------------------------------------------------------
// AgentRegistry — CRUD over agents + agent_tasks
// ---------------------------------------------------------------------------

export interface AgentRegistry {
  create(input: CreateAgentInput): AgentDefinition;
  get(id: number): AgentDefinition | undefined;
  getByName(name: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
  update(id: number, patch: UpdateAgentInput): AgentDefinition | undefined;
  remove(id: number): boolean;

  enqueue(input: EnqueueTaskInput): AgentTask;
  getTask(id: number): AgentTask | undefined;
  listTasks(filter?: AgentTaskFilter): AgentTask[];
  // Status transitions used by the runner/queue. `patch` carries the fields
  // that change with each transition (started_at on running, result/error +
  // finished_at on terminal states, the conversation link once known).
  updateTask(
    id: number,
    patch: Partial<
      Pick<
        AgentTask,
        'status' | 'result' | 'error' | 'conversationId' | 'virtualChatId' | 'pausedUntil'
      >
    > & { startedAt?: number; finishedAt?: number },
  ): void;
}

export function createAgentRegistry(db: DB): AgentRegistry {
  const insertAgent = db.prepare(
    `INSERT INTO agents
       (name, role, system_prompt, tool_allowlist, profile, think_mode, max_tool_rounds,
        budget_tokens, execution_mode, max_concurrency, can_delegate,
        delegatable_agents, created_at, updated_at)
     VALUES (@name, @role, @system_prompt, @tool_allowlist, @profile, @think_mode, @max_tool_rounds,
             @budget_tokens, @execution_mode, @max_concurrency, @can_delegate,
             @delegatable_agents, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM agents WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM agents WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM agents ORDER BY name`);
  const deleteById = db.prepare(`DELETE FROM agents WHERE id = ?`);

  const insertTask = db.prepare(
    `INSERT INTO agent_tasks
       (agent_id, parent_id, prompt, status, execution_mode, priority, depth,
        tool_allowlist_override, created_at)
     VALUES (@agent_id, @parent_id, @prompt, 'queued', @execution_mode, @priority, @depth,
             @tool_allowlist_override, @created_at)`,
  );
  const selectTaskById = db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`);

  function get(id: number): AgentDefinition | undefined {
    const row = selectById.get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  function getByName(name: string): AgentDefinition | undefined {
    const row = selectByName.get(name) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  function create(input: CreateAgentInput): AgentDefinition {
    const now = Date.now();
    const allowlist = input.toolAllowlist === undefined ? null : input.toolAllowlist;
    const info = insertAgent.run({
      name: input.name,
      role: input.role ?? '',
      system_prompt: input.systemPrompt,
      tool_allowlist: allowlist === null ? null : JSON.stringify(allowlist),
      profile: input.profile ?? 'chat',
      think_mode: input.thinkMode ?? 'auto',
      max_tool_rounds: input.maxToolRounds ?? 4,
      budget_tokens: input.budgetTokens ?? null,
      execution_mode: input.executionMode ?? 'sequential',
      max_concurrency: input.maxConcurrency ?? 1,
      can_delegate: input.canDelegate ? 1 : 0,
      delegatable_agents: JSON.stringify(input.delegatableAgents ?? []),
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function update(id: number, patch: UpdateAgentInput): AgentDefinition | undefined {
    const current = get(id);
    if (!current) return undefined;
    const next: AgentDefinition = {
      ...current,
      ...('name' in patch && patch.name !== undefined ? { name: patch.name } : {}),
      ...('role' in patch && patch.role !== undefined ? { role: patch.role } : {}),
      ...('systemPrompt' in patch && patch.systemPrompt !== undefined
        ? { systemPrompt: patch.systemPrompt }
        : {}),
      ...('toolAllowlist' in patch ? { toolAllowlist: patch.toolAllowlist ?? null } : {}),
      ...('profile' in patch && patch.profile !== undefined ? { profile: patch.profile } : {}),
      ...('thinkMode' in patch && patch.thinkMode !== undefined
        ? { thinkMode: patch.thinkMode }
        : {}),
      ...('maxToolRounds' in patch && patch.maxToolRounds !== undefined
        ? { maxToolRounds: patch.maxToolRounds }
        : {}),
      ...('budgetTokens' in patch ? { budgetTokens: patch.budgetTokens ?? null } : {}),
      ...('executionMode' in patch && patch.executionMode !== undefined
        ? { executionMode: patch.executionMode }
        : {}),
      ...('maxConcurrency' in patch && patch.maxConcurrency !== undefined
        ? { maxConcurrency: patch.maxConcurrency }
        : {}),
      ...('canDelegate' in patch && patch.canDelegate !== undefined
        ? { canDelegate: patch.canDelegate }
        : {}),
      ...('delegatableAgents' in patch && patch.delegatableAgents !== undefined
        ? { delegatableAgents: patch.delegatableAgents }
        : {}),
      updatedAt: Date.now(),
    };
    db.prepare(
      `UPDATE agents SET
         name = @name, role = @role, system_prompt = @system_prompt,
         tool_allowlist = @tool_allowlist, profile = @profile, think_mode = @think_mode,
         max_tool_rounds = @max_tool_rounds, budget_tokens = @budget_tokens,
         execution_mode = @execution_mode, max_concurrency = @max_concurrency,
         can_delegate = @can_delegate, delegatable_agents = @delegatable_agents,
         updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      name: next.name,
      role: next.role,
      system_prompt: next.systemPrompt,
      tool_allowlist: next.toolAllowlist === null ? null : JSON.stringify(next.toolAllowlist),
      profile: next.profile,
      think_mode: next.thinkMode,
      max_tool_rounds: next.maxToolRounds,
      budget_tokens: next.budgetTokens,
      execution_mode: next.executionMode,
      max_concurrency: next.maxConcurrency,
      can_delegate: next.canDelegate ? 1 : 0,
      delegatable_agents: JSON.stringify(next.delegatableAgents),
      updated_at: next.updatedAt,
    });
    return get(id);
  }

  function remove(id: number): boolean {
    return deleteById.run(id).changes > 0;
  }

  function enqueue(input: EnqueueTaskInput): AgentTask {
    const override = input.toolAllowlistOverride;
    const info = insertTask.run({
      agent_id: input.agentId,
      parent_id: input.parentId ?? null,
      prompt: input.prompt,
      execution_mode: input.executionMode ?? 'sequential',
      priority: input.priority ?? 0,
      depth: input.depth ?? 0,
      tool_allowlist_override:
        override === undefined || override === null ? null : JSON.stringify(override),
      created_at: Date.now(),
    });
    return getTask(Number(info.lastInsertRowid))!;
  }

  function getTask(id: number): AgentTask | undefined {
    const row = selectTaskById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  function listTasks(filter: AgentTaskFilter = {}): AgentTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.parentId !== undefined) {
      if (filter.parentId === null) {
        where.push('parent_id IS NULL');
      } else {
        where.push('parent_id = ?');
        params.push(filter.parentId);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    const rows = db
      .prepare(`SELECT * FROM agent_tasks ${clause} ORDER BY id DESC ${limit}`)
      .all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  function updateTask(
    id: number,
    patch: Partial<
      Pick<
        AgentTask,
        'status' | 'result' | 'error' | 'conversationId' | 'virtualChatId' | 'pausedUntil'
      >
    > & { startedAt?: number; finishedAt?: number },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.result !== undefined) add('result', 'result', patch.result);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.conversationId !== undefined)
      add('conversation_id', 'conversation_id', patch.conversationId);
    if (patch.virtualChatId !== undefined)
      add('virtual_chat_id', 'virtual_chat_id', patch.virtualChatId);
    if (patch.startedAt !== undefined) add('started_at', 'started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (patch.pausedUntil !== undefined) add('paused_until', 'paused_until', patch.pausedUntil);
    if (sets.length === 0) return;
    db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  return {
    create,
    get,
    getByName,
    list: () => (selectAll.all() as AgentRow[]).map(rowToAgent),
    update,
    remove,
    enqueue,
    getTask,
    listTasks,
    updateTask,
  };
}

// Seed a small, useful starter fleet on a fresh install (no-op if any agent
// already exists, so deleting them sticks). These demonstrate the two ways
// small models get to quality: a sparing heavy Planner that decomposes and
// delegates, and cheap tiny-model workers each kept to a narrow job.
export function seedStarterAgents(registry: AgentRegistry): void {
  const existing = registry.list();
  if (registry.getByName('orchestrator')) return;
  if (existing.length > 0) {
    registry.create({
      name: 'orchestrator',
      role: 'Coordinates any task across the available agent fleet',
      systemPrompt:
        'You are the Orchestrator. For any user task, decide whether to answer directly or break it ' +
        'into concrete subtasks. Use spawn_agent to delegate to the best available agents from your ' +
        'current roster, wait for their results when synthesis matters, then return one clear final answer. ' +
        'Keep the plan lean and avoid spawning agents for trivial work.',
      profile: 'reason',
      toolAllowlist: [],
      executionMode: 'sequential',
      maxToolRounds: 8,
      canDelegate: true,
      delegatableAgents: [],
    });
    return;
  }
  registry.create({
    name: 'orchestrator',
    role: 'Coordinates any task across the available agent fleet',
    systemPrompt:
      'You are the Orchestrator. For any user task, decide whether to answer directly or break it ' +
      'into concrete subtasks. Use spawn_agent to delegate to the best available agents from your ' +
      'current roster, wait for their results when synthesis matters, then return one clear final answer. ' +
      'Keep the plan lean and avoid spawning agents for trivial work.',
    profile: 'reason',
    toolAllowlist: [],
    executionMode: 'sequential',
    maxToolRounds: 8,
    canDelegate: true,
    delegatableAgents: [],
  });
  registry.create({
    name: 'researcher',
    role: 'Gathers facts using available tools',
    systemPrompt:
      'You are a focused research agent. Use the available tools to gather the facts you need, ' +
      'then report them concisely. Do not speculate beyond what the tools return.',
    profile: 'tools',
    toolAllowlist: null,
    executionMode: 'parallel',
    maxConcurrency: 2,
  });
  registry.create({
    name: 'writer',
    role: 'Drafts clear prose from notes',
    systemPrompt:
      'You are a writing agent. Turn the provided notes into clear, concise prose. ' +
      'No tools — just write.',
    profile: 'chat',
    toolAllowlist: [],
  });
  registry.create({
    name: 'critic',
    role: 'Reviews and tightens a draft',
    systemPrompt:
      'You are a critic. Review the provided draft for clarity, accuracy, and concision, ' +
      'then return an improved version. Be specific about what you changed.',
    profile: 'chat',
    toolAllowlist: [],
  });
}

// ---------------------------------------------------------------------------
// Filtered tool-registry view
// ---------------------------------------------------------------------------

// Predicate from an allowlist: an entry matches a tool by its own name or by
// the name of the extension that registered it. null = allow everything.
export function agentToolPredicate(allowlist: string[] | null): (h: ToolHandler) => boolean {
  if (allowlist === null) return () => true;
  const set = new Set(allowlist);
  return (h) => set.has(h.name) || (h.extension !== undefined && set.has(h.extension));
}

// A read-through ToolRegistry that only exposes handlers the predicate admits.
// list/get/schemas/schemasFor are narrowed; execute fails closed on a hidden
// tool (defense in depth — the orchestrator's per-turn gate already blocks
// out-of-manifest names, but a delegated worker must never reach a tool
// outside its grant even via a forced/auto-routed call). register/unregister/
// onAfterExecute delegate straight through to the base registry.
export function filterToolRegistry(
  base: ToolRegistry,
  predicate: (h: ToolHandler) => boolean,
): ToolRegistry {
  const visibleNames = (): Set<string> =>
    new Set(
      base
        .list()
        .filter(predicate)
        .map((h) => h.name),
    );
  return {
    register: (h) => base.register(h),
    unregister: (n) => base.unregister(n),
    list: () => base.list().filter(predicate),
    get: (name) => {
      const h = base.get(name);
      return h && predicate(h) ? h : undefined;
    },
    schemas: () => {
      const names = visibleNames();
      return base.schemas().filter((s) => names.has(s.function.name));
    },
    schemasFor: (extensionNames, inputText) => {
      const names = visibleNames();
      return base.schemasFor(extensionNames, inputText).filter((s) => names.has(s.function.name));
    },
    execute: async (call, ctx) => {
      const h = base.get(call.name);
      if (!h || !predicate(h)) {
        return { call, ok: false, output: `tool '${call.name}' is not available to this agent` };
      }
      return base.execute(call, ctx);
    },
    onAfterExecute: (n, l) => base.onAfterExecute(n, l),
  };
}

// ---------------------------------------------------------------------------
// AgentRuntime — headless execution of a task through the orchestrator
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  db: DB;
  llm: LLM;
  // Base registry holding every registered tool. Each agent gets a filtered
  // view of this.
  tools: ToolRegistry;
  log: Logger;
  registry: AgentRegistry;
  // User id stamped on the agent's conversation row (telegram_chats.user_id is
  // NOT NULL). The bot owner's id; tests pass any number.
  ownerUserId: number;
  // Maximum number of tokens allowed for the agent's prompt context.
  budgetTokens?: number;
  // Maximum number of characters of a tool's output to inject into context.
  toolResultMaxChars?: number;
}

export interface RunResult {
  ok: boolean;
  text: string;
  error?: string;
  conversationId: number;
}

export interface AgentRuntime {
  // Run a queued task to completion. Marks it running, drives the orchestrator,
  // persists result/error + the conversation link, returns the outcome.
  runTask(taskId: number, opts?: { onDelta?: (delta: string) => void }): Promise<RunResult>;
  // Best-effort cancellation for a queued or running task. Running tasks abort
  // their active orchestrator turn; queued tasks are marked terminal.
  cancelTask(taskId: number): boolean;
  shutdown(): Promise<void>;
}

export function createAgentRuntime(opts: AgentRuntimeOptions): AgentRuntime {
  const log = opts.log.child({ mod: 'agent-runtime' });
  // One orchestrator per agent definition, rebuilt when the definition changes
  // (keyed by updatedAt). The expensive resources — db, llm, base tool
  // registry — are shared singletons; an orchestrator is a thin wrapper.
  const cache = new Map<number, { cacheKey: string; orch: Orchestrator }>();
  const active = new Map<number, { orch: Orchestrator; virtualChatId: number }>();

  // Build the tool-visibility predicate for an agent. The delegation tool is
  // visible iff the agent may delegate (independent of its allowlist); an
  // optional grant ceiling (from a spawning task) is ANDed on top.
  function agentPredicate(
    agent: AgentDefinition,
    override: string[] | null,
  ): (h: ToolHandler) => boolean {
    const own = agentToolPredicate(agent.toolAllowlist);
    const ceiling = agentToolPredicate(override);
    return (h) => {
      if (h.name === SPAWN_AGENT_TOOL_NAME || h.name === SPAWN_AGENTS_TOOL_NAME)
        return agent.canDelegate;
      // Every agent may ask for human approval, regardless of its tool grant.
      if (h.name === REQUEST_APPROVAL_TOOL_NAME) return true;
      return own(h) && ceiling(h);
    };
  }

  function buildOrchestrator(agent: AgentDefinition, override: string[] | null): Orchestrator {
    const tools = filterToolRegistry(opts.tools, agentPredicate(agent, override));
    const systemPrompt = agent.canDelegate
      ? `${agent.systemPrompt}\n\n${delegateRosterPrompt(agent)}`
      : agent.systemPrompt;
    return createOrchestrator({
      db: opts.db,
      llm: opts.llm,
      tools,
      log: opts.log.child({ agent: agent.name }),
      systemPrompt,
      defaultProfile: agent.profile,
      // The persona runs on a single model; use it for tool turns too rather
      // than falling back to the global chat model.
      toolProfile: agent.profile,
      // Agents are explicitly configured personas with their own tool grant.
      // Deterministic auto-route (e.g. gurney-codex claiming any turn whose
      // prompt contains "research") is a main-chat affordance for the tiny chat
      // model and would otherwise hijack a research agent's turn before it can
      // reach its own tools (websearch). The agent can still call such a tool
      // explicitly if it's in its allowlist.
      autoRouteEnabled: false,
      // 'auto' keeps the profile/model default; only force when explicitly set.
      ...(agent.thinkMode !== 'auto' ? { defaultThinkMode: agent.thinkMode } : {}),
      maxToolRounds: agent.maxToolRounds,
      ...(agent.budgetTokens
        ? { budgetTokens: agent.budgetTokens }
        : opts.budgetTokens
          ? { budgetTokens: opts.budgetTokens }
          : {}),
      ...(opts.toolResultMaxChars ? { toolResultMaxChars: opts.toolResultMaxChars } : {}),
    });
  }

  function delegateRoster(agent: AgentDefinition): AgentDefinition[] {
    if (!agent.canDelegate) return [];
    const allowed = new Set(agent.delegatableAgents);
    return opts.registry
      .list()
      .filter((candidate) => candidate.id !== agent.id)
      .filter((candidate) => allowed.size === 0 || allowed.has(candidate.name));
  }

  function delegateRosterPrompt(agent: AgentDefinition): string {
    const roster = delegateRoster(agent);
    if (roster.length === 0) {
      return 'No delegate agents are currently available. Do not call spawn_agent.';
    }
    const lines = roster.map(
      (candidate) =>
        `- ${candidate.name}: ${candidate.role || candidate.systemPrompt.slice(0, 90)} (${candidate.profile})`,
    );
    return [
      'Available delegate agents for spawn_agent:',
      ...lines,
      'Pick the smallest suitable agent for each subtask. Use exact agent names.',
      'For several independent subtasks, call spawn_agents once with a list to run ' +
        'lightweight workers in parallel; use spawn_agent for a single subtask or a heavy agent.',
    ].join('\n');
  }

  function orchestratorCacheKey(agent: AgentDefinition): string {
    if (!agent.canDelegate) return String(agent.updatedAt);
    return `${agent.updatedAt}:${delegateRoster(agent)
      .map(
        (candidate) => `${candidate.id}:${candidate.name}:${candidate.role}:${candidate.updatedAt}`,
      )
      .join('|')}`;
  }

  // Cache the common case — an agent run with no grant ceiling — keyed by the
  // definition's updatedAt. Runs that carry a per-task override get a one-off
  // orchestrator that's torn down after the run.
  function orchestratorFor(agent: AgentDefinition): Orchestrator {
    const hit = cache.get(agent.id);
    const cacheKey = orchestratorCacheKey(agent);
    if (hit && hit.cacheKey === cacheKey) return hit.orch;
    if (hit) void hit.orch.shutdown();
    const orch = buildOrchestrator(agent, null);
    cache.set(agent.id, { cacheKey, orch });
    return orch;
  }

  async function runTask(
    taskId: number,
    runOpts: { onDelta?: (delta: string) => void } = {},
  ): Promise<RunResult> {
    const task = opts.registry.getTask(taskId);
    if (!task) throw new Error(`agent task ${taskId} not found`);
    if (task.status === 'cancelled') {
      return { ok: false, text: '', error: AGENT_TASK_CANCELLED_MESSAGE, conversationId: 0 };
    }
    const agent = opts.registry.get(task.agentId);
    if (!agent) throw new Error(`agent ${task.agentId} for task ${taskId} not found`);

    const virtualChatId = AGENT_CHAT_ID_BASE + task.id;
    opts.registry.updateTask(task.id, {
      status: 'running',
      startedAt: Date.now(),
      virtualChatId,
    });

    // A grant ceiling means a one-off orchestrator (different tool view than
    // the cached per-agent one); tear it down after the run.
    const ephemeral = task.toolAllowlistOverride !== null;
    const orch = ephemeral
      ? buildOrchestrator(agent, task.toolAllowlistOverride)
      : orchestratorFor(agent);
    active.set(task.id, { orch, virtualChatId });
    let buffer = '';
    let finalText: string | undefined;
    let conversationId = 0;

    try {
      try {
        await orch.handleUserMessage({
          chatId: virtualChatId,
          userId: opts.ownerUserId,
          text: task.prompt,
          send: (chunk: ReplyChunk) => {
            if (chunk.delta) {
              buffer += chunk.delta;
              runOpts.onDelta?.(chunk.delta);
            }
            if (chunk.done) {
              // meta.afterTurn.assistantText is the canonical post-guard reply
              // (after hallucination scrubbing / `replace`); prefer it over the
              // raw streamed buffer.
              if (chunk.meta?.afterTurn) {
                finalText = chunk.meta.afterTurn.assistantText;
                conversationId = chunk.meta.afterTurn.conversationId;
              } else if (typeof chunk.replace === 'string') {
                finalText = chunk.replace;
              }
            }
          },
        });
      } catch (e) {
        if (opts.registry.getTask(task.id)?.status === 'cancelled') {
          return {
            ok: false,
            text: '',
            error: AGENT_TASK_CANCELLED_MESSAGE,
            conversationId,
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('agent task threw', { taskId, agent: agent.name, error: msg });
        opts.registry.updateTask(task.id, {
          status: 'error',
          error: msg,
          finishedAt: Date.now(),
        });
        return { ok: false, text: '', error: msg, conversationId };
      }

      if (opts.registry.getTask(task.id)?.status === 'cancelled') {
        return {
          ok: false,
          text: finalText ?? buffer,
          error: AGENT_TASK_CANCELLED_MESSAGE,
          conversationId,
        };
      }

      const errored = orch.lastError(virtualChatId);
      const text = finalText ?? buffer;
      if (errored) {
        opts.registry.updateTask(task.id, {
          status: 'error',
          error: errored,
          finishedAt: Date.now(),
          ...(conversationId ? { conversationId } : {}),
        });
        return { ok: false, text, error: errored, conversationId };
      }
      opts.registry.updateTask(task.id, {
        status: 'done',
        result: text,
        finishedAt: Date.now(),
        ...(conversationId ? { conversationId } : {}),
      });
      return { ok: true, text, conversationId };
    } finally {
      active.delete(task.id);
      if (ephemeral) await orch.shutdown();
    }
  }

  function cancelTask(taskId: number): boolean {
    const task = opts.registry.getTask(taskId);
    if (!task) return false;
    if (task.status === 'done' || task.status === 'error' || task.status === 'paused') return false;
    if (task.status !== 'cancelled') {
      opts.registry.updateTask(taskId, {
        status: 'cancelled',
        error: AGENT_TASK_CANCELLED_MESSAGE,
        finishedAt: Date.now(),
      });
    }
    const hit = active.get(taskId);
    if (hit) {
      hit.orch.stop(hit.virtualChatId);
      return true;
    }
    return task.status === 'queued' || task.status === 'running' || task.status === 'cancelled';
  }

  async function shutdown(): Promise<void> {
    for (const [taskId] of active) cancelTask(taskId);
    await Promise.all([...cache.values()].map((c) => c.orch.shutdown()));
    cache.clear();
    active.clear();
  }

  return { runTask, cancelTask, shutdown };
}
