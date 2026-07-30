import type { ServicesResult } from './calendarService';

export type CustomerReplyLeakReason =
  | 'internal_hint'
  | 'service_id'
  | 'professional_id'
  | 'appointment_id'
  | 'technical_id'
  | 'false_write_claim';

export interface CustomerReplyInspection {
  safe: boolean;
  reasons: CustomerReplyLeakReason[];
}

export type ToolTraceLike = {
  name: string;
  result: string;
};

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

/**
 * Normalização mecânica e conservadora para WhatsApp. Não resume nem corta
 * conteúdo operacional: remove apenas sintaxe Markdown/list markers e limita
 * a resposta a um emoji, mesmo quando o modelo ignora a instrução de estilo.
 */
export function normalizeCustomerReplyStyle(reply: string): string {
  let emojiSeen = false;
  return reply
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
  for (const entry of toolTrace) {
    if (entry.name !== 'getUpcomingAppointments') continue;
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
    /^\s+(?:por|pelo|pela)\b/.test(afterClaim) &&
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
  const isFutureOrConditional =
    /(?:\b(?:vou|vamos|iremos|vai|vao|sera|serao|estara|estarao|ficara|ficarao|ficaria|ficariam|poderia|poderiam|posso|podemos|pretendo)\b(?:\s+\w+){0,6}|\b(?:assim que|quando|caso|depois que|se)\b(?:\s+\w+){0,8})\s*$/.test(
      localPrefix
    );

  return isNegated || isFutureOrConditional;
}

function appointmentLocalParts(startTime: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
} | null {
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
  return [...times];
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

function appointmentMatchesStateClause(
  clause: string,
  appointment: AuthoritativeAppointment,
  allAppointments: AuthoritativeAppointment[]
): boolean {
  if (
    appointment.status &&
    /cancel|reject|no_show|deleted/i.test(appointment.status)
  ) {
    return false;
  }
  if (
    /\bconfirmad[oa]s?\b/.test(clause) &&
    appointment.status &&
    !/confirm|scheduled|booked/i.test(appointment.status)
  ) {
    return false;
  }

  const parts = appointmentLocalParts(appointment.startTime);
  if (!parts) return false;

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

  return true;
}

function hasCompatibleAppointmentRead(
  clause: string,
  appointments: AuthoritativeAppointment[]
): boolean {
  const explicitCount = clause.match(
    /\b(?:tem|ha|existem?)\s+(dois|duas|2|tres|3)\s+agendamentos?\b/
  )?.[1];
  if (explicitCount) {
    const expectedCount = /^(?:dois|duas|2)$/.test(explicitCount) ? 2 : 3;
    if (appointments.length !== expectedCount) return false;
  }
  return appointments.some((appointment) =>
    appointmentMatchesStateClause(clause, appointment, appointments)
  );
}

function inspectCompletedClaims(
  reply: string,
  toolTrace: ToolTraceLike[]
): { hasUnlicensedClaim: boolean; needsAppointmentRead: boolean } {
  const normalized = normalizeClaimText(reply);
  if (!normalized) {
    return { hasUnlicensedClaim: false, needsAppointmentRead: false };
  }

  const successfulWrites = successfulWriteKinds(toolTrace);
  const appointments = parseSuccessfulAppointmentReads(toolTrace);
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
        hasCompatibleAppointmentRead(clause, appointments)
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
      if (isPresentAppointmentStateClaim(clause, matchIndex, claim)) {
        if (
          successfulWrites.has('book') ||
          hasCompatibleAppointmentRead(clause, appointments)
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
  toolTrace: ToolTraceLike[]
): boolean {
  return inspectCompletedClaims(reply, toolTrace).hasUnlicensedClaim;
}

/**
 * Permite que o caller faça uma única leitura autoritativa sob demanda antes
 * de descartar uma descrição de estado. Nunca pede leitura para licenciar ato.
 */
export function needsAuthoritativeAppointmentRead(
  reply: string,
  toolTrace: ToolTraceLike[]
): boolean {
  return inspectCompletedClaims(reply, toolTrace).needsAppointmentRead;
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
  toolTrace: ToolTraceLike[] = []
): CustomerReplyInspection {
  const reasons = new Set<CustomerReplyLeakReason>();
  if (/INTERNAL_HINT/i.test(reply)) {
    reasons.add('internal_hint');
  }
  if (hasFalseWriteClaim(reply, toolTrace)) {
    reasons.add('false_write_claim');
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
