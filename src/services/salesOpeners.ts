import crypto from 'crypto';

export const AD_OPENING_MESSAGES = [
  'Oi! Quero ver como a Receps atenderia as clientes da minha clínica.',
  'Oi! Me identifiquei com o anúncio… me conta como funciona?',
] as const;

export const OPENER_SCRIPTS = [
  'Oi! Que bom que você chamou 😊\n\nA Receps organiza a clínica inteira e ainda tem a Ana atendendo no seu WhatsApp por você.\n\nMe conta uma coisa: o que mais te chamou atenção — organizar a clínica toda, com agenda, financeiro e comissão, ter a Ana respondendo seu WhatsApp, ou as duas coisas?',
  'Oi! Adorei seu interesse 🙌\n\nPra eu te explicar do seu jeito, me conta o que mais pesou pra você chamar aqui: organizar a clínica toda, com agenda, financeiro e comissão, ter a Ana respondendo seu WhatsApp no seu lugar, ou as duas coisas juntas?',
] as const;

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
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

const PARTNER_SLUG_PATTERN = /^[a-z0-9_.]{2,30}$/;

type PartnerToken = {
  raw: string;
  normalized: string;
};

/**
 * Separa palavras ignorando pontuação de frase, mas preserva os caracteres que
 * precisam ser validados no slug (`@`, `.`, `_`, hífen, acentos e `<...>`).
 * Assim o indicador de origem é tolerante a pontuação/acentos sem "consertar"
 * um slug inválido antes da validação estrita.
 */
function partnerMentionTokens(text: string): PartnerToken[] {
  return text
    .replace(/(?:\.{3}|…)/gu, ' ')
    .replace(/[,;:!?()[\]{}"'“”‘’]+/gu, ' ')
    .split(/\s+/u)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map((raw) => ({ raw, normalized: normalizeForMatch(raw) }));
}

function validatedPartnerSlug(token: PartnerToken | undefined): string | null {
  if (!token) return null;
  const candidate = token.raw.startsWith('@') ? token.raw.slice(1) : token.raw;
  return PARTNER_SLUG_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Detecta a menção determinística de origem na PRIMEIRA mensagem consolidada.
 * A janela de primeira mensagem é responsabilidade do chamador, igual ao
 * `matchAdOpening`; esta função só interpreta o texto recebido.
 *
 * Case-insensitive vale para as expressões de origem. O slug continua estrito
 * no formato canônico minúsculo — não normalizamos maiúscula/acento/hífen para
 * outro identificador antes de o Receps revalidar regex + allowlist.
 */
export function matchPartnerMention(consolidatedText: string): string | null {
  const tokens = partnerMentionTokens(consolidatedText);

  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]?.normalized;
    const next = tokens[index + 1]?.normalized;

    // Forma mais específica primeiro para "vim pelo perfil da" não virar
    // candidato "perfil" pelo padrão curto "vim pelo".
    if (
      current === 'vim' &&
      next === 'pelo' &&
      tokens[index + 2]?.normalized === 'perfil' &&
      tokens[index + 3]?.normalized === 'da'
    ) {
      return validatedPartnerSlug(tokens[index + 4]);
    }

    if (
      current === 'vim' &&
      next === 'atraves' &&
      ['da', 'do'].includes(tokens[index + 2]?.normalized ?? '')
    ) {
      return validatedPartnerSlug(tokens[index + 3]);
    }

    if (
      ['vim', 'venho'].includes(current ?? '') &&
      ['pela', 'pelo'].includes(next ?? '')
    ) {
      return validatedPartnerSlug(tokens[index + 2]);
    }

    if (
      current === 'indicacao' &&
      ['da', 'do'].includes(next ?? '')
    ) {
      return validatedPartnerSlug(tokens[index + 2]);
    }

    if (
      current === 'a' &&
      tokens[index + 2]?.normalized === 'indicou'
    ) {
      return validatedPartnerSlug(tokens[index + 1]);
    }
  }

  return null;
}

/** Rotação estável por lead, sem random e sem expor o telefone em log. */
export function pickOpenerScript(phone: string): string {
  const digest = crypto.createHash('sha256').update(phone).digest();
  return OPENER_SCRIPTS[digest.readUInt32BE(0) % OPENER_SCRIPTS.length];
}
