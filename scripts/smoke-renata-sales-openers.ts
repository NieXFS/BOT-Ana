/** Smoke determinístico das aberturas CTWA, sem DB/Anthropic/rede. */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
delete process.env.ANTHROPIC_API_KEY;

import type { TenantBotConfig } from '../src/configProvider';
import type { Message } from '../src/services/contextManager';
import type { SalesReplyDeps } from '../src/services/salesBrain';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const config: TenantBotConfig = {
  tenantSlug: 'receps-vendas',
  botName: 'Renata',
  botRole: 'sales',
  systemPrompt: 'x',
  greetingMessage: null,
  fallbackMessage: 'fallback',
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-5',
  aiTemperature: 0.4,
  aiMaxTokens: 500,
  openaiApiKey: null,
  botIsAlwaysActive: true,
  botActiveStart: '00:00',
  botActiveEnd: '23:59',
  timezone: 'America/Sao_Paulo',
  waAccessToken: 'token',
  waApiVersion: 'v21.0',
  phoneNumberId: 'PN_SALES',
  isActive: true,
};

async function main(): Promise<void> {
  const {
    AD_OPENING_MESSAGES,
    OPENER_SCRIPTS,
    matchAdOpening,
    pickOpenerScript,
  } = await import('../src/services/salesOpeners');
  const { getSalesReply } = await import('../src/services/salesBrain');

  check('casa abertura clínica', matchAdOpening(AD_OPENING_MESSAGES[0]));
  check('casa abertura anúncio', matchAdOpening(AD_OPENING_MESSAGES[1]));
  check(
    'robusto a caixa/pontuação/emoji',
    matchAdOpening('  OI! ME IDENTIFIQUEI COM O ANÚNCIO... ME CONTA COMO FUNCIONA?! 😊 ')
  );
  check('não casa texto próprio', !matchAdOpening('Oi, quero saber os preços.'));
  check(
    'rotação por telefone é determinística',
    pickOpenerScript('5511000000001') === pickOpenerScript('5511000000001')
  );
  check(
    'script pertence ao pool',
    OPENER_SCRIPTS.includes(
      pickOpenerScript('5511000000002') as (typeof OPENER_SCRIPTS)[number]
    )
  );

  const history: Message[] = [];
  const events: string[] = [];
  let schedules = 0;
  const deps: SalesReplyDeps = {
    addMessage: async (_key, role, content) => {
      history.push({ role, content });
    },
    scheduleFollowup: async () => {
      schedules += 1;
    },
    setChannelPreference: async () => undefined,
    getHistory: async () => [...history],
    emitEvent: async (_pn, _phone, type) => {
      events.push(type);
    },
  };

  const reply = await getSalesReply(
    '5511000000003',
    AD_OPENING_MESSAGES[0],
    'Cliente',
    config,
    deps
  );
  check('1º inbound casado devolve script sem Anthropic key', OPENER_SCRIPTS.includes(reply as (typeof OPENER_SCRIPTS)[number]));
  check('histórico guarda user + assistant', history.map((m) => m.role).join(',') === 'user,assistant');
  check('assistant guardado é o reply original', history[1]?.content === reply);
  check('régua foi agendada', schedules === 1);
  check('emitiu primeira_resposta', events.join(',') === 'primeira_resposta');

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-sales-openers OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
