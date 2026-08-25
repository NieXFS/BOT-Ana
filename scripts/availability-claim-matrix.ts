import type {
  AvailabilityTimeMentionDisposition,
  AvailabilityTimeMentionExclusionReason,
  AvailabilityTimeMentionSource,
  AvailabilityTimeMentionV2,
} from '../src/services/availabilityClaimScope';

export type AvailabilityClaimMatrixCase = {
  label: string;
  text: string;
  claims: readonly AvailabilityTimeMentionV2[];
  requiresEvidence: boolean;
};

const mention = (
  text: string,
  rawToken: string,
  time: string,
  disposition: AvailabilityTimeMentionDisposition,
  source: AvailabilityTimeMentionSource,
  exclusionReason?: AvailabilityTimeMentionExclusionReason
): AvailabilityTimeMentionV2 => {
  const start = text.indexOf(rawToken);
  if (start < 0) {
    throw new Error(`matrix token not found: ${rawToken}`);
  }
  const base = {
    time,
    span: { start, end: start + rawToken.length },
    disposition,
    source,
  } satisfies AvailabilityTimeMentionV2;
  return exclusionReason ? { ...base, exclusionReason } : base;
};

const positive = (
  text: string,
  rawToken: string,
  time: string,
  source: AvailabilityTimeMentionSource
) => mention(text, rawToken, time, 'positive_availability', source);

const negative = (
  text: string,
  rawToken: string,
  time: string,
  source: AvailabilityTimeMentionSource
) => mention(text, rawToken, time, 'negative_availability', source);

const unknown = (
  text: string,
  rawToken: string,
  time: string,
  source: AvailabilityTimeMentionSource = 'unclassified'
) => mention(text, rawToken, time, 'unknown', source);

const excluded = (
  text: string,
  rawToken: string,
  time: string,
  exclusionReason: AvailabilityTimeMentionExclusionReason
) =>
  mention(
    text,
    rawToken,
    time,
    'non_availability_reference',
    'explicit_exclusion',
    exclusionReason
  );

/**
 * The first 24 cases are the IA-26b polarity matrix. Cases 25-29 are the
 * adversarial inversion cases from the previous iteration, and cases 30-34
 * close local scope for typed exclusions. The expected value is the complete
 * per-time mention list, not only the subset that the old helper happened to
 * recognize.
 */
export const AVAILABILITY_CLAIM_MATRIX: readonly AvailabilityClaimMatrixCase[] = [
  {
    label: 'negative result with a time restriction',
    text: 'Não encontrei horários hoje depois das 17h30.',
    claims: [
      excluded(
        'Não encontrei horários hoje depois das 17h30.',
        '17h30',
        '17:30',
        'customer_constraint'
      ),
    ],
    requiresEvidence: false,
  },
  {
    label: 'e opens positive claim',
    text: 'Não encontrei horários hoje e tenho 10:00 amanhã.',
    claims: [
      positive(
        'Não encontrei horários hoje e tenho 10:00 amanhã.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'comma opens positive claim',
    text: 'Não encontrei horários hoje, tenho 10:00 amanhã.',
    claims: [
      positive(
        'Não encontrei horários hoje, tenho 10:00 amanhã.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'adversative opens positive claim',
    text: 'Não encontrei horários hoje mas tenho 10:00 amanhã.',
    claims: [
      positive(
        'Não encontrei horários hoje mas tenho 10:00 amanhã.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative slot plus independent positive slot',
    text: 'Não temos 09:00 e temos 10:30.',
    claims: [
      negative('Não temos 09:00 e temos 10:30.', '09:00', '09:00', 'predicate_before'),
      positive('Não temos 09:00 e temos 10:30.', '10:30', '10:30', 'predicate_before'),
    ],
    requiresEvidence: true,
  },
  {
    label: 'two slots with coordinated positive inheritance',
    text: 'Temos 10:00 e 10:30.',
    claims: [
      positive('Temos 10:00 e 10:30.', '10:00', '10:00', 'predicate_before'),
      positive(
        'Temos 10:00 e 10:30.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'three slots with coordinated positive inheritance',
    text: 'Temos 10:00, 10:30 e 11:00.',
    claims: [
      positive(
        'Temos 10:00, 10:30 e 11:00.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      positive(
        'Temos 10:00, 10:30 e 11:00.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
      positive(
        'Temos 10:00, 10:30 e 11:00.',
        '11:00',
        '11:00',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'operating-hours clocks are not availability claims',
    text: 'Não encontrei horários hoje e o estabelecimento fecha às 20h.',
    claims: [
      excluded(
        'Não encontrei horários hoje e o estabelecimento fecha às 20h.',
        '20h',
        '20:00',
        'business_hours'
      ),
    ],
    requiresEvidence: false,
  },
  {
    label: 'positive then negative result lead',
    text: 'Temos 10:00 e não temos 10:30.',
    claims: [
      positive('Temos 10:00 e não temos 10:30.', '10:00', '10:00', 'predicate_before'),
      negative('Temos 10:00 e não temos 10:30.', '10:30', '10:30', 'predicate_before'),
    ],
    requiresEvidence: true,
  },
  {
    label: 'later local positive lead survives earlier negative result',
    text: 'Não encontrei horários hoje e amanhã tenho 10:00.',
    claims: [
      positive(
        'Não encontrei horários hoje e amanhã tenho 10:00.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'later status survives earlier negative result',
    text: 'Não encontrei nada hoje e o 15:00 está disponível.',
    claims: [
      positive(
        'Não encontrei nada hoje e o 15:00 está disponível.',
        '15:00',
        '15:00',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative lead plus status and inherited positive slot',
    text: 'Não tenho 09:00, mas o 11:00 está livre e o 14:00 também.',
    claims: [
      negative(
        'Não tenho 09:00, mas o 11:00 está livre e o 14:00 também.',
        '09:00',
        '09:00',
        'predicate_before'
      ),
      positive(
        'Não tenho 09:00, mas o 11:00 está livre e o 14:00 também.',
        '11:00',
        '11:00',
        'status_after'
      ),
      positive(
        'Não tenho 09:00, mas o 11:00 está livre e o 14:00 também.',
        '14:00',
        '14:00',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'positive result lead then negative status',
    text: 'Temos 10:00 e 10:30 não está disponível.',
    claims: [
      positive(
        'Temos 10:00 e 10:30 não está disponível.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      negative(
        'Temos 10:00 e 10:30 não está disponível.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'positive status then negative status',
    text: '10:00 está disponível e 10:30 não está.',
    claims: [
      positive(
        '10:00 está disponível e 10:30 não está.',
        '10:00',
        '10:00',
        'status_after'
      ),
      negative(
        '10:00 está disponível e 10:30 não está.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative result lead then positive status',
    text: 'Não temos 10:00, 10:30 está disponível.',
    claims: [
      negative(
        'Não temos 10:00, 10:30 está disponível.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      positive(
        'Não temos 10:00, 10:30 está disponível.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative result inherited through nem',
    text: 'Não encontrei 10:00 nem 10:30.',
    claims: [
      negative(
        'Não encontrei 10:00 nem 10:30.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      negative(
        'Não encontrei 10:00 nem 10:30.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: false,
  },
  {
    label: 'no explicit time',
    text: 'Não encontrei horário hoje e amanhã.',
    claims: [],
    requiresEvidence: false,
  },
  {
    label: 'restriction threshold remains non-offer',
    text: 'Não encontrei horário depois das 17:30.',
    claims: [
      excluded(
        'Não encontrei horário depois das 17:30.',
        '17:30',
        '17:30',
        'customer_constraint'
      ),
    ],
    requiresEvidence: false,
  },
  {
    label: 'positive state ellipsis after negative available state',
    text: 'O 10:00 não está disponível e o 10:30 está.',
    claims: [
      negative(
        'O 10:00 não está disponível e o 10:30 está.',
        '10:00',
        '10:00',
        'status_after'
      ),
      positive(
        'O 10:00 não está disponível e o 10:30 está.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'positive state ellipsis after negative free state',
    text: 'O 10:00 não está livre e o 10:30 está.',
    claims: [
      negative(
        'O 10:00 não está livre e o 10:30 está.',
        '10:00',
        '10:00',
        'status_after'
      ),
      positive(
        'O 10:00 não está livre e o 10:30 está.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative state ellipsis remains local after positive state',
    text: 'O 10:00 está disponível e o 10:30 não está.',
    claims: [
      positive(
        'O 10:00 está disponível e o 10:30 não está.',
        '10:00',
        '10:00',
        'status_after'
      ),
      negative(
        'O 10:00 está disponível e o 10:30 não está.',
        '10:30',
        '10:30',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative list plus later positive result',
    text: 'Não temos 10:00 nem 10:30, mas temos 11:00.',
    claims: [
      negative(
        'Não temos 10:00 nem 10:30, mas temos 11:00.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      negative(
        'Não temos 10:00 nem 10:30, mas temos 11:00.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
      positive(
        'Não temos 10:00 nem 10:30, mas temos 11:00.',
        '11:00',
        '11:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'positive list plus later negative result',
    text: 'Temos 10:00 e 10:30, mas não temos 11:00.',
    claims: [
      positive(
        'Temos 10:00 e 10:30, mas não temos 11:00.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      positive(
        'Temos 10:00 e 10:30, mas não temos 11:00.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
      negative(
        'Temos 10:00 e 10:30, mas não temos 11:00.',
        '11:00',
        '11:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative and positive result leads in one sentence',
    text: 'Não encontrei 10:00, encontrei 10:30.',
    claims: [
      negative(
        'Não encontrei 10:00, encontrei 10:30.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      positive(
        'Não encontrei 10:00, encontrei 10:30.',
        '10:30',
        '10:30',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'inverted plural state leaves the first time unknown',
    text: 'O 10:00 e o 10:30 estão disponíveis.',
    claims: [
      unknown(
        'O 10:00 e o 10:30 estão disponíveis.',
        '10:00',
        '10:00'
      ),
      unknown(
        'O 10:00 e o 10:30 estão disponíveis.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'inverted plural free state leaves both times visible',
    text: 'Estão livres 10:00 e 10:30.',
    claims: [
      unknown('Estão livres 10:00 e 10:30.', '10:00', '10:00'),
      unknown(
        'Estão livres 10:00 e 10:30.',
        '10:30',
        '10:30',
        'coordinated_inheritance'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'past appointment plus bare positive state',
    text: 'O 10:00 já foi, mas o 10:30 está.',
    claims: [
      excluded(
        'O 10:00 já foi, mas o 10:30 está.',
        '10:00',
        '10:00',
        'appointment_context'
      ),
      unknown(
        'O 10:00 já foi, mas o 10:30 está.',
        '10:30',
        '10:30'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'bare no/yes contrast keeps both mentions conservative',
    text: '10:00 não, 10:30 sim.',
    claims: [
      unknown('10:00 não, 10:30 sim.', '10:00', '10:00'),
      unknown('10:00 não, 10:30 sim.', '10:30', '10:30'),
    ],
    requiresEvidence: true,
  },
  {
    label: 'negative result plus bare yes keeps the second time conservative',
    text: 'Não temos 10:00 mas o 10:30 sim.',
    claims: [
      negative(
        'Não temos 10:00 mas o 10:30 sim.',
        '10:00',
        '10:00',
        'predicate_before'
      ),
      unknown(
        'Não temos 10:00 mas o 10:30 sim.',
        '10:30',
        '10:30'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'business-hours exclusion stays local before positive result',
    text: 'Fechamos às 20:00 e tenho 18:00.',
    claims: [
      excluded(
        'Fechamos às 20:00 e tenho 18:00.',
        '20:00',
        '20:00',
        'business_hours'
      ),
      positive(
        'Fechamos às 20:00 e tenho 18:00.',
        '18:00',
        '18:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'business-hours exclusion stays local before positive status',
    text: 'Funcionamos até 20:00 e o 18:00 está livre.',
    claims: [
      excluded(
        'Funcionamos até 20:00 e o 18:00 está livre.',
        '20:00',
        '20:00',
        'business_hours'
      ),
      positive(
        'Funcionamos até 20:00 e o 18:00 está livre.',
        '18:00',
        '18:00',
        'status_after'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'customer constraint stays local before positive result',
    text: 'Você pediu depois das 17:30 e tenho 18:00.',
    claims: [
      excluded(
        'Você pediu depois das 17:30 e tenho 18:00.',
        '17:30',
        '17:30',
        'customer_constraint'
      ),
      positive(
        'Você pediu depois das 17:30 e tenho 18:00.',
        '18:00',
        '18:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'appointment context stays local before positive result',
    text: 'Seu agendamento anterior era às 10:00 e tenho 11:00.',
    claims: [
      excluded(
        'Seu agendamento anterior era às 10:00 e tenho 11:00.',
        '10:00',
        '10:00',
        'appointment_context'
      ),
      positive(
        'Seu agendamento anterior era às 10:00 e tenho 11:00.',
        '11:00',
        '11:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: true,
  },
  {
    label: 'business-hours exclusion stays local before negative result',
    text: 'Fechamos às 20:00 e não tenho 18:00.',
    claims: [
      excluded(
        'Fechamos às 20:00 e não tenho 18:00.',
        '20:00',
        '20:00',
        'business_hours'
      ),
      negative(
        'Fechamos às 20:00 e não tenho 18:00.',
        '18:00',
        '18:00',
        'predicate_before'
      ),
    ],
    requiresEvidence: false,
  },
];

/** A standalone unknown probe remains useful in addition to the 34-case matrix. */
export const UNKNOWN_AVAILABILITY_CLAIM: AvailabilityClaimMatrixCase = {
  label: 'uncertain predicate is evidence-required',
  text: 'Acho que o 10:00 pode funcionar.',
  claims: [
    unknown('Acho que o 10:00 pode funcionar.', '10:00', '10:00'),
  ],
  requiresEvidence: true,
};
