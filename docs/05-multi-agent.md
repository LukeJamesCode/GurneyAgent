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

| Field                              | Meaning                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemPrompt`                     | The persona's instructions.                                                                                                                                             |
| `profile`                          | `chat` / `tools` (tiny models) or `reason` (the heavy 9B).                                                                                                              |
| `toolAllowlist`                    | Extension and/or tool names the agent may call. `null` = all tools; `[]` = none. A **short, role-scoped allowlist measurably improves tool selection** on a 0.8B model. |
| `maxToolRounds`, `budgetTokens`    | Per-agent caps.                                                                                                                                                         |
| `executionMode`                    | `sequential` (one of its own tasks at a time) or `parallel` (up to `maxConcurrency`).                                                                                   |
| `canDelegate`, `delegatableAgents` | Whether it may spawn sub-agents, and which ones (`[]` = any).                                                                                                           |
| `mode`                             | `single` (one bounded turn — the default) or `autonomous` (the plan→act→reflect loop below).                                                                            |
| `maxTotalRounds`, `maxWallClockMs` | Autonomous-run budget ceilings (loop turns / wall-clock). `null` = engine defaults (30 rounds / 30 min).                                                                |

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
heavy work — "parallel" never overrides physics. The command center shows a task as _queued_
until a model slot frees up.

The daemon is the **single owner** of task execution. The web panel (a separate process) only
creates/edits agents and enqueues tasks; the daemon polls the DB and runs them. This keeps the
heavy-model slot from being contended by two processes.

## Delegation (supervisor → worker)

An agent with `canDelegate` sees a built-in `spawn_agent(agent, task, mode)` tool:

- `mode: 'await'` (default) runs the worker now and returns its answer as the tool result — the
  supervisor is paused in tool execution (not generating), so there's no model contention.
- `mode: 'async'` enqueues the worker on the queue and returns its task id.

For **independent** subtasks, a delegating agent also sees `spawn_agents({ tasks: [{agent, task}, …] })`,
which dispatches the whole batch at once and returns all results joined and labelled by agent. This is
how you actually get the "fan out, then synthesise" pattern: the workers run inline with a
**tier-bounded concurrency cap** (Small 1 / Standard 2 / Heavy 3 — the same tiny-worker budget the queue
uses), so a Pi never loads more small models than its RAM allows. Targets must be **lightweight**
(non-`reason`) agents — a heavy target is refused, because the supervisor already holds the single heavy
slot while paused in tool execution, so a parallel heavy fan-out could never get a slot to run. Use
`spawn_agent` for a single subtask or a heavy agent; `spawn_agents` for parallel lightweight work.

Safety is enforced in code, not by the prompt:

- A worker's effective tool grant is the **intersection** of the supervisor's grant and the
  worker's own allowlist — delegation can never escalate capability.
- Delegation depth is capped (`MAX_DELEGATION_DEPTH`).
- A `confirm`- or `owner`-tier tool inside an unattended background run **fails closed** (there's
  no one to approve it), rather than auto-running or hanging.

## Autonomous agents (long-horizon)

A `single`-mode agent answers in one bounded turn (today's behaviour). An `autonomous`
agent instead runs a **plan→act→reflect loop**: it keeps working a goal across many turns
until it's done or a budget trips. This is how Gurney does "run for an hour" tasks without a
giant context — each turn is a normal, fully-guarded orchestrator turn against the task's
virtual chat, so history accumulates and every guard still applies.

The loop is deterministic code (`createAgentRuntime` → `runAutonomous`); the model only makes
judgment calls through five built-in tools, visible **only** to autonomous agents
(`agent-planning.ts`):

- `update_plan({ steps })` — author/revise an ordered todo. Re-authoring keeps finished steps done.
- `complete_step({ id? })` — tick the current (or a named) step off.
- `record_finding({ note })` — keep a fact for the final answer (saved as an artifact).
- `save_artifact({ name, content })` — persist a deliverable.
- `finish({ summary })` — declare the goal met; the summary becomes the result. Called once.

**Stopping** is enforced in code, never left to the model: the loop ends on `finish`, when the
plan is all done, when the round/wall-clock budget trips, or when the model stalls (no progress
for two turns) — then one finalise turn produces a clean summary.

**Durable resume.** After every step the loop checkpoints the plan, step cursor, rounds used, and
timestamp to the task row. If the daemon restarts mid-run, an autonomous task is re-queued **with
its checkpoint intact** (its `started_at` is preserved so the wall-clock budget stays honest) and
resumes from the next step — it does **not** replay the goal. Single-mode tasks still re-run from
scratch (a half-finished turn can't be resumed).

**Cooperative pause / steer.** Pausing an autonomous task stops it **between steps** with state
intact; resuming continues from the checkpoint. You can also **steer** a running task — a message
appended to its steer queue and applied before the next step — without cancelling it.

Budgets are deliberately modest by default so a stray run can't grind forever on a small box;
raise them per-agent in the editor. The seeded **operator** agent is the flagship autonomous
persona (heavy `reason` model, can delegate, 24-round / 30-min budget).

## The command center (web panel)

`gurney-frontend` → **Agents** tab:

- **Fleet** — every persona with its profile, mode, and grant; buttons to dispatch, edit, delete.
  Autonomous agents carry an `autonomous` badge; the editor exposes the run mode + budgets.
- **Editor** — name, role, system prompt, model profile, tool allowlist, execution mode +
  concurrency, the delegation grant, and (for autonomous agents) the round/time budgets.
- **Run view** — opens a task and streams it live over SSE: a budget gauge (rounds + time burn-down),
  the plan ticking off, saved artifacts, the transcript, and a **Steer** box to nudge a running
  agent mid-flight. The panel runs in its own process, so it reads the checkpointed state from the
  DB rather than the daemon's in-memory events.

## Starter fleet

A fresh install seeds four agents to demonstrate the pattern (delete them and they stay gone):

- **orchestrator** - heavy `reason` model; decomposes any task and delegates to the available fleet.
- **researcher** — `tools` model; gathers facts (parallel-friendly).
- **writer** — `chat` model; drafts prose, no tools.
- **critic** — `chat` model; reviews and tightens a draft.

## Example patterns

- **Orchestrator + parallel workers.** A 9B orchestrator decomposes "summarise my week and draft three
  priorities", dispatches 0.8B workers to gather calendar/tasks/weather in parallel, then
  synthesises once.
- **Deterministic pipeline.** researcher → writer → critic, run sequentially — Pi-safe.
- **Switchable specialists.** A "coding helper", a "home assistant", a "tutor" — each a saved
  persona with a small tool manifest so the tiny model picks tools accurately.
- **Overnight routine.** A low-priority background task runs while you sleep (one heavy model,
  sequential) and reports back.

## Code map

| Concern                                               | File                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Definitions, registry, headless runner, autonomous loop, starter fleet | `src/core/agents.ts`                                               |
| Resource-aware queue                                  | `src/core/agent-queue.ts`                                                           |
| `spawn_agent` delegation tool                         | `src/core/agent-delegation.ts`                                                      |
| Autonomous-loop tools (plan/step/finding/artifact/finish) | `src/core/agent-planning.ts`                                                   |
| Schema (agents + autonomy columns/artifacts)          | `src/storage/migrations/0009_agents.sql`, `0017_agent_autonomy.sql`                |
| Boot wiring (engine + confirm fail-closed + resume)   | `src/cli/start.ts`                                                                  |
| Command center API + UI (incl. live run view)         | `extensions/gurney-frontend/server.ts`, `extensions/gurney-frontend/web/agents.jsx` |
