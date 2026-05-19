// `gurney logs [--follow]` — stream ~/.gurney/log/gurney.log.
//
// One-shot mode prints the whole file. --follow keeps reading new bytes as
// they're appended, like `tail -f` but without shelling out.

import { existsSync, statSync, watchFile, createReadStream, unwatchFile } from 'node:fs';
import { homeDir } from './config-store.js';
import { logFilePath } from './daemon.js';

export interface LogsOptions {
  follow?: boolean;
  // Number of bytes from the end to print first (--follow only). Default: 4 KB.
  tailBytes?: number;
}

export async function run(opts: LogsOptions = {}): Promise<void> {
  const file = logFilePath(homeDir());
  if (!existsSync(file)) {
    process.stderr.write(`No log file at ${file}. Has gurney been started?\n`);
    process.exit(1);
  }

  if (!opts.follow) {
    await streamWholeFile(file);
    return;
  }

  await streamTailThenFollow(file, opts.tailBytes ?? 4096);
}

async function streamWholeFile(file: string): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const s = createReadStream(file, { encoding: 'utf8' });
    s.on('data', (c) => process.stdout.write(c));
    s.on('error', reject);
    s.on('end', () => resolveP());
  });
}

async function streamTailThenFollow(file: string, tailBytes: number): Promise<void> {
  let pos = Math.max(0, statSync(file).size - tailBytes);
  await streamFrom(file, pos);
  pos = statSync(file).size;

  // Two timer ticks during a noisy log burst can both pass the size guard and
  // both call streamFrom() from the same `pos`, duplicating output. The lock
  // serialises reads; if a burst arrives while we're still draining, the next
  // tick will see the updated `pos` and pick up where we stopped.
  let reading = false;
  watchFile(file, { interval: 500 }, (curr, prev) => {
    if (curr.size < prev.size) {
      pos = 0;
      return;
    }
    if (reading) return;
    if (curr.size > pos) {
      reading = true;
      streamFrom(file, pos)
        .then(() => {
          pos = statSync(file).size;
        })
        .catch(() => {
          /* ignore transient read errors during rotation */
        })
        .finally(() => {
          reading = false;
        });
    }
  });

  // Keep the process alive until SIGINT.
  await new Promise<void>((resolveP) => {
    process.once('SIGINT', () => {
      unwatchFile(file);
      resolveP();
    });
  });
}

async function streamFrom(file: string, start: number): Promise<void> {
  const size = statSync(file).size;
  if (size <= start) return;
  await new Promise<void>((resolveP, reject) => {
    const s = createReadStream(file, { encoding: 'utf8', start });
    s.on('data', (c) => process.stdout.write(c));
    s.on('error', reject);
    s.on('end', () => resolveP());
  });
}
