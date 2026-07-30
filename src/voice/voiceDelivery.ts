import crypto from 'crypto';
import type { TenantBotConfig } from '../configProvider';
import { buildConversationKey } from '../services/contextManager';
import { Sentry } from '../observability/sentry';
import {
  sendAudioMessage,
  sendFreeformMessage,
  uploadMedia,
} from '../whatsappCloudService';
import { encodeToOpus, type TtsEncoderInput } from './audioEncoder';
import { decideDelivery } from './channelPolicy';
import { getChannelPref } from './channelPref';
import { dayKey, recordHit, recordMiss } from './costMeter';
import { applyProsody } from './prosody';
import { synthesizeWithFallback } from './resilientTtsProvider';
import type { TtsSynthesisResult, TtsUsage } from './ttsProvider';
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
  providerDailyCharBudget,
  voiceFingerprint,
  type VoiceEnvConfig,
  type VoiceTtsProviderName,
} from './voiceConfig';

export type VoiceDeliveryStep = 'tts' | 'ffmpeg' | 'upload' | 'send' | 'cache';

export interface VoiceDeliveryDeps {
  getPreference: (conversationKey: string) => Promise<boolean>;
  voiceEnabled: (config: TenantBotConfig) => boolean;
  getConfig: () => VoiceEnvConfig;
  synthesize: (text: string) => Promise<TtsSynthesisResult>;
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
  encode: (audio: Buffer, input: TtsEncoderInput) => Promise<Buffer>;
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
  recordCacheHit: (
    day: string,
    provider: VoiceTtsProviderName
  ) => Promise<void>;
  recordCacheMiss: (
    day: string,
    provider: VoiceTtsProviderName,
    chars: number,
    dailyCharBudget: number,
    usage?: TtsUsage
  ) => Promise<void>;
  now: () => Date;
  captureWarning: (step: VoiceDeliveryStep) => void;
}

const defaultDeps: VoiceDeliveryDeps = {
  getPreference: getChannelPref,
  voiceEnabled: isRenataVoiceEnabled,
  getConfig: getVoiceEnvConfig,
  synthesize: (text) => synthesizeWithFallback(text, getVoiceEnvConfig()),
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

function resultProviderName(provider: string): VoiceTtsProviderName {
  if (provider === 'gemini' || provider === 'elevenlabs') return provider;
  throw new Error(`renata_voice returned unsupported provider ${provider}`);
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
    const primaryProvider = voiceConfig.provider;
    const primaryFingerprint = voiceFingerprint(voiceConfig, primaryProvider);
    const usageDay = dayKey(deps.now());

    step = 'cache';
    const cached = await deps.lookupCache(textHash, primaryFingerprint);
    if (cached) {
      let mediaId = cached.mediaId;
      if (!isMediaFresh(cached, deps.now().getTime())) {
        step = 'upload';
        mediaId = await deps.upload(cached.oggBytes, config);
        step = 'cache';
        await deps.refreshCachedMedia(textHash, primaryFingerprint, mediaId);
      }

      if (!mediaId) {
        throw new Error('renata_voice cache row has no media id');
      }
      step = 'send';
      await deps.sendAudio(to, mediaId, config);
      // A linha histórica do cache não guarda provider; como o lookup foi pelo
      // fingerprint efetivo, o provider primário é autoritativo neste hit.
      await bestEffortUsage(
        () => deps.recordCacheHit(usageDay, primaryProvider),
        deps
      );
      return true;
    }

    step = 'tts';
    const synthesis = await deps.synthesize(prosodic);
    const effectiveProvider = resultProviderName(synthesis.provider);
    const effectiveFingerprint = voiceFingerprint(
      voiceConfig,
      effectiveProvider
    );
    // Conta o texto prosódico sem o style prompt do Gemini. O input textual é
    // ruído frente ao custo de áudio e a métrica segue comparável ao histórico.
    // Conta assim que o provider respondeu, mesmo se uma etapa posterior falhar.
    await bestEffortUsage(
      () =>
        deps.recordCacheMiss(
          usageDay,
          effectiveProvider,
          prosodic.length,
          providerDailyCharBudget(voiceConfig, effectiveProvider),
          synthesis.usage
        ),
      deps
    );

    step = 'ffmpeg';
    const ogg = await deps.encode(synthesis.audio, {
      format: synthesis.format,
      sampleRate: synthesis.sampleRate,
    });
    step = 'upload';
    const mediaId = await deps.upload(ogg, config);
    step = 'cache';
    // Nunca grava fallback sob o fingerprint do primário: isso envenenaria o
    // cache Gemini com uma voz ElevenLabs e pinaria uma indisponibilidade curta.
    await deps.saveCache(textHash, effectiveFingerprint, ogg, mediaId);
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
 * Orquestra a política áudio-primeiro da Renata. É batch: sintetiza o áudio
 * completo (MP3 ou PCM), converte em memória, faz upload e só então envia PTT.
 */
export async function deliverSalesReply(
  to: string,
  originalText: string,
  config: TenantBotConfig,
  overrides?: Partial<VoiceDeliveryDeps>
): Promise<void> {
  const deps = resolveDeps(overrides);
  const voiceConfig = deps.getConfig();
  if (!overrides?.synthesize) {
    // Usa exatamente o mesmo snapshot de env do gate/fingerprint desta entrega.
    deps.synthesize = (text) => synthesizeWithFallback(text, voiceConfig);
  }
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
