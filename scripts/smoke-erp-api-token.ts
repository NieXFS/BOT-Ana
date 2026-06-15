/**
 * Smoke do resolvedor do ERP_API_TOKEN (M25). Prova que o default público fraco
 * ('minha-chave-secreta-receps-123') sumiu e a nova política vale:
 *   - produção sem token → LANÇA (no boot, PM2 não sobe);
 *   - dev sem token → warning + token efêmero aleatório (não trava o local);
 *   - token real no env → respeitado verbatim em qualquer ambiente.
 *
 * Controla NODE_ENV + ERP_API_TOKEN ANTES de cada import/chamada (o módulo lê o
 * env no load), usando import dinâmico + cache-bust para o teste de throw-no-boot.
 *
 * Rodar: npx ts-node -T scripts/smoke-erp-api-token.ts
 */
const WEAK_DEFAULT = 'minha-chave-secreta-receps-123';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

async function main() {
  // Pega a FUNÇÃO num modo seguro (dev sem token não lança no load).
  process.env.NODE_ENV = 'development';
  delete process.env.ERP_API_TOKEN;
  const { resolveErpApiToken } = await import('../src/erpApiToken');

  console.log('[1] produção sem token → throw');
  process.env.NODE_ENV = 'production';
  delete process.env.ERP_API_TOKEN;
  let threw = false;
  let msg = '';
  try {
    resolveErpApiToken();
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  check('lança em produção sem ERP_API_TOKEN', threw && msg.includes('ERP_API_TOKEN missing'), msg);

  console.log('[2] dev sem token → efêmero aleatório');
  process.env.NODE_ENV = 'development';
  delete process.env.ERP_API_TOKEN;
  const t1 = resolveErpApiToken();
  const t2 = resolveErpApiToken();
  check('retorna string não-vazia (não trava o dev)', typeof t1 === 'string' && t1.length > 0);
  check('NÃO é o default fraco antigo', t1 !== WEAK_DEFAULT);
  check('é hex de 64 chars (randomBytes(32))', /^[a-f0-9]{64}$/.test(t1), t1.slice(0, 12) + '…');
  check('tokens efêmeros diferem entre chamadas', t1 !== t2);

  console.log('[3] token real no env → respeitado verbatim');
  process.env.ERP_API_TOKEN = 'real-token-xyz';
  process.env.NODE_ENV = 'production';
  check('prod com token → verbatim', resolveErpApiToken() === 'real-token-xyz');
  process.env.NODE_ENV = 'development';
  check('dev com token → verbatim', resolveErpApiToken() === 'real-token-xyz');
  // (espaço em branco é trimado)
  process.env.ERP_API_TOKEN = '  spaced-token  ';
  check('token é trimado', resolveErpApiToken() === 'spaced-token');

  console.log('[4] import do módulo em produção sem token REJEITA (fail-fast no boot)');
  delete process.env.ERP_API_TOKEN;
  process.env.NODE_ENV = 'production';
  // cache-bust pra forçar reavaliação do `export const ERP_API_TOKEN = resolveErpApiToken()`
  try {
    const resolved = require.resolve('../src/erpApiToken');
    delete require.cache[resolved];
  } catch {
    /* ignore */
  }
  let loadThrew = false;
  try {
    await import('../src/erpApiToken');
  } catch {
    loadThrew = true;
  }
  check('importar o módulo em prod sem token lança no load (PM2 não sobe)', loadThrew);

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-erp-api-token OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ erro inesperado no smoke:', e);
  process.exit(1);
});
