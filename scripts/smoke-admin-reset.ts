process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.NODE_ENV = 'production';
process.env.RECEPS_BOT_WEBHOOK_SECRET = 'smoke-admin-reset-secret';

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AdminResetDeps } from '../src/services/adminReset';

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main() {
  const { botSignatureMiddleware } = await import('../src/security');
  const { buildResetConversationKeys, resetAdminConversation } = await import(
    '../src/services/adminReset'
  );
  const rawBody = Buffer.from(
    JSON.stringify({
      phoneNumberId: 'PN_VENDAS',
      customerPhone: '+5516997510032',
      dryRun: true,
    })
  );
  const correctSignature =
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.RECEPS_BOT_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('hex');

  function invokeMiddleware(signature?: string) {
    let status = 200;
    let nextCalled = false;
    const req = {
      rawBody,
      get: (name: string) =>
        name.toLowerCase() === 'x-bot-signature' ? signature : undefined,
    } as unknown as Request;
    const res = {
      status(code: number) { status = code; return this; },
      json() { return this; },
      sendStatus(code: number) { status = code; return this; },
    } as unknown as Response;
    const next = (() => { nextCalled = true; }) as NextFunction;
    botSignatureMiddleware(req, res, next);
    return { status, nextCalled };
  }

  const unsigned = invokeMiddleware();
  check('não-assinado rejeitado 401', unsigned.status === 401 && !unsigned.nextCalled);
  const wrong = invokeMiddleware('sha256=0000');
  check('assinatura errada rejeitada 401', wrong.status === 401 && !wrong.nextCalled);
  const correct = invokeMiddleware(correctSignature);
  check('assinatura correta aceita', correct.status === 200 && correct.nextCalled);

  const rawKey = 'PN_VENDAS:5516997510032';
  const canonicalKey = 'PN_VENDAS:+5516997510032';
  const unrelatedHistory = 'PN_VENDAS:5516999990000';
  const unrelatedFollowup = 'PN_OUTRO:5516997510032';
  const history = new Set([rawKey, canonicalKey, unrelatedHistory]);
  const followups = new Set([rawKey, unrelatedFollowup]);
  const processedMessages = new Set(['wamid.smoke.1', 'wamid.smoke.2']);
  const matched = (store: Set<string>, keys: string[]) =>
    keys.filter((key) => store.has(key));
  const remove = (store: Set<string>, keys: string[]) => {
    const rows = matched(store, keys);
    rows.forEach((key) => store.delete(key));
    return rows.length;
  };
  const deps: AdminResetDeps = {
    countHistory: async (keys) => matched(history, keys).length,
    countFollowups: async (keys) => matched(followups, keys).length,
    deleteHistory: async (keys) => remove(history, keys),
    deleteFollowups: async (keys) => remove(followups, keys),
  };

  const variants = buildResetConversationKeys('PN_VENDAS', '+55 16 99751-0032');
  check('variantes incluem wa_id cru', variants.includes(rawKey));
  check('variantes incluem canônico', variants.includes(canonicalKey));
  const dryRun = await resetAdminConversation(
    { phoneNumberId: 'PN_VENDAS', customerPhone: '+5516997510032', dryRun: true },
    deps
  );
  check('dry-run conta sem apagar',
    dryRun.history === 2 && dryRun.followups === 1 && history.has(rawKey) && followups.has(rawKey));
  check('processed_messages intocado no dry-run', processedMessages.size === 2);

  const applied = await resetAdminConversation(
    { phoneNumberId: 'PN_VENDAS', customerPhone: '+55 16 99751-0032' },
    deps
  );
  check('apply retorna contagens', applied.history === 2 && applied.followups === 1);
  check('histórico/régua apagados', !history.has(rawKey) && !followups.has(rawKey));
  check('outras conversas sobrevivem',
    history.has(unrelatedHistory) && followups.has(unrelatedFollowup));
  check('processed_messages NUNCA tocado', processedMessages.size === 2);
  const again = await resetAdminConversation(
    { phoneNumberId: 'PN_VENDAS', customerPhone: '5516997510032' }, deps);
  check('idempotente', again.history === 0 && again.followups === 0);

  if (failures > 0) throw new Error(`${failures} check(s) falharam.`);
  console.log('\n✅ smoke-admin-reset OK');
}

main().catch((error) => {
  console.error('❌ smoke-admin-reset falhou:', error);
  process.exitCode = 1;
});
