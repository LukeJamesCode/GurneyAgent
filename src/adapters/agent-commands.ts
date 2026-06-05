// Pure command logic for the agent surface (/agents, /dispatch). Kept out of
// the grammY adapter so it can be unit-tested and reused by other chat
// surfaces (e.g. gurney-discord) without touching Telegram I/O.

import type { AgentRegistry, AgentTask } from '../core/agents.js';
import type { AgentQueue } from '../core/agent-queue.js';

// Render the fleet for `/agents`: one line per persona with its role, model,
// whether it delegates, and the status of its most recent task.
export function formatAgentList(registry: AgentRegistry): string {
  const agents = registry.list();
  if (agents.length === 0) {
    return 'No agents defined yet. Create one in the web panel (Agents tab).';
  }
  const recent = registry.listTasks({ limit: 200 });
  const latestByAgent = new Map<number, AgentTask>();
  for (const t of recent) {
    if (!latestByAgent.has(t.agentId)) latestByAgent.set(t.agentId, t);
  }
  const lines = agents.map((a) => {
    const last = latestByAgent.get(a.id);
    const status = last ? ` · last: ${last.status}` : '';
    const deleg = a.canDelegate ? ' · delegates' : '';
    return `• ${a.name} — ${a.role || a.profile} (${a.profile})${deleg}${status}`;
  });
  return ['Agents:', ...lines, '', 'Dispatch a task:  /dispatch <agent> <task>'].join('\n');
}

// Enqueue a task from `/dispatch <agent> <task>`. Returns the user-facing reply.
// Uses the queue (which kicks the scheduler) when available, falling back to a
// plain enqueue so the task is at least persisted if the queue isn't wired.
export function handleDispatch(
  registry: AgentRegistry,
  queue: AgentQueue | undefined,
  arg: string,
): string {
  const trimmed = arg.trim();
  if (!trimmed) return 'Usage: /dispatch <agent> <task>';
  const sep = trimmed.search(/\s/);
  if (sep === -1) {
    return 'Usage: /dispatch <agent> <task> — add the task after the agent name.';
  }
  const agentName = trimmed.slice(0, sep);
  const task = trimmed.slice(sep + 1).trim();
  if (!task) return 'Usage: /dispatch <agent> <task> — the task is empty.';

  const agent = registry.getByName(agentName);
  if (!agent) return `No agent named '${agentName}'. Run /agents to see them.`;

  const enqueued = queue
    ? queue.dispatch({ agentId: agent.id, prompt: task })
    : registry.enqueue({ agentId: agent.id, prompt: task });
  return `Dispatched task #${enqueued.id} to ${agent.name}. Track it in the panel (Agents → Tasks).`;
}
