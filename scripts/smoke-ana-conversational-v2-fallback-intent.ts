import assert from 'node:assert/strict';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  ModelTurnResultV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import type { ModelTurnResultV2ParseResult } from '../src/services/conversationalV2/modelResultParser';
import {
  ANSWER_TO_PENDING_FALLBACK_V2,
  INFORMATION_QUESTION_FALLBACK_V2,
  TRANSACTION_REQUEST_FALLBACK_V2,
  coordinateRecoveryV2,
} from '../src/services/conversationalV2/recoveryCoordinator';
import {
  classifyRecoveryFallbackIntentV2,
  type RecoveryFallbackIntentV2,
} from '../src/services/conversationalV2/recoveryFallbackIntent';

const now = new Date('2026-08-15T06:00:00.000Z');
const inboundId = 'in-fallback-intent';
const servicesResult: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-marina'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia'],
    },
  ],
  professionals: [
    { id: 'prof-marina', name: 'Marina' },
    { id: 'prof-julia', name: 'Júlia' },
  ],
};

const baseFrame: TurnFrameV2 = {
  schemaVersion: 2,
  turnId: 'turn-fallback-intent',
  inputSequence: 1,
  catalogSnapshotHash: 'a'.repeat(64),
  catalogState: 'available',
  humanControl: 'NO_ACTIVE_TAKEOVER',
  currentInboundIds: [inboundId],
  pending: null,
  flowState: {
    flowId: 'flow-fallback-intent',
    fixedByProofVersion: {},
  },
};

function frameWithPending(
  kind: NonNullable<TurnFrameV2['pending']>['kind'],
  options: NonNullable<TurnFrameV2['pending']>['options']
): TurnFrameV2 {
  return {
    ...baseFrame,
    pending: {
      questionId: `question-${kind.toLowerCase()}`,
      askedAt: '2026-08-15T05:55:00.000Z',
      kind,
      flowId: baseFrame.flowState.flowId,
      version: 1,
      options,
    },
  };
}

const servicePendingFrame = frameWithPending('SERVICE', [
  { position: 1, entityId: 'svc-drenagem', displayName: 'Drenagem' },
  { position: 2, entityId: 'svc-peeling', displayName: 'Peeling Facial' },
]);
const timePendingFrame = frameWithPending('TIME', [
  { position: 1, entityId: '15:00', displayName: '15h' },
  { position: 2, entityId: '16:00', displayName: '16h' },
]);

function classify(
  inboundText: string,
  frame: TurnFrameV2 = baseFrame
): RecoveryFallbackIntentV2 {
  return classifyRecoveryFallbackIntentV2({
    frame,
    inboundId,
    inboundText,
    servicesResult,
    now,
  });
}

async function main(): Promise<void> {
assert.equal(
  classify('Como funciona a Drenagem?'),
  'INFORMATION_QUESTION',
  'pergunta informacional com ?'
);
assert.equal(
  classify('Como funciona a Drenagem'),
  'INFORMATION_QUESTION',
  'wh-token classifica pergunta mesmo sem ?'
);
assert.equal(
  classify('Como funciona a Drenagem('),
  'INFORMATION_QUESTION',
  'typo real do parêntese não muda o ato de fala'
);
assert.equal(
  classify('Pode marcar a Drenagem?'),
  'TRANSACTION_REQUEST',
  '? não converte pedido transacional explícito em pergunta informacional'
);
assert.equal(classify('Quero agendar'), 'TRANSACTION_REQUEST');
assert.equal(
  classify('Quero agendar', servicePendingFrame),
  'TRANSACTION_REQUEST',
  'reinício transacional não é resposta à SERVICE pendente'
);
assert.equal(
  classify('Quanto custa a Drenagem?', servicePendingFrame),
  'INFORMATION_QUESTION',
  'menção de serviço em pergunta informacional não resolve a pendência'
);
assert.equal(classify('Posso cancelar?'), 'TRANSACTION_REQUEST');
assert.equal(
  classify('pode ser drenagem?', servicePendingFrame),
  'ANSWER_TO_PENDING',
  'matcher fechado da SERVICE vence a pontuação'
);
assert.equal(
  classify('15h?', timePendingFrame),
  'ANSWER_TO_PENDING',
  'matcher temporal fechado da TIME vence a pontuação'
);
assert.equal(
  classify('a segunda opção?', servicePendingFrame),
  'ANSWER_TO_PENDING',
  'ordinal interrogativo continua resposta à pendência'
);

const invalidEnvelope: ModelTurnResultV2ParseResult = {
  ok: false,
  issues: [{ code: 'INVALID_JSON', path: '$' }],
};
const falseWriteCandidate: ModelTurnResultV2 = {
  schemaVersion: 2,
  reply: 'Pronto, seu atendimento ficou agendado.',
  replyPurpose: 'WRITE_CONFIRMATION',
  pendingTransitionCandidate: { kind: 'preserve' },
  resolutionCandidate: null,
  unknownServiceEvidence: null,
};
const parsedFalseWrite: ModelTurnResultV2ParseResult = {
  ok: true,
  value: falseWriteCandidate,
  resolutionProof: null,
  resolutionProofRejections: [],
};
const failedRegen = async () => ({
  ok: false as const,
  reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
  providerCalls: 1 as const,
});

async function recover(input: {
  inboundText: string;
  frame?: TurnFrameV2;
  primaryResult?: ModelTurnResultV2ParseResult;
  fallbackIntent?: RecoveryFallbackIntentV2;
}) {
  const frame = input.frame ?? baseFrame;
  const fallbackIntent =
    input.fallbackIntent ?? classify(input.inboundText, frame);
  return coordinateRecoveryV2({
    frame,
    fallbackIntent,
    primaryResult: input.primaryResult ?? parsedFalseWrite,
    boundaryContext: {
      servicesResult,
      sourceInboundText: input.inboundText,
      currentInboundIds: [inboundId],
      inboundTextsById: { [inboundId]: input.inboundText },
      route: 'model',
      pendingAnaOpen: frame.pending !== null,
      pendingSnapshot: frame.pending,
    },
    toolTrace: [],
    regenerate: failedRegen,
  });
}

const realTypoRecovery = await recover({
  inboundText: 'Como funciona a Drenagem(',
});
assert.equal(realTypoRecovery.status, 'accepted');
if (realTypoRecovery.status === 'accepted') {
  assert.equal(realTypoRecovery.recoveryKind, 'direct_fallback');
  assert.equal(realTypoRecovery.payload, INFORMATION_QUESTION_FALLBACK_V2);
  assert.equal(
    realTypoRecovery.boundaryAttempts.some((attempt) =>
      attempt.evaluation.reasonCodes.includes('FALSE_WRITE_CLAIM')
    ),
    true,
    'a reprodução atravessa FALSE_WRITE_CLAIM antes do fallback dirigido'
  );
}

const newQuestionWithOldPending = await recover({
  inboundText: 'Como funciona a Drenagem?',
  frame: servicePendingFrame,
});
assert.equal(newQuestionWithOldPending.status, 'accepted');
if (newQuestionWithOldPending.status === 'accepted') {
  assert.equal(
    newQuestionWithOldPending.payload,
    INFORMATION_QUESTION_FALLBACK_V2,
    'pergunta nova não repete a pendência antiga'
  );
  assert.deepEqual(newQuestionWithOldPending.pendingTransitionCandidate, {
    kind: 'preserve',
  });
  assert.notEqual(
    newQuestionWithOldPending.payload,
    'Qual serviço você prefere: Drenagem, Peeling Facial?'
  );
}

const answeredPending = await recover({
  inboundText: 'pode ser drenagem?',
  frame: servicePendingFrame,
  primaryResult: invalidEnvelope,
});
assert.equal(answeredPending.status, 'accepted');
if (answeredPending.status === 'accepted') {
  assert.equal(
    answeredPending.payload,
    'Qual serviço você prefere: Drenagem, Peeling Facial?'
  );
  assert.deepEqual(answeredPending.pendingTransitionCandidate, {
    kind: 'preserve',
  });
}

const transactionRecovery = await recover({
  inboundText: 'Quero remarcar meu atendimento',
  primaryResult: invalidEnvelope,
});
assert.equal(transactionRecovery.status, 'accepted');
if (transactionRecovery.status === 'accepted') {
  assert.equal(transactionRecovery.payload, TRANSACTION_REQUEST_FALLBACK_V2);
}

const repeatedPendingFallback = await coordinateRecoveryV2({
  frame: servicePendingFrame,
  fallbackIntent: 'ANSWER_TO_PENDING',
  primaryResult: invalidEnvelope,
  boundaryContext: {
    servicesResult,
    sourceInboundText: 'pode ser drenagem?',
    currentInboundIds: [inboundId],
    inboundTextsById: { [inboundId]: 'pode ser drenagem?' },
    recentAssistantReplies: [
      'Qual serviço você prefere: Drenagem, Peeling Facial?',
    ],
  },
  toolTrace: [],
  regenerate: failedRegen,
});
assert.equal(repeatedPendingFallback.status, 'accepted');
if (repeatedPendingFallback.status === 'accepted') {
  assert.equal(
    repeatedPendingFallback.payload,
    ANSWER_TO_PENDING_FALLBACK_V2,
    'anti-repetição troca a pergunta recém-entregue pela copy de ANSWER_TO_PENDING'
  );
}

const confirmationPendingFrame = frameWithPending('CONFIRMATION', [
  {
    position: 1,
    entityId: 'booking-confirmation:flow-fallback-intent',
    displayName: 'Confirmar Drenagem amanhã às 15h',
  },
]);

assert.equal(
  classify('sim?', confirmationPendingFrame),
  'ANSWER_TO_PENDING',
  'afirmativo compacto com ? na CONFIRMATION não vira pergunta informacional'
);
assert.equal(
  classify('pode ser?', confirmationPendingFrame),
  'ANSWER_TO_PENDING'
);
assert.equal(
  classify('ok?', confirmationPendingFrame),
  'ANSWER_TO_PENDING'
);

const answeredConfirmation = await recover({
  inboundText: 'sim?',
  frame: confirmationPendingFrame,
  primaryResult: invalidEnvelope,
});
assert.equal(answeredConfirmation.status, 'accepted');
if (answeredConfirmation.status === 'accepted') {
  assert.equal(
    answeredConfirmation.payload,
    'Você confirma essa opção?',
    'CONFIRMATION + sim? reancora a moldura, não a copy de pergunta'
  );
  assert.notEqual(
    answeredConfirmation.payload,
    INFORMATION_QUESTION_FALLBACK_V2
  );
}

console.log('smoke ana conversational v2 fallback intent: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
