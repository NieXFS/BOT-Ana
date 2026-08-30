/**
 * Gate determinístico, 100% em memória, da seleção do tombstone PROD -> LAB.
 *
 * Este script espelha a consulta da seção 6 do runbook sem importar runtime,
 * abrir DB, ler env, fazer HTTP ou semear qualquer storage. A derivação é a
 * interseção `processed_messages JOIN inbound_event_outbox` por `message_id`:
 * somente o outbox aplica o corte `received_at < T_HOLD`; `processed_at` nunca
 * participa do filtro. A validação posterior é uma cerca separada: estado
 * instável, chave divergente ou mudança entre leituras abortam.
 */

import { createHash } from 'node:crypto';

type Decision = 'INCLUI' | 'EXCLUI' | 'ABORTA';

interface ProcessedMessageRow {
  messageId: string;
  phoneNumberId: string;
  conversationKey: string;
  processedAt: string;
}

interface InboundOutboxRow {
  messageId: string;
  phoneNumberId: string;
  conversationKey: string;
  receivedAt: string;
  contentStatus: string;
  deliveredAt: string | null;
  terminalAt: string | null;
}

export interface SeedSelectionInput {
  processedMessages: readonly ProcessedMessageRow[];
  inboundEventOutbox: readonly InboundOutboxRow[];
  phoneNumberId: string;
  conversationKey: string;
  holdAt: string;
}

export interface SeedCandidateSet {
  /** IDs ficam somente na memória; a saída do gate usa apenas count + digest. */
  readonly messageIds: readonly string[];
  readonly count: number;
  readonly digest: string;
  readonly processedSourceRows: number;
  readonly outboxSourceRows: number;
  readonly intersectionRows: number;
  readonly keyMismatchRows: number;
  readonly unstableRows: number;
  readonly stableRows: number;
}

export interface SeedValidation {
  readonly decision: Decision;
  readonly reason:
    | 'candidate_set_stable'
    | 'candidate_set_empty'
    | 'candidate_set_changed'
    | 'key_mismatch'
    | 'unstable_outbox';
}

interface JoinedRow {
  processed: ProcessedMessageRow;
  outbox: InboundOutboxRow;
}

function requireTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('timestamp fixture inválido');
  }
  return timestamp;
}

/**
 * Digest técnico do conjunto ordenado. Não é exibido nenhum ID; o digest serve
 * apenas para comparar a leitura final com a leitura imediatamente antes do
 * seed, inclusive quando a cardinalidade permanece igual.
 */
function digestMessageSet(messageIds: readonly string[]): string {
  const canonical = JSON.stringify([...new Set(messageIds)].sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Deriva a interseção conforme o SQL do runbook.
 *
 * Equivalente semântico:
 *   p = processed_messages filtrado por phone_number_id/conversation_key
 *   o = inbound_event_outbox filtrado pelos mesmos campos e
 *       received_at < T_HOLD
 *   j = p JOIN o ON o.message_id = p.message_id
 *
 * As linhas sem par, as linhas na fronteira e as linhas pós-hold ficam fora do
 * conjunto. Conteúdo/entrega/terminal não são filtros de derivação: são
 * validados pela cerca fail-closed abaixo, para não transformar instabilidade
 * em exclusão silenciosa.
 */
export function deriveSeedCandidateSet(
  input: SeedSelectionInput
): SeedCandidateSet {
  const holdAtMs = requireTimestamp(input.holdAt);
  const processed = input.processedMessages.filter(
    (row) =>
      row.phoneNumberId === input.phoneNumberId &&
      row.conversationKey === input.conversationKey
  );
  const outbox = input.inboundEventOutbox.filter(
    (row) =>
      row.phoneNumberId === input.phoneNumberId &&
      row.conversationKey === input.conversationKey &&
      requireTimestamp(row.receivedAt) < holdAtMs
  );

  // As tabelas reais têm PK em message_id. O nested join mantém a semântica
  // relacional explícita e deixa qualquer violação de unicidade visível nos
  // contadores, em vez de esconder uma linha inválida numa Map.
  const joined: JoinedRow[] = [];
  for (const processedRow of processed) {
    for (const outboxRow of outbox) {
      if (outboxRow.messageId === processedRow.messageId) {
        joined.push({ processed: processedRow, outbox: outboxRow });
      }
    }
  }

  const messageIds = [...new Set(joined.map((row) => row.processed.messageId))].sort();
  const keyMismatchRows = joined.filter(
    ({ processed: processedRow, outbox: outboxRow }) =>
      processedRow.phoneNumberId !== outboxRow.phoneNumberId ||
      processedRow.conversationKey !== outboxRow.conversationKey
  ).length;
  const unstableRows = joined.filter(
    ({ outbox: outboxRow }) =>
      outboxRow.contentStatus === 'pending' ||
      outboxRow.deliveredAt === null ||
      outboxRow.terminalAt !== null
  ).length;
  const stableRows = joined.filter(
    ({ outbox: outboxRow }) =>
      outboxRow.contentStatus !== 'pending' &&
      outboxRow.deliveredAt !== null &&
      outboxRow.terminalAt === null
  ).length;

  return {
    messageIds,
    count: messageIds.length,
    digest: digestMessageSet(messageIds),
    processedSourceRows: processed.length,
    outboxSourceRows: outbox.length,
    intersectionRows: joined.length,
    keyMismatchRows,
    unstableRows,
    stableRows,
  };
}

/**
 * Aplica a cerca de seed depois da derivação.
 *
 * Sem par (ou sem qualquer candidato após o corte) é EXCLUI: a interseção não
 * autoriza ampliar a seleção por outra tabela. Já uma linha pareada, porém
 * pendente, não é descartada — ABORTA, pois o estado precisa ser reconciliado.
 */
export function validateSeedCandidateSet(
  finalRead: SeedCandidateSet,
  seedRead: SeedCandidateSet = finalRead
): SeedValidation {
  if (
    finalRead.count !== seedRead.count ||
    finalRead.digest !== seedRead.digest
  ) {
    return { decision: 'ABORTA', reason: 'candidate_set_changed' };
  }
  if (finalRead.keyMismatchRows > 0) {
    return { decision: 'ABORTA', reason: 'key_mismatch' };
  }
  if (finalRead.unstableRows > 0) {
    return { decision: 'ABORTA', reason: 'unstable_outbox' };
  }
  if (finalRead.count === 0) {
    return { decision: 'EXCLUI', reason: 'candidate_set_empty' };
  }
  return { decision: 'INCLUI', reason: 'candidate_set_stable' };
}

interface MatrixCase {
  name: string;
  expected: Decision;
  finalInput: SeedSelectionInput;
  seedInput?: SeedSelectionInput;
}

interface MatrixResult {
  name: string;
  expected: Decision;
  actual: Decision;
  count: number;
  digest: string;
  reason: SeedValidation['reason'];
}

const PHONE_NUMBER_ID = 'seed-selection-phone-fixture';
const CONVERSATION_KEY = `${PHONE_NUMBER_ID}:seed-selection-customer-fixture`;
const T_HOLD = '2026-08-30T12:00:00.000Z';
const BEFORE_HOLD = '2026-08-30T11:59:59.000Z';
const AT_HOLD = T_HOLD;
const AFTER_HOLD = '2026-08-30T12:00:01.000Z';
const PROCESSED_AFTER_HOLD = '2026-08-30T12:30:00.000Z';
const DELIVERED_AT = '2026-08-30T12:31:00.000Z';

function processedMessage(
  messageId: string,
  processedAt = '2026-08-30T11:00:00.000Z'
): ProcessedMessageRow {
  return {
    messageId,
    phoneNumberId: PHONE_NUMBER_ID,
    conversationKey: CONVERSATION_KEY,
    processedAt,
  };
}

function inboundOutbox(
  messageId: string,
  overrides: Partial<InboundOutboxRow> = {}
): InboundOutboxRow {
  return {
    messageId,
    phoneNumberId: PHONE_NUMBER_ID,
    conversationKey: CONVERSATION_KEY,
    receivedAt: BEFORE_HOLD,
    contentStatus: 'final',
    deliveredAt: DELIVERED_AT,
    terminalAt: null,
    ...overrides,
  };
}

function selectionInput(
  processedMessages: readonly ProcessedMessageRow[],
  inboundEventOutbox: readonly InboundOutboxRow[]
): SeedSelectionInput {
  return {
    processedMessages,
    inboundEventOutbox,
    phoneNumberId: PHONE_NUMBER_ID,
    conversationKey: CONVERSATION_KEY,
    holdAt: T_HOLD,
  };
}

function buildMatrixCases(): readonly MatrixCase[] {
  return [
    {
      name: 'processed + outbox estável pre-hold',
      expected: 'INCLUI',
      finalInput: selectionInput(
        [processedMessage('fixture-stable')],
        [inboundOutbox('fixture-stable')]
      ),
    },
    {
      name: 'processed sem outbox',
      expected: 'EXCLUI',
      finalInput: selectionInput(
        [processedMessage('fixture-processed-only')],
        []
      ),
    },
    {
      name: 'outbox sem processed',
      expected: 'EXCLUI',
      finalInput: selectionInput(
        [],
        [inboundOutbox('fixture-outbox-only')]
      ),
    },
    {
      name: 'received_at = T_HOLD (fronteira)',
      expected: 'EXCLUI',
      finalInput: selectionInput(
        [processedMessage('fixture-at-hold')],
        [inboundOutbox('fixture-at-hold', { receivedAt: AT_HOLD })]
      ),
    },
    {
      name: 'received_at > T_HOLD',
      expected: 'EXCLUI',
      finalInput: selectionInput(
        [processedMessage('fixture-after-hold')],
        [inboundOutbox('fixture-after-hold', { receivedAt: AFTER_HOLD })]
      ),
    },
    {
      name: 'recebido pre-hold, processado pos-hold',
      expected: 'INCLUI',
      finalInput: selectionInput(
        [processedMessage('fixture-processed-after-hold', PROCESSED_AFTER_HOLD)],
        [inboundOutbox('fixture-processed-after-hold')]
      ),
    },
    {
      name: 'content_status = pending',
      expected: 'ABORTA',
      finalInput: selectionInput(
        [processedMessage('fixture-content-pending')],
        [inboundOutbox('fixture-content-pending', { contentStatus: 'pending' })]
      ),
    },
    {
      name: 'delivered_at IS NULL',
      expected: 'ABORTA',
      finalInput: selectionInput(
        [processedMessage('fixture-delivery-null')],
        [inboundOutbox('fixture-delivery-null', { deliveredAt: null })]
      ),
    },
    {
      name: 'terminal_at IS NOT NULL',
      expected: 'ABORTA',
      finalInput: selectionInput(
        [processedMessage('fixture-terminal')],
        [inboundOutbox('fixture-terminal', {
          terminalAt: '2026-08-30T11:59:00.000Z',
        })]
      ),
    },
    {
      name: 'conjunto muda entre leitura final e seed',
      expected: 'ABORTA',
      finalInput: selectionInput(
        [processedMessage('fixture-final-read')],
        [inboundOutbox('fixture-final-read')]
      ),
      seedInput: selectionInput(
        [
          processedMessage('fixture-final-read'),
          processedMessage('fixture-added-before-seed'),
        ],
        [
          inboundOutbox('fixture-final-read'),
          inboundOutbox('fixture-added-before-seed'),
        ]
      ),
    },
  ];
}

function evaluateCase(testCase: MatrixCase): MatrixResult {
  const finalRead = deriveSeedCandidateSet(testCase.finalInput);
  const seedRead = deriveSeedCandidateSet(testCase.seedInput ?? testCase.finalInput);
  const validation = validateSeedCandidateSet(finalRead, seedRead);
  return {
    name: testCase.name,
    expected: testCase.expected,
    actual: validation.decision,
    count: finalRead.count,
    digest: finalRead.digest,
    reason: validation.reason,
  };
}

function verifyStabilityChecks(): void {
  const finalRead = deriveSeedCandidateSet(
    selectionInput(
      [processedMessage('fixture-stability-a')],
      [inboundOutbox('fixture-stability-a')]
    )
  );
  const sameCardinalityDifferentDigest = deriveSeedCandidateSet(
    selectionInput(
      [processedMessage('fixture-stability-b')],
      [inboundOutbox('fixture-stability-b')]
    )
  );
  const differentCardinality = deriveSeedCandidateSet(
    selectionInput(
      [
        processedMessage('fixture-stability-a'),
        processedMessage('fixture-stability-b'),
      ],
      [
        inboundOutbox('fixture-stability-a'),
        inboundOutbox('fixture-stability-b'),
      ]
    )
  );

  if (
    validateSeedCandidateSet(finalRead, sameCardinalityDifferentDigest).decision !==
    'ABORTA'
  ) {
    throw new Error('digest de estabilidade não protege conjunto de mesma cardinalidade');
  }
  if (
    validateSeedCandidateSet(finalRead, differentCardinality).decision !== 'ABORTA'
  ) {
    throw new Error('cardinalidade de estabilidade não protege conjunto alterado');
  }
}

function printMatrix(results: readonly MatrixResult[]): void {
  console.log('gate ana lab seed selection: matriz sanitizada');
  for (const result of results) {
    console.log(
      [
        `case=${result.name}`,
        `expected=${result.expected}`,
        `actual=${result.actual}`,
        `count=${result.count}`,
        `digest=${result.digest}`,
        `reason=${result.reason}`,
      ].join(' | ')
    );
  }
}

function main(): void {
  const results = buildMatrixCases().map(evaluateCase);
  printMatrix(results);
  verifyStabilityChecks();

  const mismatches = results.filter(
    (result) => result.expected !== result.actual
  );
  if (mismatches.length > 0) {
    throw new Error('matriz de seleção divergiu');
  }
  console.log('gate ana lab seed selection: OK (somente memória; sem DB/rede/env)');
}

try {
  main();
} catch {
  // Nunca revelar IDs, conteúdo, DSN ou qualquer detalhe de fixture em falha.
  console.error('gate ana lab seed selection: FAILED');
  process.exitCode = 1;
}
