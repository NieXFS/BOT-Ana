import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type {
  UpcomingAppointment,
  UpcomingAppointmentsResult,
  ServicesResult,
} from '../src/services/calendarService';
import type {
  CancellationFlowV2,
  FlowStateV2,
  ModelTurnResultV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';
import type { CancelAppointmentV2Payload } from '../src/services/cancelAppointmentV2Authorized';
import type { V2CheckpointStage } from '../src/services/conversationalV2/runtimeTypes';
import type { RegenerationResultV2 } from '../src/services/conversationalV2/regenerator';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana_v2_cancellation';
process.env.OPENAI_API_KEY = 'sk-smoke-no-network';
process.env.ERP_API_TOKEN = 'smoke-no-network';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';
process.env.ANA_ESCALATION_ENABLED = 'true';

const NOW = new Date('2026-08-15T18:00:00.000Z');
const TZ = 'America/Sao_Paulo';
const SUNDAY_10_UTC = '2026-08-16T13:00:00.000Z';
const SUNDAY_10_END_UTC = '2026-08-16T14:00:00.000Z';
const MONDAY_14_UTC = '2026-08-17T17:00:00.000Z';
const PHONE = '+5511999001100';

const config = {
  tenantSlug: 'fixture-cancel-v2',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda com segurança.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-no-network',
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: TZ,
  waAccessToken: 'fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-CANCEL-V2',
  isActive: true,
} as TenantBotConfig;

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling Facial',
      durationMinutes: 45,
      price: 100,
      priceFormatted: 'R$ 100,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

function appointment(input: {
  id: string;
  startTime: string;
  endTime?: string;
  serviceName?: string;
  professionalName?: string;
  status?: string;
  cancellationDisposition?: UpcomingAppointment['cancellationDisposition'];
}): UpcomingAppointment {
  const row: UpcomingAppointment = {
    id: input.id,
    startTime: input.startTime,
    endTime: input.endTime ?? SUNDAY_10_END_UTC,
    serviceName: input.serviceName ?? 'Drenagem Linfática',
    professionalName: input.professionalName ?? 'Carla Mendes',
    status: input.status ?? 'CONFIRMED',
  };
  if (input.cancellationDisposition) {
    row.cancellationDisposition = input.cancellationDisposition;
  }
  return row;
}

const SUNDAY_AUTO = appointment({
  id: 'apt-ia11-sunday-10',
  startTime: SUNDAY_10_UTC,
  cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
});
const MONDAY_AUTO = appointment({
  id: 'apt-ia11-monday-14',
  startTime: MONDAY_14_UTC,
  endTime: '2026-08-17T18:00:00.000Z',
  serviceName: 'Peeling Facial',
  cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
});
const SUNDAY_PEELING = appointment({
  id: 'apt-ia11-sunday-10-peeling',
  startTime: SUNDAY_10_UTC,
  serviceName: 'Peeling Facial',
  cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
});

function upcomingJson(
  appointments: readonly UpcomingAppointment[]
): string {
  return JSON.stringify({ success: true, appointments });
}

function assertNoTechnicalIdLeak(
  text: string,
  ids: readonly string[],
  label: string
): void {
  assert.doesNotMatch(text, /"appointmentId"/u, `${label}: chave appointmentId`);
  assert.doesNotMatch(text, /"fingerprint"/u, `${label}: chave fingerprint`);
  for (const id of ids) {
    assert.equal(text.includes(id), false, `${label}: id ${id}`);
  }
}

function modelLoopResult(
  reply: string
): {
  rawReply: string;
  exhausted: false;
  provider: 'openai';
  model: string;
  providerReportedModels: string[];
  rounds: number;
  messages: [];
  toolTrace: [];
  usage: [];
} {
  const result: ModelTurnResultV2 = {
    schemaVersion: 2,
    reply,
    replyPurpose: 'OPERATIONAL_ANSWER',
    pendingTransitionCandidate: { kind: 'preserve' },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
  return {
    rawReply: JSON.stringify(result),
    exhausted: false,
    provider: 'openai',
    model: 'gpt-4o-mini',
    providerReportedModels: [],
    rounds: 1,
    messages: [],
    toolTrace: [],
    usage: [],
  };
}

async function main(): Promise<void> {
  const runtime = await import('../src/services/conversationalV2/runtime');
  const delivery = await import('../src/services/conversationalV2/delivery');
  const stateStore = await import('../src/services/conversationalV2/stateStore');
  const context = await import('../src/services/contextManager');
  const flow = await import('../src/services/conversationalV2/cancellationFlowV2');
  const abandonment = await import(
    '../src/services/conversationalV2/cancellationAbandonmentV2'
  );
  const regenerator = await import('../src/services/conversationalV2/regenerator');
  const authorized = await import('../src/services/cancelAppointmentV2Authorized');
  const receipts = await import('../src/services/conversationalV2/receipts');
  const contract = await import('../src/services/conversationalV2/modelResultContract');
  const kinds = await import('../src/services/conversationalV2/contracts');
  const optOut = await import('../src/services/optOutService');

  let serial = 0;
  const nextId = () => `cancel-v2-${++serial}`;

  assert.equal(optOut.isOptOutMessage('pare'), true);
  assert.equal(optOut.isOptOutMessage('quero cancelar'), false);
  assert.equal(optOut.isOptOutMessage('O de domingo as 10h'), false);
  assert.equal(
    flow.detectPositiveCancellationIntentV2(
      'Na verdade preciso cancelar esse de domingo às 10h'
    ),
    true
  );
  assert.equal(
    flow.detectPositiveCancellationIntentV2('O de domingo as 10h'),
    false
  );
  assert.equal(
    flow.detectPositiveCancellationIntentV2('pode cancelar?'),
    true
  );

  assert.doesNotMatch(
    contract.MODEL_TURN_RESULT_V2_CONTRACT_BLOCK,
    /CANCEL_TARGET|CANCEL_CONFIRMATION/u
  );
  assert.deepEqual(kinds.MODEL_PENDING_KINDS_V2, [
    'SERVICE',
    'PROFESSIONAL',
    'DATE',
    'TIME',
    'CONFIRMATION',
  ]);
  assert.ok(kinds.PENDING_KINDS_V2.includes('CANCEL_TARGET'));
  assert.ok(kinds.PENDING_KINDS_V2.includes('CANCEL_CONFIRMATION'));

  const sundayDisplay = flow.canonicalCancellationDisplayNameV2(SUNDAY_AUTO, TZ);
  assert.ok(sundayDisplay);
  const confirmationCopy = flow.buildCancelConfirmationCopyV2(sundayDisplay!);
  const sundayCandidates = flow.candidatesFromUpcomingAppointmentsV2(
    [SUNDAY_AUTO],
    TZ
  );
  const sundayFingerprint = sundayCandidates[0]!.fingerprint;
  assert.ok(sundayFingerprint);
  const sundaySecrets = [SUNDAY_AUTO.id, sundayFingerprint];

  const promptFrame: TurnFrameV2 = {
    schemaVersion: 2,
    turnId: 'prompt-cancel',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: ['inbound-prompt'],
    pending: null,
    flowState: {
      flowId: 'flow-prompt',
      fixedByProofVersion: {},
      cancellation: {
        flowId: 'flow-prompt',
        sourceReadTurnId: 'read-1',
        selectedToken: flow.cancellationTargetTokenV2(SUNDAY_AUTO.id),
        candidates: flow.candidatesFromUpcomingAppointmentsV2([SUNDAY_AUTO], TZ),
      },
    },
  };
  const prompt = runtime.__v2RulesPromptForSmoke(
    config,
    services,
    NOW,
    promptFrame,
    { 'inbound-prompt': 'Quero cancelar' }
  );
  assertNoTechnicalIdLeak(prompt, sundaySecrets, 'prompt');
  assert.match(prompt, /cancel-target:/u);

  const bookingAbandon = abandonment.decideCancellationAbandonmentV2({
    inboundText: 'quero agendar Drenagem',
    pending: {
      questionId: 'q-target',
      askedAt: NOW.toISOString(),
      kind: 'CANCEL_TARGET',
      flowId: 'flow-prompt',
      version: 1,
      options: [
        {
          position: 1,
          entityId: sundayCandidates[0]!.token,
          displayName: sundayDisplay!,
        },
      ],
    },
    flowState: promptFrame.flowState,
    now: NOW,
  });
  assert.equal(bookingAbandon.kind, 'abandon');
  if (bookingAbandon.kind === 'abandon') {
    assert.equal(bookingAbandon.reason, 'explicit_booking_or_reschedule');
    assert.equal(bookingAbandon.nextFlowState.cancellation, undefined);
    assert.equal(bookingAbandon.pendingTransitionCandidate.kind, 'invalidate');
  }
  const withdrawAbandon = abandonment.decideCancellationAbandonmentV2({
    inboundText: 'não quero cancelar; quero agendar',
    pending: {
      questionId: 'q-confirm',
      askedAt: NOW.toISOString(),
      kind: 'CANCEL_CONFIRMATION',
      flowId: 'flow-prompt',
      version: 1,
      options: [
        {
          position: 1,
          entityId: sundayCandidates[0]!.token,
          displayName: sundayDisplay!,
        },
      ],
    },
    flowState: promptFrame.flowState,
    now: NOW,
  });
  assert.equal(withdrawAbandon.kind, 'abandon');
  if (withdrawAbandon.kind === 'abandon') {
    assert.equal(withdrawAbandon.reason, 'explicit_withdrawal');
  }
  const expiredAbandon = abandonment.decideCancellationAbandonmentV2({
    inboundText: 'ok',
    pending: {
      questionId: 'q-expired',
      askedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
      kind: 'CANCEL_TARGET',
      flowId: 'flow-prompt',
      version: 1,
      options: [
        {
          position: 1,
          entityId: sundayCandidates[0]!.token,
          displayName: sundayDisplay!,
        },
      ],
    },
    flowState: {
      ...promptFrame.flowState,
      lastOperationalAt: NOW.toISOString(),
    },
    now: NOW,
  });
  assert.equal(expiredAbandon.kind, 'abandon');
  if (expiredAbandon.kind === 'abandon') {
    assert.equal(expiredAbandon.reason, 'expired_pending');
  }

  const regenMessagesDirect = regenerator.buildRegenerationMessagesV2(
    {
      frame: promptFrame,
      catalogSnapshot: { services: [], professionals: [] },
      messages: [{ role: 'user', content: 'sim' }],
      rejectedCandidate: 'Marquei pra você no domingo.',
    },
    ['FALSE_WRITE_CLAIM']
  );
  assertNoTechnicalIdLeak(
    JSON.stringify(regenMessagesDirect),
    sundaySecrets,
    'regen direta'
  );

  const openConversation = (input?: {
    phone?: string;
    appointments?: UpcomingAppointment[];
    now?: Date;
    paused?: boolean;
    humanActive?: boolean;
  }) => {
    const phone = input?.phone ?? PHONE;
    const now = input?.now ?? NOW;
    const store = new stateStore.MemoryConversationalV2StateStore();
    const conversationKey = context.buildConversationKey(
      config.phoneNumberId,
      phone
    );
    let sequence = 0;
    let appointments = [...(input?.appointments ?? [SUNDAY_AUTO])];
    const posts: CancelAppointmentV2Payload[] = [];
    const escalations: Array<{ reasonCode?: unknown }> = [];
    const upcomingResult = (): UpcomingAppointmentsResult => ({
      success: true,
      appointments,
    });
    const setAppointments = (next: UpcomingAppointment[]) => {
      appointments = [...next];
    };
    const prepare = async (
      text: string,
      overrides?: {
        now?: Date;
        paused?: boolean;
        humanActive?: boolean;
        checkpoint?: (
          stage: V2CheckpointStage
        ) => Promise<{
          paused: boolean;
          latestInputSequence: number;
          successorInputSequence: number | null;
          successorInboundMessageIds: string[];
        }>;
        runModelLoop?: (input: {
          executeTool: (
            name: string,
            args: Record<string, unknown>
          ) => Promise<string>;
        }) => Promise<ReturnType<typeof modelLoopResult> & { rawReply: string }>;
        regenerate?: (
          reasonCodes: readonly string[],
          regenInput: {
            frame: unknown;
            messages: unknown;
            rejectedCandidate: string;
            validationContext: { frame: unknown };
          }
        ) => Promise<RegenerationResultV2>;
        executeTool?: (
          name: string,
          args?: Record<string, unknown>
        ) => Promise<string>;
      }
    ) => {
      sequence += 1;
      store.setInputSequence(conversationKey, sequence);
      const inboundId = nextId();
      const turnNow = overrides?.now ?? now;
      return runtime.getReceptionistReplyV2({
        phone,
        userMessage: text,
        userName: 'Cliente Fixture',
        config,
        ...(overrides?.humanActive || input?.humanActive
          ? {
              turnControl: {
                disposition: 'HUMAN_ACTIVE' as const,
                resumeDecision: 'KEEP_HUMAN' as const,
              },
            }
          : {}),
        interpreterEnabled: false,
        turnRuntime: {
          turnId: nextId(),
          inputSequence: sequence,
          currentInboundIds: [inboundId],
          currentInboundTextsById: { [inboundId]: text },
          checkpoint: async (stage) =>
            overrides?.checkpoint
              ? overrides.checkpoint(stage)
              : {
                  paused: overrides?.paused ?? input?.paused ?? false,
                  latestInputSequence: sequence,
                  successorInputSequence: null,
                  successorInboundMessageIds: [],
                },
        },
        deps: {
          store,
          now: () => turnNow,
          id: nextId,
          loadServices: async () => services,
          loadHistory: async () => [],
          isPaused: async () => overrides?.paused ?? input?.paused ?? false,
          runModelLoop: (overrides?.runModelLoop ??
            (async () => {
              throw new Error('O smoke de cancelamento v2 não pode chamar modelo.');
            })) as never,
          ...(overrides?.regenerate
            ? { regenerate: overrides.regenerate as never }
            : {}),
          escalate: async () => ({ matched: false as const }),
          executeTool: async (name, args) => {
            if (overrides?.executeTool) {
              return overrides.executeTool(name, args);
            }
            if (name === 'getUpcomingAppointments') {
              return upcomingJson(appointments);
            }
            if (name === 'bookAppointment' || name === 'cancelAppointment') {
              throw new Error(`Tool de escrita do modelo não autorizada: ${name}`);
            }
            throw new Error(`Tool inesperada no smoke de cancelamento: ${name}`);
          },
          cancelDeps: {
            getUpcomingAppointments: async () => upcomingResult(),
            postCancel: async (payload) => {
              posts.push(payload);
            },
          },
          escalateCancelDeps: {
            post: async (candidate) => {
              escalations.push(candidate);
              return {
                questionId: 'question-cancel-human-review',
                escalation: {
                  active: true,
                  questionId: 'question-cancel-human-review',
                  version: 1,
                },
              };
            },
          },
        },
      });
    };
    const deliver = async (
      prepared: Awaited<ReturnType<typeof prepare>>,
      turnNow = now
    ) =>
      delivery.deliverPreparedReceptionistTurnV2(prepared, {
        store,
        now: () => turnNow,
        id: nextId,
        checkpoint: async () => ({
          paused: false,
          latestInputSequence: sequence,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        }),
        sendTransport: async () => ({ providerMessageId: nextId() }),
      });
    return {
      phone,
      store,
      conversationKey,
      posts,
      escalations,
      setAppointments,
      prepare,
      deliver,
    };
  };

  // 1. Alvo explícito único → confirmação, zero writes.
  {
    const conv = openConversation();
    const prepared = await conv.prepare(
      'Na verdade preciso cancelar esse de domingo às 10h'
    );
    assert.equal(prepared.planReceipt.route, 'fast_path');
    assert.equal(prepared.payload, confirmationCopy);
    assert.equal(prepared.transition.kind, 'open');
    if (prepared.transition.kind === 'open') {
      assert.equal(prepared.transition.frame.kind, 'CANCEL_CONFIRMATION');
    }
    assert.equal(conv.posts.length, 0);
    assert.equal(prepared.hasCommittedWrite, false);
    assertNoTechnicalIdLeak(prepared.payload ?? '', [SUNDAY_AUTO.id], 'payload 1');
    receipts.assertReceiptRedactedV2(prepared.planReceipt, {
      forbiddenPlaintextFragments: [SUNDAY_AUTO.id],
      forbiddenPhoneValues: [PHONE, '5511999001100'],
    });
    const serialized = receipts.serializeTurnPlanReceiptV2(prepared.planReceipt, {
      forbiddenPlaintextFragments: [SUNDAY_AUTO.id],
    });
    assertNoTechnicalIdLeak(serialized, [SUNDAY_AUTO.id], 'recibo 1');
    await conv.deliver(prepared);
  }

  // 2. "sim" após confirmação entregue → um único cancelamento.
  {
    const conv = openConversation();
    const ask = await conv.prepare(
      'Quero cancelar a drenagem de 16/08 as 10h'
    );
    assert.equal(ask.payload, confirmationCopy);
    await conv.deliver(ask);
    const confirm = await conv.prepare('sim');
    assert.equal(confirm.payload, flow.CANCEL_WRITE_SUCCESS_COPY_V2);
    assert.equal(conv.posts.length, 1);
    assert.equal(conv.posts[0]?.customerPhone, PHONE);
    assert.equal(conv.posts[0]?.appointmentId, SUNDAY_AUTO.id);
    assert.equal(conv.posts[0]?.tenantSlug, config.tenantSlug);
    assert.equal(confirm.hasCommittedWrite, true);
    assert.equal(confirm.transition.kind, 'resolve');
    assertNoTechnicalIdLeak(confirm.payload ?? '', [SUNDAY_AUTO.id], 'payload 2');
  }

  // 2b. IA-15c: re-ask preserve da mesma versão NÃO invalida o cancel.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const afterOpen = await conv.store.loadLatestState(
      conv.conversationKey,
      NOW
    );
    assert.equal(afterOpen.openingAcceptedDelivery?.transition.kind, 'open');
    const preserveTurnId = nextId();
    const preserveNow = new Date(NOW.getTime() + 1_000);
    await conv.deliver(
      {
        ...ask,
        frame: {
          ...ask.frame,
          turnId: preserveTurnId,
          inputSequence: 2,
          pending: afterOpen.pending?.snapshot ?? ask.frame.pending,
        },
        planReceipt: {
          ...ask.planReceipt,
          planReceiptId: nextId(),
          turnId: preserveTurnId,
          pendingTransitionCandidate: { kind: 'preserve' },
        },
        transition: {
          kind: 'preserve',
          expectedQuestionId: afterOpen.pending?.snapshot.questionId ?? null,
          expectedVersion: afterOpen.pending?.snapshot.version ?? null,
          nextFlowState: afterOpen.flowState ?? ask.frame.flowState,
        },
      },
      preserveNow
    );
    const afterPreserve = await conv.store.loadLatestState(
      conv.conversationKey,
      preserveNow
    );
    assert.equal(
      afterPreserve.lastAcceptedDelivery?.transition.kind,
      'preserve'
    );
    assert.equal(
      afterPreserve.openingAcceptedDelivery?.transition.kind,
      'open'
    );
    const confirm = await conv.prepare('sim');
    assert.equal(
      conv.posts.length,
      1,
      'IA-15c cancel: re-ask preserve da pergunta não invalida'
    );
    assert.equal(confirm.hasCommittedWrite, true);
  }

  // 2c. IA-15c predicado compartilhado no gate de cancel.
  {
    const token = sundayCandidates[0]!.token;
    const cancelPending = {
      questionId: 'q-cancel-ia15c',
      askedAt: NOW.toISOString(),
      kind: 'CANCEL_CONFIRMATION' as const,
      flowId: 'flow-cancel-ia15c',
      version: 1,
      options: [
        {
          position: 1,
          entityId: token,
          displayName: sundayDisplay!,
        },
      ],
    };
    const cancelFlowState: FlowStateV2 = {
      flowId: cancelPending.flowId,
      fixedByProofVersion: {},
      cancellation: {
        flowId: cancelPending.flowId,
        sourceReadTurnId: 'turn-read-cancel-ia15c',
        selectedToken: token,
        candidates: [...sundayCandidates],
      },
    };
    const cancelOpenDelivery = {
      payload: confirmationCopy,
      terminalAt: NOW.toISOString(),
      conversationCommitOutcome: 'committed' as const,
      pendingCommitOutcome: 'opened' as const,
      copyVariant: 'canonical' as const,
      transition: {
        kind: 'open' as const,
        frame: cancelPending,
        expectedQuestionId: null,
        expectedVersion: null,
        nextFlowState: cancelFlowState,
      },
    };
    const cancelPreserveDelivery = {
      payload: confirmationCopy,
      terminalAt: NOW.toISOString(),
      conversationCommitOutcome: 'committed' as const,
      pendingCommitOutcome: 'preserved' as const,
      copyVariant: 'canonical' as const,
      transition: {
        kind: 'preserve' as const,
        nextFlowState: cancelFlowState,
      },
    };
    assert.equal(
      flow.cancelConfirmationGateV2({
        currentInboundBatchText: 'sim',
        pending: cancelPending,
        flowState: cancelFlowState,
        lastAcceptedDelivery: cancelPreserveDelivery,
        openingAcceptedDelivery: cancelOpenDelivery,
        now: NOW,
      }).ok,
      true,
      'IA-15c cancel: open committed + re-ask preserve + sim licencia'
    );
    assert.equal(
      flow.cancelConfirmationGateV2({
        currentInboundBatchText: 'sim',
        pending: cancelPending,
        flowState: cancelFlowState,
        lastAcceptedDelivery: cancelPreserveDelivery,
        openingAcceptedDelivery: null,
        now: NOW,
      }).ok,
      false,
      'IA-15c cancel: preserve sem open committed da versão não licencia'
    );
    assert.equal(
      flow.cancelConfirmationGateV2({
        currentInboundBatchText: 'sim',
        pending: { ...cancelPending, version: 2 },
        flowState: cancelFlowState,
        lastAcceptedDelivery: cancelOpenDelivery,
        openingAcceptedDelivery: null,
        now: NOW,
      }).ok,
      false,
      'IA-15c cancel: open da versão anterior não licencia pending v2'
    );
  }

  // 3. Confirmação não entregue / expirada / pausada → zero writes.
  {
    const undelivered = openConversation();
    const ask = await undelivered.prepare('quero cancelar domingo as 10h');
    assert.equal(ask.payload, confirmationCopy);
    const gate = flow.cancelConfirmationGateV2({
      currentInboundBatchText: 'sim',
      pending:
        ask.transition.kind === 'open' ? ask.transition.frame : null,
      flowState: ask.frame.flowState.cancellation
        ? {
            ...ask.frame.flowState,
            cancellation: {
              ...ask.frame.flowState.cancellation,
              selectedToken: ask.frame.flowState.cancellation.candidates[0]?.token,
            },
          }
        : ask.frame.flowState,
      lastAcceptedDelivery: null,
      now: NOW,
    });
    assert.equal(gate.ok, false);
    assert.equal(undelivered.posts.length, 0);

    const paused = openConversation();
    const pausedAsk = await paused.prepare('quero cancelar domingo as 10h');
    await paused.deliver(pausedAsk);
    const pausedConfirm = await paused.prepare('sim', { paused: true });
    assert.equal(pausedConfirm.preemption, 'HUMAN_ACTIVE');
    assert.equal(pausedConfirm.payload, null);
    assert.equal(paused.posts.length, 0);

    const expired = openConversation();
    const expiredAsk = await expired.prepare('quero cancelar domingo as 10h');
    await expired.deliver(expiredAsk);
    const later = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    const expiredConfirm = await expired.prepare('sim', {
      now: later,
      runModelLoop: async () =>
        modelLoopResult('Pode me dizer o que você prefere?'),
    });
    assert.equal(expired.posts.length, 0);
    assert.notEqual(
      expiredConfirm.payload,
      flow.CANCEL_WRITE_SUCCESS_COPY_V2
    );
  }

  // 4. "o de domingo às 10h" após lista entregue → seleciona e abre confirmação.
  {
    const conv = openConversation({
      appointments: [SUNDAY_AUTO, MONDAY_AUTO],
    });
    const list = await conv.prepare('quero cancelar');
    assert.equal(conv.posts.length, 0);
    assert.equal(list.transition.kind, 'open');
    if (list.transition.kind === 'open') {
      assert.equal(list.transition.frame.kind, 'CANCEL_TARGET');
      assert.equal(list.transition.frame.options.length, 2);
    }
    assert.match(list.payload ?? '', /^Qual você quer cancelar:/u);
    await conv.deliver(list);
    const select = await conv.prepare('O de domingo as 10h');
    assert.equal(select.payload, confirmationCopy);
    assert.equal(conv.posts.length, 0);
    if (select.transition.kind === 'open') {
      assert.equal(select.transition.frame.kind, 'CANCEL_CONFIRMATION');
    }
  }

  // 5. 0, 2 ambíguos e 6+ candidatos → zero writes.
  {
    const none = openConversation({ appointments: [] });
    const nonePrepared = await none.prepare('quero cancelar');
    assert.equal(nonePrepared.payload, flow.NO_UPCOMING_CANCEL_COPY_V2);
    assert.equal(none.posts.length, 0);
    assert.notEqual(nonePrepared.transition.kind, 'open');

    const ambiguous = openConversation({
      appointments: [SUNDAY_AUTO, SUNDAY_PEELING],
    });
    const ambiguousPrepared = await ambiguous.prepare(
      'quero cancelar o de domingo as 10h'
    );
    assert.equal(ambiguous.posts.length, 0);
    if (ambiguousPrepared.transition.kind === 'open') {
      assert.equal(ambiguousPrepared.transition.frame.kind, 'CANCEL_TARGET');
    }

    const many = Array.from({ length: 6 }, (_, index) =>
      appointment({
        id: `apt-ia11-many-${index}`,
        startTime: `2026-08-1${index + 2}T13:00:00.000Z`,
        endTime: `2026-08-1${index + 2}T14:00:00.000Z`,
        cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
      })
    );
    const overcrowded = openConversation({ appointments: many });
    const overcrowdedPrepared = await overcrowded.prepare('quero cancelar');
    assert.equal(overcrowdedPrepared.payload, flow.CANCEL_NEED_DATETIME_COPY_V2);
    assert.equal(overcrowded.posts.length, 0);
  }

  // 6. Consulta pura → terminal sem pendência de cancel.
  {
    const conv = openConversation({
      appointments: [SUNDAY_AUTO, MONDAY_AUTO],
    });
    const prepared = await conv.prepare('Quero ver meus agendamentos');
    assert.equal(prepared.planReceipt.route, 'fast_path');
    assert.equal(prepared.transition.kind, 'preserve');
    assert.equal(prepared.frame.flowState.cancellation, undefined);
    assert.match(prepared.payload ?? '', /Encontrei estes agendamentos/u);
    assert.equal(conv.posts.length, 0);
    assert.notEqual(prepared.payload, confirmationCopy);
  }

  // 7. Negação / interrogação curta não confirma.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const question = await conv.prepare('pode cancelar?');
    assert.equal(conv.posts.length, 0);
    assert.notEqual(question.payload, flow.CANCEL_WRITE_SUCCESS_COPY_V2);
    const denial = await conv.prepare('não');
    assert.equal(conv.posts.length, 0);
    assert.notEqual(denial.payload, flow.CANCEL_WRITE_SUCCESS_COPY_V2);
  }

  // 8. Alvo de outro cliente, removido e fingerprint alterado → zero POST.
  {
    const removed = openConversation();
    const ask = await removed.prepare('quero cancelar domingo as 10h');
    await removed.deliver(ask);
    removed.setAppointments([]);
    const confirmRemoved = await removed.prepare('sim');
    assert.equal(removed.posts.length, 0);
    assert.notEqual(confirmRemoved.payload, flow.CANCEL_WRITE_SUCCESS_COPY_V2);

    const fingerprint = openConversation();
    const askFp = await fingerprint.prepare('quero cancelar domingo as 10h');
    await fingerprint.deliver(askFp);
    fingerprint.setAppointments([
      appointment({
        id: SUNDAY_AUTO.id,
        startTime: '2026-08-16T14:00:00.000Z',
        endTime: '2026-08-16T15:00:00.000Z',
        cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
      }),
    ]);
    const confirmFp = await fingerprint.prepare('sim');
    assert.equal(fingerprint.posts.length, 0);
    assert.notEqual(confirmFp.payload, flow.CANCEL_WRITE_SUCCESS_COPY_V2);

    const foreignFlow: CancellationFlowV2 = {
      flowId: 'flow-foreign',
      sourceReadTurnId: 'read-foreign',
      selectedToken: flow.cancellationTargetTokenV2('apt-ia11-other-customer'),
      candidates: flow.candidatesFromUpcomingAppointmentsV2(
        [
          appointment({
            id: 'apt-ia11-other-customer',
            startTime: SUNDAY_10_UTC,
            cancellationDisposition: 'AUTO_CANCEL_ALLOWED',
          }),
        ],
        TZ
      ),
    };
    const foreignPending: PendingFrameSnapshotV2 = {
      questionId: 'q-foreign',
      askedAt: NOW.toISOString(),
      kind: 'CANCEL_CONFIRMATION',
      flowId: 'flow-foreign',
      version: 1,
      options: [
        {
          position: 1,
          entityId: foreignFlow.selectedToken!,
          displayName: foreignFlow.candidates[0]!.displayName,
        },
      ],
    };
    const foreignWrite = await authorized.cancelAppointmentV2Authorized({
      phone: PHONE,
      config,
      pending: foreignPending,
      flow: foreignFlow,
      token: foreignFlow.selectedToken!,
      deps: {
        getUpcomingAppointments: async () => ({
          success: true,
          appointments: [SUNDAY_AUTO],
        }),
        postCancel: async () => {
          throw new Error('POST de cliente alheio não pode ocorrer.');
        },
      },
    });
    assert.equal(foreignWrite.posted, false);
    assert.equal(foreignWrite.success, false);
  }

  // 9. HUMAN_REVIEW / NOT_CANCELABLE / sem disposição → zero POST.
  {
    const review = openConversation({
      appointments: [
        appointment({
          id: 'apt-ia11-paid',
          startTime: SUNDAY_10_UTC,
          cancellationDisposition: 'HUMAN_REVIEW_REQUIRED',
        }),
      ],
    });
    const reviewPrepared = await review.prepare(
      'quero cancelar domingo as 10h'
    );
    assert.equal(review.posts.length, 0);
    assert.equal(review.escalations.length, 1);
    assert.equal(review.escalations[0]?.reasonCode, 'OUT_OF_SCOPE');
    assert.equal(
      reviewPrepared.authoritativeEscalationQuestionId,
      'question-cancel-human-review'
    );
    assert.match(reviewPrepared.payload ?? '', /^Vou avisar /u);

    const blocked = openConversation({
      appointments: [
        appointment({
          id: 'apt-ia11-started',
          startTime: SUNDAY_10_UTC,
          cancellationDisposition: 'NOT_CANCELABLE',
        }),
      ],
    });
    const blockedPrepared = await blocked.prepare(
      'quero cancelar domingo as 10h'
    );
    assert.equal(blocked.posts.length, 0);
    assert.equal(blockedPrepared.payload, flow.NOT_CANCELABLE_COPY_V2);

    const missing = openConversation({
      appointments: [
        appointment({
          id: 'apt-ia11-legacy',
          startTime: SUNDAY_10_UTC,
        }),
      ],
    });
    const missingPrepared = await missing.prepare(
      'quero cancelar domingo as 10h'
    );
    assert.equal(missing.posts.length, 0);
    assert.equal(missing.escalations.length, 1);
    assert.equal(missing.escalations[0]?.reasonCode, 'OUT_OF_SCOPE');
    assert.match(missingPrepared.payload ?? '', /^Vou avisar /u);
  }

  // 10. Opt-out, pausa e takeover vencem entrada e confirmação.
  {
    const pausedEntry = openConversation({ paused: true });
    const pausedPrepared = await pausedEntry.prepare('quero cancelar');
    assert.equal(pausedPrepared.preemption, 'HUMAN_ACTIVE');
    assert.equal(pausedPrepared.payload, null);
    assert.equal(pausedEntry.posts.length, 0);

    const takeover = openConversation({ humanActive: true });
    const takeoverPrepared = await takeover.prepare('quero cancelar');
    assert.equal(takeoverPrepared.preemption, 'HUMAN_ACTIVE');
    assert.equal(takeover.posts.length, 0);

    const takeoverConfirm = openConversation();
    const ask = await takeoverConfirm.prepare('quero cancelar domingo as 10h');
    await takeoverConfirm.deliver(ask);
    const blockedSim = await takeoverConfirm.prepare('sim', {
      humanActive: true,
    });
    assert.equal(blockedSim.preemption, 'HUMAN_ACTIVE');
    assert.equal(takeoverConfirm.posts.length, 0);
  }

  // 11. Nenhum appointmentId em prompt, payload, histórico de modelo ou recibo.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const confirm = await conv.prepare('sim');
    const ids = [SUNDAY_AUTO.id];
    assertNoTechnicalIdLeak(ask.payload ?? '', ids, 'payload confirmação');
    assertNoTechnicalIdLeak(confirm.payload ?? '', ids, 'payload sucesso');
    receipts.assertReceiptRedactedV2(ask.planReceipt, {
      forbiddenPlaintextFragments: ids,
    });
    receipts.assertReceiptRedactedV2(confirm.planReceipt, {
      forbiddenPlaintextFragments: ids,
    });
    const state = await conv.store.loadLatestState(conv.conversationKey, NOW);
    const historyProbe = JSON.stringify({
      payload: confirm.payload,
      receipt: confirm.planReceipt,
      lastDelivery: state.lastAcceptedDelivery?.payload ?? null,
    });
    assertNoTechnicalIdLeak(historyProbe, ids, 'histórico/recibo agregado');
  }

  const bookingProbe = async (
    conv: ReturnType<typeof openConversation>,
    text: string,
    extra?: { now?: Date }
  ) => {
    const bookingHits: string[] = [];
    const prepared = await conv.prepare(text, {
      ...(extra?.now ? { now: extra.now } : {}),
      executeTool: async (name) => {
        if (name === 'getUpcomingAppointments') {
          return upcomingJson([SUNDAY_AUTO, MONDAY_AUTO]);
        }
        if (name === 'bookAppointment') {
          return JSON.stringify({
            success: false,
            reason: 'blocked',
            message: 'INTERNAL_HINT: booking confirmation required',
          });
        }
        throw new Error(`Tool inesperada no probe de booking: ${name}`);
      },
      runModelLoop: async (loopInput) => {
        const result = await loopInput.executeTool('bookAppointment', {});
        bookingHits.push(result);
        return modelLoopResult('Qual dia você prefere?');
      },
    });
    return { prepared, bookingHits };
  };

  const assertAbandonedCancel = (
    prepared: Awaited<ReturnType<ReturnType<typeof openConversation>['prepare']>>,
    posts: CancelAppointmentV2Payload[],
    bookingHits: string[],
    label: string
  ) => {
    assert.equal(posts.length, 0, `${label}: zero POST`);
    const nextFlowState =
      'nextFlowState' in prepared.transition
        ? prepared.transition.nextFlowState
        : undefined;
    assert.ok(nextFlowState, `${label}: nextFlowState`);
    assert.equal(
      nextFlowState?.cancellation,
      undefined,
      `${label}: cancellation removido`
    );
    if (prepared.transition.kind === 'open') {
      assert.equal(
        prepared.transition.frame.kind === 'CANCEL_TARGET' ||
          prepared.transition.frame.kind === 'CANCEL_CONFIRMATION',
        false,
        `${label}: não reabre CANCEL_*`
      );
    } else {
      assert.equal(prepared.transition.kind, 'invalidate', label);
    }
    if (bookingHits.length > 0) {
      assert.equal(
        bookingHits.some((hit) =>
          hit.includes('fluxo de cancelamento conversacional')
        ),
        false,
        `${label}: booking não bloqueado pelo cancel flow`
      );
    }
  };

  // 12. IA-12: abandono — CANCEL_TARGET + "quero agendar Drenagem".
  {
    const conv = openConversation({
      appointments: [SUNDAY_AUTO, MONDAY_AUTO],
    });
    const list = await conv.prepare('quero cancelar');
    await conv.deliver(list);
    const { prepared, bookingHits } = await bookingProbe(
      conv,
      'quero agendar Drenagem'
    );
    assertAbandonedCancel(prepared, conv.posts, bookingHits, 'CANCEL_TARGET→agendar');
  }

  // 13. IA-12: abandono — CANCEL_CONFIRMATION + retirada explícita.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const { prepared, bookingHits } = await bookingProbe(
      conv,
      'não quero cancelar; quero agendar'
    );
    assertAbandonedCancel(
      prepared,
      conv.posts,
      bookingHits,
      'CANCEL_CONFIRMATION→retirada'
    );
  }

  // 14. IA-12: pendência vencida com lastOperationalAt recente.
  {
    const conv = openConversation({
      appointments: [SUNDAY_AUTO, MONDAY_AUTO],
    });
    const list = await conv.prepare('quero cancelar');
    await conv.deliver(list);
    const expiredAskedAt = new Date(NOW.getTime() - 5 * 60 * 60 * 1_000);
    const rows = conv.store.pending.get(conv.conversationKey) ?? [];
    const open = [...rows].reverse().find((row) => row.state === 'OPEN');
    assert.ok(open);
    open.snapshot = { ...open.snapshot, askedAt: expiredAskedAt.toISOString() };
    open.flowState = {
      ...open.flowState,
      lastOperationalAt: NOW.toISOString(),
    };
    open.updatedAt = NOW.toISOString();
    const { prepared, bookingHits } = await bookingProbe(conv, 'quero marcar horário');
    assertAbandonedCancel(
      prepared,
      conv.posts,
      bookingHits,
      'pendência vencida'
    );
  }

  // 15. IA-12: ambiguous_reference não renova lastOperationalAt.
  {
    const conv = openConversation({
      appointments: [SUNDAY_AUTO, MONDAY_AUTO],
    });
    const list = await conv.prepare('quero cancelar');
    await conv.deliver(list);
    const afterList = await conv.store.loadLatestState(conv.conversationKey, NOW);
    const lastOp = afterList.flowState?.lastOperationalAt;
    assert.ok(lastOp);
    const unclear = await conv.prepare('não sei');
    assert.equal(unclear.payload, flow.CANCEL_AMBIGUOUS_REFERENCE_COPY_V2);
    assert.equal(conv.posts.length, 0);
    assert.equal(unclear.transition.kind, 'preserve');
    if (unclear.transition.kind === 'preserve') {
      assert.equal(unclear.transition.nextFlowState?.lastOperationalAt, lastOp);
      assert.ok(unclear.transition.nextFlowState?.cancellation);
    }
  }

  // 16. IA-12: regen runtime boundary→regen sem appointmentId/fingerprint.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const rows = conv.store.pending.get(conv.conversationKey) ?? [];
    const open = [...rows].reverse().find((row) => row.state === 'OPEN');
    assert.ok(open?.flowState.cancellation);
    open.snapshot = {
      ...open.snapshot,
      kind: 'SERVICE',
      options: [
        {
          position: 1,
          entityId: 'svc-drenagem',
          displayName: 'Drenagem Linfática',
        },
        {
          position: 2,
          entityId: 'svc-peeling',
          displayName: 'Peeling Facial',
        },
      ],
    };
    const captured: string[] = [];
    const prepared = await conv.prepare('asdf qwerty', {
      runModelLoop: async () =>
        modelLoopResult('Marquei pra você no domingo às 10h.'),
      regenerate: async (reasonCodes, regenInput) => {
        captured.push(JSON.stringify(regenInput.frame));
        const messages = regenerator.buildRegenerationMessagesV2(
          {
            frame: regenInput.frame as TurnFrameV2,
            catalogSnapshot: { services: [], professionals: [] },
            messages: regenInput.messages as never,
            rejectedCandidate: regenInput.rejectedCandidate,
          },
          reasonCodes as never
        );
        captured.push(JSON.stringify(messages));
        const serializedValidation = JSON.stringify(regenInput.validationContext.frame);
        assert.equal(
          serializedValidation.includes(SUNDAY_AUTO.id) ||
            serializedValidation.includes(sundayFingerprint),
          true,
          'validationContext local conserva o frame completo'
        );
        return {
          ok: true,
          providerCalls: 1,
          resolutionProof: null,
          result: {
            schemaVersion: 2,
            reply: 'Qual serviço você prefere?',
            replyPurpose: 'OPERATIONAL_ANSWER',
            pendingTransitionCandidate: { kind: 'preserve' },
            resolutionCandidate: null,
            unknownServiceEvidence: null,
          },
        };
      },
    });
    assert.equal(captured.length, 2);
    for (const blob of captured) {
      assertNoTechnicalIdLeak(blob, sundaySecrets, 'regen runtime');
    }
    assert.equal(prepared.planReceipt.route, 'regen');
    assert.equal(conv.posts.length, 0);
  }

  // 17. IA-12: checkpoint entre releitura e POST → posts=0.
  {
    const conv = openConversation();
    const ask = await conv.prepare('quero cancelar domingo as 10h');
    await conv.deliver(ask);
    const stages: V2CheckpointStage[] = [];
    const confirm = await conv.prepare('sim', {
      checkpoint: async (stage) => {
        stages.push(stage);
        if (stage === 'before_cancel_post') {
          return {
            paused: false,
            latestInputSequence: 3,
            successorInputSequence: 3,
            successorInboundMessageIds: [nextId()],
          };
        }
        return {
          paused: false,
          latestInputSequence: 2,
          successorInputSequence: null,
          successorInboundMessageIds: [],
        };
      },
    });
    assert.equal(stages.includes('before_cancel_post'), true);
    assert.equal(conv.posts.length, 0);
    assert.equal(confirm.preemption, 'SUPERSEDED_BY_NEW_INBOUND');
    assert.equal(confirm.payload, null);
    assert.equal(confirm.hasCommittedWrite, false);
  }

  const conflict = flow.__cancellationFlowForSmokeV2.inboundDateTimeConstraintV2({
    text: 'quero cancelar segunda 16/08 as 10h',
    dateResolution: { kind: 'resolved', date: '2026-08-16', mentions: ['16/08'] },
    now: NOW,
    timezone: TZ,
  });
  assert.equal(conflict.kind, 'ambiguous');

  console.log(
    'PASS smoke cancelamento conversacional v2: IA-11 + IA-12 (regen sem vazamento, abandono/TTL, checkpoint pré-POST).'
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
