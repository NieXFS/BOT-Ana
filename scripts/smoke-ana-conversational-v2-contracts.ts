import assert from 'node:assert/strict';
import type {
  FlatModelTurnV2,
  TurnDeliveryReceiptV2,
  TurnFrameV2,
  TurnPlanReceiptV2,
} from '../src/services/conversationalV2/contracts';
import { isAnaConversationalV2Enabled } from '../src/services/conversationalV2/featureFlag';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  resolveUniqueCatalogEntityFromCurrentMessage,
} from '../src/services/service-gate';
import {
  __parseFlatModelTurnV2ForSmoke,
  codePointSliceV2,
  coerceEquivalentOpenTransitionV2,
  normalizeWithCodePointMapV2,
  parseModelTurnResultV2,
  unwrapModelTurnResultV2Json,
  type ModelResultValidationContextV2,
} from '../src/services/conversationalV2/modelResultParser';
import {
  assertReceiptRedactedV2,
  opaqueReceiptHashV2,
  redactPendingTransitionCandidateV2,
  serializeTurnDeliveryReceiptV2,
  serializeTurnPlanReceiptV2,
} from '../src/services/conversationalV2/receipts';

const now = new Date('2026-08-13T15:00:00.000Z');
const services = [
  { id: 'svc-peeling', displayName: 'Peeling facial', professionalIds: ['prof-carla'] },
  { id: 'svc-drenagem', displayName: 'Drenagem linfática', professionalIds: ['prof-carla'] },
  { id: 'svc-limpeza', displayName: 'Limpeza de pele profunda', professionalIds: ['prof-carla'] },
];
const professionals = [
  { id: 'prof-carla', displayName: 'Carla Mendes' },
  { id: 'prof-julia', displayName: 'Júlia Costa' },
];

function frameFor(
  inboundIds: string[],
  overrides: Partial<TurnFrameV2> = {}
): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: 'turn-v2-fixture',
    inputSequence: 7,
    catalogSnapshotHash: opaqueReceiptHashV2('catalog-fixture'),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: inboundIds,
    pending: null,
    flowState: { flowId: 'flow-current', fixedByProofVersion: {} },
    ...overrides,
  };
}

function contextFor(input: {
  inbounds: Record<string, string>;
  frame?: TurnFrameV2;
  services?: ModelResultValidationContextV2['catalogEntities']['services'];
  professionals?: ModelResultValidationContextV2['catalogEntities']['professionals'];
  toolTrace?: ModelResultValidationContextV2['toolTrace'];
}): ModelResultValidationContextV2 {
  const ids = Object.keys(input.inbounds);
  return {
    frame: input.frame ?? frameFor(ids),
    inboundTextsById: input.inbounds,
    catalogEntities: {
      services: input.services ?? services,
      professionals: input.professionals ?? professionals,
    },
    now,
    proofVersion: 9,
    ...(input.toolTrace ? { toolTrace: input.toolTrace } : {}),
  };
}

function flat(overrides: Partial<FlatModelTurnV2> = {}): FlatModelTurnV2 {
  return {
    reply: 'Perfeito. Qual dia você prefere?',
    nextPending: 'PRESERVE',
    chosenOptionText: null,
    unknownServiceText: null,
    ...overrides,
  };
}

function parsed(input: {
  inbounds: Record<string, string>;
  result?: Partial<FlatModelTurnV2>;
  context?: Omit<Parameters<typeof contextFor>[0], 'inbounds'>;
}) {
  return parseModelTurnResultV2(
    JSON.stringify(flat(input.result)),
    contextFor({ inbounds: input.inbounds, ...input.context })
  );
}

const peeling = parsed({
  inbounds: { current: '😊 não, peraí, Peeling!' },
  result: { chosenOptionText: 'Peeling', nextPending: 'DATE' },
});
assert.equal(peeling.ok, true);
if (peeling.ok) {
  assert.equal(peeling.resolutionProof?.kind, 'catalog_entity');
  assert.equal(peeling.resolutionProof?.entityId, 'svc-peeling');
  assert.equal(peeling.resolutionProof?.proofVersion, 9);
  assert.equal(peeling.value.replyPurpose, 'DATE_TIME_QUESTION');
  assert.equal(peeling.value.pendingTransitionCandidate.kind, 'open');
  const span = peeling.resolutionProof?.kind === 'catalog_entity'
    ? peeling.resolutionProof.span
    : null;
  assert.equal(
    span ? codePointSliceV2('😊 não, peraí, Peeling!', span.start, span.end) : null,
    'Peeling',
    'mapa reversível preserva offsets por code points após emoji'
  );
}

for (const [label, inbound, chosen, entityId] of [
  ['peeling parcial', 'peeling', 'peeling', 'svc-peeling'],
  ['typo distância 1', 'drenajem', 'drenajem', 'svc-drenagem'],
  ['correção com pontuação', 'não, peraí, peeling!', 'peeling', 'svc-peeling'],
] as const) {
  const result = parsed({
    inbounds: { current: inbound },
    result: { chosenOptionText: chosen },
  });
  assert.equal(result.ok, true, label);
  if (result.ok) assert.equal(result.resolutionProof?.entityId, entityId, label);
}

const uniqueDistanceTwo = parsed({
  inbounds: { current: 'quero drenajemm' },
  result: { chosenOptionText: 'drenajemm' },
});
assert.equal(ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH, true);
assert.equal(
  resolveUniqueCatalogEntityFromCurrentMessage('drenajemm', [
    { id: 'svc-drenagem', name: 'Drenagem' },
  ]).kind,
  'resolved',
  'D compartilhado aceita 1 indel + 1 substituição com os pisos canônicos'
);
assert.equal(uniqueDistanceTwo.ok, true);
if (uniqueDistanceTwo.ok) {
  assert.equal(
    uniqueDistanceTwo.resolutionProof?.entityId,
    'svc-drenagem',
    'D: token >=8 a distância 2 resolve quando a entidade é única'
  );
}
const canaryDistanceTwo = resolveUniqueCatalogEntityFromCurrentMessage(
  'denajem',
  [{ id: 'svc-drenagem', name: 'Drenagem' }]
);
assert.equal(canaryDistanceTwo.kind, 'resolved');
if (canaryDistanceTwo.kind === 'resolved') {
  assert.equal(canaryDistanceTwo.entity.id, 'svc-drenagem');
}
assert.equal(
  resolveUniqueCatalogEntityFromCurrentMessage('mensagem', [
    { id: 'svc-massagem', name: 'Massagem' },
  ]).kind,
  'no_match',
  'D-1: duas substituições não transformam mensagem em Massagem'
);
const professionalExactWins = resolveUniqueCatalogEntityFromCurrentMessage(
  'Fernanda',
  [
    { id: 'prof-fernanda', name: 'Fernanda Lopes' },
    { id: 'prof-neighbor', name: 'Fexrnandb Souza' },
  ]
);
assert.equal(
  professionalExactWins.kind === 'resolved'
    ? professionalExactWins.entity.id
    : professionalExactWins.kind,
  'prof-fernanda',
  'K8: full profissional nunca é vencido pelo typo dist-2 de outra pessoa'
);
const ambiguousDistanceTwo = parsed({
  inbounds: { current: 'quero drenajemm' },
  result: { chosenOptionText: 'drenajemm' },
  context: {
    services: [
      { id: 'svc-drenagem', displayName: 'Drenagem' },
      { id: 'svc-drenajemx', displayName: 'Drenajemx' },
    ],
  },
});
assert.equal(ambiguousDistanceTwo.ok, true);
if (ambiguousDistanceTwo.ok) {
  assert.equal(
    ambiguousDistanceTwo.resolutionProof,
    null,
    'D: duas entidades dentro da distância 2 permanecem fail-closed'
  );
  assert.equal(
    ambiguousDistanceTwo.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_AMBIGUOUS'
  );
}

// K1: polaridade é por oração; menção negada não governa a escolha.
const polarized = parsed({
  inbounds: { current: 'não quero drenagem, quero peeling' },
  result: { chosenOptionText: 'peeling' },
});
assert.equal(polarized.ok && polarized.resolutionProof?.entityId, 'svc-peeling');
const negatedClaim = parsed({
  inbounds: { current: 'não quero drenagem, quero peeling' },
  result: { chosenOptionText: 'drenagem' },
});
assert.equal(negatedClaim.ok, true);
if (negatedClaim.ok) {
  assert.equal(negatedClaim.resolutionProof, null);
  assert.equal(
    negatedClaim.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_TEXT_NOT_CURRENT'
  );
}
const laterNegatedSameText = parsed({
  inbounds: { current: 'quero peeling, mas não peeling' },
  result: { chosenOptionText: 'peeling' },
});
assert.equal(laterNegatedSameText.ok, true);
if (laterNegatedSameText.ok && laterNegatedSameText.resolutionProof?.kind === 'catalog_entity') {
  assert.equal(
    codePointSliceV2(
      'quero peeling, mas não peeling',
      laterNegatedSameText.resolutionProof.span.start,
      laterNegatedSameText.resolutionProof.span.end
    ),
    'peeling',
    'proof aponta para a ocorrência polar-positiva, nunca para a repetição negada'
  );
  assert.equal(laterNegatedSameText.resolutionProof.span.start, 6);
}

// K2: full-match pai que é prefixo próprio do filho é ambíguo na v2.
const parentChild = parsed({
  inbounds: { current: 'limpeza' },
  result: { chosenOptionText: 'limpeza' },
  context: {
    services: [
      { id: 'svc-parent', displayName: 'Limpeza' },
      { id: 'svc-child', displayName: 'Limpeza de pele' },
    ],
  },
});
assert.equal(parentChild.ok, true);
if (parentChild.ok) {
  assert.equal(parentChild.resolutionProof, null);
  assert.equal(
    parentChild.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_AMBIGUOUS'
  );
}

// K8: resolução cruza famílias; full profissional vence typo de serviço.
const crossFamily = parsed({
  inbounds: { current: 'Carla' },
  result: { chosenOptionText: 'Carla' },
  context: {
    services: [{ id: 'svc-carlla', displayName: 'Carlla premium' }],
    professionals: [{ id: 'prof-carla', displayName: 'Carla' }],
  },
});
assert.equal(crossFamily.ok, true);
if (crossFamily.ok) {
  assert.equal(crossFamily.resolutionProof?.entityId, 'prof-carla');
}

// Supersession do lote: a correção posterior governa.
const superseded = parsed({
  inbounds: { first: 'Drenagem', second: 'não, peraí, peeling!' },
  result: { chosenOptionText: 'Drenagem' },
});
assert.equal(superseded.ok, true);
if (superseded.ok) {
  assert.equal(superseded.resolutionProof, null);
  assert.equal(
    superseded.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_SUPERSEDED'
  );
}
const supersedingCorrection = parsed({
  inbounds: { first: 'Drenagem', second: 'não, peraí, peeling!' },
  result: { chosenOptionText: 'peeling' },
});
assert.equal(
  supersedingCorrection.ok && supersedingCorrection.resolutionProof?.entityId,
  'svc-peeling',
  'correção explícita posterior governa o lote'
);
const distinctWithoutCorrection = parsed({
  inbounds: { first: 'drenagem', second: 'peeling' },
  result: { chosenOptionText: 'peeling' },
});
assert.equal(distinctWithoutCorrection.ok, true);
if (distinctWithoutCorrection.ok) {
  assert.equal(distinctWithoutCorrection.resolutionProof, null);
  assert.equal(
    distinctWithoutCorrection.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_AMBIGUOUS',
    'duas entidades positivas sem correção explícita não viram supersession'
  );
}

const ambiguousCleaning = parsed({
  inbounds: { current: 'limpeza' },
  result: { chosenOptionText: 'limpeza' },
  context: {
    services: [
      { id: 'svc-limpeza-profunda', displayName: 'Limpeza de pele profunda' },
      { id: 'svc-limpeza-express', displayName: 'Limpeza facial express' },
    ],
  },
});
assert.equal(ambiguousCleaning.ok, true);
if (ambiguousCleaning.ok) assert.equal(ambiguousCleaning.resolutionProof, null);

const nakedWeekday = parsed({
  inbounds: { current: 'segunda' },
  result: { chosenOptionText: 'segunda' },
});
assert.equal(nakedWeekday.ok, true);
if (nakedWeekday.ok) assert.equal(nakedWeekday.resolutionProof, null);

const absentText = parsed({
  inbounds: { current: 'quero peeling' },
  result: { chosenOptionText: 'drenajem' },
});
assert.equal(absentText.ok, true);
if (absentText.ok) {
  assert.equal(absentText.resolutionProof, null);
  assert.equal(
    absentText.resolutionProofRejections[0]?.code,
    'CATALOG_ENTITY_TEXT_NOT_CURRENT'
  );
}

// unknownServiceText nunca licencia denial quando o contexto completo contém catálogo.
const guardedUnknown = parsed({
  inbounds: { first: 'peeling', second: 'e botox?' },
  result: { unknownServiceText: 'botox' },
});
assert.equal(guardedUnknown.ok, true);
if (guardedUnknown.ok) assert.equal(guardedUnknown.value.unknownServiceEvidence, null);
const validUnknown = parsed({
  inbounds: { current: 'vocês fazem botox?' },
  result: { unknownServiceText: 'botox' },
});
assert.equal(validUnknown.ok, true);
if (validUnknown.ok) {
  assert.equal(validUnknown.value.unknownServiceEvidence?.inboundId, 'current');
}
const canaryTypoCannotLicenseDenial = parsed({
  inbounds: { current: 'vocês fazem denajem?' },
  result: { unknownServiceText: 'denajem' },
});
assert.equal(canaryTypoCannotLicenseDenial.ok, true);
if (canaryTypoCannotLicenseDenial.ok) {
  assert.equal(
    canaryTypoCannotLicenseDenial.value.unknownServiceEvidence,
    null,
    'denajem resolve Drenagem e nunca vira prova de serviço ausente'
  );
}

// Tabela de precondições: TIME só nasce de slots autoritativos tipados.
const timeWithoutRead = parsed({
  inbounds: { current: 'amanhã' },
  result: { nextPending: 'TIME' },
  context: {
    frame: frameFor(['current'], {
      flowState: {
        flowId: 'flow-current',
        fixedServiceId: 'svc-peeling',
        fixedProfessionalId: 'prof-carla',
        fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
      },
    }),
  },
});
assert.equal(
  timeWithoutRead.ok && timeWithoutRead.value.pendingTransitionCandidate.kind,
  'preserve'
);
const existingServicePendingFrame = frameFor(['current'], {
  pending: {
    questionId: 'question-service-open',
    askedAt: '2026-08-13T14:59:00.000Z',
    kind: 'SERVICE',
    flowId: 'flow-current',
    version: 4,
    options: services.map((service, index) => ({
      position: index + 1,
      entityId: service.id,
      displayName: service.displayName,
    })),
  },
});
const samePendingKind = parsed({
  inbounds: { current: 'nossa, vocês são super organizados!! 🥰' },
  result: { nextPending: 'SERVICE' },
  context: { frame: existingServicePendingFrame },
});
assert.equal(
  samePendingKind.ok && samePendingKind.value.pendingTransitionCandidate.kind,
  'open',
  'parser materializa a proposta antes da coerção anti-churn'
);
if (samePendingKind.ok) {
  const equivalentCandidate = samePendingKind.value.pendingTransitionCandidate;
  assert.equal(
    coerceEquivalentOpenTransitionV2(
      equivalentCandidate,
      existingServicePendingFrame,
      existingServicePendingFrame.flowState
    ).kind,
    'preserve',
    'tupla completa idêntica preserva questionId/version'
  );
  if (equivalentCandidate.kind === 'open') {
    assert.equal(
      coerceEquivalentOpenTransitionV2(
        {
          ...equivalentCandidate,
          optionEntityIds: equivalentCandidate.optionEntityIds.slice(1),
        },
        existingServicePendingFrame,
        existingServicePendingFrame.flowState
      ).kind,
      'open',
      'mudança na tupla ordenada de opções exige supersession'
    );
    assert.equal(
      coerceEquivalentOpenTransitionV2(
        equivalentCandidate,
        existingServicePendingFrame,
        {
          ...existingServicePendingFrame.flowState,
          fixedServiceId: 'svc-peeling',
        }
      ).kind,
      'open',
      'mudança no flowState exige supersession mesmo com opções iguais'
    );
  }
}

const confirmationPendingFrame = frameFor(['current'], {
  pending: {
    questionId: 'question-confirmation-open',
    askedAt: '2026-08-13T14:59:00.000Z',
    kind: 'CONFIRMATION',
    flowId: 'flow-current',
    version: 5,
    options: [
      { position: 1, entityId: 'booking-confirmation:yes', displayName: 'sim' },
      { position: 2, entityId: 'booking-confirmation:no', displayName: 'não' },
    ],
  },
});
const equivalentConfirmationCandidate = {
  kind: 'open' as const,
  pendingKind: 'CONFIRMATION' as const,
  flowId: 'flow-current',
  optionEntityIds: ['booking-confirmation:yes', 'booking-confirmation:no'],
};
assert.equal(
  coerceEquivalentOpenTransitionV2(
    equivalentConfirmationCandidate,
    confirmationPendingFrame,
    confirmationPendingFrame.flowState
  ).kind,
  'preserve',
  'CONFIRMATION comum também exige e aceita a tupla completa idêntica'
);
const duplicateConfirmationFrame = frameFor(['current'], {
  pending: {
    ...confirmationPendingFrame.pending!,
    questionId: 'question-duplicate-resolution',
    options: [
      {
        position: 1,
        entityId: 'duplicate-resolution:keep-both',
        displayName: 'manter os dois',
      },
    ],
  },
});
assert.equal(
  coerceEquivalentOpenTransitionV2(
    {
      ...equivalentConfirmationCandidate,
      optionEntityIds: ['duplicate-resolution:keep-both'],
    },
    duplicateConfirmationFrame,
    duplicateConfirmationFrame.flowState
  ).kind,
  'open',
  'duplicate-resolution nunca é coagido para preserve'
);
const otherFlowSameKind = parsed({
  inbounds: { current: 'quero começar outro atendimento' },
  result: { nextPending: 'SERVICE' },
  context: {
    frame: {
      ...existingServicePendingFrame,
      flowState: { flowId: 'flow-new', fixedByProofVersion: {} },
    },
  },
});
assert.equal(
  otherFlowSameKind.ok && otherFlowSameKind.value.pendingTransitionCandidate.kind,
  'open',
  'deduplicação não cruza flowId'
);
if (otherFlowSameKind.ok) {
  assert.equal(
    coerceEquivalentOpenTransitionV2(
      otherFlowSameKind.value.pendingTransitionCandidate,
      existingServicePendingFrame,
      otherFlowSameKind.ok
        ? { flowId: 'flow-new', fixedByProofVersion: {} }
        : existingServicePendingFrame.flowState
    ).kind,
    'open'
  );
}
const timeWithRead = parsed({
  inbounds: { current: 'amanhã' },
  result: { nextPending: 'TIME' },
  context: {
    frame: frameFor(['current'], {
      flowState: {
        flowId: 'flow-current',
        fixedServiceId: 'svc-peeling',
        fixedProfessionalId: 'prof-carla',
        fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
      },
    }),
    toolTrace: [
      {
        name: 'getAvailableSlots',
        args: {
          serviceId: 'svc-peeling',
          professionalId: 'prof-carla',
          date: '2026-08-14',
        },
        result: JSON.stringify({ success: true, slots: ['14:00', '15:00'] }),
      },
    ],
  },
});
assert.equal(timeWithRead.ok, true);
if (timeWithRead.ok) {
  assert.deepEqual(
    timeWithRead.value.pendingTransitionCandidate.kind === 'open'
      ? timeWithRead.value.pendingTransitionCandidate.optionEntityIds
      : [],
    ['14:00', '15:00']
  );
}
const timeWithCrossedServiceRead = parsed({
  inbounds: { current: 'amanhã' },
  result: { nextPending: 'TIME' },
  context: {
    frame: frameFor(['current'], {
      flowState: {
        flowId: 'flow-current',
        fixedServiceId: 'svc-peeling',
        fixedProfessionalId: 'prof-carla',
        fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
      },
    }),
    toolTrace: [
      {
        name: 'getAvailableSlots',
        args: {
          serviceId: 'svc-drenagem',
          professionalId: 'prof-carla',
          date: '2026-08-14',
        },
        result: JSON.stringify({ success: true, slots: ['14:00'] }),
      },
    ],
  },
});
assert.equal(
  timeWithCrossedServiceRead.ok &&
    timeWithCrossedServiceRead.value.pendingTransitionCandidate.kind,
  'preserve',
  'TIME rejeita slots de outro serviço'
);

const confirmationFrame = frameFor(['current'], {
  flowState: {
    flowId: 'flow-current',
    fixedServiceId: 'svc-peeling',
    fixedProfessionalId: 'prof-carla',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-with-slots',
      serviceId: 'svc-peeling',
      professionalId: 'prof-carla',
      date: '2026-08-14',
      slots: ['14:00', '15:00'],
    },
    bookingDraft: {
      serviceId: 'svc-peeling',
      professionalId: 'prof-carla',
      date: '2026-08-14',
      time: '15:00',
      slotEvidenceTurnId: 'turn-with-slots',
    },
    fixedByProofVersion: {
      fixedServiceId: 2,
      fixedProfessionalId: 2,
      resolvedDate: 2,
    },
  },
});
const confirmationWithDraft = parsed({
  inbounds: { current: 'pode ser 15h' },
  result: { nextPending: 'CONFIRMATION' },
  context: { frame: confirmationFrame },
});
assert.equal(
  confirmationWithDraft.ok &&
    confirmationWithDraft.value.pendingTransitionCandidate.kind === 'open' &&
    confirmationWithDraft.value.pendingTransitionCandidate.pendingKind,
  'CONFIRMATION'
);
const confirmationWithStaleDraft = parsed({
  inbounds: { current: 'pode ser 15h' },
  result: { nextPending: 'CONFIRMATION' },
  context: {
    frame: {
      ...confirmationFrame,
      flowState: {
        ...confirmationFrame.flowState,
        bookingDraft: {
          ...confirmationFrame.flowState.bookingDraft!,
          slotEvidenceTurnId: 'outro-turno',
        },
      },
    },
  },
});
assert.equal(
  confirmationWithStaleDraft.ok &&
    confirmationWithStaleDraft.value.pendingTransitionCandidate.kind,
  'preserve',
  'CONFIRMATION rejeita draft sem a evidência tipada correspondente'
);

// Parser externo é estritamente plano: rico, extra e enum inventado falham.
assert.equal(
  parseModelTurnResultV2(
    JSON.stringify({ schemaVersion: 2, reply: 'x' }),
    contextFor({ inbounds: { current: 'oi' } })
  ).ok,
  false
);
assert.equal(
  parseModelTurnResultV2(
    JSON.stringify({ ...flat(), extra: true }),
    contextFor({ inbounds: { current: 'oi' } })
  ).ok,
  false
);
assert.equal(
  __parseFlatModelTurnV2ForSmoke(JSON.stringify({ ...flat(), nextPending: 'INVENTED' })).ok,
  false
);

const fenced = `\`\`\`json\n${JSON.stringify(flat())}\n\`\`\``;
assert.equal(parseModelTurnResultV2(fenced, contextFor({ inbounds: { current: 'oi' } })).ok, true);
assert.equal(unwrapModelTurnResultV2Json(fenced).ok, true);
const inertContractMarker = __parseFlatModelTurnV2ForSmoke(
  JSON.stringify({ contract: 'FlatModelTurnV2', ...flat() })
);
assert.equal(
  inertContractMarker.ok,
  true,
  'unwrap remove somente o marcador literal contract=FlatModelTurnV2'
);
const wrongContractMarker = __parseFlatModelTurnV2ForSmoke(
  JSON.stringify({ contract: 'OutroContrato', ...flat() })
);
assert.equal(wrongContractMarker.ok, false);
if (!wrongContractMarker.ok) {
  assert.ok(
    wrongContractMarker.issues.some(
      (issue) => issue.code === 'EXTRA_FIELD' && issue.path === '$.contract'
    )
  );
}
const markerWithAnotherExtra = __parseFlatModelTurnV2ForSmoke(
  JSON.stringify({ contract: 'FlatModelTurnV2', ...flat(), extra: true })
);
assert.equal(markerWithAnotherExtra.ok, false);
if (!markerWithAnotherExtra.ok) {
  assert.ok(
    markerWithAnotherExtra.issues.some(
      (issue) => issue.code === 'EXTRA_FIELD' && issue.path === '$.extra'
    )
  );
}
assert.equal(
  parseModelTurnResultV2(
    `Segue o objeto:\n\`\`\`json\n${JSON.stringify(flat())}\n\`\`\``,
    contextFor({ inbounds: { current: 'oi' } })
  ).ok,
  true
);
assert.equal(
  parseModelTurnResultV2(
    `Segue:\n${JSON.stringify(flat())}\ntexto depois`,
    contextFor({ inbounds: { current: 'oi' } })
  ).ok,
  false
);

const mapped = normalizeWithCodePointMapV2('😊 Júlia!');
assert.equal(mapped.text, 'julia');
assert.equal(codePointSliceV2('😊 Júlia!', mapped.starts[0]!, mapped.ends.at(-1)!), 'Júlia');

const redactedTransition = redactPendingTransitionCandidateV2({
  kind: 'open',
  pendingKind: 'SERVICE',
  flowId: 'flow-current',
  optionEntityIds: ['svc-peeling', 'svc-drenagem'],
});
const planReceipt: TurnPlanReceiptV2 = {
  schemaVersion: 2,
  planReceiptId: 'plan-receipt-v2',
  turnId: 'turn-v2-fixture',
  frameHash: opaqueReceiptHashV2('frame-fixture'),
  inputSequence: 7,
  route: 'model',
  provider: 'deepseek',
  requestedModel: 'deepseek-v4-flash',
  response: {
    model: 'deepseek-v4-flash-response',
    systemFingerprint: 'fp_fixture_contracts',
  },
  thinkingMode: 'enabled',
  strictTools: true,
  primaryModelRounds: 2,
  primaryProviderCalls: 2,
  regenProviderCalls: 0,
  pendingTransitionCandidate: redactedTransition,
  toolEffects: [
    {
      invocationId: 'invocation-1',
      tool: 'getAvailableSlots',
      class: 'read',
      outcome: 'success',
      writeCommitted: false,
    },
  ],
  boundaryAttempts: [
    {
      index: 0,
      candidateHash: opaqueReceiptHashV2('candidate'),
      reasonCodes: [],
    },
  ],
  gateDecline: {
    gate: 'booking_confirmation',
    reason: 'scoped_modal_delivery_missing',
  },
  recoveryKind: 'none',
  result: 'accepted_for_delivery',
};
const deliveryReceipt: TurnDeliveryReceiptV2 = {
  schemaVersion: 2,
  deliveryReceiptId: 'delivery-receipt-v2',
  planReceiptId: planReceipt.planReceiptId,
  turnId: planReceipt.turnId,
  deliveryAttemptId: 'delivery-attempt-v2',
  transportStartedAt: '2026-08-13T15:00:01.000Z',
  transportOutcome: 'accepted_by_provider',
  providerMessageIdHash: opaqueReceiptHashV2('provider-message-id'),
  outboxState: 'accepted_by_provider',
  conversationCommitOutcome: 'committed',
  pendingCommitOutcome: 'opened',
  expectedPendingVersion: 3,
  observedPendingVersion: 3,
  terminalAt: '2026-08-13T15:00:02.000Z',
};
const redactionContext = {
  forbiddenCatalogEntityIds: ['svc-peeling', 'svc-drenagem', 'prof-julia'],
  forbiddenPlaintextFragments: ['texto secreto do cliente'],
  forbiddenMessageIds: ['wamid.raw-sensitive-id'],
  forbiddenPhoneValues: ['5511999999999'],
};
const successorReceipt: TurnDeliveryReceiptV2 = {
  ...(() => {
    const { providerMessageIdHash: _omitted, ...withoutProviderHash } = deliveryReceipt;
    return withoutProviderHash;
  })(),
  deliveryReceiptId: 'delivery-successor',
  transportStartedAt: null,
  transportOutcome: 'superseded',
  outboxState: 'prepared',
  conversationCommitOutcome: 'not_applicable',
  pendingCommitOutcome: 'not_applicable',
  successorTurnId: opaqueReceiptHashV2('successor-turn'),
};
for (const receipt of [planReceipt, deliveryReceipt, successorReceipt]) {
  assert.doesNotThrow(() => assertReceiptRedactedV2(receipt, redactionContext));
}
assert.doesNotThrow(() => JSON.parse(serializeTurnPlanReceiptV2(planReceipt, redactionContext)));
assert.doesNotThrow(() => JSON.parse(serializeTurnDeliveryReceiptV2(deliveryReceipt, redactionContext)));

const numericSequenceCandidateHash = 'abcdef0123456789' + 'a'.repeat(48);
assert.equal(numericSequenceCandidateHash.length, 64);
assert.doesNotThrow(() =>
  serializeTurnPlanReceiptV2({
    ...planReceipt,
    boundaryAttempts: [
      { ...planReceipt.boundaryAttempts[0]!, candidateHash: numericSequenceCandidateHash },
    ],
  })
);
assert.throws(() =>
  serializeTurnPlanReceiptV2({
    ...planReceipt,
    toolEffects: [
      { ...planReceipt.toolEffects[0]!, invocationId: numericSequenceCandidateHash },
    ],
  })
);
for (const invalidPlan of [
  { ...planReceipt, frameHash: 'a'.repeat(63) },
  {
    ...planReceipt,
    boundaryAttempts: [
      { ...planReceipt.boundaryAttempts[0]!, candidateHash: '1c42c1578904821f' },
    ],
  },
]) {
  assert.throws(() => serializeTurnPlanReceiptV2(invalidPlan), /hash fora do formato SHA-256/);
}
for (const invalidDelivery of [
  { ...deliveryReceipt, providerMessageIdHash: 'a'.repeat(65) },
  { ...deliveryReceipt, providerMessageIdHash: 'g'.repeat(64) },
  { ...deliveryReceipt, providerMessageIdHash: undefined },
  { ...deliveryReceipt, providerMessageIdHash: 64 },
]) {
  assert.throws(
    () => serializeTurnDeliveryReceiptV2(invalidDelivery as unknown as TurnDeliveryReceiptV2),
    /hash fora do formato SHA-256/
  );
}
assert.throws(() =>
  assertReceiptRedactedV2(
    { ...planReceipt, customerPhone: '+5511999999999' } as TurnPlanReceiptV2,
    redactionContext
  )
);
assert.throws(() =>
  assertReceiptRedactedV2(
    { ...planReceipt, replyText: 'texto secreto do cliente' } as TurnPlanReceiptV2,
    redactionContext
  )
);
assert.throws(() =>
  assertReceiptRedactedV2(
    { ...planReceipt, recoveryKind: 'texto secreto do cliente' } as TurnPlanReceiptV2,
    redactionContext
  )
);
assert.throws(() =>
  assertReceiptRedactedV2(
    { ...deliveryReceipt, turnId: 'wamid.raw-sensitive-id' },
    redactionContext
  )
);
assert.throws(() =>
  assertReceiptRedactedV2(
    { ...deliveryReceipt, deliveryAttemptId: 'attempt-5511999999999' },
    redactionContext
  )
);
assert.throws(() =>
  assertReceiptRedactedV2(
    {
      ...planReceipt,
      toolEffects: [{ ...planReceipt.toolEffects[0]!, args: { serviceId: 'svc-peeling' } }],
    } as TurnPlanReceiptV2,
    redactionContext
  )
);

assert.equal(isAnaConversationalV2Enabled('tenant-a', ''), false);
assert.equal(isAnaConversationalV2Enabled('tenant-a', undefined), false);
assert.equal(isAnaConversationalV2Enabled('tenant-a', '*'), false);
assert.equal(isAnaConversationalV2Enabled('tenant-a', 'tenant-b, tenant-a'), true);

console.log('smoke ana conversational v2 contracts: OK');
