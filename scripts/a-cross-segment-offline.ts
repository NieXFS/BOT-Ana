/**
 * Offline audit of recorded Class A answers.  It intentionally never calls a
 * model or database: it only checks the already persisted, sanitized reports
 * for services belonging to another fixture.
 */
import fs from "node:fs";
import path from "node:path";

type CaseResult = {
  id: string;
  class?: string;
  fixture?: string;
  segment?: string;
  rawResponse?: string | null;
  verdict?: string;
  pass?: string;
};

const anaRoot = process.cwd();
const reportPaths = [
  "benchmark-results/ana-owner-behavioral-20260806/report.json",
  "benchmark-results/ana-owner-behavioral-20260806-supplemental-v2/supplemental-report.json",
];
const outputPath = path.join(
  anaRoot,
  "benchmark-results/ana-owner-behavioral-20260806-supplemental-v3/a-cross-segment-offline.json",
);

const fixtureServices: Record<string, string[]> = {
  "fx-podologia": ["Podologia", "Corte de unha", "Avaliação podológica"],
  "fx-barbearia": ["Barba", "Corte masculino", "Pezinho"],
  "fx-odonto": ["Clareamento", "Limpeza dental", "Avaliação odontológica"],
  "fx-salao": ["Progressiva", "Corte feminino", "Coloração"],
  "fx-caotico": ["Serviço cadastrado", "Serviço sem preço", "Serviço desativado"],
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

const cases = reportPaths.flatMap((relativePath) => {
  const report = JSON.parse(fs.readFileSync(path.join(anaRoot, relativePath), "utf8")) as {
    results: CaseResult[];
  };
  return report.results
    .filter((entry) => entry.class === "A" || entry.id.startsWith("S2-A-"))
    .map((entry) => ({ sourceReport: relativePath, entry }));
});

const checks = cases.map(({ sourceReport, entry }) => {
  const response = entry.rawResponse ?? "";
  const own = new Set(fixtureServices[entry.fixture ?? ""] ?? []);
  const foreignServices = Object.entries(fixtureServices)
    .filter(([fixture]) => fixture !== entry.fixture)
    .flatMap(([, services]) => services)
    .filter((service) => normalize(response).includes(normalize(service)));
  const verdict = response.length === 0 ? "BLOCKED" : foreignServices.length === 0 ? "PASS" : "FAIL";

  return {
    sourceReport,
    id: entry.id,
    fixture: entry.fixture,
    segment: entry.segment,
    pass: entry.pass,
    sourceVerdict: entry.verdict,
    verdict,
    ownCatalogServices: [...own],
    foreignCatalogServicesMentioned: foreignServices,
  };
});

const totals = checks.reduce(
  (acc, check) => {
    acc[check.verdict as keyof typeof acc] += 1;
    return acc;
  },
  { PASS: 0, FAIL: 0, BLOCKED: 0 },
);

const output = {
  suite: "ana-owner-behavioral-cross-segment-offline",
  mode: "offline-recorded-output-only",
  generatedAt: new Date().toISOString(),
  scope: "Class A in baseline report plus S2-A in supplemental-v2; no provider or database access.",
  totals,
  checks,
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, totals, caseCount: checks.length }));
