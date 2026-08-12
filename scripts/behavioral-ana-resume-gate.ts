import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TenantBotConfig } from '../src/configProvider';
import { ANA_RESUME_BEHAVIOR_CASES } from './fixtures/ana-resume-gate-cases';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgres://blocked:blocked@127.0.0.1:1/blocked';

function repetitions(): number {
  const arg = process.argv.find((value) => value.startsWith('--repeat='));
  const parsed = Number(arg?.split('=')[1] ?? '1');
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 20 ? parsed : 1;
}

function selectedCaseIds(): Set<string> | null {
  const arg = process.argv.find((value) => value.startsWith('--ids='));
  if (!arg) return null;
  const ids = arg
    .slice('--ids='.length)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

const config: TenantBotConfig = {
  tenantSlug: 'fixture-resume-gate',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt: 'fixture',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'blocked',
  waApiVersion: 'v21.0',
  phoneNumberId: 'fixture',
  isActive: true,
};

async function main() {
  const { classifyAnaResume } = await import('../src/services/anaResumeClassifier');
  const repeat = repetitions();
  const selectedIds = selectedCaseIds();
  const cases = selectedIds
    ? ANA_RESUME_BEHAVIOR_CASES.filter((item) => selectedIds.has(item.id))
    : ANA_RESUME_BEHAVIOR_CASES;
  const results = [];

  for (let pass = 1; pass <= repeat; pass += 1) {
    for (const item of cases) {
      const classification = await classifyAnaResume({
        history: item.history,
        config,
      });
      const expectedAction =
        item.expected === 'RESUME_ANA' ? 'PROCEED' : 'KEEP_SILENT';
      const actualAction =
        classification.decision === 'RESUME_ANA' ? 'PROCEED' : 'KEEP_SILENT';
      results.push({
        id: item.id,
        pass,
        description: item.description,
        expected: item.expected,
        actual: classification.decision,
        reasonCode: classification.reasonCode,
        latencyMs: classification.latencyMs,
        contextHash: classification.contextHash,
        rawOutput: classification.rawOutput ?? null,
        exactLabelMatch: classification.decision === item.expected,
        expectedAction,
        actualAction,
        passVerdict: expectedAction === actualAction,
      });
    }
  }

  const failures = results.filter((item) => !item.passVerdict);
  const report = {
    suite: 'ana-resume-gate-v1',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'enabled',
    tools: false,
    retries: 0,
    customerFacingOutput: false,
    database: 'blocked',
    erp: 'blocked',
    whatsapp: 'blocked',
    cases: cases.length,
    repetitions: repeat,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    exactLabelMismatches: results.filter((item) => !item.exactLabelMatch).length,
    results,
  };
  const outputDir = path.resolve('benchmark-results', 'ana-resume-gate');
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(outputDir, `${stamp}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report, results: undefined }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'behavioral suite failed');
  process.exit(1);
});
