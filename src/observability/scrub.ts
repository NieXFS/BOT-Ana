/**
 * Scrubbing de PII para o Sentry da Ana (LGPD).
 *
 * Mensagens de WhatsApp são PII de cliente final. Regra firme: nada de PII de
 * cliente final escapa pro Sentry. Redige valores de chaves sensíveis (email,
 * telefone, número do cliente `from`/`wa_id`/`customerPhone`, nome do cliente,
 * cpf, tokens, segredos) e trunca texto livre (`text`/`body`/`message`...) > 60
 * chars pra `[REDACTED:N chars]`.
 *
 * Allowlist: `phoneNumberId` (ID Meta da linha do salão, não é número pessoal),
 * `tenantSlug` e `messageId` são contexto útil e ficam preservados.
 */

import type { Event } from '@sentry/node';

// Obs.: NÃO incluir "whatsapp" aqui — o contexto deliberado `whatsapp_message`
// (phoneNumberId/tenantSlug/messageId) usa esse nome e seria redigido inteiro.
// O número do cliente chega em `from`/`to`/`wa_id`/`phone`/`telefone`.
const SENSITIVE_KEY =
  /(e-?mail|phone|telefone|fone|celular|wa_id|customer.?phone|customer.?name|client.?name|nome.?cliente|cpf|cnpj|rg|password|senha|secret|token|authorization|api[-_]?key|cookie)/i;

/** Chaves cujo nome bate em SENSITIVE_KEY mas NÃO são PII — não redigir. */
const ALLOWLIST_KEY = /^(phoneNumberId|tenantSlug|messageId)$/;

/** Telefone do cliente chega como `from`/`to` no payload da Meta. */
const PHONE_FIELD_KEY = /^(from|to)$/i;

const LONG_TEXT_KEY = /^(text|body|message|mensagem|notes?|description|descricao|observac(ao|oes))$/i;

const MAX_CLIENT_TEXT = 60;
const REDACTED = '[REDACTED]';
const REDACTED_IP = '0.0.0.0';
const MAX_DEPTH = 8;

function shouldRedactKey(key: string): boolean {
  if (ALLOWLIST_KEY.test(key)) {
    return false;
  }
  return SENSITIVE_KEY.test(key) || PHONE_FIELD_KEY.test(key);
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
      if (LONG_TEXT_KEY.test(key) && current.length > MAX_CLIENT_TEXT) {
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
    if (Array.isArray(event.breadcrumbs)) {
      for (const crumb of event.breadcrumbs) {
        if (crumb && crumb.data) {
          scrubDeep(crumb.data, 0, new WeakSet());
        }
      }
    }
  } catch {
    // nunca deixa o scrubbing quebrar a captura
  }
  return event;
}
