/**
 * Smoke determinístico da verdade operacional da recepcionista.
 * Não chama OpenAI/DeepSeek, ERP, WhatsApp ou banco.
 *
 * Rodar: npm run smoke:clinical-copy
 */
process.env.DATABASE_URL ||= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
process.env.OPENAI_API_KEY ||= "sk-smoke-test";
process.env.ERP_API_TOKEN ||= "erp-smoke-test";

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TenantBotConfig } from "../src/configProvider";
import type { ServicesResult } from "../src/services/calendarService";
import {
  PROMISE_GUARD_FALLBACK,
  applyPromiseGuard,
} from "../src/services/promiseGuard";
import {
  FORBIDDEN_PROMISE_PATTERNS,
  isNegatedContext,
  matchForbiddenPromise,
  matchForbiddenPromiseInSpeech,
} from "./lib/operationalTruth";

export const NEW_CANONICAL_SHA256 =
  "e6f615a1ed6b0d589e3f363e0317f53894a5e094366557748a48aa81501f9be3";

const CLINICAL_CANONICAL_V2 =
  "A equipe ou o profissional responsável precisa avaliar o seu caso. Se quiser, posso apresentar os serviços cadastrados e, depois que você escolher um deles, verificar os horários disponíveis.";
const OLD_CLINICAL_PROMISE =
  "Vou encaminhar sua dúvida para que possam te orientar.";

const SOURCE_RADICAL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "src/security.ts": [
    " * O webhook da Ana recebe o payload ENCAMINHADO pelo Receps (não direto da",
  ],
};
const TECHNICAL_PROMISE_GUARD_PATTERN_LINE = /^\s*\/.*encaminh.*\/i,\s*$/i;

let checks = 0;
let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  console.log(
    `${condition ? "[PASS]" : "[FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) failures += 1;
}

function configWithPrompt(systemPrompt: string): TenantBotConfig {
  return {
    tenantSlug: "tenant-smoke",
    botName: "Ana",
    botRole: "receptionist",
    systemPrompt,
    greetingMessage: "Olá! Sou a Ana.",
    fallbackMessage: "Tente novamente.",
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: "08:00",
    botActiveEnd: "20:00",
    timezone: "America/Sao_Paulo",
    waAccessToken: "wa-smoke",
    waApiVersion: "v21.0",
    phoneNumberId: "phone-smoke",
    isActive: true,
  };
}

const servicesFixture: ServicesResult = {
  success: true,
  professionals: [{ id: "prof-smoke", name: "Profissional Smoke" }],
  services: [
    {
      id: "svc-avaliacao",
      name: "Avaliação Podológica",
      durationMinutes: 30,
      price: 100,
      priceFormatted: "R$ 100,00",
      professionalIds: ["prof-smoke"],
    },
  ],
};

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function isExcludedReceptionistSource(relativePath: string): boolean {
  return /(?:sales|renata|onboarding)/i.test(relativePath);
}

function isAllowedRadicalSourceLine(
  relativePath: string,
  line: string,
): boolean {
  if (
    relativePath === "src/services/promiseGuard.ts" &&
    TECHNICAL_PROMISE_GUARD_PATTERN_LINE.test(line)
  ) {
    return true;
  }

  return (SOURCE_RADICAL_ALLOWLIST[relativePath] ?? []).includes(line);
}

function sourceRadicalViolations(root: string): string[] {
  const srcRoot = path.join(root, "src");
  const violations: string[] = [];
  const observedAllowlist = new Set<string>();

  for (const absolutePath of listTypeScriptFiles(srcRoot)) {
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    if (isExcludedReceptionistSource(relativePath)) continue;

    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/encaminh/i.test(line)) return;

      if (isAllowedRadicalSourceLine(relativePath, line)) {
        observedAllowlist.add(`${relativePath}\0${line}`);
        return;
      }
      violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }

  for (const [relativePath, allowedLines] of Object.entries(
    SOURCE_RADICAL_ALLOWLIST,
  )) {
    for (const line of allowedLines) {
      if (!observedAllowlist.has(`${relativePath}\0${line}`)) {
        violations.push(
          `${relativePath}: allowlist obsoleta; linha técnica esperada não foi encontrada`,
        );
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const { DEFAULT_BOT_SYSTEM_PROMPT } = await import("../src/botDefaults");
  const {
    BRAIN_SERVICE_INTERNAL_HINT_SAMPLES,
    RECEPTIONIST_TOOLS,
    buildSystemPromptFromServices,
  } = await import("../src/services/brainService");
  const { BOOKING_CONFIRMATION_INTERNAL_HINTS } =
    await import("../src/services/bookingConfirmationGate");
  const { CALENDAR_RECEPTIONIST_INTERNAL_HINT_SAMPLES } =
    await import("../src/services/calendarService");
  const { PROFESSIONAL_SELECTION_INTERNAL_HINT_SAMPLES } =
    await import("../src/services/professional-selection-gate");
  const { SERVICE_SELECTION_INTERNAL_HINT_SAMPLE } =
    await import("../src/services/service-gate");
  const now = new Date("2026-08-04T15:00:00.000Z");

  check(
    "matcher determinístico exporta exatamente os 8 patterns canônicos",
    FORBIDDEN_PROMISE_PATTERNS.map(String).join("\n") ===
      [
        "/encaminh/i",
        "/\\bvou\\s+(avisar|chamar|acionar|pedir|passar|falar|repassar|transmitir)\\b/i",
        "/\\b(avisarei|chamarei|acionarei|repassarei|retornarei|transmitirei)\\b/i",
        "/j[áa] chamei/i",
        "/vai te responder/i",
        "/em breve/i",
        "/entrar(ei|emos|á|ão)? em contato/i",
        "/vou (te )?retornar/i",
      ].join("\n"),
  );
  for (const sample of [
    "Vou encaminhar para a responsável.",
    "Vou avisar a equipe.",
    "Avisarei a responsável.",
    "Já chamei alguém.",
    "Ela vai te responder.",
    "A resposta chega em breve.",
    "A equipe entrará em contato.",
    "Vou te retornar.",
  ]) {
    check(
      `matcher determinístico diagnostica: ${sample}`,
      matchForbiddenPromise(sample) !== null,
      matchForbiddenPromise(sample) ?? undefined,
    );
  }

  const speechMatcherCases: Array<{
    text: string;
    expected: "match" | "null";
  }> = [
    {
      text: "não posso prometer que alguém vai te responder",
      expected: "null",
    },
    {
      text: "você pode entrar em contato diretamente com a recepção",
      expected: "null",
    },
    { text: "a equipe entrará em contato", expected: "match" },
    {
      text: "a responsável vai entrar em contato com você",
      expected: "match",
    },
    { text: "alguém vai te responder ainda hoje", expected: "match" },
    { text: "vou avisar a equipe", expected: "match" },
    {
      text: "Vou te passar para a equipe do estabelecimento",
      expected: "match",
    },
    { text: "vou lhe transferir agora", expected: "match" },
    { text: "estou te transferindo", expected: "match" },
    { text: "não consigo te passar para ninguém", expected: "null" },
    { text: "você pode passar na recepção", expected: "null" },
    { text: "não vou conseguir avisar a equipe", expected: "null" },
    {
      text: "não consigo encaminhar seu pedido para a equipe",
      expected: "null",
    },
    {
      text: "não vou encaminhar seu pedido para a equipe",
      expected: "null",
    },
    {
      text: "a sua reclamação deve ser encaminhada para eles",
      expected: "null",
    },
    { text: "vou encaminhar sua dúvida", expected: "match" },
    { text: "já encaminhei sua solicitação", expected: "match" },
    {
      text: "sua dúvida será encaminhada para a equipe",
      expected: "match",
    },
    { text: "estou encaminhando sua conversa", expected: "match" },
    {
      text: "a equipe vai encaminhar uma resposta",
      expected: "match",
    },
    { text: "Ela vai te responder.", expected: "match" },
    { text: "vão te responder", expected: "match" },
    { text: "vou falar com eles", expected: "match" },
    { text: "Vou avisar a dona.", expected: "match" },
    { text: "Vou falar com a podóloga.", expected: "match" },
    { text: "A recepcionista retornará com você.", expected: "match" },
    { text: "Eu encaminho para a equipe.", expected: "match" },
    { text: "Encaminharei sua dúvida.", expected: "match" },
    { text: "Posso encaminhar para a equipe.", expected: "match" },
    { text: "Vamos encaminhar para a equipe.", expected: "match" },
    { text: "Vamos avisar a equipe.", expected: "match" },
    { text: "Vou te passar pra equipe.", expected: "match" },
    { text: "Retornarei com uma resposta.", expected: "match" },
    { text: "Eu retorno depois.", expected: "match" },
    { text: "Avisarei a responsável.", expected: "match" },
    { text: "Já avisei a equipe.", expected: "match" },
    {
      text: "Não apenas vou encaminhar sua dúvida.",
      expected: "match",
    },
    { text: "Não só vou transferir você.", expected: "match" },
    { text: "Não somente vou transferir você.", expected: "match" },
    {
      text: "Não consigo resolver, mas vou te passar para a equipe.",
      expected: "match",
    },
    {
      text: "Não posso fazer isso; vou chamar alguém.",
      expected: "match",
    },
    {
      text: "Não consigo resolver:\nvou avisar a equipe.",
      expected: "match",
    },
    {
      text: "Não consigo resolver. 😊 Vou transferir você.",
      expected: "match",
    },
    {
      text: "VOU ENCAMINHÁ-LA PARA A RESPONSÁVEL.",
      expected: "match",
    },
    { text: "Vou encaminha-la para a responsável.", expected: "match" },
    { text: "Vou passar-te para a responsável.", expected: "match" },
    { text: "Em breve.", expected: "null" },
    { text: "Um momento.", expected: "null" },
    { text: "Você vai responder algumas perguntas.", expected: "null" },
    {
      text: "Você vai entrar em contato diretamente com a equipe.",
      expected: "null",
    },
    { text: "Vou te passar os horários disponíveis.", expected: "null" },
    { text: "Vamos te passar os horários disponíveis.", expected: "null" },
    { text: "Vou pedir para você confirmar o serviço.", expected: "null" },
    { text: "O retorno depende da equipe.", expected: "null" },
    { text: "O retorno do agendamento aparece no sistema.", expected: "null" },
  ];
  for (const { text, expected } of speechMatcherCases) {
    const match = matchForbiddenPromiseInSpeech(text);
    check(
      `matcher de fala retorna ${expected}: ${text}`,
      expected === "match" ? match !== null : match === null,
      match ?? undefined,
    );
  }
  const secondSentence = "não vou avisar a equipe. vou avisar a equipe";
  check(
    "guarda de negação respeita o início da sentença atual",
    isNegatedContext(secondSentence, secondSentence.lastIndexOf("vou")) ===
      false,
  );
  check(
    "matcher de fala continua procurando após ocorrência negada",
    matchForbiddenPromiseInSpeech(secondSentence) !== null,
  );

  const blockedPromise = applyPromiseGuard(
    "Claro! Vou te passar para a equipe do estabelecimento.",
  );
  check(
    "promise guard substitui promessa pelo fallback fixo",
    blockedPromise.blocked && blockedPromise.reply === PROMISE_GUARD_FALLBACK,
    blockedPromise.blocked ? blockedPromise.pattern : undefined,
  );
  const honestReply =
    "Não consigo transferir por aqui. Esse assunto é tratado diretamente com a equipe.";
  const allowedPromise = applyPromiseGuard(honestReply);
  check(
    "promise guard preserva fala honesta",
    !allowedPromise.blocked && allowedPromise.reply === honestReply,
  );
  const schedulingReply = "Vou te passar os horários disponíveis.";
  const allowedSchedulingReply = applyPromiseGuard(schedulingReply);
  check(
    "promise guard preserva oferta legítima de horários",
    !allowedSchedulingReply.blocked &&
      allowedSchedulingReply.reply === schedulingReply,
  );

  const defaultPrompt = buildSystemPromptFromServices(
    configWithPrompt(DEFAULT_BOT_SYSTEM_PROMPT),
    servicesFixture,
    now,
  );
  const defaultMatch = matchForbiddenPromise(defaultPrompt);
  check(
    "prompt final com default local tem zero promessas proibidas",
    defaultMatch === null,
    defaultMatch ?? undefined,
  );
  const exactTransferRule =
    "H. TRANSFERÊNCIA E RECADOS — Você NÃO transfere a conversa, NÃO avisa ninguém, NÃO deixa recado e NÃO aciona a equipe. Se o cliente pedir para falar com alguém, para ser transferido ou para que você avise alguém, diga com clareza que isso não é possível por aqui e que esses assuntos são tratados diretamente com a equipe do estabelecimento. NÃO prometa nenhuma ação futura sua nem da equipe e NÃO peça para o cliente aguardar por alguém.";
  check(
    "prompt composto contém a regra H byte-idêntica",
    defaultPrompt.includes(exactTransferRule),
  );

  const canonicalCount = defaultPrompt.split(CLINICAL_CANONICAL_V2).length - 1;
  check(
    "prompt final default contém a frase clínica v2 exatamente 2 vezes",
    canonicalCount === 2,
    `ocorrências=${canonicalCount}`,
  );

  const harmlessCustomPrompt = buildSystemPromptFromServices(
    configWithPrompt("Seja simpática e responda somente com dados atuais."),
    servicesFixture,
    now,
  );
  const harmlessMatch = matchForbiddenPromise(harmlessCustomPrompt);
  check(
    "prompt final com custom inofensivo tem zero promessas proibidas",
    harmlessMatch === null,
    harmlessMatch ?? undefined,
  );

  const staleCustomPrompt = buildSystemPromptFromServices(
    configWithPrompt(`Seja simpática. ${OLD_CLINICAL_PROMISE}`),
    servicesFixture,
    now,
  );
  check(
    "prompt custom antigo permanece visível para responsabilidade do migrador",
    staleCustomPrompt.includes(OLD_CLINICAL_PROMISE),
  );

  for (const tool of RECEPTIONIST_TOOLS) {
    const description = tool.function.description ?? "";
    const match = matchForbiddenPromise(description);
    check(
      `tool ${tool.function.name} tem description operacionalmente honesta`,
      match === null,
      match ?? undefined,
    );
  }

  const hintGroups: Array<readonly string[]> = [
    BRAIN_SERVICE_INTERNAL_HINT_SAMPLES,
    BOOKING_CONFIRMATION_INTERNAL_HINTS,
    CALENDAR_RECEPTIONIST_INTERNAL_HINT_SAMPLES,
    PROFESSIONAL_SELECTION_INTERNAL_HINT_SAMPLES,
    [SERVICE_SELECTION_INTERNAL_HINT_SAMPLE],
  ];
  const hints = hintGroups.flat();
  hints.forEach((hint, index) => {
    const match = matchForbiddenPromise(hint);
    check(
      `instrução interna da recepcionista ${index + 1}/${hints.length} tem zero matches`,
      match === null,
      match ?? undefined,
    );
  });

  const canonicalSha256 = createHash("sha256")
    .update(DEFAULT_BOT_SYSTEM_PROMPT)
    .digest("hex");
  console.log(
    `[INFO] NEW_CANONICAL_SHA256 (Ana e pin esperado no Receps)=${canonicalSha256}`,
  );
  check(
    "sha256 do default local corresponde ao canônico v2 pinado",
    canonicalSha256 === NEW_CANONICAL_SHA256,
  );

  const sourceViolations = sourceRadicalViolations(process.cwd());
  check(
    "sweep de src/ não-sales mantém radical apenas na allowlist técnica",
    sourceViolations.length === 0,
    sourceViolations.length > 0 ? sourceViolations.join(" | ") : undefined,
  );

  console.log(
    `\n${failures === 0 ? "✅ TODOS OS CHECKS PASSARAM" : `❌ ${failures} CHECK(S) FALHARAM`} (${checks} no total)`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
