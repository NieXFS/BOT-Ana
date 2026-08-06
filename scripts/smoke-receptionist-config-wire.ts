import assert from 'node:assert/strict';
import { normalizeBookingMenuPayload, normalizeStructuredPreferencesPayload } from '../src/services/structuredPreferences';

const structured = normalizeStructuredPreferencesPayload({
  structuredConfigVersion: 2, tone: 'DIRETA', treatment: 'VOCE', emojiLevel: 'NENHUM',
  directionsMode: 'SO_CIDADE', paymentMethods: ['PIX'], policies: [],
});
assert.equal(structured?.locationPolicy, 'SO_CIDADE');
const menu = normalizeBookingMenuPayload([{ kind: 'SERVICE', label: 'Rosto', order: 0, publication: 'PUBLISHED', services: [{ id: 'svc-1', name: 'Limpeza' }] }]);
assert.deepEqual(menu?.[0], { kind: 'SERVICE', label: 'Rosto', order: 0, publication: 'PUBLISHED', serviceIds: ['svc-1'] });
console.log('smoke receptionist config wire: OK');
