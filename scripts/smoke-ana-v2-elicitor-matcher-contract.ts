#!/usr/bin/env ts-node
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://smoke:smoke@127.0.0.1:1/ana-v2-elicitor-contract';
process.env.OPENAI_API_KEY = 'sk-smoke-invalid';
process.env.ERP_API_TOKEN = 'smoke-invalid';

async function main(): Promise<void> {
  const {
    extractQuotedElicitorAnswers,
    elicitorMatcherContractRowsV2,
    __elicitorMatcherContractForSmokeV2,
  } = await import(
    '../src/services/conversationalV2/elicitorMatcherContract'
  );
  const { isExplicitBookingConfirmation, bookingConfirmationGate } =
    await import('../src/services/bookingConfirmationGate');
  const { cancelConfirmationGateV2 } = await import(
    '../src/services/conversationalV2/cancellationFlowV2'
  );
  const { resolvePendingOptionProofV2 } = await import(
    '../src/services/conversationalV2/fastPaths'
  );
  const { DATE_PENDING_QUESTION_V2 } = await import(
    '../src/services/conversationalV2/pendingQuestion'
  );

  const rows = elicitorMatcherContractRowsV2();
  assert.ok(
    rows.some((row) => row.nome === 'resumo canônico booking — recibo compatível'),
    'linha do resumo canônico com recibo compatível'
  );
  assert.ok(
    rows.some((row) => row.nome === 'resumo canônico booking — recibo ausente'),
    'linha do resumo canônico com recibo ausente'
  );
  assert.ok(
    rows.some((row) => row.nome === 'CANCEL_CONFIRMATION'),
    'linha de CANCEL_CONFIRMATION'
  );
  assert.ok(
    rows.some((row) => row.nome === 'duplicidade — 4 opções'),
    'linha de duplicidade'
  );
  assert.ok(
    rows.some((row) => row.nome === 'clarificador de meia-hora'),
    'linha do clarificador'
  );
  assert.ok(
    rows.some((row) => row.nome === 'pergunta de DATE'),
    'linha de DATE'
  );
  assert.ok(
    rows.some(
      (row) =>
        row.nome ===
        'legado isExplicitBookingConfirmation × CONFIRMATION_HINT'
    ),
    'linha do matcher legado'
  );

  for (const row of rows) {
    const quoted = extractQuotedElicitorAnswers(row.elicitor);
    const naturaisAutorizam = row.respostasNaturaisAutorizam !== false;
    for (const taught of quoted) {
      assert.equal(
        row.matcher(taught),
        naturaisAutorizam,
        `${row.nome}: elicitor ensina "${taught}" e o matcher deve ${
          naturaisAutorizam ? 'aceitar' : 'bloquear sem entrega'
        }`
      );
    }
    for (const reply of row.respostasNaturais) {
      assert.equal(
        row.matcher(reply),
        naturaisAutorizam,
        `${row.nome}: resposta natural "${reply}"`
      );
    }
    for (const reply of row.negacoes) {
      assert.equal(
        row.matcher(reply),
        false,
        `${row.nome}: negação "${reply}"`
      );
    }
    for (const reply of row.interrogativas) {
      assert.equal(
        row.matcher(reply),
        false,
        `${row.nome}: interrogativa "${reply}"`
      );
    }
  }

  const bookingRow = rows.find(
    (row) => row.nome === 'resumo canônico booking — recibo compatível'
  );
  const bookingHole = rows.find(
    (row) => row.nome === 'resumo canônico booking — recibo ausente'
  );
  assert.ok(bookingRow);
  assert.ok(bookingHole);
  assert.match(bookingRow!.elicitor, /Posso marcar\?$/u);
  assert.equal(
    bookingRow!.matcher('Certo'),
    true,
    'caso vivo: Certo pós-resumo CONFIRMA com recibo compatível'
  );
  assert.equal(
    bookingRow!.matcher('uhum'),
    true,
    'uhum pós-resumo CONFIRMA com recibo compatível'
  );
  for (const reply of ['Certo', 'uhum', 'sim', 'aham']) {
    assert.equal(
      bookingHole!.matcher(reply),
      false,
      `${reply} com recibo null não confirma`
    );
  }
  const uncommitted = __elicitorMatcherContractForSmokeV2.compatibleBookingDelivery();
  assert.equal(
    __elicitorMatcherContractForSmokeV2.bookingConfirmationMatcher('Certo', {
      ...uncommitted,
      conversationCommitOutcome: 'accepted_uncommitted',
    }),
    false,
    'Certo com accepted_uncommitted não confirma'
  );
  assert.equal(
    isExplicitBookingConfirmation('Certo'),
    true,
    'matcher legado aceita Certo'
  );
  assert.equal(
    bookingConfirmationGate({
      currentUserMessage: 'Certo',
      history: [],
      confirmedDuplicate: false,
    }).ok,
    false,
    'Certo em turno livre não confirma'
  );
  assert.equal(
    cancelConfirmationGateV2({
      currentInboundBatchText: 'Certo',
      pending: null,
      flowState: { flowId: 'flow-free', fixedByProofVersion: {} },
      lastAcceptedDelivery: null,
      now: __elicitorMatcherContractForSmokeV2.CONTRACT_NOW,
    }).ok,
    false,
    'Certo sem CANCEL_CONFIRMATION entregue não confirma'
  );

  const dateRow = rows.find((row) => row.nome === 'pergunta de DATE');
  assert.equal(dateRow?.elicitor, DATE_PENDING_QUESTION_V2);

  const duplicateFrame = {
    schemaVersion: 2 as const,
    turnId: 'turn-free',
    inputSequence: 1,
    catalogSnapshotHash: 'a'.repeat(64),
    catalogState: 'available' as const,
    humanControl: 'NO_ACTIVE_TAKEOVER' as const,
    currentInboundIds: ['in-free'],
    pending: {
      questionId: 'question-date',
      askedAt: '2026-08-16T17:55:00.000Z',
      kind: 'DATE' as const,
      flowId: 'flow-date-free',
      version: 1,
      options: [
        { position: 1, entityId: 'date-freeform', displayName: 'dia desejado' },
      ],
    },
    flowState: {
      flowId: 'flow-date-free',
      lastOperationalAt: '2026-08-16T18:00:00.000Z',
      fixedByProofVersion: {},
    },
  };
  assert.equal(
    resolvePendingOptionProofV2({
      frame: duplicateFrame,
      inboundId: 'in-free',
      inboundText: 'claro',
      now: __elicitorMatcherContractForSmokeV2.CONTRACT_NOW,
    }),
    null,
    'família afirmativa não seleciona DATE em turno que não é confirmação'
  );

  console.log('smoke-ana-v2-elicitor-matcher-contract: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
