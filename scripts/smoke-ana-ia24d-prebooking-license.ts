import assert from 'node:assert/strict';
import type { ServicesResult } from '../src/services/calendarService';
import {
  evaluateBoundaryV2,
  isLicensedPreBookingSummaryV2,
} from '../src/services/conversationalV2/boundary';
import {
  buildPreBookingSummaryEvidenceV2,
  materializePreBookingSummaryV2,
} from '../src/services/conversationalV2/preBookingSummary';
import type { FlowStateV2, ModelTurnResultV2 } from '../src/services/conversationalV2/contracts';
import { coordinateRecoveryV2 } from '../src/services/conversationalV2/recoveryCoordinator';

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-manicure',
      name: 'Manicure',
      durationMinutes: 50,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: ['prof-vitin'],
    },
    {
      id: 'svc-pedicure',
      name: 'Pedicure',
      durationMinutes: 50,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: ['prof-vitin'],
    },
    {
      id: 'svc-combo',
      name: 'Manicure e pedicure',
      durationMinutes: 100,
      price: 140,
      priceFormatted: 'R$ 140,00',
      professionalIds: ['prof-vitin'],
    },
    {
      id: 'svc-other',
      name: 'Reposição de unha',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-vitin'],
    },
  ],
  professionals: [
    { id: 'prof-vitin', name: 'Vitin' },
    { id: 'prof-other', name: 'Outra Profissional' },
  ],
};

const flowState: FlowStateV2 = {
  flowId: 'flow-ia24d',
  fixedServiceId: 'svc-combo',
  fixedProfessionalId: 'prof-vitin',
  resolvedDate: '2026-08-24',
  bookingDraft: {
    serviceId: 'svc-combo',
    professionalId: 'prof-vitin',
    date: '2026-08-24',
    time: '18:00',
    slotEvidenceTurnId: 'turn-slot-ia24d',
  },
  slotEvidence: {
    turnId: 'turn-slot-ia24d',
    serviceId: 'svc-combo',
    professionalId: 'prof-vitin',
    date: '2026-08-24',
    slots: ['17:30', '18:00'],
  },
  fixedByProofVersion: {
    fixedServiceId: 1,
    fixedProfessionalId: 1,
    resolvedDate: 1,
  },
};

const evidence = buildPreBookingSummaryEvidenceV2({ flowState, services });
assert.ok(evidence);
const canonical = materializePreBookingSummaryV2({
  bookingDraft: flowState.bookingDraft!,
  services,
});
const transition = {
  kind: 'open' as const,
  pendingKind: 'CONFIRMATION' as const,
  flowId: flowState.flowId,
  optionEntityIds: [`booking-confirmation:${flowState.flowId}`],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawCandidate: canonical,
    servicesResult: services,
    flowState,
    sourceInboundText: 'Pode ser 18h',
    pendingTransitionCandidate: transition,
    replyPurpose: 'WRITE_CONFIRMATION' as const,
    source: 'CANONICAL' as const,
    outboundEvidence: { preBookingSummary: evidence },
    // The empty list is deliberately present: absence of a duplicate is not
    // the license; the typed proposal proof is.
    toolTrace: [
      {
        name: 'getUpcomingAppointments',
        result: JSON.stringify({ success: true, appointments: [] }),
      },
    ],
    ...overrides,
  };
}

function candidateFor(state: FlowStateV2): string {
  return materializePreBookingSummaryV2({
    bookingDraft: state.bookingDraft!,
    services,
  });
}

function typedEvidenceFor(
  state: FlowStateV2,
  overrides: Partial<NonNullable<typeof evidence>> = {}
): NonNullable<typeof evidence> {
  const draft = state.bookingDraft!;
  return {
    flowId: state.flowId,
    serviceId: draft.serviceId,
    ...(draft.professionalId ? { professionalId: draft.professionalId } : {}),
    date: draft.date,
    time: draft.time,
    slotEvidenceTurnId: draft.slotEvidenceTurnId,
    ...overrides,
  };
}

const positive = evaluateBoundaryV2(input());
assert.equal(positive.safe, true, positive.reasonCodes.join(','));
assert.equal(
  positive.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  false
);
assert.equal(isLicensedPreBookingSummaryV2(canonical, input()), true);

const confirmationPendingSnapshot = {
  questionId: 'question-ia24d-confirmation',
  askedAt: '2026-08-24T17:00:00.000Z',
  kind: 'CONFIRMATION' as const,
  flowId: flowState.flowId,
  version: 2,
  options: [
    {
      position: 1,
      entityId: `booking-confirmation:${flowState.flowId}`,
      displayName: 'Confirmar agendamento',
    },
  ],
};
const reanchorPositive = evaluateBoundaryV2(
  input({
    pendingTransitionCandidate: { kind: 'preserve' as const },
    pendingAnaOpen: true,
    pendingSnapshot: confirmationPendingSnapshot,
  })
);
assert.equal(reanchorPositive.safe, true, reanchorPositive.reasonCodes.join(','));
assert.equal(
  reanchorPositive.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
  false
);

const negatives: Array<[string, Record<string, unknown>]> = [
  [
    'serviço diferente do fixedServiceId',
    (() => {
      const state: FlowStateV2 = {
        ...flowState,
        bookingDraft: { ...flowState.bookingDraft!, serviceId: 'svc-other' },
        slotEvidence: { ...flowState.slotEvidence!, serviceId: 'svc-other' },
      };
      return {
        rawCandidate: candidateFor(state),
        flowState: state,
        outboundEvidence: { preBookingSummary: typedEvidenceFor(state) },
      };
    })(),
  ],
  [
    'horário fora do slotEvidence',
    (() => {
      const state: FlowStateV2 = {
        ...flowState,
        bookingDraft: { ...flowState.bookingDraft!, time: '19:00' },
      };
      return {
        rawCandidate: candidateFor(state),
        flowState: state,
        outboundEvidence: { preBookingSummary: typedEvidenceFor(state) },
      };
    })(),
  ],
  [
    'data diferente',
    (() => {
      const state: FlowStateV2 = {
        ...flowState,
        bookingDraft: { ...flowState.bookingDraft!, date: '2026-08-25' },
        slotEvidence: { ...flowState.slotEvidence!, date: '2026-08-25' },
      };
      return {
        rawCandidate: candidateFor(state),
        flowState: state,
        outboundEvidence: { preBookingSummary: typedEvidenceFor(state) },
      };
    })(),
  ],
  [
    'profissional incompatível',
    (() => {
      const state: FlowStateV2 = {
        ...flowState,
        bookingDraft: { ...flowState.bookingDraft!, professionalId: 'prof-other' },
        slotEvidence: { ...flowState.slotEvidence!, professionalId: 'prof-other' },
      };
      return {
        rawCandidate: candidateFor(state),
        flowState: state,
        outboundEvidence: { preBookingSummary: typedEvidenceFor(state) },
      };
    })(),
  ],
  [
    'ausência de bookingDraft',
    { flowState: { ...flowState, bookingDraft: undefined } },
  ],
  [
    'bookingDraft sem evidence correspondente',
    {
      flowState: {
        ...flowState,
        bookingDraft: {
          ...flowState.bookingDraft!,
          slotEvidenceTurnId: 'turn-different-from-slot',
        },
      },
      outboundEvidence: {
        preBookingSummary: {
          ...evidence!,
          slotEvidenceTurnId: 'turn-different-from-slot',
        },
      },
    },
  ],
  [
    'fixedProfessionalId ausente',
    {
      flowState: { ...flowState, fixedProfessionalId: undefined },
    },
  ],
  [
    'fixedProfessionalId incompatível',
    {
      flowState: { ...flowState, fixedProfessionalId: 'prof-other' },
    },
  ],
  [
    'resolvedDate ausente',
    {
      flowState: { ...flowState, resolvedDate: undefined },
    },
  ],
  [
    'resolvedDate incompatível',
    {
      flowState: { ...flowState, resolvedDate: '2026-08-25' },
    },
  ],
  [
    'serviço sem profissional elegível atual',
    {
      servicesResult: {
        ...services,
        services: services.services?.map((service) =>
          service.id === 'svc-combo'
            ? { ...service, professionalIds: [] }
            : service
        ),
      },
    },
  ],
  [
    'texto parecido mas não igual',
    { rawCandidate: canonical.replace('Posso marcar?', 'Posso agendar?') },
  ],
  [
    'afirmação de write antes do write',
    { rawCandidate: 'Seu horário já está marcado para 24/08/2026 às 18h. Posso marcar?' },
  ],
  [
    'candidate GENERATED sem evidência tipada',
    { source: 'GENERATED', outboundEvidence: { preBookingSummary: evidence } },
  ],
  [
    'source CANONICAL com transition preserve',
    {
      pendingTransitionCandidate: { kind: 'preserve' as const },
    },
  ],
  [
    'source CANONICAL com transition de outro flow',
    {
      pendingTransitionCandidate: {
        ...transition,
        flowId: 'flow-other',
      },
    },
  ],
  [
    'purpose diferente de WRITE_CONFIRMATION',
    { replyPurpose: 'OPERATIONAL_ANSWER' as const },
  ],
];

for (const [label, overrides] of negatives) {
  const result = evaluateBoundaryV2(input(overrides));
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
    true,
    `${label}: ${result.reasonCodes.join(',')}`
  );
  assert.equal(result.safe, false, label);
}

for (const [label, overrides] of [
  ['successful write no trace license', {
    toolTrace: [
      {
        name: 'bookAppointment',
        result: JSON.stringify({ success: true }),
      },
    ],
  }],
  ['source CANONICAL sem evidence', { outboundEvidence: undefined }],
] as const) {
  const result = evaluateBoundaryV2(input(overrides));
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
    true,
    label
  );
}

for (const [label, overrides] of [
  [
    'reanchor sem PendingFrame OPEN real',
    { pendingTransitionCandidate: { kind: 'preserve' as const }, pendingAnaOpen: false, pendingSnapshot: confirmationPendingSnapshot },
  ],
  [
    'reanchor com PendingFrame de kind errado',
    {
      pendingTransitionCandidate: { kind: 'preserve' as const },
      pendingAnaOpen: true,
      pendingSnapshot: { ...confirmationPendingSnapshot, kind: 'TIME' as const },
    },
  ],
  [
    'reanchor com options erradas',
    {
      pendingTransitionCandidate: { kind: 'preserve' as const },
      pendingAnaOpen: true,
      pendingSnapshot: {
        ...confirmationPendingSnapshot,
        options: [
          {
            position: 1,
            entityId: 'booking-confirmation:other-flow',
            displayName: 'Confirmar agendamento',
          },
        ],
      },
    },
  ],
  [
    'reanchor com flow divergente',
    {
      pendingTransitionCandidate: { kind: 'preserve' as const },
      pendingAnaOpen: true,
      pendingSnapshot: { ...confirmationPendingSnapshot, flowId: 'flow-other' },
    },
  ],
  [
    'reanchor GENERATED sem licença',
    {
      source: 'GENERATED' as const,
      pendingTransitionCandidate: { kind: 'preserve' as const },
      pendingAnaOpen: true,
      pendingSnapshot: confirmationPendingSnapshot,
    },
  ],
] as const) {
  const result = evaluateBoundaryV2(input(overrides));
  assert.equal(
    result.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT'),
    true,
    label
  );
  assert.equal(result.safe, false, label);
}

const modelResult: ModelTurnResultV2 = {
  schemaVersion: 2,
  reply: canonical,
  replyPurpose: 'WRITE_CONFIRMATION',
  pendingTransitionCandidate: transition,
  resolutionCandidate: null,
  unknownServiceEvidence: null,
};
async function main(): Promise<void> {
const regen = await coordinateRecoveryV2({
  frame: {
    schemaVersion: 2,
    turnId: 'turn-recovery-ia24d',
    inputSequence: 1,
    catalogSnapshotHash: 'catalog-hash',
    catalogState: 'available',
    humanControl: 'BOT_ACTIVE',
    currentInboundIds: ['in-ia24d'],
    pending: null,
    flowState,
  },
  primaryResult: { ok: true, value: modelResult, resolutionProof: null, resolutionProofRejections: [] },
  primarySource: 'GENERATED',
  // Even if a caller accidentally supplies it, GENERATED must not inherit it.
  primaryOutboundEvidence: { preBookingSummary: evidence },
  boundaryContext: {
    servicesResult: services,
    sourceInboundText: 'Pode ser 18h',
  },
  toolTrace: [],
  fallbackIntent: 'OTHER',
  regenerate: async () => ({
    ok: true as const,
    result: modelResult,
    providerCalls: 1,
    resolutionProof: null,
  }),
});
assert.equal(regen.regenCount, 1);
assert.equal(regen.boundaryAttempts.length, 2);
assert.equal(regen.status, 'silent_escalation');
assert.equal(
  regen.boundaryAttempts.every((attempt) =>
    attempt.evaluation.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT')
  ),
  true
);

console.log(JSON.stringify({
  status: 'PASS',
  source: 'CANONICAL',
  replyPurpose: 'WRITE_CONFIRMATION',
  pending: 'CONFIRMATION',
  primaryProviderCalls: 0,
  regenProviderCalls: 0,
  negativeCases: negatives.length + 8,
  generatedRegenBlocked: true,
}));
}

void main().catch((error: unknown) => {
  console.error(`smoke-ana-ia24d-prebooking-license: FAIL (${error instanceof Error ? error.name : 'unknown'})`);
  process.exitCode = 1;
});
