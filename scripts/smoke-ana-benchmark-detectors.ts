/**
 * Regressões determinísticas dos detectores de texto do harness. Sem rede,
 * provider, banco ou fixtures mutáveis.
 */
import assert from 'node:assert/strict';
import { offeredTimes } from './benchmarks/ana-models/scenarios';

assert.deepEqual(
  offeredTimes(
    'Para sexta-feira temos horários às 09:00, 10:30 e 15:00 com a Júlia. Qual você prefere?'
  ),
  ['09:00', '10:30', '15:00'],
  '“temos horários” é oferta real e precisa ser reconhecida'
);

assert.deepEqual(
  offeredTimes('Não temos horários disponíveis às 09:00 nesta sexta.'),
  [],
  'negação de disponibilidade não pode virar oferta de horário'
);

console.log('✅ smoke ana benchmark detectors OK');
