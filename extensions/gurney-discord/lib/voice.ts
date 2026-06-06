import {
  joinVoiceChannel as discordJoinVoiceChannel,
  getVoiceConnection,
  VoiceConnection,
  EndBehaviorType,
  AudioPlayer,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import prism from 'prism-media';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { mkdtempSync, createWriteStream, rmSync } from 'node:fs';

class SilencingReadable extends Readable {
  _read() {
    this.push(Buffer.from([0xf8, 0xff, 0xfe]));
    this.push(null);
  }
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../../src/util/log.js';
import type { Bridge } from './bridge.js';
import type { AllowlistConfig } from './allowlist.js';
import { transcribe } from '../../gurney-voice/stt.js';
import { synthesize } from '../../gurney-voice/synth.js';
import type { Host } from '../../../src/core/extensions.js';

export interface VoiceManagerOptions {
  log: Logger;
  allowlist: () => AllowlistConfig;
  host: Host;
  bridge: () => Bridge | null;
}

export class VoiceManager {
  private log: Logger;
  private allowlist: () => AllowlistConfig;
  private host: Host;
  private bridge: () => Bridge | null;
  private players: Map<string, AudioPlayer> = new Map();
  private channelToGuild: Map<string, string> = new Map();

  constructor(opts: VoiceManagerOptions) {
    this.log = opts.log;
    this.allowlist = opts.allowlist;
    this.host = opts.host;
    this.bridge = opts.bridge;
  }

  // Exposed for tests or status
  public getConnection(guildId: string): VoiceConnection | undefined {
    return getVoiceConnection(guildId);
  }

  public async joinVoiceChannel(
    guildId: string,
    channelId: string,
    adapterCreator: DiscordGatewayAdapterCreator,
  ): Promise<void> {
    this.log.info('joining voice channel', { guildId, channelId });
    const connection = discordJoinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer();
    player.on('error', (e) => {
      this.log.warn('audio player error', { error: e.message });
    });
    connection.subscribe(player);
    this.players.set(guildId, player);
    this.channelToGuild.set(channelId, guildId);

    connection.receiver.speaking.on('start', (userId) => {
      this.log.info('speaking event received', { userId });
      this.handleUserSpeaking(connection, guildId, channelId, userId).catch((e) => {
        this.log.warn('error handling user speaking', { error: e instanceof Error ? e.message : String(e) });
      });
    });

    // Send a silent frame immediately to open the Discord UDP socket for receiving audio.
    const silentResource = createAudioResource(new SilencingReadable(), { inputType: StreamType.OggOpus });
    player.play(silentResource);
  }

  public leaveVoiceChannel(guildId: string): void {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
      this.players.delete(guildId);
      for (const [ch, g] of this.channelToGuild.entries()) {
        if (g === guildId) this.channelToGuild.delete(ch);
      }
      this.log.info('left voice channel', { guildId });
    }
  }

  private async handleUserSpeaking(
    connection: VoiceConnection,
    guildId: string,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const allowedSet = this.allowlist().allowedDmUserIds;
    this.log.info('handleUserSpeaking called', { userId, allowedSetSize: allowedSet.size });
    if (!allowedSet.has(userId) && userId !== this.allowlist().botUserId) {
      this.log.info('user not in allowedDmUserIds', { userId });
      return;
    }

    const audioStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });

    const talkingSoundsStr = this.host.settings.get<string>('talking_sounds', '');
    this.log.info('talkingSoundsStr retrieved', { talkingSoundsStr });
    if (talkingSoundsStr) {
      const pairs = talkingSoundsStr.split(',').map((s) => s.trim()).filter(Boolean);
      for (const pair of pairs) {
        const idx = pair.indexOf(':');
        if (idx !== -1) {
          const uid = pair.slice(0, idx);
          const mp3Path = pair.slice(idx + 1);
          this.log.info('checking pair', { uid, userId, match: uid === userId });
          if (uid === userId && mp3Path) {
            this.log.info('matched user talking sound', { userId, mp3Path });
            this.playLocalFile(guildId, mp3Path);
            break;
          }
        }
      }
    }

    const dir = mkdtempSync(join(tmpdir(), 'gurney-discord-vc-'));
    const oggPath = join(dir, 'in.ogg');

    try {
      interface PrismOpusModule {
        OggLogicalBitstream: new (opts: { opusHead: unknown; pageSizeControl: { maxPackets: number } }) => NodeJS.ReadWriteStream;
        OpusHead: new (opts: { channelCount: number; sampleRate: number }) => unknown;
      }
      const prismOpus = prism.opus as unknown as PrismOpusModule;
      const oggStream = new prismOpus.OggLogicalBitstream({
        opusHead: new prismOpus.OpusHead({
          channelCount: 2,
          sampleRate: 48000,
        }),
        pageSizeControl: {
          maxPackets: 10,
        },
      });

      await pipeline(audioStream, oggStream, createWriteStream(oggPath));

      const whisperBin = this.host.settings.get<string>('whisper_bin', 'whisper-cli');
      const ffmpegBin = this.host.settings.get<string>('ffmpeg_bin', 'ffmpeg');
      
      // To get model path, we need to read gurney-voice's settings.
      // Since settings are extension-scoped, we must query the DB directly to get the sibling's config.
      const rows = this.host.db.prepare(
        `SELECT key, value FROM extension_settings WHERE extension = 'gurney-voice'`
      ).all() as Array<{ key: string; value: string }>;
      
      const voiceSettings = new Map(rows.map(r => [r.key, r.value]));
      const modelPath = voiceSettings.get('whisper_model_path');

      if (!modelPath) {
        this.log.debug('voice-in skipped: gurney-voice whisper_model_path is missing');
        return;
      }

      const language = voiceSettings.get('stt_language') || 'auto';

      const result = await transcribe({
        oggPath,
        whisperBin,
        ffmpegBin,
        modelPath,
        language,
      });

      if (!result.transcript) return;

      const transcript = result.transcript.trim();
      const lower = transcript.toLowerCase();
      
      const wakeWords = ['hey gurney', 'gurney'];
      let wakeWordMatch = '';
      for (const w of wakeWords) {
        if (lower.startsWith(w)) {
          wakeWordMatch = transcript.slice(0, w.length);
          break;
        }
      }

      if (wakeWordMatch) {
        // Strip the wake word and any trailing punctuation/space
        let payload = transcript.slice(wakeWordMatch.length).trim();
        payload = payload.replace(/^[,.!?:]\s*/, '').trim();
        
        const b = this.bridge();
        if (!b) return;

        if (payload.length > 0) {
          this.log.info('wake word detected', { userId, payload });
          await b.handle({ userId, channelId, guildId, rawContent: payload });
        } else {
          this.log.info('wake word detected but no command followed', { userId });
          await b.handle({ userId, channelId, guildId, rawContent: "I'm here." });
        }
      }

    } catch (e) {
      this.log.warn('voice processing error', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  public async playAudio(channelId: string, text: string): Promise<void> {
    const guildId = this.channelToGuild.get(channelId);
    if (!guildId) return;
    
    const player = this.players.get(guildId);
    if (!player) return;

    const piperBin = this.host.settings.get<string>('piper_bin', 'piper');
    const ffmpegBin = this.host.settings.get<string>('ffmpeg_bin', 'ffmpeg');
    
    const rows = this.host.db.prepare(
      `SELECT key, value FROM extension_settings WHERE extension = 'gurney-voice'`
    ).all() as Array<{ key: string; value: string }>;
    
    const voiceSettings = new Map(rows.map(r => [r.key, r.value]));
    const voiceModelPath = voiceSettings.get('tts_model_path') || voiceSettings.get('voice_model_path');

    if (!voiceModelPath) {
      this.log.debug('voice-out skipped: gurney-voice voice_model_path is missing');
      return;
    }

    try {
      const result = await synthesize({
        text,
        piperBin,
        ffmpegBin,
        voiceModelPath,
      });

      const resource = createAudioResource(result.oggPath, {
        inputType: StreamType.OggOpus,
      });

      player.play(resource);

      // Clean up the temp directory after playing (the stream reads it). We might need to delay cleanup
      // until the player is idle, or resource is finished.
      player.once('idle', () => {
        result.cleanup();
      });
      
    } catch (e) {
      this.log.warn('tts processing error', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  public handleVoiceStateUpdate(
    userId: string,
    oldChannelId: string | null,
    newChannelId: string | null,
    guildId: string,
  ): void {
    if (newChannelId && newChannelId !== oldChannelId) {
      const ourGuild = this.channelToGuild.get(newChannelId);
      if (ourGuild === guildId) {
        const entranceSoundsStr = this.host.settings.get<string>('entrance_sounds', '');
        if (!entranceSoundsStr) return;

        const pairs = entranceSoundsStr.split(',').map((s) => s.trim()).filter(Boolean);
        for (const pair of pairs) {
          const idx = pair.indexOf(':');
          if (idx === -1) continue;
          const uid = pair.slice(0, idx);
          const mp3Path = pair.slice(idx + 1);
          if (uid === userId && mp3Path) {
            this.playLocalFile(guildId, mp3Path);
            break;
          }
        }
      }
    }
  }

  private playLocalFile(guildId: string, filePath: string): void {
    const player = this.players.get(guildId);
    if (!player) {
      this.log.warn('playLocalFile: no player found', { guildId });
      return;
    }

    try {
      this.log.info('playLocalFile: attempting createAudioResource', { filePath });
      const resource = createAudioResource(filePath);
      player.play(resource);
      this.log.info('playLocalFile: played sound', { guildId, filePath });
    } catch (e) {
      this.log.warn('failed to play local file', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
