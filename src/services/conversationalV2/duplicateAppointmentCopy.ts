/**
 * Shared server-owned prefix for the v2 duplicate-preflight elicitor.
 *
 * This module intentionally has no runtime dependencies on the guard or on
 * the booking planner.  Both the producer and the boundary can therefore
 * reconstruct the same appointment sentence without a circular import or a
 * second, subtly different date/time formatter.
 */
export function buildCanonicalDuplicateAppointmentContextV2(input: {
  serviceName: string;
  startTime: string;
  timezone: string;
}): string | null {
  const instant = new Date(input.startTime);
  if (Number.isNaN(instant.getTime()) || !input.serviceName.trim()) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  if (![year, month, day, hour, minute].every(Boolean)) return null;
  return `Vi que você já tem outro agendamento de ${input.serviceName.trim()} em ${day}/${month}/${year} às ${hour}:${minute}.`;
}
