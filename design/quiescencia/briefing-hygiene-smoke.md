Requested Codex effort: xhigh

# DUAS TAREFAS SEPARADAS: identifier hygiene + smoke de dedupe cross-storage

Worktree: /Users/niexfs/dev/wt-ana-lab   base: a83ae7b (lab/ana-lab-1-p1)
Crie branch de revisao a partir de a83ae7b. DOIS COMMITS SEPARADOS, nesta ordem.

## CADEIA
Voce ORQUESTRA; escrita no subagente NATIVO gpt-5.6-luna, esforco max.
codex-em-codex morre no sandbox. Um escritor por vez. Voce revisa e roda gates.

## CERCAS
NAO deployar, NAO reiniciar processo, NAO tocar VPS/env/nginx/Meta/Neon/WhatsApp.
NAO EXECUTAR o smoke novo contra storage real — ele pode rodar em memoria, mas
nada de banco LAB ou PROD. O commit fica comigo.

## ORDEM IMPORTA
O smoke exige, no fim, que o log traga HASH e nao o wamid cru. Isso so existe
depois do patch de hygiene. Entao: commit 1 = hygiene, commit 2 = smoke.

===========================================================================
# COMMIT 1 — IDENTIFIER HYGIENE

## O problema, ja verificado por mim

  messageHandler.ts:1582
    console.info(`Inbound ${message.id} repetida — intake atomico em noop.`)

Isso interpola o WAMID CRU. Conferi em def0832: JA ESTA EM PRODUCAO, nao foi
introduzido por nos. Qualquer inbound duplicado hoje ja escreve o wamid no log.

O revisor encontrou uma SEGUNDA ocorrencia no mesmo arquivo: no erro de entrega
imediata do inbound, o codigo poe message.id cru numa TAG do Sentry
(messageId: message.id). Confirme e corrija tambem.

Deixou de ser latente: o procedimento de dedupe do cutover fara um replay cair
DELIBERADAMENTE nesse ramo. Nos mesmos provocariamos a exposicao.

## O que fazer

Varredura DIRIGIDA por Meta message IDs crus em SINKS DE TELEMETRIA:
console.*, tags e context do Sentry, e receipts serializados.

Substituir SOMENTE nesses sinks por hash tecnico, algo como:
  messageIdHash: technicalHash(message.id).slice(0, 16)
e no log:
  Inbound repetida — intake atomico em noop | messageIdHash=...

NAO ALTERAR message.id onde ele e AUTORIDADE: chave de banco, dedupe, HMAC,
requests, correlacao interna. Ele continua cru onde precisa ser cru; so nao sai
em log nem em telemetria.

Se ja existir helper de hash tecnico no repo, REUSE. Nao crie um segundo.

Acrescente um gate que FALHA se um ID sintetico cru aparecer na telemetria
capturada.

NAO misturar com o P2 de observabilidade do loadServices. Risco e regressao
diferentes; janela pode ser a mesma, commits nao.

===========================================================================
# COMMIT 2 — SMOKE scripts/smoke-ana-lab-cross-storage-dedupe.ts

Ja existe um arquivo com esse nome nesta worktree, escrito e nao executado.
REVISE-O contra as quatro exigencias abaixo e corrija o que faltar.

## Exigencia 1 — a mais importante
NAO aceite injetar persistInbound => {fresh:false} e declarar vitoria. Isso
testa a CONSEQUENCIA, nao a PROPRIEDADE do tombstone. O fake/store precisa
modelar a autoridade real:

  seed do tombstone em processed_messages
    -> persistInbound tenta o INSERT
    -> CONFLITO na PK message_id
    -> fresh:false

Se o store atual nao faz isso, refaca.

## Exigencia 2 — contadores explicitos em ZERO para o ID tombstonado
history · conversation_seq · inbound_event_outbox · deliverInbound ·
buffer/debounce · download/transcribe · model · tools · WhatsApp outbound ·
ERP write.

O codigo real autoriza essa expectativa: conferi que o return ocorre
imediatamente apos o fresh:false, em messageHandler.ts:1583.

## Exigencia 3 — a contrapartida
ID NAO semeado entra exatamente UMA vez; retransmissao do mesmo ID nao duplica
efeito nenhum.

## Exigencia 4 — transformar o achado de privacidade em REGRESSAO
NAO silencie o log do duplicate. Capture console.info e exija:
  o wamid sintetico CRU nao aparece
  o hash tecnico aparece
Assim o teste deixa de esconder a falha e passa a impedir que ela volte.

## Contexto que o smoke deve refletir, mas nao testar
A selecao do conjunto acontece depois da quiescencia, o mais perto possivel de
T_SEED, e e reconferida imediatamente antes de T_LAB. PROD e LAB sao bancos
diferentes: NAO existe transacao atomica cross-storage. A seguranca vem de
hold + quiescencia + conjunto estavel. Se o count da intersecao mudar entre a
leitura final e a seed, ABORTA. Deixe isso documentado no cabecalho do smoke.

===========================================================================
# GATES
Rode, com exit REAL: o smoke novo (em memoria, sem banco) · build ·
os smokes do LAB que ja existiam (ana-lab-runtime, closed-catalog) para provar
que o patch de hygiene nao regrediu nada.

# RETORNO
status · os DOIS diffs separados · quantas ocorrencias de ID cru voce achou na
varredura e onde · confirmacao de que nenhum ID de autoridade foi tocado ·
exit real de cada gate · o que nao conseguiu determinar.
Sem raciocinio interno, sem credencial, sem PII, sem wamid cru no relatorio.
