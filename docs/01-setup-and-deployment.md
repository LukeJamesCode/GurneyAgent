# 01. Setup and Deployment

This guide covers everything you need to know to get Gurney running on your hardware, from initial setup to optimal performance tuning.

## Hardware and Performance

Gurney runs the same code everywhere. The **defaults** scale to the hardware; nothing is gated or disabled on smaller machines. `gurney init` detects RAM and CPU count and suggests a tier. You can override it freely.

| Tier       | Hardware               | Default chat model    | Reasoning model     | Memory / TTS ext |
| ---------- | ---------------------- | --------------------- | ------------------- | ---------------- |
| `small`    | Pi 4 / Pi 5, 4–8 GB    | `qwen3.5:0.8b`        | off                 | off              |
| `standard` | Mini PC, 16 GB         | `qwen3.5:0.8b`        | `qwen3.5:9b` (cold) | optional         |
| `heavy`    | 5800H+ / server, 32 GB | `qwen3.5:0.8b` (warm) | `qwen3.5:9b` (warm) | recommended      |

### Recommended models
- **Chat (small tier)**: `qwen3.5:0.5b` (Q4_K_M) - ~500 MB
- **Chat (standard/heavy)**: `qwen3.5:0.8b` (Q4_K_M) - ~700 MB
- **Reasoning**: `qwen3.5:9b` - ~5–6 GB

> [!TIP]
> **Quantization:** Use `Q4_K_M` rather than `Q4_0`. The K_M variant has measurably better output quality at near-identical speed.

### Tier-aware context sizing
The configured tier scales three Ollama knobs per model profile (`num_ctx`, `num_predict`, and `keep_alive`) plus the orchestrator's prompt budget.

| Tier       | Chat `num_ctx` | Prompt budget | Reasoning `num_ctx` | Chat `keep_alive` |
| ---------- | -------------- | ------------- | ------------------- | ----------------- |
| `small`    | 4096           | 3584          | 8192                | 30m               |
| `standard` | 8192           | 6144          | 16384               | 15m               |
| `heavy`    | 16384          | 12288         | 32768               | 30m               |

### Heavy-model eviction
On Standard and Heavy tiers, only one 7–9B model is kept resident at a time. The idle eviction sweep proactively evicts a heavy model that hasn't been used so it doesn't pin RAM. 

---

## Installation Prerequisites
- **Node.js ≥ 20** (`node --version` to check)
- **Ollama** (Running locally or on your network, keep it as a separate process or container)
- **A Telegram bot token** (Create one with [@BotFather](https://t.me/BotFather))
- **Your Telegram user ID** (From [@userinfobot](https://t.me/userinfobot))
- **≥ 4 GB RAM**

> [!IMPORTANT]
> Pull the models in Ollama before starting: `ollama pull qwen3.5:0.8b`

---

## Deployment Options

### Option A — Native Node (Recommended for development)

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
npm install
npm run build
npm link          # adds `gurney` to your PATH
```

### Option B — Docker Compose (Recommended for always-on deployments)

The Compose file runs Ollama and Gurney as separate containers. 

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
cp .env.example .env
```
Edit `.env` with your values (Token, Allowed IDs, Model, etc.) and then:
```sh
docker compose run --rm ollama ollama pull qwen3.5:0.8b
docker compose up -d
docker compose exec gurney node dist/cli/index.js init
```
For Ollama performance in Docker, set `OLLAMA_NUM_THREADS` to your physical core count and `OLLAMA_FLASH_ATTENTION=1`.

### Option C — Raspberry Pi (Pi 4 or Pi 5)

Run Ollama's model store from a USB SSD, not the SD card.
```sh
sudo apt update && sudo apt upgrade -y
# Add zram swap
sudo apt install -y zram-tools
echo "ALGO=zstd" | sudo tee -a /etc/default/zramswap
echo "PERCENT=50" | sudo tee -a /etc/default/zramswap
sudo systemctl restart zramswap
```
Install Node 20 (via NodeSource) and Ollama (`curl -fsSL https://ollama.com/install.sh | sh`).
Configure Ollama threads (4 cores for Pi 4/5) via `/etc/systemd/system/ollama.service.d/override.conf`.

---

## 1. First-run wizard — `gurney init`

Run this once (or again any time you need to change core settings):
```sh
gurney init
```
The wizard sets up:
1. Telegram bot token
2. Allowed Telegram user IDs
3. Ollama URL
4. Chat model & Reasoning model
5. Hardware tier
Config is written to `~/.gurney/config.json`.

## 2. Pre-flight check — `gurney doctor`

Run this before the first start to catch any missing pieces:
```sh
gurney doctor
```
Verifies `home`, `config`, `ram`, `disk`, `extensions`, `migrations`, `ports`, `telegram`, and `ollama`.

## 3. Start the bot — `gurney start`

```sh
gurney start              # Foreground (logs to stdout)
gurney start --detach     # Background daemon (logs to ~/.gurney/log/gurney.log)
```

## 4. Monitor & Manage

```sh
gurney status          # one-shot health summary
gurney logs --follow   # tail -f the log file
gurney stop            # send SIGTERM to the daemon
gurney config          # interactive TUI for all core settings
gurney update          # update Gurney codebase
gurney fresh           # wipe all Gurney data and start fresh
```
