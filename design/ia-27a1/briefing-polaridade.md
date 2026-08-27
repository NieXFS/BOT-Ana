Requested Codex effort: max

# IA-27A1 — ultimo bloqueante: TRANSACTION SIGNAL nao respeita polaridade

Worktree: /Users/niexfs/dev/wt-ana-v2-impl
Branch: review/ia-27a1   HEAD atual: a7a35c5

O bloqueante anterior (gramatica cruzada de confirmacao) esta FECHADO e APROVADO.
Nao reabra. Este briefing corrige uma coisa so.

## O DEFEITO, JA MEDIDO POR MIM

Os detectores de transacao testam a regex contra a string inteira, sem verificar
se o token esta em oracao positiva. Rodei o classificador real. Resultado de hoje:

    "nao quero cancelar"                    -> CANCELLATION    (esperado null)
    "nao quero remarcar"                    -> RESCHEDULE      (esperado null)
    "nao quero marcar"                      -> BOOKING         (esperado null)
    "nao quero confirmar meu agendamento"   -> CONFIRMATION    (esperado null)

ATENCAO — dois casos a mais estao VERMELHOS HOJE, antes do seu patch. Nao sao
regressao sua; ja chegam quebrados:

    "nao quero remarcar, quero cancelar"              -> RESCHEDULE   (esperado CANCELLATION)
    "nao quero cancelar, quero confirmar meu agend."  -> CANCELLATION (esperado CONFIRMATION)

Causa: a negacao da primeira oracao nao invalida o token, e a precedencia
(RESCHEDULE -> CANCELLATION -> CONFIRMATION -> BOOKING) entrega a vitoria ao
primeiro cue que casar, ainda que negado.

## O DESENHO JA ESTA VALIDADO — NAO INVENTE OUTRO

Eu simulei a correcao antes de te acionar. Mantendo a precedencia EXATAMENTE como
esta e trocando apenas os cues por versoes polarity-aware, os 12 casos passam
(8 exigidos + 4 controles positivos). Portanto:

  - NAO altere a ordem de precedencia em transactionSignal.
  - NAO crie `if (texto contem "nao") return false` global.
  - Use a infraestrutura compartilhada existente: `hasPositiveClauseMatchV2`
    de src/services/conversationalV2/polarity.ts.

Ela ja faz o certo: negacao vale so no prefixo da propria oracao, e pontuacao
e adversativas (mas/porem/contudo/entretanto/so que) abrem oracao nova.

## 1. CANCELAMENTO — REAPROVEITE A ROTA PRODUTIVA

Existe `detectPositiveCancellationIntentV2` em cancellationFlowV2.ts:

    export function detectPositiveCancellationIntentV2(value: string): boolean {
      const witnessed = stripPowerZeroMetalinguisticAssignmentsV2(value);
      return hasPositiveClauseMatchV2(witnessed, CANCEL_VERB_RE);
    }

Consuma ESSA funcao no planningIntentV2, em vez de duplicar uma semantica pior.
NAO altere cancellationFlowV2.ts.

Ganho: alem da polaridade, o detector passa a herdar o interpretador de poder
zero, e as duas camadas deixam de poder divergir sobre o que e um cancelamento.

ALARGAMENTO CONSCIENTE, DECLARE NO RETORNO: CANCEL_VERB_RE e mais largo que o
cue atual (inclui cancela, cancelem, desmarca, desmarquem). Cancelamento passa a
ser detectado em mais frases. E intencional e alinha a telemetria com a rota
produtiva — mas quero isso escrito no seu relatorio, nao descoberto depois.

## 2. BOOKING / RESCHEDULE / CONFIRMACAO REFERENCIAL

Todos passam a exigir evidencia POSITIVA da acao.

Cuidados que eu ja levantei lendo o codigo, trate os tres:

(a) `hasBookingCue` tem alternativas COMPOSTAS que hoje testam duas regexes
    soltas contra a string inteira:

        /\b(?:horario|horarios)\b.*\b(?:hoje|amanha|...)\b/
        /\b(?:pode ser|pode ficar|fica para|fica pra|serve)\b/ && /\b(?:hoje|amanha|...)\b/

    Ao tornar polarity-aware, avalie a composta POR ORACAO. Nao misture
    "clause match positivo para A" com "teste cru para B" — isso produz
    resultado incoerente em frases com negacao parcial.

(b) A precedencia do `&&` sobre o `||` na ultima alternativa esta correta hoje.
    Nao mude o agrupamento sem querer ao refatorar.

(c) `hasExplicitReferentialConfirmation` casa "confirmar" + ate 3 palavras +
    "agendamento". Como splitClausesV2 quebra em virgula, uma frase como
    "confirmar, por favor, meu agendamento" deixaria de casar. Isso e
    ESTREITAMENTO (fail-closed), aceitavel nesta onda — mas confira e declare.

## 3. COLATERAL OBRIGATORIO — LINHA 166

`hasBookingCue` NAO e usado so em transactionSignal. Na linha 166 ele suprime
a familia GENERIC_INFORMATION:

    const hasSchedulingCue = hasBookingCue(normalized);

Ali a pergunta e de TOPICALIDADE ("esta mensagem fala de agenda?"), nao de
INTENCAO ("esta mensagem quer agendar?"). Uma mencao negada continua sendo
mencao.

Portanto: mantenha a linha 166 no cue polarity-INSENSITIVE e introduza a versao
polarity-aware SOMENTE para transactionSignal. Assim as familias de informacao
nao mudam em nenhum caso.

Conferi que os 4 casos exigidos nao casam GENERIC_INFORMATION_RE, entao eles
caem em GENERAL como especificado. Prove isso no smoke.

## 4. PRESERVE OS 7 CASOS JA PROVADOS

    CONFIRMATION + "Sim."                               -> PENDING_ANSWER
    CANCEL_CONFIRMATION + "Sim."                        -> PENDING_ANSWER
    draft + "Pode marcar"                               -> CONFIRMATION
    CONFIRMATION + "pode cancelar"                      -> CANCELLATION / TRANSACTION
    CANCEL_CONFIRMATION + "pode marcar"                 -> BOOKING / TRANSACTION
    draft + "Pode marcar uma limpeza amanha?"           -> BOOKING / TRANSACTION
    draft + "quero remarcar para amanha"                -> RESCHEDULE

## 5. ADVERSARIAIS NOVOS OBRIGATORIOS (7)

    "nao quero cancelar"                              -> transaction=null, arbitration=GENERAL
    "nao quero remarcar"                              -> transaction=null, arbitration=GENERAL
    "nao quero marcar"                                -> transaction=null, arbitration=GENERAL
    "nao quero confirmar meu agendamento"             -> transaction=null, arbitration=GENERAL
    "nao quero cancelar, quero remarcar"              -> RESCHEDULE / TRANSACTION
    "nao quero remarcar, quero cancelar"              -> CANCELLATION / TRANSACTION
    "nao quero marcar hoje, mas quero marcar amanha"  -> BOOKING / TRANSACTION

## 6. FORA DE ESCOPO — NAO ABRA

A pendencia conhecida CONFIRMATION + "nao" / CANCEL_CONFIRMATION + "nao"
continua fora de escopo. Exige pendingPolarity. Nao mexa.

Estamos corrigindo apenas falso POSITIVO de transaction.

## 7. NAO TOCAR

planner, fast-paths, recovery, flag, receipt, prompt/provider,
IA-23 / IA-25d / IA-26 / IA-26b, cancellationFlowV2.ts.
Shadow OFF/ON deve seguir byte-equivalent nos campos comportamentais;
so planningIntent pode diferir.

O patch deve ficar restrito a:
  src/services/conversationalV2/planningIntentV2.ts
  scripts/smoke-ana-ia27a1-planning-intent.ts

## 8. GATES (rode e reporte exit REAL de cada um)

    npm run typecheck
    npm run smoke:ana-ia27a1-planning-intent
    npm run smoke:ana-conversational-v2-cancellation
    npm run smoke:ana-conversational-v2-fallback-intent
    npm run smoke:ana-conversational-v2-recovery
    npm run smoke:ana-conversational-v2-contracts
    npm run smoke:ana-conversational-v2-boundary
    npm run smoke:ana-conversational-v2-ia23
    npm run smoke:ana-conversational-v2-service-context
    npm run smoke:ana-service-resolver
    npm run smoke:ana-ia25d-composite-fence
    npm run smoke:ana-ia24-time
    npm run smoke:ana-v2-elicitor-matcher-contract

## FORMATO DE RETORNO

Trabalhe autonomamente dentro deste escopo. Devolva SOMENTE relatorio compacto:
status (concluido/parcial/bloqueado) - arquivos alterados - decisoes tecnicas -
os 7+7 casos com resultado REAL - o alargamento do CANCEL_VERB_RE declarado -
o estreitamento do (c) declarado - exit real de cada gate - riscos e pendencias.

Sem raciocinio interno, sem JSONL, sem credencial, sem log cru.
