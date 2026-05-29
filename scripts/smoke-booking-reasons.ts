/**
 * Smoke (sem rede) das correções de fluxo da Ana (relato de prod):
 *
 *  - Falha 1 (desambiguação de serviço): getAvailableSlots/bookAppointment SEM
 *    serviceId devolvem INTERNAL_HINT orientando a perguntar qual serviço; e o
 *    system prompt tem a regra de fluxo "ESCOLHA DO SERVIÇO".
 *  - Falha 2 (sempre consultar horários após falha): o system prompt tem a regra
 *    "HORÁRIO INDISPONÍVEL" e as falhas de book carregam um `hint`.
 *  - Falha 3 (mensagens por motivo): normalizeBookReason + customerMessageForReason
 *    mapeiam blocked/conflict/outside_hours/package_exhausted/other corretamente.
 *
 * Tudo aqui é determinístico e roda antes de qualquer chamada ao ERP — os
 * guards retornam cedo. O fim-a-fim real (Ana→ERP→OpenAI) é validado no
 * WhatsApp. Rodar: node scripts/smoke-booking-reasons.ts
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  normalizeBookReason,
  customerMessageForReason,
  getAvailableSlots,
  bookAppointment,
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
  const reasons: BookFailureReason[] = ["blocked", "conflict", "outside_hours", "package_exhausted", "other"];
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
    "system prompt diferencia duplicidade de indisponibilidade (não chamar getAvailableSlots no fluxo de duplicata)",
    brainSrc.includes("DUPLICADO") || brainSrc.includes("duplicad"),
  );

  const calSrc = readFileSync(resolve(here, "../src/services/calendarService.ts"), "utf8");
  record(
    "falhas de book carregam hint pra consultar horários reais (Falha 2)",
    calSrc.includes("BOOK_ALTERNATIVES_HINT") && calSrc.includes("ANTES de sugerir qualquer alternativa"),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ TODOS OS CHECKS PASSARAM" : `❌ ${failed.length} CHECK(S) FALHARAM`} (${checks.length} no total)`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke falhou:", err);
  process.exitCode = 1;
});
