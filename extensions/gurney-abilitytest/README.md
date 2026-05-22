# gurney-abilitytest

Scripted end-to-end ability tests for Gurney. Boots a one-shot in-process
Gurney (db + ollama + tools + extension loader + orchestrator), drives
catalog messages through the same dispatch ladder the Telegram adapter
uses, and prints a per-test row plus a final summary. A markdown report is
written to `~/.gurney/ability-test-<timestamp>.md`.

## Usage

```bash
gurney stop                              # the runner refuses to start while the daemon is running
gurney abilitytest                       # standard tier (~40 tests)
gurney abilitytest --tier smoke          # quick smoke pass (~25 tests)
gurney abilitytest --tier full           # exhaustive (~80+ tests, ~15 min on CPU)
gurney abilitytest --filter '^calendar'  # only tests whose id or ability matches the regex
gurney abilitytest --out report.md       # custom report path
```

## Important: no cleanup

This runner hits the same Google Calendar, Google Tasks, weather API and
local SQLite that a real chat would. Events, tasks, reminders and quiet
windows the model creates **stay** in your accounts after the run. Plan to
clean them up by hand, or run against a throwaway account.

## Adding tests for a new ability

Each extension owns its own catalog at `<extension>/tests/ability-tests.json`:

```json
{
  "tests": [
    {
      "id": "myext.create.smoke",
      "ability": "myext:create_thing",
      "tier": "smoke",
      "kind": "freeform",
      "message": "Make me a thing called widget",
      "expects": { "tool": "myext_create" }
    }
  ]
}
```

Fields:

- `id` — unique, dot-separated. Used for `--filter` and in the report.
- `ability` — the human-readable ability the test targets (e.g. `calendar:create_event`). Tests sharing an `ability` run in one conversation; `/newchat` fires between abilities.
- `tier` — `smoke` (one per ability), `standard` (default), or `full`.
- `kind` — `freeform` (goes through intercepts → orchestrator) or `slash` (dispatched as a `/command`, core or extension).
- `message` — exactly what the user would type.
- `expects` (optional) — judging hints:
  - `tool: "name"` — pass iff `name` appears in `afterTurn.toolCalls` and didn't fail.
  - `interceptReply: true` — pass iff an extension intercept (e.g. gurney-instant-responses) shipped a reply.
  - `voice: true` — pass iff a voice payload was emitted via `sendVoice` (TTS).

Without `expects`, a test is **info-only**: it runs and gets logged, but
isn't graded. Useful for slash commands where the only thing you want to
verify is that nothing throws.

## How freeform messages are dispatched

Same ladder as `src/adapters/telegram.ts`:

1. Run the intercept chain (`loader.intercepts()`). Each intercept can `reply()` and/or `next()`; if it doesn't call `next()`, the orchestrator never runs.
2. Otherwise, `orchestrator.handleUserMessage()` streams a reply. The final chunk's `meta.afterTurn.toolCalls` is what `expects.tool` matches against.
3. After the assistant reply lands, `afterReply` and `afterTurn` hooks fire — same order, same behaviour as Telegram.
4. The TTS `sendVoice` thunk is replaced with a recorder so `expects.voice` can be checked.

## Limits

- Real-time only. `Remind me in 10 minutes` actually schedules a 10-minute reminder; it'll fire at the next `gurney start`.
- No Telegram, so anything that depends on Telegram-specific behaviour (button callbacks, voice replay) is not exercised — but the orchestrator path and tool dispatch are.
- Failures don't change the exit code unless the runner itself crashes. Use the report's summary to decide what to fix.
