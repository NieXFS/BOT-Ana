Requested Codex effort: xhigh

# FECHAR O BLOCKER #6 — replay cross-storage. DESENHO, NAO EXECUCAO.

Worktree: /Users/niexfs/dev/wt-ana-lab (lab/ana-lab-1-p1, HEAD a83ae7b)
Runbook existente: design/quiescencia/RUNBOOK-STUDIO-VITI.md

## CADEIA
Voce ORQUESTRA; escrita no subagente NATIVO gpt-5.6-luna, esforco max.
codex-em-codex morre no sandbox. Um escritor por vez. Voce revisa antes de devolver.

## CERCAS
NAO executar nada. NAO escrever no banco LAB nem PROD. NAO criar branch de
produto, NAO alterar env, NAO reiniciar processo, NAO deployar, NAO tocar VPS,
Meta ou WhatsApp. O produto e DOCUMENTO + CODIGO DE SMOKE nao executado.

## EVIDENCIA REAL QUE EU JA LEVANTEI — use, nao redescubra

O customer canario escolhido pelo Victor e o telefone de teste dele. Rodei a
verificacao read-only contra producao e o resultado e:

  ana_inbound_messages        1     (2026-08-14 13:45, contentStatus=final)
  processed_messages          1
  inbound_event_outbox        1
  ana_v2_outbound_outbox      1
  ana_conversation_seq        1
  ana_conversation_history    0
  customers / appointments    0     (nao e cliente cadastrado em tenant nenhum)

  inbound pendente                0
  outbox nao estabilizada         0
  inbound com conteudo pendente   0

Ou seja: UMA interacao, de duas semanas atras, TOTALMENTE ESTABILIZADA. Nada em
voo. O blocker #1 (transport_unknown) esta limpo para este par. O #6 continua
vivo: existe UM message_id que o PROD conhece e o storage do LAB nao.

O conjunto autoritativo de IDs ja vistos tem TAMANHO UM. Isso muda a opcao B de
"mecanismo de migracao" para "uma linha".

ATENCAO ao schema: as tabelas misturam convencao. processed_messages,
inbound_event_outbox, ana_v2_outbound_outbox e ana_conversation_seq usam
conversation_key (snake_case); ana_conversation_history usa "conversationKey"
(camelCase); ana_inbound_messages usa "phoneNumberId"/"customerPhone". Errei isso
duas vezes hoje — confira coluna por coluna antes de escrever query.

## TAREFA 1 — atualizar a classificacao no runbook

O revisor reclassificou os seis achados. Atualize o documento:

  #1 transport_unknown sem negativa do provider   BLOCKER CONDICIONAL
  #2 receipts sem conversation_key                RISCO ACEITAVEL (P2)
  #3 sem prova universal de zero business write   ACEITAVEL COM CERCA
  #4 router sem ledger duravel                    ACEITAVEL NESTE CANARIO
  #5 trabalho in-memory sem registry/deadline     BLOCKER CONDICIONAL
  #6 replay cross-storage                         BLOCKER REAL

Regra do #1: a impossibilidade TEORICA de provar a negativa nao bloqueia; uma
OCORRENCIA CONCRETA de transport_unknown para o Viti bloqueia. Requisito de GO:
transport_unknown = 0, transport_started = 0, accepted_uncommitted = 0.
Nao "esperar envelhecer" um transport_unknown — ou resolver por evidencia
externa suficiente, ou trocar o customer canario.

Regra do #5: sem registry nao e blocker sozinho. MAS qualquer content_status
pending, transcricao ou midia pendente, ou qualquer caminho sem teto observado
= BLOCKER. Com todos os caminhos ilimitados excluidos, PID estavel, estados
duraveis zerados e 40 min sem atividade, o risco residual e aceito.

## TAREFA 2 — desenhar as DUAS opcoes para o #6

OPCAO A (preferida se houver numero virgem): escreva as queries que PROVAM
"customer virgem" contra o phoneNumberId do Viti — zero em todas as superficies
acima, cobrindo as duas convencoes de coluna. O Victor nao tem um terceiro
numero disponivel agora, entao documente A como caminho preferido para o futuro
e prove por que o numero atual NAO se qualifica (evidencia acima).

OPCAO B (escolhida): seed de tombstone de dedupe PROD -> LAB.
Responda com precisao:
  - QUAIS tabelas formam o conjunto autoritativo de "IDs ja vistos pelo PROD"
    ate T_HOLD. Justifique a escolha; processed_messages e o candidato obvio,
    mas verifique se inbound_event_outbox ou outra superficie precisa entrar.
  - ONDE exatamente o LAB receberia os tombstones, e em que formato, para que o
    caminho de dedupe do runtime os reconheca. Leia o codigo, nao suponha.
  - PROVE que a semeadura NAO suprime inbound criado DURANTE o hold. Esse e o
    ponto critico: um inbound que chegou depois de T_HOLD e nunca entrou no PROD
    nao pode estar no conjunto semeado. Mostre por que o corte temporal garante isso.
  - O que acontece se o mesmo message_id chegar DUAS vezes no LAB.

Se o schema atual de processed_messages nao permitir semeadura segura, proponha
uma tabela/fence especifica do cutover — LAB-ONLY, jamais um ledger novo no ERP.

## TAREFA 3 — smoke de path fidelity, escrito mas NAO executado

  ID semeado do PROD    -> LAB deduplica, zero model, zero outbound, zero state
  ID nao visto no PROD  -> LAB processa normalmente

Use seams determinísticos, store em memoria, sem rede/provider/banco real.
Deixe o arquivo pronto; nao rode contra o storage LAB real.

## TAREFA 4 — corrigir a definicao da prova final

O runbook (e o nosso vocabulario) precisa parar de chamar "primeiro inbound do
LAB" de prova do canario. Isso e fragil por definicao quando existe retry da
Meta. A prova passa a ser:

  "inbound canario enviado DELIBERADAMENTE pelo customer controlado depois de
   T_LAB, identificado e observado atravessando ERP router -> LAB -> storage LAB
   -> resposta permitida"

Qualquer replay anterior e TRAFEGO DE TRANSICAO e nunca deve ser confundido com
a entrada experimental. Deixe isso explicito no documento, com o criterio de
identificacao do canario.

## RETORNO
status · o que mudou no runbook · a resposta precisa das quatro perguntas da
opcao B · o caminho do arquivo de smoke criado · o que voce nao conseguiu
determinar. Sem raciocinio interno, sem credencial, sem PII, sem telefone cru.
