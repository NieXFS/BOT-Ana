import { isExplicitBookingConfirmation } from './bookingConfirmationGate';

type ConversationMessage = {
  role: string;
  content?: unknown;
};

export type SalesToolTraceLike = {
  name: string;
  result: string;
};

export type SalesToolGuardDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'email_confirmation_required';
      hintMessage: string;
    };

export type SalesReplyClaimReason =
  | 'empty_response'
  | 'internal_hint'
  | 'unconfigured_price'
  | 'required_handoff_missing'
  | 'required_schedule_demo_missing'
  | 'required_prefill_missing'
  | 'required_common_signup_missing'
  | 'required_demo_video_missing'
  | 'required_lgpd_answer_missing'
  | 'required_paused_plan_explanation_missing'
  | 'required_simulation_offer_missing'
  | 'handoff_without_success'
  | 'signup_link_without_result'
  | 'terminal_signup_delivery_failed'
  | 'prefill_claim_without_success'
  | 'demo_video_without_success'
  | 'scheduled_demo_without_success';

export interface SalesReplyClaimInspection {
  safe: boolean;
  reasons: SalesReplyClaimReason[];
  hintMessage: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? [candidate.text]
        : [];
    })
    .join('\n');
}

function conversationalMessages(
  history: ConversationMessage[]
): Array<{ role: string; text: string }> {
  return history
    .map((message) => ({
      role: message.role,
      text: contentText(message.content),
    }))
    .filter((message) => message.text.trim().length > 0);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function emailsIn(text: string): string[] {
  return (text.match(EMAIL_RE) ?? []).map((email) => email.toLowerCase());
}

function asksToConfirmEmail(text: string, email: string): boolean {
  const normalized = normalize(text);
  return (
    normalized.includes(email) &&
    /\b(?:confirma|confirmar|confirmando|certo|certinh[oa]|correto|esta certo|ta certo)\b/.test(
      normalized
    )
  );
}

function explicitlyConfirmsEmail(text: string, email: string): boolean {
  const normalized = normalize(text);
  if (
    /\b(?:nao|corrig|troca|muda|na verdade|mas|outro email|e-mail errado)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  const emails = emailsIn(text);
  if (emails.some((candidate) => candidate !== email)) return false;
  if (
    emails.includes(email) &&
    /\b(?:sim|certo|correto|confirmo|confirmado|isso mesmo|pode mandar|manda ver)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  return isExplicitBookingConfirmation(text);
}

/**
 * Evidência de confirmação vem somente da conversa: idealmente a Renata repetiu
 * o e-mail e um inbound posterior confirmou; também vale a própria lead repetir
 * o endereço exato com confirmação inequívoca. Informar o e-mail e pedir o link
 * no primeiro turno nunca autoriza o prefill.
 */
export function hasConfirmedSalesEmail(
  emailValue: unknown,
  history: ConversationMessage[]
): boolean {
  const email = normalizeEmail(emailValue);
  if (!email) return false;
  const messages = conversationalMessages(history);

  // Fallback autoritativo: a própria lead repetiu o endereço exato e o
  // confirmou explicitamente. Isso cobre perguntas genéricas do modelo sem
  // aceitar o primeiro envio do e-mail como confirmação implícita.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role !== 'user' ||
      !emailsIn(message.text).includes(email) ||
      !/\b(?:sim|certo|correto|confirmo|confirmado|isso mesmo|esta certo|ta certo)\b/.test(
        normalize(message.text)
      ) ||
      !explicitlyConfirmsEmail(message.text, email)
    ) {
      continue;
    }
    const invalidated = messages
      .slice(index + 1)
      .filter((candidate) => candidate.role === 'user')
      .some((candidate) => {
        const laterEmails = emailsIn(candidate.text);
        return laterEmails.some((laterEmail) => laterEmail !== email);
      });
    if (!invalidated) return true;
  }

  for (let index = 0; index < messages.length - 1; index += 1) {
    const proposal = messages[index];
    if (
      proposal.role !== 'assistant' ||
      !asksToConfirmEmail(proposal.text, email)
    ) {
      continue;
    }

    const confirmation = messages[index + 1];
    if (
      confirmation.role !== 'user' ||
      !explicitlyConfirmsEmail(confirmation.text, email)
    ) {
      continue;
    }

    const laterUserTexts = messages
      .slice(index + 2)
      .filter((message) => message.role === 'user')
      .map((message) => message.text);
    const invalidated = laterUserTexts.some((text) => {
      const normalized = normalize(text);
      const laterEmails = emailsIn(text);
      return (
        laterEmails.some((candidate) => candidate !== email) ||
        (/\b(?:corrig|troca|muda|na verdade|email errado|e-mail errado)\b/.test(
          normalized
        ) && laterEmails.length > 0)
      );
    });
    if (!invalidated) return true;
  }
  return false;
}

export function authorizeSalesToolCall(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  history: ConversationMessage[];
}): SalesToolGuardDecision {
  if (input.toolName !== 'sendPrefilledSignup') return { ok: true };
  if (hasConfirmedSalesEmail(input.toolInput.email, input.history)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'email_confirmation_required',
    hintMessage:
      'INTERNAL_HINT: o link pré-preenchido NÃO foi gerado porque o e-mail ainda não tem confirmação inequívoca em um turno posterior. Repita o e-mail exato para a lead, pergunte se está correto e aguarde a resposta. Correção de e-mail exige uma nova confirmação; não prometa que enviou link.',
  };
}

function parsedResult(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function salesToolSucceeded(
  trace: SalesToolTraceLike[],
  name: string
): boolean {
  return trace.some(
    (entry) =>
      entry.name === name && parsedResult(entry.result)?.success === true
  );
}

function toolHadAuthorizedAttempt(
  trace: SalesToolTraceLike[],
  name: string
): boolean {
  return trace.some((entry) => {
    if (entry.name !== name) return false;
    return parsedResult(entry.result)?.code !== 'email_confirmation_required';
  });
}

function hasDeliveredSignupLink(trace: SalesToolTraceLike[]): boolean {
  return trace.some((entry) => {
    if (
      entry.name !== 'sendSignupLink' &&
      entry.name !== 'sendPrefilledSignup'
    ) {
      return false;
    }
    const result = parsedResult(entry.result);
    return Boolean(
      result &&
        (result.success === true ||
          typeof result.url === 'string' ||
          typeof result.waitlistHref === 'string')
    );
  });
}

function hasDeliveredPrefilledSignup(trace: SalesToolTraceLike[]): boolean {
  return trace.some((entry) => {
    if (entry.name !== 'sendPrefilledSignup') return false;
    const result = parsedResult(entry.result);
    return result?.success === true && result.prefilled !== false;
  });
}

function toolAttemptedWithoutSuccess(
  trace: SalesToolTraceLike[],
  name: string
): boolean {
  return trace.some((entry) => entry.name === name) &&
    !salesToolSucceeded(trace, name);
}

function priceTokens(text: string): string[] {
  return (text.match(/R\$\s*[\d.]+(?:,\d{2})?/gi) ?? []).map((value) =>
    value.replace(/\s+/g, '').replace(/^r\$/i, '').toLowerCase()
  );
}

function userMentionedPriceTokens(text: string): string[] {
  return (text.match(/(?:R\$\s*)?[\d.]+,\d{2}/gi) ?? []).map((value) =>
    value.replace(/\s+/g, '').replace(/^r\$/i, '').toLowerCase()
  );
}

function hasCompletedHandoffClaim(normalized: string): boolean {
  return /\b(?:ja (?:acionei|chamei|passei|transferi)|acionei|transferi|passei (?:voce|vc|te)|vou (?:te )?(?:passar|transferir)|vou chamar (?:o )?victor|deixa (?:eu )?(?:te passar|chamar (?:o )?victor)|victor (?:vai )?te responde)\b/.test(
    normalized
  );
}

function requiresHandoff(history: ConversationMessage[]): boolean {
  const latestUser = conversationalMessages(history)
    .filter((message) => message.role === 'user')
    .at(-1)?.text;
  if (!latestUser) return false;
  const normalized = normalize(latestUser);
  const explicitHuman =
    /\b(?:quero|preciso|prefiro|posso).{0,35}\b(?:falar|conversar).{0,25}\b(?:pessoa|humano|atendente|victor)\b/.test(
      normalized
    );
  const negotiation =
    /\b(?:desconto|negociar|negociacao|condicao especial|contraoferta)\b/.test(
      normalized
    ) ||
    /\b(?:faz|fizer|fecha|fechar|deixa|deixar|consegue).{0,45}(?:r\$\s*)?\d{2,}(?:[.,]\d{2})?\b/.test(
      normalized
    );
  return explicitHuman || negotiation;
}

function timeValues(text: string): number[] {
  return [...text.matchAll(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:([0-5]\d))?)\b/gi)]
    .map((match) => Number(match[1]) * 60 + Number(match[2] ?? match[3] ?? 0));
}

function requiresScheduleDemo(history: ConversationMessage[]): boolean {
  const messages = conversationalMessages(history);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex <= 0) return false;
  const userTimes = timeValues(messages[latestUserIndex].text);
  if (userTimes.length === 0) return false;
  const priorAssistant = [...messages.slice(0, latestUserIndex)]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!priorAssistant) return false;
  const assistantTimes = timeValues(priorAssistant.text);
  return (
    assistantTimes.length >= 2 &&
    userTimes.some((time) => assistantTimes.includes(time)) &&
    /\b(?:demo|demonstracao|horarios?|agenda)\b/.test(
      normalize(priorAssistant.text)
    )
  );
}

function requiresPrefilledSignup(history: ConversationMessage[]): boolean {
  const messages = conversationalMessages(history);
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .join('\n');
  const normalized = normalize(userText);
  const latestUser = normalize(
    messages.filter((message) => message.role === 'user').at(-1)?.text ?? ''
  );
  // A intenção comercial precisa estar no pedido atual, com plano e e-mail
  // confirmados no contexto. Isso inclui "Quero o Essencial" seguido de
  // "Pode gerar agora", sem confundir curiosidade sobre o produto com compra.
  const hasBuyingSignal =
    /\b(?:quero (?:contratar|assinar)|(?:pode|consegue|ja pode)\s+gerar(?:\s+(?:o\s+)?(?:link|cadastro))?(?:\s+agora)?|(?:pode|consegue|ja pode)\s+(?:mandar|enviar)(?:\s+(?:o\s+)?(?:link|cadastro))?|manda\s+(?:o\s+)?(?:link|cadastro)|envia\s+(?:o\s+)?(?:link|cadastro)|(?:pode|consegue|ja pode)\s+(?:seguir|prosseguir)\s+(?:com\s+)?(?:o\s+)?cadastro)\b/.test(
      latestUser
    );
  const hasKnownPlan = /\b(?:essencial|pro)\b/.test(normalized);
  return (
    hasBuyingSignal &&
    hasKnownPlan &&
    emailsIn(userText).some((email) => hasConfirmedSalesEmail(email, history))
  );
}

function singleKnownPlanFromHistory(
  history: ConversationMessage[]
): 'essencial' | 'pro' | null {
  const plans = [
    ...new Set(
      conversationalMessages(history)
        .filter((message) => message.role === 'user')
        .flatMap((message) => normalize(message.text).match(/\b(?:essencial|pro)\b/g) ?? [])
    ),
  ].filter(
    (plan): plan is 'essencial' | 'pro' =>
      plan === 'essencial' || plan === 'pro'
  );
  return plans.length === 1 ? plans[0] : null;
}

/**
 * Link comum só é obrigatório quando a pessoa recusa o e-mail no inbound
 * atual, pede explicitamente o cadastro/link normal e já escolheu um único
 * plano. Isso não transforma curiosidade, mera recusa ou comparação entre
 * planos em intenção de compra.
 */
function requiresCommonSignupLink(history: ConversationMessage[]): boolean {
  const latestUser = normalize(
    conversationalMessages(history)
      .filter((message) => message.role === 'user')
      .at(-1)?.text ?? ''
  );
  const explicitlyRefusesEmail =
    /\b(?:nao\s+(?:quero\s+)?(?:passar|informar|dar|usar)|prefiro\s+nao\s+(?:passar|informar|dar|usar)|sem)\s+(?:o\s+)?e-?mail\b/.test(
      latestUser
    );
  const explicitlyRequestsCommonSignup =
    /\b(?:manda|envia|(?:pode|consegue|ja pode)\s+(?:mandar|enviar)|quero)\s+(?:o\s+)?(?:link|cadastro)(?:\s+normal)?\b/.test(
      latestUser
    );
  return (
    explicitlyRefusesEmail &&
    explicitlyRequestsCommonSignup &&
    singleKnownPlanFromHistory(history) !== null
  );
}

export function resolveRequiredCommonSignup(
  history: ConversationMessage[]
): { plan: 'essencial' | 'pro' } | null {
  const plan = singleKnownPlanFromHistory(history);
  return requiresCommonSignupLink(history) && plan ? { plan } : null;
}

/**
 * O prefill pode falhar sem encerrar a venda: nesse caso ainda existe o link
 * comum como alternativa. Mas, se as duas entregas já falharam, o modelo não
 * pode encerrar prometendo uma nova tentativa. A única saída segura é o
 * handoff confirmado por código.
 */
function requiresTerminalSignupHandoff(
  trace: SalesToolTraceLike[],
  history: ConversationMessage[]
): boolean {
  const noDeliveryOrHandoff =
    !hasDeliveredSignupLink(trace) &&
    !salesToolSucceeded(trace, 'handoffToHuman');
  const failedPrefillAndCommonLink =
    toolAttemptedWithoutSuccess(trace, 'sendPrefilledSignup') &&
    toolAttemptedWithoutSuccess(trace, 'sendSignupLink');
  const failedRequiredCommonLink =
    requiresCommonSignupLink(history) &&
    toolAttemptedWithoutSuccess(trace, 'sendSignupLink');
  return noDeliveryOrHandoff && (failedPrefillAndCommonLink || failedRequiredCommonLink);
}

export function requiresImmediateTerminalHandoff(
  reasons: readonly SalesReplyClaimReason[]
): boolean {
  return reasons.includes('terminal_signup_delivery_failed');
}

function requiresDemoVideo(history: ConversationMessage[]): boolean {
  const latestUser = conversationalMessages(history)
    .filter((message) => message.role === 'user')
    .at(-1)?.text;
  if (!latestUser) return false;
  const normalized = normalize(latestUser);
  return (
    /\bvideo\b/.test(normalized) &&
    /\b(?:prefiro|quero|manda|mandar|envia|enviar|assistir)\b/.test(normalized)
  );
}

function latestUserText(history: ConversationMessage[]): string {
  return (
    conversationalMessages(history)
      .filter((message) => message.role === 'user')
      .at(-1)?.text ?? ''
  );
}

export function isPausedAiPlanRequest(
  history: ConversationMessage[]
): boolean {
  const latest = normalize(latestUserText(history));
  return (
    /\b(?:somente atendente ia|plano (?:so|apenas) (?:da )?ana|ana (?:de|por) 99[,.]99)\b/.test(
      latest
    ) ||
    /\b(?:quero|contratar|assinar|manda).{0,35}\b(?:so|apenas)\b.{0,20}\b(?:ana|atendente)\b/.test(
      latest
    )
  );
}

export function resolveConfirmedSalesPrefill(
  history: ConversationMessage[]
): {
  email: string;
  plan: 'essencial' | 'pro';
  track: 'flexivel' | 'fidelidade';
} | null {
  const userMessages = conversationalMessages(history).filter(
    (message) => message.role === 'user'
  );
  const userText = userMessages.map((message) => message.text).join('\n');
  const confirmedEmails = [
    ...new Set(
      emailsIn(userText).filter((email) =>
        hasConfirmedSalesEmail(email, history)
      )
    ),
  ];
  const plans = [
    ...new Set(
      normalize(userText).match(/\b(?:essencial|pro)\b/g) ?? []
    ),
  ].filter(
    (plan): plan is 'essencial' | 'pro' =>
      plan === 'essencial' || plan === 'pro'
  );
  if (confirmedEmails.length !== 1 || plans.length !== 1) return null;

  // Ausência de escolha explícita preserva o default técnico flexivel (Mensal).
  // Procura a mensagem mais recente que nomeia uma opção, aceitando também os
  // nomes antigos; se ela menciona as duas, falha fechado. "Anual à vista"
  // continua sendo a oferta legada aposentada e nunca autoriza fidelidade.
  let track: 'flexivel' | 'fidelidade' = 'flexivel';
  for (const message of [...userMessages].reverse()) {
    const normalized = normalize(message.text);
    const mentionsMonthly = /\b(?:mensal|flexivel)\b/.test(normalized);
    const mentionsAnnual = /\b(?:anual|fidelidade)\b/.test(normalized);
    const requestsLegacyAnnual =
      /\banual\b.{0,24}\b(?:a vista|adiantad[oa]|pago (?:de uma vez|integralmente))\b/.test(
        normalized
      );
    if (requestsLegacyAnnual) return null;
    if (mentionsMonthly && mentionsAnnual) return null;
    if (mentionsAnnual) {
      track = 'fidelidade';
      break;
    }
    if (mentionsMonthly) break;
  }
  return { email: confirmedEmails[0], plan: plans[0], track };
}

export function buildDeterministicSalesGuardReply(
  reasons: readonly SalesReplyClaimReason[],
  history: ConversationMessage[]
): string | null {
  if (
    isPausedAiPlanRequest(history) &&
    (reasons.includes('required_paused_plan_explanation_missing') ||
      reasons.includes('unconfigured_price'))
  ) {
    return 'O plano Somente Atendente IA está em atualização e não aceita novas assinaturas no momento. O Essencial já inclui a Ana funcionando no WhatsApp, além da agenda e do financeiro. Quer que eu te mostre esse caminho?';
  }
  return null;
}

export function inspectSalesReplyActionClaims(
  reply: string,
  trace: SalesToolTraceLike[],
  history: ConversationMessage[] = [],
  options: { priceAuthorityText?: string } = {}
): SalesReplyClaimInspection {
  const normalized = normalize(reply);
  const reasons = new Set<SalesReplyClaimReason>();

  if (!normalized) reasons.add('empty_response');
  if (/internal_hint/i.test(reply)) reasons.add('internal_hint');
  const authorizedPrices = new Set(
    priceTokens(options.priceAuthorityText ?? '')
  );
  const userPrices = new Set(
    userMentionedPriceTokens(
      conversationalMessages(history)
        .filter((message) => message.role === 'user')
        .map((message) => message.text)
        .join('\n')
    )
  );
  const explicitlyRejectsPriceOrPlan =
    /\b(?:pausad\w*|indisponiv\w*|nao.{0,30}(?:preco|valor|assin\w*|disponiv\w*|vend\w*)|valor que voce mencionou|valor mencionado)\b/.test(
      normalized
    );
  if (
    priceTokens(reply).some(
      (price) =>
        !authorizedPrices.has(price) &&
        !(userPrices.has(price) && explicitlyRejectsPriceOrPlan)
    )
  ) {
    reasons.add('unconfigured_price');
  }
  if (
    requiresHandoff(history) &&
    !salesToolSucceeded(trace, 'handoffToHuman')
  ) {
    reasons.add('required_handoff_missing');
  }
  if (
    requiresScheduleDemo(history) &&
    !salesToolSucceeded(trace, 'scheduleDemo')
  ) {
    reasons.add('required_schedule_demo_missing');
  }
  if (
    requiresPrefilledSignup(history) &&
    !toolHadAuthorizedAttempt(trace, 'sendPrefilledSignup')
  ) {
    reasons.add('required_prefill_missing');
  }
  if (
    requiresCommonSignupLink(history) &&
    !toolHadAuthorizedAttempt(trace, 'sendSignupLink')
  ) {
    reasons.add('required_common_signup_missing');
  }
  if (requiresTerminalSignupHandoff(trace, history)) {
    reasons.add('terminal_signup_delivery_failed');
  }
  if (
    requiresDemoVideo(history) &&
    !salesToolSucceeded(trace, 'sendDemoVideo')
  ) {
    reasons.add('required_demo_video_missing');
  }
  const latestUser = normalize(latestUserText(history));
  if (
    /\b(?:lgpd|dados (?:das )?(?:minhas )?clientes.{0,20}seguros?|seguranca dos dados)\b/.test(
      latestUser
    ) &&
    !/\b(?:lgpd|protecao de dados|privacidade|politica de privacidade)\b/.test(
      normalized
    )
  ) {
    reasons.add('required_lgpd_answer_missing');
  }
  if (
    isPausedAiPlanRequest(history) &&
    !/\b(?:atualiza\w*|pausad\w*|indisponiv\w*|lista de interesse|nao.{0,25}(?:assin\w*|disponiv\w*|vend\w*))\b/.test(
      normalized
    )
  ) {
    reasons.add('required_paused_plan_explanation_missing');
  }
  if (
    /\b(?:ver|testar|mostrar).{0,25}\bana\b|\bana.{0,25}(?:funcionando|antes de decidir)\b/.test(
      latestUser
    ) &&
    !/\b(?:simula|finge que voce|quer ver a ana|cliente sua)\b/.test(
      normalized
    )
  ) {
    reasons.add('required_simulation_offer_missing');
  }
  if (
    hasCompletedHandoffClaim(normalized) &&
    !salesToolSucceeded(trace, 'handoffToHuman')
  ) {
    reasons.add('handoff_without_success');
  }

  const claimsLinkDelivery =
    /\b(?:te mandei (?:aqui )?(?:o )?link|ja enviei (?:aqui )?(?:o )?link|segue (?:aqui )?(?:o )?link|link (?:esta|ta) (?:aqui )?embaixo|aqui esta (?:o )?link)\b/.test(
      normalized
    );
  if (claimsLinkDelivery && !hasDeliveredSignupLink(trace)) {
    reasons.add('signup_link_without_result');
  }

  const mentionsPrefillBenefit =
    /\b(?:dados (?:todos )?(?:preenchidos|prontos)|ja vem (?:com )?(?:seus )?dados|so (?:precisa )?criar (?:a )?senha|voce so cria (?:a )?senha)\b/.test(
      normalized
    );
  const claimsDeliveredPrefill =
    mentionsPrefillBenefit &&
    (claimsLinkDelivery ||
      hasDeliveredSignupLink(trace) ||
      toolAttemptedWithoutSuccess(trace, 'sendPrefilledSignup') ||
      /\b(?:pronto|prontinho|agora sim|confirmado|gerei|enviei|mandei|esta aqui|ta aqui)\b/.test(
        normalized
      ));
  if (
    claimsDeliveredPrefill &&
    !hasDeliveredPrefilledSignup(trace)
  ) {
    reasons.add('prefill_claim_without_success');
  }

  if (
    /\b(?:video (?:ja )?(?:foi )?enviado|te mandei (?:o )?video|enviei (?:o )?video)\b/.test(
      normalized
    ) &&
    !salesToolSucceeded(trace, 'sendDemoVideo')
  ) {
    reasons.add('demo_video_without_success');
  }

  if (
    /\b(?:demo|demonstracao).{0,35}\b(?:agendada|marcada|confirmada)\b/.test(
      normalized
    ) &&
    !salesToolSucceeded(trace, 'scheduleDemo')
  ) {
    reasons.add('scheduled_demo_without_success');
  }

  const list = [...reasons];
  return {
    safe: list.length === 0,
    reasons: list,
    hintMessage:
      list.length === 0
        ? null
        : `INTERNAL_HINT: sua resposta afirmou uma ação ou preço sem fonte autoritativa (${list.join(
            ', '
          )}). Não envie essa resposta. Use somente preços presentes em PLANOS. Cumpra o requisito agora: explique que o plano Somente Atendente IA está pausado quando esse foi o pedido; responda LGPD no mesmo turno; convide imediatamente para a simulação pedida; ou chame a ferramenta necessária — handoffToHuman para negociação/pedido de humano, scheduleDemo para horário escolhido, sendPrefilledSignup após compra/plano/e-mail confirmado e sendDemoVideo quando ela pediu o vídeo. Se a ferramenta falhar, explique a falha com acolhimento e sem dizer que a ação aconteceu.`,
  };
}

export function normalizeSalesReplyStyle(reply: string): string {
  let emojiSeen = false;
  return reply
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '_$1_')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu, (emoji) => {
      if (emojiSeen) return '';
      emojiSeen = true;
      return emoji;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NON_BLOCKING_QUESTION_RE =
  /(?:tudo bem|quer ver|sabe por que|faz sentido|ne|legal ne|bom ne)$/;

/**
 * Conta perguntas que pedem respostas distintas. Interjeições retóricas curtas
 * ("tudo bem?", "quer ver?") não viram uma segunda pergunta quando a mesma
 * mensagem também contém uma pergunta substantiva; sozinhas continuam valendo
 * como uma pergunta.
 */
export function countActionableSalesQuestions(reply: string): number {
  const questions = reply
    .split('?')
    .slice(0, -1)
    .map((segment) => {
      const clause = segment.split(/[.!\n]/).at(-1) ?? segment;
      return normalize(clause).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    })
    .filter(Boolean);
  if (questions.length <= 1) return questions.length;
  const actionable = questions.filter(
    (question) => !NON_BLOCKING_QUESTION_RE.test(question)
  );
  return Math.max(1, actionable.length);
}

export function isThinkingOnlyResponse(input: {
  stopReason: string | null | undefined;
  contentTypes: string[];
  text: string;
}): boolean {
  return (
    !input.text.trim() &&
    input.stopReason === 'max_tokens' &&
    input.contentTypes.includes('thinking')
  );
}

export function buildSafeSalesRecoveryReply(
  trace: SalesToolTraceLike[],
  fallback: string
): string {
  if (salesToolSucceeded(trace, 'handoffToHuman')) {
    return 'Pronto, já acionei o Victor para continuar com você por aqui.';
  }
  if (hasDeliveredPrefilledSignup(trace)) {
    return 'Prontinho! Te mandei o link com seus dados preenchidos — você só cria a senha. Se precisar, fico por aqui com você.';
  }
  if (hasDeliveredSignupLink(trace)) {
    return 'Prontinho! Te mandei o link do cadastro. Se precisar, fico por aqui com você.';
  }
  if (salesToolSucceeded(trace, 'sendDemoVideo')) {
    return 'Prontinho! O vídeo foi enviado. Depois me conta o que você achou.';
  }
  if (salesToolSucceeded(trace, 'scheduleDemo')) {
    return 'Pronto, sua demonstração foi agendada com sucesso.';
  }
  return fallback;
}
