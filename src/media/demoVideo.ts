import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { TenantBotConfig } from '../configProvider';
import { Sentry } from '../observability/sentry';
import {
  sendVideoMessage,
  uploadVideoMedia,
} from '../whatsappCloudService';
import { MEDIA_FRESH_MS } from '../voice/ttsCache';
import {
  DEMO_VIDEO_ASSET_KEY,
  lookupMedia,
  upsertMedia,
  type MediaCacheRow,
} from './mediaCache';

export type DemoVideoStep = 'read' | 'lookup' | 'upload' | 'cache' | 'send';

export type DemoVideoResult =
  | { success: true; mediaId: string; cache: 'fresh' | 'refreshed' | 'miss' }
  | { success: false };

export interface DemoAsset {
  bytes: Buffer;
  contentHash: string;
}

export interface DemoVideoDeps {
  loadAsset: () => Promise<DemoAsset>;
  lookup: (
    assetKey: string,
    contentHash: string,
    phoneNumberId: string
  ) => Promise<MediaCacheRow | null>;
  persist: (
    assetKey: string,
    contentHash: string,
    phoneNumberId: string,
    mediaId: string
  ) => Promise<void>;
  upload: (bytes: Buffer, config: TenantBotConfig) => Promise<string>;
  send: (to: string, mediaId: string, config: TenantBotConfig) => Promise<void>;
  now: () => number;
  captureWarning: (step: DemoVideoStep) => void;
}

let memoizedAsset: Promise<DemoAsset> | null = null;

export function resolveDemoVideoPath(): string {
  const override = process.env.RENATA_DEMO_VIDEO_PATH?.trim();
  if (override) return path.resolve(override);

  // `src/media` e `dist/media` têm a mesma profundidade a partir da raiz; por
  // isso `../../assets` resolve o mesmo arquivo no ts-node-dev e no build tsc.
  return path.resolve(__dirname, '../../assets/renata-demo.mp4');
}

export function loadDemoAsset(): Promise<DemoAsset> {
  if (!memoizedAsset) {
    memoizedAsset = fs.readFile(resolveDemoVideoPath()).then((bytes) => ({
      bytes,
      // O hash faz parte do PK: qualquer re-render do arquivo cria outra chave
      // automaticamente. O asset inteiro fica lazy/memoizado uma vez por
      // processo, então o SHA-256 não é recalculado a cada envio.
      contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    }));
  }
  return memoizedAsset;
}

const defaultDeps: DemoVideoDeps = {
  loadAsset: loadDemoAsset,
  lookup: lookupMedia,
  persist: upsertMedia,
  upload: uploadVideoMedia,
  send: sendVideoMessage,
  now: () => Date.now(),
  captureWarning: (step) => {
    // Nunca capturar o erro original: AxiosError pode carregar URL/token/PII em
    // config.data. A mensagem sintética registra somente a etapa técnica.
    Sentry.captureMessage('renata_demo_video: delivery failed', {
      level: 'warning',
      tags: { service: 'renata_demo_video', step },
    });
  },
};

function resolveDeps(overrides?: Partial<DemoVideoDeps>): DemoVideoDeps {
  return { ...defaultDeps, ...overrides };
}

export function isDemoMediaFresh(
  row: Pick<MediaCacheRow, 'mediaId' | 'mediaUploadedAt'>,
  nowMs: number
): boolean {
  return (
    Boolean(row.mediaId) &&
    nowMs - row.mediaUploadedAt.getTime() < MEDIA_FRESH_MS
  );
}

/** Envia o vídeo da escada de demonstração. Nunca lança. */
export async function sendDemoVideo(
  to: string,
  config: TenantBotConfig,
  overrides?: Partial<DemoVideoDeps>
): Promise<DemoVideoResult> {
  const deps = resolveDeps(overrides);
  let step: DemoVideoStep = 'read';

  try {
    const asset = await deps.loadAsset();

    step = 'lookup';
    const cached = await deps.lookup(
      DEMO_VIDEO_ASSET_KEY,
      asset.contentHash,
      config.phoneNumberId
    );
    if (cached && isDemoMediaFresh(cached, deps.now())) {
      step = 'send';
      await deps.send(to, cached.mediaId, config);
      return { success: true, mediaId: cached.mediaId, cache: 'fresh' };
    }

    step = 'upload';
    const mediaId = await deps.upload(asset.bytes, config);
    step = 'cache';
    // `phone_number_id` também faz parte do PK porque media_id do WhatsApp é
    // escopado ao número que fez o upload; compartilhar entre números falha na
    // Graph API.
    await deps.persist(
      DEMO_VIDEO_ASSET_KEY,
      asset.contentHash,
      config.phoneNumberId,
      mediaId
    );
    step = 'send';
    await deps.send(to, mediaId, config);
    return {
      success: true,
      mediaId,
      cache: cached ? 'refreshed' : 'miss',
    };
  } catch {
    deps.captureWarning(step);
    return { success: false };
  }
}

/** Apenas para isolar processos de smoke que importem o módulo mais de uma vez. */
export function __resetDemoAssetForTest(): void {
  memoizedAsset = null;
}
