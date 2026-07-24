/** Smoke determinístico do vídeo da Renata: sem arquivo, rede ou DB reais. */
process.env.DATABASE_URL ||=
  'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type {
  DemoVideoDeps,
  DemoVideoResult,
} from '../src/media/demoVideo';
import type { MediaCacheRow } from '../src/media/mediaCache';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function config(phoneNumberId: string): TenantBotConfig {
  return {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'x',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId,
    isActive: true,
  };
}

function cacheRow(
  contentHash: string,
  phoneNumberId: string,
  mediaId: string,
  uploadedAt: number
): MediaCacheRow {
  return {
    assetKey: 'demo-video',
    contentHash,
    phoneNumberId,
    mediaId,
    mediaUploadedAt: new Date(uploadedAt),
    hitCount: 0,
    createdAt: new Date(uploadedAt),
  };
}

async function main(): Promise<void> {
  const { MEDIA_FRESH_MS } = await import('../src/voice/ttsCache');
  const { sendDemoVideo } = await import('../src/media/demoVideo');
  const { ensureMediaCacheTable } = await import('../src/media/mediaCache');
  const { buildVideoMessagePayload } = await import(
    '../src/whatsappCloudService'
  );
  const now = Date.UTC(2026, 6, 23, 12);

  console.log('▶ payload WhatsApp');
  const payload = buildVideoMessagePayload('5511000000000', 'media-1', 'Veja');
  check(
    'type video + media id + caption',
    payload.type === 'video' &&
      payload.video.id === 'media-1' &&
      payload.video.caption === 'Veja'
  );
  const withoutCaption = buildVideoMessagePayload('x', 'm');
  check(
    'caption ausente não cria chave vazia',
    !('caption' in withoutCaption.video)
  );
  let schemaSql = '';
  await ensureMediaCacheTable(async (sql) => {
    schemaSql = sql;
    return { rows: [] };
  });
  check(
    'schema usa PK hash+número e não guarda bytes',
    /PRIMARY KEY \(asset_key, content_hash, phone_number_id\)/.test(
      schemaSql
    ) && !/bytea|ogg_bytes|video_bytes/i.test(schemaSql)
  );

  async function scenario(
    existing: MediaCacheRow | null,
    overrides: Partial<DemoVideoDeps> = {}
  ): Promise<{
    result: DemoVideoResult;
    uploads: number;
    persists: number;
    sends: string[];
    warnings: string[];
  }> {
    let uploads = 0;
    let persists = 0;
    const sends: string[] = [];
    const warnings: string[] = [];
    const result = await sendDemoVideo('lead', config('PN1'), {
      loadAsset: async () => ({
        bytes: Buffer.from('fake-video'),
        contentHash: 'hash-a',
      }),
      lookup: async () => existing,
      persist: async () => {
        persists += 1;
      },
      upload: async () => {
        uploads += 1;
        return 'uploaded-media';
      },
      send: async (_to, mediaId) => {
        sends.push(mediaId);
      },
      now: () => now,
      captureWarning: (step) => warnings.push(step),
      ...overrides,
    });
    return { result, uploads, persists, sends, warnings };
  }

  console.log('▶ cache fresh/stale/miss');
  const fresh = await scenario(
    cacheRow('hash-a', 'PN1', 'fresh-media', now - MEDIA_FRESH_MS + 1)
  );
  check(
    'fresh → 0 upload e envia media_id cacheado',
    fresh.result.success &&
      fresh.result.cache === 'fresh' &&
      fresh.uploads === 0 &&
      fresh.persists === 0 &&
      fresh.sends.join(',') === 'fresh-media'
  );

  const stale = await scenario(
    cacheRow('hash-a', 'PN1', 'stale-media', now - MEDIA_FRESH_MS - 1)
  );
  check(
    'stale >25d → re-upload + refresh + envio',
    stale.result.success &&
      stale.result.cache === 'refreshed' &&
      stale.uploads === 1 &&
      stale.persists === 1 &&
      stale.sends.join(',') === 'uploaded-media'
  );

  const miss = await scenario(null);
  check(
    'miss → upload + persist + envio',
    miss.result.success &&
      miss.result.cache === 'miss' &&
      miss.uploads === 1 &&
      miss.persists === 1 &&
      miss.sends.length === 1
  );

  console.log('▶ falhas nunca lançam');
  const uploadFailure = await scenario(null, {
    upload: async () => {
      throw new Error('mock upload');
    },
  });
  check(
    'falha de upload → success false + warning sintético',
    uploadFailure.result.success === false &&
      uploadFailure.warnings.join(',') === 'upload'
  );
  const sendFailure = await scenario(
    cacheRow('hash-a', 'PN1', 'fresh-media', now),
    {
      send: async () => {
        throw new Error('mock send');
      },
    }
  );
  check(
    'falha de envio → success false sem lançar',
    sendFailure.result.success === false &&
      sendFailure.warnings.join(',') === 'send'
  );

  console.log('▶ PK inclui hash + phone_number_id');
  const rows = new Map<string, MediaCacheRow>();
  let uploads = 0;
  async function deliver(contentHash: string, phoneNumberId: string) {
    return sendDemoVideo('lead', config(phoneNumberId), {
      loadAsset: async () => ({
        bytes: Buffer.from(contentHash),
        contentHash,
      }),
      lookup: async (assetKey, hash, pn) =>
        rows.get(`${assetKey}:${hash}:${pn}`) ?? null,
      persist: async (assetKey, hash, pn, mediaId) => {
        rows.set(
          `${assetKey}:${hash}:${pn}`,
          cacheRow(hash, pn, mediaId, now)
        );
      },
      upload: async () => {
        uploads += 1;
        return `media-${uploads}`;
      },
      send: async () => undefined,
      now: () => now,
      captureWarning: () => undefined,
    });
  }
  await deliver('hash-a', 'PN1');
  await deliver('hash-b', 'PN1');
  await deliver('hash-a', 'PN2');
  check(
    'hash diferente cria linha nova',
    rows.has('demo-video:hash-a:PN1') &&
      rows.has('demo-video:hash-b:PN1')
  );
  check(
    'phone_number_id diferente cria linha nova',
    rows.has('demo-video:hash-a:PN2') && rows.size === 3
  );

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-demo-video OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
