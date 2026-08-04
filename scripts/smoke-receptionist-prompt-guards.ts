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
  professionals: [{ id: 'prof-smoke', name: 'Profissional Smoke' }],
  services: [
    {
      id: 'svc-limpeza',
      name: 'Limpeza de Pele',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: ['prof-smoke'],
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

  const { buildSystemPromptFromServices } = await import('../src/services/brainService');
  const runtimePrompt = buildSystemPromptFromServices(
    config,
    servicesResult,
    new Date('2026-08-03T15:00:00.000Z')
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

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }

  console.log('\nsmoke-receptionist-prompt-guards OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
