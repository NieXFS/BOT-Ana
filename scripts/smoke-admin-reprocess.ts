process.env.DATABASE_URL ||=
  'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type {
  AdminReprocessDeps,
  AdminReprocessInput,
} from '../src/services/adminReprocess';
import type { Message } from '../src/services/contextManager';

const config: TenantBotConfig = {
  tenantSlug: 'receps-vendas',
  botName: 'Renata',
  botRole: 'sales',
  systemPrompt: '',
  greetingMessage: null,
  fallbackMessage: null,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-5',
  aiTemperature: 0,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN_VENDAS',
  isActive: true,
};

const input: AdminReprocessInput = {
  phoneNumberId: 'PN_VENDAS',
  customerPhone: '+5516999990000',
};

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function makeDeps(options: {
  history: Message[];
  generated?: string;
  brainFails?: boolean;
}): {
  deps: AdminReprocessDeps;
  generatedCalls: string[];
  sent: Array<{ phone: string; text: string }>;
  cleared: string[];
} {
  const generatedCalls: string[] = [];
  const sent: Array<{ phone: string; text: string }> = [];
  const cleared: string[] = [];

  return {
    generatedCalls,
    sent,
    cleared,
    deps: {
      getConfig: async () => config,
      getHistory: async (conversationKey) =>
        conversationKey === 'PN_VENDAS:5516999990000'
          ? options.history
          : [],
      generate: async (phone, _userName, _config, retryOptions) => {
        generatedCalls.push(`${phone}:${retryOptions?.retryPolicy ?? ''}`);
        if (options.brainFails) throw new Error('brain indisponível');
        return options.generated ?? 'resposta gerada';
      },
      send: async (phone, text) => {
        sent.push({ phone, text });
      },
      clearRecovery: (conversationKey) => {
        cleared.push(conversationKey);
      },
    },
  };
}

async function main(): Promise<void> {
  const {
    isValidAdminReprocessInput,
    reprocessSalesResponse,
  } = await import('../src/services/adminReprocess');
  const { HUMAN_ECHO_PREFIX } = await import(
    '../src/services/contextManager'
  );

  check('body vazio é inválido', !isValidAdminReprocessInput({}));
  check(
    'body com strings vazias é inválido',
    !isValidAdminReprocessInput({
      phoneNumberId: ' ',
      customerPhone: '',
    })
  );
  check('body válido é aceito', isValidAdminReprocessInput(input));

  {
    const fixture = makeDeps({
      history: [{ role: 'assistant', content: 'mensagem sem inbound' }],
    });
    const result = await reprocessSalesResponse(input, fixture.deps);
    check(
      'histórico sem user retorna sem_inbound',
      !result.replied && result.reason === 'sem_inbound'
    );
  }

  {
    const fixture = makeDeps({
      history: [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'resposta persistida' },
      ],
    });
    const result = await reprocessSalesResponse(input, fixture.deps);
    check('assistant-último é reenviado sem gerar', fixture.generatedCalls.length === 0);
    check(
      'reenvio usa wa_id cru derivado da conversationKey',
      fixture.sent[0]?.phone === '5516999990000' &&
        fixture.sent[0]?.text === 'resposta persistida'
    );
    check('reenvio bem-sucedido retorna replied true', result.replied === true);
  }

  {
    const fixture = makeDeps({
      history: [
        { role: 'user', content: 'oi' },
        {
          role: 'assistant',
          content: `${HUMAN_ECHO_PREFIX}resposta humana`,
        },
      ],
    });
    const result = await reprocessSalesResponse(input, fixture.deps);
    check(
      'echo humano assistant-último retorna ja_respondida',
      !result.replied && result.reason === 'ja_respondida'
    );
    check(
      'echo humano não chama brain nem envia',
      fixture.generatedCalls.length === 0 && fixture.sent.length === 0
    );
  }

  {
    const fixture = makeDeps({
      history: [{ role: 'user', content: 'quero saber mais' }],
      generated: 'resposta nova',
    });
    const result = await reprocessSalesResponse(input, fixture.deps);
    check(
      'user-último gera com policy quick',
      fixture.generatedCalls.join(',') === '5516999990000:quick'
    );
    check(
      'sucesso entrega e limpa recovery',
      result.replied === true &&
        fixture.sent[0]?.text === 'resposta nova' &&
        fixture.cleared.join(',') === 'PN_VENDAS:5516999990000'
    );
  }

  {
    const fixture = makeDeps({
      history: [{ role: 'user', content: 'oi' }],
      brainFails: true,
    });
    const result = await reprocessSalesResponse(input, fixture.deps);
    check(
      'brain quebrado retorna slug seguro',
      !result.replied && result.reason === 'brain_failed'
    );
    check('brain quebrado não tenta enviar', fixture.sent.length === 0);
  }

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }
  console.log('\n✅ smoke-admin-reprocess OK');
}

main().catch((error) => {
  console.error('❌ smoke-admin-reprocess falhou:', error);
  process.exitCode = 1;
});
