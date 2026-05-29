/**
 * Smoke test do Sentry (Ana).
 *
 * Não depende de rede nem de projeto Sentry real. Testa o `scrubEvent` (o
 * beforeSend) direto e o pipeline real do @sentry/node com transport no-op,
 * disparando um Error sintético + captureMessage com PII de WhatsApp, e
 * ASSERTANDO que telefone/nome/conteúdo do cliente foram escrubbados e que o
 * `phoneNumberId` (ID Meta da linha do salão) foi PRESERVADO.
 *
 * Rodar: npx ts-node -T scripts/smoke-sentry-ana.ts
 */

import 'dotenv/config';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { scrubEvent } from '../src/observability/scrub';

let failures = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function testScrubDirect() {
  console.log('\n[1] scrubEvent (unit)');

  const longText = 'oi quero marcar '.repeat(8); // > 60 chars
  const event = {
    user: { id: 'tenant:clinica-bella', email: 'cliente@gmail.com', ip_address: '187.1.2.3' },
    tags: { phoneNumberId: '123456789', tenantSlug: 'clinica-bella', messageId: 'wamid.ABC' },
    extra: {
      whatsapp: {
        from: '5511999998888',
        text: longText,
        body: longText,
        phoneNumberId: '123456789',
        tenantSlug: 'clinica-bella',
        messageId: 'wamid.ABC',
        type: 'text',
      },
      customerName: 'Maria da Silva',
      nested: { authorization: 'Bearer xyz', telefone: '+5511888887777', curto: 'ok' },
    },
  } as unknown as Event;

  const out = scrubEvent(event);
  const wa = (out.extra as Record<string, Record<string, unknown>>).whatsapp;

  check('user.email removido', out.user?.email === undefined);
  check('user.ip_address removido', out.user?.ip_address === undefined);
  check('user.id preservado', out.user?.id === 'tenant:clinica-bella');
  check('whatsapp.from (telefone cliente) redigido', wa.from === '[REDACTED]');
  check('whatsapp.text (>60) virou marcador', String(wa.text).startsWith('[REDACTED:'));
  check('whatsapp.body (>60) virou marcador', String(wa.body).startsWith('[REDACTED:'));
  check('whatsapp.phoneNumberId PRESERVADO (allowlist)', wa.phoneNumberId === '123456789');
  check('whatsapp.tenantSlug preservado', wa.tenantSlug === 'clinica-bella');
  check('whatsapp.messageId preservado', wa.messageId === 'wamid.ABC');
  check('whatsapp.type preservado', wa.type === 'text');
  check(
    'customerName redigido',
    (out.extra as Record<string, unknown>).customerName === '[REDACTED]',
  );
  const nested = (out.extra as Record<string, Record<string, unknown>>).nested;
  check('nested.authorization redigido', nested.authorization === '[REDACTED]');
  check('nested.telefone redigido', nested.telefone === '[REDACTED]');
  check('nested.curto preservado', nested.curto === 'ok');
  check(
    'tags.phoneNumberId PRESERVADO (allowlist)',
    (out.tags as Record<string, unknown>).phoneNumberId === '123456789',
  );
}

async function testPipeline() {
  console.log('\n[2] pipeline real (init + beforeSend)');

  const sent: Event[] = [];
  const longText = 'mensagem bem comprida do cliente '.repeat(4);

  Sentry.init({
    dsn: 'https://examplePublicKey@o0.ingest.us.sentry.io/0',
    enabled: true,
    environment: 'smoke-test',
    sendDefaultPii: false,
    // Desliga ContextLines no teste (anexaria o código-fonte deste script aos
    // stack frames, causando falso positivo na busca por PII no payload).
    integrations: (defaults) => defaults.filter((i) => i.name !== 'ContextLines'),
    beforeSend: (event) => {
      const scrubbed = scrubEvent(event);
      sent.push(scrubbed);
      return scrubbed;
    },
    transport: () => ({
      send: () => Promise.resolve({ statusCode: 200 }),
      flush: () => Promise.resolve(true),
    }),
  });

  Sentry.withScope((scope) => {
    scope.setTag('phoneNumberId', '123456789');
    scope.setExtras({
      mensagem_cliente: { from: '5511999998888', text: longText, body: longText },
    });
    Sentry.captureException(new Error('Falha ao gerar resposta da Ana'));
  });

  Sentry.captureMessage('ana sentry ok', 'info');

  await Sentry.flush(3000);

  const messages = sent.map((e) => e.message).filter(Boolean);
  check("captureMessage 'ana sentry ok' enviado", messages.includes('ana sentry ok'));

  const piiEvent = sent.find((e) =>
    e.exception?.values?.some((v) => v.value === 'Falha ao gerar resposta da Ana'),
  );
  check('evento de exceção presente', Boolean(piiEvent));
  const msg = (piiEvent?.extra as Record<string, Record<string, unknown>> | undefined)
    ?.mensagem_cliente;
  check('mensagem_cliente.from redigido', msg?.from === '[REDACTED]');
  check('mensagem_cliente.text (>60) virou marcador', String(msg?.text).startsWith('[REDACTED:'));
  check(
    'tag phoneNumberId preservada no pipeline',
    (piiEvent?.tags as Record<string, unknown> | undefined)?.phoneNumberId === '123456789',
  );

  const serialized = JSON.stringify(sent);
  check('telefone do cliente NÃO vazou no payload', !serialized.includes('5511999998888'));
  check('nenhum "Bearer " vazou no payload', !serialized.includes('Bearer '));
}

async function main() {
  console.log('=== smoke-sentry-ana (Ana) ===');
  testScrubDirect();
  await testPipeline();

  console.log('');
  if (failures > 0) {
    console.error(`❌ smoke-sentry-ana FALHOU: ${failures} verificação(ões).`);
    process.exit(1);
  }
  console.log('✅ smoke-sentry-ana PASSOU: scrubbing OK.');
  process.exit(0);
}

void main();
