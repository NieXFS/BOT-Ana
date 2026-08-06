import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';

async function main() {
  const outbound = await import('../src/services/receptionistOutbound');
  const replies = await import('../src/services/questionReplyService');
  const sent: string[] = [];
  const rows = new Map<string, any>();
  const store: replies.QuestionReplyStore = {
    async reserve(input) {
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { inserted: false, row: existing };
      const row = { ...input, status: 'in_flight', providerMessageId: null, failureCode: null, providerStatus: null, providerStatusAt: null, providerFailureCode: null, callbackPending: false, createdAt: new Date(), updatedAt: new Date() };
      rows.set(input.idempotencyKey, row);
      return { inserted: true, row };
    },
    async update(key, status, providerMessageId, failureCode) {
      const row = rows.get(key);
      Object.assign(row, { status, providerMessageId: providerMessageId ?? row.providerMessageId, failureCode, updatedAt: new Date() });
      return row;
    },
    async get(key) { return rows.get(key) ?? null; },
  };
  const deps = replies.createQuestionReplyDeps({
    store,
    now: () => Date.now(),
    withLock: async (_phone, _customer, work) => work({} as any),
    getLatestSource: async () => 'wamid-source',
    getLastInboundAtMs: async () => Date.now(),
    sendReceipt: async (_to, text) => { sent.push(text); return { providerMessageId: `wamid-${sent.length}` }; },
  });
  const base = { phoneNumberId: 'pn', customerPhone: '5511999999999', sourceInboundMessageId: 'wamid-source' };
  const valid = 'Resposta da equipe:\nA avaliação indica que isso cura a condição.';
  const result1 = await replies.sendQuestionReply({ ...base, idempotencyKey: 'q:1', text: valid, blocks: [{ source: 'TEAM_REPLY', text: valid }], evidence: { teamReplyAuthorization: { authoredAt: new Date().toISOString(), authoredBy: 'actor', questionId: 'q', clinicalCapability: true } } }, {} as any, deps);
  assert.equal(result1.kind, 'sent');
  assert.equal(sent[0], valid, 'preview/payload válido permanece byte-exato');

  const unsafe = 'Resposta da equipe:\nCura por R$ 999,00.';
  const result2 = await replies.sendQuestionReply({ ...base, idempotencyKey: 'q:2', text: unsafe, blocks: [{ source: 'TEAM_REPLY', text: unsafe }], evidence: { teamReplyAuthorization: { authoredAt: new Date().toISOString(), authoredBy: 'actor', questionId: 'q', clinicalCapability: true } }, authoritativeCatalog: { services: [], professionals: [] } }, {} as any, deps);
  assert.equal(result2.kind, 'sent');
  assert.equal(sent[1], outbound.RECEPTIONIST_SAFE_FALLBACK, 'hard block de preço envia fallback com recibo');

  const result3 = await replies.sendQuestionReply({ ...base, idempotencyKey: 'q:3', text: 'payload adulterado', blocks: [{ source: 'CANONICAL', text: 'outro payload' }] }, {} as any, deps);
  assert.equal(result3.kind, 'sent');
  assert.equal(sent[2], outbound.RECEPTIONIST_SAFE_FALLBACK, 'envelope adulterado envia fallback com recibo');
  console.log('smoke receptionist manual envelope: OK');
}
void main();
