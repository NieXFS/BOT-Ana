# Ana v2 — arquitetura congelada de FlowState e outbox

**Data da prova:** 2026-08-23

**Status:** congelada após bateria IA-23/23b/23c em PostgreSQL real, com 3/3
cenários PASS e zero linhas sintéticas remanescentes no Neon DEV.

Este é o documento operacional da arquitetura. As Revisões 12, 13 e 14 do
contrato continuam sendo a fonte canônica dos contratos de dados e das
mudanças de implementação em
[`ANA-CONVERSATIONAL-V2-CONTRATO.md`](../../ANA-CONVERSATIONAL-V2-CONTRATO.md);
este documento registra a decisão arquitetural, a prova PG e os critérios para
rollout. Não há um índice canônico separado em `docs/architecture/` para
duplicar aqui.

## Decisão

`ana_v2_outbound_outbox` é o event log durável de deliveries aceitos e
commitados que também pode projetar o `FlowStateV2`. `PendingFrame` continua
sendo o lifecycle da pergunta operacional (`OPEN`, `RESOLVED`, `INVALIDATED`,
`EXPIRED`, `SUPERSEDED`); ele não é mais tratado como o dono universal do
estado conversacional.

A escolha congelada é a alternativa 1: reutilizar o outbox/event log que já
tem a identidade do delivery, o recibo terminal, o `terminalAt` original do
provider e a transição planejada, e projetar o estado através de
`resolveLatestFlowStateV2`/`projectLatestFlowStateV2`. O cutoff humano durável
fica em `ana_v2_flow_state_invalidations`. Não se cria uma segunda tabela
singleton de FlowState nem se acopla a projeção à existência de uma pergunta
aberta.

Essa alternativa preserva três fatos que não podem ser confundidos:

1. a pergunta pode estar fechada, ausente ou invalidada;
2. o provider pode ter aceitado uma mensagem mesmo quando o commit local
   ainda não terminou; e
3. a conversa pode ter sido tomada por um humano antes ou depois da aceitação
   do provider.

O outbox registra o evento factual e a transição candidata; a projeção aplica
os fences e as regras de proveniência na leitura/commit. Nenhuma leitura do
outbox autoriza um novo POST de transporte.

## Causa-raiz que a decisão corrige

O desenho anterior acoplava o estado operacional à existência do
`PendingFrame` e, por consequência, à pergunta que o modelo tinha feito. Isso
funcionava enquanto toda informação relevante estava dentro de uma pergunta
aberta, mas falhava nos turnos `preserve`, em respostas sociais e em aceite do
provider seguido de falha do commit local: não havia uma pergunta que pudesse
ser usada como projeção do estado, ou uma reconciliação posterior poderia
parecer autorizada a restaurar um snapshot antigo.

O estado operacional agora tem uma fonte de evento geral (outbox) e uma
projeção com precedência explícita. `PendingFrame` ainda é necessário para
responder a uma pendência e para CAS da pergunta, mas não é a única forma de
carregar `FlowStateV2` entre turnos.

## Invariantes congeladas

### 1. Takeover humano é um cutoff, inclusive para `accepted_uncommitted`

Uma tomada humana grava um tombstone monotônico em
`ana_v2_flow_state_invalidations` e invalida os `PendingFrame.OPEN` na mesma
operação. Todo delivery anterior ao cutoff perde licença para restaurar
`PendingFrame` ou `FlowStateV2`, inclusive quando:

- o provider já aceitou a mensagem;
- o outbox ficou em `accepted_uncommitted`;
- o sweeper/reconciliador está tentando concluir o commit local; ou
- a reconciliação acontece depois do takeover.

A comparação é estrita: somente `terminalAt > invalidatedAt` pode iniciar uma
projeção posterior. `terminalAt <= invalidatedAt`, timestamps inválidos e
ausência de prova de aceite ficam sem projeção. O relógio do reconciliador
(`now`, `updated_at`) nunca substitui o `terminalAt` original.

### 2. Não se projeta entrega sem aceite factual do provider

`prepared`, `transport_started`, `transport_unknown`, `transport_failed`,
`suppressed_pause` e `superseded` não projetam FlowState nem abrem uma
PendingFrame. Um `accepted_uncommitted` preserva o fato de que o provider
aceitou o transporte, mas não licencia o commit local do histórico, da
PendingFrame ou do FlowState até a reconciliação. A reconciliação só repete o
commit local; nunca repete o POST.

Depois que o commit local termina, o receipt separa explicitamente o aceite do
provider do resultado de cada projeção. Um delivery pode ser factual e aceito
e ainda ter `flowStateCommitOutcome=skipped_human_cutoff`.

### 3. Pending, FlowState e conversa são outcomes diferentes

Os três eixos não devem ser colapsados em um booleano `sent` ou em um único
estado:

| Eixo | Campo | O que descreve |
| --- | --- | --- |
| Pending | `pendingCommitOutcome` | lifecycle da pergunta, incluindo `opened`, `resolved`, `invalidated`, `cas_conflict` e `not_applicable` |
| FlowState | `flowStateCommitOutcome` | projeção do agregado operacional, incluindo `committed`, `accepted_uncommitted`, `skipped_human_cutoff`, `cas_conflict` e `failed` |
| Conversa | `conversationCommitOutcome` | commit do outbox/receipt/histórico, incluindo `committed`, `accepted_uncommitted`, `not_applicable` e `failed` |

Um delivery aceito sem pergunta pode, legitimamente, ter
`pendingCommitOutcome=not_applicable`,
`flowStateCommitOutcome=committed` e
`conversationCommitOutcome=committed`. No fence humano, o mesmo delivery
continua factual, mas seu FlowState fica `skipped_human_cutoff` e o snapshot
antigo não volta.

### 4. O fence deve ter um único dono de lock e o mesmo `PoolClient`

Locks advisory de sessão do PostgreSQL não são reentrantes entre conexões.
Adquirir uma session lock na conexão A e tentar adquiri-la de novo numa
conexão B para executar o helper lock-owned produz deadlock ou timeout real.
O owner que já segura a lock passa o mesmo `PoolClient` a
`invalidateOpenPendingByHumanWithClient`, `commitAcceptedWithClient` ou
`markAcceptedUncommittedWithClient`; esses helpers não fazem `BEGIN`, não
conectam outro client e não adquirem uma segunda advisory lock.

O wrapper autônomo faz exatamente uma transação e uma
`pg_advisory_xact_lock`, e só então chama o helper com o client que ele
próprio possui. Essa fronteira está documentada em
`src/services/conversationalV2/stateStore.ts:320-345` e
`src/services/conversationalV2/stateStore.ts:1528-1563`.

O caminho de flush que retorna após o bookkeeping também preserva a
propriedade de que não haverá outbound; a referência operacional solicitada
é `src/messageHandler.ts:1221-1223`. O comentário imediatamente seguinte
(linhas 1225-1227) registra o motivo: advisory locks PG não são reentrantes
entre conexões e somente um owner deve ser responsável por lock, pausa e
transporte.

### 5. `terminalAt` original é a autoridade de ordenação

O evento aceito é ordenado pelo `deliveryReceipt.terminalAt` escrito no
momento do aceite do provider. `updated_at` só é bookkeeping de reconciliação
e não pode promover um evento antigo a evento novo. Em empate, o
`deliveryAttemptId` é apenas desempate determinístico; ele não substitui o
timestamp factual.

### 6. Idempotência é por `deliveryAttemptId`

O `deliveryAttemptId` identifica a obrigação de transporte. Reexecutar
`reconcileAcceptedCommit` sobre a mesma tentativa retorna o receipt persistido
quando ela já está `accepted_by_provider`; não cria novo outbox, não altera o
`providerMessageIdHash`, não muda `transportStartedAt` e não chama o
transportador. Um receipt aceito é soberano sobre bytes enviados novamente
pelo chamador.

### 7. Takeover pending + cutoff é uma CTE atômica

`invalidateOpenPendingByHumanWithClient` executa em uma única instrução
modificadora:

1. `UPDATE ana_v2_pending_frames ... state='INVALIDATED'` para os `OPEN` da
   conversa; e
2. `INSERT ... ON CONFLICT` em `ana_v2_flow_state_invalidations`, com
   `invalidated_at` monotônico por `GREATEST`.

A instrução só retorna quando `cutoff_written=true`. Uma falha dentro do ramo
do cutoff reverte também o `UPDATE`; não se aceita uma falha lançada antes da
query como prova de atomicidade. Mesmo com zero `OPEN`, a CTE grava o cutoff
durável.

### 8. O kill switch é estreito

O kill switch de contexto remove somente `deferredAvailability` na hidratação
e na projeção. Ele não apaga `FlowStateV2` válido, não remove o event log, não
apaga receipts, não desfaz o cutoff e não reabre uma pergunta tomada por
humano.

## Sequência operacional

O caminho normal e os caminhos de recuperação seguem esta sequência:

1. O planner grava `TurnPlanReceiptV2` e prepara uma row do outbox com a
   transição candidata (`prepared`).
2. Antes do transporte, a tentativa passa a `transport_started`, com
   `transportStartedAt`.
3. Se o provider aceitar, a resposta factual carrega `terminalAt` e o hash do
   provider. O runtime tenta o commit local sob a mesma autoridade de
   conversa.
4. Se o processo perder o commit local depois do aceite, a row fica
   `accepted_uncommitted`. O sweeper chama apenas
   `reconcileAcceptedCommit`; não existe ramo de re-POST.
5. Um takeover humano usa a session lock já existente quando está no fluxo
   interativo e chama o helper lock-owned no mesmo client. Operação autônoma
   usa o wrapper transacional único. Em ambos os casos, pending e cutoff são
   escritos na fronteira atômica.
6. Commit/reconcile relê o cutoff dentro da transação, compara o
   `terminalAt` original e só aplica a transição se o evento for estritamente
   posterior. Caso contrário, fecha o delivery aceito com
   `flowStateCommitOutcome=skipped_human_cutoff`.
7. `loadLatestState` usa o mesmo projetor para Memory e PG. A pergunta OPEN
   válida preserva seu lifecycle; na ausência de pending aplicável, o último
   delivery aceito/commitado é a fonte do FlowState; pending terminal é apenas
   fallback legado sem restaurar constraint de disponibilidade indevida.

## Prova operacional PG — IA-23/23b/23c

### Escopo da execução

- **Data:** 2026-08-23.
- **Endpoint configurado:** host DEV pooler sanitizado
  `ep-restless-frost-aclk96fv-pooler.sa-east-1.aws.neon.tech`.
- **Endpoint usado:** host DEV direto sanitizado
  `ep-restless-frost-aclk96fv.sa-east-1.aws.neon.tech` (o sufixo `-pooler`
  foi removido apenas em memória).
- **Store:** `pgConversationalV2StateStore` real e `Pool`/`PoolClient` reais.
- **APIs exercitadas:** `ensureConversationalV2Tables`,
  `prepareOutbound`, `markTransportStarted`,
  `markAcceptedUncommitted`, `commitAccepted`,
  `reconcileAcceptedCommit`, `invalidateOpenPendingByHuman`,
  `invalidateOpenPendingByHumanWithClient`,
  `recordFlowStateInvalidation` e `loadLatestState`.
- **SQL observado:** advisory locks PG, `pg_locks`, CTE UPDATE + UPSERT,
  `CHECK` de reason, rows de pending/outbox/cutoff/receipt/histórico e
  commits/reconciliações reais.
- **Dados:** apenas fixtures sintéticas com prefixos `ia23pg`, sem telefone,
  nome, WAMID, conteúdo de cliente ou provider real.
- **Transporte:** não houve WhatsApp, Meta, HTTP de provider ou ERP; o teste
  não afirma entrega externa. O C3 prova a fronteira real do reconciliador e
  a persistência, sem enviar uma mensagem.
- **Evidência detalhada:**
  `/private/tmp/claude-501/-Users-niexfs-dev-Receps-ERP/6b92ee4e-5418-4be9-a93c-c518e7e452f6/scratchpad/exec-ia23-pg-battery.md`.

| Cenário | Setup/injeção | API/SQL real | Observado | Cleanup | Veredito |
| --- | --- | --- | --- | --- | --- |
| C1 — fence PG + CTE atômica | Duas conexões reais no endpoint direto. A segurou session advisory lock; B chamou o wrapper autônomo. O helper de takeover recebeu o mesmo client A. | `withConversationLock`; `recordFlowStateInvalidation`; `invalidateOpenPendingByHumanWithClient`; `pg_locks`; CTE `UPDATE pending` + UPSERT cutoff. Uma reason inválida violou o `CHECK` dentro da instrução. | `pg_locks` mostrou owner concedido e waiter na mesma key; B só concluiu depois do unlock. A falha reverteu pending e cutoff juntos. Com zero pending, o cutoff ainda foi gravado. | `finally` removeu pending, outbox, invalidations, successors, histórico e receipts sintéticos. | **PASS** |
| C2 — takeover concorrente no meio do turno | Duas ordens concorrentes reais no endpoint direto: (A) owner humano segurou session lock, gravou cutoff com helper lock-owned e B iniciou `commitAccepted`; (B) `accepted_uncommitted` foi preparado antes, owner humano segurou a mesma autoridade e B iniciou `reconcileAcceptedCommit`. Em ambas, B ficou bloqueado até o unlock. Depois foi criado evento com `terminalAt` estritamente posterior. | `withConversationLock`, `invalidateOpenPendingByHumanWithClient`, `commitAccepted`, `markAcceptedUncommitted`, `reconcileAcceptedCommit`, `loadLatestState` e barreira `pg_locks` owner+waiter em cada ordem. | As duas ordens observaram owner+waiter na mesma advisory key, não concluíram antes do unlock e fecharam `skipped_human_cutoff`; nenhuma ressuscitou FlowState/PendingFrame anterior. O novo evento posterior abriu e carregou novo flow. Provider-send-after-cutoff não foi simulado: a delivery boundary/pausa deve impedi-lo antes do transporte. | Mesmo cleanup fail-closed em `finally`; manifests before/after verificados e zero. | **PASS** |
| C3 — accepted_uncommitted → takeover → reconcile | Outbox/receipt reais preparados e marcados como transport started + accepted uncommitted. Nenhum POST foi feito. Cutoff humano foi gravado antes da reconciliação. | `markAcceptedUncommitted`, `invalidateOpenPendingByHuman`, `reconcileAcceptedCommit` duas vezes e queries PG de estado/hash/transport. | Delivery permaneceu factualmente aceito; `flowStateCommitOutcome=skipped_human_cutoff`; não aplicou estado/pending antigo. A mesma tentativa, hash e `transportStartedAt` permaneceram; uma row de outbox; segunda reconciliação idempotente. | Mesmo cleanup em `finally`; zero rows sintéticas. | **PASS** |

O critério de congelamento foi `3/3 PASS` **e** zero resíduos. Qualquer cenário
falho, não reproduzível ou sem prova PG deve ser reportado como **NÃO
VERIFICÁVEL** e reprovar a bateria inteira; não se converte um smoke em
aprovação por inferência de Memory.

## Direct versus pooler

O endpoint pooler foi apenas a origem autorizada para derivar o host direto em
memória. A bateria inteira usou o endpoint direto para o state store, o pool
de observação e o pool dedicado de locks.

Advisory session locks exigem afinidade com o backend e não podem depender de
transaction pooling. Por isso, qualquer caminho que precise manter lock
através de uma chamada ou que prove ownership concorrente deve usar o endpoint
direto. Um `pg_advisory_xact_lock` dentro de uma transação única é diferente,
mas não muda a regra do owner lock-owned: não se adquire uma segunda lock em
outra conexão.

O script não imprime DSN, senha, database user, IDs de fixture ou texto livre.
O relatório só registra hosts sanitizados, status e contagens por prefixo.

## Alerta operacional de rollout

Os mecanismos gerais de IA-23 **não são gateados** por
`ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS`. Essa allowlist é o kill switch
estreito do contexto de serviço/deferred availability; ela não é uma barreira
geral para cutoff, event log, receipt ou reconciliação.

Na fotografia operacional de 2026-08-23, Jackeline e Rose estão fora por
`AnaTechnicalMaintenance` global habilitado; `studio-viti` é o único isento,
desde 16:06. Ao desligar a manutenção, Jackeline/Rose passam imediatamente,
sem um canário adicional de `ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS`.
Isso é uma decisão consciente de operação, não uma garantia implícita da
arquitetura.

Antes de desligar a manutenção, exigir prova explícita do `process.env` do
processo que será recarregado e registrar:

- valor efetivo e escopo de `ANA_CONVERSATIONAL_V2_TENANT_SLUGS`;
- valor efetivo de `ANA_V2_SERVICE_CONTEXT_ROLLOUT_TENANT_SLUGS`;
- estado de `AnaTechnicalMaintenance` por tenant e a isenção de
  `studio-viti`; e
- SHA/build/processo que contém os helpers e o reconciliador provados aqui.

Não usar uma consulta de allowlist como substituto da prova de manutenção, e
não interpretar a bateria DEV como E2E de cliente.

## Critérios futuros, rollback e gate Laura

### Critérios para avançar

Antes de qualquer rollout público ou alteração de manutenção:

1. repetir a bateria PG no Neon DEV direto com o script opt-in e registrar
   `3/3 PASS` + zero rows;
2. executar `git diff --check`, `npx tsc --noEmit`, `npm run build` e os
   smokes herméticos IA-23, IA-23b, IA-23c, persistence, service-context,
   receipt-bookkeeping, silent-escalation, debounce-flush,
   receptionist-final-outbound, receptionist-renata-regression,
   `ana-v2-behavioral-receipt` e `ana-v2-tau2`;
3. confirmar que a versão implantada usa o endpoint direto para locks de
   sessão e que nenhum pooler foi promovido a owner da lock; e
4. passar o E2E da Laura como gate independente. A bateria PG não substitui
   uma conversa real, nem prova provider, Meta, WhatsApp, copy, áudio ou
   comportamento observado pela Laura.

### Rollback

Se o contexto de serviço precisar ser interrompido, o rollback inicial deve
desligar apenas o kill switch de `deferredAvailability` e manter o event log,
receipts, cutoff e fences duráveis. Não apagar rows de outbox nem invalidations
para “voltar” a um estado anterior: isso violaria o invariant de não
ressuscitar o pré-takeover.

Se a bateria falhar, o rollout fica bloqueado até reproduzir a causa em DEV;
um cenário sem prova é **NÃO VERIFICÁVEL** e tem veredito global REPROVADO. A
reexecução deve preservar o código e os dados reais sem reset destrutivo;
fixtures novas usam prefixos sintéticos e `finally` deve deixar contagem zero.

## Arquivos e referências de implementação

- `src/services/conversationalV2/stateStore.ts:320-345` — wrapper autônomo,
  um client e uma transaction advisory lock.
- `src/services/conversationalV2/stateStore.ts:1507-1547` — CTE atômica de
  pending + cutoff e helper lock-owned.
- `src/services/conversationalV2/stateStore.ts:1768-1914` — commit aceito,
  fence pelo cutoff, receipt persistido e idempotência de reconciliação.
- `src/services/conversationalV2/stateStore.ts:1916-1980` — aceite
  `accepted_uncommitted` sem novo transporte.
- `src/services/conversationOrder.ts:181-208` — ownership da session lock,
  unlock e liberação da conexão.
- `src/messageHandler.ts:1221-1223` — retorno sem outbound no caminho de
  bookkeeping silencioso; linhas 1225-1227 explicam a fronteira de lock.
- `scripts/smoke-ana-conversational-v2-ia23-pg.ts` — bateria PG opt-in,
  guard `ANA_IA23_PG_DEV_TEST=1`, host DEV, fixtures sintéticas e cleanup.
- `scripts/smoke-ana-conversational-v2-ia23.ts`,
  `scripts/smoke-ana-conversational-v2-ia23b.ts` — smokes herméticos de
  projeção, takeover e bookkeeping; continuam sem substituir a prova PG.
