# 05. Multi-Agent Engine

Gurney can run **named agent personas** and coordinate them — both as standalone
specialists you dispatch tasks to, and as a supervisor that delegates subtasks to
workers. This is how Gurney gets agentic quality out of small qwen models on a Pi:
instead of asking one small model to do everything in one long context, you decompose a
hard task across small, well-scoped agents and use a heavy reasoning model sparingly.

## What an agent is

An agent is a saved bundle of orchestrator options plus an execution policy. Nothing about
running one is special — it drives the **same** orchestrator pipeline as a Telegram turn, so
it inherits every guard (per-turn tool gate, hallucination scrubbing, tool timeouts).

| Field | Meaning |
| --- | --- |
| `systemPrompt` | The persona's instructions. |
| `profile` | `chat` / `tools` (tiny models) or `reason` (the heavy 9B). |
| `toolAllowlist` | Extension and/or tool names the agent may call. `null` = all tools; `[]` = none. A **short, role-scoped allowlist measurably improves tool selection** on a 0.8B model. |
| `maxToolRounds`, `budgetTokens` | Per-agent caps. |
| `executionMode` | `sequential` (one of its own tasks at a time) or `parallel` (up to `maxConcurrency`). |
| `canDelegate`, `delegatableAgents` | Whether it may spawn sub-agents, and which ones (`[]` = any). |

Definitions and task rows live in SQLite (`agents`, `agent_tasks`; migration `0009`). Each run
writes its transcript to a `conversations` row under a reserved **virtual chat id**
(`AGENT_CHAT_ID_BASE + taskId`), so agent transcripts never mix with your real chats.

## The resource governor (why "parallel" has limits)

The hard constraint on a small machine is the **model**, not the number of agents: Ollama keeps
exactly one heavy (7–9B) model resident at a time. The task queue is keyed to that:

- **At most one heavy task runs at a time.** Two reasoning agents can never thrash the model
  cache against each other — on a Pi they simply queue.
- **Tiny (0.5–0.8B) tasks run in parallel** up to a tier-scaled cap (Small 1 / Standard 2 /
  Heavy 3).
- A `sequential` agent runs only one of its own tasks at a time regardless of the global budget.

So an agent marked `parallel` that uses the `reason` profile still serialises against all other
heavy work — "parallel" never overrides physics. The command center shows a task as *queued*
until a model slot frees up.

The daemon is the **single owner** of task execution. The web panel (a separate process) only
creates/edits agents and enqueues tasks; the daemon polls the DB and runs them. This keeps the
heavy-model slot from being contended by two processes.

## Delegation (supervisor → worker)

An agent with `canDelegate` sees a built-in `spawn_agent(agent, task, mode)` tool:

- `mode: 'await'` (default) runs the worker now and returns its answer as the tool result — the
  supervisor is paused in tool execution (not generating), so there's no model contention.
- `mode: 'async'` enqueues the worker on the queue and returns its task id.

Safety is enforced in code, not by the prompt:

- A worker's effective tool grant is the **intersection** of the supervisor's grant and the
  worker's own allowlist — delegation can never escalate capability.
- Delegation depth is capped (`MAX_DELEGATION_DEPTH`).
- A `confirm`- or `owner`-tier tool inside an unattended background run **fails closed** (there's
  no one to approve it), rather than auto-running or hanging.

## The command center (web panel)

`gurney-frontend` → **Agents** tab:

- **Fleet** — every persona with its profile, mode, and grant; buttons to dispatch, edit, delete.
- **Editor** — name, role, system prompt, model profile, tool allowlist, execution mode +
  concurrency, and the delegation grant.
- **Tasks** — recent runs with live status; open one to see its transcript and sub-agent tree.

## Starter fleet

A fresh install seeds four agents to demonstrate the pattern (delete them and they stay gone):

- **planner** — heavy `reason` model; decomposes a goal and delegates to the others.
- **researcher** — `tools` model; gathers facts (parallel-friendly).
- **writer** — `chat` model; drafts prose, no tools.
- **critic** — `chat` model; reviews and tightens a draft.

## Example patterns

- **Planner + parallel workers.** A 9B planner decomposes "summarise my week and draft three
  priorities", dispatches 0.8B workers to gather calendar/tasks/weather in parallel, then
  synthesises once.
- **Deterministic pipeline.** researcher → writer → critic, run sequentially — Pi-safe.
- **Switchable specialists.** A "coding helper", a "home assistant", a "tutor" — each a saved
  persona with a small tool manifest so the tiny model picks tools accurately.
- **Overnight routine.** A low-priority background task runs while you sleep (one heavy model,
  sequential) and reports back.

## Code map

| Concern | File |
| --- | --- |
| Definitions, registry, headless runner, starter fleet | `src/core/agents.ts` |
| Resource-aware queue | `src/core/agent-queue.ts` |
| `spawn_agent` delegation tool | `src/core/agent-delegation.ts` |
| Schema | `src/storage/migrations/0009_agents.sql` |
| Boot wiring (engine + confirm fail-closed) | `src/cli/start.ts` |
| Command center API + UI | `extensions/gurney-frontend/server.ts`, `extensions/gurney-frontend/web/agents.jsx` |
