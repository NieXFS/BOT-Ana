/**
 * Contrato HTTP das tools de onboarding contra Express local. Offline: não usa
 * Receps real, DB, Anthropic, Meta nem WhatsApp.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.ERP_API_TOKEN =
  process.env.ERP_API_TOKEN ?? 'smoke-onboarding-token';

import express from 'express';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';

type Captured = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  authorization?: string;
};

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

/**
 * Passa a chamada do Axios pelo listener real do Express, mas usa objetos HTTP
 * em memória. É o equivalente offline de `app.listen(0)` em sandboxes que
 * proíbem até socket loopback.
 */
function expressAdapter(
  app: ReturnType<typeof express>
): AxiosAdapter {
  return async (
    config: InternalAxiosRequestConfig
  ): Promise<AxiosResponse> =>
    new Promise<AxiosResponse>((resolve, reject) => {
      const responseChunks: Buffer[] = [];
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          responseChunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          );
          callback();
        },
      });
      const requestUrl = new URL(
        config.url ?? '/',
        'http://express.local'
      );
      if (config.params && typeof config.params === 'object') {
        for (const [key, value] of Object.entries(config.params)) {
          if (value !== undefined && value !== null) {
            requestUrl.searchParams.set(key, String(value));
          }
        }
      }

      const request = new IncomingMessage(socket);
      request.method = (config.method ?? 'get').toUpperCase();
      request.url = `${requestUrl.pathname}${requestUrl.search}`;
      const requestHeaders = config.headers.toJSON();
      request.headers = Object.fromEntries(
        Object.entries(requestHeaders).map(([key, value]) => [
          key.toLowerCase(),
          String(value),
        ])
      );

      const requestBody =
        typeof config.data === 'string'
          ? config.data
          : config.data === undefined
            ? ''
            : JSON.stringify(config.data);
      if (requestBody) {
        request.headers['content-length'] = String(
          Buffer.byteLength(requestBody)
        );
      }

      const response = new ServerResponse(request);
      response.assignSocket(socket);
      response.once('finish', () => {
        const raw = Buffer.concat(responseChunks);
        const separator = raw.indexOf('\r\n\r\n');
        const bodyBuffer =
          separator >= 0 ? raw.subarray(separator + 4) : raw;
        const rawBody = bodyBuffer.toString('utf8');
        let data: unknown = rawBody;
        try {
          data = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          // Mantém texto cru; o contrato em teste usa JSON.
        }
        const axiosResponse: AxiosResponse = {
          data,
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.getHeaders(),
          config,
          request,
        };
        const validateStatus = config.validateStatus;
        if (
          !validateStatus ||
          validateStatus(axiosResponse.status)
        ) {
          resolve(axiosResponse);
          return;
        }
        reject(
          new AxiosError(
            `Request failed with status code ${axiosResponse.status}`,
            axiosResponse.status >= 500
              ? AxiosError.ERR_BAD_RESPONSE
              : AxiosError.ERR_BAD_REQUEST,
            config,
            request,
            axiosResponse
          )
        );
      });
      response.once('error', reject);
      app(request, response);
      request.push(requestBody || null);
      if (requestBody) request.push(null);
    });
}

async function main(): Promise<void> {
  const captured: Captured[] = [];
  let nextFailure:
    | { status: number; reason: string; extra?: Record<string, unknown> }
    | null = null;

  const state = {
    session: {
      id: 'session-1',
      stage: 'welcome',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'OPEN',
      derivedStage: 'services',
    },
    tenant: {
      name: 'Clínica Smoke',
      segment: 'CLINICA_ESTETICA',
      planSlug: 'essencial',
      maxProfessionals: 2,
      professionalsActive: 1,
      setupCompletedAt: null,
    },
    catalog: {
      servicesCount: 1,
      seedServicesCount: 1,
      services: [
        {
          id: 'seed-1',
          name: 'Limpeza',
          durationMinutes: 60,
          price: 180,
          isSeed: true,
        },
      ],
    },
    schedule: {
      openingTime: '08:00',
      closingTime: '20:00',
      slotIntervalMinutes: 30,
      scheduleLocked: false,
    },
    whatsapp: {
      connected: false,
      coexistence: false,
      connectedAt: null,
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    captured.push({
      path: req.path,
      method: req.method,
      body:
        req.body && typeof req.body === 'object'
          ? req.body
          : {},
      query: req.query,
      authorization: req.get('authorization'),
    });
    if (nextFailure) {
      const failure = nextFailure;
      nextFailure = null;
      res.status(failure.status).json({
        error: 'mock error',
        reason: failure.reason,
        ...failure.extra,
      });
      return;
    }
    next();
  });

  app.get('/api/v1/bot/onboarding/session', (_req, res) => {
    res.json(state);
  });
  app.post('/api/v1/bot/onboarding/claim', (_req, res) => {
    res.json(state);
  });
  app.post('/api/v1/bot/onboarding/service', (_req, res) => {
    res.json({
      ok: true,
      service: {
        id: 'service-1',
        name: 'Limpeza de pele',
        durationMinutes: 60,
        price: 180,
      },
      action: 'created',
    });
  });
  app.post('/api/v1/bot/onboarding/schedule', (_req, res) => {
    res.json({
      ok: true,
      applied: {
        openingTime: '09:00',
        closingTime: '19:00',
        slotIntervalMinutes: 30,
      },
      blocks: {
        dayOffSeries: 1,
        lunchSeries: 5,
        blocksCreated: 312,
        skippedConflicts: 0,
      },
    });
  });
  app.post('/api/v1/bot/onboarding/professional', (_req, res) => {
    res.json({
      ok: true,
      professional: { id: 'professional-1', name: 'Camila' },
      accessPending: true,
      remainingSlots: 0,
    });
  });
  app.post('/api/v1/bot/onboarding/clinic-info', (_req, res) => {
    res.json({ ok: true, updatedFields: ['name', 'city'] });
  });
  app.post('/api/v1/bot/onboarding/complete', (_req, res) => {
    res.json({
      ok: true,
      completedAt: new Date().toISOString(),
      status: 'COMPLETED',
    });
  });
  app.get(
    '/api/v1/bot/onboarding/whatsapp-status',
    (_req, res) => {
      res.json({
        ready: false,
        connected: false,
        coexistence: false,
        connectedAt: null,
        source: null,
        pollBudgetHint: 20,
      });
    }
  );

  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = expressAdapter(app);
  process.env.RECEPS_INTERNAL_API_URL = 'http://express.local';

  const sessionModule = await import(
    '../src/services/onboardingSession'
  );
  const tools = await import('../src/services/onboardingTools');
  const phone = '5516999998888';
  const claimCode = 'ABCDE23456';

  console.log('▶ sessão, claim e leituras');
  sessionModule.__resetOnboardingSessionCacheForTest();
  const lookup = await sessionModule.getOnboardingSessionResult(phone);
  const cachedLookup =
    await sessionModule.getOnboardingSessionResult(phone);
  check(
    'GET /session devolve estado aberto',
    lookup.kind === 'open' &&
      lookup.state.session.derivedStage === 'services'
  );
  check(
    'cache positivo de 60s evita segundo GET',
    cachedLookup.kind === 'open' &&
      captured.filter(
        (request) =>
          request.path === '/api/v1/bot/onboarding/session'
      ).length === 1
  );
  const claim = await sessionModule.claimOnboardingSession(
    phone,
    claimCode
  );
  check('POST /claim devolve o mesmo estado', claim.success);
  const lookupAfterClaim =
    await sessionModule.getOnboardingSessionResult(phone);
  check(
    'claim bem-sucedido invalida o cache',
    lookupAfterClaim.kind === 'open' &&
      captured.filter(
        (request) =>
          request.path === '/api/v1/bot/onboarding/session'
      ).length === 2
  );
  const status = await tools.getWhatsappStatus(phone);
  check(
    'GET /whatsapp-status preserva pollBudgetHint',
    status.success && status.status.pollBudgetHint === 20
  );

  console.log('▶ cinco escritas e bodies finais');
  const service = await tools.executeOnboardingWrite(
    'upsertService',
    phone,
    {
      name: 'Limpeza de pele',
      durationMin: 60,
      price: 180,
      replaceServiceId: 'seed-1',
    }
  );
  const schedule = await tools.executeOnboardingWrite(
    'setSchedule',
    phone,
    {
      openingTime: '09:00',
      closingTime: '19:00',
      slotIntervalMinutes: 30,
      closedWeekdays: [0],
      lunch: { start: '12:00', end: '13:00' },
    }
  );
  const professional = await tools.executeOnboardingWrite(
    'addProfessional',
    phone,
    { name: 'Camila', specialty: 'Esteticista' }
  );
  const clinic = await tools.executeOnboardingWrite(
    'updateClinicInfo',
    phone,
    {
      businessName: 'Clínica Smoke',
      city: 'Franca',
      cnpj: 'proibido',
    }
  );
  const complete = await tools.executeOnboardingWrite(
    'completeOnboarding',
    phone,
    {}
  );
  check(
    'as cinco rotas retornam success',
    [service, schedule, professional, clinic, complete].every(
      (result) => result.success
    )
  );

  const writeRequests = captured.filter(
    (request) =>
      request.method === 'POST' &&
      request.path !== '/api/v1/bot/onboarding/claim'
  );
  check(
    'toda escrita manda confirmed:true',
    writeRequests.every(
      (request) => request.body.confirmed === true
    )
  );
  check(
    'customerPhone é injetado e tenant nunca é enviado',
    writeRequests.every(
      (request) =>
        request.body.customerPhone === phone &&
        !('tenantId' in request.body) &&
        !('tenantSlug' in request.body)
    )
  );
  const clinicRequest = captured.find(
    (request) =>
      request.path === '/api/v1/bot/onboarding/clinic-info'
  );
  check(
    'clinic-info filtra campo fora do contrato',
    clinicRequest !== undefined && !('cnpj' in clinicRequest.body)
  );
  check(
    'Bearer correto em todas as rotas',
    captured.every(
      (request) =>
        request.authorization === 'Bearer smoke-onboarding-token'
    )
  );
  check(
    'todas as 8 rotas HTTP foram exercitadas',
    [
      '/api/v1/bot/onboarding/session',
      '/api/v1/bot/onboarding/claim',
      '/api/v1/bot/onboarding/service',
      '/api/v1/bot/onboarding/schedule',
      '/api/v1/bot/onboarding/professional',
      '/api/v1/bot/onboarding/clinic-info',
      '/api/v1/bot/onboarding/complete',
      '/api/v1/bot/onboarding/whatsapp-status',
    ].every((path) =>
      captured.some((request) => request.path === path)
    )
  );
  check(
    'sendConnectLink usa URL canônica sem HTTP novo',
    tools.connectLinkResult().success &&
      JSON.stringify(tools.connectLinkResult()).includes(
        'https://app.receps.com.br/atendente-ia'
      )
  );

  console.log('▶ códigos de erro finais viram orientação útil');
  const reasons = [
    'no_session',
    'session_closed',
    'ambiguous_session',
    'confirmation_required',
    'replace_not_allowed',
    'catalog_limit',
    'schedule_already_set',
    'schedule_unavailable',
    'professional_limit',
    'professional_exists',
    'not_ready',
    'validation_error',
    'invalid_json',
    'rate_limited',
    'audit_failed',
    'unauthorized',
    'auth_unavailable',
    'internal_error',
  ];
  for (const reason of reasons) {
    nextFailure = {
      status:
        reason === 'no_session'
          ? 404
          : reason === 'session_closed'
            ? 410
            : reason === 'ambiguous_session'
              ? 409
              : reason === 'rate_limited'
                ? 429
                : reason === 'unauthorized'
                  ? 401
                  : reason === 'internal_error' ||
                      reason === 'audit_failed' ||
                      reason === 'auth_unavailable'
                    ? 500
                    : reason === 'validation_error' ||
                        reason === 'invalid_json'
                      ? 400
                      : 422,
      reason,
      ...(reason === 'not_ready'
        ? { extra: { missing: ['services', 'schedule'] } }
        : {}),
    };
    const result = await tools.executeOnboardingWrite(
      'upsertService',
      phone,
      {
        name: 'Teste seguro',
        durationMin: 30,
        price: 10,
      }
    );
    check(
      `${reason}: reason preservado + fala útil`,
      !result.success &&
        result.reason === reason &&
        result.message.length > 20 &&
        !result.message.includes('mock error')
    );
  }

  console.log('▶ erros específicos de claim');
  nextFailure = { status: 404, reason: 'invalid_code' };
  const invalidClaim = await sessionModule.claimOnboardingSession(
    phone,
    claimCode
  );
  check(
    'invalid_code não revela existência da sessão',
    !invalidClaim.success &&
      invalidClaim.reason === 'invalid_code' &&
      invalidClaim.message.includes('não foi aceito')
  );
  nextFailure = {
    status: 409,
    reason: 'code_already_claimed',
  };
  const claimedElsewhere =
    await sessionModule.claimOnboardingSession(phone, claimCode);
  check(
    'code_already_claimed tem orientação específica',
    !claimedElsewhere.success &&
      claimedElsewhere.reason === 'code_already_claimed'
  );

  console.log('▶ cache negativo');
  sessionModule.__resetOnboardingSessionCacheForTest();
  const sessionRequestsBeforeNegative = captured.filter(
    (request) =>
      request.path === '/api/v1/bot/onboarding/session'
  ).length;
  nextFailure = { status: 404, reason: 'no_session' };
  const negativeFirst =
    await sessionModule.getOnboardingSessionResult(phone);
  const negativeCached =
    await sessionModule.getOnboardingSessionResult(phone);
  check(
    'no_session também fica em cache por 60s',
    negativeFirst.kind === 'none' &&
      negativeCached.kind === 'none' &&
      captured.filter(
        (request) =>
          request.path === '/api/v1/bot/onboarding/session'
      ).length ===
        sessionRequestsBeforeNegative + 1
  );

  console.log('▶ transporte nunca entrega AxiosError cru ao Sentry');
  const capturedErrors: Error[] = [];
  tools.__setOnboardingCaptureSinkForTest((error) => {
    capturedErrors.push(error);
  });
  axios.defaults.adapter = async (config) => {
    throw new AxiosError(
      'synthetic network failure',
      AxiosError.ERR_NETWORK,
      config
    );
  };
  const network = await tools.executeOnboardingWrite(
    'updateClinicInfo',
    phone,
    {
      businessName: 'Clínica com PII',
      phone,
      address: 'Rua Segredo 123',
    }
  );
  check(
    'falha de rede não lança e volta mensagem sintética',
    !network.success && network.reason === 'network'
  );
  const serializedCapture = capturedErrors
    .map((error) => `${error.name}:${error.message}:${error.stack ?? ''}`)
    .join('\n');
  check(
    'Sentry recebe Error sintético, nunca telefone/endereço/código',
    capturedErrors.length === 1 &&
      !serializedCapture.includes(phone) &&
      !serializedCapture.includes('Rua Segredo') &&
      !serializedCapture.includes(claimCode) &&
      !serializedCapture.includes('AxiosError')
  );
  tools.__setOnboardingCaptureSinkForTest(null);
  axios.defaults.adapter = originalAdapter;

  if (failures > 0) {
    throw new Error(
      `smoke-onboarding-tools falhou: ${failures} check(s)`
    );
  }
  console.log('\n✅ smoke-onboarding-tools OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
