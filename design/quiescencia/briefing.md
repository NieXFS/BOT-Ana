Requested Codex effort: xhigh

# RUNBOOK DE QUIESCENCIA DO STUDIO VITI — SOMENTE LEITURA E PLANEJAMENTO

Worktree: /Users/niexfs/dev/wt-ana-lab (branch lab/ana-lab-1-p1, HEAD a83ae7b)
Repo ERP para consulta de schema: /Users/niexfs/dev/Receps ERP

## CADEIA
Voce ORQUESTRA; a escrita vai para o subagente NATIVO gpt-5.6-luna, esforco max.
codex-em-codex morre no sandbox. Um escritor por vez. Voce revisa antes de devolver.

## CERCAS — NAO EXECUTAR NADA
NAO criar branch, NAO alterar env, NAO reiniciar processo, NAO escrever no banco,
NAO disparar webhook, NAO mandar WhatsApp, NAO deployar, NAO tocar VPS.
Isto e um DOCUMENTO. O produto e o runbook, nao a execucao.

## PRINCIPIO QUE VAI NO TOPO DO DOCUMENTO
Quiescencia NAO significa "ninguem mandou mensagem por alguns minutos".
Significa "nao ha mais efeito PROD capaz de aparecer depois do corte".

## NUMEROS QUE EU JA VERIFIQUEI NO CODIGO — use, nao redescubra
  messageHandler.ts:127  DEBOUNCE_TIME_MS = 12_000
  messageHandler.ts:128  MAX_WAIT_TIME_MS = 30_000
  anthropicRetry.ts:38   QUICK_DELAYS_MS = [1_000, 2_000, 4_000]  (quick = 4 tentativas)
  anthropicRetry.ts:44   PATIENT_MAX_ATTEMPTS = 7
  whatsappCloudService.ts:221  timeout 20_000 no POST

ATENCAO: o revisor estimou a janela sem contar o PATIENT_MAX_ATTEMPTS=7. O pior
caso e PIOR do que ele supos. Recalcule o piso com esse dado e diga o numero que
sai da conta, junto com o raciocinio. A recomendacao dele foi 25 minutos como
piso conservador; confirme, aumente ou justifique.

Confirme tambem, no codigo, o timeout do modelo e o teto de rodadas do loop v2 —
eu nao consegui fechar esses dois por grep.

## ESTRUTURA OBRIGATORIA DO RUNBOOK

1. PRECONDICOES
   freeze da main do ERP ativo · SHA do ERP implantado conhecido · router
   implantado e comprovadamente OFF · receps-ia PROD saudavel · receps-ia-lab
   saudavel em loopback :3002 · tenant/phoneNumberId/customer canario fechados ·
   relogio UTC e America/Sao_Paulo registrados.

2. SNAPSHOT PROD ANTES DO HOLD
   Para a conversa canario do Viti, escreva queries SQL READ-ONLY REAIS,
   derivadas do schema atual — nao pseudocodigo — que provem:
     inbound_event_outbox sem inbound pendente relevante
     outbox V2 sem linha em estado nao estabilizado (prepared, transport_started,
       accepted_uncommitted)
     nenhum successor V2 incompleto
     nenhum silent escalation hold pending/active
     estado de pause/ownership do Viti no ERP
     ultima atividade operacional conhecida da conversa
     obrigacoes de reconciliation que ainda possam materializar efeito
   NAO tratar accepted_by_provider com commit concluido como pendencia.
   Para CADA query: tabela · condicao · resultado esperado · o que fazer se vier
   diferente de zero.

3. ARMAR HOLD — DESCREVER, NAO EXECUTAR
   Quais envs mudam, qual processo reinicia. Contrato esperado apos o hold:
   Viti recebe 503 retryable ANTES de mutacao PROD · Jackeline e Rose seguem PROD
   normal · zero fallback Viti->PROD · zero forward Viti->LAB enquanto em hold.
   Registrar T_HOLD.

4. DRENAGEM
   O hold fecha a entrada de trabalho NOVO, mas trabalho ja encaminhado antes de
   T_HOLD pode seguir em memoria. NAO reiniciar o receps-ia PROD para "limpar".
   Piso de quiet window contado a partir de max(T_HOLD, ultima atividade PROD do
   Viti). Qualquer atividade PROD nova REINICIA a janela.

5. GATE DE QUIESCENCIA
   So declarar VITI_PROD_QUIESCENT=true com: estados transitorios zerados ·
   nenhum successor incompleto · nenhum silent hold ativo · nenhum
   pause/ownership residual que o LAB desconheca · nenhuma atividade PROD nova
   durante a janela · DUAS leituras independentes separadas por >=60s com o mesmo
   resultado · PID do receps-ia PROD inalterado durante a drenagem.
   Qualquer falha: ABORTAR CUTOVER e permanecer em hold.

6. EVENTOS META ANTIGOS
   sent/delivered/read tardios de outbounds pre-cutover VAO chegar. Documentar
   que nao podem ressuscitar estado conversacional; que cutoverAt e cerca de
   AUDITORIA, nao prova de causalidade; e que status com wamid antigo pode virar
   telemetry unmatched/pending local, mas nunca selecionar servico, criar flow
   state ou executar business write.

7. ATIVACAO LAB — SO PROCEDIMENTO
   Troca hold -> lab, restart necessario, verificacoes imediatas. Primeira prova
   real usa SOMENTE o customer allowlistado. Validar: router Viti->LAB · zero
   mutacao conversacional PROD · LAB processando no storage dedicado · nenhum
   business write · resposta real so para o telefone allowlistado.

8. ROLLBACK
   REGRA: o LAB nunca volta direto para PROD. Qualquer anomalia -> lab vira HOLD
   primeiro. So depois reavaliar LAB + PROD e decidir retorno por procedimento
   proprio de reconciliacao. Nada de fallback automatico.

9. FEASIBILITY AUDIT — a parte mais importante
   Tabela: GATE | FONTE DA PROVA | QUERY OU LOG | PROVAVEL? | LACUNA
   Se algum gate NAO puder ser provado hoje com DB, log ou estado de processo,
   marque como BLOCKER DE OBSERVABILIDADE. NAO invente inferencia para preencher.
   Descobrir "nao temos como provar X" no papel e o objetivo deste exercicio.

## RETORNO
O runbook completo, em arquivo dentro de design/quiescencia/. Mais um resumo
compacto com: os numeros recalculados da janela · quantos gates sao provaveis
hoje · quais viraram blocker de observabilidade · o que voce nao conseguiu
determinar. Sem raciocinio interno, sem credencial, sem PII.
