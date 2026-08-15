import { normalizeVoiceTextV2 } from '../voice/normalize';
import { extractOrderedTimesV2, extractVoiceHardFactsV2 } from '../voice/extractors';
import type { Tau2CommunicateItem } from './types';

export function communicateItemPresentV2(
  payload: string,
  item: Tau2CommunicateItem
): boolean {
  const normalized = normalizeVoiceTextV2(payload);
  if (item.kind === 'service') {
    const label = item.label?.trim();
    return Boolean(label && normalized.includes(normalizeVoiceTextV2(label)));
  }
  if (item.kind === 'date') {
    const value = String(item.value ?? '');
    const facts = extractVoiceHardFactsV2(payload);
    if (facts.dates.includes(value)) return true;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return normalized.includes(normalizeVoiceTextV2(value));
    const display = `${Number(match[3])}/${match[2]}/${match[1]}`;
    return normalized.includes(normalizeVoiceTextV2(display));
  }
  if (item.kind === 'time') {
    const value = String(item.value ?? '');
    const times = extractOrderedTimesV2(payload);
    if (times.includes(value)) return true;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
    if (!match) return normalized.includes(normalizeVoiceTextV2(value));
    const hour = Number(match[1]);
    const minute = match[2];
    const colloquial = minute === '00' ? `${hour}h` : `${hour}h${minute}`;
    return times.includes(value) || normalized.includes(colloquial);
  }
  if (item.kind === 'money_cents') {
    const cents = Number(item.value);
    return extractVoiceHardFactsV2(payload).moneyCents.includes(cents);
  }
  return false;
}

export function evaluateCommunicateV2(
  payloads: readonly string[],
  items: readonly Tau2CommunicateItem[]
): 0 | 1 {
  if (items.length === 0) return 1;
  const joined = payloads.join('\n');
  return items.every((item) => communicateItemPresentV2(joined, item)) ? 1 : 0;
}
