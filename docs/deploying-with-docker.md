# Deploying with Docker Compose

The recommended way to run Gurney in an always-on or server environment. Ollama and Gurney run as separate containers — a Gurney redeploy never unloads the LLM.

---

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- At least 6 GB RAM available to Docker
- Ollama models pulled before first start

---

## Quick start

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
cp .env.example .env
```

Edit `.env` with your values:

```sh
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_IDS=123456789
GURNEY_CHAT_MODEL=qwen3.5:0.8b
```

Pull the model into the Ollama container:

```sh
docker compose run --rm ollama ollama pull qwen3.5:0.8b
```

Start everything:

```sh
docker compose up -d
```

Run the setup wizard inside the Gurney container:

```sh
docker compose exec gurney node dist/cli/index.js init
```

---

## The Compose file

The `docker-compose.yml` ships two services by default:

### `ollama`

The Ollama service. Runs independently; its model cache persists in a named volume (`ollama-data`) so models survive container rebuilds.

Key design decision: Ollama is a **separate container**. If you rebuild or restart the `gurney` container, Ollama keeps running and the model stays loaded. The first message to a freshly restarted Gurney costs only the Gurney startup time (~2s), not a 30–60s model reload.

### `gurney`

The Gurney agent. Mounts a volume at `/data` which maps to `GURNEY_HOME` (`~/.gurney` inside the container). Config, the SQLite DB, logs, and extension state all persist in this volume.

---

## Configuration

The Gurney container reads config from environment variables first, then from `/data/config.json` (written by `gurney init`). For Docker deployments the simplest approach is env vars in your `.env` file:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_IDS=123456789
OLLAMA_URL=http://ollama:11434
GURNEY_CHAT_MODEL=qwen3.5:0.8b
GURNEY_REASON_MODEL=qwen3.5:9b
GURNEY_LOG_LEVEL=info
```

`OLLAMA_URL` must use the service name (`ollama`) not `localhost` — the containers are on a shared network.

See [configuration-reference.md](./configuration-reference.md) for all env vars.

---

## Running CLI commands inside the container

```sh
# Status and health
docker compose exec gurney node dist/cli/index.js status
docker compose exec gurney node dist/cli/index.js doctor

# Change config interactively
docker compose exec -it gurney node dist/cli/index.js config

# Install an extension
docker compose exec -it gurney node dist/cli/index.js ext install gurney-everyday-assistant

# Authorize an extension
docker compose exec -it gurney node dist/cli/index.js auth gurney-everyday-assistant

# View logs
docker compose logs -f gurney
```

---

## Installing extensions in Docker

Extensions installed via `gurney ext install` land in `/data/extensions/<name>/` inside the container, which is persisted in the `gurney-data` volume.

```sh
docker compose exec -it gurney node dist/cli/index.js ext install gurney-everyday-assistant
docker compose exec -it gurney node dist/cli/index.js auth gurney-everyday-assistant
docker compose exec -it gurney node dist/cli/index.js ext reload gurney-everyday-assistant
```

Bundled extensions (in `<repo>/extensions/`) are baked into the image. They don't need `ext install`.

---

## Long-term memory extension (gurney-memgraph)

`gurney-memgraph` needs FalkorDB. Uncomment the `falkordb` service block in `docker-compose.yml`:

```yaml
falkordb:
  image: falkordb/falkordb:latest
  volumes:
    - falkordb-data:/data
  restart: unless-stopped
```

And add the volume:

```yaml
volumes:
  falkordb-data:
```

Then install and configure the extension:

```sh
docker compose up -d falkordb
docker compose exec -it gurney node dist/cli/index.js ext install gurney-memgraph
docker compose exec -it gurney node dist/cli/index.js config
# → gurney-memgraph → bridge_url → http://falkordb:8765
```

The FalkorDB service must be running a compatible bridge. See [the gurney-memgraph docs](./extensions/gurney-memgraph.md) for the bridge contract.

---

## Updating Gurney

```sh
git pull
docker compose build gurney      # rebuild the image
docker compose up -d gurney      # restart only gurney, leave ollama running
```

Ollama stays up through the update. The new Gurney image connects to the same Ollama container — no model reload.

---

## Backups

The important data is in two volumes:

| Volume        | Contents                                                       |
| ------------- | -------------------------------------------------------------- |
| `gurney-data` | Config, SQLite DB, logs, extension state, installed extensions |
| `ollama-data` | Model files (large; can be re-pulled; not critical to back up) |

Back up `gurney-data`:

```sh
docker run --rm \
  -v gurney-data:/source \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/gurney-$(date +%Y%m%d).tar.gz -C /source .
```

Restore:

```sh
docker run --rm \
  -v gurney-data:/target \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/gurney-20260101.tar.gz -C /target
```

---

## Ollama performance in Docker

On Linux hosts, Docker adds almost no overhead for CPU workloads. On macOS and Windows, Docker runs inside a VM — set the VM memory limit to at least 8 GB in Docker Desktop settings.

Configure Ollama threads in the Compose file:

```yaml
ollama:
  environment:
    OLLAMA_NUM_THREADS: '8' # physical core count of your host
    OLLAMA_FLASH_ATTENTION: '1'
```

---

## Compose service health

Add a health check so dependent services wait for Ollama to be ready:

```yaml
ollama:
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:11434/api/tags']
    interval: 10s
    timeout: 5s
    retries: 5

gurney:
  depends_on:
    ollama:
      condition: service_healthy
```
