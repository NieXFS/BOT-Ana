import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import type { Content, FunctionDeclaration, Part, Tool } from '@google/genai';
import * as Sentry from '@sentry/node';
import type { TenantBotConfig } from '../configProvider';
import { DEFAULT_FALLBACK_MESSAGE } from '../botDefaults';
import { callGeminiWithRetry } from '../utils/geminiRetry';
import { isCaptured } from '../observability/captured';
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
  cancelAppointment,
} from './calendarService';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const clientCache = new Map<string, GoogleGenAI>();

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no ambiente.');
  }

  const cached = clientCache.get(apiKey);
  if (cached) {
    return cached;
  }

  const client = new GoogleGenAI({ apiKey });
  clientCache.set(apiKey, client);
  return client;
}

function getGeminiModel(config: TenantBotConfig): string {
  // config.aiModel vem do ERP e é específico do OpenAI (ex: "gpt-4o-mini"), então
  // NÃO serve como nome de modelo Gemini. O modelo é controlado por GEMINI_MODEL
  // (default gemini-2.5-flash). aiTemperature/aiMaxTokens são genéricos e seguem
  // sendo usados (temperature / maxOutputTokens).
  void config;
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

function getCurrentYear(timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
    }).format(new Date())
  );
}

export async function buildSystemPrompt(config: TenantBotConfig): Promise<string> {
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
  const servicesResult = await getServices(config);
  const servicesBlock =
    servicesResult.success && servicesResult.services
      ? `SERVIÇOS DISPONÍVEIS (use estes IDs diretamente nas ferramentas — você NÃO precisa chamar getServices):
${servicesResult.services
  .map(
    (service) =>
      `- ${service.name} (${service.durationMinutes}min, ${
        service.priceFormatted ?? 'preço não definido'
      }) — id: ${service.id}`
  )
  .join('\n')}

PROFISSIONAIS DISPONÍVEIS:
${(servicesResult.professionals ?? [])
  .map((professional) => `- ${professional.name} — id: ${professional.id}`)
  .join('\n')}`
      : '(Não foi possível carregar a lista de serviços agora. Se precisar, chame getServices.)';

  return `CONTEXTO TEMPORAL (OBRIGATÓRIO): Hoje é ${today}, são ${currentTime}. O ano atual é ${currentYear}. Quando o cliente mencionar datas relativas (amanhã, semana que vem, segunda, etc.), calcule a data correta a partir de HOJE. Quando o cliente mencionar apenas dia/mês (ex: "01/04"), SEMPRE assuma o ano ${currentYear}. NUNCA use anos anteriores.

IDENTIDADE DO ATENDIMENTO: Seu nome é ${botName}. Se houver qualquer conflito com instruções antigas, sempre priorize este nome.

${servicesBlock}

${config.systemPrompt}

REGRAS DE FLUXO DE ATENDIMENTO (prioridade máxima, leia primeiro):
A. ESCOLHA DO SERVIÇO — NUNCA assuma qual serviço o cliente quer. Ao INICIAR um novo agendamento, se a mensagem ATUAL não nomear o serviço com clareza (ex.: "quero marcar", "quero marcar para o dia 31", "quero marcar amanhã", "quero remarcar") E houver mais de um item na lista "SERVIÇOS DISPONÍVEIS", você DEVE listar TODOS os serviços disponíveis de forma NEUTRA (texto natural) e perguntar qual ele deseja ANTES de consultar horários (getAvailableSlots) ou agendar. NÃO faça pergunta direcionada como "quer o mesmo serviço de antes?" nem cite só um serviço — apresente as opções e deixe o cliente escolher. NUNCA reaproveite o serviço de um agendamento JÁ CONCLUÍDO, de mensagens antigas ou do histórico desta conversa — cada NOVO pedido recomeça perguntando o serviço (o fato de o cliente ter marcado/citado Depilação antes NÃO significa que o próximo agendamento também é Depilação). Exceção: durante um agendamento EM ANDAMENTO, mantenha o serviço que o cliente já escolheu NESSE mesmo fluxo (não repergunte a cada mensagem). Só siga direto, sem perguntar, se existir exatamente UM serviço disponível.
B. HORÁRIO INDISPONÍVEL — Se bookAppointment retornar success=false por causa do horário (campo reason = "blocked", "conflict" ou "outside_hours"), você DEVE chamar getAvailableSlots (mesma data, serviceId e profissional) ANTES de sugerir qualquer alternativa e oferecer SOMENTE os horários reais que ela retornar. NUNCA chute horários vizinhos (se pediram 15h, não invente 15h30 ou 16h). Se o retorno tiver um campo "hint", siga-o. ATENÇÃO: um retorno "INTERNAL_HINT:" sobre agendamento DUPLICADO NÃO é indisponibilidade de horário — nesse caso siga a regra 7 abaixo e NÃO chame getAvailableSlots.
C. ESCOLHA DO PROFISSIONAL — Se há 2+ profissionais em "PROFISSIONAIS DISPONÍVEIS" que atendem o serviço pedido E o cliente não disse com quem quer agendar, PERGUNTE: "Quer agendar com algum profissional específico ou tanto faz?". Se o cliente responder "tanto faz" / "qualquer um" / "pode ser qualquer" / similar, chame bookAppointment SEM o campo professionalId — o sistema escolhe automaticamente um profissional livre e te devolve o nome. Se o cliente disser um nome, passe o professionalId correspondente. Se houver apenas 1 profissional, agende direto sem perguntar. SEMPRE confirme ao cliente com QUEM ficou o agendamento (ex.: "Agendado às 15h com a Julia para Corte de cabelo").

REGRAS CRÍTICAS DE FERRAMENTAS (não negociáveis, sempre seguir):
1. Use os IDs de serviço e profissional listados em "SERVIÇOS DISPONÍVEIS" acima diretamente nas ferramentas (getAvailableSlots, bookAppointment). Você normalmente NÃO precisa chamar getServices porque a lista atualizada já está disponível. Só chame getServices se suspeitar que a lista mudou (ex: cliente mencionou um serviço/profissional que não aparece na lista acima).
2. serviceId e professionalId são IDs TÉCNICOS retornados na lista acima (formato cuid, ex: "cmnpffkiq000vl16krhv4ifzg"). Nunca são nomes legíveis ("depilacao", "samantha", "seed-svc-..."). Se o cliente diz "com a Samantha", encontre o ID dela na lista acima.
3. Se algum exemplo de ID aparecer em qualquer instrução anterior (incluindo nomes que comecem com "seed-"), IGNORE — são placeholders, não IDs reais. Use SOMENTE IDs da lista "SERVIÇOS DISPONÍVEIS" / "PROFISSIONAIS DISPONÍVEIS" acima.
4. Se a ferramenta retornar erro de "Serviço não encontrado", chame getServices uma vez pra atualizar e use o ID exato retornado.
5. FONTE DA VERDADE — Os horários retornados por getAvailableSlots são a única fonte da verdade sobre disponibilidade. Se o cliente pedir um horário que ESTÁ na lista (incluindo variações como "15h" = "15:00", "15h30" = "15:30", "às 8 da manhã" = "08:00"), prossiga DIRETO para a confirmação do agendamento. NUNCA, EM HIPÓTESE ALGUMA, invente que está ocupado se o horário aparece na lista retornada pela ferramenta. Só diga que está indisponível se a ferramenta retornar erro 409 explicitamente.
6. INTERNAL_HINT — Se uma ferramenta retornar uma mensagem começando com "INTERNAL_HINT:", siga a instrução dela IMEDIATAMENTE no próximo turno (chamando outras ferramentas se preciso) e refaça a chamada original com os parâmetros corretos. NÃO responda ao cliente, NÃO peça confirmação novamente — o cliente já confirmou antes da chamada que falhou. Mensagens INTERNAL_HINT são internas, nunca devem ser repassadas ao cliente em nenhuma forma.
7. DETECÇÃO DE AGENDAMENTO EXISTENTE — Quando bookAppointment retornar INTERNAL_HINT informando que o cliente já tem agendamento(s) futuro(s), NÃO crie o novo ainda. Pergunte ao cliente conforme as opções listadas no hint. Aguarde a resposta. Agir conforme:
   - "Manter os dois": chame bookAppointment de novo com confirmedDuplicate=true e os mesmos demais parâmetros.
   - "Remarcar (cancelar e marcar este novo)": PRIMEIRO chame cancelAppointment com o ID técnico exato do agendamento anterior (o valor dentro de [id: ...]). Após sucesso, chame bookAppointment com confirmedDuplicate=true.
   - "Só cancelar o anterior": chame cancelAppointment com o ID técnico exato do agendamento anterior (o valor dentro de [id: ...]). NÃO chame bookAppointment.
   - "Pensar depois": não chame ferramentas. Responda gentilmente e aguarde.
   - Se houver mais de um agendamento anterior e o cliente escolher remarcar/cancelar sem indicar qual, pergunte qual agendamento deve ser cancelado ANTES de chamar cancelAppointment. Nunca invente appointmentId usando data/hora.
8. CANCELAMENTO RESTRITO — A ferramenta cancelAppointment SÓ pode ser usada no fluxo da regra 7. Para qualquer outro pedido de cancelamento ou remarcação fora desse fluxo, NÃO chame cancelAppointment — encaminhe para a equipe conforme regras de comportamento.`;
}

function sanitizeTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
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

// Converte a string JSON devolvida por executeFunction no objeto que o Gemini
// espera em functionResponse.response (Record<string, unknown>). O conteúdo é o
// MESMO que o OpenAI recebia como content da tool — só o transporte muda.
function toFunctionResponseObject(result: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result };
  }
}

// Mesmas 4 ferramentas, mesmas descrições e mesmo JSON Schema de parâmetros do
// OpenAI — só o formato muda (functionDeclarations + parametersJsonSchema, que
// aceita JSON Schema padrão). NENHUMA palavra de description/schema foi alterada.
const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'getServices',
    description:
      'Lista os serviços e profissionais cadastrados no ERP. FALLBACK APENAS: você normalmente NÃO precisa chamar essa ferramenta porque a lista atualizada já vem no system prompt. Use apenas se suspeitar que a lista mudou (ex: cliente pediu um serviço que não aparece no prompt).',
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'getAvailableSlots',
    description:
      'Consulta os horários disponíveis para um serviço específico em uma data específica, com opção de profissional',
    parametersJsonSchema: {
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
            "ID técnico do serviço listado em SERVIÇOS DISPONÍVEIS no system prompt, ou obtido via getServices apenas como fallback. Nunca o nome do serviço, nunca um exemplo, nunca string com 'seed-'.",
        },
        professionalId: {
          type: 'string',
          description:
            "ID técnico do profissional (formato cuid) listado em PROFISSIONAIS DISPONÍVEIS no system prompt. Nunca o nome (ex: 'samantha' está ERRADO, use o id que vem da lista). OMITA este campo quando o cliente NÃO escolheu um profissional (disse 'tanto faz', 'qualquer um' ou não mencionou) — o sistema escolhe automaticamente um profissional livre. Só preencha quando o cliente especificar o profissional pelo nome.",
        },
      },
      required: ['date', 'serviceId'],
    },
  },
  {
    name: 'bookAppointment',
    description:
      'Agenda um horário no ERP. O telefone e o nome do cliente são preenchidos automaticamente pelo sistema.',
    parametersJsonSchema: {
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
            "ID técnico do serviço listado em SERVIÇOS DISPONÍVEIS no system prompt, ou obtido via getServices apenas como fallback. Nunca o nome do serviço, nunca um exemplo, nunca string com 'seed-'.",
        },
        professionalId: {
          type: 'string',
          description:
            "ID técnico do profissional (formato cuid) listado em PROFISSIONAIS DISPONÍVEIS no system prompt. Nunca o nome (ex: 'samantha' está ERRADO, use o id que vem da lista). OMITA este campo quando o cliente NÃO escolheu um profissional (disse 'tanto faz', 'qualquer um' ou não mencionou) — o sistema escolhe automaticamente um profissional livre. Só preencha quando o cliente especificar o profissional pelo nome.",
        },
        confirmedDuplicate: {
          type: 'boolean',
          description:
            'Marque como true APENAS quando o cliente confirmou explicitamente que quer manter agendamentos duplicados (no fluxo de detecção de conflito). NUNCA marque como true em outras situações.',
        },
      },
      required: ['date', 'time', 'serviceId'],
    },
  },
  {
    name: 'cancelAppointment',
    description:
      'Cancela um agendamento futuro do cliente. Use APENAS no fluxo de detecção de agendamento existente (após o cliente escolher remarcar). NUNCA use em outros contextos — cancelamentos avulsos devem ser encaminhados para a equipe.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description:
            'ID técnico exato do agendamento a cancelar, conforme retornado no INTERNAL_HINT de detecção de conflito (valor dentro de [id: ...]). Nunca invente usando data/hora. Se houver mais de um agendamento e o cliente não indicou qual, pergunte antes de cancelar.',
        },
      },
      required: ['appointmentId'],
    },
  },
];

const TOOLS: Tool[] = [{ functionDeclarations: FUNCTION_DECLARATIONS }];

async function executeFunction(
  functionName: string,
  args: Record<string, unknown>,
  phone: string,
  userName: string,
  config: TenantBotConfig,
  currentUserMessage: string
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
          typeof args.professionalId === 'string' ? args.professionalId : undefined,
          args.confirmedDuplicate === true
        );
        return JSON.stringify(result);
      }
      case 'cancelAppointment': {
        const result = await cancelAppointment(
          String(args.appointmentId ?? ''),
          phone,
          config,
          currentUserMessage
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
  const isFirstContact = !(await hasConversation(conversationKey));

  await addMessage(conversationKey, 'user', userMessage);

  // Histórico persistido é só texto (user/assistant). Converte pro formato Gemini:
  // 'assistant' -> 'model', content textual -> parts:[{text}]. O system prompt NÃO
  // entra em contents — vai em config.systemInstruction (mesmo texto de antes).
  const history = await getHistory(conversationKey);
  const contents: Content[] = history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));

  const systemInstruction = await buildSystemPrompt(config);
  const model = getGeminiModel(config);
  const maxToolRounds = 8;

  try {
    for (let round = 0; round < maxToolRounds; round++) {
      const response = await callGeminiWithRetry(
        () =>
          getGeminiClient().models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: TOOLS,
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
              },
              temperature: sanitizeTemperature(config.aiTemperature),
              maxOutputTokens: sanitizeMaxTokens(config.aiMaxTokens),
              // Desliga o "thinking" do 2.5 Flash: paridade com o gpt-4o-mini (que
              // não pensava) e evita que o orçamento de tokens (maxOutputTokens
              // baixo) seja consumido pelo raciocínio, deixando a resposta vazia.
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        `gemini-generate tenant=${config.tenantSlug} round=${round + 1}/${maxToolRounds}`
      );

      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length === 0) {
        const rawReply = (response.text ?? '').trim();
        const finalReply = maybePrependGreeting(
          rawReply || getFallbackMessage(config),
          isFirstContact,
          config
        );

        await addMessage(conversationKey, 'assistant', finalReply);
        return finalReply;
      }

      // Anexa o turno do modelo (com os parts de functionCall) ao histórico em
      // memória — necessário para o Gemini casar cada functionResponse à chamada.
      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) {
        contents.push(modelContent);
      } else {
        contents.push({
          role: 'model',
          parts: functionCalls.map((functionCall) => ({ functionCall })),
        });
      }

      const functionResponseParts: Part[] = [];
      for (const functionCall of functionCalls) {
        const functionName = functionCall.name ?? '';
        const args = (functionCall.args ?? {}) as Record<string, unknown>;

        console.log(
          `🔧 ${config.botName} chamou função: ${functionName}(${JSON.stringify(args)}) para ${phone}`
        );

        const result = await executeFunction(
          functionName,
          args,
          phone,
          userName,
          config,
          userMessage
        );

        console.log(`📋 Resultado de ${functionName}: ${result}`);

        functionResponseParts.push({
          functionResponse: {
            name: functionName,
            response: toFunctionResponseObject(result),
          },
        });
      }

      // O turno com os functionResponse vai como role 'user' (formato do Gemini).
      contents.push({ role: 'user', parts: functionResponseParts });
    }
  } catch (error) {
    // Erros do Gemini já foram capturados no funil (geminiRetry); aqui pegamos
    // o resto (ex.: falha de persistência de contexto) sem duplicar.
    if (!isCaptured(error)) {
      Sentry.captureException(error, {
        tags: { service: 'brain', operation: 'get_reply' },
        contexts: {
          get_reply: {
            tenant_slug: config.tenantSlug,
            phone_number_id: config.phoneNumberId,
            bot_name: config.botName,
          },
        },
      });
    }
    console.error(`❌ Erro ao gerar resposta da ${config.botName}:`, error);
  }

  const fallbackReply = maybePrependGreeting(
    getFallbackMessage(config),
    isFirstContact,
    config
  );
  await addMessage(conversationKey, 'assistant', fallbackReply);
  return fallbackReply;
}
