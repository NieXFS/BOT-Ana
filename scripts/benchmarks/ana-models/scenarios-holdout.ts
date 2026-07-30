import { DEFAULT_SLOTS, IDS } from './fixtures';
import {
  assertion,
  calls,
  defineScenario,
  lastAssistantText,
  offeredTimes,
} from './scenarios';
import type { BenchmarkScenario } from './types';

function noCalendarMutationTools(run: Parameters<typeof calls>[0]): boolean {
  return (
    calls(run, 'getAvailableSlots').length === 0 &&
    calls(run, 'bookAppointment').length === 0 &&
    calls(run, 'cancelAppointment').length === 0
  );
}

/**
 * Holdout escrito sem consultar benchmark-results. Ele mede compreensão e
 * segurança fora do caminho feliz de booking usado para calibrar a suíte P0.
 */
export const HOLDOUT_SCENARIOS: BenchmarkScenario[] = [
  defineScenario({
    id: 'P1-HOLDOUT-PRICE-DURATION-PEELING',
    priority: 'P1',
    description:
      'Consulta factual de preço e duração deve responder do catálogo sem iniciar agenda.',
    turns: ['Quanto custa o Peeling e quanto tempo demora?'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      return [
        assertion(
          'holdout-price-duration-no-calendar-tools',
          noCalendarMutationTools(run),
          'nenhuma tool de disponibilidade/escrita',
          run.toolTrace
        ),
        assertion(
          'holdout-price-duration-exact',
          /(?:r\$\s*)?250(?:[,.]00)?/i.test(reply) &&
            /\b45\s*(?:min|minutos?)\b/i.test(reply),
          'R$ 250,00 e 45 minutos',
          reply
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-INELIGIBLE-PROFESSIONAL',
    priority: 'P1',
    description:
      'Profissional incompatível com o serviço não pode ser consultado nem ofertado como elegível.',
    turns: ['Quero fazer Peeling com o Caio nesta sexta.'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      const incompatibleCalls = calls(run, 'getAvailableSlots').filter(
        (entry) => entry.args.professionalId === IDS.professional.caio
      );
      return [
        assertion(
          'holdout-ineligible-pro-no-incompatible-call',
          incompatibleCalls.length === 0 &&
            calls(run, 'bookAppointment').length === 0,
          '0 chamadas com Caio e 0 bookings',
          { incompatibleCalls, books: calls(run, 'bookAppointment') }
        ),
        assertion(
          'holdout-ineligible-pro-offers-valid-path',
          /(caio).{0,100}(não|nao|indispon|atende)|(?:júlia|julia).{0,80}marina|marina.{0,80}(?:júlia|julia)/i.test(
            reply
          ),
          'explica incompatibilidade ou oferece Júlia/Marina',
          reply,
          'soft'
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-SERVICE-CHANGE',
    priority: 'P1',
    description:
      'Mudança de serviço no meio do fluxo invalida o profissional incompatível anterior.',
    turns: [
      'Quero marcar Peeling amanhã.',
      'Com a Marina.',
      'Mudei de ideia, quero Limpeza de Pele.',
    ],
    evaluate: (run) => {
      const lastTurnAvailability = calls(run, 'getAvailableSlots', 3);
      const availability = lastTurnAvailability.at(-1);
      return [
        assertion(
          'holdout-service-change-rechecks-latest-service',
          lastTurnAvailability.length === 1 &&
            availability?.args.serviceId === IDS.service.limpeza &&
            availability?.args.professionalId === IDS.professional.julia,
          {
            calls: 1,
            serviceId: IDS.service.limpeza,
            professionalId: IDS.professional.julia,
          },
          lastTurnAvailability
        ),
        assertion(
          'holdout-service-change-no-stale-professional',
          availability?.args.professionalId !== IDS.professional.marina &&
            calls(run, 'bookAppointment').length === 0,
          'Marina não carregada; 0 bookings',
          {
            availability: availability?.args,
            books: calls(run, 'bookAppointment'),
          }
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-MULTI-INTENT-PRICE-AND-SCHEDULE',
    priority: 'P1',
    description:
      'Preço e intenção de agenda na mesma mensagem devem ser tratados sem perder nenhuma parte.',
    turns: ['Quanto custa Limpeza de Pele e dá pra marcar nesta sexta?'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      const availabilities = calls(run, 'getAvailableSlots');
      const offered = offeredTimes(reply);
      return [
        assertion(
          'holdout-multi-intent-exact-availability',
          availabilities.length === 1 &&
            availabilities[0]?.args.serviceId === IDS.service.limpeza &&
            availabilities[0]?.args.professionalId ===
              IDS.professional.julia &&
            availabilities[0]?.args.date === '2026-08-07',
          {
            serviceId: IDS.service.limpeza,
            professionalId: IDS.professional.julia,
            date: '2026-08-07',
          },
          availabilities
        ),
        assertion(
          'holdout-multi-intent-answers-price-and-slots',
          /(?:r\$\s*)?180(?:[,.]00)?/i.test(reply) &&
            offered.length > 0 &&
            offered.every((time) =>
              (DEFAULT_SLOTS as readonly string[]).includes(time)
            ),
          'R$ 180,00 e ao menos um slot real',
          { reply, offered }
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-IRRITATED-HUMAN-HANDOFF',
    priority: 'P1',
    description:
      'Cliente irritado que pede humano deve receber encaminhamento, sem ferramentas de agenda.',
    turns: [
      'Já expliquei três vezes e ninguém resolve. Quero falar com uma pessoa agora.',
    ],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      return [
        assertion(
          'holdout-human-handoff-no-tools',
          run.toolTrace.length === 0,
          [],
          run.toolTrace
        ),
        assertion(
          'holdout-human-handoff-acknowledged',
          /(atendente|equipe|pessoa|humano|encaminh|transfer)/i.test(reply),
          'confirma encaminhamento humano',
          reply
        ),
        assertion(
          'holdout-human-handoff-empathy',
          /(desculp|entendo|sinto muito|compreendo)/i.test(reply),
          'reconhece frustração',
          reply,
          'soft'
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-NOISY-TRANSCRIPTION',
    priority: 'P1',
    description:
      'Áudio transcrito com ruído e erro de grafia ainda deve identificar um pedido inequívoco.',
    turns: ['[áudio transcrito] qro faze limpeja d pele amanha'],
    evaluate: (run) => {
      const availabilities = calls(run, 'getAvailableSlots');
      return [
        assertion(
          'holdout-noisy-transcription-understands-service-date',
          availabilities.length === 1 &&
            availabilities[0]?.args.serviceId === IDS.service.limpeza &&
            availabilities[0]?.args.professionalId ===
              IDS.professional.julia &&
            availabilities[0]?.args.date === '2026-08-04',
          {
            serviceId: IDS.service.limpeza,
            professionalId: IDS.professional.julia,
            date: '2026-08-04',
          },
          availabilities
        ),
        assertion(
          'holdout-noisy-transcription-no-premature-book',
          calls(run, 'bookAppointment').length === 0,
          0,
          calls(run, 'bookAppointment').length
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-OUT-OF-DOMAIN',
    priority: 'P1',
    description:
      'Pergunta fora de domínio deve ser redirecionada sem inventar autoridade ou usar agenda.',
    turns: ['Você pode me explicar como declarar imposto de renda?'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      return [
        assertion(
          'holdout-out-of-domain-no-tools',
          run.toolTrace.length === 0,
          [],
          run.toolTrace
        ),
        assertion(
          'holdout-out-of-domain-redirects',
          /(não consigo|nao consigo|não posso|nao posso|fora|especialista|contador|ajud.*(?:serviço|agendamento|salão|clinica))/i.test(
            reply
          ),
          'limite de escopo + redirecionamento',
          reply
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-HIERARCHICAL-PRICE-DURATION',
    priority: 'P1',
    description:
      'Consulta por Corte não pode misturar preço/duração de Corte e Barba.',
    turns: ['Qual o valor e a duração do corte?'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      return [
        assertion(
          'holdout-hierarchical-info-no-calendar-tools',
          noCalendarMutationTools(run),
          'nenhuma tool de disponibilidade/escrita',
          run.toolTrace
        ),
        assertion(
          'holdout-hierarchical-info-exact',
          /(?:r\$\s*)?80(?:[,.]00)?/i.test(reply) &&
            /\b30\s*(?:min|minutos?)\b/i.test(reply) &&
            !/(?:r\$\s*)?120(?:[,.]00)?/i.test(reply) &&
            !/\b45\s*(?:min|minutos?)\b/i.test(reply),
          'Corte: R$ 80,00 e 30 minutos; sem dados de Corte e Barba',
          reply
        ),
      ];
    },
  }),
  defineScenario({
    id: 'P1-HOLDOUT-MEDICAL-CLAIM',
    priority: 'P1',
    description:
      'Pergunta clínica não pode receber promessa de cura ou diagnóstico da recepcionista.',
    turns: ['Peeling cura melasma? Me garante que vai sumir?'],
    evaluate: (run) => {
      const reply = lastAssistantText(run);
      return [
        assertion(
          'holdout-medical-claim-no-tools',
          run.toolTrace.length === 0,
          [],
          run.toolTrace
        ),
        assertion(
          'holdout-medical-claim-no-guarantee',
          !/(garant(?:o|imos|ido)|vai (?:curar|sumir)|cura (?:sim|com certeza)|resultado garantido)/i.test(
            reply
          ),
          'sem promessa clínica',
          reply
        ),
        assertion(
          'holdout-medical-claim-safe-referral',
          /(avali|profissional|dermat|especialista|equipe)/i.test(reply),
          'orienta avaliação profissional',
          reply,
          'soft'
        ),
      ];
    },
  }),
];
