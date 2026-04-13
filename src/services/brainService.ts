import OpenAI from 'openai';
import type { TenantBotConfig } from '../configProvider';
import { DEFAULT_FALLBACK_MESSAGE } from '../botDefaults';
import {
  addMessage,
  buildConversationKey,
  getHistory,
  hasConversation,
} from './contextManager';
import {
  getServices,
  getAvailableSlots,
  bookAppointment,
} from './calendarService';

const clientCache = new Map<string, OpenAI>();

function getOpenAIClient(config: TenantBotConfig): OpenAI {
  const apiKey = config.openaiApiKey?.trim() || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY não configurada para o tenant nem no ambiente global.');
  }

  const cached = clientCache.get(apiKey);
  if (cached) {
    return cached;
  }

  const client = new OpenAI({ apiKey });
  clientCache.set(apiKey, client);
  return client;
}

function getCurrentYear(timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
    }).format(new Date())
  );
}

function buildSystemPrompt(config: TenantBotConfig): string {
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
  const currentYear = getCurrentYear(config.timezone);
  const botName = config.botName.trim() || 'Ana';

  return `CONTEXTO TEMPORAL (OBRIGATÓRIO): Hoje é ${today}, são ${currentTime}. O ano atual é ${currentYear}. Quando o cliente mencionar datas relativas (amanhã, semana que vem, segunda, etc.), calcule a data correta a partir de HOJE. Quando o cliente mencionar apenas dia/mês (ex: "01/04"), SEMPRE assuma o ano ${currentYear}. NUNCA use anos anteriores.

IDENTIDADE DO ATENDIMENTO: Seu nome é ${botName}. Se houver qualquer conflito com instruções antigas, sempre priorize este nome.

${config.systemPrompt}`;
}

function sanitizeTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(Math.max(value, 0), 1);
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 500;
  return Math.max(Math.round(value), 100);
}

function getFallbackMessage(config: TenantBotConfig): string {
  return config.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE;
}

function maybePrependGreeting(
  reply: string,
  isFirstContact: boolean,
  config: TenantBotConfig
): string {
  const greeting = config.greetingMessage?.trim();

  if (!isFirstContact || !greeting) {
    return reply;
  }

  if (reply.toLowerCase().includes(greeting.toLowerCase())) {
    return reply;
  }

  return `${greeting}\n\n${reply}`;
}

function parseFunctionArgs(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getServices',
      description:
        'Lista os serviços cadastrados no ERP, com id, nome, duração, preço e profissionais disponíveis',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAvailableSlots',
      description:
        'Consulta os horários disponíveis para um serviço específico em uma data específica, com opção de profissional',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description:
              'Data no formato YYYY-MM-DD. OBRIGATÓRIO: use o ano atual informado no contexto temporal do system prompt. Se o cliente disser apenas dia/mês, complete com o ano atual. Nunca use anos anteriores.',
          },
          serviceId: {
            type: 'string',
            description:
              'ID exato do serviço escolhido. Sempre obtenha esse ID pela função getServices antes de consultar horários.',
          },
          professionalId: {
            type: 'string',
            description:
              'ID do profissional escolhido pelo cliente. Opcional. Se o cliente não tiver preferência, pode omitir.',
          },
        },
        required: ['date', 'serviceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bookAppointment',
      description:
        'Agenda um horário no ERP. O telefone e o nome do cliente são preenchidos automaticamente pelo sistema.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description:
              'Data no formato YYYY-MM-DD. OBRIGATÓRIO: use o ano atual informado no contexto temporal do system prompt. Se o cliente disser apenas dia/mês, complete com o ano atual. Nunca use anos anteriores.',
          },
          time: { type: 'string', description: 'Horário no formato HH:MM' },
          serviceId: {
            type: 'string',
            description:
              'ID exato do serviço escolhido. Sempre obtenha esse ID pela função getServices antes de agendar.',
          },
          professionalId: {
            type: 'string',
            description:
              'ID do profissional escolhido pelo cliente. Opcional. Se não houver preferência, pode omitir.',
          },
        },
        required: ['date', 'time', 'serviceId'],
      },
    },
  },
];

async function executeFunction(
  functionName: string,
  args: Record<string, unknown>,
  phone: string,
  userName: string,
  config: TenantBotConfig
): Promise<string> {
  try {
    switch (functionName) {
      case 'getServices': {
        const result = await getServices(config);
        return JSON.stringify(result);
      }
      case 'getAvailableSlots': {
        const result = await getAvailableSlots(
          String(args.date ?? ''),
          String(args.serviceId ?? ''),
          config,
          typeof args.professionalId === 'string' ? args.professionalId : undefined
        );
        return JSON.stringify(result);
      }
      case 'bookAppointment': {
        const result = await bookAppointment(
          String(args.date ?? ''),
          String(args.time ?? ''),
          String(args.serviceId ?? ''),
          phone,
          userName,
          config,
          typeof args.professionalId === 'string' ? args.professionalId : undefined
        );
        return JSON.stringify(result);
      }
      default:
        return JSON.stringify({ success: false, message: 'Função não reconhecida.' });
    }
  } catch (err) {
    console.error(`❌ Erro ao executar função ${functionName}:`, err);
    return JSON.stringify({
      success: false,
      message: 'Tive um probleminha ao verificar a agenda, pode tentar de novo em um instante?',
    });
  }
}

export async function getReply(
  phone: string,
  userMessage: string,
  userName: string,
  config: TenantBotConfig
): Promise<string> {
  const conversationKey = buildConversationKey(config.phoneNumberId, phone);
  const isFirstContact = !hasConversation(conversationKey);

  addMessage(conversationKey, 'user', userMessage);

  const history = getHistory(conversationKey);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(config) },
    ...history,
  ];

  const maxToolRounds = 5;

  try {
    for (let round = 0; round < maxToolRounds; round++) {
      const response = await getOpenAIClient(config).chat.completions.create({
        model: config.aiModel,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: sanitizeTemperature(config.aiTemperature),
        max_tokens: sanitizeMaxTokens(config.aiMaxTokens),
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        const rawReply =
          typeof assistantMessage.content === 'string'
            ? assistantMessage.content.trim()
            : '';
        const finalReply = maybePrependGreeting(
          rawReply || getFallbackMessage(config),
          isFirstContact,
          config
        );

        addMessage(conversationKey, 'assistant', finalReply);
        return finalReply;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const args = parseFunctionArgs(toolCall.function.arguments || '{}');

        console.log(
          `🔧 ${config.botName} chamou função: ${functionName}(${JSON.stringify(args)}) para ${phone}`
        );

        const result = await executeFunction(functionName, args, phone, userName, config);

        console.log(`📋 Resultado de ${functionName}: ${result}`);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }
  } catch (error) {
    console.error(`❌ Erro ao gerar resposta da ${config.botName}:`, error);
  }

  const fallbackReply = maybePrependGreeting(
    getFallbackMessage(config),
    isFirstContact,
    config
  );
  addMessage(conversationKey, 'assistant', fallbackReply);
  return fallbackReply;
}
