/**
 * Transporte mockado, sem Meta/DB/ERP. Prova que OTP/utility só alcançam o
 * sender de template e não ganham dependência de lead, follow-up, pausa ou
 * histórico comercial.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.ERP_API_TOKEN ||= 'smoke-erp-token';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { TransactionalOnboardingMessageDeps } from '../src/services/transactionalOnboardingMessages';
import type { WhatsAppTemplateMessage } from '../src/whatsappCloudService';

async function main(): Promise<void> {
  const transactional = await import(
    '../src/services/transactionalOnboardingMessages'
  );

  const sent: Array<{
    to: string;
    template: WhatsAppTemplateMessage;
  }> = [];
  const deps: TransactionalOnboardingMessageDeps = {
    resolveSenderConfig: async () => ({
      phoneNumberId: '123456789',
      waAccessToken: 'mock-token',
      waApiVersion: 'v21.0',
    }),
    sendTemplate: async (to, template) => {
      sent.push({ to, template });
      return { providerMessageId: 'provider-receipt-must-not-escape' };
    },
    consumeLimit: () => ({ ok: true, retryAfter: 0 }),
  };

  const otpCode = '482913';
  const phone = '+5511999999999';
  const otpResult = await transactional.sendAuthenticationOtp(
    { phone, code: otpCode },
    deps
  );
  const welcomeResult = await transactional.sendOnboardingWelcome(
    { phone },
    deps
  );

  assert.equal(sent.length, 2, 'somente dois transports explicitamente pedidos');
  assert.equal(sent[0]?.to, '5511999999999', 'Meta recebe somente dígitos');
  assert.equal(sent[0]?.template.name, transactional.AUTH_OTP_TEMPLATE_NAME);
  assert.deepEqual(sent[0]?.template.components, [
    {
      type: 'body',
      parameters: [{ type: 'text', text: otpCode }],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: otpCode }],
    },
  ]);
  assert.equal(
    sent[1]?.template.name,
    transactional.ONBOARDING_WELCOME_TEMPLATE_NAME
  );
  assert.equal(sent[1]?.template.components, undefined);

  const publicResult = JSON.stringify([otpResult, welcomeResult]);
  assert.equal(publicResult.includes(otpCode), false, 'resultado não vaza código');
  assert.equal(publicResult.includes(phone), false, 'resultado não vaza telefone');
  assert.equal(
    publicResult.includes('provider-receipt'),
    false,
    'resultado não vaza wamid/recibo'
  );

  const source = fs.readFileSync(
    new URL(
      '../src/services/transactionalOnboardingMessages.ts',
      import.meta.url
    ),
    'utf8'
  );
  const forbiddenDependencies = [
    'SalesLead',
    'salesEvents',
    'salesFollowups',
    'pauseService',
    'pauseConversation',
    'contextManager',
    'addMessage',
  ];
  for (const forbidden of forbiddenDependencies) {
    assert.equal(
      source.includes(forbidden),
      false,
      `transporte transacional não pode depender de ${forbidden}`
    );
  }

  let failedTransportCalls = 0;
  await assert.rejects(
    transactional.sendAuthenticationOtp(
      { phone, code: otpCode },
      {
        ...deps,
        sendTemplate: async () => {
          failedTransportCalls += 1;
          const error = new Error('provider rejected');
          Object.assign(error, { response: { status: 400 } });
          throw error;
        },
      }
    ),
    (error: unknown) =>
      error instanceof transactional.TransactionalMessageError &&
      error.reason === 'provider_rejected'
  );
  assert.equal(failedTransportCalls, 1, 'sem retry/fallback cruzado no transporte');

  console.log(
    'smoke auth transactional guardrails: transporte mockado + zero lead/follow-up/pausa/histórico + respostas redigidas OK'
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
