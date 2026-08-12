import type { AnaResumeDecision } from '../../src/services/anaResumeClassifier';
import type { TimestampedMessage } from '../../src/services/contextManager';

export interface AnaResumeBehaviorCase {
  id: string;
  description: string;
  history: TimestampedMessage[];
  expected: AnaResumeDecision;
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 7, 11, 12, minute)).toISOString();

const nextDay = (minute: number) =>
  new Date(Date.UTC(2026, 7, 12, 12, minute)).toISOString();

export const ANA_RESUME_BEHAVIOR_CASES: AnaResumeBehaviorCase[] = [
  {
    id: 'rose-booking-handled',
    description: 'a equipe marcou e a cliente apenas confirma o combinado',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] ficou sexta às 13h com ela', createdAt: at(0) },
      { role: 'user', content: 'Foi agendado p as 13 horas c ela', createdAt: at(8) },
    ],
  },
  {
    id: 'rose-personal-banter',
    description: 'conversa social entre dona e cliente',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] sim kkkk', createdAt: at(0) },
      { role: 'user', content: 'Oh, que legal, da hora, da hora.', createdAt: at(1) },
    ],
  },
  {
    id: 'customer-confirms-human-option',
    description: 'resposta curta confirma uma opção oferecida pela humana',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] tenho sexta às 15h, pode ser?', createdAt: at(0) },
      { role: 'user', content: 'Pode ser', createdAt: at(2) },
    ],
  },
  {
    id: 'customer-complements-booking',
    description: 'cliente complementa dados do agendamento humano',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] deixei quinta depois do trabalho', createdAt: at(0) },
      { role: 'user', content: 'Isso, saio às 17 e vou direto', createdAt: at(4) },
    ],
  },
  {
    id: 'human-clinical-followup',
    description: 'acompanhamento clínico ainda conduzido pela profissional',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] continua o curativo e me avisa como ficou', createdAt: at(0) },
      { role: 'user', content: 'Hoje melhorou bastante, só está sensível', createdAt: at(15) },
    ],
  },
  {
    id: 'human-question-pending',
    description: 'cliente responde a pergunta feita pela humana',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] qual período fica melhor?', createdAt: at(0) },
      { role: 'user', content: 'Depois das 18h', createdAt: at(3) },
    ],
  },
  {
    id: 'new-request-next-day',
    description: 'pedido claramente novo no dia seguinte',
    expected: 'RESUME_ANA',
    history: [
      { role: 'assistant', content: '[atendente] combinado, até amanhã', createdAt: at(0) },
      { role: 'user', content: 'Oi, quero marcar esmaltação em gel para semana que vem', createdAt: nextDay(0) },
    ],
  },
  {
    id: 'new-request-different-service',
    description: 'novo pedido independente e com outro serviço',
    expected: 'RESUME_ANA',
    history: [
      { role: 'assistant', content: '[atendente] seu retorno ficou confirmado', createdAt: at(0) },
      { role: 'user', content: 'Também queria agendar manicure para minha mãe em outro dia', createdAt: nextDay(5) },
    ],
  },
  {
    id: 'direct-ana-request',
    description: 'cliente pede explicitamente atendimento da Ana',
    expected: 'RESUME_ANA',
    history: [
      { role: 'assistant', content: '[atendente] qualquer coisa me chama', createdAt: at(0) },
      { role: 'user', content: 'Ana, pode continuar e me mostrar os horários de sexta?', createdAt: at(50) },
    ],
  },
  {
    id: 'human-releases-ana',
    description: 'a própria humana devolve o atendimento e há pedido operacional novo',
    expected: 'RESUME_ANA',
    history: [
      { role: 'assistant', content: '[atendente] Ana pode continuar o agendamento com você', createdAt: at(0) },
      { role: 'user', content: 'Quero ver os horários de terça para podoprofilaxia', createdAt: at(2) },
    ],
  },
  {
    id: 'ambiguous-greeting',
    description: 'saudação sozinha não prova conversa nova',
    expected: 'UNCERTAIN',
    history: [
      { role: 'assistant', content: '[atendente] te respondo assim que terminar aqui', createdAt: at(0) },
      { role: 'user', content: 'Oiii', createdAt: at(55) },
    ],
  },
  {
    id: 'ambiguous-pronoun',
    description: 'referência vaga pode depender do que a humana falou',
    expected: 'UNCERTAIN',
    history: [
      { role: 'assistant', content: '[atendente] vou olhar isso', createdAt: at(0) },
      { role: 'user', content: 'E aquele outro?', createdAt: at(20) },
    ],
  },
  {
    id: 'ambiguous-mixed-request',
    description: 'mistura confirmação humana e possível pedido novo',
    expected: 'UNCERTAIN',
    history: [
      { role: 'assistant', content: '[atendente] ficou marcado às 14h', createdAt: at(0) },
      { role: 'user', content: 'Tá bom, e se der queria ver outra coisa também', createdAt: at(4) },
    ],
  },
  {
    id: 'audio-transcript-handled',
    description: 'transcrição do áudio humano contém o combinado',
    expected: 'KEEP_HUMAN',
    history: [
      { role: 'assistant', content: '[atendente] deixei reservado sexta às treze, pode vir direto', createdAt: at(0) },
      { role: 'user', content: 'Obrigada, estarei aí', createdAt: at(7) },
    ],
  },
  {
    id: 'audio-unavailable',
    description: 'sem transcrição a decisão obrigatoriamente falha fechada',
    expected: 'UNCERTAIN',
    history: [
      { role: 'assistant', content: '[atendente] [áudio do atendente sem transcrição]', createdAt: at(0) },
      { role: 'user', content: 'Pode ser assim então', createdAt: at(7) },
    ],
  },
];
