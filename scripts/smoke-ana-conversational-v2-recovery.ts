import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  FlatModelTurnV2,
  DeliveryPreemptionV2,
  ModelTurnResultV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import {
  parseModelTurnResultV2,
  type ModelResultValidationContextV2,
  type ModelTurnResultV2ParseResult,
} from '../src/services/conversationalV2/modelResultParser';
import {
  coordinateRecoveryV2,
  type RecoveryCoordinatorInputV2,
} from '../src/services/conversationalV2/recoveryCoordinator';
import {
  regenerateReceptionistCopyV2,
  type RegenerationResultV2,
} from '../src/services/conversationalV2/regenerator';
import { MODEL_TURN_RESULT_V2_CONTRACT_BLOCK } from '../src/services/conversationalV2/modelResultContract';

const servicesResult: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-marina'],
    },
    {
      id: 'svc-limpeza',
      name: 'Limpeza de pele profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-julia'],
    },
  ],
  professionals: [
    { id: 'prof-julia', name: 'Júlia' },
    { id: 'prof-marina', name: 'Marina' },
  ],
};
const frame: TurnFrameV2 = {
  schemaVersion: 2,
  turnId: 'turn-recovery',
  inputSequence: 1,
  catalogSnapshotHash: 'a'.repeat(64),
  catalogState: 'available',
  humanControl: 'NO_ACTIVE_TAKEOVER',
  currentInboundIds: ['in-current'],
  pending: null,
  flowState: {
    flowId: 'flow-recovery',
    fixedServiceId: 'svc-peeling',
    fixedByProofVersion: { fixedServiceId: 1 },
  },
};
const validationContext: ModelResultValidationContextV2 = {
  frame,
  inboundTextsById: { 'in-current': 'Quero agendar amanhã' },
  catalogEntities: {
    services: servicesResult.services!.map((service) => ({
      id: service.id,
      displayName: service.name,
    })),
    professionals: servicesResult.professionals!.map((professional) => ({
      id: professional.id,
      displayName: professional.name,
    })),
  },
  now: new Date('2026-08-13T15:00:00.000Z'),
};
const safeModelResult: ModelTurnResultV2 = {
  schemaVersion: 2,
  reply: 'Qual dia você prefere?',
  replyPurpose: 'DATE_TIME_QUESTION',
  pendingTransitionCandidate: { kind: 'preserve' },
  resolutionCandidate: null,
  unknownServiceEvidence: null,
};
const safeFlatResult: FlatModelTurnV2 = {
  reply: safeModelResult.reply,
  nextPending: 'PRESERVE',
  chosenOptionText: null,
  unknownServiceText: null,
};
const config = {
  tenantSlug: 'tenant-smoke',
  phoneNumberId: 'PN-SMOKE-V2',
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 600,
  openaiApiKey: 'sk-smoke-not-real',
} as TenantBotConfig;

function completion(
  content: string,
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  finishReason?: 'stop' | 'tool_calls' | 'length'
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'completion-smoke',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason:
          finishReason ?? (toolCalls?.length ? 'tool_calls' : 'stop'),
        logprobs: null,
        message: {
          role: 'assistant',
          content,
          refusal: null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  } as OpenAI.Chat.Completions.ChatCompletion;
}

async function main(): Promise<void> {
let completionCalls = 0;
const regenerated = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: {
      services: servicesResult.services!,
      professionals: servicesResult.professionals!,
    },
    messages: [{ role: 'user', content: 'Quero agendar amanhã' }],
    rejectedCandidate: 'Tem vaga amanhã.',
  },
  reasonCodes: ['UNVERIFIED_AVAILABILITY'],
  validationContext,
  thinkingMode: 'enabled',
  maxTokens: 8_192,
  completionFactory: async (request) => {
    completionCalls += 1;
    assert.deepEqual(request.tools, []);
    assert.equal(request.maxTokens, 8_192);
    assert.equal(request.thinkingMode, 'enabled');
    assert.equal(request.responseFormat, 'json_object');
    assert.equal(
      request.messages.at(-1)?.role === 'system' &&
        typeof request.messages.at(-1)?.content === 'string' &&
        request.messages.at(-1)!.content.endsWith(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK),
      true,
      'regen reutiliza literalmente o bloco textual do contrato'
    );
    assert.equal(
      request.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('UNVERIFIED_AVAILABILITY')
      ),
      true
    );
    return completion(JSON.stringify(safeFlatResult));
  },
});
assert.equal(regenerated.ok, true);
assert.equal(completionCalls, 1);

const emptyPrimaryRegen = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: {
      services: servicesResult.services!,
      professionals: servicesResult.professionals!,
    },
    messages: [{ role: 'user', content: 'Quero agendar amanhã' }],
    rejectedCandidate: '',
  },
  reasonCodes: ['MODEL_RESULT_INVALID'],
  validationContext,
  useJsonObjectResponseFormat: false,
  completionFactory: async (request) => {
    assert.equal(
      request.responseFormat,
      undefined,
      'regen após content vazio não força response_format'
    );
    return completion(
      `Segue a instância final:\n\`\`\`json\n${JSON.stringify(safeFlatResult)}\n\`\`\``
    );
  },
});
assert.equal(
  emptyPrimaryRegen.ok,
  true,
  'regen textual continua submetida ao unwrap e parser plano estrito'
);

const literalR43Copy =
  'A limpeza de pele profunda custa R$ 180,00 e dura 60 minutos. Gostaria de agendar?';
const plainProseRegen = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: {
      services: servicesResult.services!,
      professionals: servicesResult.professionals!,
    },
    messages: [{ role: 'user', content: 'quanto custa a limpeza?' }],
    rejectedCandidate: '{"reply":',
  },
  reasonCodes: ['MODEL_RESULT_INVALID'],
  validationContext,
  completionFactory: async () => completion(literalR43Copy),
});
assert.equal(plainProseRegen.ok, false);
if (!plainProseRegen.ok) {
  assert.equal(plainProseRegen.reasonCode, 'REGEN_MODEL_RESULT_INVALID');
  assert.equal(plainProseRegen.rawReply, literalR43Copy);
  assert.equal(
    plainProseRegen.validationIssues?.some((issue) => issue.code === 'INVALID_JSON'),
    true,
    'regen preserva prosa apenas como copy inválida, sem afrouxar o parser'
  );
}

const truncatedRegen = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: { services: [], professionals: [] },
    messages: [],
    rejectedCandidate: 'candidato',
  },
  reasonCodes: ['MODEL_RESULT_INVALID'],
  validationContext,
  thinkingMode: 'enabled',
  maxTokens: 8_192,
  completionFactory: async () => completion('{"schemaVersion":2', undefined, 'length'),
});
assert.equal(truncatedRegen.ok, false);
if (!truncatedRegen.ok) {
  assert.equal(truncatedRegen.reasonCode, 'REGEN_MODEL_RESULT_INVALID');
  assert.deepEqual(truncatedRegen.validationIssues, [
    { code: 'TRUNCATED_OUTPUT', path: '$' },
  ]);
}

const toolCallResult = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: { services: [], professionals: [] },
    messages: [],
    rejectedCandidate: 'candidato',
  },
  reasonCodes: ['MODEL_RESULT_INVALID'],
  validationContext,
  completionFactory: async (request) => {
    assert.deepEqual(request.tools, []);
    return completion(JSON.stringify(safeFlatResult), [
      {
        id: 'call-forbidden',
        type: 'function',
        function: { name: 'bookAppointment', arguments: '{}' },
      },
    ]);
  },
});
assert.deepEqual(
  toolCallResult.ok ? null : toolCallResult.reasonCode,
  'REGEN_TOOL_CALLS'
);

let providerFailures = 0;
const providerFailure = await regenerateReceptionistCopyV2({
  config,
  snapshot: {
    frame,
    catalogSnapshot: { services: [], professionals: [] },
    messages: [],
    rejectedCandidate: 'candidato',
  },
  reasonCodes: ['MODEL_RESULT_INVALID'],
  validationContext,
  completionFactory: async (request) => {
    providerFailures += 1;
    assert.deepEqual(request.tools, []);
    throw new Error('mock provider failure');
  },
});
assert.equal(providerFailure.ok, false);
assert.equal(providerFailures, 1, 'regen tem zero retries');

function parsed(result: ModelTurnResultV2): ModelTurnResultV2ParseResult {
  return {
    ok: true,
    value: result,
    resolutionProof: null,
    resolutionProofRejections: [],
  };
}

const baseInput = {
  frame,
  fallbackIntent: 'TRANSACTION_REQUEST',
  boundaryContext: {
    servicesResult,
    sourceInboundText: 'Quero agendar amanhã',
    currentInboundIds: ['in-current'],
    inboundTextsById: { 'in-current': 'Quero agendar amanhã' },
  },
} satisfies Pick<
  RecoveryCoordinatorInputV2,
  'frame' | 'fallbackIntent' | 'boundaryContext'
>;

const invalidEnvelope = {
  ok: false as const,
  issues: [{ code: 'INVALID_JSON' as const, path: '$' }],
};

let safePrimaryRegenCalls = 0;
const safePrimaryProse = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: invalidEnvelope,
  unparsedCandidate: 'Qual dia você prefere?',
  toolTrace: [],
  regenerate: async () => {
    safePrimaryRegenCalls += 1;
    throw new Error('copy primária segura não deve regenerar');
  },
});
assert.equal(safePrimaryProse.status, 'accepted');
assert.equal(safePrimaryProse.recoveryKind, 'none');
assert.equal(safePrimaryProse.payload, 'Qual dia você prefere?');
assert.deepEqual(safePrimaryProse.pendingTransitionCandidate, {
  kind: 'preserve',
});
assert.equal(safePrimaryRegenCalls, 0);

let unsafePrimaryRegenCalls = 0;
const unsafePrimaryProse = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: invalidEnvelope,
  unparsedCandidate: 'Tem vaga amanhã.',
  toolTrace: [],
  regenerate: async (reasonCodes) => {
    unsafePrimaryRegenCalls += 1;
    assert.equal(reasonCodes.includes('UNVERIFIED_AVAILABILITY'), true);
    return {
      ok: true,
      result: safeModelResult,
      resolutionProof: null,
      providerCalls: 1,
    };
  },
});
assert.equal(unsafePrimaryRegenCalls, 1);
assert.equal(unsafePrimaryProse.status, 'accepted');
assert.equal(unsafePrimaryProse.recoveryKind, 'regen');

const cleaningFrame: TurnFrameV2 = {
  ...frame,
  flowState: {
    flowId: 'flow-cleaning-price',
    fixedServiceId: 'svc-limpeza',
    fixedByProofVersion: { fixedServiceId: 1 },
  },
};
const safeRegenProse = await coordinateRecoveryV2({
  frame: cleaningFrame,
  boundaryContext: {
    servicesResult,
    sourceInboundText: 'quanto custa a limpeza?',
    currentInboundIds: ['in-current'],
    inboundTextsById: { 'in-current': 'quanto custa a limpeza?' },
  },
  primaryResult: invalidEnvelope,
  unparsedCandidate: '{"reply":',
  toolTrace: [],
  regenerate: async () => ({
    ok: false,
    reasonCode: 'REGEN_MODEL_RESULT_INVALID',
    providerCalls: 1,
    validationIssues: [{ code: 'INVALID_JSON', path: '$' }],
    rawReply: literalR43Copy,
  }),
});
assert.equal(safeRegenProse.status, 'accepted');
assert.equal(safeRegenProse.recoveryKind, 'regen');
assert.equal(safeRegenProse.payload, literalR43Copy);
assert.deepEqual(safeRegenProse.pendingTransitionCandidate, {
  kind: 'preserve',
});

const unsafeRegenProse = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: invalidEnvelope,
  unparsedCandidate: '{"reply":',
  toolTrace: [],
  regenerate: async () => ({
    ok: false,
    reasonCode: 'REGEN_MODEL_RESULT_INVALID',
    providerCalls: 1,
    validationIssues: [{ code: 'INVALID_JSON', path: '$' }],
    rawReply: 'Tem vaga amanhã.',
  }),
});
assert.equal(unsafeRegenProse.status, 'accepted');
assert.equal(unsafeRegenProse.recoveryKind, 'direct_fallback');
assert.notEqual(unsafeRegenProse.payload, 'Tem vaga amanhã.');

let writeExecutions = 0;
const executeWriteOnce = () => {
  writeExecutions += 1;
  return {
    name: 'bookAppointment',
    result: JSON.stringify({ success: true }),
  };
};
const writeTrace = [executeWriteOnce()];
let regenAfterWrite = 0;
const writeRecovery = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: parsed({
    ...safeModelResult,
    reply: 'INTERNAL_HINT: use svc-peeling',
    replyPurpose: 'WRITE_CONFIRMATION',
  }),
  toolTrace: writeTrace,
  regenerate: async () => {
    regenAfterWrite += 1;
    return {
      ok: true,
      result: safeModelResult,
      resolutionProof: null,
      providerCalls: 1,
    };
  },
});
assert.equal(writeRecovery.status, 'accepted');
assert.equal(writeRecovery.recoveryKind, 'canonical_write_confirmation');
assert.equal(writeRecovery.payload.includes('confirmado com sucesso'), true);
assert.equal(regenAfterWrite, 0);
assert.equal(writeExecutions, 1, 'RecoveryCoordinator nunca reexecuta write');

let regenAfterUnparsedWrite = 0;
const unparsedWriteRecovery = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: invalidEnvelope,
  unparsedCandidate: 'Pronto, ficou marcado.',
  toolTrace: writeTrace,
  regenerate: async () => {
    regenAfterUnparsedWrite += 1;
    throw new Error('write success não deve regenerar');
  },
});
assert.equal(unparsedWriteRecovery.status, 'accepted');
assert.equal(
  unparsedWriteRecovery.recoveryKind,
  'canonical_write_confirmation'
);
assert.equal(
  unparsedWriteRecovery.payload.includes('confirmado com sucesso'),
  true
);
assert.equal(regenAfterUnparsedWrite, 0);

const regenRecovery = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: parsed({ ...safeModelResult, reply: 'Tem vaga amanhã.' }),
  toolTrace: [],
  regenerate: async (reasonCodes) => {
    assert.equal(reasonCodes.includes('UNVERIFIED_AVAILABILITY'), true);
    return {
      ok: true,
      result: safeModelResult,
      resolutionProof: null,
      providerCalls: 1,
    };
  },
});
assert.equal(regenRecovery.status, 'accepted');
assert.equal(regenRecovery.recoveryKind, 'regen');
assert.equal(regenRecovery.regenCount, 1);

const personalFrame: TurnFrameV2 = {
  ...frame,
  flowState: { flowId: 'flow-personal-drift', fixedByProofVersion: {} },
};
const personalValidationContext: ModelResultValidationContextV2 = {
  ...validationContext,
  frame: personalFrame,
  inboundTextsById: { 'in-current': 'amanhã é aniversário da minha filha' },
};
const parsePersonal = (result: ModelTurnResultV2): ModelTurnResultV2ParseResult => {
  return {
    ok: true,
    value: result,
    resolutionProof: null,
    resolutionProofRejections: [],
  };
};
let personalRegenCalls = 0;
const personalDriftRecovery = await coordinateRecoveryV2({
  frame: personalFrame,
  fallbackIntent: 'OTHER',
  boundaryContext: {
    servicesResult,
    route: 'model',
    pendingAnaOpen: false,
    sourceInboundText: 'amanhã é aniversário da minha filha',
    currentInboundIds: ['in-current'],
    inboundTextsById: {
      'in-current': 'amanhã é aniversário da minha filha',
    },
  },
  primaryResult: parsePersonal({
    ...safeModelResult,
    reply: 'Que legal! Quer aproveitar e marcar um horário?',
    replyPurpose: 'SERVICE_QUESTION',
  }),
  toolTrace: [],
  regenerate: async (reasonCodes) => {
    personalRegenCalls += 1;
    assert.equal(reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'), true);
    return {
      ok: true,
      providerCalls: 1,
      resolutionProof: null,
      result: {
        ...safeModelResult,
        reply: 'Posso abrir a agenda para você agora.',
        replyPurpose: 'SERVICE_QUESTION',
      },
    };
  },
});
assert.equal(personalRegenCalls, 1);
assert.equal(personalDriftRecovery.status, 'accepted');
assert.equal(personalDriftRecovery.recoveryKind, 'direct_fallback');
assert.ok(personalDriftRecovery.payload.trim().length > 0);
assert.ok(regenRecovery.payload.trim());

const failedRegen: RegenerationResultV2 = {
  ok: false,
  reasonCode: 'REGEN_MODEL_RESULT_INVALID',
  providerCalls: 1,
};
const directFallback = await coordinateRecoveryV2({
  ...baseInput,
  primaryResult: {
    ok: false,
    issues: [{ code: 'INVALID_JSON', path: '$' }],
  },
  toolTrace: [],
  regenerate: async () => failedRegen,
});
assert.equal(directFallback.status, 'accepted');
assert.equal(directFallback.recoveryKind, 'direct_fallback');
assert.ok(directFallback.payload.trim());

for (const rejectedReply of [
  'Não fazemos Botox.',
  'Fazemos Botox.',
  'Tem vaga amanhã.',
  'Está cheio hoje.',
  'Te aguardo às oito amanhã.',
  'A Marina vai te atender.',
  'Temos Peeling Facial e Drenagem. Qual você prefere?',
]) {
  const recovered = await coordinateRecoveryV2({
    ...baseInput,
    primaryResult: parsed({ ...safeModelResult, reply: rejectedReply }),
    toolTrace: [],
    regenerate: async () => failedRegen,
  });
  assert.equal(recovered.status, 'accepted', rejectedReply);
  assert.ok(recovered.payload.trim(), rejectedReply);
}

const preemptions: DeliveryPreemptionV2[] = [
  'HUMAN_ACTIVE',
  'PAUSE_RECHECK',
  'INBOUND_SUSPENDED',
  'OUTSIDE_HOURS_THROTTLED',
  'TRANSPORT_OUTCOME_UNKNOWN',
  'SUPERSEDED_BY_NEW_INBOUND',
];
for (const preemption of preemptions) {
  const preempted = await coordinateRecoveryV2({
    ...baseInput,
    primaryResult: parsed(safeModelResult),
    toolTrace: [],
    preemption,
    regenerate: async () => {
      throw new Error('regen não pode ocorrer após preempção');
    },
  });
  assert.equal(preempted.status, 'preempted');
  assert.equal(preempted.payload, null);
}

const pendingFrame: TurnFrameV2 = {
  ...frame,
  pending: {
    questionId: 'question-date',
    askedAt: '2026-08-13T14:30:00.000Z',
    kind: 'DATE',
    flowId: 'flow-recovery',
    version: 1,
    options: [{ position: 1, entityId: 'date-open', displayName: 'dia desejado' }],
  },
};
const pendingFallback = await coordinateRecoveryV2({
  ...baseInput,
  frame: pendingFrame,
  fallbackIntent: 'OTHER',
  primaryResult: {
    ok: false,
    issues: [{ code: 'INVALID_JSON', path: '$' }],
  },
  toolTrace: [],
  regenerate: async () => failedRegen,
});
assert.equal(pendingFallback.status, 'accepted');
assert.equal(pendingFallback.payload, 'Qual dia você prefere?');

console.log('smoke ana conversational v2 recovery: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
