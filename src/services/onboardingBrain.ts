import Anthropic from '@anthropic-ai/sdk';
import type { TenantBotConfig } from '../configProvider';
import { DEFAULT_FALLBACK_MESSAGE } from '../botDefaults';
import { Sentry } from '../observability/sentry';
import {
  callAnthropicWithRetry,
  type AnthropicRetryPolicy,
} from '../utils/anthropicRetry';
import { detectChannelRequest, setChannelPref } from '../voice/channelPref';
import {
  addMessage,
  buildConversationKey,
  getHistory,
} from './contextManager';
import {
  authorizeOnboardingWrite,
  clearPendingOnboardingProposal,
  invalidateProposalForInbound,
  ONBOARDING_WRITE_TOOLS,
  rememberProposalFromReply,
  type OnboardingWriteTool,
} from './onboardingConfirmationGate';
import {
  cancelOnboardingPolling,
  markOnboardingWhatsappReady,
  recordEmbeddedSignupFailure,
  resumeOnboardingPolling,
  startOnboardingPolling,
} from './onboardingPolling';
import {
  getOnboardingSessionResult,
  type OnboardingState,
} from './onboardingSession';
import {
  connectLinkResult,
  executeOnboardingWrite,
  getOnboardingStateTool,
  getWhatsappStatus,
} from './onboardingTools';
import {
  scheduleOnboardingFollowup,
} from './salesFollowups';
import { handoffToHuman } from './salesTools';

const clientCache = new Map<string, Anthropic>();
const MAX_TOOL_ROUNDS = 8;

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não configurada — necessária para o brain de onboarding.'
    );
  }
  const cached = clientCache.get(apiKey);
  if (cached) return cached;
  const client = new Anthropic({ apiKey });
  clientCache.set(apiKey, client);
  return client;
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 700;
  return Math.max(Math.round(value), 100);
}

function fallbackMessage(config: TenantBotConfig): string {
  return config.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE;
}

const ONBOARDING_CODE_PREAMBLE = `PAPEL ATIVO: ONBOARDING DA RENATA

Você está configurando, por conversa, a clínica que já possui uma sessão de onboarding aberta. Não volte ao funil de vendas.

REGRAS DURAS DE CÓDIGO E CONDUTA:
1. O estado real da clínica vem exclusivamente de getOnboardingState e do bloco ESTADO ATUAL. Nunca deduza que algo foi salvo pelo histórico ou por uma fala anterior.
2. Antes de propor qualquer alteração, consulte getOnboardingState. Depois de uma escrita, consulte novamente antes da próxima proposta.
3. upsertService, setSchedule, addProfessional, updateClinicInfo e completeOnboarding são escritas. Primeiro apresente uma proposta explícita com todos os dados e pergunte se a cliente confirma. Só tente a tool num NOVO turno após confirmação inequívoca. Hesitação, correção ou adversativa exigem nova proposta.
4. Nunca delete, nunca toque financeiro, faturamento, clientes finais, agendamentos ou prontuários. Não invente endpoint nem campo.
5. Pausa ou takeover humano vence tudo. Quando houver pedido explícito de humano, frustração/trava, estrutura complexa com 3 ou mais profissionais, ou falha repetida do Embedded Signup, use handoffToHuman.
6. Para conectar o WhatsApp, use sendConnectLink. O link deve aparecer em texto. getWhatsappStatus apenas consulta o estado autoritativo.
7. O primeiro teste é real: oriente a dona a enviar uma mensagem ao próprio número da clínica e observar a Ana responder. Nunca simule chamada cruzada nem afirme que o teste aconteceu.
8. completeOnboarding é o fecho: proponha finalizar, espere confirmação em novo turno e só então chame a tool.

O manual salvo abaixo continua sendo a fonte da persona, do tom e da jornada. Se ainda não houver um capítulo de Onboarding no manual, siga este preâmbulo sem inventar regras adicionais.`;

export function buildStableOnboardingPrompt(
  config: TenantBotConfig
): string {
  const botName = config.botName.trim() || 'Renata';
  return `IDENTIDADE: Seu nome é ${botName}. Se houver conflito, o papel ONBOARDING e as regras duras abaixo têm prioridade.

${ONBOARDING_CODE_PREAMBLE}

MANUAL SALVO NO PAINEL:
${config.systemPrompt}`;
}

export function buildVolatileOnboardingPrompt(
  state: OnboardingState
): string {
  return `ESTADO ATUAL AUTORITATIVO DA CLÍNICA (VOLÁTIL; não memorize como verdade para o próximo turno):
${JSON.stringify(state)}

derivedStage é a etapa calculada pelo Receps a partir do banco e tem precedência sobre session.stage.`;
}

export function buildOnboardingSystem(
  config: TenantBotConfig,
  state: OnboardingState
): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: buildStableOnboardingPrompt(config),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: buildVolatileOnboardingPrompt(state),
    },
  ];
}

export const ONBOARDING_TOOLS: Anthropic.Tool[] = [
  {
    name: 'getOnboardingState',
    description:
      'Consulta o estado autoritativo atual da clínica. Chame antes de qualquer proposta e novamente depois de qualquer escrita bem-sucedida. Nunca deduza estado pelo histórico.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'upsertService',
    description:
      'Cria ou atualiza um serviço. É ESCRITA: só tente depois de ter proposto exatamente nome, duração e preço no turno anterior e recebido confirmação inequívoca agora. confirmed é injetado pelo código e não existe no input.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome, de 2 a 80 caracteres.' },
        durationMin: {
          type: 'integer',
          description: 'Duração em minutos, de 5 a 600.',
        },
        price: {
          type: 'number',
          description: 'Preço entre 0 e 999999.99.',
        },
        replaceServiceId: {
          type: 'string',
          description:
            'ID de um serviço-semente retornado pelo estado, somente quando a cliente confirmou substituí-lo.',
        },
      },
      required: ['name', 'durationMin', 'price'],
    },
  },
  {
    name: 'setSchedule',
    description:
      'Configura horário geral, dias fechados e almoço. É ESCRITA: proponha todos os campos e espere confirmação em novo turno. Bloqueios do onboarding são write-once.',
    input_schema: {
      type: 'object',
      properties: {
        openingTime: { type: 'string', description: 'HH:MM.' },
        closingTime: { type: 'string', description: 'HH:MM.' },
        slotIntervalMinutes: {
          type: 'integer',
          enum: [15, 30, 60],
        },
        closedWeekdays: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          description: '0=domingo até 6=sábado.',
        },
        lunch: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'HH:MM.' },
            end: { type: 'string', description: 'HH:MM.' },
          },
          required: ['start', 'end'],
        },
      },
      required: [
        'openingTime',
        'closingTime',
        'slotIntervalMinutes',
      ],
    },
  },
  {
    name: 'addProfessional',
    description:
      'Adiciona um profissional ativo sem criar credencial de acesso. É ESCRITA: proponha nome/especialidade e espere confirmação em novo turno. Para estrutura complexa com 3+ profissionais, faça handoff.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome, de 2 a 80 caracteres.' },
        specialty: {
          type: 'string',
          description: 'Especialidade; omita para Profissional.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'updateClinicInfo',
    description:
      'Atualiza somente dados básicos da clínica. É ESCRITA: proponha os campos exatos e espere confirmação em novo turno. Nunca peça CNPJ, documento, e-mail, slug, billing ou plano.',
    input_schema: {
      type: 'object',
      properties: {
        businessName: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zipCode: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'getWhatsappStatus',
    description:
      'Consulta no Receps se o Embedded Signup terminou. É read-only. Nunca afirme que conectou sem ready:true.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'sendConnectLink',
    description:
      'Obtém o link oficial do fluxo de conexão. Inclua a URL retornada na resposta; a política de canal a envia em texto. Inicia uma rodada limitada de consulta de status.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'completeOnboarding',
    description:
      'Finaliza o setup inicial e fecha a sessão. É ESCRITA: primeiro proponha explicitamente finalizar a configuração, espere confirmação inequívoca em novo turno e só então tente.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'handoffToHuman',
    description:
      'Transfere para o Victor, envia o contexto operacional e pausa a conversa. Use quando o ES falhou duas vezes, a cliente travou ou ficou frustrada, há 3+ profissionais com estrutura complexa, ou houve pedido explícito de humano.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: [
            'onboarding_es_falhou',
            'onboarding_travada',
            'onboarding_equipe_complexa',
            'pedido_humano',
          ],
        },
      },
      required: ['reason'],
    },
    // Prompt caching depende de esta ser a ÚLTIMA tool.
    cache_control: { type: 'ephemeral' },
  },
];

type ProposalCandidate = {
  tool: OnboardingWriteTool;
  input: Record<string, unknown>;
};

const HANDOFF_REASONS = new Set([
  'onboarding_es_falhou',
  'onboarding_travada',
  'onboarding_equipe_complexa',
  'pedido_humano',
]);

export async function executeOnboardingFunction(input: {
  name: string;
  toolInput: Record<string, unknown>;
  phone: string;
  config: TenantBotConfig;
  conversationKey: string;
  currentUserMessage: string;
  proposalCandidates: ProposalCandidate[];
}): Promise<string> {
  const {
    name,
    toolInput,
    phone,
    config,
    conversationKey,
    currentUserMessage,
    proposalCandidates,
  } = input;

  if (name === 'getOnboardingState') {
    return JSON.stringify(
      await getOnboardingStateTool(phone, { bypassCache: true })
    );
  }

  if (
    (ONBOARDING_WRITE_TOOLS as readonly string[]).includes(name)
  ) {
    const tool = name as OnboardingWriteTool;
    const decision = authorizeOnboardingWrite({
      conversationKey,
      tool,
      toolInput,
      currentUserMessage,
    });
    if (!decision.ok) {
      proposalCandidates.push({ tool, input: toolInput });
      return JSON.stringify({
        success: false,
        reason: decision.reason,
        message: decision.hintMessage,
      });
    }
    return JSON.stringify(
      await executeOnboardingWrite(tool, phone, toolInput)
    );
  }

  if (name === 'getWhatsappStatus') {
    const result = await getWhatsappStatus(phone);
    if (result.success && result.status.ready) {
      markOnboardingWhatsappReady(conversationKey);
    } else if (result.success) {
      resumeOnboardingPolling(
        conversationKey,
        phone,
        config
      );
    }
    return JSON.stringify(result);
  }

  if (name === 'sendConnectLink') {
    const polling = startOnboardingPolling(
      conversationKey,
      phone,
      config
    );
    return JSON.stringify({
      ...connectLinkResult(),
      polling,
    });
  }

  if (name === 'handoffToHuman') {
    const requested =
      typeof toolInput.reason === 'string'
        ? toolInput.reason
        : 'onboarding_travada';
    const reason = HANDOFF_REASONS.has(requested)
      ? requested
      : 'onboarding_travada';
    cancelOnboardingPolling(conversationKey);
    clearPendingOnboardingProposal(conversationKey);
    return JSON.stringify(
      await handoffToHuman(
        phone,
        config.phoneNumberId,
        reason
      )
    );
  }

  return JSON.stringify({
    success: false,
    reason: 'unknown_tool',
    message: 'INTERNAL_HINT: Tool não reconhecida. Não afirme sucesso.',
  });
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export interface OnboardingReplyOptions {
  retryPolicy?: AnthropicRetryPolicy;
}

export class OnboardingBrainFailure extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Não foi possível gerar a resposta de onboarding.');
    this.name = 'OnboardingBrainFailure';
    this.cause = cause;
  }
}

async function runOnboardingFromLoadedHistory(
  phone: string,
  config: TenantBotConfig,
  history: Awaited<ReturnType<typeof getHistory>>,
  currentUserMessage: string,
  state: OnboardingState,
  options: OnboardingReplyOptions
): Promise<string> {
  const conversationKey = buildConversationKey(
    config.phoneNumberId,
    phone
  );
  const messages: Anthropic.MessageParam[] = history.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }));
  const system = buildOnboardingSystem(config, state);
  const proposalCandidates: ProposalCandidate[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await callAnthropicWithRetry(
        () =>
          getAnthropicClient().messages.create({
            model: config.aiModel,
            max_tokens: sanitizeMaxTokens(config.aiMaxTokens),
            // Sonnet 5 rejeita temperature; usa o default do provider.
            system,
            tools: ONBOARDING_TOOLS,
            messages,
          }),
        `onboarding tenant=${config.tenantSlug} round=${round + 1}/${MAX_TOOL_ROUNDS}`,
        options.retryPolicy ?? 'patient'
      );

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use'
      );
      if (toolUses.length === 0) {
        const reply =
          extractText(response.content) || fallbackMessage(config);
        const candidate = proposalCandidates[0];
        if (candidate) {
          rememberProposalFromReply({
            conversationKey,
            reply,
            tool: candidate.tool,
            toolInput: candidate.input,
          });
        }
        await addMessage(conversationKey, 'assistant', reply);
        return reply;
      }

      messages.push({
        role: 'assistant',
        content:
          response.content as Anthropic.ContentBlockParam[],
      });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        console.log(
          `🔧 Renata onboarding chamou: ${toolUse.name} | phoneNumberId=${config.phoneNumberId}`
        );
        const result = await executeOnboardingFunction({
          name: toolUse.name,
          toolInput: (toolUse.input ?? {}) as Record<string, unknown>,
          phone,
          config,
          conversationKey,
          currentUserMessage,
          proposalCandidates,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (error) {
    Sentry.captureException(
      new Error('onboarding brain failed'),
      {
        tags: {
          service: 'onboarding-brain',
          operation: 'get_onboarding_reply',
          phoneNumberId: config.phoneNumberId,
          tenantSlug: config.tenantSlug,
          error_kind:
            error instanceof Error ? error.name : typeof error,
        },
      }
    );
    console.error(
      `❌ Erro no brain de onboarding | phoneNumberId=${config.phoneNumberId} | error=${
        error instanceof Error ? error.name : typeof error
      }`
    );
    throw new OnboardingBrainFailure(error);
  }

  const reply = fallbackMessage(config);
  await addMessage(conversationKey, 'assistant', reply);
  return reply;
}

async function loadOpenState(
  phone: string
): Promise<OnboardingState> {
  const lookup = await getOnboardingSessionResult(phone);
  if (lookup.kind === 'open') return lookup.state;
  throw new Error(`onboarding state unavailable (${lookup.reason})`);
}

export async function getOnboardingReply(
  phone: string,
  userMessage: string,
  _userName: string,
  config: TenantBotConfig,
  initialState?: OnboardingState
): Promise<string> {
  const conversationKey = buildConversationKey(
    config.phoneNumberId,
    phone
  );
  invalidateProposalForInbound(conversationKey, userMessage);
  await addMessage(conversationKey, 'user', userMessage);

  const state = initialState ?? (await loadOpenState(phone));
  await scheduleOnboardingFollowup(
    config.phoneNumberId,
    phone,
    _userName
  ).catch(() => undefined);

  const channelRequest = detectChannelRequest(userMessage);
  if (channelRequest) {
    await setChannelPref(
      conversationKey,
      channelRequest === 'text'
    ).catch(() => undefined);
  }

  const esFailure = recordEmbeddedSignupFailure(
    conversationKey,
    state.session.derivedStage === 'whatsapp'
      ? userMessage
      : ''
  );
  if (esFailure.matched) {
    if (esFailure.handoff) {
      cancelOnboardingPolling(conversationKey);
      clearPendingOnboardingProposal(conversationKey);
      await handoffToHuman(
        phone,
        config.phoneNumberId,
        'onboarding_es_falhou'
      );
    }
    await addMessage(
      conversationKey,
      'assistant',
      esFailure.message
    );
    return esFailure.message;
  }

  const history = await getHistory(conversationKey);
  return runOnboardingFromLoadedHistory(
    phone,
    config,
    history,
    userMessage,
    state,
    { retryPolicy: 'patient' }
  );
}

export async function getOnboardingReplyFromHistory(
  phone: string,
  _userName: string,
  config: TenantBotConfig,
  options: OnboardingReplyOptions = {}
): Promise<string> {
  const conversationKey = buildConversationKey(
    config.phoneNumberId,
    phone
  );
  const history = await getHistory(conversationKey);
  const currentUserMessage =
    [...history]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content ?? '';
  const state = await loadOpenState(phone);
  return runOnboardingFromLoadedHistory(
    phone,
    config,
    history,
    currentUserMessage,
    state,
    options
  );
}
