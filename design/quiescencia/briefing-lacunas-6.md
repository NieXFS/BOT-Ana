Requested Codex effort: xhigh

# FECHAR AS TRES LACUNAS DO #6. Codigo e documento, SEM tocar storage real.

Worktree: /Users/niexfs/dev/wt-ana-lab
Branch atual: review/ana-lab-identifier-hygiene (HEAD adba853)
Runbook: design/quiescencia/RUNBOOK-STUDIO-VITI.md

## CADEIA
Voce ORQUESTRA; escrita no subagente NATIVO gpt-5.6-luna, esforco max.
codex-em-codex morre no sandbox. Um escritor por vez. Voce revisa e roda gates.
O commit fica comigo — o git falha no seu sandbox por permissao de gitdir.

## CERCAS
NAO tocar storage LAB nem PROD. NAO deployar, reiniciar, mexer em env, VPS,
nginx, Meta, WhatsApp. NAO semear nada. Smoke roda em MEMORIA.

## O DIAGNOSTICO DO REVISOR, que eu aceito

O #6 esta fechado pela METADE. Hoje temos:

  Selecao correta do tombstone   DOCUMENTADA
  Seed fail-closed               DOCUMENTADO
  Comportamento apos tombstone   TESTADO      <- so esta

O smoke atual COMECA com o tombstone ja colocado. Ele prova a reacao do runtime,
nao que o tombstone escolhido era o correto. E a mesma classe de path fidelity
que perseguimos a onda inteira, agora no nosso proprio trabalho.

## LACUNA 1 — gate da SELECAO, nao so da consequencia

Escreva um gate que prove a matriz da intersecao. Prefira uma funcao PURA
deriveSeedCandidateSet() restrita ao script, ou SQL exato contra tabelas
temporarias em PostgreSQL DEV numa transacao que termina em ROLLBACK. Se usar a
funcao pura, ela precisa espelhar fielmente o SQL do runbook.

Casos obrigatorios:

  processed + outbox estavel pre-hold          INCLUI
  processed sem outbox (ex.: echo humano)      EXCLUI
  outbox sem processed                         EXCLUI
  received_at = T_HOLD                         EXCLUI  (fronteira)
  received_at > T_HOLD                         EXCLUI
  recebido pre-hold, PROCESSADO pos-hold       INCLUI  <- o sutil; processed_at NAO e corte
  content_status = pending                     ABORTA
  delivered_at IS NULL                         ABORTA
  terminal_at IS NOT NULL                      ABORTA
  conjunto muda entre leitura final e seed     ABORTA

O caso "recebido pre-hold, processado pos-hold" e o que mais me importa: e o
unico que distingue um corte por received_at de um corte por processed_at, e
errar nele descartaria um tombstone legitimo.

## LACUNA 2 — o preflight promete mais do que verifica

O runbook diz "falha fechado se houver qualquer linha previa para a conversa",
mas o SQL so olha processed_messages. Uma limpeza parcial poderia deixar
history, sequence, inbound outbox, pending, state, outbox V2 ou hold orfaos e
passar batido.

Amplie o preflight para exigir ZERO da conversa canaria em TODAS as superficies
operacionais do LAB. Marker e as tabelas em si permanecem, obviamente; o que
tem de estar vazio e o ESTADO da conversa.

## LACUNA 3 — transporte seguro do ID cru

A seed precisa inevitavelmente do message_id cru. O runbook proibe imprimi-lo,
mas nao define COMO ele sai do PROD e entra no LAB sem aparecer em argumento de
processo, shell history, set -x, log de terminal ou arquivo com permissao aberta.

Documente procedimento explicito: arquivo temporario 600 ou pipe protegido,
shell tracing desligado, nada visivel em ps, cleanup imediato apos a transacao,
e relatorio contendo apenas contagem e digest.

O revisor nomeou bem o risco: seria tragicomico remover o WAMID do log e depois
coloca-lo no argv do psql.

## HARDENING recomendado, incluir no runbook

Durante T_SEED, parar SOMENTE o receps-ia-lab, sem tocar PROD:
  hold ativo -> LAB parado -> confirmar storage canario vazio -> seed ->
  verificar exatamente um tombstone -> iniciar LAB -> health/fingerprint/
  recoveries verdes -> revalidar tombstone -> so entao T_LAB
Elimina corrida com request loopback acidental, e e mais simples e auditavel que
uma trava por advisory lock.

## DOIS LIMITES QUE O RUNBOOK PRECISA DECLARAR

1. A intersecao fecha replay de messages[] de cliente ja processado no PROD. NAO
   e ledger universal da WABA. Echo humano usa processed_messages mas nao
   inbound_event_outbox, entao fica DELIBERADAMENTE fora do seed. Nao vender a
   solucao como dedupe universal de smb_message_echoes ou statuses[].

2. O smoke de ID novo usa deliverInbound injetado e incrementa um contador
   chamado erpWrite. Isso prova que o ID novo atravessa o downstream UMA vez;
   NAO prova a write policy do LAB, que continua provada pelos gates especificos.
   Deixe isso explicito para ninguem ler aquele contador como garantia que ele
   nao da.

## GATES
Rode com exit REAL: o gate novo · smoke:ana-lab-cross-storage-dedupe ·
smoke:ana-pii-runtime · smoke:ana-lab-runtime · build.

## RETORNO
status · diff · a matriz da selecao com resultado REAL de cada caso · as
superficies do preflight ampliado · o procedimento de transporte do ID · exit
real de cada gate · o que nao conseguiu determinar.
Sem raciocinio interno, sem credencial, sem PII, sem wamid cru.
