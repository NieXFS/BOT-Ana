import crypto from 'crypto';
import type { TenantBotConfig } from '../configProvider';
import { buildConversationKey } from '../services/contextManager';
import { Sentry } from '../observability/sentry';
import {
  sendAudioMessage,
  sendFreeformMessage,
  uploadMedia,
} from '../whatsappCloudService';
import { encodeToOpus } from './audioEncoder';
import { decideDelivery } from './channelPolicy';
import { getChannelPref } from './channelPref';
import { dayKey, recordHit, recordMiss } from './costMeter';
import { applyProsody } from './prosody';
import { getTtsProvider, type TtsProvider } from './ttsProvider';
import {
  isMediaFresh,
  lookup,
  refreshMediaId,
  saveNew,
  type TtsCacheRow,
} from './ttsCache';
import {
  getVoiceEnvConfig,
  isRenataVoiceEnabled,
  voiceFingerprint,
  type VoiceEnvConfig,
} from './voiceConfig';

export type VoiceDeliveryStep = 'tts' | 'ffmpeg' | 'upload' | 'send' | 'cache';

export interface VoiceDeliveryDeps {
  getPreference: (conversationKey: string) => Promise<boolean>;
  voiceEnabled: (config: TenantBotConfig) => boolean;
  getConfig: () => VoiceEnvConfig;
  getProvider: () => TtsProvider;
  lookupCache: (textHash: string, fingerprint: string) => Promise<TtsCacheRow | null>;
  saveCache: (
    textHash: string,
    fingerprint: string,
    oggBytes: Buffer,
    mediaId: string
  ) => Promise<void>;
  refreshCachedMedia: (
    textHash: string,
    fingerprint: string,
    mediaId: string
  ) => Promise<void>;
  encode: (mp3: Buffer) => Promise<Buffer>;
  upload: (ogg: Buffer, config: TenantBotConfig) => Promise<string>;
  sendAudio: (
    to: string,
    mediaId: string,
    config: TenantBotConfig
  ) => Promise<void>;
  sendText: (
    to: string,
    text: string,
    config: TenantBotConfig
  ) => Promise<void>;
  recordCacheHit: (day: string) => Promise<void>;
  recordCacheMiss: (
    day: string,
    chars: number,
    dailyCharBudget: number
  ) => Promise<void>;
  now: () => Date;
  captureWarning: (step: VoiceDeliveryStep) => void;
}

const defaultDeps: VoiceDeliveryDeps = {
  getPreference: getChannelPref,
  voiceEnabled: isRenataVoiceEnabled,
  getConfig: getVoiceEnvConfig,
  getProvider: () => getTtsProvider(),
  lookupCache: lookup,
  saveCache: saveNew,
  refreshCachedMedia: refreshMediaId,
  encode: encodeToOpus,
  upload: uploadMedia,
  sendAudio: sendAudioMessage,
  sendText: sendFreeformMessage,
  recordCacheHit: recordHit,
  recordCacheMiss: recordMiss,
  now: () => new Date(),
  captureWarning: (step) => {
    // Nunca captura o erro original: AxiosError de TTS/upload pode carregar o
    // texto, URL, telefone ou e-mail em config.data/config.url.
    Sentry.captureMessage('renata_voice: audio delivery fallback', {
      level: 'warning',
      tags: { service: 'renata_voice', step },
    });
  },
};

function resolveDeps(overrides?: Partial<VoiceDeliveryDeps>): VoiceDeliveryDeps {
  return { ...defaultDeps, ...overrides };
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function bestEffortUsage(
  operation: () => Promise<void>,
  deps: VoiceDeliveryDeps
): Promise<void> {
  try {
    await operation();
  } catch {
    // O contador não pode duplicar a entrega já feita nem impedir a tentativa
    // de áudio. Reporta sem anexar o erro/PII e segue.
    deps.captureWarning('cache');
  }
}

async function sendOriginalFallback(
  to: string,
  originalText: string,
  config: TenantBotConfig,
  deps: VoiceDeliveryDeps
): Promise<void> {
  try {
    await deps.sendText(to, originalText, config);
  } catch {
    deps.captureWarning('send');
    throw new Error('renata_voice fallback text send failed');
  }
}

/**
 * Retorna true quando o áudio foi enviado. Em qualquer falha, tenta o texto
 * ORIGINAL completo e retorna false; no split, isso já preserva o link.
 */
async function speakAndSend(
  to: string,
  spokenText: string,
  originalText: string,
  config: TenantBotConfig,
  voiceConfig: VoiceEnvConfig,
  deps: VoiceDeliveryDeps
): Promise<boolean> {
  let step: VoiceDeliveryStep = 'cache';

  try {
    const prosodic = applyProsody(spokenText);
    const textHash = hashText(prosodic);
    const fingerprint = voiceFingerprint(voiceConfig);
    const usageDay = dayKey(deps.now());

    step = 'cache';
    const cached = await deps.lookupCache(textHash, fingerprint);
    if (cached) {
      let mediaId = cached.mediaId;
      if (!isMediaFresh(cached, deps.now().getTime())) {
        step = 'upload';
        mediaId = await deps.upload(cached.oggBytes, config);
        step = 'cache';
        await deps.refreshCachedMedia(textHash, fingerprint, mediaId);
      }

      if (!mediaId) {
        throw new Error('renata_voice cache row has no media id');
      }
      step = 'send';
      await deps.sendAudio(to, mediaId, config);
      await bestEffortUsage(() => deps.recordCacheHit(usageDay), deps);
      return true;
    }

    step = 'tts';
    const mp3 = await deps.getProvider().synthesize(prosodic);
    // A ElevenLabs já cobrou os chars quando o MP3 chegou; conta mesmo se uma
    // etapa posterior falhar.
    await bestEffortUsage(
      () =>
        deps.recordCacheMiss(
          usageDay,
          prosodic.length,
          voiceConfig.dailyCharBudget
        ),
      deps
    );

    step = 'ffmpeg';
    const ogg = await deps.encode(mp3);
    step = 'upload';
    const mediaId = await deps.upload(ogg, config);
    step = 'cache';
    await deps.saveCache(textHash, fingerprint, ogg, mediaId);
    step = 'send';
    await deps.sendAudio(to, mediaId, config);
    return true;
  } catch {
    deps.captureWarning(step);
    await sendOriginalFallback(to, originalText, config, deps);
    return false;
  }
}

/**
 * Orquestra a política áudio-primeiro da Renata. É batch: sintetiza o MP3
 * completo, converte em memória, faz upload e só então envia a nota de voz.
 */
export async function deliverSalesReply(
  to: string,
  originalText: string,
  config: TenantBotConfig,
  overrides?: Partial<VoiceDeliveryDeps>
): Promise<void> {
  const deps = resolveDeps(overrides);
  const voiceConfig = deps.getConfig();
  const conversationKey = buildConversationKey(config.phoneNumberId, to);

  let prefersText = false;
  try {
    prefersText = await deps.getPreference(conversationKey);
  } catch {
    // Preferência é best-effort: falha de leitura preserva o default
    // áudio-primeiro. Reporta sem anexar erro/PII.
    deps.captureWarning('cache');
  }

  const plan = decideDelivery({
    text: originalText,
    voiceEnabled: deps.voiceEnabled(config),
    prefersText,
    maxChars: voiceConfig.maxChars,
  });

  if (plan.mode === 'text') {
    await deps.sendText(to, originalText, config);
    return;
  }

  if (plan.mode === 'audio') {
    await speakAndSend(
      to,
      originalText,
      originalText,
      config,
      voiceConfig,
      deps
    );
    return;
  }

  const audioSent = await speakAndSend(
    to,
    plan.voiceText,
    originalText,
    config,
    voiceConfig,
    deps
  );
  if (!audioSent) {
    // O fallback acima já enviou o ORIGINAL, que contém o link.
    return;
  }

  try {
    await deps.sendText(to, plan.linkText, config);
  } catch {
    deps.captureWarning('send');
    // A voz saiu, mas o link não. Reenvia o ORIGINAL em texto para garantir a
    // informação fechada do produto, ainda sem silêncio.
    await sendOriginalFallback(to, originalText, config, deps);
  }
}
