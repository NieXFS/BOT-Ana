/**
 * Regressão dourada table-driven do compositor de turno: pending ANA,
 * slot-fill elíptico, HUMAN no meio, drift só com evidência social/pessoal.
 */
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke';

import assert from 'node:assert/strict';
import { buildServiceQuestion } from '../src/services/service-gate';
import {
  HUMAN_ECHO_PREFIX,
  type StoredConversationMessage,
} from '../src/services/humanConversationContext';
import {
  __getTurnDecisionReceiptsForTest,
  __resetTurnDecisionReceiptsForTest,
  buildAmbiguousServiceConfirmation,
  buildTurnDecisionReceipt,
  emitReceptionistTurnReceipt,
  resolveListedServiceOrdinal,
  resolveReceptionistTurnDecision,
  SERVICE_REPEAT_PROMPT,
  type ReceptionistTurnControl,
} from '../src/services/receptionistTurnDecision';
import { resolveGroundedReceptionistTurn } from '../src/services/receptionistTurnGrounding';
import {
  buildReceptionistEnvelope,
  validateReceptionistOutbound,
} from '../src/services/receptionistOutbound';
import {
  classifyReceptionistTurnPermission,
  hasPositiveSocialOrPersonalEvidence,
} from '../src/services/receptionistSocialSafety';

const catalog = {
  success: true as const,
  services: [
    {
      id: 'svc-drenagem',
      name: 'Drenagem Linfática',
      durationMinutes: 60,
      price: 160,
      priceFormatted: 'R$ 160,00',
    },
    {
      id: 'svc-limpeza',
      name: 'Limpeza de pele profunda',
      durationMinutes: 50,
      price: 180,
      priceFormatted: 'R$ 180,00',
    },
    {
      id: 'svc-peeling',
      name: 'Peeling facial',
      durationMinutes: 40,
      price: 140,
      priceFormatted: 'R$ 140,00',
    },
    {
      id: 'svc-calo',
      name: 'Calosidades e Fissuras',
      durationMinutes: 45,
      price: 120,
      priceFormatted: 'R$ 120,00',
    },
  ],
  professionals: [{ id: 'pro-julia', name: 'Júlia' }],
};

const serviceQuestion = buildServiceQuestion(catalog.services);
const roseQuestion =
  'Claro! Para qual serviço você gostaria de agendar? Temos Calosidades e Fissuras, Drenagem Linfática e Peeling facial. Qual você prefere?';
const bookingConfirm =
  'Posso marcar Calosidades e Fissuras amanhã às 17:00. Confirma?';

function historyFor(
  assistant: string,
  inbound: string,
  extra: StoredConversationMessage[] = []
): StoredConversationMessage[] {
  return [
    ...extra,
    { role: 'user', content: 'Quero agendar' },
    { role: 'assistant', content: assistant },
    { role: 'user', content: inbound },
  ];
}

const noIo = {
  readUpcoming: async () => {
    throw new Error('não consulta upcoming neste smoke');
  },
  readSlots: async () => {
    throw new Error('não consulta slots neste smoke');
  },
};

const cases: Array<{
  name: string;
  inbound: string;
  assistant?: string;
  extraHistory?: StoredConversationMessage[];
  action: string;
  slot?: string;
  source?: string;
  replyIncludes?: string;
  replyExcludes?: RegExp;
  grounded?: 'short_circuit' | 'continue';
  humanControl?: ReceptionistTurnControl;
}> = [
  {
    name: 'Drenagem Linfática após pergunta de serviço avança',
    inbound: 'Drenagem Linfática',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    slot: 'SERVICE',
    source: 'ANA',
    replyIncludes: 'Drenagem Linfática',
    replyExcludes: /Limpeza de pele profunda|Peeling facial/,
    grounded: 'short_circuit',
  },
  {
    name: 'case/acento drenagem linfatica',
    inbound: 'drenagem linfatica',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: 'Limpeza de pele profunda',
    inbound: 'Limpeza de pele profunda',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Limpeza de pele profunda',
    grounded: 'short_circuit',
  },
  {
    name: 'Peeling facial',
    inbound: 'Peeling facial',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Peeling facial',
    grounded: 'short_circuit',
  },
  {
    name: 'Calosidade não repete lista',
    inbound: 'Calosidade',
    assistant: roseQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Calosidades e Fissuras',
    replyExcludes: /Peeling facial|Drenagem Linfática/,
    grounded: 'short_circuit',
  },
  {
    name: 'pode ser a drenagem',
    inbound: 'pode ser a drenagem',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: 'a de 60 minutos',
    inbound: 'a de 60 minutos',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: 'typo drenagen',
    inbound: 'drenagen',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: 'sim após 3 serviços pede repetição sem lista',
    inbound: 'sim',
    assistant: serviceQuestion,
    action: 'ask_repeat',
    replyIncludes: SERVICE_REPEAT_PROMPT,
    replyExcludes: /Temos /,
    grounded: 'short_circuit',
  },
  {
    name: '14h após pergunta de serviço não agenda',
    inbound: '14h',
    assistant: serviceQuestion,
    action: 'continue_model',
    grounded: 'continue',
  },
  {
    name: 'emoji+sim após confirmação de serviço avança',
    inbound: 'sim 😊',
    assistant: buildAmbiguousServiceConfirmation('Drenagem Linfática'),
    action: 'follow_up_datetime',
    slot: 'CONFIRMATION',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: 'podologa não vira booking nem lista',
    inbound: 'podologa',
    assistant: roseQuestion,
    action: 'unknown_denial',
    replyExcludes: /Temos |Calosidades e Fissuras,/,
    grounded: 'short_circuit',
  },
  {
    name: 'serviço desconhecido Botox',
    inbound: 'Botox',
    assistant: serviceQuestion,
    action: 'unknown_denial',
    grounded: 'short_circuit',
  },
  {
    name: 'HUMAN_ACTIVE no meio silencia',
    inbound: 'Drenagem Linfática',
    assistant: `${HUMAN_ECHO_PREFIX}qual horário fica melhor?`,
    extraHistory: [
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: serviceQuestion },
    ],
    action: 'silence_human',
    source: 'HUMAN',
    grounded: 'short_circuit',
    humanControl: {
      disposition: 'HUMAN_ACTIVE',
      resumeDecision: 'KEEP_HUMAN',
    },
  },
  {
    name: 'pergunta HUMAN com takeover ativo não é pending ANA',
    inbound: 'Drenagem Linfática',
    assistant: `${HUMAN_ECHO_PREFIX}você prefere drenagem ou peeling?`,
    action: 'silence_human',
    source: 'HUMAN',
    grounded: 'short_circuit',
    humanControl: {
      disposition: 'HUMAN_ACTIVE',
      resumeDecision: 'KEEP_HUMAN',
    },
  },
  {
    name: 'RESUME_ANA não silencia histórico HUMAN nem reusa slot',
    inbound: 'Drenagem Linfática',
    assistant: `${HUMAN_ECHO_PREFIX}qual horário fica melhor?`,
    extraHistory: [
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: serviceQuestion },
    ],
    action: 'continue_model',
    source: 'HUMAN',
    grounded: 'continue',
    humanControl: {
      disposition: 'RESUME_APPROVED',
      resumeDecision: 'RESUME_ANA',
    },
  },
  {
    name: 'pausa expirada sem chefe não silencia histórico HUMAN',
    inbound: 'Quero agendar',
    assistant: `${HUMAN_ECHO_PREFIX}te chamo já`,
    extraHistory: [
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: serviceQuestion },
    ],
    action: 'continue_model',
    source: 'HUMAN',
    grounded: 'continue',
    humanControl: {
      disposition: 'NO_ACTIVE_TAKEOVER',
      resumeDecision: 'GATE_DISABLED',
    },
  },
  {
    name: 'a segunda opção escolhe Limpeza',
    inbound: 'a segunda opção',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    slot: 'SERVICE',
    source: 'ANA',
    replyIncludes: 'Limpeza de pele profunda',
    replyExcludes: /Drenagem Linfática|Peeling facial/,
    grounded: 'short_circuit',
  },
  {
    name: 'primeiro / 1 / última contra a lista pendente',
    inbound: 'a primeira',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Drenagem Linfática',
    grounded: 'short_circuit',
  },
  {
    name: '2 escolhe o segundo listado',
    inbound: '2',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Limpeza de pele profunda',
    grounded: 'short_circuit',
  },
  {
    name: 'terceiro com acento',
    inbound: 'a Terceira',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Peeling facial',
    grounded: 'short_circuit',
  },
  {
    name: 'última quando inequívoco',
    inbound: 'a última',
    assistant: serviceQuestion,
    action: 'follow_up_datetime',
    replyIncludes: 'Calosidades e Fissuras',
    grounded: 'short_circuit',
  },
  {
    name: 'índice fora do intervalo pede repetição sem inventar',
    inbound: 'a 5ª opção',
    assistant: serviceQuestion,
    action: 'ask_repeat',
    replyIncludes: SERVICE_REPEAT_PROMPT,
    replyExcludes: /Drenagem Linfática|Limpeza de pele profunda/,
    grounded: 'short_circuit',
  },
  {
    name: 'ordinal fora de pergunta pendente não opera',
    inbound: 'a segunda opção',
    action: 'personal_ack',
    source: 'none',
    grounded: 'short_circuit',
  },
  {
    name: 'pessoal B05 não opera',
    inbound: 'sexta às 20 tem festa',
    action: 'personal_ack',
    source: 'none',
    grounded: 'short_circuit',
  },
  {
    name: 'saudação continua template social',
    inbound: 'Boa tarde',
    action: 'social_reply',
    grounded: 'continue',
  },
  {
    name: 'kkk sem pending segue modelo (sem ampliar social)',
    inbound: 'kkk',
    action: 'continue_model',
    source: 'none',
    grounded: 'continue',
  },
  {
    name: 'confirmação neutra não se repete',
    inbound: 'talvez',
    assistant: buildAmbiguousServiceConfirmation('Drenagem Linfática'),
    action: 'ask_repeat',
    replyIncludes: SERVICE_REPEAT_PROMPT,
    grounded: 'short_circuit',
  },
  {
    name: 'sim após confirmação de booking segue o modelo',
    inbound: 'sim',
    assistant: bookingConfirm,
    action: 'continue_model',
    grounded: 'continue',
  },
  {
    name: 'obrigada após confirmação de booking não vira template social',
    inbound: 'obrigada',
    assistant: bookingConfirm,
    action: 'continue_model',
    grounded: 'continue',
  },
];

async function main(): Promise<void> {
  __resetTurnDecisionReceiptsForTest();
  for (const testCase of cases) {
    const history = testCase.assistant
      ? historyFor(
          testCase.assistant,
          testCase.inbound,
          testCase.extraHistory ?? []
        )
      : [{ role: 'user' as const, content: testCase.inbound }];
    const decision = resolveReceptionistTurnDecision({
      inbound: testCase.inbound,
      history,
      catalog,
      humanControl: testCase.humanControl,
    });
    assert.equal(decision.action, testCase.action, testCase.name);
    if (testCase.slot) {
      assert.equal(decision.pending.expectedSlot, testCase.slot, testCase.name);
    }
    if (testCase.source) {
      assert.equal(decision.pending.source, testCase.source, testCase.name);
    }
    if (testCase.replyIncludes) {
      assert.match(
        decision.reply ?? '',
        new RegExp(testCase.replyIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        testCase.name
      );
    }
    if (testCase.replyExcludes && decision.reply) {
      assert.doesNotMatch(decision.reply, testCase.replyExcludes, testCase.name);
    }

    const grounded = await resolveGroundedReceptionistTurn({
      userMessage: testCase.inbound,
      userMessages: history
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
      history,
      services: catalog,
      now: new Date('2026-08-12T18:00:00.000Z'),
      timezone: 'America/Sao_Paulo',
      humanControl: testCase.humanControl,
      ...noIo,
    });
    if (testCase.grounded) {
      assert.equal(grounded.kind, testCase.grounded, testCase.name);
    }
    if (grounded.kind === 'short_circuit') {
      assert.equal(grounded.toolTrace.length, 0, testCase.name);
    }
  }

  assert.equal(
    classifyReceptionistTurnPermission('hoje a drenagem da festa foi ótima', {
      services: catalog.services.map((service) => service.name),
    }),
    'NO_OPERATIONAL_INTENT'
  );
  assert.equal(
    resolveReceptionistTurnDecision({
      inbound: 'hoje a drenagem da festa foi ótima',
      history: [{ role: 'user', content: 'hoje a drenagem da festa foi ótima' }],
      catalog,
    }).action,
    'personal_ack'
  );

  const followUp = resolveReceptionistTurnDecision({
    inbound: 'Drenagem Linfática',
    history: historyFor(serviceQuestion, 'Drenagem Linfática'),
    catalog,
  });
  const outbound = validateReceptionistOutbound(
    buildReceptionistEnvelope({
      purpose: 'REACTIVE',
      blocks: [{ source: 'GENERATED', text: followUp.reply! }],
      authoritativeCatalog: {
        services: catalog.services.map((service) => ({
          id: service.id,
          name: service.name,
        })),
        professionals: catalog.professionals,
      },
      evidence: {
        sourceInboundText: 'Drenagem Linfática',
        pendingQuestion: followUp.pending,
        disableSocialContextDrift: followUp.disableSocialContextDrift,
      },
    })
  );
  assert.equal(outbound.originalAccepted, true, outbound.reasonCodes.join(','));
  assert.equal(outbound.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'), false);

  const stale = validateReceptionistOutbound(
    buildReceptionistEnvelope({
      purpose: 'REACTIVE',
      blocks: [
        {
          source: 'GENERATED',
          text: 'A Juliana te recebe amanhã às 10h para Limpeza.',
        },
      ],
      authoritativeCatalog: {
        services: [{ id: 's1', name: 'Limpeza' }],
        professionals: [{ id: 'p1', name: 'Juliana' }],
      },
      evidence: { sourceInboundText: 'Booa tarde' },
    })
  );
  assert.equal(stale.originalAccepted, false);
  assert.ok(stale.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'));

  assert.equal(hasPositiveSocialOrPersonalEvidence('hellou'), false);
  const residual = validateReceptionistOutbound(
    buildReceptionistEnvelope({
      purpose: 'REACTIVE',
      blocks: [
        {
          source: 'GENERATED',
          text: 'A Juliana te recebe amanhã às 10h para Limpeza.',
        },
      ],
      authoritativeCatalog: {
        services: [{ id: 's1', name: 'Limpeza' }],
        professionals: [{ id: 'p1', name: 'Juliana' }],
      },
      evidence: { sourceInboundText: 'hellou' },
    })
  );
  assert.equal(residual.originalAccepted, false);
  assert.equal(residual.reasonCodes.includes('SOCIAL_CONTEXT_DRIFT'), false);
  assert.ok(
    residual.reasonCodes.includes('UNVERIFIED_APPOINTMENT_CONTEXT') ||
      residual.reasonCodes.includes('UNKNOWN_PROFESSIONAL')
  );

  __resetTurnDecisionReceiptsForTest();
  emitReceptionistTurnReceipt(
    buildTurnDecisionReceipt({
      phoneNumberId: 'PN-SMOKE',
      customerPhone: '5511999990000',
      tenantSlug: 'studio-viti',
      inboundMessageId: 'wamid.smoke',
      decision: followUp,
      modelCalled: false,
      toolNames: [],
      outboundAction: 'sent',
      payload: followUp.reply,
    })
  );
  const receipts = __getTurnDecisionReceiptsForTest();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.route, 'pending_follow_up');
  assert.equal(receipts[0]?.socialRoute, 'not_social');
  assert.equal(receipts[0]?.pendingQuestionSource, 'ANA');
  assert.ok(receipts[0]?.payloadHash);
  assert.doesNotMatch(JSON.stringify(receipts[0]), /5511999990000|Drenagem|wamid\.smoke/);

  const socialReceipt = buildTurnDecisionReceipt({
    phoneNumberId: 'PN-SMOKE',
    customerPhone: '5511999990000',
    tenantSlug: 'studio-viti',
    decision: resolveReceptionistTurnDecision({
      inbound: 'Boa tarde',
      history: [{ role: 'user', content: 'Boa tarde' }],
      catalog,
    }),
    modelCalled: false,
    toolNames: [],
    outboundAction: 'sent',
    payload: 'Boa tarde! Como posso ajudar?',
  });
  assert.equal(socialReceipt.route, 'social_template');
  assert.equal(socialReceipt.socialRoute, 'social_template');
  assert.equal(socialReceipt.payloadVariant, 'greeting_boa_tarde');
  assert.ok(socialReceipt.payloadHash);
  assert.doesNotMatch(JSON.stringify(socialReceipt), /5511999990000/);

  const listed = [
    'Drenagem Linfática',
    'Limpeza de pele profunda',
    'Peeling facial',
    'Calosidades e Fissuras',
  ];
  assert.equal(resolveListedServiceOrdinal('a segunda opção', listed).kind, 'unequivocal');
  assert.equal(
    resolveListedServiceOrdinal('a segunda opção', listed).kind === 'unequivocal'
      ? resolveListedServiceOrdinal('a segunda opção', listed).serviceName
      : null,
    'Limpeza de pele profunda'
  );
  assert.equal(resolveListedServiceOrdinal('primeiro', listed).kind, 'unequivocal');
  assert.equal(resolveListedServiceOrdinal('1', listed).kind, 'unequivocal');
  assert.equal(resolveListedServiceOrdinal('a última', listed).kind, 'unequivocal');
  assert.equal(resolveListedServiceOrdinal('5', listed).kind, 'out_of_range');
  assert.equal(resolveListedServiceOrdinal('a quarta opção', listed).kind, 'unequivocal');
  assert.equal(resolveListedServiceOrdinal('quarta', listed).kind, 'none');
  assert.equal(resolveListedServiceOrdinal('segunda feira', listed).kind, 'none');
  assert.equal(resolveListedServiceOrdinal('a segunda opção', []).kind, 'out_of_range');

  const resumed = resolveReceptionistTurnDecision({
    inbound: 'Drenagem Linfática',
    history: historyFor(`${HUMAN_ECHO_PREFIX}já te atendo`, 'Drenagem Linfática', [
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: serviceQuestion },
    ]),
    catalog,
    humanControl: {
      disposition: 'RESUME_APPROVED',
      resumeDecision: 'RESUME_ANA',
    },
  });
  assert.equal(resumed.action, 'continue_model');
  assert.notEqual(resumed.action, 'silence_human');
  assert.equal(resumed.pending.source, 'HUMAN');
  assert.equal(resumed.pending.expectedSlot, undefined);
  assert.equal(resumed.humanControlDisposition, 'RESUME_APPROVED');
  assert.equal(resumed.resumeDecision, 'RESUME_ANA');
  const resumeReceipt = buildTurnDecisionReceipt({
    phoneNumberId: 'PN-SMOKE',
    customerPhone: '5511999990000',
    tenantSlug: 'studio-viti',
    inboundMessageId: 'wamid.resume',
    decision: resumed,
    modelCalled: true,
    toolNames: [],
    outboundAction: 'sent',
    payload: 'Qual dia e horário você prefere?',
  });
  assert.notEqual(resumeReceipt.decision, 'silence_human');
  assert.equal(resumeReceipt.humanControlDisposition, 'RESUME_APPROVED');
  assert.equal(resumeReceipt.resumeDecision, 'RESUME_ANA');
  assert.equal(resumeReceipt.pendingQuestionSource, 'HUMAN');
  assert.doesNotMatch(
    JSON.stringify(resumeReceipt),
    /5511999990000|Drenagem|wamid\.resume|atendente/
  );

  const keepHuman = resolveReceptionistTurnDecision({
    inbound: 'Drenagem Linfática',
    history: historyFor(`${HUMAN_ECHO_PREFIX}já te atendo`, 'Drenagem Linfática'),
    catalog,
    humanControl: {
      disposition: 'HUMAN_ACTIVE',
      resumeDecision: 'KEEP_HUMAN',
    },
  });
  assert.equal(keepHuman.action, 'silence_human');
  assert.equal(keepHuman.humanControlDisposition, 'HUMAN_ACTIVE');

  assert.equal(followUp.humanControlDisposition, 'NO_ACTIVE_TAKEOVER');
  assert.equal(receipts[0]?.humanControlDisposition, 'NO_ACTIVE_TAKEOVER');
  assert.equal(receipts[0]?.resumeDecision, 'NONE');

  console.log('smoke receptionist turn decision: OK');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
