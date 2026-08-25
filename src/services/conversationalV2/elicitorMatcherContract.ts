import type { UpcomingAppointment } from '../calendarService';
import { buildServiceQuestion } from '../service-gate';
import { resolveReceptionistTurnDecision } from '../receptionistTurnDecision';
import {
  bookingConfirmationGate,
  CONFIRMATION_HINT,
  isExplicitBookingConfirmation,
} from '../bookingConfirmationGate';
import {
  buildCancelConfirmationCopyV2,
  cancelConfirmationGateV2,
} from './cancellationFlowV2';
import type {
  DeferredAvailabilityConstraintV2,
  FlowStateV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from './contracts';
import { resolveCurrentInboundDateV2 } from './currentDateResolution';
import {
  buildBareHourDisambiguationV2,
  resolvePendingOptionProofV2,
} from './fastPaths';
import {
  buildCanonicalBookingSummaryV2,
  buildSlotOfferCopyV2,
} from './lifecycleReducer';
import { NATURAL_AFFIRMATIVE_REPLIES_V2 } from './naturalAffirmative';
import {
  DATE_PENDING_QUESTION_V2,
  DUPLICATE_RESOLUTION_CHOICE_QUESTION_V2,
  DUPLICATE_RESOLUTION_OPTIONS_V2,
  buildPendingQuestionV2,
} from './pendingQuestion';
import { buildDuplicateResolutionQuestionV2 } from './bookingProgressFastPaths';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';
import {
  buildDeferredAvailabilityExhaustedCopyV2,
  findSelectedDeferredWindowV2,
} from './serviceContext';

export interface ElicitorMatcherContractRowV2 {
  readonly nome: string;
  readonly elicitor: string;
  readonly respostasNaturais: readonly string[];
  readonly negacoes: readonly string[];
  readonly interrogativas: readonly string[];
  readonly matcher: (reply: string) => boolean;
  /** Default true. False = a família natural NÃO autoriza (recibo ausente). */
  readonly respostasNaturaisAutorizam?: boolean;
}

const CONTRACT_NOW = new Date('2026-08-16T18:00:00.000Z');
const CONTRACT_TZ = 'America/Sao_Paulo';
const ASKED_AT = '2026-08-16T17:55:00.000Z';
const TERMINAL_AT = '2026-08-16T17:55:01.000Z';

const DUPLICATE_COURTESY_PREFIXES_V2 = [
  '',
  'pode ser ',
  'prefiro ',
  'vou querer ',
  'acho que ',
] as const;

const PODE_LEXICON_REPLIES_V2 = ['sim', 'confirmo', 'pode marcar'] as const;

function catalog() {
  return {
    success: true,
    services: [{
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: null,
      priceFormatted: null,
    }],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  };
}

function bookingDraft() {
  return {
    serviceId: 'svc-drenagem',
    professionalId: 'prof-carla',
    date: '2026-08-17',
    time: '15:00',
    slotEvidenceTurnId: 'turn-slots-contract',
  };
}

function confirmationFlowState(): FlowStateV2 {
  const draft = bookingDraft();
  return {
    flowId: 'flow-elicitor-contract',
    fixedServiceId: draft.serviceId,
    fixedProfessionalId: draft.professionalId,
    resolvedDate: draft.date,
    bookingDraft: draft,
    slotEvidence: {
      turnId: draft.slotEvidenceTurnId,
      serviceId: draft.serviceId,
      professionalId: draft.professionalId,
      date: draft.date,
      slots: [draft.time],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  };
}

function pendingFrame(
  kind: PendingFrameSnapshotV2['kind'],
  options: PendingFrameSnapshotV2['options'],
  flowId = 'flow-elicitor-contract'
): PendingFrameSnapshotV2 {
  return {
    questionId: `question-${kind.toLowerCase()}`,
    askedAt: ASKED_AT,
    kind,
    flowId,
    version: 1,
    options,
  };
}

function turnFrame(
  pending: PendingFrameSnapshotV2,
  flowState: FlowStateV2
): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: 'turn-elicitor-contract',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: ['in-contract'],
    pending,
    flowState,
  };
}

function acceptedDelivery(
  pending: PendingFrameSnapshotV2,
  flowState: FlowStateV2,
  payload: string
): AcceptedDeliveryEvidenceV2 {
  return {
    payload,
    terminalAt: TERMINAL_AT,
    conversationCommitOutcome: 'committed',
    pendingCommitOutcome: 'opened',
    copyVariant: 'canonical',
    transition: {
      kind: 'open',
      frame: pending,
      expectedQuestionId: null,
      expectedVersion: null,
      nextFlowState: flowState,
    },
  };
}

function canonicalBookingSummary(): string {
  return buildCanonicalBookingSummaryV2({
    draft: bookingDraft(),
    services: catalog(),
  });
}

function bookingConfirmationMatcher(
  reply: string,
  lastAcceptedDelivery: AcceptedDeliveryEvidenceV2 | null
): boolean {
  const pending = pendingFrame('CONFIRMATION', [
    {
      position: 1,
      entityId: 'booking-confirmation:flow-elicitor-contract',
      displayName: 'opção apresentada',
    },
  ]);
  const flowState = confirmationFlowState();
  const summary = canonicalBookingSummary();
  return bookingConfirmationGate({
    currentUserMessage: reply,
    history: [{ role: 'assistant', content: summary }],
    confirmedDuplicate: false,
    expectedBooking: {
      date: '2026-08-17',
      time: '15:00',
      serviceName: 'Drenagem Linfática',
      professionalName: 'Carla Mendes',
    },
    v2ConfirmationContext: {
      pending,
      flowState,
      catalog: catalog(),
      lastAcceptedDelivery,
      now: CONTRACT_NOW,
    },
  }).ok;
}

function compatibleBookingDelivery(): AcceptedDeliveryEvidenceV2 {
  const pending = pendingFrame('CONFIRMATION', [
    {
      position: 1,
      entityId: 'booking-confirmation:flow-elicitor-contract',
      displayName: 'opção apresentada',
    },
  ]);
  return acceptedDelivery(pending, confirmationFlowState(), canonicalBookingSummary());
}

function cancelConfirmationMatcher(reply: string): boolean {
  const token = 'cancel-target:elicitor-contract' as const;
  const displayName =
    'Drenagem Linfática em 17/08/2026 às 10:00 com Carla Mendes';
  const copy = buildCancelConfirmationCopyV2(displayName);
  const pending = pendingFrame('CANCEL_CONFIRMATION', [
    { position: 1, entityId: token, displayName },
  ]);
  const flowState: FlowStateV2 = {
    flowId: pending.flowId,
    fixedByProofVersion: {},
    cancellation: {
      flowId: pending.flowId,
      sourceReadTurnId: 'turn-read-cancel',
      selectedToken: token,
      candidates: [
        {
          token,
          appointmentId: 'appt-elicitor-contract',
          startTime: '2026-08-17T13:00:00.000Z',
          fingerprint: 'fp-elicitor-contract',
          disposition: 'AUTO_CANCEL_ALLOWED',
          displayName,
        },
      ],
    },
  };
  return cancelConfirmationGateV2({
    currentInboundBatchText: reply,
    pending,
    flowState,
    lastAcceptedDelivery: acceptedDelivery(pending, flowState, copy),
    now: CONTRACT_NOW,
  }).ok;
}

function duplicateOptionMatcher(reply: string): boolean {
  const options = DUPLICATE_RESOLUTION_OPTIONS_V2.map((option, index) => ({
    position: index + 1,
    entityId: option.entityId,
    displayName: option.displayName,
  }));
  const pending = pendingFrame('CONFIRMATION', options);
  const proof = resolvePendingOptionProofV2({
    frame: turnFrame(pending, confirmationFlowState()),
    inboundId: 'in-contract',
    inboundText: reply,
    now: CONTRACT_NOW,
  });
  return proof?.kind === 'pending_option';
}

function halfHourClarifierMatcher(reply: string): boolean {
  const options = [
    { position: 1, entityId: '17:00', displayName: '17h' },
    { position: 2, entityId: '17:30', displayName: '17h30' },
  ];
  const pending = pendingFrame('TIME', options);
  const flowState: FlowStateV2 = {
    flowId: pending.flowId,
    lastOperationalAt: CONTRACT_NOW.toISOString(),
    fixedServiceId: 'svc-drenagem',
    resolvedDate: '2026-08-17',
    slotEvidence: {
      turnId: 'turn-slots-contract',
      serviceId: 'svc-drenagem',
      date: '2026-08-17',
      slots: ['17:00', '17:30'],
    },
    fixedByProofVersion: { fixedServiceId: 1, resolvedDate: 1 },
  };
  const proof = resolvePendingOptionProofV2({
    frame: turnFrame(pending, flowState),
    inboundId: 'in-contract',
    inboundText: reply,
    now: CONTRACT_NOW,
    lastAcceptedAssistantText: buildBareHourDisambiguationV2(options),
  });
  return proof?.kind === 'pending_option';
}

function timeOfferOptionsFromCopy(
  elicitor: string
): readonly PendingFrameSnapshotV2['options'][number][] {
  const match = /:\s*([^.!?]+)\.\s*Qual você prefere\?$/u.exec(elicitor);
  if (!match?.[1]) return [];
  const slots = [
    ...new Set(
      normalizeTemporalAssertionsV2(match[1])
        .filter((assertion) => assertion.kind === 'time')
        .map((assertion) => assertion.normalized)
    ),
  ];
  return slots.map((slot, index) => ({
    position: index + 1,
    entityId: slot,
    displayName: slot,
  }));
}

/** Derives the natural replies from the live copy's witnessed slot(s). */
function timeOfferRepliesFromCopy(elicitor: string): readonly string[] {
  const options = timeOfferOptionsFromCopy(elicitor);
  return options.flatMap((option) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(option.entityId);
    if (!match) return [];
    const hour = String(Number(match[1]));
    const display = Number(match[2]) === 0
      ? `${Number(match[1])}h`
      : `${Number(match[1])}h${match[2]}`;
    return [display, option.entityId, `Pode ser ${display}`];
  });
}

function singleTimeOfferRepliesFromCopy(elicitor: string): readonly string[] {
  if (timeOfferOptionsFromCopy(elicitor).length !== 1) return [];
  const options = timeOfferOptionsFromCopy(elicitor);
  const slot = options[0]!.entityId;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(slot);
  if (!match) return [];
  const hour = String(Number(match[1]));
  const display = Number(match[2]) === 0
    ? `${Number(match[1])}h`
    : `${Number(match[1])}h${match[2]}`;
  return [
    ...timeOfferRepliesFromCopy(elicitor),
    `pode ser as ${hour}`,
    `quero ${display}`,
    `o de ${display}`,
    'esse',
    'pode ser',
  ];
}

function timeOfferMatcher(reply: string, elicitor: string): boolean {
  const options = timeOfferOptionsFromCopy(elicitor);
  if (options.length === 0) return false;
  const pending = pendingFrame('TIME', options);
  const flowState: FlowStateV2 = {
    flowId: pending.flowId,
    fixedServiceId: 'svc-drenagem',
    resolvedDate: '2026-08-17',
    slotEvidence: {
      turnId: 'turn-slots-contract',
      serviceId: 'svc-drenagem',
      date: '2026-08-17',
      slots: options.map((option) => option.entityId),
    },
    fixedByProofVersion: { fixedServiceId: 1, resolvedDate: 1 },
  };
  const proof = resolvePendingOptionProofV2({
    frame: turnFrame(pending, flowState),
    inboundId: 'in-contract-time',
    inboundText: reply,
    now: CONTRACT_NOW,
    lastAcceptedAssistantText: elicitor,
  });
  return proof?.kind === 'pending_option';
}

function selectionRepliesFromCopy(elicitor: string): readonly string[] {
  const optionName = elicitor
    .replace(/^Qual (?:serviço|profissional) você prefere:\s*/u, '')
    .replace(/\?$/u, '')
    .trim();
  if (!optionName) return [];
  return [
    optionName,
    `Pode ser ${optionName}`,
    `Quero ${optionName}`,
    'esse',
    'pode ser',
  ];
}

function singleSelectionMatcher(
  reply: string,
  kind: 'SERVICE' | 'PROFESSIONAL',
  option: { entityId: string; displayName: string }
): boolean {
  const pending = pendingFrame(kind, [
    { position: 1, entityId: option.entityId, displayName: option.displayName },
  ]);
  const flowState: FlowStateV2 = {
    flowId: pending.flowId,
    fixedServiceId: kind === 'PROFESSIONAL' ? 'svc-drenagem' : undefined,
    fixedByProofVersion: {},
  };
  const proof = resolvePendingOptionProofV2({
    frame: turnFrame(pending, flowState),
    inboundId: `in-contract-${kind.toLowerCase()}`,
    inboundText: reply,
    now: CONTRACT_NOW,
    catalog: catalog(),
  });
  return proof?.kind === 'pending_option';
}

const LEGACY_SERVICE_OPTIONS = [
  { id: 'svc-drenagem', name: 'Drenagem Linfática' },
  { id: 'svc-peeling', name: 'Peeling facial' },
] as const;

function legacyServiceQuestionMatcher(reply: string, elicitor: string): boolean {
  const decision = resolveReceptionistTurnDecision({
    inbound: reply,
    history: [
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: elicitor },
      { role: 'user', content: reply },
    ],
    catalog: {
      success: true,
      services: LEGACY_SERVICE_OPTIONS.map((service) => ({
        ...service,
        durationMinutes: 60,
        price: null,
        priceFormatted: null,
      })),
      professionals: [],
    },
  });
  return decision.action === 'follow_up_datetime';
}

function legacyServiceRepliesFromCopy(elicitor: string): readonly string[] {
  const names = LEGACY_SERVICE_OPTIONS.filter((service) =>
    elicitor.toLocaleLowerCase().includes(service.name.toLocaleLowerCase())
  ).map((service) => service.name);
  return [
    ...names,
    `${names[0]}?`,
    `Não, quero ${names[1]}`,
    `Não é ${names[0]}, mas pode ser ${names[1]}`,
  ];
}

function dateQuestionMatcher(reply: string): boolean {
  return (
    resolveCurrentInboundDateV2({
      currentInboundIds: ['in-contract'],
      inboundTextsById: { 'in-contract': reply },
      now: CONTRACT_NOW,
      timezone: CONTRACT_TZ,
    }).kind === 'resolved'
  );
}

function deferredWindowSelectionMatcher(
  reply: string,
  constraint: DeferredAvailabilityConstraintV2
): boolean {
  const dateResolution = resolveCurrentInboundDateV2({
    currentInboundIds: ['in-deferred-window'],
    inboundTextsById: { 'in-deferred-window': reply },
    now: CONTRACT_NOW,
    timezone: CONTRACT_TZ,
  });
  return Boolean(
    findSelectedDeferredWindowV2({
      constraint,
      inboundText: reply,
      dateResolution,
      now: CONTRACT_NOW,
      timezone: CONTRACT_TZ,
      turnId: 'turn-deferred-window-contract',
      inputSequence: 1,
    })
  );
}

function duplicateNaturalAnswers(): string[] {
  return DUPLICATE_RESOLUTION_OPTIONS_V2.flatMap((option) =>
    DUPLICATE_COURTESY_PREFIXES_V2.map(
      (prefix) => `${prefix}${option.displayName}`
    )
  );
}

function duplicateElicitor(): string {
  const appointment: UpcomingAppointment = {
    id: 'appt-duplicate-contract',
    startTime: '2026-08-17T13:00:00.000Z',
    endTime: '2026-08-17T14:00:00.000Z',
    serviceName: 'Drenagem Linfática',
    professionalName: 'Carla Mendes',
    status: 'CONFIRMED',
  };
  return buildDuplicateResolutionQuestionV2(appointment, CONTRACT_TZ);
}

export function extractQuotedElicitorAnswers(elicitor: string): string[] {
  return [...elicitor.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}

/**
 * Tabela declarativa elicitor↔matcher. Quem muda a pergunta atualiza as
 * respostas neste módulo, ao lado das copies importadas.
 */
export function elicitorMatcherContractRowsV2(): readonly ElicitorMatcherContractRowV2[] {
  const confirmationReplies = [
    ...NATURAL_AFFIRMATIVE_REPLIES_V2,
    ...PODE_LEXICON_REPLIES_V2,
  ];
  const timeOfferElicitor = buildSlotOfferCopyV2({
    date: '2026-08-17',
    slots: ['18:00'],
  });
  const timeOfferReplies = singleTimeOfferRepliesFromCopy(timeOfferElicitor);
  const rawTimeOfferElicitor = buildSlotOfferCopyV2({
    date: '2026-08-17',
    slots: ['18:00'],
    rawSlots: true,
  });
  const rawTimeOfferReplies = singleTimeOfferRepliesFromCopy(rawTimeOfferElicitor);
  const multiTimeOfferElicitor = buildSlotOfferCopyV2({
    date: '2026-08-17',
    slots: ['18:00', '18:30'],
  });
  const multiTimeOfferReplies = timeOfferRepliesFromCopy(multiTimeOfferElicitor);
  const deferredRemainingConstraint: DeferredAvailabilityConstraintV2 = {
    schemaVersion: 1,
    capturedAt: CONTRACT_NOW.toISOString(),
    capturedTurnId: 'turn-deferred-window-contract',
    capturedInputSequence: 1,
    date: '2026-08-17',
    timeWindow: { kind: 'PERIOD', period: 'morning' },
  };
  const deferredWindowElicitor = buildDeferredAvailabilityExhaustedCopyV2({
    selected: {
      date: '2026-08-16',
      timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
    },
    remaining: [
      {
        date: '2026-08-17',
        timeWindow: { kind: 'PERIOD', period: 'morning' },
      },
    ],
    now: CONTRACT_NOW,
    timezone: CONTRACT_TZ,
  });
  const serviceOption = { entityId: 'svc-drenagem', displayName: 'Drenagem Linfática' };
  const professionalOption = { entityId: 'prof-carla', displayName: 'Carla Mendes' };
  const serviceElicitor = buildPendingQuestionV2({
    pending: pendingFrame('SERVICE', [
      { position: 1, ...serviceOption },
    ]),
    flowState: { flowId: 'flow-elicitor-contract', fixedByProofVersion: {} },
    catalog: catalog(),
  })!;
  const professionalElicitor = buildPendingQuestionV2({
    pending: pendingFrame('PROFESSIONAL', [
      { position: 1, ...professionalOption },
    ]),
    flowState: {
      flowId: 'flow-elicitor-contract',
      fixedServiceId: 'svc-drenagem',
      fixedByProofVersion: {},
    },
    catalog: catalog(),
  })!;
  const legacyServiceElicitor = buildServiceQuestion(
    LEGACY_SERVICE_OPTIONS.map((service) => ({ id: service.id, name: service.name }))
  );
  return [
    {
      nome: 'resumo canônico booking — recibo compatível',
      elicitor: canonicalBookingSummary(),
      respostasNaturais: confirmationReplies,
      negacoes: ['não tá certo', 'não certo', 'não', 'não quero'],
      interrogativas: ['certo?', 'sim?', 'ok?', 'posso marcar?'],
      matcher: (reply) =>
        bookingConfirmationMatcher(reply, compatibleBookingDelivery()),
    },
    {
      nome: 'resumo canônico booking — recibo ausente',
      elicitor: canonicalBookingSummary(),
      respostasNaturais: confirmationReplies,
      respostasNaturaisAutorizam: false,
      negacoes: ['não tá certo', 'não certo', 'não', 'não quero'],
      interrogativas: ['certo?', 'sim?', 'ok?', 'posso marcar?'],
      matcher: (reply) => bookingConfirmationMatcher(reply, null),
    },
    {
      nome: 'CANCEL_CONFIRMATION',
      elicitor: buildCancelConfirmationCopyV2(
        'Drenagem Linfática em 17/08/2026 às 10:00 com Carla Mendes'
      ),
      respostasNaturais: confirmationReplies,
      negacoes: ['não tá certo', 'não', 'não confirma'],
      interrogativas: ['certo?', 'sim?', 'confirma?'],
      matcher: cancelConfirmationMatcher,
    },
    {
      nome: 'duplicidade — 4 opções',
      elicitor: duplicateElicitor(),
      respostasNaturais: duplicateNaturalAnswers(),
      negacoes: [
        'não quero remarcar',
        'não quero manter os dois',
        'nenhuma',
      ],
      interrogativas: [
        'pode remarcar?',
        'posso manter os dois?',
        'pode decidir depois?',
      ],
      matcher: duplicateOptionMatcher,
    },
    {
      nome: 'oferta de horário — opção única',
      elicitor: timeOfferElicitor,
      respostasNaturais: timeOfferReplies,
      negacoes: ['não sei', 'não quero'],
      interrogativas: ['qual horário?', 'qual opção?'],
      matcher: (reply) => timeOfferMatcher(reply, timeOfferElicitor),
    },
    {
      nome: 'oferta de horário — serviceContext HH:MM',
      elicitor: rawTimeOfferElicitor,
      respostasNaturais: rawTimeOfferReplies,
      negacoes: ['não sei', 'não quero'],
      interrogativas: ['qual horário?', 'qual opção?'],
      matcher: (reply) => timeOfferMatcher(reply, rawTimeOfferElicitor),
    },
    {
      nome: 'oferta de horário — duas opções',
      elicitor: multiTimeOfferElicitor,
      respostasNaturais: multiTimeOfferReplies,
      negacoes: ['nenhuma', 'não sei', 'esse', 'pode ser'],
      interrogativas: ['qual horário?', 'qual opção?'],
      matcher: (reply) => timeOfferMatcher(reply, multiTimeOfferElicitor),
    },
    {
      nome: 'pergunta de SERVICE — opção única',
      elicitor: serviceElicitor,
      respostasNaturais: selectionRepliesFromCopy(serviceElicitor),
      negacoes: ['não quero Drenagem Linfática'],
      interrogativas: ['qual serviço?'],
      matcher: (reply) => singleSelectionMatcher(reply, 'SERVICE', serviceOption),
    },
    {
      nome: 'pergunta de PROFESSIONAL — opção única',
      elicitor: professionalElicitor,
      respostasNaturais: selectionRepliesFromCopy(professionalElicitor),
      negacoes: ['não quero Carla Mendes'],
      interrogativas: ['qual profissional?'],
      matcher: (reply) =>
        singleSelectionMatcher(reply, 'PROFESSIONAL', professionalOption),
    },
    {
      nome: 'legado SERVICE — copy viva Algum desses',
      elicitor: legacyServiceElicitor,
      respostasNaturais: legacyServiceRepliesFromCopy(legacyServiceElicitor),
      negacoes: [
        `não quero ${LEGACY_SERVICE_OPTIONS[0]!.name}`,
        `Não é ${LEGACY_SERVICE_OPTIONS[0]!.name}`,
      ],
      interrogativas: ['qual serviço?'],
      matcher: (reply) => legacyServiceQuestionMatcher(reply, legacyServiceElicitor),
    },
    {
      nome: 'clarificador de meia-hora',
      elicitor: buildBareHourDisambiguationV2([
        { position: 1, entityId: '17:00', displayName: '17h' },
        { position: 2, entityId: '17:30', displayName: '17h30' },
      ]),
      respostasNaturais: ['17h', '17', 'a primeira'],
      negacoes: ['nenhuma', 'depois', 'não quero'],
      interrogativas: ['17h ou 17h30?'],
      matcher: halfHourClarifierMatcher,
    },
    {
      nome: 'pergunta de DATE',
      elicitor: DATE_PENDING_QUESTION_V2,
      respostasNaturais: ['segunda', 'amanhã', '17/08'],
      negacoes: ['não sei', 'depois eu vejo', 'qualquer dia'],
      interrogativas: ['qual dia você prefere?', 'segunda ou terça?'],
      matcher: dateQuestionMatcher,
    },
    {
      nome: 'janela deferida — alternativa conhecida após esgotamento',
      elicitor: deferredWindowElicitor,
      respostasNaturais: ['pode', 'sim', 'amanhã', 'de manhã', 'amanhã de manhã'],
      negacoes: ['qualquer dia', 'não sei', 'não quero'],
      interrogativas: ['qual janela?', 'posso escolher?'],
      matcher: (reply) =>
        deferredWindowSelectionMatcher(reply, deferredRemainingConstraint),
    },
    {
      nome: 'legado isExplicitBookingConfirmation × CONFIRMATION_HINT',
      elicitor: CONFIRMATION_HINT,
      respostasNaturais: confirmationReplies,
      negacoes: ['não tá certo', 'não certo', 'não', 'pode ser'],
      interrogativas: ['certo?', 'sim?', 'ok?', 'pode marcar?'],
      matcher: isExplicitBookingConfirmation,
    },
  ];
}

export const __elicitorMatcherContractForSmokeV2 = {
  CONTRACT_NOW,
  DUPLICATE_RESOLUTION_CHOICE_QUESTION_V2,
  canonicalBookingSummary,
  bookingConfirmationMatcher,
  compatibleBookingDelivery,
  cancelConfirmationMatcher,
};
