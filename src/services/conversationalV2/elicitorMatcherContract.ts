import type { UpcomingAppointment } from '../calendarService';
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
  FlowStateV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from './contracts';
import { resolveCurrentInboundDateV2 } from './currentDateResolution';
import {
  buildBareHourDisambiguationV2,
  resolvePendingOptionProofV2,
} from './fastPaths';
import { buildCanonicalBookingSummaryV2 } from './lifecycleReducer';
import { NATURAL_AFFIRMATIVE_REPLIES_V2 } from './naturalAffirmative';
import {
  DATE_PENDING_QUESTION_V2,
  DUPLICATE_RESOLUTION_CHOICE_QUESTION_V2,
  DUPLICATE_RESOLUTION_OPTIONS_V2,
} from './pendingQuestion';
import { buildDuplicateResolutionQuestionV2 } from './bookingProgressFastPaths';
import type { AcceptedDeliveryEvidenceV2 } from './stateStore';

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
    services: [{ id: 'svc-drenagem', name: 'Drenagem Linfática' }],
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
