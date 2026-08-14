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

## Exec 2 — escalada viva

**Status:** conserto local na Ana; sem deploy; ERP intocado.

### Diagnóstico vivo (somente leitura)

Canário `studio-viti` (`ANA_CONVERSATIONAL_V2_TENANT_SLUGS=studio-viti`, `ANA_ESCALATION_ENABLED=true`). Dois turnos no mesmo `convHash=e283c7c94004e83f` (23 chars = `posso falar com a dona?`):

1. `v2Route=fast_path_escalation` → `⏸️ [pausado] resposta pendente suprimida após intervenção humana.`
2. repetição horas depois, mesmo par.

O POST **não falhou**. No Postgres do Receps, essa conversa tem duas `ana_questions` `HUMAN_REQUEST` (`has_source_inbound=true`): v2 em 16:51:37 e v4 em 18:45:17, ambas `SUPERSEDED` por inbound posterior. Nenhuma OPEN no tenant agora — a dona nunca recebeu o ack, mas a pergunta existiu.

Contrato real do pause-state (código + GET vivo, Bearer remoto, sem PII):

| Momento | `escalation` | `conversationPausedUntil` |
|---|---|---|
| Depois do escalate (OPEN) | `{ active: true, questionId, version }` — **sem** `questionId: null` | ISO futuro (pause `source=ESCALATION`, `inbound.receivedAt + 24h`) |
| Sem pergunta aberta (GET vivo pós-supersede) | `{ active: false, version: 4 }` — **sem** campo `questionId` | `null` |
| Nunca escalou | `{ active: false, version: 0 }` — **sem** `questionId` | `null` |

O GET `{active:false, version:N}` observado pelo coordenador é o union **inativo** do ERP (`AnaEscalationState`), não prova que o POST foi recusado. No canário, o POST 200 aconteceu; o ack morreu **depois**.

Causa no último centímetro: `escalateAnaQuestion` (Receps) cria a pergunta e a `ConversationPause` ESCALATION na mesma transação. O pause-ack da Ana zerava só `escalation.active` e ainda consultava `conversationPausedUntil` → `isPausedFromState=true` → `suppressFlushIfPaused` → o log de “intervenção humana”. O parser estrito ainda exigia `questionId: null` no inativo, então o shape vivo `{active:false, version}` falhava fechado se o GET viesse assim.

Não há mudança necessária no ERP para este fecho. O Receps já devolve o union certo e já pausa a conversa para a dona; a Ana é que tratava a pausa da própria ação como silêncio.

### Conserto (somente Receps-IA)

- `parseStrictEscalationSnapshot` casa o union real: ativo exige `questionId` string; inativo aceita `questionId` omitido (ERP) ou `null` (legado). `{active:false}` sem `version`, `null`, primitivo e array continuam inválidos.
- `isConversationPausedForEscalationAcknowledgement`: com snapshot local ativo + remoto `active:true` e o mesmo `questionId`, ignora `conversationPausedUntil` **só neste ack** (a pausa ESCALATION que o POST acabou de gravar). Global, schedule e modo técnico continuam bloqueando. Inativo real aplica a decisão ordinária (echo/manual não são furados). Fetch nulo e ID divergente seguem fail-closed.
- Mensagens seguintes continuam pausadas: o cache local de escalada permanece `active:true` após o ack; `isConversationPaused` não usa esta exceção.

### Fixtures

- Vivo ativo: `{ active: true, questionId, version }` + `conversationPausedUntil` +24h → ack **entregue**.
- Vivo inativo: `{ active: false, version: 0 }` sem `questionId` → ack se não houver outra pausa; com `conversationPausedUntil` → silêncio (echo/manual).
- E2E `flushBuffer → runtime v2 → escalate fake 200 → pause-state vivo (active:true + conversationPausedUntil) → delivery → "Vou avisar Heloísa…"` no transporte fake.
- Fail-closed intacto: ID divergente, fetch nulo, `{active:false}` incompleto, pausa global/schedule, ERP fora → copy de indisponibilidade sem promessa.

### Validação (exit real)

| Comando | exit | nota |
|---|---|---|
| `npm run build` | 0 | |
| `git diff --check` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | pause-ack no shape vivo |
| `smoke:ana-escalation-cache` | 0 | union ERP |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Sem deploy. Sem POST de escalate real. Sem edição na VPS.

### Riscos que permanecem

- O pause-state não publica `source` da pausa de conversa. O ack casa pelo `questionId` e ignora `conversationPausedUntil` nesse único envio; um echo humano no mesmo instante do ack (após o lock) é residual. Global/schedule/técnico não entram nessa licença.
- GET inativo `{active:false, version}` durante o ack (pergunta já superseded) continua aplicando pausa ordinária e grava inactive no cache — correto se a OPEN já morreu; o canário vivo era OPEN + pause ESCALATION.
- Recibo `suppressed_pause` para UNRECORDED_HANDOFF permanece o enum existente.

## Exec 3 — contrato tipado de pausas

**Status:** implementado nos dois repos; sem deploy; sem push; VPS intocada.

A conferência reprovou a Exec 2 no ponto (1): ignorar `conversationPausedUntil` no ack era heurística, porque o wire do ERP agregava ECHO/MANUAL/ESCALATION no mesmo carimbo sem origem.

### ERP (Receps) — aditivo

A origem **já existia** em `ConversationPause.source` (`ECHO` | `MANUAL` | `ESCALATION`) com `@@unique([tenantId, customerPhone, source])`. Nenhuma migration: não havia coluna a criar nem backfill a fazer.

`GET /api/v1/bot/pause-state` (via `getConversationPauseState`) passa a publicar, **além** dos campos v1 intactos:

- `escalationPause { active, questionId, version, until }` — da linha `source=ESCALATION` ativa, com `version` da `AnaQuestion` vinculada
- `humanPause { active, source: "ECHO"|"MANUAL", until }` — das linhas ECHO/MANUAL ativas; se as duas existem, `source=MANUAL` e `until` é o máximo da janela humana

`conversationPausedUntil` continua o agregado (máximo de todas as linhas ativas), para consumidores v1. O campo legado `escalation` (união de `AnaQuestion` OPEN) não foi removido.

Helper puro: `src/lib/bot/conversation-pause-reasons.ts` (`deriveTypedPauseReasons`).
Smoke focado: `npm run smoke:pause-state-typed-reasons`.

Inbound `/questions` não ganhou os campos novos (`BasePauseState` omite-os). Nenhuma outra rota alterada.

### Ana (Receps-IA)

O pause-ack só ignora a pausa ESCALATION cujo `questionId` corresponde. `humanPause.active` bloqueia em qualquer combinação (incluindo simultânea com a própria escalada). Sem os dois campos tipados no wire (ERP antigo no rollout) ⇒ fail-closed total. Recheck permanece **dentro** da mesma `withConversationLock` do transporte.

Parser puro: `parseStrictEscalationPause` / `parseStrictHumanPause` / `decideEscalationAcknowledgementPause` em `pauseDecision.ts`. Shape malformado, contrato parcial (só um dos dois campos) e `fetchState=null` continuam fechados. Global / schedule / modo técnico não são furados.

### Fixtures

- escalationPause correspondente + `humanPause` inativo + `conversationPausedUntil` agregado ⇒ entrega
- os dois motivos ativos simultâneos ⇒ suprime
- wire sem campos tipados (shape vivo da Exec 2) ⇒ suprime; snapshot local preservado
- shapes malformados (`null`, primitivo, array, `active:true` sem `questionId`, `until` ausente, contrato parcial) ⇒ fail-closed
- E2E `flushBuffer → runtime v2 → pause-ack real sob a lock de envio → transporte fake`: tipado casa ⇒ `Vou avisar Heloísa…`; humanPause simultâneo ⇒ 🛑; ERP antigo sem tipados ⇒ 🛑; ERP fora ⇒ copy de indisponibilidade sem promessa

### Validação ERP (exit real)

| Comando | exit | nota |
|---|---|---|
| `npm run typecheck` | 0 | |
| `npm run lint` | 0 | 0 erros; 40 warnings pré-existentes (react-hooks/purity etc.) |
| `npm run smoke:pause-state-typed-reasons` | 0 | puro + round-trip `getConversationPauseState` |

Sem `next build`. Sem deploy.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `npm run build` | 0 | |
| `git diff --check` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | contrato tipado + E2E na lock |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:pause-decision` | 0 | parsers + decisão pura |
| `smoke:ana-escalation-cache` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Sem deploy. Sem push. Sem escrita na VPS.

### Riscos que permanecem

- Rollout: Ana nova + ERP antigo suprime o ack (fail-closed, direção segura). O ack só volta quando os dois lados publicam/consomem o contrato tipado.
- Echo humano **depois** do GET de pause-state mas **ainda dentro** da lock é coberto pelo write-through do echo (mesma lock). Echo que chegar depois do POST ao WhatsApp é o residual de sempre.
- Recibo `suppressed_pause` para UNRECORDED_HANDOFF permanece o enum existente.

## Exec 4 — lock do echo

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada.

A conferência reprovou a Exec 3 no ponto da ordenação echo×envio: `pauseConversation` corria **fora** da `withConversationLock` (o smoke até aprovava “pausa acontece fora da lock”), enquanto o delivery fazia o último checkpoint e ainda atravessava I/O antes do POST. Um echo podia chegar depois do checkpoint e antes do transporte; o ack saía.

### Conserto

1. `handleSmbMessageEchoes` executa `pauseConversation` sob a **mesma** `withConversationLock` da conversa **antes** de liberar download/transcrição/persistência. O envio (`flushBuffer` / `deliverPreparedReceptionistTurnV2`) já segura essa lock do pause-ack até o recibo. As duas ordens ficam serializadas:
   - echo vence ⇒ latch ECHO publicado, transporte suprimido;
   - envio vence ⇒ o echo só começa a pausar depois do recibo.
2. Latch local **explicitamente tipado** `{ source: "ECHO", untilMs }` (`pauseDecision.isActiveLocalEchoLatch` + mapa em `pauseService`). O GET do ERP **não** o apaga. O pause-ack consulta o latch **além** do `humanPause` tipado no wire. Se o POST de pausa ao ERP falhar, o latch permanece e o ack continua bloqueado.
3. Fixture “pausa fora da lock” substituída pela corrida de duas ordens + POST falho ⇒ latch ainda bloqueia.

Download/transcrição de áudio humano continuam **fora** da lock (não prender o pool). Dedup + persistência reentram.

### Fixtures

- E2 áudio: pausa **dentro** da lock; download/transcrição fora; persistência na lock curta.
- R1 echo vence ⇒ envio espera a lock; latch `source=ECHO`; transporte suprimido mesmo com `humanPause` inativo no ERP.
- R2 envio vence ⇒ echo não chama `pauseConversation` enquanto o envio segura a lock; só começa depois do recibo.
- R3 POST de pausa falho ⇒ latch ECHO preservado; pause-ack bloqueia.
- Helper puro: latch ECHO futuro bloqueia; expirado/MANUAL não; contrato tipado sem latch continua liberando o ack da própria escalada.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | latch ECHO no pause-ack |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:pause-decision` | 0 | latch puro |
| `smoke:ana-escalation-cache` | 0 | |
| `smoke:echo-handler` | 0 | |
| `smoke:listen-while-paused` | 0 | corrida R1/R2/R3 |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |

Extras verdes: `smoke-echo-pause-race` (POST falho ⇒ latch ECHO + pause-ack). Sem deploy. Sem push. Sem escrita na VPS.

### Riscos que permanecem

- O POST de pausa ao ERP agora segura a advisory lock (de propósito: serializa com o envio). Download/transcrição continuam fora. Um ERP lento segura o envio dessa conversa até o timeout do POST (10s) — a alternativa era a janela de corrida.
- Recibo `suppressed_pause` para UNRECORDED_HANDOFF permanece o enum existente.
- Rollout Ana nova + ERP antigo continua fail-closed no ack sem campos tipados; o latch ECHO é só local, independente do wire.

