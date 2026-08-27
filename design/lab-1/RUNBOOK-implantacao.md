# LAB-1 — runbook de implantacao

Codigo aprovado em b2a2529 (def0832..b2a2529: 28 arquivos, 4.261 insercoes, 3 commits lineares).
NADA aqui foi executado. Cada passo exige autorizacao explicita do Victor.
Autorizacao de um passo NAO vale para o seguinte.

## ROLLBACK — definido ANTES de pedir autorizacao

Ordem importa: restaurar o callback PRIMEIRO. Enquanto ele apontar para o LAB,
o Viti esta atendido por branch experimental.

1. Restaurar o callback da WABA Studio Viti para o endpoint produtivo anterior
   (valor registrado no passo 11 antes de qualquer mudanca) e verificar o
   GET/challenge.
2. Confirmar que novos inbounds voltaram ao receps-ia (:3001).
3. Parar e remover SOMENTE receps-ia-lab. Nao reiniciar, recarregar nem
   rebuildar receps-ia.
4. Remover somente a location /webhook-clinica-lab.
5. nginx -t; so entao reload.
6. Confirmar que nao existe listener em :3002 e que :3001 segue saudavel.
7. PRESERVAR worktree LAB, SHA, logs sanitizados, storage LAB e receipts para
   investigacao. Nao apagar banco nem artefato automaticamente.
8. Nao rodar pm2 save ate confirmar que a definicao produtiva ficou intacta.
9. Se o callback nao puder ser restaurado: tratar como INCIDENTE e nao continuar
   teste nenhum.

## FASE A — storage (sem tocar em processo)

1. Provisionar database Neon dedicado, VAZIO, com role/credencial PROPRIOS.
   Nao clonar, nao usar branch de producao. Confirmar que nenhum processo
   produtivo tem essa conexao. Calcular o fingerprint sem imprimir a URL.

2. Bootstrap do schema: npm run lab:bootstrap-schema, uma unica vez, a partir do
   commit revisado. Exigir exit 0, marker versao 1, zero rows previas.
   SE FALHAR NO MEIO: nao continuar, nao reaproveitar o database parcialmente
   inicializado, descartar e recriar vazio, repetir o bootstrap. O marker e
   escrito por ultimo, entao falha no meio deixa tabelas sem marker.

3. Gate contra o PostgreSQL LAB REAL, antes de PM2/nginx/Meta. Dados
   exclusivamente sinteticos, cleanup zero. Provar:
   validateLabSchema · marker/fingerprint · reverse fence de producao contra
   esse storage · transport_started stale -> transport_unknown ·
   accepted_uncommitted -> reconciled sem re-POST · ProviderStatusV2
   pending -> applied · zero business write externo.

## FASE B — processo (sem trafego externo)

4. Criar /root/Receps-IA-lab como checkout independente no commit candidato.
   NUNCA fazer checkout/pull/build dentro de /root/Receps-IA.

5. Build no cwd LAB. Conferir exit REAL e dist/ emitido. Nao tocar no build
   produtivo.

6. Criar PM2 receps-ia-lab: PORT=3002, HOST=127.0.0.1, NODE_ENV=production,
   ANA_RUNTIME_MODE=lab, LAB_WRITE_POLICY=disabled, fingerprint do storage,
   allowlists so do Viti, customer allowlist SO com o telefone de teste,
   logs proprios. Nao reiniciar receps-ia.

7. Prova por localhost 127.0.0.1:3002/health, exigindo:
   runtimeMode=lab · writePolicy=disabled · globalBackgroundJobs=false ·
   localRecoveryJobs { conversationalV2State=true, conversationalV2Successor=true,
   providerStatusV2=true }.
   Confirmar listener SOMENTE em loopback e receps-ia intacto, sem restart.

## FASE C — rede (ainda sem Meta)

8. nginx: criar SOMENTE a location exata /webhook-clinica-lab -> 127.0.0.1:3002/webhook.
   Nao publicar /health, /admin, /internal, purge, reprocess nem a raiz do Express.
   Sem subdominio.

9. nginx -t. Erro aborta antes do reload.

10. Reload, so apos nginx -t verde e autorizacao. Verificar que a location
    produtiva continua em :3001.

## FASE D — Meta (o ponto de nao-retorno)

11. Preflight do Viti PRODUTIVO: conferir que nao ha transport_started,
    accepted_uncommitted, successor pendente nem silent hold VIVOS. Estado vivo
    na hora do corte vira lixo irreconciliavel entre os dois bancos.

12. Graph API READ-ONLY listando os numeros da WABA do Viti — SOMENTE com
    autorizacao especifica do Victor. Fecha o residual que a auditoria de banco
    nao fecha. Sem autorizacao: registrar o risco e exigir aceite explicito
    antes do override.

13. Registrar callback e verify token ATUAIS (para o rollback) e o cutoverAt.
    Alterar SOMENTE a WABA do Studio Viti. Nao tocar em Jackeline, Rose, Renata.

14. Verificacao GET do webhook no novo path: challenge 200. Se qualquer cerca
    ou health divergir, parar aqui.

## FASE E — prova

15. Primeiro inbound real, controlado, do telefone de teste. NAO usar pedido de
    agendamento/cancelamento como primeiro caso. Provar: roteou para o LAB, sem
    evento correspondente no processo produtivo; provider real; reads reais do
    ERP; state/receipts no banco LAB; outbound so para o customer permitido.

16. Prova de zero escrita, por leitura comparada antes/depois:
    0 bookAppointment ERP · 0 cancelAppointment ERP · 0 escalation ERP ·
    0 pause/resume ERP · 0 inbound projection ERP · 0 outro tenant ou customer
    alcancado. Confirmar receipts blocked/writeCommitted=false e zero row LAB no
    storage produtivo.
    Avaliar receipts e statuses SOMENTE a partir do cutoverAt: status callback
    antigo do Viti pode chegar depois do corte e aparecer como evento sem outbox
    correspondente, poluindo a metrica sem ser defeito.

## Debito separado, NAO corrigir aqui

boundary: def0832 RED == LAB RED, mesma assercao UNVERIFIED_AVAILABILITY.
Auditoria propria, fora do LAB-1.
