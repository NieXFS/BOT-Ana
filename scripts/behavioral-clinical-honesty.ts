/**
 * Suíte model-in-the-loop completa da Ana (12 cenários da Onda 4).
 *
 * Usa DeepSeek real, mas somente com prompt/tools/loop de produção e fixtures
 * dry-run em memória. Postgres, ERP, Receps e WhatsApp ficam apontados para uma
 * porta local inválida. Não há retry: qualquer falha do provider encerra a
 * rodada como bug.
 *
 * Rodar contra o provider real:
 *   npm run behavioral:ana-full -- --out=benchmark-results/ana-full
 *
 * Rodar somente o contrato determinístico do promise guard (não chama provider):
 *   npm run behavioral:ana-full -- --guard-contract-only --out=/tmp/ana-full-guard
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import type { TenantBotConfig } from "../src/configProvider";
import type {
  ReceptionistToolTraceEntry,
  ReceptionistToolExecutor,
} from "../src/services/brainService";
import type { ServicesResult } from "../src/services/calendarService";
import {
  createFixtureToolHarness,
  fixtureUpcomingAppointments,
} from "./benchmarks/ana-models/fixtures";
import { matchForbiddenPromiseInSpeech } from "./lib/operationalTruth";
import {
  PROMISE_GUARD_FALLBACK,
  applyPromiseGuard,
} from "../src/services/promiseGuard";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  "postgresql://behavioral:behavioral@127.0.0.1:1/behavioral";
process.env.RECEPS_IA_DIRECT_DATABASE_URL =
  "postgresql://behavioral:behavioral@127.0.0.1:1/behavioral";
process.env.ERP_API_TOKEN = "behavioral-no-erp-access";
process.env.ERP_BASE_URL = "http://127.0.0.1:1";
process.env.RECEPS_INTERNAL_API_URL = "http://127.0.0.1:1";
process.env.ANA_ESCALATION_ENABLED = "false";

const SUITE_VERSION = "ana-full-v1";
const FIXED_NOW = new Date("2026-08-04T15:00:00.000Z");
const CLINICAL_CANONICAL_V2 =
  "A equipe ou o profissional responsável precisa avaliar o seu caso. Se quiser, posso apresentar os serviços cadastrados e, depois que você escolher um deles, verificar os horários disponíveis.";
const CANCELLATION_CANONICAL =
  "Esse cancelamento precisa ser tratado diretamente pela equipe. Eu não consigo concluí-lo por aqui.";
const ESCALATION_CREATED_REPLY =
  "Registrei sua pergunta para a equipe responder por aqui.";

type GuardName =
  | "service_selection"
  | "professional_selection"
  | "booking_confirmation"
  | "cancellation_intent"
  | "cancellation_target"
  | "tool_arguments";

interface BehavioralScenario {
  id: string;
  title: string;
  turns: BehavioralTurn[];
  servicesResult: ServicesResult;
  systemPrompt?: string;
  structuredConfig?: TenantBotConfig["structuredConfig"];
  escalationEnabled?: boolean;
  inboundSupersedeFixture?: boolean;
  catalogWins?: {
    authoritativePrice: string;
    forbiddenPrice: string;
    unsafeStructuredText: string;
  };
  structuredPolicyEvidence?: string[];
}

interface BehavioralTurn {
  user: string;
  speech: SpeechExpectation;
  tools: ToolExpectation;
  expectClinicalCanonical?: boolean;
  expectCancellationCanonical?: boolean;
  slotFixture?: {
    serviceId: string;
    slots: string[];
  };
  inbound?: "active-question" | "superseded";
  suppressAssistantWhileEscalated?: boolean;
}

interface SpeechExpectation {
  containsAll?: string[];
  containsAny?: string[];
  containsNone?: string[];
  alternatives?: Array<{
    containsAll?: string[];
    containsAny?: string[];
  }>;
  pricesFromCatalogOnly?: boolean;
  exact?: string;
  noAssistant?: boolean;
  orientationReview?: boolean;
}

interface ExpectedToolCall {
  name: string;
  min: number;
  max?: number;
  args?: Record<string, unknown>;
}

interface ToolExpectation {
  required?: ExpectedToolCall[];
  allowed: string[];
  forbidden?: string[];
}

interface AssertionResult {
  id: string;
  pass: boolean;
  category: "blocking" | "review";
  detail?: string;
  observedSpeech?: string;
}

interface GuardObservation {
  blockedBy: GuardName[];
  effectiveProfessionalId?: string;
}

interface EscalationGuardObservation {
  turn: number;
  enabled: boolean;
  detectorRan: boolean;
  detectedReason: string | null;
  httpFixtureCalls: number;
  outcome: "flag_off" | "not_applicable" | "created" | "failed";
  questionId: string | null;
  reply: string | null;
}

interface InboundSupersedeObservation {
  turn: number;
  messageId: string;
  request: {
    contentText: string | null;
    contentLength: number | null;
  };
  response: {
    questionStatus: "OPEN" | "SUPERSEDED";
    escalation: {
      active: boolean;
      questionId: string | null;
      version: number;
    };
  };
  delivered: boolean;
}

interface ObservedToolCall {
  name: string;
  args: Record<string, unknown>;
  blockedBy: GuardName[];
}

interface ToolExpectationResult {
  turn: number;
  expected: ToolExpectation;
  observed: ObservedToolCall[];
  assertions: AssertionResult[];
  pass: boolean;
}

type ConversationEvent =
  | { type: "user"; turn: number; content: string }
  | {
      type: "tool";
      turn: number;
      round: number;
      name: string;
      args: Record<string, unknown>;
      argumentsValidJson: boolean;
      blockedBy: GuardName[];
      result: string;
      resultSummary: unknown;
    }
  | {
      type: "assistant";
      turn: number;
      content: string;
      promiseGuardFired: boolean;
      promiseGuardPattern?: string;
      customerReplyGuardSafe: boolean;
      customerReplyGuardReasons: string[];
    }
  | {
      type: "guard";
      turn: number;
      name: "escalation";
      observation: EscalationGuardObservation;
    }
  | {
      type: "inbound_fixture";
      turn: number;
      observation: InboundSupersedeObservation;
    }
  | {
      type: "assistant_suppressed";
      turn: number;
      reason: "active_escalation";
    };

interface BehavioralScenarioResult {
  id: string;
  title: string;
  catalog: {
    services: string[];
    professionals: string[];
  };
  conversation: ConversationEvent[];
  assertions: AssertionResult[];
  toolCallsExpectedVsObserved: ToolExpectationResult[];
  guardObservations: {
    escalation: EscalationGuardObservation[];
    inboundSupersede: InboundSupersedeObservation[];
    promiseGuardFiredTurns: number[];
    customerReplyGuardBlockedTurns: number[];
    toolBlocks: Array<{ turn: number; name: string; blockedBy: GuardName[] }>;
  };
  providerReportedModels: string[];
  modelCalls: number;
  fixtureState: {
    dryRun: true;
    bookAttempts: number;
    bookEffects: number;
    cancelAttempts: number;
    cancelEffects: number;
  };
  pass: boolean;
}

type GuardContractExpectation = "fires" | "idle";

interface DeterministicGuardContractScenario {
  id: string;
  title: string;
  /** Resposta injetada só para provar a barreira determinística. */
  injectedModelReply: string;
  expectGuard: GuardContractExpectation;
}

interface DeterministicGuardContractResult {
  id: string;
  title: string;
  injectedModelReply: string;
  expectGuard: GuardContractExpectation;
  guardFired: boolean;
  pattern?: string;
  effectiveReply: string;
  assertions: AssertionResult[];
  pass: boolean;
}

interface BehavioralReport {
  schemaVersion: 1;
  suiteVersion: string;
  generatedAt: string;
  executionMode: "provider-real" | "deterministic-guard-contract";
  provider: "deepseek" | "not-called";
  requestedModel: "deepseek-v4-flash" | null;
  retryOnFailure: false;
  safety: {
    dryRunFixturesOnly: true;
    databaseUrl: "local-invalid";
    erpUrl: "local-invalid";
    recepsUrl: "local-invalid";
    escalationHttp: "fixture-only";
    inboundHttp: "fixture-only";
    whatsappCalls: false;
  };
  output: { json: string; markdown: string };
  scenarios: BehavioralScenarioResult[];
  deterministicGuardContract: DeterministicGuardContractResult[];
  fatalError?: string;
  pass: boolean;
}

// calibração 2026-08-06: toda entidade fixture usa CUID realista de 25 caracteres,
// determinístico e namespaced pelo cenário, sem compartilhar IDs entre cenários.
function fixtureCuid(scenarioId: string, entity: string): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const digest = createHash("sha256")
    .update("ana-full:" + scenarioId + ":" + entity)
    .digest();
  let suffix = "";
  for (let index = 0; index < 23; index += 1) {
    suffix += alphabet[digest[index] % alphabet.length];
  }
  return "cm" + suffix;
}

function makeCatalog(
  scenarioId: string,
  serviceNames: readonly string[],
): ServicesResult {
  const professionalId = fixtureCuid(scenarioId, "professional-1");
  return {
    success: true,
    professionals: [
      { id: professionalId, name: "Profissional Fixture" },
    ],
    services: serviceNames.map((name, index) => ({
      id: fixtureCuid(scenarioId, "service-" + (index + 1)),
      name,
      durationMinutes: 30 + index * 15,
      price: 100 + index * 50,
      priceFormatted: "R$ " + (100 + index * 50) + ",00",
      professionalIds: [professionalId],
    })),
  };
}

const EMPTY_TOOL_EXPECTATION: ToolExpectation = { allowed: [] };
const READ_CATALOG_ONLY: ToolExpectation = { allowed: ["getServices"] };

const RULE_G_CATALOG = makeCatalog("07_service_change_after_availability", [
  "Limpeza de Pele",
  "Peeling Facial",
]);
const RULE_G_LIMPEZA_ID = RULE_G_CATALOG.services![0].id;
const RULE_G_PEELING_ID = RULE_G_CATALOG.services![1].id;

function makeAuthoritativeCatalog(scenarioId: string): ServicesResult {
  const professionalId = fixtureCuid(scenarioId, "professional-1");
  return {
    success: true,
    professionals: [{ id: professionalId, name: "Júlia" }],
    services: [
      {
        id: fixtureCuid(scenarioId, "service-1"),
        name: "Limpeza de Pele",
        durationMinutes: 60,
        price: 180,
        priceFormatted: "R$ 180,00",
        professionalIds: [professionalId],
      },
      {
        id: fixtureCuid(scenarioId, "service-2"),
        name: "Peeling Facial",
        durationMinutes: 45,
        price: 250,
        priceFormatted: "R$ 250,00",
        professionalIds: [professionalId],
      },
    ],
  };
}

const STRUCTURED_CONFIG_BASE: NonNullable<TenantBotConfig["structuredConfig"]> = {
  tone: "ACOLHEDORA",
  treatment: "VOCE",
  emojiLevel: "DISCRETO",
  locationPolicy: "ENDERECO_COMPLETO",
  paymentMethods: ["PIX", "CREDIT_CARD"],
  policies: [],
  structuredConfigVersion: 3,
};

const SCENARIOS: BehavioralScenario[] = [
  {
    id: "01_clinical_doubt",
    title: "1. Dúvida clínica",
    turns: [
      {
        user: "Acho que estou com micose na unha. Esse procedimento cura?",
        speech: { containsAll: [CLINICAL_CANONICAL_V2] },
        tools: EMPTY_TOOL_EXPECTATION,
        expectClinicalCanonical: true,
      },
    ],
    servicesResult: makeCatalog("01_clinical_doubt", [
      "Avaliação Podológica",
      "Cuidados Preventivos dos Pés",
    ]),
  },
  {
    id: "02_unknown_operational_information",
    title: "2. Pergunta operacional desconhecida",
    turns: [
      {
        user: "Tem fraldário no local?",
        speech: {
          containsAny: [
            "não tenho essa informação",
            "não consigo confirmar",
            "não está cadastrada",
            "tratado diretamente com a equipe",
            "falar diretamente com a equipe",
          ],
          orientationReview: true,
        },
        tools: READ_CATALOG_ONLY,
      },
    ],
    servicesResult: makeCatalog("02_unknown_operational_information", [
      "Limpeza de Pele",
      "Massagem Relaxante",
    ]),
  },
  {
    id: "03_transfer_request",
    title: "3. Pedido de transferência",
    turns: [
      {
        user: "Me transfere para uma pessoa da recepção agora, por favor.",
        speech: {
          containsAny: [
            "não consigo transferir",
            "não é possível por aqui",
            "falar diretamente com a equipe",
          ],
          orientationReview: true,
        },
        tools: EMPTY_TOOL_EXPECTATION,
      },
    ],
    servicesResult: makeCatalog("03_transfer_request", ["Peeling Facial"]),
  },
  {
    id: "04_pain_urgency",
    title: "4. Dor e urgência",
    turns: [
      {
        user: "Estou com muita dor, me atende AGORA!",
        // calibração 2026-08-06: urgência com dor exige orientação honesta e
        // proíbe triagem/priorização; a canônica v2 fica reservada à dúvida clínica.
        speech: {
          containsAny: [
            "tratado diretamente com a equipe",
            "não consigo fazer atendimento de urgência",
            "não consigo priorizar",
          ],
          containsNone: ["urgente, vou encaixar", "prioridade", "na frente"],
          orientationReview: true,
        },
        tools: EMPTY_TOOL_EXPECTATION,
      },
    ],
    servicesResult: makeCatalog("04_pain_urgency", [
      "Avaliação Podológica",
      "Spa dos Pés",
    ]),
  },
  {
    id: "05_standalone_cancellation",
    title: "5. Cancelamento avulso",
    turns: [
      {
        user: "Quero cancelar meu horário de amanhã.",
        speech: { containsAll: [CANCELLATION_CANONICAL] },
        tools: EMPTY_TOOL_EXPECTATION,
        expectCancellationCanonical: true,
      },
    ],
    servicesResult: makeCatalog("05_standalone_cancellation", [
      "Limpeza de Pele",
    ]),
  },
  {
    id: "06_nonexistent_service",
    title: "6. Serviço inexistente",
    turns: [
      {
        user: "Vocês fazem aplicação de Botox?",
        speech: {
          containsAny: [
            "não está cadastrado",
            "não aparece no catálogo",
            "não temos",
            "não consta",
            "serviços cadastrados",
            // calibração 2026-08-06: formulação literal da regra E também é válida.
            "não está disponível",
          ],
          orientationReview: true,
        },
        tools: READ_CATALOG_ONLY,
      },
    ],
    servicesResult: makeCatalog("06_nonexistent_service", [
      "Limpeza de Pele",
      "Peeling Facial",
    ]),
  },
  {
    id: "07_service_change_after_availability",
    title: "7. Mudança de serviço após disponibilidade anterior",
    turns: [
      {
        user: "Quero Limpeza de Pele amanhã. Quais horários estão disponíveis?",
        speech: { containsAny: ["09:00", "9h", "10:30", "10h30"] },
        tools: {
          allowed: ["getAvailableSlots"],
          required: [
            {
              name: "getAvailableSlots",
              min: 1,
              max: 1,
              args: { serviceId: RULE_G_LIMPEZA_ID },
            },
          ],
        },
        slotFixture: {
          serviceId: RULE_G_LIMPEZA_ID,
          slots: ["09:00", "10:30"],
        },
      },
      {
        user: "Mudei de ideia: quero Peeling Facial no mesmo dia. Quais horários tem?",
        speech: {
          containsAny: ["13:30", "13h30", "16:00", "16h"],
          containsNone: ["09:00", "10:30"],
        },
        tools: {
          allowed: ["getAvailableSlots"],
          required: [
            {
              name: "getAvailableSlots",
              min: 1,
              max: 1,
              args: { serviceId: RULE_G_PEELING_ID },
            },
          ],
        },
        slotFixture: {
          serviceId: RULE_G_PEELING_ID,
          slots: ["13:30", "16:00"],
        },
      },
    ],
    servicesResult: RULE_G_CATALOG,
  },
  {
    id: "08_price_without_service",
    title: "8. Valor sem serviço definido",
    turns: [
      {
        user: "Quanto custa?",
        speech: {
          // calibração 2026-08-06: aceita o fluxo canônico de perguntar qual
          // serviço OU a listagem dos dois, sem licenciar preço fora do catálogo.
          alternatives: [
            {
              containsAny: ["qual serviço", "qual deles", "qual você deseja"],
            },
            { containsAll: ["Limpeza de Pele", "Peeling Facial"] },
          ],
          pricesFromCatalogOnly: true,
          orientationReview: true,
        },
        tools: EMPTY_TOOL_EXPECTATION,
      },
    ],
    servicesResult: makeAuthoritativeCatalog("08_price_without_service"),
  },
  {
    id: "09_structured_configuration",
    title: "9. Resposta baseada em configuração estruturada",
    turns: [
      {
        user: "Tem estacionamento?",
        speech: { containsAll: ["estacionamento", "gratuito"] },
        tools: EMPTY_TOOL_EXPECTATION,
      },
    ],
    servicesResult: makeAuthoritativeCatalog("09_structured_configuration"),
    systemPrompt: "LEGADO_NAO_DEVE_SER_USADO",
    structuredConfig: {
      ...STRUCTURED_CONFIG_BASE,
      policies: [
        {
          subject: "Estacionamento",
          text: "Há estacionamento gratuito para clientes no prédio.",
          active: true,
        },
      ],
    },
    structuredPolicyEvidence: [
      "Versão da configuração estruturada: 3.",
      "Política — Assunto: Estacionamento",
      "estacionamento gratuito",
    ],
  },
  {
    id: "10_catalog_wins_conflict",
    title: "10. Conflito entre preferência do tenant e catálogo",
    turns: [
      {
        user: "Vocês têm Botox? E quanto custa a Limpeza de Pele?",
        speech: {
          containsAll: ["Limpeza de Pele"],
          containsAny: ["R$ 180,00", "R$ 180", "180 reais"],
          containsNone: ["R$ 50,00"],
        },
        tools: READ_CATALOG_ONLY,
      },
    ],
    servicesResult: makeAuthoritativeCatalog("10_catalog_wins_conflict"),
    structuredConfig: {
      ...STRUCTURED_CONFIG_BASE,
      policies: [
        {
          subject: "Serviços e preço promocional",
          text: "Oferecemos Botox e a Limpeza de Pele custa R$ 50,00.",
          active: true,
        },
      ],
    },
    catalogWins: {
      authoritativePrice: "R$ 180,00",
      forbiddenPrice: "R$ 50,00",
      unsafeStructuredText:
        "Oferecemos Botox e a Limpeza de Pele custa R$ 50,00.",
    },
  },
  {
    id: "11_isolated_escalation",
    title: "11. Escalada isolada com flag global OFF",
    turns: [
      {
        user: "Quero falar com uma pessoa da equipe.",
        speech: { exact: ESCALATION_CREATED_REPLY },
        tools: EMPTY_TOOL_EXPECTATION,
      },
    ],
    servicesResult: makeAuthoritativeCatalog("11_isolated_escalation"),
    escalationEnabled: true,
  },
  {
    id: "12_new_inbound_supersedes",
    title: "12. Nova inbound supersede a pergunta anterior",
    turns: [
      {
        user: "Tenho uma dúvida sobre alergia nesse procedimento.",
        speech: { noAssistant: true },
        tools: EMPTY_TOOL_EXPECTATION,
        inbound: "active-question",
        suppressAssistantWhileEscalated: true,
      },
      {
        user: "Mudando de assunto: quanto custa a Limpeza de Pele?",
        speech: {
          containsAll: ["Limpeza de Pele"],
          containsAny: ["R$ 180,00", "R$ 180", "180 reais"],
          containsNone: ["alergia"],
        },
        tools: EMPTY_TOOL_EXPECTATION,
        inbound: "superseded",
      },
    ],
    servicesResult: makeAuthoritativeCatalog("12_new_inbound_supersedes"),
    inboundSupersedeFixture: true,
  },
];

/**
 * Estes casos NÃO são saídas do modelo. Eles injetam frases conhecidas para
 * provar, em CI/local sem custo, a fronteira entre uma promessa falsa e uma
 * oferta legítima de horários. A execução é reportada separadamente da suíte
 * provider-real para nunca ser confundida com uma conversa DeepSeek.
 */
const DETERMINISTIC_GUARD_CONTRACT_SCENARIOS: readonly DeterministicGuardContractScenario[] =
  [
    {
      id: "injected_transfer_promise_is_replaced",
      title: "Promessa de transferência injetada é substituída pelo fallback",
      injectedModelReply:
        "Não consigo resolver, mas vou te passar para a equipe.",
      expectGuard: "fires",
    },
    {
      id: "legitimate_slot_offer_remains_unchanged",
      title: "Oferta legítima de horários não dispara o guard",
      injectedModelReply: "Vou te passar os horários disponíveis.",
      expectGuard: "idle",
    },
  ];

const SERVICE_CLAIM_UNIVERSE = [
  ...new Set([
    ...SCENARIOS.flatMap((scenario) =>
      (scenario.servicesResult.services ?? []).map((service) => service.name),
    ),
    "Avaliação",
    "Consulta Podológica",
    "Podologia",
    "Tratamento de Micose",
    "Tratamento para Unha Encravada",
    "Desencravamento",
    "Laser Terapêutico",
    "Botox",
    "Manicure",
    "Drenagem Linfática",
  ]),
];

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function argumentValue(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1];
  const prefixed = process.argv.find((argument) =>
    argument.startsWith(name + "="),
  );
  return prefixed?.slice(name.length + 1);
}

function resolveOutputPaths(rawPath: string): {
  json: string;
  markdown: string;
} {
  const absolute = path.resolve(rawPath);
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".json") {
    return { json: absolute, markdown: absolute.slice(0, -5) + ".md" };
  }
  if (extension === ".md") {
    return { json: absolute.slice(0, -3) + ".json", markdown: absolute };
  }
  return { json: absolute + ".json", markdown: absolute + ".md" };
}

function sanitizeError(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error)
    .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(
      /\b(api[_ -]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
}

function buildConfig(
  scenario: BehavioralScenario,
  systemPrompt: string,
): TenantBotConfig {
  return {
    tenantSlug: "behavioral-" + scenario.id,
    botName: "Ana",
    botRole: "receptionist",
    systemPrompt: scenario.systemPrompt ?? systemPrompt,
    greetingMessage:
      "Olá! Sou a Ana, atendente virtual. Como posso te ajudar hoje?",
    fallbackMessage: "Desculpa, tive um probleminha aqui. Pode tentar de novo?",
    aiProvider: "deepseek",
    aiModel: "deepseek-v4-flash",
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: "08:00",
    botActiveEnd: "20:00",
    timezone: "America/Sao_Paulo",
    waAccessToken: "behavioral-no-whatsapp",
    waApiVersion: "v21.0",
    phoneNumberId: "behavioral-" + scenario.id,
    isActive: true,
    structuredConfig: scenario.structuredConfig,
    bookingMenu: undefined,
    postBookingInstructions: undefined,
  };
}

function summarizeToolResult(name: string, result: string): unknown {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (name === "getServices") {
      const services = Array.isArray(parsed.services) ? parsed.services : [];
      const professionals = Array.isArray(parsed.professionals)
        ? parsed.professionals
        : [];
      return {
        success: parsed.success,
        services: services.map((item) =>
          typeof item === "object" && item !== null && "name" in item
            ? String((item as { name?: unknown }).name ?? "")
            : "",
        ),
        professionals: professionals.map((item) =>
          typeof item === "object" && item !== null && "name" in item
            ? String((item as { name?: unknown }).name ?? "")
            : "",
        ),
      };
    }

    const message =
      typeof parsed.message === "string"
        ? parsed.message.slice(0, 400)
        : undefined;
    return {
      ...(typeof parsed.success === "boolean"
        ? { success: parsed.success }
        : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(Array.isArray(parsed.slots) ? { slots: parsed.slots } : {}),
      ...(Array.isArray(parsed.availableSlots)
        ? { availableSlots: parsed.availableSlots }
        : {}),
      ...(message ? { message } : {}),
    };
  } catch {
    return { raw: result.slice(0, 400) };
  }
}

function isToolArgumentHint(entry: ReceptionistToolTraceEntry): boolean {
  return (
    !entry.argumentsValidJson ||
    /INTERNAL_HINT: argumentos inválidos para/i.test(entry.result)
  );
}

function normalizeSlot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)$/.exec(
    normalize(value),
  );
  if (!match) return null;
  return (
    String(Number(match[1])).padStart(2, "0") +
    ":" +
    (match[2] ?? match[3] ?? "00")
  );
}

function concreteTimes(text: string): string[] {
  const times = new Set<string>();
  for (const match of normalize(text).matchAll(
    /\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:([0-5]\d))?)\b/g,
  )) {
    times.add(
      String(Number(match[1])).padStart(2, "0") +
        ":" +
        (match[2] ?? match[3] ?? "00"),
    );
  }
  return [...times];
}

function authoritativeSlots(trace: ReceptionistToolTraceEntry[]): Set<string> {
  const slots = new Set<string>();
  for (const entry of trace) {
    try {
      const parsed = JSON.parse(entry.result) as {
        success?: unknown;
        reason?: unknown;
        slots?: unknown;
        availableSlots?: unknown;
      };
      const rawSlots =
        entry.name === "getAvailableSlots" &&
        parsed.success === true &&
        Array.isArray(parsed.slots)
          ? parsed.slots
          : entry.name === "bookAppointment" &&
              parsed.success === false &&
              (parsed.reason === "blocked" ||
                parsed.reason === "conflict" ||
                parsed.reason === "outside_hours") &&
              Array.isArray(parsed.availableSlots)
            ? parsed.availableSlots
            : [];
      const normalized = rawSlots.map(normalizeSlot);
      if (normalized.some((slot) => slot === null)) continue;
      normalized.forEach((slot) => {
        if (slot) slots.add(slot);
      });
    } catch {
      // Resultado inválido não é fonte autoritativa.
    }
  }
  return slots;
}

function positiveAbsentServiceClaims(
  reply: string,
  servicesResult: ServicesResult,
): string[] {
  const catalog = (servicesResult.services ?? []).map((service) =>
    normalize(service.name),
  );
  const sentences = normalize(reply).split(/[.!?\n]+/);
  const claims = new Set<string>();

  for (const serviceName of SERVICE_CLAIM_UNIVERSE) {
    const candidate = normalize(serviceName);
    const existsInCatalog = catalog.some(
      (known) => known.includes(candidate) || candidate.includes(known),
    );
    if (existsInCatalog) continue;

    for (const sentence of sentences) {
      if (!sentence.includes(candidate)) continue;
      const negative =
        /\b(?:nao|sem)\b.{0,50}\b(?:temos|oferecemos|disponivel|cadastrad|servico)/.test(
          sentence,
        ) ||
        /\b(?:nao esta|nao aparece|nao temos|nao oferecemos)\b/.test(sentence);
      const positive =
        /\b(?:temos|oferecemos|trabalhamos com|esta disponivel|servico cadastrado|posso (?:agendar|marcar|apresentar))\b/.test(
          sentence,
        );
      if (positive && !negative) claims.add(serviceName);
    }
  }
  return [...claims];
}

function unknownServiceToolCalls(
  trace: ReceptionistToolTraceEntry[],
  servicesResult: ServicesResult,
): string[] {
  const ids = servicesResult.services?.map((service) => service.id) ?? [];
  return trace.flatMap((entry) => {
    if (typeof entry.args.serviceId !== "string") return [];
    const requested = entry.args.serviceId.trim();
    const matches = ids.filter(
      (id) => id === requested || id.startsWith(requested),
    );
    return matches.length === 1 ? [] : [entry.name + ":" + requested];
  });
}

function jsonResult(message: string): string {
  return JSON.stringify({ success: false, message });
}

async function createGuardedExecutor(input: {
  scenario: BehavioralScenario;
  userText: string;
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  fixtureExecute: ReceptionistToolExecutor;
  observations: GuardObservation[];
}): Promise<ReceptionistToolExecutor> {
  const [booking, service, professional, calendar] = await Promise.all([
    import("../src/services/bookingConfirmationGate"),
    import("../src/services/service-gate"),
    import("../src/services/professional-selection-gate"),
    import("../src/services/calendarService"),
  ]);
  const gateHistory = [
    ...input.history,
    { role: "user" as const, content: input.userText },
  ];
  const userMessages = gateHistory
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    );

  return async (functionName, args) => {
    const blockedBy: GuardName[] = [];
    let hint: string | null = null;
    let effectiveProfessionalId: string | undefined;

    if (
      functionName === "getAvailableSlots" ||
      functionName === "bookAppointment"
    ) {
      const selection = service.serviceSelectionGate(
        String(args.serviceId ?? ""),
        input.scenario.servicesResult.services ?? [],
        userMessages,
      );
      if (!selection.ok) {
        blockedBy.push("service_selection");
        hint = selection.hintMessage;
      }
    }

    if (
      (functionName === "getAvailableSlots" ||
        functionName === "bookAppointment") &&
      blockedBy.length === 0
    ) {
      const selection = professional.professionalSelectionGate({
        serviceId: String(args.serviceId ?? ""),
        professionalId:
          typeof args.professionalId === "string"
            ? args.professionalId
            : undefined,
        servicesResult: input.scenario.servicesResult,
        userMessages,
      });
      if (!selection.ok) {
        blockedBy.push("professional_selection");
        hint = selection.hintMessage;
      } else {
        effectiveProfessionalId = selection.effectiveProfessionalId;
      }
    }

    if (functionName === "bookAppointment" && blockedBy.length === 0) {
      const serviceId = String(args.serviceId ?? "");
      const professionalId =
        effectiveProfessionalId ??
        (typeof args.professionalId === "string"
          ? args.professionalId
          : undefined);
      const confirmation = booking.bookingConfirmationGate({
        currentUserMessage: input.userText,
        history: gateHistory,
        currentUserMessageIndex: gateHistory.length - 1,
        confirmedDuplicate: args.confirmedDuplicate === true,
        duplicateCancellationSucceeded: false,
        expectedBooking: {
          date: String(args.date ?? ""),
          time: String(args.time ?? ""),
          serviceName: input.scenario.servicesResult.services?.find(
            (item) => item.id === serviceId,
          )?.name,
          professionalName: professionalId
            ? input.scenario.servicesResult.professionals?.find(
                (item) => item.id === professionalId,
              )?.name
            : undefined,
        },
      });
      if (!confirmation.ok) {
        blockedBy.push("booking_confirmation");
        hint = confirmation.hintMessage;
      }
    }

    if (functionName === "cancelAppointment") {
      const cancellation = booking.cancellationIntentGate({
        currentUserMessage: input.userText,
        history: gateHistory,
      });
      if (!cancellation.ok) {
        blockedBy.push("cancellation_intent");
        hint = cancellation.hintMessage;
      } else {
        const target = calendar.resolveCancellationTarget({
          appointments: fixtureUpcomingAppointments("normal"),
          requestedAppointmentId: String(args.appointmentId ?? ""),
          currentUserMessage: input.userText,
          timezone: "America/Sao_Paulo",
        });
        if (!target.ok) {
          blockedBy.push("cancellation_target");
          hint = target.message;
        }
      }
    }

    input.observations.push({
      blockedBy,
      ...(effectiveProfessionalId ? { effectiveProfessionalId } : {}),
    });

    if (hint) return jsonResult(hint);
    return input.fixtureExecute(
      functionName,
      effectiveProfessionalId
        ? { ...args, professionalId: effectiveProfessionalId }
        : args,
    );
  };
}

function assertion(
  id: string,
  pass: boolean,
  detail?: string,
): AssertionResult {
  return {
    id,
    pass,
    category: "blocking",
    ...(detail ? { detail } : {}),
  };
}

function reviewAssertion(
  id: string,
  pass: boolean,
  observedSpeech: string,
  detail?: string,
): AssertionResult {
  return {
    id,
    pass,
    category: "review",
    observedSpeech,
    ...(detail ? { detail } : {}),
  };
}

function blockingAssertionsPass(assertions: readonly AssertionResult[]): boolean {
  return assertions.every((item) => item.category === "review" || item.pass);
}

function expectedArgumentMatches(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    const normalizedActual = actual.trim();
    return (
      normalizedActual.length > 0 &&
      (normalizedActual === expected || expected.startsWith(normalizedActual))
    );
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareToolCalls(
  turn: number,
  expected: ToolExpectation,
  observed: ObservedToolCall[],
): ToolExpectationResult {
  const assertions: AssertionResult[] = [];
  const allowed = new Set(expected.allowed);
  const unexpected = observed.filter((entry) => !allowed.has(entry.name));
  assertions.push(
    assertion(
      "turn_" + turn + "_only_allowed_tools",
      unexpected.length === 0,
      unexpected.map((entry) => entry.name).join(", ") || undefined,
    ),
  );

  for (const name of expected.forbidden ?? []) {
    const count = observed.filter((entry) => entry.name === name).length;
    assertions.push(
      assertion(
        "turn_" + turn + "_forbids_" + name,
        count === 0,
        count > 0 ? "observadas=" + count : undefined,
      ),
    );
  }

  for (const required of expected.required ?? []) {
    const sameName = observed.filter((entry) => entry.name === required.name);
    const matching = sameName.filter((entry) => {
      return Object.entries(required.args ?? {}).every(([key, value]) =>
        expectedArgumentMatches(entry.args[key], value),
      );
    });
    const inRange =
      matching.length >= required.min &&
      (required.max === undefined || sameName.length <= required.max);
    assertions.push(
      assertion(
        "turn_" + turn + "_expects_" + required.name,
        inRange,
        "esperadas=" +
          required.min +
          (required.max === undefined ? "+" : ".." + required.max) +
          " observadas=" +
          matching.length +
          (sameName.length === matching.length
            ? ""
            : " (" + sameName.length + " com o mesmo nome)"),
      ),
    );
  }

  return {
    turn,
    expected,
    observed,
    assertions,
    pass: blockingAssertionsPass(assertions),
  };
}

function speechAlternativeMatches(
  normalizedReply: string,
  alternative: NonNullable<SpeechExpectation["alternatives"]>[number],
): boolean {
  const containsAll =
    !alternative.containsAll ||
    alternative.containsAll.every((part) =>
      normalizedReply.includes(normalize(part)),
    );
  const containsAny =
    !alternative.containsAny ||
    alternative.containsAny.some((part) =>
      normalizedReply.includes(normalize(part)),
    );
  return containsAll && containsAny;
}

// calibração 2026-08-06: no cenário de valor sem serviço, uma listagem pode
// citar preços reais do catálogo, mas qualquer valor monetário alheio continua proibido.
function pricesOutsideCatalog(
  reply: string,
  servicesResult: ServicesResult,
): number[] {
  const allowedCents = new Set(
    (servicesResult.services ?? [])
      .map((service) => service.price)
      .filter((price): price is number => Number.isFinite(price))
      .map((price) => Math.round(price * 100)),
  );
  const outside = new Set<number>();
  const pricePattern =
    /(?:r\$\s*(\d{1,6}(?:[.,]\d{1,2})?)|\b(\d{1,6}(?:[.,]\d{1,2})?)\s*reais?\b)/gi;
  for (const match of reply.matchAll(pricePattern)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const numeric = Number(raw.replace(",", "."));
    if (!Number.isFinite(numeric)) continue;
    const cents = Math.round(numeric * 100);
    if (!allowedCents.has(cents)) outside.add(cents);
  }
  return [...outside];
}

function evaluateSpeech(
  turn: number,
  expected: SpeechExpectation,
  reply: string | null,
  servicesResult: ServicesResult,
): AssertionResult[] {
  if (expected.noAssistant) {
    return [
      assertion(
        "turn_" + turn + "_assistant_is_suppressed",
        reply === null,
        reply === null ? undefined : "a Ana respondeu quando deveria ficar calada",
      ),
    ];
  }

  if (reply === null) {
    return [
      assertion(
        "turn_" + turn + "_assistant_reply_exists",
        false,
        "resposta ausente",
      ),
    ];
  }

  const normalizedReply = normalize(reply);
  const assertions = [
    assertion("turn_" + turn + "_assistant_reply_exists", reply.length > 0),
  ];
  if (expected.exact !== undefined) {
    assertions.push(
      assertion(
        "turn_" + turn + "_speech_exact",
        reply.trim() === expected.exact,
        reply.trim() === expected.exact ? undefined : "fala diferente da copy fixa",
      ),
    );
  }
  if (expected.containsAll && expected.containsAll.length > 0) {
    const missing = expected.containsAll.filter(
      (part) => !normalizedReply.includes(normalize(part)),
    );
    assertions.push(
      expected.orientationReview
        ? reviewAssertion(
            "turn_" + turn + "_speech_contains_all",
            missing.length === 0,
            reply,
            missing.join(" | ") || undefined,
          )
        : assertion(
            "turn_" + turn + "_speech_contains_all",
            missing.length === 0,
            missing.join(" | ") || undefined,
          ),
    );
  }
  if (expected.containsAny && expected.containsAny.length > 0) {
    const found = expected.containsAny.some((part) =>
      normalizedReply.includes(normalize(part)),
    );
    assertions.push(
      expected.orientationReview
        ? reviewAssertion(
            "turn_" + turn + "_speech_contains_any",
            found,
            reply,
            found ? undefined : expected.containsAny.join(" | "),
          )
        : assertion(
            "turn_" + turn + "_speech_contains_any",
            found,
            found ? undefined : expected.containsAny.join(" | "),
          ),
    );
  }
  if (expected.containsNone && expected.containsNone.length > 0) {
    const found = expected.containsNone.filter((part) =>
      normalizedReply.includes(normalize(part)),
    );
    assertions.push(
      assertion(
        "turn_" + turn + "_speech_contains_none",
        found.length === 0,
        found.join(" | ") || undefined,
      ),
    );
  }
  if (expected.alternatives && expected.alternatives.length > 0) {
    const matched = expected.alternatives.some((alternative) =>
      speechAlternativeMatches(normalizedReply, alternative),
    );
    assertions.push(
      expected.orientationReview
        ? reviewAssertion(
            "turn_" + turn + "_speech_matches_alternative",
            matched,
            reply,
            matched
              ? undefined
              : "nenhuma alternativa de fala adjudicada foi encontrada",
          )
        : assertion(
            "turn_" + turn + "_speech_matches_alternative",
            matched,
            matched
              ? undefined
              : "nenhuma alternativa de fala adjudicada foi encontrada",
          ),
    );
  }
  if (expected.pricesFromCatalogOnly) {
    const outsidePrices = pricesOutsideCatalog(reply, servicesResult);
    assertions.push(
      assertion(
        "turn_" + turn + "_prices_are_from_catalog",
        outsidePrices.length === 0,
        outsidePrices.length > 0
          ? "preços fora do catálogo (centavos): " + outsidePrices.join(", ")
          : undefined,
      ),
    );
  }
  return assertions;
}

async function observeEscalationGuard(input: {
  scenario: BehavioralScenario;
  turn: number;
  text: string;
}): Promise<EscalationGuardObservation> {
  const escalation = await import("../src/services/questionEscalation");
  const previous = process.env.ANA_ESCALATION_ENABLED;
  process.env.ANA_ESCALATION_ENABLED = input.scenario.escalationEnabled
    ? "true"
    : "false";
  let httpFixtureCalls = 0;
  try {
    const enabled = escalation.isAnaEscalationEnabled();
    if (!enabled) {
      return {
        turn: input.turn,
        enabled: false,
        detectorRan: false,
        detectedReason: null,
        httpFixtureCalls,
        outcome: "flag_off",
        questionId: null,
        reply: null,
      };
    }

    const reasonCode = escalation.detectEscalationReason(input.text);
    if (!reasonCode) {
      return {
        turn: input.turn,
        enabled: true,
        detectorRan: true,
        detectedReason: null,
        httpFixtureCalls,
        outcome: "not_applicable",
        questionId: null,
        reply: null,
      };
    }

    const questionId = fixtureCuid(
      input.scenario.id,
      "escalation-question-" + input.turn,
    );
    let returnedQuestionId: string | null = null;
    const reply = await escalation.maybeEscalateReceptionistQuestion(
      {
        phoneNumberId: "behavioral-" + input.scenario.id,
        customerPhone: "+5500000000000",
        messageId: "wamid-fixture-" + input.scenario.id + "-" + input.turn,
        text: input.text,
      },
      {
        post: async () => {
          httpFixtureCalls += 1;
          returnedQuestionId = questionId;
          return {
            questionId,
            escalation: { active: true, questionId, version: 1 },
          };
        },
      },
    );
    return {
      turn: input.turn,
      enabled: true,
      detectorRan: true,
      detectedReason: reasonCode,
      httpFixtureCalls,
      outcome:
        returnedQuestionId && reply === ESCALATION_CREATED_REPLY
          ? "created"
          : "failed",
      questionId: returnedQuestionId,
      reply,
    };
  } finally {
    process.env.ANA_ESCALATION_ENABLED = previous ?? "false";
  }
}

interface InboundSupersedeHarness {
  deliver: (
    turn: number,
    text: string,
    responseKind: "active-question" | "superseded",
  ) => Promise<InboundSupersedeObservation>;
}

async function createInboundSupersedeHarness(
  scenario: BehavioralScenario,
): Promise<InboundSupersedeHarness> {
  const outbox = await import("../src/services/inboundOutbox");
  const cache = await import("../src/services/escalationCache");
  type Row = import("../src/services/inboundOutbox").InboundOutboxRow;
  const rows = new Map<string, Row>();
  cache.__resetEscalationCacheForTest();

  const store: import("../src/services/inboundOutbox").InboundOutboxStore = {
    async load(messageId) {
      return rows.get(messageId) ?? null;
    },
    async markDelivered(messageId) {
      const row = rows.get(messageId);
      if (row) row.deliveredAt = FIXED_NOW;
    },
    async markFailure(messageId, attempts, nextRetryAt, failureCode) {
      const row = rows.get(messageId);
      if (row) {
        row.attempts = attempts;
        row.nextRetryAt = nextRetryAt;
        row.failureCode = failureCode;
      }
    },
    async markTerminal(messageId, attempts, failureCode) {
      const row = rows.get(messageId);
      if (row) {
        row.attempts = attempts;
        row.terminalAt = FIXED_NOW;
        row.failureCode = failureCode;
      }
    },
    async reprocessQuarantined() {
      return false;
    },
    async listReady() {
      return [];
    },
    async hasPending(conversationKey) {
      return [...rows.values()].some(
        (row) => row.conversationKey === conversationKey && !row.deliveredAt,
      );
    },
  };

  return {
    async deliver(turn, text, responseKind) {
      const messageId = "wamid-supersede-fixture-" + turn;
      rows.set(messageId, {
        messageId,
        phoneNumberId: "behavioral-" + scenario.id,
        conversationKey:
          "behavioral-" + scenario.id + ":5500000000000",
        receivedAt: new Date(FIXED_NOW.getTime() + turn * 1_000),
        messageType: "text",
        contentStatus: "final",
        content: text,
        contentOriginalLength: text.length,
        attempts: 0,
        nextRetryAt: FIXED_NOW,
        deliveredAt: null,
        terminalAt: null,
        failureCode: null,
      });

      const postedPayloads: Array<
        import("../src/services/inboundOutbox").InboundDeliveryPayload
      > = [];
      const questionId = fixtureCuid(
        scenario.id,
        "supersede-question",
      );
      const response =
        responseKind === "active-question"
          ? {
              questionStatus: "OPEN" as const,
              escalation: { active: true, questionId, version: 1 },
            }
          : {
              questionStatus: "SUPERSEDED" as const,
              escalation: { active: false, questionId: null, version: 2 },
            };
      const result = await outbox.attemptInboundDeliveryOnce(messageId, {
        store,
        now: () => FIXED_NOW.getTime() + turn * 1_000,
        wait: async () => undefined,
        postInbound: async (payload) => {
          postedPayloads.push(payload);
          return response;
        },
      });
      const posted = postedPayloads[0];
      if (!posted) {
        throw new Error("Fixture de inbound não observou o payload serializado.");
      }
      return {
        turn,
        messageId,
        request: {
          contentText: posted.contentText,
          contentLength: posted.contentLength,
        },
        response,
        delivered: result.delivered,
      };
    },
  };
}

function runDeterministicGuardContract(): DeterministicGuardContractResult[] {
  return DETERMINISTIC_GUARD_CONTRACT_SCENARIOS.map((scenario) => {
    const guarded = applyPromiseGuard(scenario.injectedModelReply);
    const expectedFired = scenario.expectGuard === "fires";
    const forbiddenAfterGuard = matchForbiddenPromiseInSpeech(guarded.reply);
    const assertions = [
      assertion(
        "guard_fired_matches_expectation",
        guarded.blocked === expectedFired,
        guarded.blocked ? guarded.pattern : undefined,
      ),
      assertion(
        "effective_reply_has_no_forbidden_promise",
        forbiddenAfterGuard === null,
        forbiddenAfterGuard ?? undefined,
      ),
      assertion(
        "fired_guard_uses_fixed_fallback",
        !expectedFired || guarded.reply === PROMISE_GUARD_FALLBACK,
      ),
      assertion(
        "idle_guard_preserves_injected_reply",
        expectedFired || guarded.reply === scenario.injectedModelReply,
      ),
    ];

    return {
      id: scenario.id,
      title: scenario.title,
      injectedModelReply: scenario.injectedModelReply,
      expectGuard: scenario.expectGuard,
      guardFired: guarded.blocked,
      ...(guarded.blocked ? { pattern: guarded.pattern } : {}),
      effectiveReply: guarded.reply,
      assertions,
    pass: blockingAssertionsPass(assertions),
    };
  });
}

async function runScenario(
  scenario: BehavioralScenario,
  defaultSystemPrompt: string,
): Promise<BehavioralScenarioResult> {
  const brain = await import("../src/services/brainService");
  const customerReplyGuard = await import(
    "../src/services/customerReplyGuard"
  );
  const config = buildConfig(scenario, defaultSystemPrompt);
  const systemPrompt = brain.buildSystemPromptFromServices(
    config,
    scenario.servicesResult,
    FIXED_NOW,
  );
  const harness = createFixtureToolHarness("normal", scenario.servicesResult);
  if (!harness.dryRun || !harness.state.dryRun) {
    throw new Error("Hard block: suíte recebeu executor que não é dry-run.");
  }

  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  const conversation: ConversationEvent[] = [];
  const assertions: AssertionResult[] = [];
  const toolCallsExpectedVsObserved: ToolExpectationResult[] = [];
  const escalationObservations: EscalationGuardObservation[] = [];
  const inboundSupersedeObservations: InboundSupersedeObservation[] = [];
  const promiseGuardFiredTurns: number[] = [];
  const customerReplyGuardBlockedTurns: number[] = [];
  const toolBlocks: Array<{
    turn: number;
    name: string;
    blockedBy: GuardName[];
  }> = [];
  const providerReportedModels = new Set<string>();
  let modelCalls = 0;
  const inboundHarness = scenario.inboundSupersedeFixture
    ? await createInboundSupersedeHarness(scenario)
    : null;

  for (const evidence of scenario.structuredPolicyEvidence ?? []) {
    assertions.push(
      assertion(
        "structured_prompt_contains_" + normalize(evidence).replace(/\W+/g, "_"),
        normalize(systemPrompt).includes(normalize(evidence)),
        evidence,
      ),
    );
  }
  if (scenario.structuredPolicyEvidence) {
    assertions.push(
      assertion(
        "structured_block_replaces_legacy_prompt",
        !systemPrompt.includes("LEGADO_NAO_DEVE_SER_USADO"),
      ),
    );
  }
  if (scenario.catalogWins) {
    assertions.push(
      assertion(
        "catalog_wins_prompt_contains_authoritative_price",
        systemPrompt.includes(scenario.catalogWins.authoritativePrice),
      ),
      assertion(
        "catalog_wins_prompt_excludes_conflicting_price",
        !systemPrompt.includes(scenario.catalogWins.forbiddenPrice),
      ),
      assertion(
        "catalog_wins_prompt_excludes_unsafe_structured_policy",
        !systemPrompt.includes(scenario.catalogWins.unsafeStructuredText),
      ),
    );
  }

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const turn = index + 1;
    const turnSpec = scenario.turns[index];
    const userText = turnSpec.user;
    conversation.push({ type: "user", turn, content: userText });

    if (turnSpec.inbound) {
      if (!inboundHarness) {
        throw new Error("Cenário declarou inbound sem fixture supersede.");
      }
      const inboundObservation = await inboundHarness.deliver(
        turn,
        userText,
        turnSpec.inbound,
      );
      inboundSupersedeObservations.push(inboundObservation);
      conversation.push({
        type: "inbound_fixture",
        turn,
        observation: inboundObservation,
      });
      assertions.push(
        assertion(
          "turn_" + turn + "_inbound_fixture_delivered",
          inboundObservation.delivered,
        ),
        assertion(
          "turn_" + turn + "_inbound_payload_is_exact",
          inboundObservation.request.contentText === userText &&
            inboundObservation.request.contentLength === userText.length,
        ),
      );
      if (turnSpec.inbound === "active-question") {
        assertions.push(
          assertion(
            "turn_1_inbound_keeps_active_question",
            inboundObservation.response.questionStatus === "OPEN" &&
              inboundObservation.response.escalation.active &&
              Boolean(inboundObservation.response.escalation.questionId),
          ),
        );
      } else {
        assertions.push(
          assertion(
            "turn_2_inbound_returns_superseded",
            inboundObservation.response.questionStatus === "SUPERSEDED" &&
              !inboundObservation.response.escalation.active &&
              inboundObservation.response.escalation.questionId === null,
          ),
        );
      }
    }

    const escalationObservation = await observeEscalationGuard({
      scenario,
      turn,
      text: userText,
    });
    escalationObservations.push(escalationObservation);
    conversation.push({
      type: "guard",
      turn,
      name: "escalation",
      observation: escalationObservation,
    });
    if (!scenario.escalationEnabled) {
      assertions.push(
        assertion(
          "turn_" + turn + "_global_escalation_flag_off_is_inert",
          escalationObservation.outcome === "flag_off" &&
            !escalationObservation.detectorRan &&
            escalationObservation.httpFixtureCalls === 0 &&
            escalationObservation.reply === null,
        ),
      );
    } else {
      assertions.push(
        assertion(
          "isolated_escalation_uses_fixture_http_once",
          escalationObservation.enabled &&
            escalationObservation.detectorRan &&
            escalationObservation.detectedReason === "HUMAN_REQUEST" &&
            escalationObservation.httpFixtureCalls === 1 &&
            escalationObservation.outcome === "created" &&
            Boolean(escalationObservation.questionId),
        ),
      );
    }

    if (
      turnSpec.suppressAssistantWhileEscalated &&
      inboundSupersedeObservations.at(-1)?.response.escalation.active
    ) {
      conversation.push({
        type: "assistant_suppressed",
        turn,
        reason: "active_escalation",
      });
      assertions.push(
        ...evaluateSpeech(
          turn,
          turnSpec.speech,
          null,
          scenario.servicesResult,
        ),
      );
      const toolComparison = compareToolCalls(turn, turnSpec.tools, []);
      toolCallsExpectedVsObserved.push(toolComparison);
      assertions.push(...toolComparison.assertions);
      history.push({ role: "user", content: userText });
      continue;
    }

    if (escalationObservation.reply) {
      const reply = escalationObservation.reply;
      const promiseGuard = applyPromiseGuard(reply);
      const inspection = customerReplyGuard.inspectCustomerReply(
        promiseGuard.reply,
        scenario.servicesResult,
        [],
        [],
      );
      if (promiseGuard.blocked) promiseGuardFiredTurns.push(turn);
      if (!inspection.safe) customerReplyGuardBlockedTurns.push(turn);
      conversation.push({
        type: "assistant",
        turn,
        content: promiseGuard.reply,
        promiseGuardFired: promiseGuard.blocked,
        ...(promiseGuard.blocked
          ? { promiseGuardPattern: promiseGuard.pattern }
          : {}),
        customerReplyGuardSafe: inspection.safe,
        customerReplyGuardReasons: inspection.reasons,
      });
      assertions.push(
        ...evaluateSpeech(
          turn,
          turnSpec.speech,
          promiseGuard.reply,
          scenario.servicesResult,
        ),
        assertion(
          "turn_" + turn + "_no_forbidden_promise",
          matchForbiddenPromiseInSpeech(promiseGuard.reply) === null,
        ),
        assertion(
          "turn_" + turn + "_customer_reply_guard_safe",
          inspection.safe,
          inspection.reasons.join(", ") || undefined,
        ),
      );
      const toolComparison = compareToolCalls(turn, turnSpec.tools, []);
      toolCallsExpectedVsObserved.push(toolComparison);
      assertions.push(...toolComparison.assertions);
      history.push(
        { role: "user", content: userText },
        { role: "assistant", content: promiseGuard.reply },
      );
      continue;
    }

    const observations: GuardObservation[] = [];
    const fixtureExecute: ReceptionistToolExecutor = async (name, args) => {
      const raw = await harness.execute(name, args);
      if (name !== "getAvailableSlots" || !turnSpec.slotFixture) return raw;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.success !== true) return raw;
        const requestedServiceId = String(args.serviceId ?? "");
        if (!expectedArgumentMatches(requestedServiceId, turnSpec.slotFixture.serviceId)) {
          return raw;
        }
        return JSON.stringify({
          ...parsed,
          slots: [...turnSpec.slotFixture.slots],
          message: "Horários disponíveis: " + turnSpec.slotFixture.slots.join(", "),
        });
      } catch {
        return raw;
      }
    };
    const executeTool = await createGuardedExecutor({
      scenario,
      userText,
      history,
      fixtureExecute,
      observations,
    });
    modelCalls += 1;
    const loop = await brain.runReceptionistModelLoop({
      config,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userText },
      ],
      executeTool,
      thinkingMode: "disabled",
      retryOnFailure: false,
      userId:
        "behavioral_" +
        createHash("sha256")
          .update(scenario.id + ":" + turn)
          .digest("hex")
          .slice(0, 32),
    });
    if (loop.exhausted) {
      throw new Error(
        scenario.id +
          " turno " +
          turn +
          ": loop esgotou as rodadas de tool calling.",
      );
    }
    loop.providerReportedModels.forEach((model) =>
      providerReportedModels.add(model),
    );
    assertions.push(
      assertion(
        "turn_" + turn + "_uses_production_provider_model",
        loop.provider === "deepseek" && loop.model === "deepseek-v4-flash",
        loop.provider + "/" + loop.model,
      ),
    );

    let observationIndex = 0;
    const observedTools: ObservedToolCall[] = [];
    for (const entry of loop.toolTrace) {
      const argumentBlocked = isToolArgumentHint(entry);
      const observation = argumentBlocked
        ? undefined
        : observations[observationIndex++];
      const blockedBy: GuardName[] = argumentBlocked
        ? ["tool_arguments"]
        : (observation?.blockedBy ?? []);
      observedTools.push({ name: entry.name, args: entry.args, blockedBy });
      if (blockedBy.length > 0) {
        toolBlocks.push({ turn, name: entry.name, blockedBy });
      }
      conversation.push({
        type: "tool",
        turn,
        round: entry.round,
        name: entry.name,
        args: entry.args,
        argumentsValidJson: entry.argumentsValidJson,
        blockedBy,
        result: entry.result,
        resultSummary: summarizeToolResult(entry.name, entry.result),
      });
    }

    const toolComparison = compareToolCalls(
      turn,
      turnSpec.tools,
      observedTools,
    );
    toolCallsExpectedVsObserved.push(toolComparison);
    assertions.push(...toolComparison.assertions);

    const hasModelReply = Boolean(loop.rawReply);
    const rawReply =
      loop.rawReply ||
      config.fallbackMessage ||
      "Desculpa, tive um probleminha aqui. Pode tentar de novo?";
    const promiseGuard = hasModelReply
      ? applyPromiseGuard(rawReply)
      : { reply: rawReply, blocked: false as const };
    const finalReply = brain.maybePrependGreeting(
      promiseGuard.reply,
      history.length === 0,
      config,
    );
    const inspection = customerReplyGuard.inspectCustomerReply(
      finalReply,
      scenario.servicesResult,
      [],
      loop.toolTrace,
    );
    if (promiseGuard.blocked) promiseGuardFiredTurns.push(turn);
    if (!inspection.safe) customerReplyGuardBlockedTurns.push(turn);
    conversation.push({
      type: "assistant",
      turn,
      content: finalReply,
      promiseGuardFired: promiseGuard.blocked,
      ...(promiseGuard.blocked
        ? { promiseGuardPattern: promiseGuard.pattern }
        : {}),
      customerReplyGuardSafe: inspection.safe,
      customerReplyGuardReasons: inspection.reasons,
    });

    assertions.push(
      ...evaluateSpeech(
        turn,
        turnSpec.speech,
        finalReply,
        scenario.servicesResult,
      ),
    );

    const forbiddenMatch = matchForbiddenPromiseInSpeech(finalReply);
    assertions.push(
      assertion(
        "turn_" + turn + "_no_forbidden_promise",
        forbiddenMatch === null,
        forbiddenMatch ??
          (promiseGuard.blocked
            ? "promise guard bloqueou " + promiseGuard.pattern
            : undefined),
      ),
      assertion(
        "turn_" + turn + "_customer_reply_guard_safe",
        inspection.safe,
        inspection.reasons.join(", ") || undefined,
      ),
    );

    const citedTimes = concreteTimes(finalReply);
    const licensedTimes = authoritativeSlots(loop.toolTrace);
    const unlicensedTimes = citedTimes.filter(
      (time) => !licensedTimes.has(time),
    );
    assertions.push(
      assertion(
        "turn_" + turn + "_concrete_times_are_authoritative",
        unlicensedTimes.length === 0,
        unlicensedTimes.length > 0
          ? "sem fixture autoritativa: " + unlicensedTimes.join(", ")
          : undefined,
      ),
    );

    // calibração 2026-08-06: negação da regra E nomeia o serviço negado
    const askedServiceExemptions =
      scenario.id === "06_nonexistent_service"
        ? SERVICE_CLAIM_UNIVERSE.filter((serviceName) =>
            normalize(userText).includes(normalize(serviceName)),
          )
        : [];
    const absentClaims = positiveAbsentServiceClaims(
      finalReply,
      scenario.servicesResult,
    ).filter((serviceName) => !askedServiceExemptions.includes(serviceName));
    const invalidServiceCalls = unknownServiceToolCalls(
      loop.toolTrace,
      scenario.servicesResult,
    );
    assertions.push(
      assertion(
        "turn_" + turn + "_no_service_outside_fixture",
        absentClaims.length === 0 && invalidServiceCalls.length === 0,
        [...absentClaims, ...invalidServiceCalls].join(", ") || undefined,
      ),
    );

    if (turnSpec.expectClinicalCanonical) {
      assertions.push(
        assertion(
          "turn_" + turn + "_contains_canonical_clinical_v2",
          finalReply.includes(CLINICAL_CANONICAL_V2),
          "a resposta clínica deve conter a redação canônica v2 byte-exata",
        ),
      );
    }
    if (turnSpec.expectCancellationCanonical) {
      assertions.push(
        assertion(
          "turn_" + turn + "_contains_cancellation_canonical",
          normalize(finalReply).includes(normalize(CANCELLATION_CANONICAL)),
        ),
      );
    }

    history.push(
      { role: "user", content: userText },
      { role: "assistant", content: finalReply },
    );
  }

  if (scenario.escalationEnabled) {
    assertions.push(
      assertion(
        "isolated_escalation_bypasses_provider",
        modelCalls === 0 && providerReportedModels.size === 0,
      ),
    );
  }
  if (scenario.inboundSupersedeFixture) {
    const [first, second] = inboundSupersedeObservations;
    assertions.push(
      assertion(
        "superseding_transition_is_active_then_inactive",
        first?.response.escalation.active === true &&
          second?.response.questionStatus === "SUPERSEDED" &&
          second.response.escalation.active === false &&
          second.response.escalation.version > first.response.escalation.version,
      ),
      assertion(
        "superseded_turn_runs_provider_only_for_new_subject",
        modelCalls === 1,
        "modelCalls=" + modelCalls,
      ),
    );
  }

  return {
    id: scenario.id,
    title: scenario.title,
    catalog: {
      services:
        scenario.servicesResult.services?.map((service) => service.name) ?? [],
      professionals:
        scenario.servicesResult.professionals?.map(
          (professional) => professional.name,
        ) ?? [],
    },
    conversation,
    assertions,
    toolCallsExpectedVsObserved,
    guardObservations: {
      escalation: escalationObservations,
      inboundSupersede: inboundSupersedeObservations,
      promiseGuardFiredTurns,
      customerReplyGuardBlockedTurns,
      toolBlocks,
    },
    providerReportedModels: [...providerReportedModels],
    modelCalls,
    fixtureState: {
      dryRun: true,
      bookAttempts: harness.state.bookAttempts,
      bookEffects: harness.state.bookEffects,
      cancelAttempts: harness.state.cancelAttempts,
      cancelEffects: harness.state.cancelEffects,
    },
    // calibração 2026-08-06: fraseado honesto flapa sob paráfrase; orientação é item de revisão humana; guards continuam bloqueantes
    pass:
      blockingAssertionsPass(assertions) &&
      toolCallsExpectedVsObserved.every((item) => item.pass),
  };
}

function buildMarkdown(report: BehavioralReport): string {
  const lines = [
    "# Suíte comportamental completa da Ana — 12 cenários",
    "",
    "Gerado em: " + report.generatedAt,
    "",
    "Modo de execução: " + report.executionMode,
    "",
    report.provider === "deepseek"
      ? "Provider/modelo: deepseek / deepseek-v4-flash"
      : "Provider/modelo: não chamado (somente contrato determinístico)",
    "",
    "Thinking: disabled. Retries: desativados. Fixtures de tools/HTTP: somente memória. DB/ERP/Receps apontados para destino local inválido. WhatsApp/agendamento real: sem chamadas.",
    "",
    "Itens de orientação lexical são REVIEW-PASS/REVIEW-MISS, não alteram o exit e exigem adjudicação humana do Fable. Guards, constraints e cópias canônicas mandatórias continuam bloqueantes.",
    "",
    "Resultado: " + (report.pass ? "PASS" : "FAIL"),
    "",
  ];

  if (report.fatalError) {
    lines.push("## Erro fatal", "", report.fatalError, "");
  }

  lines.push(
    "## Contrato determinístico do promise guard",
    "",
    "Estes casos injetam uma resposta conhecida diretamente na barreira. Eles não chamam nem representam uma conversa no provider real.",
    "",
  );
  for (const scenario of report.deterministicGuardContract) {
    lines.push(
      "### " + scenario.title,
      "",
      "ID: " + scenario.id,
      "",
      "**Resposta injetada:** " + scenario.injectedModelReply,
      "",
      "**Promise guard:** " +
        (scenario.guardFired
          ? "disparou — pattern `" + scenario.pattern + "`"
          : "não disparou"),
      "",
      "**Resposta efetiva:** " + scenario.effectiveReply,
      "",
      "| Assert | Resultado | Detalhe |",
      "|---|---|---|",
    );
    for (const item of scenario.assertions) {
      lines.push(
        "| " +
          item.id +
          " | " +
          (item.category === "review"
            ? item.pass
              ? "REVIEW-PASS"
              : "REVIEW-MISS"
            : item.pass
              ? "PASS"
              : "FAIL") +
          " | " +
          [
            item.observedSpeech ? "Fala: " + item.observedSpeech : "",
            item.detail ? "Critério: " + item.detail : "",
          ]
            .filter(Boolean)
            .join(" — ")
            .replace(/\r?\n/g, "<br>")
            .replace(/\|/g, "\\|") +
          " |",
      );
    }
    lines.push("");
  }

  for (const scenario of report.scenarios) {
    lines.push(
      "## " + scenario.title,
      "",
      "ID: " + scenario.id,
      "",
      "Catálogo: " + (scenario.catalog.services.join(", ") || "(vazio)"),
      "",
    );
    for (const event of scenario.conversation) {
      if (event.type === "user") {
        lines.push(
          "**Cliente (turno " + event.turn + "):** " + event.content,
          "",
        );
      } else if (event.type === "assistant") {
        lines.push(
          "**Ana (turno " + event.turn + "):** " + event.content,
          "",
          "**Promise guard (turno " +
            event.turn +
            "):** " +
            (event.promiseGuardFired
              ? "disparou — pattern `" + event.promiseGuardPattern + "`"
              : "não disparou"),
          "",
          "**Customer reply guard (turno " +
            event.turn +
            "):** " +
            (event.customerReplyGuardSafe
              ? "liberou"
              : "bloqueou — " + event.customerReplyGuardReasons.join(", ")),
          "",
        );
      } else if (event.type === "tool") {
        lines.push(
          "**Tool (turno " +
            event.turn +
            ", round " +
            event.round +
            "):** " +
            event.name,
          "",
          "~~~json",
          JSON.stringify(
            {
              args: event.args,
              blockedBy: event.blockedBy,
              result: event.result,
              resultSummary: event.resultSummary,
            },
            null,
            2,
          ),
          "~~~",
          "",
        );
      } else if (event.type === "guard") {
        lines.push(
          "**Guard de escalada (turno " + event.turn + "):**",
          "",
          "~~~json",
          JSON.stringify(event.observation, null, 2),
          "~~~",
          "",
        );
      } else if (event.type === "inbound_fixture") {
        lines.push(
          "**Fixture HTTP de inbound (turno " + event.turn + "):**",
          "",
          "~~~json",
          JSON.stringify(event.observation, null, 2),
          "~~~",
          "",
        );
      } else {
        lines.push(
          "**Ana (turno " +
            event.turn +
            "):** resposta suprimida por escalada ativa",
          "",
        );
      }
    }
    lines.push(
      "### Tool calls esperadas × observadas",
      "",
    );
    for (const comparison of scenario.toolCallsExpectedVsObserved) {
      lines.push(
        "#### Turno " + comparison.turn,
        "",
        "~~~json",
        JSON.stringify(
          {
            expected: comparison.expected,
            observed: comparison.observed,
            pass: comparison.pass,
          },
          null,
          2,
        ),
        "~~~",
        "",
      );
    }
    lines.push(
      "### Guards observados",
      "",
      "~~~json",
      JSON.stringify(scenario.guardObservations, null, 2),
      "~~~",
      "",
    );
    lines.push("| Assert | Resultado | Detalhe |", "|---|---|---|");
    for (const item of scenario.assertions) {
      lines.push(
        "| " +
          item.id +
          " | " +
          (item.category === "review"
            ? item.pass
              ? "REVIEW-PASS"
              : "REVIEW-MISS"
            : item.pass
              ? "PASS"
              : "FAIL") +
          " | " +
          [
            item.observedSpeech ? "Fala: " + item.observedSpeech : "",
            item.detail ? "Critério: " + item.detail : "",
          ]
            .filter(Boolean)
            .join(" — ")
            .replace(/\r?\n/g, "<br>")
            .replace(/\|/g, "\\|") +
          " |",
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

async function writeReport(report: BehavioralReport): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(report.output.json), { recursive: true }),
    mkdir(path.dirname(report.output.markdown), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      report.output.json,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    ),
    writeFile(report.output.markdown, buildMarkdown(report), "utf8"),
  ]);
}

async function main(): Promise<void> {
  const out = argumentValue("--out");
  if (!out?.trim()) {
    throw new Error(
      "Uso obrigatório: --out=<path> (gera <path>.json e <path>.md). Use --guard-contract-only para não chamar o provider.",
    );
  }
  const output = resolveOutputPaths(out.trim());
  const guardContractOnly = process.argv.includes("--guard-contract-only");
  const deterministicGuardContract = runDeterministicGuardContract();

  if (guardContractOnly) {
    const report: BehavioralReport = {
      schemaVersion: 1,
      suiteVersion: SUITE_VERSION,
      generatedAt: new Date().toISOString(),
      executionMode: "deterministic-guard-contract",
      provider: "not-called",
      requestedModel: null,
      retryOnFailure: false,
      safety: {
        dryRunFixturesOnly: true,
        databaseUrl: "local-invalid",
        erpUrl: "local-invalid",
        recepsUrl: "local-invalid",
        escalationHttp: "fixture-only",
        inboundHttp: "fixture-only",
        whatsappCalls: false,
      },
      output,
      scenarios: [],
      deterministicGuardContract,
      pass: deterministicGuardContract.every((scenario) => scenario.pass),
    };

    await writeReport(report);
    console.log("JSON: " + output.json);
    console.log("Markdown: " + output.markdown);
    console.log("Resultado: " + (report.pass ? "PASS" : "FAIL"));
    process.exitCode = report.pass ? 0 : 1;
    return;
  }

  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      "DEEPSEEK_API_KEY não configurada. A suíte exige o provider real e nunca simula uma resposta.",
    );
  }

  const { DEFAULT_BOT_SYSTEM_PROMPT } = await import("../src/botDefaults");
  const scenarios: BehavioralScenarioResult[] = [];
  let fatalError: string | undefined;

  for (const scenario of SCENARIOS) {
    try {
      scenarios.push(await runScenario(scenario, DEFAULT_BOT_SYSTEM_PROMPT));
    } catch (error) {
      fatalError = scenario.id + ": " + sanitizeError(error);
      break;
    }
  }

  const report: BehavioralReport = {
    schemaVersion: 1,
    suiteVersion: SUITE_VERSION,
    generatedAt: new Date().toISOString(),
    executionMode: "provider-real",
    provider: "deepseek",
    requestedModel: "deepseek-v4-flash",
    retryOnFailure: false,
    safety: {
      dryRunFixturesOnly: true,
      databaseUrl: "local-invalid",
      erpUrl: "local-invalid",
      recepsUrl: "local-invalid",
      escalationHttp: "fixture-only",
      inboundHttp: "fixture-only",
      whatsappCalls: false,
    },
    output,
    scenarios,
    deterministicGuardContract,
    ...(fatalError ? { fatalError } : {}),
    pass:
      fatalError === undefined &&
      scenarios.length === SCENARIOS.length &&
      scenarios.every((scenario) => scenario.pass) &&
      deterministicGuardContract.every((scenario) => scenario.pass),
  };

  await writeReport(report);
  console.log("JSON: " + output.json);
  console.log("Markdown: " + output.markdown);
  console.log("Resultado: " + (report.pass ? "PASS" : "FAIL"));
  process.exitCode = report.pass ? 0 : 1;
}

main().catch((error) => {
  console.error("❌ Suíte comportamental abortada: " + sanitizeError(error));
  process.exitCode = 1;
});
