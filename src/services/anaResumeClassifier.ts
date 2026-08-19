import { createHash } from 'crypto';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../configProvider';
import { scrubText } from '../observability/scrub';
import {
  HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE,
  type TimestampedMessage,
} from './contextManager';
import {
  humanEchoBody,
  projectAssistantContentForLlm,
} from './humanConversationContext';
import {
  createAnaResumeClassifierCompletion,
  DEEPSEEK_V4_FLASH_MODEL,
  resolveAnaResumeClassifierRuntime,
} from './receptionistLlmProvider';

export const ANA_RESUME_DECISIONS = [
  'RESUME_ANA',
  'KEEP_HUMAN',
  'UNCERTAIN',
] as const;

export type AnaResumeDecision = (typeof ANA_RESUME_DECISIONS)[number];

export const ANA_RESUME_REASON_CODES = [
  'NEW_INDEPENDENT_REQUEST',
  'DIRECT_ANA_REQUEST',
  'HUMAN_CONVERSATION_CONTINUES',
  'HUMAN_HANDLED_REQUEST',
  'PERSONAL_OR_SOCIAL',
  'AMBIGUOUS_CONTEXT',
  'TRANSCRIPTION_UNAVAILABLE',
  'PROVIDER_FAILURE',
  'INVALID_MODEL_OUTPUT',
] as const;

export type AnaResumeReasonCode = (typeof ANA_RESUME_REASON_CODES)[number];

export const ANA_RESUME_DETERMINISTIC_MODEL = 'deterministic' as const;

export type AnaResumeTelemetryModel =
  | typeof ANA_RESUME_DETERMINISTIC_MODEL
  | typeof DEEPSEEK_V4_FLASH_MODEL;

export interface AnaResumeClassification {
  decision: AnaResumeDecision;
  reasonCode: AnaResumeReasonCode;
  model: AnaResumeTelemetryModel;
  latencyMs: number;
  contextHash: string;
  /** JSON curto devolvido pelo classificador; nunca inclui reasoning_content. */
  rawOutput?: string;
}

export interface AnaResumeTimelineEvent {
  speaker: 'CUSTOMER' | 'HUMAN' | 'ANA';
  gap: 'FIRST' | 'SAME_MINUTE' | 'MINUTES' | 'HOURS' | 'NEXT_DAY_OR_LATER';
  text: string;
}

const SYSTEM_PROMPT = `Você é um classificador de segurança do atendimento da Ana.

Tarefa única: decidir se a Ana pode responder ao ÚLTIMO evento CUSTOMER depois que uma pessoa da equipe assumiu a conversa.

Prioridade máxima: nunca fazer a Ana falar por cima de uma conversa humana.

Escolha RESUME_ANA somente quando o último pedido for claramente novo e independente, ou quando a cliente pedir explicitamente que a Ana continue. Escolha KEEP_HUMAN quando a pessoa da equipe ainda estiver conduzindo, já tiver combinado/agendado algo, a cliente estiver confirmando ou complementando esse combinado, ou a conversa for pessoal/social. Qualquer dúvida, dependência de áudio sem transcrição ou contexto misto deve ser UNCERTAIN.

Você não conversa com a cliente, não escreve resposta de WhatsApp, não usa ferramentas e não decide serviço, horário ou agendamento.

Responda SOMENTE um objeto JSON com duas chaves:
{"decision":"RESUME_ANA|KEEP_HUMAN|UNCERTAIN","reasonCode":"..."}

Pares permitidos:
- RESUME_ANA: NEW_INDEPENDENT_REQUEST, DIRECT_ANA_REQUEST
- KEEP_HUMAN: HUMAN_CONVERSATION_CONTINUES, HUMAN_HANDLED_REQUEST, PERSONAL_OR_SOCIAL
- UNCERTAIN: AMBIGUOUS_CONTEXT`;

const allowedReasons: Record<AnaResumeDecision, ReadonlySet<AnaResumeReasonCode>> = {
  RESUME_ANA: new Set(['NEW_INDEPENDENT_REQUEST', 'DIRECT_ANA_REQUEST']),
  KEEP_HUMAN: new Set([
    'HUMAN_CONVERSATION_CONTINUES',
    'HUMAN_HANDLED_REQUEST',
    'PERSONAL_OR_SOCIAL',
  ]),
  UNCERTAIN: new Set(['AMBIGUOUS_CONTEXT']),
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownValues(text: string, values: readonly (string | null | undefined)[]) {
  let result = scrubText(text);
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < 2) continue;
    result = result.replace(new RegExp(escapeRegex(trimmed), 'giu'), '[NOME]');
  }
  return result;
}

function gapBucket(previous: string | null, current: string): AnaResumeTimelineEvent['gap'] {
  if (!previous) return 'FIRST';
  const gapMs = Date.parse(current) - Date.parse(previous);
  if (!Number.isFinite(gapMs) || gapMs < 0) return 'MINUTES';
  if (gapMs < 60_000) return 'SAME_MINUTE';
  if (gapMs < 60 * 60_000) return 'MINUTES';
  if (gapMs < 24 * 60 * 60_000) return 'HOURS';
  return 'NEXT_DAY_OR_LATER';
}

export function buildAnaResumeTimeline(input: {
  history: readonly TimestampedMessage[];
  config: TenantBotConfig;
  customerName?: string | null;
}): AnaResumeTimelineEvent[] {
  const all = input.history.map((message, index, messages) => {
    const humanBody = humanEchoBody(message.content);
    const human = message.role === 'assistant' && humanBody !== null;
    const rawText = human
      ? humanBody
      : message.role === 'assistant'
        ? projectAssistantContentForLlm(message.content)
        : message.content;
    return {
      speaker: (message.role === 'user'
        ? 'CUSTOMER'
        : human
          ? 'HUMAN'
          : 'ANA') as AnaResumeTimelineEvent['speaker'],
      gap: gapBucket(messages[index - 1]?.createdAt ?? null, message.createdAt),
      text: redactKnownValues(rawText, [
        input.customerName,
        input.config.tenantSlug,
      ]).slice(0, 1_200),
    };
  });

  let lastHuman = -1;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all[index]?.speaker === 'HUMAN') {
      lastHuman = index;
      break;
    }
  }
  if (lastHuman === -1) return all.slice(-12);
  return all.slice(Math.max(0, lastHuman - 4), lastHuman + 18).slice(-18);
}

export function hashAnaResumeTimeline(timeline: readonly AnaResumeTimelineEvent[]): string {
  return createHash('sha256').update(JSON.stringify(timeline)).digest('hex');
}

function normalizeIntentText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ANA_RESUME_REQUEST_PATTERNS = [
  /\bana\s+(?:pode|poderia|consegue)\s+(?:continuar|assumir|voltar|retomar)\b/,
  /\b(?:pode|poderia|consegue)\s+(?:continuar|assumir|voltar|retomar)\s+(?:com\s+)?(?:a\s+)?ana\b/,
  /\bquero\s+(?:falar|ser atendid[oa])\s+(?:com|pela)\s+(?:a\s+)?ana\b/,
  /\b(?:deixa|deixe|passa|passe)\s+(?:a\s+)?ana\s+(?:continuar|assumir|atender|voltar|retomar)\b/,
  /\bana\s+(?:volta|volte|continue|continua|assume|retoma)\b/,
] as const;

/**
 * Pedido direto da cliente para a Ana retomar. Fonte única para o begin
 * (`explicitAnaResumeRequest`) e para o ramo determinístico do classificador.
 */
export function isExplicitAnaResumeRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (/\bana\s+(?:nao|nunca)\b/.test(normalized)) return false;
  if (/\b(?:nao|nunca)\s+(?:quero|preciso)\s+.{0,40}\bana\b/.test(normalized)) {
    return false;
  }
  if (/\bsera que\b/.test(normalized)) return false;
  if (
    /\b(?:quem|o que|oque|qual|quando|onde|porque|por que)\b/.test(normalized)
  ) {
    return false;
  }
  if (
    /\ba ana\s+(?:esta|ta|fica|ficou)\s+(?:pausad|ocupad|offline|desligad)/.test(
      normalized
    )
  ) {
    return false;
  }
  return ANA_RESUME_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isHumanReleaseOfAna(text: string): boolean {
  const human = normalizeIntentText(text);
  return (
    !/\bana\s+(?:nao|nunca)\b/.test(human) &&
    (/\bana\s+(?:pode|vai)\s+(?:continuar|assumir|atender)\b/.test(human) ||
      /\b(?:deixo|passo)\s+(?:com|para)\s+(?:a\s+)?ana\b/.test(human))
  );
}

function hasOperationalCustomerRequest(text: string): boolean {
  return /\b(?:agend|marc|horari|servic|dispon|cancel|remarc|preco|valor|dia|semana)\w*/.test(
    normalizeIntentText(text)
  );
}

export function hasExplicitAnaResumeAuthorization(
  timeline: readonly AnaResumeTimelineEvent[]
): boolean {
  const last = timeline[timeline.length - 1];
  if (!last || last.speaker !== 'CUSTOMER') return false;
  if (isExplicitAnaResumeRequest(last.text)) return true;

  let lastHumanIndex = -1;
  for (let index = timeline.length - 2; index >= 0; index -= 1) {
    if (timeline[index]?.speaker === 'HUMAN') {
      lastHumanIndex = index;
      break;
    }
  }
  if (lastHumanIndex === -1) return false;
  return (
    isHumanReleaseOfAna(timeline[lastHumanIndex]!.text) &&
    hasOperationalCustomerRequest(last.text)
  );
}

export function parseAnaResumeClassifierOutput(raw: string): {
  decision: AnaResumeDecision;
  reasonCode: AnaResumeReasonCode;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.keys(parsed).sort().join(',') !== 'decision,reasonCode') return null;
    if (
      typeof parsed.decision !== 'string' ||
      !ANA_RESUME_DECISIONS.includes(parsed.decision as AnaResumeDecision) ||
      typeof parsed.reasonCode !== 'string' ||
      !ANA_RESUME_REASON_CODES.includes(parsed.reasonCode as AnaResumeReasonCode)
    ) {
      return null;
    }
    const decision = parsed.decision as AnaResumeDecision;
    const reasonCode = parsed.reasonCode as AnaResumeReasonCode;
    if (!allowedReasons[decision].has(reasonCode)) return null;
    return { decision, reasonCode };
  } catch {
    return null;
  }
}

export interface AnaResumeClassifierDeps {
  now: () => number;
  complete: (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => Promise<string>;
}

const defaultDeps: AnaResumeClassifierDeps = {
  now: Date.now,
  complete: async (messages) => {
    const completion = await createAnaResumeClassifierCompletion(
      resolveAnaResumeClassifierRuntime(),
      { messages }
    );
    return completion.choices[0]?.message?.content ?? '';
  },
};

export async function classifyAnaResume(input: {
  history: readonly TimestampedMessage[];
  config: TenantBotConfig;
  customerName?: string | null;
}, deps: AnaResumeClassifierDeps = defaultDeps): Promise<AnaResumeClassification> {
  const timeline = buildAnaResumeTimeline(input);
  const contextHash = hashAnaResumeTimeline(timeline);
  const last = timeline[timeline.length - 1];
  const deterministic = (
    decision: AnaResumeDecision,
    reasonCode: AnaResumeReasonCode,
    rawOutput?: string
  ): AnaResumeClassification => ({
    decision,
    reasonCode,
    model: ANA_RESUME_DETERMINISTIC_MODEL,
    latencyMs: 0,
    contextHash,
    ...(rawOutput === undefined ? {} : { rawOutput }),
  });

  if (last?.speaker === 'CUSTOMER' && isExplicitAnaResumeRequest(last.text)) {
    return deterministic('RESUME_ANA', 'DIRECT_ANA_REQUEST');
  }
  if (!timeline.some((event) => event.speaker === 'HUMAN')) {
    return deterministic('UNCERTAIN', 'AMBIGUOUS_CONTEXT');
  }
  if (
    timeline.some((event) =>
      event.text.includes(HUMAN_AUDIO_TRANSCRIPTION_UNAVAILABLE)
    )
  ) {
    return deterministic('UNCERTAIN', 'TRANSCRIPTION_UNAVAILABLE');
  }
  if (hasExplicitAnaResumeAuthorization(timeline)) {
    return deterministic('RESUME_ANA', 'DIRECT_ANA_REQUEST');
  }

  const startedAt = deps.now();
  let raw: string;
  try {
    raw = await deps.complete([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({ timeline, classifyLastCustomerEvent: true }),
      },
    ]);
  } catch {
    return deterministic('UNCERTAIN', 'PROVIDER_FAILURE');
  }
  const parsed = parseAnaResumeClassifierOutput(raw);
  if (!parsed) return deterministic('UNCERTAIN', 'INVALID_MODEL_OUTPUT', raw);

  return {
    ...parsed,
    model: DEEPSEEK_V4_FLASH_MODEL,
    latencyMs: Math.max(0, deps.now() - startedAt),
    contextHash,
    rawOutput: raw,
  };
}
