/**
 * Registry por conversa do Workstream D. Puro/offline: não chama DB, Receps,
 * Anthropic nem WhatsApp.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.ERP_API_TOKEN =
  process.env.ERP_API_TOKEN ?? 'smoke-erp-token';

import fs from 'node:fs';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const brain = await import('../src/services/brainService');
  const onboarding = await import('../src/services/onboardingBrain');
  const session = await import('../src/services/onboardingSession');

  check(
    'onboarding permanece no Sonnet fora do canário de vendas',
    onboarding.resolveOnboardingModel() === 'claude-sonnet-5'
  );

  console.log('▶ precedência da ponte por conversa');
  check(
    'recepcionista não entra na ponte',
    brain.resolveConversationBrainRole({
      baseRole: 'receptionist',
      paused: false,
      claimStatus: 'accepted',
      onboardingState: 'open',
    }) === 'receptionist'
  );
  check(
    'pausa vence claim e sessão',
    brain.resolveConversationBrainRole({
      baseRole: 'sales',
      paused: true,
      claimStatus: 'accepted',
      onboardingState: 'open',
    }) === 'paused'
  );
  check(
    'claim bem-sucedido entra em onboarding no mesmo turno',
    brain.resolveConversationBrainRole({
      baseRole: 'sales',
      paused: false,
      claimStatus: 'accepted',
      onboardingState: 'none',
    }) === 'onboarding'
  );
  check(
    'claim recusado não cai em sales',
    brain.resolveConversationBrainRole({
      baseRole: 'sales',
      paused: false,
      claimStatus: 'rejected',
      onboardingState: 'none',
    }) === 'claim'
  );
  check(
    'sessão aberta vence sales',
    brain.resolveConversationBrainRole({
      baseRole: 'sales',
      paused: false,
      claimStatus: 'none',
      onboardingState: 'open',
    }) === 'onboarding'
  );
  check(
    'sem claim/sessão permanece sales',
    brain.resolveConversationBrainRole({
      baseRole: 'sales',
      paused: false,
      claimStatus: 'none',
      onboardingState: 'none',
    }) === 'sales'
  );
  check(
    'estado ERP ambíguo/indisponível nunca cai em vendas',
    ['blocked', 'unavailable'].every(
      (onboardingState) =>
        brain.resolveConversationBrainRole({
          baseRole: 'sales',
          paused: false,
          claimStatus: 'none',
          onboardingState: onboardingState as 'blocked' | 'unavailable',
        }) === 'blocked'
    )
  );
  check(
    'claim reconhece prefixo e separadores',
    session.matchOnboardingClaimCode(
      'Meu código é ONB-ABCDE-23456.'
    ) === 'ABCDE23456'
  );
  check(
    'claim reconhece código sem prefixo e com espaço',
    session.matchOnboardingClaimCode('ABCDE 23456') ===
      'ABCDE23456'
  );
  check(
    'texto comum não vira autorização',
    session.matchOnboardingClaimCode(
      'Quero configurar minha clínica'
    ) === null
  );

  console.log('▶ isolamento dos caminhos existentes');
  const brainSource = fs.readFileSync(
    new URL('../src/services/brainService.ts', import.meta.url),
    'utf8'
  );
  const salesSource = fs.readFileSync(
    new URL('../src/services/salesBrain.ts', import.meta.url),
    'utf8'
  );
  const resolverSource = brainSource.match(
    /export function resolveBrainRole[\s\S]*?return config\.botRole === 'sales' \? 'sales' : 'receptionist';\n}/
  )?.[0];
  check(
    'resolveBrainRole permanece com o corpo canônico',
    Boolean(resolverSource)
  );
  check(
    'resolveBrainRole não ganhou o papel por configuração',
    !resolverSource?.includes('onboarding')
  );
  check(
    'fallback sem sessão chama o getSalesReply existente',
    /return getSalesReply\(phone, userMessage, userName, config\);/.test(
      brainSource
    )
  );
  check(
    'getSalesReply não ganhou dependência de onboarding',
    !/onboarding/i.test(
      salesSource.slice(
        salesSource.indexOf('export async function getSalesReply(')
      )
    )
  );
  check(
    'recepcionista continua sendo o retorno final do dispatcher',
    /return getReceptionistReply\(phone, userMessage, userName, config\);/.test(
      brainSource
    )
  );

  console.log('▶ toolset e prompt caching');
  const expectedOrder = [
    'getOnboardingState',
    'upsertService',
    'setSchedule',
    'addProfessional',
    'updateClinicInfo',
    'getWhatsappStatus',
    'sendConnectLink',
    'completeOnboarding',
    'handoffToHuman',
  ];
  check(
    '9 tools na ordem canônica',
    JSON.stringify(onboarding.ONBOARDING_TOOLS.map((tool) => tool.name)) ===
      JSON.stringify(expectedOrder)
  );
  check(
    'handoff é a última tool e carrega cache_control',
    onboarding.ONBOARDING_TOOLS.at(-1)?.name === 'handoffToHuman' &&
      onboarding.ONBOARDING_TOOLS.at(-1)?.cache_control?.type ===
        'ephemeral'
  );
  check(
    'nenhuma tool anterior carrega cache_control',
    onboarding.ONBOARDING_TOOLS
      .slice(0, -1)
      .every((tool) => !tool.cache_control)
  );

  const config = {
    tenantSlug: 'receps-vendas',
    botName: 'Renata',
    botRole: 'sales',
    systemPrompt: 'MANUAL SALVO',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    aiTemperature: 0.4,
    aiMaxTokens: 700,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PNID',
    isActive: true,
  };
  const state = {
    session: {
      id: 'session',
      stage: 'welcome',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'OPEN' as const,
      derivedStage: 'services' as const,
    },
    tenant: {
      name: 'Clínica',
      segment: null,
      planSlug: 'essencial',
      maxProfessionals: 2,
      professionalsActive: 1,
      setupCompletedAt: null,
    },
    catalog: {
      servicesCount: 0,
      seedServicesCount: 0,
      services: [],
    },
    schedule: {
      openingTime: '08:00',
      closingTime: '20:00',
      slotIntervalMinutes: 30,
      scheduleLocked: false,
    },
    whatsapp: {
      connected: false,
      coexistence: false,
      connectedAt: null,
    },
  };
  const system = onboarding.buildOnboardingSystem(config, state);
  check(
    'bloco estável inclui manual salvo e cache_control',
    system[0]?.text.includes('MANUAL SALVO') &&
      system[0]?.cache_control?.type === 'ephemeral'
  );
  check(
    'estado atual fica no bloco volátil sem cache',
    system[1]?.text.includes('"derivedStage":"services"') &&
      !system[1]?.cache_control
  );
  check(
    'request do onboarding não envia temperature',
    !/\btemperature\s*:/.test(
      fs.readFileSync(
        new URL('../src/services/onboardingBrain.ts', import.meta.url),
        'utf8'
      )
    )
  );

  if (failures > 0) {
    throw new Error(
      `smoke-onboarding-registry falhou: ${failures} check(s)`
    );
  }
  console.log('\n✅ smoke-onboarding-registry OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
