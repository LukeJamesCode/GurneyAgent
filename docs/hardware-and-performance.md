# Hardware and Performance

Gurney runs the same code everywhere. The **defaults** scale to the hardware; nothing is gated or disabled on smaller machines.

---

## Hardware tiers

`gurney init` detects RAM and CPU count and suggests a tier. You can override it freely — the tier is informational and doesn't gate any features.

| Tier       | Hardware               | Default chat model    | Reasoning model     | Memory ext  | TTS ext     |
| ---------- | ---------------------- | --------------------- | ------------------- | ----------- | ----------- |
| `small`    | Pi 4 / Pi 5, 4–8 GB    | `qwen3.5:0.8b`        | off                 | off         | off         |
| `standard` | Mini PC, 16 GB         | `qwen3.5:0.8b`        | `qwen3.5:9b` (cold) | optional    | optional    |
| `heavy`    | 5800H+ / server, 32 GB | `qwen3.5:0.8b` (warm) | `qwen3.5:9b` (warm) | recommended | recommended |

### Auto-detection logic

Tier is suggested from total RAM:

- < 12 GB → `small`
- 12–24 GB → `standard`
- ≥ 24 GB → `heavy`

CPU count is used as a sanity check: WSL2 and Docker containers can report low RAM caps on high-RAM machines. If the CPU count is ≥ 8 logical cores and the RAM suggests `small`, the suggestion bumps to `standard`. ≥ 12 cores bumps to `heavy`.

---

## Recommended models

These are the tested defaults. You can use any Ollama-compatible model by setting `GURNEY_CHAT_MODEL` etc.

| Profile               | Recommended tag | RAM resident (approx) | Notes                                          |
| --------------------- | --------------- | --------------------- | ---------------------------------------------- |
| Chat (small tier)     | `qwen3.5:0.5b`  | ~500 MB               | Fastest; 0.5B Q4_K_M                           |
| Chat (standard/heavy) | `qwen3.5:0.8b`  | ~700 MB               | Better quality, still fast on Pi 5             |
| Reasoning             | `qwen3.5:9b`    | ~5–6 GB               | Cold-loaded on demand (standard); warm (heavy) |

**Quantization:** use Q4_K_M rather than Q4_0. The K_M variant has measurably better output quality at near-identical speed. Pin this in your Modelfile to avoid accidentally pulling a worse variant:

```
FROM qwen3.5:0.8b
PARAMETER quantize q4_K_M
```

---

## Ollama configuration

These settings live in the Ollama process environment, not in Gurney's config.

### `OLLAMA_NUM_THREADS`

Set to your physical core count (not logical, not hyperthreaded).

| Device                  | Value                   |
| ----------------------- | ----------------------- |
| Raspberry Pi 4          | `4`                     |
| Raspberry Pi 5          | `4`                     |
| AMD 5800H               | `8`                     |
| Intel i7-12700H (6P+8E) | `6` (performance cores) |

Defaults to all logical cores. On a CPU with hyperthreading, using all logical cores actually hurts inference throughput because the two threads on one physical core compete for the same FPU.

```sh
# In /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_NUM_THREADS=4"
```

### `OLLAMA_FLASH_ATTENTION`

```sh
OLLAMA_FLASH_ATTENTION=1
```

Measurable speedup on qwen3.5 with no quality loss. Enable this on all hardware.

### Keep Ollama separate

Ollama must be a separate process or container. Never bundle it into Gurney's container. Cold-loading a 9B model from disk on CPU takes 30–60 seconds. A Gurney redeploy or restart must not pay that cost — Ollama should keep the model warm across Gurney restarts.

---

## Gurney performance mechanisms

### Deterministic prompt prefix for KV cache hits

The context manager always emits the prompt in the same order:

```
system → tools → memory → session → history
```

Ollama caches the KV state for recently-seen prompt prefixes. When the prefix is identical across turns (same system prompt, same tool list, same memory, same session summary), Ollama reuses the cached state and only processes the new history tail. This turns follow-up turns on a Pi 5 from ~8s to ~2–3s.

What breaks the cache:

- A new extension being loaded (changes the tool list)
- A memory update (changes the `memory` block)
- A session summary update (changes `session`)
- Any reordering of the above

What doesn't break it: new history turns, which are always appended at the end.

### Heavy-model eviction

On Standard and Heavy tiers, only one 7–9B model is kept resident at a time. When a reasoning request comes in on a machine that has the chat model warm, Gurney unloads the chat model (`keep_alive=0`) before loading the reasoning model, and vice versa. The idle eviction sweep (default 5 minutes, `GURNEY_HEAVY_IDLE_MS`) proactively evicts a heavy model that hasn't been used so it doesn't pin RAM until the next request.

### Boot warm-up

Gurney calls the chat profile with an empty prompt on startup to trigger Ollama's model load. The first real user message never pays the cold-load cost.

### Tool result truncation

Tool output longer than 2000 characters is truncated before being fed back to the model (`…[truncated]` marker appended). A large tool result — a 30-event calendar dump, a verbose web search — otherwise fills the model's context for several turns. Truncation keeps things fast and focused.

### Right-sizing profiles

The `tools` model profile (`GURNEY_TOOLS_MODEL`) lets you use a different (often larger) model for tool-selection turns and a small fast model for plain conversation. This trades a bit of extra cold-load time on tool turns for a faster baseline chat experience.

---

## Speculative decoding (Phase 7 benchmark)

qwen3.5:9B (draft: qwen3.5:0.5B) can give 1.5–2× wall-clock speedup on CPU with identical output quality. Speculation works by running the small draft model to generate candidate tokens cheaply, then verifying them in a single forward pass of the large model. Net effect: more tokens per second for the 9B model's quality.

This hasn't been enabled by default yet — the benchmark in `scripts/bench-spec-decode.mjs` must show ≥1.5× before it ships as default on Heavy tier. Run it on your hardware:

```sh
npm run bench:spec-decode
```

If it wins on your box, configure it in the Ollama Modelfile for the reasoning profile.

---

## Pi 4 — specific guidance

The Pi 4 (4 GB) is the design minimum. These settings are important:

### Swap

Enable at least 2 GB of swap (zram is better than a swap file on an SD card):

```sh
# zram swap — fast and doesn't wear the SD card
sudo apt install zram-tools
echo "ALGO=zstd" | sudo tee -a /etc/default/zramswap
echo "PERCENT=50" | sudo tee -a /etc/default/zramswap
sudo systemctl restart zramswap
```

### SD card vs. USB SSD

Run Ollama's model store on a USB SSD, not the SD card. Model files are large; SD card wear under repeated reads shortens its life, and a USB 3.0 SSD cold-loads models 2–3× faster.

### Model choice

Use `qwen3.5:0.5b` (chat, Q4_K_M) on a 4 GB Pi 4. The 0.8b model is tight but workable if you leave 1.5 GB headroom for the OS. Do **not** enable heavy extensions like `gurney-voice` on a 4 GB Pi — they need Standard or Heavy tier.

### Temperature throttling

Sustained LLM inference heats the Pi 4. With a good heatsink (not a fan-less case) the CPU stays at ~80°C and doesn't throttle. Verify with `vcgencmd measure_temp` and `vcgencmd measure_clock arm` while the bot is replying.

---

## Expected latency

| Device        | Model                    | First token | Full short reply |
| ------------- | ------------------------ | ----------- | ---------------- |
| Pi 4 (4 GB)   | qwen3.5:0.5b Q4_K_M      | ~1–2s       | ~5–10s           |
| Pi 5 (8 GB)   | qwen3.5:0.8b Q4_K_M      | ~0.5–1s     | ~3–6s            |
| 5800H (32 GB) | qwen3.5:0.8b Q4_K_M      | <0.5s       | ~1–3s            |
| 5800H (32 GB) | qwen3.5:9b Q4_K_M (warm) | ~1s         | ~8–20s           |

Warm model (cached KV prefix) vs cold: first-turn cold-load adds 30–60s on a Pi 4 with a 0.5b model from an SD card, 5–10s from a USB SSD. Subsequent turns at the same prefix are much faster.
