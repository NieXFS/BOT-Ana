export const FORBIDDEN_PROMISE_PATTERNS: RegExp[] = [
  /encaminh/i,
  /\bvou\s+(avisar|chamar|acionar|pedir|passar|falar|repassar|transmitir)\b/i,
  /\b(avisarei|chamarei|acionarei|repassarei|retornarei|transmitirei)\b/i,
  /j[áa] chamei/i,
  /vai te responder/i,
  /em breve/i,
  /entrar(ei|emos|á|ão)? em contato/i,
  /vou (te )?retornar/i,
];

export {
  FORBIDDEN_PROMISE_SPEECH_PATTERNS,
  isNegatedContext,
  matchForbiddenPromiseInSpeech,
} from '../../src/services/promiseGuard';

export function matchForbiddenPromise(text: string): string | null {
  for (const pattern of FORBIDDEN_PROMISE_PATTERNS) {
    if (pattern.test(text)) return pattern.toString();
  }
  return null;
}
