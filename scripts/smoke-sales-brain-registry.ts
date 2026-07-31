/**
 * Smoke DETERMINÍSTICO do brain registry da Renata (Workstream B). Sem rede /
 * Anthropic. Cobre: seleção de brain por botRole (receptionist ↔ sales),
 * typingDelay OFF em sales, prompt caching ligado (system + tools), injeção do
 * {{PLANOS}} e a garantia de que o bloco de preços NÃO traz valor fora da
 * sales-config (o modelo nunca inventa preço).
 *
 * Rodar: npx tsx scripts/smoke-sales-brain-registry.ts
 */
// DATABASE_URL só pra o import do grafo (contextManager cria um Pool LAZY — não
// conecta). Setado ANTES dos imports dinâmicos abaixo.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { SalesConfig } from '../src/salesConfigProvider';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function makeConfig(botRole: string, systemPrompt = 'Persona.'): TenantBotConfig {
  return {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole,
    systemPrompt,
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: botRole === 'sales' ? 'anthropic' : 'openai',
    aiModel: botRole === 'sales' ? 'claude-sonnet-5' : 'gpt-4o-mini',
    aiTemperature: 0.5,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '08:00',
    botActiveEnd: '20:00',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'tok',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PNID',
    isActive: true,
  };
}

const salesConfig: SalesConfig = {
  currency: 'BRL',
  annualFreeMonths: 2,
  signupBaseUrl: 'https://receps.com.br/cadastro',
  plans: [
    {
      slug: 'atendente-ia',
      name: 'Somente Atendente IA',
      sellable: false,
      priceMonthly: 99.99,
      priceMonthlyFormatted: 'R$ 99,99',
      priceAnnualTotalFormatted: 'R$ 999,90',
      priceAnnualMonthlyFormatted: 'R$ 83,32',
      annualFreeMonths: 2,
      trialDays: 7,
      maxProfessionals: 1,
      features: ['Ana 24h no WhatsApp'],
      waitlist: { reason: 'em atualização', href: 'https://wa.me/5516991113783' },
    },
    {
      slug: 'essencial',
      name: 'Essencial',
      sellable: true,
      priceMonthly: 159.99,
      priceMonthlyFormatted: 'R$ 159,99',
      priceAnnualTotalFormatted: 'R$ 1.599,90',
      priceAnnualMonthlyFormatted: 'R$ 133,32',
      annualFreeMonths: 2,
      trialDays: 7,
      maxProfessionals: 3,
      features: ['Agenda completa', 'Financeiro'],
    },
    {
      slug: 'pro',
      name: 'Pro',
      sellable: true,
      priceMonthly: 299.99,
      priceMonthlyFormatted: 'R$ 299,99',
      priceAnnualTotalFormatted: 'R$ 2.999,90',
      priceAnnualMonthlyFormatted: 'R$ 249,99',
      annualFreeMonths: 2,
      trialDays: 14,
      maxProfessionals: null,
      features: ['Ana ilimitada', 'Prontuário'],
    },
  ],
  anaBeta: { testing: true, waitlistHref: 'https://wa.me/5516991113783', notice: 'plano em atualização' },
};

async function main() {
  const { resolveBrainRole } = await import('../src/services/brainService');
  const { typingSimEnabled } = await import('../src/messageHandler');
  const {
    SALES_TOOLS,
    buildSalesSystem,
    buildStableSalesPrompt,
  } = await import(
    '../src/services/salesBrain'
  );
  const {
    rememberConversationAdHeadline,
    getConversationAdHeadline,
    clearConversationAdHeadlines,
  } = await import('../src/services/salesAdState');
  const { renderPlansBlock } = await import('../src/salesConfigProvider');

  console.log('▶ brain registry (botRole)');
  check('sales → sales', resolveBrainRole(makeConfig('sales')) === 'sales');
  check('receptionist → receptionist', resolveBrainRole(makeConfig('receptionist')) === 'receptionist');
  check('botRole vazio → receptionist (fallback)', resolveBrainRole(makeConfig('')) === 'receptionist');
  check(
    'recepcionista permanece no caminho byte-idêntico para qualquer role não-sales',
    ['receptionist', '', 'legacy'].every(
      (role) => resolveBrainRole(makeConfig(role)) === 'receptionist'
    )
  );

  console.log('▶ typingDelay OFF em sales');
  check('sales → typing OFF', typingSimEnabled(makeConfig('sales')) === false);
  check('receptionist → typing ON (intocado)', typingSimEnabled(makeConfig('receptionist')) === true);

  console.log('▶ prompt caching (Anthropic)');
  const lastTool = SALES_TOOLS[SALES_TOOLS.length - 1];
  check('última tool tem cache_control', (lastTool as { cache_control?: unknown }).cache_control != null);
  check(
    'toolset inclui sendDemoVideo antes do handoff',
    SALES_TOOLS.map((t) => t.name).join(',') ===
      'getAvailableSlots,scheduleDemo,sendSignupLink,sendPrefilledSignup,registerQualifiedLead,sendDemoVideo,handoffToHuman'
  );
  // O cache_control mora na ÚLTIMA tool (cacheia todas as definições). Tool nova
  // entra ANTES do handoffToHuman de propósito — se alguém a pendurar no fim sem
  // mover o cache_control, o caching das tools morre em silêncio.
  check('handoffToHuman continua sendo a última (âncora do cache)', lastTool.name === 'handoffToHuman');
  check(
    'só a última tool tem cache_control',
    SALES_TOOLS.filter((t) => (t as { cache_control?: unknown }).cache_control != null).length === 1
  );
  check(
    'sendPrefilledSignup required = só e-mail e plano',
    (() => {
      const tool = SALES_TOOLS.find((t) => t.name === 'sendPrefilledSignup');
      const required = (tool?.input_schema as { required?: string[] })?.required ?? [];
      return required.join(',') === 'email,plan';
    })()
  );
  check(
    'sendPrefilledSignup expõe niche enum + professionalsCount integer opcionais',
    (() => {
      const tool = SALES_TOOLS.find((t) => t.name === 'sendPrefilledSignup');
      const properties = (
        tool?.input_schema as {
          properties?: Record<string, { type?: string; enum?: string[] }>;
        }
      )?.properties;
      return (
        properties?.professionalsCount?.type === 'integer' &&
        properties?.niche?.type === 'string' &&
        properties?.niche?.enum?.join(',') ===
          'estetica_facial_corporal,sobrancelhas_cilios,podologia,depilacao,outro'
      );
    })()
  );
  check(
    'sendPrefilledSignup instrui a CONFIRMAR o e-mail antes de gerar',
    /confirme o e-mail/i.test(
      SALES_TOOLS.find((t) => t.name === 'sendPrefilledSignup')?.description ?? ''
    )
  );
  check(
    'sendPrefilledSignup instrui reenvio do mesmo link e agenda pronta',
    (() => {
      const description =
        SALES_TOOLS.find((t) => t.name === 'sendPrefilledSignup')?.description ?? '';
      return /mesmo link/i.test(description) && /agenda pronta/i.test(description);
    })()
  );
  check(
    'sendSignupLink continua no toolset (fallback de quem não dá e-mail)',
    SALES_TOOLS.some((t) => t.name === 'sendSignupLink')
  );
  check(
    'sendDemoVideo não exige parâmetros',
    (() => {
      const tool = SALES_TOOLS.find((item) => item.name === 'sendDemoVideo');
      const required =
        (tool?.input_schema as { required?: string[] })?.required ?? [];
      return required.length === 0;
    })()
  );
  check(
    'registerQualifiedLead expõe interest com enum das 3 trilhas',
    (() => {
      const tool = SALES_TOOLS.find(
        (item) => item.name === 'registerQualifiedLead'
      );
      const interest = (
        tool?.input_schema as {
          properties?: Record<string, { enum?: string[] }>;
        }
      )?.properties?.interest;
      return interest?.enum?.join(',') === 'sistema,ia,ambos';
    })()
  );
  check(
    'handoff não usa sinal de compra como gatilho',
    (() => {
      const description =
        SALES_TOOLS.find((item) => item.name === 'handoffToHuman')
          ?.description ?? '';
      return /sinal de compra NÃO é handoff/i.test(description);
    })()
  );
  const system = buildSalesSystem(makeConfig('sales', 'M {{PLANOS}} F'), renderPlansBlock(salesConfig));
  check('system[0] (estável) tem cache_control', (system[0] as { cache_control?: unknown }).cache_control != null);
  check('system[1] (volátil) SEM cache_control', (system[1] as { cache_control?: unknown }).cache_control == null);
  check('system[1] é o contexto temporal', system[1].text.includes('CONTEXTO TEMPORAL'));
  const headline = 'A Ana responde suas clientes no WhatsApp';
  const withHeadline = buildSalesSystem(
    makeConfig('sales', 'M {{PLANOS}} F'),
    renderPlansBlock(salesConfig),
    { adHeadline: headline }
  );
  check(
    'headline entra somente no bloco volátil',
    !withHeadline[0].text.includes(headline) &&
      withHeadline[1].text.includes(headline) &&
      withHeadline[1].text.includes('CONFIRMAR a trilha provável')
  );
  check(
    'sem headline o bloco específico fica ausente',
    !system[1].text.includes('HEADLINE DO ANÚNCIO')
  );
  rememberConversationAdHeadline('PN:lead', `${headline}${'x'.repeat(250)}`);
  rememberConversationAdHeadline('PN:lead', 'segunda headline');
  check(
    'estado de headline é first-write-wins e truncado em 200 chars',
    getConversationAdHeadline('PN:lead')?.startsWith(headline) === true &&
      getConversationAdHeadline('PN:lead')?.length === 200
  );
  clearConversationAdHeadlines(['PN:lead']);
  check(
    'reset administrativo limpa headline volátil',
    getConversationAdHeadline('PN:lead') === null
  );

  console.log('▶ injeção do {{PLANOS}}');
  const plansBlock = renderPlansBlock(salesConfig);
  const withPlaceholder = buildStableSalesPrompt(makeConfig('sales', 'Antes {{PLANOS}} Depois'), plansBlock);
  check('placeholder substituído', !withPlaceholder.includes('{{PLANOS}}'));
  check('bloco de planos injetado no lugar', withPlaceholder.includes('R$ 159,99'));
  check('identidade Renata presente', withPlaceholder.includes('Renata'));
  const withoutPlaceholder = buildStableSalesPrompt(makeConfig('sales', 'Sem placeholder aqui'), plansBlock);
  check('sem placeholder → bloco anexado no fim', withoutPlaceholder.includes('R$ 299,99'));

  console.log('▶ preços SÓ da sales-config (adversarial: nada de memória)');
  check('essencial mensal presente', plansBlock.includes('R$ 159,99'));
  check('pro mensal presente', plansBlock.includes('R$ 299,99'));
  check('equivalente mensal anual presente', plansBlock.includes('R$ 133,32'));
  check('header "NUNCA cite preço de memória"', plansBlock.includes('NUNCA cite preço de memória'));
  check('plano pausado NÃO é vendido (sem preço no bloco)', !plansBlock.includes('R$ 99,99'));
  check(
    'plano pausado → lista de interesse com link',
    plansBlock.includes('lista de interesse') && plansBlock.includes('wa.me/5516991113783')
  );
  const allowed = new Set<string>();
  for (const p of salesConfig.plans) {
    if (!p.sellable) continue;
    allowed.add(p.priceMonthlyFormatted);
    allowed.add(p.priceAnnualTotalFormatted);
    allowed.add(p.priceAnnualMonthlyFormatted);
  }
  const found = plansBlock.match(/R\$\s[\d.]+,\d{2}/g) ?? [];
  const stray = found.filter((v) => !allowed.has(v));
  check(`nenhum preço fora da config (${found.length} achados)`, stray.length === 0);

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-sales-brain-registry OK');
}

main().catch((err) => {
  console.error('❌ erro no smoke:', err);
  process.exit(1);
});
