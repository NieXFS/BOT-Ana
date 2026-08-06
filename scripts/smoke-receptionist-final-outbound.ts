import assert from 'node:assert/strict';
import {
  RECEPTIONIST_SAFE_FALLBACK,
  buildReceptionistEnvelope,
  outboundBlockHash,
  validateReceptionistOutbound,
} from '../src/services/receptionistOutbound';

const catalog = {
  services: [{ id: 'svc-1', name: 'Limpeza de Pele', priceCents: 10000, durationMinutes: 60, professionalIds: ['pro-1'] }],
  professionals: [{ id: 'pro-1', name: 'Júlia', active: true }],
};
const validate = (blocks: any[], extra: any = {}) => validateReceptionistOutbound(buildReceptionistEnvelope({
  purpose: extra.purpose ?? 'REACTIVE', blocks, authoritativeCatalog: catalog, evidence: extra.evidence,
  ...(extra.exactPayload === undefined ? {} : { exactPayload: extra.exactPayload }),
}));

assert.equal(validate([{ source: 'GENERATED', text: 'A Limpeza de Pele custa R$ 100,00.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GREETING', text: 'Avaliação custa R$ 999,00.' }]).payload, RECEPTIONIST_SAFE_FALLBACK);
assert.equal(validate([{ source: 'POST_BOOKING', text: 'Cura garantida.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Temos 09:10 disponível.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Temos 09:10 disponível.' }], { evidence: { toolTrace: [{ name: 'getAvailableSlots', result: JSON.stringify({ success: true, slots: ['09:10'] }) }] } }).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Limpeza de Pele com Júlia.' }]).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Limpeza de Pele com Marina.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'A equipe responde em 10 minutos.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'CPF 123.456.789-00.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Tudo certo 😊 🎉' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Vou te encaminhar.' }]).originalAccepted, false);
assert.equal(validate([{ source: 'GENERATED', text: 'Vou te encaminhar.' }], { evidence: { actionRecorded: true } }).originalAccepted, true);
assert.equal(validate([{ source: 'GENERATED', text: 'Cura garantida.' }]).originalAccepted, false);
const validTeamReply = 'Resposta da equipe:\nA avaliação da equipe indica que isso cura a condição.';
const validTeamResult = validate([{ source: 'TEAM_REPLY', text: validTeamReply }], { evidence: { teamReplyAuthorization: { authoredAt: new Date().toISOString(), authoredBy: 'user-id', questionId: 'question-id', clinicalCapability: true } } });
assert.equal(validTeamResult.originalAccepted, true);
assert.equal(validTeamResult.payload, validTeamReply);
assert.equal(validate([{ source: 'TEAM_REPLY', text: validTeamReply }]).originalAccepted, false);

const approvedText = 'A resposta aprovada afirma que o procedimento é eficaz.';
assert.equal(validate([{ source: 'APPROVED_RESPONSE', text: approvedText }], { evidence: { clinicalAuthorization: { blockHash: outboundBlockHash(approvedText), acceptedAt: new Date().toISOString(), acceptedBy: 'actor-id', detectedAssertions: ['EFFICACY'], clinicalCapability: true } } }).originalAccepted, true);
assert.equal(validate([{ source: 'APPROVED_RESPONSE', text: 'Cura por R$ 999,00.' }], { evidence: { clinicalAuthorization: { blockHash: outboundBlockHash('Cura por R$ 999,00.'), acceptedAt: new Date().toISOString(), acceptedBy: 'actor-id', detectedAssertions: ['CURE'], clinicalCapability: true } } }).originalAccepted, false);
assert.equal(validate([{ source: 'CANONICAL', text: 'Tudo certo.' }], { exactPayload: 'adulterado' }).originalAccepted, false);
assert.ok(RECEPTIONIST_SAFE_FALLBACK.length > 0);
console.log('smoke receptionist final outbound: OK');
