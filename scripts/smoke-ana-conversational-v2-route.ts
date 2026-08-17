import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  FlatModelTurnV2,
  ModelTurnResultV2,
  PendingFrameSnapshotV2,
} from '../src/services/conversationalV2/contracts';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import { serializeTurnPlanReceiptV2 } from '../src/services/conversationalV2/receipts';
import {
  __strictOrdinalForSmokeV2,
  resolveInitialServiceQuestionFastPathV2,
  resolveSelectionFastPathV2,
} from '../src/services/conversationalV2/fastPaths';
import {
  __enforceCanonicalTimeSummaryTransitionForSmokeV2,
  getReceptionistReplyV2,
  __v2RulesPromptForSmoke,
} from '../src/services/conversationalV2/runtime';
import {
  MemoryConversationalV2StateStore,
  SUCCESSOR_REARM_DEBOUNCE_MS_V2,
  type PendingFrameRecordV2,
} from '../src/services/conversationalV2/stateStore';
import {
  executeReceptionistFunction,
  runReceptionistModelLoop,
} from '../src/services/brainService';
import {
  bookingConfirmationGate,
  CONFIRMATION_HINT,
  ENABLE_V2_SCOPED_MODAL_ECHO_CONFIRMATION,
  hasTypedNoConflictPreflightEvidenceV2,
  matchesScopedV2ModalEchoConfirmation,
} from '../src/services/bookingConfirmationGate';
import {
  MODEL_TURN_RESULT_V2_BOOKING_RULE,
  MODEL_TURN_RESULT_V2_CONTRACT_BLOCK,
  MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER,
} from '../src/services/conversationalV2/modelResultContract';
import {
  reduceToolLifecycleV2,
} from '../src/services/conversationalV2/lifecycleReducer';
import {
  buildPendingQuestionV2,
  shouldReanchorPendingQuestionV2,
} from '../src/services/conversationalV2/pendingQuestion';
import { coerceEquivalentOpenTransitionV2 } from '../src/services/conversationalV2/modelResultParser';
import * as handler from '../src/messageHandler';

const now = new Date('2026-08-13T15:00:00.000Z');
let serial = 0;
const nextId = () => `route-v2-${++serial}`;
const config = {
  tenantSlug: 'tenant-v2-route',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-invalid',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'smoke-token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-V2-ROUTE',
  isActive: true,
  authoritativeCatalog: {
    tenant: {
      name: 'Clínica Fixture V2',
      address: 'Avenida Fixture, 123',
      city: 'São Paulo',
      state: 'SP',
    },
    services: [],
    professionals: [],
  },
} as TenantBotConfig;

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 120,
      priceFormatted: 'R$ 120,00',
      professionalIds: ['prof-julia'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 60,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-julia', 'prof-marina'],
    },
    {
      id: 'svc-sem-profissional',
      name: 'Massagem Especial',
      durationMinutes: 30,
      price: 80,
      priceFormatted: 'R$ 80,00',
      professionalIds: [],
    },
  ],
  professionals: [
    { id: 'prof-julia', name: 'Júlia' },
    { id: 'prof-marina', name: 'Marina' },
  ],
};

config.authoritativeCatalog = {
  ...config.authoritativeCatalog,
  services: services.services!.map((service) => ({ ...service })),
  professionals: services.professionals!.map((professional) => ({
    ...professional,
  })),
};

function pending(input: {
  askedAt?: string;
  options?: PendingFrameSnapshotV2['options'];
  kind?: PendingFrameSnapshotV2['kind'];
} = {}): PendingFrameSnapshotV2 {
  return {
    questionId: nextId(),
    askedAt: input.askedAt ?? '2026-08-13T14:00:00.000Z',
    kind: input.kind ?? 'SERVICE',
    flowId: nextId(),
    version: 2,
    options: input.options ?? [
      { position: 1, entityId: 'svc-drenagem', displayName: 'Drenagem Linfática' },
      { position: 2, entityId: 'svc-peeling', displayName: 'Peeling Facial' },
    ],
  };
}

function seedPending(
  store: MemoryConversationalV2StateStore,
  conversationKey: string,
  snapshot: PendingFrameSnapshotV2,
  flowState: PendingFrameRecordV2['flowState'] = {
    flowId: snapshot.flowId,
    fixedByProofVersion: {},
  }
): void {
  store.pending.set(conversationKey, [
    {
      conversationKey,
      state: 'OPEN',
      snapshot,
      flowState,
      updatedAt: snapshot.askedAt,
    },
  ]);
}

function completion(input: {
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  callId?: string;
  finishReason?: 'stop' | 'tool_calls' | 'length';
}): OpenAI.Chat.Completions.ChatCompletion {
  const toolCalls = input.toolName
    ? [
        {
          id: input.callId ?? nextId(),
          type: 'function' as const,
          function: {
            name: input.toolName,
            arguments: JSON.stringify(input.args ?? {}),
          },
        },
      ]
    : undefined;
  return {
    id: nextId(),
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason:
          input.finishReason ?? (toolCalls ? 'tool_calls' : 'stop'),
        logprobs: null,
        message: {
          role: 'assistant',
          content: input.content ?? null,
          refusal: null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function modelResult(overrides: Partial<ModelTurnResultV2> = {}): ModelTurnResultV2 {
  return {
    schemaVersion: 2,
    reply: 'Qual serviço você prefere: Drenagem Linfática ou Peeling Facial?',
    replyPurpose: 'SERVICE_QUESTION',
    pendingTransitionCandidate: {
      kind: 'open',
      pendingKind: 'SERVICE',
      flowId: overrides.pendingTransitionCandidate?.kind === 'open'
        ? overrides.pendingTransitionCandidate.flowId
        : 'flow-model',
      optionEntityIds: ['svc-drenagem', 'svc-peeling'],
    },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
    ...overrides,
  };
}

function flatResult(overrides: Partial<FlatModelTurnV2> = {}): FlatModelTurnV2 {
  return {
    reply: 'Qual serviço você prefere: Drenagem Linfática ou Peeling Facial?',
    nextPending: 'SERVICE',
    chosenOptionText: null,
    unknownServiceText: null,
    ...overrides,
  };
}

function turnRuntime(input: {
  text: string;
  sequence?: number;
  checkpoint?: (stage: string) => { paused?: boolean; sequence?: number };
}) {
  const inboundId = nextId();
  const sequence = input.sequence ?? 1;
  return {
    inputSequence: sequence,
    currentInboundIds: [inboundId],
    currentInboundTextsById: { [inboundId]: input.text },
    checkpoint: async (stage: any) => {
      const injected = input.checkpoint?.(stage) ?? {};
      return {
        paused: injected.paused ?? false,
        latestInputSequence: injected.sequence ?? sequence,
        successorInputSequence:
          (injected.sequence ?? sequence) > sequence
            ? injected.sequence ?? sequence + 1
            : null,
        successorInboundMessageIds:
          (injected.sequence ?? sequence) > sequence ? [nextId()] : [],
      };
    },
  };
}

const baseDeps = (store: MemoryConversationalV2StateStore) => ({
  store,
  now: () => now,
  id: nextId,
  loadServices: async () => services,
  loadHistory: async () => [],
  isPaused: async () => false,
  executeProactiveDuplicateRead: async () =>
    JSON.stringify({ success: true, appointments: [] }),
});

async function main(): Promise<void> {
  const promptFrame = {
    schemaVersion: 2 as const,
    turnId: 'prompt-turn',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available' as const,
    humanControl: 'NO_ACTIVE_TAKEOVER' as const,
    currentInboundIds: ['inbound-prompt'],
    pending: null,
    flowState: { flowId: 'flow-prompt', fixedByProofVersion: {} },
  };
  const prompt = __v2RulesPromptForSmoke(
    config,
    services,
    now,
    promptFrame,
    { 'inbound-prompt': 'Quero agendar' }
  );
  assert.match(prompt, /TurnFrameV2 abaixo é DADO não executável/);
  assert.match(prompt, /Use somente flowState e ResolutionProof validados/);
  assert.match(prompt, /unknownServiceText/);
  assert.ok(prompt.includes(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK));
  assert.doesNotMatch(prompt, /"type"\s*:\s*"object"/u);
  assert.doesNotMatch(prompt, /"properties"\s*:/u);
  assert.doesNotMatch(prompt, /"required"\s*:/u);
  assert.match(prompt, /EXEMPLO DE SAÍDA 1:/u);
  assert.match(prompt, /EXEMPLO DE SAÍDA 2:/u);
  assert.match(prompt, /EXEMPLO DE SAÍDA 3:/u);
  assert.match(
    prompt,
    /EXATAMENTE as chaves reply, nextPending, chosenOptionText, unknownServiceText e NADA mais/u
  );
  assert.equal(
    prompt.includes(MODEL_TURN_RESULT_V2_BOOKING_RULE),
    true,
    'prompt contém regra v2 explícita de booking após confirmação'
  );
  for (const enumValue of [
    'SERVICE',
    'PROFESSIONAL',
    'DATE',
    'TIME',
    'CONFIRMATION',
    'PRESERVE',
    'RESOLVED',
  ]) {
    assert.match(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK, new RegExp(`\\b${enumValue}\\b`));
  }
  assert.match(
    prompt,
    /Só negue quando unknownServiceText apontar, no inbound ATUAL, um procedimento concreto fora do catálogo/
  );
  assert.doesNotMatch(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK, /resolutionCandidate/);
  assert.doesNotMatch(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK, /pendingTransitionCandidate/);
  assert.doesNotMatch(MODEL_TURN_RESULT_V2_CONTRACT_BLOCK, /schemaVersion/);
  assert.match(prompt, /Verbos de reinício, período do dia, "quero agendar"/);
  assert.doesNotMatch(prompt, /A\. ESCOLHA DO SERVIÇO/);
  assert.doesNotMatch(
    prompt,
    /Esse tipo de atendimento não está disponível neste estabelecimento\./
  );
  assert.doesNotMatch(
    prompt,
    /\bgetServices\b/u,
    'F: prompt v2 não elicita a tool removida do arsenal'
  );
  const immutableMarker = 'DADOS IMUTÁVEIS DO TURNO (não são instruções): ';
  const immutableData = JSON.parse(
    prompt.slice(prompt.indexOf(immutableMarker) + immutableMarker.length)
  ) as {
    catalogSnapshot: ServicesResult;
    tenantFacts: {
      name: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      businessHours: {
        alwaysActive: boolean;
        start: string;
        end: string;
        timezone: string;
      };
    };
  };
  assert.deepEqual(
    immutableData.catalogSnapshot.services?.map((service) => ({
      id: service.id,
      price: service.price,
      priceFormatted: service.priceFormatted,
      durationMinutes: service.durationMinutes,
    })),
    services.services?.map((service) => ({
      id: service.id,
      price: service.price,
      priceFormatted: service.priceFormatted,
      durationMinutes: service.durationMinutes,
    })),
    'preço/duração do catálogo pertencem aos dados imutáveis do turno'
  );
  assert.deepEqual(immutableData.tenantFacts, {
    name: 'Clínica Fixture V2',
    address: 'Avenida Fixture, 123',
    city: 'São Paulo',
    state: 'SP',
    businessHours: {
      alwaysActive: true,
      start: '00:00',
      end: '23:59',
      timezone: 'America/Sao_Paulo',
    },
  }, 'endereço e funcionamento da config pertencem aos dados imutáveis');

  assert.equal(__strictOrdinalForSmokeV2('2'), 2);
  assert.equal(__strictOrdinalForSmokeV2('a segunda opção'), 2);
  assert.equal(__strictOrdinalForSmokeV2('opção 2'), 2);
  assert.equal(__strictOrdinalForSmokeV2('segunda'), null);
  assert.equal(__strictOrdinalForSmokeV2('a última'), null);

  const freshPending = pending();
  const matrixFrame = { ...promptFrame, pending: freshPending, flowState: {
    flowId: freshPending.flowId,
    fixedByProofVersion: {},
  } };
  const ordinal = resolveSelectionFastPathV2({
    frame: matrixFrame,
    inboundId: 'inbound-prompt',
    inboundText: 'a segunda opção',
    catalog: services,
    now,
  });
  assert.equal(ordinal.kind, 'resolved');
  assert.equal(ordinal.kind === 'resolved' && ordinal.proof.kind, 'pending_option');
  assert.equal(
    resolveSelectionFastPathV2({
      frame: matrixFrame,
      inboundId: 'inbound-prompt',
      inboundText: 'segunda',
      catalog: services,
      now,
    }).kind,
    'continue_model'
  );
  const stale = resolveSelectionFastPathV2({
    frame: {
      ...matrixFrame,
      pending: { ...freshPending, askedAt: '2026-08-13T09:00:00.000Z' },
    },
    inboundId: 'inbound-prompt',
    inboundText: '2',
    catalog: services,
    now,
  });
  assert.equal(stale.kind, 'continue_model');

  const denajemFastPath = resolveSelectionFastPathV2({
    frame: matrixFrame,
    inboundId: 'inbound-denajem',
    inboundText: 'denajem',
    catalog: services,
    now,
  });
  assert.equal(
    denajemFastPath.kind,
    'resolved',
    'resposta curta à pergunta SERVICE reutiliza o matcher D compartilhado'
  );
  if (denajemFastPath.kind === 'resolved') {
    assert.equal(denajemFastPath.proof.kind, 'pending_option');
    assert.equal(denajemFastPath.proof.entityId, 'svc-drenagem');
    assert.equal(denajemFastPath.nextFlowState.fixedServiceId, 'svc-drenagem');
  }
  assert.equal(
    resolveSelectionFastPathV2({
      frame: matrixFrame,
      inboundId: 'inbound-denajem-negated',
      inboundText: 'não denajem',
      catalog: services,
      now,
    }).kind,
    'continue_model',
    'typo distância 2 nunca vence polaridade negativa'
  );

  const deterministicServiceQuestion = resolveInitialServiceQuestionFastPathV2({
    frame: promptFrame,
    inboundText: 'Quero agendar',
    catalog: services,
    now,
  });
  assert.equal(deterministicServiceQuestion.kind, 'resolved');
  if (deterministicServiceQuestion.kind === 'resolved') {
    assert.equal(
      deterministicServiceQuestion.result.pendingTransitionCandidate.kind === 'open' &&
        deterministicServiceQuestion.result.pendingTransitionCandidate.pendingKind,
      'SERVICE'
    );
    assert.deepEqual(
      deterministicServiceQuestion.result.pendingTransitionCandidate.kind === 'open'
        ? deterministicServiceQuestion.result.pendingTransitionCandidate.optionEntityIds
        : [],
      services.services!.map((service) => service.id)
    );
  }
  for (const [label, inboundText, catalog] of [
    ['negação', 'não quero agendar', services],
    ['serviço resolvido', 'quero agendar Peeling Facial', services],
    [
      'catálogo unitário',
      'quero agendar',
      { ...services, services: [services.services![0]!] },
    ],
  ] as const) {
    assert.equal(
      resolveInitialServiceQuestionFastPathV2({
        frame: promptFrame,
        inboundText,
        catalog,
        now,
      }).kind,
      'continue_model',
      label
    );
  }

  const timePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
      { position: 3, entityId: '17:00', displayName: '17:00' },
    ],
  });
  const timeFastPath = resolveSelectionFastPathV2({
    frame: {
      ...promptFrame,
      pending: timePending,
      flowState: {
        flowId: timePending.flowId,
        fixedServiceId: 'svc-drenagem',
        fixedProfessionalId: 'prof-julia',
        resolvedDate: '2026-08-14',
        slotEvidence: {
          turnId: 'turn-slot-evidence',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          slots: ['14:00', '15:00', '17:00'],
        },
        fixedByProofVersion: {
          fixedServiceId: 1,
          fixedProfessionalId: 1,
          resolvedDate: 1,
        },
      },
    },
    inboundId: 'inbound-prompt',
    inboundText: 'pode ser às 15h',
    catalog: services,
    now,
  });
  assert.equal(timeFastPath.kind, 'resolved');
  if (timeFastPath.kind === 'resolved') {
    assert.equal(timeFastPath.result.replyPurpose, 'WRITE_CONFIRMATION');
    assert.equal(
      timeFastPath.result.pendingTransitionCandidate.kind === 'open' &&
        timeFastPath.result.pendingTransitionCandidate.pendingKind,
      'CONFIRMATION'
    );
    assert.deepEqual(timeFastPath.nextFlowState.bookingDraft, {
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      time: '15:00',
      slotEvidenceTurnId: 'turn-slot-evidence',
    });
    assert.match(timeFastPath.result.reply, /Confirmando: Drenagem Linfática/);
  }

  for (const [inboundText, expectedTime] of [
    ['pode ser às 15', '15:00'],
    ['as 15', '15:00'],
    ['15', '15:00'],
    ['as 17', '17:00'],
    ['17', '17:00'],
    ['17h', '17:00'],
  ] as const) {
    const bareTimeFastPath = resolveSelectionFastPathV2({
      frame: {
        ...promptFrame,
        pending: timePending,
        flowState: {
          flowId: timePending.flowId,
          fixedServiceId: 'svc-drenagem',
          fixedProfessionalId: 'prof-julia',
          resolvedDate: '2026-08-14',
          slotEvidence: {
            turnId: 'turn-slot-evidence',
            serviceId: 'svc-drenagem',
            professionalId: 'prof-julia',
            date: '2026-08-14',
            slots: ['14:00', '15:00', '17:00'],
          },
          fixedByProofVersion: {
            fixedServiceId: 1,
            fixedProfessionalId: 1,
            resolvedDate: 1,
          },
        },
      },
      inboundId: 'inbound-prompt',
      inboundText,
      catalog: services,
      now,
    });
    assert.equal(bareTimeFastPath.kind, 'resolved', inboundText);
    if (bareTimeFastPath.kind === 'resolved') {
      assert.equal(
        bareTimeFastPath.nextFlowState.bookingDraft?.time,
        expectedTime
      );
      assert.deepEqual(
        bareTimeFastPath.result.pendingTransitionCandidate.kind === 'open'
          ? bareTimeFastPath.result.pendingTransitionCandidate.pendingKind
          : null,
        'CONFIRMATION'
      );
    }
  }

  const ambiguousBareTime = resolveSelectionFastPathV2({
    frame: {
      ...promptFrame,
      pending: {
        ...timePending,
        options: [
          { position: 1, entityId: '15:00', displayName: '15:00' },
          { position: 2, entityId: '15:30', displayName: '15:30' },
        ],
      },
      flowState: {
        flowId: timePending.flowId,
        fixedServiceId: 'svc-drenagem',
        fixedProfessionalId: 'prof-julia',
        resolvedDate: '2026-08-14',
        slotEvidence: {
          turnId: 'turn-slot-evidence-ambiguous',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          slots: ['15:00', '15:30'],
        },
        fixedByProofVersion: {
          fixedServiceId: 1,
          fixedProfessionalId: 1,
          resolvedDate: 1,
        },
      },
    },
    inboundId: 'inbound-prompt',
    inboundText: '15',
    catalog: services,
    now,
  });
  assert.equal(
    ambiguousBareTime.kind,
    'resolved',
    '15:00 e 15:30 tornam "15" uma clarificação determinística'
  );
  if (ambiguousBareTime.kind === 'resolved') {
    assert.equal(ambiguousBareTime.proof, null);
    assert.equal(ambiguousBareTime.result.reply, '15h ou 15h30?');
    assert.deepEqual(
      ambiguousBareTime.result.pendingTransitionCandidate,
      {
        kind: 'open',
        pendingKind: 'TIME',
        flowId: timePending.flowId,
        optionEntityIds: ['15:00', '15:30'],
        forceSupersede: 'time_disambiguation',
      }
    );
    assert.equal(ambiguousBareTime.nextFlowState.bookingDraft, undefined);
  }

  const ambiguousTimeFrame = {
    ...promptFrame,
    pending: {
      ...timePending,
      options: [
        { position: 1, entityId: '17:00', displayName: '17:00' },
        { position: 2, entityId: '17:30', displayName: '17:30' },
      ],
    },
    flowState: {
      flowId: timePending.flowId,
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-julia',
      resolvedDate: '2026-08-14',
      slotEvidence: {
        turnId: 'turn-slot-evidence-half-hour',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-julia',
        date: '2026-08-14',
        slots: ['17:00', '17:30'],
      },
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    },
  };
  for (const [inboundText, lastReply, expectedTime] of [
    ['17h', undefined, '17:00'],
    ['17h30', undefined, '17:30'],
    ['17 e meia', undefined, '17:30'],
    ['17', '17h ou 17h30?', '17:00'],
    ['meia', '17h ou 17h30?', '17:30'],
    ['e meia', '17h ou 17h30?', '17:30'],
    ['30', '17h ou 17h30?', '17:30'],
  ] as const) {
    const resolved = resolveSelectionFastPathV2({
      frame: ambiguousTimeFrame,
      inboundId: 'inbound-half-hour',
      inboundText,
      catalog: services,
      now,
      lastAcceptedAssistantText: lastReply,
    });
    assert.equal(resolved.kind, 'resolved', inboundText);
    if (resolved.kind === 'resolved') {
      assert.equal(resolved.nextFlowState.bookingDraft?.time, expectedTime);
      assert.equal(resolved.result.replyPurpose, 'WRITE_CONFIRMATION');
    }
  }

  const repeatedTimeClarification = resolveSelectionFastPathV2({
    frame: ambiguousTimeFrame,
    inboundId: 'inbound-half-hour-loop',
    inboundText: 'as 17',
    catalog: services,
    now,
    lastAcceptedAssistantText: '17h ou 17h30?',
  });
  assert.deepEqual(repeatedTimeClarification, {
    kind: 'continue_model',
    reason: 'repeated_time_clarification_requires_model',
  });

  assert.equal(
    shouldReanchorPendingQuestionV2({
      pending: ambiguousTimeFrame.pending,
      flowState: ambiguousTimeFrame.flowState,
      lastAcceptedTerminalAt: new Date(now.getTime() - 16 * 60 * 1000).toISOString(),
      now,
      explicitRestart: false,
    }),
    true,
    'gap maior que 15 minutos reancora TIME do mesmo fluxo'
  );
  assert.equal(
    shouldReanchorPendingQuestionV2({
      pending: ambiguousTimeFrame.pending,
      flowState: ambiguousTimeFrame.flowState,
      lastAcceptedTerminalAt: now.toISOString(),
      now,
      explicitRestart: true,
    }),
    true,
    'reinício explícito reancora TIME do mesmo fluxo'
  );
  assert.equal(
    buildPendingQuestionV2({
      pending: ambiguousTimeFrame.pending,
      flowState: ambiguousTimeFrame.flowState,
      catalog: services,
      reanchor: true,
    }),
    'A gente estava marcando Drenagem Linfática para 14/08/2026 — qual horário você prefere?'
  );

  const nakedTimeOrdinal = resolveSelectionFastPathV2({
    frame: {
      ...promptFrame,
      pending: timePending,
      flowState: {
        flowId: timePending.flowId,
        fixedServiceId: 'svc-drenagem',
        fixedProfessionalId: 'prof-julia',
        resolvedDate: '2026-08-14',
        slotEvidence: {
          turnId: 'turn-slot-evidence',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          slots: ['14:00', '15:00', '17:00'],
        },
        fixedByProofVersion: {
          fixedServiceId: 1,
          fixedProfessionalId: 1,
          resolvedDate: 1,
        },
      },
    },
    inboundId: 'inbound-time-naked-ordinal',
    inboundText: '2',
    catalog: services,
    now,
  });
  assert.equal(
    nakedTimeOrdinal.kind,
    'continue_model',
    'dígito nu em TIME nunca significa posição ordinal'
  );
  const explicitTimeOrdinal = resolveSelectionFastPathV2({
    frame: {
      ...promptFrame,
      pending: timePending,
      flowState: {
        flowId: timePending.flowId,
        fixedServiceId: 'svc-drenagem',
        fixedProfessionalId: 'prof-julia',
        resolvedDate: '2026-08-14',
        slotEvidence: {
          turnId: 'turn-slot-evidence',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          slots: ['14:00', '15:00', '17:00'],
        },
        fixedByProofVersion: {
          fixedServiceId: 1,
          fixedProfessionalId: 1,
          resolvedDate: 1,
        },
      },
    },
    inboundId: 'inbound-time-explicit-ordinal',
    inboundText: 'opção 2',
    catalog: services,
    now,
  });
  assert.equal(explicitTimeOrdinal.kind, 'resolved');
  if (explicitTimeOrdinal.kind === 'resolved') {
    assert.equal(explicitTimeOrdinal.nextFlowState.bookingDraft?.time, '15:00');
  }

  const reducerSlots = reduceToolLifecycleV2({
    frame: promptFrame,
    services,
    sourceInboundText: 'obrigada, e amanhã?',
    toolTrace: [
      {
        round: 1,
        name: 'getAvailableSlots',
        args: {
          date: '2026-08-14',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
        },
        argumentsValidJson: true,
        result: JSON.stringify({ success: true, slots: ['14:00', '15:00'] }),
      },
    ],
  });
  assert.equal(reducerSlots?.kind, 'canonical_slots');
  assert.equal(
    reducerSlots?.result.pendingTransitionCandidate.kind === 'open' &&
      reducerSlots.result.pendingTransitionCandidate.pendingKind,
    'TIME'
  );
  assert.deepEqual(reducerSlots?.nextFlowState.slotEvidence?.slots, ['14:00', '15:00']);
  assert.match(
    reducerSlots?.result.reply ?? '',
    /^Obrigada! Encontrei horários para 14\/08\/2026:/,
    'oferta canônica inclui a data civil legível'
  );

  // A3 kill: TIME de hoje nunca pode sobreviver a uma leitura nova de amanhã.
  const todayTimePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
      { position: 3, entityId: '17:00', displayName: '17:00' },
    ],
  });
  const todayTimeFrame = {
    ...promptFrame,
    pending: todayTimePending,
    flowState: {
      flowId: todayTimePending.flowId,
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-julia',
      resolvedDate: '2026-08-13',
      slotEvidence: {
        turnId: 'turn-slots-today',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-julia',
        date: '2026-08-13',
        slots: ['14:00', '15:00', '17:00'],
      },
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    },
  } as const;
  const tomorrowSlots = reduceToolLifecycleV2({
    frame: todayTimeFrame,
    services,
    sourceInboundText: 'na verdade amanhã',
    toolTrace: [
      {
        round: 1,
        name: 'getAvailableSlots',
        args: {
          date: '2026-08-14',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
        },
        argumentsValidJson: true,
        result: JSON.stringify({ success: true, slots: ['09:00', '10:30'] }),
      },
    ],
  });
  assert.equal(tomorrowSlots?.kind, 'canonical_slots');
  const tomorrowCandidate = coerceEquivalentOpenTransitionV2(
    tomorrowSlots!.result.pendingTransitionCandidate,
    todayTimeFrame,
    tomorrowSlots!.nextFlowState
  );
  assert.equal(
    tomorrowCandidate.kind,
    'open',
    'opções/flowState de amanhã supersedem o TIME OPEN de hoje'
  );
  if (tomorrowCandidate.kind === 'open') {
    const tomorrowFrame = {
      ...todayTimeFrame,
      pending: {
        questionId: 'question-time-tomorrow',
        askedAt: now.toISOString(),
        kind: tomorrowCandidate.pendingKind,
        flowId: tomorrowCandidate.flowId,
        version: todayTimePending.version + 1,
        options: tomorrowCandidate.optionEntityIds.map((entityId, index) => ({
          position: index + 1,
          entityId,
          displayName: entityId,
        })),
      },
      flowState: tomorrowSlots!.nextFlowState,
    };
    const prohibitedBareOrdinal = resolveSelectionFastPathV2({
      frame: tomorrowFrame,
      inboundId: 'inbound-prompt',
      inboundText: 'o primeiro',
      catalog: services,
      now,
    });
    assert.equal(
      prohibitedBareOrdinal.kind,
      'continue_model',
      'a sequência exata não pode resolver silenciosamente o snapshot velho; D2 exige "opção"'
    );
    const firstTomorrow = resolveSelectionFastPathV2({
      frame: tomorrowFrame,
      inboundId: 'inbound-prompt',
      inboundText: 'a primeira opção',
      catalog: services,
      now,
    });
    assert.equal(firstTomorrow.kind, 'resolved');
    if (firstTomorrow.kind === 'resolved') {
      assert.equal(firstTomorrow.nextFlowState.bookingDraft?.date, '2026-08-14');
      assert.equal(firstTomorrow.nextFlowState.bookingDraft?.time, '09:00');
      assert.notEqual(firstTomorrow.nextFlowState.bookingDraft?.time, '14:00');
    }
  }

  const autoProfessionalSlots = reduceToolLifecycleV2({
    frame: promptFrame,
    services,
    toolTrace: [
      {
        round: 1,
        name: 'getAvailableSlots',
        args: { date: '2026-08-14', serviceId: 'svc-peeling' },
        argumentsValidJson: true,
        result: JSON.stringify({
          success: true,
          professionalId: 'prof-marina',
          slots: ['14:00'],
        }),
      },
    ],
  });
  assert.equal(autoProfessionalSlots?.nextFlowState.fixedProfessionalId, 'prof-marina');
  assert.equal(
    autoProfessionalSlots?.nextFlowState.slotEvidence?.professionalId,
    'prof-marina',
    'reducer usa a profissional autoritativa retornada no auto-resolve'
  );

  const reducerWrite = reduceToolLifecycleV2({
    frame: {
      ...promptFrame,
      pending: timePending,
      flowState: {
        flowId: timePending.flowId,
        fixedServiceId: 'svc-drenagem',
        fixedProfessionalId: 'prof-julia',
        resolvedDate: '2026-08-14',
        bookingDraft: {
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          time: '15:00',
          slotEvidenceTurnId: 'turn-slot-evidence',
        },
        fixedByProofVersion: {
          fixedServiceId: 1,
          fixedProfessionalId: 1,
          resolvedDate: 1,
        },
      },
    },
    services,
    toolTrace: [
      {
        round: 1,
        name: 'bookAppointment',
        args: {
          date: '2026-08-14',
          time: '15:00',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
        },
        argumentsValidJson: true,
        result: JSON.stringify({ success: true }),
      },
    ],
  });
  assert.equal(reducerWrite?.kind, 'canonical_write');
  assert.equal(reducerWrite?.result.pendingTransitionCandidate.kind, 'resolve');
  assert.equal(reducerWrite?.nextFlowState.bookingDraft, undefined);
  assert.match(reducerWrite?.result.reply ?? '', /confirmado com sucesso/i);

  const k7Draft = {
    serviceId: 'svc-drenagem',
    professionalId: 'prof-julia',
    date: '2026-08-14',
    time: '15:00',
    slotEvidenceTurnId: 'turn-slot-evidence',
  } as const;
  const k7Args = {
    serviceId: k7Draft.serviceId,
    professionalId: k7Draft.professionalId,
    date: k7Draft.date,
    time: k7Draft.time,
  };
  for (const [label, pendingSnapshot, args] of [
    [
      'pending DATE',
      { ...timePending, kind: 'DATE' as const },
      k7Args,
    ],
    [
      'CONFIRMATION de outro flowId',
      { ...timePending, kind: 'CONFIRMATION' as const, flowId: 'outro-flow' },
      k7Args,
    ],
    [
      'CONFIRMATION de duplicidade',
      {
        ...timePending,
        kind: 'CONFIRMATION' as const,
        options: [
          {
            position: 1,
            entityId: 'duplicate-resolution:keep-both',
            displayName: 'manter os dois',
          },
        ],
      },
      k7Args,
    ],
    [
      'argumento diverge do BookingDraftV2',
      { ...timePending, kind: 'CONFIRMATION' as const },
      { ...k7Args, time: '14:00' },
    ],
  ] as const) {
    const blocked = JSON.parse(
      await executeReceptionistFunction(
        'bookAppointment',
        { ...args },
        '5511000000000',
        'Cliente',
        config,
        'sim, pode marcar',
        ['sim, pode marcar'],
        [],
        services,
        `k7-${label}`,
        {
          flowState: {
            flowId: timePending.flowId,
            fixedServiceId: k7Draft.serviceId,
            fixedProfessionalId: k7Draft.professionalId,
            bookingDraft: k7Draft,
          },
          pending: pendingSnapshot,
        }
      )
    ) as { success?: unknown; message?: unknown };
    assert.equal(blocked.success, false, label);
    assert.equal(blocked.message, CONFIRMATION_HINT, label);
  }

  for (const [serviceName, expected] of [
    ['Drenagem Linfática', 'DATE'],
    ['Peeling Facial', 'PROFESSIONAL'],
    ['Massagem Especial', 'SERVICE'],
  ] as const) {
    const result = resolveSelectionFastPathV2({
      frame: promptFrame,
      inboundId: 'inbound-prompt',
      inboundText: serviceName,
      catalog: services,
      now,
    });
    assert.equal(result.kind, 'resolved', serviceName);
    assert.equal(
      result.kind === 'resolved' &&
        result.result.pendingTransitionCandidate.kind === 'open' &&
        result.result.pendingTransitionCandidate.pendingKind,
      expected,
      serviceName
    );
  }

  // Replay I1: nome completo em uma pendência entregue fixa o serviço e segue.
  const i1Store = new MemoryConversationalV2StateStore();
  const i1Key = `${config.phoneNumberId}:5511000000001`;
  seedPending(i1Store, i1Key, freshPending);
  i1Store.setInputSequence(i1Key, 1);
  let i1ModelCalls = 0;
  const i1 = await getReceptionistReplyV2({
    phone: '5511000000001',
    userMessage: 'Drenagem Linfática',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Drenagem Linfática' }),
    deps: {
      ...baseDeps(i1Store),
      runModelLoop: async () => {
        i1ModelCalls += 1;
        throw new Error('fast-path não deve chamar modelo');
      },
    },
  });
  assert.equal(i1ModelCalls, 0);
  assert.equal(i1.planReceipt.route, 'fast_path');
  assert.match(i1.payload ?? '', /Qual dia/);
  assert.doesNotMatch(i1.payload ?? '', /não (?:temos|está disponível)/i);

  // Replay canário: o modelo havia devolvido PRESERVE porque o fast-path não
  // ligava a resposta curta ao matcher D. Agora a prova nasce da pendência e o
  // provider não participa.
  const denajemStore = new MemoryConversationalV2StateStore();
  const denajemPhone = '5511000000019';
  const denajemKey = `${config.phoneNumberId}:${denajemPhone}`;
  const denajemPending = pending();
  seedPending(denajemStore, denajemKey, denajemPending);
  denajemStore.setInputSequence(denajemKey, 1);
  let denajemModelCalls = 0;
  const denajemPrepared = await getReceptionistReplyV2({
    phone: denajemPhone,
    userMessage: 'denajem',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'denajem' }),
    deps: {
      ...baseDeps(denajemStore),
      runModelLoop: async () => {
        denajemModelCalls += 1;
        throw new Error('denajem ancorado em SERVICE OPEN não chama modelo');
      },
    },
  });
  assert.equal(denajemModelCalls, 0);
  assert.equal(denajemPrepared.planReceipt.route, 'fast_path');
  assert.equal(
    denajemPrepared.frame.flowState.fixedServiceId,
    'svc-drenagem'
  );
  assert.equal(
    denajemPrepared.transition.kind === 'open' &&
      denajemPrepared.transition.frame.kind,
    'DATE'
  );

  // Replay canário T4: hora nua é preenchida contra TIME OPEN autoritativo; a
  // copy canônica atravessa a boundary usando BookingDraftV2 + slotEvidence.
  const bareTimeStore = new MemoryConversationalV2StateStore();
  const bareTimePhone = '5511000000018';
  const bareTimeKey = `${config.phoneNumberId}:${bareTimePhone}`;
  seedPending(bareTimeStore, bareTimeKey, timePending, {
    flowId: timePending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-slot-evidence-prior',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['14:00', '15:00', '17:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  bareTimeStore.setInputSequence(bareTimeKey, 1);
  let bareTimeModelCalls = 0;
  const bareTimePrepared = await getReceptionistReplyV2({
    phone: bareTimePhone,
    userMessage: 'pode ser às 15',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode ser às 15' }),
    deps: {
      ...baseDeps(bareTimeStore),
      runModelLoop: async () => {
        bareTimeModelCalls += 1;
        throw new Error('hora nua unívoca não deve chamar modelo');
      },
    },
  });
  assert.equal(bareTimeModelCalls, 0);
  assert.equal(bareTimePrepared.planReceipt.route, 'fast_path');
  assert.equal(
    bareTimePrepared.planReceipt.boundaryAttempts.at(-1)?.reasonCodes.length,
    0
  );
  assert.match(bareTimePrepared.payload ?? '', /às 15h/);
  assert.equal(
    bareTimePrepared.transition.kind === 'open' &&
      bareTimePrepared.transition.frame.kind,
    'CONFIRMATION'
  );
  assert.equal(
    bareTimePrepared.frame.flowState.bookingDraft?.slotEvidenceTurnId,
    'turn-slot-evidence-prior'
  );
  await deliverPreparedReceptionistTurnV2(bareTimePrepared, {
    store: bareTimeStore,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  const bareTimeAccepted = await bareTimeStore.loadLatestState(bareTimeKey, now);
  assert.ok(bareTimeAccepted.pending);
  assert.ok(bareTimeAccepted.lastAcceptedDelivery);
  const bareTimeExpectedBooking = {
    date: '2026-08-14',
    time: '15:00',
    serviceName: 'Drenagem Linfática',
    professionalName: 'Júlia',
  };
  assert.deepEqual(
    bookingConfirmationGate({
      currentUserMessage: 'pode',
      history: [
        {
          role: 'assistant',
          content: bareTimeAccepted.lastAcceptedDelivery!.payload,
        },
      ],
      confirmedDuplicate: false,
      expectedBooking: bareTimeExpectedBooking,
      v2ConfirmationContext: {
        pending: bareTimeAccepted.pending!.snapshot,
        flowState: bareTimeAccepted.pending!.flowState,
        catalog: services,
        lastAcceptedDelivery: bareTimeAccepted.lastAcceptedDelivery,
        now,
      },
    }),
    { ok: true, consumesCancellationEvidence: false },
    'resumo entregue e aceito abre a versão que licencia "pode"'
  );
  const bareTimeWrite = reduceToolLifecycleV2({
    frame: {
      ...bareTimePrepared.frame,
      pending: bareTimeAccepted.pending!.snapshot,
      flowState: bareTimeAccepted.pending!.flowState,
    },
    services,
    toolTrace: [
      {
        round: 1,
        name: 'bookAppointment',
        args: {
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          time: '15:00',
        },
        argumentsValidJson: true,
        result: JSON.stringify({ success: true }),
      },
    ],
  });
  assert.equal(bareTimeWrite?.kind, 'canonical_write');
  assert.equal(
    bareTimeWrite?.result.pendingTransitionCandidate.kind,
    'resolve',
    'bookAppointment success fecha a CONFIRMATION do caminho feliz'
  );

  const ambiguousTimeStore = new MemoryConversationalV2StateStore();
  const ambiguousTimePhone = '5511000000021';
  const ambiguousTimeKey = `${config.phoneNumberId}:${ambiguousTimePhone}`;
  const ambiguousTimePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '17:00', displayName: '17:00' },
      { position: 2, entityId: '17:30', displayName: '17:30' },
    ],
  });
  seedPending(ambiguousTimeStore, ambiguousTimeKey, ambiguousTimePending, {
    flowId: ambiguousTimePending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-slot-evidence-ambiguous-runtime',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['17:00', '17:30'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ambiguousTimeStore.setInputSequence(ambiguousTimeKey, 1);
  let ambiguousTimeModelCalls = 0;
  const ambiguousTimePrepared = await getReceptionistReplyV2({
    phone: ambiguousTimePhone,
    userMessage: 'as 17',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'as 17' }),
    deps: {
      ...baseDeps(ambiguousTimeStore),
      runModelLoop: async () => {
        ambiguousTimeModelCalls += 1;
        throw new Error('hora nua ambígua usa clarificação determinística');
      },
    },
  });
  assert.equal(ambiguousTimeModelCalls, 0);
  assert.equal(ambiguousTimePrepared.planReceipt.route, 'fast_path');
  assert.equal(ambiguousTimePrepared.payload, '17h ou 17h30?');
  assert.equal(ambiguousTimePrepared.transition.kind, 'open');
  assert.deepEqual(
    ambiguousTimePrepared.transition.kind === 'open'
      ? ambiguousTimePrepared.transition.frame.options.map(
          (option) => option.entityId
        )
      : [],
    ['17:00', '17:30'],
    'a clarificação abre snapshot TIME próprio só com as opções ambíguas'
  );
  await deliverPreparedReceptionistTurnV2(ambiguousTimePrepared, {
    store: ambiguousTimeStore,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  const ambiguousTimeAccepted = await ambiguousTimeStore.loadLatestState(
    ambiguousTimeKey,
    now
  );
  assert.equal(
    ambiguousTimeAccepted.pending?.snapshot.version,
    ambiguousTimePending.version + 1,
    'clarificação de hora ganha questionId/versão próprios'
  );
  assert.deepEqual(
    ambiguousTimeAccepted.pending?.snapshot.options.map(
      (option) => option.entityId
    ),
    ['17:00', '17:30']
  );
  assert.equal(
    ambiguousTimeAccepted.pending?.flowState.bookingDraft,
    undefined,
    'hora ambígua nunca cria BookingDraft'
  );

  ambiguousTimeStore.setInputSequence(ambiguousTimeKey, 2);
  const clarifiedWholeHour = await getReceptionistReplyV2({
    phone: ambiguousTimePhone,
    userMessage: '17',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: '17', sequence: 2 }),
    deps: {
      ...baseDeps(ambiguousTimeStore),
      runModelLoop: async () => {
        ambiguousTimeModelCalls += 1;
        throw new Error('resposta à clarificação TIME fecha por fast-path');
      },
    },
  });
  assert.equal(ambiguousTimeModelCalls, 0);
  assert.equal(clarifiedWholeHour.planReceipt.route, 'fast_path');
  assert.match(clarifiedWholeHour.payload ?? '', /às 17h,/u);
  assert.equal(
    clarifiedWholeHour.transition.kind === 'open'
      ? clarifiedWholeHour.transition.frame.kind
      : null,
    'CONFIRMATION'
  );
  assert.equal(
    clarifiedWholeHour.transition.kind === 'open'
      ? clarifiedWholeHour.transition.nextFlowState.bookingDraft?.time
      : null,
    '17:00',
    '"17" depois da pergunta resolve 17:00 na primeira resposta'
  );

  const loopBreakerStore = new MemoryConversationalV2StateStore();
  const loopBreakerPhone = '5511000000022';
  const loopBreakerKey = `${config.phoneNumberId}:${loopBreakerPhone}`;
  seedPending(loopBreakerStore, loopBreakerKey, ambiguousTimePending, {
    flowId: ambiguousTimePending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-slot-evidence-loop-breaker',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['17:00', '17:30'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  loopBreakerStore.setInputSequence(loopBreakerKey, 1);
  const firstLoopClarification = await getReceptionistReplyV2({
    phone: loopBreakerPhone,
    userMessage: 'as 17',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'as 17' }),
    deps: baseDeps(loopBreakerStore),
  });
  await deliverPreparedReceptionistTurnV2(firstLoopClarification, {
    store: loopBreakerStore,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  loopBreakerStore.setInputSequence(loopBreakerKey, 2);
  let loopBreakerModelCalls = 0;
  const secondLoopAttempt = await getReceptionistReplyV2({
    phone: loopBreakerPhone,
    userMessage: 'as 17',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'as 17', sequence: 2 }),
    deps: {
      ...baseDeps(loopBreakerStore),
      runModelLoop: async () => {
        loopBreakerModelCalls += 1;
        return {
          rawReply: JSON.stringify(
            flatResult({
              reply: 'Você quer a hora cheia ou o horário de meia hora?',
              nextPending: 'PRESERVE',
            })
          ),
          exhausted: false,
          provider: 'openai' as const,
          model: 'gpt-4o-mini',
          providerReportedModels: ['gpt-4o-mini'],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [],
        };
      },
    },
  });
  assert.equal(loopBreakerModelCalls, 1, 'a segunda clarificação igual vai ao modelo');
  assert.notEqual(secondLoopAttempt.payload, '17h ou 17h30?');

  const reanchorStore = new MemoryConversationalV2StateStore();
  const reanchorPhone = '5511000000023';
  const reanchorKey = `${config.phoneNumberId}:${reanchorPhone}`;
  const staleDeliveryNow = new Date(now.getTime() - 16 * 60 * 1000);
  seedPending(reanchorStore, reanchorKey, ambiguousTimePending, {
    flowId: ambiguousTimePending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-slot-evidence-reanchor',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['17:00', '17:30'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  reanchorStore.setInputSequence(reanchorKey, 1);
  const staleClarification = await getReceptionistReplyV2({
    phone: reanchorPhone,
    userMessage: 'as 17',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'as 17' }),
    deps: {
      ...baseDeps(reanchorStore),
      now: () => staleDeliveryNow,
    },
  });
  await deliverPreparedReceptionistTurnV2(staleClarification, {
    store: reanchorStore,
    id: nextId,
    now: () => staleDeliveryNow,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  reanchorStore.setInputSequence(reanchorKey, 2);
  const reanchoredFallback = await getReceptionistReplyV2({
    phone: reanchorPhone,
    userMessage: 'não lembro',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'não lembro', sequence: 2 }),
    deps: {
      ...baseDeps(reanchorStore),
      runModelLoop: async () => ({
        rawReply: '{"reply":',
        exhausted: false,
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
      regenerate: async () => ({
        ok: false,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
        providerCalls: 1,
        validationIssues: [{ code: 'INVALID_JSON', path: '$' }],
        rawReply: '{"reply":',
      }),
    },
  });
  assert.equal(reanchoredFallback.planReceipt.route, 'fallback');
  assert.equal(
    reanchoredFallback.payload,
    'A gente estava marcando Drenagem Linfática para 14/08/2026 — qual horário você prefere?',
    're-ask após 15 minutos recapitula serviço e data do fluxo tipado'
  );

  // Regressão do loop real: tentativa após "pode" é bloqueada, a copy falsa
  // também é barrada e o fallback reancora o gate com o resumo completo.
  const confirmationLoopStore = new MemoryConversationalV2StateStore();
  const confirmationLoopPhone = '5511000000020';
  const confirmationLoopKey = `${config.phoneNumberId}:${confirmationLoopPhone}`;
  const confirmationPendingBase = pending({
    kind: 'CONFIRMATION',
    options: [],
  });
  const confirmationPending = {
    ...confirmationPendingBase,
    options: [
      {
        position: 1,
        entityId: `booking-confirmation:${confirmationPendingBase.flowId}`,
        displayName: 'Confirmar agendamento',
      },
    ],
  } as const;
  const confirmationFlowState = {
    flowId: confirmationPending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    bookingDraft: {
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      time: '15:00',
      slotEvidenceTurnId: 'turn-confirmation-loop-slots',
    },
    slotEvidence: {
      turnId: 'turn-confirmation-loop-slots',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['15:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  } as const;
  assert.equal(
    buildPendingQuestionV2({
      pending: confirmationPending,
      flowState: {
        flowId: confirmationPending.flowId,
        fixedByProofVersion: {},
      },
      catalog: services,
    }),
    'Você confirma essa opção?',
    'CONFIRMATION sem BookingDraftV2 completo mantém pergunta neutra'
  );
  const duplicateFallbackPending = {
    ...confirmationPending,
    options: [
      {
        position: 1,
        entityId: 'duplicate-resolution:keep-both',
        displayName: 'manter os dois',
      },
      {
        position: 2,
        entityId: 'duplicate-resolution:reschedule',
        displayName: 'remarcar',
      },
    ],
  } as const;
  const duplicateFallbackCopy = buildPendingQuestionV2({
    pending: duplicateFallbackPending,
    flowState: confirmationFlowState,
    catalog: services,
  });
  assert.equal(
    duplicateFallbackCopy,
    'Qual opção você prefere: manter os dois, remarcar?',
    'duplicidade usa copy própria e nunca o resumo de booking normal'
  );
  assert.doesNotMatch(duplicateFallbackCopy ?? '', /^Confirmando:/u);
  seedPending(
    confirmationLoopStore,
    confirmationLoopKey,
    confirmationPending,
    confirmationFlowState
  );
  confirmationLoopStore.setInputSequence(confirmationLoopKey, 1);
  const canonicalConfirmationSummary =
    'Confirmando: Drenagem Linfática, em 14/08/2026, às 15h, com Júlia. Posso marcar?';
  const falseWriteClaim = 'Pronto, seu agendamento foi confirmado com sucesso.';
  const confirmationLoopPrepared = await getReceptionistReplyV2({
    phone: confirmationLoopPhone,
    userMessage: 'pode',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode' }),
    deps: {
      ...baseDeps(confirmationLoopStore),
      loadHistory: async () => [
        { role: 'assistant', content: canonicalConfirmationSummary },
        { role: 'user', content: 'pode' },
      ],
      runModelLoop: async (loopInput) => {
        const args = {
          serviceId: 'svc-drenagem',
          professionalId: 'prof-julia',
          date: '2026-08-14',
          time: '15:00',
        };
        const blockedResult = await loopInput.executeTool(
          'bookAppointment',
          args
        );
        assert.equal(
          (JSON.parse(blockedResult) as { message?: unknown }).message,
          CONFIRMATION_HINT,
          'o gate real bloqueia "pode" antes de qualquer I/O'
        );
        return {
          rawReply: JSON.stringify(
            flatResult({
              reply: falseWriteClaim,
              nextPending: 'PRESERVE',
            })
          ),
          exhausted: false,
          provider: 'openai' as const,
          model: 'gpt-4o-mini',
          providerReportedModels: ['gpt-4o-mini'],
          rounds: 2,
          messages: [],
          toolTrace: [
            {
              round: 1,
              name: 'bookAppointment',
              args,
              argumentsValidJson: true,
              result: blockedResult,
            },
          ],
          usage: [],
        };
      },
      regenerate: async (reasonCodes) => {
        assert.ok(reasonCodes.includes('FALSE_WRITE_CLAIM'));
        return {
          ok: true,
          providerCalls: 1,
          resolutionProof: null,
          result: modelResult({
            reply: falseWriteClaim,
            replyPurpose: 'WRITE_CONFIRMATION',
            pendingTransitionCandidate: { kind: 'preserve' },
          }),
        };
      },
    },
  });
  assert.equal(confirmationLoopPrepared.planReceipt.route, 'fallback');
  assert.equal(
    confirmationLoopPrepared.planReceipt.toolEffects[0]?.outcome,
    'blocked'
  );
  assert.deepEqual(
    confirmationLoopPrepared.planReceipt.gateDecline,
    {
      gate: 'booking_confirmation',
      reason: 'scoped_modal_delivery_missing',
    },
    'recibo explica por que o léxico "pode" declinou neste turno'
  );
  assert.equal(confirmationLoopPrepared.payload, canonicalConfirmationSummary);
  assert.equal(
    confirmationLoopPrepared.planReceipt.boundaryAttempts
      .slice(0, 2)
      .every((attempt) =>
        attempt.reasonCodes.includes('FALSE_WRITE_CLAIM')
      ),
    true
  );
  const confirmationTransportPayloads: string[] = [];
  await deliverPreparedReceptionistTurnV2(confirmationLoopPrepared, {
    store: confirmationLoopStore,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async (payload) => {
      confirmationTransportPayloads.push(payload);
      return { providerMessageId: nextId() };
    },
  });
  assert.deepEqual(confirmationTransportPayloads, [canonicalConfirmationSummary]);
  const deliveredConfirmationState = await confirmationLoopStore.loadLatestState(
    confirmationLoopKey,
    now
  );
  const confirmationHistory = [
    { role: 'assistant', content: canonicalConfirmationSummary },
    { role: 'user', content: 'pode' },
    { role: 'assistant', content: canonicalConfirmationSummary },
    { role: 'user', content: 'sim' },
  ];
  const expectedBooking = {
    date: '2026-08-14',
    time: '15:00',
    serviceName: 'Drenagem Linfática',
    professionalName: 'Júlia',
  };
  const v2ConfirmationContext = {
    pending: confirmationPending,
    flowState: confirmationFlowState,
    catalog: services,
    lastAcceptedDelivery: deliveredConfirmationState.lastAcceptedDelivery,
    now,
  };
  assert.equal(ENABLE_V2_SCOPED_MODAL_ECHO_CONFIRMATION, true);
  assert.equal(
    matchesScopedV2ModalEchoConfirmation({
      currentUserMessage: 'pode',
      history: confirmationHistory.slice(0, 1),
      expectedBooking,
      context: v2ConfirmationContext,
    }),
    false,
    'fallback que preservou a versão não se finge de entrega que a abriu'
  );
  const v2HappyConfirmationContext = {
    ...v2ConfirmationContext,
    lastAcceptedDelivery: {
      payload: canonicalConfirmationSummary,
      terminalAt: now.toISOString(),
      conversationCommitOutcome: 'committed' as const,
      pendingCommitOutcome: 'opened' as const,
      transition: {
        kind: 'open' as const,
        frame: confirmationPending,
        expectedQuestionId: null,
        expectedVersion: null,
        nextFlowState: confirmationFlowState,
      },
    },
  };
  assert.equal(
    bookingConfirmationGate({
      currentUserMessage: 'pode',
      history: confirmationHistory.slice(0, 1),
      confirmedDuplicate: false,
      expectedBooking,
      v2ConfirmationContext: v2HappyConfirmationContext,
    }).ok,
    true,
    'resumo que abriu a versão atual licencia o eco modal estrito'
  );
  assert.equal(
    bookingConfirmationGate({
      currentUserMessage: 'sim',
      history: confirmationHistory,
      confirmedDuplicate: false,
      expectedBooking,
      v2ConfirmationContext,
    }).ok,
    false,
    'sim após fallback-preserve não fura a prova de entrega'
  );
  for (const message of ['sim', 'Certo', 'uhum'] as const) {
    assert.equal(
      bookingConfirmationGate({
        currentUserMessage: message,
        history: confirmationHistory,
        confirmedDuplicate: false,
        expectedBooking,
        v2ConfirmationContext: v2HappyConfirmationContext,
      }).ok,
      true,
      `${message} com recibo open/committed da versão atual licencia a escrita`
    );
  }

  // Rodada 9d: TIME validado entrega resumo + abre CONFIRMATION; o modal
  // seguinte executa o write server-owned sem nenhuma completion do modelo.
  const lexicalBookingStore = new MemoryConversationalV2StateStore();
  const lexicalBookingPhone = '5511000000027';
  const lexicalBookingKey = `${config.phoneNumberId}:${lexicalBookingPhone}`;
  const lexicalTimePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '10:00', displayName: '10:00' },
      { position: 2, entityId: '11:00', displayName: '11:00' },
    ],
  });
  seedPending(lexicalBookingStore, lexicalBookingKey, lexicalTimePending, {
    flowId: lexicalTimePending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-lexical-slots',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['10:00', '11:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  lexicalBookingStore.setInputSequence(lexicalBookingKey, 1);
  const lexicalSummary = await getReceptionistReplyV2({
    phone: lexicalBookingPhone,
    userMessage: '10h',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: '10h' }),
    deps: {
      ...baseDeps(lexicalBookingStore),
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({
          success: true,
          appointments: [
            {
              id: 'appointment-non-conflicting',
              startTime: '2026-08-15T16:00:00.000Z',
              endTime: '2026-08-15T17:00:00.000Z',
              serviceName: 'Peeling Facial',
              professionalName: 'Marina',
            },
          ],
        }),
      runModelLoop: async () => {
        throw new Error('TIME validado não chama modelo');
      },
    },
  });
  assert.equal(lexicalSummary.planReceipt.route, 'fast_path');
  assert.equal(lexicalSummary.transition.kind, 'open');
  if (lexicalSummary.transition.kind !== 'open') {
    throw new Error('resumo não materializou OPEN');
  }
  assert.equal(lexicalSummary.transition.frame.kind, 'CONFIRMATION');
  assert.deepEqual(
    lexicalSummary.transition.frame.options.map((option) => option.entityId),
    [`booking-confirmation:${lexicalTimePending.flowId}`]
  );
  assert.equal(lexicalSummary.transition.nextFlowState.bookingDraft?.time, '10:00');
  assert.deepEqual(
    __enforceCanonicalTimeSummaryTransitionForSmokeV2({
      frame: lexicalSummary.frame,
      flowState: lexicalSummary.transition.nextFlowState,
      services,
      payload: lexicalSummary.payload!,
      candidate: { kind: 'preserve' },
      writeCommitted: false,
    }),
    {
      kind: 'open',
      pendingKind: 'CONFIRMATION',
      flowId: lexicalTimePending.flowId,
      optionEntityIds: [`booking-confirmation:${lexicalTimePending.flowId}`],
    },
    'backstop converte PRESERVE acidental em OPEN CONFIRMATION'
  );
  const lexicalSummaryDelivery = await deliverPreparedReceptionistTurnV2(
    lexicalSummary,
    {
      store: lexicalBookingStore,
      id: nextId,
      now: () => now,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 1,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(
    lexicalSummaryDelivery.receipt.pendingCommitOutcome,
    'opened'
  );
  const afterLexicalSummary = await lexicalBookingStore.loadLatestState(
    lexicalBookingKey,
    now
  );
  assert.equal(afterLexicalSummary.pending?.snapshot.kind, 'CONFIRMATION');
  assert.equal(afterLexicalSummary.pending?.flowState.bookingDraft?.time, '10:00');
  assert.deepEqual(
    afterLexicalSummary.pending?.flowState.duplicatePreflightClearance,
    {
      kind: 'no_conflict',
      readEvidenceTurnId: lexicalSummary.frame.turnId,
      sourcePendingKind: 'TIME',
      sourcePendingVersion: lexicalTimePending.version,
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      time: '10:00',
    },
    'read sem conflito fica vinculado à tupla completa do draft'
  );
  assert.equal(
    hasTypedNoConflictPreflightEvidenceV2({
      pending: afterLexicalSummary.pending!.snapshot,
      flowState: afterLexicalSummary.pending!.flowState,
      catalog: services,
      lastAcceptedDelivery: afterLexicalSummary.lastAcceptedDelivery,
      now,
    }),
    true,
    'executor compartilhado reconhece clearance apenas na CONFIRMATION normal'
  );
  assert.equal(
    hasTypedNoConflictPreflightEvidenceV2({
      pending: afterLexicalSummary.pending!.snapshot,
      flowState: {
        ...afterLexicalSummary.pending!.flowState,
        bookingDraft: {
          ...afterLexicalSummary.pending!.flowState.bookingDraft!,
          time: '11:00',
        },
      },
      catalog: services,
      lastAcceptedDelivery: afterLexicalSummary.lastAcceptedDelivery,
      now,
    }),
    false,
    'mudança de horário invalida o clearance'
  );
  // Compatibilidade de rollout: simula uma CONFIRMATION aberta pelo 9d antes
  // de o campo de clearance existir. O turno do modal deve fazer o read uma
  // vez e continuar até o write, sem reemitir o resumo.
  const lexicalOpen = lexicalBookingStore.pending
    .get(lexicalBookingKey)
    ?.find((entry) => entry.state === 'OPEN');
  assert.ok(lexicalOpen);
  const {
    duplicatePreflightClearance: _legacyMissingClearance,
    ...legacyConfirmationFlowState
  } = lexicalOpen.flowState;
  lexicalOpen.flowState = legacyConfirmationFlowState;

  lexicalBookingStore.setInputSequence(lexicalBookingKey, 2);
  let lexicalBookCalls = 0;
  let lexicalConfirmationReads = 0;
  const lexicalBook = await getReceptionistReplyV2({
    phone: lexicalBookingPhone,
    userMessage: 'pode',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode', sequence: 2 }),
    deps: {
      ...baseDeps(lexicalBookingStore),
      executeProactiveDuplicateRead: async () => {
        lexicalConfirmationReads += 1;
        return JSON.stringify({
          success: true,
          appointments: [
            {
              id: 'appointment-non-conflicting',
              startTime: '2026-08-15T16:00:00.000Z',
              endTime: '2026-08-15T17:00:00.000Z',
              serviceName: 'Peeling Facial',
              professionalName: 'Marina',
            },
          ],
        });
      },
      loadHistory: async () => [
        { role: 'assistant', content: lexicalSummary.payload! },
        { role: 'user', content: 'pode' },
      ],
      executeTool: async (name, args) => {
        assert.equal(name, 'bookAppointment');
        assert.deepEqual(args, {
          serviceId: 'svc-drenagem',
          date: '2026-08-14',
          time: '10:00',
          professionalId: 'prof-julia',
        });
        lexicalBookCalls += 1;
        return JSON.stringify({
          success: true,
          message:
            'Agendado com sucesso para 14/08/2026 às 10:00 com Júlia para Drenagem Linfática.',
        });
      },
      runModelLoop: async () => {
        throw new Error('modal tipado não chama modelo');
      },
    },
  });
  assert.equal(lexicalBookCalls, 1, 'léxico executa exatamente um write');
  assert.equal(
    lexicalConfirmationReads,
    1,
    'CONFIRMATION legada executa o preflight uma única vez'
  );
  assert.equal(lexicalBook.planReceipt.route, 'fast_path');
  assert.equal(lexicalBook.planReceipt.primaryProviderCalls, 0);
  assert.equal(lexicalBook.planReceipt.gateDecline, undefined);
  assert.deepEqual(
    lexicalBook.planReceipt.toolEffects.map((effect) => effect.tool),
    ['getUpcomingAppointments', 'bookAppointment'],
    'read sem conflito passa ao léxico e ao write no mesmo turno'
  );
  assert.equal(lexicalBook.planReceipt.toolEffects.at(-1)?.tool, 'bookAppointment');
  assert.equal(lexicalBook.planReceipt.toolEffects.at(-1)?.outcome, 'success');
  assert.equal(lexicalBook.transition.kind, 'resolve');
  assert.match(lexicalBook.payload ?? '', /confirmado com sucesso|agendado com sucesso/iu);
  const lexicalBookDelivery = await deliverPreparedReceptionistTurnV2(
    lexicalBook,
    {
      store: lexicalBookingStore,
      id: nextId,
      now: () => now,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 2,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(lexicalBookDelivery.receipt.pendingCommitOutcome, 'resolved');
  assert.equal(
    (await lexicalBookingStore.loadLatestState(lexicalBookingKey, now)).pending,
    null,
    'booking_committed fecha a CONFIRMATION'
  );

  // Rodada 9e: CONFIRMATION sem cache faz um read único. Conflito preempta o
  // léxico com recibo explícito; keep-both reabre o resumo e o modal seguinte
  // escreve uma única vez sem repetir o preflight.
  const duplicatePassStore = new MemoryConversationalV2StateStore();
  const duplicatePassPhone = '5511000000028';
  const duplicatePassKey = `${config.phoneNumberId}:${duplicatePassPhone}`;
  const duplicatePassNow = (step: number) =>
    new Date(now.getTime() + step * 1_000);
  const duplicatePassTime = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '10:00', displayName: '10:00' },
      { position: 2, entityId: '11:00', displayName: '11:00' },
    ],
  });
  seedPending(duplicatePassStore, duplicatePassKey, duplicatePassTime, {
    flowId: duplicatePassTime.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-duplicate-pass-slots',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['10:00', '11:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  let duplicatePassReads = 0;
  const conflictingUpcoming = JSON.stringify({
    success: true,
    appointments: [
      {
        id: 'appointment-existing',
        startTime: '2026-08-14T13:00:00.000Z',
        endTime: '2026-08-14T14:00:00.000Z',
        serviceName: 'Drenagem Linfática',
        professionalName: 'Júlia',
      },
    ],
  });
  const duplicatePassRead = async () => {
    duplicatePassReads += 1;
    return duplicatePassReads === 1
      ? JSON.stringify({ success: false, reason: 'executor_error' })
      : conflictingUpcoming;
  };
  duplicatePassStore.setInputSequence(duplicatePassKey, 1);
  const duplicatePassSummary = await getReceptionistReplyV2({
    phone: duplicatePassPhone,
    userMessage: '10h',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: '10h' }),
    deps: {
      ...baseDeps(duplicatePassStore),
      now: () => duplicatePassNow(1),
      executeProactiveDuplicateRead: duplicatePassRead,
      runModelLoop: async () => {
        throw new Error('TIME validado não chama modelo');
      },
    },
  });
  assert.match(duplicatePassSummary.payload ?? '', /^Confirmando:/u);
  assert.equal(duplicatePassSummary.transition.kind, 'open');
  await deliverPreparedReceptionistTurnV2(duplicatePassSummary, {
    store: duplicatePassStore,
    id: nextId,
    now: () => duplicatePassNow(1),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  assert.equal(
    (
      await duplicatePassStore.loadLatestState(
        duplicatePassKey,
        duplicatePassNow(1)
      )
    ).pending
      ?.snapshot.kind,
    'CONFIRMATION'
  );

  duplicatePassStore.setInputSequence(duplicatePassKey, 2);
  const duplicateQuestionPrepared = await getReceptionistReplyV2({
    phone: duplicatePassPhone,
    userMessage: 'pode',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode', sequence: 2 }),
    deps: {
      ...baseDeps(duplicatePassStore),
      now: () => duplicatePassNow(2),
      executeProactiveDuplicateRead: duplicatePassRead,
      loadHistory: async () => [
        { role: 'assistant', content: duplicatePassSummary.payload! },
        { role: 'user', content: 'pode' },
      ],
      executeTool: async () => {
        throw new Error('conflito deve preemptar o write');
      },
      runModelLoop: async () => {
        throw new Error('conflito tipado não chama modelo');
      },
    },
  });
  assert.match(duplicateQuestionPrepared.payload ?? '', /manter os dois/iu);
  assert.deepEqual(duplicateQuestionPrepared.planReceipt.gateDecline, {
    gate: 'duplicate_preflight',
    reason: 'lexicon_preempted_duplicate_conflict',
  });
  assert.deepEqual(
    duplicateQuestionPrepared.planReceipt.toolEffects.map(
      (effect) => effect.tool
    ),
    ['getUpcomingAppointments']
  );
  const duplicateQuestionDelivery = await deliverPreparedReceptionistTurnV2(
    duplicateQuestionPrepared,
    {
      store: duplicatePassStore,
      id: nextId,
      now: () => duplicatePassNow(2),
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 2,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(duplicateQuestionDelivery.receipt.pendingCommitOutcome, 'opened');

  duplicatePassStore.setInputSequence(duplicatePassKey, 3);
  const keepBothPrepared = await getReceptionistReplyV2({
    phone: duplicatePassPhone,
    userMessage: 'outro atendimento',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'outro atendimento', sequence: 3 }),
    deps: {
      ...baseDeps(duplicatePassStore),
      now: () => duplicatePassNow(3),
      executeProactiveDuplicateRead: duplicatePassRead,
      loadHistory: async () => [
        { role: 'assistant', content: duplicatePassSummary.payload! },
        { role: 'user', content: 'pode' },
        { role: 'assistant', content: duplicateQuestionPrepared.payload! },
        { role: 'user', content: 'outro atendimento' },
      ],
      runModelLoop: async () => {
        throw new Error('keep-both tipado não chama modelo');
      },
    },
  });
  assert.match(keepBothPrepared.payload ?? '', /^Confirmando:/u);
  assert.equal(keepBothPrepared.transition.kind, 'open');
  const keepBothDelivery = await deliverPreparedReceptionistTurnV2(
    keepBothPrepared,
    {
      store: duplicatePassStore,
      id: nextId,
      now: () => duplicatePassNow(3),
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 3,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(keepBothDelivery.receipt.pendingCommitOutcome, 'opened');
  const afterKeepBoth = await duplicatePassStore.loadLatestState(
    duplicatePassKey,
    duplicatePassNow(3)
  );
  assert.deepEqual(
    afterKeepBoth.pending?.snapshot.options.map((option) => option.entityId),
    [`booking-confirmation:${duplicatePassTime.flowId}`]
  );
  assert.equal(
    afterKeepBoth.pending?.flowState.duplicateResolution?.kind,
    'keep_both'
  );
  const keepBothHistory = [
    { role: 'assistant', content: duplicatePassSummary.payload! },
    { role: 'user', content: 'pode' },
    { role: 'assistant', content: duplicateQuestionPrepared.payload! },
    { role: 'user', content: 'outro atendimento' },
    { role: 'assistant', content: keepBothPrepared.payload! },
    { role: 'user', content: 'pode' },
  ];
  const keepBothGateDecision = bookingConfirmationGate({
    currentUserMessage: 'pode',
    history: keepBothHistory,
    confirmedDuplicate: false,
    expectedBooking: {
      date: '2026-08-14',
      time: '10:00',
      serviceName: 'Drenagem Linfática',
      professionalName: 'Júlia',
    },
    v2ConfirmationContext: {
      pending: afterKeepBoth.pending!.snapshot,
      flowState: afterKeepBoth.pending!.flowState,
      catalog: services,
      lastAcceptedDelivery: afterKeepBoth.lastAcceptedDelivery,
      now: duplicatePassNow(4),
    },
  });
  assert.equal(
    keepBothGateDecision.ok,
    true,
    keepBothGateDecision.ok ? '' : keepBothGateDecision.reason
  );

  duplicatePassStore.setInputSequence(duplicatePassKey, 4);
  let duplicatePassWrites = 0;
  const keepBothBookPrepared = await getReceptionistReplyV2({
    phone: duplicatePassPhone,
    userMessage: 'pode',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode', sequence: 4 }),
    deps: {
      ...baseDeps(duplicatePassStore),
      now: () => duplicatePassNow(4),
      executeProactiveDuplicateRead: async () => {
        throw new Error('keep-both tipado não relê duplicidade');
      },
      loadHistory: async () => keepBothHistory,
      executeTool: async (name, args) => {
        assert.equal(name, 'bookAppointment');
        assert.deepEqual(args, {
          serviceId: 'svc-drenagem',
          date: '2026-08-14',
          time: '10:00',
          professionalId: 'prof-julia',
        });
        duplicatePassWrites += 1;
        return JSON.stringify({ success: true });
      },
      runModelLoop: async () => {
        throw new Error('modal pós-keep-both não chama modelo');
      },
    },
  });
  assert.equal(duplicatePassWrites, 1);
  assert.equal(keepBothBookPrepared.transition.kind, 'resolve');
  const keepBothBookDelivery = await deliverPreparedReceptionistTurnV2(
    keepBothBookPrepared,
    {
      store: duplicatePassStore,
      id: nextId,
      now: () => duplicatePassNow(4),
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 4,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(keepBothBookDelivery.receipt.pendingCommitOutcome, 'resolved');
  assert.equal(
    (
      await duplicatePassStore.loadLatestState(
        duplicatePassKey,
        duplicatePassNow(4)
      )
    ).pending,
    null
  );
  assert.equal(duplicatePassReads, 3, 'cada etapa autorizada lê uma única vez');

  // Rodada 9c: um booking nu com progresso velho abre continuar|novo antes do
  // reset/modelo; continuar restaura a pendência operacional com recap.
  const reentryStore = new MemoryConversationalV2StateStore();
  const reentryPhone = '5511000000024';
  const reentryKey = `${config.phoneNumberId}:${reentryPhone}`;
  const reentryTimePending = pending({
    kind: 'TIME',
    askedAt: '2026-08-13T08:00:00.000Z',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
    ],
  });
  const reentryFlowState = {
    flowId: reentryTimePending.flowId,
    lastOperationalAt: '2026-08-13T08:00:00.000Z',
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-reentry-slots',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['14:00', '15:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  } as const;
  seedPending(
    reentryStore,
    reentryKey,
    reentryTimePending,
    reentryFlowState
  );
  reentryStore.setInputSequence(reentryKey, 1);
  const reentryOffer = await getReceptionistReplyV2({
    phone: reentryPhone,
    userMessage: 'quero agendar',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'quero agendar' }),
    deps: {
      ...baseDeps(reentryStore),
      runModelLoop: async () => {
        throw new Error('reentrada determinística não chama modelo');
      },
    },
  });
  assert.equal(reentryOffer.planReceipt.route, 'fast_path');
  assert.equal(
    reentryOffer.payload,
    'A gente estava marcando Drenagem Linfática para 14/08/2026 — quer continuar esse agendamento ou marcar outro?'
  );
  assert.equal(reentryOffer.transition.kind, 'open');
  if (reentryOffer.transition.kind !== 'open') {
    throw new Error('reentrada não abriu escolha');
  }
  assert.deepEqual(
    reentryOffer.transition.frame.options.map((option) => option.entityId),
    ['booking-reentry:continue', 'booking-reentry:new']
  );
  await deliverPreparedReceptionistTurnV2(reentryOffer, {
    store: reentryStore,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  reentryStore.setInputSequence(reentryKey, 2);
  const reentryContinue = await getReceptionistReplyV2({
    phone: reentryPhone,
    userMessage: 'continuar',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'continuar', sequence: 2 }),
    deps: {
      ...baseDeps(reentryStore),
      runModelLoop: async () => {
        throw new Error('continuação determinística não chama modelo');
      },
    },
  });
  assert.equal(reentryContinue.planReceipt.route, 'fast_path');
  assert.equal(
    reentryContinue.payload,
    'A gente estava marcando Drenagem Linfática para 14/08/2026 — qual horário você prefere?'
  );
  assert.equal(reentryContinue.transition.kind, 'open');
  if (reentryContinue.transition.kind !== 'open') {
    throw new Error('continuação não reabriu TIME');
  }
  assert.equal(reentryContinue.transition.frame.kind, 'TIME');
  assert.deepEqual(
    reentryContinue.transition.frame.options.map((option) => option.entityId),
    ['14:00', '15:00']
  );

  // "segunda opção" é ordinal: nunca vira segunda-feira nem dispara slots.
  const ordinalDateVetoStore = new MemoryConversationalV2StateStore();
  const ordinalDateVetoPhone = '5511000000025';
  const ordinalDateVetoKey = `${config.phoneNumberId}:${ordinalDateVetoPhone}`;
  const ordinalDateVetoPending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
    ],
  });
  seedPending(ordinalDateVetoStore, ordinalDateVetoKey, ordinalDateVetoPending, {
    flowId: ordinalDateVetoPending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    slotEvidence: {
      turnId: 'turn-ordinal-date-veto',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      slots: ['14:00', '15:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ordinalDateVetoStore.setInputSequence(ordinalDateVetoKey, 1);
  let ordinalUpcomingReads = 0;
  const ordinalDateVeto = await getReceptionistReplyV2({
    phone: ordinalDateVetoPhone,
    userMessage: 'segunda opção',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'segunda opção' }),
    deps: {
      ...baseDeps(ordinalDateVetoStore),
      executeProactiveDuplicateRead: async () => {
        ordinalUpcomingReads += 1;
        return JSON.stringify({ success: true, appointments: [] });
      },
      executeTool: async (name) => {
        throw new Error(`tool inesperada após veto temporal: ${name}`);
      },
      runModelLoop: async () => {
        throw new Error('ordinal TIME inequívoco não chama modelo');
      },
    },
  });
  assert.equal(ordinalUpcomingReads, 1, 'somente o preflight de duplicidade lê');
  assert.equal(ordinalDateVeto.planReceipt.route, 'fast_path');
  assert.match(ordinalDateVeto.payload ?? '', /às 15h/u);

  // Intenção existente explícita é entitlement v2 e ignora o gate genérico.
  const cancelReadStore = new MemoryConversationalV2StateStore();
  const cancelReadPhone = '5511000000026';
  const cancelReadKey = `${config.phoneNumberId}:${cancelReadPhone}`;
  cancelReadStore.setInputSequence(cancelReadKey, 1);
  let cancelReadCalls = 0;
  const entitledCancelRead = await getReceptionistReplyV2({
    phone: cancelReadPhone,
    userMessage: 'quero cancelar',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'quero cancelar' }),
    deps: {
      ...baseDeps(cancelReadStore),
      executeProactiveDuplicateRead: async () => {
        cancelReadCalls += 1;
        return JSON.stringify({
          success: true,
          appointments: [
            {
              id: 'appointment-not-exposed',
              startTime: '2026-08-15T17:00:00.000Z',
              endTime: '2026-08-15T18:00:00.000Z',
              serviceName: 'Drenagem Linfática',
              professionalName: 'Júlia',
              status: 'CONFIRMED',
              cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
            },
          ],
        });
      },
      runModelLoop: async () => {
        throw new Error('read entitlement explícito não chama modelo');
      },
    },
  });
  assert.equal(cancelReadCalls, 1);
  assert.equal(entitledCancelRead.planReceipt.route, 'fast_path');
  assert.equal(
    entitledCancelRead.payload,
    'Confirma o cancelamento de Drenagem Linfática em 15/08/2026 às 14:00 com Júlia?'
  );
  assert.doesNotMatch(entitledCancelRead.payload ?? '', /appointment-not-exposed/u);
  assert.equal(entitledCancelRead.planReceipt.gateDecline, undefined);
  assert.doesNotMatch(
    JSON.stringify(entitledCancelRead.planReceipt.toolEffects),
    /cancelAppointment/u
  );

  // Replay canário T1/T2: pedido genérico supersede pendência velha sem modelo,
  // entrega SERVICE OPEN e ancora a resposta ordinal seguinte.
  const i3Store = new MemoryConversationalV2StateStore();
  const i3Key = `${config.phoneNumberId}:5511000000003`;
  const oldPending = pending({ askedAt: '2026-08-13T09:00:00.000Z' });
  seedPending(i3Store, i3Key, oldPending);
  i3Store.setInputSequence(i3Key, 1);
  let i3ModelCalls = 0;
  const i3 = await getReceptionistReplyV2({
    phone: '5511000000003',
    userMessage: 'Quero agendar',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Quero agendar' }),
    deps: {
      ...baseDeps(i3Store),
      runModelLoop: async () => {
        i3ModelCalls += 1;
        return {
          rawReply: JSON.stringify(flatResult()),
          exhausted: false,
          provider: 'openai' as const,
          model: 'gpt-4o-mini',
          providerReportedModels: ['gpt-4o-mini'],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [],
        };
      },
    },
  });
  assert.equal(i3ModelCalls, 0);
  assert.equal(i3.planReceipt.route, 'fast_path');
  assert.match(i3.payload ?? '', /qual serviço/i);
  assert.doesNotMatch(i3.payload ?? '', /não (?:temos|está disponível)/i);
  assert.equal(i3.transition.kind, 'open');
  assert.equal(i3.transition.kind === 'open' && i3.transition.frame.kind, 'SERVICE');
  await deliverPreparedReceptionistTurnV2(i3, {
    store: i3Store,
    id: nextId,
    now: () => now,
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 1,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  i3Store.setInputSequence(i3Key, 2);
  const i3Second = await getReceptionistReplyV2({
    phone: '5511000000003',
    userMessage: 'segunda opção',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'segunda opção', sequence: 2 }),
    deps: {
      ...baseDeps(i3Store),
      runModelLoop: async () => {
        i3ModelCalls += 1;
        throw new Error('segunda opção ancorada não deve chamar modelo');
      },
    },
  });
  assert.equal(i3ModelCalls, 0);
  assert.equal(i3Second.planReceipt.route, 'fast_path');
  assert.equal(i3Second.frame.flowState.fixedServiceId, 'svc-peeling');

  await assert.rejects(
    () =>
      runReceptionistModelLoop({
        config,
        messages: [{ role: 'user', content: 'Quero agendar' }],
        executeTool: async () => JSON.stringify({ success: false }),
        retryOnFailure: false,
        completionFactory: async () =>
          completion({
            content: '{"schemaVersion":2',
            finishReason: 'length',
          }),
      }),
    /truncada pelo limite de tokens/,
    'sem opt-in v2, o comportamento legado de truncamento permanece intacto'
  );

  // Thinking truncado é uma falha recuperável do turno v2: o loop preserva o
  // trace, o parser recebe TRUNCATED_OUTPUT e o coordinator chega a fallback.
  const truncatedStore = new MemoryConversationalV2StateStore();
  const truncatedPhone = '5511000000008';
  truncatedStore.setInputSequence(
    `${config.phoneNumberId}:${truncatedPhone}`,
    1
  );
  let truncatedRegenCalls = 0;
  const truncatedPrepared = await getReceptionistReplyV2({
    phone: truncatedPhone,
    userMessage: 'quanto custa Peeling Facial?',
    userName: 'Cliente',
    config: { ...config, aiMaxTokens: 8_192 },
    turnRuntime: turnRuntime({ text: 'quanto custa Peeling Facial?' }),
    deps: {
      ...baseDeps(truncatedStore),
      runModelLoop: (loopInput) =>
        runReceptionistModelLoop({
          ...loopInput,
          retryOnFailure: false,
          completionFactory: async () =>
            completion({
              content: '{"schemaVersion":2',
              finishReason: 'length',
            }),
        }),
      regenerate: async (reasonCodes) => {
        truncatedRegenCalls += 1;
        assert.deepEqual(reasonCodes, ['MODEL_RESULT_INVALID']);
        return {
          ok: false,
          reasonCode: 'REGEN_MODEL_RESULT_INVALID',
          providerCalls: 1,
          validationIssues: [{ code: 'TRUNCATED_OUTPUT', path: '$' }],
        };
      },
    },
  });
  assert.equal(truncatedRegenCalls, 1);
  assert.equal(truncatedPrepared.planReceipt.route, 'fallback');
  assert.equal(truncatedPrepared.planReceipt.primaryProviderCalls, 1);
  assert.ok(truncatedPrepared.payload.trim().length > 0);

  // D4 pós-matriz 2: content vazio sem qualquer tool permite exatamente uma
  // reinvocação completa. As duas provider calls ficam reconciliadas no plano.
  const emptyRetryStore = new MemoryConversationalV2StateStore();
  const emptyRetryPhone = '5511000000014';
  emptyRetryStore.setInputSequence(
    `${config.phoneNumberId}:${emptyRetryPhone}`,
    1
  );
  let emptyRetryLoopInvocations = 0;
  let emptyRetryRegenCalls = 0;
  const emptyRetryPrepared = await getReceptionistReplyV2({
    phone: emptyRetryPhone,
    userMessage: 'quanto custa drenagem?',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'quanto custa drenagem?' }),
    deps: {
      ...baseDeps(emptyRetryStore),
      runModelLoop: (loopInput) => {
        emptyRetryLoopInvocations += 1;
        const invocation = emptyRetryLoopInvocations;
        return runReceptionistModelLoop({
          ...loopInput,
          retryOnFailure: false,
          completionFactory: async ({ responseFormat }) => {
            assert.equal(responseFormat, 'json_object');
            return completion({
              content:
                invocation === 1
                  ? ''
                  : JSON.stringify(
                      flatResult({
                        reply: 'A Drenagem Linfática custa R$ 120,00.',
                        nextPending: 'PRESERVE',
                        chosenOptionText: 'drenagem',
                      })
                    ),
            });
          },
        });
      },
      regenerate: async () => {
        emptyRetryRegenCalls += 1;
        return {
          ok: false,
          reasonCode: 'REGEN_PROVIDER_ERROR',
          providerCalls: 1,
        };
      },
    },
  });
  assert.equal(emptyRetryLoopInvocations, 2, 'uma única reinvocação effect-free');
  assert.equal(emptyRetryRegenCalls, 0, 'retry válido evita regen');
  assert.equal(emptyRetryPrepared.planReceipt.primaryProviderCalls, 2);
  assert.equal(emptyRetryPrepared.planReceipt.route, 'model');
  assert.match(emptyRetryPrepared.payload ?? '', /R\$ 120,00/u);

  // Qualquer tool no trace veda a reinvocação. A saída final vazia segue para
  // uma regen textual, explicitamente sem response_format.
  const emptyAfterToolStore = new MemoryConversationalV2StateStore();
  const emptyAfterToolPhone = '5511000000015';
  emptyAfterToolStore.setInputSequence(
    `${config.phoneNumberId}:${emptyAfterToolPhone}`,
    1
  );
  let emptyAfterToolLoopInvocations = 0;
  let emptyAfterToolProviderRounds = 0;
  let emptyAfterToolRegenCalls = 0;
  const emptyAfterToolPrepared = await getReceptionistReplyV2({
    phone: emptyAfterToolPhone,
    userMessage: 'quanto custa drenagem?',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'quanto custa drenagem?' }),
    deps: {
      ...baseDeps(emptyAfterToolStore),
      executeTool: async () => JSON.stringify(services),
      runModelLoop: (loopInput) => {
        emptyAfterToolLoopInvocations += 1;
        return runReceptionistModelLoop({
          ...loopInput,
          retryOnFailure: false,
          completionFactory: async ({ responseFormat }) => {
            emptyAfterToolProviderRounds += 1;
            assert.equal(responseFormat, 'json_object');
            return emptyAfterToolProviderRounds === 1
              ? completion({ toolName: 'getUpcomingAppointments', args: {} })
              : completion({ content: '' });
          },
        });
      },
      regenerate: async (reasonCodes, regenInput) => {
        emptyAfterToolRegenCalls += 1;
        assert.deepEqual(reasonCodes, ['MODEL_RESULT_INVALID']);
        assert.equal(regenInput.useJsonObjectResponseFormat, false);
        return {
          ok: true,
          providerCalls: 1,
          resolutionProof: null,
          result: modelResult({
            reply: 'A Drenagem Linfática custa R$ 120,00.',
            replyPurpose: 'OPERATIONAL_ANSWER',
            pendingTransitionCandidate: { kind: 'preserve' },
          }),
        };
      },
    },
  });
  assert.equal(
    emptyAfterToolLoopInvocations,
    1,
    'trace com tool proíbe reinvocação do loop'
  );
  assert.equal(emptyAfterToolProviderRounds, 2);
  assert.equal(emptyAfterToolRegenCalls, 1);
  assert.equal(emptyAfterToolPrepared.planReceipt.primaryProviderCalls, 2);
  assert.equal(emptyAfterToolPrepared.planReceipt.regenProviderCalls, 1);
  assert.equal(emptyAfterToolPrepared.planReceipt.route, 'regen');
  assert.match(emptyAfterToolPrepared.payload ?? '', /R\$ 120,00/u);

  // Emenda D3 pós-convergência: fora de uma pergunta OPEN, nome parcial/typo
  // unívoco vindo do modelo produz ResolutionProof e fixa flowState.
  for (const fixture of [
    {
      inboundText: 'peeling',
      spanText: 'peeling',
      entityId: 'svc-peeling',
    },
    {
      inboundText: 'drenajem',
      spanText: 'drenajem',
      entityId: 'svc-drenagem',
    },
    {
      inboundText: 'não, peraí, peeling!',
      spanText: 'peeling',
      entityId: 'svc-peeling',
    },
  ]) {
    const proofStore = new MemoryConversationalV2StateStore();
    const proofPhone = `5511000003${serial}`;
    const proofKey = `${config.phoneNumberId}:${proofPhone}`;
    proofStore.setInputSequence(proofKey, 1);
    const points = Array.from(fixture.inboundText);
    const spanPoints = Array.from(fixture.spanText);
    const spanStart = points.findIndex((_, index) =>
      points.slice(index, index + spanPoints.length).join('') === fixture.spanText
    );
    const inboundId = nextId();
    const prepared = await getReceptionistReplyV2({
      phone: proofPhone,
      userMessage: fixture.inboundText,
      userName: 'Cliente',
      config,
      turnRuntime: {
        inputSequence: 1,
        currentInboundIds: [inboundId],
        currentInboundTextsById: { [inboundId]: fixture.inboundText },
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: 1,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
      },
      deps: {
        ...baseDeps(proofStore),
        runModelLoop: async () => ({
          rawReply: JSON.stringify(flatResult({
            reply: 'Perfeito. Qual dia você prefere?',
            nextPending: 'DATE',
            chosenOptionText: points
              .slice(spanStart, spanStart + spanPoints.length)
              .join(''),
          })),
          exhausted: false,
          provider: 'openai',
          model: 'gpt-4o-mini',
          providerReportedModels: [],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [],
        }),
      },
    });
    assert.equal(
      prepared.frame.flowState.fixedServiceId,
      fixture.entityId,
      fixture.inboundText
    );
    assert.equal(prepared.planReceipt.route, 'model', fixture.inboundText);
  }

  // Loop nativo read -> write -> final: final é parseado como JSON v2 e write
  // ocorre uma única vez; copy inválida vira confirmação canônica sem regen.
  const loopStore = new MemoryConversationalV2StateStore();
  const loopPhone = '5511000000004';
  const loopKey = `${config.phoneNumberId}:${loopPhone}`;
  const loopPending = pending({
    kind: 'CONFIRMATION',
    options: [{ position: 1, entityId: 'confirm-booking', displayName: 'Confirmar agendamento' }],
  });
  seedPending(loopStore, loopKey, loopPending, {
    flowId: loopPending.flowId,
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-14',
    bookingDraft: {
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-14',
      time: '09:00',
      slotEvidenceTurnId: 'turn-prior',
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  loopStore.setInputSequence(loopKey, 1);
  let toolExecutions = 0;
  let providerRound = 0;
  const loopPrepared = await getReceptionistReplyV2({
    phone: loopPhone,
    userMessage: 'confirmo',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'confirmo' }),
    deps: {
      ...baseDeps(loopStore),
      executeTool: async (name) => {
        toolExecutions += 1;
        return name === 'bookAppointment'
          ? JSON.stringify({ success: true })
          : JSON.stringify({ success: true, slots: ['09:00'] });
      },
      runModelLoop: (loopInput) =>
        runReceptionistModelLoop({
          ...loopInput,
          retryOnFailure: false,
          completionFactory: async ({ messages, responseFormat, tools }) => {
            providerRound += 1;
            assert.equal(responseFormat, 'json_object', 'toda completion brain v2 pede JSON mode');
            assert.ok((tools?.length ?? 0) > 0, 'JSON mode convive com tools nativas');
            assert.deepEqual(
              tools.map((tool) => tool.function.name),
              [
                'getAvailableSlots',
                'getUpcomingAppointments',
                'bookAppointment',
                'cancelAppointment',
              ],
              'F: arsenal v2 exclui getServices e preserva somente as quatro tools aprovadas'
            );
            if (providerRound > 1) {
              assert.equal(messages.at(-1)?.role, 'system');
              assert.equal(
                messages.at(-1)?.content,
                MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER,
                'cada rodada pós-tool recebe o lembrete v2 como última mensagem'
              );
            }
            if (providerRound === 1) {
              return completion({
                content: ' \n ',
                toolName: 'getAvailableSlots',
                args: {
                  date: '2026-08-14',
                  serviceId: 'svc-drenagem',
                  professionalId: 'prof-julia',
                },
              });
            }
            if (providerRound === 2) {
              return completion({
                toolName: 'bookAppointment',
                args: {
                  date: '2026-08-14',
                  time: '09:00',
                  serviceId: 'svc-drenagem',
                  professionalId: 'prof-julia',
                },
              });
            }
            return completion({
              content: JSON.stringify(flatResult({
                reply: 'INTERNAL_HINT svc-drenagem',
                nextPending: 'PRESERVE',
              })),
            });
          },
        }),
    },
  });
  assert.equal(providerRound, 3);
  assert.equal(toolExecutions, 2);
  assert.equal(loopPrepared.planReceipt.primaryProviderCalls, 3);
  assert.equal(
    loopPrepared.planReceipt.recoveryKind,
    'none',
    'write success é reduzido antes de recovery e não depende da copy do modelo'
  );
  assert.equal(loopPrepared.planReceipt.regenProviderCalls, 0);
  assert.match(loopPrepared.payload ?? '', /confirmado com sucesso/i);
  assert.equal(loopPrepared.frame.flowState.bookingDraft, undefined);

  let legacyRound = 0;
  let legacySawReminder = false;
  await runReceptionistModelLoop({
    config,
    messages: [{ role: 'system', content: 'prompt legado sem flag v2' }],
    executeTool: async () => JSON.stringify({ success: true, slots: [] }),
    retryOnFailure: false,
    completionFactory: async ({ messages, tools }) => {
      legacyRound += 1;
      assert.equal(
        tools.some((tool) => tool.function.name === 'getServices'),
        true,
        'caller v1 sem override preserva getServices'
      );
      legacySawReminder ||= messages.some(
        (message) => message.content === MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER
      );
      return legacyRound === 1
        ? completion({
            toolName: 'getAvailableSlots',
            args: { date: '2026-08-14', serviceId: 'svc-drenagem' },
          })
        : completion({ content: 'resposta legada' });
    },
  });
  assert.equal(legacyRound, 2);
  assert.equal(
    legacySawReminder,
    false,
    'caller sem postToolResultReminder preserva o caminho v1'
  );

  const unsafe = modelResult({
    reply: 'Tem vaga amanhã.',
    pendingTransitionCandidate: { kind: 'preserve' },
  });
  const safe = modelResult({
    reply: 'Pode me dizer novamente o que você prefere?',
    replyPurpose: 'CLARIFICATION',
    pendingTransitionCandidate: { kind: 'preserve' },
  });
  for (const stage of [
    'during_primary',
    'before_regen',
    'during_regen',
    'before_transport',
  ] as const) {
    const store = new MemoryConversationalV2StateStore();
    const phone = `5511000001${serial}`;
    const key = `${config.phoneNumberId}:${phone}`;
    store.setInputSequence(key, 1);
    const runtime = turnRuntime({
      text: 'quanto custa Peeling Facial?',
      checkpoint: (current) => ({
        sequence: current === stage && stage !== 'before_transport' ? 2 : 1,
      }),
    });
    const prepared = await getReceptionistReplyV2({
      phone,
      userMessage: 'quanto custa Peeling Facial?',
      userName: 'Cliente',
      config,
      turnRuntime: runtime,
      deps: {
        ...baseDeps(store),
        runModelLoop: async () => ({
          rawReply: JSON.stringify(flatResult({
            reply: unsafe.reply,
            nextPending: 'PRESERVE',
          })),
          exhausted: false,
          provider: 'openai',
          model: 'gpt-4o-mini',
          providerReportedModels: [],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [],
        }),
        regenerate: async () => ({ ok: true, result: safe, providerCalls: 1 }),
      },
    });
    let sends = 0;
    const delivered = await deliverPreparedReceptionistTurnV2(prepared, {
      store,
      id: nextId,
      now: () => now,
      checkpoint: async () => ({
        paused: false,
        latestInputSequence:
          stage === 'before_transport' ? prepared.frame.inputSequence + 1 : prepared.frame.inputSequence,
        successorInputSequence:
          stage === 'before_transport' ? prepared.frame.inputSequence + 1 : null,
        successorInboundMessageIds: stage === 'before_transport' ? [nextId()] : [],
      }),
      sendTransport: async () => {
        sends += 1;
        return { providerMessageId: nextId() };
      },
    });
    assert.equal(sends, 0, stage);
    assert.equal(delivered.receipt.transportOutcome, 'superseded', stage);
    assert.ok(delivered.receipt.successorTurnId, stage);
    assert.equal(
      (
        await store.listReadySuccessors(
          10,
          new Date(now.getTime() + SUCCESSOR_REARM_DEBOUNCE_MS_V2)
        )
      ).length,
      1,
      stage
    );
  }

  for (const stage of [
    'during_primary',
    'before_regen',
    'during_regen',
    'before_transport',
  ] as const) {
    const store = new MemoryConversationalV2StateStore();
    const phone = `5511000002${serial}`;
    const key = `${config.phoneNumberId}:${phone}`;
    store.setInputSequence(key, 1);
    const runtime = turnRuntime({
      text: 'quanto custa Peeling Facial?',
      checkpoint: (current) => ({
        paused: current === stage && stage !== 'before_transport',
      }),
    });
    const prepared = await getReceptionistReplyV2({
      phone,
      userMessage: 'quanto custa Peeling Facial?',
      userName: 'Cliente',
      config,
      turnRuntime: runtime,
      deps: {
        ...baseDeps(store),
        runModelLoop: async () => ({
          rawReply: JSON.stringify(flatResult({
            reply: unsafe.reply,
            nextPending: 'PRESERVE',
          })),
          exhausted: false,
          provider: 'openai',
          model: 'gpt-4o-mini',
          providerReportedModels: [],
          rounds: 1,
          messages: [],
          toolTrace: [],
          usage: [],
        }),
        regenerate: async () => ({ ok: true, result: safe, providerCalls: 1 }),
      },
    });
    let sends = 0;
    const delivered = await deliverPreparedReceptionistTurnV2(prepared, {
      store,
      id: nextId,
      now: () => now,
      checkpoint: async () => ({
        paused: stage === 'before_transport',
        latestInputSequence: prepared.frame.inputSequence,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => {
        sends += 1;
        return { providerMessageId: nextId() };
      },
    });
    assert.equal(sends, 0, `echo ${stage}`);
    assert.equal(delivered.receipt.transportOutcome, 'suppressed_pause', stage);
  }

  // O throw de invariante do coordinator sobe ao caller e cai no fallback já
  // existente do flush; nunca é convertido em drop silencioso.
  handler.__resetFlushStateForTest();
  const fallbackKey = handler.__seedFlushBufferForTest(
    { ...config, tenantSlug: 'v1-fallback-smoke' },
    '5511000000999',
    ['mensagem']
  );
  const fallbacks: string[] = [];
  await handler.flushBuffer(fallbackKey, {
    getReply: async () => {
      throw new Error('Fallback canônico v2 rejeitado pela própria boundary.');
    },
    sendReply: async () => {
      throw new Error('resposta primária não deve ser enviada');
    },
    sendReplyPlain: async (_to, text) => {
      fallbacks.push(text);
      return 'sent';
    },
    isPaused: async () => false,
    withConversationLock: async (_phoneNumberId, _customerPhone, work) => work(),
  });
  assert.deepEqual(fallbacks, [
    'Tive um probleminha aqui. Pode repetir sua última mensagem?',
  ]);

  // Exec IA-7 — transcript canário 2026-08-15 14h32 BRT. Civil: 15/08=sábado,
  // domingo=16/08. O rótulo "sexta/sábado/domingo" do E2E estava deslocado 1 dia.
  const ia7Now = new Date('2026-08-15T17:32:00.000Z');
  const ia7Slots = (date: string) => async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, 'getAvailableSlots');
    assert.equal(args.date, date);
    assert.equal(args.serviceId, 'svc-drenagem');
    return JSON.stringify({
      success: true,
      slots: date === '2026-08-17' ? ['10:00', '11:00', '14:00'] : ['10:00', '11:00'],
      professionalId: 'prof-julia',
    });
  };

  const ia7F2Store = new MemoryConversationalV2StateStore();
  const ia7F2Phone = '5511000000917';
  const ia7F2Key = `${config.phoneNumberId}:${ia7F2Phone}`;
  ia7F2Store.setInputSequence(ia7F2Key, 1);
  const ia7F2 = await getReceptionistReplyV2({
    phone: ia7F2Phone,
    userMessage: 'Quero agendar uma drenagem pra domingo',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Quero agendar uma drenagem pra domingo' }),
    deps: {
      ...baseDeps(ia7F2Store),
      now: () => ia7Now,
      executeTool: ia7Slots('2026-08-16'),
      runModelLoop: async () => {
        throw new Error('F2 aberto não chama modelo');
      },
    },
  });
  assert.equal(ia7F2.planReceipt.route, 'fast_path');
  assert.match(ia7F2.payload ?? '', /16\/08\/2026/);
  assert.doesNotMatch(ia7F2.payload ?? '', /15\/08\/2026/);

  const ia7F3Store = new MemoryConversationalV2StateStore();
  const ia7F3Phone = '5511000000918';
  const ia7F3Key = `${config.phoneNumberId}:${ia7F3Phone}`;
  const ia7F3Pending = pending({
    kind: 'TIME',
    askedAt: ia7Now.toISOString(),
    options: [
      { position: 1, entityId: '09:00', displayName: '09:00' },
      { position: 2, entityId: '11:00', displayName: '11:00' },
    ],
  });
  seedPending(ia7F3Store, ia7F3Key, ia7F3Pending, {
    flowId: ia7F3Pending.flowId,
    lastOperationalAt: ia7Now.toISOString(),
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-15',
    slotEvidence: {
      turnId: 'turn-ia7-sabado',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-15',
      slots: ['09:00', '11:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ia7F3Store.setInputSequence(ia7F3Key, 1);
  const ia7F3 = await getReceptionistReplyV2({
    phone: ia7F3Phone,
    userMessage: 'Domingo, não sábado!',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Domingo, não sábado!' }),
    deps: {
      ...baseDeps(ia7F3Store),
      now: () => ia7Now,
      executeTool: ia7Slots('2026-08-16'),
      runModelLoop: async () => {
        throw new Error('F3 correção não chama modelo');
      },
    },
  });
  assert.equal(ia7F3.planReceipt.route, 'fast_path');
  assert.match(ia7F3.payload ?? '', /16\/08\/2026/);
  assert.doesNotMatch(ia7F3.payload ?? '', /15\/08\/2026/);

  const ia7F1Store = new MemoryConversationalV2StateStore();
  const ia7F1Phone = '5511000000919';
  const ia7F1Key = `${config.phoneNumberId}:${ia7F1Phone}`;
  ia7F1Store.setInputSequence(ia7F1Key, 1);
  const ia7F1 = await getReceptionistReplyV2({
    phone: ia7F1Phone,
    userMessage: 'Quais horários tem domingo pra drenagem?',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({
      text: 'Quais horários tem domingo pra drenagem?',
    }),
    deps: {
      ...baseDeps(ia7F1Store),
      now: () => ia7Now,
      executeTool: ia7Slots('2026-08-16'),
      runModelLoop: async () => {
        throw new Error('F1 leitura ancorada não chama modelo');
      },
    },
  });
  assert.equal(ia7F1.planReceipt.route, 'fast_path');
  assert.match(ia7F1.payload ?? '', /16\/08\/2026/);
  assert.equal(ia7F1.frame.flowState.fixedServiceId, 'svc-drenagem');

  const ia8DualServices: ServicesResult = {
    success: true,
    services: [
      ...services.services!,
      {
        id: 'svc-modeladora',
        name: 'Drenagem Modeladora',
        durationMinutes: 60,
        price: 120,
        priceFormatted: 'R$ 120,00',
        professionalIds: ['prof-julia'],
      },
    ],
    professionals: services.professionals,
  };
  const ia8DualStore = new MemoryConversationalV2StateStore();
  const ia8DualPhone = '5511000000922';
  const ia8DualKey = `${config.phoneNumberId}:${ia8DualPhone}`;
  ia8DualStore.setInputSequence(ia8DualKey, 1);
  let ia8DualSlotCalls = 0;
  const ia8DualInbound =
    'Quais horários tem domingo pra Drenagem Linfática e Drenagem Modelador';
  const ia8Dual = await getReceptionistReplyV2({
    phone: ia8DualPhone,
    userMessage: ia8DualInbound,
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: ia8DualInbound }),
    deps: {
      ...baseDeps(ia8DualStore),
      now: () => ia7Now,
      loadServices: async () => ia8DualServices,
      executeTool: async (name) => {
        if (name === 'getAvailableSlots') {
          ia8DualSlotCalls += 1;
          throw new Error('F1 Q2 dual mention não chama getAvailableSlots');
        }
        throw new Error(`tool inesperada: ${name}`);
      },
      runModelLoop: async () => ({
        rawReply: JSON.stringify(
          flatResult({
            reply:
              'Qual serviço você prefere: Drenagem Linfática ou Drenagem Modeladora?',
            nextPending: 'SERVICE',
            chosenOptionText: null,
          })
        ),
        exhausted: false,
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
    },
  });
  assert.equal(ia8DualSlotCalls, 0, 'F1 Q2 rota: zero getAvailableSlots');
  assert.notEqual(ia8Dual.planReceipt.route, 'fast_path');
  assert.notEqual(
    ia8Dual.frame.flowState.fixedServiceId,
    'svc-drenagem',
    'F1 Q2 não persiste fixedServiceId do 1º match'
  );

  const ia9ExactSiblingInbound =
    'Quais horários tem domingo pra Drenagem Linfática?';
  const ia9ExactStore = new MemoryConversationalV2StateStore();
  const ia9ExactPhone = '5511000000923';
  const ia9ExactKey = `${config.phoneNumberId}:${ia9ExactPhone}`;
  ia9ExactStore.setInputSequence(ia9ExactKey, 1);
  const ia9Exact = await getReceptionistReplyV2({
    phone: ia9ExactPhone,
    userMessage: ia9ExactSiblingInbound,
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: ia9ExactSiblingInbound }),
    deps: {
      ...baseDeps(ia9ExactStore),
      now: () => ia7Now,
      loadServices: async () => ia8DualServices,
      executeTool: ia7Slots('2026-08-16'),
      runModelLoop: async () => {
        throw new Error('F1 IA-9 nome completo com irmão não chama modelo');
      },
    },
  });
  assert.equal(ia9Exact.planReceipt.route, 'fast_path');
  assert.match(ia9Exact.payload ?? '', /16\/08\/2026/);
  assert.equal(ia9Exact.frame.flowState.fixedServiceId, 'svc-drenagem');

  const ia9NestedServices: ServicesResult = {
    success: true,
    services: [
      {
        id: 'svc-corte',
        name: 'Corte',
        durationMinutes: 30,
        price: 80,
        priceFormatted: 'R$ 80,00',
        professionalIds: ['prof-julia'],
      },
      {
        id: 'svc-corte-barba',
        name: 'Corte e Barba',
        durationMinutes: 45,
        price: 100,
        priceFormatted: 'R$ 100,00',
        professionalIds: ['prof-julia'],
      },
    ],
    professionals: services.professionals,
  };
  const ia9NestedInbound = 'Quais horários tem domingo pra Corte e Barba?';
  const ia9NestedStore = new MemoryConversationalV2StateStore();
  const ia9NestedPhone = '5511000000924';
  const ia9NestedKey = `${config.phoneNumberId}:${ia9NestedPhone}`;
  ia9NestedStore.setInputSequence(ia9NestedKey, 1);
  const ia9Nested = await getReceptionistReplyV2({
    phone: ia9NestedPhone,
    userMessage: ia9NestedInbound,
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: ia9NestedInbound }),
    deps: {
      ...baseDeps(ia9NestedStore),
      now: () => ia7Now,
      loadServices: async () => ia9NestedServices,
      executeTool: async (name, args) => {
        assert.equal(name, 'getAvailableSlots');
        assert.equal(args.date, '2026-08-16');
        assert.equal(args.serviceId, 'svc-corte-barba');
        return JSON.stringify({
          success: true,
          slots: ['10:00', '11:00'],
          professionalId: 'prof-julia',
        });
      },
      runModelLoop: async () => {
        throw new Error('F1 IA-9 Corte e Barba não chama modelo');
      },
    },
  });
  assert.equal(ia9Nested.planReceipt.route, 'fast_path');
  assert.match(ia9Nested.payload ?? '', /16\/08\/2026/);
  assert.equal(ia9Nested.frame.flowState.fixedServiceId, 'svc-corte-barba');

  const ia7F4Store = new MemoryConversationalV2StateStore();
  const ia7F4Phone = '5511000000920';
  const ia7F4Key = `${config.phoneNumberId}:${ia7F4Phone}`;
  const ia7F4Pending = pending({
    kind: 'TIME',
    askedAt: ia7Now.toISOString(),
    options: [
      { position: 1, entityId: '09:00', displayName: '09:00' },
      { position: 2, entityId: '11:00', displayName: '11:00' },
    ],
  });
  seedPending(ia7F4Store, ia7F4Key, ia7F4Pending, {
    flowId: ia7F4Pending.flowId,
    lastOperationalAt: ia7Now.toISOString(),
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-16',
    slotEvidence: {
      turnId: 'turn-ia7-f4-old',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-16',
      slots: ['09:00', '11:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ia7F4Store.setInputSequence(ia7F4Key, 1);
  const ia7F4 = await getReceptionistReplyV2({
    phone: ia7F4Phone,
    userMessage: 'Pode ser dia 17/08 as 10h',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Pode ser dia 17/08 as 10h' }),
    deps: {
      ...baseDeps(ia7F4Store),
      now: () => ia7Now,
      executeTool: ia7Slots('2026-08-17'),
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({ success: true, appointments: [] }),
      runModelLoop: async () => {
        throw new Error('F4 data+hora não chama modelo');
      },
    },
  });
  assert.equal(ia7F4.planReceipt.route, 'fast_path');
  assert.match(ia7F4.payload ?? '', /^Confirmando:/u);
  assert.equal(ia7F4.transition.kind, 'open');
  assert.equal(
    ia7F4.transition.kind === 'open' && ia7F4.transition.frame.kind,
    'CONFIRMATION'
  );
  assert.equal(ia7F4.transition.nextFlowState.bookingDraft?.time, '10:00');
  assert.equal(ia7F4.transition.nextFlowState.bookingDraft?.date, '2026-08-17');

  const ia7F5Store = new MemoryConversationalV2StateStore();
  const ia7F5Phone = '5511000000921';
  const ia7F5Key = `${config.phoneNumberId}:${ia7F5Phone}`;
  const ia7F5Pending = pending({
    kind: 'CONFIRMATION',
    askedAt: ia7Now.toISOString(),
    options: [
      { position: 1, entityId: 'duplicate-resolution:keep-both', displayName: 'manter os dois' },
      { position: 2, entityId: 'duplicate-resolution:reschedule', displayName: 'remarcar' },
      { position: 3, entityId: 'duplicate-resolution:cancel-only', displayName: 'só cancelar o anterior' },
      { position: 4, entityId: 'duplicate-resolution:decide-later', displayName: 'decidir depois' },
    ],
  });
  seedPending(ia7F5Store, ia7F5Key, ia7F5Pending, {
    flowId: ia7F5Pending.flowId,
    lastOperationalAt: ia7Now.toISOString(),
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-16',
    bookingDraft: {
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-16',
      time: '10:00',
      slotEvidenceTurnId: 'turn-ia7-f5',
    },
    slotEvidence: {
      turnId: 'turn-ia7-f5',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-16',
      slots: ['10:00', '11:00'],
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ia7F5Store.setInputSequence(ia7F5Key, 1);
  const ia7F5 = await getReceptionistReplyV2({
    phone: ia7F5Phone,
    userMessage: 'Pode manter os dois',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Pode manter os dois' }),
    deps: {
      ...baseDeps(ia7F5Store),
      now: () => ia7Now,
      executeProactiveDuplicateRead: async () =>
        JSON.stringify({
          success: true,
          appointments: [
            {
              id: 'appointment-existing',
              startTime: '2026-08-16T13:00:00.000Z',
              endTime: '2026-08-16T14:00:00.000Z',
              serviceName: 'Drenagem Linfática',
              professionalName: 'Júlia',
            },
          ],
        }),
      runModelLoop: async () => {
        throw new Error('F5 prefixo educado não chama modelo');
      },
    },
  });
  assert.equal(ia7F5.planReceipt.route, 'fast_path');
  assert.match(ia7F5.payload ?? '', /^Confirmando:/u);
  assert.equal(
    ia7F5.transition.nextFlowState.duplicateResolution?.kind,
    'keep_both'
  );

  // Exec IA-10 — canário 2026-08-15 22:32 UTC. TIME aberto (23 slots de
  // domingo 16/08) + "10h" + upcoming do mesmo serviço em OUTRO dia (17/08)
  // abre a pergunta de duplicidade no mesmo turno. O plano era aceito; o
  // crash era serializeTurnPlanReceiptV2 tratar UUID técnico como telefone.
  const ia10Origin = new Date('2026-08-15T22:32:00.000Z');
  const ia10Now = (step: number) =>
    new Date(ia10Origin.getTime() + step * 1_000);
  const ia10UnluckyUuid = 'ea75666d-e51a-4408-8f41-041115543015';
  const ia10SundaySlots = [
    '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
    '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
    '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00',
  ];
  const ia10Store = new MemoryConversationalV2StateStore();
  const ia10Phone = '5511000000109';
  const ia10Key = `${config.phoneNumberId}:${ia10Phone}`;
  const ia10TimePending = pending({
    kind: 'TIME',
    askedAt: ia10Now(0).toISOString(),
    options: ia10SundaySlots.map((slot, index) => ({
      position: index + 1,
      entityId: slot,
      displayName: slot,
    })),
  });
  seedPending(ia10Store, ia10Key, ia10TimePending, {
    flowId: ia10TimePending.flowId,
    lastOperationalAt: ia10Now(0).toISOString(),
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-julia',
    resolvedDate: '2026-08-16',
    slotEvidence: {
      turnId: 'turn-ia10-108-slots',
      serviceId: 'svc-drenagem',
      professionalId: 'prof-julia',
      date: '2026-08-16',
      slots: ia10SundaySlots,
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  });
  ia10Store.setInputSequence(ia10Key, 109);
  const ia10Upcoming = JSON.stringify({
    success: true,
    appointments: [
      {
        id: 'appointment-existing-17',
        startTime: '2026-08-17T13:00:00.000Z',
        endTime: '2026-08-17T14:00:00.000Z',
        serviceName: 'Drenagem Linfática',
        professionalName: 'Júlia',
        status: 'CONFIRMED',
      },
    ],
  });
  const ia10Prepared = await getReceptionistReplyV2({
    phone: ia10Phone,
    userMessage: '10h',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: '10h', sequence: 109 }),
    deps: {
      ...baseDeps(ia10Store),
      now: () => ia10Now(1),
      executeProactiveDuplicateRead: async () => ia10Upcoming,
      executeTool: async (name) => {
        throw new Error(`IA-10 turno 109 não chama ${name}`);
      },
      runModelLoop: async () => {
        throw new Error('IA-10 duplicidade TIME→CONFIRMATION não chama modelo');
      },
    },
  });
  assert.equal(ia10Prepared.planReceipt.route, 'fast_path');
  assert.equal(ia10Prepared.planReceipt.result, 'accepted_for_delivery');
  assert.deepEqual(
    ia10Prepared.planReceipt.toolEffects.map((effect) => ({
      tool: effect.tool,
      outcome: effect.outcome,
    })),
    [{ tool: 'getUpcomingAppointments', outcome: 'success' }]
  );
  assert.equal(ia10Prepared.planReceipt.pendingTransitionCandidate.kind, 'open');
  if (ia10Prepared.planReceipt.pendingTransitionCandidate.kind === 'open') {
    assert.equal(
      ia10Prepared.planReceipt.pendingTransitionCandidate.pendingKind,
      'CONFIRMATION'
    );
    assert.equal(ia10Prepared.planReceipt.pendingTransitionCandidate.optionCount, 4);
  }
  assert.match(ia10Prepared.payload ?? '', /manter os dois/iu);
  assert.equal(ia10Prepared.transition.kind, 'open');
  assert.equal(
    ia10Prepared.transition.kind === 'open' && ia10Prepared.transition.frame.kind,
    'CONFIRMATION'
  );
  assert.deepEqual(
    ia10Prepared.transition.kind === 'open'
      ? ia10Prepared.transition.frame.options.map((option) => option.entityId)
      : [],
    [
      'duplicate-resolution:keep-both',
      'duplicate-resolution:reschedule',
      'duplicate-resolution:cancel-only',
      'duplicate-resolution:decide-later',
    ]
  );
  const ia10UnluckyPrepared = {
    ...ia10Prepared,
    frame: { ...ia10Prepared.frame, turnId: ia10UnluckyUuid },
    planReceipt: {
      ...ia10Prepared.planReceipt,
      planReceiptId: ia10UnluckyUuid,
      turnId: ia10UnluckyUuid,
    },
  };
  assert.doesNotThrow(() =>
    serializeTurnPlanReceiptV2(ia10UnluckyPrepared.planReceipt)
  );
  const ia10Delivery = await deliverPreparedReceptionistTurnV2(
    ia10UnluckyPrepared,
    {
      store: ia10Store,
      id: nextId,
      now: () => ia10Now(1),
      checkpoint: async () => ({
        paused: false,
        latestInputSequence: 109,
        successorInputSequence: null,
        successorInboundMessageIds: [],
      }),
      sendTransport: async () => ({ providerMessageId: nextId() }),
    }
  );
  assert.equal(ia10Delivery.delivery, 'sent');
  assert.equal(ia10Delivery.receipt.outboxState, 'accepted_by_provider');
  assert.equal(ia10Delivery.receipt.pendingCommitOutcome, 'opened');
  assert.equal(ia10Store.outbox.size, 1);
  assert.equal(
    [...ia10Store.outbox.values()][0]?.state,
    'accepted_by_provider'
  );
  const ia10AfterQuestion = await ia10Store.loadLatestState(ia10Key, ia10Now(1));
  assert.equal(ia10AfterQuestion.pending?.snapshot.kind, 'CONFIRMATION');
  assert.deepEqual(
    ia10AfterQuestion.pending?.snapshot.options.map((option) => option.entityId),
    [
      'duplicate-resolution:keep-both',
      'duplicate-resolution:reschedule',
      'duplicate-resolution:cancel-only',
      'duplicate-resolution:decide-later',
    ]
  );

  ia10Store.setInputSequence(ia10Key, 110);
  const ia10KeepBoth = await getReceptionistReplyV2({
    phone: ia10Phone,
    userMessage: 'Pode manter os dois',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'Pode manter os dois', sequence: 110 }),
    deps: {
      ...baseDeps(ia10Store),
      now: () => ia10Now(2),
      executeProactiveDuplicateRead: async () => ia10Upcoming,
      executeTool: async (name) => {
        throw new Error(`IA-10 keep-both não chama ${name} no executor de write`);
      },
      loadHistory: async () => [
        { role: 'user', content: 'Quais horários tem domingo pra drenagem?' },
        { role: 'assistant', content: ia10Prepared.payload! },
        { role: 'user', content: '10h' },
        { role: 'assistant', content: ia10Prepared.payload! },
        { role: 'user', content: 'Pode manter os dois' },
      ],
      runModelLoop: async () => {
        throw new Error('IA-10 keep-both não chama modelo');
      },
    },
  });
  assert.equal(ia10KeepBoth.planReceipt.route, 'fast_path');
  assert.match(ia10KeepBoth.payload ?? '', /^Confirmando:/u);
  assert.equal(ia10KeepBoth.transition.nextFlowState.duplicateResolution?.kind, 'keep_both');
  await deliverPreparedReceptionistTurnV2(ia10KeepBoth, {
    store: ia10Store,
    id: nextId,
    now: () => ia10Now(2),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 110,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });

  ia10Store.setInputSequence(ia10Key, 111);
  const ia10AfterKeepBoth = await ia10Store.loadLatestState(ia10Key, ia10Now(2));
  const ia10BookHistory = [
    { role: 'assistant', content: ia10Prepared.payload! },
    { role: 'user', content: 'Pode manter os dois' },
    { role: 'assistant', content: ia10KeepBoth.payload! },
    { role: 'user', content: 'pode' },
  ];
  const ia10Gate = bookingConfirmationGate({
    currentUserMessage: 'pode',
    history: ia10BookHistory,
    confirmedDuplicate: false,
    expectedBooking: {
      date: '2026-08-16',
      time: '10:00',
      serviceName: 'Drenagem Linfática',
      professionalName: 'Júlia',
    },
    v2ConfirmationContext: {
      pending: ia10AfterKeepBoth.pending!.snapshot,
      flowState: ia10AfterKeepBoth.pending!.flowState,
      catalog: services,
      lastAcceptedDelivery: ia10AfterKeepBoth.lastAcceptedDelivery,
      now: ia10Now(3),
    },
  });
  assert.equal(
    ia10Gate.ok,
    true,
    ia10Gate.ok ? '' : ia10Gate.reason
  );
  let ia10Writes = 0;
  const ia10Book = await getReceptionistReplyV2({
    phone: ia10Phone,
    userMessage: 'pode',
    userName: 'Cliente',
    config,
    turnRuntime: turnRuntime({ text: 'pode', sequence: 111 }),
    deps: {
      ...baseDeps(ia10Store),
      now: () => ia10Now(3),
      executeProactiveDuplicateRead: async () => {
        throw new Error('IA-10 book pós-keep-both não relê duplicidade');
      },
      loadHistory: async () => ia10BookHistory,
      executeTool: async (name, args) => {
        assert.equal(name, 'bookAppointment');
        assert.deepEqual(args, {
          serviceId: 'svc-drenagem',
          date: '2026-08-16',
          time: '10:00',
          professionalId: 'prof-julia',
        });
        ia10Writes += 1;
        return JSON.stringify({ success: true });
      },
      runModelLoop: async () => {
        throw new Error('IA-10 book pós-keep-both não chama modelo');
      },
    },
  });
  assert.equal(ia10Writes, 1);
  assert.equal(ia10Book.transition.kind, 'resolve');
  const ia10BookDelivery = await deliverPreparedReceptionistTurnV2(ia10Book, {
    store: ia10Store,
    id: nextId,
    now: () => ia10Now(3),
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: 111,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
    sendTransport: async () => ({ providerMessageId: nextId() }),
  });
  assert.equal(ia10BookDelivery.receipt.pendingCommitOutcome, 'resolved');
  assert.equal((await ia10Store.loadLatestState(ia10Key, ia10Now(3))).pending, null);

  console.log('smoke ana conversational v2 route: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
