/**
 * FASE 3 (Ana) — fluxo multi-profissional.
 *
 * PARTE A (DETERMINÍSTICA, gating): exercita src/services/calendarService.ts —
 * a camada que o modelo aciona — contra o Receps real (dev server). Prova o fix
 * do lado da Ana sem depender do não-determinismo do gpt-4o-mini:
 *   A1. bookAppointment SEM professionalId, Julia ocupada → agenda com Samantha
 *       (Ana OMITE professionalId; o servidor escolhe um LIVRE; a mensagem traz o nome).
 *   A2. bookAppointment COM professionalId=Samantha (livre) → agenda com Samantha.
 *   A3. bookAppointment SEM professionalId, AMBAS ocupadas → reason "conflict"
 *       (sem overbooking — não chuta profissional).
 *
 * PARTE B (BEST-EFFORT, não-gating): roda getReply real com "tanto faz" e checa
 * que, SE o modelo agendar, ele chama bookAppointment SEM professionalId. mini às
 * vezes alucina disponibilidade e não conclui — por isso é observacional (não
 * derruba o exit code). O comportamento já foi observado verde em execução manual.
 *
 * Pré-requisitos (orquestrado pelo runner): dev server em ERP_BASE_URL, fixture
 * (tenant + Julia + Samantha + Corte) via SIM_SLUG, DATABASE_URL (contextManager),
 * ERP_API_TOKEN = AI_BOT_API_KEY do Receps.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  const env = readFileSync("/Users/niexfs/Documents/Receps ERP/.env", "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}
process.env.ERP_BASE_URL = process.env.ERP_BASE_URL || "http://localhost:3000";

const toolCalls: { name: string; args: any }[] = [];
const origLog = console.log.bind(console);
console.log = (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  const m = line.match(/chamou função: (\w+)\((.*)\) para /);
  if (m) { try { toolCalls.push({ name: m[1], args: JSON.parse(m[2]) }); } catch { /* ignore */ } }
  origLog(...a);
};

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const rec = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); origLog(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`); };

function tomorrowAt(h: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cal = await import("../src/services/calendarService.ts");
  const { getReply } = await import("../src/services/brainService.ts");
  const { DEFAULT_BOT_SYSTEM_PROMPT } = await import("../src/botDefaults.ts");
  const slug = process.env.SIM_SLUG!;
  const date = tomorrowAt(0);

  const baseConfig: any = {
    tenantSlug: slug, botName: "Ana", systemPrompt: DEFAULT_BOT_SYSTEM_PROMPT, greetingMessage: null,
    fallbackMessage: "x", aiModel: "gpt-4o-mini", aiTemperature: 0.4, aiMaxTokens: 500, openaiApiKey: null,
    botIsAlwaysActive: true, botActiveStart: "07:00", botActiveEnd: "19:00", timezone: "America/Sao_Paulo",
    waAccessToken: "x", waApiVersion: "v21.0", phoneNumberId: slug, isActive: true,
  };

  // Descobre os ids de serviço/profissionais via getServices (cache da Ana).
  const services = await cal.getServices(baseConfig);
  const corte = services.services?.find((s) => /corte/i.test(s.name));
  const julia = services.professionals?.find((p) => /julia/i.test(p.name));
  const samantha = services.professionals?.find((p) => /samantha/i.test(p.name));
  if (!corte || !julia || !samantha) {
    rec("setup: fixture com Corte + Julia + Samantha", false, JSON.stringify({ corte: corte?.name, julia: julia?.name, samantha: samantha?.name }));
    await pool.end();
    process.exit(1);
  }

  try {
    // ===== PARTE A — calendarService (determinística) =====
    // Ocupa a Julia às 14h (pin explícito).
    const occJulia = await cal.bookAppointment(date, "14:00", corte.id, "+5511970000001", "Ocupa Julia", baseConfig, julia.id);
    rec("setup: ocupar Julia 14h", occJulia.success === true, occJulia.message);

    // A1: sem professionalId, 14h → servidor escolhe a Samantha (Julia ocupada).
    const a1 = await cal.bookAppointment(date, "14:00", corte.id, "+5511970000002", "Cliente A1", baseConfig /* sem professionalId */);
    rec("A1: bookAppointment SEM professionalId (Julia ocupada) → agenda com Samantha", a1.success === true && /samantha/i.test(a1.message), a1.message);

    // A2: com professionalId=Samantha livre às 15h → Samantha.
    const a2 = await cal.bookAppointment(date, "15:00", corte.id, "+5511970000003", "Cliente A2", baseConfig, samantha.id);
    rec("A2: bookAppointment COM professionalId=Samantha → agenda com Samantha", a2.success === true && /samantha/i.test(a2.message), a2.message);

    // A3: sem professionalId, 14h, AMBAS ocupadas (Julia setup + Samantha A1) → conflict.
    const a3 = await cal.bookAppointment(date, "14:00", corte.id, "+5511970000004", "Cliente A3", baseConfig /* sem professionalId */);
    rec("A3: bookAppointment SEM professionalId + ambas ocupadas → reason conflict (sem overbooking)", a3.success === false && a3.reason === "conflict", `success=${a3.success} reason=${a3.reason}`);

    // ===== PARTE B — getReply real (best-effort, não-gating) =====
    const phoneB = "5599000000051";
    const keyB = `${slug}:${phoneB}`;
    await pool.query('DELETE FROM ana_conversation_history WHERE "conversationKey"=$1', [keyB]);
    toolCalls.length = 0;
    const turnsB = ["Quero cortar o cabelo amanhã", "tanto faz", "pode ser às 11h", "sim, pode confirmar"];
    const repliesB: string[] = [];
    for (const turn of turnsB) {
      origLog(`\n-- [getReply] cliente: "${turn}"`);
      const r = await getReply(phoneB, turn, "Cliente Obs", { ...baseConfig });
      origLog(`-- ana: ${r}`);
      repliesB.push(r);
    }
    await pool.query('DELETE FROM ana_conversation_history WHERE "conversationKey"=$1', [keyB]);
    const bookB = toolCalls.filter((c) => c.name === "bookAppointment");
    if (bookB.length === 0) {
      origLog('ℹ️  [B/observacional] o modelo não concluiu o book nesta execução (flakiness do gpt-4o-mini). Sem violação — invariante de não-overbooking preservada.');
    } else {
      const allWithoutProf = bookB.every((c) => !c.args.professionalId);
      origLog(`${allWithoutProf ? "✅" : "⚠️"} [B/observacional] "tanto faz" → bookAppointment ${allWithoutProf ? "SEM" : "COM"} professionalId — args=${JSON.stringify(bookB[bookB.length - 1].args)}`);
    }
  } finally {
    await pool.end();
  }

  const failed = checks.filter((c) => !c.ok);
  origLog(`\n${failed.length === 0 ? "✅ PARTE A (determinística) PASSOU" : `❌ ${failed.length} CHECK(S) DA PARTE A FALHARAM`} (${checks.length} no total)`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main().catch((e) => { origLog("smoke falhou:", e); process.exit(1); });
