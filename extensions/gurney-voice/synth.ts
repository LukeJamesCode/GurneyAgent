// Piper synthesis pipeline. Pure shell glue:
//   text → piper (stdin) → wav (stdout) → ffmpeg → ogg/opus (Telegram voice)
//
// Telegram voice notes want OPUS-in-OGG; Piper emits 22.05 kHz mono WAV. We
// pipe stdin → stdin between the two so nothing hits disk except the final
// ogg, which the caller hands back to Telegram via InputFile.
//
// The synth is pluggable so smoke tests don't need piper / ffmpeg installed:
// `runShell` defaults to a real spawn but tests pass a stub.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SynthRequest {
  text: string;
  piperBin: string;
  ffmpegBin: string;
  voiceModelPath: string;
}

export interface SynthResult {
  // Path to a temporary OGG file. Caller is responsible for unlinking after
  // sending; the helper exposes `cleanup()` to centralize that.
  oggPath: string;
  cleanup(): void;
}

export type RunShell = (
  cmd: string,
  args: string[],
  opts: { input?: Buffer; outputPath?: string },
) => Promise<{ stdout: Buffer; stderr: string; code: number }>;

export class TtsSynthError extends Error {
  constructor(
    public stage: 'piper' | 'ffmpeg',
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'TtsSynthError';
  }
}

const defaultRunShell: RunShell = (cmd, args, { input, outputPath }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: outputPath ? ['pipe', 'ignore', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    if (!outputPath) {
      child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    }
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        code: code ?? -1,
      }),
    );
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
  });

export async function synthesize(
  req: SynthRequest,
  runShell: RunShell = defaultRunShell,
): Promise<SynthResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gurney-voice-'));
  const wavPath = join(dir, 'out.wav');
  const oggPath = join(dir, 'out.ogg');

  // Piper supports `--output_file` to write WAV directly. Cleaner than
  // streaming binary stdout through Node, and avoids issues with piper builds
  // that emit JSON to stdout instead of WAV.
  const piperRes = await runShell(
    req.piperBin,
    ['--model', req.voiceModelPath, '--output_file', wavPath],
    { input: Buffer.from(req.text, 'utf8') },
  );
  if (piperRes.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new TtsSynthError('piper', piperRes.code, piperRes.stderr || 'piper failed');
  }

  const ffmpegRes = await runShell(
    req.ffmpegBin,
    ['-y', '-i', wavPath, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', oggPath],
    {},
  );
  if (ffmpegRes.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new TtsSynthError('ffmpeg', ffmpegRes.code, ffmpegRes.stderr || 'ffmpeg failed');
  }

  return {
    oggPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Test helper: produce an in-memory pseudo-OGG file so the smoke test for the
// after-reply hook can exercise the wiring without piper installed.
export function writeStubOgg(): SynthResult {
  const dir = mkdtempSync(join(tmpdir(), 'gurney-voice-stub-'));
  const oggPath = join(dir, 'stub.ogg');
  writeFileSync(oggPath, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // "OggS"
  return {
    oggPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Used by tests / debug to peek at the bytes the synth produced.
export function readSynthBytes(r: SynthResult): Buffer {
  return readFileSync(r.oggPath);
}
