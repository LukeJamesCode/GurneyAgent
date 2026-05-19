# Troubleshooting

Common problems and how to fix them. Run `gurney doctor` first — it catches most setup issues automatically.

---

## `gurney doctor` check failed

### `home` — `~/.gurney/ does not exist`

You haven't run the setup wizard yet:

```sh
gurney init
```

---

### `config` — missing required values

The wizard didn't complete or the config file was manually edited incorrectly. Run `gurney init` again; existing values load as defaults.

Check the config directly:

```sh
cat ~/.gurney/config.json
```

Missing fields: `telegram.token`, `telegram.allowedIds`, `ollama.url`, `models.chat`.

---

### `ram` — only X.X GB total

The bot is being run on a device with less than 4 GB RAM. Use a model with a smaller footprint (`qwen3.5:0.5b`, ~500 MB), or add swap (see [hardware-and-performance.md](./hardware-and-performance.md)).

---

### `disk` — only X.XX GB free

Free up disk space. Model files typically live in `~/.ollama/models/` and can be several GB. Remove unused models with `ollama rm <tag>`.

---

### `extensions` — folder without manifest.json

A directory under one of the extension search roots doesn't have a `manifest.json`. Either it's a half-extracted archive or an unrelated directory. Remove it or add a valid manifest.

---

### `migrations` — checksum mismatch

A migration file was edited after it was applied to the database. This corrupts the migration state — the DB schema no longer matches what the code expects.

**Fix**: If the DB has no data you care about, delete it and let Gurney recreate it:

```sh
rm ~/.gurney/gurney.db
gurney start
```

If you need to preserve data, figure out what changed in the migration file, and either revert the file to its original content or write a compensating migration.

---

### `migrations` — pending migrations

Gurney has migrations that haven't been applied yet. This is usually fine — they will run automatically on next start. If `gurney start` fails after this warning, check the logs for the SQL error.

---

### `env` — deprecated or unknown env vars

A stale env var from an old Gurney version is set in your shell or `.env` file. Follow the `doctor` output to identify which and remove or rename it.

---

### `ports` — port X on localhost is FREE

Nothing is listening on Ollama's expected port. Start Ollama:

```sh
ollama serve            # foreground
# or
systemctl start ollama  # if installed as a systemd service
```

---

### `telegram` — getMe HTTP 401

The bot token is invalid or was revoked. Get a new token from [@BotFather](https://t.me/BotFather) (`/newbot` or `/mybots` → select bot → `API Token`) and update it:

```sh
gurney config   # edit telegram.token
```

---

### `ollama` — unreachable

Ollama is not running or the configured URL is wrong.

```sh
curl http://localhost:11434/api/tags   # should return JSON
```

If the URL is different, update it:

```sh
gurney config   # edit ollama.url
```

---

### `ollama` — missing models

Ollama is running but doesn't have the configured model. Pull it:

```sh
ollama pull qwen3.5:0.8b
ollama pull qwen3.5:9b    # if reasoning is configured
```

---

## Bot doesn't respond to messages

**1. Check the bot is running:**

```sh
gurney status
```

**2. Check you're using an allowed Telegram user ID:**
Messages from IDs not in `telegram.allowedIds` are silently dropped. Confirm your ID is listed:

```sh
cat ~/.gurney/config.json
```

Your Telegram ID: send a message to [@userinfobot](https://t.me/userinfobot).

**3. Check for errors:**

```sh
gurney logs --follow
```

Send a message to the bot and watch for error lines.

**4. Check in-bot:**
Type `/lasterror` in the chat to see the last orchestrator failure for that chat.

---

## Bot replies "I'm having trouble connecting to my language model"

Ollama stopped responding. Check:

```sh
curl http://localhost:11434/api/tags
ollama ps        # show loaded models
```

The circuit breaker opens after repeated failures and fails fast until Ollama recovers. Once Ollama is healthy again, the breaker half-opens and closes after a few successful probes — no restart needed.

---

## Replies are very slow (> 30s)

**Cold-load:** The model is being loaded from disk. The first reply after starting the bot (or after an idle eviction) is always slower. Subsequent replies at the same prompt prefix are much faster.

**Model too large:** On a Pi 4 with 4 GB RAM, the 0.8b model may cause swapping if the OS isn't trimmed. Switch to 0.5b or add zram swap.

**CPU thread count:** Check `OLLAMA_NUM_THREADS`. If it's not set, Ollama uses all logical cores including hyperthreads, which can hurt throughput. Set it to physical core count.

**KV cache miss:** If every reply is slow (not just the first), the prompt prefix may be changing between turns. Check that no extension is doing something non-deterministic in its prompt fragment registration.

---

## Extension fails to load

**Check the logs:**

```sh
gurney logs | grep -i "extension\|error" | tail -40
```

**Common causes:**

- **Manifest missing or invalid**: the `name` field must match the folder name exactly.
- **TypeScript error in entrypoint**: the extension's `register()` function threw during import. The error is logged with the extension name.
- **Missing dependency extension**: some tools in `gurney-everyday-assistant` require Google OAuth — run `gurney auth gurney-everyday-assistant` if calendar or tasks tools fail.
- **Migration error**: a per-extension SQL migration failed. Check for syntax errors in `extensions/<name>/migrations/`.

---

## `gurney auth` OAuth flow fails

**"Redirect URI mismatch" from Google:**
The OAuth callback server opens on a random port. Make sure you have `http://localhost` (without a specific port, or with port `8080`) added to the "Authorized redirect URIs" list in Google Cloud Console for your OAuth client.

**Token expired immediately:**
This can happen if your system clock is wrong. Google OAuth rejects tokens with a large clock skew. Check:

```sh
date
```

Fix with `timedatectl set-ntp true` (systemd) or `sudo ntpdate pool.ntp.org`.

**Re-running auth:**

```sh
gurney auth gurney-everyday-assistant    # runs the flow again; overwrites the stored token
```

---

## Hot-reload isn't picking up extension changes

The filesystem watcher monitors mtime changes. If you edited a file but the bot didn't reload:

1. **Touch the folder manually:**

   ```sh
   gurney ext reload gurney-myext
   ```

2. **Check the watcher is running:** look for `[info] watching extensions` in the logs.

3. **In a Docker container:** volume mounts from some host OSes don't propagate mtime events. Use `gurney ext reload` explicitly instead of relying on file-watch events.

---

## `gurney start --detach` leaves no PID file

The daemon may have crashed immediately after forking. Check:

```sh
cat ~/.gurney/log/gurney.log | tail -20
```

Common cause: a config error that `gurney doctor` would have caught — missing token, Ollama unreachable, etc.

---

## DB locked error

`better-sqlite3` is synchronous and doesn't support multiple writers. If two `gurney` processes are running against the same `gurney.db`, one will get a `SQLITE_BUSY` error.

Check for a stale process:

```sh
cat ~/.gurney/gurney.pid
ps aux | grep gurney
```

Kill the stale process and restart:

```sh
gurney stop
gurney start --detach
```

---

## Out of memory on Pi 4

Symptoms: bot stops responding, Ollama process killed, `dmesg | grep -i oom` shows kills.

**Immediate fix:**

```sh
gurney stop
# then reduce model size or add swap before restarting
```

**Longer term:**

- Switch to `qwen3.5:0.5b`
- Add zram swap (see [hardware-and-performance.md](./hardware-and-performance.md))
- Disable heavy extensions (`gurney-memgraph`, `gurney-tts`)
- Set `GURNEY_HEAVY_IDLE_MS=60000` to evict heavy models after 1 minute of idle instead of 5

---

## Getting more help

- `/lasterror` in the bot chat shows the last orchestrator error
- `gurney logs --follow` shows real-time structured JSON logs
- `gurney doctor` runs all preflight checks at once
- Open an issue at the project repo with the output of `gurney doctor` and the relevant log lines
