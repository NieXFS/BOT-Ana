/**
 * Smoke dos CONTRATOS das ferramentas de venda da Renata (Workstream B).
 * - buildSignupLink: URL builder puro (utm + cid + plano + interval; beta →
 *   lista de espera; plano inválido → recusa; ctwaClid > wa:hash).
 * - registerQualifiedLead / handoffToHuman: contrato HTTP contra um MOCK do
 *   Receps (express local) — sem tocar no Receps real nem no DB (a régua de
 *   follow-up é best-effort e falha em silêncio no smoke).
 *
 * Rodar: npx tsx scripts/smoke-sales-tools.ts
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { SalesConfig } from '../src/salesConfigProvider';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
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
      features: [],
      waitlist: { reason: 'em testes', href: 'https://wa.me/5516991113783' },
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
      features: [],
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
      features: [],
    },
  ],
  anaBeta: { testing: true, waitlistHref: 'https://wa.me/5516991113783', notice: 'beta' },
};

type Captured = { path: string; body: Record<string, unknown> };

async function main() {
  // ── MOCK do Receps ─────────────────────────────────────────────
  const captured: Captured[] = [];
  const app = express();
  app.use(express.json());
  app.post('/api/v1/bot/sales-lead', (req, res) => {
    captured.push({ path: '/sales-lead', body: req.body });
    res.json({ id: 'lead1', status: req.body?.status ?? 'novo' });
  });
  app.post('/api/v1/bot/pause-conversation', (req, res) => {
    captured.push({ path: '/pause-conversation', body: req.body });
    res.json({ pausedUntil: new Date(Date.now() + 3600_000).toISOString() });
  });
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  process.env.RECEPS_INTERNAL_API_URL = `http://127.0.0.1:${port}`;

  // Import DEPOIS de setar a env (o módulo lê a base no load).
  const { buildSignupLink, registerQualifiedLead, handoffToHuman, hashPhoneForCid } =
    await import('../src/services/salesTools');

  const phone = '5516999998888';

  console.log('▶ buildSignupLink (URL builder puro)');
  const essencial = buildSignupLink('essencial', undefined, phone, salesConfig);
  check('essencial: success', essencial.success === true);
  if (essencial.success) {
    check('essencial: plan=essencial', essencial.url.includes('plan=essencial'));
    check('essencial: utm completo', essencial.url.includes('utm_source=whatsapp&utm_medium=renata&utm_campaign=ctwa'));
    check('essencial: cid=wa:<hash>', essencial.url.includes(`cid=wa%3A${hashPhoneForCid(phone)}`) || essencial.url.includes(`cid=wa:${hashPhoneForCid(phone)}`));
    check('essencial: sem interval (mensal)', !essencial.url.includes('interval=annual'));
  }
  const proAnnual = buildSignupLink('pro', 'annual', phone, salesConfig);
  check('pro anual: interval=annual', proAnnual.success === true && proAnnual.url.includes('interval=annual'));
  check('pro anual: plan=pro', proAnnual.success === true && proAnnual.url.includes('plan=pro'));

  const beta = buildSignupLink('atendente-ia', undefined, phone, salesConfig);
  check('beta: recusa (não vende)', beta.success === false);
  check('beta: devolve waitlistHref', beta.success === false && beta.waitlistHref === 'https://wa.me/5516991113783');

  const invalid = buildSignupLink('inexistente', undefined, phone, salesConfig);
  check('plano inválido: recusa listando válidos', invalid.success === false && invalid.message.includes('essencial'));

  const withClid = buildSignupLink('pro', undefined, phone, salesConfig, 'ABC123CLID');
  check('ctwaClid > wa:hash', withClid.success === true && withClid.url.includes('cid=ABC123CLID') && !withClid.url.includes('wa%3A'));

  console.log('▶ registerQualifiedLead (contrato HTTP)');
  const reg = await registerQualifiedLead(phone, 'PNID', {
    name: 'Maria',
    professionalsCount: 2,
    status: 'qualificado',
  });
  check('register: success', reg.success === true);
  const regReq = captured.find((c) => c.path === '/sales-lead' && c.body.status === 'qualificado');
  check('register: POST /sales-lead com status qualificado', !!regReq);
  check('register: customerPhone injetado', regReq?.body.customerPhone === phone);
  check('register: name repassado', regReq?.body.name === 'Maria');

  console.log('▶ handoffToHuman (contrato HTTP)');
  captured.length = 0;
  const handoff = await handoffToHuman(phone, 'PNID', 'quer falar com humano');
  check('handoff: success', handoff.success === true);
  const leadReq = captured.find((c) => c.path === '/sales-lead');
  check('handoff: sales-lead status=handoff', leadReq?.body.status === 'handoff');
  check('handoff: sales-lead reason repassado', leadReq?.body.reason === 'quer falar com humano');
  const pauseReq = captured.find((c) => c.path === '/pause-conversation');
  check('handoff: pause-conversation source=handoff', pauseReq?.body.source === 'handoff');
  check('handoff: pause-conversation phoneNumberId', pauseReq?.body.phoneNumberId === 'PNID');
  check('handoff: pause-conversation customerPhone', pauseReq?.body.customerPhone === phone);

  server.close();

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) falharam.`);
    process.exit(1);
  }
  console.log('\n✅ smoke-sales-tools OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ erro no smoke:', err);
  process.exit(1);
});
