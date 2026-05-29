// `gurney frontend` — run the local web control panel (gurney-frontend).
//
// The actual HTTP server lives in the extension (extensions/gurney-frontend/
// server.ts) so it can ship, hot-reload, and own its assets. This file is a
// thin shim that resolves that server by absolute path and runs it — the same
// pattern `gurney abilitytest` uses for its runner. tsx (registered in
// index.ts) transpiles the .ts on the fly.
//
// The server runs as its own process, deliberately separate from the agent
// daemon: the panel's Start/Stop buttons drive `gurney start/stop`, and a
// server living inside the daemon would kill itself on "Stop".

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frontendPidFilePath, isAlive, tryAcquirePidLock } from './daemon.js';
import { ensurePrivateDir, homeDir } from './config-store.js';

export interface FrontendRunOptions {
  detach?: boolean;
  stop?: boolean;
}

function serverModulePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'extensions', 'gurney-frontend', 'server.ts');
}

export async function run(options: FrontendRunOptions = {}): Promise<void> {
  const home = homeDir();
  ensurePrivateDir(home);
  const pidFile = frontendPidFilePath(home);

  if (options.stop) {
    const pid = readFrontendPid(pidFile);
    if (pid && isAlive(pid)) {
      process.kill(pid, 'SIGTERM');
      process.stdout.write(`gurney-frontend stopped (pid ${pid}).\n`);
    } else {
      process.stdout.write('gurney-frontend is not running.\n');
    }
    clearFrontendPid(pidFile);
    return;
  }

  const existing = readFrontendPid(pidFile);
  if (existing && isAlive(existing)) {
    throw new Error(
      `gurney-frontend already running (pid ${existing}). Use 'gurney frontend stop' first.`,
    );
  }
  if (existing) clearFrontendPid(pidFile);

  if (options.detach) {
    return detach();
  }

  if (!tryAcquirePidLock(process.pid, home, pidFile)) {
    throw new Error("gurney-frontend is already starting. Use 'gurney frontend stop' if stale.");
  }

  const modPath = serverModulePath();
  if (!existsSync(modPath)) {
    clearFrontendPid(pidFile);
    throw new Error(
      `gurney-frontend is not installed (expected ${modPath}). Install it with 'gurney ext install gurney-frontend'.`,
    );
  }
  const mod = (await import(pathToFileURL(modPath).href)) as {
    run: (opts: { cliEntry?: string; execArgv?: string[] }) => Promise<unknown>;
  };

  // Only remove the pidfile if it still names us. Without this guard, a start
  // that fails to bind (port held by another panel) would, on exit, delete a
  // pidfile that points at the live server — leaving `gurney frontend stop`
  // unable to find it.
  const cleanup = (): void => {
    if (readFrontendPid(pidFile) === process.pid) clearFrontendPid(pidFile);
  };
  process.once('exit', cleanup);

  await mod.run({
    cliEntry: process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), 'index.js'),
    execArgv: process.execArgv,
  });
}

function detach(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliEntry = process.argv[1] ?? join(here, 'index.js');
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, 'frontend'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  process.stdout.write(
    `gurney-frontend started in background (pid ${child.pid}).\n` +
      `Stop with 'gurney frontend stop'.\n`,
  );
}

function readFrontendPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function clearFrontendPid(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}
