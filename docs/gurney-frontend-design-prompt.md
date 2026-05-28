# Design Prompt: Gurney Frontend — the Gurney Hub

> Paste this into a Claude design/artifact session to generate the UI for the
> `gurney-frontend` extension. It is self-contained — Claude does not need access
> to the Gurney repo to produce a high-fidelity, interactive prototype from this.

---

## Your task

Design and build an interactive, high-fidelity web UI prototype for **Gurney Frontend**,
the local web "hub" for an open-source, self-hosted AI agent called **Gurney**.

Today, everything in Gurney is done through a terminal CLI. We want a friendly web app
that lets a non-technical person do *everything the CLI can do* — first-time setup,
running the agent, installing/configuring/removing extensions, editing settings, and
watching logs/status — without ever touching a terminal.

Build it as a clickable prototype (React + Tailwind, single-page app with client-side
routing/tabs, mock data and mock state). Make every primary flow navigable. Prioritize
**clarity and ease for a beginner** over density. This runs **locally on the user's own
hardware** (anything from a Raspberry Pi to a mini PC) and is served on the LAN — so it
should feel like a calm, trustworthy "home server" control panel, not a flashy SaaS dashboard.

---

## What Gurney is (context you need to design well)

- **Gurney** is a small, private, self-hosted AI assistant that runs on the user's own
  hardware (CPU-only, Raspberry Pi → mini PC). It uses local models via **Ollama** and is
  private by default — nothing leaves the user's machine unless an extension explicitly does so.
- The agent's main chat surface today is **Telegram** (the user talks to their bot in Telegram).
  Gurney runs as a background process (daemon) that long-polls Telegram, runs the model,
  calls tools, and replies.
- Gurney is **extension-driven**: a minimal core plus optional extensions that add real
  capabilities (calendar, reminders, weather, voice, etc.). Extensions can declare tools the
  AI can call, Telegram commands, scheduled jobs, OAuth/auth flows, and their own settings.
- **Gurney Frontend is itself one of these extensions.** Installing it spins up a local web
  server that hosts this UI. It is strictly opt-in; the CLI remains fully usable on its own.

### Glossary (use this language in the UI, define gently for beginners)
- **Gurney Core**: the base agent (its connection to Telegram, to the local model server, and its settings).
- **Ollama**: the local model server that runs the AI models on-device. Has a URL (default `http://localhost:11434`).
- **Model profiles**: Gurney uses up to three model "slots": **Chat** (fast, default), **Reasoning** (bigger, optional, for hard problems), **Tools** (for tool-calling; falls back to Chat).
- **Hardware tier**: a hint about the machine's power — `Small` / `Standard` / `Heavy` — auto-suggested from RAM, user-overridable.
- **Extension**: an installable add-on. Can be enabled/disabled, configured, and uninstalled.
- **Allowlist**: the Telegram user IDs allowed to talk to the bot.
- **The daemon / "running" state**: whether the agent is currently live and answering messages.

---

## The two entry scenarios you must design for

### Scenario A — First-run setup handoff from the CLI
During CLI setup (`gurney init` or a fresh install), the CLI asks:
**"Would you like to install Gurney Frontend and set Gurney up in your browser?"**

- If **yes**: the CLI installs the frontend extension, starts the local web server, and
  prints a URL (e.g. `http://localhost:7777` or the LAN IP). The user opens it and lands in a
  **guided setup wizard** that walks them through configuring Gurney Core and choosing extensions
  — i.e. the web UI takes over the rest of setup from the CLI.
- If **no**: setup continues in the terminal as normal (you don't need to design that path,
  but the web UI should still offer the same setup later for people who change their mind).

So the UI has **two states**: a **first-run guided setup** (nothing configured yet) and the
**main hub** (returning user, already set up). Design both, and make the wizard's last step
drop the user into the hub.

### Scenario B — Returning user opens the hub
They land on the main hub with the agent either running or stopped, and use the tabs to manage everything.

---

## Required surfaces (design all of these)

### 1. First-run Setup Wizard (mirrors `gurney init`, but friendly)
A step-by-step wizard with progress indication, a back button, sensible defaults, inline
validation, and plain-language help on every field. Steps:

1. **Welcome** — what Gurney is, that it runs privately on this machine, what we're about to set up.
2. **Connect Telegram** — paste a Telegram bot token. Provide a "How do I get a token?"
   helper (talk to @BotFather). Validate the token live and show the bot's name/username on success.
3. **Who can talk to it (Allowlist)** — add one or more Telegram user IDs that are allowed to
   chat with the bot. Include a "How do I find my ID?" helper. Show added users as removable chips.
4. **Local model server (Ollama)** — Ollama URL with a "Test connection" button that shows
   reachable/unreachable and lists detected models.
5. **Choose models** — pick the **Chat** model from detected models (or enter a tag manually),
   optionally pick a **Reasoning** model (with a clear "Skip — my hardware is small" option),
   and optionally a **Tools** model (defaults to Chat). Explain each slot in one sentence.
6. **Hardware tier** — show auto-detected RAM and a suggested tier; let the user confirm or override (Small/Standard/Heavy).
7. **Pick your extensions** — a gallery of available extensions with toggles to install now
   (see the extension list below). Some require extra auth (e.g. Google) — flag that they'll be
   prompted to connect after install. This is optional; they can skip and add later.
8. **Review & finish** — summary of everything chosen, a "Start Gurney" button. On finish,
   land in the **main hub** with the agent starting up.

Design empty/loading/error states for the live checks (token invalid, Ollama unreachable, no models found).

### 2. Main Hub layout
A persistent left sidebar (or top tab bar) navigation with these sections, plus a global
**agent status indicator** always visible (Running / Stopped / Starting / Error) and a global
**Start / Stop** control. Sections:

#### a) Chat Hub (primary landing for returning users)
- A **Start / Stop** button for the agent (the daemon), with clear running/stopped/starting states.
- "Normal controls": **Restart**, **New chat / clear conversation**, **Stop current reply** (abort an in-flight answer), and a **quiet/proactive** toggle (whether the agent can send unprompted nudges).
- A **live chat view** so the user can talk to Gurney directly from the web UI (mirroring what
  they'd do in Telegram) — message list with streaming assistant replies, an input box, and a
  visible indicator when the agent is "thinking" or "calling a tool."
- A compact **live activity / status strip**: model in use, queue depth, last error (if any),
  connection health to Telegram and Ollama.

#### b) Extensions
- A tab listing **available** extensions (from a registry) and **installed** ones, clearly distinguished.
- For each extension: name, description, version, capabilities (e.g. "network", "storage", "uses Google account"), and an **Install** button.
- For installed extensions: **Enable/Disable** toggle, **Settings** (opens a settings form generated from the extension's schema — string/number/boolean/enum fields, with secret fields masked), **Connect / Re-auth** (for extensions needing OAuth, e.g. Google Calendar), and **Uninstall** (with a "also delete its data/settings" option and a confirmation).
- Show an extension detail view: what tools it adds, what Telegram commands it provides, what scheduled jobs it runs, and its settings.

#### c) Settings (Gurney Core)
Edit everything that's in core config, in friendly forms grouped into sections:
- **Telegram**: bot token (masked, re-validate button), allowlist management.
- **Model server**: Ollama URL + test button.
- **Models**: Chat / Reasoning / Tools profile pickers (re-run model picker).
- **Hardware tier**: Small/Standard/Heavy.
- **Logging level**: debug/info/warn/error.
- Note which values can be overridden by environment variables (show a small "set by environment" lock when applicable).

#### d) System / Diagnostics (the rest of the CLI, integrated)
This is where the remaining CLI power-features live so nothing is lost:
- **Status dashboard** (`gurney status`): running?, Ollama reachable?, models loaded, allowlist count, extensions enabled, queue depth.
- **Doctor** (`gurney doctor`): a one-click health check that runs a list of preflight checks
  (home dir, config, RAM, disk, extensions, migrations, env vars, ports, Telegram, Ollama) and
  shows each as pass/warn/fail with remediation hints.
- **Logs** (`gurney logs -f`): a live, follow-mode log viewer (structured JSON lines rendered
  readably) with severity filtering and search. Secrets are redacted.
- **Maintenance**: **Update Gurney** (pull + rebuild) and a clearly-guarded, destructive
  **Fresh install / Reset** action (wipes config and re-runs setup) behind a strong confirmation.
- **Telegram bot commands reference**: a readable list of the slash commands available in the
  Telegram chat (e.g. `/newchat`, `/status`, `/model`, `/doctor`, `/voice`, reminders, etc.) so
  users know what they can type in Telegram too.

### CLI → UI feature mapping (make sure each is reachable somewhere)
- `gurney init` / `gurney models` → Setup Wizard + Settings
- `gurney start` / `gurney stop` → Chat Hub Start/Stop
- `gurney config` → Settings + per-extension Settings forms
- `gurney auth <ext>` → extension "Connect / Re-auth"
- `gurney status` / `gurney doctor` / `gurney logs` → System / Diagnostics
- `gurney update` / `gurney fresh` → System / Maintenance
- `gurney ext list/install/enable/disable/uninstall/reload` → Extensions tab

---

## Available extensions to populate the gallery (use these as realistic mock data)
- **Everyday Assistant** — Google Calendar, tasks, local reminders, weather, daily briefings, day-planning. Requires connecting a Google account.
- **Voice** — two-way Telegram voice: text-to-speech replies and voice-note transcription.
- **Instant Responses** — fast templated replies for trivial chatter.
- **Speaker (ESP32 puck)** — connects a small hardware speaker/mic device over the local network; depends on Voice.
- **Codex** — escalates hard coding tasks to a more capable cloud coding model; local-first fallback.

(Each should show description, version like `0.1.0`, capabilities, and install/enable/settings/uninstall controls.)

---

## Design direction & constraints
- **Audience**: a curious but non-technical home user setting up their own private AI. Reduce
  jargon; explain Telegram/Ollama/models in one friendly line where they appear. Power users
  should still find depth in System/Diagnostics.
- **Tone/visual**: calm, trustworthy, "self-hosted home control panel." Light and dark themes.
  Generous spacing, clear primary actions, obvious system status at a glance. Think Tailscale /
  Home Assistant / a clean NAS admin UI — not a neon crypto dashboard.
- **Privacy-forward**: surface the "runs locally / your data stays on this machine" idea. Mark
  any extension that talks to the network or a cloud account.
- **Lightweight feel**: this may run on a Raspberry Pi served over the LAN. Keep it snappy and
  uncluttered; avoid heavy visual effects.
- **Trust & safety in destructive actions**: Stop, Uninstall (+purge), Reset/Fresh, and token
  changes need clear confirmations and consequences spelled out.
- **States everywhere**: design empty, loading, success, and error states for setup checks,
  chat streaming, extension installs, and the agent start/stop transitions.
- **Responsive**: works well on a laptop and is usable on a phone (people will check it from their couch).
- **Accessibility**: keyboard navigable, good contrast, clear focus states, labeled controls.

---

## Deliverable
A polished, interactive React + Tailwind prototype with:
1. The **first-run Setup Wizard** (all steps, with mock live-validation states).
2. The **main Hub** with working tab navigation between **Chat Hub**, **Extensions**, **Settings**, and **System/Diagnostics**.
3. A global agent **status indicator + Start/Stop** present across the hub.
4. Realistic mock data (the extensions above, sample logs, sample chat, sample status), and
   simulated transitions (e.g. clicking Start moves Stopped → Starting → Running).
5. Both **light and dark** themes.

Make it clickable end-to-end: a new user should be able to walk from "I just installed this"
through setup and into managing a running agent, entirely in the browser.
