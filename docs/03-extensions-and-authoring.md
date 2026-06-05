# 03. Extensions and Authoring

Gurney is designed so that almost nothing is built-in — capabilities are provided by extensions. Extensions are drop-in mods: placing a folder in `~/.gurney/extensions/<name>/` makes new tools and Telegram commands appear without restarting the bot.

## Building an Extension

### TL;DR

```sh
gurney ext create gurney-myext        # scaffolds ./gurney-myext/ ready to edit
gurney ext install ./gurney-myext     # picks it up locally
```

### manifest.json (Required)
Every extension needs a `manifest.json`.

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
  "telegram_commands": [{ "command": "myext", "description": "Run the thing" }],
  "intent_pattern": "\\b(event|events|meeting|calendar|schedule)\\b"
}
```

The `intent_pattern` is an optional regex. If provided, the orchestrator tests the user's message against it. The extension's tools are only injected if the message matches, keeping the LLM context lean.

### The `host` API

Runtime entrypoints export `register(host)`. 

- **Identity & Filesystem**: `host.name`, `host.version`, `host.log`, `host.dataDir`.
- **Shared Services**: `host.db`, `host.llm`.
- **Settings**: `host.settings.get('key')`, `host.settings.set('key', value)`.
- **Tools (LLM-callable)**: 
  ```ts
  host.tools.register({
    name: 'list_my_things',
    description: 'List things.',
    parameters: { type: 'object', properties: {} },
    tier: 'auto', // 'auto', 'confirm', or 'owner'
    handler: async ({ args }) => ({ ok: true, result: ['a', 'b'] }),
  });
  ```
- **Telegram commands**: `host.telegram.command(...)`
- **Scheduler (cron)**: `host.scheduler.cron('myext.sweep', '*/5 * * * *', async () => { ... })`
- **Prompt fragments**: `host.prompts.contribute("System prompt instruction...")`
- **Auth flows**: `host.auth.flow({ label: 'Authorize', run: async (io) => ... })`

### Settings Schema (`settings.schema.json`)
Rendered by `gurney config` as a TUI. Fields marked with `"secret": true` are masked in prompts but stored plaintext in the local SQLite DB.

### Migrations
Place `migrations/0001_init.sql` in your folder. The loader runs it under a private table `_ext_<your_name>_migrations`.

### Post-reply lifecycle hooks
- `host.telegram.afterReply(ctx)`: Lightweight hook that fires after every reply. Perfect for TTS.
- `host.telegram.afterTurn(ctx)`: Rich hook that fires after the full user/assistant turn, providing timing, tool-call results, and texts. Perfect for learning and routines.

---

## Bundled Extensions

### 1. gurney-everyday-assistant
Combines Calendar, Tasks, Reminders, Weather, and Briefings.
- **Tools**: Calendar list/add/delete, Tasks list/add/complete, Weather fetching, Reminders.
- **Commands**: `/events`, `/quickadd`, `/todos`, `/weather`, `/morningbrief`, etc.
- **Learned Routines**: Watches user habits (e.g. asking for tomorrow's schedule every night) and automatically proposes recurring nudges.
- **Requires Google OAuth**. (See the section below).

### 2. gurney-instant-responses
Intercepts trivial chatter ("hi", "thanks") and tool intents ("what's the weather") to send immediate templated replies before the LLM finishes, making the bot feel lightning fast.

### 3. gurney-voice
Two-way Telegram voice. Outbound replies via Piper (TTS) and inbound transcription via whisper.cpp.
- Run `/voice on` and `/voice transcribe on` in chat to enable.
- CPU-heavy; recommended for Standard or Heavy tiers only.

### 4. gurney-websearch (Planned for v1.4)
Web search via DuckDuckGo instant answers, with an optional SearXNG backend for full result sets. LLM-driven tool `web_search`.

### 5. gurney-memgraph (Planned for v1.4)
Long-term memory backed by FalkorDB. Heavy extension. Adds `/memory`, `/remember`, and background sweeps for fact extraction.

---

## Google OAuth Setup (For gurney-everyday-assistant)

To use Calendar and Tasks features, you need to authorize the extension.

1. Go to [Google Cloud Console](https://console.cloud.google.com/). Create a new Project.
2. Under **APIs & Services → Library**, enable **Google Calendar API** and **Google Tasks API**.
3. Under **OAuth consent screen**, choose **External**. Add your Google account email as a Test user. Publish the app to prevent the 7-day token expiry.
4. Under **Credentials**, create a new **OAuth client ID** of type **Desktop app**.
5. Run `gurney auth gurney-everyday-assistant` in your terminal. Paste the Client ID and Secret when prompted.
6. A browser window will open to authorize access. The flow completes automatically via a local callback server.
