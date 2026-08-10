/**
 * Smoke do scrub de STRINGS livres no Sentry da Ana (M13).
 *
 * Antes o scrub era só por NOME de chave; um AxiosError podia levar telefone/
 * email/cpf/token embutido em `event.message`, em `exception.values[].value`
 * (a mensagem da exception) ou em `breadcrumb.message`. Este smoke monta um
 * Event no formato de AxiosError com PII nessas três superfícies, roda o
 * `scrubEvent`, e ASSERTA que toda a PII sumiu — preservando o allowlist
 * (phoneNumberId estruturado) e o texto técnico útil.
 *
 * Rodar: npx ts-node -T scripts/smoke-ana-scrub-message.ts
 */
import type { Event } from '@sentry/node';
import { scrubEvent, scrubText } from '../src/observability/scrub';

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

const PHONE = '+5511999998888';
const EMAIL = 'victor@receps.com.br';
const CPF = '123.456.789-09';
const HEX = 'a'.repeat(40); // 40 hex chars (>= 32)
const BEARER_TOK = 'abcDEF123456_token-value';

const RAW_MESSAGE_ID = 'wamid.HBgONjI4OTU0MjYyNTAzNjcVAgAS.fixture';
const MESSAGE_ID_HASH = '36f35eb6f0a0b0eb';

const event = {
  message: `Request failed for ${EMAIL} cpf ${CPF}`,
  exception: {
    values: [
      {
        type: 'AxiosError',
        value: `Request failed with status code 401: phone ${PHONE} Authorization: Bearer ${BEARER_TOK} token=${HEX}`,
      },
    ],
  },
  breadcrumbs: [
    {
      category: 'http',
      message: `POST /messages from ${PHONE} email ${EMAIL}`,
      data: { from: PHONE },
    },
  ],
  tags: {
    phoneNumberId: '123456789012345',
    messageId: RAW_MESSAGE_ID,
    messageIdHash: MESSAGE_ID_HASH,
  },
} as unknown as Event;

const out = scrubEvent(event);
const blob = JSON.stringify(out);

console.log('[1] PII removida das três superfícies de string');
check('telefone E.164 sumiu', !blob.includes(PHONE));
check('email sumiu', !blob.includes(EMAIL));
check('cpf sumiu', !blob.includes(CPF));
check('token hex longo sumiu', !blob.includes(HEX));
check('credencial do Bearer sumiu', !blob.includes(BEARER_TOK));

console.log('[2] legibilidade + contexto técnico preservados');
const exVal = String(out.exception?.values?.[0]?.value ?? '');
check('prefixo "Bearer " mantido (legibilidade)', exVal.includes('Bearer [REDACTED]'));
check('status técnico mantido ("status code 401")', exVal.includes('status code 401'));
check(
  'event.message scrubbado',
  !String(out.message).includes(EMAIL) && !String(out.message).includes(CPF)
);
check(
  'breadcrumb.message scrubbado',
  !String(out.breadcrumbs?.[0]?.message).includes(PHONE) &&
    !String(out.breadcrumbs?.[0]?.message).includes(EMAIL)
);

console.log('[3] key-level intacto (allowlist + breadcrumb.data)');
check(
  'breadcrumb.data.from redigido por chave',
  (out.breadcrumbs?.[0]?.data as { from?: string } | undefined)?.from === '[REDACTED]'
);
check(
  'allowlist phoneNumberId (campo estruturado) preservado',
  (out.tags as Record<string, unknown> | undefined)?.phoneNumberId === '123456789012345'
);
check(
  'wamid cru é redigido porque pode carregar telefone reversível',
  (out.tags as Record<string, unknown> | undefined)?.messageId === '[REDACTED]' &&
    !blob.includes(RAW_MESSAGE_ID)
);
check(
  'hash técnico do wamid permanece observável',
  (out.tags as Record<string, unknown> | undefined)?.messageIdHash === MESSAGE_ID_HASH
);

console.log('[4] scrubText unit');
check('scrubText(null) === null', scrubText(null) === null);
check('scrubText(undefined) === undefined', scrubText(undefined) === undefined);
check('scrubText("") === ""', scrubText('') === '');
check(
  'scrubText texto limpo não muda',
  scrubText('ola tudo bem por aqui') === 'ola tudo bem por aqui'
);
check('scrubText redige telefone embutido', !scrubText(`liga ${PHONE}`)!.includes(PHONE));

console.log('[5] formatos de telefone que clientes digitam no WhatsApp');
for (const p of ['(11) 99999-8888', '11 99999-8888', '(11)99999-8888', '11 3333-4444', '+55 11 99999-8888']) {
  const r = scrubText(`cliente ${p} agora`)!;
  check(`redige "${p}"`, !r.includes(p) && r.includes('[REDACTED]'));
}

console.log('[6] ReDoS bound — entrada adversarial não trava o event loop');
const attack = 'a@' + 'a.'.repeat(40000); // ~80KB
const t0 = Date.now();
scrubText(attack);
const dt = Date.now() - t0;
check(`scrub de 80KB adversarial < 50ms (foi ${dt}ms)`, dt < 50);
check('entrada > teto é truncada', scrubText('x'.repeat(3000))!.includes('…[truncated]'));

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) falharam.`);
  process.exit(1);
}
console.log('\n✅ smoke-ana-scrub-message OK');
process.exit(0);
