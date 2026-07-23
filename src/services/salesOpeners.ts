import crypto from 'crypto';

export const AD_OPENING_MESSAGES = [
  'Oi! Quero ver como a Receps atenderia as clientes da minha clínica.',
  'Oi! Me identifiquei com o anúncio… me conta como funciona?',
] as const;

export const OPENER_SCRIPTS = [
  'Oi! Que bom que você chamou 😊\n\nDeixa eu te mostrar rapidinho como a Receps funciona pra sua clínica.\n\nMe conta uma coisa: hoje é só você atendendo ou tem mais gente no time?',
  'Oi! Adorei seu interesse 🙌\n\nA Receps organiza sua agenda, seu financeiro e ainda tem a Ana atendendo no WhatsApp por você.\n\nPra eu te explicar do seu jeito: quantas profissionais atendem na sua clínica?',
] as const;

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?:\.{3}|…)/g, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[!?.…]+$/g, '')
    .trim();
}

export function matchAdOpening(consolidatedText: string): boolean {
  const normalized = normalizeForMatch(consolidatedText);
  return AD_OPENING_MESSAGES.some(
    (opening) => normalizeForMatch(opening) === normalized
  );
}

/** Rotação estável por lead, sem random e sem expor o telefone em log. */
export function pickOpenerScript(phone: string): string {
  const digest = crypto.createHash('sha256').update(phone).digest();
  return OPENER_SCRIPTS[digest.readUInt32BE(0) % OPENER_SCRIPTS.length];
}
