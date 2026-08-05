/**
 * Guardrail D: a Ana não pode afirmar que transferiu, repassou ou acionou
 * alguém quando não existe transporte humano no produto. Este matcher é
 * deliberadamente mais estreito que o das superfícies determinísticas: ele
 * protege a fala ao cliente sem bloquear uma negação honesta ou uma ação
 * normal de agendamento, como "vou te passar os horários disponíveis".
 */
export const PROMISE_GUARD_FALLBACK =
  "Esse assunto é tratado diretamente com a equipe do estabelecimento. Por aqui, posso ajudar com informações cadastradas e com o agendamento.";

type PromisePattern = {
  /** Identificador seguro para log/Sentry; nunca contém a fala da cliente. */
  id: string;
  pattern: RegExp;
};

const HUMAN_TARGET_TERMS = [
  "equipe",
  "responsave(?:l|is)",
  "profissiona(?:l|is)",
  "recepcao",
  "rose",
  "alguem",
  "pessoas?",
  "superior(?:es)?",
  "time",
  "atendentes?",
  "clinica",
  "ela",
  "ele",
  "eles",
  "elas",
  "dona",
  "proprietari[ao]s?",
  "gestor(?:a|as|es)?",
  "doutor(?:a|as|es)?",
  "medic[ao]s?",
  "podolog[ao]s?",
  "secretari[ao]s?",
  "recepcionistas?",
  "humanos?",
] as const;

const HUMAN_TARGET =
  `(?:(?:a|o|as|os)\\s+)?` + `(?:${HUMAN_TARGET_TERMS.join("|")})`;

const SPEECH_PROMISE_PATTERNS: readonly PromisePattern[] = [
  {
    id: "direct_transfer",
    pattern:
      /\b(?:vou|irei|iremos|vamos|estou|ja|posso)\s+(?:(?:te|lhe)\s+)?(?:encaminhar|transferir|direcionar|redirecionar|conectar)\b|\b(?:eu\s+)?(?:(?:te|lhe)\s+)?(?:encaminho|encaminharei|transfiro|transferirei|direciono|direcionarei|redireciono|redirecionarei|conecto|conectarei)\b/i,
  },
  {
    id: "completed_transfer",
    pattern:
      /\b(?:encaminhei|encaminhando|transferi|transferindo|direcionei|direcionando|redirecionei|redirecionando|conectei|conectando)\b/i,
  },
  {
    id: "passive_transfer",
    pattern:
      /\b(?:sera|serao|ficara|ficarao)\s+(?:(?:te|lhe)\s+)?(?:encaminhad[oa]s?|transferid[oa]s?|direcionad[oa]s?|redirecionad[oa]s?|conectad[oa]s?)\b/i,
  },
  {
    id: "future_transfer",
    pattern:
      /\b(?:vai|vao|ira|irao)\s+(?:(?:te|lhe)\s+)?(?:encaminhar|transferir|direcionar|redirecionar|conectar)\b/i,
  },
  {
    id: "clitic_transfer",
    pattern:
      /\b(?:encaminha|encaminhe|encaminho|encaminhei|transferi|transfira|transfero|direciona|direcionei|redireciona|redirecionei)-?(?:lo|la|los|las|te|lhe)\b/i,
  },
  {
    id: "ambiguous_action_to_human",
    pattern: new RegExp(
      `\\b(?:vou|irei|iremos|vamos|estou|ja|deixa\\s+que\\s+eu|eu|posso)\\s+` +
        `(?:(?:te|lhe)\\s+)?` +
        `(?:avisar|aviso|avisarei|chamar|chamo|chamarei|acionar|aciono|acionarei|` +
        `pedir|peco|pedirei|falar|falo|falarei|passar|passo|passarei|repassar|` +
        `repasso|repassarei|transmitir|transmito|transmitirei)\\s+` +
        `(?:para\\s+|pra\\s+|a\\s+|ao\\s+|com\\s+)?${HUMAN_TARGET}\\b`,
      "i",
    ),
  },
  {
    id: "clitic_action_to_human",
    pattern: new RegExp(
      `\\b(?:vou|irei|iremos|vamos|estou|ja)\\s+` +
        `(?:passar|passa|repassar|repassa|transmitir|transmita)-?` +
        `(?:te|lhe|lo|la|los|las)\\s+(?:para|pra)\\s+${HUMAN_TARGET}\\b`,
      "i",
    ),
  },
  {
    id: "bare_action_to_human",
    pattern: new RegExp(
      `\\b(?:aviso|avisarei|chamo|chamarei|aciono|acionarei|peco|pedirei|` +
        `falo|falarei|passo|passarei|repasso|repassarei|transmito|` +
        `transmitirei)\\s+` +
        `(?:para\\s+|pra\\s+|a\\s+|ao\\s+|com\\s+)?${HUMAN_TARGET}\\b`,
      "i",
    ),
  },
  {
    id: "completed_action_to_human",
    pattern: new RegExp(
      `\\b(?:ja\\s+)?` +
        `(?:avisei|chamei|acionei|pedi|falei|passei|repassei|transmiti)\\s+` +
        `(?:para\\s+|pra\\s+|a\\s+|ao\\s+|com\\s+)?${HUMAN_TARGET}\\b`,
      "i",
    ),
  },
  {
    id: "third_party_future_contact",
    pattern: new RegExp(
      `\\b${HUMAN_TARGET}\\s+` +
        `(?:(?:vai|vao|ira|irao)\\s+(?:(?:te|lhe)\\s+)?` +
        `(?:responder|retornar|falar|avisar|chamar|entrar\\s+em\\s+contato)|` +
        `(?:respondera|responderao|retornara|retornarao|falara|falaram|entrara|` +
        `entrarao)\\s+(?:(?:com\\s+)?voce|te|lhe|em\\s+contato)?)\\b`,
      "i",
    ),
  },
  {
    id: "implicit_third_party_future_contact",
    pattern:
      /\b(?:vai|vao|ira|irao)\s+(?:te|lhe)\s+(?:responder|retornar|falar|avisar|chamar|entrar\s+em\s+contato)\b/i,
  },
  {
    id: "assistant_return",
    pattern:
      /\b(?:(?:vou|irei|iremos|vamos)\s+(?:(?:te|lhe)\s+)?retornar|eu\s+retorno|retornarei|retorno\s+(?:em\s+breve|logo|depois))\b/i,
  },
  {
    id: "leave_message",
    pattern: /\b(?:vou|irei|deixei|deixar)\s+(?:um\s+)?recado\b/i,
  },
];

/** Exposto ao smoke para garantir que os padrões continuam estreitos. */
export const FORBIDDEN_PROMISE_SPEECH_PATTERNS = SPEECH_PROMISE_PATTERNS.map(
  ({ pattern }) => pattern,
);

const CLAUSE_BOUNDARY =
  /[,.!?;:\n]+|\b(?:mas|porem|contudo|todavia|entretanto|so\s+que)\b/gi;
const NEGATION_TAIL = /\b(?:nao|nunca|nem)\b(?:\s+[a-z]+){0,5}\s*$/i;
const NON_DENYING_NEGATION = /\bnao\s+(?:apenas|so|somente)\b/i;

function normalizeForPromiseGuard(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function currentClauseStart(text: string, matchIndex: number): number {
  const boundedIndex = Math.max(0, Math.min(matchIndex, text.length));
  const beforeMatch = text.slice(0, boundedIndex);
  let start = 0;

  for (const boundary of beforeMatch.matchAll(CLAUSE_BOUNDARY)) {
    const index = boundary.index ?? 0;
    start = index + boundary[0].length;
  }

  return start;
}

/**
 * Uma negação licencia somente a oração em que ela aparece e somente quando
 * está próxima da ação detectada. Vírgula, ponto e vírgula, dois-pontos,
 * quebra de linha e adversativas quebram o contexto de propósito.
 */
export function isNegatedContext(text: string, matchIndex: number): boolean {
  const normalized = normalizeForPromiseGuard(text);
  const boundedIndex = Math.max(0, Math.min(matchIndex, normalized.length));
  const clausePrefix = normalized.slice(
    currentClauseStart(normalized, boundedIndex),
    boundedIndex,
  );

  return (
    !NON_DENYING_NEGATION.test(clausePrefix) && NEGATION_TAIL.test(clausePrefix)
  );
}

/**
 * Detecta apenas promessas AFIRMATIVAS na fala ao cliente. O identificador
 * retornado é seguro para telemetria e não expõe texto livre.
 */
export function matchForbiddenPromiseInSpeech(text: string): string | null {
  const normalized = normalizeForPromiseGuard(text);

  for (const { id, pattern } of SPEECH_PROMISE_PATTERNS) {
    const matches = normalized.matchAll(
      new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      ),
    );
    for (const match of matches) {
      const matchIndex = match.index ?? 0;
      if (!isNegatedContext(normalized, matchIndex)) return id;
    }
  }

  return null;
}

export type PromiseGuardResult =
  | { reply: string; blocked: false }
  | { reply: string; blocked: true; pattern: string };

/** Barreira pura: nunca registra nem envia o texto que provocou o bloqueio. */
export function applyPromiseGuard(reply: string): PromiseGuardResult {
  const pattern = matchForbiddenPromiseInSpeech(reply);
  if (!pattern) return { reply, blocked: false };
  return { reply: PROMISE_GUARD_FALLBACK, blocked: true, pattern };
}
