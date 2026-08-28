import type { Request, Response } from 'express';
import { getTenantConfig, type TenantBotConfig } from '../configProvider';
import { Sentry } from '../observability/sentry';
import {
  runtimeErrorKind,
  safeHttpStatus,
  technicalHash,
} from '../observability/safeRuntime';
import { consumeRateLimit, type RateLimitResult } from '../security';
import {
  isAmbiguousWhatsAppTransportError,
  sendTemplateMessageWithReceipt,
  type WhatsAppTemplateMessage,
  type WhatsAppTenantConfig,
} from '../whatsappCloudService';

export const AUTH_OTP_TEMPLATE_NAME =
  process.env.RECEPS_AUTH_OTP_TEMPLATE_NAME?.trim() ||
  'receps_auth_otp_v1';
export const ONBOARDING_WELCOME_TEMPLATE_NAME =
  process.env.RECEPS_ONBOARDING_WELCOME_TEMPLATE_NAME?.trim() ||
  'receps_onboarding_welcome_v1';
export const TRANSACTIONAL_TEMPLATE_LANGUAGE = 'pt_BR';

export const AUTH_OTP_RATE_LIMIT = 5;
export const AUTH_OTP_RATE_WINDOW_MS = 10 * 60_000;
export const ONBOARDING_WELCOME_RATE_LIMIT = 3;
export const ONBOARDING_WELCOME_RATE_WINDOW_MS = 24 * 60 * 60_000;

const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const CANONICAL_BR_PHONE_PATTERN = /^\+55[1-9]\d{9,10}$/;
const OTP_CODE_PATTERN = /^\d{4,10}$/;

export interface AuthOtpInput {
  phone: string;
  code: string;
}

export interface OnboardingWelcomeInput {
  phone: string;
}

export type TransactionalMessageKind = 'auth_otp' | 'onboarding_welcome';

export interface TransactionalMessageAccepted {
  ok: true;
  kind: TransactionalMessageKind;
  status: 'accepted';
  template: string;
  language: typeof TRANSACTIONAL_TEMPLATE_LANGUAGE;
}

export class TransactionalMessageError extends Error {
  constructor(
    readonly reason:
      | 'rate_limited'
      | 'sender_not_configured'
      | 'provider_rejected'
      | 'provider_outcome_unknown',
    readonly statusCode: number,
    readonly retryAfter?: number
  ) {
    super(reason);
    this.name = 'TransactionalMessageError';
  }
}

export interface TransactionalOnboardingMessageDeps {
  resolveSenderConfig: () => Promise<WhatsAppTenantConfig>;
  sendTemplate: (
    to: string,
    template: WhatsAppTemplateMessage,
    config: WhatsAppTenantConfig
  ) => Promise<{ providerMessageId: string }>;
  consumeLimit: (
    key: string,
    limit: number,
    windowMs: number
  ) => RateLimitResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

export function isCanonicalBrazilianPhone(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_BR_PHONE_PATTERN.test(value)
  );
}

export function isValidOtpCode(value: unknown): value is string {
  return typeof value === 'string' && OTP_CODE_PATTERN.test(value);
}

export function parseAuthOtpInput(value: unknown): AuthOtpInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ['phone', 'code'])) {
    return null;
  }
  if (!isCanonicalBrazilianPhone(value.phone) || !isValidOtpCode(value.code)) {
    return null;
  }
  return { phone: value.phone, code: value.code };
}

export function parseOnboardingWelcomeInput(
  value: unknown
): OnboardingWelcomeInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ['phone'])) {
    return null;
  }
  if (!isCanonicalBrazilianPhone(value.phone)) return null;
  return { phone: value.phone };
}

export function toMetaRecipient(phone: string): string {
  return phone.slice(1);
}

function assertTemplateName(name: string): string {
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new TransactionalMessageError('sender_not_configured', 503);
  }
  return name;
}

export function buildAuthOtpTemplate(code: string): WhatsAppTemplateMessage {
  return {
    name: assertTemplateName(AUTH_OTP_TEMPLATE_NAME),
    languageCode: TRANSACTIONAL_TEMPLATE_LANGUAGE,
    components: [
      {
        type: 'body',
        parameters: [{ type: 'text', text: code }],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      },
    ],
  };
}

export function buildOnboardingWelcomeTemplate(): WhatsAppTemplateMessage {
  return {
    name: assertTemplateName(ONBOARDING_WELCOME_TEMPLATE_NAME),
    languageCode: TRANSACTIONAL_TEMPLATE_LANGUAGE,
  };
}

function transactionalPhoneNumberId(): string {
  return (
    process.env.RECEPS_TRANSACTIONAL_PHONE_NUMBER_ID?.trim() ||
    process.env.WA_PHONE_NUMBER_ID?.trim() ||
    ''
  );
}

function isRecepsSalesSender(
  config: TenantBotConfig | null,
  expectedPhoneNumberId: string
): config is TenantBotConfig {
  return Boolean(
    config &&
      config.isActive &&
      config.botRole === 'sales' &&
      config.tenantSlug === 'receps-vendas' &&
      config.phoneNumberId === expectedPhoneNumberId &&
      config.waAccessToken?.trim() &&
      config.waApiVersion?.trim()
  );
}

export async function resolveTransactionalSenderConfig(): Promise<WhatsAppTenantConfig> {
  const phoneNumberId = transactionalPhoneNumberId();
  if (!/^\d+$/.test(phoneNumberId)) {
    throw new TransactionalMessageError('sender_not_configured', 503);
  }

  const config = await getTenantConfig(phoneNumberId);
  if (!isRecepsSalesSender(config, phoneNumberId)) {
    throw new TransactionalMessageError('sender_not_configured', 503);
  }

  return config;
}

const defaultDeps: TransactionalOnboardingMessageDeps = {
  resolveSenderConfig: resolveTransactionalSenderConfig,
  sendTemplate: sendTemplateMessageWithReceipt,
  consumeLimit: consumeRateLimit,
};

let testDeps: TransactionalOnboardingMessageDeps | null = null;

function activeDeps(
  explicit?: TransactionalOnboardingMessageDeps
): TransactionalOnboardingMessageDeps {
  return explicit ?? testDeps ?? defaultDeps;
}

/** Seam exclusivo de smoke; `undefined` restaura as dependências produtivas. */
export function __setTransactionalOnboardingMessageDepsForTest(
  deps?: TransactionalOnboardingMessageDeps
): void {
  testDeps = deps ?? null;
}

function consumeRecipientLimit(
  kind: TransactionalMessageKind,
  phone: string,
  deps: TransactionalOnboardingMessageDeps
): void {
  const result =
    kind === 'auth_otp'
      ? deps.consumeLimit(
          `transactional:${kind}:${technicalHash(phone)}`,
          AUTH_OTP_RATE_LIMIT,
          AUTH_OTP_RATE_WINDOW_MS
        )
      : deps.consumeLimit(
          `transactional:${kind}:${technicalHash(phone)}`,
          ONBOARDING_WELCOME_RATE_LIMIT,
          ONBOARDING_WELCOME_RATE_WINDOW_MS
        );
  if (!result.ok) {
    throw new TransactionalMessageError(
      'rate_limited',
      429,
      result.retryAfter
    );
  }
}

async function dispatchTemplate(
  kind: TransactionalMessageKind,
  phone: string,
  template: WhatsAppTemplateMessage,
  deps: TransactionalOnboardingMessageDeps
): Promise<TransactionalMessageAccepted> {
  consumeRecipientLimit(kind, phone, deps);
  const sender = await deps.resolveSenderConfig();

  try {
    // O recibo fica somente na fronteira do transporte; nunca volta ao ERP nem
    // entra em log, histórico comercial ou telemetria de funil.
    await deps.sendTemplate(toMetaRecipient(phone), template, sender);
  } catch (error) {
    const ambiguous = isAmbiguousWhatsAppTransportError(error);
    Sentry.captureException(
      new Error('transactional onboarding template transport failed'),
      {
        tags: {
          service: 'transactional-onboarding-messages',
          operation: kind,
          outcome: ambiguous ? 'unknown' : 'rejected',
          error_kind: runtimeErrorKind(error),
          http_status: safeHttpStatus(error) ?? 'unknown',
        },
      }
    );
    throw new TransactionalMessageError(
      ambiguous ? 'provider_outcome_unknown' : 'provider_rejected',
      ambiguous ? 202 : 502
    );
  }

  return {
    ok: true,
    kind,
    status: 'accepted',
    template: template.name,
    language: TRANSACTIONAL_TEMPLATE_LANGUAGE,
  };
}

export async function sendAuthenticationOtp(
  input: AuthOtpInput,
  depsInput?: TransactionalOnboardingMessageDeps
): Promise<TransactionalMessageAccepted> {
  const deps = activeDeps(depsInput);
  return dispatchTemplate(
    'auth_otp',
    input.phone,
    buildAuthOtpTemplate(input.code),
    deps
  );
}

export async function sendOnboardingWelcome(
  input: OnboardingWelcomeInput,
  depsInput?: TransactionalOnboardingMessageDeps
): Promise<TransactionalMessageAccepted> {
  const deps = activeDeps(depsInput);
  return dispatchTemplate(
    'onboarding_welcome',
    input.phone,
    buildOnboardingWelcomeTemplate(),
    deps
  );
}

function sendErrorResponse(error: unknown, res: Response): void {
  if (error instanceof TransactionalMessageError) {
    if (error.retryAfter) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    res.status(error.statusCode).json({
      ok: false,
      status:
        error.reason === 'provider_outcome_unknown' ? 'unknown' : 'rejected',
      reason: error.reason,
    });
    return;
  }

  Sentry.captureException(
    new Error('transactional onboarding endpoint failed'),
    {
      tags: {
        service: 'transactional-onboarding-messages',
        operation: 'endpoint',
        error_kind: runtimeErrorKind(error),
      },
    }
  );
  res.status(500).json({ ok: false, status: 'rejected', reason: 'internal_error' });
}

export async function authOtpEndpoint(
  req: Request,
  res: Response
): Promise<void> {
  const input = parseAuthOtpInput(req.body);
  if (!input) {
    res.status(400).json({
      ok: false,
      status: 'rejected',
      reason: 'invalid_payload',
    });
    return;
  }

  try {
    res.status(200).json(await sendAuthenticationOtp(input));
  } catch (error) {
    sendErrorResponse(error, res);
  }
}

export async function onboardingWelcomeEndpoint(
  req: Request,
  res: Response
): Promise<void> {
  const input = parseOnboardingWelcomeInput(req.body);
  if (!input) {
    res.status(400).json({
      ok: false,
      status: 'rejected',
      reason: 'invalid_payload',
    });
    return;
  }

  try {
    res.status(200).json(await sendOnboardingWelcome(input));
  } catch (error) {
    sendErrorResponse(error, res);
  }
}
