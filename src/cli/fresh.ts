// `gurney fresh` - wipe all local Gurney data, update the code, then re-run
// the setup wizard. Equivalent to: stop + rm -rf ~/.gurney + update + init.
//
// This is destructive and prompts for confirmation before proceeding.

import { confirm } from '@inquirer/prompts';
import { rmSync } from 'node:fs';
import { homeDir } from './config-store.js';
import { isAlive, readPid } from './daemon.js';
import { run as runUpdate } from './update.js';
import { run as runInit } from './init.js';

export async function run(): Promise<void> {
  const home = homeDir();

  process.stdout.write(
    'Fresh install will erase all Gurney config, the database, logs, installed extensions,\n' +
      'and extension state, including Gurney-managed Piper binaries, ffmpeg paths, and voice models.\n' +
      `Data directory: ${home}\n\n`,
  );

  const ok = await confirm({
    message: 'Are you sure? This cannot be undone.',
    default: false,
  });
  if (!ok) {
    process.stdout.write('Aborted.\n');
    return;
  }

  // Stop a running daemon before wiping its home dir.
  const pid = readPid(home);
  if (pid && isAlive(pid)) {
    process.stdout.write(`Stopping running daemon (pid ${pid})...\n`);
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    } catch {
      // Already gone - fine.
    }
  }

  process.stdout.write(`Wiping ${home}...\n`);
  rmSync(home, { recursive: true, force: true });
  process.stdout.write('Data directory cleared.\n\n');

  await runUpdate();

  process.stdout.write('\n--- Running setup wizard ---\n\n');
  await runInit();
}
