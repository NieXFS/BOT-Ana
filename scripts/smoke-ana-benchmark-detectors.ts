/**
 * Regressões determinísticas dos detectores de texto do harness. Sem rede,
 * provider, banco ou fixtures mutáveis.
 */
import assert from 'node:assert/strict';
import {
  deniesRequestedServiceAvailability,
  offeredTimes,
} from './benchmarks/ana-models/scenarios';

assert.deepEqual(
  offeredTimes(
    'Para sexta-feira temos horários às 09:00, 10:30 e 15:00 com a Júlia. Qual você prefere?'
  ),
  ['09:00', '10:30', '15:00'],
  '“temos horários” é oferta real e precisa ser reconhecida'
);

assert.deepEqual(
  offeredTimes('Na sexta tem horários às 09:00 e 10:30 com a Júlia.'),
  ['09:00', '10:30'],
  '“tem horários” é oferta real e precisa ser reconhecida'
);

assert.deepEqual(
  offeredTimes('Na sexta tem horário às 09:00 com a Júlia.'),
  ['09:00'],
  '“tem horário” é oferta real e precisa ser reconhecida'
);

assert.deepEqual(
  offeredTimes('Na sexta tem 09:00 e 10:30 com a Júlia.'),
  [],
  '“tem” solto não é licença contextual para oferta de horário'
);

assert.deepEqual(
  offeredTimes('Não temos horários disponíveis às 09:00 nesta sexta.'),
  [],
  'negação de disponibilidade não pode virar oferta de horário'
);

assert.deepEqual(
  offeredTimes('Não tem horário às 09:00 nesta sexta.'),
  [],
  'negação singular de disponibilidade não pode virar oferta de horário'
);

for (const reply of [
  'Não temos Botox.',
  'Não oferecemos Botox.',
  'Não trabalhamos com Botox.',
  'Não encontrei Botox.',
  'Botox não está disponível.',
  'Botox não está na nossa lista.',
  'Botox não aparece.',
  'Botox não é um serviço disponível no nosso estabelecimento.',
  'Botox não é um serviço oferecido.',
  'Botox não é um serviço cadastrado.',
  'Botox não é um serviço listado.',
  'Botox não faz parte dos serviços oferecidos.',
]) {
  assert.equal(
    deniesRequestedServiceAvailability(reply, 'Botox'),
    true,
    `deve reconhecer negativa explícita de disponibilidade: ${reply}`
  );
}

for (const reply of [
  'Botox é um serviço disponível.',
  'Botox está disponível.',
  'Não temos Peeling, mas Botox está disponível.',
  'Peeling não é um serviço disponível.',
  'Talvez Botox não seja um serviço disponível.',
  'Se Botox não estiver disponível, posso procurar outra data.',
  'Não sei se Botox é um serviço disponível.',
  'Se Botox não é um serviço disponível, posso sugerir outro serviço.',
  'Caso Botox não é um serviço disponível, posso sugerir outro serviço.',
  'Talvez Botox não é um serviço disponível.',
  'Pode ser que Botox não é um serviço disponível.',
  'Acho que Botox não é um serviço disponível.',
]) {
  assert.equal(
    deniesRequestedServiceAvailability(reply, 'Botox'),
    false,
    `não deve aceitar disponibilidade ambígua, hipotética ou de outro serviço: ${reply}`
  );
}

console.log('✅ smoke ana benchmark detectors OK');
