// Whisper.cpp transcription pipeline. Pure shell glue:
//   ogg/opus → ffmpeg → 16 kHz mono wav → whisper-cli → txt
//
// Telegram voice notes are OGG/Opus at 48 kHz; whisper.cpp expects 16-bit PCM
// WAV at 16 kHz mono. ffmpeg is already a dep of the TTS pipeline so we reuse
// it here without bloating the install surface.
//
// Like synth.ts, the pipeline is pluggable via `runShell`: tests pass a stub
// so the wiring can be exercised without whisper-cli installed.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TranscribeRequest {
  // Path to the incoming voice note (OGG/Opus) on disk.
  oggPath: string;
  whisperBin: string;
  ffmpegBin: string;
  // Path to the ggml whisper model (.bin). Auto-downloaded by setup.ts.
  modelPath: string;
  // ISO-639-1 language code, or "auto" to let whisper detect. Defaults to
  // "auto" when unset.
  language?: string;
}

export interface TranscribeResult {
  transcript: string;
}

export type RunShell = (
  cmd: string,
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: Buffer; stderr: string; code: number }>;

export class SttError extends Error {
  constructor(
    public stage: 'ffmpeg' | 'whisper' | 'output',
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

const defaultRunShell: RunShell = (cmd, args, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: code ?? -1 }),
    );
  });

// Normalise whisper's text output. The model occasionally emits leading
// whitespace, repeated punctuation, and `[BLANK_AUDIO]`-style markers for
// silent stretches. Strip those so the transcript reads like a real message.
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|.*?_PLAYING)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function transcribe(
  req: TranscribeRequest,
  runShell: RunShell = defaultRunShell,
): Promise<TranscribeResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gurney-voice-stt-'));
  const wavPath = join(dir, 'in.wav');
  // whisper-cli writes `<wavPath>.txt` next to the input by default; we point
  // it at the same dir to keep cleanup simple.
  const txtPath = `${wavPath}.txt`;

  try {
    // OGG/Opus → 16 kHz mono 16-bit PCM WAV. Whisper.cpp's input contract is
    // strict; -ar/-ac/-acodec must match or it'll emit garbage.
    const ffmpegRes = await runShell(
      req.ffmpegBin,
      [
        '-y',
        '-i',
        req.oggPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        wavPath,
      ],
      {},
    );
    if (ffmpegRes.code !== 0) {
      throw new SttError('ffmpeg', ffmpegRes.code, ffmpegRes.stderr || 'ffmpeg failed');
    }

    const lang = req.language?.trim() || 'auto';
    const whisperRes = await runShell(
      req.whisperBin,
      ['-m', req.modelPath, '-f', wavPath, '-l', lang, '-otxt', '-nt'],
      {},
    );
    if (whisperRes.code !== 0) {
      throw new SttError('whisper', whisperRes.code, whisperRes.stderr || 'whisper failed');
    }

    if (!existsSync(txtPath)) {
      throw new SttError('output', -1, `whisper produced no output at ${txtPath}`);
    }
    const transcript = cleanTranscript(readFileSync(txtPath, 'utf8'));
    return { transcript };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
