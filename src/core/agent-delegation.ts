// The spawn_agent delegation tool (supervisor -> worker).
//
// Registered as a core tool but visible only to agents whose definition has
// canDelegate (the runtime's per-agent tool filter enforces that, and the main
// Telegram/panel orchestrator filters it out entirely). When a supervisor's
// turn calls it, we resolve the calling task from the tool context's chat id
// (every agent run drives the orchestrator against AGENT_CHAT_ID_BASE + taskId),
// enforce the delegation grant, and run or enqueue a child task.
//
// Security invariants:
//   - canDelegate must be set on the calling agent.
//   - the target must be in the caller's delegatableAgents ([] = any).
//   - delegation depth is capped (MAX_DELEGATION_DEPTH).
//   - the child's tool grant is intersected with the caller's effective grant,
//     so a worker can never reach a tool the supervisor itself couldn't use.
//
// `await` mode runs the child inline (the supervisor isn't using the model
// during tool execution, so there's no contention and no risk of the heavy
// slot deadlocking on itself) and returns the worker's reply as the tool
// result. `async` mode enqueues the child on the resource-aware queue and
// returns its id immediately.

import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import type { AgentQueue } from './agent-queue.js';
import {
  isAgentChatId,
  intersectGrants,
  AGENT_CHAT_ID_BASE,
  MAX_DELEGATION_DEPTH,
  SPAWN_AGENT_TOOL_NAME,
  type AgentRegistry,
  type AgentRuntime,
} from './agents.js';

export interface AgentDelegationDeps {
  tools: ToolRegistry;
  registry: AgentRegistry;
  runtime: AgentRuntime;
  queue: AgentQueue;
  log: Logger;
}

export function setupAgentDelegation(deps: AgentDelegationDeps): void {
  const log = deps.log.child({ mod: 'agent-delegation' });

  deps.tools.register({
    name: SPAWN_AGENT_TOOL_NAME,
    description:
      'Delegate a subtask to another agent and (by default) wait for its result. ' +
      'Use this to break a hard task into smaller pieces handled by specialised agents.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the agent to delegate to.' },
        task: { type: 'string', description: 'The subtask, as a clear instruction.' },
        mode: {
          type: 'string',
          enum: ['await', 'async'],
          description:
            "'await' (default) runs the worker now and returns its answer; " +
            "'async' starts it in the background and returns a task id.",
        },
      },
      required: ['agent', 'task'],
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId;
      if (chatId === undefined || !isAgentChatId(chatId)) {
        return 'spawn_agent can only be used from within an agent run.';
      }
      const parentTaskId = chatId - AGENT_CHAT_ID_BASE;
      const parentTask = deps.registry.getTask(parentTaskId);
      if (!parentTask) return 'Could not resolve the calling task; delegation aborted.';
      const parentAgent = deps.registry.get(parentTask.agentId);
      if (!parentAgent) return 'Could not resolve the calling agent; delegation aborted.';

      if (!parentAgent.canDelegate) {
        return `Agent '${parentAgent.name}' is not permitted to delegate.`;
      }
      if (parentTask.depth >= MAX_DELEGATION_DEPTH) {
        return `Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached; refusing to spawn deeper.`;
      }

      const targetName = String(args['agent'] ?? '').trim();
      const subtask = String(args['task'] ?? '').trim();
      if (!targetName || !subtask) return 'Both `agent` and `task` are required.';

      const target = deps.registry.getByName(targetName);
      if (!target) return `No agent named '${targetName}'.`;
      // [] means "any agent"; a non-empty list is an explicit allowlist.
      if (
        parentAgent.delegatableAgents.length > 0 &&
        !parentAgent.delegatableAgents.includes(targetName)
      ) {
        return `Agent '${parentAgent.name}' may not delegate to '${targetName}'.`;
      }

      // The worker can use at most what the supervisor itself could — its own
      // effective grant (its allowlist intersected with any ceiling it inherited).
      const parentEffectiveGrant = intersectGrants(
        parentAgent.toolAllowlist,
        parentTask.toolAllowlistOverride,
      );

      const mode = args['mode'] === 'async' ? 'async' : 'await';
      const child = deps.registry.enqueue({
        agentId: target.id,
        prompt: subtask,
        parentId: parentTask.id,
        depth: parentTask.depth + 1,
        executionMode: target.executionMode,
        toolAllowlistOverride: parentEffectiveGrant,
      });
      log.info('delegated subtask', {
        from: parentAgent.name,
        to: targetName,
        mode,
        childTask: child.id,
        depth: child.depth,
      });

      if (mode === 'async') {
        // Hand it to the resource-aware queue and return immediately.
        deps.queue.notify();
        return `Started '${targetName}' on task #${child.id} in the background.`;
      }

      // Inline run: the supervisor is paused in tool execution (not generating),
      // so running the worker now doesn't contend for the model.
      const result = await deps.runtime.runTask(child.id);
      if (!result.ok) {
        return `Sub-agent '${targetName}' failed: ${result.error ?? 'unknown error'}`;
      }
      return result.text || `Sub-agent '${targetName}' finished with no output.`;
    },
  });
}
