import type { ServicesResult } from './calendarService';
import { buildCanonicalDuplicateAppointmentContextV2 } from './conversationalV2/duplicateAppointmentCopy';
import {
  classifyAvailabilityTimeClaims,
  type AvailabilityTimeMentionV2,
} from './availabilityClaimScope';

export type CustomerReplyLeakReason =
  | 'internal_hint'
  | 'service_id'
  | 'professional_id'
  | 'appointment_id'
  | 'technical_id'
  | 'false_write_claim'
  | 'unverified_availability'
  | 'unverified_appointment_context';

export interface CustomerReplyInspection {
  safe: boolean;
  reasons: CustomerReplyLeakReason[];
}

export type ToolTraceLike = {
  name: string;
  result: string;
  /**
   * Só existe nos traces do benchmark/reauditoria. Em produção, o trace é
   * sempre do turno que acabou de ser processado e pode omitir este campo.
   */
  userTurn?: number;
};

export interface AppointmentTemporalContext {
  now: Date | string;
  timezone: string;
}

type WriteKind = 'book' | 'cancel' | 'reschedule';

type AuthoritativeAppointment = {
  startTime: string;
  serviceName?: string;
  professionalName?: string;
  status?: string;
};

const COMPLETED_WRITE_CLAIM_RE =
  /\b(?:agendad[oa]s?|marcad[oa]s?|confirmad[oa]s?|cancelad[oa]s?|remarcad[oa]s?|reservad[oa]s?|criad[oa]s?|realizad[oa]s?|agendei|marquei|confirmei|cancelei|remarquei|reservei|realizei|acabei de (?:agendar|marcar|confirmar|cancelar|remarcar|reservar))\b/g;
const EMOJI_CLUSTER_RE =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

function normalizeClaimText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInitialInternalMetaParagraph(paragraph: string): boolean {
  const normalized = normalizeClaimText(paragraph);
  return (
    normalized.includes(
      'preciso perguntar a preferencia antes de consultar horarios'
    ) ||
    /\b[oa] cliente (?:quer|pediu|disse)\b/.test(normalized) ||
    /\b(?:getavailableslots|bookappointment|getservices|getupcomingappointments|cancelappointment)\b/.test(
      normalized
    )
  );
}

/**
 * Remove somente uma sequência de parágrafos internos no INÍCIO da resposta.
 * Se todos os parágrafos forem internos, preserva a mensagem: esta camada não
 * cria fallback, não devolve vazio e nunca recorta uma frase no meio.
 */
function stripLeadingInternalMetaParagraphs(normalizedReply: string): string {
  const paragraphs = normalizedReply
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let initialMetaCount = 0;

  while (
    initialMetaCount < paragraphs.length &&
    isInitialInternalMetaParagraph(paragraphs[initialMetaCount])
  ) {
    initialMetaCount += 1;
  }

  if (initialMetaCount === 0 || initialMetaCount === paragraphs.length) {
    return normalizedReply;
  }

  return paragraphs.slice(initialMetaCount).join('\n\n');
}

/**
 * Normalização mecânica e conservadora para WhatsApp. Não resume nem corta
 * conteúdo operacional: remove apenas sintaxe Markdown/list markers e limita
 * a resposta a um emoji, mesmo quando o modelo ignora a instrução de estilo.
 */
export function normalizeCustomerReplyStyle(reply: string): string {
  let emojiSeen = false;
  const normalizedReply = reply
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(EMOJI_CLUSTER_RE, (emoji) => {
      if (emojiSeen) return '';
      emojiSeen = true;
      return emoji;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return stripLeadingInternalMetaParagraphs(normalizedReply);
}

function toolSucceeded(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { success?: unknown };
    return parsed.success === true;
  } catch {
    return false;
  }
}

function successfulWriteKinds(toolTrace: ToolTraceLike[]): Set<WriteKind> {
  const kinds = new Set<WriteKind>();
  for (const entry of toolTrace) {
    if (!toolSucceeded(entry.result)) continue;
    if (entry.name === 'bookAppointment') kinds.add('book');
    if (entry.name === 'cancelAppointment') kinds.add('cancel');
  }
  if (kinds.has('book') && kinds.has('cancel')) {
    kinds.add('reschedule');
  }
  return kinds;
}

function parseSuccessfulAppointmentReads(
  toolTrace: ToolTraceLike[]
): AuthoritativeAppointment[] {
  const appointments: AuthoritativeAppointment[] = [];
  const turns = toolTrace
    .map((entry) => entry.userTurn)
    .filter((turn): turn is number => Number.isInteger(turn));
  const currentTurn = turns.length > 0 ? Math.max(...turns) : null;
  for (const entry of toolTrace) {
    if (entry.name !== 'getUpcomingAppointments') continue;
    // Reaudits can carry more than one user turn in a single trace. A
    // successful read from an older turn is not provenance for this copy;
    // production traces omit userTurn because they are already turn-scoped.
    if (currentTurn !== null && entry.userTurn !== currentTurn) continue;
    try {
      const parsed = JSON.parse(entry.result) as {
        success?: unknown;
        appointments?: unknown;
      };
      if (parsed.success !== true || !Array.isArray(parsed.appointments)) {
        continue;
      }
      for (const appointment of parsed.appointments) {
        if (
          appointment &&
          typeof appointment === 'object' &&
          typeof (appointment as { startTime?: unknown }).startTime === 'string'
        ) {
          const candidate = appointment as {
            startTime: string;
            serviceName?: unknown;
            professionalName?: unknown;
            status?: unknown;
          };
          appointments.push({
            startTime: candidate.startTime,
            serviceName:
              typeof candidate.serviceName === 'string'
                ? candidate.serviceName
                : undefined,
            professionalName:
              typeof candidate.professionalName === 'string'
                ? candidate.professionalName
                : undefined,
            status:
              typeof candidate.status === 'string'
                ? candidate.status
                : undefined,
          });
        }
      }
    } catch {
      // Leitura inválida nunca licencia uma afirmação.
    }
  }
  return appointments;
}

function isPlainWriteStatusQuestion(clause: string): boolean {
  if (/\b(?:com sucesso|pronto|tudo certo)\b/.test(clause)) return false;
  return /^(?:(?:o|seu|esse|este)\s+)?(?:agendamento|horario|cancelamento|remarcacao|reserva)\s+(?:(?:esta|ta|ficou|foi)\s+)?(?:agendad[oa]|marcad[oa]|confirmad[oa]|cancelad[oa]|remarcad[oa]|reservad[oa])(?:\s+(?:com|para|no|na|dia|as)\b[^?]*)?\s*\?$/.test(
    clause
  );
}

function claimWriteKind(claim: string): WriteKind {
  if (/cancel/.test(claim)) return 'cancel';
  if (/remarc/.test(claim)) return 'reschedule';
  return 'book';
}

function isPresentAppointmentStateClaim(
  clause: string,
  matchIndex: number,
  claim: string
): boolean {
  if (!/^(?:agendad|marcad|confirmad|reservad)/.test(claim)) {
    return false;
  }

  const beforeClaim = clause.slice(0, matchIndex);
  return (
    /\b(?:esta|ta|continua|permanece)\s*$/.test(beforeClaim) ||
    /\bvoce\s+(?:ja\s+)?tem\s+(?!que\b)[^.!?\n]{0,140}\s*$/.test(beforeClaim) ||
    /\b(?:voce\s+(?:ja\s+)?)?tem\s+(?:(?:um|o|esse|este|seu)\s+)?(?:agendamento|horario)\b[^.!?\n]{0,120}\s*$/.test(
      beforeClaim
    )
  );
}

function isServicePerformanceDescription(
  clause: string,
  matchIndex: number,
  claim: string
): boolean {
  if (!/^realizad/.test(claim)) return false;
  const beforeClaim = clause.slice(0, matchIndex);
  const afterClaim = clause.slice(matchIndex + claim.length);
  return (
    /^\s+(?:por|pelo|pela|pelos|pelas)\b/.test(afterClaim) &&
    (/\b(?:servico|procedimento|tratamento|ele|ela)\s+(?:e|eh)\s*$/.test(
      beforeClaim
    ) ||
      (!/\b(?:agendamento|horario|reserva)\b/.test(beforeClaim) &&
        /\b(?:e|eh)\s*$/.test(beforeClaim)))
  );
}

function localClaimIsNegatedOrFuture(
  clause: string,
  matchIndex: number
): boolean {
  const beforeClaim = clause.slice(0, matchIndex);
  // Só a oração local governa a polaridade. Ex.: "não consegui cancelar,
  // mas o novo ficou confirmado" continua sendo uma afirmação positiva.
  const localPrefix =
    beforeClaim.split(/[,;:]|\b(?:mas|porem|contudo|entretanto)\b/).pop() ??
    beforeClaim;

  const isNegated =
    /(?:\b(?:nao|nunca)\b(?:\s+\w+){0,6}|\bainda\s+nao\b(?:\s+\w+){0,6}|\bsem\b(?:\s+\w+){0,4})\s*$/.test(
      localPrefix
    );
  // O quantificador genérico acima usa \w por segurança e, portanto, não
  // atravessa "100%". Este caso de estado negativo é deliberadamente estreito:
  // só reconhece uma negação explícita imediatamente antes de estar/ficar com
  // percentual ou intensificador; nunca licencia uma confirmação positiva.
  const isExplicitNegatedStatus =
    /\b(?:ainda\s+)?nao\s+(?:esta|ta|ficou|permanece)\s+(?:(?:\d+(?:[.,]\d+)?\s*%|totalmente|completamente)\s+)?$/.test(
      localPrefix
    );
  const isFutureOrConditional =
    /(?:\b(?:vou|vamos|iremos|vai|vao|sera|serao|estara|estarao|ficara|ficarao|ficaria|ficariam|poderia|poderiam|posso|podemos|pretendo)\b(?:\s+\w+){0,6}|\b(?:assim que|quando|caso|depois que|se)\b(?:\s+\w+){0,8})\s*$/.test(
      localPrefix
    );
  // "Pode ser que" e "talvez" são hipóteses sobre um estado, não uma
  // confirmação de write. Não dividimos em vírgulas aqui: a mesma hipótese
  // pode governar alternativas coordenadas ("... confirmado, ou ...
  // cancelado"). Um contraste posterior ("mas") continua isolando a oração
  // positiva, como na regra acima.
  const hypothesisPrefix =
    beforeClaim.split(/\b(?:mas|porem|contudo|entretanto)\b/).pop() ?? beforeClaim;
  const isHedgedHypothesis = /\b(?:pode ser que|talvez)\b/.test(hypothesisPrefix);

  return (
    isNegated ||
    isExplicitNegatedStatus ||
    isFutureOrConditional ||
    isHedgedHypothesis
  );
}

function appointmentLocalParts(startTime: string, timezone?: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
} | null {
  if (timezone) {
    const instant = new Date(startTime);
    if (Number.isNaN(instant.getTime())) return null;
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        weekday: 'long',
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value])
    );
    const weekdayMap: Record<string, string> = {
      Sunday: 'domingo',
      Monday: 'segunda',
      Tuesday: 'terca',
      Wednesday: 'quarta',
      Thursday: 'quinta',
      Friday: 'sexta',
      Saturday: 'sabado',
    };
    if (!values.year || !values.month || !values.day || !values.hour || !values.minute) {
      return null;
    }
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      weekday: weekdayMap[values.weekday ?? ''] ?? '',
    };
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startTime);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const weekday = [
    'domingo',
    'segunda',
    'terca',
    'quarta',
    'quinta',
    'sexta',
    'sabado',
  ][
    new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12)
    ).getUTCDay()
  ];
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    weekday,
  };
}

const CANONICAL_DUPLICATE_LEAD_RE =
  /^vi\s+que\s+voce\s+ja\s+tem\s+outro\s+agendamento\s+de\b/u;

/**
 * The v2 duplicate preflight owns one exact sentence. Rebuild it from the
 * appointment read and the runtime timezone; a canonical-looking clause that
 * differs in any semantic token must not fall through to generic prose
 * matching.
 */
function matchesCanonicalDuplicateClause(
  clause: string,
  appointment: AuthoritativeAppointment,
  timezone?: string
): boolean {
  if (!timezone || !appointment.serviceName) return false;
  const expected = buildCanonicalDuplicateAppointmentContextV2({
    serviceName: appointment.serviceName,
    startTime: appointment.startTime,
    timezone,
  });
  return expected !== null && normalizeClaimText(clause) === normalizeClaimText(expected);
}

const HOUR_WORD_VALUES: Record<string, number> = {
  zero: 0,
  uma: 1,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  'vinte e uma': 21,
  'vinte e duas': 22,
  'vinte e tres': 23,
};

const WORD_HOUR_PATTERN = Object.keys(HOUR_WORD_VALUES)
  .sort((left, right) => right.length - left.length)
  .join('|');

function mentionedTimes(clause: string): string[] {
  const times = new Set<string>();
  for (const match of clause.matchAll(
    /\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:([0-5]\d))?)\b/g
  )) {
    times.add(
      `${String(Number(match[1])).padStart(2, '0')}:${
        match[2] ?? match[3] ?? '00'
      }`
    );
  }
  for (const match of clause.matchAll(
    new RegExp(
      `\\b(?:as|para|pras?)\\s+(${WORD_HOUR_PATTERN})(?:\\s+horas?)?(?:\\s+e\\s+(meia|trinta|quinze|quarenta e cinco))?\\b`,
      'g'
    )
  )) {
    const hour = HOUR_WORD_VALUES[match[1] ?? ''];
    if (hour === undefined) continue;
    const minute =
      match[2] === 'meia' || match[2] === 'trinta'
        ? 30
        : match[2] === 'quinze'
          ? 15
          : match[2] === 'quarenta e cinco'
            ? 45
            : 0;
    times.add(
      `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    );
  }
  return [...times];
}

function normalizeAvailabilitySlot(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeClaimText(value);
  const match = /^([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)$/.exec(
    normalized
  );
  if (!match) return null;

  return `${String(Number(match[1])).padStart(2, '0')}:${
    match[2] ?? match[3] ?? '00'
  }`;
}

const QUALIFIED_BOOK_AVAILABILITY_FAILURE_REASONS = new Set([
  'blocked',
  'conflict',
  'outside_hours',
]);

/**
 * Coleta disponibilidade concreta apenas de fontes autoritativas do turno
 * atual: leitura `getAvailableSlots success:true` ou falha qualificada de
 * `bookAppointment` que já devolveu `availableSlots` após consultar o
 * calendário internamente. `message` e `hint` nunca são evidência.
 */
function currentTurnAuthoritativeAvailabilitySlots(
  toolTrace: ToolTraceLike[]
): Set<string> {
  const turns = toolTrace
    .map((entry) => entry.userTurn)
    .filter((turn): turn is number => Number.isInteger(turn));
  const currentTurn = turns.length > 0 ? Math.max(...turns) : null;
  const slots = new Set<string>();

  for (const entry of toolTrace) {
    // O runtime real constrói o trace por chamada de getReply, então todos os
    // itens já pertencem ao turno atual. Na reauditoria, ignorar qualquer slot
    // de turno anterior impede a resposta de reciclar disponibilidade velha.
    if (currentTurn !== null && entry.userTurn !== currentTurn) continue;
    try {
      const parsed = JSON.parse(entry.result) as {
        success?: unknown;
        slots?: unknown;
        reason?: unknown;
        availableSlots?: unknown;
      };
      const rawSlots =
        entry.name === 'getAvailableSlots' &&
        parsed.success === true &&
        Array.isArray(parsed.slots)
          ? parsed.slots
          : entry.name === 'bookAppointment' &&
              parsed.success === false &&
              typeof parsed.reason === 'string' &&
              QUALIFIED_BOOK_AVAILABILITY_FAILURE_REASONS.has(parsed.reason) &&
              Array.isArray(parsed.availableSlots)
            ? parsed.availableSlots
            : null;
      if (!rawSlots) continue;

      const normalizedSlots: string[] = [];
      for (const slot of rawSlots) {
        const normalized = normalizeAvailabilitySlot(slot);
        // Um payload parcialmente malformado não prova que o subconjunto que
        // parece válido seja completo. Rejeita a fonte inteira fail-closed.
        if (!normalized) {
          normalizedSlots.length = 0;
          break;
        }
        normalizedSlots.push(normalized);
      }
      if (normalizedSlots.length !== rawSlots.length) continue;

      for (const slot of normalizedSlots) {
        slots.add(slot);
      }
    } catch {
      // Resposta de tool inválida não licencia disponibilidade.
    }
  }

  return slots;
}

/**
 * Exceção estrita para a leitura factual "confirmei que 15h está disponível".
 * Não licencia agendamento: exige o verbo exato, a gramática de disponibilidade
 * e cada horário citado no mesmo conjunto autoritativo do turno atual.
 */
function isVerifiedAvailabilityConfirmation(
  clause: string,
  matchIndex: number,
  claim: string,
  verifiedSlots: Set<string>
): boolean {
  if (claim !== 'confirmei' || matchIndex !== 0 || verifiedSlots.size === 0) {
    return false;
  }

  const afterClaim = clause.slice(matchIndex + claim.length);
  const isAvailabilityStatement =
    /^\s+que\s+(?:as\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)?(?:\s*(?:,|e)\s*(?:as\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)?)*\s+(?:esta|ta|estao)\s+disponiv(?:el|eis)\b/.test(
      afterClaim
    );
  if (!isAvailabilityStatement) return false;

  const times = mentionedTimes(clause);
  return times.length > 0 && times.every((time) => verifiedSlots.has(time));
}

/**
 * Expõe a classificação completa por horário. A fronteira abaixo decide quais
 * disposições são oferta e quais foram excluídas positivamente; horário não
 * compreendido permanece `unknown` e exige evidência.
 */
export function classifyCustomerReplyAvailabilityClaims(
  reply: string
): AvailabilityTimeMentionV2[] {
  return classifyAvailabilityTimeClaims(reply);
}

function offeredAvailabilitySlots(reply: string): string[] {
  const offered = new Set<string>();
  for (const claim of classifyCustomerReplyAvailabilityClaims(reply)) {
    // Só uma exclusão tipada ou uma negativa local fica fora deste guard. Toda
    // menção positiva ou ainda desconhecida exige prova autoritativa.
    if (
      claim.disposition === 'positive_availability' ||
      claim.disposition === 'unknown'
    ) {
      offered.add(claim.time);
    }
  }
  return [...offered];
}

/**
 * Uma oferta concreta de horário é uma afirmação operacional. Só pode seguir
 * para o WhatsApp se uma fonte autoritativa tiver retornado cada slot NO TURNO
 * ATUAL: `getAvailableSlots success:true` ou `bookAppointment success:false`
 * qualificado com `availableSlots`. Falta de fonte, falha não qualificada ou
 * divergência bloqueiam fail-closed; não usamos histórico, prompt, `message`,
 * `hint` ou uma disponibilidade consultada em turno anterior como evidência.
 */
export function hasUnverifiedAvailabilityClaim(
  reply: string,
  toolTrace: ToolTraceLike[],
  additionalVerifiedSlots: readonly string[] = []
): boolean {
  const offered = offeredAvailabilitySlots(reply);
  if (offered.length === 0) return false;

  const verified = currentTurnAuthoritativeAvailabilitySlots(toolTrace);
  for (const slot of additionalVerifiedSlots) {
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot)) verified.add(slot);
  }
  return offered.some((slot) => !verified.has(slot));
}

function mentionedDates(
  clause: string
): Array<{ year?: number; month: number; day: number }> {
  const dates: Array<{ year?: number; month: number; day: number }> = [];
  for (const match of clause.matchAll(
    /\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])(?:[/-](\d{2,4}))?\b/g
  )) {
    const rawYear = match[3];
    dates.push({
      day: Number(match[1]),
      month: Number(match[2]),
      year: rawYear
        ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
        : undefined,
    });
  }
  for (const match of clause.matchAll(/\bdia\s+(0?[1-9]|[12]\d|3[01])\b/g)) {
    if (!dates.some((date) => date.day === Number(match[1]))) {
      dates.push({ day: Number(match[1]), month: 0 });
    }
  }
  return dates;
}

function expectedRelativeCivilDate(
  temporalContext: AppointmentTemporalContext,
  offsetDays: number
): { year: number; month: number; day: number } | null {
  const instant =
    temporalContext.now instanceof Date
      ? temporalContext.now
      : new Date(temporalContext.now);
  if (Number.isNaN(instant.getTime())) return null;
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: temporalContext.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  if (!values.year || !values.month || !values.day) return null;
  const shifted = new Date(
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day) + offsetDays,
      12
    )
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function appointmentMatchesStateClause(
  clause: string,
  appointment: AuthoritativeAppointment,
  allAppointments: AuthoritativeAppointment[],
  temporalContext?: AppointmentTemporalContext
): boolean {
  if (
    appointment.status &&
    /cancel|reject|no_show|deleted/i.test(appointment.status)
  ) {
    return false;
  }
  const normalizedClause = normalizeClaimText(clause);
  if (CANONICAL_DUPLICATE_LEAD_RE.test(normalizedClause)) {
    return matchesCanonicalDuplicateClause(
      normalizedClause,
      appointment,
      temporalContext?.timezone
    );
  }
  if (
    /\bconfirmad[oa]s?\b/.test(clause) &&
    appointment.status &&
    !/confirm|scheduled|booked/i.test(appointment.status)
  ) {
    return false;
  }

  const parts = appointmentLocalParts(
    appointment.startTime,
    temporalContext?.timezone
  );
  if (!parts) return false;

  const relativeOffset = /\bamanha\b/.test(clause)
    ? 1
    : /\bhoje\b/.test(clause)
      ? 0
      : null;
  if (relativeOffset !== null) {
    if (!temporalContext) return false;
    const expected = expectedRelativeCivilDate(temporalContext, relativeOffset);
    if (
      !expected ||
      expected.year !== parts.year ||
      expected.month !== parts.month ||
      expected.day !== parts.day
    ) {
      return false;
    }
  }

  const times = mentionedTimes(clause);
  const appointmentTime = `${String(parts.hour).padStart(2, '0')}:${String(
    parts.minute
  ).padStart(2, '0')}`;
  if (times.length > 0 && !times.includes(appointmentTime)) {
    return false;
  }

  const dates = mentionedDates(clause);
  if (
    dates.length > 0 &&
    !dates.some(
      (date) =>
        date.day === parts.day &&
        (date.month === 0 || date.month === parts.month) &&
        (date.year === undefined || date.year === parts.year)
    )
  ) {
    return false;
  }

  const weekdays = [
    'domingo',
    'segunda',
    'terca',
    'quarta',
    'quinta',
    'sexta',
    'sabado',
  ].filter((weekday) => new RegExp(`\\b${weekday}\\b`).test(clause));
  if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) {
    return false;
  }

  const mentionedServices = allAppointments
    .map((item) => item.serviceName)
    .filter((name): name is string => Boolean(name))
    .filter((name) => clause.includes(normalizeClaimText(name)));
  if (
    mentionedServices.length > 0 &&
    (!appointment.serviceName ||
      !mentionedServices.includes(appointment.serviceName))
  ) {
    return false;
  }
  const rawClaimedService =
    clause.match(
      /\b(?:seu|sua)\s+(?!agendamento\b|horario\b|reserva\b)(.{2,80}?)\s+(?:esta|ta)\s+(?:agendad|marcad|confirmad|reservad)/
    )?.[1] ??
    clause.match(
      /\bagendamento\s+de\s+(.{2,80}?)\s+(?:esta|ta|foi|ficou)\s+(?:agendad|marcad|confirmad|reservad)/
    )?.[1] ??
    clause.match(
      /\b(?:retorno|atendimento|agendamento|horario)\s+de\s+(.{2,60}?)(?=\s+(?:com|para|pra|em|no|na|dia|as|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|[,?.!]|$)/
    )?.[1];
  let claimedService = rawClaimedService;
  if (claimedService) {
    // "Sua Limpeza de Pele com a Júlia está agendada" não torna
    // "Limpeza de Pele com a Júlia" o nome do serviço. Remove somente o sufixo
    // de um profissional autoritativamente conhecido; nomes de serviço que
    // contenham "com" continuam intactos.
    for (const item of allAppointments) {
      if (!item.professionalName) continue;
      const professional = normalizeClaimText(item.professionalName);
      for (const suffix of [
        ` com ${professional}`,
        ` com a ${professional}`,
        ` com o ${professional}`,
      ]) {
        if (claimedService.endsWith(suffix)) {
          claimedService = claimedService.slice(0, -suffix.length).trim();
          break;
        }
      }
    }
  }
  if (
    claimedService &&
    (!appointment.serviceName ||
      normalizeClaimText(claimedService) !==
        normalizeClaimText(appointment.serviceName))
  ) {
    return false;
  }

  const mentionedProfessionals = allAppointments
    .map((item) => item.professionalName)
    .filter((name): name is string => Boolean(name))
    .filter((name) => clause.includes(normalizeClaimText(name)));
  if (
    mentionedProfessionals.length > 0 &&
    (!appointment.professionalName ||
      !mentionedProfessionals.includes(appointment.professionalName))
  ) {
    return false;
  }
  if (
    /\bcom\s+(?:a|o)?\s*[a-z]/.test(clause) &&
    appointment.professionalName &&
    !clause.includes(normalizeClaimText(appointment.professionalName))
  ) {
    return false;
  }

  const groundingFacts = appointmentGroundingFacts(clause);
  const claimedFactServices = groundingFacts
    .filter((fact) => fact.startsWith('service:'))
    .map((fact) => fact.slice('service:'.length));
  if (
    claimedFactServices.length > 0 &&
    (!appointment.serviceName ||
      !claimedFactServices.includes(normalizeClaimText(appointment.serviceName)))
  ) {
    return false;
  }
  const claimedFactProfessionals = groundingFacts
    .filter((fact) => fact.startsWith('professional:'))
    .map((fact) => fact.slice('professional:'.length));
  if (
    claimedFactProfessionals.length > 0 &&
    (!appointment.professionalName ||
      !claimedFactProfessionals.includes(
        normalizeClaimText(appointment.professionalName)
      ))
  ) {
    return false;
  }

  return true;
}

function hasCompatibleAppointmentRead(
  clause: string,
  appointments: AuthoritativeAppointment[],
  temporalContext?: AppointmentTemporalContext
): boolean {
  const explicitCount = clause.match(
    /\b(?:tem|ha|existem?)\s+(dois|duas|2|tres|3)\s+agendamentos?\b/
  )?.[1];
  if (explicitCount) {
    const expectedCount = /^(?:dois|duas|2)$/.test(explicitCount) ? 2 : 3;
    if (appointments.length !== expectedCount) return false;
  }
  return appointments.some((appointment) =>
    appointmentMatchesStateClause(
      clause,
      appointment,
      appointments,
      temporalContext
    )
  );
}

function inspectCompletedClaims(
  reply: string,
  toolTrace: ToolTraceLike[],
  temporalContext?: AppointmentTemporalContext
): { hasUnlicensedClaim: boolean; needsAppointmentRead: boolean } {
  const normalized = normalizeClaimText(reply);
  if (!normalized) {
    return { hasUnlicensedClaim: false, needsAppointmentRead: false };
  }

  const successfulWrites = successfulWriteKinds(toolTrace);
  const appointments = parseSuccessfulAppointmentReads(toolTrace);
  const verifiedAvailabilitySlots = currentTurnAuthoritativeAvailabilitySlots(toolTrace);
  const clauses = normalized.match(/[^.!?\n]+[.!?]?/g) ?? [normalized];
  let needsAppointmentRead = false;

  for (const clauseValue of clauses) {
    const clause = clauseValue.trim();
    if (!clause || isPlainWriteStatusQuestion(clause)) continue;

    const isDirectStateReference =
      !clause.endsWith('?') &&
      (/\b(?:(?:seu|o|esse|este)\s+)?(?:agendamento|horario)\s+(?:e|eh|esta|ta|ficou)\s+(?:para|no|na|dia|as|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(
        clause
      ) ||
        /\bvoce\s+(?:ja\s+)?tem(?:\s+um)?\s+(?:agendamento|horario)\s+(?:para|no|na|dia|as)\b/.test(
          clause
        ));
    if (isDirectStateReference) {
      if (
        successfulWrites.has('book') ||
        hasCompatibleAppointmentRead(clause, appointments, temporalContext)
      ) {
        // A mesma oração ainda pode conter uma afirmação de ato; ela é
        // analisada abaixo e não herda a licença da leitura.
      } else {
        needsAppointmentRead = true;
      }
    }

    for (const match of clause.matchAll(COMPLETED_WRITE_CLAIM_RE)) {
      const matchIndex = match.index ?? 0;
      if (localClaimIsNegatedOrFuture(clause, matchIndex)) continue;

      const claim = match[0];
      if (
        isServicePerformanceDescription(
          clause,
          matchIndex,
          claim
        )
      ) {
        continue;
      }
      if (
        isVerifiedAvailabilityConfirmation(
          clause,
          matchIndex,
          claim,
          verifiedAvailabilitySlots
        )
      ) {
        continue;
      }
      if (isPresentAppointmentStateClaim(clause, matchIndex, claim)) {
        if (
          successfulWrites.has('book') ||
          hasCompatibleAppointmentRead(clause, appointments, temporalContext)
        ) {
          continue;
        }
        needsAppointmentRead = true;
        continue;
      }

      const requiredWrite = claimWriteKind(claim);
      if (!successfulWrites.has(requiredWrite)) {
        return { hasUnlicensedClaim: true, needsAppointmentRead };
      }
    }
  }

  return {
    hasUnlicensedClaim: needsAppointmentRead,
    needsAppointmentRead,
  };
}

/**
 * Barreira negativa dual à confirmação segura. Afirmação de ato exige
 * success:true da write correspondente. Descrição estrita de estado presente
 * ("está confirmado", "tem um horário marcado") pode ser licenciada por uma
 * leitura getUpcomingAppointments success:true cujo payload contenha um
 * agendamento compatível.
 *
 * Prosa do modelo e histórico nunca são evidência. Frases ambíguas como "foi
 * confirmado", "ficou marcado" ou "pronto, agendado" são atos. A assimetria
 * continua fail-closed: em dúvida, classifica como ato e bloqueia.
 */
export function hasFalseWriteClaim(
  reply: string,
  toolTrace: ToolTraceLike[],
  temporalContext?: AppointmentTemporalContext
): boolean {
  return inspectCompletedClaims(reply, toolTrace, temporalContext).hasUnlicensedClaim;
}

const EXPLICIT_EXISTING_APPOINTMENT_REFERENCE_RE =
  /\b(?:seu horario|seu agendamento|seu retorno|seu atendimento|seu procedimento|sua consulta|sua sessao|agendamento anterior|horario anterior|retorno anterior|atendimento anterior|procedimento anterior|consulta anterior|sessao anterior)\b/;
const EXISTING_APPOINTMENT_ACTION_RE =
  /\b(?:remarc\w*|reagend\w*|cancel\w*|desmarc\w*|adiar|adiou|antecip\w*)\b/;
const APPOINTMENT_SHIFT_RE =
  /\b(?:mud(?:ar|ou|anca|ando)|troc\w*|alter\w*|pass(?:ar|ou|ando)|transfer\w*|mover|moveu|jogar|jogou)\b/;
const SPECIFIC_APPOINTMENT_DETAIL_RE =
  /\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia\s+\d{1,2}(?:\/\d{1,2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:[01]?\d|2[0-3])(?::\d{2}|h(?:\d{2})?))\b/;
const APPOINTMENT_NOUN_RE =
  /\b(?:agendamento|horario|retorno|reserva|atendimento|procedimento|sessao|consulta)\b/;

function isExistingAppointmentContextClause(clause: string): boolean {
  if (EXPLICIT_EXISTING_APPOINTMENT_REFERENCE_RE.test(clause)) return true;
  // This is the canonical duplicate-preflight elicitor: it describes an
  // existing appointment without using "seu agendamento".  It still requires
  // an authoritative read below; this branch only classifies the sentence as
  // appointment context, never licenses it by itself.
  if (
    /\b(?:vi|notei|confirmei|encontrei)\s+que\s+(?:voce\s+)?(?:ja\s+)?tem\b[^.!?\n]{0,160}\b(?:agendamento|horario|reserva)\b/u.test(
      clause
    )
  ) {
    return true;
  }
  if (
    EXISTING_APPOINTMENT_ACTION_RE.test(clause) &&
    (APPOINTMENT_NOUN_RE.test(clause) || SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause))
  ) {
    return true;
  }
  if (
    APPOINTMENT_SHIFT_RE.test(clause) &&
    (APPOINTMENT_NOUN_RE.test(clause) || SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause))
  ) {
    return true;
  }
  if (
    /\b(?:so\s+)?confirm(?:a|ando|ar|acao)\b/.test(clause) &&
    (APPOINTMENT_NOUN_RE.test(clause) || SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause))
  ) {
    return true;
  }
  if (
    APPOINTMENT_NOUN_RE.test(clause) &&
    /\b(?:sera|vai ser|acontece|ocorre|esta|ta|ficou)\b/.test(clause) &&
    SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause)
  ) {
    return true;
  }
  if (
    /\b(?:te|lhe)\s+(?:recebe|atende)\b/.test(clause) &&
    (SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause) ||
      /\b(?:para|pra)\s+(?:a|o)\s+[a-z]/.test(clause))
  ) {
    return true;
  }
  const hasGroundableStateObject =
    APPOINTMENT_NOUN_RE.test(clause) ||
    SPECIFIC_APPOINTMENT_DETAIL_RE.test(clause) ||
    /\bcom\s+(?:a|o)\s+[a-z][a-z'-]+\b/.test(clause);
  if (!hasGroundableStateObject) return false;

  if (
    /\b(?:ficou|esta|ta)\s+(?:para|pra|com|no|na|as|dia|hoje|amanha)\b/.test(
      clause
    )
  ) {
    return true;
  }

  // "é" perde o acento na normalização. Só trate como estado quando inicia a
  // oração e há um objeto operacional concreto; a conjunção cotidiana
  // "Tudo bem sim, e com você?" não pode virar falso fato de agendamento.
  return /^(?:(?:sim|entao|certo|perfeito|ok|isso)[,]?\s+)?(?:e|eh)\s+(?:para|pra|com|no|na|as|dia|hoje|amanha)\b/.test(
    clause
  );
}

function appointmentGroundingFacts(value: string): string[] {
  const normalized = normalizeClaimText(value);
  const facts = new Set<string>();
  for (const match of normalized.matchAll(
    /\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia\s+\d{1,2}(?:\/\d{1,2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/g
  )) {
    facts.add(`date:${match[0]}`);
  }
  for (const match of normalized.matchAll(
    /\b([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\s+(?:te|lhe)\s+(?:recebe|atende)\b/g
  )) {
    const name = match[1]?.trim();
    if (
      name &&
      !/^(?:ela|ele|a equipe|o profissional|a profissional|a gente)$/.test(name)
    ) {
      facts.add(`professional:${name}`);
    }
  }
  for (const time of mentionedTimes(normalized)) {
    facts.add(`time:${time}`);
  }
  for (const match of normalized.matchAll(
    /\bcom\s+(?:a|o)?\s*([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)(?=\s+(?:para|pra|pro|no|na|dia|as)\b|[,?.!]|$)/g
  )) {
    const name = match[1]
      ?.replace(
        /\s+(?:agendad[oa]|marcad[oa]|confirmad[oa]|reservad[oa])$/,
        ''
      )
      .trim();
    if (
      name &&
      !/^(?:voce|vc|a equipe|o profissional|sucesso|seguranca|certeza)$/.test(
        name
      )
    ) {
      facts.add(`professional:${name}`);
    }
  }
  for (const match of normalized.matchAll(
    /\b(?:para|pra)\s+(?:a|o)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,5})(?=\s+(?:com|no|na|dia|as|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|[,?.!]|$)/g
  )) {
    const service = match[1]?.trim();
    if (
      service &&
      !/^(?:equipe|recepcao|estabelecimento|clinica|sala|data|hora)$/.test(
        service
      )
    ) {
      facts.add(`service:${service}`);
    }
  }
  for (const match of normalized.matchAll(
    /\b(?:retorno|atendimento|agendamento|horario)\s+de\s+(.{2,60}?)(?=\s+(?:com|para|pra|pro|em|no|na|dia|as|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|[,?.!]|$)/g
  )) {
    const service = match[1]?.trim();
    if (service) facts.add(`service:${service}`);
  }
  return [...facts];
}

function currentInboundGroundsAppointmentContext(
  clause: string,
  sourceInboundText?: string
): boolean {
  if (!sourceInboundText?.trim()) return false;
  const source = normalizeClaimText(sourceInboundText);
  const facts = appointmentGroundingFacts(clause);
  if (facts.length === 0) return isExistingAppointmentContextClause(source);
  const sourceFacts = new Set(appointmentGroundingFacts(source));
  if (!facts.every((fact) => sourceFacts.has(fact))) return false;
  return isExistingAppointmentContextClause(source);
}

function successfulWriteLicensesGenericAppointmentContext(
  clause: string,
  toolTrace: ToolTraceLike[]
): boolean {
  // Uma write só licencia o estado genérico que efetivamente produziu. Data,
  // hora, profissional ou serviço continuam exigindo fonte compatível; assim,
  // uma write de outro horário nunca autoriza detalhes inventados pelo modelo.
  if (appointmentGroundingFacts(clause).length > 0) return false;
  const writes = successfulWriteKinds(toolTrace);
  if (/\b(?:remarc\w*|reagend\w*)\b/.test(clause)) {
    return writes.has('reschedule');
  }
  if (/\bcancel\w*\b/.test(clause)) {
    return writes.has('cancel');
  }
  if (/\b(?:agend\w*|marcad\w*|confirmad\w*|reservad\w*)\b/.test(clause)) {
    return writes.has('book');
  }
  return false;
}

/**
 * Perguntas também podem vazar estado: "você quer remarcar ... com X amanhã às
 * Y?" introduz fatos operacionais mesmo terminando em `?`. Só uma leitura
 * compatível do turno atual (ou uma write concluída) licencia esse contexto.
 */
export function hasUnverifiedExistingAppointmentContext(
  reply: string,
  toolTrace: ToolTraceLike[],
  sourceInboundText?: string,
  temporalContext?: AppointmentTemporalContext
): boolean {
  const appointments = parseSuccessfulAppointmentReads(toolTrace);
  const normalized = normalizeClaimText(reply);
  const clauses = normalized.match(/[^.!?\n]+[.!?]?/g) ?? [normalized];

  return clauses.some((clauseValue) => {
    const clause = clauseValue.trim();
    if (!isExistingAppointmentContextClause(clause)) {
      return false;
    }
    return (
      !successfulWriteLicensesGenericAppointmentContext(clause, toolTrace) &&
      !currentInboundGroundsAppointmentContext(clause, sourceInboundText) &&
      !hasCompatibleAppointmentRead(clause, appointments, temporalContext)
    );
  });
}

/**
 * Permite que o caller faça uma única leitura autoritativa sob demanda antes
 * de descartar uma descrição de estado. Nunca pede leitura para licenciar ato.
 */
export function needsAuthoritativeAppointmentRead(
  reply: string,
  toolTrace: ToolTraceLike[],
  sourceInboundText?: string,
  temporalContext?: AppointmentTemporalContext
): boolean {
  return (
    inspectCompletedClaims(reply, toolTrace, temporalContext).needsAppointmentRead ||
    hasUnverifiedExistingAppointmentContext(
      reply,
      toolTrace,
      sourceInboundText,
      temporalContext
    )
  );
}

/**
 * Última barreira antes do WhatsApp. Prompt adherence não é segurança: se o
 * modelo copiar INTERNAL_HINT/ID técnico ou afirmar uma escrita sem success:true,
 * a resposta inteira é descartada e o caller envia o fallback neutro.
 */
export function inspectCustomerReply(
  reply: string,
  servicesResult: ServicesResult,
  forbiddenAppointmentIds: string[] = [],
  toolTrace: ToolTraceLike[] = [],
  sourceInboundText?: string,
  temporalContext?: AppointmentTemporalContext,
  additionalVerifiedSlots: readonly string[] = []
): CustomerReplyInspection {
  const reasons = new Set<CustomerReplyLeakReason>();
  if (/INTERNAL_HINT/i.test(reply)) {
    reasons.add('internal_hint');
  }
  if (hasFalseWriteClaim(reply, toolTrace, temporalContext)) {
    reasons.add('false_write_claim');
  }
  if (
    hasUnverifiedAvailabilityClaim(
      reply,
      toolTrace,
      additionalVerifiedSlots
    )
  ) {
    reasons.add('unverified_availability');
  }
  if (
    hasUnverifiedExistingAppointmentContext(
      reply,
      toolTrace,
      sourceInboundText,
      temporalContext
    )
  ) {
    reasons.add('unverified_appointment_context');
  }

  for (const service of servicesResult.services ?? []) {
    if (service.id && reply.includes(service.id)) {
      reasons.add('service_id');
      break;
    }
  }

  for (const professional of servicesResult.professionals ?? []) {
    if (professional.id && reply.includes(professional.id)) {
      reasons.add('professional_id');
      break;
    }
  }

  for (const appointmentId of forbiddenAppointmentIds) {
    if (appointmentId && reply.includes(appointmentId)) {
      reasons.add('appointment_id');
      break;
    }
  }

  const knownTechnicalIdFound =
    reasons.has('service_id') ||
    reasons.has('professional_id') ||
    reasons.has('appointment_id');
  if (
    !knownTechnicalIdFound &&
    /\b(?:c[a-z0-9]{19,31}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i.test(
      reply
    )
  ) {
    reasons.add('technical_id');
  }

  return {
    safe: reasons.size === 0,
    reasons: [...reasons],
  };
}

/**
 * Se o modelo vazar conteúdo interno DEPOIS de uma escrita bem-sucedida, nunca
 * diga ao cliente que houve erro. Deriva uma confirmação curta apenas do estado
 * das tools, sem ecoar IDs, argumentos ou texto não confiável do provider.
 */
export function buildSafeWriteConfirmation(
  toolTrace: ToolTraceLike[]
): string | null {
  const booked = toolTrace.some(
    (entry) => entry.name === 'bookAppointment' && toolSucceeded(entry.result)
  );
  const cancelled = toolTrace.some(
    (entry) => entry.name === 'cancelAppointment' && toolSucceeded(entry.result)
  );

  if (booked && cancelled) {
    return 'Tudo certo! O agendamento anterior foi cancelado e o novo foi confirmado com sucesso.';
  }
  if (booked) {
    return 'Tudo certo! Seu agendamento foi confirmado com sucesso.';
  }
  if (cancelled) {
    return 'Tudo certo! O agendamento anterior foi cancelado com sucesso.';
  }
  return null;
}

/**
 * Recuperação fail-safe para o caso em que uma escrita terminou, mas a chamada
 * seguinte ao provider falhou ou o loop esgotou as rodadas. O cliente recebe o
 * estado confirmado pelas tools em vez de uma falsa mensagem genérica de erro.
 */
export function buildSafeRecoveryReply(
  toolTrace: ToolTraceLike[],
  fallbackMessage: string
): string {
  return buildSafeWriteConfirmation(toolTrace) ?? fallbackMessage;
}
