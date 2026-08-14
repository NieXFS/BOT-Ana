# RELATORIO-GROK-EXEC-1 — escalada suprimida no último centímetro

**Status:** concluído após Retrabalho 2 (pause-ack fail-closed)

## Baseline do passo 0 (antes de qualquer edição)

Árvore limpa em `HEAD` detached `b442549` (onda 2.5). Sem contaminação da tarefa interrompida.

| Comando | exit |
|---|---|
| `npm run build` | 0 |
| `npm run smoke:ana-conversational-v2-contracts` | 0 |
| `npm run smoke:ana-conversational-v2-boundary` | 0 |
| `npm run smoke:ana-conversational-v2-recovery` | 0 |
| `npm run smoke:ana-conversational-v2-persistence` | 0 |
| `npm run smoke:ana-conversational-v2-route` | 0 |
| `npm run smoke:ana-conversational-v2-social-reads` | 0 |
| `npm run smoke:ana-conversational-v2-wave1` | 0 |
| `npm run smoke:ana-conversational-v2-escalation` | 0 |
| `npm run smoke:ana-conversational-v2-interpreter` | 0 |
| `npm run smoke:service-gate` | 0 |

## Causa exata encontrada

O log de produção `🛑 Resposta da recepcionista não foi enviada` nasce em `src/messageHandler.ts:901-902` quando `delivery !== 'sent'`. O prepare já tinha passado (`v2Route=fast_path_escalation`). Dois furos no último centímetro, encadeados:

1. **Licença de handoff não atravessava o validador de envelope.** A copy canônica `Vou avisar a equipe responsável pelo atendimento.` casa `matchForbiddenPromiseInSpeech` (`src/services/promiseGuard.ts`, padrão `ambiguous_action_to_human`). A boundary v2 já licenciava com `actionRecorded` (`src/services/conversationalV2/boundary.ts:243-245` + envelope em `:1417-1432`). O `questionId` ficava só em `PreparedReceptionistTurnV2.authoritativeEscalationQuestionId` (`runtime.ts:1116-1118`) e **não ia no evidence do envelope**. O validador final `validateReceptionistOutbound` (`src/services/receptionistOutbound.ts`, HANDOFF_RE antigo na linha que virou `:530-532`) usava um regex mais estreito, que **não** pega `vou avisar`, então a boundary passava e o transporte v2 mandava a string nua via `sendFreeformMessageWithReceipt` — sem rechecar a promessa com a licença.

2. **O 🛑 de produção (prepare ok, envio morto) é o pause-ack.** Depois do ERP 200, `escalateQuestion` grava o snapshot local `{active, questionId}`. `isConversationPausedForEscalationAcknowledgement` (`src/services/pauseService.ts`, trecho antigo equivalente a `:319-324`) fazia GET do pause-state e, se o campo aditivo `escalation` viesse ausente/inactive, **forçava overwrite do cache para inactive e devolvia `true` (pausado)**. O handler usa esse check em `messageHandler.ts:814-838`; pausado ⇒ `delivery='suppressed'` ⇒ 🛑. A copy existia; o ack da própria ação era tratado como pausa alheia.

Hipótese do coordenador (UNRECORDED_HANDOFF bloqueando a feature que deveria licenciá-lo): verdadeira como invariante de envelope — a promessa e a licença não compartilhavam o mesmo evidence no validador/transporte. O sintoma 🛑 do canário casa primeiro com o pause-ack, não com um reject da boundary (isso teria sido throw `Copy canônica de escalada v2 rejeitada`).

## Diff conceitual

- `questionId` confirmado **é** a licença autoritativa de handoff (`hasAuthoritativeHandoffLicense`: questionId trimado OU `actionRecorded` para compat v1).
- O detector de promessa do envelope passa a unir `matchForbiddenPromiseInSpeech` (pega `vou avisar a equipe`) com o HANDOFF_RE legado.
- A boundary de escalada (fast-path e intérprete `FALAR_HUMANO`) coloca `authoritativeEscalationQuestionId` no `outboundEvidence`.
- `deliverPreparedReceptionistTurnV2` revalida a promessa **antes** do POST, com o questionId do prepared. Sem licença ⇒ suppress sem transporte. Com questionId ⇒ envia.
- Pause-ack: snapshot local com o mesmo questionId continua válido se o pause-state não ecoar o campo aditivo; questionId remoto divergente e fetch nulo continuam fail-closed; outras pausas (conversa/global/schedule/técnico) não são furadas.
- Sem questionId: `buildEscalationReplyV2` segue na copy de indisponibilidade (sem promessa) — nunca silêncio.

## Fixtures novas

Em `scripts/smoke-ana-conversational-v2-escalation.ts`:

- `"posso falar com a dona?"` → ERP fake 200 + `question-authoritative-fixture` → envelope sem evidence = `UNRECORDED_HANDOFF` → prepared sem questionId = transporte suprimido → prepared **com** questionId = copy `Vou avisar` **entregue** no store fake, pendência SERVICE preservada.
- Pause-ack com pause-state **sem** campo `escalation` e questionId local casado → não pausado.
- ERP fora → copy de indisponibilidade (`falar diretamente com a equipe`), sem `vou avisar`, entregue, pendência preservada.

Também: `smoke-ana-conversational-v2-boundary.ts` (`vou avisar` bloqueado / licenciado) e `smoke-receptionist-final-outbound.ts` (mesmo par no envelope canônico).

## Tabela de validações finais (exit real)

| Comando | exit | nota |
|---|---|---|
| `npm run build` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Extras não pedidos, verdes: `smoke:receptionist-final-outbound`, `smoke:debounce-flush`, `smoke:ana-escalation-cache`.

Sem deploy. Sem chamadas reais a provider/ERP/WhatsApp. Renata, chefe e matchers de vocabulário de inbound intocados.

## Riscos / pendências

- Recibo de suppress por UNRECORDED_HANDOFF no transporte v2 reusa `transportOutcome: 'suppressed_pause'` (enum existente). Observabilidade pode confundir pause com outbound; não alterei o contrato de recibo nesta tarefa.
- Pause-ack ainda é fail-closed se o GET de pause-state **falhar** (`fetchState=null`), mesmo com questionId local. Só o campo aditivo ausente foi liberalizado.
- `conversationPausedUntil` de echo/manual continua bloqueando o ack (correto). Se o Receps pausar a conversa por timestamp em vez de `escalation.active` no mesmo POST de escalate, o ack ainda silencia — contraparte Receps.
- Compat: `actionRecorded: true` sem questionId ainda licencia (smoke v1 `Vou te encaminhar.`). A rota v2 de escalada sempre passa os dois quando o ERP devolve questionId.

## Retrabalho pós-conferência

Conferência GPT 5.6 Sol: **REPROVADO**. O núcleo (propagação do `questionId` server-owned e a causa do `pause-ack`) foi APROVADO; o retrabalho toca só os fechos fail-closed e a fixture ponta a ponta. `runtime.ts` e o restante aprovado não foram editados.

### O que a conferência encontrou

1. O detector de promessa (`containsUnlicensedHandoffPromise`) pegava `Vou avisar a equipe…` via `matchForbiddenPromiseInSpeech` + `HUMAN_TARGET`, mas **não** a copy canônica com responsável nominal arbitrário (`Vou avisar Carla, responsável por este atendimento.`). `Carla` não está em `HUMAN_TARGET` e o `HANDOFF_RE` legado não contém `avisar`. Sem `questionId`, essa promessa atravessava.
2. O `pause-ack` liberalizava demais: `parseEscalationSnapshot` colapsava campo ausente, `{active:true, questionId:null}` e `{active:false}` no mesmo caminho. Só o campo aditivo ausente deveria preservar o snapshot local.
3. Os smokes eram composição por camada, não um E2E único `flushBuffer → runtime → pause-ack real → delivery real → transporte fake`. O caso 4b de `smoke-debounce-flush-error.ts` injeta stubs dos dois helpers e não reproduz a integração do canário.
4. O relatório original superestimava a cobertura fail-closed ao chamar essa composição de E2E.

### Fechos implementados

- `receptionistOutbound.ts`: família `vou/iremos/irei/vamos avisar` + alvo humano nominal (qualquer `escalationResponsibleName`, sem lista fechada de nomes). Boundary e delivery passam a usar o mesmo detector.
- `pauseService.ts` ramifica pelo valor bruto de `escalation`:
  - campo ausente (`undefined`/`null`): preserva o snapshot local deste único ack;
  - `active:true` + mesmo `questionId`: atualiza e libera somente a própria escalada;
  - `active:true` sem `questionId` ou com ID divergente: fail-closed (atualiza o cache remoto);
  - `active:false`: atualiza o cache para inactive e aplica a decisão ordinária das demais pausas, sem fingir correspondência do ack;
  - objeto presente com `active` inválido: fail-closed.
- Smokes: copy `Heloísa`/`Zoraide Nunes` bloqueada sem `questionId` e aceita com `questionId` (boundary, envelope, delivery). Pause-ack cobre os quatro ramos acima. Cadeia única:

  `flushBuffer → runtime v2 → escalada fake 200/questionId → pause-state fake sem campo aditivo → delivery v2 real → transporte fake accepted_by_provider → PendingFrame preservado`.

  O mesmo flush com ERP fora e `escalationResponsibleName=Heloísa` entrega a copy de indisponibilidade, sem `vou avisar`, e preserva a pendência.

### Validação reexecutada (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | inclui responsável nominal |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | inclui E2E flushBuffer |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Sem deploy. Sem chamadas reais.

### Riscos que permanecem

- Recibo de suppress por UNRECORDED_HANDOFF no transporte v2 ainda reusa `transportOutcome: 'suppressed_pause'` (não bloqueador funcional; a conferência concordou).
- GET de pause-state nulo (`fetchState=null`) continua fail-closed, mesmo com questionId local.
- `conversationPausedUntil` de echo/manual continua bloqueando o ack (correto).

## Retrabalho 2

Conferência GPT 5.6 Sol no retrabalho 1: **aprovou (1) detector nominal e (3) E2E flushBuffer**; **reprovou só o (2)** pause-ack. Sonda: `escalation:null` caía no ramo de campo ausente e devolvia `paused=false` (liberação indevida).

### Fecho implementado

`isConversationPausedForEscalationAcknowledgement` considera ausente **somente** `state.escalation === undefined`. Qualquer valor presente passa por `parseStrictEscalationSnapshot`:

- `undefined` → preserva o snapshot local deste único ack (rollout sem campo aditivo).
- `null`, primitivo, array, ou objeto com `active`/`questionId`/`version` inválidos ou incompletos → `true` (fail-closed), sem gravar o payload no cache.
- snapshot completo `active:true` + mesmo `questionId` → atualiza e libera só a própria escalada.
- snapshot completo `active:true` sem ID / ID divergente → fail-closed.
- snapshot completo `{active:false, questionId:null, version}` → atualiza inactive e aplica a decisão ordinária das demais pausas.

### Regressões

- `escalation:null` → pausado; snapshot local ativo intacto.
- `{active:false}` incompleto → pausado; não grava inactive.
- primitivo e array → fail-closed.
- `{active:false, questionId:null, version:8}` completo continua liberando o ack na ausência de outra pausa.

### Validação reexecutada (exit real)

| Comando | exit | nota |
|---|---|---|
| `npm run build` | 0 | |
| `git diff --check` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | pause-ack + `null` / `{active:false}` incompleto |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| `smoke:ana-escalation-cache` | 0 | parser estrito |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Sem deploy. Sem chamadas reais.

