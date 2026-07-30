import Anthropic from '@anthropic-ai/sdk';
import { Sentry } from '../observability/sentry';
import type { TenantBotConfig } from '../configProvider';
import { DEFAULT_FALLBACK_MESSAGE } from '../botDefaults';
import {
  callAnthropicWithRetry,
  type AnthropicRetryPolicy,
} from '../utils/anthropicRetry';
import { isCaptured } from '../observability/captured';
import { addMessage, buildConversationKey, getHistory } from './contextManager';
import { getAvailableSlots, bookAppointment } from './calendarService';
import {
  getSalesConfig,
  renderPlansBlock,
  type SalesConfig,
} from '../salesConfigProvider';
import {
  buildSignupLink,
  createPrefilledSignupLink,
  PREFILL_NICHES,
  registerQualifiedLead,
  handoffToHuman,
  type QualifiedLeadPayload,
} from './salesTools';
import {
  markFollowupDemoStage,
  markFollowupPostLink,
  scheduleFollowup,
} from './salesFollowups';
import {
  capturePartnerAttribution,
  emitSalesEvent,
} from './salesEvents';
import { detectChannelRequest, setChannelPref } from '../voice/channelPref';
import {
  matchAdOpening,
  matchPartnerMention,
  pickOpenerScript,
} from './salesOpeners';
import {
  getConversationPartnerSlug,
  rememberConversationPartnerSlug,
} from './salesPartnerState';
import { resolveDemoServiceId } from './demoScheduling';
import { sendDemoVideo } from '../media/demoVideo';
import { getConversationAdHeadline } from './salesAdState';

/**
 * Brain de VENDAS da Renata (Workstream B). Provider Anthropic (claude-sonnet-5),
 * tool calling + prompt caching. SEPARADO do brain de recepção (que fica 100%
 * intocado). Preço NUNCA vem da memória do modelo — sai do {{PLANOS}} (sales-config).
 * Pula o service-gate da recepção (não se aplica). Guardrail A do calendarService
 * continua valendo no scheduleDemo (bookAppointment embute horários reais na falha).
 */

const clientCache = new Map<string, Anthropic>();

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada — necessária para o brain de vendas.');
  }
  const cached = clientCache.get(apiKey);
  if (cached) return cached;
  const client = new Anthropic({ apiKey });
  clientCache.set(apiKey, client);
  return client;
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 500;
  return Math.max(Math.round(value), 100);
}

function getFallbackMessage(config: TenantBotConfig): string {
  return config.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE;
}

const PLANOS_PLACEHOLDER = '{{PLANOS}}';

/** Bloco seguro quando a sales-config está indisponível — NUNCA inventa preço. */
const PLANS_UNAVAILABLE_BLOCK =
  'PLANOS E PREÇOS: não consegui puxar os valores agora. NÃO invente preço, plano nem trial. Se perguntarem valor, diga que confirma em instantes ou ofereça falar com o Victor.';

/**
 * Bloco ESTÁVEL do system prompt (persona + manual + {{PLANOS}}) — é o que o
 * prompt caching barateia. Puro/testável. `plansBlock` já vem renderizado (ou o
 * fallback seguro). Substitui {{PLANOS}} no manual salvo; se o placeholder não
 * existir, anexa o bloco no fim (defesa).
 */
export function buildStableSalesPrompt(
  config: TenantBotConfig,
  plansBlock: string
): string {
  const botName = config.botName.trim() || 'Renata';
  const manual = config.systemPrompt.includes(PLANOS_PLACEHOLDER)
    ? config.systemPrompt.split(PLANOS_PLACEHOLDER).join(plansBlock)
    : `${config.systemPrompt}\n\n${plansBlock}`;

  return `IDENTIDADE: Seu nome é ${botName}. Se houver qualquer conflito com instruções antigas, priorize este nome.

${manual}`;
}

export interface VolatileSalesContext {
  partnerSlug?: string | null;
  isFirstResponse?: boolean;
  adHeadline?: string | null;
}

/** Bloco VOLÁTIL (tempo + origem do lead) — fica FORA do prompt cacheado. */
export function buildVolatileSalesPrompt(
  config: TenantBotConfig,
  context: VolatileSalesContext = {}
): string {
  const now = new Date();
  const today = now.toLocaleDateString('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const currentTime = now.toLocaleTimeString('pt-BR', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const currentYear = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, year: 'numeric' }).format(now)
  );
  const temporal = `CONTEXTO TEMPORAL (para agendar demonstrações): Hoje é ${today}, são ${currentTime}. O ano atual é ${currentYear}. Datas relativas (amanhã, semana que vem) são a partir de HOJE. Se citarem só dia/mês, assuma ${currentYear}.`;

  const volatileBlocks = [temporal];

  if (context.partnerSlug) {
    const partnerInstruction = context.isFirstResponse
      ? `Esta é a PRIMEIRA resposta. Comece reconhecendo somente a indicação (por exemplo: "Que bom que a @${context.partnerSlug} te indicou!"), sem afirmar que a parceira usa, testou ou aprovou o produto e sem inventar intimidade. Em seguida, continue o fluxo normal de qualificação.`
      : 'A indicação já faz parte do contexto; não repita a saudação de origem em toda resposta.';

    volatileBlocks.push(`ORIGEM DE PARCEIRA (detectada deterministicamente na primeira mensagem): @${context.partnerSlug}.
${partnerInstruction}
Não invente benefício, prazo de trial, lucro ou resultado a partir desta origem. Este contexto NÃO substitui nem altera a regra e a ordem da disclosure B2a do manual.`);
  }

  if (context.adHeadline) {
    volatileBlocks.push(`HEADLINE DO ANÚNCIO (contexto volátil, não é uma afirmação do lead): ${context.adHeadline.slice(0, 200)}
Use somente como pista para CONFIRMAR a trilha provável (sistema, IA ou ambos), em vez de perguntar no escuro. Não afirme que a pessoa quer algo que ela não disse. Não invente oferta, prazo, trial, funcionalidade ou resultado a partir da headline. Este contexto NÃO altera a regra nem a ordem da disclosure B2a do manual.`);
  }

  return volatileBlocks.join('\n\n');
}

export const SALES_TOOLS: Anthropic.Tool[] = [
  {
    name: 'getAvailableSlots',
    description:
      'Consulta horários livres para uma demonstração ao vivo com o Victor. Esta é a ÚLTIMA etapa da escada: use SOMENTE quando a clínica tem 3+ profissionais, o interesse é no plano Pro, ou a pessoa pediu explicitamente falar com humano. Consulte antes de oferecer e apresente DOIS horários concretos; nunca pergunte data em aberto nem invente horário.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            'Data no formato YYYY-MM-DD (use o ano atual do contexto temporal). Nunca use anos anteriores.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'scheduleDemo',
    description:
      'Agenda a demonstração ao vivo de 30min com o Victor. Use SOMENTE quando a clínica tem 3+ profissionais, o interesse é no plano Pro, ou a pessoa pediu explicitamente falar com humano, e só APÓS ela escolher um dos horários reais oferecidos por getAvailableSlots. Nunca peça data em aberto. Telefone e nome são preenchidos automaticamente.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Data YYYY-MM-DD (ano atual).' },
        time: { type: 'string', description: 'Horário HH:MM.' },
      },
      required: ['date', 'time'],
    },
  },
  {
    name: 'sendSignupLink',
    description:
      'Gera o link de cadastro do trial grátis (sem cartão) de um plano. Retorna a URL para você enviar ao lead. NÃO gere link do plano em fase de testes (ele volta com a lista de espera).',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'Slug do plano ("essencial" ou "pro"; "atendente-ia" está em testes). Use o slug exato do bloco PLANOS.',
        },
        interval: {
          type: 'string',
          enum: ['monthly', 'annual'],
          description: 'Cobrança mensal (padrão) ou anual. Omita para mensal.',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'sendPrefilledSignup',
    description:
      'Gera ou reenvia o MESMO link vigente de cadastro JÁ PREENCHIDO com os dados do lead (e-mail, nome, clínica, plano e, quando descobertos, nicho e número de profissionais); informar o nicho faz o cadastro já chegar com uma agenda pronta. Ela só precisa criar a senha. PREFIRA esta tool ao sendSignupLink sempre que você souber o e-mail, inclusive se ela pedir "manda o link de novo" ou disser que perdeu o link. Antes de chamar, CONFIRME o e-mail repetindo de volta pra ela ("só confirma pra mim: maria@gmail.com, certo?"). Se ela não quiser dar o e-mail, use o sendSignupLink e não insista. Retorna a URL pra você enviar.',
    input_schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'E-mail do lead, JÁ CONFIRMADO com ela na conversa.',
        },
        name: { type: 'string', description: 'Nome do lead, se souber.' },
        clinicName: { type: 'string', description: 'Nome da clínica, se souber.' },
        plan: {
          type: 'string',
          description:
            'Slug do plano ("essencial" ou "pro"; "atendente-ia" está em testes). Use o slug exato do bloco PLANOS.',
        },
        interval: {
          type: 'string',
          enum: ['monthly', 'annual'],
          description: 'Cobrança mensal (padrão) ou anual. Omita para mensal.',
        },
        niche: {
          type: 'string',
          enum: [...PREFILL_NICHES],
          description: 'Nicho da clínica que você descobriu na qualificação.',
        },
        professionalsCount: {
          type: 'integer',
          description: 'Quantos profissionais atendem, se souber.',
        },
      },
      required: ['email', 'plan'],
    },
  },
  {
    name: 'registerQualifiedLead',
    description:
      'Registra o que você descobriu sobre o lead (qualificação). Chame quando a qualificação fechar, mesmo sem venda. O telefone é preenchido automaticamente.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome do lead, se souber.' },
        clinicName: { type: 'string', description: 'Nome da clínica, se souber.' },
        professionalsCount: {
          type: 'integer',
          description: 'Quantos profissionais atendem na clínica.',
        },
        whatsappVolume: {
          type: 'string',
          description: 'Volume de WhatsApp/dia ou atendimentos/semana (texto livre).',
        },
        currentSystem: {
          type: 'string',
          description: 'Como organiza hoje (papel, planilha, outro sistema — qual).',
        },
        mainPain: { type: 'string', description: 'A dor principal que fez o lead clicar.' },
        interest: {
          type: 'string',
          enum: ['sistema', 'ia', 'ambos'],
          description:
            'Trilha escolhida pela lead na abertura: sistema, atendente IA ou ambos.',
        },
        recommendedPlan: {
          type: 'string',
          description: 'Slug do plano recomendado ("essencial" ou "pro").',
        },
        score: { type: 'integer', description: 'Nota de qualificação de 0 a 100 (opcional).' },
        status: {
          type: 'string',
          enum: ['novo', 'em_conversa', 'qualificado', 'trial', 'perdido', 'optout'],
          description: 'Estado do lead. Use "qualificado" ao fechar a qualificação; "optout" se pediu para parar.',
        },
      },
      required: [],
    },
  },
  {
    name: 'sendDemoVideo',
    description:
      'Envia o vídeo curto de demonstração quando a lead prefere SÓ ASSISTIR, em vez de fazer a simulação in-chat da escada de demonstração. Depois do envio, pergunte o que ela achou.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'handoffToHuman',
    description:
      'Transfere a conversa pro Victor (humano). Use em: pedido explícito de falar com pessoa, negociação de preço/desconto/condição, migração técnica de dados, reclamação ou imprensa/parceria/revenda. Sinal de compra NÃO é handoff: mande o link na hora. Avise o lead que o Victor responde por aqui já já.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo curto do handoff.' },
      },
      required: ['reason'],
    },
    // Prompt caching: cache_control na ÚLTIMA tool cacheia todas as definições.
    cache_control: { type: 'ephemeral' },
  },
];

async function executeSalesFunction(
  name: string,
  input: Record<string, unknown>,
  phone: string,
  userName: string,
  config: TenantBotConfig,
  salesConfig: SalesConfig | null,
  partnerSlug: string | null
): Promise<string> {
  try {
    switch (name) {
      case 'getAvailableSlots': {
        await markFollowupDemoStage(config.phoneNumberId, phone);
        const serviceId = await resolveDemoServiceId(config);
        if (!serviceId) {
          return JSON.stringify({
            success: false,
            message: 'Não consegui abrir a agenda da demonstração agora. Tente em instantes.',
          });
        }
        const result = await getAvailableSlots(String(input.date ?? ''), serviceId, config);
        return JSON.stringify(result);
      }
      case 'scheduleDemo': {
        await markFollowupDemoStage(config.phoneNumberId, phone);
        const serviceId = await resolveDemoServiceId(config);
        if (!serviceId) {
          return JSON.stringify({
            success: false,
            message: 'Não consegui abrir a agenda da demonstração agora. Tente em instantes.',
          });
        }
        // Reusa bookAppointment (Guardrail A embute horários reais na falha).
        // professionalId omitido → auto-resolve pro Victor (único habilitado).
        const result = await bookAppointment(
          String(input.date ?? ''),
          String(input.time ?? ''),
          serviceId,
          phone,
          userName,
          config
        );
        return JSON.stringify(result);
      }
      case 'sendSignupLink': {
        if (!salesConfig) {
          return JSON.stringify({
            success: false,
            message: 'Não consegui gerar o link agora. Tente em instantes.',
          });
        }
        const result = buildSignupLink(
          String(input.plan ?? ''),
          typeof input.interval === 'string' ? input.interval : undefined,
          phone,
          salesConfig
        );
        if (result.success) {
          await markFollowupPostLink(config.phoneNumberId, phone);
          void emitSalesEvent(config.phoneNumberId, phone, 'link_enviado', {
            plan: result.plan,
            interval: result.interval,
          }).catch(() => undefined);
        }
        return JSON.stringify(result);
      }
      case 'sendPrefilledSignup': {
        if (!salesConfig) {
          return JSON.stringify({
            success: false,
            message: 'Não consegui gerar o link agora. Tente em instantes.',
          });
        }
        // O evento `link_enviado` sai do Receps neste caminho (o endpoint o
        // registra junto com o token) — emitir aqui contaria duas vezes.
        const result = await createPrefilledSignupLink(
          phone,
          config.phoneNumberId,
          {
            email: String(input.email ?? ''),
            name: typeof input.name === 'string' ? input.name : undefined,
            clinicName: typeof input.clinicName === 'string' ? input.clinicName : undefined,
            plan: String(input.plan ?? ''),
            interval: typeof input.interval === 'string' ? input.interval : undefined,
            niche:
              typeof input.niche === 'string' &&
              (PREFILL_NICHES as readonly string[]).includes(input.niche)
                ? input.niche
                : undefined,
            professionalsCount:
              typeof input.professionalsCount === 'number'
                ? input.professionalsCount
                : undefined,
          },
          salesConfig
        );
        if (result.success) {
          await markFollowupPostLink(config.phoneNumberId, phone);
        }
        return JSON.stringify(result);
      }
      case 'registerQualifiedLead': {
        const payload: QualifiedLeadPayload = {
          name: typeof input.name === 'string' ? input.name : undefined,
          clinicName: typeof input.clinicName === 'string' ? input.clinicName : undefined,
          professionalsCount:
            typeof input.professionalsCount === 'number' ? input.professionalsCount : undefined,
          whatsappVolume:
            typeof input.whatsappVolume === 'string' ? input.whatsappVolume : undefined,
          currentSystem: typeof input.currentSystem === 'string' ? input.currentSystem : undefined,
          mainPain: typeof input.mainPain === 'string' ? input.mainPain : undefined,
          interest:
            input.interest === 'sistema' ||
            input.interest === 'ia' ||
            input.interest === 'ambos'
              ? input.interest
              : undefined,
          recommendedPlan:
            typeof input.recommendedPlan === 'string' ? input.recommendedPlan : undefined,
          score: typeof input.score === 'number' ? input.score : undefined,
          status: typeof input.status === 'string' ? input.status : 'qualificado',
          partnerSlug: partnerSlug ?? undefined,
        };
        const result = await registerQualifiedLead(phone, config.phoneNumberId, payload);
        return JSON.stringify(result);
      }
      case 'sendDemoVideo': {
        const result = await sendDemoVideo(phone, config);
        return JSON.stringify(
          result.success
            ? {
                success: true,
                message:
                  'O vídeo já foi enviado. Agora pergunte o que ela achou, sem descrever o vídeo em detalhe.',
              }
            : {
                success: false,
                message:
                  'Não consegui enviar o vídeo. Ofereça a simulação in-chat da Ana e siga a conversa sem prometer que o vídeo será enviado.',
              }
        );
      }
      case 'handoffToHuman': {
        const result = await handoffToHuman(
          phone,
          config.phoneNumberId,
          typeof input.reason === 'string' ? input.reason : 'pedido do lead',
          { partnerSlug: partnerSlug ?? undefined }
        );
        return JSON.stringify(result);
      }
      default:
        return JSON.stringify({ success: false, message: 'Função não reconhecida.' });
    }
  } catch (err) {
    console.error(`❌ Erro ao executar função de vendas ${name}:`, err);
    return JSON.stringify({
      success: false,
      message: 'Tive um probleminha aqui, pode tentar de novo em um instante?',
    });
  }
}

/**
 * Monta o `system` da Anthropic: bloco ESTÁVEL (persona+manual+planos) com
 * prompt caching (`cache_control: ephemeral`) + bloco VOLÁTIL (contexto temporal)
 * SEM cache. Exportado pra smoke determinístico (caching ligado).
 */
export function buildSalesSystem(
  config: TenantBotConfig,
  plansBlock: string,
  context: VolatileSalesContext = {}
): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: buildStableSalesPrompt(config, plansBlock),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: buildVolatileSalesPrompt(config, context) },
  ];
}

const MAX_TOOL_ROUNDS = 6;

/** Extrai o texto final (concatena os blocos de texto da resposta). */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export interface SalesReplyDeps {
  addMessage: typeof addMessage;
  scheduleFollowup: typeof scheduleFollowup;
  setChannelPreference: typeof setChannelPref;
  getHistory: typeof getHistory;
  emitEvent: typeof emitSalesEvent;
}

const defaultSalesReplyDeps: SalesReplyDeps = {
  addMessage,
  scheduleFollowup,
  setChannelPreference: setChannelPref,
  getHistory,
  emitEvent: emitSalesEvent,
};

export interface SalesReplyOptions {
  retryPolicy?: AnthropicRetryPolicy;
}

/** Falha terminal pública do miolo de vendas; nunca vira copy pro lead. */
export class SalesBrainFailure extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Não foi possível gerar a resposta de vendas.');
    this.name = 'SalesBrainFailure';
    this.cause = cause;
  }
}

async function runSalesReplyFromLoadedHistory(
  phone: string,
  userName: string,
  config: TenantBotConfig,
  history: Awaited<ReturnType<typeof getHistory>>,
  options: SalesReplyOptions,
  deps: SalesReplyDeps = defaultSalesReplyDeps
): Promise<string> {
  const conversationKey = buildConversationKey(config.phoneNumberId, phone);
  const isFirstResponse = !history.some((message) => message.role === 'assistant');
  const partnerSlug = getConversationPartnerSlug(conversationKey);
  const adHeadline = getConversationAdHeadline(conversationKey);

  // Preço SEMPRE da sales-config. Indisponível → bloco seguro (nunca inventa).
  let salesConfig: SalesConfig | null = null;
  let plansBlock = PLANS_UNAVAILABLE_BLOCK;
  try {
    salesConfig = await getSalesConfig();
    plansBlock = renderPlansBlock(salesConfig);
  } catch (err) {
    console.warn('⚠️ sales-config indisponível — Renata segue sem preço:', err);
  }

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const system = buildSalesSystem(config, plansBlock, {
    partnerSlug,
    isFirstResponse,
    adHeadline,
  });

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callAnthropicWithRetry(
        () =>
          getAnthropicClient().messages.create({
            model: config.aiModel,
            max_tokens: sanitizeMaxTokens(config.aiMaxTokens),
            // NÃO enviar `temperature`: o claude-sonnet-5 a rejeita (400
            // "temperature is deprecated for this model"). Usa o default do modelo.
            system,
            tools: SALES_TOOLS,
            messages,
          }),
        `sales tenant=${config.tenantSlug} round=${round + 1}/${MAX_TOOL_ROUNDS}`,
        options.retryPolicy ?? 'patient'
      );

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUses.length === 0) {
        const reply = extractText(response.content) || getFallbackMessage(config);
        await deps.addMessage(conversationKey, 'assistant', reply);
        if (isFirstResponse) {
          void deps
            .emitEvent(config.phoneNumberId, phone, 'primeira_resposta')
            .catch(() => undefined);
        }
        return reply;
      }

      // Empurra a resposta do modelo (com os tool_use) e executa as tools.
      messages.push({
        role: 'assistant',
        content: response.content as Anthropic.ContentBlockParam[],
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const args = (toolUse.input ?? {}) as Record<string, unknown>;
        console.log(`🔧 Renata chamou: ${toolUse.name} para ${config.phoneNumberId}`);
        const result = await executeSalesFunction(
          toolUse.name,
          args,
          phone,
          userName,
          config,
          salesConfig,
          partnerSlug
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  } catch (error) {
    if (!isCaptured(error)) {
      Sentry.captureException(error, {
        tags: { service: 'sales-brain', operation: 'get_sales_reply' },
        contexts: {
          get_sales_reply: {
            tenant_slug: config.tenantSlug,
            phone_number_id: config.phoneNumberId,
            bot_name: config.botName,
          },
        },
      });
    }
    console.error(
      `❌ Erro ao gerar resposta da Renata | phoneNumberId=${
        config.phoneNumberId
      } | error=${error instanceof Error ? error.name : typeof error}`
    );
    throw new SalesBrainFailure(error);
  }

  // O provider respondeu, mas esgotou MAX_TOOL_ROUNDS sem texto final. Este
  // fallback de modelo vivo continua sendo uma resposta normal, como antes.
  const fallbackReply = getFallbackMessage(config);
  await deps.addMessage(conversationKey, 'assistant', fallbackReply);
  if (isFirstResponse) {
    void deps
      .emitEvent(config.phoneNumberId, phone, 'primeira_resposta')
      .catch(() => undefined);
  }
  return fallbackReply;
}

/**
 * Reexecuta somente o miolo da Renata a partir do histórico já persistido.
 * Não grava inbound nem repete follow-up, preferência de canal, atribuição ou
 * opener. Usado pelo recovery automático e pelo reprocessamento administrativo.
 */
export async function getSalesReplyFromHistory(
  phone: string,
  userName: string,
  config: TenantBotConfig,
  options: SalesReplyOptions = {},
  deps: SalesReplyDeps = defaultSalesReplyDeps
): Promise<string> {
  const conversationKey = buildConversationKey(config.phoneNumberId, phone);
  const history = await deps.getHistory(conversationKey);
  return runSalesReplyFromLoadedHistory(
    phone,
    userName,
    config,
    history,
    options,
    deps
  );
}

export async function getSalesReply(
  phone: string,
  userMessage: string,
  userName: string,
  config: TenantBotConfig,
  deps: SalesReplyDeps = defaultSalesReplyDeps
): Promise<string> {
  const conversationKey = buildConversationKey(config.phoneNumberId, phone);

  await deps.addMessage(conversationKey, 'user', userMessage);
  const history = await deps.getHistory(conversationKey);
  const userMessages = history.filter((message) => message.role === 'user');
  const isFirstResponse = !history.some((message) => message.role === 'assistant');
  const isFirstInboundWindow = userMessages.length === 1 && isFirstResponse;

  // Mesma janela determinística do matchAdOpening: só a primeira mensagem
  // consolidada da conversa pode criar a atribuição. O carimbo inicial não leva
  // `status` nem evento; falha de rede jamais interrompe a resposta.
  if (isFirstInboundWindow) {
    const detectedPartnerSlug = matchPartnerMention(userMessage);
    if (detectedPartnerSlug) {
      rememberConversationPartnerSlug(conversationKey, detectedPartnerSlug);
      void capturePartnerAttribution(
        config.phoneNumberId,
        phone,
        detectedPartnerSlug
      ).catch(() => undefined);
    }
  }

  // Régua de follow-up ZERA a cada inbound (best-effort, não bloqueia a resposta).
  await deps
    .scheduleFollowup(config.phoneNumberId, phone, userName)
    .catch(() => undefined);

  // Pedido explícito de canal vale já para ESTA resposta e é reversível.
  const channelRequest = detectChannelRequest(userMessage);
  if (channelRequest) {
    await deps
      .setChannelPreference(conversationKey, channelRequest === 'text')
      .catch(() => undefined);
  }

  // Aberturas reais dos anúncios: 1º inbound casado recebe script canônico sem
  // Anthropic. O texto original segue no histórico e no mesmo evento do caminho
  // normal; o messageHandler decide voz/texto depois.
  if (isFirstInboundWindow && matchAdOpening(userMessage)) {
    const script = pickOpenerScript(phone);
    await deps.addMessage(conversationKey, 'assistant', script);
    void deps
      .emitEvent(config.phoneNumberId, phone, 'primeira_resposta')
      .catch(() => undefined);
    return script;
  }

  return runSalesReplyFromLoadedHistory(
    phone,
    userName,
    config,
    history,
    { retryPolicy: 'patient' },
    deps
  );
}
