#!/usr/bin/env node
// Gurney CLI entrypoint. Phase 1 wired only `gurney start`; Phase 3 fills in
// the rest of the subcommands (see docs/cli-reference.md).

// Tint all stdout/stderr green when running in a TTY. Side-effect import,
// must run before anything else writes.
import './color.js';

// Register tsx so the compiled CLI can dynamically import .ts extension files.
import { register } from 'tsx/esm/api';
register();

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';

// Subcommands are pulled in lazily. Keeping the top of the CLI free of heavy
// transitive imports (grammY, better-sqlite3, the LLM client) means `gurney
// --help` and quick subcommands like `gurney status` boot in tens of ms
// instead of paying the full daemon's import cost.

function fail(prefix: string, e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${prefix}: ${msg}\n`);
  process.exit(1);
}

async function call<T extends unknown[]>(
  name: string,
  fn: (...args: T) => Promise<void>,
  ...args: T
): Promise<void> {
  try {
    await fn(...args);
  } catch (e) {
    // @inquirer/prompts throws this when the user hits Ctrl-C — don't print
    // a scary stack for an intentional cancel.
    if (e instanceof Error && (e.name === 'ExitPromptError' || e.name === 'AbortError')) {
      process.stderr.write('\n(cancelled)\n');
      process.exit(130);
    }
    fail(`gurney ${name} failed`, e);
  }
}

const program = new Command();
program
  .name('gurney')
  .description('Small, terminal-first AI agent. CPU-only. Extensions turn it into anything.')
  .version('0.0.0');

program
  .command('start')
  .description('Run the bot (Telegram long-poll + Ollama)')
  .option('--detach', 'Run as a background process; write a pid file')
  .action(async (opts: { detach?: boolean }) => {
    const { run } = await import('./start.js');
    await call('start', run, { detach: !!opts.detach });
  });

program
  .command('init')
  .description('First-run wizard: telegram token, allowlist, ollama, models')
  .action(async () => {
    const { run } = await import('./init.js');
    await call('init', run);
  });

program
  .command('config')
  .description('Interactive settings TUI (core + extensions)')
  .action(async () => {
    const { run } = await import('./config.js');
    await call('config', run);
  });

program
  .command('auth')
  .argument('<extension>', 'Extension name to authorize')
  .description('Run an extension auth flow')
  .action(async (extension: string) => {
    const { run } = await import('./auth.js');
    await call('auth', run, extension);
  });

program
  .command('models')
  .description('Pick chat / reasoning model profiles from Ollama')
  .action(async () => {
    const { run } = await import('./models.js');
    await call('models', run);
  });

program
  .command('stop')
  .description('Stop a running gurney daemon')
  .action(async () => {
    const { run } = await import('./stop.js');
    await call('stop', run);
  });

program
  .command('logs')
  .option('-f, --follow', 'Follow new log lines, like `tail -f`')
  .description('Stream the gurney log file')
  .action(async (opts: { follow?: boolean }) => {
    const { run } = await import('./logs.js');
    await call('logs', run, { follow: !!opts.follow });
  });

program
  .command('status')
  .option('--json', 'Emit a single JSON object instead of two-column text')
  .description('One-shot summary of bot health (config, ollama, extensions)')
  .action(async (opts: { json?: boolean }) => {
    const { run } = await import('./status.js');
    await call('status', run, { json: !!opts.json });
  });

program
  .command('doctor')
  .description('Run preflight diagnostics (config, telegram, ollama, ram, extensions)')
  .action(async () => {
    const { run } = await import('./doctor.js');
    await call('doctor', run);
  });

program
  .command('update')
  .description('Pull latest code, reinstall dependencies, and rebuild')
  .action(async () => {
    const { run } = await import('./update.js');
    await call('update', run);
  });

program
  .command('fresh')
  .description('Wipe all Gurney data, update code, and re-run the setup wizard')
  .action(async () => {
    const { run } = await import('./fresh.js');
    await call('fresh', run);
  });

program
  .command('abilitytest')
  .description('Run scripted ability tests against a fresh in-process Gurney (no Telegram)')
  .option('--tier <tier>', 'smoke | standard | full', 'standard')
  .option('--filter <regex>', 'only run tests whose id or ability matches this regex')
  .option('--out <path>', 'where to write the markdown report')
  .action(async (opts: { tier?: string; filter?: string; out?: string }) => {
    // The runner lives in the gurney-abilitytest extension (so it can ship,
    // be hot-reloaded, and own its catalog). The CLI is a thin shim that
    // resolves the .ts file by absolute path and dynamically imports it —
    // tsx handles the on-the-fly transpile.
    const here = dirname(fileURLToPath(import.meta.url));
    const runnerPath = resolve(here, '..', '..', 'extensions', 'gurney-abilitytest', 'runner.ts');
    const mod = (await import(pathToFileURL(runnerPath).href)) as {
      run: (opts: {
        tier: 'smoke' | 'standard' | 'full';
        filter?: string;
        outFile?: string;
      }) => Promise<void>;
    };
    const tier = (opts.tier ?? 'standard') as 'smoke' | 'standard' | 'full';
    if (tier !== 'smoke' && tier !== 'standard' && tier !== 'full') {
      throw new Error(`Unknown tier '${tier}'. Use smoke | standard | full.`);
    }
    await call('abilitytest', mod.run, {
      tier,
      ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
      ...(opts.out !== undefined ? { outFile: opts.out } : {}),
    });
  });

const extCmd = program.command('ext').description('Manage extensions');
extCmd
  .command('list')
  .description('List installed extensions and their state')
  .action(async () => {
    const ext = await import('./ext.js');
    await call('ext list', ext.list);
  });
extCmd
  .command('install')
  .argument('<source>', 'Local path, git URL, or repo extension name')
  .description('Install an extension')
  .action(async (source: string) => {
    const ext = await import('./ext.js');
    await call('ext install', ext.install, source);
  });
extCmd
  .command('enable')
  .argument('<name>')
  .description('Enable an installed extension')
  .action(async (name: string) => {
    const ext = await import('./ext.js');
    await call('ext enable', ext.enable, name);
  });
extCmd
  .command('disable')
  .argument('<name>')
  .description('Disable an installed extension')
  .action(async (name: string) => {
    const ext = await import('./ext.js');
    await call('ext disable', ext.disable, name);
  });
extCmd
  .command('uninstall')
  .argument('<name>')
  .option('--purge', 'Also drop the extension settings and state')
  .description('Uninstall an extension installed under ~/.gurney/extensions/')
  .action(async (name: string, opts: { purge?: boolean }) => {
    const ext = await import('./ext.js');
    await call('ext uninstall', ext.uninstall, name, { purge: !!opts.purge });
  });
extCmd
  .command('reload')
  .argument('[name]')
  .description('Touch extension folders so a running gurney hot-reloads them')
  .action(async (name: string | undefined) => {
    const ext = await import('./ext.js');
    await call('ext reload', ext.reload, name);
  });
extCmd
  .command('create')
  .argument('<name>', 'Extension name (e.g. gurney-todo)')
  .argument('[dir]', 'Parent directory (default: current working directory)')
  .description('Scaffold a runnable starter extension you can edit and publish')
  .action(async (name: string, dir: string | undefined) => {
    const ext = await import('./ext.js');
    await call('ext create', ext.create, name, dir);
  });

program.parseAsync(process.argv).catch((e) => {
  fail('gurney', e);
});
