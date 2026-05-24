import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribe, cleanTranscript, SttError, type RunShell } from './stt.js';

interface Recorded {
  cmd: string;
  args: string[];
}

function makeShell(
  responses: Array<{ code: number; stderr?: string; writeWav?: boolean; writeTxtTo?: string }>,
): { impl: RunShell; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const impl: RunShell = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[i++];
    if (!r) throw new Error('shell script exhausted');
    if (r.writeWav) {
      // ffmpeg writes its WAV to the trailing positional arg.
      writeFileSync(args[args.length - 1]!, Buffer.from('RIFF'));
    }
    if (r.writeTxtTo) {
      // whisper writes `<wav>.txt` next to the input; copy the desired body
      // into that path so transcribe() can read it back.
      const fIdx = args.indexOf('-f');
      const wav = args[fIdx + 1]!;
      writeFileSync(`${wav}.txt`, r.writeTxtTo);
    }
    return {
      stdout: Buffer.alloc(0),
      stderr: r.stderr ?? '',
      code: r.code,
    };
  };
  return { impl, calls };
}

test('transcribe pipes ogg through ffmpeg then whisper, returns trimmed transcript', async () => {
  const { impl, calls } = makeShell([
    // ffmpeg: writes the wav (positional output is the last arg)
    { code: 0, writeWav: true },
    // whisper: writes the .txt next to the input wav
    { code: 0, writeTxtTo: '  hello world  \n[BLANK_AUDIO]\n' },
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'gurney-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    const result = await transcribe(
      {
        oggPath,
        whisperBin: 'whisper-cli',
        ffmpegBin: 'ffmpeg',
        modelPath: '/models/ggml-base.en.bin',
        language: 'en',
      },
      impl,
    );

    assert.equal(result.transcript, 'hello world');
    assert.equal(calls.length, 2);

    // ffmpeg argv: must request 16 kHz mono PCM s16le WAV.
    assert.equal(calls[0]!.cmd, 'ffmpeg');
    assert.ok(calls[0]!.args.includes('-ar'));
    assert.ok(calls[0]!.args.includes('16000'));
    assert.ok(calls[0]!.args.includes('-ac'));
    assert.ok(calls[0]!.args.includes('1'));
    assert.ok(calls[0]!.args.includes('pcm_s16le'));

    // whisper argv: model path, the produced wav, language, txt output, no timestamps.
    assert.equal(calls[1]!.cmd, 'whisper-cli');
    assert.deepEqual(calls[1]!.args.slice(0, 2), ['-m', '/models/ggml-base.en.bin']);
    assert.ok(calls[1]!.args.includes('-otxt'));
    assert.ok(calls[1]!.args.includes('-nt'));
    assert.equal(calls[1]!.args[calls[1]!.args.indexOf('-l') + 1], 'en');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('transcribe cleans up its temp dir even when whisper fails', async () => {
  const { impl } = makeShell([
    { code: 0, writeWav: true },
    { code: 1, stderr: 'no model' },
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'gurney-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    let leakedDir: string | null = null;
    const wrap: RunShell = async (cmd, args, opts) => {
      // Steal the wav path on the ffmpeg call so we can verify cleanup ran.
      if (cmd === 'ffmpeg') leakedDir = args[args.length - 1]!;
      return impl(cmd, args, opts);
    };

    await assert.rejects(
      () =>
        transcribe(
          {
            oggPath,
            whisperBin: 'whisper-cli',
            ffmpegBin: 'ffmpeg',
            modelPath: '/m.bin',
          },
          wrap,
        ),
      (e: unknown) => e instanceof SttError && e.stage === 'whisper',
    );

    // The wav was inside a temp dir we created; that dir should be gone.
    assert.ok(leakedDir, 'ffmpeg should have been invoked');
    assert.equal(existsSync(leakedDir!), false, 'temp dir survives — cleanup missed it');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('transcribe errors when whisper produces no output file', async () => {
  const { impl } = makeShell([{ code: 0, writeWav: true }, { code: 0 }]);
  const tmp = mkdtempSync(join(tmpdir(), 'gurney-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    await assert.rejects(
      () =>
        transcribe(
          {
            oggPath,
            whisperBin: 'whisper-cli',
            ffmpegBin: 'ffmpeg',
            modelPath: '/m.bin',
          },
          impl,
        ),
      (e: unknown) => e instanceof SttError && e.stage === 'output',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cleanTranscript strips whisper sentinels and normalises whitespace', () => {
  assert.equal(cleanTranscript('  hello   world  '), 'hello world');
  assert.equal(cleanTranscript('  hi [BLANK_AUDIO] there '), 'hi there');
  assert.equal(cleanTranscript('foo\n\n[Music]\nbar'), 'foo bar');
  // The dummy readFileSync use just keeps the import alive for tools that
  // would otherwise drop unused imports during lint.
  void readFileSync;
});
