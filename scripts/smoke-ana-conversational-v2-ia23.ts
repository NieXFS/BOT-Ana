import assert from 'node:assert/strict';
import type {
  FlowStateV2,
  TurnDeliveryReceiptV2,
} from '../src/services/conversationalV2/contracts';
import { opaqueReceiptHashV2 } from '../src/services/conversationalV2/receipts';
import {
  MemoryConversationalV2StateStore,
  resolveLatestFlowStateV2,
  type MaterializedPendingTransitionV2,
  type OutboundOutboxRecordV2,
} from '../src/services/conversationalV2/stateStore';
import { parsePersistedFlowStateV2 } from '../src/services/conversationalV2/flowStateParser';

const t0 = new Date('2026-08-21T15:00:00.000Z');

function minimalFlow(flowId: string, terminalAt = t0.toISOString()): FlowStateV2 {
  return {
    flowId,
    lastOperationalAt: terminalAt,
    fixedByProofVersion: {},
  };
}

function fullFlow(): FlowStateV2 {
  return {
    flowId: 'flow-full',
    lastOperationalAt: t0.toISOString(),
    fixedServiceId: 'svc-manicure',
    fixedProfessionalId: 'pro-ana',
    resolvedDate: '2026-08-21',
    bookingDraft: {
      serviceId: 'svc-manicure',
      professionalId: 'pro-ana',
      date: '2026-08-21',
      time: '18:00',
      slotEvidenceTurnId: 'turn-slots',
    },
    slotEvidence: {
      turnId: 'turn-slots',
      serviceId: 'svc-manicure',
      professionalId: 'pro-ana',
      date: '2026-08-21',
      slots: ['18:00', '18:30'],
    },
    bookingReentry: {
      pendingKind: 'TIME',
      optionEntityIds: ['18:00', '18:30'],
    },
    duplicateResolution: {
      kind: 'keep_both',
      readEvidenceTurnId: 'turn-duplicate-read',
      sourcePendingVersion: 2,
      serviceId: 'svc-manicure',
      professionalId: 'pro-ana',
      date: '2026-08-21',
      time: '18:00',
    },
    duplicatePreflightClearance: {
      kind: 'no_conflict',
      readEvidenceTurnId: 'turn-preflight-read',
      sourcePendingKind: 'CONFIRMATION',
      sourcePendingVersion: 3,
      serviceId: 'svc-manicure',
      professionalId: 'pro-ana',
      date: '2026-08-21',
      time: '18:00',
    },
    cancellation: {
      flowId: 'flow-full',
      sourceReadTurnId: 'turn-cancel-read',
      candidates: [
        {
          token: 'cancel-target:appointment-1',
          appointmentId: 'appointment-1',
          startTime: '2026-08-21T18:00:00.000Z',
          fingerprint: 'fp-appointment-1',
          disposition: 'AUTO_CANCEL_ALLOWED',
          displayName: 'Manicure',
        },
      ],
      selectedToken: 'cancel-target:appointment-1',
    },
    deferredAvailability: {
      schemaVersion: 1,
      capturedAt: t0.toISOString(),
      capturedTurnId: 'turn-deferred',
      capturedInputSequence: 4,
      date: '2026-08-21',
      timeWindow: { kind: 'AFTER_EXCLUSIVE', minuteOfDay: 17 * 60 + 30 },
    },
    fixedByProofVersion: {
      fixedServiceId: 1,
      fixedProfessionalId: 1,
      resolvedDate: 1,
    },
  };
}

function receipt(input: {
  id: string;
  terminalAt: string;
  state: TurnDeliveryReceiptV2['outboxState'];
  flowStateCommitOutcome?: TurnDeliveryReceiptV2['flowStateCommitOutcome'];
  conversationCommitOutcome?: TurnDeliveryReceiptV2['conversationCommitOutcome'];
}): TurnDeliveryReceiptV2 {
  return {
    schemaVersion: 2,
    deliveryReceiptId: `receipt-${input.id}`,
    planReceiptId: `plan-${input.id}`,
    turnId: `turn-${input.id}`,
    deliveryAttemptId: input.id,
    transportStartedAt: input.terminalAt,
    transportOutcome:
      input.state === 'accepted_by_provider'
        ? 'accepted_by_provider'
        : input.state === 'transport_failed'
          ? 'transport_failed'
          : 'transport_unknown',
    providerMessageIdHash: opaqueReceiptHashV2(`provider-${input.id}`),
    outboxState: input.state,
    flowStateCommitOutcome: input.flowStateCommitOutcome,
    conversationCommitOutcome:
      input.conversationCommitOutcome ??
      (input.state === 'accepted_by_provider' ? 'committed' : 'failed'),
    pendingCommitOutcome: 'not_applicable',
    expectedPendingVersion: null,
    observedPendingVersion: null,
    terminalAt: input.terminalAt,
  };
}

function outbox(input: {
  id: string;
  terminalAt: string;
  flowState: FlowStateV2;
  state?: OutboundOutboxRecordV2['state'];
  flowStateCommitOutcome?: TurnDeliveryReceiptV2['flowStateCommitOutcome'];
  conversationKey?: string;
}): OutboundOutboxRecordV2 {
  const state = input.state ?? 'accepted_by_provider';
  const transition: MaterializedPendingTransitionV2 = {
    kind: 'preserve',
    nextFlowState: input.flowState,
  };
  const deliveryReceipt = receipt({
    id: input.id,
    terminalAt: input.terminalAt,
    state,
    flowStateCommitOutcome:
      input.flowStateCommitOutcome ??
      (state === 'accepted_by_provider' ? 'committed' : 'not_applicable'),
  });
  return {
    deliveryAttemptId: input.id,
    conversationKey: input.conversationKey ?? 'PN:ia23',
    turnId: `turn-${input.id}`,
    planReceiptId: `plan-${input.id}`,
    state,
    payload: 'copy fixture',
    transition,
    providerMessageIdHash: opaqueReceiptHashV2(`provider-${input.id}`),
    providerStatus: null,
    providerStatusAt: null,
    providerFailureCode: null,
    providerStatusVersion: 0,
    transportStartedAt: input.terminalAt,
    commitPayload: {
      assistantText: 'copy fixture',
      transition,
      deliveryReceipt,
    },
    createdAt: input.terminalAt,
    updatedAt: '2099-01-01T00:00:00.000Z',
  };
}

async function main(): Promise<void> {
  const valid = fullFlow();
  assert.deepEqual(parsePersistedFlowStateV2(valid), valid);
  const malformedCases: Array<[string, (flow: FlowStateV2) => unknown]> = [
    ['flowId', (flow) => ({ ...flow, flowId: '' })],
    ['lastOperationalAt', (flow) => ({ ...flow, lastOperationalAt: 'not-a-date' })],
    ['resolvedDate', (flow) => ({ ...flow, resolvedDate: '2026-02-30' })],
    ['bookingDraft', (flow) => ({ ...flow, bookingDraft: { ...flow.bookingDraft!, time: '25:00' } })],
    ['slotEvidence', (flow) => ({ ...flow, slotEvidence: { ...flow.slotEvidence!, slots: ['18:00', '18:00'] } })],
    ['bookingReentry', (flow) => ({ ...flow, bookingReentry: { ...flow.bookingReentry!, pendingKind: 'NOT_A_KIND' } })],
    ['duplicateResolution', (flow) => ({ ...flow, duplicateResolution: { ...flow.duplicateResolution!, date: 'bad' } })],
    ['duplicatePreflightClearance', (flow) => ({ ...flow, duplicatePreflightClearance: { ...flow.duplicatePreflightClearance!, sourcePendingVersion: 0 } })],
    ['cancellation', (flow) => ({ ...flow, cancellation: { ...flow.cancellation!, selectedToken: 'cancel-target:missing' } })],
    ['deferredAvailability', (flow) => ({ ...flow, deferredAvailability: { ...flow.deferredAvailability!, timeWindow: { kind: 'EXACT', minuteOfDay: 2000 } } })],
    ['fixedByProofVersion', (flow) => ({ ...flow, fixedByProofVersion: { fixedServiceId: 0 } })],
  ];
  for (const [name, mutate] of malformedCases) {
    assert.equal(parsePersistedFlowStateV2(mutate(valid)), null, `malformed ${name}`);
  }
  assert.equal(
    parsePersistedFlowStateV2({
      flowId: 'flow-1',
      fixedServiceId: 'svc-a',
      resolvedDate: '2026-08-21',
      slotEvidence: {
        turnId: 'turn-slots',
        serviceId: 'svc-b',
        date: '2026-08-22',
        slots: ['18:00'],
      },
      fixedByProofVersion: { fixedServiceId: 1, resolvedDate: 1 },
    }),
    null,
    'cross-field service/date slot evidence mismatch is fail-closed'
  );
  assert.equal(
    parsePersistedFlowStateV2({
      flowId: 'flow-1',
      fixedServiceId: 'svc-a',
      fixedProfessionalId: 'prof-a',
      resolvedDate: '2026-08-21',
      slotEvidence: {
        turnId: 'turn-slots',
        serviceId: 'svc-a',
        professionalId: 'prof-b',
        date: '2026-08-21',
        slots: ['18:00'],
      },
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    }),
    null,
    'cross-field professional evidence mismatch is fail-closed'
  );
  assert.equal(
    parsePersistedFlowStateV2({
      ...valid,
      slotEvidence: undefined,
    }),
    null,
    'bookingDraft requires integral slotEvidence'
  );
  assert.equal(
    parsePersistedFlowStateV2({
      ...valid,
      duplicateResolution: {
        ...valid.duplicateResolution!,
        serviceId: 'svc-other',
      },
    }),
    null,
    'duplicate resolution tuple must match fixed service'
  );
  assert.equal(
    parsePersistedFlowStateV2({
      ...valid,
      duplicatePreflightClearance: {
        ...valid.duplicatePreflightClearance!,
        professionalId: 'prof-other',
      },
    }),
    null,
    'duplicate clearance tuple must match fixed professional'
  );
  assert.equal(
    parsePersistedFlowStateV2({ ...valid, unexpected: true }),
    null,
    'unknown top-level shape is fail-closed'
  );

  const old = outbox({
    id: 'old',
    terminalAt: '2026-08-21T15:00:01.000Z',
    flowState: minimalFlow('flow-old', '2026-08-21T15:00:01.000Z'),
  });
  const newer = outbox({
    id: 'newer',
    terminalAt: '2026-08-21T15:00:02.000Z',
    flowState: minimalFlow('flow-newer', '2026-08-21T15:00:02.000Z'),
  });
  const projected = resolveLatestFlowStateV2({
    latestPendingRecord: null,
    lastAcceptedOutbox: old,
    acceptedOutboxes: [old, newer],
    now: t0,
  });
  assert.equal(projected?.flowId, 'flow-newer');
  assert.equal(
    resolveLatestFlowStateV2({
      latestPendingRecord: null,
      lastAcceptedOutbox: newer,
      acceptedOutboxes: [
        outbox({
          id: 'failed',
          terminalAt: '2026-08-21T15:00:03.000Z',
          flowState: minimalFlow('flow-failed'),
          state: 'transport_failed',
        }),
        outbox({
          id: 'uncommitted',
          terminalAt: '2026-08-21T15:00:04.000Z',
          flowState: minimalFlow('flow-uncommitted'),
          state: 'accepted_uncommitted',
          flowStateCommitOutcome: 'accepted_uncommitted',
        }),
      ],
      now: t0,
    })?.flowId,
    'flow-newer'
  );
  const off = resolveLatestFlowStateV2({
    latestPendingRecord: null,
    lastAcceptedOutbox: newer,
    now: t0,
    featureEnabled: false,
  });
  assert.equal(off?.flowId, 'flow-newer');
  assert.equal(off?.deferredAvailability, undefined);

  // Fence crítico: provider aceitou em T1, commit local falhou, humano
  // assumiu em T2, reconciliação em T3. O aceite e o histórico permanecem
  // factuais, mas o agregado antigo não é ressuscitado.
  const store = new MemoryConversationalV2StateStore();
  const key = 'PN:ia23-race';
  const flow = minimalFlow('flow-human-cutoff', '2026-08-21T15:00:01.000Z');
  const transition: MaterializedPendingTransitionV2 = { kind: 'preserve', nextFlowState: flow };
  await store.prepareOutbound({
    deliveryAttemptId: 'attempt-race',
    conversationKey: key,
    turnId: 'turn-race',
    planReceiptId: 'plan-race',
    payload: 'copy aceita',
    transition,
    now: new Date('2026-08-21T15:00:01.000Z'),
  });
  await store.markTransportStarted('attempt-race', new Date('2026-08-21T15:00:01.000Z'));
  await store.markAcceptedUncommitted({
    deliveryAttemptId: 'attempt-race',
    providerMessageIdHash: opaqueReceiptHashV2('provider-race'),
    commitPayload: {
      assistantText: 'copy aceita',
      transition,
      deliveryReceipt: receipt({
        id: 'attempt-race',
        terminalAt: '2026-08-21T15:00:01.000Z',
        state: 'accepted_by_provider',
      }),
    },
    now: new Date('2026-08-21T15:00:01.000Z'),
  });
  await store.invalidateOpenPendingByHuman(key, new Date('2026-08-21T15:00:02.000Z'));
  const reconciled = await store.reconcileAcceptedCommit(
    'attempt-race',
    new Date('2026-08-21T15:00:03.000Z')
  );
  assert.equal(reconciled.flowStateCommitOutcome, 'skipped_human_cutoff');
  assert.equal(store.outbox.get('attempt-race')?.state, 'accepted_by_provider');
  assert.equal(store.outbox.get('attempt-race')?.commitPayload?.deliveryReceipt.transportOutcome, 'accepted_by_provider');
  assert.equal((await store.loadLatestState(key, new Date('2026-08-21T15:00:03.000Z'))).flowState, null);
  assert.equal((await store.loadLatestState(key, new Date('2026-08-21T15:00:03.000Z'))).pending, null);
  assert.deepEqual(store.assistantHistory.get(key), ['copy aceita']);
  assert.equal(store.transportPostCount, 1);
  assert.equal(
    (await store.reconcileAcceptedCommit('attempt-race', new Date('2026-08-21T15:00:04.000Z'))).flowStateCommitOutcome,
    'skipped_human_cutoff'
  );

  // Ordem inversa: commit vence a lock, mas takeover posterior ainda corta a
  // projeção no reload; o delivery aceito continua factual.
  const afterStore = new MemoryConversationalV2StateStore();
  const afterKey = 'PN:ia23-after';
  await afterStore.prepareOutbound({
    deliveryAttemptId: 'attempt-after',
    conversationKey: afterKey,
    turnId: 'turn-after',
    planReceiptId: 'plan-after',
    payload: 'copy anterior',
    transition: { kind: 'preserve', nextFlowState: minimalFlow('flow-after') },
    now: new Date('2026-08-21T15:00:01.000Z'),
  });
  await afterStore.markTransportStarted('attempt-after', new Date('2026-08-21T15:00:01.000Z'));
  await afterStore.commitAccepted({
    deliveryAttemptId: 'attempt-after',
    providerMessageIdHash: opaqueReceiptHashV2('provider-after'),
    commitPayload: {
      assistantText: 'copy anterior',
      transition: { kind: 'preserve', nextFlowState: minimalFlow('flow-after') },
      deliveryReceipt: receipt({
        id: 'attempt-after',
        terminalAt: '2026-08-21T15:00:01.000Z',
        state: 'accepted_by_provider',
      }),
    },
    now: new Date('2026-08-21T15:00:01.000Z'),
  });
  assert.equal((await afterStore.loadLatestState(afterKey, t0)).flowState?.flowId, 'flow-after');
  await afterStore.invalidateOpenPendingByHuman(afterKey, new Date('2026-08-21T15:00:02.000Z'));
  assert.equal((await afterStore.loadLatestState(afterKey, t0)).flowState, null);
  assert.equal(afterStore.outbox.get('attempt-after')?.state, 'accepted_by_provider');
  assert.deepEqual(afterStore.assistantHistory.get(afterKey), ['copy anterior']);

  console.log('smoke-ana-conversational-v2-ia23: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
