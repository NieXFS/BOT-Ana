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

## Exec 5 — voz e tau2

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada.

Síntese (interseção ataque × estrutura): a voz não entra na `BoundaryEvaluation`. Rephrase em runtime só na Fase 1A (`initial_service_question`, `booking_reentry_service_question`, `service_selected_date_question`), com conferência completa (speech-act + conjunto/ordem + polaridade/modalidade + fatos duros). Qualquer falha, timeout ou segunda fronteira devolve o template **pós-P6** e o recibo `voice_rejected`. Oferta de slots e reabertura ficam em pools compilados `PENDENTE-PAINEL` (runtime não aplica até o painel aprovar). Denylist permanente byte-fixa: resumo canônico, write, duplicidade, clarificador de meia-hora, denial licenciada, cancel compliance, identidade, re-ask de `CONFIRMATION`. τ² evolui o harness: reward `STATE×ENV×COMMUNICATE`, `pass^1`/`pass^4`, simulador oracle, tom fora do reward, cinco braços mock.

### Encaixe

- Registry opt-in por proveniência `fast_path`; modelo/intérprete não escolhem `copyId`.
- Dupla fronteira + `source: VOICE_REPHRASE` + checkpoint `during_voice`. Prompt sem inbound. T=0.3, `tools:[]`, thinking OFF, 4s, zero retry.
- `copyVariant` intocado. Allowlist `ANA_CONVERSATIONAL_V2_VOICE_TENANT_SLUGS` vazia. Contrato: Revisão 3.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | voz default OFF |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | registry, fallback, recibo, `VOICE_REPHRASE` |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | mutation tests da conferência (A1–A3 + conjunto/ordem) |
| `smoke:ana-v2-tau2` | 0 | 5 braços, FAIL 0, pass^1=1, pass^4=1 |
| `smoke:booking-confirmation-gate` | 0 | “pode” intacto |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | `VOICE_REPHRASE` como fonte gerada |

Sem deploy. Sem push. Sem escrita na VPS. Pools VOZ-2 nesta fase: fixtures mock `PENDENTE-PAINEL`; geração real gateada à parte.

### Riscos que permanecem

- Pools compilados não estão aprovados pelo painel; produção continua nas 3 variantes P6 de slots e na copy canônica de reabertura.
- O quinto braço mock usa o mesmo Fast Path 1A; a matriz real (provider vivo) continua autorização própria.
- Tom permanece juiz experimental, fora do reward; não calibra canário.

## Exec 5b — retrabalho voz + τ² (três gates reprovados)

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada.

A conferência da Exec 5 reprovou três gates obrigatórios. Este retrabalho fecha exatamente esses pontos.

### 1. Conferência de voz — núcleo semântico inalcançável pelo modelo

Na Fase 1A o LLM gera só um conectivo estilístico não factual (`{"connective":"..."}`, teto 48 tokens). O servidor compõe pergunta, lista e ordem canônicas. A conferência passou a checar `semanticAct` (`ask_service` ≠ `ask_date` ≠ handoff), gramática fechada (oração residual rejeita), negação pós-fixada, preço/duração por extenso e `hard_fact_uninterpretable`.

As três sondas do conferente agora caem no template: `ask_date → “Você prefere falar com a equipe?”`; lista + `“Drenagem Linfática não é oferecida”`; `“O serviço custa cento e cinquenta reais”`. Pipeline: primeira boundary → rephrase de conectivo → composição → conferência → checkpoint → segunda boundary `VOICE_REPHRASE` → delivery ou fallback.

### 2. Denylist permanente — inalcançável pelo registry

`VoiceEligibleCopyIdV2` é disjunto de `PermanentVoiceAnchorIdV2`. `fastPathProvenanceV2` só aceita IDs elegíveis (`@ts-expect-error` em `canonical_booking_summary`). Produtores de âncora devolvem `null`. O resolver executa `if (isPermanentVoiceDenylistV2(copyId)) return null` **antes** de qualquer lookup. Registry congelado, não exportado mutável. Sonda forjada via cast → `resolve=null`; mutação do registry não reativa a âncora; `providerCallCount=0` nas oito âncoras.

### 3. Harness τ² — executa tasks de verdade

Runner valida/carrega o JSON, clona `initial_state` por `taskId×armId×trialId`, corre a sessão completa (`oracle_acts`, `deliverPrepared`), projeta o estado final fechado e agrega `pass^1`/`pass^4` só depois de agrupar por task. STATE usa hash da projeção completa (efeito extra ⇒ reward 0). Controlador de atos + amostragem real de transcripts; `inconclusive` se cobertura < `max(30, 20%)` ou 0/1 auditoria. Duas tasks (uma multi-step conta uma vez); macro entre tasks; juiz de tom fora do reward.

Resultado mock: 2 tasks × 5 braços × 4 trials = 40 sessões; `pass^1=1`, `pass^4=1` por task e no macro; simulador 30/40 auditados, `inconclusive=false`; voz só no 5º braço (12 chamadas). Flash/Luna usam `requestedModel` distinto (`gpt-4o-mini` vs `gpt-5.6-luna`).

### 4–5. Pools e proveniência

`reviewOverride:"aprovado"` saiu da API de produção (`selectCompiledPoolVariantForTestV2` só no smoke). Proveniência registrada após a P6 e zerada se `recoveryKind !== "none"` ou `recovery.payload !== provenancedPayload`. Regen/fallback com candidato rejeitado: `rephraseCompletion` = 0.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | inclui `@ts-expect-error` da denylist |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | denylist inalcançável, 8 âncoras call=0, 3 sondas → template, proveniência×recovery |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | A1–A3 + sondas do conferente + pós-fixada/extenso/handoff/troca de pergunta |
| `smoke:ana-v2-tau2` | 0 | 2 tasks, 5 braços, 40 sessões, FAIL 0, pass^1=1, pass^4=1, audit 30/40 |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **flash** × **voz** | 0 | Passos 30, FAIL 0, REVIEW 15; 94 chamadas (voz extra) |

Sem deploy. Sem push. Sem escrita na VPS.

### Riscos que permanecem

- Pools compilados continuam `PENDENTE-PAINEL`; o runtime não os aplica.
- Em 1A o fast-path ainda ganha do intérprete (ordem do runtime); os braços Flash/Luna distinguem-se por `requestedModel` e a voz por chamadas reais. A matriz viva continua autorização própria.
- Tom permanece juiz experimental, fora do reward.

## Exec 5c — retrabalho FINAL voz + τ² (enum, pass^k por braço, --real)

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada; matriz `--real` fica com o coordenador.

A conferência da Exec 5b reprovou quatro gates. Este retrabalho fecha exatamente a instrução literal de aprovação.

### 1. Voz por enum server-side

O modelo devolve somente um `VoiceConnectiveId` de enum finito (`claro`, `combinado`, `vamos_la` para `ask_service`; `perfeito`, `otimo`, `combinado_dot` para `ask_date`). O servidor materializa a frase aprovada e cola o núcleo canônico. ID desconhecido, texto livre, campo `connective` ou ID incompatível com o ato ⇒ template cru. A gramática aberta (`isValidVoiceConnectiveV2` + denylist/regex de conectivo) saiu; as sondas que passavam — `Botox funciona!`, `Gestantes podem fazer!`, `Sem contraindicações!`, `É totalmente seguro!` — viraram fixtures de rejeição em compose, fidelidade e `applyConversationalVoiceV2`.

### 2. `pass^k` por `taskId × armId`

`aggregatePassKByTaskV2` agrupa por tarefa e braço. A sonda Flash `4/4` + Luna `0/4` produz duas linhas (`pass¹=1/pass⁴=1` e `pass¹=0/pass⁴=0`), nunca uma linha `trials=8`. O mock oficial agora emite 10 linhas (2 tasks × 5 braços), cada uma com `trials=4`.

### 3. Auditoria do simulador com rótulos reais

`labelSimulatorTranscriptV2` deriva rótulos dos transcripts (`ok`, `act_not_in_controller`, `oracle_sequence_mismatch`, `empty_agent_payload`, …). `auditSimulatorTranscriptsV2` amostra e conta a partir desses rótulos. O smoke não passa mais `failCount: 0` manual. Fixture de ato inventado falha; a amostra mock de 30/40 fica `ok` e `inconclusive=false`.

### 4–5. τ² `--real` e Flash de verdade na voz

O harness τ² aceita `--real` com preflight/recibo de provider+modelo por braço. Flash = `deepseek/deepseek-v4-flash` (não `gpt-4o-mini`). Sem `DEEPSEEK_API_KEY` o preflight falha fechado. Recibo `*-mock` ou `gpt-4o-mini` é rejeitado. No 5º braço, `--real` não injeta factory: chama `createReceptionistChatCompletion` no caminho default. O behavioral faz o mesmo na voz sob `--real --provider flash --voice on` e recusa o recibo mock.

Schema do relatório τ²: 4. Política de voz: 3.

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
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | enum, texto livre/ID incompatível ⇒ template |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | sondas Botox/Gestantes/contraindicações/seguro + ID incompatível |
| `smoke:ana-v2-tau2` | 0 | 10 linhas task×arm, FAIL 0, pass^1=1, pass^4=1, audit 30/40 rotulada, Flash=`deepseek-v4-flash` |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **flash** × **voz** | 0 | Passos 30, FAIL 0, REVIEW 15; 94 chamadas |

Sem deploy. Sem push. Sem escrita na VPS. Sem matriz `--real` (coordenador).

### Riscos que permanecem

- Pools compilados continuam `PENDENTE-PAINEL`; o runtime não os aplica.
- A matriz viva (`--real` τ² e 5º braço Flash+voz) continua autorização do coordenador; o mock prova o fecho, não o desempenho do Flash na rede.
- Tom permanece juiz experimental, fora do reward.

## Exec 6 — protocolo, workflow, canário pt-BR, juiz pairwise (última antes da matriz real)

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada; `--real` (protocolo e τ²) fica com o coordenador.

Fonte: adendo §6 do dossiê (Deep Research GPT 5.6). Conclusão central respeitada: a evidência reforça a arquitetura já escolhida (plan-then-realize), não pede outra.

### 1. `tool_choice` required/named (non-thinking, DOC OFICIAL)

A limitação famosa é **só do thinking**. Non-thinking emite `required`/`named` atrás de `supportsToolChoiceRequired` (openai/luna/deepseek = true; classificador de retomada = false). Thinking omite `tool_choice` mesmo se o caller pedir `required`. DeepSeek non-thinking continua omitindo `auto`.

Onde a máquina já sabe que o ato é tool (`forceUpcomingRead` no sucessor pós-write), `resolveForcedToolChoiceV2` manda named `getUpcomingAppointments` no `initialToolChoice` do loop. O fast-path de leitura ainda resolve o sucessor quando pode; o `tool_choice` cobre o continue_model. Retry de args inválidos também nomeia a tool.

Políticas do adendo no loop: `EXPECTED_TOOL_GOT_TEXT` (forced + texto; 1 retry; content nunca executado); `EMPTY_GENERATION`; `PSEUDO_TOOL_IN_CONTENT` só telemetria — pseudo-tool no `content` jamais é desserializada.

### 2. Suíte de protocolo (`smoke:provider-protocol`)

Separada da suíte de negócio. Mock offline × 12: auto → `tool_calls` estruturado; required → zero execução de texto puro; named → nome exato (round 2 volta a `auto`); strict válido/inválido → aceito/400; pós-tool não-vazio; injection tool-like no texto da cliente → `executed=[]`. `--real` existe, barato, fail-closed sem chave real; esta exec não o corre.

### 3. Purga da linguagem de workflow (não-âncora)

Âncoras byte-fixas (resumo, write, duplicidade, clarificador, denial, cancel, identidade, re-ask de CONFIRMATION) **não** foram tocadas. `VOICE_TEMPLATE_VERSION_V2 = 2`. Varredura `findWorkflowLanguageV2` na wave1/voz.

| Template | Antes | Depois |
|---|---|---|
| `VOICE_CONNECTIVE_PHRASES_V2.combinado_dot` | `Combinado.` | `Combinado, então.` |
| P6 `date_question_3` | `Combinado.` | `Combinado, então.` |
| Read fast-path de disponibilidade (sucesso) | `Tenho estes horários disponíveis para ${date}: ${slots}. Qual você prefere?` | `Pra ${date} eu tenho ${slots}. Qual fica melhor pra você?` |
| Pool `booking_reentry` (variante 4) | `Seguimos com {service}…` | `A gente ia de {service} em {date}{timePart} — quer continuar esse agendamento ou marcar outro?` |
| Pool `booking_reentry` (variante 8) | `Temos o {service} … em andamento` | `A gente ainda estava no {service} de {date}{timePart} — quer continuar esse agendamento ou marcar outro?` |

Lifecycle `Encontrei horários para … Qual você prefere?` permanece (P6 `slots_offer_*` e conferência dos pools). Não era linguagem da denylist.

### 4. Canário linguístico pt-BR

Fixtures permanentes em `linguisticCanary.ts`, exercitados na wave1: `pra` (data), `tá` (afirmativa compacta com 1 TIME), elipse `pode ser o das 15...`, `pode ser às 15?`, `depois das três`, `não, peraí, às 16h`.

### 5. Juiz de tom pairwise no τ²

Schema do relatório: **5**. Mesmo payload ⇒ A=template, B=variante. Juiz cego devolve left/right; (A,B) e (B,A) independentes; só preferência consistente conta. Bandas de comprimento. Fidelidade é GATE (`evaluateVoiceFidelityV2` exclui antes do juiz) e **nunca** entra em `preferenceRate`. Juiz único não pode ser o gerador (Flash não julga Flash sozinho). Mock desta exec: `nComparisons=2`, `nExcludedFidelity=1`, `nExcludedLength=1`, `nConsistent=1`, `preferenceRate=1`, juiz=`luna`. Tom continua fora do reward.

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
| `smoke:ana-conversational-v2-wave1` | 0 | canário + denylist + P6 `Combinado, então.` |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | templateVersion=2; connectives/pools sem workflow |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | mutations ok |
| `smoke:ana-v2-tau2` | 0 | schema 5, FAIL 0, pass^1=1, pass^4=1, pairwise n=2 |
| `smoke:provider-protocol` | 0 | mock × 12; injection nunca executa |
| `smoke:receptionist-provider` | 0 | required/named DeepSeek; thinking omite |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15 |
| mock × interpreter **on** × **flash** × **voz** | 0 | Passos 30, FAIL 0, REVIEW 15; 94 chamadas |

Sem deploy. Sem push. Sem escrita na VPS. Sem `--real` (coordenador).

### Riscos que permanecem

- Pools compilados continuam `PENDENTE-PAINEL`; o runtime não os aplica.
- A matriz viva (`--real` τ², protocolo `--real`, 5º braço Flash+voz na rede) continua autorização do coordenador.
- Tom pairwise no `--real` deixa de publicar métrica sintética (Exec 6b); a escala ~85 comparações e o gold set humano brasileiro ficam para a matriz real.
- Fast-path de `forceUpcomingRead` ainda resolve a leitura no servidor quando pode; `tool_choice` named é a rede de segurança do continue_model, não um substituto da leitura determinística.

## Exec 6b — juiz pairwise real no `--real`

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada; `--real` τ² continua autorização do coordenador.

Parecer do conferente: quatro gates da Exec 6 passaram, mas o `--real` ainda publicava o probe sintético (`askJudge: order === "ab" ? "right" : "left"`) como `judges:["luna"]`. O avaliador puro já estava correto; a cablagem não.

### O que mudou

O probe do avaliador permanece só como asserção interna. O JSON do harness passou a schema **6** e o campo `pairwiseTone` ganhou `status`.

| Modo | `pairwiseTone.status` | Métrica |
|---|---|---|
| mock | `not_run` / `mock_harness` | `preferenceRate: null`, `nComparisons: 0`, `judges: []`. Pares dos braços são contados (`nPairedItems=12` nesta fixture) mas **não** julgados. |
| `--real` com juiz válido | `judged` | Pares `taskId × trialId × copyId` dos outputs entregues por `flash_interpreter` (template) e `flash_interpreter_voice` (variante). Fidelidade e banda de comprimento **antes** do juiz. Duas chamadas por item elegível, ordem AB e BA. Recibo por chamada: provider, modelo pedido/devolvido, latência, tokens. `nComparisons` = número real de chamadas. |
| `--real` sem credencial, autojuiz único, spec `*-mock` ou sem juiz fora do par | `not_run` | `inconclusive: true`, `preferenceRate: null`, `nComparisons: 0`. **Nunca** número sintético. Recibo `*-mock` no retorno do juiz **lança** (fail-closed). |

Default do juiz: o provider que **não** está no par. O 5º braço é Flash+voz ⇒ Luna (`gpt-5.6-luna`). Override: `ANA_V2_TAU2_JUDGE_PROVIDER` / `ANA_V2_TAU2_JUDGE_MODEL`. Flash não julga Flash sozinho.

Teste injetável no smoke: duas chamadas, esquerda/direita invertidas em BA, zero chamadas no item excluído por fidelidade, autojuiz único → `not_run` com zero chamadas, modelo `*-mock` rejeitado.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | |
| `smoke:provider-protocol` | 0 | |
| `smoke:receptionist-provider` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | |
| `smoke:ana-v2-tau2` | 0 | schema 6; mock `pairwiseTone.status=not_run`, `nPairedItems=12`, `preferenceRate=null`; probe interno n=2 |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |

Sem deploy. Sem push. Sem escrita na VPS. Sem `--real` (coordenador). Roteiros comportamentais não reexecutados: o delta é só a cablagem do juiz no harness τ².

### Riscos que permanecem

- A matriz viva (`--real` τ²) continua autorização do coordenador. Com `OPENAI_API_KEY_LUNA` (já exigida pelos braços Luna) o juiz default **vai chamar a Luna de verdade** — 12 pares nesta fixture × 2 ordens = 24 completions de juiz, mais o 5º braço de voz.
- Sem juiz não-gerador o relatório fica `not_run`/inconclusive; isso não autoriza publicar `preferenceRate` sintético.
- Escala ~85 comparações e gold set humano brasileiro continuam fora desta exec.

## Exec 7 — auditabilidade do harness behavioral (recibo + anti-mock + preços Luna)

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada; `--real` continua autorização do coordenador. Esta exec **não** fez chamadas reais.

O relatório de decisão estava bloqueado: no braço Luna `--real`, os `providerCalls` do behavioral saíram com `requestedModel`/`fingerprint` ausentes (63× `?`) e custo implausível (US$0,0012 / 63 chamadas — ~20× mais barato que Flash/chamada).

### 1. Recibo plumado em cada `providerCall`

O runtime já gravava `requestedModel`, `response.model` e `response.systemFingerprint` no recibo de turno (Exec 6). O log do harness **não** copiava esses campos para `ProviderCallMetric`, então a auditoria do JSON só via `?`.

Cada chamada agora leva o mesmo shape do recibo de turno. Schema do relatório behavioral: **4**. O adapter Luna (`normalizeLunaResponseToChatCompletion`) copia `system_fingerprint` quando a Responses API envia o campo. No log do harness o campo `response.systemFingerprint` existe sempre (`null` se a API omitir).

### 2. Preflight anti-mock no `--real` (igual ao τ²)

Antes de correr o braço: provider/modelo resolvidos têm de casar com o spec (`luna/gpt-5.6-luna`, `deepseek/deepseek-v4-flash`, `openai/gpt-4o-mini`). R10 continua exigindo o chefe Thinking em Flash.

Em **cada** `providerCall` e de novo **antes de escrever** `raw.json`: recibo `*-mock` ou modelo divergente do braço ⇒ lança e **nunca publica**. `requestedModel` ou `response.model` ausentes também abortam. Fingerprint nulo é lícito (Responses da Luna pode não mandar). O 5º braço de voz mantém `assertLiveVoiceModelReceiptV2`.

Não havia mock vazando no caminho Luna brain sob `--real`: o `completionFactory` só usa `syntheticCompletion` / `*-mock` quando `mode === 'mock'`; o `--real` já chamava `createReceptionistChatCompletion`. A lacuna era a **ausência de gate** — um recibo mock poderia ser publicado. O gate fecha isso.

### 3. Auditoria da tabela de preços Luna — veredito: pricing, não chamada fake

Evidência no código, sem rede:

| Peça | O que mostra |
|---|---|
| `PRICE_PER_MILLION.luna` (antes) | `Number(process.env.OPENAI_LUNA_* ?? 0)` — default **0** |
| `.env.example` | documentava deixar 0 “até o contrato comercial” |
| Custo US$0,0012 / 63 | 62 chamadas Luna a US$0 + ~1 chamada `resume_thinking` Flash (`4_000` completion × US$0,28/1M ≈ US$0,00112) |
| `kind === 'resume_thinking' ? 'deepseek'` | o chefe do R10 entra no total do braço Luna com preço Flash |
| `mode === 'mock'` no brain | **não** entra no `--real`; tokens do mock são 0, o que daria US$0,00, não 0,0012 |

Conclusão: o número barato **não** prova Luna 20× mais barata nem prova mock no brain. Prova tabela Luna zerada + custo residual do classificador DeepSeek misturado no total. Com a tabela 0 o harness **publicava US$0 como se fosse preço**.

Correção: `--real --provider luna` com `OPENAI_LUNA_INPUT/OUTPUT_USD_PER_MILLION=0` aborta (`recusando publicar custo US$0`). Não inventa preço comercial. O relatório passa a ter `pricingStatus` e `estimatedCostUsdByProvider`. Mock continua podendo logar custo 0.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npm run build` | 0 | |
| `smoke:ana-v2-behavioral-receipt` | 0 | schema 4; mock aborta; Luna unpriced aborta; 62×US$0+Flash thinking ≈ US$0,0012 |
| `smoke:ana-luna-responses-protocol` | 0 | fingerprint copiado quando presente; omitido quando a Responses não manda |
| `smoke:provider-protocol` | 0 | |
| `smoke:receptionist-provider` | 0 | |
| `smoke:ana-v2-tau2` | 0 | schema 6 intacto |
| `smoke:ana-conversational-v2-voice` | 0 | |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15; 73 chamadas |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15; 64 chamadas |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15; 73 chamadas; `requestedModel=gpt-5.6-luna`, `response.model=gpt-5.6-luna-mock`, fingerprint 73/73; `pricingStatus=unpriced`; `estimatedCostUsdByProvider={luna:0, deepseek:0.000012}` |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15; 64 chamadas |
| mock × interpreter **on** × **flash** × **voz** | 0 | Passos 30, FAIL 0, REVIEW 15; 94 chamadas |

Sem deploy. Sem push. Sem escrita na VPS. Sem `--real` (coordenador). Próxima matriz Luna `--real` exige `OPENAI_LUNA_INPUT_USD_PER_MILLION` e `OPENAI_LUNA_OUTPUT_USD_PER_MILLION` > 0; senão o braço aborta antes de publicar.

### Riscos que permanecem

- O contrato comercial da Luna continua de fora: esta exec não inventa USD/1M. Sem env preenchido o `--real` luna não corre — proposital.
- Responses API da Luna pode devolver `system_fingerprint: null`; o campo existe no log, o valor nulo não aborta.
- R10 no braço Luna ainda chama Flash no chefe Thinking; o custo dessa fatia aparece em `estimatedCostUsdByProvider.deepseek`, não deve ser lido como preço Luna.
- A matriz viva continua autorização do coordenador.

## Exec 7b — fail-closed do anti-mock, echo de fingerprint, juiz τ² sem fixture

**Status:** implementado na Ana; sem deploy; sem push; VPS intocada; `--real` continua autorização do coordenador. Esta exec **não** fez chamadas reais.

O conferente reprovou a Exec 7: o helper anti-mock rejeitava mocks no assert, mas `recordProviderCall` lançava **antes** do `push`. Voz/intérprete/social/regen/R10 engolem a exceção como `provider_error`/`PROVIDER_FAILURE`. A sonda integrada de voz comprovou o furo: `gateExceptionEscaped:false`, resultado `{ok:false, reason:"provider_error", returnedModel:null}` — a chamada inválida não entrava em `ctx.calls` e o sweep final não tinha o que reprovar.

Na matriz real o coordenador viu `systemFingerprint` 0/N em todos os braços (requestedModel ok) e o juiz τ² `--real` caiu em 401 com `sk-smoke-luna-invalid`.

### 1. Latch anti-mock fail-closed

Cada `providerCall` em `--real` agora: avalia o recibo → se inválido, **dispara o latch no `RunContext`**, **empurra a métrica com `poisoned:true`**, e só então lança. Camadas resilientes podem continuar engolindo a exceção; a detecção não desaparece.

`assertBehavioralPublishAllowedV2` roda **antes** de `mkdir` e de qualquer `writeFile`. Latch ou log poisoned ⇒ aborta sem `raw.json`, `summary.md` ou `comparison.md`.

A sonda integrada do conferente virou fixture em `smoke:ana-v2-behavioral-receipt`: mock atravessa as camadas reais que capturam exceção (brain, intérprete, social, regen, voz, chefe R10, juiz τ²). Em todas o latch dispara, o recibo poisoned entra no log, e o publisher espião não cria artefato.

Schema do relatório behavioral: **5**.

### 2. Echo de fingerprint (nunca silencioso)

`providerResponseEchoV2` lê o eco real:

| Transporte | Campos |
|---|---|
| chat/completions | `response.model` + `response.system_fingerprint` (também camelCase) |
| Responses API | `response.model` + `system_fingerprint` no topo **ou** em `metadata.system_fingerprint` / `metadata.fingerprint` |

Se o provider não devolver fingerprint: `response.model` continua no log e `fingerprintStatus: "absent"`. O summary deixa de ser um 0/N mudo: `Fingerprints: present X / absent Y / N`. Ausência **não** aborta (Responses da Luna pode omitir). Mock desta exec: 73/73 present (`fp_ana_v2_mock`).

### 3. Juiz τ² `--real` sem chave fixture

O ternário em `armConfig` injeta `sk-smoke-luna-invalid` **só no mock**. Em `--real`: `openaiApiKey=null` e o smoke **remove** chaves fixture do env (`sk-smoke-*`, `fixture`, `no-network`). Credencial do juiz = mesma resolução do adapter Luna (`OPENAI_API_KEY_LUNA` com fallback `OPENAI_API_KEY`); fixture conta como ausente ⇒ `pairwiseTone.status: "not_run"`, `inconclusive: true`, `nComparisons: 0`. Nunca 401 com chave de smoke.

### Validação Ana (exit real)

| Comando | exit | nota |
|---|---|---|
| `git diff --check` | 0 | |
| `npx tsc --noEmit` | 0 | |
| `npm run build` | 0 | |
| `smoke:ana-v2-behavioral-receipt` | 0 | schema 5; latch+poisoned; mutações 7 camadas sem artefato |
| `smoke:ana-luna-responses-protocol` | 0 | fingerprint do topo e de `metadata`; `absent` quando a Responses omite |
| `smoke:ana-v2-tau2` | 0 | schema 6; mock `not_run`; fixture key ⇒ `missing_credential` |
| `smoke:provider-protocol` | 0 | |
| `smoke:receptionist-provider` | 0 | |
| `smoke:ana-conversational-v2-wave1` | 0 | |
| `smoke:ana-conversational-v2-voice` | 0 | |
| `smoke:ana-conversational-v2-voice-fidelity` | 0 | |
| `smoke:ana-conversational-v2-contracts` | 0 | |
| `smoke:ana-conversational-v2-boundary` | 0 | |
| `smoke:ana-conversational-v2-recovery` | 0 | |
| `smoke:ana-conversational-v2-persistence` | 0 | |
| `smoke:ana-conversational-v2-route` | 0 | |
| `smoke:ana-conversational-v2-social-reads` | 0 | |
| `smoke:ana-conversational-v2-escalation` | 0 | |
| `smoke:ana-conversational-v2-interpreter` | 0 | |
| `smoke:booking-confirmation-gate` | 0 | |
| `smoke:service-gate` | 0 | |
| `smoke:professional-selection-gate` | 0 | |
| `smoke:customer-reply-guard` | 0 | |
| `smoke:receptionist-final-outbound` | 0 | |
| mock × interpreter **on** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15; 73 chamadas; fingerprint present 73/73 |
| mock × interpreter **off** × **flash** | 0 | Passos 30, FAIL 0, REVIEW 15; 64 chamadas |
| mock × interpreter **on** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15; 73 chamadas; schema 5 |
| mock × interpreter **off** × **luna** | 0 | Passos 30, FAIL 0, REVIEW 15; 64 chamadas |
| mock × interpreter **on** × **flash** × **voz** | 0 | Passos 30, FAIL 0, REVIEW 15; 94 chamadas |

Sem deploy. Sem push. Sem escrita na VPS. Sem `--real` (coordenador).

### Riscos que permanecem

- Fingerprint `absent` na matriz viva é agora um fato auditável, não um furo de cablagem. Se Flash/Luna realmente não ecoarem `system_fingerprint`, o relatório dirá `absent` — não inventamos fingerprint.
- O juiz `--real` com `OPENAI_API_KEY_LUNA` viva **vai chamar** a Luna; sem ela (ou só com fixture) fica `not_run`/inconclusive.
- Split de custo Luna vs `resume_thinking` DeepSeek da Exec 7 permanece correto; esta exec não mexeu em preços.
- A matriz viva continua autorização do coordenador.

