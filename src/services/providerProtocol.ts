/**
 * Contrato de protocolo do provider, separado da suíte de negócio.
 * Pseudo-tool-call em `content` NUNCA é desserializada nem executada.
 */

export const PROVIDER_PROTOCOL_EVENT_CODES = [
  'EXPECTED_TOOL_GOT_TEXT',
  'EMPTY_GENERATION',
  'PSEUDO_TOOL_IN_CONTENT',
] as const;

export type ProviderProtocolEventCode =
  (typeof PROVIDER_PROTOCOL_EVENT_CODES)[number];

export interface ProviderProtocolEvent {
  readonly code: ProviderProtocolEventCode;
  readonly round: number;
  readonly expectedTool?: string;
  readonly pseudoToolNames?: readonly string[];
}

export type ReceptionistToolChoice =
  | 'auto'
  | 'required'
  | { type: 'function'; name: string };

const KNOWN_TOOL_NAMES = [
  'getUpcomingAppointments',
  'getAvailableSlots',
  'bookAppointment',
  'cancelAppointment',
  'getServices',
] as const;

const KNOWN_TOOL_NAME_RE = new RegExp(
  `\\b(${KNOWN_TOOL_NAMES.join('|')})\\b`,
  'g'
);

export function isNamedToolChoice(
  value: ReceptionistToolChoice | undefined
): value is { type: 'function'; name: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.type === 'function' &&
      typeof value.name === 'string' &&
      value.name.trim()
  );
}

export function isForcedToolChoice(
  value: ReceptionistToolChoice | undefined
): boolean {
  return value === 'required' || isNamedToolChoice(value);
}

/**
 * Detecta aparência de tool-call em prosa. Só telemetria: o loop nunca passa
 * estes nomes para o executor.
 */
export function detectPseudoToolCallsInText(text: string): {
  readonly names: readonly string[];
} {
  if (!text.trim()) return { names: [] };
  const names = new Set<string>();
  const xml =
    /<tool_call>\s*\{[\s\S]*?"name"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/gu;
  for (const match of text.matchAll(xml)) {
    if (match[1]) names.add(match[1]);
  }
  const jsonBlock =
    /"tool_calls"\s*:\s*\[[\s\S]*?"(?:name|function)"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/gu;
  for (const match of text.matchAll(jsonBlock)) {
    if (match[1]) names.add(match[1]);
  }
  const fenced =
    /```(?:json|tool(?:_call)?)?[\s\S]*?"name"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/gu;
  for (const match of text.matchAll(fenced)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(KNOWN_TOOL_NAME_RE)) {
    if (match[1]) names.add(match[1]);
  }
  return { names: [...names] };
}

export function assistantContentLooksLikeToolCall(text: string): boolean {
  return detectPseudoToolCallsInText(text).names.length > 0;
}
