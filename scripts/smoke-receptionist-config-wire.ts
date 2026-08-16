import assert from 'node:assert/strict';
import { normalizeBookingMenuPayload, normalizeStructuredPreferencesPayload } from '../src/services/structuredPreferences';
import { normalizeBusinessAddressPayload, parseDirectionsModePayload } from '../src/configProvider';

const structured = normalizeStructuredPreferencesPayload({
  structuredConfigVersion: 2, tone: 'DIRETA', treatment: 'VOCE', emojiLevel: 'NENHUM',
  directionsMode: 'SO_CIDADE', paymentMethods: ['PIX'], policies: [],
});
assert.equal(structured?.locationPolicy, 'SO_CIDADE');
assert.equal(parseDirectionsModePayload('ENDERECO_COMPLETO'), 'ENDERECO_COMPLETO');
assert.deepEqual(
  normalizeBusinessAddressPayload({
    full: 'Avenida Paulista, 1000',
    city: 'São Paulo',
    state: 'SP',
    zipCode: '01310930',
  }),
  { full: 'Avenida Paulista, 1000', city: 'São Paulo', state: 'SP', zipCode: '01310930' }
);
assert.equal(normalizeBusinessAddressPayload(undefined), undefined);
const menu = normalizeBookingMenuPayload([{ kind: 'SERVICE', label: 'Rosto', order: 0, publication: 'PUBLISHED', services: [{ id: 'svc-1', name: 'Limpeza' }] }]);
assert.deepEqual(menu?.[0], { kind: 'SERVICE', label: 'Rosto', order: 0, publication: 'PUBLISHED', serviceIds: ['svc-1'] });
console.log('smoke receptionist config wire: OK');
