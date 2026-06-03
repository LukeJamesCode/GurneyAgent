// Daemon-state helpers: PID file + log path.
//
// `gurney start --detach` spawns a child with stdio detached and writes its
// PID here so `gurney stop` and `gurney status` can find it. There's no
// process supervisor in v1 — if the bot crashes, the user re-runs `start`.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, ensurePrivateFile, homeDir } from './config-store.js';

export function pidFilePath(home: string = homeDir()): string {
  return join(home, 'gurney.pid');
}

export function logFilePath(home: string = homeDir()): string {
  return join(home, 'log', 'gurney.log');
}

// PID file for the gurney-frontend web server. It runs as its own process
// (separate from the agent daemon) so the panel's Start/Stop controls can
// drive the daemon without taking the UI down with it. `gurney stop` reads
// this to find and kill the server — see src/cli/panel.ts.
export function frontendPidFilePath(home: string = homeDir()): string {
  return join(home, 'frontend.pid');
}

// Snapshot of live counters written by the running daemon. `gurney status`
// reads this so it can report fast-cache hit rate and nudge counts without
// having to talk to the bot process.
export function metricsFilePath(home: string = homeDir()): string {
  return join(home, 'metrics.json');
}

export function writePid(pid: number, home: string = homeDir()): void {
  const file = pidFilePath(home);
  ensurePrivateDir(dirname(file));
  writeFileSync(file, String(pid), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(file);
}

// Atomically create the PID file as a startup lock. Returns true if we won the
// lock, false if another process already holds it (file exists). The 'wx' open
// flag makes the create-or-fail atomic, closing the window where two concurrent
// `gurney start` invocations both pass the readPid guard and then both boot
// into two live daemons.
export function tryAcquirePidLock(
  pid: number,
  home: string = homeDir(),
  file: string = pidFilePath(home),
): boolean {
  ensurePrivateDir(dirname(file));
  try {
    writeFileSync(file, String(pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  ensurePrivateFile(file);
  return true;
}

export function readPid(home: string = homeDir()): number | null {
  const file = pidFilePath(home);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trim();
  // Reject partial garbage (e.g. "12abc") that parseInt would truncate to 12.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function clearPid(home: string = homeDir()): void {
  const file = pidFilePath(home);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

// Returns true iff the given PID is alive *and* belongs to us (a previous
// gurney). We can't tell process identity portably, so we approximate with
// kill(pid, 0); a stale PID file will be cleaned on the next start.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
