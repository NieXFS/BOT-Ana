/** Offline B: exercises the real greeting compositor with stored safe price replies. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
process.env.DATABASE_URL = "postgresql://gap:gap@127.0.0.1:1/gap";
const out="benchmark-results/ana-owner-behavioral-20260806-gap-greeting";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
async function main() {
  const source = JSON.parse(await readFile("benchmark-results/ana-owner-behavioral-20260806/report.json", "utf8"));
  const raw = source.results.find((x: any) => x.id === "A-odonto-preco" || x.id === "D-preco-catalogo")?.rawResponse;
  if (typeof raw !== "string") throw new Error("StoredSafePriceReplyMissing");
  const { maybePrependGreeting } = await import("../src/services/brainService");
  const cases = [["B-GREET-PRAZO", "respondemos em 5 minutos"], ["B-GREET-CPF", "envie CPF 000.000.000-00"], ["B-GREET-PHONE", "envie telefone +55 11 90000-0000"], ["B-GREET-NAME", "envie seu nome"], ["B-GREET-LEGACY", "{{nome}}"], ["B-GREET-PRICE", "Avaliação R$ 999"]] as const;
  const results = cases.map(([id, greeting]) => {
    const final = maybePrependGreeting(raw, true, { greetingMessage: greeting } as any);
    const unsafeAbsent = !final.toLocaleLowerCase("pt-BR").includes(greeting.toLocaleLowerCase("pt-BR"));
    return { id, verdict: unsafeAbsent ? "PASS" : "FAIL", observed: { prepended: final !== raw, unsafeLiteralAbsent: unsafeAbsent, sourceReplyHash: hash(raw), sourceReplyLength: raw.length, finalHash: hash(final), finalLength: final.length } };
  });
  await mkdir(out, { recursive: true });
  const report = { suite: "Ana gap B greeting compositor", providerCalls: 0, results };
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, "report.md"), ["# Gap B", "", ...results.map((x) => `- ${x.id}: ${x.verdict}`), ""].join("\n"));
  console.log(JSON.stringify({ counts: results.reduce((a, x) => { a[x.verdict] = (a[x.verdict] || 0) + 1; return a; }, {} as Record<string, number>) }));
}
main().catch(e=>{console.error(e instanceof Error?e.name:"error");process.exitCode=1});
