# Deploying on Raspberry Pi

Gurney is designed to run on a Pi 4 or Pi 5. This guide covers the OS setup, Ollama installation, and running Gurney as a background service.

---

## Requirements

| Item    | Minimum                                 | Recommended                           |
| ------- | --------------------------------------- | ------------------------------------- |
| Board   | Raspberry Pi 4 (4 GB)                   | Raspberry Pi 5 (8 GB)                 |
| OS      | Raspberry Pi OS Lite (64-bit, Bookworm) | Same                                  |
| Storage | 16 GB SD card                           | 64 GB+ USB SSD                        |
| Power   | Official 5V/3A USB-C PSU                | Same (undervoltage causes throttling) |

**Run Ollama's model store from a USB SSD, not the SD card.** Model files are large; SD cards wear out under repeated reads, and a USB 3.0 SSD cold-loads models 2–3× faster.

---

## 1. OS setup

Flash Raspberry Pi OS Lite (64-bit) with the Raspberry Pi Imager. Enable SSH in the imager's advanced settings. Boot and connect.

```sh
# Update everything first
sudo apt update && sudo apt upgrade -y

# Add swap (zram — fast and doesn't wear the SD card)
sudo apt install -y zram-tools
echo "ALGO=zstd" | sudo tee -a /etc/default/zramswap
echo "PERCENT=50" | sudo tee -a /etc/default/zramswap
sudo systemctl restart zramswap

# Verify swap is active
free -h
```

---

## 2. Install Node.js 20+

Pi OS Bookworm ships Node 18 via apt. Install Node 20 via NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should print v20.x.x
```

---

## 3. Install Ollama

```sh
curl -fsSL https://ollama.com/install.sh | sh
```

The installer creates a systemd service and starts Ollama automatically.

**Move the model store to your USB SSD** (if using one):

```sh
sudo systemctl stop ollama

# Assuming your SSD is mounted at /mnt/ssd
sudo mkdir -p /mnt/ssd/ollama
sudo mv /usr/share/ollama/.ollama /mnt/ssd/ollama/.ollama
sudo ln -s /mnt/ssd/ollama/.ollama /usr/share/ollama/.ollama

sudo systemctl start ollama
```

**Configure threads** — set to physical core count (4 for both Pi 4 and Pi 5):

```sh
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_NUM_THREADS=4"
Environment="OLLAMA_FLASH_ATTENTION=1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Pull the chat model:**

```sh
ollama pull qwen3.5:0.8b      # Pi 5 (8 GB) — recommended
# or
ollama pull qwen3.5:0.5b      # Pi 4 (4 GB) — if RAM is tight
```

---

## 4. Install Gurney

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git ~/gurney
cd ~/gurney
npm install
npm run build
npm link          # makes the `gurney` binary available on your PATH
```

Verify:

```sh
gurney --version
```

---

## 5. First-run setup

```sh
gurney init
```

The wizard will ask for:

- Your Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- Ollama URL: press Enter for the default `http://localhost:11434`
- Chat model: pick `qwen3.5:0.8b` (or `0.5b` on a 4 GB Pi 4)
- Hardware tier: the wizard will suggest `small` — accept it

```sh
gurney doctor     # verify everything is green
```

---

## 6. Run as a systemd service

Running Gurney as a systemd service means it starts on boot and restarts on crash.

```sh
sudo tee /etc/systemd/system/gurney.service <<EOF
[Unit]
Description=Gurney AI Agent
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/gurney
ExecStart=$(which node) dist/cli/index.js start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gurney
sudo systemctl start gurney
```

Check the service:

```sh
sudo systemctl status gurney
journalctl -u gurney -f    # follow logs
```

---

## 7. Monitor and update

```sh
# Check bot health
gurney status

# View logs (when running under systemd, logs go to journald)
journalctl -u gurney -f

# Update Gurney
cd ~/gurney
gurney update              # pulls code, reinstalls deps, rebuilds
sudo systemctl restart gurney
```

---

## Pi 4 (4 GB) — extra considerations

The Pi 4 with 4 GB is the minimum supported device. It works, but you need to be deliberate:

- Use `qwen3.5:0.5b` (chat model). The 0.8b model fits but leaves little headroom.
- Do not enable heavy extensions like `gurney-voice` — they require Standard or Heavy tier.
- Check for thermal throttling under load: `vcgencmd measure_temp`. Values above 85°C indicate you need better cooling.
- The first reply after start takes 10–30s (cold model load from SSD; 30–60s from SD card). Subsequent replies in the same conversation are much faster (KV cache hit).

---

## Troubleshooting Pi-specific issues

### "cannot allocate memory" / OOM kill

The kernel killed Ollama or Gurney because RAM ran out. Add or increase zram swap:

```sh
echo "PERCENT=75" | sudo tee /etc/default/zramswap
sudo systemctl restart zramswap
```

### Slow first-reply every time

The chat model is being cold-loaded from disk every time because it's being evicted. This can happen if something else is consuming RAM between conversations. Check `ollama ps` — if the model isn't listed, it was unloaded. The idle eviction timer (`GURNEY_HEAVY_IDLE_MS`) won't evict a 0.5b/0.8b model unless it's classified as a heavy model, so this is usually an OS-level memory pressure issue.

### CPU throttling

```sh
vcgencmd measure_clock arm   # should be 1800000000 (1.8 GHz) on Pi 4
vcgencmd measure_temp        # should be < 80°C
```

If clock speed is below max, the CPU is throttling — improve cooling.
