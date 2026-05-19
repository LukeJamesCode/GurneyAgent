# Public release checklist (1.0)

Run through this before tagging a release. Each box is a real gate — don't tick what you didn't run.

## Code health

- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `npm run typecheck` passes for core **and** every bundled extension
- [ ] `npm test` green on Node 20 and Node 22 (CI matrix)
- [ ] `docker compose config --quiet` clean
- [ ] `npm audit` reviewed; high/critical resolved or documented

## Smoke tests against real services

- [ ] `gurney init` end-to-end against a real Ollama + real Telegram bot
- [ ] `gurney doctor` returns all-green on a fresh machine
- [ ] `gurney start` → bot replies in Telegram on first message
- [ ] `gurney start --detach` writes a PID, logs to `~/.gurney/log/gurney.log`, `gurney stop` exits cleanly
- [ ] `gurney ext install` works for all three install sources:
  - [ ] local path
  - [ ] git URL
  - [ ] bare registry name (via `extensions/registry.json`)
- [ ] `gurney ext install gurney-everyday-assistant` followed by `gurney auth gurney-everyday-assistant` walks a Google OAuth flow to completion
- [ ] Hot-reload picks up an edit to an extension file without restarting the bot

## Hardware-tier verification

- [ ] **Pi 4 (4 GB)** — 24 hours of light traffic, no OOM, no restart loop, no >5 s reply latency on `qwen3.5:0.5b`. Blocking for 1.0 (North Star #1).
- [ ] **Pi 5 (8 GB)** — `qwen3.5:0.8b` chat warm; reply latency < 3 s
- [ ] **Mini PC / 5800H (≥16 GB)** — `qwen3.5:9b` cold-load time documented; eviction confirmed working
- [ ] **5800H (32 GB)** — both profiles warm; speculative-decoding benchmark run and documented

## Performance

- [ ] `npm run bench:spec-decode` against a Heavy-tier box — record the speed-up; if ≥1.5× ship as default for Heavy tier reasoning, otherwise leave off and document
- [ ] Slot-cache hit rate sampled in `gurney status` after a day of use — no obvious cache misses on the deterministic prompt prefix
- [ ] Heavy-model eviction observed: only one 7–9 B model resident at a time

## Migration & state safety

- [ ] `tools/migrate-from-atlas/` (if present) imports a real ATLAS DB without data loss
- [ ] Numbered migrations checksum cleanly — `gurney doctor` reports no pending or mismatched migrations on an upgraded install
- [ ] `gurney ext uninstall <name>` keeps settings, `--purge` drops them, and downstream extensions fail loudly if a hard dep is missing

## Security & privacy

- [ ] `gurney config` masks secrets (telegram token, OAuth refresh tokens, API keys)
- [ ] Logger redacts secrets in error paths (regression-test the redact pipeline)
- [ ] No telemetry without explicit opt-in
- [ ] No outbound calls on first run other than the user-configured services (Ollama, Telegram, the extensions they installed)
- [ ] Threat model documented for each capability: `network`, `storage`, `auth:oauth`
- [ ] `SECURITY.md` lists how to report a vulnerability

## Documentation

- [ ] `README.md` reflects the actual subcommand surface; quick-start cheatsheet works copy-paste
- [ ] `CLAUDE.md` agrees with shipping behaviour
- [ ] `CONTRIBUTING.md` exists and has a working setup section
- [ ] `docs/extension-authoring.md` exists and matches the real `Host` API
- [ ] Each bundled extension has a `README.md` covering: what it does, settings, auth flow, data it stores
- [ ] CHANGELOG (or release notes) summarizes everything user-visible since the last tag

## Distribution

- [ ] `package.json` `version` bumped
- [ ] `bin` field installs `gurney` correctly via `npm link`
- [ ] Docker image builds and `docker compose up` starts cleanly without manual intervention
- [ ] `extensions/registry.json` lists every first-party extension with the correct git URL + subpath
- [ ] Tag pushed; release notes published

## Post-release

- [ ] At least one bug report / question received and answered within a week (silence is suspicious)
- [ ] Telemetry — even passive (npm-download counts, GitHub stars) — sampled for shape
- [ ] Pi-4 deployment still healthy after a week

If any of the blocking items above (Pi 4 soak, end-to-end smoke, doctor, registry install) fail, do not ship. The North Stars don't bend for a release date.
