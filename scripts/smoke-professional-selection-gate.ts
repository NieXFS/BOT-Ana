/**
 * Smoke determinístico do Guardrail D de seleção profissional. Sem rede,
 * provider, ERP ou banco: exercita somente o gate puro contra snapshots
 * sintéticos, inclusive compatibilidade com ERP legado (`professionalIds`
 * ausente) e a delimitação da intenção do cliente.
 */
import type { ServicesResult } from '../src/services/calendarService';
import {
  professionalSelectionGate,
  type ProfessionalSelectionGateResult,
} from '../src/services/professional-selection-gate';

const IDS = {
  service: {
    limpeza: 'svc-limpeza-pele',
    peeling: 'svc-peeling',
    drenagem: 'svc-drenagem',
    legado: 'svc-legado',
  },
  professional: {
    julia: 'prof-julia-sousa',
    marinaSilva: 'prof-marina-silva',
    marinaCosta: 'prof-marina-costa',
    caio: 'prof-caio-lima',
  },
} as const;

const servicesResult: ServicesResult = {
  success: true,
  services: [
    {
      id: IDS.service.limpeza,
      name: 'Limpeza de Pele',
      durationMinutes: 60,
      price: 180,
      priceFormatted: 'R$ 180,00',
      professionalIds: [IDS.professional.julia],
    },
    {
      id: IDS.service.peeling,
      name: 'Peeling',
      durationMinutes: 45,
      price: 250,
      priceFormatted: 'R$ 250,00',
      professionalIds: [
        IDS.professional.julia,
        IDS.professional.marinaSilva,
        IDS.professional.marinaCosta,
      ],
    },
    {
      id: IDS.service.drenagem,
      name: 'Drenagem',
      durationMinutes: 50,
      price: 160,
      priceFormatted: 'R$ 160,00',
      professionalIds: [],
    },
    {
      id: IDS.service.legado,
      name: 'Serviço Legado',
      durationMinutes: 30,
      price: 100,
      priceFormatted: 'R$ 100,00',
      // `undefined` deliberado: ERP antigo ainda não publica elegibilidade.
      professionalIds: undefined,
    },
  ],
  professionals: [
    { id: IDS.professional.julia, name: 'Júlia Sousa' },
    { id: IDS.professional.marinaSilva, name: 'Marina Silva' },
    { id: IDS.professional.marinaCosta, name: 'Marina Costa' },
    { id: IDS.professional.caio, name: 'Caio Lima' },
  ],
};

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${label}`);
  if (!condition) {
    failures += 1;
    if (detail !== undefined) {
      console.log(`  observado: ${JSON.stringify(detail)}`);
    }
  }
}

function run(input: {
  serviceId: string;
  professionalId?: string;
  userMessages: string[];
}): ProfessionalSelectionGateResult {
  return professionalSelectionGate({ ...input, servicesResult });
}

function runAfterChoosingJulia(
  rejection: string
): ProfessionalSelectionGateResult {
  return run({
    serviceId: IDS.service.peeling,
    professionalId: IDS.professional.julia,
    userMessages: [
      'Quero marcar Peeling.',
      'Com a Júlia.',
      rejection,
    ],
  });
}

function isBlocked(
  result: ProfessionalSelectionGateResult,
  reason: string
): boolean {
  return !result.ok && result.reason === reason && /INTERNAL_HINT:/.test(result.hintMessage);
}

function isAllowedWith(
  result: ProfessionalSelectionGateResult,
  effectiveProfessionalId?: string
): boolean {
  return (
    result.ok &&
    result.effectiveProfessionalId === effectiveProfessionalId
  );
}

// 0 habilitados: `[]` é indisponibilidade explícita, nunca fallback legado.
const none = run({
  serviceId: IDS.service.drenagem,
  userMessages: ['Quero marcar Drenagem amanhã.'],
});
check(
  '0 habilitados bloqueia getAvailableSlots/book e orienta indisponibilidade',
  isBlocked(none, 'no_eligible_professional'),
  none
);

// 1 habilitado: não pode perguntar preferência, omitir nem trocar profissional.
const singleOmitted = run({
  serviceId: IDS.service.limpeza,
  userMessages: ['Quero marcar Limpeza de Pele amanhã.'],
});
check(
  '1 habilitado: professionalId omitido é bloqueado com refação imediata',
  isBlocked(singleOmitted, 'single_professional_required'),
  singleOmitted
);

const singleWrong = run({
  serviceId: IDS.service.limpeza,
  professionalId: IDS.professional.caio,
  userMessages: ['Quero marcar Limpeza de Pele amanhã.'],
});
check(
  '1 habilitado: outro profissional é bloqueado',
  isBlocked(singleWrong, 'single_professional_required'),
  singleWrong
);

const singleAmbiguousPrefix = run({
  serviceId: IDS.service.limpeza,
  professionalId: 'prof-',
  userMessages: ['Quero marcar Limpeza de Pele amanhã.'],
});
check(
  '1 habilitado: prefixo ambíguo global não atravessa o gate',
  isBlocked(singleAmbiguousPrefix, 'single_professional_required'),
  singleAmbiguousPrefix
);

const singleUniquePrefix = run({
  serviceId: IDS.service.limpeza,
  professionalId: 'prof-j',
  userMessages: ['Quero marcar Limpeza de Pele amanhã.'],
});
check(
  '1 habilitado: prefixo globalmente unívoco é canonicalizado para a I/O',
  isAllowedWith(singleUniquePrefix, IDS.professional.julia),
  singleUniquePrefix
);

// 2+ habilitados: pré-fetch não é autorizado sem escolha do CLIENTE.
const prefetch = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.'],
});
check(
  '2+ habilitados: prefetch antes da preferência é bloqueado',
  isBlocked(prefetch, 'preference_required'),
  prefetch
);

const anyWithoutId = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.', 'Tanto faz.'],
});
check(
  '"tanto faz" libera somente com professionalId ausente',
  isAllowedWith(anyWithoutId),
  anyWithoutId
);

const noPreferenceWithoutId = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.', 'Sem preferência.'],
});
check(
  '"sem preferência" também libera professionalId ausente',
  isAllowedWith(noPreferenceWithoutId),
  noPreferenceWithoutId
);

const noPreferenceExplicitWithoutId = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.', 'Não tenho preferência.'],
});
check(
  '"não tenho preferência" curto também libera sem professionalId',
  isAllowedWith(noPreferenceExplicitWithoutId),
  noPreferenceExplicitWithoutId
);

const anyWithCourtesy = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.', 'Tanto faz, por favor.'],
});
check(
  'resposta curta "tanto faz" com cortesia ainda libera sem professionalId',
  isAllowedWith(anyWithCourtesy),
  anyWithCourtesy
);

const explicitAnyProfessional = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling amanhã.', 'Qualquer profissional amanhã.'],
});
check(
  'forma profissional explícita aceita "qualquer profissional" mesmo com data',
  isAllowedWith(explicitAnyProfessional),
  explicitAnyProfessional
);

const anyWithId = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: ['Quero marcar Peeling amanhã.', 'Qualquer um.'],
});
check(
  'ID indevido depois de "qualquer um" é bloqueado e exige omissão',
  isBlocked(anyWithId, 'any_preference_requires_omission'),
  anyWithId
);

const fullName = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: ['Quero marcar Peeling com a Marina Silva amanhã.'],
});
check(
  'nome completo explícito habilitado autoriza o ID correspondente',
  isAllowedWith(fullName, IDS.professional.marinaSilva),
  fullName
);

const uniqueFirstName = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: ['Quero marcar Peeling com a Júlia amanhã.'],
});
check(
  'primeiro nome unívoco entre ativos resolve para o profissional correto',
  isAllowedWith(uniqueFirstName, IDS.professional.julia),
  uniqueFirstName
);

const ambiguousFirstName = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: ['Quero marcar Peeling com a Marina amanhã.'],
});
check(
  'primeiro nome compartilhado permanece ambíguo e fail-closed',
  isBlocked(ambiguousFirstName, 'preference_required'),
  ambiguousFirstName
);

const namedMismatch = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaCosta,
  userMessages: ['Quero marcar Peeling.', 'Com a Júlia.'],
});
check(
  'nome explícito: mismatch de professionalId é bloqueado',
  isBlocked(namedMismatch, 'named_professional_required'),
  namedMismatch
);

const namedOmitted = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling.', 'Com a Júlia.'],
});
check(
  'nome explícito: omissão de professionalId é bloqueada',
  isBlocked(namedOmitted, 'named_professional_required'),
  namedOmitted
);

const dateCorrectionKeepsProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Marina Silva.',
    'Na verdade, nesta sexta.',
  ],
});
check(
  'correção de data preserva profissional explícito da intenção em curso',
  isAllowedWith(
    dateCorrectionKeepsProfessional,
    IDS.professional.marinaSilva
  ),
  dateCorrectionKeepsProfessional
);

const dateCorrectionWithChangeLanguageKeepsProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Marina Silva.',
    'Mudei de ideia, quero nesta sexta.',
  ],
});
check(
  '"mudei de ideia" em correção de data não apaga a profissional escolhida',
  isAllowedWith(
    dateCorrectionWithChangeLanguageKeepsProfessional,
    IDS.professional.marinaSilva
  ),
  dateCorrectionWithChangeLanguageKeepsProfessional
);

const dateCorrectionWithNowWantKeepsProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Marina Silva.',
    'Agora quero dia 10.',
  ],
});
check(
  '"agora quero" em correção de data não reinicia a preferência profissional',
  isAllowedWith(
    dateCorrectionWithNowWantKeepsProfessional,
    IDS.professional.marinaSilva
  ),
  dateCorrectionWithNowWantKeepsProfessional
);

const serviceChangeOmitted = run({
  serviceId: IDS.service.limpeza,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Marina Silva.',
    'Mudei de ideia, quero Limpeza de Pele.',
  ],
});
check(
  'mudança de serviço reavalia elegibilidade e exige a única Júlia',
  isBlocked(serviceChangeOmitted, 'single_professional_required'),
  serviceChangeOmitted
);

const serviceChangeCorrect = run({
  serviceId: IDS.service.limpeza,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Marina Silva.',
    'Mudei de ideia, quero Limpeza de Pele.',
  ],
});
check(
  'mudança de serviço não carrega Marina e aceita a única Júlia',
  isAllowedWith(serviceChangeCorrect, IDS.professional.julia),
  serviceChangeCorrect
);

const incompatible = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.caio,
  userMessages: ['Quero marcar Peeling com o Caio amanhã.'],
});
check(
  'profissional ativo incompatível com o serviço é bloqueado',
  isBlocked(incompatible, 'ineligible_professional_requested'),
  incompatible
);

const newBookingResetsOldPreference = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling amanhã.',
    'Com a Júlia.',
    'Quero marcar outro agendamento de Peeling amanhã.',
  ],
});
check(
  'novo agendamento não herda profissional escolhido no fluxo anterior',
  isBlocked(newBookingResetsOldPreference, 'preference_required'),
  newBookingResetsOldPreference
);

const namedProfessionalWithAnyTime = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia, qualquer horário.',
  ],
});
check(
  '"com a Júlia, qualquer horário" mantém Júlia; horário não vira qualquer profissional',
  isAllowedWith(namedProfessionalWithAnyTime, IDS.professional.julia),
  namedProfessionalWithAnyTime
);

const noPreferenceForTime = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling.', 'Sem preferência de horário.'],
});
check(
  '"sem preferência de horário" sem profissional continua pedindo preferência',
  isBlocked(noPreferenceForTime, 'preference_required'),
  noPreferenceForTime
);

const anyTime = run({
  serviceId: IDS.service.peeling,
  userMessages: ['Quero marcar Peeling.', 'Tanto faz o horário.'],
});
check(
  '"tanto faz o horário" não licencia qualquer profissional',
  isBlocked(anyTime, 'preference_required'),
  anyTime
);

const temporalAnyOneOfSlots = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: ['Quero marcar Peeling.', 'Qualquer um dos horários.'],
});
check(
  '"qualquer um dos horários" não vira escolha de profissional',
  isBlocked(temporalAnyOneOfSlots, 'preference_required'),
  temporalAnyOneOfSlots
);

const temporalAnyOneOfDates = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: ['Quero marcar Peeling.', 'Qualquer uma das datas.'],
});
check(
  '"qualquer uma das datas" não vira escolha de profissional',
  isBlocked(temporalAnyOneOfDates, 'preference_required'),
  temporalAnyOneOfDates
);

const temporalAnyOfTheseSlots = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: ['Quero marcar Peeling.', 'Qualquer um desses horários.'],
});
check(
  '"qualquer um desses horários" não vira escolha de profissional',
  isBlocked(temporalAnyOfTheseSlots, 'preference_required'),
  temporalAnyOfTheseSlots
);

const excludedProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: ['Quero marcar Peeling.', 'Qualquer um menos Marina.'],
});
check(
  'exclusão "qualquer um menos Marina" é ambígua e fail-closed',
  isBlocked(excludedProfessional, 'preference_required'),
  excludedProfessional
);

const rejectedNamedProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Não quero a Júlia.',
  ],
});
check(
  'nome negado não vira escolha positiva mesmo com professionalId antigo',
  isBlocked(rejectedNamedProfessional, 'preference_required'),
  rejectedNamedProfessional
);

const noLongerWantsJulia = runAfterChoosingJulia('Não quero mais a Júlia.');
check(
  '"não quero mais a Júlia" reseta o ID antigo e falha fechado',
  isBlocked(noLongerWantsJulia, 'preference_required'),
  noLongerWantsJulia
);

const noLongerAcceptsJulia = runAfterChoosingJulia('Não aceito mais a Júlia.');
check(
  '"não aceito mais a Júlia" reseta o ID antigo e falha fechado',
  isBlocked(noLongerAcceptsJulia, 'preference_required'),
  noLongerAcceptsJulia
);

const noLongerPrefersJulia = runAfterChoosingJulia('Não prefiro mais Júlia.');
check(
  '"não prefiro mais Júlia" reseta o ID antigo e falha fechado',
  isBlocked(noLongerPrefersJulia, 'preference_required'),
  noLongerPrefersJulia
);

const juliaCannotBeChosen = runAfterChoosingJulia('Não pode ser a Júlia.');
check(
  '"não pode ser a Júlia" não vira escolha positiva',
  isBlocked(juliaCannotBeChosen, 'preference_required'),
  juliaCannotBeChosen
);

const juliaMustNotBeChosen = runAfterChoosingJulia('Que não seja a Júlia.');
check(
  '"que não seja a Júlia" não vira escolha positiva',
  isBlocked(juliaMustNotBeChosen, 'preference_required'),
  juliaMustNotBeChosen
);

const juliaNo = runAfterChoosingJulia('Júlia não.');
check(
  '"Júlia não" não vira escolha positiva',
  isBlocked(juliaNo, 'preference_required'),
  juliaNo
);

const excludedNamedProfessional = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Menos a Júlia.',
  ],
});
check(
  'nome excluído não vira escolha positiva mesmo com professionalId antigo',
  isBlocked(excludedNamedProfessional, 'preference_required'),
  excludedNamedProfessional
);

const rejectedSharedFirstName = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaSilva,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Marina Silva.',
    'Não quero a Marina.',
  ],
});
check(
  'rejeição por primeiro nome compartilhado também limpa a Marina anterior',
  isBlocked(rejectedSharedFirstName, 'preference_required'),
  rejectedSharedFirstName
);

const anotherProfessionalResetsPreference = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Quero outra profissional.',
  ],
});
check(
  '"outra profissional" limpa preferência antiga e bloqueia o ID anterior',
  isBlocked(anotherProfessionalResetsPreference, 'preference_required'),
  anotherProfessionalResetsPreference
);

const differentProfessionalResetsPreference = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Quero profissional diferente.',
  ],
});
check(
  '"profissional diferente" limpa preferência antiga e bloqueia o ID anterior',
  isBlocked(differentProfessionalResetsPreference, 'preference_required'),
  differentProfessionalResetsPreference
);

const changeProfessionalResetsPreference = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Quero trocar de profissional.',
  ],
});
check(
  '"trocar de profissional" limpa preferência antiga e bloqueia o ID anterior',
  isBlocked(changeProfessionalResetsPreference, 'preference_required'),
  changeProfessionalResetsPreference
);

const moveProfessionalResetsPreference = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.julia,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Quero mudar de profissional.',
  ],
});
check(
  '"mudar de profissional" limpa preferência antiga e bloqueia o ID anterior',
  isBlocked(moveProfessionalResetsPreference, 'preference_required'),
  moveProfessionalResetsPreference
);

const laterNamedProfessionalAfterReset = run({
  serviceId: IDS.service.peeling,
  professionalId: IDS.professional.marinaCosta,
  userMessages: [
    'Quero marcar Peeling.',
    'Com a Júlia.',
    'Quero outra profissional.',
    'Com a Marina Costa.',
  ],
});
check(
  'nome inequívoco posterior substitui normalmente o reset de profissional',
  isAllowedWith(laterNamedProfessionalAfterReset, IDS.professional.marinaCosta),
  laterNamedProfessionalAfterReset
);

const legacyFallback = run({
  serviceId: IDS.service.legado,
  professionalId: IDS.professional.caio,
  userMessages: ['Quero marcar Serviço Legado com o Caio amanhã.'],
});
check(
  'professionalIds ausente usa fallback global legado, não vira zero habilitados',
  isAllowedWith(legacyFallback, IDS.professional.caio),
  legacyFallback
);

console.log(
  `\n${
    failures === 0
      ? '✅ smoke-professional-selection-gate OK'
      : `❌ ${failures} check(s) falharam`
  }`
);
process.exit(failures === 0 ? 0 : 1);
