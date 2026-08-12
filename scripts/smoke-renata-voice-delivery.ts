/**
 * Smoke determinístico do orquestrador: cache hit/stale/miss, split e fallback
 * por etapa. Todos os I/Os são injetados; sem DB/rede/ffmpeg/TTS reais.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { TtsCacheRow } from '../src/voice/ttsCache';
import type {
  VoiceDeliveryDeps,
  VoiceDeliveryStep,
} from '../src/voice/voiceDelivery';
import type { VoiceEnvConfig } from '../src/voice/voiceConfig';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const config: TenantBotConfig = {
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

const voiceConfig: VoiceEnvConfig = {
  enabled: true,
  provider: 'elevenlabs',
  gemini: {
    apiKey: 'gemini-key',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Achernar',
    temperature: 1.1,
    stylePrompt: 'Fale com empatia',
    styleMode: 'prefix',
    dailyCharBudget: 100_000,
  },
  apiKey: 'key',
  voiceId: 'voice',
  model: 'eleven_multilingual_v2',
  stability: 0.3,
  similarity: 0.75,
  speed: 1.12,
  style: 0.1,
  dailyCharBudget: 200_000,
  maxChars: 600,
};

interface Log {
  synth: number;
  encode: number;
  upload: number;
  save: number;
  refresh: number;
  hit: number;
  miss: number;
  events: string[];
  warnings: VoiceDeliveryStep[];
}

function cacheRow(ageMs: number, mediaId = 'MEDIA_OLD'): TtsCacheRow {
  const now = new Date('2026-07-23T15:00:00.000Z').getTime();
  return {
    textHash: 'hash',
    voiceFingerprint: 'fp',
    oggBytes: Buffer.from('cached-ogg'),
    mediaId,
    mediaUploadedAt: new Date(now - ageMs),
    hitCount: 3,
    createdAt: new Date(now - ageMs),
  };
}

function harness(
  overrides: Partial<VoiceDeliveryDeps> = {}
): { deps: VoiceDeliveryDeps; log: Log } {
  const log: Log = {
    synth: 0,
    encode: 0,
    upload: 0,
    save: 0,
    refresh: 0,
    hit: 0,
    miss: 0,
    events: [],
    warnings: [],
  };
  const deps: VoiceDeliveryDeps = {
    getPreference: async () => false,
    voiceEnabled: () => true,
    getConfig: () => voiceConfig,
    synthesize: async () => {
      log.synth += 1;
      return {
        audio: Buffer.from('mp3'),
        format: 'mp3',
        provider: 'elevenlabs',
      };
    },
    lookupCache: async () => null,
    saveCache: async () => {
      log.save += 1;
    },
    refreshCachedMedia: async () => {
      log.refresh += 1;
    },
    encode: async () => {
      log.encode += 1;
      return Buffer.from('ogg');
    },
    upload: async () => {
      log.upload += 1;
      return 'MEDIA_NEW';
    },
    sendAudio: async (_to, id) => {
      log.events.push(`audio:${id}`);
    },
    sendText: async (_to, text) => {
      log.events.push(`text:${text}`);
    },
    recordCacheHit: async () => {
      log.hit += 1;
    },
    recordCacheMiss: async () => {
      log.miss += 1;
    },
    now: () => new Date('2026-07-23T15:00:00.000Z'),
    captureWarning: (step) => log.warnings.push(step),
    ...overrides,
  };
  return { deps, log };
}

async function main(): Promise<void> {
  const { deliverSalesReply } = await import('../src/voice/voiceDelivery');
  const { MEDIA_FRESH_MS } = await import('../src/voice/ttsCache');

  console.log('▶ cache hit fresco');
  {
    const { deps, log } = harness({
      lookupCache: async () => cacheRow(1_000, 'MEDIA_FRESH'),
    });
    await deliverSalesReply('lead', 'Oi! Posso te explicar rapidinho.', config, deps);
    check('envia media fresco', log.events.join(',') === 'audio:MEDIA_FRESH');
    check('0 TTS / 0 upload', log.synth === 0 && log.upload === 0);
    check('conta hit', log.hit === 1 && log.miss === 0);
  }

  console.log('▶ cache hit com media velho');
  {
    const { deps, log } = harness({
      lookupCache: async () => cacheRow(MEDIA_FRESH_MS + 1),
    });
    await deliverSalesReply('lead', 'Oi! Posso te explicar rapidinho.', config, deps);
    check('re-upload sem TTS', log.upload === 1 && log.synth === 0);
    check('refresh media id', log.refresh === 1);
    check('envia id novo', log.events.join(',') === 'audio:MEDIA_NEW');
  }

  console.log('▶ cache miss');
  {
    const { deps, log } = harness();
    await deliverSalesReply('lead', 'Oi! Posso te explicar rapidinho.', config, deps);
    check('TTS → ffmpeg → upload → save → send', log.synth === 1 && log.encode === 1 && log.upload === 1 && log.save === 1);
    check('miss conta chars uma vez', log.miss === 1 && log.hit === 0);
    check('nota enviada', log.events.join(',') === 'audio:MEDIA_NEW');
  }

  console.log('▶ fallback por etapa usa ORIGINAL');
  const original = 'Oi! Esta é a resposta ORIGINAL.';
  const cases: Array<{
    label: string;
    override: Partial<VoiceDeliveryDeps>;
    step: VoiceDeliveryStep;
  }> = [
    {
      label: 'cache',
      override: { lookupCache: async () => { throw new Error('cache'); } },
      step: 'cache',
    },
    {
      label: 'tts',
      override: {
        synthesize: async () => {
          throw new Error('tts');
        },
      },
      step: 'tts',
    },
    {
      label: 'ffmpeg',
      override: { encode: async () => { throw new Error('ffmpeg'); } },
      step: 'ffmpeg',
    },
    {
      label: 'upload',
      override: { upload: async () => { throw new Error('upload'); } },
      step: 'upload',
    },
    {
      label: 'send',
      override: { sendAudio: async () => { throw new Error('send'); } },
      step: 'send',
    },
  ];
  for (const testCase of cases) {
    const { deps, log } = harness(testCase.override);
    await deliverSalesReply('lead', original, config, deps);
    check(
      `${testCase.label}: fallback texto original`,
      log.events.includes(`text:${original}`)
    );
    check(
      `${testCase.label}: warning da etapa`,
      log.warnings.includes(testCase.step)
    );
  }

  console.log('▶ envio de áudio ambíguo nunca gera texto duplicado');
  for (const transportCode of ['ETIMEDOUT', 'ECONNRESET']) {
    for (const includesAxiosRequest of [true, false]) {
      const ambiguous = Object.assign(new Error('timeout após POST'), {
        code: transportCode,
        ...(includesAxiosRequest ? { request: {} } : {}),
      });
      const { deps, log } = harness({
        sendAudio: async () => {
          log.events.push('audio:POST_POSSIVELMENTE_ACEITO');
          throw ambiguous;
        },
      });
      await deliverSalesReply('lead', original, config, deps);
      check(
        `${transportCode} ${includesAxiosRequest ? 'Axios' : 'Error comum'} não envia fallback textual`,
        log.events.join('|') === 'audio:POST_POSSIVELMENTE_ACEITO'
      );
      check(
        `${transportCode} ${includesAxiosRequest ? 'Axios' : 'Error comum'} registra warning de send`,
        log.warnings.includes('send')
      );
    }
  }
  {
    const ambiguous = Object.assign(new Error('fallback text timeout'), {
      code: 'ETIMEDOUT',
      request: {},
    });
    const { deps } = harness({
      synthesize: async () => {
        throw new Error('tts indisponível');
      },
      sendText: async () => {
        throw ambiguous;
      },
    });
    let propagated: unknown = null;
    try {
      await deliverSalesReply('lead', original, config, deps);
    } catch (error) {
      propagated = error;
    }
    const { isAmbiguousWhatsAppTransportError } = await import(
      '../src/whatsappCloudService'
    );
    check(
      'fallback textual ambíguo chega ao caller sem virar retry elegível',
      isAmbiguousWhatsAppTransportError(propagated)
    );
  }

  console.log('▶ split voz + link');
  const splitText =
    'Deixei tudo organizado pra você começar com calma por aqui: https://receps.com.br/cadastro?x=1';
  {
    const { deps, log } = harness();
    await deliverSalesReply('lead', splitText, config, deps);
    check(
      'ordem = voz depois texto só-link',
      log.events[0] === 'audio:MEDIA_NEW' &&
        log.events[1] === 'text:https://receps.com.br/cadastro?x=1'
    );
  }
  {
    const ambiguous = Object.assign(new Error('link timeout'), {
      isAxiosError: true,
      code: 'ECONNRESET',
      request: {},
    });
    const { deps, log } = harness({
      sendText: async (_to, text) => {
        log.events.push(`text:${text}`);
        throw ambiguous;
      },
    });
    await deliverSalesReply('lead', splitText, config, deps);
    check(
      'link ambíguo não reenvia o ORIGINAL completo',
      log.events.join('|') ===
        'audio:MEDIA_NEW|text:https://receps.com.br/cadastro?x=1'
    );
  }
  {
    const { deps, log } = harness({
      synthesize: async () => {
        throw new Error('tts');
      },
    });
    await deliverSalesReply('lead', splitText, config, deps);
    check(
      'falha da voz preserva link no ORIGINAL, sem link duplicado',
      log.events.join('|') === `text:${splitText}`
    );
  }

  console.log('▶ exceção de política não chama TTS');
  {
    const { deps, log } = harness();
    const emailText = 'Confirma pra mim: maria@example.com?';
    await deliverSalesReply('lead', emailText, config, deps);
    check('email força texto original', log.events.join(',') === `text:${emailText}`);
    check('email não sintetiza', log.synth === 0);
  }

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-voice-delivery OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
