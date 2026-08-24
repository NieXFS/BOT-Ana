# Decisão FINAL (v2) — Arquitetura conversacional da Ana

Data: 2026-08-13 · Painel: Grok 4.6 xhigh (adversário, 2 rodadas) + GPT 5.6 Sol xhigh (estrutura, 2 rodadas) · Coordenador: Fable 5 · Base: `4e0c92a`.
Esta versão incorpora TODAS as mitigações da rodada 2 (Grok #13, S11/S12, N1–N7; Sol correções 1–5, lacunas 1–6, contratos e campos de recibo). É o contrato de implementação.

## D1 — Precedência e preempções tipadas

O compositor conversacional só escolhe ausência de resposta por `HUMAN_ACTIVE`. Qualquer outro não-envio é preempção tipada: `PAUSE_RECHECK` | `INBOUND_SUSPENDED` | `OUTSIDE_HOURS_THROTTLED` | `TRANSPORT_OUTCOME_UNKNOWN` | `SUPERSEDED_BY_NEW_INBOUND` (válido só com sucessor duravelmente persistido — ver D9). Ordem do fio: compliance/intake → resume gate e pausa → horário → snapshot/versionamento do turno → fast-path/modelo/recuperação → recheck de versão, TTL de pendência E pausa SOB LOCK → transporte → commit de entrega. "Nunca silêncio" NÃO vale após `isConversationPaused`; fallback só via `withConversationLock`; `getReply` não faz POST. **O recibo terminal de entrega existe mesmo sem POST** (`suppressed_pause`, `superseded`) — é o recibo da DECISÃO de entrega.

**D1-a — Autoridade fresca do `/pause-state`.** Pausas ordinárias positivas (`globalPausedUntil`, `conversationPausedUntil` e `schedulePausedUntil`) são memoizadas por no máximo 25 segundos. Depois do TTL, um `pausedUntil` futuro é apenas a última evidência conhecida e não impede a releitura autoritativa: uma resposta válida do ERP pode encerrá-lo antecipadamente. Em falha ou resposta nula, a última evidência positiva continua fail-closed; a falha não grava um snapshot inativo, para que a próxima chamada tente novamente. A escalada é atualizada pela resposta fresca (inclusive uma versão inativa posterior), sem sticky v33. O latch local tipado `ECHO` não é pausa ordinária, permanece soberano e nunca é apagado por um `pause-state` inativo; somente `releaseLocalEchoPauseAfterAnaResume` o libera. A fronteira final `isConversationPausedFresh` continua ignorando o TTL e consultando sempre.

## D2 — Pré-modelo allow-only

Saem da rota (v2): `unknown_denial`, `personal_ack`, o short-circuit `isUnknownCatalogServiceRequest`, o template de feedback e o template social como decisores. **Nenhum caminho pré-modelo emite negação.**

Fast-paths de seleção permitidos (respondem direto com copy canônica):
- nome completo único do catálogo atual;
- ordinal ESTRITO ancorado à pendência `OPEN` entregue: dígito isolado (`1`/`2`/`3`) ou forma contendo explicitamente "opção" ("primeira opção", "a segunda opção", "opção 2"). **"A última" foi REMOVIDO** (rodada 2 Sol). **`segunda`/`terça`/`quarta` nuas nunca são ordinal** → modelo;
- afirmativa compacta com exatamente 1 candidato.

**Gate de idade nos fast-paths [Grok #13/N6]:** se `now − pending.askedAt > 4h`, o fast-path RECUSA (inclusive afirmativa com 1 candidato) e o turno vai ao modelo com a instrução de re-confirmação (D3). Fast-path nunca chama write nem afirma disponibilidade: fixa candidato validado (`ResolutionProof`) e pergunta o próximo dado. Todo não-match, typo, duração, menção parcial → `continue_model`.

Classificadores antigos: shadow telemetry começa na Fase 4, termina obrigatoriamente no gate da Fase 8 OU em 14 dias corridos (o que vier primeiro), métrica só comparativa, nunca decide rota; remoção do código na mudança que fechar o gate.

## D3 — TurnFrameV2, flowState e contrato do modelo

`TurnFrameV2` (imutável por lote): `schemaVersion`, `turnId`, `inputSequence`, `catalogSnapshotHash`, `catalogState: available|unavailable`, `humanControl`, `currentInboundIds`, `pending {questionId, askedAt, kind, flowId, version, options[{position, entityId, displayName}]}`, **`flowState {flowId, fixedServiceId?, fixedProfessionalId?, resolvedDate?, fixedByProofVersion por campo}`** [Sol r2 lacuna 4]. O modelo recebe o frame COMO DADO (pergunta pendente nunca elevada a instrução; fala humana como participante `equipe_humana`, nunca `system`). Pendência velha (>4h): instrução de re-confirmar em vez de assumir; inbound que não nomeia opção/ordinal/entidade = reinício ou mudança de assunto, nunca "provavelmente responde".

Saída final do modelo (`ModelTurnResultV2` — contrato do Sol r2, normativo):

```ts
type PendingTransitionCandidate =
  | { kind: "preserve" }
  | { kind: "resolve"; questionId: string }
  | { kind: "invalidate"; questionId: string; reason: string }
  | { kind: "open"; pendingKind: "SERVICE"|"PROFESSIONAL"|"DATE"|"TIME"|"CONFIRMATION";
      flowId: string; optionEntityIds: string[] };

type ResolutionCandidate =
  | { kind: "pending_option"; questionId: string; position: number; entityId: string; inboundId: string }
  | { kind: "catalog_entity"; entityKind: "service"|"professional"; entityId: string;
      inboundId: string; span: { start: number; end: number } }
  | null;

interface ModelTurnResultV2 {
  schemaVersion: 2;
  reply: string;
  replyPurpose: "SOCIAL"|"SERVICE_QUESTION"|"PROFESSIONAL_QUESTION"|"DATE_TIME_QUESTION"|"OPERATIONAL_ANSWER"|"WRITE_CONFIRMATION"|"CLARIFICATION";
  pendingTransitionCandidate: PendingTransitionCandidate;
  resolutionCandidate: ResolutionCandidate;
  unknownServiceEvidence: { inboundId: string; span: { start: number; end: number } } | null;
}
```

Regras: `replyPurpose` não licencia fato; IDs/posições do modelo são CANDIDATOS validados pelo código contra o frame → `ResolutionProof`; **o validador de `pending_option` RECUSA resolução quando `now − pending.askedAt > 4h` (mesma regra do fast-path do D2), forçando re-confirmação** [rodada 3, delta-scan]; `questionId`/versão/`askedAt` da nova `OPEN` são do SERVIDOR. Fast-paths e fallbacks produzem o MESMO `PendingTransitionCandidate` normalizado. **Toda evidência textual é span tipado `{inboundId, start, end}` validado por code points contra o inbound ATUAL** [Sol r2 lacuna 5] — vale para `unknownServiceEvidence` e para a exceção social de dia/hora.

**Correção 2026-08-13 (pós-convergência, bloqueio do harness dos roteiros):** a implementação inicial validou o span de `resolutionCandidate.kind: "catalog_entity"` exigindo igualdade com o `displayName` COMPLETO — restrição que o contrato nunca pediu e que contradiz a semântica de token distintivo já usada no licenciamento de negação (D5.iii). Regra corrigida: o span deve (a) existir no inbound ATUAL por code points e (b) resolver **UNIVOCAMENTE** para o `entityId` alegado via o matcher canônico da casa (token distintivo + plural regular conservador + typo seguro de distância 1, mesma família do `service-gate`/`uniqueCatalogServiceFromCurrentMessage`; dias da semana nus continuam excluídos). Ambiguidade ou não-match ⇒ prova REJEITADA fail-closed (a resposta em si não é bloqueada; o estado só não fixa). Sem essa correção, "peeling"/"drenajem"/"não, peraí, peeling!" (R3/R4/R9 aprovados) jamais fixariam `flowState`, esvaziando os matchers profissional×estado, re-lista e entitlements que dependem dele.

**Tool-calls:** NÃO existe campo "callToolAgain". O loop nativo continua: resposta com `tool_calls` → executa e segue rodada; sem `tool_calls` → ramo final parseado como `ModelTurnResultV2`. "Loop principal roda uma vez" = UMA invocação do orquestrador por turno (várias provider calls internas são normais e contadas em `primaryModelRounds`/`primaryProviderCalls`). **Nota D4 pós-matriz 2:** loop 1× COM EFEITOS; uma invocação terminal com saída vazia e zero tools executadas pode ser repetida uma única vez. Qualquer tool no trace proíbe essa repetição e segue para regen/fallback. O provider NÃO tem `response_format` garantido: parser/validador estrito obrigatório; JSON inválido no ramo final = violação recuperável (1 regen no-tools → fallback dirigido).

## D4 — RecoveryCoordinator

- Loop principal com tools: no máximo 1 invocação por turno. Depois: congelar catálogo, frame, proof, toolTrace.
- **Write `success:true` + copy inválida → confirmação canônica derivada da write; NUNCA regen.**
- Sem write: UMA regeneração de copy — **função SEPARADA do loop** (uma única completion, `tools: []`, zero retries, snapshot congelado + reason codes; parser estrito).
- Ordem: scan de leak no candidato BRUTO → normalização mecânica → `customerReplyGuard` → `receptionistOutbound`, unificados em `BoundaryEvaluation` (taxonomia única). **Regen pendura nas DUAS fronteiras; `safe===false` ou `originalAccepted===false` dispara regen/fallback ANTES de existir payload vazio.**
- 2ª violação / erro / deadline → fallback canônico dirigido: identidade → copy de identidade; write → confirmação canônica; pendência ativa → repetir a pergunta pendente; catálogo indisponível → retry neutro; demais → esclarecimento neutro. **Nenhum caminho ativo retorna payload vazio.**
- Revalidar pausa + `inputSequence` + versão/TTL do `PendingFrame` antes da regen e novamente SOB LOCK antes do transporte; snapshot `OPEN` que virou `EXPIRED`/`INVALIDATED` no recheck → NÃO enviar copy de seleção; fallback = re-perguntar [Grok N6].
- Check de re-lista: dirigido por dados tipados — só proíbe re-lista quando `flowState.fixedServiceId` existe E `pendingTransitionCandidate.kind` não abre pendência `SERVICE`; propósito nunca inferido da copy; fallback que É a pergunta pendente isento.
- SLO: `regenCount ≤ 1`, deadline total da fase de geração, fallback ao estourar; medir taxa de regen e p95 end-to-end.

**D4 — Resultado terminal e silêncio tipado.** Todo turno ativo produz payload entregável, exceto quando termina como `SilentEscalationDispositionV2`. Essa exceção só é válida após falha da resposta primária e da única regeneração interna, sem write confirmado, com `recoveryKind="silent_escalation"`, `payload=null`, recibo terminal `transportOutcome="silent_escalation"` e um hold durável da intenção de escalada persistido antes do retorno. O hold pode estar `pending` enquanto o POST idempotente ao ERP é retentado, ou `confirmed` quando a Pergunta/pausa já existe. Pergunta ativa diferente e ownership humano concorrente também autorizam silêncio porque já existe estado autoritativo que impede a Ana de responder. Falha em persistir o hold NÃO autoriza silêncio: o turno deve sair pelo fallback técnico visível/M24, sem afirmar que a equipe foi acionada. `HUMAN_ACTIVE`, pausa, preempção e resultado de transporte ambíguo conservam suas regras próprias de silêncio. Um turno `SilentEscalationDispositionV2` persiste obrigatoriamente o `TurnPlanReceiptV2` e um `TurnDeliveryReceiptV2` terminal com `transportOutcome="silent_escalation"`, mesmo quando hold, pausa ESCALATION ou ownership humano já suprimem qualquer transporte. O silêncio elimina o outbound, nunca a auditoria técnica.

**Autoridades distintas da escalada silenciosa.** Uma escalada silenciosa possui três autoridades distintas: (1) a linha `ConversationPause(source=ESCALATION)`; (2) a `AnaQuestion OPEN`, que também deriva `escalation.active` no `pause-state`; e (3) o hold/cache local do Receps-IA enquanto o POST está pendente ou seu estado ainda está memoizado. Apagar somente uma linha SQL não constitui despausa válida. O fluxo normal de liberação é echo humano, assumir/cancelar/reativar pela superfície autorizada e a reconciliação do hold. Reload do runtime é medida de incidente somente depois de reconciliar os estados persistidos, nunca substituto do fluxo de produto.

**Emenda IA-19D — reconciliação de hold histórico (2026-08-20).** Um hold `confirmed` prova que o ERP confirmou uma Pergunta no passado, mas não que ela permaneça `OPEN` para um novo WAMID. O único bloqueio local é o `pending owner` da conversa, definido pelo menor `created_at` e, em empate, por `source_message_id ASC`; somente retry desse owner pode submeter POST. Diante de `confirmed` alheio, sem owner pending alheio, a Ana persiste o hold atual e submete POST idempotente ao ERP: `ACTIVE_QUESTION_DIFFERENT_SOURCE` preserva deduplicação e silêncio; criação aceita libera holds antigos `confirmed|active_elsewhere` e ancora a nova divergência. Depois de qualquer desfecho autoritativo, o overlay é recalculado no owner residual: pending remanescente mantém o silêncio conversation-scoped; sem pending o overlay pode ser limpo. Se essa recomputação falhar, o outcome ERP é preservado, a entrada conversation-scoped do cache é invalidada e o próximo lookup relê o store: enquanto indisponível retorna `unknown`/fail-closed, sem latch eterno; após recuperação recompõe `active` ou `inactive`. `ECHO_HUMAN_ACTIVE` continua liberando todos os holds e limpando o overlay. Em dúvida de transporte, o hold atual permanece `pending` e fail-closed. A reconciliação histórica é estritamente conversation-scoped, nunca libera `pending` nem o source atual, e sua falha depois de uma criação aceita não desfaz a Pergunta nem altera o resultado/recibos do turno.

**Pré-condição de deploy IA-18:** o Exec IA-19A (corrida echo×divergência, hold obrigatório do silêncio, e SERVICE/FAMILY capada) é pré-condição do deploy conjunto IA-18. Sem IA-19A o trem não sobe.

## D5 — Fronteira de fatos endurecida

- **Split UNKNOWN_SERVICE:** `UNKNOWN_SERVICE_OFFER` (oferta positiva fora do catálogo) com POLARIDADE local ("não/nunca" no prefixo da oração anula o match de oferta — helper de polaridade ÚNICO e compartilhado, nunca duas regexes divergentes). Depois que um segmento resolve univocamente para serviço canônico, orações tipadas de preço/duração deixam de contar como resíduo do NOME; o candidato integral continua sujeito a `UNKNOWN_PRICE`, e qualquer modificador de serviço desconhecido remanescente continua bloqueando. `UNLICENSED_SERVICE_UNAVAILABLE_DENIAL`: negação só licenciada quando TODAS: (i) `unknownServiceEvidence` com span tipado válido no inbound ATUAL; (ii) nenhum match de token distintivo do catálogo no inbound NEM no span (semântica do `uniqueCatalogServiceFromCurrentMessage`: "peeling", "limpeza", "drenajem"-typo ⇒ `continue_model`, nunca denial); (iii) o span, após strip de nomes de catálogo, verbos de agenda, dia/hora/período e vocabulário operacional genérico (`retorno`, `encaixe`, `avaliação`, `unidade`, `manhã`, `tarde`, `noite`, `horário`), ainda contém ≥1 substantivo de procedimento [Grok N3]. Sem licença → regen para esclarecimento neutro; NUNCA enviar negativa. Copy licenciada = genérica canônica, sem ecoar o termo.
- **Prompt de sistema reescrito:** regra E — negar só com procedimento concreto nomeado fora do catálogo; PROIBIDA a frase canônica para verbo de reinício, período do dia ou "quero agendar". Regra A harmonizada com o frame.
- **Matchers de fato mole (fail-closed, mesmo gatilho de regen):** (i) claim de disponibilidade/ocupação SEM evidência do turno — categoria, não lista de strings: "tem vaga", "tem/temos horário", "te encaixo", "está lotado/cheio", "tem espaço", "agenda cheia/livre" [Grok N7]; (ii) compromisso implícito "te vejo/te espero/te aguardo" + data/hora sem write/read compatível; (iii) profissional citado incompatível com `flowState.fixedServiceId` (contra o ESTADO, não a mesma frase); (iv) horas por extenso ("15 horas", "das 8 às 18", "oito da manhã") no normalizador de afirmações temporais.
- **Read fast-paths:** leitura de agendamento existente por pedido explícito atual **OU `ResolutionProof` válido do fluxo de duplicidade (mesmo `flowId`+versão)** [Sol r2]; disponibilidade por serviço único + data resolvida + pedido explícito + gate profissional; POLARIDADE (negação anula); falha de tool → copy canônica por `reason`, nunca `message`/`hint` bruto. Não-match → modelo; nunca negação.
- **`UNRECORDED_HANDOFF` continua GLOBAL** e roda antes do boundary social: promessa de transferência humana sem ação autoritativa bloqueia em qualquer rota [Sol r2].

## D6 — Social opt-in humanizado

- Rota social selecionada APENAS por detecção positiva, estrita e TOTALMENTE consumidora (saudação, cortesia, elogio, despedida, smalltalk puro). Leftover operacional ("obrigada! e amanhã tem horário?") → rota modelo. Entidade de catálogo presente ("kkk drenagem") → rota modelo com frame.
- Chamada SEM tools, SEM catálogo no prompt, 1–2 frases.
- Blocklist social (regen no-tools; 2ª falha → template atual): serviço/profissional/agenda; preço em qualquer forma (com/sem R$, por extenso, "baratinho"); horário de funcionamento em qualquer forma; promoção/pacote/pagamento; endereço/localização; lotação/encaixe; duração; staff não catalogado; canal paralelo; claim clínico; **instrução de comparecimento (chegar X min antes, preparo, vestimenta, jejum)** [Grok S11]; **fatos sobre pessoas/identidade ("a dona já te conhece") e promessa de retorno humano** [Grok S12 — soma-se ao `UNRECORDED_HANDOFF` global].
- Eco de dia/hora: permitido SÓ para span temporal presente no inbound ATUAL (span tipado; nunca histórico, nunca hora nova).
- **Turno social não responde nem expira a pendência OPERACIONAL** (a resposta social é entregue normalmente): `PendingFrame.OPEN` preservado sem CAS de resolução; recibo registra `pendingTransition: preserved`; a resposta social não vira âncora operacional.
- `greetingMessage` do tenant vira fallback documentado (dado ERP não reinterpretado).
- **Correção 2026-08-13 (bug do R8, matriz mock):** o `SOCIAL_CONTEXT_DRIFT` herdado do avaliador v1 dentro do `BoundaryEvaluation` estava reclassificando a mensagem inteira na saída — contradição direta com este D6. Regra corrigida (fórmula da mitigação Grok r1 #11): na rota v2, o drift herdado só se aplica quando TODAS: (a) rota = modelo (na rota social governa a blocklist própria); (b) a permissão do turno computada sobre o inbound COMPLETO é NO_OPERATIONAL_INTENT ou SOCIAL_ONLY (leftover transacional/informacional ⇒ sem drift); (c) inbound sem entidade de catálogo; (d) sem pendência ANA `OPEN`. Mensagem mista ("obrigada!! e amanhã tem horário?") responde social + operacional na mesma resposta com evidência, como o R8 exige. A proteção anti-empurrão de agenda em papo pessoal continua: nesses turnos (b–d verdadeiros) o drift segue armado, com regen → fallback, nunca silêncio. Rota v1 permanece intocada.

## D7 — PendingFrame + outbox delivery-aware

Estados `NONE → OPEN → RESOLVED | INVALIDATED | EXPIRED | SUPERSEDED`; chave `conversationKey+flowId`; CAS por versão. Fala humana invalida SOB LOCK; `reset` do modelo commita só após validação+entrega; TTL `askedAt+24h` = teto de contexto ativo (idade exposta no frame; re-confirmação >4h).

**Outbox (normativo — fecha N1/Sol lacuna 1):**
`prepared → transport_started → accepted_by_provider | transport_unknown | transport_failed`
- `prepared` persiste ANTES do POST; `transport_started` persiste imediatamente antes do POST.
- Crash com `transport_started` sem terminal → fail-closed: NUNCA re-POST automático; sweeper marca `transport_unknown`.
- Aceite da Meta → UMA transação local: histórico + `PendingFrame.OPEN` + recibo `accepted_by_provider`. Se essa transação falhar → estado `accepted_uncommitted`: repetir SOMENTE o commit local (idempotente), NUNCA o POST.
- **Inbound chegando com outbound `accepted_uncommitted`/`transport_started` pendente na conversa:** reconstruir o frame a partir do payload aceito OU preempção `INBOUND_SUSPENDED` até o sweeper materializar — o inbound NUNCA segue com `pending: NONE` enquanto existe pergunta aceita não commitada [Grok N1].
- Apenas `accepted_by_provider` alimenta `PendingFrame` e o histórico que o brain lê; inbounds agrupados por lote/`turnId`.

## D8 — Recibos duplos (campos normativos do Sol r2)

`TurnPlanReceiptV2`: `schemaVersion`, `planReceiptId`, `turnId`, `frameHash`, `inputSequence`, rota `fast_path|model|regen|fallback|preempted|interpreter_hit|interpreter_nenhuma|interpreter_error`, `primaryModelRounds`, `primaryProviderCalls`, `regenProviderCalls`, `pendingTransitionCandidate` REDIGIDO (sem nomes/IDs de catálogo), `toolEffects[] {invocationId, tool, classe read|write, outcome, writeCommitted}` (nunca args/resultados crus), `boundaryAttempts[] {índice, hash opaco, reason codes}`, `recoveryKind: none|regen|canonical_write_confirmation|direct_fallback`, resultado `accepted_for_delivery` (nunca "sent").
`TurnDeliveryReceiptV2` (recibo TERMINAL da decisão de entrega; existe também para `suppressed_pause`/`superseded` sem POST): `deliveryReceiptId`, `planReceiptId`, `turnId`, `deliveryAttemptId`, `transportStartedAt`, `transportOutcome`, `providerMessageIdHash` (só quando recebido), `outboxState`, `conversationCommitOutcome: committed|accepted_uncommitted|not_applicable|failed`, `pendingCommitOutcome: opened|preserved|resolved|invalidated|cas_conflict|not_applicable|failed`, `successorTurnId` (obrigatório em `superseded`, referenciando turno JÁ persistido), versões CAS esperada/observada, timestamp terminal.
Proibido em ambos: texto, telefone, `wamid` em claro, `displayName`/`entityId` de catálogo, args/resultados de tool. **Correção 2026-08-13:** todo campo `*hash` de recibo é SHA-256 COMPLETO (64 hex) — hash truncado é proibido nos recibos, porque o redator fail-closed trata qualquer valor fora de 64 hex como conteúdo potencialmente sensível (um 16-hex com sequência de 10+ dígitos foi confundido com telefone e abortou a entrega no primeiro run da matriz). Métricas: % social via modelo, taxa de bloqueio por candidatos gerados, taxa de regen, p95 end-to-end.

## D9 — Corridas e supersession

- `inputSequence` no frame; comparação SOB LOCK.
- **Write `success:true` no toolTrace congelado PROÍBE descarte [Grok N2]:** enviar confirmação canônica, commitar entrega; o sucessor nasce como turno que LÊ (`getUpcomingAppointments`) e não escreve sem novo ciclo completo de confirmação. `SUPERSEDED` não apaga write.
- Sem write: se `pendingTexts` cresceu ANTES do POST → não posta; **enfileiramento DURÁVEL do lote sucessor (registro nomeado, sobrevive a restart, reprocesso idempotente, sweeper pelo outbox — nunca só o `Map` do processo)** [Grok N4/Sol lacuna 2]; só então `SUPERSEDED`.
- POST já saiu com `accepted`/`unknown` → NÃO reprocessa-e-envia (anti-duplicata vence); o texto da cliente alimenta o PRÓXIMO turno.
- **Anti-starvation [Grok N5]:** após o 1º `SUPERSEDED`, rearmar debounce (12s) no lote concatenado; teto de 2 reprocessos; estourou → fallback dirigido no-tools ("recebi várias mensagens, me confirma o que você prefere?").
- Echo humano vence antes, durante e depois da regen.

## D10 — Migração

Flag `ANA_CONVERSATIONAL_V2_TENANT_SLUGS` (default vazio; sem `*`; avaliada antes de qualquer efeito; turno iniciado em v2 termina em v2). Schema aditivo; rollback = flag OFF, sem down migration; v1 ignora dados v2. **Fases contratuais 0–8; canário futuro é execução separada pós-gate, FORA desta entrega** [Sol r2]. Ajustes de fase: `flowState` + DTOs de telemetria redigidos na F1; polaridade + matchers de fato mole + pós-condição de re-lista na F2; registro durável de sucessor na F3; matriz de ordinal + matcher de profissional×estado na F4; blocklist social + casos de eco temporal na F5; entitlements de read (incl. proof de duplicidade) na F6; recibos/corridas (4 pontos de injeção + restart) na F7; gate completo SEM deploy na F8. Matriz DeepSeek e canário: SOMENTE após aprovação dos 10 roteiros pelo Victor.

## D11 — Testes por invariantes

Replays I1–I3 + invariantes da v1 + rodada 2:
- Loop: 1 invocação de orquestrador, N provider calls contadas; fixture read→write→final.
- Regen: `tools.length===0`; qualquer `tool_calls` na regen = inválido → fallback; write 1× no executor.
- PendingFrame: matriz transporte failed/unknown/suppressed → nenhuma OPEN; accepted+commit ok → 1 OPEN; social → OPEN preservada; reset rejeitado → sem transição; **accepted+commit fail → `accepted_uncommitted`, sem re-POST, reconciliação local; inbound nesse estado → frame reconstruído ou `INBOUND_SUSPENDED` (nunca `pending: NONE`)**.
- Corridas: inbound novo injetado em 4 pontos (durante primary, antes da regen, durante regen, antes do POST) → zero POST velho, `superseded` + `successorTurnId` persistido + sucessor processado APÓS RESTART SIMULADO; echo humano vence na mesma matriz; burst → teto 2 reprocessos + fallback.
- Boundary (property/tabela sobre candidato bruto): "não fazemos X" não ativa oferta; denial sem span atual bloqueia; span "retorno"/"unidade" NÃO licencia denial; "peeling"/"drenajem" → continue_model; "tem vaga"/"tem horário"/"está cheio" sem slot bloqueia; "te aguardo às oito" sem write/read bloqueia; profissional × `fixedServiceId` bloqueia sem serviço na frase; "sexta às 20h" social passa SÓ com span do inbound atual; "segunda" nua não produz proof; ordinal >4h recusa fast-path; toda rejeição termina em payload canônico não vazio ou preempção enumerada.
- Recibos: reconciliação 1:1; teste recursivo de redação (falha se contiver texto/telefone/IDs de catálogo/wamid/args).
- Suite v1 legada sob adapter enquanto a flag existir; hard gates sem flexibilização.

## REVISÃO 2 (2026-08-13, consenso Fable×Sol×Grok pós-matriz-real) — Interface plana e reducer de lifecycle

Evidência: DeepSeek Flash real conversa corretamente mas não emite o envelope rico (3/3 turnos em prosa; transições nunca declaradas; probes: contrato mini obedecido, `json_object` convive com tools). Auditoria adversária das emendas (Grok, kill list K1–K8) e parecer estrutural (Sol, MODIFICAR) convergiram no seguinte, que SUBSTITUI a interface externa do modelo definida no D3 (o contrato interno `ModelTurnResultV2` permanece):

**R2-a — Interface plana única** (primário E regen): `{"reply": string, "nextPending": "SERVICE|PROFESSIONAL|DATE|TIME|CONFIRMATION|PRESERVE|RESOLVED", "chosenOptionText": string|null, "unknownServiceText": string|null}`. Tradução server-side fail-closed: textos localizados SOMENTE nos inbounds do lote atual (todos os `currentInboundIds`), com mapa reversível de offsets na normalização; resolução computada pelo matcher canônico sobre o INBOUND COMPLETO com polaridade por oração [Grok K1] — `chosenOptionText` deve CONCORDAR com essa resolução; full-match que é prefixo próprio de outro nome ⇒ ambíguo [K2]; resolução cruzada serviço×profissional no mesmo texto, typo nunca vence full/token de outro entityId [K8]; correção posterior no lote governa (supersession); ocorrências levando a entidades distintas ⇒ sem prova; `unknownServiceText` não licencia denial se houver entidade canônica no span OU no contexto completo; `replyPurpose` DERIVADO pelo servidor (tabela do parecer Sol); candidato rejeitado nunca derruba a copy. Servidor único dono de IDs/versões/opções/spans.

**R2-b — JSON mode em todo o brain v2** atrás de capability explícita do provider; `tool_calls` prevalece sobre `content` (whitespace normalizado, nunca resposta final); rodada final sem tool_calls → parser estrito PLANO (interface externa única — proibido fallback pro parser rico); lembrete pós-tool encolhido; v1/social/texto-puro inalterados. Smokes: tool 1ª rodada, 2+ rodadas, whitespace+tool_calls, final JSON, final vazio, chave extra/enum inválido.

**R2-c — Reducer determinístico de lifecycle** [substitui o backstop amplo; refutação Sol aceita]: `nextPending` é candidato validado por tabela de precondições — `TIME` exige slots autoritativos do turno (opções derivadas SÓ deles); `CONFIRMATION` exige `BookingDraftV2` completo e compatível; `RESOLVED` exige evento terminal; `SERVICE/PROFESSIONAL/DATE` materializam opções só de catálogo/elegibilidade/estado tipado. NENHUM lifecycle inferido da redação. Reducers silenciosos só com copy canônica do servidor: `bookAppointment success:true` → fecha + confirmação canônica; `getAvailableSlots success:true` → pode abrir TIME se o servidor entregar oferta canônica dos mesmos slots; opção TIME validada contra o PendingFrame → `BookingDraftV2` + resumo canônico + abre CONFIRMATION. Prosa segura sem envelope válido → copy candidata pelas fronteiras + PRESERVE. `BookingDraftV2` server-owned `{serviceId, professionalId?, date, time, slotEvidenceTurnId}`, invalidado em mudança de serviço/profissional/data; NÃO licencia escrita (gates intactos).

**R2-d — Kills do Grok incorporados:** K3: resumo pré-booking só com horários ⊆ evidência de slots DO TURNO (preferência da cliente sozinha NÃO licencia), data validada contra estado/turno, profissional pelo predicado K5; `chosenTimeWithoutRead` vira CONTRAPROVA. K4: cláusula (c) do escopo do drift REMOVIDA (token de catálogo em turno NO_OPERATIONAL_INTENT/SOCIAL_ONLY mantém drift; R8 segue coberto pela permissão (b)). K6: descarte temporal-only da oferta exige ≥1 `kind:time` normalizado + evidência de slot; `disponibilidade/agenda/vagas` nuas = claim de lotação (mesmo saco do D5.i). K7: regra de booking SÓ com `pending.kind===CONFIRMATION` deste flowId + confirmação explícita; 2ª frase apagada; CONFIRMATION de resolução de duplicidade excluída. K5 (fecho consensual): fast-path de troca de serviço ZERA `fixedProfessionalId` (como `flowStateWithProof` já faz); descarte do UNKNOWN_PROFESSIONAL exige resolução unívoca ∧ fora da stoplist (nome da bot, substantivos comuns) ∧ [inbound polar-positivo resolve o MESMO ID ∨ toolTrace do turno com `getAvailableSlots` success ou falha qualificada de book com `result.professionalId===ID` ∨ trustedProfessional: `fixedProfessionalId===ID` ∧ elegível pro `fixedServiceId` ATUAL ∧ fixado nesta versão de serviço].

## ONDA 1 ANA DESTRAVADA (2026-08-14, consenso pós-canário)

- **P1 — data→slots determinístico:** só dispara com pendência `DATE` ou correção de `TIME`, serviço fixo, gate profissional válido e UMA data civil resolvida no lote atual completo. Correção posterior no burst vence; duas datas sem correção falham fechado. Nunca usa `resolvedDate` residual como gatilho. Data nova veta o fill do `TIME` antigo e o novo `OPEN TIME` o supersede. A leitura permanece sujeita às corridas do D9; `slotEvidence.date` registra a origem e toda oferta canônica nomeia `dd/mm/aaaa`. Grade vazia reabre `DATE`.
- **P2 — sessão operacional sem amputar histórico:** `flowState.lastOperationalAt` é relógio server-owned commitado. Idle maior que 4h inicia novo `flowId`; linha física continua 24h e `EXPIRED` nunca ressuscita estado. Reinício explícito só zera estado quando não há serviço/profissional/data/hora no lote e não existe pendência fresca aproveitável, salvo `SERVICE`. `DATE|TIME|CONFIRMATION|PROFESSIONAL` frescas são soberanas. Reset com copy `PRESERVE` invalida a pergunta velha no mesmo commit. Histórico não é cortado nem apagado.
- **P3 — duplicidade proativa no ponto computável:** somente uma opção `TIME` validada contra `PendingFrame`+`slotEvidence` cria `BookingDraftV2` e autoriza a leitura v2 de `getUpcomingAppointments`; o modelo não recebe essa licença e o gate v1 permanece igual. Identidade ambígua ou titular divergente retorna copy segura sem qualquer fato. Conflito = mesmo serviço no mesmo dia OU sobreposição temporal no mesmo dia. Só o conflito compatível é mostrado; IDs nunca saem. A pendência usa os quatro `optionEntityIds`/`displayName` canônicos e o gate de write continua sendo o backstop.
- **P6 — naturalidade fora das âncoras:** variantes determinísticas existem apenas em saudação/conectivos server-owned de pergunta de serviço, pergunta de data e oferta de slots. Resumo de booking, confirmação modal, duplicidade e perguntas canônicas de fallback continuam byte-idênticos. `copyVariant` é proveniência técnica no recibo/commit, e a última variante aceita impede repetição consecutiva.
- **P5a — braço OpenAI:** `aiProvider:"openai"` + `gpt-4o-mini` usa o mesmo runtime v2 e o harness aceita `--provider openai`; DeepSeek continua default e o chefe R10 continua no contrato próprio.

## ONDA 2.5 — INTÉRPRETE DE PODER ZERO (2026-08-14, consenso adversário K4–K11)

- **Escopo e trigger:** feature default OFF, executada somente depois de todos os fast-paths determinísticos falharem e apenas com pendência `OPEN` não modal fresca ou testemunha operacional barata no lote atual. `flowState` sozinho, ack ou lixo não chamam o intérprete. `CONFIRMATION` + ack compacto nunca entra; opções de booking/duplicidade/reentrada nunca compõem o enum.
- **Contrato mínimo:** chamada no mesmo provider do braço, `tools: []`, timeout curto, JSON estrito `{choice, span?}`. O prompt contém só tokens opacos `OPT_n`; IDs de entidade/agendamento não entram. Cada opção já nasce de uma família com testemunha lexical positiva no inbound completo. Negação local remove a família; duas famílias, ambiguidade, enum inválido, chave extra, timeout ou erro resultam em `NENHUMA`/erro fail-closed.
- **Pós-condição server-owned:** `span` apenas concorda e nunca escolhe alvo; toda resolução é refeita contra o lote completo pelos matchers canônicos. `NENHUMA` é byte-equivalente ao miss anterior: continua no brain, sem denial/reset/invalidação. Opções só podem resolver `SERVICE|PROFESSIONAL|TIME`; nunca `CONFIRMATION`, write ou fato.
- **Rotas tipadas:** `CONSULTAR_AGENDA` usa o read v2 identity-safe e só recorta por data civil unívoca do lote; disponibilidade não vira consulta de agenda. `CANCELAR|REMARCAR` fazem exclusivamente `getUpcomingAppointments` + copy segura existente, com zero `cancelAppointment`; seleção final continua nos gates legados sobre o inbound completo. `NOVO_AGENDAMENTO` apenas seleciona a pergunta server-owned já existente. `FALAR_HUMANO` exige testemunha humano/atendente/pessoa/equipe e chama a escalada autoritativa existente; nome de profissional de catálogo nunca escala.
- **Observabilidade e medição:** recibo distingue `interpreter_hit|interpreter_nenhuma|interpreter_error`, sem PII. Harness aceita `--interpreter on|off`, ortogonal a `--provider flash|luna`; cobertura não é objetivo, precisão contra write e preempção modal é o gate.

## REVISÃO 3 (2026-08-14) — Camada de voz (síntese) + harness τ²

Consenso: interseção do ataque (kill list da voz) e do parecer de estrutura. A voz **não** é estágio da `BoundaryEvaluation`. Mora no runtime v2 depois da política/recovery e das coerções finais, **depois da P6**, antes de `PreparedReceptionistTurnV2` e fora de `withConversationLock`. Fail de qualquer camada devolve o template **pós-P6** já aprovado + recibo `voice.outcome = voice_rejected`. Sem regen, sem segunda chamada, sem silêncio. `copyVariant` permanece o ID da P6; voz é subrecibo ortogonal (`decision`, hashes, `providerCallCount`).

### VOZ-1 — rephrase em runtime, só Fase 1A

Opt-in por `ServerCopyProvenanceV2` (`producer:"fast_path"` + `copyId` server-owned). Ausência, producer que não seja fast-path, `copyId` desconhecido ou registry `off` ⇒ não chama o LLM. IDs da Fase 1A: `initial_service_question`, `booking_reentry_service_question`, `service_selected_date_question`. Allowlist `ANA_CONVERSATIONAL_V2_VOICE_TENANT_SLUGS` vazia por default, sem `*`. Matriz/testes injetam o booleano do braço.

Ordem: (1) template final pós-P6/recovery atravessa `evaluateBoundaryV2` completa; (2) rephraser isolado devolve **somente** um `VoiceConnectiveId` de enum finito (`tools:[]`, thinking OFF, T=0.3, teto 48 tokens, timeout 4s, zero retry); o servidor materializa a frase aprovada e compõe pergunta, lista e ordem canônicas. ID desconhecido, texto livre, campo `connective` ou ID incompatível com o ato ⇒ template cru. Não há gramática aberta nem denylist/regex de conectivo; (3) conferência determinística (o prefixo tem de ser exatamente a frase materializada do enum daquele ato); (4) checkpoint `during_voice`; (5) segunda `evaluateBoundaryV2` completa com `source:"VOICE_REPHRASE"` (fonte gerada, nunca `CANONICAL`); (6) entrega ou fallback ao template aprovado. **Inbound da cliente fica fora do prompt**. Histórico 1A = 0 turnos. Dados sensíveis fora. Proveniência de voz é zerada se `recoveryKind !== "none"` ou o payload recuperado diverge do payload associado após a P6.

Conferência (falhou QUALQUER camada ⇒ template cru + `voice_rejected`):
- `semanticAct` específico (`ask_service` ≠ `ask_date` ≠ handoff); prefixo fora do enum do ato (inclui as sondas `Botox funciona!`, `Gestantes podem fazer!`, `Sem contraindicações!`, `É totalmente seguro!`) rejeita;
- speech-act fechado `OFFER|DENY|ASK|CONFIRM_ACT|COMPLIANCE` classificado no template pelo `copyId` **antes** do LLM; o rewrite devolve a mesma classe;
- igualdade de **conjunto** e de **ordem** de serviços/profissionais/slots (omitir, acrescentar ou reordenar falha; “existe no catálogo” não licencia);
- polaridade/modalidade, inclusive negação pós-fixada (`X não é oferecida`);
- fatos duros (data absoluta no fuso do tenant, hora `15h`≡`15:00`, centavos, duração por algarismo **ou** por extenso, write_state); fato novo, ausente, relativo (`amanhã`) ou não interpretável rejeita (`hard_fact_uninterpretable`);
- denylist de modificadores (`só`, ranking, clínico, preço inventado) e CTA novo (CPF/link/handoff);
- repetição exata da última entrega, se o template atual for outro, rejeita só a voz.

### VOZ-2 — pools compilados (risco zero no runtime)

Famílias densas/quase-âncoras **proibidas** de rephrase em runtime: `availability_slots_offer` (oferta de slots) e `booking_reentry_question` (reabertura). Pools de 8–15 variantes por template, gerados offline, validados em lote pela conferência completa. Nesta entrega os fixtures estão marcados `PENDENTE-PAINEL`; o runtime **só** escolhe variante se `reviewStatus==="aprovado"` (anti-repetição no mesmo espírito da P6, `copyVariant` intocado). A geração real dos pools é corrida **separada e gateada**. Denial licenciada **não** entra em pool.

### VOZ-3 — denylist PERMANENTE (byte-fixos para sempre)

Nunca rephrase, nunca pool, nunca “fase 2 com conferência estrita”. `VoiceEligibleCopyIdV2` é disjunto de `PermanentVoiceAnchorIdV2`; `fastPathProvenanceV2` só aceita IDs elegíveis; produtores de âncora devolvem `null`; o resolver veta a denylist **antes** de qualquer lookup, com registry congelado. Conferência estrita **não** restaura igualdade byte a byte do eco modal nem os matchers léxicos de gate.

| copyId | Por que é âncora |
|---|---|
| `canonical_booking_summary` | `matchesScopedV2ModalEchoConfirmation` exige payload ≡ gerador canônico |
| `write_success_confirmation` | predicado do ato; zero entidades; D4: write nunca regen |
| `duplicate_choice_question` | `assistantPresentedDuplicateChoice` lê o texto (`manter`/`remarcar`/`cancelar`) |
| `half_hour_clarifier` | `activeHalfHourClarificationPositionV2` exige igualdade com `lastAcceptedAssistantText` |
| `licensed_service_denial` | denial só passa byte-idêntica a `UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2` |
| `cancel_compliance` | copy de incapacidade; rephrase vira handoff/falsa write |
| `identity_safe` | fail-closed de PII; zero entidades |
| `confirmation_reask` | anti-repetição da boundary só libera a copy normativa de `CONFIRMATION` |

O eco modal **não** é afrouxado. Gate de “pode” continua exigindo o resumo canônico exato.

### τ² — harness evolutivo (não substitui o atual)

Task JSON: o runner valida/carrega tasks, clona `initial_state` por `taskId×armId×trialId`, executa a sessão completa (atos do controlador, `oracle_acts`), projeta o estado final fechado e registra os três fatores. `env_assertions` (DSL fechada `path`+`op`+`expected`) / `communicate_info` tipado (`service`/`date`/`time`/`money_cents`, `15h`≡`15:00`). Reward binário `STATE × ENV_ASSERTION × COMMUNICATE`. STATE compara a projeção canônica completa (hash); efeito extra zera. `pass^1 = c/n`; `pass^4 = C(c,4)/C(n,4)` **por taskId × armId**, depois macro; **não** misturar braços na mesma linha e **não** usar `(pass^1)^4`. Simulador restrito: controlador escolhe o ato, LLM só verbaliza; auditoria amostra transcripts reais e deriva rótulos (`ok`, `act_not_in_controller`, `oracle_sequence_mismatch`, `empty_agent_payload`, …) — nunca `failCount` manual; cobertura < `max(30, 20%)` ou zero/uma auditoria torna a matriz inconclusiva. Erro crítico >5% também. Replay nomeado `fixed_user_replay`; incompatibilidade = `replay_incompatible`. Tom = juiz experimental **separado**, fora do reward. Execução `--real` faz preflight/recibo de provider+modelo por braço; o 5º braço chama `deepseek-v4-flash` na voz e rejeita recibo `*-mock` ou `gpt-4o-mini`. Schema do relatório do harness: 4.

Braços: `flash`, `luna`, `flash+interpreter`, `luna+interpreter`, `flash+interpreter+voz`. Flash = `deepseek/deepseek-v4-flash`. O quinto só é válido pareado ao Flash idêntico em todas as outras dimensões (`voicePairingIsValidV2`). Schema do relatório τ²: 4 na R3; 5 na R4; **6 na Exec 6b**. Schema do relatório behavioral (`ana-v2-roteiros`): **4 na Exec 7; 5 na Exec 7b**. Cada `providerCall` do behavioral leva `requestedModel` + `response.model` + `response.systemFingerprint` + `fingerprintStatus` (`present`|`absent`). `--real` aborta (nunca publica) se o recibo for `*-mock`, o modelo divergir do braço, ou a tabela Luna `OPENAI_LUNA_*_USD_PER_MILLION` estiver 0. O assert anti-mock **registra** a métrica (`poisoned`) e um latch no `RunContext` **antes** de lançar; o sweep final reprova o latch/log **antes** de `mkdir`/`writeFile`, mesmo se voz/intérprete/social/regen/R10 engolirem a exceção. `ProviderCallMetric.kind` inclui `voice`. Juiz τ² `--real`: só credencial viva de env (`OPENAI_API_KEY_LUNA` com fallback `OPENAI_API_KEY`, mesma resolução do adapter Luna); chave fixture ⇒ `not_run`/inconclusive. O hardening preventivo reconhece `sk-proj-` viva (~164) antes da denylist textual; ele não é apresentado como causa do incidente 7c, pois as duas chaves observadas não continham `smoke`. `npm run smoke:ana-v2-tau2 -- --real` preserva `OPENAI_API_KEY` exportada (`${OPENAI_API_KEY:-sk-smoke-invalid}`). O juiz lê `process.env` no momento da chamada, sem clone precoce.

## REVISÃO 4 (2026-08-14) — Protocolo do provider, purga de workflow, canário pt-BR, juiz pairwise

Adendo §6 do dossiê (Deep Research GPT 5.6). Não muda a arquitetura; reforça o plan-then-realize já escolhido.

### tool_choice required/named (non-thinking, DOC OFICIAL)

A limitação "thinking rejeita tool_choice" é **só do thinking**. Non-thinking documenta `auto|none|required|named`. Onde a máquina de estados já sabe que o próximo ato só pode ser tool (`forceUpcomingRead` no sucessor pós-write; named `getUpcomingAppointments`), o loop envia `initialToolChoice` atrás de `supportsToolChoiceRequired`. Thinking **omite** `tool_choice`. Capability falsa degrada para `auto` (OpenAI) ou omissão (DeepSeek). DeepSeek non-thinking continua omitindo `auto` (default oficial).

Pseudo-tool-call em `content` **nunca** é desserializada nem executada — só telemetria `PSEUDO_TOOL_IN_CONTENT`. Forced choice + texto puro ⇒ `EXPECTED_TOOL_GOT_TEXT` + uma regeneração na mesma rodada, sem executar o content. HTTP 200 + content vazio + sem `tool_calls` ⇒ `EMPTY_GENERATION`, nunca "mensagem vazia válida".

### Suíte de protocolo (separada da de negócio)

`scripts/smoke-provider-protocol.ts` / `npm run smoke:provider-protocol`. Fixtures mínimos × N=12: auto com tool necessária → `tool_calls` estruturado; required non-thinking → nunca texto puro executado; named → nome exato; strict válido/inválido → aceito/400; pós-tool → não-vazio; injection tool-like no texto da cliente → zero execução. Default mock offline. `--real` é barato e só para revisão de modelo (esta exec não o corre).

### Purga da linguagem de workflow (não-âncora)

Copies canônicas fora da denylist permanente de âncoras byte-fixas. Âncoras da VOZ-3 **não** são tocadas. `VOICE_TEMPLATE_VERSION_V2 = 2`. Varredura `findWorkflowLanguageV2` na suíte.

### Canário linguístico pt-BR

Fixtures permanentes: `pra`, `tá`, elipse, `pode ser às 15?`, `depois das três`, correção de horário. Vendor não cobre pt-BR falado.

### Juiz de tom pairwise no τ²

Mesmo payload ⇒ A=template, B=variante. Comparações (A,B) e (B,A) independentes; só preferência consistente (mapeada de left/right cegos) conta. Bandas de comprimento. **Fidelidade é GATE**: `evaluateVoiceFidelityV2` exclui inválidos **antes** do juiz e **nunca** entra na média (`preferenceRate = variantWins / nConsistent`). Juiz configurável; juiz único não pode ser o mesmo modelo gerador. Tom permanece fora do reward binário.

**`--real` (Exec 6b / Exec 7b / Exec 7c / Exec 7d):** o relatório **não** pode publicar o probe sintético do avaliador como se tivesse sido julgado. Pares = outputs efetivamente entregues pelo baseline e pelo braço com voz no mesmo `taskId × trialId × copyId`. O juiz é um provider REAL configurável (`ANA_V2_TAU2_JUDGE_PROVIDER` / `ANA_V2_TAU2_JUDGE_MODEL`); default = o provider que **não** está no par (Flash+voz ⇒ Luna). A resolução de credencial é única para `luna` e `openai`: `OPENAI_API_KEY_LUNA` → `OPENAI_API_KEY`, lida de `process.env` no momento do juiz. O valor resolvido atravessa o gate e é gravado no `openaiApiKey` da configuração e no runtime exato entregue ao adapter; gate e adapter não podem consultar fontes diferentes. Chave fixture (`sk-smoke-*` etc.) conta como ausente. O npm script não sobrescreve `OPENAI_API_KEY` já exportada.

O modelo `gpt-5.6-luna` usa obrigatoriamente o provider Luna e o mesmo transporte **Responses API** dos braços Luna, ainda que o override histórico tenha rotulado o provider como `openai`: request com `max_output_tokens`, nunca Chat Completions com `max_tokens`. Sem credencial viva, sem juiz não-gerador ou modelo `*-mock` no spec ⇒ `pairwiseTone.status:"not_run"`, `preferenceRate:null`, `nComparisons:0` e `inconclusive:true`. Todo `not_run` preserva `attemptedProvider` e `attemptedModel`, sem valor de credencial.

Falha de chamada do juiz (4xx, 5xx, timeout ou erro do adapter) não destrói os resultados dos braços: o JSON schema-6 completo é publicado com `reason:"judge_call_failed"`, `judgeError` limitado e scrubbed, contagens/recibos brutos acumulados até a quebra, `preferenceRate:null` e `inconclusive:true`; nenhuma média parcial é produzida. Depois de publicar, o runner termina com exit `1`, para o operador não confundir relatório recuperável com matriz aprovada. Recibo bem-sucedido por chamada mantém provider, modelo pedido/devolvido, latência e tokens; `nComparisons` é o número de chamadas concluídas.

## REVISÃO 5 (2026-08-15) — Conteúdo licenciado de catálogo, escalada procedural e fallback por ato de fala

Pacote D-DESC convergido por Fable×Sol em 2026-08-15. A lente adversarial do Grok é gate retroativo obrigatório antes do deploy destas features; o transporte estava indisponível durante a madrugada. Esta revisão congela o contrato, mas somente D-DESC-3 entra no Exec IA-2. D-DESC-1, D-DESC-2 e D-DESC-4 permanecem sem runtime até suas fases próprias.

### D-DESC-1 — `LicensedServiceDescriptionV2` e responsabilidade do estabelecimento

Descrição de serviço só entra no universo fechado da Ana por um artefato `LicensedServiceDescriptionV2`, composto de cláusulas exatas tipadas por faceta. No v1, as únicas facetas selecionáveis são `WHAT_IT_IS` e `HOW_PERFORMED`. O modelo recebe um conjunto fechado e pode selecionar apenas `serviceId + clauseIds`; o servidor materializa o texto exato. Não há paráfrase clínica, resumo semântico nem execução de instruções contidas na descrição. Descrição vetada não sofre extração parcial: fica `unavailable_for_ana` e se comporta como descrição ausente. Respostas usam corte por fronteira de sentença e teto aproximado de 700 caracteres.

**Emenda vinculante do Victor em 2026-08-15, que substitui a régua lexical discutida pelo painel:** não existe policiamento de promessa/conteúdo clínico por léxico. Um **Termo de Responsabilidade do Estabelecimento** habilita o uso da descrição inteira pela Ana. O aceite é versionado e vincula versão da cláusula jurídica, hash calculado server-side, usuário efetivo e timestamp, espelhando o padrão de `fidelity-clause`/`AnaClinicalResponsibilityAcceptance`. Sem aceite válido para a versão vigente, a descrição fica `unavailable_for_ana`. O conteúdo é responsabilidade do tenant.

Permanecem proteções técnicas, não editoriais: PII bloqueia; tamanho é limitado com recorte apenas em fronteira de sentença; conflito com preço ou duração canônicos produz aviso não-bloqueante; e instrução embutida nunca vira instrução executável porque o modelo só escolhe IDs e o servidor materializa texto exato. Cláusulas clínicas dentro de descrição aceita são entregáveis como parte dela. Perguntas clínicas não cobertas pela descrição continuam em `CLINICAL_DOUBT`. O runtime revalida fail-closed aceite, versão, hash, PII e limites para cobrir registros legados e importações. O texto do termo é rascunho pendente de revisão jurídica na mesma fila de `/termos`; engenharia versiona a cláusula desde o primeiro dia, e troca textual sempre cria nova versão em vez de editar o aceite anterior.

### D-DESC-2 — informação procedural ausente

Mantém-se `reasonCode: "UNCADASTRED_INFO"`; `topicCode: "PROCEDURE_INFO"` é ortogonal. `ProcedureInfoDecisionV2` roda server-side depois do catálogo e decide `none | answer_from_license | escalate`, sempre carregando `serviceId`, facetas pedidas e cobertura. O match é cumulativo: interrogativa procedural **e** serviço resolvido no inbound atual ou anafórico fixado no fluxo ativo **e** domínio procedural. A exclusão operacional é feita pelo objeto da pergunta; “como funciona o agendamento/pagamento/cancelamento?” nunca é escalada procedural. Facetas clínicas continuam em `CLINICAL_DOUBT`. Pergunta específica sobre faceta descoberta (`o que é` → `WHAT_IT_IS`; `como é feita a sessão/o procedimento` e `como funciona` seguido de objeto procedural `a aplicação`/`as aplicações`/`a sessão`/`as sessões`/`o procedimento`, inclusive com `de`/`do`/`da` antes do serviço → `HOW_PERFORMED`; esta forma de `como funciona` tem precedência sobre a classe genérica) escala integralmente quando a faceta não está coberta. Pergunta procedural genérica (`como funciona` sem esses objetos procedurais, `me fala/conta sobre`, `como é`) responde **todas** as facetas cobertas pela licença, na ordem original das cláusulas (`WHAT_IT_IS` antes de `HOW_PERFORMED`), sem escalar enquanto houver ao menos uma cláusula entregável; o teto de 700 corta em fronteira de cláusula e, se estourar, prioriza `WHAT_IT_IS` + a primeira `HOW_PERFORMED`.

Mensagem mista torna a decisão procedural um componente do plano, nunca um short-circuit: (1) decompor conteúdo coberto, parte operacional e faceta não coberta; (2) executar no máximo leituras operacionais autorizadas; (3) criar Pergunta+pausa como efeito autoritativo final; (4) compor uma única resposta boundary-checked que entregue o testemunhado e confirme a escalada; (5) não executar write de agenda no mesmo turno em que uma escalada nova pausa a conversa. Precedência de conteúdo no runtime: `AnaApprovedResponse` da faceta exata → cláusula licenciada da mesma faceta → escalada. O decisor só entra após o contrato de payload do ERP. Pergunta de enumeração (`quais serviços` / `lista de serviços`) é continuação operacional da decisão procedural. Segmentos server-owned já autorizados (descrição licenciada, handoff registrado, endereço testemunhado) entram na composição da lista como `{texto, source, evidência}` e essa evidência é mesclada na **primeira** avaliação e no fallback; o fallback conserva o componente autorizado e entrega a lista, sem relançar `UNAUTHORIZED_CLINICAL_PROMISE` / `UNRECORDED_HANDOFF`.

### D-DESC-3 — fallback por ato de fala

`RecoveryFallbackIntentV2 = ANSWER_TO_PENDING | INFORMATION_QUESTION | TRANSACTION_REQUEST | OTHER`. O classificador determinístico recebe o `currentInboundBatchText` completo imediatamente antes de `coordinateRecoveryV2`; não lê `boundaryContext.sourceInboundText`, que contém apenas `input.userMessage`. Primeiro tenta o matcher fechado do slot pendente; match inequívoco vence pontuação e produz `ANSWER_TO_PENDING`. Depois distingue interrogativa informacional de pedido transacional explícito; `?` nunca transforma “pode marcar?” em informação. Sem testemunha, produz `OTHER`.

Precedência do coordinator: identidade → confirmação canônica de write cometido → pendência apenas para `ANSWER_TO_PENDING` ou `OTHER` genuinamente ambíguo enquanto existe `PendingFrame.OPEN` → catálogo indisponível quando material → fallback pelo ato de fala. Pergunta ou transação nova não repete a pendência antiga, mas sua transição permanece `preserve`. Templates canônicos: `ANSWER_TO_PENDING` mantém “Não consegui confirmar com segurança. Pode me dizer novamente o que você prefere?”; `INFORMATION_QUESTION` usa “Não consegui te responder direito agora. Pode fazer a pergunta de outro jeito?”; `TRANSACTION_REQUEST` usa “Não consegui concluir isso com segurança. Pode me dizer de outro jeito o que você quer fazer?”; `OTHER` usa “Não consegui entender com segurança. Pode explicar de outro jeito?”. Todos atravessam a boundary como `CANONICAL`; anti-repetição, proveniência e nunca-silêncio permanecem.

**D-DESC-3 — Supersessão dos fallbacks de incompreensão.** Os quatro templates de reformulação deixam de ser o terminal padrão somente quando a exceção D4 acima estiver integralmente satisfeita. Repetição de PendingFrame autoritativa, confirmação de write, resposta identity-safe e indisponibilidade técnica do catálogo permanecem payloads canônicos; não viram divergência silenciosa.

### D-DESC-4 — promoção explícita de resposta humana

Conhecimento reutilizável nasce em `AnaApprovedResponse`, nunca em `AnaQuestion`, com `knowledgeKind: PROCEDURE_INFO`, faceta tipada e unicidade fail-closed por tenant+serviço+kind+faceta. A promoção exige ação explícita, preview editável e scan de PII; revisão/hash servem para integridade e alerta de duplicidade, nunca para reuso automático por similaridade. Conteúdo clínico segue o contrato de responsabilidade aplicável à revisão exata. Conflito ou múltiplos ativos falham fechado. Implementação fica para fase posterior.

### D-ADDR — endereço operacional (`businessAddress` + `directionsMode`)

O runtime consome o payload aditivo do ERP: `businessAddress { full, city, state, zipCode }` (cada campo `string | null`) e `structuredConfig.directionsMode` (`ENDERECO_COMPLETO | SO_CIDADE | APOS_CONFIRMACAO`). O ERP sempre inclui o objeto, com campos null quando não há cadastro. Fast-path e `UNKNOWN_ADDRESS` só armam com endereço **utilizável**: ao menos um de `{full, city}` não-null e não-vazio após trim. Objeto ausente, null, todos os campos null/vazios, ou só `zipCode` preenchido = runtime velho (rota do modelo, gate desarmado, zero negação nova). Modo ausente/desconhecido trata-se como `SO_CIDADE`.

Matcher determinístico (classe read fast-path), com polaridade local e exclusão de objeto alheio (`endereço do site/instagram/email`): `endereço`, `onde fica(m)` / `onde vocês ficam`, `como chego` / `como chegar`, `localização`, `qual o local`. Copies canônicas são materializadas server-side com os campos exatos; campo ausente é omitido, nunca inventado.

- `ENDERECO_COMPLETO` exige `full`: `Estamos em <full>, <city> - <state>.` (+ `, CEP <zip>` se houver).
- `SO_CIDADE` exige `city`: `Estamos em <city> - <state>. O endereço completo a equipe confirma com você no contato.`
- `APOS_CONFIRMACAO` lê `getCustomerUpcomingAppointmentsV2` com a mesma âncora fail-closed de identidade do cancelamento. Sem upcoming futuro não-cancelado: copy única `Estamos em <city> - <state>. Assim que seu agendamento estiver confirmado te passo o endereço completinho.` (sem a frase da equipe; `city`/`state` do payload). Com upcoming: copy FULL. Identidade ambígua/mismatch ou leitura falha não vazam FULL.

Pergunta pura e respondível short-circuita em `fast_path`. Mensagem mista (R8) torna o endereço um **componente**, nunca short-circuit: o servidor anexa a copy canônica depois da leitura operacional (ex.: `"qual o endereço? e tem vaga amanhã?"` → slots + endereço). Sem `full`/`city` para o modo pedido, preserva-se a rota do modelo. O componente de endereço autorizado preserva `businessAddress` testemunhado quando a lista canônica entra no mesmo turno (mesma regra de evidência tipada da descrição/handoff).

Os campos testemunhados entram na família de soft-facts: `UNKNOWN_ADDRESS` bloqueia rua/CEP/`estamos em` que não sejam os do payload. Payload ausente ou inutilizável (todo-null / só CEP) não arma esse bloqueio. O CEP da copy canônica server-owned não dispara `EXPLICIT_PII` (8 dígitos casam o detector de telefone); o mesmo número em segmento de origem modelo é reinspecionado com `PHONE_RE` cru e bloqueia.

## Riscos declarados

R1: capacidade do DeepSeek Flash com frame tipado — NÃO VERIFICÁVEL até roteiros+matriz (gate do Victor). R2: pior caso de latência percebida ~20s — SLO+medição. R3: complexidade nova (outbox/PendingFrame) em caminho crítico — mitigada por fases aditivas, flag e sweeper fail-closed.
R4 [MÉDIO residual, rodada 3]: sweeper que marca `transport_unknown` tira a conversa do guarda de inbound do D7 — se a pergunta TIVER sido entregue, o turno seguinte roda com `pending: NONE`; não religa ordinal nem denial (caem no modelo, que esclarece). Aceito e declarado.
R5 [MÉDIO residual, rodada 3]: modelo ignorar a instrução de re-confirmação do D3 é residual de R1 — o validador de `pending_option` >4h (D3) é a contenção determinística.
R6 [futuro, IA-19A]: `ESTABLISHMENT_AUTOMATION` ainda é tratado conservadoramente como ownership da casa; não altera automações nem `lastHumanEchoAt` neste trem.

## Estampa de convergência

Rodada 3 (Grok 4.6 xhigh, adversário): "NÃO resta risco ALTO sem mitigação aceita. Convergência: a v2 é contrato de implementação." Rodada 2 (GPT 5.6 Sol xhigh, estrutura): "SIM com correções pontuais" — todas incorporadas nesta versão. Protocolo reuniao.md: fechado no critério, dentro do teto de 3 rodadas.

## EMENDA IA-20 (2026-08-20) — status assíncrono de entrega da Ana

O aceite do POST pelo provider e os callbacks posteriores da Meta são
autoridades distintas. `TurnDeliveryReceiptV2.transportOutcome=
"accepted_by_provider"` significa somente que o POST foi aceito e devolveu um
identificador do provider; esse receipt terminal é imutável. `sent`,
`delivered`, `read` e `failed` passam a uma autoridade assíncrona separada,
representada por `ProviderDeliveryStatusReceiptV2` e projetada no outbox.

O status assíncrono é monotônico e append-only na inbox: `null → sent →
delivered → read`, ou `sent → failed`; `read` e `failed` são terminais.
Duplicatas, regressões e callbacks com timestamp mais antigo são `noop` e não
reescrevem o estado vigente. A aplicação do status e o vínculo ao outbox,
turno e delivery receipt acontecem na mesma transação local. Um callback que
chegue antes do commit do outbox fica `pending`, é reprocessado pelo sweeper e
só vira `unmatched` depois do horizonte de reconciliação.

O durable ingest local precede o HTTP 200 do webhook. Falha de persistência
local deixa o webhook em 500 para permitir retransmissão idempotente da Meta;
callback ao ERP e reconciliação posterior são obrigações duráveis que não
seguram a resposta da Meta. `failed`, inclusive `META_131047`, é observabilidade
durável e nunca autoriza resend, template, rollback, write, tool, mutação ou
compensação.

O WAMID cru existe apenas na memória do parser e no caminho legado autorizado
de `sent_question_replies`. A correlação v2 persiste somente
`opaqueReceiptHashV2(wamid)`/`providerMessageIdHash`; nenhuma coluna ou log novo
guarda WAMID, `recipient_id`, telefone ou mensagem de erro da Meta.

## REVISÃO 6 (2026-08-23) — contexto temporal deferido e correção de serviço fora da pendência

Dois defeitos acoplados da rota conversacional v2: o family fast-path terminal descartava data/hora/período de uma pergunta de disponibilidade; e uma pendência `SERVICE` tratava `optionEntityIds` como soberana mesmo em turno de correção.

### Family fast-path list-only vetado com componente temporal

`resolveInitialServiceQuestionFastPathV2` e `resolveWitnessedServiceFamilyFastPathV2` (e o ramo `NOVO_AGENDAMENTO` do intérprete) não terminam o turno com a lista-only antiga quando o lote tem restrição temporal/data/período operacional. O planner `planServiceContextV2` corre antes desses caminhos. Período vago não numericamente resolvível também veta o fast-path antigo e segue ao modelo, sem inventar intervalo. O detector de período vago exige contexto temporal operacional (`à tarde`, `pela manhã`, `de noite`, `no período da tarde` ou data+período); saudações `Boa tarde`/`Boa noite`/`Bom dia` nunca contam. Sem família testemunhada materializável, a Ana **não** despeja o catálogo geral: pede o nome do serviço com a constraint server-owned. Zero tool e zero write enquanto o serviço não estiver resolvido. Nenhuma camada genérica de sinônimos neste exec.

### `DeferredAvailabilityConstraintV2`

Campo server-owned em `FlowStateV2` (`schemaVersion: 1`). Sem mensagem/texto cru, nome, telefone ou WAMID. Data vem de `resolveCurrentInboundDateV2`. Hora vem do normalizador canônico + parser fechado de operador: `após/depois de` = `AFTER_EXCLUSIVE`; `a partir de` = `AT_OR_AFTER`; `antes de` = `BEFORE_EXCLUSIVE`; `até` = `AT_OR_BEFORE`; horário sem operador = `EXACT`; `entre X e Y` = `BETWEEN_INCLUSIVE`. “segunda opção” continua mascarada e nunca vira weekday. Conflito/múltiplas datas ou janelas incompatíveis não materializam constraint. Consumível só no mesmo `flowId` e até quatro horas após `capturedAt`. Novo fluxo explícito, abandono, write confirmado ou expiração limpam a constraint. Troca de serviço no mesmo fluxo **preserva** a constraint e limpa `slotEvidence`, `bookingDraft`, duplicate evidence e profissional incompatível. O campo é projetado em `TurnFrameForModelV2` sem IDs sensíveis adicionais.

Persistência entre turnos: a constraint vive em `FlowStateV2` e já é gravada em `transition_json` no outbox aceito. Uma transição `preserve` sem PendingFrame OPEN **não** projeta o flowState em `ana_v2_pending_frames` (`pendingCommitOutcome=not_applicable`). `loadLatestState` (Memory e PG) usa o helper puro `resolveLatestFlowStateV2`: PendingFrame OPEN vigente continua autoritativa; na ausência de pending aplicável, restaura `lastAcceptedOutbox.transition.nextFlowState` somente quando o outbox e o recibo estão `accepted_by_provider`, `conversationCommitOutcome="committed"`, a transition traz `deferredAvailability` bem-formada e o terminal aceito é posterior ao último pending terminal. `transport_unknown`, `transport_failed`, `accepted_uncommitted`, recibo sem commit ou constraint ausente nunca restauram. Sem tabela/migration nova. Com a flag off, a hidratação do frame remove `deferredAvailability` **antes** de qualquer fast-path/modelo, inclusive quando o campo veio desse fallback do outbox. Recaptura parcial (ex.: `Hoje` só com data) **funde** com a janela de hora já persistida; não apaga `timeWindow`.

Consumo: serviço válido no catálogo corrente; gates de profissional intactos; 2+ profissionais sem escolha → pergunta profissional e preserva a constraint; profissional resolvido + `date` deferida → exatamente um `getAvailableSlots`; filtra só os slots da tool conforme `timeWindow`; `slotEvidence` e pendência `TIME` guardam somente o subconjunto ofertado. `EXACT` disponível → pergunta se deseja agendar/abre confirmação; **nunca** escreve sem confirmação entregue. Somente `success:true` com array de slots válido prova ausência depois do filtro: nesse caso a copy canônica pede outro dia/período e não afirma que o salão está fechado. `success:false`, exceção, JSON inválido ou array inválido usam o fallback canônico de falha de consulta, preservam a constraint e **não** afirmam indisponibilidade. Sem data deferida, pergunta data e preserva a janela de hora. Nenhum slot ausente da tool entra na copy ou no estado. `bookAppointment`, `bookingConfirmationGate`, `professionalSelectionGate`, `customerReplyGuard` e a fronteira de fatos não foram enfraquecidos.

### Subset `SERVICE` não soberano apenas em turno de correção

Fora de correção, o matcher fechado atual (incluindo ordinal) permanece soberano. Nome exato que pertence às opções apresentadas, sem marcador de correção, devolve `none` e segue esse matcher com `ResolutionProof` — não gera `outside_pending_selection`. Nome exato fora das opções é `select_outside_pending`. Turno explicitamente corretivo resolve contra o catálogo inteiro **antes** da allowlist da pendência. Match positivo único fora das opções supersede a pendência; múltiplos positivos abrem subset novo; match negativo nunca seleciona. `não X, quero Y` usa só a evidência positiva de Y. `não é X` com X na pendência invalida a pergunta velha e pede o nome correto, sem eleger o sobrevivente. `não é só X mesmo` é ambiguidade de polaridade e entrega exatamente: `Só para confirmar: você quer X ou está dizendo que não é X?`. Copies server-owned adicionais: `Entendi — não é uma dessas opções. Qual serviço você procura?` e a materialização canônica dos positivos. Sem voz/rephrase para essas copies nesta fase. Toda supersessão/invalidação só commita depois de delivery aceita. IDs continuam fora de payload, prompt desnecessário, histórico público e recibos.

### Recibo e rollout temporário

`TurnPlanReceiptV2.serviceContextDecision?` é enum redacted (`disabled` | `not_applicable` | `temporal_deferred` | `outside_pending_selection` | `positive_reclarification` | `negative_clarification`). Sem `serviceId`, `messageId`, WAMID ou texto cru. Com a flag off o campo é omitido e o comportamento anterior é restaurado de fato: a hidratação do frame remove `deferredAvailability` (inclusive o fallback do outbox) antes de fast-path/modelo; `resolveDateSlotsFastPathV2` não lê nem aplica constraint persistida; a constraint é removida do `nextFlowState`; `flowStateWithProof` volta ao baseline; `fixedStateForSlots` volta ao baseline e, no ramo novo, preserva exclusivamente `deferredAvailability` por opção explícita — nunca espalha o restante do flow state.

Flag `ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS`: default vazio/off; `*` proibido; exige também `isAnaConversationalV2Enabled(tenantSlug)`; boolean explícito para fixtures; produção resolve uma vez na entrada do turno; não persiste em `BotConfig`. Rollout inicial somente `studio-viti`. Jackeline fica off até E2E. Flag e ramo antigo têm sunset obrigatório de sete dias após aprovação do Studio; depois o comportamento novo vira default único da v2 e a flag é removida. Nenhum deploy/env é realizado neste exec.

## REVISÃO 7 (2026-08-23) — constraint some entre turnos sem PendingFrame

Reprovação de campo no canário `studio-viti` (IA-22c). A flag chegou ligada nos três turnos; o planner criou `deferredAvailability`; o commit `preserve` sem OPEN não projetou o flowState. `loadLatestState` agora restaura a constraint do outbox aceito via `resolveLatestFlowStateV2`. A prova obrigatória é round-trip runtime (`getReceptionistReplyV2` + `deliverPreparedReceptionistTurnV2` + recarga do store), não o consumidor direto.

## REVISÃO 8 (2026-08-23) — cutoff humano durável do flow state

O fallback do outbox não sobrevive a takeover. `ana_v2_flow_state_invalidations` (mapa Memory + tabela PG aditiva, `conversation_key` PK, `invalidated_at` monotônico via `GREATEST`) é a autoridade por conversa. Motivos: `HUMAN_OWNERSHIP` | `SILENT_ESCALATION` | `EXPLICIT_CONVERSATION_RESET`. Sem texto de cliente, serviço, telefone separado, WAMID ou payload.

`invalidateOpenPendingByHuman` continua invalidando OPEN e agora grava `HUMAN_OWNERSHIP` mesmo com zero linhas. Echo Meta já chamava esse método; a aba Perguntas/internal question reply passa a chamar na mesma operação. Escalada silenciosa autoritativa grava `SILENT_ESCALATION`. `RESUME_APPROVED` grava `EXPLICIT_CONVERSATION_RESET` antes de hidratar o próximo plano.

Correção IA-22g: o sujeito dessa restauração é `resolveLatestFlowStateV2`, não `invalidateOpenPendingByHuman`. `invalidateOpenPendingByHuman` grava o cutoff `HUMAN_OWNERSHIP` (e invalida OPEN). `resolveLatestFlowStateV2` é quem só restaura pending/outbox com timestamp autoritativo estritamente posterior a `invalidatedAt`. OPEN anterior ao cutoff não vence (invalidação incompleta, fail-closed). `INVALIDATED`/`SUPERSEDED`/`RESOLVED` nunca devolvem `deferredAvailability`. `EXPIRED` continua null. Outbox aceito depois do cutoff pode iniciar contexto novo. Memory e PG usam o mesmo `projectLatestFlowStateV2`.

## REVISÃO 9 (2026-08-23) — copy server-owned para restrição temporal sem serviço

Segunda reprovação de campo no canário `studio-viti` (IA-22e). Com serviço já resolvido, o cutoff de IA-22d e o consumo da constraint funcionam. Sem serviço resolvido nem família testemunhada, `planServiceContextV2` produzia `deferred_open_service_question` + `vetoFamilyFastPath` + `result:null`. O turno caía no intérprete/modelo; a prosa “horário hoje depois das 17h30” era `UNVERIFIED_AVAILABILITY`; primary e regen na mesma classe; RecoveryCoordinator em `silent_escalation` (silêncio + card).

O ramo agora materializa `ModelTurnResultV2` server-owned: `replyPurpose=SERVICE_QUESTION`, PendingFrame `SERVICE` OPEN com `optionEntityIds=[]`, constraint no `nextFlowState`, `receipt=temporal_deferred`, veto de family fast-path intacto. Copy única via `buildDeferredOpenServiceQuestionCopyV2`: usa “consultar a agenda”, nunca “tem horário” / “tem vaga” / “horários disponíveis” / “encontrei” / “verificar os horários”. Materializações: data+janela; só data; só janela; fallback “no período que você pediu”. Zero modelo, intérprete, regen, tool ou write no primeiro turno. Escolha posterior por nome resolve contra o catálogo inteiro; ordinal não existe com `options=[]`. A fronteira aceita a copy canônica e continua bloqueando “verificar os horários”. Flag off, cutoff humano, precedência Memory/PG e writes permanecem como nas revisões 6–8.

## REVISÃO 10 (2026-08-23) — serviço fora do catálogo sob pendência SERVICE vazia

Com `SERVICE` OPEN, `options=[]`, mesmo `flowId` e `deferredAvailability` consumível, o servidor materializa a negativa: se o parser produzir `unknownServiceEvidence` validada, a copy entregue é `UNKNOWN_SERVICE_UNAVAILABLE_CANONICAL_V2` — o modelo não precisa adivinhar os bytes. Sem evidência válida, o fallback canônico é a clarificação “Não achei esse nome na nossa lista. Você sabe se o serviço tem outro nome?”, nunca “Qual serviço você prefere?” e nunca silêncio no primeiro no-match. Se essa clarificação já foi entregue, o turno é `visible_escalation`: persiste a divergência/card/hold e só então licencia o handoff visível canônico; não sobrecarrega `direct_fallback`, não usa `silent_escalation` neste caso operacional, e falha de persistência não finge que a equipe foi acionada. A pendência vazia e a restrição temporal são preservadas. “Drenagem linfática” continua consumindo a restrição normalmente.

## REVISÃO 11 (2026-08-23) — write confirmado soberano; handoff visível persiste antes da copy

IA-22g. Dois bloqueantes do IA-22f no item d, mais copy de clarificação e correção documental da Revisão 8.

D1: `buildSafeWriteConfirmation` / `canonical_write_confirmation` executa **antes** de qualquer overlay de serviço desconhecido. `bookAppointment success:true` + `unknownServiceEvidence` no estado especial continua entregando a confirmação canônica do write, com zero regen.

D2: o coordenador passa a emitir o resultado tipado `visible_escalation` (não `direct_fallback`). O runtime persiste divergência/card/hold **antes** de licenciar a copy visível; o hold recém-criado não suprime a copy daquele mesmo turno; o turno seguinte em hold é silêncio pré-brain. Falha de persistência lança `SilentEscalationHoldPersistenceError` e não entrega a copy que afirma falar com a equipe. `silent_escalation` legítimo (ex.: disponibilidade não verificada sem evidência/tool) permanece intacto. `TurnPlanReceiptV2.recoveryKind` ganha o valor `visible_escalation`.

## REVISÃO 12 (2026-08-23) — IA-23: outbox como event log e projeção geral de FlowStateV2

`ana_v2_outbound_outbox` é o event log autoritativo do último delivery aceito/commitado; não há tabela nova de flow state e `PendingFrame` continua sendo somente o lifecycle da pergunta. `parsePersistedFlowStateV2` é a única validação do agregado persistido: valida o shape completo e versionável, IDs, timestamps/civil date/horas, provas de booking, reentry, duplicidade, cancelamento, deferred e versões positivas. Um subshape malformado invalida o estado inteiro; não se aproveita apenas `deferredAvailability`.

`resolveLatestFlowStateV2`/`projectLatestFlowStateV2` são usados por Memory e PG. A precedência é: (1) `PendingFrame` OPEN vigente continua sendo lifecycle da pergunta, ancorada na delivery `open` aceita da mesma `questionId`/versão/flowId; (2) o `FlowStateV2` corrente é o `nextFlowState` do delivery aceito e commitado mais recente, ordenado por `deliveryReceipt.terminalAt` original do provider (nunca por `updated_at` de reconciliação); (3) pending terminal é somente fallback legado quando não há evento aceito aplicável. `EXPIRED` não restaura. Cutoff/invalidation corta tudo com `terminalAt <= invalidatedAt`; delivery aceito posterior pode iniciar novo flow. O kill switch sanitiza apenas `deferredAvailability`, inclusive no fallback de outbox, sem apagar os demais campos válidos.

Os receipts separam três dimensões: `pendingCommitOutcome` descreve apenas a PendingFrame; `conversationCommitOutcome` descreve history/outbox/receipt; `flowStateCommitOutcome` é fechado em `committed`, `not_applicable`, `accepted_uncommitted`, `cas_conflict`, `skipped_human_cutoff` e `failed`. Sem pending, um delivery aceito válido pode ter `pendingCommitOutcome=not_applicable`, `flowStateCommitOutcome=committed` e `conversationCommitOutcome=committed`. Transporte falho/unknown/suprimido/superseded não projeta FlowState. Um aceite não commitado permanece factual (`accepted_by_provider` no transporte) e nunca repete POST; a reconciliação atualiza somente o commit local e seu receipt.

Commit aceito, reconciliação e takeover humano compartilham a mesma autoridade conversation-scoped: lock transacional/advisory no PG e fila de lock no Memory. A decisão compara sempre o `terminalAt` original, não o relógio do reconciliador. No fence `accepted_uncommitted` → takeover → reconcile, o histórico assistant é gravado uma vez e o delivery continua aceito, mas `flowStateCommitOutcome=skipped_human_cutoff`, sem PendingFrame antiga e sem `nextFlowState`; a ordem inversa também é cortada pelo cutoff persistido. Commit idempotente retorna os outcomes persistidos da row, nunca os bytes do chamador.

`visible_escalation` aplica a mesma fronteira: depois do card/hold autoritativo, grava `SILENT_ESCALATION` e entrega a única copy visível com a PendingFrame antiga fechada e um FlowState sucessor limpo. O handoff não pode reabrir a pergunta anterior no reload; falha do cutoff/hold continua sem licença para enviar a copy.

## REVISÃO 13 (2026-08-23) — IA-23b: lock-owned fence, parser cruzado e delivery real

O fence de takeover tem duas APIs: wrappers autônomos adquirem a autoridade uma vez; `invalidateOpenPendingByHumanWithClient` e `recordFlowStateInvalidationWithClient` recebem o client da lock já possuída e não tentam advisory lock novamente. Echo e aba Perguntas propagam o client da mesma `withConversationLock`; assim não há espera circular entre sessão A e conexão B. O delivery v2 também recebe o client quando é chamado dentro do lock do flush e usa commit/accepted-uncommitted lock-owned; fora desse contexto continua adquirindo sua transação própria.

`parsePersistedFlowStateV2` agora valida coerência cruzada: `slotEvidence` precisa coincidir com service/date/professional fixados, `bookingDraft` exige evidence integral compatível, e duplicate resolution/preflight clearance precisam coincidir com fixed state, draft e evidence. Qualquer divergência de serviço, data, profissional, draft ou clearance invalida o agregado inteiro.

`visible_escalation` atravessa `deliverPreparedReceptionistTurnV2` real: o cutoff esconde a PendingFrame antiga na leitura, mas uma autorização estreita formada por `recoveryKind=visible_escalation`, handoff questionId, source questionId e transição `invalidate` permite preparar o mesmo handoff; o commit CAS físico ainda precisa encontrar a pergunta antiga. O receipt aceito exige `transportStartedAt`, não pode ter `cas_conflict`, e confirma o FlowState sucessor limpo criado pelo runtime. Pausa humana fresca continua vencendo. Falha de transporte mantém cutoff/hold e nunca finge `sent`.

## REVISÃO 14 (2026-08-23) — IA-23c: takeover pending+cutoff atômico

`invalidateOpenPendingByHumanWithClient` agora executa UPDATE da PendingFrame e UPSERT de `ana_v2_flow_state_invalidations` numa única CTE modificadora. A instrução retorna `invalidated_count` factual e `cutoff_written=true`; zero OPEN continua gravando tombstone. O helper não abre transação, não adquire advisory lock e não faz segunda query: o client lock-owned continua pertencendo à sessão A, enquanto wrappers autônomos preservam seu único owner/transação. Falha da instrução reverte pending e cutoff juntos; a fixture IA-23c injeta a falha antes de aplicar qualquer uma das duas mutações.

## REVISÃO 15 (2026-08-24) — IA-24: resolvedor tenant-scoped e múltiplas janelas

`authoritativeCatalog.services[].aliases` e `services[].aliases` são dados
estruturados opcionais do catálogo, nunca prompt, histórico ou instrução. O
runtime aplica a mesma forma canônica do ERP (NFKC, remoção de diacríticos,
lowercase pt-BR, trim e colapso de espaços), revalida o array fail-closed e
remove `aliases` antes de montar o bloco visível ao modelo.

O resolvedor determinístico lê somente o catálogo ativo do tenant. Precedência:
(1) nome canônico exato e unívoco; (2) alias exato com um único proprietário;
(3) ambiguidade tipada. Alias duplicado, inativo, malformado ou ausente nunca
seleciona. `unha` isolado não escolhe por substring e não materializa o subset
histórico Reposição/Unha infantil; a clarificação contém apenas serviços
plausíveis derivados de nomes/aliases do catálogo. Negação nunca seleciona por
eliminação: evidência negativa só clarifica, enquanto um span positivo atual
(`não, quero pé e mão`) pode resolver independentemente. Troca de serviço limpa
slot/draft/duplicidade e profissional incompatível pelos reducers existentes;
nenhum gate de write ou confirmação foi relaxado.

Quando um lote traz duas restrições temporais inequívocas, o servidor grava
`DeferredAvailabilityConstraintV2.schemaVersion=2` com `windows[]` tipadas; o
novo `PERIOD` representa manhã/tarde/noite/madrugada sem texto cru. A copy
server-owned pergunta somente qual janela consultar primeiro e abre uma
PendingFrame DATE com opções opacas `window:N`. Uma resposta parcial que
identifique exatamente uma janela (`Hoje`, `amanhã`, `de manhã`) reduz o estado
para schema 1; só então ocorre um `getAvailableSlots`, e apenas o subconjunto
compatível vira `slotEvidence` e PendingFrame TIME. Nenhuma resposta da Ana é
parseada como fonte de verdade.

Flag `ANA_V2_SERVICE_RESOLVER_ROLLOUT_TENANT_SLUGS`: default vazio/off; `*`
proibido; produção exige allowlist geral v2 e service-context ativo; fixtures
podem injetar booleano explícito. O valor é resolvido uma vez na entrada do
turno. Com a flag off, aliases não influenciam matching, `windows` é removido do
FlowState hidratado e uma PendingFrame experimental já entregue é encerrada
pelo reset/CAS normal do turno — nunca por `HUMAN_OWNERSHIP`, cutoff artificial
ou alteração do stateStore. IA-23 (outbox, receipts, locks, cutoff, terminalAt e
reconcile) permanece byte-idêntico.

Gates obrigatórios: a conversa literal da Laura em um único lote deve ter zero
provider/model/tool/write no primeiro turno; escolha parcial de janela faz uma
única leitura; normalização wire ERP→runtime é testada com aliases já
normalizados e inbound acentuado; DeepSeek real continua funcional em cenário
adjacente; round-trip PostgreSQL DEV direto confirma pending/outbox/receipts,
reload e takeover sem ressurreição, com cleanup zero. E2E Meta e rollout real
continuam fora desta revisão.
