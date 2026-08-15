#!/usr/bin/env ts-node
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import { getReceptionistReplyV2 } from '../src/services/conversationalV2/runtime';
import { deliverPreparedReceptionistTurnV2 } from '../src/services/conversationalV2/delivery';
import { evaluateBoundaryV2 } from '../src/services/conversationalV2/boundary';
import { assertReceiptRedactedV2, opaqueReceiptHashV2 } from '../src/services/conversationalV2/receipts';
import type { TurnFrameV2 } from '../src/services/conversationalV2/contracts';
import { MemoryConversationalV2StateStore } from '../src/services/conversationalV2/stateStore';
import {
  applyConversationalVoiceV2,
  assertLiveVoiceModelReceiptV2,
  COMPILED_VOICE_POOLS_V2,
  composePhase1AVoiceRewriteV2,
  evaluateVoiceFidelityV2,
  fastPathProvenanceV2,
  getVoiceCopyRegistryV2,
  isBlockedLiveVoiceModelV2,
  isPermanentVoiceDenylistV2,
  parseVoiceConnectiveIdV2,
  renderCompiledPoolConnectiveV2,
  resolveVoiceCopyPolicyV2,
  selectCompiledPoolVariantForTestV2,
  selectCompiledPoolVariantV2,
  shouldKeepVoiceProvenanceV2,
  VOICE_CONNECTIVE_IDS_V2,
  VOICE_CONNECTIVE_PHRASES_V2,
  VOICE_PERMANENT_DENYLIST_V2,
  VOICE_POLICY_VERSION_V2,
  VOICE_TEMPLATE_VERSION_V2,
} from '../src/services/conversationalV2/voice';
import { findWorkflowLanguageV2 } from '../src/services/conversationalV2/workflowLanguage';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/voice';
process.env.OPENAI_API_KEY = 'sk-smoke-invalid';
process.env.ERP_API_TOKEN = 'smoke-invalid';

const now = new Date('2026-08-14T15:00:00.000Z');
let serial = 0;
const nextId = () => `voice-v2-${++serial}`;

const services: ServicesResult = {
  success: true,
  services: [
    {
      id: 'svc-peeling',
      name: 'Peeling facial',
      durationMinutes: 45,
      price: 140,
      priceFormatted: 'R$ 140,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: ['prof-carla'],
    },
    {
      id: 'svc-limpeza',
      name: 'Limpeza de Pele Profunda',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-carla'],
    },
  ],
  professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
};

const config = {
  tenantSlug: 'tenant-v2-voice',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda.',
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
  phoneNumberId: 'PN-V2-VOICE',
  isActive: true,
  authoritativeCatalog: {
    tenant: { name: 'Clínica Fixture', address: 'Rua Fixture, 1' },
    services: [],
    professionals: [],
  },
} as TenantBotConfig;

function completionFor(content: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'voice-completion',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    system_fingerprint: 'fp_voice_smoke',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content,
          refusal: null,
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function turnRuntime(text: string, sequence = 1) {
  const inboundId = nextId();
  return {
    inputSequence: sequence,
    currentInboundIds: [inboundId],
    currentInboundTextsById: { [inboundId]: text },
    checkpoint: async () => ({
      paused: false,
      latestInputSequence: sequence,
      successorInputSequence: null,
      successorInboundMessageIds: [],
    }),
  };
}

const frame: TurnFrameV2 = {
  schemaVersion: 2,
  turnId: 'turn-voice',
  inputSequence: 1,
  catalogSnapshotHash: opaqueReceiptHashV2('catalog'),
  catalogState: 'available',
  humanControl: 'NO_ACTIVE_TAKEOVER',
  currentInboundIds: ['in-1'],
  pending: null,
  flowState: { flowId: 'flow-voice', fixedByProofVersion: {} },
};

async function main(): Promise<void> {
  const registry = getVoiceCopyRegistryV2();
  assert.equal(VOICE_POLICY_VERSION_V2, 3);
  assert.equal(VOICE_TEMPLATE_VERSION_V2, 2);
  assert.equal(VOICE_CONNECTIVE_PHRASES_V2.combinado_dot, 'Combinado, então.');
  for (const phrase of Object.values(VOICE_CONNECTIVE_PHRASES_V2)) {
    assert.deepEqual(findWorkflowLanguageV2(phrase), []);
  }
  for (const pool of COMPILED_VOICE_POOLS_V2) {
    for (const variant of pool.variants) {
      assert.deepEqual(
        findWorkflowLanguageV2(variant.connective),
        [],
        `${pool.copyId} ${variant.variantId}`
      );
    }
  }
  assert.deepEqual(
    [...VOICE_CONNECTIVE_IDS_V2],
    ['claro', 'combinado', 'vamos_la', 'perfeito', 'otimo', 'combinado_dot']
  );
  assert.equal(parseVoiceConnectiveIdV2('{"connectiveId":"combinado"}'), 'combinado');
  assert.equal(parseVoiceConnectiveIdV2('claro'), 'claro');
  assert.equal(parseVoiceConnectiveIdV2('{"connective":"Claro!"}'), null);
  assert.equal(parseVoiceConnectiveIdV2('Botox funciona!'), null);
  assert.equal(parseVoiceConnectiveIdV2('{"connectiveId":"claro","extra":true}'), null);
  assert.equal(isBlockedLiveVoiceModelV2('deepseek-v4-flash-mock'), true);
  assert.equal(isBlockedLiveVoiceModelV2('gpt-4o-mini'), true);
  assert.equal(isBlockedLiveVoiceModelV2('deepseek-v4-flash'), false);
  assert.throws(() =>
    assertLiveVoiceModelReceiptV2({
      provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash',
      returnedModel: 'deepseek-v4-flash-mock',
      decision: 'accepted',
    })
  );
  assert.equal(isPermanentVoiceDenylistV2('write_success_confirmation'), true);
  assert.equal(Object.isFrozen(registry), true);
  for (const copyId of VOICE_PERMANENT_DENYLIST_V2) {
    assert.equal(registry[copyId].mode, 'off', copyId);
    assert.equal(isPermanentVoiceDenylistV2(copyId), true);
  }

  const mutated = registry as {
    canonical_booking_summary: { mode: string };
  };
  const beforeMode = mutated.canonical_booking_summary.mode;
  try {
    mutated.canonical_booking_summary = {
      ...mutated.canonical_booking_summary,
      mode: 'rephrase_v1',
    };
  } catch {
    // freeze
  }
  try {
    mutated.canonical_booking_summary.mode = 'rephrase_v1';
  } catch {
    // freeze
  }
  assert.equal(registry.canonical_booking_summary.mode, beforeMode);
  const forgedAnchor = resolveVoiceCopyPolicyV2({
    producer: 'fast_path',
    copyId: 'canonical_booking_summary',
    templateVersion: 1,
  } as never);
  assert.equal(forgedAnchor, null);
  assert.equal(isPermanentVoiceDenylistV2('canonical_booking_summary'), true);

  assert.equal(
    shouldKeepVoiceProvenanceV2({
      recoveryKind: 'none',
      recoveryPayload: 'template',
      provenancedPayload: 'template',
    }),
    true
  );
  assert.equal(
    shouldKeepVoiceProvenanceV2({
      recoveryKind: 'regen',
      recoveryPayload: 'template',
      provenancedPayload: 'template',
    }),
    false
  );
  assert.equal(
    shouldKeepVoiceProvenanceV2({
      recoveryKind: 'none',
      recoveryPayload: 'fallback',
      provenancedPayload: 'template',
    }),
    false
  );
  assert.equal(
    shouldKeepVoiceProvenanceV2({
      recoveryKind: 'direct_fallback',
      recoveryPayload: 'fallback',
      provenancedPayload: 'template',
    }),
    false
  );

  const forged = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: 'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial e Drenagem Linfática. Qual você prefere?',
    provenance: {
      producer: 'model',
      copyId: 'initial_service_question',
      templateVersion: 1,
    } as never,
    frame,
    candidate: { kind: 'preserve' },
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: { servicesResult: services },
    checkpoint: async () => null,
    completionFactory: async () => completionFor('não deveria chamar'),
  });
  assert.equal(forged.kind, 'payload');
  if (forged.kind === 'payload') {
    assert.equal(forged.receipt, null);
  }

  const serviceTemplate =
    'Claro! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?';
  const candidate = {
    kind: 'open' as const,
    pendingKind: 'SERVICE' as const,
    flowId: 'flow-voice',
    optionEntityIds: ['svc-peeling', 'svc-drenagem', 'svc-limpeza'],
  };
  const boundaryCtx = { servicesResult: services, route: 'model' as const };

  let voiceCalls = 0;
  const accepted = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: serviceTemplate,
    provenance: fastPathProvenanceV2('initial_service_question'),
    frame,
    candidate,
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => null,
    completionFactory: async (input) => {
      voiceCalls += 1;
      assert.deepEqual(input.tools, []);
      assert.equal(input.thinkingMode, 'disabled');
      assert.equal(input.temperature, 0.3);
      assert.ok(input.messages.every((message) => message.role === 'system'));
      return completionFor('{"connectiveId":"combinado"}');
    },
  });
  assert.equal(voiceCalls, 1);
  assert.equal(accepted.kind, 'payload');
  if (accepted.kind === 'payload') {
    assert.equal(accepted.receipt?.decision, 'accepted');
    assert.equal(accepted.receipt?.outcome, 'accepted');
    assert.equal(accepted.receipt?.providerCallCount, 1);
    assert.notEqual(accepted.payload, serviceTemplate);
    assert.match(accepted.payload, /^Combinado! Para qual serviço/);
    assertReceiptRedactedV2({
      schemaVersion: 2,
      planReceiptId: 'plan',
      turnId: 'turn',
      frameHash: opaqueReceiptHashV2('frame'),
      inputSequence: 1,
      route: 'fast_path',
      provider: 'openai',
      requestedModel: 'gpt-4o-mini',
      response: { model: null, systemFingerprint: null },
      thinkingMode: 'disabled',
      strictTools: false,
      primaryModelRounds: 0,
      primaryProviderCalls: 0,
      regenProviderCalls: 0,
      pendingTransitionCandidate: { kind: 'preserve' },
      toolEffects: [],
      boundaryAttempts: [],
      recoveryKind: 'none',
      voice: accepted.receipt!,
      result: 'accepted_for_delivery',
    });
    assert.match(accepted.receipt!.sourceHash, /^[a-f0-9]{64}$/i);
  }

  voiceCalls = 0;
  const unchanged = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: serviceTemplate,
    provenance: fastPathProvenanceV2('initial_service_question'),
    frame,
    candidate,
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => null,
    completionFactory: async () => {
      voiceCalls += 1;
      return completionFor('{"connectiveId":"claro"}');
    },
  });
  assert.equal(voiceCalls, 1);
  assert.equal(unchanged.kind, 'payload');
  if (unchanged.kind === 'payload') {
    assert.equal(unchanged.receipt?.decision, 'unchanged');
    assert.equal(unchanged.payload, serviceTemplate);
  }

  voiceCalls = 0;
  const polarityRejected = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: serviceTemplate,
    provenance: fastPathProvenanceV2('initial_service_question'),
    frame,
    candidate,
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => null,
    completionFactory: async () => {
      voiceCalls += 1;
      return completionFor(
        'Não temos Peeling facial. Temos Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?'
      );
    },
  });
  assert.equal(voiceCalls, 1);
  assert.equal(polarityRejected.kind, 'payload');
  if (polarityRejected.kind === 'payload') {
    assert.equal(polarityRejected.payload, serviceTemplate);
    assert.equal(polarityRejected.receipt?.outcome, 'voice_rejected');
    assert.equal(polarityRejected.receipt?.decision, 'fidelity_rejected_template');
  }

  voiceCalls = 0;
  const timedOut = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: serviceTemplate,
    provenance: fastPathProvenanceV2('initial_service_question'),
    frame,
    candidate,
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => null,
    timeoutMs: 20,
    completionFactory: async () =>
      new Promise(() => {
        voiceCalls += 1;
      }),
  });
  assert.equal(timedOut.kind, 'payload');
  if (timedOut.kind === 'payload') {
    assert.equal(timedOut.payload, serviceTemplate);
    assert.equal(timedOut.receipt?.decision, 'timeout_template');
    assert.equal(timedOut.receipt?.outcome, 'voice_rejected');
  }

  const denylist = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: 'Tudo certo! Seu agendamento foi confirmado com sucesso.',
    provenance: {
      producer: 'fast_path',
      copyId: 'write_success_confirmation',
      templateVersion: 1,
    } as never,
    frame,
    candidate: { kind: 'preserve' },
    replyPurpose: 'WRITE_CONFIRMATION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => {
      throw new Error('denylist não chama checkpoint de voz');
    },
    completionFactory: async () => {
      throw new Error('denylist não chama provider');
    },
  });
  assert.equal(denylist.kind, 'payload');
  if (denylist.kind === 'payload') {
    assert.equal(denylist.receipt, null);
    assert.equal(
      denylist.payload,
      'Tudo certo! Seu agendamento foi confirmado com sucesso.'
    );
  }

  for (const copyId of VOICE_PERMANENT_DENYLIST_V2) {
    let calls = 0;
    const blocked = await applyConversationalVoiceV2({
      config,
      enabled: true,
      templatePayload: 'âncora',
      provenance: {
        producer: 'fast_path',
        copyId,
        templateVersion: 1,
      } as never,
      frame,
      candidate: { kind: 'preserve' },
      replyPurpose: 'OPERATIONAL_ANSWER',
      services,
      boundaryContext: boundaryCtx,
      checkpoint: async () => {
        throw new Error(`âncora ${copyId} não chama checkpoint`);
      },
      completionFactory: async () => {
        calls += 1;
        throw new Error(`âncora ${copyId} não chama provider`);
      },
    });
    assert.equal(blocked.kind, 'payload', copyId);
    if (blocked.kind === 'payload') {
      assert.equal(blocked.receipt, null, copyId);
      assert.equal(calls, 0, copyId);
    }
  }

  let checkpoints = 0;
  const raced = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload: serviceTemplate,
    provenance: fastPathProvenanceV2('initial_service_question'),
    frame,
    candidate,
    replyPurpose: 'SERVICE_QUESTION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => {
      checkpoints += 1;
      return checkpoints === 1 ? 'SUPERSEDED_BY_NEW_INBOUND' : null;
    },
    completionFactory: async () => completionFor(serviceTemplate),
  });
  assert.equal(raced.kind, 'preempted');
  if (raced.kind === 'preempted') {
    assert.equal(raced.preemption, 'SUPERSEDED_BY_NEW_INBOUND');
    assert.equal(raced.payload, serviceTemplate);
  }

  const voiceSourceBoundary = evaluateBoundaryV2({
    rawCandidate:
      'Combinado! Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    servicesResult: services,
    replyPurpose: 'SERVICE_QUESTION',
    source: 'VOICE_REPHRASE',
    route: 'model',
  });
  assert.equal(voiceSourceBoundary.safe, true, voiceSourceBoundary.reasonCodes.join(','));

  for (const pool of COMPILED_VOICE_POOLS_V2) {
    assert.equal(pool.reviewStatus, 'PENDENTE-PAINEL');
    assert.equal(pool.provenance.note, 'PENDENTE-PAINEL');
    assert.ok(pool.variants.length >= 8);
    assert.equal(
      selectCompiledPoolVariantV2({ copyId: pool.copyId, seed: 1 }),
      null
    );
    const selected = selectCompiledPoolVariantForTestV2({
      copyId: pool.copyId,
      seed: 1,
      reviewOverride: 'aprovado',
    });
    assert.ok(selected);
    const canonicalSlots =
      'Encontrei horários para 14/08/2026: 15h e 16h. Qual você prefere?';
    const canonicalReentry =
      'A gente estava marcando Peeling facial para 14/08/2026 — quer continuar esse agendamento ou marcar outro?';
    for (const variant of pool.variants) {
      const rendered = renderCompiledPoolConnectiveV2(variant.connective, {
        date: '14/08/2026',
        slots: '15h e 16h',
        service: 'Peeling facial',
        timePart: '',
      });
      const fidelity = evaluateVoiceFidelityV2({
        copyId: pool.copyId,
        template: pool.copyId === 'availability_slots_offer' ? canonicalSlots : canonicalReentry,
        rewrite: rendered,
        catalog: {
          services: ['Peeling facial', 'Drenagem Linfática', 'Limpeza de Pele Profunda'],
          professionals: ['Carla Mendes'],
        },
      });
      assert.equal(
        fidelity.safe,
        true,
        `${pool.copyId} ${variant.variantId}: ${fidelity.reasons.join(',')}`
      );
    }
  }

  const store = new MemoryConversationalV2StateStore();
  const phone = '5511000000099';
  store.setInputSequence(`${config.phoneNumberId}:${phone}`, 1);
  let modelCalls = 0;
  let runtimeVoiceCalls = 0;
  const prepared = await getReceptionistReplyV2({
    phone,
    userMessage: 'quero agendar',
    userName: 'Cliente',
    config,
    voiceEnabled: true,
    turnRuntime: turnRuntime('quero agendar'),
    deps: {
      store,
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      voiceEnabled: true,
      runModelLoop: async () => {
        modelCalls += 1;
        throw new Error('fast-path 1A não chama brain');
      },
      rephraseCompletion: async () => {
        runtimeVoiceCalls += 1;
        return completionFor('{"connectiveId":"vamos_la"}');
      },
    },
  });
  assert.equal(modelCalls, 0);
  assert.equal(runtimeVoiceCalls, 1);
  assert.equal(prepared.planReceipt.route, 'fast_path');
  assert.equal(prepared.planReceipt.voice?.decision, 'accepted');
  assert.equal(prepared.planReceipt.primaryProviderCalls, 0);
  assert.match(prepared.payload ?? '', /Peeling facial/);
  assert.notEqual(prepared.copyVariant, undefined);

  const confirmationStore = new MemoryConversationalV2StateStore();
  confirmationStore.setInputSequence(`${config.phoneNumberId}:5511000000100`, 1);
  let confirmationVoiceCalls = 0;
  const confirmation = await applyConversationalVoiceV2({
    config,
    enabled: true,
    templatePayload:
      'Confirmando: Peeling facial, em 14/08/2026, às 15h. Posso marcar?',
    provenance: {
      producer: 'fast_path',
      copyId: 'canonical_booking_summary',
      templateVersion: 1,
    } as never,
    frame,
    candidate: {
      kind: 'open',
      pendingKind: 'CONFIRMATION',
      flowId: 'flow-voice',
      optionEntityIds: ['booking-confirmation:flow-voice'],
    },
    replyPurpose: 'WRITE_CONFIRMATION',
    services,
    boundaryContext: boundaryCtx,
    checkpoint: async () => null,
    completionFactory: async () => {
      confirmationVoiceCalls += 1;
      return completionFor('não');
    },
  });
  assert.equal(confirmationVoiceCalls, 0);
  assert.equal(confirmation.kind, 'payload');
  if (confirmation.kind === 'payload') {
    assert.equal(confirmation.receipt, null);
  }

  const dateTemplate = 'Perfeito. Qual dia você prefere?';
  const dateCandidate = {
    kind: 'open' as const,
    pendingKind: 'DATE' as const,
    flowId: 'flow-voice',
    optionEntityIds: ['date-freeform'],
  };
  const probe = async (rewrite: string) => {
    let calls = 0;
    const result = await applyConversationalVoiceV2({
      config,
      enabled: true,
      templatePayload: dateTemplate,
      provenance: fastPathProvenanceV2('service_selected_date_question'),
      frame,
      candidate: dateCandidate,
      replyPurpose: 'DATE_TIME_QUESTION',
      services,
      boundaryContext: boundaryCtx,
      checkpoint: async () => null,
      completionFactory: async () => {
        calls += 1;
        return completionFor(rewrite);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.kind, 'payload');
    if (result.kind !== 'payload') throw new Error('payload');
    assert.equal(result.payload, dateTemplate);
    assert.equal(result.receipt?.outcome, 'voice_rejected');
    assert.equal(result.receipt?.decision, 'fidelity_rejected_template');
  };
  await probe('Você prefere falar com a equipe?');
  await probe(
    `${serviceTemplate} Drenagem Linfática não é oferecida.`
  );
  await probe(`${dateTemplate} O serviço custa cento e cinquenta reais`);
  await probe('{"connective":"Perfeito."}');
  await probe('{"connectiveId":"claro"}');
  await probe('Botox funciona!');
  await probe('Gestantes podem fazer!');
  await probe('Sem contraindicações!');
  await probe('É totalmente seguro!');
  await probe('{"connective":"Botox funciona!"}');

  const adversarialFreeText = [
    'Botox funciona!',
    'Gestantes podem fazer!',
    'Sem contraindicações!',
    'É totalmente seguro!',
    '{"connective":"Claro!"}',
    '{"connectiveId":"perfeito"}',
  ];
  for (const modelOutput of adversarialFreeText) {
    const composed = composePhase1AVoiceRewriteV2({
      copyId: 'initial_service_question',
      template: serviceTemplate,
      modelOutput,
    });
    assert.equal(composed.ok, false, modelOutput);
    if (!composed.ok) {
      assert.ok(composed.reasons.includes('closed_grammar_violation'), modelOutput);
    }
  }
  for (const phrase of [
    'Botox funciona!',
    'Gestantes podem fazer!',
    'Sem contraindicações!',
    'É totalmente seguro!',
  ]) {
    const fidelity = evaluateVoiceFidelityV2({
      copyId: 'initial_service_question',
      template: serviceTemplate,
      rewrite: `${phrase} Para qual serviço você gostaria de agendar? Temos Peeling facial, Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?`,
      catalog: {
        services: ['Peeling facial', 'Drenagem Linfática', 'Limpeza de Pele Profunda'],
        professionals: ['Carla Mendes'],
      },
    });
    assert.equal(fidelity.safe, false, phrase);
    assert.ok(
      fidelity.reasons.includes('closed_grammar_violation'),
      `${phrase}: ${fidelity.reasons.join(',')}`
    );
    let calls = 0;
    const rejected = await applyConversationalVoiceV2({
      config,
      enabled: true,
      templatePayload: serviceTemplate,
      provenance: fastPathProvenanceV2('initial_service_question'),
      frame,
      candidate,
      replyPurpose: 'SERVICE_QUESTION',
      services,
      boundaryContext: boundaryCtx,
      checkpoint: async () => null,
      completionFactory: async () => {
        calls += 1;
        return completionFor(`{"connective":"${phrase}"}`);
      },
    });
    assert.equal(calls, 1, phrase);
    assert.equal(rejected.kind, 'payload', phrase);
    if (rejected.kind === 'payload') {
      assert.equal(rejected.payload, serviceTemplate, phrase);
      assert.equal(rejected.receipt?.outcome, 'voice_rejected', phrase);
      assert.equal(rejected.receipt?.decision, 'fidelity_rejected_template', phrase);
    }
  }
  const enumAccepted = composePhase1AVoiceRewriteV2({
    copyId: 'initial_service_question',
    template: serviceTemplate,
    modelOutput: '{"connectiveId":"vamos_la"}',
  });
  assert.equal(enumAccepted.ok, true);
  if (enumAccepted.ok) {
    assert.equal(enumAccepted.connectiveId, 'vamos_la');
    assert.equal(enumAccepted.connective, 'Vamos lá!');
    assert.match(enumAccepted.payload, /^Vamos lá! Para qual serviço/);
  }

  const recoveryStore = new MemoryConversationalV2StateStore();
  const recoveryPhone = '5511000000101';
  recoveryStore.setInputSequence(`${config.phoneNumberId}:${recoveryPhone}`, 1);
  let recoveryVoiceCalls = 0;
  const recovered = await getReceptionistReplyV2({
    phone: recoveryPhone,
    userMessage: 'quanto custa Peeling Facial?',
    userName: 'Cliente',
    config,
    voiceEnabled: true,
    turnRuntime: turnRuntime('quanto custa Peeling Facial?'),
    deps: {
      store: recoveryStore,
      now: () => now,
      id: nextId,
      loadServices: async () => services,
      loadHistory: async () => [],
      isPaused: async () => false,
      voiceEnabled: true,
      runModelLoop: async () => ({
        rawReply: 'INTERNAL_HINT: candidato rejeitado de propósito',
        exhausted: false,
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        providerReportedModels: ['gpt-4o-mini'],
        systemFingerprints: [],
        thinkingMode: 'disabled' as const,
        strictTools: false,
        rounds: 1,
        messages: [],
        toolTrace: [],
        usage: [],
      }),
      regenerate: async () => ({
        ok: false as const,
        reasonCode: 'REGEN_MODEL_RESULT_INVALID' as const,
        providerCalls: 1 as const,
        rawReply: 'ainda inválido',
      }),
      rephraseCompletion: async () => {
        recoveryVoiceCalls += 1;
        return completionFor('{"connectiveId":"claro"}');
      },
    },
  });
  assert.equal(recoveryVoiceCalls, 0);
  assert.notEqual(recovered.planReceipt.recoveryKind, 'none');
  assert.equal(recovered.planReceipt.voice, undefined);

  console.log('smoke-ana-conversational-v2-voice: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
