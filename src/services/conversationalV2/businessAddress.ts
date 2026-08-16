import type {
  TenantBotConfig,
  TenantBusinessAddress,
  TenantDirectionsMode,
} from '../../configProvider';
import type { UpcomingAppointment } from '../calendarService';
import {
  findClauseMatchesV2,
  hasPositiveClauseMatchV2,
} from './polarity';
import { stripPowerZeroMetalinguisticAssignmentsV2 } from './powerZeroWitness';

export const BUSINESS_ADDRESS_FULL_COPY_ID_V2 = 'business_address_full' as const;
export const BUSINESS_ADDRESS_CITY_COPY_ID_V2 = 'business_address_city' as const;
export const BUSINESS_ADDRESS_AFTER_CONFIRMATION_COPY_ID_V2 =
  'business_address_after_confirmation' as const;

const CITY_TEAM_CONFIRMS_SENTENCE_V2 =
  'O endereço completo a equipe confirma com você no contato.';
const AFTER_CONFIRMATION_SENTENCE_V2 =
  'assim que seu agendamento estiver confirmado te passo o endereço completinho.';

const ADDRESS_QUESTION_RE =
  /\b(?:endereco|localizacao|onde\s+ficam?|onde\s+voces\s+ficam?|como\s+cheg(?:o|ar)|qual\s+(?:e\s+)?(?:o\s+)?local)\b/u;
const FOREIGN_ADDRESS_OBJECT_RE =
  /\b(?:site|instagram|facebook|e-?mail|email|whatsapp|link|perfil|pagina)\b/u;
const COURTESY_ACK_RE =
  /\b(?:muito\s+)?(?:obrigad[oa]|agradeco|valeu|vlw)\b/u;
const ADDITIONAL_OPERATIONAL_RE =
  /\b(?:tem\s+vaga|tem\s+horario|disponibilidade|agenda(?:r|mento)?|marcar|remarcar|cancelar|desmarcar|pagamento|pagar|pix|cartao|preco|valor|quanto\s+custa|profissional|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}(?::\d{2}|h\d{0,2})?|como\s+funciona|o\s+que\s+(?:e|eh)|me\s+(?:fala|fale|conta|conte))\b/u;
const STREET_CLAIM_RE =
  /\b(?:rua|avenida|av\.?|alameda|travessa|estrada|rodovia|praca|largo|viela)\b/u;
const LOCATION_LEAD_RE =
  /\b(?:estamos|ficamos|localizad[oa]s?)\s+(?:em|no|na|nos|nas)\b|\b(?:nosso\s+endereco|o\s+endereco(?:\s+completo)?)\s+(?:e|eh|fica|fica\s+em|e\s+em)\b/u;
const CEP_DIGITS_RE = /\b(\d{5}-?\d{3})\b/gu;
const INACTIVE_UPCOMING_STATUS_RE =
  /^(?:cancelled|canceled|cancelado|cancelada|no[_-]?show|faltou|completed|concluido|concluida)$/u;

const DIRECTIONS_MODES = new Set<TenantDirectionsMode>([
  'ENDERECO_COMPLETO',
  'SO_CIDADE',
  'APOS_CONFIRMACAO',
]);

export type BusinessAddressCopyKindV2 =
  | typeof BUSINESS_ADDRESS_FULL_COPY_ID_V2
  | typeof BUSINESS_ADDRESS_CITY_COPY_ID_V2
  | typeof BUSINESS_ADDRESS_AFTER_CONFIRMATION_COPY_ID_V2;

export type BusinessAddressDecisionV2 =
  | { kind: 'none'; reason: string }
  | {
      kind: 'answer';
      copyKind: BusinessAddressCopyKindV2;
      text: string;
      mode: TenantDirectionsMode;
    };

export interface BusinessAddressPlanV2 {
  decision: BusinessAddressDecisionV2;
  requiresOperationalContinuation: boolean;
  hasCourtesyAcknowledgement: boolean;
  upcomingReadRaw?: string;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function presentField(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * O ERP sempre envia o objeto `businessAddress` (campos null quando não há
 * cadastro). Só `full` ou `city` não-vazios após trim tornam o payload
 * utilizável: sem isso o fast-path e o UNKNOWN_ADDRESS ficam desarmados.
 */
export function isUsableBusinessAddressV2(
  address: TenantBusinessAddress | null | undefined
): address is TenantBusinessAddress {
  if (!address) return false;
  return presentField(address.full) !== null || presentField(address.city) !== null;
}

export function resolveDirectionsModeV2(
  config: Pick<TenantBotConfig, 'directionsMode'>
): TenantDirectionsMode {
  const mode = config.directionsMode;
  return mode && DIRECTIONS_MODES.has(mode) ? mode : 'SO_CIDADE';
}

export function matchBusinessAddressQuestionV2(value: string): {
  matched: boolean;
  requiresOperationalContinuation: boolean;
  hasCourtesyAcknowledgement: boolean;
} {
  const witnessed = stripPowerZeroMetalinguisticAssignmentsV2(value);
  const matched = findClauseMatchesV2(witnessed, ADDRESS_QUESTION_RE).some(
    (entry) => entry.positive && !FOREIGN_ADDRESS_OBJECT_RE.test(entry.clause)
  );
  return {
    matched,
    requiresOperationalContinuation: ADDITIONAL_OPERATIONAL_RE.test(
      normalize(witnessed)
    ),
    hasCourtesyAcknowledgement: COURTESY_ACK_RE.test(normalize(witnessed)),
  };
}

function joinCityState(address: TenantBusinessAddress): string | null {
  const city = presentField(address.city);
  const state = presentField(address.state);
  if (city && state) return `${city} - ${state}`;
  return city;
}

export function materializeFullBusinessAddressCopyV2(
  address: TenantBusinessAddress
): string | null {
  const full = presentField(address.full);
  if (!full) return null;
  let body = full;
  const cityState = joinCityState(address);
  if (cityState) body += `, ${cityState}`;
  const zip = presentField(address.zipCode);
  if (zip) body += `, CEP ${zip}`;
  return `Estamos em ${body}.`;
}

export function materializeCityBusinessAddressCopyV2(
  address: TenantBusinessAddress
): string | null {
  const cityState = joinCityState(address);
  if (!cityState) return null;
  return `Estamos em ${cityState}. ${CITY_TEAM_CONFIRMS_SENTENCE_V2}`;
}

export function materializeAfterConfirmationBusinessAddressCopyV2(
  address: TenantBusinessAddress
): string | null {
  const cityCopy = materializeCityBusinessAddressCopyV2(address);
  if (!cityCopy) return null;
  return `${cityCopy} ${AFTER_CONFIRMATION_SENTENCE_V2}`;
}

function isActiveFutureAppointmentV2(
  appointment: UpcomingAppointment,
  now: Date
): boolean {
  const start = Date.parse(appointment.startTime);
  if (!Number.isFinite(start) || start <= now.getTime()) return false;
  const status = normalize(String(appointment.status ?? ''));
  return !INACTIVE_UPCOMING_STATUS_RE.test(status);
}

function parseUpcomingReadV2(
  raw: string,
  now: Date
): { kind: 'appointments'; appointments: UpcomingAppointment[] } | { kind: 'none' } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.reason === 'customer_identity_ambiguous' ||
      parsed.reason === 'customer_identity_mismatch'
    ) {
      return { kind: 'none' };
    }
    if (parsed.success !== true || !Array.isArray(parsed.appointments)) {
      return { kind: 'none' };
    }
    const appointments = parsed.appointments.filter(
      (entry): entry is UpcomingAppointment =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as UpcomingAppointment).startTime === 'string'
    );
    return {
      kind: 'appointments',
      appointments: appointments.filter((appointment) =>
        isActiveFutureAppointmentV2(appointment, now)
      ),
    };
  } catch {
    return { kind: 'none' };
  }
}

export async function resolveBusinessAddressPlanV2(input: {
  inboundText: string;
  config: TenantBotConfig;
  now: Date;
  executeUpcomingRead: () => Promise<string>;
}): Promise<BusinessAddressPlanV2> {
  const match = matchBusinessAddressQuestionV2(input.inboundText);
  const empty: BusinessAddressPlanV2 = {
    decision: { kind: 'none', reason: 'no_address_question' },
    requiresOperationalContinuation: match.requiresOperationalContinuation,
    hasCourtesyAcknowledgement: match.hasCourtesyAcknowledgement,
  };
  if (!match.matched) return empty;

  const address = input.config.businessAddress;
  if (!isUsableBusinessAddressV2(address)) {
    return {
      ...empty,
      decision: { kind: 'none', reason: 'business_address_absent' },
    };
  }

  const mode = resolveDirectionsModeV2(input.config);
  if (mode === 'ENDERECO_COMPLETO') {
    const text = materializeFullBusinessAddressCopyV2(address);
    return {
      ...empty,
      decision: text
        ? { kind: 'answer', copyKind: BUSINESS_ADDRESS_FULL_COPY_ID_V2, text, mode }
        : { kind: 'none', reason: 'full_address_missing' },
    };
  }

  if (mode === 'SO_CIDADE') {
    const text = materializeCityBusinessAddressCopyV2(address);
    return {
      ...empty,
      decision: text
        ? { kind: 'answer', copyKind: BUSINESS_ADDRESS_CITY_COPY_ID_V2, text, mode }
        : { kind: 'none', reason: 'city_missing' },
    };
  }

  let upcomingReadRaw = '';
  try {
    upcomingReadRaw = await input.executeUpcomingRead();
  } catch {
    upcomingReadRaw = JSON.stringify({ success: false, reason: 'executor_error' });
  }
  const upcoming = parseUpcomingReadV2(upcomingReadRaw, input.now);
  const hasUpcoming =
    upcoming.kind === 'appointments' && upcoming.appointments.length > 0;
  if (hasUpcoming) {
    const text = materializeFullBusinessAddressCopyV2(address);
    return {
      ...empty,
      upcomingReadRaw,
      decision: text
        ? { kind: 'answer', copyKind: BUSINESS_ADDRESS_FULL_COPY_ID_V2, text, mode }
        : { kind: 'none', reason: 'full_address_missing' },
    };
  }
  const text = materializeAfterConfirmationBusinessAddressCopyV2(address);
  return {
    ...empty,
    upcomingReadRaw,
    decision: text
      ? {
          kind: 'answer',
          copyKind: BUSINESS_ADDRESS_AFTER_CONFIRMATION_COPY_ID_V2,
          text,
          mode,
        }
      : { kind: 'none', reason: 'city_missing' },
  };
}

export function canonicalBusinessAddressCopiesV2(
  address: TenantBusinessAddress | null | undefined
): string[] {
  if (!address) return [];
  return [
    materializeAfterConfirmationBusinessAddressCopyV2(address),
    materializeFullBusinessAddressCopyV2(address),
    materializeCityBusinessAddressCopyV2(address),
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
}

/** Remove a copy canônica para o restante seguir os guards operacionais. */
export function stripCanonicalBusinessAddressCopyV2(
  text: string,
  address: TenantBusinessAddress | null | undefined
): string {
  const copies = canonicalBusinessAddressCopiesV2(address);
  if (copies.length === 0) return text;
  for (const copy of copies) {
    const index = text.indexOf(copy);
    if (index < 0) continue;
    return `${text.slice(0, index)}${text.slice(index + copy.length)}`
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }
  return text;
}

export function composeBusinessAddressComponentV2(input: {
  baseText?: string | null;
  componentText: string;
  courtesyAcknowledgement?: boolean;
  socialGreeting?: string | null;
}): string {
  const parts: string[] = [];
  const greeting = input.socialGreeting?.trim();
  if (greeting) parts.push(greeting);
  const base = input.baseText?.trim();
  if (base && !parts.some((part) => part.includes(base))) parts.push(base);
  if (!base && !greeting && input.courtesyAcknowledgement) parts.push('Imagina!');
  const component = input.componentText.trim();
  if (component && !parts.some((part) => part.includes(component))) {
    parts.push(component);
  }
  return parts.join('\n\n');
}

export function businessAddressModelInstructionV2(): string {
  return (
    'COMPONENTE DE ENDEREÇO SERVER-OWNED: responda somente aos outros ' +
    'componentes do lote. Não informe, resuma nem invente endereço, cidade, ' +
    'UF, CEP ou como chegar; o servidor anexará a copy canônica depois da ' +
    'sua resposta.'
  );
}

function zipDigits(value: string): string {
  return value.replace(/\D/gu, '');
}

function licensedAddressTokensV2(address: TenantBusinessAddress): string[] {
  return [address.full, address.city, address.state, address.zipCode]
    .flatMap((value) => {
      const present = presentField(value);
      return present ? [normalize(present)] : [];
    })
    .sort((left, right) => right.length - left.length);
}

function clauseHasUnlicensedAddressClaimV2(
  clause: string,
  address: TenantBusinessAddress
): boolean {
  const normalized = normalize(clause);
  if (!STREET_CLAIM_RE.test(normalized) && !LOCATION_LEAD_RE.test(normalized)) {
    return false;
  }
  let remainder = normalized;
  for (const token of licensedAddressTokensV2(address)) {
    remainder = remainder.split(token).join(' ');
  }
  const zip = presentField(address.zipCode);
  if (zip) {
    const digits = zipDigits(zip);
    remainder = remainder.replace(new RegExp(digits, 'gu'), ' ');
    if (digits.length === 8) {
      remainder = remainder.replace(
        new RegExp(`${digits.slice(0, 5)}-${digits.slice(5)}`, 'gu'),
        ' '
      );
    }
  }
  remainder = remainder
    .replace(
      /\b(?:estamos|ficamos|em|no|na|nos|nas|de|do|da|dos|das|e|cep|endereco|completo|equipe|confirma|com|voce|contato|localizad[oa]s?|av)\b/gu,
      ' '
    )
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return remainder.length > 0;
}

function addressClaimWindowsV2(text: string): string[] {
  return normalize(text)
    .split(/[.!?;:\n]+/u)
    .map((window) => window.trim())
    .filter(Boolean);
}

export function hasUnlicensedBusinessAddressClaimV2(
  text: string,
  address: TenantBusinessAddress | null | undefined
): boolean {
  if (!isUsableBusinessAddressV2(address)) return false;
  const licensedZip = presentField(address.zipCode)
    ? zipDigits(address.zipCode as string)
    : '';
  for (const match of text.matchAll(new RegExp(CEP_DIGITS_RE.source, 'gu'))) {
    const digits = zipDigits(match[1] ?? '');
    if (!licensedZip || digits !== licensedZip) return true;
  }
  return addressClaimWindowsV2(text).some((window) =>
    clauseHasUnlicensedAddressClaimV2(window, address)
  );
}

export const __businessAddressMatchersForSmokeV2 = {
  ADDRESS_QUESTION_RE,
  FOREIGN_ADDRESS_OBJECT_RE,
  STREET_CLAIM_RE,
  LOCATION_LEAD_RE,
  normalize,
  hasPositiveClauseMatchV2,
};
