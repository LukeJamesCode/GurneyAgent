// `gurney init` — first-run wizard.
//
// Walks the user through the bare minimum needed to launch the bot:
//   1. Where to put the config dir
//   2. Telegram bot token (validated against /getMe)
//   3. Allowed Telegram user IDs
//   4. Ollama URL (validated by listing models)
//   5. Pick chat / reasoning profile models from the live model list
//   6. Hardware tier (auto-suggested from RAM, overridable)
//   7. Extension selection — choose which bundled extensions to enable,
//      then fill in their required settings and auth tokens on the spot.
//
// The wizard is idempotent: re-running it loads existing config and lets the
// user step through each value, accepting the previous one as the default.

import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTier } from './tier.js';
import {
  effectiveConfig,
  homeDir,
  loadConfig,
  parseAllowedIds,
  saveConfig,
  type GurneyConfig,
} from './config-store.js';
import { probeOllama } from './ollama-probe.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import {
  setupExtensions,
  printTelegramCommandsGuide,
  type DiscoveredExtension,
} from './ext-setup.js';
import type { Manifest } from '../core/extensions.js';

const TELEGRAM_API = 'https://api.telegram.org';

interface BotInfo {
  ok: boolean;
  username?: string;
}

async function validateBotToken(token: string): Promise<BotInfo> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return { ok: !!j.ok, ...(j.result?.username ? { username: j.result.username } : {}) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Extension discovery + setup
// ---------------------------------------------------------------------------

function discoverBundledExtensions(): DiscoveredExtension[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoExt = resolve(here, '..', '..', 'extensions');
  const out: DiscoveredExtension[] = [];
  let entries: string[];
  try {
    entries = readdirSync(repoExt);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const folder = join(repoExt, entry);
    try {
      if (!statSync(folder).isDirectory()) continue;
      const manifestPath = join(folder, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      if (typeof manifest.name === 'string') out.push({ name: manifest.name, folder, manifest });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Write extension_state rows for every bundled extension BEFORE the loader
// runs, so unselected ones don't get auto-enabled on first start. Selected
// extensions get enabled=1; everything else gets enabled=0.
function presetExtensionStates(
  home: string,
  bundled: DiscoveredExtension[],
  selectedNames: string[],
): void {
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'gurney.db'), log });
  try {
    const stmt = db.prepare(
      `INSERT INTO extension_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
    );
    const now = Date.now();
    for (const ext of bundled) {
      stmt.run(ext.name, ext.manifest.version, selectedNames.includes(ext.name) ? 1 : 0, now, now);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const existing = loadConfig(home);
  const ramBytes = totalmem();
  const cpuCount = cpus().length;
  const tierGuess = detectTier(ramBytes, cpuCount);
  const ramGb = (ramBytes / 1024 / 1024 / 1024).toFixed(1);

  process.stdout.write(`Welcome to Gurney. Config will live in ${home}.\n\n`);

  // -- Telegram ----------------------------------------------------------
  let token = existing.telegram.token;
  let botUsername: string | undefined;
  for (;;) {
    token = await password({
      message: 'Telegram bot token (from @BotFather):',
      mask: '*',
      validate: (v) => (v.trim().length > 0 ? true : 'Required.'),
    });
    process.stdout.write('Validating with Telegram… ');
    const info = await validateBotToken(token.trim());
    if (info.ok) {
      botUsername = info.username;
      process.stdout.write(`✓ Connected as @${botUsername ?? '<unknown>'}.\n`);
      break;
    }
    process.stdout.write('✗ token rejected.\n');
    const retry = await confirm({ message: 'Try a different token?', default: true });
    if (!retry) break;
  }

  const allowedRaw = await input({
    message: 'Allowed Telegram user IDs (comma-separated):',
    default: existing.telegram.allowedIds.join(','),
    validate: (v) => {
      try {
        const ids = parseAllowedIds(v);
        return ids.length > 0 ? true : 'Need at least one numeric Telegram user id.';
      } catch (e) {
        return (e as Error).message;
      }
    },
  });
  const allowedIds = parseAllowedIds(allowedRaw);

  // -- Ollama ------------------------------------------------------------
  const ollamaUrl = await input({
    message: 'Ollama URL:',
    default: existing.ollama.url,
  });
  process.stdout.write('Probing Ollama… ');
  const probe = await probeOllama(ollamaUrl);
  let chatModel = existing.models.chat;
  let reasonModel: string | undefined = existing.models.reason;
  let toolsModel: string | undefined = existing.models.tools;
  if (!probe.ok) {
    process.stdout.write(`✗ ${probe.error ?? 'unreachable'}.\n`);
    process.stdout.write(
      'Continuing with defaults; you can run `gurney models` later once Ollama is up.\n',
    );
  } else {
    process.stdout.write(`✓ ${probe.models.length} models available.\n`);
    if (probe.models.length > 0) {
      const chatChoices = [
        ...probe.models.map((m) => ({ name: m, value: m })),
        { name: '(enter a model name manually)', value: '__custom__' },
      ];
      const chatPick = await select({
        message: 'Chat profile model:',
        choices: chatChoices,
        default: probe.models.includes(existing.models.chat)
          ? existing.models.chat
          : probe.models[0],
      });
      chatModel =
        chatPick === '__custom__'
          ? await input({ message: 'Chat model tag:', default: existing.models.chat })
          : chatPick;

      const reasonChoices = [
        { name: '(skip — small device)', value: '__skip__' },
        ...probe.models.map((m) => ({ name: m, value: m })),
        { name: '(enter a model name manually)', value: '__custom__' },
      ];
      const reasonPick = await select({
        message: 'Reasoning profile model:',
        choices: reasonChoices,
        default: existing.models.reason ?? '__skip__',
      });
      if (reasonPick === '__skip__') reasonModel = undefined;
      else if (reasonPick === '__custom__') {
        reasonModel = await input({ message: 'Reasoning model tag:' });
      } else reasonModel = reasonPick;

      const toolsChoices = [
        { name: '(skip — reuse chat model for tool turns)', value: '__skip__' },
        ...probe.models.map((m) => ({ name: m, value: m })),
        { name: '(enter a model name manually)', value: '__custom__' },
      ];
      const toolsPick = await select({
        message: 'Tool-use profile model (handles every tool-bearing turn):',
        choices: toolsChoices,
        default: existing.models.tools ?? '__skip__',
      });
      if (toolsPick === '__skip__') toolsModel = undefined;
      else if (toolsPick === '__custom__') {
        toolsModel = await input({ message: 'Tool-use model tag:' });
      } else toolsModel = toolsPick;
    }
  }

  // -- Tier --------------------------------------------------------------
  // Show what Gurney actually saw — under WSL2 / Docker the reported RAM is
  // the container cap, not host RAM, so the user can spot a mismatch and
  // override.
  process.stdout.write(`\nDetected: ${ramGb} GB RAM, ${cpuCount} logical CPU(s).\n`);
  const tier = (await select({
    message: `Hardware tier (suggested: ${tierGuess}):`,
    choices: [
      { name: 'small (Pi 4/5, 4–8GB)', value: 'small' },
      { name: 'standard (mini PC, 16GB)', value: 'standard' },
      { name: 'heavy (5800H+, 32GB)', value: 'heavy' },
    ],
    default: existing.tier ?? tierGuess,
  })) as GurneyConfig['tier'];

  const cfg: GurneyConfig = {
    telegram: { token: token.trim(), allowedIds },
    ollama: { url: ollamaUrl.trim() },
    models: {
      chat: chatModel,
      ...(reasonModel ? { reason: reasonModel } : {}),
      ...(toolsModel ? { tools: toolsModel } : {}),
    },
    ...(tier ? { tier } : {}),
    logLevel: existing.logLevel ?? 'info',
  };
  saveConfig(cfg, home);
  process.stdout.write(`\n✓ Wrote ${home}/config.json.\n`);

  // Read effective config so we can warn if env overrides are about to win.
  const effective = effectiveConfig(home);
  if (effective.telegram.token !== cfg.telegram.token) {
    process.stdout.write(
      'Note: TELEGRAM_BOT_TOKEN in your environment overrides the config file.\n',
    );
  }

  // -- Extensions --------------------------------------------------------
  const bundled = discoverBundledExtensions();
  if (bundled.length === 0) {
    process.stdout.write('\nNo bundled extensions found — run `gurney start` to launch.\n');
    return;
  }

  process.stdout.write('\n');
  const selectedNames = await checkbox({
    message: 'Select extensions to enable (Space to toggle, Enter to confirm):',
    choices: bundled.map((ext) => ({
      name: `${ext.name}${ext.manifest.description ? '  —  ' + ext.manifest.description : ''}`,
      value: ext.name,
    })),
  });

  const selected = bundled.filter((e) => selectedNames.includes(e.name));

  // Pre-seed extension_state so unselected bundled extensions are disabled
  // from the first start rather than auto-enabled by the loader.
  presetExtensionStates(home, bundled, selectedNames);

  if (selected.length === 0) {
    process.stdout.write(
      '\nNo extensions selected. You can add them later with:\n' +
        '  gurney ext install <name>   — install an extension\n' +
        '  gurney auth <extension>     — run an extension OAuth flow\n' +
        '  gurney config               — edit settings interactively\n\n' +
        'Run `gurney start` to launch.\n',
    );
    return;
  }

  await setupExtensions(home, selected);
  printTelegramCommandsGuide(selected, botUsername);

  process.stdout.write('\nAll done. Run `gurney start` to launch.\n');
}
