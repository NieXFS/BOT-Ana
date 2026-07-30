/**
 * Smoke offline do Gemini TTS, fallback, PCM/ffmpeg, cache e custo por provider.
 * Todos os I/Os são injetados; não usa rede, DB, ffmpeg nem TTS reais.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import type { spawn } from 'child_process';
import type { TenantBotConfig } from '../src/configProvider';
import type { CostMeterDeps } from '../src/voice/costMeter';
import type {
  GeminiTtsHttpPost,
  GeminiTtsRequestBody,
} from '../src/voice/geminiTtsProvider';
import type {
  ResilientTtsProviderDeps,
} from '../src/voice/resilientTtsProvider';
import type {
  TtsProvider,
  TtsProviderOutput,
  TtsSynthesisResult,
  TtsUsage,
} from '../src/voice/ttsProvider';
import type {
  VoiceDeliveryDeps,
  VoiceDeliveryStep,
} from '../src/voice/voiceDelivery';
import type {
  VoiceEnvConfig,
  VoiceTtsProviderName,
} from '../src/voice/voiceConfig';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const tenantConfig: TenantBotConfig = {
  tenantSlug: 'receps-vendas',
  botName: 'Renata',
  botRole: 'sales',
  systemPrompt: 'x',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'anthropic',
  aiModel: 'smoke',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN_SALES',
  isActive: true,
};

function voiceConfig(
  overrides: Partial<VoiceEnvConfig> = {}
): VoiceEnvConfig {
  const base: VoiceEnvConfig = {
    enabled: true,
    provider: 'gemini',
    gemini: {
      apiKey: 'gemini-smoke-key',
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Achernar',
      temperature: 1.1,
      stylePrompt: 'Fale com empatia e ritmo rápido',
      styleMode: 'prefix',
      dailyCharBudget: 100_000,
    },
    apiKey: 'elevenlabs-smoke-key',
    voiceId: 'carla',
    model: 'eleven_multilingual_v2',
    stability: 0.4,
    similarity: 0.75,
    speed: 1.13,
    style: 0.1,
    dailyCharBudget: 3_300,
    maxChars: 600,
  };
  return {
    ...base,
    ...overrides,
    gemini: {
      ...base.gemini,
      ...(overrides.gemini ?? {}),
    },
  };
}

function fakeProvider(
  name: VoiceTtsProviderName,
  synthesize: () => Promise<TtsProviderOutput>,
  format: 'mp3' | 'pcm_s16le' = name === 'gemini' ? 'pcm_s16le' : 'mp3'
): TtsProvider {
  return {
    name,
    outputFormat: format,
    synthesize,
  };
}

interface DeliveryProbe {
  lookupHash?: string;
  lookupFingerprint?: string;
  saveFingerprint?: string;
  synthesizedText?: string;
  missChars?: number;
  missProvider?: VoiceTtsProviderName;
  missBudget?: number;
  missUsage?: TtsUsage;
  encodeInput?: { format: 'mp3' | 'pcm_s16le'; sampleRate?: number };
  texts: string[];
  warnings: VoiceDeliveryStep[];
}

function deliveryDeps(
  cfg: VoiceEnvConfig,
  synthesis: (text: string) => Promise<TtsSynthesisResult>
): { deps: VoiceDeliveryDeps; probe: DeliveryProbe } {
  const probe: DeliveryProbe = { texts: [], warnings: [] };
  const deps: VoiceDeliveryDeps = {
    getPreference: async () => false,
    voiceEnabled: () => true,
    getConfig: () => cfg,
    synthesize: async (text) => {
      probe.synthesizedText = text;
      return synthesis(text);
    },
    lookupCache: async (textHash, fingerprint) => {
      probe.lookupHash = textHash;
      probe.lookupFingerprint = fingerprint;
      return null;
    },
    saveCache: async (_textHash, fingerprint) => {
      probe.saveFingerprint = fingerprint;
    },
    refreshCachedMedia: async () => {},
    encode: async (_audio, input) => {
      probe.encodeInput = input;
      return Buffer.from('ogg');
    },
    upload: async () => 'MEDIA_ID',
    sendAudio: async () => {},
    sendText: async (_to, text) => {
      probe.texts.push(text);
    },
    recordCacheHit: async () => {},
    recordCacheMiss: async (_day, provider, chars, budget, usage) => {
      probe.missProvider = provider;
      probe.missChars = chars;
      probe.missBudget = budget;
      probe.missUsage = usage;
    },
    now: () => new Date('2026-07-30T15:00:00.000Z'),
    captureWarning: (step) => probe.warnings.push(step),
  };
  return { deps, probe };
}

async function main(): Promise<void> {
  const {
    GeminiTtsProvider,
    GEMINI_TTS_REQUEST_TIMEOUT_MS,
  } = await import('../src/voice/geminiTtsProvider');
  const {
    __setAudioEncoderSpawnForTest,
    __setFfmpegAvailableForTest,
    encodeToOpus,
  } = await import('../src/voice/audioEncoder');
  const {
    synthesizeWithFallback,
  } = await import('../src/voice/resilientTtsProvider');
  const { deliverSalesReply } = await import('../src/voice/voiceDelivery');
  const { applyProsody } = await import('../src/voice/prosody');
  const {
    getVoiceEnvConfig,
    isRenataVoiceEnabled,
    voiceFingerprint,
  } = await import('../src/voice/voiceConfig');
  const cost = await import('../src/voice/costMeter');

  console.log('▶ payload Gemini + style steering + parse PCM');
  const prefixCfg = voiceConfig();
  const requestCalls: Array<{
    url: string;
    body: GeminiTtsRequestBody;
    config: Parameters<GeminiTtsHttpPost>[2];
  }> = [];
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const prefixPost: GeminiTtsHttpPost = async (url, body, config) => {
    requestCalls.push({ url, body, config });
    return {
      data: {
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                data: pcm.toString('base64'),
                mimeType: 'audio/l16; rate=24000; channels=1',
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 25,
          candidatesTokenCount: 63,
          totalTokenCount: 88,
          promptTokensDetails: [{ modality: 'TEXT', tokenCount: 25 }],
          candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 63 }],
          serviceTier: 'standard',
        },
      },
    };
  };
  const prefixProvider = new GeminiTtsProvider(prefixCfg, prefixPost);
  const prefixOutput = await prefixProvider.synthesize('texto prosódico');
  const prefixCall = requestCalls[0]!;
  check(
    'modelo correto e chave fora da URL',
    prefixCall.url.includes(
      '/gemini-3.1-flash-tts-preview:generateContent'
    ) &&
      !prefixCall.url.includes(prefixCfg.gemini.apiKey)
  );
  check(
    'chave no x-goog-api-key + content-type',
    prefixCall.config.headers?.['x-goog-api-key'] ===
      prefixCfg.gemini.apiKey &&
      prefixCall.config.headers?.['content-type'] === 'application/json'
  );
  check(
    'timeout 20s aplicado',
    prefixCall.config.timeout === GEMINI_TTS_REQUEST_TIMEOUT_MS
  );
  check(
    'payload AUDIO/model voice/temp',
    prefixCall.body.generationConfig.responseModalities[0] === 'AUDIO' &&
      prefixCall.body.generationConfig.temperature === 1.1 &&
      prefixCall.body.generationConfig.speechConfig.voiceConfig
        .prebuiltVoiceConfig.voiceName === 'Achernar'
  );
  check(
    'prefix exato "<style>: <prosódico>"',
    prefixCall.body.contents[0]?.parts[0]?.text ===
      `${prefixCfg.gemini.stylePrompt}: texto prosódico` &&
      !prefixCall.body.systemInstruction
  );
  check(
    'fixture real: base64/rate e usageMetadata são extraídos',
    prefixOutput.audio.equals(pcm) &&
      prefixOutput.sampleRate === 24_000 &&
      prefixOutput.usage?.audioTokens === 63 &&
      prefixOutput.usage.textTokens === 25
  );

  const systemCfg = voiceConfig({
    gemini: { ...prefixCfg.gemini, styleMode: 'system' },
  });
  let systemBody: GeminiTtsRequestBody | undefined;
  const systemProvider = new GeminiTtsProvider(
    systemCfg,
    async (_url, body) => {
      systemBody = body;
      return {
        data: {
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  data: pcm.toString('base64'),
                  mimeType: 'audio/L16;codec=pcm',
                },
              }],
            },
          }],
        },
      };
    }
  );
  const systemOutput = await systemProvider.synthesize('texto prosódico');
  check(
    'system põe estilo só em systemInstruction',
    systemBody?.contents[0]?.parts[0]?.text === 'texto prosódico' &&
      systemBody.systemInstruction?.parts[0]?.text ===
        systemCfg.gemini.stylePrompt
  );
  check(
    'rate ausente usa 24000 e usage ausente não lança nem fabrica zero',
    systemOutput.sampleRate === 24_000 && systemOutput.usage === undefined
  );

  console.log('▶ mesma instância Gemini é stateless em concorrência');
  let releaseFirst: (() => void) | undefined;
  const firstCanReturn = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sharedProvider = new GeminiTtsProvider(
    prefixCfg,
    async (_url, body) => {
      const requestedText = body.contents[0]?.parts[0]?.text ?? '';
      const isFirst = requestedText.endsWith('primeira');
      if (isFirst) {
        await firstCanReturn;
      } else {
        releaseFirst?.();
      }
      const tokenCount = isFirst ? 32 : 96;
      return {
        data: {
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  data: Buffer.from(isFirst ? 'first' : 'second').toString(
                    'base64'
                  ),
                  mimeType: `audio/l16; rate=${
                    isFirst ? 16000 : 22050
                  }; channels=1`,
                },
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: isFirst ? 7 : 11,
            candidatesTokenCount: tokenCount,
            totalTokenCount: tokenCount + (isFirst ? 7 : 11),
            promptTokensDetails: [{
              modality: 'TEXT',
              tokenCount: isFirst ? 7 : 11,
            }],
            candidatesTokensDetails: [{
              modality: 'AUDIO',
              tokenCount,
            }],
            serviceTier: 'standard',
          },
        },
      };
    }
  );
  const [firstOutput, secondOutput] = await Promise.all([
    sharedProvider.synthesize('primeira'),
    sharedProvider.synthesize('segunda'),
  ]);
  check(
    'cada síntese concorrente conserva rate/uso da própria resposta',
    firstOutput.audio.toString() === 'first' &&
      firstOutput.sampleRate === 16_000 &&
      firstOutput.usage?.audioTokens === 32 &&
      firstOutput.usage.textTokens === 7 &&
      secondOutput.audio.toString() === 'second' &&
      secondOutput.sampleRate === 22_050 &&
      secondOutput.usage?.audioTokens === 96 &&
      secondOutput.usage.textTokens === 11
  );

  const rawMarker = 'BODY_COM_TEXTO_PRIVADO';
  let missingAudioError = '';
  try {
    const missingProvider = new GeminiTtsProvider(
      prefixCfg,
      async () =>
        ({
          data: {
            candidates: [{
              finishReason: 'SAFETY',
              content: { parts: [{ text: rawMarker }] },
            }],
          },
        } as never)
    );
    await missingProvider.synthesize('não vazar');
  } catch (error) {
    missingAudioError = error instanceof Error ? error.message : String(error);
  }
  check(
    'sem inlineData falha claro sem vazar body',
    missingAudioError.includes('missing inline audio data') &&
      !missingAudioError.includes(rawMarker) &&
      !missingAudioError.includes('não vazar')
  );

  console.log('▶ hash/chars sem style prompt nos dois modos');
  const original = 'Oi! Posso te explicar rapidinho.';
  const prosodic = applyProsody(original);
  const expectedHash = crypto.createHash('sha256').update(prosodic).digest('hex');
  for (const cfg of [prefixCfg, systemCfg]) {
    const { deps, probe } = deliveryDeps(cfg, async () => ({
      audio: Buffer.from('pcm'),
      format: 'pcm_s16le',
      sampleRate: 24_000,
      provider: 'gemini',
      usage: prefixOutput.usage,
    }));
    await deliverSalesReply('lead', original, tenantConfig, deps);
    check(
      `${cfg.gemini.styleMode}: TTS recebe texto prosódico sem style`,
      probe.synthesizedText === prosodic &&
        !probe.synthesizedText?.includes(cfg.gemini.stylePrompt)
    );
    check(
      `${cfg.gemini.styleMode}: hash/chars excluem style`,
        probe.lookupHash === expectedHash &&
        probe.missChars === prosodic.length &&
        probe.missBudget === cfg.gemini.dailyCharBudget &&
        probe.missUsage?.audioTokens === 63 &&
        probe.missUsage.textTokens === 25
    );
  }

  console.log('▶ encoder MP3/PCM com spawn falso');
  const spawnCalls: string[][] = [];
  const fakeSpawn = ((
    _command: string,
    args?: readonly string[]
  ) => {
    spawnCalls.push([...(args ?? [])]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.kill = () => true;
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('ogg'));
        child.emit('close', 0);
      });
    });
    return child;
  }) as unknown as typeof spawn;
  __setAudioEncoderSpawnForTest(fakeSpawn);
  try {
    await encodeToOpus(Buffer.from('mp3'), { format: 'mp3' });
    await encodeToOpus(Buffer.from('pcm'), {
      format: 'pcm_s16le',
      sampleRate: 16_000,
    });
  } finally {
    __setAudioEncoderSpawnForTest();
  }
  const historicalMp3Args = [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '24k', '-ar', '24000', '-ac', '1',
    '-application', 'voip', '-vbr', 'on', '-f', 'ogg', 'pipe:1',
  ];
  check(
    'MP3 mantém args byte-idênticos',
    JSON.stringify(spawnCalls[0]) === JSON.stringify(historicalMp3Args)
  );
  const pcmArgs = spawnCalls[1] ?? [];
  const pcmInput = pcmArgs.slice(3, 11);
  check(
    'PCM declara s16le/rate/mono antes de -i',
    JSON.stringify(pcmInput) ===
      JSON.stringify([
        '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0',
      ])
  );
  check(
    'saída Opus é idêntica nos dois formatos',
    JSON.stringify(pcmArgs.slice(11)) ===
      JSON.stringify(historicalMp3Args.slice(5))
  );

  console.log('▶ retry curto + fallback');
  {
    let geminiCalls = 0;
    let elevenCalls = 0;
    const slept: number[] = [];
    const result = await synthesizeWithFallback('prosódico', prefixCfg, {
      providers: {
        gemini: fakeProvider('gemini', async () => {
          geminiCalls += 1;
          if (geminiCalls < 3) throw { status: 529 };
          return {
            audio: Buffer.from('gemini'),
            sampleRate: 24_000,
            usage: { audioTokens: 63, textTokens: 25 },
          };
        }, 'pcm_s16le'),
        elevenlabs: fakeProvider('elevenlabs', async () => {
          elevenCalls += 1;
          return { audio: Buffer.from('eleven') };
        }),
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
      captureProviderFailure: () => {},
      logSuccess: () => {},
    });
    check(
      '529 faz retry curto e recupera no Gemini',
      geminiCalls === 3 &&
        elevenCalls === 0 &&
        slept.join(',') === '1000,2000' &&
        result.provider === 'gemini' &&
        result.sampleRate === 24_000 &&
        result.usage?.audioTokens === 63
    );
  }

  let fallbackGeminiCalls = 0;
  let fallbackElevenCalls = 0;
  const capturedFailures: string[] = [];
  const fallbackDeps: ResilientTtsProviderDeps = {
    providers: {
      gemini: fakeProvider('gemini', async () => {
        fallbackGeminiCalls += 1;
        throw { status: 503 };
      }),
      elevenlabs: fakeProvider('elevenlabs', async () => {
        fallbackElevenCalls += 1;
        return { audio: Buffer.from('eleven') };
      }),
    },
    retryDelaysMs: [],
    captureProviderFailure: (provider) => capturedFailures.push(provider),
    logSuccess: () => {},
  };
  const fallbackResult = await synthesizeWithFallback(
    'prosódico',
    prefixCfg,
    fallbackDeps
  );
  check(
    'Gemini esgotado cai na ElevenLabs e carrega provider real',
    fallbackGeminiCalls === 1 &&
      fallbackElevenCalls === 1 &&
      fallbackResult.provider === 'elevenlabs' &&
      capturedFailures.join(',') === 'gemini'
  );

  {
    let geminiCalls = 0;
    const sleeps: number[] = [];
    const result = await synthesizeWithFallback('prosódico', prefixCfg, {
      providers: {
        gemini: fakeProvider('gemini', async () => {
          geminiCalls += 1;
          throw { status: 401 };
        }),
        elevenlabs: fakeProvider(
          'elevenlabs',
          async () => ({ audio: Buffer.from('ok') })
        ),
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      captureProviderFailure: () => {},
      logSuccess: () => {},
    });
    check(
      '401 não gasta retry e ainda permite fallback explícito',
      geminiCalls === 1 && sleeps.length === 0 && result.provider === 'elevenlabs'
    );
  }

  {
    const bothFailDeps: ResilientTtsProviderDeps = {
      providers: {
        gemini: fakeProvider('gemini', async () => {
          throw { status: 529 };
        }),
        elevenlabs: fakeProvider('elevenlabs', async () => {
          throw { code: 'ECONNRESET' };
        }),
      },
      retryDelaysMs: [],
      captureProviderFailure: () => {},
      logSuccess: () => {},
    };
    const { deps, probe } = deliveryDeps(prefixCfg, (text) =>
      synthesizeWithFallback(text, prefixCfg, bothFailDeps)
    );
    await deliverSalesReply('lead', original, tenantConfig, deps);
    check(
      'ambos falham → voiceDelivery envia TEXTO original',
      probe.texts.join('|') === original && probe.warnings.includes('tts')
    );
  }

  console.log('▶ cache pelo provider efetivo + fingerprint v2');
  {
    const { deps, probe } = deliveryDeps(prefixCfg, (text) =>
      synthesizeWithFallback(text, prefixCfg, fallbackDeps)
    );
    await deliverSalesReply('lead', original, tenantConfig, deps);
    const geminiFingerprint = voiceFingerprint(prefixCfg, 'gemini');
    const elevenFingerprint = voiceFingerprint(prefixCfg, 'elevenlabs');
    check(
      'lookup usa primário Gemini',
      probe.lookupFingerprint === geminiFingerprint
    );
    check(
      'fallback Eleven salva sob Eleven, nunca sob Gemini',
      probe.saveFingerprint === elevenFingerprint &&
        probe.saveFingerprint !== geminiFingerprint &&
        probe.missProvider === 'elevenlabs' &&
        probe.encodeInput?.format === 'mp3'
    );
  }
  const fp = voiceFingerprint(prefixCfg, 'gemini');
  const fingerprintVariants: VoiceEnvConfig[] = [
    voiceConfig({ provider: 'elevenlabs' }),
    voiceConfig({
      gemini: { ...prefixCfg.gemini, model: `${prefixCfg.gemini.model}-x` },
    }),
    voiceConfig({
      gemini: { ...prefixCfg.gemini, voice: `${prefixCfg.gemini.voice}-x` },
    }),
    voiceConfig({
      gemini: {
        ...prefixCfg.gemini,
        temperature: prefixCfg.gemini.temperature + 0.1,
      },
    }),
    voiceConfig({
      gemini: {
        ...prefixCfg.gemini,
        stylePrompt: `${prefixCfg.gemini.stylePrompt}!`,
      },
    }),
    systemCfg,
  ];
  check(
    'fingerprint muda com provider/model/voz/temp/style/mode',
    voiceFingerprint(prefixCfg, 'elevenlabs') !== fp &&
      fingerprintVariants.slice(1).every(
        (variant) => voiceFingerprint(variant, 'gemini') !== fp
      )
  );
  check(
    'fingerprint estável sem mudança',
    voiceFingerprint(voiceConfig(), 'gemini') === fp
  );

  console.log('▶ budget por provider + ensure idempotente');
  const usage = {
    gemini: { chars: 0, audioTokens: 0, audioSeconds: 0, alerted: false },
    elevenlabs: { chars: 0, audioTokens: 0, audioSeconds: 0, alerted: false },
  };
  const budgetWarnings: VoiceTtsProviderName[] = [];
  const meterDeps: CostMeterDeps = {
    query: async (text, params) => {
      const provider = String(params?.[1] ?? 'elevenlabs') as VoiceTtsProviderName;
      const state = usage[provider];
      if (text.includes('INSERT INTO tts_daily_usage') && text.includes('misses')) {
        state.chars += Number(params?.[2] ?? 0);
        state.audioTokens += Number(params?.[3] ?? 0);
        state.audioSeconds += Number(params?.[4] ?? 0);
        return {
          rows: [{
            chars: state.chars,
            audio_tokens: state.audioTokens,
            audio_seconds: state.audioSeconds,
            alerted: state.alerted,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SET alerted = true')) {
        if (state.alerted) return { rows: [], rowCount: 0 };
        state.alerted = true;
        return { rows: [{ day: params?.[0], provider }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    captureBudgetWarning: (provider) => budgetWarnings.push(provider),
  };
  await cost.recordMiss(
    '2026-07-30',
    'gemini',
    80,
    100,
    prefixOutput.usage,
    meterDeps
  );
  check(
    'uso real grava 63 audio_tokens e ceil(63/32)=2 audio_seconds',
    usage.gemini.chars === 80 &&
      usage.gemini.audioTokens === 63 &&
      usage.gemini.audioSeconds === 2 &&
      usage.elevenlabs.chars === 0
  );
  await cost.recordMiss(
    '2026-07-30',
    'gemini',
    14,
    100,
    systemOutput.usage,
    meterDeps
  );
  check(
    'sem usage mantém audio_tokens=0 no miss e estima segundos por chars',
    usage.gemini.chars === 94 &&
      usage.gemini.audioTokens === 63 &&
      usage.gemini.audioSeconds === 3
  );
  check(
    'alarme 80% é 1x/dia e identifica provider',
    budgetWarnings.join(',') === 'gemini' &&
      cost.budgetWarningMessage('gemini').includes('provider=gemini')
  );
  const ensureSql: string[] = [];
  const ensureQuery = async (text: string) => {
    ensureSql.push(text);
    return { rows: [], rowCount: 0 };
  };
  await cost.ensureTtsUsageTable(ensureQuery);
  await cost.ensureTtsUsageTable(ensureQuery);
  check(
    'ensure aditivo inclui provider/audio_tokens/audio_seconds e PK composta',
    ensureSql.some(
      (sql) =>
        sql.includes('ADD COLUMN IF NOT EXISTS provider') &&
        sql.includes("DEFAULT 'elevenlabs'") &&
        sql.includes('ADD COLUMN IF NOT EXISTS audio_tokens') &&
        sql.includes('ADD COLUMN IF NOT EXISTS audio_seconds')
    ) &&
      ensureSql.some(
        (sql) =>
          sql.includes("current_pk_columns = ARRAY['day']") &&
          sql.includes('PRIMARY KEY (day, provider)')
      )
  );

  console.log('▶ gate por chave selecionada');
  __setFfmpegAvailableForTest(true);
  process.env.RENATA_VOICE_ENABLED = 'true';
  process.env.RENATA_ELEVENLABS_API_KEY = 'eleven-key';
  process.env.RENATA_TTS_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  check(
    'Gemini selecionado sem GEMINI_API_KEY fica OFF',
    !isRenataVoiceEnabled(tenantConfig)
  );
  process.env.GEMINI_API_KEY = 'gemini-key';
  check(
    'Gemini selecionado com chave fica ON',
    isRenataVoiceEnabled(tenantConfig)
  );
  process.env.RENATA_TTS_PROVIDER = 'elevenlabs';
  delete process.env.RENATA_ELEVENLABS_API_KEY;
  check(
    'ElevenLabs selecionada sem chave própria fica OFF',
    !isRenataVoiceEnabled(tenantConfig)
  );
  delete process.env.RENATA_TTS_PROVIDER;
  check(
    'default de código permanece ElevenLabs',
    getVoiceEnvConfig().provider === 'elevenlabs'
  );

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-gemini-tts OK');
}

main().catch((error) => {
  console.error(
    '❌ smoke falhou:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
