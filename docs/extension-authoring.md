# Writing a Gurney Extension

An extension is a folder. Drop it in `~/.gurney/extensions/<name>/` (or anywhere `gurney ext install` knows about), and Gurney picks it up — new tools and Telegram commands appear, without restarting the bot.

This guide walks through what an extension looks like, the registries the host exposes, the lifecycle, testing, and publishing.

## TL;DR

```sh
gurney ext create gurney-myext        # scaffolds ./gurney-myext/ ready to edit
gurney ext install ./gurney-myext     # picks it up locally
```

Scaffolded layout:

```
gurney-myext/
├── manifest.json          # required
├── tools.ts               # optional — LLM tools
├── commands.ts            # optional — Telegram /commands
├── jobs.ts                # optional — scheduled cron jobs
├── auth.ts                # optional — `gurney auth gurney-myext` flow
├── setup.ts               # optional — install-time setup checks/downloads
├── settings.schema.json   # optional — typed config rendered by `gurney config`
├── prompt.md              # optional — system-prompt fragment
├── migrations/            # optional — per-extension SQLite tables
└── README.md
```

Only `manifest.json` is required. Runtime entrypoints export `register(host)`; `setup.ts` exports `setup(ctx)` or `run(ctx)`.

## manifest.json

```json
{
  "name": "gurney-myext",
  "version": "1.0.0",
  "description": "What this extension does, in one line.",
  "gurney": ">=0.1.0",
  "deps": [],
  "capabilities": ["network", "storage", "auth:oauth"],
  "entrypoints": {
    "tools": "./tools.ts",
    "commands": "./commands.ts",
    "jobs": "./jobs.ts",
    "auth": "./auth.ts",
    "setup": "./setup.ts"
  },
  "telegram_commands": [{ "command": "myext", "description": "Run the thing" }]
}
```

| Field               | Purpose                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | Must match the folder name. Used as the registry key everywhere.                                                                                 |
| `version`           | Semver string. Bump it whenever any registered behaviour changes.                                                                                |
| `gurney`            | Host version range. Phase 2 supports `>=X.Y.Z` only.                                                                                             |
| `capabilities`      | Declarative — what the extension claims to need (`network`, `storage`, `auth:oauth`). The host doesn't sandbox in v1, but logs anything unknown. |
| `entrypoints`       | Relative paths to `.ts`/`.js` files. Runtime files export `register(host)`; optional `setup` exports `setup(ctx)` or `run(ctx)`.                 |
| `telegram_commands` | Tells the bot to advertise these via `setMyCommands`. Must match the strings you pass to `host.telegram.command(...)`.                           |

## The `host` API

Every entrypoint receives a `Host` object. The full TypeScript definition lives in [`src/core/extensions.ts`](../src/core/extensions.ts) — the table below is the cheat sheet.

### Identity & filesystem

```ts
host.name; // your extension name
host.version; // your extension version
host.log; // structured logger; redacts secrets
host.dataDir; // ~/.gurney/extension_state/<name>/ — yours alone
```

### Shared services

```ts
host.db; // the shared better-sqlite3 connection
host.llm; // chat/reason profiles via Ollama
```

### Settings

```ts
host.settings.get<string>('api_key'); // read
host.settings.get<number>('limit', 20); // read with default
host.settings.set('last_synced', Date.now()); // write
host.settings.all(); // read everything
```

The `gurney config` TUI renders `settings.schema.json` so users can edit these values without touching the DB. Mark sensitive fields with `"secret": true` so they're masked in prompts.

### Tools (LLM-callable)

```ts
host.tools.register({
  name: 'list_my_things',
  description: 'List the things this extension knows about.',
  parameters: { type: 'object', properties: {} },
  tier: 'auto',
  handler: async ({ args }) => ({ ok: true, result: ['a', 'b'] }),
});
```

`tier: 'auto' | 'confirm' | 'owner'` controls when the model is allowed to call it without user approval. Default to `auto` for read-only tools; use `confirm` for anything that mutates state and `owner` for the rare op-only tool.

### Telegram commands

```ts
host.telegram.command(
  'myext',
  async (ctx) => {
    await ctx.reply(`Hi from gurney-myext, args=${ctx.args}`);
  },
  'Run the thing',
);
```

For richer routing, register an _intercept_:

```ts
host.telegram.intercept(async (ctx) => {
  if (ctx.text.startsWith('photo:')) {
    await ctx.reply('handled by myext');
    return; // don't call ctx.next() — the orchestrator skips this message
  }
  await ctx.next(); // pass through
});
```

For voice replies (gurney-voice pattern), use the lightweight after-reply hook:

```ts
host.telegram.afterReply(async (ctx) => {
  const wav = await synthesize(ctx.text);
  await host.telegram.sendVoice(ctx.chatId, { data: wav });
});
```

For learning/routine detection that needs the full turn, use `afterTurn` instead of blocking the live reply path:

```ts
host.telegram.afterTurn(async (ctx) => {
  await learnRoutine({
    conversationId: ctx.conversationId,
    userText: ctx.userText,
    assistantText: ctx.assistantText,
    toolCalls: ctx.toolCalls,
  });
});
```

`afterTurn` includes `chatId`, `userId`, `conversationId`, `userText`, `assistantText`, `startedAt`, `finishedAt`, and summarized tool-call results.

### Scheduler (cron)

```ts
host.scheduler.cron('myext.sweep', '*/5 * * * *', async () => {
  // runs every five minutes
});
```

Cron is minute-granularity. Multiple jobs from different extensions firing in the same minute go through the proactive-loop rate limiter — your nudges won't pile up on the user.

### Cache (per-extension TTL)

```ts
const events = await host.cache.getOr('today_events', 60_000, async () => {
  return await fetchTodayEvents();
});
```

Useful for memoizing per-tick work in cron jobs. Stats are surfaced in `gurney status`.

### Prompt fragments

```ts
host.prompts.contribute(`You can manage MyExt via list_my_things, add_thing, …`);
```

This text is appended to the system prompt only when at least one tool from this extension is in scope.

### Auth flows

```ts
host.auth.flow({
  label: 'Authorize MyExt',
  run: async (io) => {
    const token = await io.prompt('Paste your token:', { secret: true });
    return { token };
  },
});
```

The returned object is written into `extension_settings`. For OAuth, request a callback server with `io.openCallbackServer()` (reference impl in `src/cli/auth.ts`).

### Migrations (per-extension tables)

Drop `migrations/0001_init.sql` in your folder. The loader runs it under the private table `_ext_<your_name>_migrations` so versions never collide with core. Schema rules are the same as core: numbered files, never `ALTER` an applied migration.

### Setup entrypoint

Use `entrypoints.setup` for install-time checks that belong to the extension, such as downloading native binaries or probing optional command-line tools. The CLI calls `setup(ctx)` or `run(ctx)` during `gurney init` / `gurney ext install`.

```ts
import type { ExtensionSetupContext } from '../../src/core/extensions.js';

export async function setup(ctx: ExtensionSetupContext): Promise<void> {
  ctx.stdout('checking native dependency...\n');
  ctx.settings.set('native_ready', true);
}
```

The setup context exposes `home`, `folder`, `db`, `settings`, `interactive`, and `stdout`. Keep setup idempotent; users can reinstall or rerun setup flows.

## Lifecycle

1. **Discovered** — folder lands under a search root.
2. **Manifest validated** — `gurney` range checked against host version.
3. **Migrations** — your `migrations/` are applied.
4. **Settings** — `settings.schema.json` defaults merged in.
5. **Setup** — optional `entrypoints.setup` runs from CLI install/init flows.
6. **Imported** — each runtime entrypoint's `register(host)` runs.
7. **Live** — your tools/commands/jobs are visible.
8. **Hot-reload** — touching any file in your folder triggers `unregister(host)` (if exported) and a re-import. Use this in `gurney ext reload <name>`.

## Testing

Co-locate tests as `*.test.ts` in your extension folder. The repo's test runner finds them automatically. The `LoadedExtension` returned by `loadExtensions(...)` lets you assert on registered tools/commands without spinning up Telegram.

A typical extension test:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('list_my_things returns sample data', async () => {
  const result = await myToolHandler({ args: {} });
  assert.deepEqual(result.result, ['a', 'b']);
});
```

## Publishing

Three install routes are supported, in increasing order of distribution reach:

1. **Local path** — useful during development:
   ```sh
   gurney ext install ./gurney-myext
   ```
2. **Git URL** — push your folder to its own repo and tell users:
   ```sh
   gurney ext install https://github.com/you/gurney-myext.git
   ```
   No registry PR, no npm publishing rights — works the moment your repo is public.
3. **Public registry** — bare name, resolved via [`extensions/registry.json`](../extensions/registry.json):
   ```sh
   gurney ext install gurney-myext
   ```
   Open a PR adding `{ "name", "source", "subpath"?, "description" }` to that file. Once merged, anyone running Gurney can install your extension by bare name.

Self-hosted forks point at their own JSON file with `GURNEY_REGISTRY_URL=https://your.host/registry.json`. Same shape as the official one.

## Capability checklist for production-quality extensions

- [ ] `manifest.json` has accurate `gurney` range and `capabilities`
- [ ] Tools are right-tiered (`auto`/`confirm`/`owner`)
- [ ] Settings have sensible defaults; secrets are flagged
- [ ] No hardcoded paths, IPs, timezones — use `host.dataDir`, the system locale, etc.
- [ ] No `console.log` — use `host.log`
- [ ] Idempotent cron jobs (assume the same minute can fire twice on a slow box)
- [ ] Tests for every tool handler and at least one Telegram command
- [ ] README covers what it does, what settings it needs, and what data it stores

## The `intent_pattern` field

```json
{
  "intent_pattern": "\\b(event|events|meeting|calendar|schedule)\\b"
}
```

An optional case-insensitive regex string in `manifest.json`. When set, the orchestrator tests each incoming message against this pattern before assembling the per-turn tool manifest. If the message matches, this extension's tools are included. If not, they're pruned from that turn's manifest.

This keeps the LLM's tool list short and the prompt prefix stable. An extension whose tools aren't relevant to the current message never appears in the tool schemas, so the model doesn't waste tokens considering them.

Rules:

- The regex must be a valid JavaScript regex string (backslashes doubled for JSON)
- The match is case-insensitive
- Core tools (no `extension` field) are always included regardless of intent
- Extensions with no `intent_pattern` are always included
- Use word boundaries (`\b`) to avoid false matches on substrings

## The `settings.schema.json` format

A JSON Schema (subset) that `gurney config` renders as an interactive TUI.

```json
{
  "type": "object",
  "properties": {
    "api_key": {
      "type": "string",
      "description": "Your service API key",
      "secret": true
    },
    "max_results": {
      "type": "number",
      "default": 10,
      "description": "Maximum results to return per query"
    },
    "enabled_feature": {
      "type": "boolean",
      "default": true,
      "description": "Toggle the optional feature on or off"
    },
    "mode": {
      "type": "string",
      "enum": ["fast", "thorough"],
      "default": "fast",
      "description": "Search mode"
    }
  },
  "required": ["api_key"]
}
```

| Field           | Notes                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `type`          | `"string"`, `"number"`, or `"boolean"`.                                                                           |
| `description`   | Shown as the prompt label in `gurney config`.                                                                     |
| `default`       | Used as the initial value. If absent, the field starts empty.                                                     |
| `secret`        | `true` → the prompt masks the value and `gurney status` doesn't show it. The stored value is plaintext in SQLite. |
| `enum`          | Array of allowed string values; `gurney config` renders a select list.                                            |
| Required fields | Listed in the top-level `"required"` array; `gurney config` prompts for them first.                               |

Access settings at runtime via:

```ts
host.settings.get<string>('api_key'); // throws if missing and no default
host.settings.get<number>('max_results', 10); // falls back to 10 if unset
host.settings.set('last_run', Date.now()); // write back
```

## Post-reply lifecycle hooks

Gurney exposes two post-reply hooks. `afterReply` is intentionally tiny and remains the right fit for simple consumers like TTS that only need the assistant text. `afterTurn` is richer and is the preferred hook for learning, routine detection, habit inference, and other extensions that need to inspect the full user/assistant turn without sitting in the hot reply path.

### The `afterReply` hook

Registers a callback that fires after every successful reply in a chat. Used by `gurney-voice` to synthesize a voice note for each text reply.

```ts
host.telegram.afterReply(async (ctx) => {
  // ctx.text    — the full text of the reply just sent
  // ctx.chatId  — the Telegram chat ID
  // ctx.log     — extension-scoped logger for background failures

  let audio: Buffer;
  try {
    audio = await synthesize(ctx.text);
  } catch (e) {
    host.log.warn({ err: e }, 'TTS synthesis failed — text reply was already sent');
    return; // do not throw — a TTS failure must not surface as an error to the user
  }

  await host.telegram.sendVoice(ctx.chatId, { data: audio });
});
```

### The `afterTurn` hook

Registers a callback that fires after the visible Telegram reply is complete, with enough context for offline learning/routine extensions:

```ts
host.telegram.afterTurn(async (ctx) => {
  // ctx.chatId / ctx.userId
  // ctx.conversationId
  // ctx.userText / ctx.assistantText
  // ctx.startedAt / ctx.finishedAt are epoch-ms timestamps
  // ctx.toolCalls: [{ name, arguments, ok, resultSummary }]

  for (const call of ctx.toolCalls) {
    host.log.debug('tool observed after turn', {
      tool: call.name,
      ok: call.ok,
      resultSummary: call.resultSummary,
    });
  }
});
```

Tool result summaries are truncated before they reach the hook, so extensions can cheaply store or scan the post-turn trace without preserving full raw tool payloads.

Key rules:

- **Keep reply-time work out of both hooks.** They fire after the user-visible text is sent and should do background-side effects only.
- **Use `afterReply` for simple TTS-style consumers.** Use `afterTurn` for learning/routine extensions that need user text, conversation id, timing, or tool-call outcomes.
- **Do not rely on hook errors reaching the user.** Hook exceptions are caught and logged by core after the reply has already been sent.

## Exporting `unregister`

If your extension holds resources that need cleanup on unload, export an `unregister(host)` function alongside `register(host)`:

```ts
let interval: NodeJS.Timeout | null = null;

export function register(host: Host): void {
  interval = setInterval(() => {
    /* ... */
  }, 60_000);
  host.tools.register({
    /* ... */
  });
}

export function unregister(_host: Host): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  // host.tools.unregister, host.telegram.command cleanup, etc.
  // are handled automatically by the loader — only clean up
  // resources you created outside the host API (timers, file handles, etc.)
}
```

`unregister` fires on hot-reload (before the extension is re-imported) and on `gurney stop`. The loader automatically disposes all `host.*` registrations — you only need `unregister` if you have external state (timers, open file handles, WebSocket connections, etc.).

## Depending on another extension

Extensions can check for sibling extensions at runtime:

```ts
import { host } from './register.js'; // your host reference saved at register() time

function getCalendarTool() {
  const tool = host.tools.get('calendar_list_events');
  if (!tool) {
    throw new Error('my-extension requires gurney-everyday-assistant to be installed and enabled');
  }
  return tool;
}
```

Or degrade gracefully if the dep is optional:

```ts
async function gatherWeather(): Promise<string | null> {
  const tool = host.tools.get('get_weather');
  if (!tool) return null; // weather not available; skip the section
  return await tool.invoke({ location: 'London' }, ctx);
}
```

Declare optional dependencies in the manifest for documentation purposes (no runtime gating in v1):

```json
{
  "deps": ["gurney-everyday-assistant"]
}
```

## Worked example — quote of the day

A minimal but complete extension: fetches a quote from a public API on demand and on a daily schedule.

**`manifest.json`:**

```json
{
  "name": "gurney-qotd",
  "version": "1.0.0",
  "description": "Quote of the day from quotable.io",
  "gurney": ">=0.1.0",
  "capabilities": ["network", "scheduler", "telegram"],
  "entrypoints": {
    "tools": "./tools.ts",
    "commands": "./commands.ts",
    "jobs": "./jobs.ts"
  },
  "telegram_commands": [{ "command": "quote", "description": "Get today's quote" }]
}
```

**`tools.ts`:**

```ts
import type { Host } from '../../src/core/extensions.js';

export async function fetchQuote(): Promise<string> {
  const res = await fetch('https://api.quotable.io/random');
  if (!res.ok) throw new Error(`quotable API error: ${res.status}`);
  const data = (await res.json()) as { content: string; author: string };
  return `"${data.content}" — ${data.author}`;
}

export function register(host: Host): void {
  host.tools.register({
    name: 'get_quote',
    description: 'Fetch an inspirational quote.',
    parameters: { type: 'object', properties: {} },
    tier: 'auto',
    async invoke() {
      return await fetchQuote();
    },
  });
}
```

**`commands.ts`:**

```ts
import type { Host } from '../../src/core/extensions.js';
import { fetchQuote } from './tools.js';

export function register(host: Host): void {
  host.telegram.command(
    'quote',
    async (ctx) => {
      try {
        const quote = await fetchQuote();
        await ctx.reply(quote);
      } catch (e) {
        host.log.warn({ err: e }, 'quote fetch failed');
        await ctx.reply('Could not fetch a quote right now.');
      }
    },
    "Get today's quote",
  );
}
```

**`jobs.ts`:**

```ts
import type { Host } from '../../src/core/extensions.js';
import { fetchQuote } from './tools.js';

export function register(host: Host): void {
  host.telegram.command('quote-on', async (ctx) => {
    host.settings.set('nudge_chat_id', ctx.chatId);
    await ctx.reply('Daily quote nudges will come here.');
  });

  host.scheduler.cron('qotd.daily', '0 9 * * *', async () => {
    const configured = host.settings.get<number>('nudge_chat_id');
    const chatIds = configured
      ? [configured]
      : host.telegram.knownChats().map((chat) => chat.chatId);
    if (chatIds.length === 0 && host.telegram.defaultChatId) {
      chatIds.push(host.telegram.defaultChatId);
    }

    try {
      const quote = await fetchQuote();
      return chatIds.map((chatId) => ({
        chatId,
        text: quote,
        key: `qotd:${chatId}:${new Date().toISOString().slice(0, 10)}`,
      }));
    } catch (e) {
      host.log.warn({ err: e }, 'daily quote nudge failed');
      return [];
    }
  });
}
```

**Install and test:**

```sh
gurney ext create gurney-qotd   # (if starting from scratch)
gurney ext install ./gurney-qotd
# then in Telegram:
# /quote
```

## When in doubt

- Look at [`extensions/gurney-everyday-assistant/`](../extensions/gurney-everyday-assistant/) — it exercises every registry (tools, commands, jobs, auth, settings schema, migrations).
- Open a discussion or issue. It's much faster than guessing at the API.
