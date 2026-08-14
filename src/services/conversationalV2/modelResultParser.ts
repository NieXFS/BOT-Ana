import type { ToolTraceLike } from '../customerReplyGuard';
import {
  ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  resolveUniqueCatalogEntityFromCurrentMessage,
  type CatalogEntityResolution,
} from '../service-gate';
import {
  FLAT_NEXT_PENDING_V2,
  type FlatModelTurnV2,
  type FlatNextPendingV2,
  type InboundSpanV2,
  type ModelReplyPurposeV2,
  type ModelTurnResultV2,
  type PendingTransitionCandidate,
  type ResolutionCandidate,
  type ResolutionProof,
  type TurnFrameV2,
  type UnknownServiceEvidenceV2,
} from './contracts';
import {
  clauseMatchHasPositivePolarityV2,
  normalizeClauseTextV2,
  splitClausesV2,
} from './polarity';
import { normalizeTemporalAssertionsV2 } from './temporalNormalizer';

export const PENDING_FAST_PATH_MAX_AGE_MS = 4 * 60 * 60 * 1_000;

export interface CatalogEntityReferenceV2 {
  id: string;
  displayName: string;
  professionalIds?: readonly string[];
}

export interface ModelResultToolTraceV2 extends ToolTraceLike {
  args?: Readonly<Record<string, unknown>>;
  round?: number;
}

export interface ModelResultValidationContextV2 {
  frame: TurnFrameV2;
  inboundTextsById: Readonly<Record<string, string>>;
  catalogEntities: {
    services: readonly CatalogEntityReferenceV2[];
    professionals: readonly CatalogEntityReferenceV2[];
  };
  now: Date;
  proofVersion?: number;
  toolTrace?: readonly ModelResultToolTraceV2[];
}

export type ModelResultValidationCodeV2 =
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'EXTRA_FIELD'
  | 'MISSING_FIELD'
  | 'INVALID_ENUM'
  | 'INVALID_VALUE'
  | 'TRUNCATED_OUTPUT';

export type ResolutionProofRejectionCodeV2 =
  | 'CATALOG_ENTITY_TEXT_NOT_CURRENT'
  | 'CATALOG_ENTITY_NOT_EVIDENCED'
  | 'CATALOG_ENTITY_AMBIGUOUS'
  | 'CATALOG_ENTITY_SUPERSEDED';

export interface ModelResultValidationIssueV2 {
  code: ModelResultValidationCodeV2;
  path: string;
}

export interface ResolutionProofRejectionV2 {
  code: ResolutionProofRejectionCodeV2;
  path: '$.chosenOptionText';
}

export type ModelTurnResultV2ParseResult =
  | {
      ok: true;
      value: ModelTurnResultV2;
      /** Ausente apenas para fast-path/reducer/fallbacks server-owned. */
      flatValue?: FlatModelTurnV2;
      resolutionProof: ResolutionProof | null;
      resolutionProofRejections: ResolutionProofRejectionV2[];
    }
  | { ok: false; issues: ModelResultValidationIssueV2[] };

type UnknownRecord = Record<string, unknown>;

export type ModelTurnResultV2UnwrapResult =
  | {
      ok: true;
      json: string;
      kind: 'plain_json' | 'markdown_fence' | 'single_object_with_prefix';
    }
  | { ok: false };

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function balancedTopLevelObjectEnd(value: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function normalizeInertContractMarker(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (parsed.contract === 'FlatModelTurnV2') {
      const { contract: _contract, ...withoutMarker } = parsed;
      return JSON.stringify(withoutMarker);
    }
    return value;
  } catch {
    return null;
  }
}

/** Desembrulho mecânico; nunca relaxa o parser de shape. */
export function unwrapModelTurnResultV2Json(
  raw: string
): ModelTurnResultV2UnwrapResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };
  const plain = normalizeInertContractMarker(trimmed);
  if (plain !== null) {
    return { ok: true, json: plain, kind: 'plain_json' };
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced) {
    const body = fenced[1]!.trim();
    const normalized = normalizeInertContractMarker(body);
    if (normalized !== null) {
      return { ok: true, json: normalized, kind: 'markdown_fence' };
    }
  }
  const start = trimmed.indexOf('{');
  if (start < 0) return { ok: false };
  const end = balancedTopLevelObjectEnd(trimmed, start);
  if (end === null) return { ok: false };
  const prefix = trimmed.slice(0, start);
  const suffix = trimmed.slice(end);
  const prefixWithoutFence = prefix.replace(/```(?:json)?\s*$/iu, '').trim();
  const suffixWithoutFence = suffix.replace(/^\s*```\s*$/iu, '').trim();
  if (
    prefixWithoutFence.length > 240 ||
    /[{}\[\]]/u.test(prefixWithoutFence) ||
    suffixWithoutFence.length > 0
  ) {
    return { ok: false };
  }
  const json = trimmed.slice(start, end);
  const normalized = normalizeInertContractMarker(json);
  return normalized !== null
    ? { ok: true, json: normalized, kind: 'single_object_with_prefix' }
    : { ok: false };
}

function validateExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  issues: ModelResultValidationIssueV2[]
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ code: 'EXTRA_FIELD', path: `$.${key}` });
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({ code: 'MISSING_FIELD', path: `$.${key}` });
    }
  }
}

function nullableEvidenceText(
  value: unknown,
  path: string,
  issues: ModelResultValidationIssueV2[]
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 512) {
    issues.push({ code: 'INVALID_VALUE', path });
    return undefined;
  }
  return value;
}

function parseFlatEnvelope(
  raw: string
): { ok: true; value: FlatModelTurnV2 } | { ok: false; issues: ModelResultValidationIssueV2[] } {
  const unwrapped = unwrapModelTurnResultV2Json(raw);
  if (!unwrapped.ok) {
    return { ok: false, issues: [{ code: 'INVALID_JSON', path: '$' }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped.json);
  } catch {
    return { ok: false, issues: [{ code: 'INVALID_JSON', path: '$' }] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issues: [{ code: 'INVALID_SHAPE', path: '$' }] };
  }
  const issues: ModelResultValidationIssueV2[] = [];
  validateExactKeys(
    parsed,
    ['reply', 'nextPending', 'chosenOptionText', 'unknownServiceText'],
    issues
  );
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
    issues.push({ code: 'INVALID_VALUE', path: '$.reply' });
  }
  if (
    typeof parsed.nextPending !== 'string' ||
    !FLAT_NEXT_PENDING_V2.includes(parsed.nextPending as FlatNextPendingV2)
  ) {
    issues.push({ code: 'INVALID_ENUM', path: '$.nextPending' });
  }
  const chosenOptionText = nullableEvidenceText(
    parsed.chosenOptionText,
    '$.chosenOptionText',
    issues
  );
  const unknownServiceText = nullableEvidenceText(
    parsed.unknownServiceText,
    '$.unknownServiceText',
    issues
  );
  if (
    issues.length > 0 ||
    typeof parsed.reply !== 'string' ||
    typeof parsed.nextPending !== 'string' ||
    !FLAT_NEXT_PENDING_V2.includes(parsed.nextPending as FlatNextPendingV2) ||
    chosenOptionText === undefined ||
    unknownServiceText === undefined
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      reply: parsed.reply,
      nextPending: parsed.nextPending as FlatNextPendingV2,
      chosenOptionText,
      unknownServiceText,
    },
  };
}

interface NormalizedCodePointMapV2 {
  text: string;
  starts: number[];
  ends: number[];
}

/** Normalização com mapa reversível para offsets do inbound original. */
export function normalizeWithCodePointMapV2(value: string): NormalizedCodePointMapV2 {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const points = Array.from(value);
  let pendingSpaceStart: number | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const folded = points[index]!
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase();
    for (const char of Array.from(folded)) {
      if (/[a-z0-9]/u.test(char)) {
        if (pendingSpaceStart !== null && out.length > 0) {
          out.push(' ');
          starts.push(pendingSpaceStart);
          ends.push(index);
        }
        pendingSpaceStart = null;
        out.push(char);
        starts.push(index);
        ends.push(index + 1);
      } else if (out.length > 0 && pendingSpaceStart === null) {
        pendingSpaceStart = index;
      }
    }
  }
  return { text: out.join(''), starts, ends };
}

export function codePointSliceV2(value: string, start: number, end: number): string | null {
  const points = Array.from(value);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > points.length) {
    return null;
  }
  return points.slice(start, end).join('');
}

export function validateInboundSpanV2(
  span: InboundSpanV2,
  frame: TurnFrameV2,
  inboundTextsById: Readonly<Record<string, string>>
): { ok: true; text: string } | { ok: false; code: 'UNKNOWN_INBOUND_ID' | 'INVALID_SPAN' } {
  if (!frame.currentInboundIds.includes(span.inboundId) || typeof inboundTextsById[span.inboundId] !== 'string') {
    return { ok: false, code: 'UNKNOWN_INBOUND_ID' };
  }
  const text = codePointSliceV2(inboundTextsById[span.inboundId]!, span.start, span.end);
  return text === null ? { ok: false, code: 'INVALID_SPAN' } : { ok: true, text };
}

function locateTextInCurrentInbounds(
  needle: string,
  context: ModelResultValidationContextV2
): InboundSpanV2[] {
  const normalizedNeedle = normalizeWithCodePointMapV2(needle).text;
  if (!normalizedNeedle) return [];
  const spans: InboundSpanV2[] = [];
  for (const inboundId of context.frame.currentInboundIds) {
    const inbound = context.inboundTextsById[inboundId];
    if (typeof inbound !== 'string') continue;
    const mapped = normalizeWithCodePointMapV2(inbound);
    let from = 0;
    while (from <= mapped.text.length - normalizedNeedle.length) {
      const index = mapped.text.indexOf(normalizedNeedle, from);
      if (index < 0) break;
      const before = index === 0 ? ' ' : mapped.text[index - 1]!;
      const afterIndex = index + normalizedNeedle.length;
      const after = afterIndex >= mapped.text.length ? ' ' : mapped.text[afterIndex]!;
      if (before === ' ' && after === ' ') {
        spans.push({
          inboundId,
          start: mapped.starts[index]!,
          end: mapped.ends[afterIndex - 1]!,
        });
      }
      from = index + Math.max(1, normalizedNeedle.length);
    }
  }
  return spans;
}

type TypedEntity = CatalogEntityReferenceV2 & {
  kind: 'service' | 'professional';
  name: string;
};

function typedEntities(context: ModelResultValidationContextV2): TypedEntity[] {
  return [
    ...context.catalogEntities.services.map((entry) => ({ ...entry, name: entry.displayName, kind: 'service' as const })),
    ...context.catalogEntities.professionals.map((entry) => ({ ...entry, name: entry.displayName, kind: 'professional' as const })),
  ];
}

function normalizedName(value: string): string {
  return normalizeWithCodePointMapV2(value).text;
}

/** K2: nome-pai exato continua ambíguo quando é prefixo próprio de outro. */
function resolveV2CatalogText(
  text: string,
  entities: readonly TypedEntity[]
): CatalogEntityResolution {
  const normalized = normalizedName(text);
  const properPrefixIds = entities
    .filter((entry) => {
      const name = normalizedName(entry.displayName);
      return name === normalized || name.startsWith(`${normalized} `);
    })
    .map((entry) => entry.id);
  if (properPrefixIds.length > 1 && entities.some((entry) => normalizedName(entry.displayName) === normalized)) {
    return { kind: 'ambiguous', entityIds: [...new Set(properPrefixIds)] };
  }
  return resolveUniqueCatalogEntityFromCurrentMessage(text, [...entities], {
    allowRestrictedDistanceTwo:
      ENABLE_RESTRICTED_DISTANCE_TWO_CATALOG_MATCH,
  });
}

function earliestEntityMentionIndex(
  clause: string,
  resolution: CatalogEntityResolution,
  entities: readonly TypedEntity[]
): number {
  const normalized = normalizeClauseTextV2(clause);
  const ids = resolution.kind === 'resolved' ? [resolution.entity.id] : resolution.kind === 'ambiguous' ? resolution.entityIds : [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const entity = entities.find((entry) => entry.id === id);
    if (!entity) continue;
    const full = normalized.indexOf(normalizedName(entity.displayName));
    if (full >= 0) earliest = Math.min(earliest, full);
  }
  if (Number.isFinite(earliest)) return earliest;
  for (const match of normalized.matchAll(/\b[a-z0-9]+\b/gu)) {
    const tokenResolution = resolveV2CatalogText(match[0], entities);
    if (
      tokenResolution.kind === 'resolved' &&
      ids.includes(tokenResolution.entity.id)
    ) {
      return match.index ?? 0;
    }
  }
  return 0;
}

function positiveResolutionForFamily(
  context: ModelResultValidationContextV2,
  kind: 'service' | 'professional'
): CatalogEntityResolution | null {
  const entities = typedEntities(context).filter((entry) => entry.kind === kind);
  let latest: CatalogEntityResolution | null = null;
  const conflictingIds = new Set<string>();
  for (const inboundId of context.frame.currentInboundIds) {
    const inbound = context.inboundTextsById[inboundId];
    if (typeof inbound !== 'string') continue;
    const correctionInbound = /\b(?:na\s+verdade|corrigindo|quis\s+dizer|melhor|agora\s+quero|trocar|troca|mudar|nao\s*,?\s*(?:pera|perai))\b/iu.test(
      normalizeClauseTextV2(inbound)
    );
    for (const clause of splitClausesV2(inbound)) {
      const resolution = resolveV2CatalogText(clause, entities);
      if (resolution.kind === 'no_match') continue;
      const index = earliestEntityMentionIndex(clause, resolution, entities);
      if (!clauseMatchHasPositivePolarityV2(clause, index)) continue;
      if (
        latest?.kind === 'resolved' &&
        resolution.kind === 'resolved' &&
        latest.entity.id !== resolution.entity.id
      ) {
        if (correctionInbound) {
          conflictingIds.clear();
          latest = resolution;
          continue;
        }
        conflictingIds.add(latest.entity.id);
        conflictingIds.add(resolution.entity.id);
        latest = { kind: 'ambiguous', entityIds: [...conflictingIds] };
        continue;
      }
      if (latest?.kind === 'ambiguous' && resolution.kind === 'resolved') {
        if (correctionInbound) {
          conflictingIds.clear();
          latest = resolution;
        } else {
          resolution.kind === 'resolved' && conflictingIds.add(resolution.entity.id);
          latest = {
            kind: 'ambiguous',
            entityIds: [
              ...new Set([
                ...latest.entityIds,
                ...conflictingIds,
              ]),
            ],
          };
        }
        continue;
      }
      latest = resolution;
    }
  }
  return latest;
}

function spanHasPositivePolarity(
  span: InboundSpanV2,
  context: ModelResultValidationContextV2
): boolean {
  const inbound = context.inboundTextsById[span.inboundId];
  if (typeof inbound !== 'string') return false;
  const prefix = Array.from(inbound).slice(0, span.start).join('');
  const marker = 'zzspanevidence';
  const clauses = splitClausesV2(`${prefix} ${marker}`);
  const containingClause = clauses.find((clause) => clause.includes(marker));
  if (!containingClause) return false;
  const index = containingClause.indexOf(marker);
  return clauseMatchHasPositivePolarityV2(containingClause, index);
}

function translateChosenOption(
  text: string | null,
  context: ModelResultValidationContextV2,
  rejections: ResolutionProofRejectionV2[]
): { candidate: ResolutionCandidate; proof: ResolutionProof | null } {
  if (text === null) return { candidate: null, proof: null };
  const spans = locateTextInCurrentInbounds(text, context);
  const positiveSpans = spans.filter((span) =>
    spanHasPositivePolarity(span, context)
  );
  if (positiveSpans.length === 0) {
    rejections.push({ code: 'CATALOG_ENTITY_TEXT_NOT_CURRENT', path: '$.chosenOptionText' });
    return { candidate: null, proof: null };
  }
  const entities = typedEntities(context);
  const resolution = resolveV2CatalogText(text, entities);
  if (resolution.kind === 'ambiguous') {
    rejections.push({ code: 'CATALOG_ENTITY_AMBIGUOUS', path: '$.chosenOptionText' });
    return { candidate: null, proof: null };
  }
  if (resolution.kind === 'no_match') {
    rejections.push({ code: 'CATALOG_ENTITY_NOT_EVIDENCED', path: '$.chosenOptionText' });
    return { candidate: null, proof: null };
  }
  const typed = entities.find((entry) => entry.id === resolution.entity.id)!;
  const fullResolution = positiveResolutionForFamily(context, typed.kind);
  if (
    !fullResolution ||
    fullResolution.kind !== 'resolved' ||
    fullResolution.entity.id !== typed.id
  ) {
    rejections.push({
      code: fullResolution?.kind === 'ambiguous'
        ? 'CATALOG_ENTITY_AMBIGUOUS'
        : 'CATALOG_ENTITY_SUPERSEDED',
      path: '$.chosenOptionText',
    });
    return { candidate: null, proof: null };
  }
  const span = positiveSpans.at(-1)!;
  const candidate: ResolutionCandidate = {
    kind: 'catalog_entity',
    entityKind: typed.kind,
    entityId: typed.id,
    inboundId: span.inboundId,
    span: { start: span.start, end: span.end },
  };
  return {
    candidate,
    proof: {
      kind: 'catalog_entity',
      proofVersion: context.proofVersion ?? 1,
      flowId: context.frame.flowState.flowId,
      entityKind: typed.kind,
      entityId: typed.id,
      inboundId: span.inboundId,
      span: { start: span.start, end: span.end },
    },
  };
}

function fullInboundHasCatalogSignal(context: ModelResultValidationContextV2): boolean {
  const entities = typedEntities(context);
  return context.frame.currentInboundIds.some((inboundId) => {
    const inbound = context.inboundTextsById[inboundId];
    if (typeof inbound !== 'string') return false;
    return splitClausesV2(inbound).some(
      (clause) => resolveV2CatalogText(clause, entities).kind !== 'no_match'
    );
  });
}

function translateUnknownServiceText(
  text: string | null,
  context: ModelResultValidationContextV2
): UnknownServiceEvidenceV2 | null {
  if (text === null || fullInboundHasCatalogSignal(context)) return null;
  const spans = locateTextInCurrentInbounds(text, context);
  if (spans.length === 0) return null;
  const entities = typedEntities(context);
  if (resolveV2CatalogText(text, entities).kind !== 'no_match') return null;
  const span = spans.at(-1)!;
  return { inboundId: span.inboundId, span: { start: span.start, end: span.end } };
}

function parseToolResult(result: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(result) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function currentSlotEvidence(context: ModelResultValidationContextV2): {
  serviceId: string;
  professionalId?: string;
  date: string;
  slots: string[];
} | null {
  for (const entry of [...(context.toolTrace ?? [])].reverse()) {
    if (entry.name !== 'getAvailableSlots') continue;
    const result = parseToolResult(entry.result);
    if (result?.success !== true || !Array.isArray(result.slots)) continue;
    const serviceId = typeof entry.args?.serviceId === 'string'
      ? entry.args.serviceId
      : '';
    const date = typeof entry.args?.date === 'string' ? entry.args.date : '';
    const professionalId = typeof entry.args?.professionalId === 'string'
      ? entry.args.professionalId
      : undefined;
    const resultProfessionalId = typeof result.professionalId === 'string'
      ? result.professionalId
      : undefined;
    if (
      professionalId &&
      resultProfessionalId &&
      professionalId !== resultProfessionalId
    ) {
      continue;
    }
    if (!serviceId || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    const normalized: string[] = [];
    for (const slot of result.slots) {
      if (typeof slot !== 'string') {
        normalized.length = 0;
        break;
      }
      const times = normalizeTemporalAssertionsV2(slot).filter((item) => item.kind === 'time');
      if (times.length !== 1) {
        normalized.length = 0;
        break;
      }
      normalized.push(times[0]!.normalized);
    }
    if (normalized.length === 0 || normalized.length !== result.slots.length) continue;
    return {
      serviceId,
      ...(resultProfessionalId || professionalId
        ? { professionalId: resultProfessionalId ?? professionalId }
        : {}),
      date,
      slots: [...new Set(normalized)],
    };
  }
  return null;
}

function effectiveServiceId(
  context: ModelResultValidationContextV2,
  proof: ResolutionProof | null
): string | undefined {
  return proof?.kind === 'catalog_entity' && proof.entityKind === 'service'
    ? proof.entityId
    : context.frame.flowState.fixedServiceId;
}

function effectiveProfessionalId(
  context: ModelResultValidationContextV2,
  proof: ResolutionProof | null
): string | undefined {
  if (proof?.kind === 'catalog_entity' && proof.entityKind === 'professional') {
    return proof.entityId;
  }
  if (
    proof?.kind === 'catalog_entity' &&
    proof.entityKind === 'service' &&
    proof.entityId !== context.frame.flowState.fixedServiceId
  ) {
    return undefined;
  }
  return context.frame.flowState.fixedProfessionalId;
}

function eligibleProfessionalIds(
  context: ModelResultValidationContextV2,
  serviceId: string
): string[] {
  const service = context.catalogEntities.services.find((entry) => entry.id === serviceId);
  const active = new Set(context.catalogEntities.professionals.map((entry) => entry.id));
  return service?.professionalIds === undefined
    ? [...active]
    : service.professionalIds.filter((id) => active.has(id));
}

function terminalBookSucceeded(context: ModelResultValidationContextV2): boolean {
  return (context.toolTrace ?? []).some(
    (entry) => entry.name === 'bookAppointment' && parseToolResult(entry.result)?.success === true
  );
}

function validBookingDraft(
  context: ModelResultValidationContextV2,
  serviceId: string | undefined,
  professionalId: string | undefined
): boolean {
  const draft = context.frame.flowState.bookingDraft;
  const evidence = context.frame.flowState.slotEvidence;
  if (
    !draft ||
    !evidence ||
    !serviceId ||
    draft.serviceId !== serviceId ||
    draft.serviceId !== evidence.serviceId ||
    draft.professionalId !== professionalId ||
    draft.professionalId !== evidence.professionalId ||
    draft.date !== context.frame.flowState.resolvedDate ||
    draft.date !== evidence.date ||
    draft.slotEvidenceTurnId !== evidence.turnId ||
    !evidence.slots.includes(draft.time) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(draft.date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(draft.time)
  ) {
    return false;
  }
  if (!professionalId) return true;
  return eligibleProfessionalIds(context, serviceId).includes(professionalId);
}

function transitionFromFlat(
  next: FlatNextPendingV2,
  context: ModelResultValidationContextV2,
  proof: ResolutionProof | null
): PendingTransitionCandidate {
  const flowId = context.frame.flowState.flowId;
  const serviceId = effectiveServiceId(context, proof);
  const professionalId = effectiveProfessionalId(context, proof);
  switch (next) {
    case 'PRESERVE':
      return { kind: 'preserve' };
    case 'RESOLVED':
      return terminalBookSucceeded(context) && context.frame.pending
        ? { kind: 'resolve', questionId: context.frame.pending.questionId }
        : { kind: 'preserve' };
    case 'SERVICE': {
      const ids = context.catalogEntities.services.map((entry) => entry.id);
      return ids.length > 0
        ? { kind: 'open', pendingKind: 'SERVICE', flowId, optionEntityIds: ids }
        : { kind: 'preserve' };
    }
    case 'PROFESSIONAL': {
      if (!serviceId) return { kind: 'preserve' };
      const ids = eligibleProfessionalIds(context, serviceId);
      return ids.length > 1
        ? { kind: 'open', pendingKind: 'PROFESSIONAL', flowId, optionEntityIds: ids }
        : { kind: 'preserve' };
    }
    case 'DATE': {
      if (!serviceId) return { kind: 'preserve' };
      const eligible = eligibleProfessionalIds(context, serviceId);
      const effectiveProfessional = professionalId ?? (eligible.length === 1 ? eligible[0] : undefined);
      return effectiveProfessional && eligible.includes(effectiveProfessional)
        ? { kind: 'open', pendingKind: 'DATE', flowId, optionEntityIds: ['date-freeform'] }
        : { kind: 'preserve' };
    }
    case 'TIME': {
      const evidence = currentSlotEvidence(context);
      const compatible = Boolean(
        evidence &&
          serviceId &&
          evidence.serviceId === serviceId &&
          (evidence.professionalId === undefined ||
            evidence.professionalId === professionalId)
      );
      return compatible && evidence
        ? {
            kind: 'open',
            pendingKind: 'TIME',
            flowId,
            optionEntityIds: evidence.slots,
          }
        : { kind: 'preserve' };
    }
    case 'CONFIRMATION': {
      return validBookingDraft(context, serviceId, professionalId)
        ? {
            kind: 'open',
            pendingKind: 'CONFIRMATION',
            flowId,
            optionEntityIds: [`booking-confirmation:${flowId}`],
          }
        : { kind: 'preserve' };
    }
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)])
    );
  }
  return value;
}

function sameFlowStateV2(left: TurnFrameV2['flowState'], right: TurnFrameV2['flowState']): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

/**
 * Anti-churn A3: só reaproveita uma OPEN se a tupla completa for idêntica.
 * A ordem de optionEntityIds é parte do contrato. Fluxos de resolução de
 * duplicidade nunca são coagidos porque carregam lifecycle próprio.
 */
export function coerceEquivalentOpenTransitionV2(
  candidate: PendingTransitionCandidate,
  frame: TurnFrameV2,
  proposedFlowState: TurnFrameV2['flowState']
): PendingTransitionCandidate {
  if (candidate.kind !== 'open' || !frame.pending) return candidate;
  const currentOptionIds = frame.pending.options.map((option) => option.entityId);
  const duplicateResolution = [...currentOptionIds, ...candidate.optionEntityIds].some(
    (entityId) => entityId.startsWith('duplicate-resolution:')
  );
  if (duplicateResolution) return candidate;
  const sameOptions =
    currentOptionIds.length === candidate.optionEntityIds.length &&
    currentOptionIds.every(
      (entityId, index) => entityId === candidate.optionEntityIds[index]
    );
  return frame.pending.flowId === candidate.flowId &&
    frame.pending.kind === candidate.pendingKind &&
    sameOptions &&
    sameFlowStateV2(frame.flowState, proposedFlowState)
    ? { kind: 'preserve' }
    : candidate;
}

function purposeFromTransition(
  candidate: PendingTransitionCandidate,
  context: ModelResultValidationContextV2
): ModelReplyPurposeV2 {
  if (candidate.kind === 'open') {
    if (candidate.pendingKind === 'SERVICE') return 'SERVICE_QUESTION';
    if (candidate.pendingKind === 'PROFESSIONAL') return 'PROFESSIONAL_QUESTION';
    if (candidate.pendingKind === 'DATE' || candidate.pendingKind === 'TIME') return 'DATE_TIME_QUESTION';
    return 'WRITE_CONFIRMATION';
  }
  if (candidate.kind === 'resolve' && terminalBookSucceeded(context)) return 'WRITE_CONFIRMATION';
  return 'OPERATIONAL_ANSWER';
}

/**
 * Parser externo único da Revisão 2. Nunca tenta o antigo envelope rico.
 */
export function parseModelTurnResultV2(
  raw: string,
  context: ModelResultValidationContextV2
): ModelTurnResultV2ParseResult {
  const flat = parseFlatEnvelope(raw);
  if (!flat.ok) return flat;
  const rejections: ResolutionProofRejectionV2[] = [];
  const translated = translateChosenOption(
    flat.value.chosenOptionText,
    context,
    rejections
  );
  const pendingTransitionCandidate = transitionFromFlat(
    flat.value.nextPending,
    context,
    translated.proof
  );
  return {
    ok: true,
    flatValue: flat.value,
    value: {
      schemaVersion: 2,
      reply: flat.value.reply,
      replyPurpose: purposeFromTransition(pendingTransitionCandidate, context),
      pendingTransitionCandidate,
      resolutionCandidate: translated.candidate,
      unknownServiceEvidence: translateUnknownServiceText(
        flat.value.unknownServiceText,
        context
      ),
    },
    resolutionProof: translated.proof,
    resolutionProofRejections: rejections,
  };
}

export const __parseFlatModelTurnV2ForSmoke = parseFlatEnvelope;
