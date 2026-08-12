process.env.RECEPS_IA_SENTRY_DSN = '';
process.env.ANA_SENTRY_DSN = '';
process.env.SENTRY_DSN = '';

import { readFileSync } from 'node:fs';
import { isPausedFromState } from '../src/services/pauseDecision';
import {
  isConversationPaused,
  __resetPauseCacheForTest,
} from '../src/services/pauseService';
import {
  ANA_TECHNICAL_MAINTENANCE_CANARY_SLUG,
  observeTechnicalMaintenance,
  shouldFailClosedForTechnicalMaintenance,
  __resetTechnicalMaintenanceCacheForTest,
} from '../src/services/technicalMaintenanceCache';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const now = Date.UTC(2026, 7, 12, 18, 0, 0);
const future = new Date(now + 60_000).toISOString();

async function main() {
  __resetPauseCacheForTest();
  __resetTechnicalMaintenanceCacheForTest();

  check(
    'contrato antigo sem technicalMaintenance continua válido',
    isPausedFromState(
      {
        globalPausedUntil: null,
        conversationPausedUntil: null,
        schedulePausedUntil: null,
      },
      now
    ) === false
  );
  check(
    'technicalMaintenance.paused pausa mesmo sem sentinela',
    isPausedFromState(
      {
        globalPausedUntil: null,
        conversationPausedUntil: null,
        schedulePausedUntil: null,
        technicalMaintenance: {
          enabled: true,
          paused: true,
          exempt: false,
        },
      },
      now
    ) === true
  );
  check(
    'Vitin exempt não pausa pelo modo técnico',
    isPausedFromState(
      {
        globalPausedUntil: null,
        conversationPausedUntil: null,
        schedulePausedUntil: null,
        technicalMaintenance: {
          enabled: true,
          paused: false,
          exempt: true,
        },
      },
      now
    ) === false
  );
  check(
    'pausa manual do Vitin continua valendo',
    isPausedFromState(
      {
        globalPausedUntil: future,
        conversationPausedUntil: null,
        schedulePausedUntil: null,
        technicalMaintenance: {
          enabled: true,
          paused: false,
          exempt: true,
        },
      },
      now
    ) === true
  );
  check(
    'horário programado do Vitin continua valendo',
    isPausedFromState(
      {
        globalPausedUntil: null,
        conversationPausedUntil: null,
        schedulePausedUntil: future,
        technicalMaintenance: {
          enabled: true,
          paused: false,
          exempt: true,
        },
      },
      now
    ) === true
  );
  check(
    'fail-closed consulta slug em cache de config',
    readFileSync('src/services/pauseService.ts', 'utf8').includes(
      'peekCachedTenantSlug'
    )
  );

  const blocked = await isConversationPaused('pnid-other', '5511999990000', {
    now: () => now,
    fetchState: async () => ({
      globalPausedUntil: null,
      conversationPausedUntil: null,
      schedulePausedUntil: null,
      technicalMaintenance: {
        enabled: true,
        paused: true,
        exempt: false,
        exemptTenantId: 'canary',
        version: 1,
      },
    }),
  });
  check('runtime recebe modo técnico e pausa não-isento', blocked === true);

  const afterOutage = await isConversationPaused('pnid-other', '5511999990000', {
    now: () => now + 30_000,
    fetchState: async () => null,
  });
  check(
    'ERP indisponível após ON permanece fail-closed para não-isento',
    afterOutage === true
  );

  __resetPauseCacheForTest();
  const vitin = await isConversationPaused('pnid-vitin', '5511888880000', {
    now: () => now,
    fetchState: async () => ({
      globalPausedUntil: null,
      conversationPausedUntil: null,
      schedulePausedUntil: null,
      technicalMaintenance: {
        enabled: true,
        paused: false,
        exempt: true,
        exemptTenantId: 'canary',
        version: 1,
      },
    }),
  });
  check('Vitin processa com modo ON', vitin === false);

  const vitinOutage = await isConversationPaused('pnid-vitin', '5511888880000', {
    now: () => now + 30_000,
    fetchState: async () => null,
  });
  check('ERP indisponível não pausa o Vitin já observado como isento', vitinOutage === false);

  observeTechnicalMaintenance({
    phoneNumberId: 'pnid-unknown',
    snapshot: {
      enabled: true,
      paused: true,
      exempt: false,
      exemptTenantId: 'canary',
    },
    tenantSlug: 'clinica-x',
  });
  check(
    'tenant desconhecido após ON fica fail-closed',
    shouldFailClosedForTechnicalMaintenance({ phoneNumberId: 'pnid-new' }) === true
  );
  check(
    'slug do canário não fica fail-closed',
    shouldFailClosedForTechnicalMaintenance({
      phoneNumberId: 'pnid-new-vitin',
      tenantSlug: ANA_TECHNICAL_MAINTENANCE_CANARY_SLUG,
    }) === false
  );

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }
  console.log('\n✅ smoke-ana-technical-maintenance OK');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
