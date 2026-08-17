type ConversationMessage = {
  role: string;
  content?: unknown;
};

export type SalesToolTraceLike = {
  name: string;
  result: string;
};

export type SalesPlan = 'essencial' | 'pro';
export type SalesTrack = 'flexivel' | 'fidelidade';

export interface SalesCommercialDecision {
  plan: SalesPlan;
  track: SalesTrack;
  evidenceIndex: number;
}

export type SalesToolGuardDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'email_confirmation_required' | 'commercial_decision_mismatch';
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
  | 'signup_url_missing_from_reply'
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

function withoutEdgePunctuation(text: string): string {
  return text
    .replace(/^[.!?,;:\s]+|[.!?,;:\s]+$/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

const POSITIVE_CONFIRMATION_EMOJI_RE =
  /^(?:👍[\u{1F3FB}-\u{1F3FF}]?|🆗|👌[\u{1F3FB}-\u{1F3FF}]?)$/u;

const EMAIL_PROPOSAL_CUE_RE =
  /\b(?:confirma(?:r|ndo)?|certo|certinh[oa]|corret[oa]|(?:esta|ta)\s+(?:certo|certinh[oa]|corret[oa]))\b/;

const EMAIL_WITH_ADDRESS_CONFIRMATION_RE =
  /\b(?:sim|certo|certinh[oa]|correto|confirmo|confirmado|isso mesmo|esta certo|ta certo)\b/;

const EMAIL_REPLY_AFFIRMATION_RE =
  /\b(?:sim|certo|certinh[oa]|corret[oa]|(?:esta|ta)\s+(?:certo|certinh[oa]|corret[oa])|tudo\s+cert(?:o|inh[oa])|(?:esta|ta)\s+tudo\s+cert(?:o|inh[oa])|confirmo|confirmado|isso(?:\s+mesmo)?|perfeito|exato|aham|uhum|pode\s+mandar|sim\s+pode|pode\s+sim|ja\s+confirmei|beleza|blz|show|fechado|combinado|ta\s+bom)\b/;

const EMAIL_SHORT_CONFIRMATION_RE =
  /^(?:(?:sim|ok|okay|certo(?:\s+mesmo)?|certinh[oa]|(?:ta|esta)\s+cert(?:o|inh[oa])|corret[oa]|confirmo|confirmado|perfeito|exato|aham|uhum|isso(?:\s+mesmo)?|e\s+isso|tudo\s+cert(?:o|inh[oa])|(?:esta|ta)\s+tudo\s+cert(?:o|inh[oa])|beleza|blz|show|fechado|combinado|ta\s+(?:bom|otimo))(?:\s*,?\s*(?:sim|pode|mandar|por favor|isso(?:\s+mesmo)?|tudo\s+cert(?:o|inh[oa])))*|pode\s+sim|sim\s+pode|pode\s+mandar|ja\s+confirmei|nao\s*,\s*ta\s+certo)$/u;

const EMAIL_CLOSED_CONFIRMATION_RE =
  /(?:^|[.!?,;]\s*)(?:pode mandar(?:\s+(?:o\s+)?link)?|ja confirmei|(?:ta|esta)\s+certinh[oa]|nao precisa (?:perguntar|confirmar) de (?:novo|novamente))(?:$|[.!?,;])/;

function hasLeadingAdversativeEmailConfirmation(text: string): boolean {
  const match = text.match(
    /^(.+?)(?:\s*[,;:—-]\s*|\s+)(?:mas|porem|so que)\s+\S/u
  );
  return (
    match !== null &&
    EMAIL_SHORT_CONFIRMATION_RE.test(withoutEdgePunctuation(match[1]))
  );
}

function hasEmailCorrectionSignal(text: string): boolean {
  const normalized = normalize(text);
  return (
    /\bnao\b.{0,45}\b(?:errado|esse|email|e-mail)\b/.test(normalized) ||
    /\bnao\s+(?:(?:esta|ta)\s+)?(?:tudo\s+)?(?:cert(?:o|inh[oa])|corret[oa])\b/.test(
      normalized
    ) ||
    /\b(?:corrig\w*|troq\w*|mud\w*|confere\w*|na verdade|errado|incorret\w*)\b/.test(
      normalized
    )
  );
}

function isExplicitEmailCorrection(text: string): boolean {
  const normalized = normalize(text);
  if (!hasEmailCorrectionSignal(text)) return false;
  return (
    /\b(?:e-?mail|endereco)\b/.test(normalized) ||
    emailsIn(text).length > 0 ||
    /\b(?:esse|ele)\b/.test(normalized)
  );
}

function emailConfirmationWindow(text: string, email: string): string | null {
  const normalized = normalize(text);
  const emailIndex = normalized.indexOf(email);
  if (emailIndex < 0) return null;

  // Mascara os pontos internos do e-mail para que só pontuação de frase/cláusula
  // determine a janela final da proposta.
  const masked = `${normalized.slice(0, emailIndex)}${' '.repeat(
    email.length
  )}${normalized.slice(emailIndex + email.length)}`;
  let start = 0;
  let end = normalized.length;
  for (const match of masked.matchAll(/[.!?;\n]/g)) {
    const boundary = match.index ?? 0;
    if (boundary < emailIndex) {
      start = boundary + 1;
    } else {
      end = boundary;
      break;
    }
  }
  return normalized.slice(start, end);
}

/**
 * Reconhece somente uma proposta dedicada de confirmação do e-mail. Uma
 * pergunta sobre outra coisa na mesma mensagem, ou uma confirmação distante
 * do endereço, não licencia respostas curtas no turno seguinte.
 */
export function isDedicatedEmailConfirmationProposal(
  text: string,
  emailValue: string
): boolean {
  const email = normalizeEmail(emailValue);
  if (!email) return false;
  const emails = emailsIn(text);
  if (emails.length !== 1 || emails[0] !== email) return false;
  if (countActionableSalesQuestions(text) > 1) return false;
  const window = emailConfirmationWindow(text, email);
  return window !== null && EMAIL_PROPOSAL_CUE_RE.test(window);
}

/**
 * Classificador único da confirmação de e-mail da lead. Ele é deliberadamente
 * independente do gate de confirmação de agendamento da Ana.
 */
export function classifyEmailConfirmationReply(
  text: string,
  emailValue: string
): boolean {
  const email = normalizeEmail(emailValue);
  if (!email) return false;

  const normalized = normalize(text);
  if (!normalized) return false;

  const emails = emailsIn(text);
  if (emails.some((candidate) => candidate !== email)) return false;
  if (hasEmailCorrectionSignal(text)) return false;

  const compact = withoutEdgePunctuation(normalized);
  if (POSITIVE_CONFIRMATION_EMOJI_RE.test(compact)) return true;
  if (EMAIL_SHORT_CONFIRMATION_RE.test(compact)) return true;
  if (hasLeadingAdversativeEmailConfirmation(normalized)) return true;

  const hasOwnEmail = emails.includes(email);
  return (
    (hasOwnEmail && EMAIL_REPLY_AFFIRMATION_RE.test(normalized)) ||
    EMAIL_CLOSED_CONFIRMATION_RE.test(normalized)
  );
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
    const messageEmails = emailsIn(message.text);
    if (
      message.role !== 'user' ||
      !messageEmails.includes(email) ||
      messageEmails.some((candidate) => candidate !== email) ||
      !EMAIL_WITH_ADDRESS_CONFIRMATION_RE.test(normalize(message.text)) ||
      hasEmailCorrectionSignal(message.text)
    ) {
      continue;
    }
    const invalidated = messages
      .slice(index + 1)
      .filter((candidate) => candidate.role === 'user')
      .some((candidate) => {
        const laterEmails = emailsIn(candidate.text);
        return (
          laterEmails.some((laterEmail) => laterEmail !== email) ||
          isExplicitEmailCorrection(candidate.text)
        );
      });
    if (!invalidated) return true;
  }

  for (let index = 0; index < messages.length - 1; index += 1) {
    const proposal = messages[index];
    if (proposal.role !== 'assistant') continue;
    const dedicatedProposal = isDedicatedEmailConfirmationProposal(
      proposal.text,
      email
    );
    const hasAnyProposalEmail = emailsIn(proposal.text).length > 0;
    if (!dedicatedProposal && !hasAnyProposalEmail) {
      continue;
    }
    if (!dedicatedProposal && !emailsIn(proposal.text).includes(email)) {
      continue;
    }

    const confirmation = messages[index + 1];
    if (
      confirmation.role !== 'user' ||
      !classifyEmailConfirmationReply(confirmation.text, email) ||
      (!dedicatedProposal && !emailsIn(confirmation.text).includes(email))
    ) {
      continue;
    }

    const laterUserTexts = messages
      .slice(index + 2)
      .filter((message) => message.role === 'user')
      .map((message) => message.text);
    const invalidated = laterUserTexts.some((text) => {
      const laterEmails = emailsIn(text);
      return (
        laterEmails.some((candidate) => candidate !== email) ||
        isExplicitEmailCorrection(text)
      );
    });
    if (!invalidated) return true;
  }
  return false;
}

export const EMAIL_CONFIRMATION_REQUIRED_HINT =
  'INTERNAL_HINT: o link pré-preenchido NÃO foi gerado porque o e-mail ainda não tem confirmação inequívoca em um turno posterior. Faça uma única proposta dedicada com o e-mail exato e aguarde uma resposta afirmativa da lead (por exemplo: "Certo", "Tá certinho", "Sim pode", "Pode mandar" ou "Já confirmei"); não exija que ela repita o e-mail. Correção de e-mail exige uma nova confirmação; não prometa que enviou link.';

const COMMERCIAL_DECISION_MISMATCH_HINT =
  'INTERNAL_HINT: plano/modalidade da ferramenta diverge da decisão comercial vigente da lead. Use o plano e o track já escolhidos; recusa nunca resolve para o plano recusado. Não gere o link de um plano que ela recusou.';

const LEGACY_ANNUAL_RE =
  /\banual\b.{0,24}\b(?:a vista|adiantad[oa]|pago (?:de uma vez|integralmente))\b/;
const CHOOSE_PLAN_CUE_RE =
  /\b(?:quero|prefiro|escolho|fecho|fechar|assinar|contratar|pode ser|fica com|ficar com|vou de|fica no|vou querer|vou ficar(?:\s+com)?|vamos de|vamos fechar)\b/;
const EPISTEMIC_QUERO_RE =
  /\b(?:quero|queria)\s+(?:(?:uma|uns|umas)\s+)?(?:saber|entender|conhecer|ver|olhar|comparar|pensar|informac(?:ao|oes)|explicac(?:ao|oes)|detalhes)\b/;
const EXPLORE_PLAN_CUE_RE =
  /\b(?:tambem|tbm)\b.{0,40}\b(?:olhei|olhando|vi|vendo|consultei|verifiquei|dei uma olhada)\b|\bvou\s+pensar\b|\bcompar(?:ar|o|ando)\b/;
const INDECISION_PLAN_CUE_RE =
  /\b(?:estou entre|nao sei|em duvida|ainda nao decidi|nao decidi)\b/;
const QUESTION_STARTER_RE =
  /\b(?:qual|quais|como|quanto|quando|onde|por que|porque|o que|quem)\b/;
const PLAN_QUESTION_BODY_RE =
  /\b(?:tem|tinha|inclui|cobre|vem com|aceita|faz|prontuario|diferenca|desconto)\b/;
const CONJOINED_PLANS_RE =
  /\b(?:essencial|pro)\b.{0,48}\b(?:e|ou)\b(?!\s+(?:quero|queria|prefiro|escolho|nao|nunca|nem|assinar|contratar|fecho|fechar|vou|vamos))\s*(?:o\s+|a\s+|plano\s+)?(?:essencial|pro)\b/;
const CLAUSE_SHIFT_RE =
  /\b(?:e|mas)\s+(?=quero|queria|prefiro|escolho|fecho|fechar|assinar|contratar|nao|nunca|nem|vou\b|vamos\b|pode ser|fica(?:r)?(?:\s+com)?)/g;
const CONTRASTIVE_CHOICE_CUE =
  '(?:quero|prefiro|escolho|fecho|fechar|assinar|contratar|pode ser|fica com|ficar com|vou de|fica no|vou querer|vamos de|vamos fechar)';
const CONTRASTIVE_PLAN_RE = new RegExp(
  `\\b${CONTRASTIVE_CHOICE_CUE}\\b.{0,40}\\b(essencial|pro)\\b.{0,40}\\bnao\\b.{0,24}\\b(essencial|pro)\\b`
);
const CONTRASTIVE_TRACK_RE = new RegExp(
  `\\b${CONTRASTIVE_CHOICE_CUE}\\b.{0,40}\\b(mensal|flexivel|anual|fidelidade)\\b.{0,40}\\bnao\\b.{0,24}\\b(mensal|flexivel|anual|fidelidade)\\b`
);
const TRACK_ATTACH_RE = /\b(?:no|na|em)\s*$/;
const UNRELATED_NEGATION_HEAD_RE =
  /^(?:tenho\s+(?:duvidas?|objec(?:ao|oes)|certeza)|ha\s+(?:duvidas?|objec(?:ao|oes)|problema))\b/;
const EXPLORATORY_NEGATION_HEAD_RE = /^(?:sei|decidi)\b/;
const EPISTEMIC_QUERO_HEAD_RE = new RegExp(
  `^(?:quero|queria)\\s+(?:(?:uma|uns|umas)\\s+)?(?:saber|entender|conhecer|ver|olhar|comparar|pensar|informac(?:ao|oes)|explicac(?:ao|oes)|detalhes)\\b`
);
const COMMERCIAL_REFUSAL_HEAD_RE =
  /^(?:da(?:\s+para|\s+pra)?\s+)?(?:(?:vou|vamos)\s+)?(?:quero|queria|prefiro|escolho|assino|assinar|contrato|contratar|fecho|fechar|ficar(?:\s+com)?)\b/;
const COMMERCIAL_REFUSAL_MODAL_RE =
  /^(?:da(?:\s+para|\s+pra)|vou|vamos)\s+(?:contratar|assinar|fechar|querer|ficar|de)\b/;
const COMMERCIAL_REFUSAL_BARE_RE = /^(?:(?:e|eh)\s*)?(?:o|a|plano)?$/;

function isSalesPlan(value: string): value is SalesPlan {
  return value === 'essencial' || value === 'pro';
}

function mentionedPlans(text: string): SalesPlan[] {
  const found = [...text.matchAll(/\b(essencial|pro)\b/g)]
    .map((match) => match[1] ?? '')
    .filter((plan): plan is SalesPlan => isSalesPlan(plan));
  return [...new Set(found)];
}

function localClausePrefix(haystack: string, start: number): string {
  const before = haystack.slice(0, start);
  CLAUSE_SHIFT_RE.lastIndex = 0;
  let shiftBoundary = -1;
  for (const match of before.matchAll(CLAUSE_SHIFT_RE)) {
    if (match.index == null) continue;
    shiftBoundary = match.index + match[0].length - 1;
  }
  const boundary = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf(';'),
    before.lastIndexOf(':'),
    before.lastIndexOf('\n'),
    before.lastIndexOf(','),
    shiftBoundary
  );
  return before.slice(boundary + 1);
}

interface UserPlanPolarity {
  chosen: SalesPlan[];
  refused: SalesPlan[];
  comparisonWithoutWinner: boolean;
  exercisedChoiceOrRefusal: boolean;
}

function lastNegationRemainder(prefix: string): string | null {
  const matches = [...prefix.matchAll(/\b(?:nao|nunca|nem)\b/g)];
  const last = matches.at(-1);
  if (!last || last.index == null) return null;
  return prefix.slice(last.index + last[0].length);
}

function remainderIsUnrelatedNegation(after: string): boolean {
  return UNRELATED_NEGATION_HEAD_RE.test(after.trim());
}

function remainderIsExploratoryNegation(after: string): boolean {
  const trimmed = after.trim();
  return (
    EXPLORATORY_NEGATION_HEAD_RE.test(trimmed) ||
    EPISTEMIC_QUERO_HEAD_RE.test(trimmed)
  );
}

function remainderIsCommercialRefusal(after: string): boolean {
  const trimmed = after.trim();
  if (remainderIsExploratoryNegation(trimmed)) return false;
  if (remainderIsUnrelatedNegation(trimmed)) return false;
  return (
    COMMERCIAL_REFUSAL_BARE_RE.test(trimmed) ||
    COMMERCIAL_REFUSAL_HEAD_RE.test(trimmed) ||
    COMMERCIAL_REFUSAL_MODAL_RE.test(trimmed)
  );
}

/** Recusa comercial do item que segue o prefixo; `não` de dúvida/saber/objeção não conta. */
function prefixRefusesMention(prefix: string): boolean {
  const after = lastNegationRemainder(prefix);
  return after != null && remainderIsCommercialRefusal(after);
}

function contrastivePlanChoice(
  normalized: string
): { chosen: SalesPlan; refused: SalesPlan } | null {
  const match = normalized.match(CONTRASTIVE_PLAN_RE);
  if (!match || match.index == null) return null;
  const chosen = match[1];
  const refused = match[2];
  if (
    !chosen ||
    !refused ||
    !isSalesPlan(chosen) ||
    !isSalesPlan(refused) ||
    chosen === refused
  ) {
    return null;
  }
  const firstPlanRel = match[0].search(/\b(?:essencial|pro)\b/);
  if (firstPlanRel < 0) return null;
  const prefix = localClausePrefix(normalized, match.index + firstPlanRel);
  if (
    prefixExploresPlan(prefix) ||
    prefixRefusesMention(prefix) ||
    !prefixChoosesPlan(prefix)
  ) {
    return null;
  }
  return { chosen, refused };
}

function isPlanQuestion(
  prefix: string,
  suffix: string,
  hasQuestionMark: boolean
): boolean {
  if (QUESTION_STARTER_RE.test(prefix)) return true;
  if (!hasQuestionMark) return false;
  if (CHOOSE_PLAN_CUE_RE.test(prefix) && !EPISTEMIC_QUERO_RE.test(prefix)) {
    return false;
  }
  if (prefixRefusesMention(prefix)) return false;
  return PLAN_QUESTION_BODY_RE.test(suffix) || prefix.trim().length <= 3;
}

function prefixExploresPlan(prefix: string): boolean {
  if (
    EXPLORE_PLAN_CUE_RE.test(prefix) ||
    EPISTEMIC_QUERO_RE.test(prefix) ||
    INDECISION_PLAN_CUE_RE.test(prefix)
  ) {
    return true;
  }
  const after = lastNegationRemainder(prefix);
  return after != null && remainderIsExploratoryNegation(after);
}

function prefixChoosesPlan(prefix: string): boolean {
  return (
    CHOOSE_PLAN_CUE_RE.test(prefix) &&
    !EPISTEMIC_QUERO_RE.test(prefix) &&
    !prefixExploresPlan(prefix) &&
    !prefixRefusesMention(prefix)
  );
}

function isAnchoredShortPlanReply(text: string): SalesPlan | null {
  if (/\?/.test(text)) return null;
  const compact = withoutEdgePunctuation(normalize(text));
  const match = compact.match(/^(?:o\s+|plano\s+)?(essencial|pro)$/);
  const plan = match?.[1];
  return plan && isSalesPlan(plan) ? plan : null;
}

function userPlanPolarity(text: string): UserPlanPolarity {
  const shortPlan = isAnchoredShortPlanReply(text);
  if (shortPlan) {
    return {
      chosen: [shortPlan],
      refused: [],
      comparisonWithoutWinner: false,
      exercisedChoiceOrRefusal: true,
    };
  }

  const normalized = normalize(text);
  const contrastive = contrastivePlanChoice(normalized);
  if (contrastive) {
    return {
      chosen: [contrastive.chosen],
      refused: [contrastive.refused],
      comparisonWithoutWinner: false,
      exercisedChoiceOrRefusal: true,
    };
  }

  const plans = mentionedPlans(normalized);
  const comparisonWithoutWinner =
    plans.length >= 2 &&
    (CONJOINED_PLANS_RE.test(normalized) ||
      INDECISION_PLAN_CUE_RE.test(normalized) ||
      /\bcompar(?:ar|o|ando)\b/.test(normalized));
  if (comparisonWithoutWinner) {
    return {
      chosen: [],
      refused: [],
      comparisonWithoutWinner: true,
      exercisedChoiceOrRefusal: false,
    };
  }

  const hasQuestionMark = /\?/.test(text);
  const chosen = new Set<SalesPlan>();
  const refused = new Set<SalesPlan>();
  const mentions: Array<{ plan: SalesPlan; start: number; end: number }> = [];
  for (const match of normalized.matchAll(/\b(essencial|pro)\b/g)) {
    const plan = match[1] ?? '';
    if (!isSalesPlan(plan)) continue;
    const start = match.index ?? 0;
    mentions.push({ plan, start, end: start + match[0].length });
  }

  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index];
    const prefix = localClausePrefix(normalized, mention.start);
    const suffixEnd =
      index + 1 < mentions.length
        ? mentions[index + 1].start
        : normalized.length;
    const suffix = normalized.slice(mention.end, suffixEnd);

    if (prefixExploresPlan(prefix)) {
      continue;
    }
    if (prefixRefusesMention(prefix)) {
      refused.add(mention.plan);
      continue;
    }
    if (isPlanQuestion(prefix, suffix, hasQuestionMark)) {
      continue;
    }
    if (prefixChoosesPlan(prefix)) {
      chosen.add(mention.plan);
    }
  }

  const uniqueChosen = [...chosen].filter((plan) => !refused.has(plan));

  return {
    chosen: uniqueChosen.length === 1 ? uniqueChosen : [],
    refused: [...refused],
    comparisonWithoutWinner: uniqueChosen.length > 1,
    exercisedChoiceOrRefusal: uniqueChosen.length === 1 || refused.size > 0,
  };
}

function tokenToTrack(token: string): SalesTrack | null {
  if (token === 'mensal' || token === 'flexivel') return 'flexivel';
  if (token === 'anual' || token === 'fidelidade') return 'fidelidade';
  return null;
}

function mentionedTracks(text: string): SalesTrack[] {
  const found = [...text.matchAll(/\b(mensal|flexivel|anual|fidelidade)\b/g)]
    .map((match) => tokenToTrack(match[1] ?? ''))
    .filter((track): track is SalesTrack => track !== null);
  return [...new Set(found)];
}

interface UserTrackPolarity {
  chosen: SalesTrack | null;
  refused: SalesTrack[];
  comparisonWithoutWinner: boolean;
  questionOrExplore: boolean;
  legacy: boolean;
}

function contrastiveTrackChoice(
  normalized: string
): { chosen: SalesTrack; refused: SalesTrack } | null {
  const match = normalized.match(CONTRASTIVE_TRACK_RE);
  if (!match || match.index == null) return null;
  const chosen = tokenToTrack(match[1] ?? '');
  const refused = tokenToTrack(match[2] ?? '');
  if (!chosen || !refused || chosen === refused) return null;
  const firstTrackRel = match[0].search(
    /\b(?:mensal|flexivel|anual|fidelidade)\b/
  );
  if (firstTrackRel < 0) return null;
  const prefix = localClausePrefix(normalized, match.index + firstTrackRel);
  if (
    prefixExploresPlan(prefix) ||
    prefixRefusesMention(prefix) ||
    !prefixChoosesPlan(prefix)
  ) {
    return null;
  }
  return { chosen, refused };
}

function userTrackPolarity(text: string): UserTrackPolarity {
  const normalized = normalize(text);
  if (LEGACY_ANNUAL_RE.test(normalized)) {
    return {
      chosen: null,
      refused: [],
      comparisonWithoutWinner: false,
      questionOrExplore: false,
      legacy: true,
    };
  }

  const contrastive = contrastiveTrackChoice(normalized);
  if (contrastive) {
    return {
      chosen: contrastive.chosen,
      refused: [contrastive.refused],
      comparisonWithoutWinner: false,
      questionOrExplore: false,
      legacy: false,
    };
  }

  const hasQuestionMark = /\?/.test(text);
  const refused: SalesTrack[] = [];
  let chosen: SalesTrack | null = null;
  let questionOrExplore = false;
  const uniqueTracks = mentionedTracks(normalized);

  for (const match of normalized.matchAll(
    /\b(mensal|flexivel|anual|fidelidade)\b/g
  )) {
    const track = tokenToTrack(match[1] ?? '');
    if (!track) continue;
    const start = match.index ?? 0;
    const prefix = localClausePrefix(normalized, start);
    const trimmedPrefix = prefix.trim();
    const suffix = normalized.slice(start + match[0].length);

    if (prefixExploresPlan(prefix)) {
      questionOrExplore = true;
      continue;
    }
    if (prefixRefusesMention(prefix)) {
      refused.push(track);
      continue;
    }
    if (
      QUESTION_STARTER_RE.test(prefix) ||
      (hasQuestionMark &&
        !prefixChoosesPlan(prefix) &&
        !TRACK_ATTACH_RE.test(trimmedPrefix))
    ) {
      questionOrExplore = true;
      continue;
    }
    if (PLAN_QUESTION_BODY_RE.test(suffix) && hasQuestionMark) {
      questionOrExplore = true;
      continue;
    }
    if (
      prefixChoosesPlan(prefix) ||
      TRACK_ATTACH_RE.test(trimmedPrefix) ||
      (/^(?:o\s+|a\s+)?$/.test(trimmedPrefix) &&
        suffix.replace(/[.!?,;:\s]+/g, '').length === 0)
    ) {
      chosen = track;
    }
  }

  const uniqueRefused = [...new Set(refused)];
  if (chosen && uniqueRefused.includes(chosen)) {
    chosen = null;
  }

  const comparisonWithoutWinner =
    uniqueTracks.length >= 2 &&
    chosen == null &&
    uniqueRefused.length < uniqueTracks.length;

  return {
    chosen,
    refused: uniqueRefused,
    comparisonWithoutWinner,
    questionOrExplore,
    legacy: false,
  };
}

function assistantFallbackPlan(text: string): SalesPlan | null {
  const plans = mentionedPlans(normalize(text));
  return plans.length === 1 ? plans[0] : null;
}

/** Modalidade nomeada na proposta dedicada da Renata, sem polaridade de pergunta. */
function assistantFallbackTrack(
  text: string
): SalesTrack | 'conflict' | 'legacy' | null {
  const normalized = normalize(text);
  if (LEGACY_ANNUAL_RE.test(normalized)) return 'legacy';
  const tracks = mentionedTracks(normalized);
  if (tracks.length >= 2) return 'conflict';
  return tracks.length === 1 ? tracks[0] : null;
}

function isDirectModalityQuestion(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  // Menção da trilha aposentada na fala da Renata não é sinal da lead e não
  // desqualifica a pergunta direta de modalidade no mesmo turno.
  const questionText = normalized.replace(LEGACY_ANNUAL_RE, ' ');
  const tracks = mentionedTracks(questionText);
  if (!tracks.includes('flexivel') || !tracks.includes('fidelidade')) {
    return false;
  }
  const hasPreferenceCue =
    /\b(?:prefere|preferem|preferencia|escolhe|escolher|escolha)\b/.test(
      questionText
    );
  const hasBinaryOr =
    /\b(?:mensal|flexivel)\b.{0,48}\bou\b.{0,48}\b(?:anual|fidelidade)\b/.test(
      questionText
    ) ||
    /\b(?:anual|fidelidade)\b.{0,48}\bou\b.{0,48}\b(?:mensal|flexivel)\b/.test(
      questionText
    );
  if (!hasPreferenceCue && !(hasBinaryOr && /\?/.test(text))) return false;
  return countActionableSalesQuestions(text) <= 1;
}

function precedingDirectModalityQuestion(
  history: ConversationMessage[],
  beforeIndex: number
): boolean {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = history[index];
    const text = contentText(message.content);
    if (!text.trim()) continue;
    return message.role === 'assistant' && isDirectModalityQuestion(text);
  }
  return false;
}

function trackForNewPlanChoice(
  text: string,
  trackPolarity: UserTrackPolarity
): SalesTrack | null {
  if (trackPolarity.legacy || trackPolarity.comparisonWithoutWinner) {
    return null;
  }
  if (trackPolarity.questionOrExplore) return 'flexivel';
  const mentioned = mentionedTracks(normalize(text));
  const onlyMentioned: SalesTrack | undefined = mentioned[0];
  const attached: SalesTrack | null =
    trackPolarity.chosen ??
    (mentioned.length === 1 &&
    onlyMentioned &&
    !trackPolarity.refused.includes(onlyMentioned)
      ? onlyMentioned
      : null);
  const nextTrack: SalesTrack = attached ?? 'flexivel';
  if (trackPolarity.refused.includes(nextTrack) && trackPolarity.chosen == null) {
    return null;
  }
  return nextTrack;
}

/**
 * Plano e modalidade como uma única decisão versionada. Recusa nunca resolve
 * para o plano recusado; pergunta, exploração e comparação sem vencedor não
 * sobrescrevem a escolha vigente. evidenceIndex é o índice no `history`
 * original, inclusive entradas vazias. Modalidade aposentada (anual à vista)
 * não fecha decisão no próprio turno; só a resposta explícita à pergunta
 * direta de modalidade da Renata recompõe o plano vigente ainda não recusado.
 */
export function resolveSalesCommercialDecision(
  history: ConversationMessage[]
): SalesCommercialDecision | null {
  let decision: SalesCommercialDecision | null = null;
  let pendingPlan: SalesPlan | null = null;
  let leadExercisedChoiceOrRefusal = false;

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    const text = contentText(message.content);
    if (!text.trim()) continue;

    if (message.role === 'user') {
      const polarity = userPlanPolarity(text);
      const trackPolarity = userTrackPolarity(text);

      if (polarity.exercisedChoiceOrRefusal) {
        leadExercisedChoiceOrRefusal = true;
      }

      if (trackPolarity.legacy) {
        const chosenPlan: SalesPlan | undefined = polarity.chosen[0];
        if (polarity.chosen.length === 1 && chosenPlan) {
          pendingPlan = chosenPlan;
        } else if (decision) {
          pendingPlan = decision.plan;
        }
        if (pendingPlan && polarity.refused.includes(pendingPlan)) {
          pendingPlan = null;
        }
        decision = null;
        continue;
      }

      if (polarity.chosen.length === 1) {
        const chosenPlan: SalesPlan | undefined = polarity.chosen[0];
        if (!chosenPlan) continue;
        const nextTrack = trackForNewPlanChoice(text, trackPolarity);
        if (!nextTrack) {
          pendingPlan = chosenPlan;
          decision = null;
          continue;
        }
        const next: SalesCommercialDecision = {
          plan: chosenPlan,
          track: nextTrack,
          evidenceIndex: index,
        };
        decision = next;
        pendingPlan = null;
        continue;
      }

      if (polarity.comparisonWithoutWinner) {
        continue;
      }

      if (polarity.refused.length > 0) {
        if (decision && polarity.refused.includes(decision.plan)) {
          decision = null;
        }
        if (pendingPlan && polarity.refused.includes(pendingPlan)) {
          pendingPlan = null;
        }
        continue;
      }

      if (trackPolarity.comparisonWithoutWinner) {
        continue;
      }

      if (
        trackPolarity.chosen &&
        !trackPolarity.refused.includes(trackPolarity.chosen)
      ) {
        if (decision) {
          leadExercisedChoiceOrRefusal = true;
          const next: SalesCommercialDecision = {
            plan: decision.plan,
            track: trackPolarity.chosen,
            evidenceIndex: index,
          };
          decision = next;
          pendingPlan = null;
        } else if (
          pendingPlan &&
          precedingDirectModalityQuestion(history, index)
        ) {
          leadExercisedChoiceOrRefusal = true;
          const next: SalesCommercialDecision = {
            plan: pendingPlan,
            track: trackPolarity.chosen,
            evidenceIndex: index,
          };
          decision = next;
          pendingPlan = null;
        }
        continue;
      }

      if (trackPolarity.questionOrExplore) {
        continue;
      }

      if (trackPolarity.refused.length > 0) {
        leadExercisedChoiceOrRefusal = true;
        if (decision && trackPolarity.refused.includes(decision.track)) {
          decision = null;
        }
        continue;
      }

      continue;
    }

    if (message.role !== 'assistant' || leadExercisedChoiceOrRefusal) {
      continue;
    }
    const proposalEmails = emailsIn(text);
    const dedicated = proposalEmails.some((email) =>
      isDedicatedEmailConfirmationProposal(text, email)
    );
    if (!dedicated) continue;
    const plan = assistantFallbackPlan(text);
    if (!plan) continue;
    const fallbackTrack = assistantFallbackTrack(text);
    if (fallbackTrack === 'legacy' || fallbackTrack === 'conflict') continue;
    const next: SalesCommercialDecision = {
      plan,
      track: fallbackTrack ?? 'flexivel',
      evidenceIndex: index,
    };
    decision = next;
  }

  return decision;
}

function parseProvidedPlan(value: unknown): SalesPlan | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return isSalesPlan(slug) ? slug : null;
}

function parseProvidedTrack(value: unknown): SalesTrack | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  if (slug === 'fidelidade' || slug === 'flexivel') return slug;
  return null;
}

function hasOwnCommercialKey(
  toolInput: Record<string, unknown>,
  key: 'plan' | 'track'
): boolean {
  return Object.prototype.hasOwnProperty.call(toolInput, key);
}

function hasCommercialSignupArgs(toolInput: Record<string, unknown>): boolean {
  return (
    hasOwnCommercialKey(toolInput, 'plan') ||
    hasOwnCommercialKey(toolInput, 'track')
  );
}

function commercialArgsMatchDecision(
  toolInput: Record<string, unknown>,
  decision: SalesCommercialDecision
): boolean {
  if (!hasOwnCommercialKey(toolInput, 'plan')) return false;
  const plan = parseProvidedPlan(toolInput.plan);
  if (plan !== decision.plan) return false;
  if (hasOwnCommercialKey(toolInput, 'track')) {
    return parseProvidedTrack(toolInput.track) === decision.track;
  }
  return decision.track === 'flexivel';
}

export function authorizeSalesToolCall(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  history: ConversationMessage[];
}): SalesToolGuardDecision {
  const isSignupTool =
    input.toolName === 'sendPrefilledSignup' ||
    input.toolName === 'sendSignupLink';

  if (input.toolName === 'sendPrefilledSignup') {
    if (!hasConfirmedSalesEmail(input.toolInput.email, input.history)) {
      return {
        ok: false,
        reason: 'email_confirmation_required',
        hintMessage: EMAIL_CONFIRMATION_REQUIRED_HINT,
      };
    }
  } else if (!isSignupTool) {
    return { ok: true };
  }

  const decision = resolveSalesCommercialDecision(input.history);
  if (hasCommercialSignupArgs(input.toolInput)) {
    if (!decision || !commercialArgsMatchDecision(input.toolInput, decision)) {
      return {
        ok: false,
        reason: 'commercial_decision_mismatch',
        hintMessage: COMMERCIAL_DECISION_MISMATCH_HINT,
      };
    }
  }
  return { ok: true };
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

const SIGNUP_URL_RE =
  /https:\/\/(?:www\.)?receps\.com\.br\/cadastro[^\s<>()]*/gi;

function trustedSignupUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const trustedHost =
      url.hostname === 'receps.com.br' ||
      url.hostname.endsWith('.receps.com.br');
    return url.protocol === 'https:' && trustedHost && url.pathname === '/cadastro'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** URL autoritativa da última tool de cadastro que realmente concluiu. */
export function successfulSalesSignupUrl(
  trace: SalesToolTraceLike[]
): string | null {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (
      entry.name !== 'sendSignupLink' &&
      entry.name !== 'sendPrefilledSignup'
    ) {
      continue;
    }
    const result = parsedResult(entry.result);
    if (result?.success !== true) continue;
    const url = trustedSignupUrl(result.url);
    if (url) return url;
  }
  return null;
}

/**
 * A tool só gera a URL; quem entrega é o outbound. Coloca a URL autoritativa em
 * linha própria e remove qualquer URL de cadastro divergente criada pelo modelo.
 */
export function ensureSalesSignupUrlInReply(
  reply: string,
  trace: SalesToolTraceLike[]
): string {
  const url = successfulSalesSignupUrl(trace);
  const trimmed = reply.trim();
  if (!url) return trimmed;
  if (trimmed.includes(url)) return trimmed;

  const withoutModelSignupUrls = trimmed
    .replace(SIGNUP_URL_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return withoutModelSignupUrls ? `${withoutModelSignupUrls}\n\n${url}` : url;
}

export function hasSalesSignupUrl(reply: string): boolean {
  SIGNUP_URL_RE.lastIndex = 0;
  return SIGNUP_URL_RE.test(reply);
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

function isSalesToolGuardBlock(result: Record<string, unknown> | null): boolean {
  return (
    result?.code === 'email_confirmation_required' ||
    result?.code === 'commercial_decision_mismatch'
  );
}

function toolHadAuthorizedAttempt(
  trace: SalesToolTraceLike[],
  name: string
): boolean {
  return trace.some((entry) => {
    if (entry.name !== name) return false;
    return !isSalesToolGuardBlock(parsedResult(entry.result));
  });
}

function hasSuccessfulSignupResult(trace: SalesToolTraceLike[]): boolean {
  return successfulSalesSignupUrl(trace) !== null;
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

export function requiresHandoff(history: ConversationMessage[]): boolean {
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

function hasImmediateDedicatedEmailConfirmation(
  history: ConversationMessage[]
): boolean {
  let lastUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (
      history[index].role === 'user' &&
      contentText(history[index].content).trim()
    ) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex <= 0) return false;
  const previous = history[lastUserIndex - 1];
  if (previous.role !== 'assistant') return false;
  const previousText = contentText(previous.content);
  if (!previousText.trim()) return false;
  const latestUser = contentText(history[lastUserIndex].content);
  return emailsIn(previousText).some(
    (email) =>
      isDedicatedEmailConfirmationProposal(previousText, email) &&
      classifyEmailConfirmationReply(latestUser, email)
  );
}

function hasExplicitSignupBuyingSignal(latestUser: string): boolean {
  return /\b(?:quero (?:contratar|assinar)|(?:pode|consegue|ja pode)\s+gerar(?:\s+(?:o\s+)?(?:link|cadastro))?(?:\s+agora)?|(?:pode|consegue|ja pode)\s+(?:mandar|enviar)(?:\s+(?:o\s+)?(?:link|cadastro))?|manda\s+(?:o\s+)?(?:link|cadastro)|envia\s+(?:o\s+)?(?:link|cadastro)|(?:pode|consegue|ja pode)\s+(?:seguir|prosseguir)\s+(?:com\s+)?(?:o\s+)?cadastro)\b/.test(
    latestUser
  );
}

function requiresPrefilledSignup(history: ConversationMessage[]): boolean {
  const messages = conversationalMessages(history);
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .join('\n');
  const latestUser = normalize(
    messages.filter((message) => message.role === 'user').at(-1)?.text ?? ''
  );
  if (resolveSalesCommercialDecision(history) === null) return false;
  if (!emailsIn(userText).some((email) => hasConfirmedSalesEmail(email, history))) {
    return false;
  }
  return (
    hasImmediateDedicatedEmailConfirmation(history) ||
    hasExplicitSignupBuyingSignal(latestUser)
  );
}

function singleKnownPlanFromHistory(
  history: ConversationMessage[]
): SalesPlan | null {
  return resolveSalesCommercialDecision(history)?.plan ?? null;
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
): { plan: SalesPlan } | null {
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
    !hasSuccessfulSignupResult(trace) &&
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

/**
 * Prefill terminal consome a decisão versionada (plano+track da mesma
 * evidência). Não reabre a unicidade global de planos no histórico — quem
 * compara e depois escolhe continua resolvendo. O fail-closed pré-existente
 * vale só para menção posterior ambígua de outro plano (exploração, pergunta
 * ou comparação sem vencedor depois da evidência vigente), como em
 * "Também olhei o Pro" após uma compra já confirmada.
 */
function laterAmbiguousOtherPlanMention(
  history: ConversationMessage[],
  decision: SalesCommercialDecision
): boolean {
  for (let index = decision.evidenceIndex + 1; index < history.length; index += 1) {
    const message = history[index];
    if (message.role !== 'user') continue;
    const text = contentText(message.content);
    if (!text.trim()) continue;
    const polarity = userPlanPolarity(text);
    const otherPlans = mentionedPlans(normalize(text)).filter(
      (plan) => plan !== decision.plan
    );
    if (otherPlans.length === 0) continue;
    if (polarity.chosen.length === 1) continue;
    const refusedOnlyTheOthers =
      polarity.refused.length > 0 &&
      !polarity.refused.includes(decision.plan) &&
      otherPlans.every((plan) => polarity.refused.includes(plan));
    if (refusedOnlyTheOthers) continue;
    return true;
  }
  return false;
}

export function resolveConfirmedSalesPrefill(
  history: ConversationMessage[]
): {
  email: string;
  plan: SalesPlan;
  track: SalesTrack;
} | null {
  const userText = conversationalMessages(history)
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .join('\n');
  const confirmedEmails = [
    ...new Set(
      emailsIn(userText).filter((email) =>
        hasConfirmedSalesEmail(email, history)
      )
    ),
  ];
  const decision = resolveSalesCommercialDecision(history);
  if (confirmedEmails.length !== 1 || !decision) return null;
  if (laterAmbiguousOtherPlanMention(history, decision)) return null;
  return {
    email: confirmedEmails[0],
    plan: decision.plan,
    track: decision.track,
  };
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
  const signupUrl = successfulSalesSignupUrl(trace);
  if (claimsLinkDelivery && !signupUrl) {
    reasons.add('signup_link_without_result');
  }
  if (signupUrl && !reply.includes(signupUrl)) {
    reasons.add('signup_url_missing_from_reply');
  }

  const mentionsPrefillBenefit =
    /\b(?:dados (?:todos )?(?:preenchidos|prontos)|ja vem (?:com )?(?:seus )?dados|so (?:precisa )?criar (?:a )?senha|voce so cria (?:a )?senha)\b/.test(
      normalized
    );
  const claimsDeliveredPrefill =
    mentionsPrefillBenefit &&
    (claimsLinkDelivery ||
      hasSuccessfulSignupResult(trace) ||
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
  const signupUrl = successfulSalesSignupUrl(trace);
  if (hasDeliveredPrefilledSignup(trace) && signupUrl) {
    return `Prontinho! Te mandei o link com seus dados preenchidos — você só cria a senha. Se precisar, fico por aqui com você.\n\n${signupUrl}`;
  }
  if (signupUrl) {
    return `Prontinho! Te mandei o link do cadastro. Se precisar, fico por aqui com você.\n\n${signupUrl}`;
  }
  if (salesToolSucceeded(trace, 'sendDemoVideo')) {
    return 'Prontinho! O vídeo foi enviado. Depois me conta o que você achou.';
  }
  if (salesToolSucceeded(trace, 'scheduleDemo')) {
    return 'Pronto, sua demonstração foi agendada com sucesso.';
  }
  return fallback;
}
