import { FLAT_NEXT_PENDING_V2 } from './contracts';

/**
 * Exemplos de INSTÂNCIA somente. O prompt não contém JSON-Schema nem outro
 * objeto formal que o modelo possa confundir com a própria resposta final.
 */
export const FLAT_MODEL_TURN_V2_EXAMPLES = [
  {
    reply: 'Qual serviço você prefere?',
    nextPending: 'SERVICE',
    chosenOptionText: null,
    unknownServiceText: null,
  },
  {
    reply: 'Perfeito. Qual dia você prefere?',
    nextPending: 'DATE',
    chosenOptionText: 'peeling',
    unknownServiceText: null,
  },
  {
    reply: 'Pode me dizer novamente o que você prefere?',
    nextPending: 'PRESERVE',
    chosenOptionText: null,
    unknownServiceText: null,
  },
] as const;

const INSTANCE_EXAMPLES = FLAT_MODEL_TURN_V2_EXAMPLES.map(
  (example, index) =>
    `EXEMPLO DE SAÍDA ${index + 1}: ${JSON.stringify(example)}`
).join('\n');

export const MODEL_TURN_RESULT_V2_BOOKING_RULE =
  'REGRA DE BOOKING V2: somente quando TurnFrameV2.pending.kind for CONFIRMATION deste mesmo flowId e a cliente confirmar inequivocamente, CHAME bookAppointment imediatamente com serviço, profissional, data e hora do BookingDraftV2; é PROIBIDO re-perguntar uma confirmação já dada. CONFIRMATION de resolução de duplicidade segue o fluxo próprio e não usa esta regra. Os gates de escrita continuam obrigatórios: nunca alegue sucesso antes de success:true.';

export const MODEL_TURN_RESULT_V2_CONTRACT_BLOCK = `CONTRATO FINAL V2 — PRODUZA UMA INSTÂNCIA:
- Quando não houver tool_calls, responda somente com um objeto JSON.
- Sua saída contém EXATAMENTE as chaves reply, nextPending, chosenOptionText, unknownServiceText e NADA mais — nunca copie o formato/schema, produza uma INSTÂNCIA.
- reply: string não vazia com a fala ao cliente.
- nextPending: exatamente um de ${FLAT_NEXT_PENDING_V2.join('|')}.
- chosenOptionText: string com o trecho escolhido pela cliente no inbound atual, ou null. Não calcule IDs nem posições.
- unknownServiceText: string com o procedimento concreto ausente citado pela cliente no inbound atual, ou null. Não use para períodos, dias, horários, verbos de agenda, retorno, avaliação ou unidade.
- Não use Markdown nem acrescente prosa fora do objeto JSON.
- O servidor localizará os textos e resolverá catálogo, spans, IDs, propósito e lifecycle. Não emita contract, type, properties, required, ModelTurnResultV2, spans, questionId, flowId ou optionEntityIds.

${INSTANCE_EXAMPLES}`;

// O loop reapresenta literalmente o mesmo contrato depois de cada tool round.
export const MODEL_TURN_RESULT_V2_POST_TOOL_REMINDER =
  MODEL_TURN_RESULT_V2_CONTRACT_BLOCK;

export const MODEL_TURN_PROSE_V2_POST_TOOL_REMINDER =
  'Depois do resultado da ferramenta, responda diretamente à cliente em texto natural. Não exponha IDs, argumentos, JSON interno nem raciocínio.';
