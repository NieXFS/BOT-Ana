export type RoteiroStepKind = 'customer' | 'human_echo';

export type MockBehavior =
  | 'R1_REOPEN'
  | 'R1_MORNING'
  | 'R1_RETURN'
  | 'R2_LIST'
  | 'R2_SLOTS'
  | 'R2_SUMMARY'
  | 'R2_BOOK'
  | 'R3_CLEANING'
  | 'R3_MONDAY'
  | 'R4_DRAINAGE_TYPO'
  | 'R4_PEELING'
  | 'R4_PRICE'
  | 'R5_UNKNOWN'
  | 'R6_GREETING'
  | 'R6_LIST'
  | 'R6_COMPLIMENT'
  | 'R7_PARTY'
  | 'R7_THANKS'
  | 'R8_SLOTS'
  | 'R8_DEFER'
  | 'R9_PEELING_CORRECTION'
  | 'R9_FRIDAY_MORNING'
  | 'R10_SATURDAY'
  | 'R10_HUMAN_ECHO'
  | 'R10_ACK_SILENCE'
  | 'R10_RESUME_CLEANING'
  | 'R10_CONTINUATION_SILENCE';

export interface RoteiroStep {
  id: string;
  label: string;
  kind: RoteiroStepKind;
  messages: string[];
  mockBehavior: MockBehavior;
  newConversation?: boolean;
  seedServiceQuestion?: 'fresh' | 'stale';
  forkFromHumanTakeover?: boolean;
  review?: string[];
}

export interface RoteiroScenario {
  id: `R${number}`;
  title: string;
  steps: RoteiroStep[];
}

export const ANA_V2_ROTEIROS: RoteiroScenario[] = [
  {
    id: 'R1',
    title: 'Camila — reabertura de fluxo',
    steps: [
      {
        id: 'R1.1',
        label: 'Quero agendar com pendência velha',
        kind: 'customer',
        messages: ['Quero agendar'],
        mockBehavior: 'R1_REOPEN',
        newConversation: true,
        seedServiceQuestion: 'stale',
        review: ['tom acolhedor'],
      },
      {
        id: 'R1.2',
        label: 'Preferência de manhã sem serviço',
        kind: 'customer',
        messages: ['quero agendar de manhã'],
        mockBehavior: 'R1_MORNING',
        newConversation: true,
        review: ['naturalidade ao registrar preferência de período'],
      },
      {
        id: 'R1.3',
        label: 'Retorno sem procedimento',
        kind: 'customer',
        messages: ['quero agendar um retorno'],
        mockBehavior: 'R1_RETURN',
        newConversation: true,
        review: ['clareza e acolhimento da pergunta'],
      },
    ],
  },
  {
    id: 'R2',
    title: 'Bruna — seleção elíptica e confirmação',
    steps: [
      { id: 'R2.1', label: 'Abrir agenda', kind: 'customer', messages: ['Oi! Quero agendar um horário'], mockBehavior: 'R2_LIST' },
      { id: 'R2.2', label: 'Segunda opção', kind: 'customer', messages: ['a segunda opção'], mockBehavior: 'R2_LIST' },
      { id: 'R2.3', label: 'Consultar quinta à tarde', kind: 'customer', messages: ['quinta à tarde'], mockBehavior: 'R2_SLOTS' },
      { id: 'R2.4', label: 'Escolher 15h', kind: 'customer', messages: ['pode ser às 15h'], mockBehavior: 'R2_SUMMARY' },
      { id: 'R2.5', label: 'Confirmar write', kind: 'customer', messages: ['sim, pode marcar'], mockBehavior: 'R2_BOOK', review: ['tom caloroso no fechamento'] },
    ],
  },
  {
    id: 'R3',
    title: 'Renata P. — segunda ambígua',
    steps: [
      { id: 'R3.1', label: 'Fixar limpeza parcial', kind: 'customer', messages: ['quero marcar limpeza de pele'], mockBehavior: 'R3_CLEANING', newConversation: true },
      { id: 'R3.2', label: 'Segunda nua não é ordinal', kind: 'customer', messages: ['segunda'], mockBehavior: 'R3_MONDAY', newConversation: true, seedServiceQuestion: 'fresh', review: ['desambiguação natural de segunda-feira'] },
    ],
  },
  {
    id: 'R4',
    title: 'Dona Marlene — typo e nome parcial',
    steps: [
      { id: 'R4.1', label: 'Drenajem', kind: 'customer', messages: ['boa tarde, voces fazem drenajem?'], mockBehavior: 'R4_DRAINAGE_TYPO', review: ['gentileza ao confirmar o typo'] },
      { id: 'R4.2', label: 'Peeling parcial', kind: 'customer', messages: ['e peeling tem?'], mockBehavior: 'R4_PEELING' },
      { id: 'R4.3', label: 'Preço da limpeza', kind: 'customer', messages: ['quanto custa a limpeza?'], mockBehavior: 'R4_PRICE' },
    ],
  },
  {
    id: 'R5',
    title: 'Patrícia — serviço inexistente',
    steps: [
      { id: 'R5.1', label: 'Botox', kind: 'customer', messages: ['vocês fazem botox?'], mockBehavior: 'R5_UNKNOWN', review: ['negação humana e redirecionamento comercial'] },
      { id: 'R5.2', label: 'Micropigmentação', kind: 'customer', messages: ['e micropigmentação de sobrancelha?'], mockBehavior: 'R5_UNKNOWN', review: ['negação humana e redirecionamento comercial'] },
    ],
  },
  {
    id: 'R6',
    title: 'Juliana — social no meio do fluxo',
    steps: [
      { id: 'R6.1', label: 'Saudação', kind: 'customer', messages: ['Oi, boa tarde!'], mockBehavior: 'R6_GREETING', review: ['calor humano da saudação'] },
      { id: 'R6.2', label: 'Listar serviços', kind: 'customer', messages: ['quero marcar um horário'], mockBehavior: 'R6_LIST' },
      { id: 'R6.3', label: 'Elogio preserva pendência', kind: 'customer', messages: ['nossa, vocês são super organizados!! 🥰'], mockBehavior: 'R6_COMPLIMENT', review: ['agradecimento humano e quente'] },
      { id: 'R6.4', label: 'Primeira opção ainda ancorada', kind: 'customer', messages: ['a primeira opção'], mockBehavior: 'R6_LIST' },
    ],
  },
  {
    id: 'R7',
    title: 'Vanessa — papo pessoal com dia e hora',
    steps: [
      { id: 'R7.1', label: 'Festa na sexta', kind: 'customer', messages: ['Hoje foi corrido, mas sexta às 20h tem uma festa. Vai ser top!'], mockBehavior: 'R7_PARTY', review: ['resposta humana e específica ao relato'] },
      { id: 'R7.2', label: 'Fechamento leve', kind: 'customer', messages: ['kkkkk obrigada'], mockBehavior: 'R7_THANKS', review: ['leveza do fechamento social'] },
    ],
  },
  {
    id: 'R8',
    title: 'Carol — social e operacional na mesma bolha',
    steps: [
      { id: 'R8.1', label: 'Agradecimento mais disponibilidade', kind: 'customer', messages: ['obrigada!! e amanhã tem horário pra drenagem?'], mockBehavior: 'R8_SLOTS' },
      { id: 'R8.2', label: 'Adiar sem insistência', kind: 'customer', messages: ['então deixa pra próxima semana, obrigada de novo ❤️'], mockBehavior: 'R8_DEFER', review: ['acolhimento sem insistência'] },
    ],
  },
  {
    id: 'R9',
    title: 'Fernanda — correção em rajada',
    steps: [
      { id: 'R9.1', label: 'Drenagem corrigida para peeling', kind: 'customer', messages: ['Drenagem', 'não, peraí, peeling!'], mockBehavior: 'R9_PEELING_CORRECTION', newConversation: true, seedServiceQuestion: 'fresh' },
      { id: 'R9.2', label: 'Três bolhas consolidadas', kind: 'customer', messages: ['na verdade', 'pode ser sexta', 'de manhã'], mockBehavior: 'R9_FRIDAY_MORNING' },
    ],
  },
  {
    id: 'R10',
    title: 'Aline e dona — takeover e retomada',
    steps: [
      { id: 'R10.1', label: 'Pergunta sobre sábado', kind: 'customer', messages: ['vocês atendem sábado?'], mockBehavior: 'R10_SATURDAY' },
      { id: 'R10.2', label: 'Echo manual da dona', kind: 'human_echo', messages: ['Oi Aline! Sábado sim, eu te encaixo, pode deixar comigo 😉'], mockBehavior: 'R10_HUMAN_ECHO' },
      { id: 'R10.3', label: 'Cliente confirma conversa humana', kind: 'customer', messages: ['ahh tá bom kkkk'], mockBehavior: 'R10_ACK_SILENCE' },
      { id: 'R10.4', label: 'Novo pedido independente no dia seguinte', kind: 'customer', messages: ['oi! queria marcar uma limpeza de pele pra semana que vem'], mockBehavior: 'R10_RESUME_CLEANING', review: ['retomada sem confrontar a dona'] },
      { id: 'R10.5', label: 'Contra-prova continua com a dona', kind: 'customer', messages: ['combinado então, sábado!'], mockBehavior: 'R10_CONTINUATION_SILENCE', forkFromHumanTakeover: true },
    ],
  },
];

