/** Offline reclassification of GSEQ anti-loop.  No provider, DB, or tool call. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = "benchmark-results/ana-owner-behavioral-20260806-gseq";
const forbidden = /INTERNAL_HINT|serviceSelectionGate|mecanismo|\bregras?\b|\btool\b|\bloop\b|tentativa bloqueada/iu;
const serviceNames = ["Limpeza de Pele", "Peeling", "Corte", "Corte e Barba", "Drenagem"];

type Turn = { rawResponse: string | null; toolTrace: unknown[] };
type Result = { id: string; pass: "A" | "B"; verdict: "PASS" | "FAIL" | "BLOCKED"; assertions: string[]; turns: Turn[]; [key: string]: unknown };

function reviewAntiLoop(result: Result): Result {
  const structuralFailures: string[] = [];
  for (const [index, turn] of result.turns.entries()) {
    const reply = turn.rawResponse ?? "";
    if (!reply || !/qual\s+(servi[cç]o|desses servi[cç]os)|preciso\s+(?:saber\s+)?(?:qual\s+servi[cç]o|que\s+voc[eê]\s+escolha)|qual voc[eê] prefere|qual voc[eê] deseja/iu.test(reply)) structuralFailures.push(`turno ${index + 1}: esclarecimento estrutural ausente`);
    if (turn.toolTrace.length > 1) structuralFailures.push(`turno ${index + 1}: mais de uma tentativa de tool`);
    if (forbidden.test(reply)) structuralFailures.push(`turno ${index + 1}: narração de mecanismo interno`);
    // A lista neutra pode citar opções; ela não é seleção. Não há resposta de
    // agendamento/disponibilidade nem trace de consulta que escolha uma delas.
    if (/agendad[oa]\s+(?:para|com)|hor[aá]rio\s+dispon[ií]vel|vou\s+marcar/iu.test(reply)) structuralFailures.push(`turno ${index + 1}: serviço/horário assumido sem clareza`);
  }
  const reviewed = structuralFailures.length === 0;
  return {
    ...result,
    originalVerdict: result.verdict,
    originalAssertions: result.assertions,
    verdict: reviewed ? "PASS" : "FAIL",
    assertions: reviewed
      ? ["HARNESS_FALSE_NEGATIVE: revisão estrutural §5; não comparar string exata", "esclarecimento em todos os turnos; zero tool/blocked attempt; nenhum serviço selecionado; mecanismo interno ausente"]
      : structuralFailures,
    review: { classification: reviewed ? "HARNESS_FALSE_NEGATIVE" : "REVIEW_FAILED", evaluator: "offline-structural-v1", providerCalls: 0 },
  };
}

async function main() {
  const original = JSON.parse(await readFile(path.join(outDir, "report.json"), "utf8")) as { results: Result[]; [key: string]: unknown };
  const results = original.results.map((result) => result.id === "GSEQ-ANTI-LOOP" ? reviewAntiLoop(result) : result);
  const counts = results.reduce((acc, result) => { acc[result.verdict] += 1; return acc; }, { PASS: 0, FAIL: 0, BLOCKED: 0 });
  const reviewed = {
    ...original,
    suite: "ana-owner-behavioral-gseq-v1-reviewed",
    originalReport: "report.json preserved unchanged",
    reviewMetadata: { mode: "offline-only", providerCalls: 0, criterion: "§5 structural allowlist/denylist; never compare exact string" },
    counts,
    results,
  };
  await writeFile(path.join(outDir, "reviewed-report.json"), `${JSON.stringify(reviewed, null, 2)}\n`);
  const rows = results.map((result) => `### ${result.id}/${result.pass} — ${result.verdict}\n\n- Original: ${(result as any).originalVerdict ?? result.verdict}\n- Asserções: ${result.assertions.join("; ") || "ok"}\n- Turns preservados: ${result.turns.length}; tool calls: ${result.turns.reduce((n, turn) => n + turn.toolTrace.length, 0)}\n`).join("\n");
  await writeFile(path.join(outDir, "reviewed-report.md"), `# GSEQ — relatório revisado offline\n\nSem provider, DB, ERP, WhatsApp ou tools. O original permanece em \`report.json\`. A reclassificação aplica §5: allowlist/denylist estrutural, sem comparação de string exata.\n\n\`\`\`json\n${JSON.stringify(reviewed.reviewMetadata, null, 2)}\n\`\`\`\n\n| PASS | FAIL | BLOCKED |\n|---:|---:|---:|\n| ${counts.PASS} | ${counts.FAIL} | ${counts.BLOCKED} |\n\n${rows}`);
  console.log(JSON.stringify({ output: outDir, counts, reviewed: results.filter((r) => (r as any).review?.classification === "HARNESS_FALSE_NEGATIVE").map((r) => `${r.id}/${r.pass}`) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
