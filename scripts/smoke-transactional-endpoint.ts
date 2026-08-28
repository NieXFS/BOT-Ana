/** HTTP real local; sender/config mockados. Nenhuma chamada à Meta/ERP/DB. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'development';
process.env.RECEPS_IA_SKIP_BOOT = '1';
process.env.DATABASE_URL = 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN = 'transactional-smoke-bearer';
process.env.RECEPS_BOT_WEBHOOK_SECRET =
  'transactional-smoke-hmac-secret-at-least-32-chars';
process.env.RECEPS_INTERNAL_API_URL = 'http://127.0.0.1:1';

function signature(body: string): string {
  return (
    'sha256=' +
    crypto
      .createHmac(
        'sha256',
        process.env.RECEPS_BOT_WEBHOOK_SECRET!
      )
      .update(Buffer.from(body))
      .digest('hex')
  );
}

function postJson(input: {
  port: number;
  path: string;
  body: string;
  bearer?: string;
  signatureHeader?: string;
}): Promise<{ status: number; body: string; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(input.body),
    };
    if (input.bearer !== undefined) {
      headers.authorization = `Bearer ${input.bearer}`;
    }
    if (input.signatureHeader !== undefined) {
      headers['x-bot-signature'] = input.signatureHeader;
    }

    const request = http.request(
      {
        host: '127.0.0.1',
        port: input.port,
        path: input.path,
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            retryAfter:
              typeof response.headers['retry-after'] === 'string'
                ? response.headers['retry-after']
                : undefined,
          });
        });
      }
    );
    request.once('error', reject);
    request.end(input.body);
  });
}

async function main(): Promise<void> {
  const security = await import('../src/security');
  const transactional = await import(
    '../src/services/transactionalOnboardingMessages'
  );
  const serverModule = await import('../src/webhookServer');

  let transportCalls = 0;
  transactional.__setTransactionalOnboardingMessageDepsForTest({
    resolveSenderConfig: async () => ({
      phoneNumberId: '123456789',
      waAccessToken: 'mock-access-token',
      waApiVersion: 'v21.0',
    }),
    sendTemplate: async () => {
      transportCalls += 1;
      return { providerMessageId: 'wamid-never-return-this' };
    },
    consumeLimit: security.consumeRateLimit,
  });

  const server = await new Promise<http.Server>((resolve) => {
    const started = serverModule.app.listen(0, '127.0.0.1', () =>
      resolve(started)
    );
  });
  const port = (server.address() as AddressInfo).port;
  const otpCode = '482913';
  const phone = '+5511999999999';
  const otpBody = JSON.stringify({ phone, code: otpCode });
  const signedRequest = (path: string, body: string) =>
    postJson({
      port,
      path,
      body,
      bearer: process.env.ERP_API_TOKEN,
      signatureHeader: signature(body),
    });

  try {
    const noBearer = await postJson({
      port,
      path: '/internal/auth/otp',
      body: otpBody,
      signatureHeader: signature(otpBody),
    });
    assert.equal(noBearer.status, 401);
    assert.equal(transportCalls, 0);

    const badBearer = await postJson({
      port,
      path: '/internal/auth/otp',
      body: otpBody,
      bearer: 'wrong-token',
      signatureHeader: signature(otpBody),
    });
    assert.equal(badBearer.status, 401);
    assert.equal(transportCalls, 0);

    const noSignature = await postJson({
      port,
      path: '/internal/auth/otp',
      body: otpBody,
      bearer: process.env.ERP_API_TOKEN,
    });
    assert.equal(noSignature.status, 401);
    assert.equal(transportCalls, 0);

    const invalidPayloads = [
      JSON.stringify({ phone: '5511999999999', code: otpCode }),
      JSON.stringify({ phone, code: 'code-raw' }),
      JSON.stringify({ phone, code: otpCode, tenantId: 'forbidden' }),
    ];
    for (const body of invalidPayloads) {
      const response = await signedRequest('/internal/auth/otp', body);
      assert.equal(response.status, 400);
      assert.equal(response.body.includes(otpCode), false);
      assert.equal(response.body.includes(phone), false);
    }
    assert.equal(transportCalls, 0);

    const success = await signedRequest('/internal/auth/otp', otpBody);
    assert.equal(success.status, 200);
    const successJson = JSON.parse(success.body) as Record<string, unknown>;
    assert.equal(successJson.ok, true);
    assert.equal(successJson.kind, 'auth_otp');
    assert.equal(success.body.includes(otpCode), false);
    assert.equal(success.body.includes(phone), false);
    assert.equal(success.body.includes('wamid'), false);
    assert.equal(transportCalls, 1);

    const welcomeBody = JSON.stringify({ phone });
    const welcome = await signedRequest(
      '/internal/onboarding/welcome',
      welcomeBody
    );
    assert.equal(welcome.status, 200);
    assert.equal(
      (JSON.parse(welcome.body) as Record<string, unknown>).kind,
      'onboarding_welcome'
    );
    assert.equal(welcome.body.includes(phone), false);
    assert.equal(transportCalls, 2);

    security.resetRateLimitStore();
    transportCalls = 0;
    for (let index = 0; index < transactional.AUTH_OTP_RATE_LIMIT; index += 1) {
      assert.equal(
        (await signedRequest('/internal/auth/otp', otpBody)).status,
        200
      );
    }
    const limited = await signedRequest('/internal/auth/otp', otpBody);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.retryAfter) >= 1);
    assert.equal(limited.body.includes(otpCode), false);
    assert.equal(limited.body.includes(phone), false);
    assert.equal(
      transportCalls,
      transactional.AUTH_OTP_RATE_LIMIT,
      'rate limit bloqueia antes do transporte'
    );

    console.log(
      'smoke transactional endpoint: Bearer+HMAC, payload estrito, resposta redigida e rate limit local OK'
    );
  } finally {
    transactional.__setTransactionalOnboardingMessageDepsForTest();
    security.resetRateLimitStore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
