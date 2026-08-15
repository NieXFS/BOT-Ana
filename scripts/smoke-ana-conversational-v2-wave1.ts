import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';
import type {
  FlowStateV2,
  PendingFrameSnapshotV2,
  TurnFrameV2,
} from '../src/services/conversationalV2/contracts';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana-v2-wave1';
process.env.OPENAI_API_KEY = 'sk-smoke-invalid';
process.env.ERP_API_TOKEN = 'smoke-invalid';

const now = new Date('2026-08-12T15:00:00.000Z');
const timezone = 'America/Sao_Paulo';
const services: ServicesResult = {
  success: true,
  services: [
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
  tenantSlug: 'fixture-wave1',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'Atenda bem.',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 0.2,
  aiMaxTokens: 900,
  openaiApiKey: 'sk-smoke-invalid',
  botIsAlwaysActive: true,
  botActiveStart: '08:00',
  botActiveEnd: '20:00',
  timezone,
  waAccessToken: 'fixture',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN-WAVE1',
  isActive: true,
  authoritativeCatalog: {
    tenant: { name: 'Clínica Fixture', address: 'Rua Fixture, 1' },
    services: [],
    professionals: [],
  },
} as TenantBotConfig;

function pending(input: {
  kind: PendingFrameSnapshotV2['kind'];
  flowId?: string;
  askedAt?: string;
  options?: PendingFrameSnapshotV2['options'];
}): PendingFrameSnapshotV2 {
  return {
    questionId: `q-${input.kind}`,
    askedAt: input.askedAt ?? now.toISOString(),
    kind: input.kind,
    flowId: input.flowId ?? 'flow-wave1',
    version: 1,
    options: input.options ?? [],
  };
}

function frame(input: {
  pending: PendingFrameSnapshotV2 | null;
  flowState?: FlowStateV2;
}): TurnFrameV2 {
  return {
    schemaVersion: 2,
    turnId: 'turn-wave1',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: ['in-1'],
    pending: input.pending,
    flowState: input.flowState ?? {
      flowId: input.pending?.flowId ?? 'flow-wave1',
      lastOperationalAt: now.toISOString(),
      fixedByProofVersion: {},
    },
  };
}

async function main(): Promise<void> {
  const [
    dateModule,
    flowModule,
    progressModule,
    fastPaths,
    copyModule,
    stateModule,
    providerModule,
    receiptModule,
    boundaryModule,
    reentryModule,
    canaryModule,
    workflowModule,
    voiceModule,
    readModule,
  ] = await Promise.all([
    import('../src/services/conversationalV2/currentDateResolution'),
    import('../src/services/conversationalV2/flowSession'),
    import('../src/services/conversationalV2/bookingProgressFastPaths'),
    import('../src/services/conversationalV2/fastPaths'),
    import('../src/services/conversationalV2/copyVariants'),
    import('../src/services/conversationalV2/stateStore'),
    import('../src/services/receptionistLlmProvider'),
    import('../src/services/conversationalV2/receipts'),
    import('../src/services/conversationalV2/boundary'),
    import('../src/services/conversationalV2/bookingReentryFastPath'),
    import('../src/services/conversationalV2/linguisticCanary'),
    import('../src/services/conversationalV2/workflowLanguage'),
    import('../src/services/conversationalV2/voice'),
    import('../src/services/conversationalV2/readFastPaths'),
  ]);

  const corrected = dateModule.resolveCurrentInboundDateV2({
    currentInboundIds: ['in-1', 'in-2'],
    inboundTextsById: { 'in-1': 'amanhã', 'in-2': 'não, sexta' },
    now,
    timezone,
  });
  assert.deepEqual(corrected, {
    kind: 'resolved',
    date: '2026-08-14',
    mentions: ['2026-08-13', '2026-08-14'],
  });
  assert.equal(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-1'],
      inboundTextsById: { 'in-1': 'amanhã ou sexta' },
      now,
      timezone,
    }).kind,
    'ambiguous',
    'duas datas sem correção falham fechadas'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-ordinal'],
      inboundTextsById: { 'in-ordinal': 'segunda opção' },
      now,
      timezone,
    }),
    { kind: 'none', mentions: [] },
    'opção veta leitura de weekday/data no mesmo inbound'
  );

  const datePending = pending({ kind: 'DATE' });
  const liveState: FlowStateV2 = {
    flowId: datePending.flowId,
    lastOperationalAt: now.toISOString(),
    fixedServiceId: 'svc-drenagem',
    fixedProfessionalId: 'prof-carla',
    fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
  };
  assert.equal(
    flowModule.decideFlowResetV2({
      flowState: liveState,
      pending: datePending,
      inboundText: 'quero agendar amanhã',
      dateResolution: dateModule.resolveCurrentInboundDateV2({
        currentInboundIds: ['in-1'],
        inboundTextsById: { 'in-1': 'quero agendar amanhã' },
        now,
        timezone,
      }),
      catalog: services,
      now,
    }),
    null,
    'progresso DATE fresco nunca é apagado pelo verbo de agendamento'
  );
  assert.equal(
    flowModule.decideFlowResetV2({
      flowState: liveState,
      pending: datePending,
      inboundText: 'quero agendar',
      dateResolution: { kind: 'none', mentions: [] },
      catalog: services,
      now,
    }),
    null,
    'DATE fresca é soberana mesmo sem data no novo lote'
  );
  const servicePending = pending({ kind: 'SERVICE' });
  assert.equal(
    flowModule.decideFlowResetV2({
      flowState: { ...liveState, flowId: servicePending.flowId },
      pending: servicePending,
      inboundText: 'quero agendar',
      dateResolution: { kind: 'none', mentions: [] },
      catalog: services,
      now,
    }),
    'explicit_restart'
  );
  assert.equal(
    flowModule.flowStateIdleV2(
      {
        ...liveState,
        lastOperationalAt: new Date(now.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
      },
      now
    ),
    true,
    'TTL operacional é quatro horas'
  );
  assert.deepEqual(
    flowModule.adjustTransitionForFlowResetV2(
      { kind: 'preserve' },
      datePending,
      'idle_timeout'
    ),
    {
      kind: 'invalidate',
      questionId: datePending.questionId,
      reason: 'flow_session_reset:idle_timeout',
    },
    'reset + copy PRESERVE invalida a pergunta velha no mesmo commit'
  );
  assert.deepEqual(
    flowModule.adjustTransitionForFlowResetV2(
      {
        kind: 'open',
        pendingKind: 'SERVICE',
        flowId: 'flow-new',
        optionEntityIds: ['svc-drenagem', 'svc-limpeza'],
      },
      datePending,
      'idle_timeout'
    ),
    {
      kind: 'open',
      pendingKind: 'SERVICE',
      flowId: 'flow-new',
      optionEntityIds: ['svc-drenagem', 'svc-limpeza'],
    },
    'novo OPEN continua supersedendo a pendência velha pela CAS normal'
  );

  const dateFrame = frame({ pending: datePending, flowState: liveState });
  const slots = await progressModule.resolveDateSlotsFastPathV2({
    frame: dateFrame,
    dateResolution: corrected,
    currentInboundText: 'não, sexta',
    servicesResult: services,
    config,
    now,
    executeTool: async (name, args) => {
      assert.equal(name, 'getAvailableSlots');
      assert.equal(args.date, '2026-08-14');
      return JSON.stringify({
        success: true,
        slots: ['14:00', '15:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(slots.kind, 'resolved');
  if (slots.kind !== 'resolved') throw new Error('P1 não resolveu slots');
  assert.match(slots.result.reply, /14\/08\/2026/u, 'oferta cita a data legível');
  assert.equal(slots.result.pendingTransitionCandidate.kind, 'open');
  assert.equal(
    slots.nextFlowState.slotEvidence?.date,
    '2026-08-14',
    'slotEvidence carrega a data de origem'
  );
  assert.equal(
    (
      await progressModule.resolveDateSlotsFastPathV2({
        frame: dateFrame,
        dateResolution: { kind: 'none', mentions: [] },
        currentInboundText: 'quais horários?',
        servicesResult: services,
        config,
        now,
        executeTool: async () => {
          throw new Error('não pode reler a ISO antiga sem data no lote');
        },
      })
    ).kind,
    'continue_model',
    'P1 nunca dispara a partir de resolvedDate residual'
  );
  const noSlots = await progressModule.resolveDateSlotsFastPathV2({
    frame: dateFrame,
    dateResolution: { kind: 'resolved', date: '2026-08-14', mentions: ['2026-08-14'] },
    currentInboundText: 'sexta',
    servicesResult: services,
    config,
    now,
    executeTool: async () => JSON.stringify({ success: true, slots: [] }),
  });
  assert.equal(noSlots.kind, 'resolved');
  if (noSlots.kind !== 'resolved') throw new Error('grade vazia não foi reduzida');
  assert.deepEqual(
    noSlots.result.pendingTransitionCandidate,
    {
      kind: 'open',
      pendingKind: 'DATE',
      flowId: dateFrame.flowState.flowId,
      optionEntityIds: ['date-freeform'],
    },
    'grade vazia reabre DATE, nunca TIME vazio'
  );

  const oldTimePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
    ],
  });
  const oldTimeFrame = frame({
    pending: oldTimePending,
    flowState: {
      ...liveState,
      resolvedDate: '2026-08-13',
      slotEvidence: {
        turnId: 'turn-old',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-carla',
        date: '2026-08-13',
        slots: ['14:00', '15:00'],
      },
      fixedByProofVersion: {
        ...liveState.fixedByProofVersion,
        resolvedDate: 1,
      },
    },
  });
  const newDateText = 'na verdade sexta às 15h';
  const newDateResolution = dateModule.resolveCurrentInboundDateV2({
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': newDateText },
    now,
    timezone,
  });
  assert.equal(
    fastPaths.resolveSelectionFastPathV2({
      frame: oldTimeFrame,
      inboundId: 'in-1',
      inboundText: newDateText,
      catalog: services,
      now,
      currentDateResolution: newDateResolution,
    }).kind,
    'continue_model',
    'data nova veta fill do TIME antigo'
  );
  const superseded = await progressModule.resolveDateSlotsFastPathV2({
    frame: oldTimeFrame,
    dateResolution: newDateResolution,
    currentInboundText: newDateText,
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        slots: ['09:00', '11:00'],
        professionalId: 'prof-carla',
      }),
  });
  assert.equal(superseded.kind, 'resolved');
  if (superseded.kind !== 'resolved') throw new Error('TIME não foi superseded');
  assert.deepEqual(
    superseded.result.pendingTransitionCandidate,
    {
      kind: 'open',
      pendingKind: 'TIME',
      flowId: oldTimeFrame.flowState.flowId,
      optionEntityIds: ['09:00', '11:00'],
    },
    'TIME novo substitui integralmente as opções antigas'
  );

  const canaryNow = new Date('2026-08-15T17:32:00.000Z');
  const canaryTz = 'America/Sao_Paulo';
  const sundayNow = new Date('2026-08-16T18:00:00.000Z');
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-domingo'],
      inboundTextsById: { 'in-domingo': 'Quero agendar uma drenagem pra domingo' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-16', mentions: ['2026-08-16'] },
    'F2: domingo por extenso é o próximo domingo civil (15/08/2026=sábado → 16/08)'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-segunda-feira'],
      inboundTextsById: { 'in-segunda-feira': 'segunda-feira' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-17', mentions: ['2026-08-17'] },
    'F2: segunda-feira com hífen'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-terca'],
      inboundTextsById: { 'in-terca': 'terca' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-18', mentions: ['2026-08-18'] },
    'F2: terca sem acento'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-sabado'],
      inboundTextsById: { 'in-sabado': 'sábado' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-15', mentions: ['2026-08-15'] },
    'F2: sábado hoje permanece hoje (≥ hoje)'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-sabado-vem'],
      inboundTextsById: { 'in-sabado-vem': 'sábado que vem' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-22', mentions: ['2026-08-22'] },
    'F2: X que vem no próprio X avança +7'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-que-vem'],
      inboundTextsById: { 'in-que-vem': 'domingo que vem' },
      now: sundayNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-23', mentions: ['2026-08-23'] },
    'F2: domingo que vem no próprio domingo avança +7'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-correcao'],
      inboundTextsById: { 'in-correcao': 'Domingo, não sábado!' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-16', mentions: ['2026-08-16'] },
    'F3: Domingo, não sábado elege domingo e descarta sábado'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-e-nao'],
      inboundTextsById: { 'in-e-nao': 'domingo e não sábado' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-16', mentions: ['2026-08-16'] },
    'F3: X e não Y'
  );
  assert.deepEqual(
    dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-nao-sexta'],
      inboundTextsById: { 'in-nao-sexta': 'não, sexta' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    { kind: 'resolved', date: '2026-08-21', mentions: ['2026-08-21'] },
    'F3: "não, sexta" continua correção conservadora, não contraste X-não-Y'
  );

  const canaryDatePending = pending({
    kind: 'DATE',
    askedAt: canaryNow.toISOString(),
  });
  const canaryDateFrame = frame({
    pending: canaryDatePending,
    flowState: {
      flowId: canaryDatePending.flowId,
      lastOperationalAt: canaryNow.toISOString(),
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-carla',
      fixedByProofVersion: { fixedServiceId: 1, fixedProfessionalId: 1 },
    },
  });
  let domingoArgs: Record<string, unknown> | null = null;
  const domingoSlots = await progressModule.resolveDateSlotsFastPathV2({
    frame: canaryDateFrame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-1'],
      inboundTextsById: { 'in-1': 'Quero agendar uma drenagem pra domingo' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Quero agendar uma drenagem pra domingo',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async (name, args) => {
      assert.equal(name, 'getAvailableSlots');
      domingoArgs = args;
      return JSON.stringify({
        success: true,
        slots: ['10:00', '11:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(domingoSlots.kind, 'resolved');
  assert.equal(domingoArgs?.date, '2026-08-16', 'F2: fetch de domingo, não sábado');
  if (domingoSlots.kind === 'resolved') {
    assert.doesNotMatch(domingoSlots.result.reply, /15\/08\/2026/);
    assert.match(domingoSlots.result.reply, /16\/08\/2026/);
  }

  const openBookingDomingo = await progressModule.resolveDateSlotsFastPathV2({
    frame: frame({
      pending: null,
      flowState: {
        flowId: 'flow-open-domingo',
        lastOperationalAt: canaryNow.toISOString(),
        fixedByProofVersion: {},
      },
    }),
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-open'],
      inboundTextsById: {
        'in-open': 'Quero agendar uma drenagem pra domingo',
      },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Quero agendar uma drenagem pra domingo',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async (_name, args) => {
      assert.equal(args.date, '2026-08-16');
      return JSON.stringify({
        success: true,
        slots: ['10:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(
    openBookingDomingo.kind,
    'resolved',
    'F2: sem pendência DATE ainda busca o domingo citado'
  );

  const correcaoDomingo = await progressModule.resolveDateSlotsFastPathV2({
    frame: {
      ...canaryDateFrame,
      pending: pending({
        kind: 'TIME',
        askedAt: canaryNow.toISOString(),
        options: [
          { position: 1, entityId: '09:00', displayName: '09:00' },
          { position: 2, entityId: '11:00', displayName: '11:00' },
        ],
      }),
      flowState: {
        ...canaryDateFrame.flowState,
        resolvedDate: '2026-08-15',
        slotEvidence: {
          turnId: 'turn-sabado',
          serviceId: 'svc-drenagem',
          professionalId: 'prof-carla',
          date: '2026-08-15',
          slots: ['09:00', '11:00'],
        },
        fixedByProofVersion: {
          ...canaryDateFrame.flowState.fixedByProofVersion,
          resolvedDate: 1,
        },
      },
    },
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-fix'],
      inboundTextsById: { 'in-fix': 'Domingo, não sábado!' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Domingo, não sábado!',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async (_name, args) => {
      assert.equal(args.date, '2026-08-16', 'F3: correção não cai em hoje/sábado');
      return JSON.stringify({
        success: true,
        slots: ['10:00', '14:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(correcaoDomingo.kind, 'resolved');
  if (correcaoDomingo.kind === 'resolved') {
    assert.match(correcaoDomingo.result.reply, /16\/08\/2026/);
    assert.doesNotMatch(correcaoDomingo.result.reply, /15\/08\/2026/);
  }

  const ambiguousDay = await progressModule.resolveDateSlotsFastPathV2({
    frame: canaryDateFrame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-amb'],
      inboundTextsById: { 'in-amb': 'domingo ou sábado' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'domingo ou sábado',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async () => {
      throw new Error('ambíguo não lista hoje');
    },
  });
  assert.equal(ambiguousDay.kind, 'resolved');
  if (ambiguousDay.kind === 'resolved') {
    assert.equal(ambiguousDay.result.reply, 'Qual dia você prefere?');
    assert.deepEqual(ambiguousDay.result.pendingTransitionCandidate, {
      kind: 'open',
      pendingKind: 'DATE',
      flowId: canaryDateFrame.flowState.flowId,
      optionEntityIds: ['date-freeform'],
    });
  }

  const pastMorning = await progressModule.resolveDateSlotsFastPathV2({
    frame: canaryDateFrame,
    dateResolution: {
      kind: 'resolved',
      date: '2026-08-15',
      mentions: ['2026-08-15'],
    },
    currentInboundText: 'hoje',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        slots: ['08:00', '08:30', '09:00', '15:00'],
        professionalId: 'prof-carla',
      }),
  });
  assert.equal(pastMorning.kind, 'resolved');
  if (pastMorning.kind === 'resolved') {
    assert.deepEqual(
      pastMorning.result.pendingTransitionCandidate.kind === 'open'
        ? pastMorning.result.pendingTransitionCandidate.optionEntityIds
        : [],
      ['15:00'],
      'F3b: 8h/8h30/9h de hoje não são oferecidos às 14h32'
    );
    assert.doesNotMatch(pastMorning.result.reply, /08:00|8h|09:00|9h/);
  }

  const f1Read = await progressModule.resolveDateSlotsFastPathV2({
    frame: frame({
      pending: null,
      flowState: {
        flowId: 'flow-f1',
        lastOperationalAt: canaryNow.toISOString(),
        fixedByProofVersion: {},
      },
    }),
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f1'],
      inboundTextsById: {
        'in-f1': 'Quais horários tem domingo pra drenagem?',
      },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Quais horários tem domingo pra drenagem?',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async (name, args) => {
      assert.equal(name, 'getAvailableSlots');
      assert.equal(args.serviceId, 'svc-drenagem');
      assert.equal(args.date, '2026-08-16');
      return JSON.stringify({
        success: true,
        slots: ['10:00', '11:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(f1Read.kind, 'resolved', 'F1: menção canônica ancora leitura de slots');
  if (f1Read.kind === 'resolved') {
    assert.equal(
      f1Read.nextFlowState.fixedServiceId,
      'svc-drenagem'
    );
  }

  const dualTypoServices: ServicesResult = {
    success: true,
    services: [
      {
        id: 'svc-drenagem',
        name: 'Drenagem Linfática',
        durationMinutes: 60,
        price: 160,
        priceFormatted: 'R$ 160,00',
        professionalIds: ['prof-carla'],
      },
      {
        id: 'svc-modeladora',
        name: 'Drenagem Modeladora',
        durationMinutes: 60,
        price: 160,
        priceFormatted: 'R$ 160,00',
        professionalIds: ['prof-carla'],
      },
    ],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  };
  const dualTypoInbound =
    'Quais horários tem domingo pra Drenagem Linfática e Drenagem Modelador';
  const dualTypoFrame = frame({
    pending: null,
    flowState: {
      flowId: 'flow-f1-dual',
      lastOperationalAt: canaryNow.toISOString(),
      fixedByProofVersion: {},
    },
  });
  let dualTypoSlotCalls = 0;
  const dualTypoDateSlots = await progressModule.resolveDateSlotsFastPathV2({
    frame: dualTypoFrame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f1-dual'],
      inboundTextsById: { 'in-f1-dual': dualTypoInbound },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: dualTypoInbound,
    servicesResult: dualTypoServices,
    config,
    now: canaryNow,
    executeTool: async (name) => {
      dualTypoSlotCalls += 1;
      throw new Error(`F1 Q2 dual mention não chama ${name}`);
    },
  });
  assert.equal(dualTypoDateSlots.kind, 'continue_model');
  assert.equal(dualTypoSlotCalls, 0, 'F1 Q2: zero getAvailableSlots no dual typo-distance');
  const dualTypoRead = await readModule.resolveReadFastPathV2({
    frame: dualTypoFrame,
    inboundText: dualTypoInbound,
    servicesResult: dualTypoServices,
    config,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f1-dual-read'],
      inboundTextsById: { 'in-f1-dual-read': dualTypoInbound },
      now: canaryNow,
      timezone: canaryTz,
    }),
    now: canaryNow,
    executeTool: async (name) => {
      dualTypoSlotCalls += 1;
      throw new Error(`F1 Q2 read-fast-path não chama ${name}`);
    },
  });
  assert.equal(dualTypoRead.kind, 'continue_model');
  assert.equal(dualTypoSlotCalls, 0, 'F1 Q2: read-fast-path também zero getAvailableSlots');

  const exactSiblingInbound =
    'Quais horários tem domingo pra Drenagem Linfática?';
  const exactSiblingFrame = frame({
    pending: null,
    flowState: {
      flowId: 'flow-f1-exact-sibling',
      lastOperationalAt: canaryNow.toISOString(),
      fixedByProofVersion: {},
    },
  });
  const exactSiblingDateSlots = await progressModule.resolveDateSlotsFastPathV2({
    frame: exactSiblingFrame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f1-exact-sibling'],
      inboundTextsById: { 'in-f1-exact-sibling': exactSiblingInbound },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: exactSiblingInbound,
    servicesResult: dualTypoServices,
    config,
    now: canaryNow,
    executeTool: async (name, args) => {
      assert.equal(name, 'getAvailableSlots');
      assert.equal(args.serviceId, 'svc-drenagem');
      assert.equal(args.date, '2026-08-16');
      return JSON.stringify({
        success: true,
        slots: ['10:00', '11:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(
    exactSiblingDateSlots.kind,
    'resolved',
    'F1 IA-9: nome completo com irmão ancora leitura'
  );
  if (exactSiblingDateSlots.kind === 'resolved') {
    assert.equal(
      exactSiblingDateSlots.nextFlowState.fixedServiceId,
      'svc-drenagem'
    );
  }

  const nestedCatalogServices: ServicesResult = {
    success: true,
    services: [
      {
        id: 'svc-corte',
        name: 'Corte',
        durationMinutes: 30,
        price: 80,
        priceFormatted: 'R$ 80,00',
        professionalIds: ['prof-carla'],
      },
      {
        id: 'svc-corte-barba',
        name: 'Corte e Barba',
        durationMinutes: 45,
        price: 100,
        priceFormatted: 'R$ 100,00',
        professionalIds: ['prof-carla'],
      },
    ],
    professionals: [{ id: 'prof-carla', name: 'Carla Mendes' }],
  };
  const nestedChildInbound = 'Quais horários tem domingo pra Corte e Barba?';
  const nestedChildFrame = frame({
    pending: null,
    flowState: {
      flowId: 'flow-f1-nested-child',
      lastOperationalAt: canaryNow.toISOString(),
      fixedByProofVersion: {},
    },
  });
  const nestedChildDateSlots = await progressModule.resolveDateSlotsFastPathV2({
    frame: nestedChildFrame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f1-nested-child'],
      inboundTextsById: { 'in-f1-nested-child': nestedChildInbound },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: nestedChildInbound,
    servicesResult: nestedCatalogServices,
    config,
    now: canaryNow,
    executeTool: async (name, args) => {
      assert.equal(name, 'getAvailableSlots');
      assert.equal(args.serviceId, 'svc-corte-barba');
      assert.equal(args.date, '2026-08-16');
      return JSON.stringify({
        success: true,
        slots: ['10:00', '11:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(
    nestedChildDateSlots.kind,
    'resolved',
    'F1 IA-9: Corte e Barba vs Corte resolve o filho'
  );
  if (nestedChildDateSlots.kind === 'resolved') {
    assert.equal(
      nestedChildDateSlots.nextFlowState.fixedServiceId,
      'svc-corte-barba'
    );
  }

  const f4TimePending = pending({
    kind: 'TIME',
    askedAt: canaryNow.toISOString(),
    options: [
      { position: 1, entityId: '09:00', displayName: '09:00' },
      { position: 2, entityId: '11:00', displayName: '11:00' },
    ],
  });
  const f4Frame = frame({
    pending: f4TimePending,
    flowState: {
      flowId: f4TimePending.flowId,
      lastOperationalAt: canaryNow.toISOString(),
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-carla',
      resolvedDate: '2026-08-16',
      slotEvidence: {
        turnId: 'turn-f4-old',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-carla',
        date: '2026-08-16',
        slots: ['09:00', '11:00'],
      },
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    },
  });
  const f4Present = await progressModule.resolveDateSlotsFastPathV2({
    frame: f4Frame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f4'],
      inboundTextsById: { 'in-f4': 'Pode ser dia 17/08 as 10h' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Pode ser dia 17/08 as 10h',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async (_name, args) => {
      assert.equal(args.date, '2026-08-17');
      return JSON.stringify({
        success: true,
        slots: ['10:00', '11:00', '14:00'],
        professionalId: 'prof-carla',
      });
    },
  });
  assert.equal(f4Present.kind, 'resolved');
  if (f4Present.kind === 'resolved') {
    assert.equal(
      f4Present.result.pendingTransitionCandidate.kind === 'open' &&
        f4Present.result.pendingTransitionCandidate.pendingKind,
      'CONFIRMATION',
      'F4: 10h na lista nova segue ao resumo'
    );
    assert.equal(f4Present.nextFlowState.bookingDraft?.time, '10:00');
    assert.equal(f4Present.nextFlowState.bookingDraft?.date, '2026-08-17');
    assert.match(f4Present.result.reply, /^Confirmando:/);
  }

  const f4Missing = await progressModule.resolveDateSlotsFastPathV2({
    frame: f4Frame,
    dateResolution: dateModule.resolveCurrentInboundDateV2({
      currentInboundIds: ['in-f4b'],
      inboundTextsById: { 'in-f4b': 'Pode ser dia 17/08 as 10h' },
      now: canaryNow,
      timezone: canaryTz,
    }),
    currentInboundText: 'Pode ser dia 17/08 as 10h',
    servicesResult: services,
    config,
    now: canaryNow,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        slots: ['11:00', '14:00'],
        professionalId: 'prof-carla',
      }),
  });
  assert.equal(f4Missing.kind, 'resolved');
  if (f4Missing.kind === 'resolved') {
    assert.equal(
      f4Missing.result.pendingTransitionCandidate.kind === 'open' &&
        f4Missing.result.pendingTransitionCandidate.pendingKind,
      'TIME',
      'F4: 10h ausente da lista nova pergunta de novo'
    );
  }

  const ia7DuplicatePending = pending({
    kind: 'CONFIRMATION',
    askedAt: canaryNow.toISOString(),
    options: [
      { position: 1, entityId: 'duplicate-resolution:keep-both', displayName: 'manter os dois' },
      { position: 2, entityId: 'duplicate-resolution:reschedule', displayName: 'remarcar' },
      { position: 3, entityId: 'duplicate-resolution:cancel-only', displayName: 'só cancelar o anterior' },
      { position: 4, entityId: 'duplicate-resolution:decide-later', displayName: 'decidir depois' },
    ],
  });
  const ia7DuplicateFrame = frame({
    pending: ia7DuplicatePending,
    flowState: {
      flowId: ia7DuplicatePending.flowId,
      lastOperationalAt: canaryNow.toISOString(),
      fixedByProofVersion: {},
    },
  });
  const politeKeep = fastPaths.resolvePendingOptionProofV2({
    frame: ia7DuplicateFrame,
    inboundId: 'in-keep',
    inboundText: 'Pode manter os dois',
    now: canaryNow,
  });
  assert.equal(politeKeep?.entityId, 'duplicate-resolution:keep-both', 'F5: prefixo pode resolve');
  const bareKeep = fastPaths.resolvePendingOptionProofV2({
    frame: ia7DuplicateFrame,
    inboundId: 'in-keep-bare',
    inboundText: 'manter os dois',
    now: canaryNow,
  });
  assert.equal(bareKeep?.entityId, 'duplicate-resolution:keep-both');
  const negatedKeep = fastPaths.resolvePendingOptionProofV2({
    frame: ia7DuplicateFrame,
    inboundId: 'in-keep-nao',
    inboundText: 'não quero manter os dois',
    now: canaryNow,
  });
  assert.equal(negatedKeep, null, 'F5: polaridade negativa não resolve a opção afirmativa');
  const queroRemarcar = fastPaths.resolvePendingOptionProofV2({
    frame: ia7DuplicateFrame,
    inboundId: 'in-rem',
    inboundText: 'quero remarcar',
    now: canaryNow,
  });
  assert.equal(queroRemarcar?.entityId, 'duplicate-resolution:reschedule');
  for (const inbound of [
    'prefiro manter os dois',
    'acho que manter os dois',
    'pode ser manter os dois',
    'vou querer remarcar',
  ] as const) {
    const polite = fastPaths.resolvePendingOptionProofV2({
      frame: ia7DuplicateFrame,
      inboundId: `in-${inbound}`,
      inboundText: inbound,
      now: canaryNow,
    });
    assert.ok(polite, `F5: ${inbound} resolve`);
    assert.match(
      polite?.entityId ?? '',
      inbound.includes('remarcar')
        ? /reschedule/
        : /keep-both/,
      inbound
    );
  }
  for (const inbound of [
    'pode remarcar?',
    'posso remarcar?',
    'não quero remarcar',
  ] as const) {
    const blocked = fastPaths.resolvePendingOptionProofV2({
      frame: ia7DuplicateFrame,
      inboundId: `in-ia8-${inbound}`,
      inboundText: inbound,
      now: canaryNow,
    });
    assert.equal(blocked, null, `F5 Q5: ${inbound} não resolve seleção`);
  }

  const timeFrame = frame({
    pending: oldTimePending,
    flowState: {
      ...oldTimeFrame.flowState,
      resolvedDate: '2026-08-14',
      slotEvidence: {
        turnId: 'turn-slots',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-carla',
        date: '2026-08-14',
        slots: ['14:00', '15:00'],
      },
    },
  });
  const conflict = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async (name) => {
      assert.equal(name, 'getUpcomingAppointments');
      return JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'appointment-must-not-leak',
            startTime: '2026-08-14T17:00:00.000Z',
            endTime: '2026-08-14T18:00:00.000Z',
            serviceName: 'Drenagem Linfática',
            professionalName: 'Carla Mendes',
            status: 'CONFIRMED',
          },
        ],
      });
    },
  });
  assert.equal(conflict.kind, 'resolved');
  if (conflict.kind !== 'resolved') throw new Error('P3 não detectou conflito');
  assert.match(conflict.result.reply, /manter os dois, remarcar, só cancelar o anterior ou decidir depois/u);
  assert.doesNotMatch(conflict.result.reply, /appointment-must-not-leak/u);
  assert.deepEqual(
    conflict.result.pendingTransitionCandidate.kind === 'open'
      ? conflict.result.pendingTransitionCandidate.optionEntityIds
      : [],
    [
      'duplicate-resolution:keep-both',
      'duplicate-resolution:reschedule',
      'duplicate-resolution:cancel-only',
      'duplicate-resolution:decide-later',
    ],
    'displayNames/opções de duplicidade permanecem canônicos'
  );
  const conflictBoundary = boundaryModule.evaluateBoundaryV2({
    rawCandidate: conflict.result.reply,
    servicesResult: services,
    toolTrace: conflict.loop.toolTrace,
    sourceInboundText: '14h',
    currentInboundIds: ['in-1'],
    inboundTextsById: { 'in-1': '14h' },
    flowState: conflict.nextFlowState,
    pendingTransitionCandidate: conflict.result.pendingTransitionCandidate,
    replyPurpose: conflict.result.replyPurpose,
    route: 'model',
    pendingAnaOpen: true,
    pendingSnapshot: timeFrame.pending,
  });
  assert.equal(
    conflictBoundary.safe && conflictBoundary.originalAccepted,
    true,
    `copy de duplicidade com leitura autoritativa deve passar: ${conflictBoundary.reasonCodes.join(',')}`
  );

  const overlapOtherService = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'typed-overlap',
            startTime: '2026-08-14T17:30:00.000Z',
            endTime: '2026-08-14T18:15:00.000Z',
            serviceName: 'Limpeza de Pele Profunda',
            professionalName: 'Carla Mendes',
            status: 'CONFIRMED',
          },
        ],
      }),
  });
  assert.equal(
    overlapOtherService.kind,
    'resolved',
    'serviço diferente com sobreposição no mesmo dia é conflito'
  );
  const noConflict = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'typed-no-overlap',
            startTime: '2026-08-14T19:00:00.000Z',
            endTime: '2026-08-14T20:00:00.000Z',
            serviceName: 'Limpeza de Pele Profunda',
            professionalName: 'Carla Mendes',
            status: 'CONFIRMED',
          },
        ],
      }),
  });
  assert.equal(
    noConflict.kind,
    'continue_model',
    'serviço diferente sem sobreposição não expõe nem abre duplicidade'
  );
  const sameServiceOtherDay = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'typed-same-service-other-day',
            startTime: '2026-08-15T17:00:00.000Z',
            endTime: '2026-08-15T18:00:00.000Z',
            serviceName: 'Drenagem Linfática',
            professionalName: 'Carla Mendes',
            status: 'CONFIRMED',
          },
        ],
      }),
  });
  assert.equal(
    sameServiceOtherDay.kind,
    'resolved',
    'mesmo serviço conflita mesmo em outra data, conforme filtro tipado'
  );
  assert.doesNotThrow(
    () =>
      receiptModule.serializeTurnPlanReceiptV2({
        schemaVersion: 2,
        planReceiptId: 'ea75666d-e51a-4408-8f41-041115543015',
        turnId: 'ea75666d-e51a-4408-8f41-041115543015',
        frameHash: 'b'.repeat(64),
        inputSequence: 109,
        route: 'fast_path',
        provider: 'openai',
        requestedModel: 'gpt-4o-mini',
        response: { model: null, systemFingerprint: null },
        thinkingMode: 'disabled',
        strictTools: false,
        primaryModelRounds: 0,
        primaryProviderCalls: 0,
        regenProviderCalls: 0,
        pendingTransitionCandidate: {
          kind: 'open',
          pendingKind: 'CONFIRMATION',
          flowIdHash: 'c'.repeat(64),
          optionCount: 4,
        },
        toolEffects: [
          {
            invocationId: 'invocation-upcoming',
            tool: 'getUpcomingAppointments',
            class: 'read',
            outcome: 'success',
            writeCommitted: false,
          },
        ],
        boundaryAttempts: [{ index: 0, candidateHash: 'd'.repeat(64), reasonCodes: [] }],
        recoveryKind: 'none',
        result: 'accepted_for_delivery',
      }),
    'plano de duplicidade com UUID azarado serializa'
  );

  const duplicatePending = pending({
    kind: 'CONFIRMATION',
    options: [
      { position: 1, entityId: 'duplicate-resolution:keep-both', displayName: 'manter os dois' },
      { position: 2, entityId: 'duplicate-resolution:reschedule', displayName: 'remarcar' },
      { position: 3, entityId: 'duplicate-resolution:cancel-only', displayName: 'só cancelar o anterior' },
      { position: 4, entityId: 'duplicate-resolution:decide-later', displayName: 'decidir depois' },
    ],
  });
  const duplicateFrame = frame({
    pending: duplicatePending,
    flowState: {
      ...timeFrame.flowState,
      flowId: duplicatePending.flowId,
      bookingDraft: {
        serviceId: 'svc-drenagem',
        professionalId: 'prof-carla',
        date: '2026-08-14',
        time: '14:00',
        slotEvidenceTurnId: 'turn-slots',
      },
    },
  });
  const keepBothProof = fastPaths.resolvePendingOptionProofV2({
    frame: duplicateFrame,
    inboundId: 'in-1',
    inboundText: 'outro atendimento',
    now,
    catalog: services,
  });
  assert.equal(keepBothProof?.kind, 'pending_option');
  assert.equal(
    keepBothProof?.kind === 'pending_option' ? keepBothProof.entityId : null,
    'duplicate-resolution:keep-both',
    'outro atendimento resolve somente a opção keep-both tipada'
  );
  const keepBoth = await progressModule.resolveDuplicateKeepBothFastPathV2({
    frame: duplicateFrame,
    proof: keepBothProof,
    servicesResult: services,
    config,
    executeTool: async (name) => {
      assert.equal(name, 'getUpcomingAppointments');
      return JSON.stringify({
        success: true,
        appointments: [
          {
            id: 'typed-keep-both',
            startTime: '2026-08-15T17:00:00.000Z',
            endTime: '2026-08-15T18:00:00.000Z',
            serviceName: 'Drenagem Linfática',
            professionalName: 'Carla Mendes',
            status: 'CONFIRMED',
          },
        ],
      });
    },
  });
  assert.equal(keepBoth.kind, 'resolved');
  if (keepBoth.kind !== 'resolved') throw new Error('keep-both não resolveu');
  assert.match(keepBoth.result.reply, /^Confirmando:/u);
  assert.equal(keepBoth.nextFlowState.duplicateResolution?.kind, 'keep_both');
  assert.deepEqual(
    keepBoth.result.pendingTransitionCandidate,
    {
      kind: 'open',
      pendingKind: 'CONFIRMATION',
      flowId: duplicatePending.flowId,
      optionEntityIds: [`booking-confirmation:${duplicatePending.flowId}`],
    },
    'keep-both volta ao resumo e abre confirmação normal nova'
  );

  const reentryPending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14:00' },
      { position: 2, entityId: '15:00', displayName: '15:00' },
    ],
  });
  const reentryFrame = frame({
    pending: reentryPending,
    flowState: {
      flowId: reentryPending.flowId,
      fixedServiceId: 'svc-drenagem',
      fixedProfessionalId: 'prof-carla',
      resolvedDate: '2026-08-14',
      slotEvidence: {
        turnId: 'turn-reentry-slots',
        serviceId: 'svc-drenagem',
        professionalId: 'prof-carla',
        date: '2026-08-14',
        slots: ['14:00', '15:00'],
      },
      fixedByProofVersion: {
        fixedServiceId: 1,
        fixedProfessionalId: 1,
        resolvedDate: 1,
      },
    },
  });
  const reentry = reentryModule.resolveBookingReentryFastPathV2({
    frame: reentryFrame,
    inboundId: 'in-1',
    inboundText: 'quero agendar',
    currentDateResolution: { kind: 'none', mentions: [] },
    catalog: services,
    now,
    newFlowId: () => 'flow-new-reentry',
  });
  assert.equal(reentry.kind, 'resolved');
  if (reentry.kind !== 'resolved') throw new Error('reentrada não resolveu');
  assert.equal(
    reentry.result.reply,
    'A gente estava marcando Drenagem Linfática para 14/08/2026 — quer continuar esse agendamento ou marcar outro?'
  );
  assert.deepEqual(
    reentry.result.pendingTransitionCandidate,
    {
      kind: 'open',
      pendingKind: 'CONFIRMATION',
      flowId: reentryPending.flowId,
      optionEntityIds: ['booking-reentry:continue', 'booking-reentry:new'],
    },
    'reentrada abre somente continuar|novo sem chamar modelo'
  );
  const reentryChoicePending = pending({
    kind: 'CONFIRMATION',
    options: [
      { position: 1, entityId: 'booking-reentry:continue', displayName: 'continuar esse agendamento' },
      { position: 2, entityId: 'booking-reentry:new', displayName: 'marcar outro' },
    ],
  });
  const reentryNew = reentryModule.resolveBookingReentryFastPathV2({
    frame: frame({
      pending: reentryChoicePending,
      flowState: {
        ...reentryFrame.flowState,
        flowId: reentryChoicePending.flowId,
        bookingReentry: {
          pendingKind: 'TIME',
          optionEntityIds: ['14:00', '15:00'],
        },
      },
    }),
    inboundId: 'in-1',
    inboundText: 'marcar outro',
    currentDateResolution: { kind: 'none', mentions: [] },
    catalog: services,
    now,
    newFlowId: () => 'flow-new-reentry',
  });
  assert.equal(reentryNew.kind, 'resolved');
  if (reentryNew.kind !== 'resolved') throw new Error('novo não resolveu');
  assert.equal(reentryNew.nextFlowState.flowId, 'flow-new-reentry');
  assert.equal(reentryNew.nextFlowState.fixedServiceId, undefined);
  assert.deepEqual(
    reentryNew.result.pendingTransitionCandidate,
    {
      kind: 'open',
      pendingKind: 'SERVICE',
      flowId: 'flow-new-reentry',
      optionEntityIds: ['svc-drenagem', 'svc-limpeza'],
    },
    'novo aplica o reset estreito e abre SERVICE no novo flow'
  );

  const identityBlocked = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: false,
        reason: 'customer_identity_ambiguous',
        appointments: [{ serviceName: 'Segredo' }],
      }),
  });
  assert.equal(identityBlocked.kind, 'resolved');
  if (identityBlocked.kind !== 'resolved') throw new Error('identidade não bloqueou');
  assert.doesNotMatch(identityBlocked.result.reply, /Segredo|agendamento de/u);
  assert.match(identityBlocked.result.reply, /identificar com segurança/u);
  const identityMismatch = await progressModule.resolveTimeDuplicatePreflightV2({
    frame: timeFrame,
    inboundId: 'in-1',
    inboundText: '14h',
    currentDateResolution: { kind: 'none', mentions: [] },
    servicesResult: services,
    config,
    now,
    executeTool: async () =>
      JSON.stringify({
        success: false,
        reason: 'customer_identity_mismatch',
        appointments: [{ serviceName: 'Outro segredo' }],
      }),
  });
  assert.equal(identityMismatch.kind, 'resolved');
  if (identityMismatch.kind !== 'resolved') throw new Error('mismatch não bloqueou');
  assert.doesNotMatch(identityMismatch.result.reply, /Outro segredo|agendamento de/u);
  assert.match(identityMismatch.result.reply, /identificar com segurança/u);

  const serviceQuestion = {
    schemaVersion: 2 as const,
    reply: 'Claro! Para qual serviço você gostaria de agendar? Temos Drenagem Linfática e Limpeza de Pele Profunda. Qual você prefere?',
    replyPurpose: 'SERVICE_QUESTION' as const,
    pendingTransitionCandidate: {
      kind: 'open' as const,
      pendingKind: 'SERVICE' as const,
      flowId: 'flow-wave1',
      optionEntityIds: ['svc-drenagem', 'svc-limpeza'],
    },
    resolutionCandidate: null,
    unknownServiceEvidence: null,
  };
  const firstVariant = copyModule.varyUnanchoredServerCopyV2({
    result: serviceQuestion,
    seed: 1,
  });
  const secondVariant = copyModule.varyUnanchoredServerCopyV2({
    result: serviceQuestion,
    lastVariant: firstVariant.variant,
    seed: 1,
  });
  assert.notEqual(firstVariant.variant, secondVariant.variant, 'variante não repete seguida');
  const confirmation = {
    ...serviceQuestion,
    reply: 'Confirmando: Drenagem Linfática, em 14/08/2026, às 14h, com Carla Mendes. Posso marcar?',
    replyPurpose: 'WRITE_CONFIRMATION' as const,
    pendingTransitionCandidate: {
      kind: 'open' as const,
      pendingKind: 'CONFIRMATION' as const,
      flowId: 'flow-wave1',
      optionEntityIds: ['booking-confirmation:flow-wave1'],
    },
  };
  const frozen = copyModule.varyUnanchoredServerCopyV2({
    result: confirmation,
    seed: 2,
  });
  assert.equal(frozen.variant, 'canonical');
  assert.equal(frozen.result.reply, confirmation.reply, 'âncora de confirmação é byte-idêntica');

  const dateQuestion = {
    ...serviceQuestion,
    reply: 'Perfeito. Qual dia você prefere?',
    replyPurpose: 'DATE_TIME_QUESTION' as const,
    pendingTransitionCandidate: {
      kind: 'open' as const,
      pendingKind: 'DATE' as const,
      flowId: 'flow-wave1',
      optionEntityIds: ['date-freeform'],
    },
  };
  const dateQuestion3 = copyModule.varyUnanchoredServerCopyV2({
    result: dateQuestion,
    seed: 2,
  });
  assert.equal(dateQuestion3.variant, 'date_question_3');
  assert.equal(
    dateQuestion3.result.reply,
    'Combinado, então. Qual dia você prefere?'
  );
  assert.deepEqual(
    workflowModule.findWorkflowLanguageV2(dateQuestion3.result.reply),
    []
  );
  assert.deepEqual(workflowModule.findWorkflowLanguageV2('Combinado.'), [
    'Combinado.',
  ]);
  assert.deepEqual(
    workflowModule.findWorkflowLanguageV2('Combinado, então.'),
    []
  );

  assert.equal(voiceModule.VOICE_TEMPLATE_VERSION_V2, 2);
  assert.equal(
    voiceModule.VOICE_CONNECTIVE_PHRASES_V2.combinado_dot,
    'Combinado, então.'
  );
  const nonAnchorCopies = [
    ...Object.values(voiceModule.VOICE_CONNECTIVE_PHRASES_V2),
    ...voiceModule.COMPILED_VOICE_POOLS_V2.flatMap((pool) =>
      pool.variants.map((variant) => variant.connective)
    ),
    'Pra 14/08/2026 eu tenho 15:00, 16:00. Qual fica melhor pra você?',
    'A gente ia de Drenagem Linfática em 14/08/2026 — quer continuar esse agendamento ou marcar outro?',
    'A gente ainda estava no Drenagem Linfática de 14/08/2026 — quer continuar esse agendamento ou marcar outro?',
    dateQuestion3.result.reply,
  ];
  for (const copy of nonAnchorCopies) {
    assert.deepEqual(
      workflowModule.findWorkflowLanguageV2(copy),
      [],
      `copy de workflow: ${copy}`
    );
  }
  const anchors = [
    'Confirmando: Drenagem Linfática, em 14/08/2026, às 14h, com Carla Mendes. Posso marcar?',
    'Tudo certo! Seu agendamento foi confirmado com sucesso.',
    'Você confirma essa opção?',
  ];
  for (const copy of anchors) {
    assert.deepEqual(
      workflowModule.findWorkflowLanguageV2(copy),
      [],
      `âncora tocada: ${copy}`
    );
  }

  assert.deepEqual(
    canaryModule.LINGUISTIC_CANARY_FIXTURES_V2.map((entry) => entry.id),
    [
      'pra',
      'ta',
      'ellipsis',
      'pode_ser_as_15_q',
      'depois_das_tres',
      'time_correction',
    ]
  );
  const praDate = dateModule.resolveCurrentInboundDateV2({
    currentInboundIds: ['in-1'],
    inboundTextsById: {
      'in-1': canaryModule.linguisticCanaryByIdV2('pra').inbound,
    },
    now,
    timezone,
  });
  assert.equal(praDate.kind, 'resolved');
  if (praDate.kind === 'resolved') {
    assert.equal(praDate.date, '2026-08-13');
  }

  const canaryTimePending = pending({
    kind: 'TIME',
    options: [
      { position: 1, entityId: '14:00', displayName: '14h' },
      { position: 2, entityId: '15:00', displayName: '15h' },
      { position: 3, entityId: '16:00', displayName: '16h' },
    ],
  });
  const canaryTimeFrame = frame({
    pending: canaryTimePending,
    flowState: {
      flowId: canaryTimePending.flowId,
      lastOperationalAt: now.toISOString(),
      fixedServiceId: 'svc-drenagem',
      resolvedDate: '2026-08-14',
      slotEvidence: {
        turnId: 'turn-canary',
        serviceId: 'svc-drenagem',
        date: '2026-08-14',
        slots: ['14:00', '15:00', '16:00'],
      },
      fixedByProofVersion: { fixedServiceId: 1, resolvedDate: 1 },
    },
  });
  const canaryEntity = (inbound: string) =>
    fastPaths.resolvePendingOptionProofV2({
      frame: canaryTimeFrame,
      inboundId: 'in-1',
      inboundText: inbound,
      now,
    })?.entityId ?? null;
  assert.equal(
    canaryEntity(canaryModule.linguisticCanaryByIdV2('ellipsis').inbound),
    '15:00'
  );
  assert.equal(
    canaryEntity(canaryModule.linguisticCanaryByIdV2('pode_ser_as_15_q').inbound),
    '15:00'
  );
  assert.equal(
    canaryEntity(canaryModule.linguisticCanaryByIdV2('depois_das_tres').inbound),
    '16:00'
  );
  assert.equal(
    canaryEntity(canaryModule.linguisticCanaryByIdV2('time_correction').inbound),
    '16:00'
  );
  const singleTimePending = pending({
    kind: 'TIME',
    options: [{ position: 1, entityId: '15:00', displayName: '15h' }],
  });
  assert.equal(
    fastPaths.resolvePendingOptionProofV2({
      frame: frame({
        pending: singleTimePending,
        flowState: {
          flowId: singleTimePending.flowId,
          lastOperationalAt: now.toISOString(),
          fixedServiceId: 'svc-drenagem',
          resolvedDate: '2026-08-14',
          fixedByProofVersion: { fixedServiceId: 1, resolvedDate: 1 },
        },
      }),
      inboundId: 'in-1',
      inboundText: canaryModule.linguisticCanaryByIdV2('ta').inbound,
      now,
    })?.entityId,
    '15:00'
  );

  const store = new stateModule.MemoryConversationalV2StateStore();
  store.pending.set('conversation-idle-not-expired', [
    {
      conversationKey: 'conversation-idle-not-expired',
      state: 'OPEN',
      snapshot: pending({
        kind: 'DATE',
        flowId: 'flow-idle',
        askedAt: new Date(now.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
      }),
      flowState: {
        flowId: 'flow-idle',
        lastOperationalAt: new Date(now.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
        fixedServiceId: 'svc-drenagem',
        fixedByProofVersion: { fixedServiceId: 1 },
      },
      updatedAt: new Date(now.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
    },
  ]);
  const idlePhysical = await store.loadLatestState(
    'conversation-idle-not-expired',
    now
  );
  assert.ok(idlePhysical.pending, 'TTL operacional de 4h não apaga a linha física de 24h');
  assert.ok(idlePhysical.flowState, 'runtime recebe o estado idle para criar novo flowId');
  assert.equal(
    store.pending.get('conversation-idle-not-expired')?.[0]?.state,
    'OPEN',
    'linha de 5h permanece auditável e OPEN até o teto físico'
  );
  store.pending.set('conversation-expired', [
    {
      conversationKey: 'conversation-expired',
      state: 'OPEN',
      snapshot: pending({
        kind: 'SERVICE',
        askedAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000).toISOString(),
      }),
      flowState: {
        flowId: 'flow-expired',
        lastOperationalAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000).toISOString(),
        fixedServiceId: 'svc-drenagem',
        fixedByProofVersion: { fixedServiceId: 1 },
      },
      updatedAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000).toISOString(),
    },
  ]);
  assert.equal(
    (await store.loadLatestState('conversation-expired', now)).flowState,
    null,
    'linha física EXPIRED não ressuscita flowState'
  );
  assert.equal(
    store.pending.get('conversation-expired')?.length,
    1,
    'histórico físico da pendência expirada não foi deletado'
  );

  const openaiRuntime = providerModule.resolveReceptionistAiRuntime(config);
  assert.equal(openaiRuntime.provider, 'openai');
  const openaiRequest = providerModule.buildReceptionistCompletionRequest(
    openaiRuntime,
    {
      messages: [{ role: 'user', content: 'fixture' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 128,
      responseFormat: 'json_object',
    }
  );
  assert.equal(openaiRequest.model, 'gpt-4o-mini');
  assert.equal(openaiRequest.tool_choice, 'auto');
  assert.deepEqual(openaiRequest.response_format, { type: 'json_object' });

  receiptModule.assertReceiptRedactedV2({
    schemaVersion: 2,
    planReceiptId: 'plan-wave1',
    turnId: 'turn-wave1',
    frameHash: 'b'.repeat(64),
    inputSequence: 1,
    route: 'fast_path',
    primaryModelRounds: 0,
    primaryProviderCalls: 0,
    regenProviderCalls: 0,
    pendingTransitionCandidate: { kind: 'preserve' },
    toolEffects: [],
    boundaryAttempts: [],
    recoveryKind: 'none',
    copyVariant: firstVariant.variant,
    result: 'accepted_for_delivery',
  });

  console.log('smoke-ana-conversational-v2-wave1: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
