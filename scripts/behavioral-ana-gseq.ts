/**
 * Last isolated behavioural execution: two stateful G scenarios only.
 * The production receptionist loop and DeepSeek Flash are real; calendar tools
 * are in-memory only and reject every write.  No DB, ERP, or WhatsApp is used.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://gseq:gseq@127.0.0.1:1/gseq";
process.env.ANA_DIRECT_DATABASE_URL = "postgresql://gseq:gseq@127.0.0.1:1/gseq";
process.env.ERP_BASE_URL = "http://127.0.0.1:1";
process.env.RECEPS_INTERNAL_API_URL = "http://127.0.0.1:1";
process.env.ERP_API_TOKEN = "gseq-no-erp";

const OUT_DIR = "benchmark-results/ana-owner-behavioral-20260806-gseq";
const NOW = new Date("2026-08-06T15:00:00.000Z");
const FORBIDDEN_ANTI_LOOP = /INTERNAL_HINT|serviceSelectionGate|mecanismo|\bregras?\b|\btool\b|\bloop\b|tentativa bloqueada/iu;
const SYNTHETIC_PHONE = "+55 11 90000-0000";
const SYNTHETIC_CPF = "000.000.000-00";

type Trace = { name: string; args: Record<string, unknown>; argumentsValidJson: boolean; result: string };
type Turn = { customerMessage: string; rawResponse: string | null; toolTrace: Trace[]; providerModels: string[]; exhausted: boolean };
type Result = { id: string; pass: "A" | "B"; verdict: "PASS" | "FAIL" | "BLOCKED"; assertions: string[]; turns: Turn[]; promptOnFailure?: string };

function redact(value: string): string {
  return value
    .replaceAll(SYNTHETIC_PHONE, "[TELEFONE_SINTETICO_REDACTED]")
    .replaceAll(SYNTHETIC_CPF, "[CPF_SINTETICO_REDACTED]")
    .replace(/\+?55[\s().-]*\d{2}[\s).-]*9?\d{4,5}[\s.-]*\d{4}\b/g, "[TELEFONE_REDACTED]")
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[CPF_REDACTED]")
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, "[INVISIVEL]");
}
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

async function dependencies() {
  const brain = await import("../src/services/brainService");
  const provider = await import("../src/services/receptionistLlmProvider");
  const preferences = await import("../src/services/structuredPreferences");
  const gate = await import("../src/services/service-gate");
  const fixture = await import("./benchmarks/ana-models/fixtures");
  return { brain, provider, preferences, gate, fixture };
}

function config(structuredConfig: unknown): any {
  return {
    tenantSlug: "gseq-in-memory-only", botName: "Ana", botRole: "receptionist",
    systemPrompt: "Configuração de fixture sem autoridade sobre regras centrais.",
    greetingMessage: null, fallbackMessage: null, aiProvider: "deepseek", aiModel: "deepseek-v4-flash",
    aiTemperature: 0.4, aiMaxTokens: 450, openaiApiKey: null,
    botIsAlwaysActive: true, botActiveStart: "00:00", botActiveEnd: "23:59", timezone: "America/Sao_Paulo",
    waAccessToken: "fixture-only", waApiVersion: "v21.0", phoneNumberId: "fixture-gseq", isActive: true,
    structuredConfig,
    bookingMenu: [], postBookingInstructions: [],
  };
}

function toolResult(value: unknown): string { return JSON.stringify(value); }

async function runConversation(
  id: string,
  pass: "A" | "B",
  inputs: string[],
  scenario: "anti-loop" | "switch",
): Promise<Result> {
  const { brain, provider, preferences, gate, fixture } = await dependencies();
  const servicesResult: any = fixture.SERVICES_RESULT;
  const structured = preferences.normalizeStructuredPreferencesPayload({
    structuredConfigVersion: 7, tone: "ACOLHEDORA", treatment: "VOCE", emojiLevel: "DISCRETO",
    locationPolicy: "SO_CIDADE", paymentMethods: ["PIX", "CREDIT_CARD"], policies: [],
  });
  const currentConfig = config(structured);
  const prompt = brain.buildSystemPromptFromServices(currentConfig, servicesResult, NOW);
  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: prompt }];
  const userMessages: string[] = [];
  const turns: Turn[] = [];
  const orderedCalls: Array<{ turn: number; name: string; serviceId?: string; blocked: boolean }> = [];

  const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const serviceId = typeof args.serviceId === "string" ? args.serviceId : undefined;
    if (name === "getServices") return toolResult(servicesResult);
    if (name === "getAvailableSlots") {
      const selected = gate.serviceSelectionGate(serviceId ?? "", servicesResult.services, userMessages);
      const turn = turns.length + 1;
      if (!selected.ok) {
        orderedCalls.push({ turn, name, serviceId, blocked: true });
        return toolResult({ success: false, message: selected.hintMessage });
      }
      const slotsByService: Record<string, string[]> = {
        [fixture.IDS.service.limpeza]: ["09:10"],
        [fixture.IDS.service.corte]: ["16:40"],
      };
      const slots = slotsByService[serviceId ?? ""] ?? ["13:20"];
      orderedCalls.push({ turn, name, serviceId, blocked: false });
      return toolResult({ success: true, slots, message: `Horários disponíveis: ${slots.join(", ")}` });
    }
    // The scenario does not authorize writes; an LLM attempt remains a safe in-memory trace.
    orderedCalls.push({ turn: turns.length + 1, name, serviceId, blocked: false });
    return toolResult({ success: false, message: "INTERNAL_HINT: Escritas não são permitidas nesta fixture em memória." });
  };

  try {
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!;
      userMessages.push(input);
      messages = [...messages, { role: "user", content: input }];
      const loop = await brain.runReceptionistModelLoop({
        config: currentConfig,
        messages,
        executeTool,
        thinkingMode: "disabled",
        retryOnFailure: false,
        maxToolRounds: 4,
        userId: `${id}-${pass}`,
        serviceSelectionAntiLoop: { services: servicesResult.services, intentionKey: `${id}-${pass}-turn-${index + 1}` },
        completionFactory: async ({ messages: completionMessages }: { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }) =>
          provider.createReceptionistChatCompletion(provider.resolveReceptionistAiRuntime(currentConfig), {
            messages: completionMessages, tools: brain.RECEPTIONIST_TOOLS, temperature: 0.4, maxTokens: 450,
            userId: `${id}-${pass}`, thinkingMode: "disabled",
          }),
      });
      messages = loop.messages;
      turns.push({ customerMessage: input, rawResponse: loop.rawReply, toolTrace: loop.toolTrace as Trace[], providerModels: loop.providerReportedModels, exhausted: loop.exhausted });
    }

    const failures: string[] = [];
    if (scenario === "anti-loop") {
      const canonical = gate.buildServiceQuestion(servicesResult.services);
      for (const [index, turn] of turns.entries()) {
        const blocked = turn.toolTrace.filter((entry) => {
          try { const parsed = JSON.parse(entry.result) as { success?: boolean; message?: string }; return parsed.success === false && String(parsed.message ?? "").includes("SERVICE_SELECTION"); } catch { return false; }
        });
        if (blocked.length > 1) failures.push(`turno ${index + 1}: mais de uma tentativa bloqueada`);
        if (turn.rawResponse !== canonical) failures.push(`turno ${index + 1}: saída canônica ausente`);
        if (FORBIDDEN_ANTI_LOOP.test(turn.rawResponse ?? "")) failures.push(`turno ${index + 1}: mecanismo interno exposto`);
      }
      if (orderedCalls.some((call) => call.name === "getAvailableSlots" && !call.blocked)) failures.push("serviço foi consultado sem escolha clara");
    } else {
      const a = fixture.IDS.service.limpeza;
      const b = fixture.IDS.service.corte;
      const availability = orderedCalls.filter((call) => call.name === "getAvailableSlots" && !call.blocked);
      if (!availability.some((call) => call.serviceId === a)) failures.push("turno 1 não consultou disponibilidade do serviço A");
      if (!availability.some((call) => call.serviceId === b)) failures.push("turno 2 não consultou disponibilidade do serviço B");
      const firstA = availability.findIndex((call) => call.serviceId === a);
      const firstB = availability.findIndex((call) => call.serviceId === b);
      if (firstA < 0 || firstB < 0 || firstA >= firstB) failures.push("ordem de disponibilidade não foi A depois B");
      if ((turns[1]?.rawResponse ?? "").includes("09:10")) failures.push("resposta após troca reutilizou slot A");
      if ((turns[1]?.rawResponse ?? "").includes("09:10") || !(turns[1]?.rawResponse ?? "").includes("16:40")) failures.push("resposta após troca não apresentou somente slot B autoritativo");
    }
    return redactDeep({ id, pass, verdict: failures.length ? "FAIL" : "PASS", assertions: failures, turns, orderedToolCalls: orderedCalls, ...(failures.length ? { promptOnFailure: prompt } : {}) }) as Result;
  } catch (error) {
    return redactDeep({ id, pass, verdict: "BLOCKED", assertions: ["provider failure; case not retried", String(error)], turns, orderedToolCalls: orderedCalls, promptOnFailure: prompt }) as Result;
  }
}

function markdown(report: any): string {
  const rows = report.results.map((result: Result) => `### ${result.id}/${result.pass} — ${result.verdict}\n\n- Asserções: ${result.assertions.length ? result.assertions.join("; ") : "ok"}\n- Tool trace ordenado: \`${JSON.stringify((result as any).orderedToolCalls)}\`\n${result.turns.map((turn, i) => `- Turno ${i + 1}; cliente: ${turn.customerMessage}; resposta bruta sanitizada: ${turn.rawResponse ?? "[sem resposta]"}; trace: \`${JSON.stringify(turn.toolTrace.map((x) => ({ name: x.name, args: x.args, argumentsValidJson: x.argumentsValidJson })))}\``).join("\n")}\n${result.promptOnFailure ? "- Prompt composto final: presente em `promptOnFailure` no JSON sanitizado." : ""}`).join("\n\n");
  return `# GSEQ — execução comportamental isolada\n\nDeepSeek Flash real, thinking disabled, retryOnFailure=false; conversas acumuladas; tools em memória. DB/ERP/WhatsApp: zero acesso. Cleanup: N/A (zero DB).\n\n\`\`\`json\n${JSON.stringify(report.metadata, null, 2)}\n\`\`\`\n\n${rows}\n`;
}

async function main() {
  const results: Result[] = [];
  for (const pass of ["A", "B"] as const) {
    results.push(await runConversation("GSEQ-ANTI-LOOP", pass, ["quero agendar", "quero um horário", "pode ser qualquer um"], "anti-loop"));
    results.push(await runConversation("GSEQ-SWITCH", pass, ["quero marcar Limpeza de Pele no dia 10/08", "Na verdade, prefiro Corte no mesmo dia"], "switch"));
  }
  const counts = results.reduce((acc, result) => { acc[result.verdict] += 1; return acc; }, { PASS: 0, FAIL: 0, BLOCKED: 0 });
  const report = redactDeep({ suite: "ana-owner-behavioral-gseq-v1", status: "EXECUTED", metadata: { provider: "deepseek", model: "deepseek-v4-flash", thinking: "disabled", retryOnFailure: false, ids: ["GSEQ-ANTI-LOOP", "GSEQ-SWITCH"], passes: ["A", "B"], safety: { database: "127.0.0.1:1 invalid", erp: "127.0.0.1:1 invalid", whatsapp: false, appointments: false, toolExecutor: "in-memory controlled" }, cleanup: "N/A: zero DB" }, counts, results });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "report.md"), markdown(report));
  console.log(JSON.stringify({ output: OUT_DIR, counts }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
