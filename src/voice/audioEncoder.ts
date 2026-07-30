import { spawn } from 'child_process';
import type { TtsAudioFormat } from './ttsProvider';

const ENCODE_TIMEOUT_MS = 15_000;
const FFMPEG_CHECK_TIMEOUT_MS = 5_000;

let ffmpegState = false;
let ffmpegCheckPromise: Promise<boolean> | null = null;
let encodeSpawn: typeof spawn = spawn;

export interface TtsEncoderInput {
  format: TtsAudioFormat;
  sampleRate?: number;
}

/** Resultado síncrono da checagem feita no boot. */
export function ffmpegAvailable(): boolean {
  return ffmpegState;
}

/**
 * Verifica se o binário está disponível e guarda o resultado para o gate
 * síncrono de voz. Chamadas concorrentes compartilham o mesmo processo.
 */
export function checkFfmpegAvailable(): Promise<boolean> {
  if (ffmpegCheckPromise) return ffmpegCheckPromise;

  ffmpegCheckPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn('ffmpeg', ['-version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ffmpegState = available;
      resolve(available);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, FFMPEG_CHECK_TIMEOUT_MS);

    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });

  return ffmpegCheckPromise;
}

export function buildFfmpegEncodeArgs(
  input: TtsEncoderInput = { format: 'mp3' }
): string[] {
  const inputArgs =
    input.format === 'pcm_s16le'
      ? [
          '-f',
          's16le',
          '-ar',
          String(input.sampleRate ?? 24_000),
          '-ac',
          '1',
        ]
      : [];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs,
    '-i',
    'pipe:0',
    '-c:a',
    'libopus',
    '-b:a',
    '24k',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-application',
    'voip',
    '-vbr',
    'on',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

/** Converte MP3 ou PCM s16le para OGG/Opus inteiramente por stdin/stdout. */
export async function encodeToOpus(
  audio: Buffer,
  input: TtsEncoderInput = { format: 'mp3' }
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = encodeSpawn('ffmpeg', buildFfmpegEncodeArgs(input));

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      const output = Buffer.concat(stdoutChunks);
      if (output.length === 0) {
        reject(new Error('ffmpeg produced an empty OGG output'));
        return;
      }
      resolve(output);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('ffmpeg encode timed out'));
    }, ENCODE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => {
      // Limita o diagnóstico: stderr do ffmpeg é técnico, mas não deve crescer
      // sem limite em memória.
      if (Buffer.concat(stderrChunks).length < 8_192) {
        stderrChunks.push(Buffer.from(chunk));
      }
    });
    child.once('error', () => finish(new Error('ffmpeg process failed to start')));
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 500);
        finish(
          new Error(
            `ffmpeg exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`
          )
        );
        return;
      }
      finish();
    });
    child.stdin.once('error', () => {
      // O evento close fornece o código/diagnóstico definitivo.
    });
    child.stdin.end(audio);
  });
}

/** Seam exclusivo para smokes determinísticos; não é usado no runtime. */
export function __setFfmpegAvailableForTest(available: boolean): void {
  ffmpegState = available;
  ffmpegCheckPromise = Promise.resolve(available);
}

/** Seam exclusivo para capturar args do ffmpeg em smoke offline. */
export function __setAudioEncoderSpawnForTest(
  spawnImpl: typeof spawn = spawn
): void {
  encodeSpawn = spawnImpl;
}
