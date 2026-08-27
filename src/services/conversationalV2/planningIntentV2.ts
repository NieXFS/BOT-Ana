import type { ServicesResult } from '../calendarService';
import { resolveServiceFromCatalog } from './serviceResolver';
import { PENDING_FAST_PATH_MAX_AGE_MS } from './modelResultParser';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  PlanningInformationFamilyV2,
  PlanningIntentArbitrationV2,
  PlanningIntentClassificationV2,
  PlanningIntentReceiptV2,
  PlanningIntentSignalsV2,
  PlanningSubjectSourceV2,
  PlanningTransactionV2,
  TurnFrameV2,
} from './contracts';

/**
 * IA-27A1 — detector determinístico de intenção de planejamento.
 *
 * Esta camada observa facetas independentes em uma mensagem atual. Ela não
 * conhece o executor, não chama provider/tool e não produz uma decisão que o
 * planner possa consumir. O runtime a usa apenas para preencher o sub-recibo
 * redacted de shadow mode.
 */

export interface PlanningIntentDetectorInputV2 {
  inboundText: string;
  /** Relógio do turno; obrigatório para não transformar o shadow em wall-clock. */
  now: Date;
  pending?: PendingFrameSnapshotV2 | null;
  flowState?: Pick<
    FlowStateV2,
    'flowId' | 'fixedServiceId' | 'bookingDraft'
  > | null;
  /** Alias conveniente para fixtures; o runtime passa o catálogo real. */
  services?: ServicesResult | null;
  catalog?: ServicesResult | null;
  /** Permite testar o detector diretamente com o mesmo frame do runtime. */
  frame?: Pick<TurnFrameV2, 'pending' | 'flowState'>;
}

const INFORMATION_FAMILY_ORDER: readonly PlanningInformationFamilyV2[] = [
  'PRICE',
  'DURATION',
  'SERVICE_NAME',
  'SERVICE_EXISTENCE',
  'PROFESSIONAL_EXISTENCE',
  'ADDRESS',
  'PROCEDURE_INFO',
  'GENERIC_INFORMATION',
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(normalized: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(normalized));
}

function containsNormalizedTerm(normalized: string, term: string): boolean {
  const candidate = normalize(term);
  if (candidate.length < 2) return false;
  return ` ${normalized} `.includes(` ${candidate} `);
}

function catalogTerms(catalog: ServicesResult | null | undefined): string[] {
  return (catalog?.services ?? [])
    .flatMap((service) => [service.name, ...(service.aliases ?? [])])
    .map(normalize)
    .filter((term) => term.length >= 2);
}

const SERVICE_SUBJECT_RE =
  /\b(?:servico|servicos|procedimento|procedimentos|tratamento|tratamentos|sessao|sessoes|peeling|drenagem|unha|unhas|manutencao|massagem|depilacao|sobrancelha|corte|limpeza|botox)\b/u;

/**
 * Sinal lexical apenas. Isto deliberadamente não licencia um serviço: termos
 * guarda-chuva como "unha" podem cobrir várias entidades do catálogo.
 */
function hasCurrentServiceMention(
  normalized: string,
  catalog: ServicesResult | null | undefined
): boolean {
  return (
    SERVICE_SUBJECT_RE.test(normalized) ||
    catalogTerms(catalog).some((term) => containsNormalizedTerm(normalized, term))
  );
}

/**
 * Única licença para `subjectSource: current_inbound`: a menção atual precisa
 * resolver para uma entidade ativa e única no catálogo tenant-scoped. O
 * resultado `ambiguous`/`no_match` permanece sem sujeito para impedir que o
 * fixedServiceId anterior seja reutilizado depois de uma mudança de assunto.
 */
function hasResolvedCurrentServiceSubject(
  rawText: string,
  catalog: ServicesResult | null | undefined
): boolean {
  if (!catalog) return false;
  return resolveServiceFromCatalog({ text: rawText, catalog }).kind === 'resolved';
}

const PRICE_RE =
  /\b(?:valor|preco|precos|custa|custam|quanto custa|quanto fica|quanto e|quanto sai|qual valor|qual preco)\b/u;
const DURATION_RE =
  /\b(?:duracao|quanto tempo|demora|leva quanto|tempo de|tempo dura|dura quanto)\b/u;
const SERVICE_NAME_RE =
  /\b(?:como(?: que| se)? chama|qual o nome|nome do|nome da|que nome)\b/u;
const ADDRESS_RE =
  /\b(?:endereco|localizacao|onde fica|onde voces atendem|onde voce atende|atendem onde|como chegar|qual o local|qual local)\b/u;
const PROCEDURE_INFO_RE =
  /\b(?:como funciona|como e feito|como se faz|em que consiste|o que inclui|para que serve|quais cuidados|cuidados|indicacao|contraindicacao|resultado|efeito|beneficio|beneficios|passo a passo|do[ií])\b/u;
const SERVICE_EXISTENCE_RE = [
  /\b(?:voces|aqui|no espaco|na clinica|o espaco|a clinica)\s+(?:faz|fazem|oferece|oferecem|realiza|realizam|atende|atendem|tem|possui|disponibiliza|disponibilizam)\b/u,
  /\b(?:fazemos|oferecemos|realizamos|atendemos|trabalhamos com|temos|possuimos)\b/u,
  /\b(?:tem|existe|ha)\s+(?:(?:algum|alguma|o|um|uma)\s+)?(?:servico|procedimento|tratamento)\b/u,
] as const;
const PROFESSIONAL_EXISTENCE_RE = [
  /\b(?:tem|possui|existe|ha)\s+(?:(?:algum|alguma|um|uma|mais de um|mais de uma)\s+)?profissional(?:is)?\b/u,
  /\bprofissional(?:is)?\s+(?:que|para|disponivel|disponiveis)\b/u,
  /\b(?:quem|qual profissional|com quem)\s+(?:realiza|faz|atende|pode)\b/u,
  /\bprofissional(?:is)?\s+(?:realiza|faz|atende)\b/u,
] as const;
const GENERIC_INFORMATION_RE = [
  /\b(?:qual|quais|como|onde|quando|quem|por que|porque|o que)\b/u,
  /\b(?:me explica|pode me explicar|explique|queria saber|gostaria de saber|quero saber|tem informacao)\b/u,
] as const;

function detectInformationFamilies(
  rawText: string,
  normalized: string,
  catalog: ServicesResult | null | undefined
): PlanningInformationFamilyV2[] {
  const serviceSubject = hasCurrentServiceMention(normalized, catalog);
  const serviceExistence =
    hasAny(normalized, SERVICE_EXISTENCE_RE) && serviceSubject;
  const professionalExistence = hasAny(
    normalized,
    PROFESSIONAL_EXISTENCE_RE
  );
  const price = PRICE_RE.test(normalized);
  const duration = DURATION_RE.test(normalized);
  const serviceName = SERVICE_NAME_RE.test(normalized);
  const address = ADDRESS_RE.test(normalized);
  const procedureInfo =
    PROCEDURE_INFO_RE.test(normalized) ||
    (serviceSubject && /\bo que e\b/u.test(normalized));

  const families = new Set<PlanningInformationFamilyV2>();
  if (price) families.add('PRICE');
  if (duration) families.add('DURATION');
  if (serviceName) families.add('SERVICE_NAME');
  if (serviceExistence) families.add('SERVICE_EXISTENCE');
  if (professionalExistence) families.add('PROFESSIONAL_EXISTENCE');
  if (address) families.add('ADDRESS');
  if (procedureInfo) families.add('PROCEDURE_INFO');

  const hasSchedulingCue = hasBookingCue(normalized);
  const hasSpecificFamily = families.size > 0;
  const hasEnoughContent = normalized.split(' ').filter(Boolean).length >= 2;
  if (
    !hasSpecificFamily &&
    hasEnoughContent &&
    !hasSchedulingCue &&
    !isCompactAffirmative(rawText) &&
    hasAny(normalized, GENERIC_INFORMATION_RE)
  ) {
    families.add('GENERIC_INFORMATION');
  }

  return INFORMATION_FAMILY_ORDER.filter((family) => families.has(family));
}

const COMPACT_AFFIRMATIVES = new Set([
  'sim',
  'sim pode',
  'pode',
  'claro',
  'isso',
  'exato',
  'confirmo',
  'confirmado',
  'fechado',
  'ok',
  'okay',
  'ta bom',
  'tudo bem',
  'pode sim',
]);

function isCompactAffirmative(rawText: string): boolean {
  return COMPACT_AFFIRMATIVES.has(normalize(rawText));
}

function hasDateExpression(rawText: string, normalized: string): boolean {
  return (
    /\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|proxima semana|dia\s+\d{1,2})\b/u.test(
      normalized
    ) || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u.test(rawText)
  );
}

function hasTimeExpression(rawText: string, normalized: string): boolean {
  return (
    /\b(?:[01]?\d|2[0-3])\s*(?:h|horas?)(?:\s*[0-5]?\d)?\b/u.test(
      normalized
    ) || /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/u.test(rawText)
  );
}

function hasBookingCue(normalized: string): boolean {
  return (
    /\b(?:tem|tenho|ha|existe)\s+(?:vaga|horario|horarios|encaixe)\b/u.test(
      normalized
    ) ||
    /\b(?:vaga|encaixe|disponibilidade|horario disponivel|horarios disponiveis)\b/u.test(
      normalized
    ) ||
    /\b(?:agendar|agende|agendamento|marcar|marque|marcacao|reservar|reserve|reserva)\b/u.test(
      normalized
    ) ||
    /\b(?:consultar|conferir|verificar)\s+(?:horario|horarios|disponibilidade)\b/u.test(
      normalized
    ) ||
    /\b(?:horario|horarios)\b.*\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia)\b/u.test(
      normalized
    ) ||
    /\b(?:pode ser|pode ficar|fica para|fica pra|serve)\b/u.test(normalized) &&
      /\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia)\b/u.test(
        normalized
      )
  );
}

function hasCancellationCue(normalized: string): boolean {
  return /\b(?:cancelar|cancele|cancelamento|desmarcar|desmarque|desmarcacao)\b/u.test(
    normalized
  );
}

function hasRescheduleCue(normalized: string): boolean {
  return (
    /\b(?:remarcar|remarque|remarcacao|reagendar|reagende|reagendamento)\b/u.test(
      normalized
    ) ||
    /\b(?:mudar|trocar|alterar|passar)\s+(?:o\s+)?(?:horario|dia|data)\b/u.test(
      normalized
    )
  );
}

function hasConfirmationCue(normalized: string): boolean {
  return /\b(?:confirmar|confirma|confirmo|confirmado|fechado|combinado)\b/u.test(
    normalized
  ) || /\b(?:pode marcar|pode agendar)\b/u.test(normalized);
}

function isOptionMentioned(
  normalized: string,
  pending: PendingFrameSnapshotV2
): boolean {
  if (/\b(?:nao|menos|sem)\b/u.test(normalized)) return false;
  const professionalFirstNames = new Map<string, number>();
  if (pending.kind === 'PROFESSIONAL') {
    for (const option of pending.options) {
      const firstName = normalize(option.displayName).split(' ')[0];
      if (firstName && firstName.length >= 3) {
        professionalFirstNames.set(
          firstName,
          (professionalFirstNames.get(firstName) ?? 0) + 1
        );
      }
    }
  }
  return pending.options.some((option) => {
    const displayName = normalize(option.displayName);
    if (
      displayName.length >= 2 &&
      containsNormalizedTerm(normalized, displayName)
    ) {
      return true;
    }
    if (pending.kind !== 'PROFESSIONAL') return false;
    const firstName = displayName.split(' ')[0];
    return Boolean(
      firstName &&
        firstName.length >= 3 &&
        professionalFirstNames.get(firstName) === 1 &&
        containsNormalizedTerm(normalized, firstName)
    );
  });
}

const OPTION_ORDINAL_POSITIONS: Readonly<Record<string, number>> = {
  primeira: 1,
  primeiro: 1,
  segunda: 2,
  segundo: 2,
  terceira: 3,
  terceiro: 3,
  quarta: 4,
  quarto: 4,
  quinta: 5,
  quinto: 5,
};

/**
 * Parser fechado e allow-only para ordinais de opção. A palavra ordinal não
 * basta sozinha: exigir "opção" evita transformar dias da semana (por
 * exemplo, "segunda-feira") em seleção. A posição é conferida contra o
 * snapshot, não contra `options.length`, porque o snapshot é a autoridade.
 */
function optionOrdinalPosition(
  normalized: string,
  pending: PendingFrameSnapshotV2
): number | null {
  const match = normalized.match(
    /^(?:e )?(?:a |o )?(?:(primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|ultim[oa]) opcao|opcao (?:numero )?([1-9]\d*|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|ultim[oa]))(?: por favor)?$/u
  );
  const token = match?.[1] ?? match?.[2];
  if (!token) return null;

  const position = /^\d+$/u.test(token)
    ? Number(token)
    : token === 'ultima' || token === 'ultimo'
      ? pending.options.at(-1)?.position ?? null
      : OPTION_ORDINAL_POSITIONS[token] ?? null;
  if (!position) return null;
  return pending.options.some((option) => option.position === position)
    ? position
    : null;
}

function hasOrdinalSelection(
  normalized: string,
  pending: PendingFrameSnapshotV2
): boolean {
  return optionOrdinalPosition(normalized, pending) !== null;
}

function hasProfessionalNeutralSelection(normalized: string): boolean {
  if (
    /\b(?:horario|horarios|hora|horas|data|dia|turno)\b/u.test(normalized) &&
    !/\b(?:profissional|profissionais|pessoa|quem)\b/u.test(normalized)
  ) {
    return false;
  }
  return /\b(?:tanto faz|qualquer profissional|qualquer pessoa|sem preferencia|quem estiver disponivel)\b/u.test(
    normalized
  );
}

function hasPendingAnswerSignal(input: {
  rawText: string;
  normalized: string;
  pending: PendingFrameSnapshotV2 | null;
  flowState: PlanningIntentDetectorInputV2['flowState'];
  catalog: ServicesResult | null | undefined;
  now: Date;
}): boolean {
  const pending = input.pending;
  if (!pending) return false;
  const askedAt = Date.parse(pending.askedAt);
  const nowMs = input.now.getTime();
  if (
    (input.flowState && pending.flowId !== input.flowState.flowId) ||
    !Number.isFinite(askedAt) ||
    !Number.isFinite(nowMs) ||
    nowMs - askedAt > PENDING_FAST_PATH_MAX_AGE_MS
  ) {
    return false;
  }

  if (pending.kind === 'CONFIRMATION' || pending.kind === 'CANCEL_CONFIRMATION') {
    return (
      isCompactAffirmative(input.rawText) ||
      /\b(?:confirmo|confirmado|pode marcar|pode agendar|pode cancelar|fechado)\b/u.test(
        input.normalized
      )
    );
  }

  if (pending.kind === 'PROFESSIONAL' && hasProfessionalNeutralSelection(input.normalized)) {
    return true;
  }

  if (isOptionMentioned(input.normalized, pending)) return true;
  if (hasOrdinalSelection(input.normalized, pending)) return true;

  if (pending.kind === 'DATE') {
    return hasDateExpression(input.rawText, input.normalized);
  }
  if (pending.kind === 'TIME') {
    return hasTimeExpression(input.rawText, input.normalized);
  }
  if (pending.kind === 'SERVICE') {
    return hasResolvedCurrentServiceSubject(input.rawText, input.catalog);
  }
  return false;
}

function hasCompleteBookingDraft(
  flowState: PlanningIntentDetectorInputV2['flowState']
): boolean {
  const draft = flowState?.bookingDraft;
  if (!draft) return false;
  return [draft.serviceId, draft.date, draft.time, draft.slotEvidenceTurnId].every(
    (value) => typeof value === 'string' && value.trim().length > 0
  );
}

function hasExplicitReferentialConfirmation(normalized: string): boolean {
  return /\b(?:confirmar|confirma|confirmo|confirmado|confirmada)\b(?:\s+\w+){0,3}\s+(?:agendamento|marcacao|reserva|consulta|horario)\b/u.test(
    normalized
  );
}

function transactionSignal(input: {
  rawText: string;
  normalized: string;
  pending: PendingFrameSnapshotV2 | null;
  answersPending: boolean;
  flowState: PlanningIntentDetectorInputV2['flowState'];
}): PlanningTransactionV2 {
  if (hasRescheduleCue(input.normalized)) return 'RESCHEDULE';
  if (hasCancellationCue(input.normalized)) return 'CANCELLATION';

  const confirmation = hasConfirmationCue(input.normalized);
  const booking = hasBookingCue(input.normalized);
  const confirmableContext =
    (input.answersPending && input.pending?.kind === 'CONFIRMATION') ||
    hasCompleteBookingDraft(input.flowState);
  if (
    hasExplicitReferentialConfirmation(input.normalized) ||
    (confirmableContext &&
      (confirmation || isCompactAffirmative(input.rawText)))
  ) {
    return 'CONFIRMATION';
  }
  if (booking) return 'BOOKING';

  if (
    input.answersPending &&
    (input.pending?.kind === 'DATE' || input.pending?.kind === 'TIME') &&
    (hasDateExpression(input.rawText, input.normalized) ||
      hasTimeExpression(input.rawText, input.normalized))
  ) {
    return 'BOOKING';
  }
  return null;
}

function deriveArbitration(
  signals: PlanningIntentSignalsV2
): PlanningIntentArbitrationV2 {
  if (signals.informationFamilies.length > 0) return 'INFORMATION_FIRST';
  if (signals.answersPending) return 'PENDING_ANSWER';
  if (signals.transaction !== null) return 'TRANSACTION';
  return 'GENERAL';
}

function deriveSubjectSource(input: {
  rawText: string;
  normalized: string;
  flowState: PlanningIntentDetectorInputV2['flowState'];
  catalog: ServicesResult | null | undefined;
}): PlanningSubjectSourceV2 {
  const currentMention = hasCurrentServiceMention(
    input.normalized,
    input.catalog
  );
  if (!currentMention) {
    if (input.flowState?.fixedServiceId || input.flowState?.bookingDraft?.serviceId) {
      return 'fixed_service';
    }
    return 'none';
  }
  return hasResolvedCurrentServiceSubject(input.rawText, input.catalog)
    ? 'current_inbound'
    : 'none';
}

function resolvedInput(input: PlanningIntentDetectorInputV2): {
  pending: PendingFrameSnapshotV2 | null;
  flowState: PlanningIntentDetectorInputV2['flowState'];
  catalog: ServicesResult | null | undefined;
} {
  return {
    pending: input.pending ?? input.frame?.pending ?? null,
    flowState: input.flowState ?? input.frame?.flowState ?? null,
    catalog: input.services ?? input.catalog,
  };
}

export function classifyPlanningIntentV2(
  input: PlanningIntentDetectorInputV2
): PlanningIntentClassificationV2 {
  const rawText = input.inboundText;
  const normalized = normalize(rawText);
  const resolved = resolvedInput(input);
  const answersPending = hasPendingAnswerSignal({
    rawText,
    normalized,
    pending: resolved.pending,
    flowState: resolved.flowState,
    catalog: resolved.catalog,
    now: input.now,
  });
  const signals: PlanningIntentSignalsV2 = {
    answersPending,
    informationFamilies: detectInformationFamilies(
      rawText,
      normalized,
      resolved.catalog
    ),
    transaction: transactionSignal({
      rawText,
      normalized,
      pending: resolved.pending,
      answersPending,
      flowState: resolved.flowState,
    }),
  };
  return {
    signals,
    arbitration: deriveArbitration(signals),
    subjectSource: deriveSubjectSource({
      rawText,
      normalized,
      flowState: resolved.flowState,
      catalog: resolved.catalog,
    }),
  };
}

/** Nome de detector explícito para os callers que preferem semântica de observação. */
export function detectPlanningIntentV2(
  input: PlanningIntentDetectorInputV2
): PlanningIntentClassificationV2 {
  return classifyPlanningIntentV2(input);
}

function receiptArbitration(
  arbitration: PlanningIntentArbitrationV2
): PlanningIntentReceiptV2['arbitrationCandidate'] {
  switch (arbitration) {
    case 'INFORMATION_FIRST':
      return 'information_first';
    case 'PENDING_ANSWER':
      return 'pending_answer';
    case 'TRANSACTION':
      return 'transaction';
    case 'GENERAL':
      return 'general';
  }
}

/** Converte o resultado puro para o sub-recibo fechado de IA-27A1. */
export function buildPlanningIntentReceiptV2(
  input: PlanningIntentDetectorInputV2
): PlanningIntentReceiptV2 {
  const classification = classifyPlanningIntentV2(input);
  return {
    version: 1,
    mode: 'shadow',
    hasPendingAnswerSignal: classification.signals.answersPending,
    informationFamilies: [...classification.signals.informationFamilies],
    transactionSignal: classification.signals.transaction,
    arbitrationCandidate: receiptArbitration(classification.arbitration),
    subjectSource: classification.subjectSource,
  };
}

export const planningIntentReceiptV2 = buildPlanningIntentReceiptV2;
