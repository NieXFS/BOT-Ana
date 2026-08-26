/**
 * Probe opt-in do provider real para IA-25d.
 *
 * Este arquivo usa o prompt, parser, adapter e resolver de produção. Não
 * imprime chave, resposta, lote, catálogo, telefone ou conteúdo de provider;
 * a saída é somente distribuição agregada, razões fechadas e shape redacted.
 *
 * Uso:
 *   ANA_SEMANTIC_PROBE=1 npx ts-node -T scripts/probe-semantic-provider-real.ts --runs 1 --variante composite-v5
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServiceSummary, ServicesResult } from '../src/services/calendarService';
import type { TurnFrameV2 } from '../src/services/conversationalV2/contracts';
import {
  clearSemanticServiceResolverCache,
  deriveSemanticCompositeAuthorityV2,
  resolveSemanticService,
  SEMANTIC_SERVICE_PARSER_REJECTION_REASONS_V2,
  SEMANTIC_SERVICE_RESOLVER_MAX_TOKENS,
} from '../src/services/conversationalV2/semanticServiceResolver';
import { COMPOSITE_FENCE_REASONS_V2 } from '../src/services/conversationalV2/compositeFence';
import { resolveServiceFromCatalog } from '../src/services/conversationalV2/serviceResolver';
import {
  deriveSemanticServiceInvocationV2,
  planServiceContextV2,
} from '../src/services/conversationalV2/serviceContext';
import { resolveCurrentInboundDateV2 } from '../src/services/conversationalV2/currentDateResolution';
import { newFlowStateV2 } from '../src/services/conversationalV2/flowSession';

if (process.env.ANA_SEMANTIC_PROBE !== '1') {
  console.error('probe opt-in: use ANA_SEMANTIC_PROBE=1');
  process.exit(2);
}

const RUNS = parsePositiveIntegerArg('--runs', 1);
const VARIANT = readStringArg('--variante') ?? 'composite-v5';
if (VARIANT !== 'composite-v5') {
  throw new Error('A probe produtiva aceita somente a variante composite-v5.');
}

function parsePositiveIntegerArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${flag} deve ser um inteiro entre 1 e 100.`);
  }
  return value;
}

function readStringArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function readDeepSeekKey(): string {
  const fromProcess = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromProcess && !fromProcess.startsWith('sk-deepseek-smoke')) {
    return fromProcess;
  }
  const envPath =
    process.env.ANA_SEMANTIC_PROBE_ENV_FILE ?? '/Users/niexfs/dev/Receps-IA/.env';
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^DEEPSEEK_API_KEY=(.*)$/u.exec(line.trim());
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/gu, '');
    if (value && !value.startsWith('sk-deepseek-smoke')) return value;
  }
  throw new Error('DEEPSEEK_API_KEY não encontrada para o probe opt-in.');
}

process.env.DEEPSEEK_API_KEY = readDeepSeekKey();
process.env.NODE_ENV = 'test';

const COMBO_ID = '11111111-1111-4111-8111-111111111111';
const MANICURE_ID = '22222222-2222-4222-8222-222222222222';
const PEDICURE_ID = '33333333-3333-4333-8333-333333333333';

function service(id: string, name: string): ServiceSummary {
  return {
    id,
    name,
    durationMinutes: 30,
    price: null,
    priceFormatted: null,
    aliases: [],
  };
}

const catalog: ServicesResult = {
  success: true,
  services: [
    service(MANICURE_ID, 'Manicure'),
    service(COMBO_ID, 'Manicure e pedicure'),
    service(PEDICURE_ID, 'Pedicure'),
    service('probe-manicure-tradicional', 'Manicure tradicional'),
    service('probe-pedicure-tradicional', 'Pedicure tradicional'),
    service('probe-reposicao', 'Reposição de unha'),
    service('probe-unha-infantil', 'Unha infantil'),
    ...Array.from({ length: 100 }, (_, index) =>
      service(
        `probe-filler-${String(index + 1).padStart(3, '0')}`,
        `Serviço de laboratório ${index + 1}`
      )
    ),
  ],
};

assert.equal(catalog.services?.length, 107);

const config = {
  tenantSlug: 'ia25d-probe',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.2,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'probe-no-whatsapp',
  waApiVersion: 'v21.0',
  phoneNumberId: 'probe-no-phone',
  isActive: true,
} as TenantBotConfig;

type ProbeCase = {
  name: string;
  text: string;
  plannerTexts?: readonly string[];
};

const cases: readonly ProbeCase[] = [
  {
    name: 'campo',
    text: 'Tem horário hoje após as 17:30? ou amanhã de manhã pra fazer a unha? pé e mão',
    plannerTexts: [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ],
  },
  { name: 'natural', text: 'gostaria de fazer as unhas dos pés e das mãos' },
  {
    name: 'lote-ordenado',
    text: 'Tem horário hoje após as 17:30? ou amanhã de manhã pra fazer a unha? pé e mão',
    plannerTexts: [
      'Tem horário hoje após as 17:30?',
      'ou amanhã de manhã pra fazer a unha?',
      'pé e mão',
    ],
  },
  { name: 'unha', text: 'quero fazer a unha' },
  { name: 'disjuntivo', text: 'manicure ou pedicure' },
  { name: 'negado', text: 'não quero pé e mão' },
  { name: 'correcao', text: 'não, quero pé e mão' },
  { name: 'so-manicure', text: 'quero só manicure' },
  { name: 'so-pe', text: 'quero só o pé' },
];

const PROBE_PLANNER_NOW = new Date('2026-08-24T15:00:00.000Z');

function invocationPolicyFromProductionPlanner(testCase: ProbeCase) {
  const plannerTexts = testCase.plannerTexts ?? [testCase.text];
  const inboundIds = plannerTexts.map(
    (_text, index) => `probe-${testCase.name}-in-${index + 1}`
  );
  const inboundTextsById = Object.fromEntries(
    inboundIds.map((inboundId, index) => [inboundId, plannerTexts[index] ?? ''])
  );
  const plannerBatch = plannerTexts.join(' ');
  const frame: TurnFrameV2 = {
    schemaVersion: 2,
    turnId: `probe-${testCase.name}-planner-turn`,
    inputSequence: 1,
    catalogSnapshotHash: 'probe-catalog',
    catalogState: 'available',
    humanControl: 'NO_ACTIVE_TAKEOVER',
    currentInboundIds: inboundIds,
    pending: null,
    flowState: newFlowStateV2(
      `probe-${testCase.name}-planner-flow`,
      PROBE_PLANNER_NOW
    ),
  };
  const plan = planServiceContextV2({
    enabled: true,
    serviceResolverEnabled: true,
    frame,
    inboundText: plannerBatch,
    inboundMessages: inboundIds.map((inboundId, index) => ({
      inboundId,
      text: plannerTexts[index] ?? '',
    })),
    catalog,
    now: PROBE_PLANNER_NOW,
    dateResolution: resolveCurrentInboundDateV2({
      currentInboundIds: inboundIds,
      inboundTextsById,
      now: PROBE_PLANNER_NOW,
      timezone: config.timezone,
    }),
    timezone: config.timezone,
    turnId: frame.turnId,
    inputSequence: frame.inputSequence,
  });

  // This is only the fallback receipt input required by the production port.
  // Candidate IDs come from `plan` inside deriveSemanticServiceInvocationV2;
  // they must never be copied from this deterministic result.
  const deterministicResult = resolveServiceFromCatalog({
    text: testCase.text,
    catalog,
  });
  return deriveSemanticServiceInvocationV2({
    enabled: true,
    plan,
    catalog,
    deterministicResult,
  });
}

const STATUS_OUTPUT_ORDER = [
  'resolved_combo',
  'resolved_other',
  'ambiguous',
  'none',
  'invalid_response',
  'rejected_evidence',
  'composite_fence_rejected',
  'provider_truncated',
  'protocol_failure',
  'provider_error',
] as const;

const SHAPE_DIAGNOSTIC_STATUSES = new Set([
  'invalid_response',
  'rejected_evidence',
  'composite_fence_rejected',
  'provider_truncated',
  'protocol_failure',
  'provider_error',
]);

function outcomeBucket(
  outcome: Awaited<ReturnType<typeof resolveSemanticService>>
): string {
  if (outcome.decision?.decision === 'resolved') {
    if (outcome.decision.serviceId === COMBO_ID) return 'resolved_combo';
    return 'resolved_other';
  }
  if (outcome.decision?.decision === 'ambiguous') return 'ambiguous';
  if (outcome.decision?.decision === 'none') return 'none';
  return outcome.receipt.status;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function shapeOccurrenceKey(
  outcome: Awaited<ReturnType<typeof resolveSemanticService>>
): string {
  const shape = outcome.shape;
  return [
    `status=${outcome.receipt.status}`,
    `decision=${shape.decision}`,
    `resolutionBasis=${shape.resolutionBasis}`,
    `modelCandidateCount=${shape.candidateCount}`,
    `componentCount=${shape.componentCount}`,
    `evidenceEmpty=${shape.evidenceEmpty}`,
    `serviceInsideFence=${shape.serviceInsideFence}`,
  ].join(' ');
}

function activeCatalogIds(catalogSnapshot: ServicesResult): Set<string> {
  return new Set(
    (catalogSnapshot.services ?? [])
      .filter((service) => {
        const raw = service as ServiceSummary & {
          active?: unknown;
          isActive?: unknown;
        };
        return raw.active !== false && raw.isActive !== false;
      })
      .map((service) => service.id)
  );
}

function topologyOccurrenceKey(input: {
  policyMode: string;
  policyCandidateCount: number;
  requestCatalogCount: number;
  compositeAuthoritySource: string | null;
  compositeAuthorityCount: number;
  deterministicKind: string;
  deterministicReason: string | null;
}): string {
  return [
    `policyMode=${input.policyMode}`,
    `policyCandidateCount=${input.policyCandidateCount}`,
    `requestCatalogCount=${input.requestCatalogCount}`,
    `compositeAuthoritySource=${input.compositeAuthoritySource ?? 'null'}`,
    `compositeAuthorityCount=${input.compositeAuthorityCount}`,
    `deterministicKind=${input.deterministicKind}`,
    `deterministicReason=${input.deterministicReason ?? 'null'}`,
  ].join(' ');
}

function printCountSection(
  title: string,
  counts: ReadonlyMap<string, number>,
  keys: readonly string[] = []
): void {
  console.log(`${title}:`);
  const entries = keys.length > 0
    ? keys.map((key) => [key, counts.get(key) ?? 0] as const)
    : [...counts.entries()];
  if (entries.length === 0) {
    console.log('  none=0');
    return;
  }
  for (const [key, count] of entries) {
    console.log(`  ${key}=${count}`);
  }
}

function printCaseSummary(input: {
  name: string;
  statusCounts: ReadonlyMap<string, number>;
  rejectionReasons: ReadonlyMap<string, number>;
  fenceReasons: ReadonlyMap<string, number>;
  shapeOccurrences: ReadonlyMap<string, number>;
  topologyOccurrences: ReadonlyMap<string, number>;
}): void {
  console.log(`case=${input.name}`);
  for (const status of STATUS_OUTPUT_ORDER) {
    console.log(`${status}=${input.statusCounts.get(status) ?? 0}`);
  }
  console.log('');
  const observedRejectionReasons =
    SEMANTIC_SERVICE_PARSER_REJECTION_REASONS_V2.filter((reason) =>
      input.rejectionReasons.has(reason)
    );
  printCountSection(
    'rejection_reasons',
    input.rejectionReasons,
    observedRejectionReasons
  );
  console.log('');
  printCountSection(
    'fence_reasons',
    input.fenceReasons,
    COMPOSITE_FENCE_REASONS_V2
  );
  console.log('');
  console.log('shape_occurrences:');
  if (input.shapeOccurrences.size === 0) {
    console.log('  none=0');
  } else {
    for (const [shape, count] of input.shapeOccurrences.entries()) {
      console.log(`  ${shape} count=${count}`);
    }
  }
  console.log('');
  console.log('topology:');
  if (input.topologyOccurrences.size === 0) {
    console.log('  none=0');
  } else {
    for (const [topology, count] of input.topologyOccurrences.entries()) {
      console.log(`  ${topology} count=${count}`);
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  assert.equal(SEMANTIC_SERVICE_RESOLVER_MAX_TOKENS, 160);
  console.log('probe=ia25d-semantic-provider-real');
  console.log(`variant=${VARIANT}`);
  console.log(`runs_per_case=${RUNS}`);
  console.log('model=deepseek-v4-flash');
  console.log('max_tokens=160');
  console.log('cache=disabled-per-attempt');
  console.log('');

  for (const testCase of cases) {
    const statusCounts = new Map<string, number>();
    const rejectionReasons = new Map<string, number>();
    const fenceReasons = new Map<string, number>();
    const shapeOccurrences = new Map<string, number>();
    const topologyOccurrences = new Map<string, number>();
    for (let run = 0; run < RUNS; run += 1) {
      clearSemanticServiceResolverCache();
      const semanticInvocation = invocationPolicyFromProductionPlanner(testCase);
      const invocationMode = semanticInvocation.policy.mode;
      const policyCandidateCount =
        invocationMode === 'planner_authorized'
          ? semanticInvocation.policy.candidateServiceIds.length
          : 0;
      const deterministicResult = semanticInvocation.deterministicResult;
      const activeIds = activeCatalogIds(catalog);
      const compositeAuthority = deriveSemanticCompositeAuthorityV2({
        policy: semanticInvocation.policy,
        deterministicResult,
        catalog,
      });
      const requestCatalogCount =
        invocationMode === 'planner_authorized'
          ? semanticInvocation.policy.candidateServiceIds.filter((id) =>
              activeIds.has(id)
            ).length
          : activeIds.size;
      const deterministicReason =
        'reason' in deterministicResult ? deterministicResult.reason : null;
      increment(
        topologyOccurrences,
        topologyOccurrenceKey({
          policyMode: invocationMode,
          policyCandidateCount,
          requestCatalogCount,
          compositeAuthoritySource: compositeAuthority?.source ?? null,
          compositeAuthorityCount: compositeAuthority?.serviceIds.size ?? 0,
          deterministicKind: deterministicResult.kind,
          deterministicReason,
        })
      );
      const outcome = await resolveSemanticService({
        tenantSlug: config.tenantSlug,
        currentBatch: testCase.text,
        catalog,
        config,
        deterministicResult,
        invocationPolicy: semanticInvocation.policy,
        context: { flow: 'service_selection' },
      });
      increment(statusCounts, outcomeBucket(outcome));
      if (outcome.parseRejectionReason) {
        increment(rejectionReasons, outcome.parseRejectionReason);
      }
      if (outcome.compositeFenceReason) {
        increment(fenceReasons, outcome.compositeFenceReason);
      }
      if (SHAPE_DIAGNOSTIC_STATUSES.has(outcome.receipt.status)) {
        increment(shapeOccurrences, shapeOccurrenceKey(outcome));
      }
      assert.equal(outcome.receipt.providerCallCount <= 1, true);
      assert.equal(outcome.receipt.cacheHit, false);
      assert.equal(
        outcome.receipt.compositeAuthoritySource,
        compositeAuthority?.source ?? null
      );
      assert.equal(
        outcome.receipt.compositeAuthorityCount,
        compositeAuthority?.serviceIds.size ?? 0
      );
      assert.equal(
        outcome.receipt.attemptedInvocationReason,
        semanticInvocation.policy.attemptedInvocationReason
      );
    }
    printCaseSummary({
      name: testCase.name,
      statusCounts,
      rejectionReasons,
      fenceReasons,
      shapeOccurrences,
      topologyOccurrences,
    });
  }
}

void main().catch((error: unknown) => {
  console.error(
    `probe failed: ${error instanceof Error ? error.message : 'unknown error'}`
  );
  process.exitCode = 1;
});
