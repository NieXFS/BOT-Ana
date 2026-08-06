/**
 * Scrubbing de PII para o Sentry da Ana (LGPD).
 *
 * Mensagens de WhatsApp são PII de cliente final. Regra firme: nada de PII de
 * cliente final escapa pro Sentry. Redige valores de chaves sensíveis (email,
 * telefone, número do cliente `from`/`wa_id`/`customerPhone`, nome do cliente,
 * cpf, tokens, segredos) e redige texto livre
 * (`text`/`body`/`message`...) para `[REDACTED:N chars]`.
 *
 * Allowlist: `phoneNumberId` (ID Meta da linha do salão, não é número pessoal),
 * `tenantSlug` e `messageId` são contexto útil e ficam preservados.
 */

import type { Event } from '@sentry/node';

// Obs.: NÃO incluir "whatsapp" aqui — o contexto deliberado `whatsapp_message`
// (phoneNumberId/tenantSlug/messageId) usa esse nome e seria redigido inteiro.
// O número do cliente chega em `from`/`to`/`wa_id`/`phone`/`telefone`.
const SENSITIVE_KEY =
  /(e-?mail|phone|telefone|fone|celular|wa_id|conversation.?key|customer.?phone|customer.?name|client.?name|nome.?cliente|cpf|cnpj|rg|password|senha|secret|token|authorization|api[-_]?key|cookie)/i;

/** Chaves cujo nome bate em SENSITIVE_KEY mas NÃO são PII — não redigir. */
const ALLOWLIST_KEY = /^(phoneNumberId|tenantSlug|messageId)$/;

/** Telefone do cliente chega como `from`/`to` no payload da Meta. */
const PHONE_FIELD_KEY = /^(from|to)$/i;

const LONG_TEXT_KEY = /^(text|body|message|mensagem|notes?|description|descricao|observac(ao|oes))$/i;

const REDACTED = '[REDACTED]';
const REDACTED_IP = '0.0.0.0';
const MAX_DEPTH = 8;

function shouldRedactKey(key: string): boolean {
  if (ALLOWLIST_KEY.test(key)) {
    return false;
  }
  return SENSITIVE_KEY.test(key) || PHONE_FIELD_KEY.test(key);
}

/**
 * M13: scrub de PII embutida numa STRING livre (mensagem de erro, message de
 * evento/breadcrumb). O scrubDeep só redige por NOME de chave; isto cobre PII
 * dentro do TEXTO — ex.: um AxiosError cujo `.message`/`.value` carrega
 * telefone/email/cpf/token. Ordem importa: formatos mascarados (E.164/CPF)
 * antes do telefone BR cru, e hex longo por último p/ não comer um token já
 * dentro de um Bearer redigido.
 *
 * ReDoS: o e-mail tem parte local que permite `.`, então em entradas
 * adversariais (`a@a.a.a...`) o retry global é ~quadrático. A defesa REAL é o
 * teto de comprimento (`MAX_SCRUB_TEXT`) aplicado ANTES das regexes — limita o
 * pior caso a ~3ms mesmo num payload de 80KB. As demais regexes (telefone/
 * token) são lineares (repetição limitada + lookarounds). O que passa do teto é
 * DESCARTADO (removido, não vaza).
 */
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
// E.164 internacional, tolerando separadores (`+55 11 99999-8888`).
const RE_E164 = /(?<!\d)\+\d{1,3}(?:[\s.-]?\d){7,14}(?!\d)/g;
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
// Telefone BR com/sem DDD entre parênteses e separadores (`(11) 99999-8888`,
// `11 3333-4444`, `1199998888`). Lookarounds evitam casar dentro de um número
// maior. Roda DEPOIS de CPF/E.164 (já redigidos) p/ não sobrepor.
const RE_BR_PHONE = /(?<!\d)\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g;
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const RE_LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;

/** Teto de comprimento p/ bound do tempo de scrubbing (defesa ReDoS). */
const MAX_SCRUB_TEXT = 2000;

export function scrubText<T extends string | null | undefined>(input: T): T {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  const capped =
    input.length > MAX_SCRUB_TEXT
      ? `${input.slice(0, MAX_SCRUB_TEXT)}…[truncated]`
      : input;
  return capped
    .replace(RE_EMAIL, REDACTED)
    .replace(RE_E164, REDACTED)
    .replace(RE_CPF, REDACTED)
    .replace(RE_BR_PHONE, REDACTED)
    .replace(RE_BEARER, 'Bearer [REDACTED]')
    .replace(RE_LONG_HEX, REDACTED) as T;
}

function scrubDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, depth + 1, seen));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const current = record[key];

    if (shouldRedactKey(key)) {
      record[key] = REDACTED;
      continue;
    }

    if (typeof current === 'string') {
      // Texto de cliente é PII independentemente do tamanho. O limite antigo
      // deixava mensagens curtas vazarem em request.data/contexts do Sentry.
      if (LONG_TEXT_KEY.test(key)) {
        record[key] = `[REDACTED:${current.length} chars]`;
      }
      continue;
    }

    record[key] = scrubDeep(current, depth + 1, seen);
  }

  return record;
}

function scrubRequest(event: Event): void {
  const request = event.request;
  if (!request) {
    return;
  }
  delete request.cookies;
  if (request.headers && typeof request.headers === 'object') {
    for (const headerName of Object.keys(request.headers)) {
      if (/^(cookie|set-cookie|authorization|x-hub-signature.*)$/i.test(headerName)) {
        delete (request.headers as Record<string, unknown>)[headerName];
      }
    }
    scrubDeep(request.headers, 0, new WeakSet());
  }
  if ('ip' in request) {
    (request as { ip?: string }).ip = REDACTED_IP;
  }
  if (request.data && typeof request.data === 'object') {
    scrubDeep(request.data, 0, new WeakSet());
  }
}

function scrubUser(event: Event): void {
  if (!event.user) {
    return;
  }
  delete event.user.email;
  delete event.user.username;
  delete event.user.ip_address;
}

/** `beforeSend` da Ana: aplica o scrubbing completo. Sempre retorna o evento. */
export function scrubEvent<T extends Event>(event: T): T {
  try {
    scrubUser(event);
    scrubRequest(event);
    if (event.extra) {
      scrubDeep(event.extra, 0, new WeakSet());
    }
    if (event.contexts) {
      scrubDeep(event.contexts, 0, new WeakSet());
    }
    if (event.tags) {
      scrubDeep(event.tags, 0, new WeakSet());
    }
    // M13: scrub de strings livres — o scrubDeep acima só cobre chaves nomeadas.
    if (typeof event.message === 'string') {
      event.message = scrubText(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (typeof ex.value === 'string') {
          ex.value = scrubText(ex.value);
        }
      }
    }
    if (Array.isArray(event.breadcrumbs)) {
      for (const crumb of event.breadcrumbs) {
        if (crumb && crumb.data) {
          scrubDeep(crumb.data, 0, new WeakSet());
        }
        if (crumb && typeof crumb.message === 'string') {
          crumb.message = scrubText(crumb.message);
        }
      }
    }
  } catch {
    // nunca deixa o scrubbing quebrar a captura
  }
  return event;
}
