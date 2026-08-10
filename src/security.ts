import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Hardening do webhook do Receps-IA: verificação de assinatura da Meta
 * (X-Hub-Signature-256) + rate limit in-memory por IP.
 *
 * In-memory é suficiente para o deploy single-instance do Receps-IA (prod-only). Ao
 * escalar para múltiplas instâncias, troque o store por Redis mantendo as
 * mesmas funções puras.
 */

// ---------------------------------------------------------------------------
// Verificação de assinatura da Meta (HMAC-SHA256)
// ---------------------------------------------------------------------------

/**
 * O segredo do app da Meta (Meta App Dashboard → Settings → App Secret).
 * Sem ele, a verificação fica DESLIGADA (fail-open com aviso) para não derrubar
 * o bot em prod antes do segredo ser provisionado. Configure para ativar.
 */
export const META_APP_SECRET =
  process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET ?? '';

/**
 * Valida `sha256=HMAC_SHA256(rawBody, secret)` contra o header recebido.
 * Comparação em tempo constante (timingSafeEqual) para não vazar timing.
 * Função pura — recebe o segredo por parâmetro para ser testável.
 */
export function isValidMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!secret || !signatureHeader || !rawBody) {
    return false;
  }

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);

  // timingSafeEqual exige buffers do mesmo tamanho; checa antes para não lançar.
  if (received.length !== computed.length) {
    return false;
  }
  return crypto.timingSafeEqual(received, computed);
}

/**
 * Middleware Express: verifica o HMAC do forward Receps→Receps-IA.
 *
 * O webhook do Receps-IA recebe o payload ENCAMINHADO pelo Receps (não direto da
 * Meta): Meta → Receps /api/v1/bot/webhook (verifica X-Hub-Signature-256 da
 * Meta) → forward assinado com RECEPS_BOT_WEBHOOK_SECRET (header X-Bot-Signature)
 * → Receps-IA. A assinatura da Meta NÃO sobrevive ao reenvio (corpo re-serializado +
 * header não repassado), então a defesa real deste hop é o segredo do forward.
 *
 * Fail-CLOSED em produção: sem RECEPS_BOT_WEBHOOK_SECRET → 503 (não processa
 * sem segredo). Em dev, segue com aviso pra não travar o ambiente local.
 * Lê o env em tempo de request (testável / robusto a mudança de ambiente).
 */
export function botSignatureMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.RECEPS_BOT_WEBHOOK_SECRET ?? '';

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '❌ RECEPS_BOT_WEBHOOK_SECRET ausente em produção — webhook não configurado (fail-closed).'
      );
      res.status(503).json({ error: 'webhook não configurado' });
      return;
    }
    console.warn(
      '⚠️ RECEPS_BOT_WEBHOOK_SECRET ausente — verificação do forward DESLIGADA (apenas dev).'
    );
    next();
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.get('x-bot-signature') ?? undefined;

  if (!isValidMetaSignature(rawBody, signature, secret)) {
    console.warn('⚠️ Forward com X-Bot-Signature inválida/ausente — rejeitado (401).');
    res.sendStatus(401);
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Auth de API interna (Bearer) — endpoints lidos pelo Receps (ex.:
// /internal/conversation-activity). Espelha o segredo compartilhado ERP_API_TOKEN
// (= AI_BOT_API_KEY do Receps).
// ---------------------------------------------------------------------------

/**
 * Valida `Authorization: Bearer <token>` contra o segredo esperado, em tempo
 * constante (não vaza timing). Função pura — recebe header e segredo por
 * parâmetro pra ser testável. Segredo vazio / header ausente / esquema errado /
 * tamanho diferente → false.
 */
export function isValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  if (!expectedToken || !authorizationHeader) {
    return false;
  }

  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) {
    return false;
  }

  const provided = authorizationHeader.slice(prefix.length).trim();
  if (!provided) {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Rate limit por IP (sliding window counter, in-memory)
// ---------------------------------------------------------------------------

export const WEBHOOK_RATE_LIMIT = 1000;
export const WEBHOOK_RATE_WINDOW_MS = 60_000;
const MAX_KEYS = 20_000;

interface WindowState {
  start: number;
  count: number;
  prevCount: number;
}
const store = new Map<string, WindowState>();

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number;
}

/** Verifica e contabiliza uma requisição. Mesma lógica de janela do Receps. */
export function consumeRateLimit(
  key: string,
  limit: number = WEBHOOK_RATE_LIMIT,
  windowMs: number = WEBHOOK_RATE_WINDOW_MS
): RateLimitResult {
  const now = Date.now();
  let state = store.get(key);

  if (!state) {
    state = { start: now, count: 0, prevCount: 0 };
  } else {
    const elapsed = now - state.start;
    if (elapsed >= 2 * windowMs) {
      state = { start: now, count: 0, prevCount: 0 };
    } else if (elapsed >= windowMs) {
      state = { start: state.start + windowMs, count: 0, prevCount: state.count };
    }
  }

  const elapsedInWindow = now - state.start;
  const prevWeight = Math.max(0, (windowMs - elapsedInWindow) / windowMs);
  const estimated = state.prevCount * prevWeight + state.count;

  // LRU touch.
  store.delete(key);
  store.set(key, state);
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }

  if (estimated >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - elapsedInWindow) / 1000));
    return { ok: false, retryAfter };
  }

  state.count += 1;
  return { ok: true, retryAfter: 0 };
}

/** Zera o store. Uso: testes/smoke. */
export function resetRateLimitStore(): void {
  store.clear();
}

/** IP do cliente atrás de proxy reverso (nginx). Confia em x-forwarded-for. */
export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  return req.ip ?? 'anonymous';
}

/**
 * Middleware Express: rate limit 1000/min por IP no webhook. Registre ANTES do
 * parser de JSON para barrar enxurradas sem custo de parsing. Só age em
 * POST /webhook; demais rotas passam direto.
 */
export function webhookRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.method !== 'POST' || req.path !== '/webhook') {
    next();
    return;
  }

  const ip = extractClientIp(req);
  const result = consumeRateLimit(`webhook:ip:${ip}`);
  if (!result.ok) {
    res.setHeader('Retry-After', String(result.retryAfter));
    res.status(429).json({ error: 'Too Many Requests' });
    return;
  }
  next();
}
