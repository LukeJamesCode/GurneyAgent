// `gurney stop` — stop a running daemon.
//
// Reads the PID from ~/.gurney/gurney.pid (written by `gurney start`) and
// sends SIGTERM. The bot's signal handler does an orderly shutdown that also
// removes the pid file.

import { homeDir } from './config-store.js';
import { clearPid, isAlive, readPid } from './daemon.js';

export async function run(): Promise<void> {
  const home = homeDir();
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
