import type OpenAI from 'openai';
import type { TenantBotConfig } from '../../configProvider';
import type { ServicesResult } from '../calendarService';
import {
  buildSocialReceptionistReply,
  currentMessageMentionsCatalogService,
  isSocialOnlyReceptionistMessage,
} from '../receptionistSocialSafety';
import {
  createReceptionistChatCompletion,
  resolveReceptionistAiRuntime,
  type DeepSeekThinkingMode,
  type ReceptionistCompletionInput,
} from '../receptionistLlmProvider';
import { evaluateBoundaryV2 } from './boundary';
import { opaqueReceiptHashV2 } from './receipts';
import type {
  BoundaryEvaluation,
  BoundaryReasonCodeV2,
  DeliveryPreemptionV2,
  InboundSpanV2,
  ModelTurnResultV2,
  TurnFrameV2,
} from './contracts';
import { hasTemporalAssertionV2 } from './temporalNormalizer';

export type StrictSocialKindV2 =
  | 'greeting'
  | 'courtesy'
  | 'compliment'
  | 'farewell'
  | 'smalltalk';

export type StrictSocialDetectionV2 =
  | { matched: false }
  | {
      matched: true;
      kind: StrictSocialKindV2;
      temporalEvidence: InboundSpanV2 | null;
    };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsCatalogEntity(
  value: string,
  servicesResult: ServicesResult
): boolean {
  const serviceNames = (servicesResult.services ?? []).map((entry) => entry.name);
  if (currentMessageMentionsCatalogService(value, serviceNames)) return true;
  const text = normalize(value);
  return (servicesResult.professionals ?? []).some((professional) => {
    const name = normalize(professional.name);
    return Boolean(
      name && new RegExp(`(?:^| )${escapeRegExp(name)}(?: |$)`, 'u').test(text)
    );
  });
}

const SOCIAL_FRAGMENTS: Array<{
  kind: StrictSocialKindV2;
  matcher: RegExp;
}> = [
  {
    kind: 'greeting',
    matcher:
      /^(?:oi+|ola+|opa|e ai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|como vai|como voce esta|como vc esta|como voce ta|como vc ta)(?: por ai)?\b\s*/u,
  },
  {
    kind: 'courtesy',
    matcher:
      /^(?:muito\s+)?(?:obrigad[oa]|agradeco|valeu|vlw)(?:\s+(?:mesmo|demais|viu|por tudo|pela ajuda|pelo atendimento|de coracao))?\b\s*/u,
  },
  {
    kind: 'compliment',
    matcher:
      /^(?:(?:voce|vc|voces|o atendimento|o servico|o trabalho)\s+(?:e|foi|ficou)\s+)?(?:adorei|amei|arrasou|arraso|parabens|perfeito|perfeita|otimo|otima|maravilhoso|maravilhosa|incrivel|excelente)(?:\s+(?:demais|viu|mesmo|o atendimento|o servico|o trabalho))?\b\s*/u,
  },
  {
    kind: 'farewell',
    matcher:
      /^(?:tchau|ate mais|ate logo|ate breve|ate|bom descanso|boa semana|bom fim de semana|beijo|beijos|falou|flw|nos vemos)\b\s*/u,
  },
  {
    kind: 'smalltalk',
    matcher:
      /^(?:kkk+|rs+|haha+|hehe+|que bom|que legal|tudo joia|tudo otimo|tudo tranquilo|por aqui tudo bem|por aqui tudo certo|so passei para dar um oi|so vim dar um oi)\b\s*/u,
  },
];

const SOCIAL_JOINER_RE = /^(?:e|tambem|pra voce|para voce|com voce)\b\s*/u;
const FAREWELL_TEMPORAL_RE =
  /^(?:na|no|nesta|neste)?\s*(?:hoje|amanha|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|domingo)(?:\s+(?:as|a|de|por volta das)?\s*(?:[01]?\d|2[0-3])(?::[0-5]\d|h[0-5]?\d?)?(?:\s*horas?)?)?\b\s*/u;

/**
 * Opt-in social D6: exige evidência positiva e consumo total. O catálogo é
 * checado antes do consumo, portanto `kkk drenagem` nunca vira rota social.
 */
export function detectStrictSocialRouteV2(input: {
  inboundId: string;
  inboundText: string;
  servicesResult: ServicesResult;
}): StrictSocialDetectionV2 {
  if (!input.inboundText.trim() || mentionsCatalogEntity(input.inboundText, input.servicesResult)) {
    return { matched: false };
  }
  if (isSocialOnlyReceptionistMessage(input.inboundText)) {
    return {
      matched: true,
      kind: 'greeting',
      temporalEvidence: null,
    };
  }
  const onlyEmoji =
    !normalize(input.inboundText) && /\p{Extended_Pictographic}/u.test(input.inboundText);
  if (onlyEmoji) {
    return { matched: true, kind: 'smalltalk', temporalEvidence: null };
  }

  let remaining = normalize(input.inboundText);
  let matchedKind: StrictSocialKindV2 | null = null;
  let consumedFarewell = false;
  for (let pass = 0; pass < 8 && remaining; pass += 1) {
    const before = remaining;
    remaining = remaining.replace(SOCIAL_JOINER_RE, '').trim();
    for (const fragment of SOCIAL_FRAGMENTS) {
      const next = remaining.replace(fragment.matcher, '').trim();
      if (next === remaining) continue;
      matchedKind ??= fragment.kind;
      consumedFarewell ||= fragment.kind === 'farewell';
      remaining = next;
      break;
    }
    if (consumedFarewell) {
      remaining = remaining.replace(FAREWELL_TEMPORAL_RE, '').trim();
    }
    if (remaining === before) break;
  }
  if (!matchedKind || remaining) return { matched: false };

  const temporalEvidence = hasTemporalAssertionV2(input.inboundText)
    ? {
        inboundId: input.inboundId,
        start: 0,
        end: Array.from(input.inboundText).length,
      }
    : null;
  return { matched: true, kind: matchedKind, temporalEvidence };
}

export interface SocialCompletionResultV2 {
  ok: boolean;
  candidate: string;
  providerCalls: 1;
  providerReportedModel?: string | null;
  systemFingerprint?: string | null;
  failureReason?:
    | 'SOCIAL_PROVIDER_ERROR'
    | 'SOCIAL_TOOL_CALLS'
    | 'SOCIAL_EMPTY_REPLY';
}

export function buildSocialCompositionMessagesV2(input: {
  inboundText: string;
  botName?: string;
  regenerationReasonCodes?: readonly BoundaryReasonCodeV2[];
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const correction = input.regenerationReasonCodes?.length
    ? ` Esta é uma regeneração única. Corrija: ${input.regenerationReasonCodes.join(', ')}.`
    : '';
  // Mesma regra do prompt v1: o nome da atendente é configurável por tenant.
  const botName = input.botName?.trim() || 'Ana';
  return [
    {
      role: 'system',
      content:
        `Você é ${botName}, recepcionista calorosa em uma conversa puramente social. ` +
        'Responda em pt-BR com 1 ou 2 frases curtas, humanas, e no máximo 1 emoji. ' +
        'Não fale de serviços, profissionais, agenda, preço, funcionamento, endereço, ' +
        'promoção, pagamento, duração, lotação, canais, saúde, preparo, pessoas da equipe ' +
        'ou retorno humano. Não chame ferramentas e não invente fatos. Responda só com a fala, sem JSON.' +
        correction,
    },
    { role: 'user', content: input.inboundText },
  ];
}

export async function composeSocialReplyV2(input: {
  config: TenantBotConfig;
  inboundText: string;
  regenerationReasonCodes?: readonly BoundaryReasonCodeV2[];
  /** Override exclusivo de harness/A-B; produção conserva disabled + 160. */
  thinkingMode?: DeepSeekThinkingMode;
  maxTokens?: number;
  completionFactory?: (
    input: ReceptionistCompletionInput
  ) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
}): Promise<SocialCompletionResultV2> {
  const completionInput: ReceptionistCompletionInput = {
    messages: buildSocialCompositionMessagesV2({
      inboundText: input.inboundText,
      botName: input.config.botName,
      regenerationReasonCodes: input.regenerationReasonCodes,
    }),
    tools: [],
    temperature:
      Number.isFinite(input.config.aiTemperature) && input.config.aiTemperature >= 0
        ? Math.min(1, input.config.aiTemperature)
        : 0.4,
    maxTokens:
      typeof input.maxTokens === 'number' && input.maxTokens > 0
        ? Math.min(4_096, Math.floor(input.maxTokens))
        : 160,
    thinkingMode: input.thinkingMode ?? 'disabled',
  };
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = input.completionFactory
      ? await input.completionFactory(completionInput)
      : await createReceptionistChatCompletion(
          resolveReceptionistAiRuntime(input.config),
          completionInput
        );
  } catch {
    return {
      ok: false,
      candidate: '',
      providerCalls: 1,
      failureReason: 'SOCIAL_PROVIDER_ERROR',
    };
  }
  const completionMetadata = {
    providerReportedModel: completion.model || null,
    systemFingerprint:
      typeof (completion as { system_fingerprint?: unknown }).system_fingerprint ===
        'string' &&
      (completion as { system_fingerprint: string }).system_fingerprint.trim()
        ? (completion as { system_fingerprint: string }).system_fingerprint.trim()
        : null,
  };
  const message = completion.choices?.[0]?.message;
  if (message?.tool_calls?.length) {
    return {
      ok: false,
      candidate: '',
      providerCalls: 1,
      ...completionMetadata,
      failureReason: 'SOCIAL_TOOL_CALLS',
    };
  }
  const candidate = typeof message?.content === 'string' ? message.content.trim() : '';
  return candidate
    ? { ok: true, candidate, providerCalls: 1, ...completionMetadata }
    : {
        ok: false,
        candidate: '',
        providerCalls: 1,
        ...completionMetadata,
        failureReason: 'SOCIAL_EMPTY_REPLY',
      };
}

export interface SocialBoundaryAttemptV2 {
  index: number;
  candidateHash: string;
  evaluation: BoundaryEvaluation;
}

export type ResolveSocialTurnResultV2 =
  | {
      status: 'preempted';
      preemption: DeliveryPreemptionV2;
      primaryProviderCalls: number;
      regenProviderCalls: number;
      providerReportedModels: string[];
      systemFingerprints: string[];
      boundaryAttempts: SocialBoundaryAttemptV2[];
    }
  | {
      status: 'accepted';
      result: ModelTurnResultV2;
      payload: string;
      recoveryKind: 'none' | 'regen' | 'direct_fallback';
      primaryProviderCalls: number;
      regenProviderCalls: number;
      providerReportedModels: string[];
      systemFingerprints: string[];
      boundaryAttempts: SocialBoundaryAttemptV2[];
    };

function normalizedComparable(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');
}

function safeFallbackCandidates(
  config: TenantBotConfig,
  inboundText: string
): string[] {
  const tenantGreeting = config.greetingMessage?.trim();
  return [
    ...(tenantGreeting ? [tenantGreeting] : []),
    buildSocialReceptionistReply(inboundText),
    'Oi! Que bom falar com você 😊',
    'Oi! Estou por aqui.',
  ];
}

/**
 * Recovery social por rota: uma completion primária, no máximo uma regen sem
 * tools e fallback determinístico. `greetingMessage`, quando seguro, é usado
 * exatamente como veio do tenant; nunca é reinterpretado nem prependado.
 */
export async function resolveSocialTurnV2(input: {
  config: TenantBotConfig;
  frame: TurnFrameV2;
  servicesResult: ServicesResult;
  inboundText: string;
  inboundTextsById: Readonly<Record<string, string>>;
  detection: Extract<StrictSocialDetectionV2, { matched: true }>;
  recentAssistantReplies: readonly string[];
  thinkingMode?: DeepSeekThinkingMode;
  compose?: typeof composeSocialReplyV2;
  afterPrimary?: () => Promise<DeliveryPreemptionV2 | null>;
  beforeRegenerate?: () => Promise<DeliveryPreemptionV2 | null>;
  afterRegenerate?: () => Promise<DeliveryPreemptionV2 | null>;
  /** Hook diagnóstico injetável pelo harness; produção não o configura. */
  onRejectedBoundaryCandidate?: (input: {
    stage: 'primary' | 'regen';
    candidate: string;
    reasonCodes: readonly BoundaryReasonCodeV2[];
  }) => void;
}): Promise<ResolveSocialTurnResultV2> {
  const compose = input.compose ?? composeSocialReplyV2;
  const attempts: SocialBoundaryAttemptV2[] = [];
  const providerReportedModels: string[] = [];
  const systemFingerprints: string[] = [];
  const recordFingerprint = (completion: SocialCompletionResultV2): void => {
    if (completion.providerReportedModel) {
      providerReportedModels.push(completion.providerReportedModel);
    }
    if (completion.systemFingerprint) {
      systemFingerprints.push(completion.systemFingerprint);
    }
  };
  const evaluate = (candidate: string): BoundaryEvaluation => {
    const evaluation = evaluateBoundaryV2({
      rawCandidate: candidate,
      servicesResult: input.servicesResult,
      sourceInboundText: input.inboundText,
      currentInboundIds: input.frame.currentInboundIds,
      inboundTextsById: input.inboundTextsById,
      flowState: input.frame.flowState,
      pendingTransitionCandidate: { kind: 'preserve' },
      replyPurpose: 'SOCIAL',
      socialTemporalEvidence: input.detection.temporalEvidence,
      recentAssistantReplies: input.recentAssistantReplies,
      route: 'social',
      pendingAnaOpen: input.frame.pending !== null,
    });
    attempts.push({
      index: attempts.length,
      candidateHash: opaqueReceiptHashV2(candidate),
      evaluation,
    });
    return evaluation;
  };
  const accepted = (evaluation: BoundaryEvaluation) =>
    evaluation.safe && evaluation.originalAccepted && evaluation.acceptedPayload.trim();

  const primary = await compose({
    config: input.config,
    inboundText: input.inboundText,
    thinkingMode: input.thinkingMode ?? 'disabled',
  });
  recordFingerprint(primary);
  const primaryEvaluation = evaluate(primary.candidate);
  const afterPrimary = await input.afterPrimary?.();
  if (afterPrimary) {
    return {
      status: 'preempted',
      preemption: afterPrimary,
      primaryProviderCalls: 1,
      regenProviderCalls: 0,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  if (accepted(primaryEvaluation)) {
    return {
      status: 'accepted',
      result: {
        schemaVersion: 2,
        reply: primaryEvaluation.acceptedPayload,
        replyPurpose: 'SOCIAL',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      payload: primaryEvaluation.acceptedPayload,
      recoveryKind: 'none',
      primaryProviderCalls: 1,
      regenProviderCalls: 0,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  input.onRejectedBoundaryCandidate?.({
    stage: 'primary',
    candidate: primary.candidate,
    reasonCodes: primaryEvaluation.reasonCodes,
  });

  const before = await input.beforeRegenerate?.();
  if (before) {
    return {
      status: 'preempted',
      preemption: before,
      primaryProviderCalls: 1,
      regenProviderCalls: 0,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  const regenerated = await compose({
    config: input.config,
    inboundText: input.inboundText,
    regenerationReasonCodes: primaryEvaluation.reasonCodes,
    thinkingMode: input.thinkingMode ?? 'disabled',
  });
  recordFingerprint(regenerated);
  const after = await input.afterRegenerate?.();
  if (after) {
    return {
      status: 'preempted',
      preemption: after,
      primaryProviderCalls: 1,
      regenProviderCalls: 1,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  const regeneratedEvaluation = evaluate(regenerated.candidate);
  if (accepted(regeneratedEvaluation)) {
    return {
      status: 'accepted',
      result: {
        schemaVersion: 2,
        reply: regeneratedEvaluation.acceptedPayload,
        replyPurpose: 'SOCIAL',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      payload: regeneratedEvaluation.acceptedPayload,
      recoveryKind: 'regen',
      primaryProviderCalls: 1,
      regenProviderCalls: 1,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  input.onRejectedBoundaryCandidate?.({
    stage: 'regen',
    candidate: regenerated.candidate,
    reasonCodes: regeneratedEvaluation.reasonCodes,
  });

  const recent = new Set(input.recentAssistantReplies.map(normalizedComparable));
  for (const fallback of safeFallbackCandidates(input.config, input.inboundText)) {
    if (recent.has(normalizedComparable(fallback))) continue;
    const fallbackEvaluation = evaluate(fallback);
    if (!accepted(fallbackEvaluation)) continue;
    return {
      status: 'accepted',
      result: {
        schemaVersion: 2,
        reply: fallbackEvaluation.acceptedPayload,
        replyPurpose: 'SOCIAL',
        pendingTransitionCandidate: { kind: 'preserve' },
        resolutionCandidate: null,
        unknownServiceEvidence: null,
      },
      payload: fallbackEvaluation.acceptedPayload,
      recoveryKind: 'direct_fallback',
      primaryProviderCalls: 1,
      regenProviderCalls: 1,
      providerReportedModels,
      systemFingerprints,
      boundaryAttempts: attempts,
    };
  }
  throw new Error('Fallback social v2 rejeitado pela própria boundary.');
}
