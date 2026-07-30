import {
  callAnthropicWithRetry,
  isRetryableAnthropicError,
} from '../src/utils/anthropicRetry';

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function expectReject(
  label: string,
  task: () => Promise<unknown>
): Promise<unknown> {
  try {
    await task();
    check(label, false);
    return null;
  } catch (error) {
    check(label, true);
    return error;
  }
}

async function main(): Promise<void> {
  const patientSleeps: number[] = [];
  let patientAttempts = 0;
  const exhausted = await expectReject(
    '529 esgota e propaga depois da política patient',
    () =>
      callAnthropicWithRetry(
        async () => {
          patientAttempts += 1;
          throw Object.assign(new Error('overloaded'), { status: 529 });
        },
        'smoke-529',
        'patient',
        {
          sleep: async (ms) => {
            patientSleeps.push(ms);
          },
          now: () => 0,
          random: () => 0.5,
        }
      )
  );
  check('patient faz 7 tentativas', patientAttempts === 7);
  check(
    'patient usa backoff crescente até teto',
    patientSleeps.join(',') === '1000,2000,4000,8000,10000,10000'
  );
  check(
    'patient respeita orçamento total de 35s',
    patientSleeps.reduce((sum, ms) => sum + ms, 0) === 35_000
  );
  check(
    'erro esgotado recebe marcador retry_exhausted',
    Boolean(
      exhausted &&
        typeof exhausted === 'object' &&
        (exhausted as Record<string, unknown>).retry_exhausted === true
    )
  );

  const overloadedSleeps: number[] = [];
  let overloadedAttempts = 0;
  const overloadedResult = await callAnthropicWithRetry(
    async () => {
      overloadedAttempts += 1;
      if (overloadedAttempts < 3) {
        throw {
          error: { error: { type: 'overloaded_error' } },
        };
      }
      return 'recuperou';
    },
    'smoke-overloaded-shape',
    'patient',
    {
      sleep: async (ms) => {
        overloadedSleeps.push(ms);
      },
      now: () => 0,
      random: () => 0,
    }
  );
  check('overloaded_error é retryable', isRetryableAnthropicError({
    error: { error: { type: 'overloaded_error' } },
  }));
  check(
    'overloaded_error recupera na tentativa N',
    overloadedResult === 'recuperou' && overloadedAttempts === 3
  );
  check(
    'jitter -25% continua crescente',
    overloadedSleeps.join(',') === '750,1500'
  );

  const retryAfterSleeps: number[] = [];
  let retryAfterAttempts = 0;
  await callAnthropicWithRetry(
    async () => {
      retryAfterAttempts += 1;
      if (retryAfterAttempts === 1) {
        throw {
          status: 429,
          headers: { 'retry-after': '7' },
        };
      }
      return 'ok';
    },
    'smoke-retry-after',
    'patient',
    {
      sleep: async (ms) => {
        retryAfterSleeps.push(ms);
      },
      now: () => 0,
      random: () => 0.5,
    }
  );
  check('retry-after em segundos espera pelo menos 7s', retryAfterSleeps[0] >= 7_000);

  for (const status of [400, 401]) {
    const sleeps: number[] = [];
    let attempts = 0;
    await expectReject(`${status} falha na primeira tentativa`, () =>
      callAnthropicWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        },
        `smoke-${status}`,
        'patient',
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }
      )
    );
    check(`${status} não dorme`, attempts === 1 && sleeps.length === 0);
  }

  let networkAttempts = 0;
  const networkResult = await callAnthropicWithRetry(
    async () => {
      networkAttempts += 1;
      if (networkAttempts === 1) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      }
      return 'rede-ok';
    },
    'smoke-network',
    'patient',
    { sleep: async () => undefined, random: () => 0.5 }
  );
  check(
    'ECONNRESET é retryado',
    networkResult === 'rede-ok' && networkAttempts === 2
  );

  const quickSleeps: number[] = [];
  let quickAttempts = 0;
  const quickResult = await callAnthropicWithRetry(
    async () => {
      quickAttempts += 1;
      if (quickAttempts < 4) {
        throw Object.assign(new Error('busy'), { status: 529 });
      }
      return 'quick-ok';
    },
    'smoke-quick',
    'quick',
    {
      sleep: async (ms) => {
        quickSleeps.push(ms);
      },
    }
  );
  check(
    'quick preserva escada curta 1s/2s/4s',
    quickResult === 'quick-ok' &&
      quickAttempts === 4 &&
      quickSleeps.join(',') === '1000,2000,4000'
  );

  if (failures > 0) {
    throw new Error(`${failures} check(s) falharam.`);
  }
  console.log('\n✅ smoke-anthropic-retry OK');
}

main().catch((error) => {
  console.error('❌ smoke-anthropic-retry falhou:', error);
  process.exitCode = 1;
});
