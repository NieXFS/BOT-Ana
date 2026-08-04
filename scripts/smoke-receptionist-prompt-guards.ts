/**
 * Smoke determinístico do prompt canônico da recepcionista e das guardas
 * imutáveis aplicadas no runtime. Não chama OpenAI/DeepSeek, ERP ou banco.
 *
 * Rodar: npm run smoke:receptionist-prompt-guards
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:5432/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-test';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BOT_SYSTEM_PROMPT,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GREETING_MESSAGE,
} from '../src/botDefaults';
import type { TenantBotConfig } from '../src/configProvider';
import type { ServicesResult } from '../src/services/calendarService';

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${label}`);
  if (!condition) failures += 1;
}

function readRecepsDefaultPrompt(): string | null {
  const recepsPath = path.resolve(
    process.cwd(),
    '../Receps ERP/src/lib/bot-config.ts'
  );
  if (!existsSync(recepsPath)) return null;

  const source = readFileSync(recepsPath, 'utf8');
  return source.match(/DEFAULT_BOT_SYSTEM_PROMPT = `([\s\S]*?)`;/)?.[1] ?? null;
}

const servicesResult: ServicesResult = {
  success: true,
  professionals: [
    { id: 'prof-smoke', name: 'Profissional Smoke' },
    { id: 'prof-smoke-2', name: 'Profissional Smoke Dois' },
  ],
  services: [
    {
      id: 'svc-limpeza',
      name: 'Limpeza de Pele',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-smoke'],
    },
    {
      id: 'svc-peeling',
      name: 'Peeling',
      durationMinutes: 45,
      price: 250,
      priceFormatted: 'R$ 250,00',
      professionalIds: ['prof-smoke', 'prof-smoke-2'],
    },
  ],
};

const config: TenantBotConfig = {
  tenantSlug: 'tenant-smoke',
  botName: 'Ana',
  botRole: 'receptionist',
  systemPrompt:
    'INSTRUÇÃO TENANT: responda apenas sobre o que estiver nos dados atuais.',
  greetingMessage: DEFAULT_GREETING_MESSAGE,
  fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '08:00',
  botActiveEnd: '20:00',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'wa-smoke',
  waApiVersion: 'v21.0',
  phoneNumberId: 'phone-smoke',
  isActive: true,
};

async function main() {
  const recepsDefaultPrompt = readRecepsDefaultPrompt();
  if (recepsDefaultPrompt === null) {
    console.log(
      '[SKIP] alinhamento cruzado com Receps (repo irmão não está disponível neste checkout)'
    );
  } else {
    check(
      'defaults Receps e Ana usam exatamente o mesmo prompt canônico',
      recepsDefaultPrompt === DEFAULT_BOT_SYSTEM_PROMPT
    );
  }
  check(
    'prompt canônico exige negativa explícita para serviço ausente',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('diga explicitamente que esse serviço não está disponível')
  );
  check(
    'prompt canônico bloqueia promessa ou recomendação clínica',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('não diagnostique, não recomende tratamento') &&
      DEFAULT_BOT_SYSTEM_PROMPT.includes('não prometa resultado')
  );
  check(
    'prompt canônico não ecoa promessa clínica nem inventa agendamento de avaliação',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('Não repita nem confirme a promessa clínica') &&
      DEFAULT_BOT_SYSTEM_PROMPT.includes('Vou encaminhar sua dúvida para que possam te orientar.') &&
      !DEFAULT_BOT_SYSTEM_PROMPT.includes('marcar uma avaliação')
  );
  check(
    'prompt canônico invalida horários quando serviço, data ou profissional mudam',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('Nunca reutilize disponibilidade antiga')
  );
  check(
    'prompt canônico exige resumo e confirmação posterior antes de agendar',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('resumo real de serviço, data, horário') &&
      DEFAULT_BOT_SYSTEM_PROMPT.includes('Confirmação vaga, condicional ou implícita')
  );
  check(
    'prompt canônico exige transparência sobre ser IA',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('atendente virtual com IA')
  );
  check(
    'prompt canônico exige responder todas as partes explícitas',
    DEFAULT_BOT_SYSTEM_PROMPT.includes('Responda todas as partes explícitas da mensagem')
  );

  const {
    buildSystemPromptFromServices,
    RECEPTIONIST_TOOLS,
  } = await import('../src/services/brainService');
  const runtimePrompt = buildSystemPromptFromServices(
    config,
    servicesResult,
    new Date('2026-08-03T15:00:00.000Z')
  );
  const whatsappStyleStart = runtimePrompt.indexOf('ESTILO DE WHATSAPP:');
  const humanMessagesStart = runtimePrompt.indexOf(
    'MENSAGENS DE ATENDENTE HUMANO:'
  );
  const whatsappStyleBlock = runtimePrompt.slice(
    whatsappStyleStart,
    humanMessagesStart
  );
  const tenantInstructionIndex = runtimePrompt.indexOf('INSTRUÇÃO TENANT');
  const unavailableServiceGuardIndex = runtimePrompt.indexOf('E. SERVIÇO AUSENTE');
  const clinicalGuardIndex = runtimePrompt.indexOf('F. SEGURANÇA CLÍNICA');
  const staleAvailabilityGuardIndex = runtimePrompt.indexOf('G. MUDANÇA NO AGENDAMENTO');

  check(
    'guarda de serviço ausente é adicionada depois do prompt editável do tenant',
    tenantInstructionIndex >= 0 && unavailableServiceGuardIndex > tenantInstructionIndex
  );
  check(
    'guarda clínica é adicionada depois do prompt editável do tenant',
    tenantInstructionIndex >= 0 && clinicalGuardIndex > tenantInstructionIndex
  );
  check(
    'guarda contra reutilizar slots é adicionada depois do prompt editável do tenant',
    tenantInstructionIndex >= 0 && staleAvailabilityGuardIndex > tenantInstructionIndex
  );
  check(
    'runtime proíbe alternativa que finja disponibilidade do serviço pedido',
    runtimePrompt.includes('Nunca trate uma alternativa como se fosse o serviço pedido.')
  );
  check(
    'runtime proíbe diagnóstico, eficácia e promessa de resultado',
    runtimePrompt.includes('não diagnostique, não recomende tratamento') &&
      runtimePrompt.includes('não afirme adequação, eficácia, resultado')
  );
  check(
    'runtime invalida slots antigos e reforça resumo mais confirmação posterior',
    runtimePrompt.includes('qualquer horário recebido antes fica INVÁLIDO') &&
      runtimePrompt.includes('resumo COMPLETO e real de serviço, data, horário') &&
      runtimePrompt.includes('uma tool bloqueada ou um INTERNAL_HINT não é confirmação')
  );
  check(
    'runtime proíbe prefetch com 2+ profissionais e codifica nome versus tanto faz',
    runtimePrompt.includes(
      'NÃO consulte horários antes de o cliente dizer profissional específico ou "tanto faz"'
    ) &&
      runtimePrompt.includes('Depois de um nome, use o ID dele') &&
      runtimePrompt.includes('depois de "tanto faz", OMITA professionalId')
  );
  check(
    'runtime exige nova disponibilidade no mesmo turno após correção',
    runtimePrompt.includes('getAvailableSlots DE NOVO NO MESMO TURNO') &&
      runtimePrompt.includes('MESMO que os horários antigos pareçam coincidir')
  );
  check(
    'runtime proíbe expor plano, raciocínio, regras internas e escolhas de tool',
    whatsappStyleBlock.includes(
      'NUNCA narre plano, raciocínio, regras internas ou escolha de tool.'
    ) &&
      whatsappStyleBlock.includes(
        'Peeling tem dois profissionais habilitados (Júlia e Marina). Preciso perguntar a preferência antes de consultar horários.'
      ) &&
      whatsappStyleBlock.includes('O cliente quer...') &&
      whatsappStyleBlock.includes('O cliente pediu...') &&
      [
        'getAvailableSlots',
        'bookAppointment',
        'getServices',
        'getUpcomingAppointments',
        'cancelAppointment',
      ].every((toolName) => whatsappStyleBlock.includes(toolName))
  );
  check(
    'runtime exige converter metarraciocínio diretamente em fala ao cliente',
    whatsappStyleBlock.includes('Converta diretamente em fala ao cliente') &&
      whatsappStyleBlock.includes(
        'Peeling é com Júlia ou Marina. Você prefere uma profissional específica ou tanto faz?'
      )
  );
  check(
    'runtime trata availableSlots de falha qualificada como consulta já feita, sem requery',
    runtimePrompt.includes(
      'reason exatamente "blocked", "conflict" ou "outside_hours" E uma lista availableSlots'
    ) &&
      runtimePrompt.includes(
        'o calendário JÁ consultou a disponibilidade internamente: NÃO chame getAvailableSlots de novo.'
      ) &&
      runtimePrompt.includes('Ofereça SOMENTE os valores exatos de availableSlots') &&
      runtimePrompt.includes('message e hint nunca são horários.')
  );
  check(
    'runtime conserva fallback seguro quando a falha qualificada não traz availableSlots',
    runtimePrompt.includes(
      'Se essa falha qualificada não trouxer availableSlots, siga o hint e chame getAvailableSlots'
    ) &&
      runtimePrompt.includes('ANTES de sugerir qualquer alternativa')
  );
  check(
    'runtime trata availableSlots vazio como nenhuma alternativa no dia',
    runtimePrompt.includes(
      'se a lista vier vazia, não há alternativa naquele dia — ofereça tentar outra data'
    ) &&
      runtimePrompt.includes(
        'lista vazia significa que não há alternativa naquele dia.'
      ) &&
      runtimePrompt.includes(
        'lista vazia significa que não há alternativa naquele dia. Sem uma dessas fontes'
      )
  );
  check(
    'fonte crítica aceita somente as duas evidências autoritativas e rejeita campos auxiliares',
    runtimePrompt.includes('Há SOMENTE duas fontes de disponibilidade') &&
      runtimePrompt.includes('getAvailableSlots com JSON success:true e slots') &&
      runtimePrompt.includes('bookAppointment com JSON success:false') &&
      runtimePrompt.includes(
        'message, hint, package_exhausted, other, bookAppointment success:true, slots inválidos e dados de outro turno NÃO são disponibilidade.'
      )
  );
  check(
    'runtime exige bookAppointment para confirmações coloquiais claras nas duas grafias de tá bom',
    runtimePrompt.includes('Após esse resumo COMPLETO anterior, "pode sim", "tá bom", "ta bom" e "pode ser sim" são confirmações CLARAS: DEVE CHAMAR bookAppointment.')
  );
  check(
    'runtime mantém "pode ser" isolado como confirmação vaga',
    runtimePrompt.includes('"pode ser" SOZINHO') &&
      runtimePrompt.includes('NÃO confirmam: pergunte novamente de forma objetiva e aguarde.')
  );
  check(
    'runtime proíbe alegar sucesso antes de bookAppointment retornar success:true',
    runtimePrompt.includes('NUNCA diga que o agendamento foi confirmado, marcado ou agendado antes de bookAppointment retornar success:true.')
  );
  check(
    'marcador de profissional único exige consultar disponibilidade no mesmo turno após mudar para o serviço',
    runtimePrompt.includes('Profissional único habilitado: Profissional Smoke') &&
      runtimePrompt.includes('Agende DIRETO com ele(a); NÃO pergunte preferência de profissional.') &&
      runtimePrompt.includes('Se o cliente MUDAR PARA ESTE SERVIÇO, CHAME getAvailableSlots NO MESMO TURNO') &&
      runtimePrompt.includes('mesmo que data e profissional já sejam conhecidos.')
  );
  check(
    'marcador de 2+ profissionais reforça disponibilidade local após preferência resolvida',
    runtimePrompt.includes('com 2+ profissionais, NÃO consulte horários antes de o cliente dizer profissional específico ou "tanto faz"') &&
      runtimePrompt.includes('Depois de um nome, use o ID dele; depois de "tanto faz", OMITA professionalId.') &&
      runtimePrompt.includes('Após a preferência estar resolvida, se o cliente MUDAR PARA ESTE SERVIÇO, CHAME getAvailableSlots NO MESMO TURNO')
  );
  check(
    'checklist final exige uma das duas fontes no turno atual e preserva a regra G',
    runtimePrompt.includes('CHECKLIST FINAL DE DISPONIBILIDADE') &&
      runtimePrompt.includes('getAvailableSlots com success:true e slots, OU bookAppointment com success:false') &&
      runtimePrompt.includes('No segundo caso, ofereça SOMENTE os valores exatos de availableSlots') &&
      runtimePrompt.includes('Sem uma dessas fontes — inclusive se a falha não trouxer availableSlots') &&
      runtimePrompt.includes('Se serviço, data ou profissional mudaram, a regra G exige getAvailableSlots fresco no mesmo turno.')
  );
  check(
    'checklist final distingue preço, duração e horário de funcionamento de disponibilidade',
    runtimePrompt.includes('Preço, duração e horário de funcionamento NÃO são disponibilidade') &&
      runtimePrompt.includes('responda-os normalmente com os dados atuais.')
  );
  const availabilityTool = RECEPTIONIST_TOOLS.find(
    (tool) => tool.function.name === 'getAvailableSlots'
  );
  const bookingTool = RECEPTIONIST_TOOLS.find(
    (tool) => tool.function.name === 'bookAppointment'
  );
  check(
    'descrição de disponibilidade reforça preferência e correção',
    availabilityTool?.function.description?.includes(
      'NÃO chame antes de o cliente escolher'
    ) === true &&
      availabilityTool.function.description?.includes('no mesmo turno') === true
  );
  check(
    'descrição de booking rejeita horário escolhido e confirmação vaga',
    bookingTool?.function.description?.includes('escolher horário não confirma') ===
      true &&
      bookingTool.function.description?.includes('"acho que pode"') === true &&
      bookingTool.function.description?.includes('"pode ser"') === true
  );
  check(
    'descrição de booking exige chamada para confirmações coloquiais, preserva "pode ser" isolado e sucesso real',
    bookingTool?.function.description?.includes('"pode sim", "tá bom", "ta bom" e "pode ser sim" são confirmações claras: CHAME bookAppointment') === true &&
      bookingTool.function.description?.includes('"pode ser" SOZINHO') === true &&
      bookingTool.function.description?.includes('antes de bookAppointment retornar success:true') === true
  );

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }

  console.log('\nsmoke-receptionist-prompt-guards OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
