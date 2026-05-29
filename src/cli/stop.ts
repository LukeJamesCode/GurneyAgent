// `gurney stop` — stop a running daemon.
//
// Reads the PID from ~/.gurney/gurney.pid (written by `gurney start`) and
// sends SIGTERM. The bot's signal handler does an orderly shutdown that also
// removes the pid file. Also stops the gurney-frontend web panel (if it's
// running), unless --agent-only is passed.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homeDir } from './config-store.js';
import { clearPid, frontendPidFilePath, isAlive, readPid } from './daemon.js';

export interface StopRunOptions {
  // Leave the gurney-frontend web panel running. Used by the panel itself
  // when its Stop button calls /api/agent/stop — otherwise that click
  // would kill the very UI making the request.
  agentOnly?: boolean;
}

export async function run(options: StopRunOptions = {}): Promise<void> {
  const home = homeDir();
  stopAgent(home);
  if (!options.agentOnly) stopFrontend(home);
}

function stopAgent(home: string): void {
  const pid = readPid(home);
  if (pid === null) {
    process.stdout.write('No PID file — gurney does not appear to be running.\n');
    return;
  }
  if (!isAlive(pid)) {
    process.stdout.write(`Stale PID file (pid ${pid} is not alive). Cleaning up.\n`);
    clearPid(home);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Sent SIGTERM to pid ${pid}.\n`);
  } catch (e) {
    process.stderr.write(`Failed to signal pid ${pid}: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

function stopFrontend(home: string): void {
  const pidFile = frontendPidFilePath(home);
  if (!existsSync(pidFile)) return;
  let pid: number | null = null;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    pid = Number.isFinite(n) ? n : null;
  } catch {
    pid = null;
  }
  if (pid === null) return;
  if (!isAlive(pid)) {
    try {
      unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`gurney-frontend stopped (pid ${pid}).\n`);
  } catch (e) {
    process.stderr.write(
      `Failed to stop gurney-frontend (pid ${pid}): ${(e as Error).message}\n`,
    );
  }
}
