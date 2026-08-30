> **Quiescencia NAO significa "ninguem mandou mensagem por alguns minutos". Significa "nao ha mais efeito PROD capaz de aparecer depois do corte".**

# RUNBOOK DE QUIESCÊNCIA PROD — STUDIO VITI → LAB

> **Aviso de execução:** nenhum comando deste runbook foi executado nesta tarefa. Não houve criação de branch, alteração de env, reinício de processo, escrita de banco, disparo de webhook, envio de WhatsApp, deploy, acesso à VPS, Meta ou produção. Cada comando abaixo é somente procedimento futuro, condicionado a autorização separada e a seus próprios gates.

Este documento é um procedimento de planejamento para fechar os efeitos do
Studio Viti no runtime PROD antes da ativação do caminho LAB. Ele não substitui
autorização operacional, evidência do ambiente real ou reconciliação posterior.

## Identidade e cercas

- Worktree de referência: `lab/ana-lab-1-p1`, HEAD
  `a83ae7ba8b6955046324e6bf2f4e4026eb89ae9f`.
- Router ERP consultado localmente: worktree
  `review/lab-bifurcacao-erp-current`, HEAD
  `b9d9793978e44e96b67621ec81ccc722918b40bb`. Esse SHA é evidência de código
  local, não de deploy, processo ativo, callback Meta ou estado OFF/hold no
  ambiente real.
- `RecepsERP` é o processo que recebe o webhook público e será reiniciado para
  trocar o modo do router. `receps-ia` PROD permanece intacto e nunca é
  reiniciado neste cutover. `receps-ia-lab` escuta somente
  `127.0.0.1:3002`.
- Valores do tenant, `phoneNumberId`, cliente canário, URLs de banco, tokens,
  segredos e DSNs são fornecidos fora deste documento. Não registrar telefone,
  nome, mensagem, token, DSN, `wamid` ou `messageId` em claro. Para correlação,
  usar somente hashes técnicos; para IDs de provider, usar o campo de hash já
  persistido.
- O runbook usa `studio-viti` como slug aprovado, mas não expõe o identificador
  do cliente canário. `customer_phone_e164` e `customer_phone_digits` são
  variáveis de `psql`, preenchidas pelo operador fora do arquivo.

### Evidência real fornecida para este desenho

Os números abaixo são o snapshot **read-only de produção já levantado pelo
operador** para o customer canário atual. Não foram consultados nem
revalidados nesta tarefa; nenhum identificador, telefone ou `message_id` é
reproduzido aqui.

| Superfície | Linhas observadas | Observação sanitizada |
|---|---:|---|
| `ana_inbound_messages` | 1 | uma entrada em 2026-08-14 13:45, `contentStatus=final` |
| `processed_messages` | 1 | um ID já conhecido pelo PROD |
| `inbound_event_outbox` | 1 | a entrada correspondente está estabilizada |
| `ana_v2_outbound_outbox` | 1 | a interação antiga está estabilizada |
| `ana_conversation_seq` | 1 | uma sequência para a conversa |
| `ana_conversation_history` | 0 | janela rolante não retém essa linha |
| `customers` / `appointments` | 0 / 0 | não cadastrado como cliente em tenant |

Os indicadores de estado fornecidos foram: inbound pendente `0`, outbox não
estabilizada `0` e inbound com conteúdo pendente `0`. Trata-se de uma única
interação, de aproximadamente duas semanas atrás, totalmente estabilizada e
sem trabalho conhecido em voo. Assim, o achado **#1 está limpo para este par**
(não há ocorrência concreta observada de `transport_unknown`), mas o achado
**#6 continua vivo**: há um `message_id` que o PROD conhece e que não existe no
storage LAB. O conjunto que a Opção B deve semear tem cardinalidade esperada
exatamente `1`.

Essa leitura também prova por que o número atual **não é customer virgem**:
cinco superfícies têm uma linha (`ana_inbound_messages`,
`processed_messages`, `inbound_event_outbox`, `ana_v2_outbound_outbox` e
`ana_conversation_seq`). Os três grupos que deveriam continuar vazios
(`ana_conversation_history`, `customers` e `appointments`) estão vazios, mas a
Opção A exige zero em **todas** as superfícies. A ausência de histórico retido
não apaga o fato de que o PROD já conhece o ID.

O snapshot não declara GO nem substitui as leituras futuras de hold, PIDs,
router, LAB, provider e fila de retries da Meta. Ele é usado apenas como
evidência factual para a classificação e para dimensionar a semeadura de uma
linha.

## 1. PRECONDIÇÕES

Só iniciar o snapshot se todas as precondições abaixo estiverem registradas.
Uma precondição não observada é pendência, não aprovação implícita.

1. Congelar a `main` do ERP para a janela. Registrar a autorização e o SHA
   exato que está implantado no processo real. Confirmar que esse SHA contém o
   router de bifurcação. A existência do código em
   `wt-erp-bif-current`/`b9d9793...` não substitui a confirmação do checkout
   implantado.
2. No ambiente real do processo `RecepsERP`, provar que o router ainda está
   OFF antes de armá-lo: `BOT_PROCESSOR_LAB_ROUTE_MODE` ausente ou igual a
   `prod`. O valor do arquivo `.env`, de uma branch ou de um painel não é
   prova do snapshot efetivo do PM2.
3. Confirmar `receps-ia` PROD saudável, com listener e processo estáveis, sem
   reinício concorrente. Registrar PID e `/proc/<PID>/stat` starttime.
4. Confirmar `receps-ia-lab` saudável em loopback
   `127.0.0.1:3002`, com schema dedicado validado. O health esperado está na
   seção 7; saúde de loopback não prova ingress externo, HMAC, router ou
   quiescência PROD.
5. Fechar fora do documento o tenant Viti, o `phoneNumberId` correspondente e
   exatamente um cliente canário allowlisted. Não usar outro cliente para o
   primeiro teste. A allowlist do LAB deve conter somente os valores aprovados;
   wildcard é proibido.
6. Confirmar, na leitura ERP, um único `BotConfig` para o número, com
   `botRole = 'receptionist'`, `aiProvider = 'deepseek'` e
   `aiModel = 'deepseek-v4-flash'`, além de `isActive = true`, salvo se uma
   autorização documentada definir outra configuração. Divergência é
   **ABORTAR**, não adaptar a conta de drenagem.
7. Confirmar que o Viti não está efetivamente pausado pela manutenção técnica:
   se `AnaTechnicalMaintenance.enabled = true`, o `exemptTenantId` precisa ser
   o tenant do Viti. Uma pausa geral, pausa ECHO/MANUAL/ESCALATION, ownership
   humano ou lease em vigor não pode atravessar para um LAB vazio sem um plano
   de transferência autoritativo.
8. Registrar relógio em UTC e em `America/Sao_Paulo`, tanto no operador quanto
   no processo `RecepsERP`. A Agenda depende de `TZ=America/Sao_Paulo` no
   processo; não alterar o fuso do sistema operacional.
9. Provar, antes de fechar a entrada, que o ingresso real da WABA Viti chega ao
   endpoint ERP/router e não possui callback ou rota paralela direta para
   `receps-ia` PROD. A prova futura é a configuração autorizada do callback,
   a rota publicada/Nginx e um access log sanitizado; não registrar URL
   sensível. Sem essa prova, o hold não fecha a entrada nova e a drenagem nem
   começa.

### Evidência de env real sem despejar segredos

Não usar `pm2 env`: ele pode despejar segredos. Depois de uma autorização
específica, ler somente os nomes da allowlist abaixo no `/proc` do PID real e
redigir os valores sensíveis antes de compartilhar a saída. O comando é futuro,
não foi executado:

```sh
# SOMENTE PROCEDIMENTO FUTURO; não executar nesta tarefa.
ERP_PID="$(pm2 pid RecepsERP)"
test -n "$ERP_PID" && test -r "/proc/${ERP_PID}/environ"
tr '\0' '\n' < "/proc/${ERP_PID}/environ" \
  | grep -E '^(BOT_PROCESSOR_LAB_ROUTE_MODE|BOT_PROCESSOR_LAB_PHONE_NUMBER_ID|BOT_PROCESSOR_LAB_TENANT_SLUG|BOT_PROCESSOR_LAB_WEBHOOK_URL|BOT_PROCESSOR_WEBHOOK_URL|NODE_ENV|TZ)=' \
  | sed -E \
      -e 's/^(BOT_PROCESSOR_LAB_PHONE_NUMBER_ID)=.*/\1=<technical-id-redacted>/' \
      -e 's/^(BOT_PROCESSOR_WEBHOOK_URL)=.*/\1=<prod-url-redacted>/'

LAB_PID="$(pm2 pid receps-ia-lab)"
test -n "$LAB_PID" && test -r "/proc/${LAB_PID}/environ"
tr '\0' '\n' < "/proc/${LAB_PID}/environ" \
  | grep -E '^(ANA_RUNTIME_MODE|LAB_WRITE_POLICY|HOST|PORT|ANA_LAB_ALLOWED_TENANT_SLUGS|ANA_LAB_ALLOWED_PHONE_NUMBER_IDS|ANA_LAB_ALLOWED_CUSTOMER_PHONES|ANA_LAB_DATABASE_FINGERPRINT|ANA_CONVERSATIONAL_V2_TENANT_SLUGS|NODE_ENV|TZ)=' \
  | sed -E \
      -e 's/^(ANA_LAB_ALLOWED_PHONE_NUMBER_IDS)=.*/\1=<technical-id-redacted>/' \
      -e 's/^(ANA_LAB_ALLOWED_CUSTOMER_PHONES)=.*/\1=<customer-redacted>/'

date -u '+UTC %Y-%m-%dT%H:%M:%S.%3NZ'
TZ=America/Sao_Paulo date '+America/Sao_Paulo %Y-%m-%dT%H:%M:%S.%3N%z'
```

Registrar separadamente o PID/starttime de cada processo:

```sh
# SOMENTE PROCEDIMENTO FUTURO; saída limitada a PID e starttime técnico.
for NAME in RecepsERP receps-ia receps-ia-lab; do
  PID="$(pm2 pid "$NAME")"
  test -n "$PID" || { echo "processo ausente: $NAME" >&2; exit 1; }
  STARTTIME="$(awk '{print $22}' "/proc/${PID}/stat")"
  printf '%s pid=%s starttime=%s\n' "$NAME" "$PID" "$STARTTIME"
done
```

Health é leitura GET local. A resposta deve ser filtrada para campos técnicos;
não compartilhar corpo de log ou env:

```sh
# SOMENTE PROCEDIMENTO FUTURO; não executar nesta tarefa.
curl --fail --silent --show-error http://127.0.0.1:3001/health
curl --fail --silent --show-error http://127.0.0.1:3002/health \
  | jq '{status,runtimeMode,writePolicy,globalBackgroundJobs,v2RecoveryJobs,localRecoveryJobs}'
```

Se o router real não estiver comprovadamente em `prod`/ausente, se qualquer
processo não estiver saudável ou se os relógios divergirem, parar antes do
hold. Não confundir a branch local com implantação real.

## 2. SNAPSHOT PROD ANTES DO HOLD

O snapshot tem duas superfícies: o storage local do `receps-ia` (tabelas raw
snake_case) e o banco ERP (tabelas `@@map` do Prisma, com colunas camelCase
entre aspas). Executar cada bloco em uma transação `REPEATABLE READ READ ONLY`.
Os valores de `psql` são passados pelo operador fora do documento; o
`ON_ERROR_STOP` e a divisão por zero fazem a sessão falhar se qualquer variável
estiver ausente ou vazia. Não usar endpoint mutável, reprocessamento ou
reconciliação automática durante o snapshot.

### Cabeçalho psql comum

Use este cabeçalho no início de cada sessão. O bloco completo de cada banco
abaixo começa com ele e termina em `ROLLBACK`.

```sh
# SOMENTE PROCEDIMENTO FUTURO; valores resolvidos fora do documento.
PGTZ=UTC psql "$ANA_PROD_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v tenant_slug="$VITI_TENANT_SLUG" \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_e164="$VITI_CUSTOMER_PHONE_E164" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" <<'SQL'
\set ON_ERROR_STOP on
\if :{?tenant_slug}
\else
  \echo 'tenant_slug ausente'
  \quit 3
\endif
\if :{?phone_number_id}
\else
  \echo 'phone_number_id ausente'
  \quit 3
\endif
\if :{?customer_phone_e164}
\else
  \echo 'customer_phone_e164 ausente'
  \quit 3
\endif
\if :{?customer_phone_digits}
\else
  \echo 'customer_phone_digits ausente'
  \quit 3
\endif

SELECT 1 / CASE
  WHEN NULLIF(trim(:'tenant_slug'), '') IS NULL
    OR NULLIF(trim(:'phone_number_id'), '') IS NULL
    OR NULLIF(trim(:'customer_phone_e164'), '') IS NULL
    OR NULLIF(trim(:'customer_phone_digits'), '') IS NULL
  THEN 0 ELSE 1 END AS variables_present;

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Os SELECTs específicos vêm aqui.
-- O encerramento obrigatório é:
ROLLBACK;
SQL
```

Para as sessões seguintes no mesmo formato, substituir apenas a URL de banco e
os SELECTs. `conversation_key` é calculada sem expor o telefone:

```sql
concat(:'phone_number_id', ':', :'customer_phone_digits')
```

Para executar A10/E7, passar também `-v hold_at="$T_HOLD_UTC"` e acrescentar
este guarda antes do `BEGIN`; sem `hold_at` a sessão deve falhar, nunca assumir
`now()`:

```sql
\if :{?hold_at}
\else
  \echo 'hold_at ausente'
  \quit 3
\endif
SELECT 1 / CASE WHEN NULLIF(trim(:'hold_at'), '') IS NULL THEN 0 ELSE 1 END AS hold_at_present;
```

#### 2.1 Storage local do `receps-ia` PROD

Use a mesma sessão `psql` com `$ANA_PROD_DATABASE_URL`, o cabeçalho acima e os
SELECTs abaixo. Cada rótulo (`A1` etc.) é uma evidência separada.

```sql
-- A1 — inbound_event_outbox: pending vivo, quarentena terminal e conteúdo pendente.
SELECT
  'A1 inbound_event_outbox' AS check_name,
  count(*) FILTER (WHERE delivered_at IS NULL AND terminal_at IS NULL) AS live_pending,
  count(*) FILTER (WHERE delivered_at IS NULL AND terminal_at IS NOT NULL) AS terminal_undelivered,
  count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
  count(*) FILTER (
    WHERE content_status = 'pending'
      AND delivered_at IS NULL
      AND terminal_at IS NULL
  ) AS content_pending,
  count(*) FILTER (
    WHERE delivered_at IS NULL AND terminal_at IS NULL
      AND content_status <> 'pending' AND next_retry_at <= now()
  ) AS ready_now
FROM inbound_event_outbox
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');

-- A2 — estados do outbound v2 e distinção accepted_by_provider committed.
SELECT state, count(*) AS rows
FROM ana_v2_outbound_outbox
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
GROUP BY state ORDER BY state;

SELECT
  'A2 summary' AS check_name,
  count(*) FILTER (WHERE state IN ('prepared','transport_started','accepted_uncommitted')) AS transient_rows,
  count(*) FILTER (WHERE state = 'transport_unknown') AS transport_unknown_rows,
  count(*) FILTER (
    WHERE state = 'accepted_by_provider'
      AND commit_payload_json->'deliveryReceipt'->>'transportOutcome' = 'accepted_by_provider'
      AND commit_payload_json->'deliveryReceipt'->>'conversationCommitOutcome' = 'committed'
  ) AS accepted_committed_not_pending,
  count(*) FILTER (
    WHERE state = 'accepted_by_provider' AND (
      provider_message_id_hash IS NULL OR commit_payload_json IS NULL
      OR commit_payload_json->'deliveryReceipt'->>'transportOutcome' IS DISTINCT FROM 'accepted_by_provider'
      OR commit_payload_json->'deliveryReceipt'->>'conversationCommitOutcome' IS DISTINCT FROM 'committed'
    )
  ) AS accepted_by_provider_inconsistent,
  count(*) FILTER (WHERE state = 'transport_failed') AS transport_failed_terminal
FROM ana_v2_outbound_outbox
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');

-- A3 — PendingFrame aberta; estados terminais são inventariados.
SELECT state, count(*) AS rows
FROM ana_v2_pending_frames
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
GROUP BY state ORDER BY state;

-- A4 — successor batches que ainda podem ser processados.
SELECT
  'A4 successor_batches' AS check_name,
  count(*) FILTER (WHERE status <> 'completed') AS incomplete_or_live,
  count(*) FILTER (WHERE status = 'completed') AS completed
FROM ana_v2_successor_batches
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');

-- A5 — silent escalation holds que ainda mantêm silêncio/obrigação.
SELECT
  'A5 silent_escalation_holds' AS check_name,
  count(*) FILTER (WHERE status IN ('pending','confirmed','active_elsewhere')) AS residual_live,
  count(*) FILTER (WHERE status = 'released') AS released
FROM ana_v2_silent_escalation_holds
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');

-- A6 — resposta de Perguntas e projeção humana local.
SELECT
  'A6 sent_question_replies' AS check_name,
  count(*) FILTER (WHERE status IN ('in_flight','confirmation_pending')) AS in_flight_or_confirmation,
  count(*) FILTER (WHERE callback_pending = true) AS callback_pending,
  count(*) FILTER (
    WHERE human_history_payload IS NOT NULL
      AND human_history_accepted_at IS NOT NULL
      AND human_history_recorded_at IS NULL
  ) AS accepted_human_history_unprojected,
  count(*) FILTER (WHERE status NOT IN ('in_flight','confirmation_pending')) AS other_statuses
FROM sent_question_replies
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');

-- A7 — status Meta é global; EXISTS escopa por tentativa OU hash sem duplicar.
SELECT state, count(*) AS rows
FROM ana_v2_provider_status_events
GROUP BY state ORDER BY state;

WITH status_scope AS (
  SELECT
    e.state,
    EXISTS (
      SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE o.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
        AND (
          (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
          OR o.provider_message_id_hash = e.provider_message_id_hash
        )
    ) AS linked_viti,
    EXISTS (
      SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE o.conversation_key <> concat(:'phone_number_id', ':', :'customer_phone_digits')
        AND (
          (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
          OR o.provider_message_id_hash = e.provider_message_id_hash
        )
    ) AS linked_other,
    EXISTS (
      SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE (
        (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
        OR o.provider_message_id_hash = e.provider_message_id_hash
      )
    ) AS linked_any
  FROM ana_v2_provider_status_events e
)
SELECT
  'A7 provider status scope' AS check_name,
  count(*) FILTER (WHERE state = 'pending' AND linked_viti) AS pending_linked_viti,
  count(*) FILTER (WHERE state = 'pending' AND NOT linked_viti AND linked_other) AS pending_linked_other_conversation,
  count(*) FILTER (WHERE state = 'pending' AND NOT linked_any) AS pending_unlinked_total,
  count(*) FILTER (WHERE state = 'pending' AND linked_viti AND linked_other) AS pending_ambiguous_multi_link
FROM status_scope;

-- A8 — reconciliação equivalente a verifyReceiptReconciliation, sem imprimir IDs.
WITH scoped_turns AS (
  SELECT DISTINCT turn_id FROM ana_v2_outbound_outbox
  WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION SELECT DISTINCT source_turn_id FROM ana_v2_successor_batches
  WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION SELECT DISTINCT successor_turn_id FROM ana_v2_successor_batches
  WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
), plans AS (
  SELECT r.receipt_id, r.turn_id,
    r.receipt_json->>'planReceiptId' AS plan_receipt_id,
    (r.receipt_id IS NOT NULL
      AND r.receipt_json->>'turnId' IS DISTINCT FROM r.turn_id) AS receipt_turn_json_mismatch
  FROM ana_v2_turn_receipts r JOIN scoped_turns s ON s.turn_id = r.turn_id
  WHERE r.receipt_kind = 'plan'
), deliveries AS (
  SELECT r.receipt_id, r.turn_id,
    r.receipt_json->>'planReceiptId' AS plan_receipt_id,
    (r.receipt_id IS NOT NULL
      AND r.receipt_json->>'turnId' IS DISTINCT FROM r.turn_id) AS receipt_turn_json_mismatch
  FROM ana_v2_turn_receipts r JOIN scoped_turns s ON s.turn_id = r.turn_id
  WHERE r.receipt_kind = 'delivery'
), delivery_counts AS (
  SELECT plan_receipt_id, count(*) AS delivery_count
  FROM deliveries
  GROUP BY plan_receipt_id
), metrics AS (
  SELECT
    (SELECT count(*) FROM plans) AS plan_count,
    (SELECT count(*) FROM deliveries) AS delivery_count,
    (SELECT count(*) FROM plans p
      WHERE p.plan_receipt_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM delivery_counts d
          WHERE d.plan_receipt_id = p.plan_receipt_id
        )
    ) AS plan_without_delivery,
    (SELECT count(*) FROM deliveries d
      WHERE d.plan_receipt_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM plans p
          WHERE p.plan_receipt_id = d.plan_receipt_id
        )
    ) AS orphan_delivery,
    (SELECT count(*) FROM deliveries d JOIN plans p
      ON p.plan_receipt_id = d.plan_receipt_id
      WHERE p.turn_id IS DISTINCT FROM d.turn_id
    ) AS mismatched_turn,
    (SELECT count(*) FROM delivery_counts
      WHERE plan_receipt_id IS NOT NULL AND delivery_count > 1
    ) AS duplicate_delivery_for_plan,
    (SELECT count(*) FROM plans WHERE receipt_turn_json_mismatch)
      + (SELECT count(*) FROM deliveries WHERE receipt_turn_json_mismatch)
      AS receipt_turn_json_mismatch
)
SELECT
  'A8 scoped receipts' AS check_name,
  plan_count,
  delivery_count,
  plan_without_delivery,
  orphan_delivery,
  mismatched_turn,
  duplicate_delivery_for_plan,
  receipt_turn_json_mismatch,
  (
    plan_count = delivery_count
    AND plan_without_delivery = 0
    AND orphan_delivery = 0
    AND mismatched_turn = 0
    AND duplicate_delivery_for_plan = 0
    AND receipt_turn_json_mismatch = 0
  ) AS receipts_ok
FROM metrics;

-- A8b — total global de receipts sem vínculo; não atribui Viti.
SELECT
  'A8b unscoped receipts' AS check_name,
  count(*) FILTER (WHERE r.receipt_kind = 'plan') AS plan_without_any_link,
  count(*) FILTER (WHERE r.receipt_kind = 'delivery') AS delivery_without_any_link
FROM ana_v2_turn_receipts r
WHERE NOT EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o WHERE o.turn_id = r.turn_id)
  AND NOT EXISTS (
    SELECT 1 FROM ana_v2_successor_batches s
    WHERE s.source_turn_id = r.turn_id OR s.successor_turn_id = r.turn_id
  );

-- A9 — T_LAST_PROD_ACTIVITY: timestamps factuais, nunca next_retry_at.
WITH activity(source, activity_at) AS (
  SELECT 'processed_messages.processed_at', max(processed_at) FROM processed_messages
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_conversation_history.createdAt', max("createdAt") FROM ana_conversation_history
    WHERE "conversationKey" = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'inbound_event_outbox.received_at', max(received_at) FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'inbound_event_outbox.delivered_at', max(delivered_at) FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'inbound_event_outbox.terminal_at', max(terminal_at) FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_conversation_seq.updated_at', max(updated_at) FROM ana_conversation_seq
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_pending_frames.updated_at', max(updated_at) FROM ana_v2_pending_frames
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_outbound_outbox.updated_at', max(updated_at) FROM ana_v2_outbound_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_outbound_outbox.transport_started_at', max(transport_started_at) FROM ana_v2_outbound_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_successor_batches.updated_at', max(updated_at) FROM ana_v2_successor_batches
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_silent_escalation_holds.updated_at', max(updated_at) FROM ana_v2_silent_escalation_holds
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'sent_question_replies.updated_at', max(updated_at) FROM sent_question_replies
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'ana_v2_flow_state_invalidations.invalidated_at', max(invalidated_at) FROM ana_v2_flow_state_invalidations
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL SELECT 'provider_status_events.observed_at', max(e.observed_at) FROM ana_v2_provider_status_events e
    WHERE EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE o.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
        AND (
          (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
          OR o.provider_message_id_hash = e.provider_message_id_hash
        ))
  UNION ALL SELECT 'turn_receipts.created_at', max(r.created_at) FROM ana_v2_turn_receipts r
    WHERE EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE o.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND o.turn_id = r.turn_id)
      OR EXISTS (SELECT 1 FROM ana_v2_successor_batches s
        WHERE s.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
          AND (s.source_turn_id = r.turn_id OR s.successor_turn_id = r.turn_id))
)
SELECT source, max(activity_at) AS last_activity_at FROM activity
WHERE activity_at IS NOT NULL GROUP BY source
UNION ALL SELECT 'T_LAST_PROD_ACTIVITY', max(activity_at) FROM activity
WHERE activity_at IS NOT NULL ORDER BY source;

-- A10 — delta Viti escopado pós-hold. Reabrir com -v hold_at="$T_HOLD_UTC".
WITH viti_delta(source, activity_at) AS (
  SELECT 'history', "createdAt" FROM ana_conversation_history
    WHERE "conversationKey" = concat(:'phone_number_id', ':', :'customer_phone_digits') AND "createdAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'inbound_received', received_at FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND received_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'inbound_delivered', delivered_at FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND delivered_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'inbound_terminal', terminal_at FROM inbound_event_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND terminal_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'outbound_updated', updated_at FROM ana_v2_outbound_outbox
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND updated_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'pending_updated', updated_at FROM ana_v2_pending_frames
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND updated_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'successor_updated', updated_at FROM ana_v2_successor_batches
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND updated_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'silent_hold_updated', updated_at FROM ana_v2_silent_escalation_holds
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND updated_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'question_reply_updated', updated_at FROM sent_question_replies
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND updated_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'processed_at', processed_at FROM processed_messages
    WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits') AND processed_at > :'hold_at'::timestamptz
  UNION ALL SELECT 'provider_status_viti', e.observed_at
    FROM ana_v2_provider_status_events e
    WHERE e.observed_at > :'hold_at'::timestamptz
      AND EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o
        WHERE o.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
          AND (
            (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
            OR o.provider_message_id_hash = e.provider_message_id_hash
          ))
  UNION ALL SELECT 'turn_receipt_viti', r.created_at
    FROM ana_v2_turn_receipts r
    WHERE r.created_at > :'hold_at'::timestamptz
      AND (
        EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o
          WHERE o.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
            AND o.turn_id = r.turn_id)
        OR EXISTS (SELECT 1 FROM ana_v2_successor_batches s
          WHERE s.conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
            AND (s.source_turn_id = r.turn_id OR s.successor_turn_id = r.turn_id))
      )
)
SELECT source, count(*) AS activity_count_after_hold, max(activity_at) AS last_activity_at
FROM viti_delta GROUP BY source
UNION ALL SELECT 'TOTAL_VITI_SCOPED_ACTIVITY_AFTER_HOLD', count(*), max(activity_at) FROM viti_delta
ORDER BY source;

-- A10b — diagnóstico global sem vínculo; NÃO somar ao total Viti acima.
WITH unscoped_global(source, activity_at) AS (
  SELECT 'provider_status_without_any_outbox', e.observed_at
  FROM ana_v2_provider_status_events e
  WHERE e.observed_at > :'hold_at'::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM ana_v2_outbound_outbox o
      WHERE (e.delivery_attempt_id IS NOT NULL AND o.delivery_attempt_id = e.delivery_attempt_id)
        OR o.provider_message_id_hash = e.provider_message_id_hash
    )
  UNION ALL
  SELECT 'turn_receipt_without_conversation_link', r.created_at
  FROM ana_v2_turn_receipts r
  WHERE r.created_at > :'hold_at'::timestamptz
    AND NOT EXISTS (SELECT 1 FROM ana_v2_outbound_outbox o WHERE o.turn_id = r.turn_id)
    AND NOT EXISTS (
      SELECT 1 FROM ana_v2_successor_batches s
      WHERE s.source_turn_id = r.turn_id OR s.successor_turn_id = r.turn_id
    )
)
SELECT source, count(*) AS diagnostic_count_after_hold, max(activity_at) AS last_observed_at
FROM unscoped_global
GROUP BY source
ORDER BY source;

ROLLBACK;
```

Interpretação, condição e ação de cada leitura local:

- **A1 — `inbound_event_outbox`:** espera-se `live_pending = 0`,
  `content_pending = 0`, `ready_now = 0` e `terminal_undelivered = 0`.
  `content_pending` conta somente `pending` ainda não entregue e não terminal;
  histórico já entregue ou terminal não infla a pendência viva. Linha viva ou
  áudio ainda `pending` exige drenagem e reinicia a janela. Uma linha terminal
  não é reprocessada automaticamente; o endpoint autenticado
  `/internal/inbound-outbox/reprocess` só pode ser usado em procedimento
  próprio, depois da correção e do congelamento de reprocessos. Ele não é
  chamado durante o snapshot. Sem disposição explícita, terminal não entregue
  é bloqueio de reconciliação.
- **A2 — `ana_v2_outbound_outbox`:** `prepared`, `transport_started` e
  `accepted_uncommitted` devem ser zero. Aceito pelo provider só é estável com
  `transportOutcome = accepted_by_provider`,
  `conversationCommitOutcome = committed` e hash; essa linha não é pendência.
  Uma ocorrência concreta de `transport_unknown` para o Viti mantém o
  bloqueio: não se reenvia, não se faz fallback e não se resolve por idade,
  porque o provider pode materializar uma entrega tardia. A impossibilidade
  teórica de provar uma negativa, sem ocorrência concreta no par, é o
  **BLOCKER CONDICIONAL #1**, não um blocker automático. Para GO, a leitura
  deve mostrar `transport_unknown = 0`, `transport_started = 0` e
  `accepted_uncommitted = 0`.
- **A3 — `ana_v2_pending_frames`:** qualquer `OPEN` é estado que o LAB vazio
  desconhece e bloqueia; estados terminais ficam no inventário. Se a consulta
  vier vazia, registrar `OPEN = 0`; se vier `OPEN > 0`, permanecer em hold e
  reconciliar a transição.
- **A4 — `ana_v2_successor_batches`:** espera-se zero em
  `incomplete_or_live`; `queued`, `processing` ou `failed` exigem
  aguardar/reconciliar sem reiniciar `receps-ia`. `completed` pode permanecer
  como histórico.
- **A5 — `ana_v2_silent_escalation_holds`:** `pending`, `confirmed` e
  `active_elsewhere` devem ser zero. `released` é histórico; qualquer residual
  exige manter o hold e reconciliar a pergunta correspondente.
- **A6 — `sent_question_replies`:** espera-se zero em in-flight,
  `callback_pending` e projeção humana aceita não registrada; qualquer um pode
  materializar callback/ownership depois do corte.
- **A7 — provider status:** status é telemetria/projeção local, não pendência
  conversacional por si só; o Viti ligado a outbox transitório não pode ter
  `pending`. O vínculo é por `delivery_attempt_id` ou
  `provider_message_id_hash` via `EXISTS`, então um pending pré-link também é
  capturado sem duplicar a contagem. O esperado é zero em
  `pending_linked_viti`, `pending_ambiguous_multi_link` e
  `pending_unlinked_total`; pendente ligado a outra conversa é diagnosticado,
  não atribuído ao Viti. Pendente sem vínculo não é atribuível e entra na
  ressalva de observabilidade.
- **A8/A8b — receipts:** no conjunto escopável, a comparação usa
  `planReceiptId`, não só `turn_id`: `plan_without_delivery`,
  `orphan_delivery`, `mismatched_turn` e `duplicate_delivery_for_plan` devem
  ser zero, assim como o mismatch JSON quando houver receipt. `A8b` é somente
  inventário global; como `ana_v2_turn_receipts` não tem `conversation_key`,
  plan-only/silent sem outbox/successor não pode ser atribuído ao Viti. Isso é
  o **RISCO ACEITÁVEL (P2) #2** neste canário, desde que não haja desvio nas
  linhas escopáveis A8 e o restante da cerca seja observado; não se deve
  convertê-lo em prova universal de ausência. Se houver desvio em A8,
  parar e reconciliar sem novo POST.
- **A9:** registrar o maior timestamp factual como `T_LAST_PROD_ACTIVITY`.
  `next_retry_at` futuro não entra. Se todas as fontes vierem nulas, registrar
  “sem atividade conhecida” e não inventar um timestamp: a quiet window parte
  de `T_HOLD`, mas a ausência de histórico continua sendo uma condição a
  conferir no gate.
- **A10/A10b:** reaplicar após cada leitura. Qualquer contagem em
  `TOTAL_VITI_SCOPED_ACTIVITY_AFTER_HOLD` reinicia a quiet window. A10b é
  diagnóstico global sem vínculo: pode conter Jackeline/Rose, alimenta o
  blocker de escopo e não é somado ao total Viti nem reinicia sozinho a janela.
  Qualificar ou bloquear, nunca descartar; registrar somente contagens,
  máximos e digest técnico.

#### 2.2 Banco ERP PROD: ownership, pause e perguntas

Use uma sessão `$ERP_PROD_DATABASE_URL`, com os mesmos quatro `-v` e o cabeçalho
comum. As tabelas e colunas vêm do schema Prisma atual e usam os nomes raw
efetivos (`@@map`) com campos camelCase entre aspas.

```sql
-- E1 — BotConfig e papel/provider/model do Viti; nenhum segredo.
SELECT
  'E1 bot_config' AS check_name,
  count(*) AS botconfig_rows,
  bool_and(bc."phoneNumberId" = :'phone_number_id') AS phone_matches,
  bool_and(bc."botRole" = 'receptionist') AS role_receptionist,
  bool_and(bc."aiProvider" = 'deepseek') AS provider_expected,
  bool_and(bc."aiModel" = 'deepseek-v4-flash') AS model_expected,
  bool_and(bc."isActive" = true) AS active_expected,
  count(*) FILTER (WHERE bc."botPausedUntil" > now()) AS global_pause_live,
  max(bc."updatedAt") AS botconfig_last_update
FROM bot_configs bc JOIN tenants t ON t.id = bc."tenantId"
WHERE t."slug" = :'tenant_slug';

-- E2 — singleton técnico: Viti só é elegível se OFF ou explicitamente isento.
SELECT
  'E2 technical maintenance' AS check_name,
  (m.id IS NOT NULL) AS singleton_present,
  coalesce(m.enabled, false) AS enabled,
  CASE WHEN m.id IS NULL THEN false WHEN m.enabled = false THEN true
       ELSE m."exemptTenantId" = t.id END AS viti_not_paused_by_maintenance,
  m."updatedAt" AS maintenance_last_update
FROM tenants t LEFT JOIN ana_technical_maintenance m ON m.id = 'global'
WHERE t."slug" = :'tenant_slug';

-- E3 — ConversationPause: futuro, ownership humano/lease e horizonte ECHO.
SELECT
  'E3 conversation_pauses' AS check_name,
  count(*) AS rows_for_conversation,
  count(*) FILTER (WHERE "pausedUntil" > now()) AS paused_until_future,
  count(*) FILTER (WHERE "anaHandoffState" = 'HUMAN_ACTIVE') AS human_active,
  count(*) FILTER (WHERE "anaHandoffState" = 'RESUME_PENDING') AS resume_pending,
  count(*) FILTER (WHERE "anaResumeLeaseUntil" > now()) AS resume_lease_future,
  count(*) FILTER (
    WHERE "anaHandoffState" <> 'ANA_ACTIVE'
      AND "lastHumanEchoAt" > now() - interval '8 hours'
  ) AS human_echo_horizon_live,
  max("updatedAt") AS pause_last_update
FROM conversation_pauses cp JOIN tenants t ON t.id = cp."tenantId"
WHERE t."slug" = :'tenant_slug' AND cp."customerPhone" = :'customer_phone_e164';

-- E4 — AnaQuestion OPEN e tentativa atual, sem texto/ID.
WITH current_questions AS (
  SELECT q."questionStatus" AS question_status,
    q."currentDeliveryAttemptId" IS NOT NULL AS has_current_attempt,
    a."deliveryStatus" AS current_delivery_status
  FROM ana_questions q JOIN tenants t ON t.id = q."tenantId"
  LEFT JOIN ana_question_delivery_attempts a ON a.id = q."currentDeliveryAttemptId"
  WHERE t."slug" = :'tenant_slug' AND q."phoneNumberId" = :'phone_number_id'
    AND q."customerPhone" = :'customer_phone_e164'
)
SELECT 'E4 questions current' AS check_name,
  count(*) FILTER (WHERE question_status = 'OPEN') AS open_questions,
  count(*) FILTER (WHERE has_current_attempt) AS questions_with_current_attempt,
  count(*) FILTER (WHERE current_delivery_status IN ('SENDING','CONFIRMATION_PENDING')) AS current_attempt_in_flight
FROM current_questions;

-- E4b — tentativa antiga ou não apontada ainda em voo.
SELECT 'E4b all delivery attempts' AS check_name,
  count(*) FILTER (WHERE a."deliveryStatus" IN ('SENDING','CONFIRMATION_PENDING')) AS any_attempt_in_flight,
  count(*) AS attempts_for_conversation
FROM ana_question_delivery_attempts a JOIN ana_questions q ON q.id = a."questionId"
JOIN tenants t ON t.id = a."tenantId"
WHERE t."slug" = :'tenant_slug' AND q."phoneNumberId" = :'phone_number_id'
  AND q."customerPhone" = :'customer_phone_e164';

-- E5 — intenção ECHO durável antes da Meta.
SELECT status, count(*) AS rows
FROM ana_outbound_echo_stamps s JOIN tenants t ON t.id = s."tenantId"
WHERE t."slug" = :'tenant_slug' AND s."customerPhone" = :'customer_phone_e164'
GROUP BY status ORDER BY status;

-- E6 — atividade ERP; audit_logs é diagnóstico conservador tenant-wide.
WITH target AS (SELECT t.id AS tenant_id FROM tenants t WHERE t."slug" = :'tenant_slug'),
activity(source, activity_at) AS (
  SELECT 'bot_configs.updatedAt', bc."updatedAt" FROM bot_configs bc JOIN target x ON x.tenant_id = bc."tenantId"
  UNION ALL SELECT 'ana_inbound_messages.receivedAt', max(i."receivedAt") FROM ana_inbound_messages i JOIN target x ON x.tenant_id = i."tenantId"
    WHERE i."phoneNumberId" = :'phone_number_id' AND i."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'ana_questions.updatedAt', max(q."updatedAt") FROM ana_questions q JOIN target x ON x.tenant_id = q."tenantId"
    WHERE q."phoneNumberId" = :'phone_number_id' AND q."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'ana_question_delivery_attempts.updatedAt', max(a."updatedAt") FROM ana_question_delivery_attempts a
    JOIN ana_questions q ON q.id = a."questionId" JOIN target x ON x.tenant_id = a."tenantId"
    WHERE q."phoneNumberId" = :'phone_number_id' AND q."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'conversation_pauses.updatedAt', max(cp."updatedAt") FROM conversation_pauses cp JOIN target x ON x.tenant_id = cp."tenantId"
    WHERE cp."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'conversation_pauses.lastHumanEchoAt', max(cp."lastHumanEchoAt") FROM conversation_pauses cp JOIN target x ON x.tenant_id = cp."tenantId"
    WHERE cp."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'ana_outbound_echo_stamps.updatedAt', max(s."updatedAt") FROM ana_outbound_echo_stamps s JOIN target x ON x.tenant_id = s."tenantId"
    WHERE s."customerPhone" = :'customer_phone_e164'
  UNION ALL SELECT 'appointments.updatedAt', max(a."updatedAt")
    FROM appointments a JOIN customers c ON c.id = a."customerId" JOIN target x ON x.tenant_id = a."tenantId"
    WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') IN (:'customer_phone_digits', regexp_replace(:'customer_phone_e164', '[^0-9]', '', 'g'))
  UNION ALL SELECT 'audit_logs.tenant_wide.createdAt', max(l."createdAt")
    FROM audit_logs l JOIN target x ON x.tenant_id = l."tenantId"
    WHERE l."entityType" IN ('Appointment','AnaInboundMessage','AnaQuestion','AnaQuestionDeliveryAttempt','ConversationPause','AnaOutboundEchoStamp')
  UNION ALL SELECT 'ana_technical_maintenance.updatedAt', max(m."updatedAt") FROM ana_technical_maintenance m WHERE m.id = 'global'
)
SELECT source, max(activity_at) AS last_activity_at FROM activity WHERE activity_at IS NOT NULL GROUP BY source
UNION ALL SELECT 'T_LAST_PROD_ACTIVITY', max(activity_at) FROM activity WHERE activity_at IS NOT NULL
ORDER BY source;

-- E7 — delta ERP pós-hold. Reabrir com -v hold_at="$T_HOLD_UTC".
WITH target AS (SELECT t.id AS tenant_id FROM tenants t WHERE t."slug" = :'tenant_slug'),
delta(source, activity_at) AS (
  SELECT 'ana_inbound_messages', i."createdAt" FROM ana_inbound_messages i JOIN target x ON x.tenant_id = i."tenantId"
    WHERE i."phoneNumberId" = :'phone_number_id' AND i."customerPhone" = :'customer_phone_e164' AND i."createdAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'ana_questions', q."updatedAt" FROM ana_questions q JOIN target x ON x.tenant_id = q."tenantId"
    WHERE q."phoneNumberId" = :'phone_number_id' AND q."customerPhone" = :'customer_phone_e164' AND q."updatedAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'question_delivery_attempts', a."updatedAt" FROM ana_question_delivery_attempts a JOIN ana_questions q ON q.id = a."questionId" JOIN target x ON x.tenant_id = a."tenantId"
    WHERE q."phoneNumberId" = :'phone_number_id' AND q."customerPhone" = :'customer_phone_e164' AND a."updatedAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'conversation_pauses', cp."updatedAt" FROM conversation_pauses cp JOIN target x ON x.tenant_id = cp."tenantId"
    WHERE cp."customerPhone" = :'customer_phone_e164' AND cp."updatedAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'outbound_echo_stamps', s."updatedAt" FROM ana_outbound_echo_stamps s JOIN target x ON x.tenant_id = s."tenantId"
    WHERE s."customerPhone" = :'customer_phone_e164' AND s."updatedAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'appointments', a."updatedAt" FROM appointments a JOIN customers c ON c.id = a."customerId" JOIN target x ON x.tenant_id = a."tenantId"
    WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') IN (:'customer_phone_digits', regexp_replace(:'customer_phone_e164', '[^0-9]', '', 'g'))
      AND a."updatedAt" > :'hold_at'::timestamptz
  UNION ALL SELECT 'audit_logs_tenant_wide', l."createdAt" FROM audit_logs l JOIN target x ON x.tenant_id = l."tenantId"
    WHERE l."createdAt" > :'hold_at'::timestamptz AND l."entityType" IN ('Appointment','AnaInboundMessage','AnaQuestion','AnaQuestionDeliveryAttempt','ConversationPause','AnaOutboundEchoStamp')
)
SELECT source, count(*) AS activity_count_after_hold, max(activity_at) AS last_activity_at FROM delta GROUP BY source
UNION ALL SELECT 'TOTAL_ERP_ACTIVITY_AFTER_HOLD', count(*), max(activity_at) FROM delta ORDER BY source;

ROLLBACK;
```

Interpretação, condição e ação das leituras ERP:

- **E1 — `bot_configs` + `tenants`:** espera-se exatamente uma linha, todos os
  booleanos de papel/provider/model/ativo verdadeiros e `global_pause_live = 0`.
  Ausência, divergência ou duplicidade é **ABORTAR**. Nunca imprimir tokens.
- **E2 — `ana_technical_maintenance`:** o singleton `global` deve existir e
  deixar o Viti não pausado. `enabled = false` é válido; `enabled = true` só
  com isenção persistida para o tenant Viti.
- **E3 — `conversation_pauses`:** para o LAB vazio, espera-se zero em pausa
  futura, `HUMAN_ACTIVE`, `RESUME_PENDING`, lease futuro e horizonte ECHO de
  oito horas enquanto o handoff não estiver em `ANA_ACTIVE`. O filtro não conta
  `lastHumanEchoAt` recente de uma linha já retomada em `ANA_ACTIVE`; histórico
  expirado/retomado pode ficar para auditoria. Qualquer estado vivo precisa ser
  reconciliado ou conhecido pelo LAB.
- **E4/E4b — perguntas/tentativas:** espera-se zero em pergunta `OPEN`,
  tentativa `SENDING`/`CONFIRMATION_PENDING` atual ou antiga. Qualquer uma pode
  materializar resposta/callback/ownership e bloqueia.
- **E5 — `ana_outbound_echo_stamps`:** `PENDING` deve ser zero; o stamp nasce
  antes da Meta e uma pendência conserva a intenção humana. Qualquer linha
  `PENDING` mantém o hold e exige reconciliação autoritativa, sem reenvio.
- **E6:** registrar o maior timestamp factual de configuração, inbound,
  pergunta, pausa, stamp, appointment e auditoria como candidato ERP de
  `T_LAST_PROD_ACTIVITY`; não usar retry futuro. `audit_logs` é tenant-wide,
  portanto é um diagnóstico conservador e não causalidade do canário. Se não
  houver linha, registrar ausência de atividade conhecida e usar `T_HOLD` como
  limite inferior, nunca como prova de silêncio anterior.
- **E7:** qualquer delta em inbound, pergunta, tentativa, pausa, stamp ou
  appointment reinicia a janela e bloqueia o corte. A linha
  `audit_logs_tenant_wide` também reinicia conservadoramente o total ERP por
  falta de correlação de entidade, mas não prova que o canário causou a entrada;
  se aparecer, qualificar ou manter o blocker cross-system da seção 9.

### Recibos e obrigações de reconciliação

Anexar A1–A10 e E1–E7 com digest técnico do resultado redigido. Não considerar
`accepted_by_provider` com `conversationCommitOutcome = committed` pendência.
Considerar bloqueante uma ocorrência concreta de `transport_unknown` para o
Viti, `accepted_uncommitted`, plan-only **escopável**, callback/projeção
pendente, terminal inbound não entregue sem disposição e qualquer pendência
sem vínculo que possa ser do Viti. A negativa teórica de um provider não é
blocker por si só; o requisito de GO continua sendo `transport_unknown = 0`,
`transport_started = 0` e `accepted_uncommitted = 0` no snapshot do par.
Plan-only não escopável é o risco P2 #2, não um bloqueio automático deste
canário. Correlação de status jamais cria business write.

`ana_v2_provider_status_events.state = pending` é telemetria/projeção local e
não é pendência conversacional por si só; ainda assim, o Viti deve ter zero
pendente ligado a transporte transitório, e pendentes sem `conversation_key`
precisam de qualificação. Correlação de status jamais cria business write.

## 3. ARMAR HOLD — DESCREVER, NÃO EXECUTAR

O hold é uma troca controlada no processo ERP. Preparar a mudança pelo fluxo de
deploy autorizado; não editar checkout diretamente na VPS. Os valores efetivos
devem ser:

```text
BOT_PROCESSOR_LAB_ROUTE_MODE=hold
BOT_PROCESSOR_LAB_PHONE_NUMBER_ID=<phoneNumberId técnico aprovado, fora do runbook>
BOT_PROCESSOR_LAB_TENANT_SLUG=studio-viti
BOT_PROCESSOR_LAB_WEBHOOK_URL=http://127.0.0.1:3002/webhook
BOT_PROCESSOR_WEBHOOK_URL=<endpoint PROD já existente, não alterar>
TZ=America/Sao_Paulo
```

`BOT_PROCESSOR_LAB_WEBHOOK_URL` pode estar pré-configurada, mas em `hold` não é
usada para encaminhar Viti. Reiniciar somente `RecepsERP`, com env atualizado e
`TZ` explicitamente preservado:

```sh
# SOMENTE PROCEDIMENTO FUTURO, mediante autorização de troca de env.
TZ=America/Sao_Paulo pm2 restart RecepsERP --update-env
```

Não reiniciar, recarregar, rebuildar ou alterar `receps-ia` PROD. Descrever
`pm2 save` apenas como passo posterior e separado, se autorizado para persistir
a definição do PM2. Depois, reler `/proc/<PID>/environ` apenas com a allowlist e
confirmar que o PID/starttime de `RecepsERP` mudou, mas o de `receps-ia` PROD não.

### Contrato observável do hold

Depois de comprovado o env real, registrar `T_HOLD` em UTC e
`America/Sao_Paulo`:

- payload exclusivamente do `phoneNumberId` Viti recebe **HTTP 503 retryable**
  antes de consulta a `BotConfig`, correlação de `statuses[]`, forward ou
  mutação conversacional PROD;
- payload de Jackeline e Rose, com IDs válidos e sem mistura ambígua, segue o
  fluxo PROD normal;
- configuração inválida, ID ausente ou payload misto falha fechado;
- não há fallback Viti → PROD nem forward Viti → LAB em `hold`;
- a Meta pode manter/retransmitir payload Viti por causa do 503; isso é uma
  consequência controlada, não ausência de atividade.

Formulário sem PII:

```text
T_HOLD_UTC=<ISO UTC>
T_HOLD_SP=<ISO America/Sao_Paulo>
ERP_DEPLOYED_SHA=<SHA do processo real>
ERP_PID=<PID técnico>
ERP_PROC_STARTTIME=<starttime /proc>
ANA_PROD_PID=<PID técnico, inalterado depois>
ANA_PROD_PROC_STARTTIME=<starttime /proc, inalterado depois>
ROUTE_MODE_EFFECTIVE=hold
VITI_FORWARD_TO_LAB=false
VITI_FALLBACK_TO_PROD=false
```

## 4. DRENAGEM

O hold fecha trabalhos Viti novos no ingresso ERP, mas não cancela trabalho já
encaminhado e em memória no `receps-ia` PROD. Não reiniciar `receps-ia` para
“limpar”: isso remove evidência de in-flight e não prova que um POST não foi
aceito.

### Números confirmados no código local

| Componente | Valor | Consequência |
|---|---:|---|
| Debounce de inbound | 12 s | Rajada pode aguardar flush. |
| Max wait do buffer | 30 s | Flush pode esperar além do debounce. |
| POST de texto WhatsApp | 20 s | Timeout não prova rejeição da Meta. |
| `typingDelay` recepção | até 10 s | Recheck ocorre depois da digitação. |
| GET fresco de pause-state | até 10 s | A fronteira final ainda tem I/O. |
| `RECEPTIONIST_AI_TIMEOUT_MS` | 30 s | Timeout por completion. |
| `callAiWithRetry` | 4 tentativas | Esperas externas 1 + 2 + 4 = 7 s por round. |
| `runReceptionistModelLoop` | 8 rounds default | Caller v2 não passa override. |
| Anthropic quick | 1 + 2 + 4 s | Só sales/reprocessamento quick. |
| `PATIENT_MAX_ATTEMPTS` | 7 | Só sales/onboarding, não Viti receptionist. |

O loop v2 tem uma chamada normal por round, mas também há retries effect-free
de completion vazia, retry de tool esperado/forçado conforme o protocolo e uma
regeneração separada. Não existe deadline total do turno nem cap explícito de
quantidade de `tool_calls` por round; ferramentas e I/O ERP ficam fora das
contas.

### Conta-base do Viti receptionist

Para o papel fechado em `receptionist`:

```text
8 × (4 × 30 s + 7 s) + 30 s max-wait + 20 s POST
= 8 × 127 s + 50 s
= 1.066 s
= 17 min 46 s
```

É conta-base, não teto. Não inclui tools, protocolo, retries effect-free,
retry forçado, `regenerateReceptionistCopyV2` (uma chamada separada, sem retry,
até 30 s), `typingDelay` (até 10 s) nem recheck fresco (até 10 s). Portanto,
25 minutos deixa somente 434 s além da base e não prova quiescência. O piso
operacional recomendado é **40 minutos** desde o marco correto; é margem de
planejamento, não deadline duro.

### Conta Anthropic contrafactual — não aplicar ao Viti fechado

`PATIENT_MAX_ATTEMPTS = 7` pertence a `salesBrain`/`onboardingBrain`. O
`salesLlmProvider` não define timeout e `@anthropic-ai/sdk` `0.100.1` é
instanciado sem `maxRetries`; o SDK usa default de até 2 retries internos e
timeout de 600 s por request. A conta exigida, supondo uma request por tentativa
externa e ignorando retries internos, é:

```text
1 chamada/round = 7 × 600 s + até 35 s de espera = 4.235 s = 70 min 35 s
8 rounds + 30 s max-wait + 20 s POST
= 8 × 4.235 s + 50 s
= 33.930 s
= 9 h 25 min 30 s
```

`9h25m30s` não é pior caso absoluto: os retries internos default do SDK e um
`Retry-After` sem teto local podem tornar o envelope ainda maior. Tudo é
**NÃO APLICÁVEL ao Viti** enquanto E1 fechar `botRole = receptionist`. Se a
leitura divergir para sales/onboarding ou provider/configuração incompatível,
**ABORTAR**, não esperar nove horas.

### Áudio e mídia: piso não universal

O inbound de áudio pode exceder 40 minutos:

- `transcriber.ts` cria `new OpenAI({ apiKey })` sem timeout explícito. O SDK
  OpenAI instalado nesta worktree é `4.104.0` (package declara `^4.52.7`) e
  expõe default de 600 s; `callOpenAIWithRetry` faz 4 tentativas com 7 s:
  `4 × 600 + 7 = 2.407 s = 40 min 07 s` só para transcrição.
- `downloadMedia()` faz dois GETs Axios sem `timeout`; não existe teto finito.
  `inbound_event_outbox` mantém `content_status = 'pending'` até finalizar.
  Linha assim, ou tipo desconhecido no snapshot, exige **ABORTAR** e
  reconciliar, não presumir que a janela resolveu.

### Marco da janela

1. Calcular `T_LAST_PROD_ACTIVITY` com A9 e E6.
2. Começar em `max(T_HOLD, T_LAST_PROD_ACTIVITY)`.
3. Qualquer atividade PROD em `TOTAL_VITI_SCOPED_ACTIVITY_AFTER_HOLD`/E7
   reinicia o marco; o diagnóstico global A10b alimenta a resolução de escopo,
   mas não reinicia sozinho a janela Viti. Nunca usar `next_retry_at` futuro.
4. Manter piso de 40 minutos e gates de banco, logs sanitizados e PID.
5. Tempo sozinho nunca encerra `transport_unknown`, in-flight sem registro,
   áudio sem deadline ou receipt não escopável.

### Regra operacional do achado #5 — trabalho in-memory

A ausência de registry durável de turn/model/tool e de um deadline total não é,
sozinha, um blocker. O **BLOCKER CONDICIONAL #5** acende se a leitura observar
qualquer `content_status = 'pending'`, transcrição ou mídia pendente, ou
qualquer caminho sem teto observado. Nessa situação, manter o hold e
reconciliar; não transformar os 40 minutos em um timeout inventado.

O risco residual pode ser aceito somente depois de excluir todos os caminhos
ilimitados conhecidos, confirmar PID/starttime estável, zerar os estados
duráveis e observar 40 minutos sem atividade. O snapshot fornecido para este
par informa zero pendências e nenhuma atividade em voo, mas não substitui a
confirmação futura de PID, quiet window e ausência de caminho ilimitado.

## 5. GATE DE QUIESCÊNCIA

Só registrar `VITI_PROD_QUIESCENT=true` depois de todas as condições abaixo,
sem exceção:

- A1: zero inbound vivo, zero `content_status = pending` e zero terminal
  undelivered sem disposição explícita;
- A2: zero `prepared`, `transport_started`, `accepted_uncommitted`,
  `transport_unknown` e `accepted_by_provider` inconsistente; aceitos com
  commit completo podem permanecer como histórico terminal. O zero de
  `transport_unknown` é requisito de GO; uma ocorrência concreta no Viti é o
  #1 condicional e não envelhece até desaparecer;
- A3: zero `OPEN` residual e nenhum estado que precise ser conhecido pelo LAB;
- A4: nenhum successor diferente de `completed`;
- A5: nenhum silent escalation hold `pending`, `confirmed` ou
  `active_elsewhere`;
- E2/E3: nenhuma pausa ou ownership vivo que o LAB dedicado desconheça;
- E4/E4b/E5 e A6: nenhuma pergunta aberta, tentativa em voo, stamp PENDING,
  callback ou projeção humana aceita ainda não registrada;
- A7: nenhum status `pending` ligado à conversa/transporte Viti e nenhuma
  pendência sem vínculo que possa ser do Viti sem resolução de escopo;
- A8: reconciliação de receipts escopáveis sem plan-only/delivery-only. O
  material não escopável pela ausência de `conversation_key` permanece
  registrado como risco P2 #2, sem ser falsamente atribuído ao Viti;
- #3 (zero business write universal) deve estar coberto pela cerca de E2/E7,
  decisão do router, storage dedicado e correlação sanitizada do primeiro
  evento. Essa é uma condição de prova do canário, não uma afirmação de que os
  deltas conhecidos formam prova universal;
- #4 (router sem ledger durável) é aceitável neste canário quando a decisão do
  router, PID/starttime, `T_LAB`, `messageIdHash`, storage LAB e receipt/resposta
  permitida estiverem correlacionados. Não se deve chamar essa correlação de
  ledger universal;
- #5: a falta de registry não bloqueia sozinha, mas qualquer pendência de
  conteúdo/transcrição/mídia ou caminho sem teto observado bloqueia. Se todos
  os caminhos ilimitados forem excluídos, PID ficar estável, estados duráveis
  zerarem e a quiet window de 40 minutos passar, o risco residual é aceito;
- #6: a semeadura do tombstone PROD → LAB da seção 6 deve estar concluída e
  reconciliada antes da prova experimental. Sem ela, o replay cross-storage é
  o **BLOCKER REAL** desta evidência;
- nenhum delta Viti escopado em `TOTAL_VITI_SCOPED_ACTIVITY_AFTER_HOLD`/E7
  durante a janela, e duas leituras independentes dos mesmos campos, separadas
  por pelo menos 60 s, com o mesmo digest técnico e os mesmos zeros; A10b deve
  estar qualificado como não-Viti ou manter o blocker de escopo, mas não é
  somado nem reinicia sozinho a janela;
- PID e `/proc/<PID>/stat` starttime de `receps-ia` PROD inalterados desde a
  primeira leitura até a decisão;
- `T_HOLD`, início da quiet window, `T_SEED`/`T_LAB`, ambas as leituras, SHA e
  PIDs registrados sem PII.

### Formulário de decisão sem PII

```text
VITI_PROD_QUIESCENT=false
tenant_slug=studio-viti
target_phone_hash=<SHA-256 técnico>
T_HOLD_UTC=<ISO>
T_LAST_PROD_ACTIVITY_UTC=<ISO>
QUIET_START_UTC=<max dos dois marcos>
QUIET_FLOOR_MINUTES=40
T_SEED_UTC=<ISO, ainda durante hold e imediatamente antes de T_LAB>
T_LAB_UTC=<ISO, rota lab efetiva/health confirmado>
T_CANARY_SEND_UTC=<ISO, customer controlado enviou deliberadamente após T_LAB>
READ_A_UTC=<ISO>
READ_A_DIGEST=<hash de contagens/statuses/timestamps redigidos>
READ_B_UTC=<ISO, pelo menos 60 s depois>
READ_B_DIGEST=<igual a READ_A_DIGEST>
READ_A_TRANSIENTS=0
READ_B_TRANSIENTS=0
READ_A_OBLIGATIONS=0
READ_B_OBLIGATIONS=0
READ_A_TRANSPORT_UNKNOWN=0
READ_B_TRANSPORT_UNKNOWN=0
RECEPS_IA_PROD_PID=<PID>
RECEPS_IA_PROD_STARTTIME=<starttime>
RECEPS_IA_PROD_PID_UNCHANGED=true
OBSERVABILITY_BLOCKERS_RESOLVED=<true/false + referência autorizada>
DECISION_REASON=<código técnico, sem texto de conversa>
VITI_PROD_QUIESCENT=<true somente se todas as cercas forem verdadeiras>
```

Qualquer condição falsa ou desconhecida: **ABORTAR CUTOVER**, manter
`BOT_PROCESSOR_LAB_ROUTE_MODE=hold` e repetir o snapshot/delta depois da
reconciliação. Não “forçar” o booleano.

## 6. EVENTOS META ANTIGOS E REPLAY DE INBOUND

### Status tardio de outbound

`sent`, `delivered` e `read` antigos do Viti podem chegar depois do corte. No
caminho LAB, o payload inteiro encaminhado inclui `statuses[]`; o
`webhookServer` faz ingest local do status e a projeção v2 só é elegível quando
encontra outbox aceito compatível. O resultado pode ser um evento local
`pending`, `applied`, `noop` ou `unmatched`. Isso é telemetria/projeção e não
deve:

- ressuscitar `PendingFrame` ou flow state;
- selecionar serviço, data, profissional ou horário;
- executar tool, `bookAppointment` ou `cancelAppointment`;
- criar pergunta, pausa, ownership ou qualquer business write ERP;
- produzir uma resposta WhatsApp.

O campo de provider deve ser representado por hash; nunca imprimir o ID cru.
`cutoverAt`/`T_HOLD` são cercas de auditoria para separar recortes, não prova de
causalidade nem de qual processo recebeu o evento. Para status do fluxo legado,
o ramo LAB não executa `processMetaQuestionDeliveryStatuses` antes do forward;
no PROD pré-cutover esse caminho pode ter criado/atualizado ownership em
`AnaQuestion`/`AnaQuestionDeliveryAttempt`. Por isso E4/E5 precisam estar
zerados antes do hold. Não confundir `statuses[]` com confirmação de resposta
humana na aba Perguntas.

### `messages[]` retransmitidas durante o hold — Opções A e B do #6

O hold devolve 503 retryable ao Viti. A Meta pode, portanto, manter ou
retransmitir `messages[]` recebidos durante o hold. Ao trocar `hold → lab`, um
replay antigo do **mesmo cliente allowlisted** passa pela cerca estrutural; o
storage LAB é dedicado e o `processed_messages` PROD não deduplica no LAB.
`cutoverAt` sozinho não distingue causalmente esse replay. Esse é o **BLOCKER
REAL #6** até que a Opção A ou a Opção B seja concluída.

Isso não é um efeito PROD pós-corte: o trabalho foi recebido antes ou durante o
hold e o PROD não o processou enquanto retornava 503. Porém impede garantir que
a primeira entrada LAB seja a entrada experimental. Qualquer mensagem anterior
à entrada experimental é **TRÁFEGO DE TRANSIÇÃO**, mesmo que o LAB a processe;
ela nunca pode ser chamada de “primeiro inbound do LAB” nem de prova do canário.
Esperar mais tempo não prova que a fila Meta foi drenada.

#### Opção A — customer virgem (preferida para um número futuro)

A Opção A é o caminho preferido quando houver um `phoneNumberId`/customer sem
qualquer linha histórica. O operador deve executar os SELECTs abaixo em
sessões `REPEATABLE READ READ ONLY` usando o cabeçalho da seção 2. Eles são
somente leitura; o resultado deve ser zero em **todas** as linhas. A primeira
consulta usa as quatro superfícies locais com `conversation_key` snake_case e
a quinta com a coluna histórica camelCase, exatamente como o schema atual
define:

```sql
-- PROD local: phoneNumberId e customer_phone_digits são variáveis externas.
SELECT 'processed_messages' AS surface, count(*) AS rows
FROM processed_messages
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
UNION ALL
SELECT 'inbound_event_outbox', count(*)
FROM inbound_event_outbox
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
UNION ALL
SELECT 'ana_v2_outbound_outbox', count(*)
FROM ana_v2_outbound_outbox
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
UNION ALL
SELECT 'ana_conversation_seq', count(*)
FROM ana_conversation_seq
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
UNION ALL
SELECT 'ana_conversation_history', count(*)
FROM ana_conversation_history
WHERE "conversationKey" = concat(:'phone_number_id', ':', :'customer_phone_digits');
```

No banco ERP, `ana_inbound_messages` é filtrada por
`"phoneNumberId"`/`"customerPhone"` camelCase e pelo tenant resolvido pelo
slug. `customers` e `appointments` são consultadas sem limitar ao tenant do
Viti: isso prova a propriedade mais forte de que o telefone não está
cadastrado em **tenant nenhum**. A normalização usada apenas na comparação
aceita tanto o E.164 quanto só-dígitos, sem imprimir o valor:

```sql
-- ERP PROD: as duas formas do telefone são variáveis externas.
SELECT 'ana_inbound_messages' AS surface, count(*) AS rows
FROM ana_inbound_messages i
JOIN tenants t ON t.id = i."tenantId"
WHERE t."slug" = :'tenant_slug'
  AND i."phoneNumberId" = :'phone_number_id'
  AND regexp_replace(coalesce(i."customerPhone", ''), '[^0-9]', '', 'g')
      = :'customer_phone_digits'
UNION ALL
SELECT 'customers', count(*)
FROM customers c
WHERE regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
      = :'customer_phone_digits'
UNION ALL
SELECT 'appointments', count(*)
FROM appointments a
JOIN customers c ON c.id = a."customerId"
WHERE regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
      = :'customer_phone_digits';
```

Os `JOIN`s e os nomes de coluna acima vêm do schema ERP: `AnaInboundMessage`
usa `tenantId`, `phoneNumberId` e `customerPhone`; `Customer` usa `phone`; e
`Appointment` liga-se a `Customer` por `customerId`. Uma linha em qualquer
superfície reprova a Opção A. O número atual não qualifica: a evidência
fornecida tem uma linha em cada uma das cinco superfícies de intake/inbound
(`ana_inbound_messages`, `processed_messages`, `inbound_event_outbox`,
`ana_v2_outbound_outbox` e `ana_conversation_seq`), ainda que histórico,
customer e appointments estejam em zero. O fato de a janela de histórico ter
sido aparada não torna o customer virgem.

Não há um terceiro número disponível agora. A fica documentada como preferência
para um futuro customer sem histórico; a Opção B abaixo é a escolhida para o
par atual.

#### Opção B — tombstone de dedupe PROD → LAB (escolhida)

A fonte autoritativa do seed é a **interseção**, e não a união, de:

1. `processed_messages` no storage local PROD, que é a autoridade efetiva de
   dedupe por `message_id`; e
2. `inbound_event_outbox` no mesmo storage PROD, que prova que o ID foi um
   inbound de customer e fornece `received_at`, o corte temporal correto.

No intake da recepcionista, essas linhas nascem na mesma transação de
`runAtomicInboundTransaction`: o runtime insere `processed_messages`, depois
histórico, `ana_conversation_seq` e `inbound_event_outbox`, e só faz `COMMIT`
quando o conjunto durável está completo. A interseção evita dois erros
simétricos: usar somente `processed_messages` incluiria IDs de echo humano
(essa tabela também é reutilizada para echo), enquanto usar somente o outbox
incluiria um inbound que não alcançou a autoridade de dedupe.

O conjunto candidato é escopado ao `conversation_key` alvo e ao
`phone_number_id` Viti. O corte é estrito em
`inbound_event_outbox.received_at < T_HOLD`; não usar `now()`, `processed_at`
isolado ou `ana_inbound_messages` para ampliar a seleção. A presença em
`processed_messages` deve ser lida no snapshot PROD feito em `T_SEED`, ainda
durante o hold. A consulta de reconciliação abaixo não imprime IDs. Ela deriva
a interseção pelo `message_id`, registra as chaves/estado do par e produz a
cardinalidade e o digest técnico que serão comparados entre a leitura final e
a leitura imediatamente anterior ao seed. A igualdade das contagens das
fontes não é exigida: o que não tiver par fica fora da interseção.

```sql
-- PROD local; passar -v hold_at="$T_HOLD_UTC" e nunca assumir now().
WITH p AS (
  -- Presença no snapshot T_SEED; não filtrar por processed_at.
  SELECT message_id, phone_number_id, conversation_key, processed_at
  FROM processed_messages
  WHERE phone_number_id = :'phone_number_id'
    AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
), o AS (
  SELECT message_id, phone_number_id, conversation_key, received_at,
         content_status, delivered_at, terminal_at
  FROM inbound_event_outbox
  WHERE phone_number_id = :'phone_number_id'
    AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
    AND received_at < :'hold_at'::timestamptz
), j AS (
  SELECT
    p.message_id,
    p.phone_number_id AS processed_phone_number_id,
    o.phone_number_id AS outbox_phone_number_id,
    p.conversation_key AS processed_conversation_key,
    o.conversation_key AS outbox_conversation_key,
    o.content_status,
    o.delivered_at,
    o.terminal_at
  FROM p
  JOIN o ON o.message_id = p.message_id
), metrics AS (
  SELECT
    (SELECT count(*) FROM p) AS processed_source_rows,
    (SELECT count(*) FROM o) AS outbox_source_rows,
    (SELECT count(*) FROM j) AS intersection_rows,
    (SELECT count(DISTINCT message_id) FROM j) AS candidate_count,
    (SELECT md5(coalesce(
       (SELECT string_agg(message_id, E'\n' ORDER BY message_id)
          FROM (SELECT DISTINCT message_id FROM j) AS ids),
       ''
    ))) AS candidate_set_digest,
    (SELECT count(*) FROM j WHERE
       processed_phone_number_id IS DISTINCT FROM outbox_phone_number_id
       OR processed_conversation_key IS DISTINCT FROM outbox_conversation_key
    ) AS key_mismatch_rows,
    (SELECT count(*) FROM j WHERE
       content_status = 'pending'
       OR delivered_at IS NULL
       OR terminal_at IS NOT NULL
    ) AS unstable_rows,
    (SELECT count(*) FROM j WHERE
       content_status <> 'pending'
       AND delivered_at IS NOT NULL
       AND terminal_at IS NULL
    ) AS stable_rows
)
SELECT *,
  (
    key_mismatch_rows = 0
    AND unstable_rows = 0
    AND intersection_rows = stable_rows
  ) AS candidate_set_valid
FROM metrics;
```

Para este par, a cardinalidade esperada de `candidate_count` e `stable_rows` é
exatamente `1`. `processed_source_rows` e `outbox_source_rows` são métricas de
diagnóstico, não uma exigência de igualdade: uma linha sem par é
**EXCLUÍDA pela derivação da interseção**, assim como uma linha na fronteira ou
pós-hold. Não se “completa” o conjunto lendo `ana_inbound_messages`. Já uma
linha pareada com `content_status = 'pending'`, outbox sem entrega final ou
`terminal_at` preenchido é **ABORTA pela validação fail-closed**; instabilidade
não pode desaparecer como exclusão silenciosa. `key_mismatch_rows` também
aborta. A coluna `candidate_set_digest` é um digest técnico do conjunto
ordenado e não contém IDs em claro na saída compartilhada.

Uma linha de `processed_messages` pode ter `processed_at` posterior a
`T_HOLD` quando o inbound foi recebido antes do hold e concluiu a transação
durante a drenagem; ela continua sendo candidata se estiver presente no
snapshot `T_SEED` e o outbox satisfizer o corte. O `processed_at` não é filtro
nem prova de chegada.

##### Gate local da seleção (somente memória)

Antes de qualquer leitura/seed autorizado, executar
`npm run gate:ana-lab-seed-selection`. O script não importa `src/`, não lê
`DATABASE_URL`, não faz HTTP e não abre Postgres: usa apenas fixtures em
memória. Ele imprime uma linha sanitizada para cada caso da matriz abaixo,
com `expected`, `actual`, cardinalidade, digest técnico e motivo; qualquer
divergência encerra com exit não-zero. O gate também verifica separadamente
que a cerca aborta quando o digest muda com a mesma cardinalidade e quando a
cardinalidade muda.

| Caso | Resultado exigido |
|---|---|
| `processed_messages` + outbox estável, `received_at < T_HOLD` | `INCLUI` |
| `processed_messages` sem outbox | `EXCLUI` |
| outbox sem `processed_messages` | `EXCLUI` |
| `received_at = T_HOLD` | `EXCLUI` |
| `received_at > T_HOLD` | `EXCLUI` |
| recebido pre-hold, `processed_at` pós-hold | `INCLUI` |
| `content_status = pending` | `ABORTA` |
| `delivered_at IS NULL` | `ABORTA` |
| `terminal_at IS NOT NULL` | `ABORTA` |
| conjunto muda entre leitura final e seed | `ABORTA` |

`deriveSeedCandidateSet()` é deliberadamente local ao script e espelha o SQL
da seção: somente o outbox corta por `received_at < T_HOLD`; a interseção é
derivada antes da validação fail-closed. O resultado do gate não é prova de
estado real; a seleção PROD/LAB continua exigindo as leituras read-only e o
preflight deste runbook.

O único corte obrigatório é `received_at < T_HOLD` estrito: essa coluna é da
fonte que representa a chegada do inbound, não a hora de uma tentativa de
processamento posterior. A10/E7 pode reiniciar a quiet window ao observar o
`processed_at` posterior, mas não remove esse ID pré-hold do seed.

O destino é a tabela já existente `processed_messages` do **LAB**, com o
mesmo contrato do runtime. O schema atual suporta a operação: `message_id` é
chave primária global, `phone_number_id` é a coluna técnica do salão,
`conversation_key` é a concatenação exata do `phoneNumberId` com `:` e os
dígitos do customer, e `processed_at` é `timestamptz NOT NULL`. Não é
necessária tabela nova nem ledger no ERP. Se o schema real do LAB não tiver
essa PK/coluna, abortar o cutover; qualquer fence alternativa seria
LAB-only e precisaria de desenho separado, nunca uma tabela nova no ERP.

O seed é uma operação futura, em hold, imediatamente antes de `T_LAB`, depois
de uma seleção PROD repetível e da reconciliação acima. Antes do `INSERT`, o
LAB deve passar o preflight transacional abaixo. Ele não verifica ausência de
tabelas nem regride o marker: a existência do schema e da tabela
`ana_lab_schema_metadata` é pré-condição. O que precisa ser zero é o estado
operacional.

As superfícies com `conversation_key` (e o histórico, que usa
`"conversationKey"`) são consultadas para a conversa canária e também no
total global do LAB dedicado; assim um resíduo de outra conversa ou um órfão
não passa despercebido. `media_cache` só tem `phone_number_id`, então recebe
uma contagem específica do número e uma contagem global. `ana_v2_turn_receipts`,
`ana_v2_provider_status_events`, `tts_cache` e `tts_daily_usage` não têm chave
de conversa (receipts/status também não são tecnicamente atribuíveis ao
canário); como o storage LAB é dedicado, a verificação global zero é segura e
fail-closed. Uma linha em qualquer escopo aborta, sem alegar que ela pertence
à conversa.

```sql
-- LAB; transação futura, antes de qualquer INSERT do tombstone.
-- O marker e as tabelas devem existir; somente as linhas operacionais abaixo
-- precisam ser zero. Não imprimir conteúdos nem IDs.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE lab_seed_preflight AS
WITH canary_scoped AS (
  SELECT 'processed_messages'::text AS surface, 'canary'::text AS scope,
         count(*)::bigint AS rows
    FROM processed_messages
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_conversation_history', 'canary', count(*)::bigint
    FROM ana_conversation_history
   WHERE "conversationKey" = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_conversation_seq', 'canary', count(*)::bigint
    FROM ana_conversation_seq
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'inbound_event_outbox', 'canary', count(*)::bigint
    FROM inbound_event_outbox
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'sent_question_replies', 'canary', count(*)::bigint
    FROM sent_question_replies
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_v2_pending_frames', 'canary', count(*)::bigint
    FROM ana_v2_pending_frames
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_v2_flow_state_invalidations', 'canary', count(*)::bigint
    FROM ana_v2_flow_state_invalidations
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_v2_outbound_outbox', 'canary', count(*)::bigint
    FROM ana_v2_outbound_outbox
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_v2_silent_escalation_holds', 'canary', count(*)::bigint
    FROM ana_v2_silent_escalation_holds
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'ana_v2_successor_batches', 'canary', count(*)::bigint
    FROM ana_v2_successor_batches
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'sales_followups', 'canary', count(*)::bigint
    FROM sales_followups
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'renata_channel_prefs', 'canary', count(*)::bigint
    FROM renata_channel_prefs
   WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
  UNION ALL
  SELECT 'media_cache', 'phone_number_id-only', count(*)::bigint
    FROM media_cache
   WHERE phone_number_id = :'phone_number_id'
), lab_global AS (
  SELECT 'processed_messages', 'lab-global', count(*)::bigint
    FROM processed_messages
  UNION ALL SELECT 'ana_conversation_history', 'lab-global', count(*)::bigint
    FROM ana_conversation_history
  UNION ALL SELECT 'ana_conversation_seq', 'lab-global', count(*)::bigint
    FROM ana_conversation_seq
  UNION ALL SELECT 'inbound_event_outbox', 'lab-global', count(*)::bigint
    FROM inbound_event_outbox
  UNION ALL SELECT 'sent_question_replies', 'lab-global', count(*)::bigint
    FROM sent_question_replies
  UNION ALL SELECT 'ana_v2_pending_frames', 'lab-global', count(*)::bigint
    FROM ana_v2_pending_frames
  UNION ALL SELECT 'ana_v2_flow_state_invalidations', 'lab-global', count(*)::bigint
    FROM ana_v2_flow_state_invalidations
  UNION ALL SELECT 'ana_v2_outbound_outbox', 'lab-global', count(*)::bigint
    FROM ana_v2_outbound_outbox
  UNION ALL SELECT 'ana_v2_silent_escalation_holds', 'lab-global', count(*)::bigint
    FROM ana_v2_silent_escalation_holds
  UNION ALL SELECT 'ana_v2_successor_batches', 'lab-global', count(*)::bigint
    FROM ana_v2_successor_batches
  UNION ALL SELECT 'sales_followups', 'lab-global', count(*)::bigint
    FROM sales_followups
  UNION ALL SELECT 'renata_channel_prefs', 'lab-global', count(*)::bigint
    FROM renata_channel_prefs
  UNION ALL SELECT 'media_cache', 'lab-global', count(*)::bigint
    FROM media_cache
  -- Sem conversation_key próprio: não atribuir; no LAB dedicado, qualquer
  -- linha é resíduo/órfão e deve abortar.
  UNION ALL SELECT 'ana_v2_turn_receipts', 'lab-global-unscoped', count(*)::bigint
    FROM ana_v2_turn_receipts
  UNION ALL SELECT 'ana_v2_provider_status_events', 'lab-global-unscoped', count(*)::bigint
    FROM ana_v2_provider_status_events
  UNION ALL SELECT 'tts_cache', 'lab-global-unscoped', count(*)::bigint
    FROM tts_cache
  UNION ALL SELECT 'tts_daily_usage', 'lab-global-unscoped', count(*)::bigint
    FROM tts_daily_usage
), preflight AS (
  SELECT * FROM canary_scoped
  UNION ALL
  SELECT * FROM lab_global
)
SELECT surface, scope, rows
  FROM preflight;

SELECT surface, scope, rows
  FROM lab_seed_preflight
 ORDER BY surface, scope;

-- Divisão por zero é o fail-closed: qualquer estado operacional aborta.
SELECT 1 / CASE WHEN bool_and(rows = 0) THEN 1 ELSE 0 END
  AS lab_operational_state_empty
  FROM lab_seed_preflight;
ROLLBACK;
```

O primeiro `SELECT` é um relatório sanitizado de contagens. O segundo só
prossegue com zero em todos os escopos; se o storage dedicado contiver uma
linha de outra conversa, um `processed_messages.conversation_key IS NULL`, um
receipt/status órfão ou cache sem atribuição, o preflight aborta. `COMMIT` não
deve ocorrer no preflight; a sessão termina em `ROLLBACK` e somente depois se
abre a transação de seed. O `message_id` cru só deve existir no arquivo
temporário `0600` ou no pipe protegido descrito abaixo; não deve aparecer em
bind `-v`, argv, terminal, saída compartilhada ou log. O valor escolhido para
`processed_at` é `T_SEED_UTC`
(a hora da semeadura, não a hora histórica do PROD), para que a limpeza de
retenção de 90 dias não remova a linha durante a janela de cutover:

```sql
-- O preflight acima terminou em ROLLBACK; abrir a transação de seed somente
-- depois do resultado zero. seed_input é preenchida pelo procedimento de
-- transporte protegido da
-- subseção seguinte. O message_id nunca é variável -v nem argumento de psql.
-- T_SEED_UTC precisa ser registrado e T_SEED < T_LAB.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE seed_input (
  message_id text PRIMARY KEY
);
-- COPY FROM STDIN é alimentado pelo arquivo 0600, sem valor no argv.
COPY seed_input (message_id) FROM STDIN;
\.

SELECT 1 / CASE WHEN (SELECT count(*) FROM seed_input) = 1 THEN 1 ELSE 0 END
  AS seed_input_exactly_one;

-- RETURNING expõe somente a constante 1. Conflito global de message_id faz
-- count(*) = 0 e aborta a transação; o ID cru nunca aparece na saída.
WITH inserted AS (
  INSERT INTO processed_messages (
    message_id, phone_number_id, conversation_key, processed_at
  )
  SELECT seed_input.message_id,
         :'phone_number_id',
         concat(:'phone_number_id', ':', :'customer_phone_digits'),
         :'seed_at'::timestamptz
    FROM seed_input
  ON CONFLICT (message_id) DO NOTHING
  RETURNING 1
)
SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS seeded_exactly_once
FROM inserted;

-- Falha fechado se a conversa não terminar com exatamente o tombstone.
SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS lab_has_one_tombstone
FROM processed_messages
WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');
COMMIT;
```

##### Transporte protegido do `message_id` cru — procedimento futuro

O `message_id` é inevitável na operação de seed, mas não pode ser carregado
numa variável shell nem passado como `-v`, `-c`, argumento de processo ou
parâmetro de `psql`. O procedimento abaixo é somente futuro e executável: roda
como script **não interativo**, com `umask 077`, diretório temporário `0700` e
arquivos `0600`. O shell tracing e o verbose ficam desligados antes de abrir o
arquivo; a seleção redireciona o único valor cru diretamente para o arquivo
protegido, sem terminal, histórico, `ps` ou log. Use os bindings externos já
definidos no cabeçalho do runbook para os seletores da conversa; nunca inclua o
ID cru neles.

Primeiro execute o bloco de preflight acima numa sessão `psql` LAB separada,
com o processo `receps-ia-lab` parado. Exija exit `0` e a linha
`lab_operational_state_empty = 1`; ele termina em `ROLLBACK`. Só então execute
o script abaixo, que abre a transação de seed. Se o preflight falhar ou se o
processo LAB voltar a escrever entre as duas sessões, abortar e repetir ambos
os passos sob o hold.

```sh
#!/usr/bin/env bash
# SOMENTE PROCEDIMENTO FUTURO — nenhum ID, segredo ou DSN é mostrado aqui.
set -euo pipefail
set +x
set +v
umask 077
export HISTFILE=/dev/null

SEED_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ana-seed.XXXXXX")"
SEED_SELECT_SQL="$SEED_TMP_DIR/select.sql"
SEED_LAB_SELECT_SQL="$SEED_TMP_DIR/lab-select.sql"
SEED_METRICS_SQL="$SEED_TMP_DIR/metrics.sql"
SEED_FINAL_METRICS_FILE="$SEED_TMP_DIR/final-metrics"
SEED_T_SEED_METRICS_FILE="$SEED_TMP_DIR/t-seed-metrics"
SEED_ID_FILE="$SEED_TMP_DIR/message-id"
SEED_LAB_ID_FILE="$SEED_TMP_DIR/lab-message-id"
CLEANUP_RUNNING=0

cleanup() {
  if [ "$CLEANUP_RUNNING" -ne 0 ]; then return 0; fi
  CLEANUP_RUNNING=1
  cleanup_status=0
  if ! rm -f -- "$SEED_SELECT_SQL" "$SEED_LAB_SELECT_SQL" "$SEED_METRICS_SQL" \
    "$SEED_FINAL_METRICS_FILE" "$SEED_T_SEED_METRICS_FILE" \
    "$SEED_ID_FILE" "$SEED_LAB_ID_FILE"; then
    cleanup_status=1
  fi
  if ! rmdir -- "$SEED_TMP_DIR"; then cleanup_status=1; fi
  return "$cleanup_status"
}
abort_on_signal() {
  cleanup || true
  exit 1
}
on_exit() {
  cleanup || true
}
trap on_exit EXIT
trap abort_on_signal HUP INT TERM

# mktemp já cria o diretório privado; reafirmar 0700 com os traps ativos.
chmod 700 "$SEED_TMP_DIR"
# Os traps já estão ativos antes de criar qualquer arquivo, inclusive os que
# poderão conter o valor cru.
(umask 077; : > "$SEED_SELECT_SQL"; : > "$SEED_LAB_SELECT_SQL"; : > "$SEED_METRICS_SQL"; : > "$SEED_FINAL_METRICS_FILE"; : > "$SEED_T_SEED_METRICS_FILE"; : > "$SEED_ID_FILE"; : > "$SEED_LAB_ID_FILE")
chmod 600 "$SEED_SELECT_SQL" "$SEED_LAB_SELECT_SQL" "$SEED_METRICS_SQL" \
  "$SEED_FINAL_METRICS_FILE" "$SEED_T_SEED_METRICS_FILE" \
  "$SEED_ID_FILE" "$SEED_LAB_ID_FILE"

# As métricas abaixo são a mesma canonicalização SQL da seleção da seção 6 e
# devolvem somente candidate_count|candidate_set_digest|candidate_set_valid.
# Os arquivos de métricas são 0600 e nunca contêm o ID cru.
(cat > "$SEED_METRICS_SQL" <<'SQL'
\set ON_ERROR_STOP on
WITH p AS (
  SELECT message_id, phone_number_id, conversation_key
    FROM processed_messages
   WHERE phone_number_id = :'phone_number_id'
     AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
), o AS (
  SELECT message_id, phone_number_id, conversation_key,
         content_status, delivered_at, terminal_at
    FROM inbound_event_outbox
   WHERE phone_number_id = :'phone_number_id'
     AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
     AND received_at < :'hold_at'::timestamptz
), j AS (
  SELECT p.message_id,
         p.phone_number_id AS processed_phone_number_id,
         o.phone_number_id AS outbox_phone_number_id,
         p.conversation_key AS processed_conversation_key,
         o.conversation_key AS outbox_conversation_key,
         o.content_status, o.delivered_at, o.terminal_at
    FROM p
    JOIN o ON o.message_id = p.message_id
), metrics AS (
  SELECT count(DISTINCT message_id) AS candidate_count,
         count(*) AS intersection_rows,
         count(*) FILTER (WHERE
           processed_phone_number_id IS DISTINCT FROM outbox_phone_number_id
           OR processed_conversation_key IS DISTINCT FROM outbox_conversation_key
         ) AS key_mismatch_rows,
         count(*) FILTER (WHERE
           content_status = 'pending'
           OR delivered_at IS NULL
           OR terminal_at IS NOT NULL
         ) AS unstable_rows,
         count(*) FILTER (WHERE
           content_status <> 'pending'
           AND delivered_at IS NOT NULL
           AND terminal_at IS NULL
         ) AS stable_rows,
         (SELECT md5(coalesce(
            (SELECT string_agg(message_id, E'\n' ORDER BY message_id)
               FROM (SELECT DISTINCT message_id FROM j) AS ids),
            ''
         ))) AS candidate_set_digest
    FROM j
)
SELECT candidate_count, candidate_set_digest,
       CASE WHEN key_mismatch_rows = 0
                  AND unstable_rows = 0
                  AND intersection_rows = stable_rows
            THEN 'true' ELSE 'false' END AS candidate_set_valid
  FROM metrics;
SQL
)

# Leitura final: somente valores sanitizados (count, digest e booleano).
PGSERVICE=ana-prod psql -X -qAt -F '|' -v ON_ERROR_STOP=1 \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" \
  -v hold_at="$T_HOLD_UTC" \
  -f "$SEED_METRICS_SQL" > "$SEED_FINAL_METRICS_FILE"
test "$(wc -l < "$SEED_FINAL_METRICS_FILE" | tr -d ' ')" = 1
IFS='|' read -r FINAL_CANDIDATE_COUNT FINAL_CANDIDATE_DIGEST FINAL_CANDIDATE_VALID \
  < "$SEED_FINAL_METRICS_FILE"
test "$FINAL_CANDIDATE_COUNT" = 1
test "$FINAL_CANDIDATE_VALID" = true

# No início de T_SEED, ainda em hold e imediatamente antes de extrair o ID,
# reexecutar a MESMA consulta/canonicalização. Só count+digest sanitizados são
# guardados em variáveis shell; o ID cru ainda não foi lido.
PGSERVICE=ana-prod psql -X -qAt -F '|' -v ON_ERROR_STOP=1 \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" \
  -v hold_at="$T_HOLD_UTC" \
  -f "$SEED_METRICS_SQL" > "$SEED_T_SEED_METRICS_FILE"
test "$(wc -l < "$SEED_T_SEED_METRICS_FILE" | tr -d ' ')" = 1
IFS='|' read -r T_SEED_CANDIDATE_COUNT T_SEED_CANDIDATE_DIGEST T_SEED_CANDIDATE_VALID \
  < "$SEED_T_SEED_METRICS_FILE"
test "$T_SEED_CANDIDATE_COUNT" = 1
test "$T_SEED_CANDIDATE_VALID" = true
test "$T_SEED_CANDIDATE_COUNT" = "$FINAL_CANDIDATE_COUNT"
test "$T_SEED_CANDIDATE_DIGEST" = "$FINAL_CANDIDATE_DIGEST"

# Só depois da cerca count+digest estável, extrair o ID cru para arquivo 0600.
# A saída é redirecionada; não usar tee, less, set -x ou qualquer verbose.
# A consulta não filtra processed_at: só received_at < T_HOLD.
(cat > "$SEED_SELECT_SQL" <<'SQL'
\set ON_ERROR_STOP on
WITH p AS (
  SELECT message_id, phone_number_id, conversation_key
    FROM processed_messages
   WHERE phone_number_id = :'phone_number_id'
     AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
), o AS (
  SELECT message_id, phone_number_id, conversation_key,
         content_status, delivered_at, terminal_at
    FROM inbound_event_outbox
   WHERE phone_number_id = :'phone_number_id'
     AND conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
     AND received_at < :'hold_at'::timestamptz
), j AS (
  SELECT p.message_id,
         p.phone_number_id AS processed_phone_number_id,
         o.phone_number_id AS outbox_phone_number_id,
         p.conversation_key AS processed_conversation_key,
         o.conversation_key AS outbox_conversation_key,
         o.content_status, o.delivered_at, o.terminal_at
    FROM p
    JOIN o ON o.message_id = p.message_id
), metrics AS (
  SELECT count(DISTINCT message_id) AS candidate_count,
         count(*) AS intersection_rows,
         count(*) FILTER (WHERE
           processed_phone_number_id IS DISTINCT FROM outbox_phone_number_id
           OR processed_conversation_key IS DISTINCT FROM outbox_conversation_key
         ) AS key_mismatch_rows,
         count(*) FILTER (WHERE
           content_status = 'pending'
           OR delivered_at IS NULL
           OR terminal_at IS NOT NULL
         ) AS unstable_rows,
         count(*) FILTER (WHERE
           content_status <> 'pending'
           AND delivered_at IS NOT NULL
           AND terminal_at IS NULL
         ) AS stable_rows
    FROM j
), candidates AS (
  SELECT j.message_id
    FROM j CROSS JOIN metrics
   WHERE metrics.candidate_count = 1
     AND metrics.key_mismatch_rows = 0
     AND metrics.unstable_rows = 0
     AND metrics.intersection_rows = metrics.stable_rows
)
SELECT message_id FROM candidates ORDER BY message_id;
SQL
)
PGSERVICE=ana-prod psql -X -qAt -v ON_ERROR_STOP=1 \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" \
  -v hold_at="$T_HOLD_UTC" \
  -f "$SEED_SELECT_SQL" > "$SEED_ID_FILE"

# Só contagem, validação de formato e digest técnico; nunca cat/echo do arquivo.
SEED_COUNT="$(wc -l < "$SEED_ID_FILE" | tr -d ' ')"
test "$SEED_COUNT" = 1

# Fechamento da janela T_SEED → extração: o arquivo acabou de ser produzido,
# mas ainda não houve conexão/seed LAB. Node recebe somente o caminho do arquivo
# no argv, remove a única newline final do psql e imprime apenas o MD5 do ID.
# O ID cru nunca é carregado em variável shell nem aparece na saída.
EXTRACTED_CANDIDATE_MD5="$(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const bytes = fs.readFileSync(process.argv[1]);
  if (
    bytes.length < 1 ||
    bytes[bytes.length - 1] !== 0x0a ||
    bytes.subarray(0, bytes.length - 1).includes(0x0a) ||
    bytes.subarray(0, bytes.length - 1).includes(0x0d)
  ) process.exit(2);
  process.stdout.write(
    crypto.createHash("md5")
      .update(bytes.subarray(0, bytes.length - 1))
      .digest("hex")
  );
' "$SEED_ID_FILE")"
test "$EXTRACTED_CANDIDATE_MD5" = "$T_SEED_CANDIDATE_DIGEST"

# Este é outro digest, deliberadamente separado: SHA-256 dos bytes do arquivo
# PROD, incluindo a newline, para a comparação posterior PROD-file ↔ LAB-file.
SEED_FILE_SHA256="$(shasum -a 256 "$SEED_ID_FILE" | awk '{print $1}')"

# O pipe leva o arquivo protegido ao stdin do psql LAB. O valor nunca aparece
# no argv: cat recebe somente o caminho 0600 e COPY o ingere numa temp table.
{
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE seed_input (message_id text PRIMARY KEY);
COPY seed_input (message_id) FROM STDIN;
SQL
  cat "$SEED_ID_FILE"
  printf '%s\n' '\.'
  cat <<'SQL'
SELECT 1 / CASE WHEN (SELECT count(*) FROM seed_input) = 1 THEN 1 ELSE 0 END;
WITH inserted AS (
  INSERT INTO processed_messages (
    message_id, phone_number_id, conversation_key, processed_at
  )
  SELECT message_id, :'phone_number_id',
         concat(:'phone_number_id', ':', :'customer_phone_digits'),
         :'seed_at'::timestamptz
    FROM seed_input
  ON CONFLICT (message_id) DO NOTHING
  RETURNING 1
)
SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END FROM inserted;
SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END
  FROM processed_messages
 WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits');
COMMIT;
SQL
} | PGSERVICE=ana-lab psql -X -q -v ON_ERROR_STOP=1 \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" \
  -v seed_at="$T_SEED_UTC"

# Releitura LAB também vai para arquivo 0600. A igualdade é conferida por
# contagem + SHA-256 do arquivo, mas o relatório compartilhado contém somente
# esses campos.
(cat > "$SEED_LAB_SELECT_SQL" <<'SQL'
\set ON_ERROR_STOP on
SELECT message_id FROM processed_messages
 WHERE conversation_key = concat(:'phone_number_id', ':', :'customer_phone_digits')
 ORDER BY message_id;
SQL
)
PGSERVICE=ana-lab psql -X -qAt -v ON_ERROR_STOP=1 \
  -v phone_number_id="$VITI_PHONE_NUMBER_ID" \
  -v customer_phone_digits="$VITI_CUSTOMER_PHONE_DIGITS" \
  -f "$SEED_LAB_SELECT_SQL" > "$SEED_LAB_ID_FILE"
LAB_COUNT="$(wc -l < "$SEED_LAB_ID_FILE" | tr -d ' ')"
LAB_FILE_SHA256="$(shasum -a 256 "$SEED_LAB_ID_FILE" | awk '{print $1}')"
test "$LAB_COUNT" = 1
test "$LAB_FILE_SHA256" = "$SEED_FILE_SHA256"
printf 'seed_source_count=%s seed_file_sha256=%s lab_count=%s lab_file_sha256=%s\n' \
  "$SEED_COUNT" "$SEED_FILE_SHA256" "$LAB_COUNT" "$LAB_FILE_SHA256"
# Cleanup explícito no sucesso; o trap continua cobrindo falhas inesperadas.
trap - HUP INT TERM
cleanup
trap - EXIT
```

O pipeline acima é uma alternativa protegida ao `-v seeded_message_id=...`:
o ID não entra em shell history, `argv`, `ps`, `set -x`, terminal ou arquivo
permissivo. O relatório final contém somente contagens e digests. Se a seleção
retornar zero, mais de uma linha, digest divergente, conflito de PK ou qualquer
erro de transação, abortar e manter o hold; nunca tentar completar o conjunto
com outra tabela. A extração e a ingestão devem ocorrer ainda com o hold ativo,
e o cleanup deve ser confirmado antes de qualquer próximo passo operacional.

Os nomes dos digests são importantes: `FINAL_CANDIDATE_DIGEST` e
`T_SEED_CANDIDATE_DIGEST` são o `candidate_set_digest` **MD5** da mesma
canonicalização SQL e servem exclusivamente para comparar leitura final ↔
`T_SEED`; eles não são o digest do arquivo. `SEED_FILE_SHA256` e
`LAB_FILE_SHA256` são
**SHA-256 dos bytes dos arquivos 0600**, incluindo a quebra de linha produzida
por `psql`, e servem exclusivamente para comparar arquivo PROD ↔ arquivo LAB.
Há ainda um terceiro vínculo, executado antes do psql LAB: o Node calcula
`EXTRACTED_CANDIDATE_MD5` a partir dos bytes do arquivo recém-extraído, sem a
única newline final, e o compara com `T_SEED_CANDIDATE_DIGEST`. Isso fecha a
janela `T_SEED → extração` caso o conjunto mude entre a segunda leitura e a
terceira query; só depois dessa comparação o ID atravessa o pipe protegido para
o LAB. Não comparar esses três tipos de digest entre si, nem chamar essa
sequência de transação atômica cross-storage. O gate em memória usa SHA-256 de
uma representação JSON de fixtures apenas para provar a propriedade de
cardinalidade/digest; seu valor não é apresentado como igual ao digest SQL ou
ao digest de transporte.

O `ON CONFLICT` não autoriza sobrescrever uma linha: se a inserção encontrar
um ID global já presente com outra conversa ou se a contagem final não for
`1`, abortar e investigar. Repetir a seleção PROD no instante `T_SEED`, ainda
em hold, já é feito pelo bloco `metrics.sql` do procedimento acima; comparar
**cardinalidade e `candidate_set_digest`** com a leitura final imediatamente
anterior ao transporte. Qualquer mudança, inclusive com a mesma cardinalidade
e IDs diferentes, é `ABORTA`. Para o par atual, exigir
`candidate_count = stable_rows = 1`; no LAB, a contagem da conversation key
deve ser zero antes e um depois. O tombstone deve ser rechecado imediatamente
antes da troca para LAB e durante a janela; não executar limpeza que o remova.
A linha do snapshot atual tem aproximadamente duas semanas, portanto também há
margem dentro da retenção, mas a escolha de `T_SEED` evita depender dessa idade
histórica.

##### Prova temporal da semeadura

Defina, de forma estrita,

```text
S(T_HOLD) = { message_id |
  processed_messages PROD ∩ inbound_event_outbox PROD,
  mesma conversation_key/phone_number_id,
  inbound_event_outbox.received_at < T_HOLD,
  processed_messages presente no snapshot PROD em T_SEED,
  conteúdo final e outbox estabilizado
}
```

Um inbound criado **durante** o hold tem
`inbound_event_outbox.received_at >= T_HOLD` e, com o router devolvendo 503
antes do handler, não entra nas duas fontes PROD. Logo não pode satisfazer a
interseção com o corte estrito e não pode ser semeado. A fronteira igual a
`T_HOLD` fica fora por segurança. Se qualquer linha PROD pós-hold aparecer,
A10/E7 reinicia a janela para a atividade pós-hold, mas um ID cujo
`received_at` é pré-hold continua elegível e não deve ser excluído somente
porque `processed_at` ficou posterior ao corte. Manter o hold e reconciliar,
sem expandir o conjunto via `ana_inbound_messages`.

A ordem exigida é `T_HOLD < T_SEED < T_LAB < T_CANARY_SEND`. O snapshot PROD,
a seleção repetida em `T_SEED` e a contagem LAB formam uma verificação
imutável/repetível por contagens e digest técnico, sem expor IDs. Esse fence
temporal impede que um inbound nunca visto no PROD durante o hold seja tratado
como tombstone; ele não transforma replay antigo em canário.

##### Duplicatas no LAB

- **ID semeado:** cada chegada ao runtime executa o intake atômico, encontra o
  `PRIMARY KEY (message_id)` já reservado e retorna `fresh = false`. O handler
  retorna imediatamente: zero histórico, sequência, outbox, modelo, outbound
  ou outro state. Duas chegadas do mesmo ID continuam sendo dois no-ops.
- **ID não visto no PROD:** a primeira chegada insere `processed_messages`, uma
  linha de `ana_conversation_history`, incrementa `ana_conversation_seq` e
  cria `inbound_event_outbox` na mesma transação; depois pode seguir ao modelo
  e à resposta permitida. A segunda encontra o conflito e retorna
  `fresh = false`, portanto há no máximo um intake/processamento/resposta.

As corridas são serializadas pela advisory lock de conversa e, em última
instância, pela PK global de `message_id`. O caminho real faz exatamente isso
em `persistInboundAtomically` → `runAtomicInboundTransaction`; não se deve
substituí-lo por um ledger novo nem testar o seed somente por contagem de
histórico, que é retido/aparado.

**Verificação de PII no checkout atual (não prova deploy):** no HEAD desta
branch, o ramo `fresh = false` de `src/messageHandler.ts` já registra somente
`messageIdHash=technicalHash(message.id)`, sem interpolar o ID cru. Não há
patch de runtime autorizado ou necessário nesta unidade. Essa é evidência
estática do checkout, não prova do processo implantado; antes do cutover, ainda
é obrigatório correlacionar SHA/PID reais e executar o smoke de PII autorizado.

##### Limites da interseção e do smoke

- A interseção cobre replay de `messages[]` de cliente que já foi processado
  no PROD. Ela **não é um ledger universal da WABA** e não promete deduplicar
  universalmente `smb_message_echoes` ou `statuses[]`.
- Echo humano pode ocupar `processed_messages`, mas não cria
  `inbound_event_outbox`; por isso fica deliberadamente fora do seed. Isso é
  uma exclusão intencional, não uma falha da seleção.
- No smoke `smoke:ana-lab-cross-storage-dedupe`, `erpWrite` é somente o
  contador do `deliverInbound` injetado. Ele prova que o ID novo atravessou o
  downstream uma vez na fixture; **não prova a write policy do LAB**. A policy
  continua coberta pelos gates específicos de runtime/storage.

## 7. ATIVAÇÃO LAB — SOMENTE PROCEDIMENTO

Ativar somente após `VITI_PROD_QUIESCENT=true` e resolução dos blockers. Esta
seção descreve passos futuros; nenhum foi executado.

### Hardening obrigatório de `T_SEED` → `T_LAB` (procedimento futuro)

Durante toda a semeadura, o hold continua ativo e o router ainda não pode
encaminhar para LAB. A ordem abaixo é obrigatória e prevalece sobre qualquer
ordem abreviada da lista de ativação:

1. Parar **somente** `receps-ia-lab` (`receps-ia` PROD, `RecepsERP` e todos os
   serviços PROD permanecem intocados). Não fazer deploy nem restart de PROD.
2. Com o LAB parado, confirmar marker/schema dedicado e executar o preflight
   transacional da seção anterior. Todas as contagens da conversa canária e os
   checks globais fail-closed precisam ser zero; qualquer estado desconhecido,
   órfão ou sem chave de conversa aborta.
3. Ainda sob hold e com o resultado zero registrado, extrair e transportar o
   conjunto pelo procedimento protegido, e executar o `INSERT` do tombstone.
   `T_SEED` é registrado neste instante.
4. Reconsultar o LAB em leitura protegida e exigir **exatamente um** tombstone
   para a conversation key, com cardinalidade e digest iguais aos da seleção
   PROD. Qualquer conflito, digest divergente ou contagem diferente aborta.
5. Só depois iniciar `receps-ia-lab`. Ler health, fingerprint e recoveries
   locais, exigindo `runtimeMode=lab`, `writePolicy=disabled`, jobs globais
   desligados e os três recoveries v2 verdes. Falha ou campo ausente mantém o
   hold.
6. Revalidar o tombstone após o LAB subir, sempre em leitura sem mutação. Só
   depois dessa revalidação preparar a troca `hold → lab` e registrar `T_LAB`
   quando a rota LAB estiver efetiva. Até lá não existe canário LAB.

Os comandos concretos de parar/iniciar processo são apenas procedimento
futuro autorizado; esta tarefa não executa nenhum deles e não altera PROD.

### Efetivar a rota LAB após a sequência de seed

1. Preparar a troca do router ERP de `hold` para `lab`, mantendo o mesmo
  `phoneNumberId` fechado, o slug literal `studio-viti` e a URL canônica:

   ```text
   BOT_PROCESSOR_LAB_ROUTE_MODE=lab
   BOT_PROCESSOR_LAB_PHONE_NUMBER_ID=<mesmo ID técnico aprovado>
   BOT_PROCESSOR_LAB_TENANT_SLUG=studio-viti
   BOT_PROCESSOR_LAB_WEBHOOK_URL=http://127.0.0.1:3002/webhook
   BOT_PROCESSOR_WEBHOOK_URL=<endpoint PROD original, preservado>
   TZ=America/Sao_Paulo
   ```

2. Reiniciar **somente** `RecepsERP` com `--update-env` e preservar
   explicitamente `TZ=America/Sao_Paulo`. Não reiniciar `receps-ia` PROD.
   Reler `/proc` do PID novo, conferir SHA/PID/starttime e confirmar que o
   processo LAB continua em `127.0.0.1:3002`.
3. Confirmar HMAC ponta a ponta por presença/fingerprint técnico do segredo
   compartilhado, sem imprimir o segredo. O router valida HMAC da Meta antes de
   classificar; o forward ERP→LAB usa `X-Bot-Signature` e o LAB valida esse
   header. Falha de segredo, timeout, rede, redirect ou não-2xx é 503 e nunca
   fallback PROD.
4. Ler `GET http://127.0.0.1:3002/health` e exigir exatamente:

   ```text
   runtimeMode=lab
   writePolicy=disabled
   globalBackgroundJobs=false
   v2RecoveryJobs=true              # Viti está na allowlist v2
   localRecoveryJobs.conversationalV2State=true
   localRecoveryJobs.conversationalV2Successor=true
   localRecoveryJobs.providerStatusV2=true
   ```

   Se `v2RecoveryJobs` for falso por allowlist ausente/misturada, parar; não
   considerar um LAB parcialmente armado como prova.
5. A prova experimental não é o “primeiro inbound do LAB”. Registrar `T_LAB`
   no instante em que a rota LAB estiver efetiva e o health filtrado confirmar
   o modo esperado. Depois, o customer controlado deve enviar
   **deliberadamente** um inbound informacional (`T_CANARY_SEND > T_LAB`), por
   exemplo uma pergunta de serviços/preço cadastrado. Registrar somente o
   `messageIdHash` técnico derivado desse evento, nunca o ID cru. Não usar
   pedido de agendamento, remarcação, cancelamento, escalada ou qualquer frase
   que licencie uma escrita como a entrada experimental inicial.
6. Observar a entrada experimental atravessando a cadeia completa:
   `ERP router → LAB → storage LAB → resposta permitida`. Correlacionar
   `T_CANARY_SEND`, decisão sanitizada do router, `messageIdHash`, presença da
   linha correspondente no storage LAB e receipt/resposta permitida. Timestamps
   sozinhos não bastam. Confirmar também que nenhum evento conversacional
   correspondente entrou no `receps-ia` PROD, o provider/model esperado foi
   usado, o storage LAB recebeu apenas as linhas locais esperadas e nenhum
   business write ERP ocorreu. O log deve usar `messageIdHash`/hash de conversa,
   nunca `messageId`, `wamid`, telefone, nome ou mensagem.

   Qualquer `messages[]` que já estivesse retido/retransmitido antes de
   `T_CANARY_SEND`, inclusive um replay do hold, é **TRÁFEGO DE TRANSIÇÃO**.
   Pode ser contabilizado e reconciliado como tal, mas não é a entrada
   experimental nem prova do canário. Se a correlação do evento deliberado
   estiver ausente, parar e não chamar o inbound de canário.
7. Validar o marker do storage LAB sem imprimir o fingerprint:

   ```sh
   # SOMENTE PROCEDIMENTO FUTURO; leitura sem fingerprint em claro.
   PGTZ=UTC psql "$LAB_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
   SELECT
     schema_version,
     (database_fingerprint IS NOT NULL) AS fingerprint_present,
     bootstrapped_at
   FROM ana_lab_schema_metadata
   WHERE singleton = true;
   ROLLBACK;
   SQL
   ```

   Esperar `schema_version = 1`, `fingerprint_present = true` e uma única linha.
   O fingerprint só pode ser comparado tecnicamente fora da saída compartilhada.
8. Antes e depois do teste, executar contagens read-only no LAB e no PROD. No
   LAB, o bootstrap deve ter começado vazio e, após a Opção B, deve conter
   exatamente o tombstone semeado para a conversation key. O inbound
   experimental acrescentará suas próprias linhas; o ID semeado continua sendo
   distinguido por `messageIdHash` técnico e não pode ser contado como entrada
   experimental. Histórico, intake, receipts e status locais podem ter
   contagens positivas, mas appointment, cancelamento, escalada ERP e
   pause/resume ERP devem permanecer sem delta.
   Reutilizar A10/E7 com o marco do teste e um bloco de contagens LAB:

   ```sql
   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
   SELECT 'processed_messages' AS table_name, count(*) AS rows FROM processed_messages
   UNION ALL SELECT 'ana_conversation_history', count(*) FROM ana_conversation_history
   UNION ALL SELECT 'inbound_event_outbox', count(*) FROM inbound_event_outbox
   UNION ALL SELECT 'sent_question_replies', count(*) FROM sent_question_replies
   UNION ALL SELECT 'ana_v2_outbound_outbox', count(*) FROM ana_v2_outbound_outbox
   UNION ALL SELECT 'ana_v2_turn_receipts', count(*) FROM ana_v2_turn_receipts
   UNION ALL SELECT 'ana_v2_provider_status_events', count(*) FROM ana_v2_provider_status_events;
   ROLLBACK;
   ```

9. Não usar `cutoverAt` sozinho para atribuir causalidade. Cruzar o timestamp
   com a decisão do router, PID/starttime, logs sanitizados, deltas ERP e
   marker/storage LAB. O router sem ledger durável é o achado #4, aceitável
   neste canário quando a correlação do evento deliberado da etapa 6 estiver
   completa; isso não é prova universal para outros eventos. Se a correlação
   mínima faltar, parar e qualificar a prova, sem chamar o resultado de GO.

## 8. ROLLBACK

O LAB nunca volta diretamente para PROD e não existe fallback automático.

1. Diante de qualquer anomalia, primeiro trocar `lab → hold` no router ERP.
2. Reiniciar somente `RecepsERP` para aplicar o env real, com
   `TZ=America/Sao_Paulo` explícito e `--update-env`. Não reiniciar
   `receps-ia` PROD para limpar a situação.
3. Confirmar no `/proc` o modo efetivo `hold`, o PID/starttime do ERP e que
   `receps-ia` PROD continua no mesmo PID/starttime. O Viti deve voltar a 503
   retryable; não encaminhar automaticamente para PROD.
4. Preservar storage LAB, marker, receipts, contagens e logs sanitizados para
   investigação. Não apagar, truncar ou recriar banco automaticamente.
5. Reauditar LAB e PROD com A1–A10, E1–E7 e os deltas pós-hold. Mensagens Meta
   retidas podem ser retransmitidas; decidir sua reconciliação em procedimento
   próprio, com hashes e sem assumir que um 503 foi perda definitiva.
6. Só depois da auditoria e de uma decisão operacional separada elaborar um
   procedimento de retorno. Esse procedimento precisa resolver ownership,
   receipts, replays e qualquer business write; o router não pode escolher
   PROD como plano de contingência silencioso.

## 9. FEASIBILITY AUDIT

### Classificação revisada dos seis achados

O revisor separou provabilidade universal, risco residual e blocker concreto.
Não se aplica mais a regra falsa de que todo achado que não é universalmente
provável bloqueia o canário:

| # | Achado | Classificação | Regra para este canário |
|---:|---|---|---|
| 1 | `transport_unknown` sem negativa do provider | **BLOCKER CONDICIONAL** | A impossibilidade teórica de provar a negativa não bloqueia. Uma ocorrência concreta de `transport_unknown` para o Viti bloqueia; GO exige `transport_unknown = 0`, `transport_started = 0` e `accepted_uncommitted = 0`. Não esperar envelhecer: resolver por evidência externa suficiente ou trocar o customer. O snapshot fornecido não observou ocorrência para este par. |
| 2 | receipts sem `conversation_key` | **RISCO ACEITÁVEL (P2)** | `ana_v2_turn_receipts` continua parcialmente não atribuível; A8 escopa o que tiver vínculo. O risco não bloqueia este canário quando as linhas escopáveis e as demais cercas passarem, mas não pode ser apresentado como prova universal. |
| 3 | sem prova universal de zero business write | **ACEITÁVEL COM CERCA** | Deltas ERP, decisão do router, storage dedicado e correlação sanitizada cobrem a prova operacional do evento controlado. Isso não afirma zero universal em todos os sistemas. |
| 4 | router sem ledger durável | **ACEITÁVEL NESTE CANÁRIO** | Para uma entrada deliberada, correlacionar decisão do router, `T_LAB`, `T_CANARY_SEND`, PID/starttime, `messageIdHash`, storage LAB e resposta permitida. A correlação não é ledger universal. |
| 5 | trabalho in-memory sem registry/deadline | **BLOCKER CONDICIONAL** | A falta de registry sozinha não bloqueia. Qualquer `content_status = 'pending'`, transcrição/mídia pendente ou caminho sem teto observado bloqueia. Com caminhos ilimitados excluídos, PID estável, estados duráveis zerados e 40 minutos sem atividade, o risco residual é aceito. O snapshot informa zero pendências para este par, mas não substitui a verificação futura de PID/quiet window. |
| 6 | replay cross-storage | **BLOCKER REAL** | O PROD conhece um ID que o LAB não conhece; o replay pode atravessar `hold → lab`. Executar a Opção B (ou demonstrar customer virgem pela A) e reconciliar o tombstone antes da prova experimental. |

Nesta tabela de feasibility, `SIM` significa que existe uma fonte concreta e um
procedimento capaz de provar o gate quando autorizado e executado; não é
afirmação de que o estado atual está verde. As classificações acima são a
decisão operacional dos seis achados que antes apareciam como
`NAO — BLOCKER DE OBSERVABILIDADE`. A ausência de acesso nesta tarefa é
registrada como “não observado nesta tarefa” quando há uma fonte concreta
futura; não é convertida automaticamente em blocker.

| GATE | FONTE DA PROVA | QUERY OU LOG | CLASSIFICAÇÃO REVISADA | LACUNA |
|---|---|---|---|---|
| 1. Freeze, SHA real, ingresso WABA→ERP e router OFF antes do hold | checkout implantado do ERP + `/proc` env allowlistado + callback WABA/Nginx/access log sanitizado | SHA do processo, modo efetivo, callback no endpoint ERP, registro de autorização | SIM | Estado real e ingresso não observados nesta tarefa; `b9d9793...` local não prova deploy/OFF. Sem prova de ingress, hold não fecha entrada e a drenagem não começa. |
| 2. `receps-ia` PROD saudável e PID estável | `/health`, PM2 e `/proc` | GET health + PID/starttime antes/depois | SIM | PIDs reais não observados nesta tarefa. |
| 3. LAB loopback/schema dedicado | `/health` LAB + `ana_lab_schema_metadata` + fingerprint técnico | health filtrado, marker e contagens de bootstrap | SIM | Processo/storage reais não observados nesta tarefa. |
| 4. Viti `BotConfig` role/provider/model/ativo | `bot_configs` + `tenants` no schema ERP | E1 read-only | SIM | Estado DB real não observado nesta tarefa. |
| 5. Inbound outbox drenado/quarentena tratada | `inbound_event_outbox` raw DDL | A1 e delta A10 | SIM | `content_pending` só conta pending não entregue/não terminal; terminal sem disposição continua bloqueio operacional. |
| 6. Outbox v2 local sem transientes/inconsistência | `ana_v2_outbound_outbox` raw DDL + `commit_payload_json` | A2 e A10 | SIM | A leitura local prova lifecycle local, não ausência de entrega tardia do provider. |
| 7. Nenhum provider pode entregar um `transport_unknown` depois | sem leitura negativa autoritativa no provider; código só persiste `transport_unknown` | A2, logs sanitizados e status local | **BLOCKER CONDICIONAL (#1)** | A negativa teórica não bloqueia; ocorrência concreta no Viti bloqueia. GO exige zero de `transport_unknown`, `transport_started` e `accepted_uncommitted`, com evidência externa suficiente ou troca do customer se houver ocorrência. |
| 8. Nenhum successor incompleto | `ana_v2_successor_batches` | A4 | SIM | O estado atual não foi observado nesta tarefa. |
| 9. Nenhum silent escalation hold residual | `ana_v2_silent_escalation_holds` | A5 | SIM | O estado atual não foi observado nesta tarefa. |
| 10. Pause/ownership ERP conhecido pelo LAB | `ConversationPause`, `AnaTechnicalMaintenance`, E2/E3 | E2/E3 e leitura do pause-state autorizada | SIM | Não há mecanismo de transportar estado vivo para o LAB vazio; qualquer residual precisa ser zero ou nova fonte. |
| 11. AnaQuestion/tentativas/stamps sem trabalho vivo | `ana_questions`, `ana_question_delivery_attempts`, `ana_outbound_echo_stamps` | E4, E4b, E5 | SIM | Estado real não observado nesta tarefa. |
| 12. Obrigações locais de Perguntas zeradas | `sent_question_replies` e campos callback/human history | A6 | SIM | Estado real não observado nesta tarefa. |
| 13. Status Meta inventory sem business write | `ana_v2_provider_status_events`, `whatsappStatusHandler` | A7, logs/status; callbacks LAB bloqueados | SIM | A7 agora captura pre-link por hash sem duplicar; pendentes sem vínculo continuam diagnóstico que precisa qualificação. |
| 14. Plan/delivery receipts completos e escopáveis | `ana_v2_turn_receipts` não tem `conversation_key`; outbox/successor só cobrem parte | A8/A8b, `planReceiptId`/contagens | **RISCO ACEITÁVEL (P2) (#2)** | Plan-only/silent sem outbox não pode ser atribuído ao Viti; permanece risco P2 e inventário, sem bloquear este canário quando A8 escopável e as cercas passarem. |
| 15. `T_LAST_PROD_ACTIVITY` e delta pós-hold | timestamps técnicos nos dois bancos | A9/A10 escopados e E6/E7 | SIM | A10b global sem vínculo é só diagnóstico e não reinicia sozinho Viti; `audit_logs` é upper bound conservador. |
| 16. Duas leituras zero ≥60 s e PID inalterado | DB read-only, digest técnico e `/proc` | formulário da seção 5 | SIM | Só executável após resolver o #6 e avaliar os blockers condicionais; estado atual não observado. |
| 17. Provar zero de qualquer business write no inbound experimental deliberado | deltas ERP conhecidos + logs de router/Receps-IA/LAB | E7, contagens de appointment/question/pause/inbound e logs | **ACEITÁVEL COM CERCA (#3)** | `audit_logs_tenant_wide` segue diagnóstico conservador sem correlação universal; a cerca do evento deliberado e os deltas conhecidos são suficientes para a prova operacional deste canário, sem alegar zero em todos os sistemas. |
| 18. Provar causalidade e roteamento exato por evento | router tem log/Sentry sanitizado, sem ledger durável/correlation ID por evento | logs sanitizados, PID, `T_LAB`, `T_CANARY_SEND` e `messageIdHash` | **ACEITÁVEL NESTE CANÁRIO (#4)** | `cutoverAt` sozinho não prova causalidade; a correlação sanitizada do evento deliberado, PID/starttime, storage LAB e resposta permitida é a cerca mínima deste canário. |
| 19. Provar que não há turn/model/tool em voo nem deadline excedido | `runReceptionistModelLoop`/buffer e logs; não há registry durável conversation-scoped nem deadline total | A1/A2 + logs de início/fim + regra de conteúdo pendente | **BLOCKER CONDICIONAL (#5)** | Registry ausente não bloqueia sozinho. Pending de conteúdo/transcrição/mídia ou caminho sem teto bloqueia; depois de excluir esses caminhos, PID estável, estados duráveis zerados e 40 minutos sem atividade aceitam o risco residual. |
| 20. Garantir que o inbound experimental não é replay antigo do hold | Meta retry queue ou fence durável por timestamp/id hash | Opção A, ou interseção PROD + tombstone LAB; logs de 503/ingress e storage LAB | **BLOCKER REAL (#6)** | `processed_messages` PROD não deduplica no LAB. Para este par há um ID no PROD ausente no LAB; a Opção B deve semear a linha e validar a contagem antes de `T_LAB`. |

**Contagem da auditoria:** **20 gates no total; 14 `SIM` por fonte/procedimento
e seis achados reclassificados**: um **BLOCKER REAL** (#6), dois
**BLOCKERS CONDICIONAIS** (#1 e #5), um **RISCO ACEITÁVEL (P2)** (#2), uma
condição **ACEITÁVEL COM CERCA** (#3) e um achado **ACEITÁVEL NESTE CANÁRIO**
(#4). Nesta evidência, somente #6 tem ocorrência concreta; #1 e #5 estão
limpos apenas para este par conforme os dados fornecidos e ainda exigem seus
gates futuros. Não declarar `VITI_PROD_QUIESCENT=true` nem GO nesta tarefa.

### Blockers mínimos e decisão de tratamento

- **#1 — `transport_unknown` (BLOCKER CONDICIONAL):** a impossibilidade
  teórica de provar uma negativa não bloqueia. Uma ocorrência concreta para o
  Viti bloqueia; não re-postar, não fazer fallback e não “esperar envelhecer”.
  Resolver por evidência externa suficiente ou trocar o customer. GO exige
  `transport_unknown = 0`, `transport_started = 0` e
  `accepted_uncommitted = 0`. O snapshot fornecido não tem ocorrência concreta
  para este par, mas isso não libera outros pares.
- **#2 — receipts sem `conversation_key` (RISCO ACEITÁVEL P2):**
  `ana_v2_turn_receipts` não tem `conversation_key`; outbox/successor escopam
  somente parte. Plan-only/silent não escopável permanece risco e inventário,
  sem atribuição ao Viti e sem bloquear este canário quando A8 e as cercas
  passarem.
- **#3 — zero business write universal (ACEITÁVEL COM CERCA):** deltas ERP
  conhecidos não equivalem a prova universal de todos os efeitos. Para a
  entrada deliberada, usar a cerca do router, storage LAB dedicado, deltas
  E7/contagens e correlação sanitizada; não vender isso como zero universal.
- **#4 — router sem ledger durável (ACEITÁVEL NESTE CANÁRIO):** logs/Sentry
  sanitizados não formam ledger universal. Para uma única entrada controlada,
  correlacionar decisão do router, `T_LAB`, `T_CANARY_SEND`, PID/starttime,
  `messageIdHash`, storage LAB e resposta permitida. Ausência dessa correlação
  mínima interrompe a prova, mas a ausência do ledger, sozinha, não é blocker.
- **#5 — in-flight/deadline sem registry (BLOCKER CONDICIONAL):** não existe
  registry durável de turn/model/tool nem deadline total; isso não bloqueia
  sozinho. Qualquer `content_status = 'pending'`, transcrição/mídia pendente
  ou caminho sem teto observado bloqueia. Excluir todos os caminhos ilimitados,
  confirmar PID estável, estados duráveis zerados e 40 minutos sem atividade
  permite aceitar o risco residual. O snapshot fornecido informa zero
  pendências para este par, mas não executa esses gates.
- **#6 — replay cross-storage (BLOCKER REAL):** 503 pode deixar `messages[]`
  na fila Meta; o replay do mesmo cliente passa no LAB e o dedup PROD não
  atravessa storage. A Opção A (customer virgem) é preferida para um número
  futuro; para o par atual, a Opção B deve reconciliar a interseção PROD e
  semear o tombstone no LAB antes da entrada experimental. Esperar não basta.

## Resumo de viabilidade

- **Piso recomendado:** 40 minutos de quiet window desde
  `max(T_HOLD, T_LAST_PROD_ACTIVITY)`, com duas leituras ≥60 s e gates de DB,
  logs e PID. É piso de planejamento, não teto nem prova universal.
- **Números confirmados:** debounce 12 s; max wait 30 s; POST WhatsApp 20 s;
  typing até 10 s; pause-state fresco até 10 s; model receptionist 30 s;
  4 tentativas por round com 1+2+4 s; 8 rounds default; regeneration separada
  de uma chamada sem retry; áudio de transcrição até 40m07s no cálculo do SDK,
  download de mídia sem timeout finito.
- **Conta base Viti:** `8 × (4 × 30 + 7) + 30 + 20 = 1.066 s = 17m46s`,
  antes de tools, retries de protocolo, regeneração, typing e rechecks. A conta
  patient de Anthropic é contrafactual: 4.235 s por round e 33.930 s em oito
  rounds, `9h25m30s`; retries internos tornam o envelope ainda maior. Se o
  role divergir, abortar.
- **Auditoria/classificação:** 20 gates; 14 têm fonte/procedimento (`SIM`) e
  os seis achados foram reclassificados: #1 e #5 são blockers condicionais,
  #2 é risco aceitável P2, #3 é aceitável com cerca, #4 é aceitável neste
  canário e #6 é o único blocker real nesta evidência.
- **Delta pós-hold:** o total que reinicia a janela é somente
  `TOTAL_VITI_SCOPED_ACTIVITY_AFTER_HOLD`/E7. A10b mantém status/receipts
  globais sem vínculo como diagnóstico de escopo; atividade de Jackeline/Rose
  não é somada nem reinicia sozinha a janela Viti. `audit_logs_tenant_wide`
  continua um upper bound conservador do ERP, não causalidade do canário.
- **Tratamento:** #1 exige zero de `transport_unknown`,
  `transport_started` e `accepted_uncommitted` no GO, mas a ausência de uma
  negativa teórica não bloqueia; #5 só bloqueia com pending ou caminho sem
  teto observado. #2 continua P2, #3 exige cerca de evento, e #4 exige
  correlação sanitizada mínima. #6 exige a Opção A ou, para o par atual, a
  Opção B com uma linha de tombstone em `processed_messages` do LAB.
- **Opções do #6:** A é customer virgem, preferida quando existir número novo;
  as queries acima cobrem as convenções `conversation_key`/`conversationKey`
  e os campos ERP `phoneNumberId`/`customerPhone`. B é a interseção
  `processed_messages ∩ inbound_event_outbox` no PROD, com
  `received_at < T_HOLD`, reconciliada por `candidate_count`, estado
  estabilizado e digest entre as leituras, e semeada no LAB. Linhas sem par
  ficam fora; estado instável ou mudança do conjunto aborta. O customer atual
  falha A porque cinco superfícies têm uma linha; o conjunto B esperado é uma
  linha.
- **Definição da prova:** a entrada experimental é o inbound deliberado pelo
  customer controlado depois de `T_LAB`, identificado por `T_CANARY_SEND` e
  `messageIdHash`, e observado em `ERP router → LAB → storage LAB → resposta
  permitida`. Todo replay anterior é TRÁFEGO DE TRANSIÇÃO; “primeiro inbound
  do LAB” não é critério.
- **Indeterminações atuais, por cerca desta tarefa:** deploy/OFF real do router,
  PIDs/starttimes reais, saúde/marker do LAB, ingresso WABA→ERP sem rota
  paralela, compatibilidade real do segredo HMAC, filas/retries Meta e
  qualquer obrigação Viti além do snapshot fornecido não foram determinados.
  O snapshot read-only fornecido informa os counts da seção de identidade, mas
  não prova esses gates operacionais nem uma negativa do provider. O código
  local e este documento não afirmam esses estados.
- **Decisão atual:** somente #6 é blocker real no snapshot fornecido, mas ele
  continua aberto até a semeadura/reconciliação. Não declarar
  `VITI_PROD_QUIESCENT=true`, não ativar LAB e não chamar o replay de canário
  nesta tarefa. A decisão futura só pode usar o formulário da seção 5 depois
  de executar as leituras autorizadas, concluir o seed e manter a distinção
  entre tráfego de transição e a entrada experimental deliberada.
