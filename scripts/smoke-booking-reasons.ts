/**
 * Smoke (sem rede) das correções de fluxo da Ana (relato de prod):
 *
 *  - Falha 1 (desambiguação de serviço): getAvailableSlots/bookAppointment SEM
 *    serviceId devolvem INTERNAL_HINT orientando a perguntar qual serviço; e o
 *    system prompt tem a regra de fluxo "ESCOLHA DO SERVIÇO".
 *  - Falha 2 (alternativas após falha): erro de horário qualificado devolve
 *    `availableSlots` já consultados pelo calendário e não pede nova consulta;
 *    lista vazia não tem alternativa. Sem `availableSlots`, hint/consulta ainda
 *    são o fallback antes de sugerir horário.
 *  - Falha 3 (mensagens por motivo): normalizeBookReason + customerMessageForReason
 *    mapeiam blocked/conflict/outside_hours/package_exhausted/other corretamente.
 *
 * Tudo aqui é determinístico e roda antes de qualquer chamada ao ERP — os
 * guards retornam cedo. O fim-a-fim real (Ana→ERP→OpenAI) é validado no
 * WhatsApp. Rodar: npx tsx scripts/smoke-booking-reasons.ts
 *
 * NB: roda via tsx (não `node`) porque importa o grafo de src/ com imports
 * relativos SEM extensão (convenção do projeto, ok no build CJS); o ESM nativo
 * do node exige extensão e quebra ao seguir `../erpApiToken`. O tsx resolve
 * extensionless + .ts + import.meta.url.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  normalizeBookReason,
  customerMessageForReason,
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
  type BookFailureReason,
} from "../src/services/calendarService.ts";
import type { TenantBotConfig } from "../src/configProvider.ts";

const here = dirname(fileURLToPath(import.meta.url));

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const config: TenantBotConfig = {
  tenantSlug: "smoke-tenant",
  botName: "Ana",
  systemPrompt: "prompt de teste",
  greetingMessage: null,
  fallbackMessage: null,
  aiModel: "gpt-4o-mini",
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: "08:00",
  botActiveEnd: "20:00",
  timezone: "America/Sao_Paulo",
  waAccessToken: "x",
  waApiVersion: "v21.0",
  phoneNumberId: "smoke-phone",
  isActive: true,
};

// data válida e futura pra passar do guard de formato/data
const FUTURE_DATE = "2099-01-02";

async function main() {
  // ===== Falha 3: mapeamento de reason → mensagem =====
  const reasons: BookFailureReason[] = [
    "blocked",
    "conflict",
    "outside_hours",
    "package_exhausted",
    "customer_identity_ambiguous",
    "other",
  ];
  for (const r of reasons) {
    record(`reason "${r}" preservado por normalizeBookReason`, normalizeBookReason(r) === r);
  }
  record('reason desconhecido + status 409 → "conflict"', normalizeBookReason(undefined, 409) === "conflict");
  record('reason desconhecido + status 400 → "other"', normalizeBookReason("xpto", 400) === "other");
  record('reason ausente sem status → "other"', normalizeBookReason(undefined) === "other");

  const blockedMsg = customerMessageForReason("blocked", "Samantha");
  record(
    'customerMessageForReason("blocked", "Samantha") cita bloqueio + nome',
    /bloquead/i.test(blockedMsg) && blockedMsg.includes("Samantha"),
    blockedMsg
  );
  const blockedMsgNoName = customerMessageForReason("blocked");
  record(
    'customerMessageForReason("blocked") sem nome ainda cita bloqueio',
    /bloquead/i.test(blockedMsgNoName),
    blockedMsgNoName
  );
  record(
    'customerMessageForReason("conflict") fala em preenchido',
    /preenchid/i.test(customerMessageForReason("conflict")),
    customerMessageForReason("conflict")
  );
  record(
    'customerMessageForReason("outside_hours") fala em horário de atendimento',
    /horário de atendimento|fora/i.test(customerMessageForReason("outside_hours")),
    customerMessageForReason("outside_hours")
  );
  record(
    'customerMessageForReason("package_exhausted") fala em pacote',
    /pacote/i.test(customerMessageForReason("package_exhausted")),
    customerMessageForReason("package_exhausted")
  );
  const identityMessage = customerMessageForReason("customer_identity_ambiguous");
  record(
    'customer_identity_ambiguous orienta atendimento humano sem falar em horário',
    /identificar seu cadastro com segurança/i.test(identityMessage) &&
      /equipe do estabelecimento/i.test(identityMessage) &&
      !/horário|vaga|disponibilidade/i.test(identityMessage),
    identityMessage
  );

  let ambiguousCancelPostCalls = 0;
  const ambiguousCancel = await cancelAppointment(
    "appointment-smoke",
    "+5511999999999",
    config,
    "Quero cancelar meu agendamento",
    {
      getUpcomingAppointments: async () => ({
        success: false,
        reason: "customer_identity_ambiguous",
        message: CUSTOMER_IDENTITY_AMBIGUOUS_HINT,
      }),
      postCancel: async () => {
        ambiguousCancelPostCalls += 1;
      },
    }
  );
  record(
    "cancelamento com identidade ambígua falha fechado antes do POST",
    ambiguousCancel.success === false &&
      ambiguousCancel.reason === "customer_identity_ambiguous" &&
      ambiguousCancel.message === CUSTOMER_IDENTITY_AMBIGUOUS_HINT &&
      ambiguousCancelPostCalls === 0,
    ambiguousCancel.message
  );

  // ===== Falha 1: guards de serviceId (pré-rede) =====
  const availNoService = await getAvailableSlots(FUTURE_DATE, "", config);
  record(
    "getAvailableSlots sem serviceId → INTERNAL_HINT (desambiguação)",
    availNoService.success === false && /INTERNAL_HINT/.test(availNoService.message ?? ""),
    availNoService.message
  );

  const availNameAsService = await getAvailableSlots(FUTURE_DATE, "depilacao", config);
  record(
    'getAvailableSlots com serviceId="depilacao" (nome) → INTERNAL_HINT',
    availNameAsService.success === false && /INTERNAL_HINT/.test(availNameAsService.message ?? ""),
    availNameAsService.message
  );

  const availNameAsProf = await getAvailableSlots(FUTURE_DATE, "cmabc123def456ghi789jkl", config, "samantha");
  record(
    'getAvailableSlots com professionalId="samantha" (nome) → INTERNAL_HINT',
    availNameAsProf.success === false && /INTERNAL_HINT/.test(availNameAsProf.message ?? ""),
    availNameAsProf.message
  );

  const bookNoService = await bookAppointment(FUTURE_DATE, "15:00", "", "+5511999999999", "Cliente", config);
  record(
    "bookAppointment sem serviceId → INTERNAL_HINT (não confirma nada)",
    bookNoService.success === false && /INTERNAL_HINT/.test(bookNoService.message ?? ""),
    bookNoService.message
  );

  const bookBadDate = await bookAppointment("ontem", "15:00", "cmabc123def456ghi789jkl", "+5511999999999", "Cliente", config);
  record(
    "bookAppointment com data inválida → erro de formato (reason other)",
    bookBadDate.success === false && bookBadDate.reason === "other",
    `reason=${bookBadDate.reason} msg=${bookBadDate.message}`
  );

  // ===== Falha 1 + 2: regras de fluxo no system prompt (wiring) =====
  const brainSrc = readFileSync(resolve(here, "../src/services/brainService.ts"), "utf8");
  record(
    "system prompt contém a regra 'ESCOLHA DO SERVIÇO' (Falha 1)",
    brainSrc.includes("ESCOLHA DO SERVIÇO") && brainSrc.includes("NUNCA assuma qual serviço")
  );
  record(
    "system prompt contém a regra 'HORÁRIO INDISPONÍVEL' (Falha 2)",
    brainSrc.includes("HORÁRIO INDISPONÍVEL") && brainSrc.includes("getAvailableSlots"),
  );
  record(
    "system prompt trata availableSlots qualificado como disponibilidade já consultada (Falha 2)",
    brainSrc.includes("availableSlots") &&
      /já consultou a disponibilidade internamente/i.test(brainSrc) &&
      brainSrc.includes("NÃO chame getAvailableSlots de novo"),
  );
  record(
    "system prompt conserva hint/consulta quando a falha qualificada não traz availableSlots",
    brainSrc.includes("não trouxer availableSlots, siga o hint e chame getAvailableSlots"),
  );
  record(
    "system prompt diferencia duplicidade de indisponibilidade (não chamar getAvailableSlots no fluxo de duplicata)",
    brainSrc.includes("DUPLICADO") || brainSrc.includes("duplicad"),
  );

  const calSrc = readFileSync(resolve(here, "../src/services/calendarService.ts"), "utf8");
  record(
    "falhas qualificadas de book carregam availableSlots autoritativos sem requery (Falha 2)",
    calSrc.includes("availableSlots: alternatives") &&
      calSrc.includes("já consultados pelo sistema") &&
      calSrc.includes("NÃO chame getAvailableSlots de novo"),
  );
  record(
    "falha qualificada sem slots mantém fallback de nenhuma alternativa no dia",
    calSrc.includes("availableSlots: []") &&
      calSrc.includes("Não há horários reais nesse dia") &&
      calSrc.includes("ofereça tentar outra data"),
  );
  record(
    "package_exhausted/other não viram disponibilidade e preservam hint de fallback",
    calSrc.includes("package_exhausted / other: oferecer horários não resolve") &&
      calSrc.includes("BOOK_ALTERNATIVES_HINT"),
  );
  record(
    "identidade ambígua é tratada antes das alternativas de horário",
    calSrc.indexOf("if (reason === 'customer_identity_ambiguous')") >= 0 &&
      calSrc.indexOf("if (reason === 'customer_identity_ambiguous')") <
        calSrc.indexOf("if (reason === 'blocked' || reason === 'conflict' || reason === 'outside_hours')"),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ TODOS OS CHECKS PASSARAM" : `❌ ${failed.length} CHECK(S) FALHARAM`} (${checks.length} no total)`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke falhou:", err);
  process.exitCode = 1;
});
