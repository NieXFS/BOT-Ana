Requested Codex effort: xhigh

# GATE NO POSTGRESQL LAB REAL — passo 2 do runbook

Worktree: /Users/niexfs/dev/wt-ana-lab   branch: lab/ana-lab-1   HEAD: b2a2529

## CERCAS — inegociaveis

- NAO acesse VPS, Meta, Graph API, nginx, PM2, DNS, firewall, WhatsApp.
- NAO conecte NEM CONSULTE o projeto Neon de producao. Existe UMA unica
  DATABASE_URL disponivel no ambiente e ela ja aponta para o storage LAB.
- NUNCA imprima DATABASE_URL, senha, token ou PII — nem em log, nem em erro,
  nem no relatorio, nem em arquivo dentro do repo.
- NAO rode o bootstrap de novo. Ele ja rodou, exit 0, schema versao 1.
- NAO altere codigo de produto para o gate passar. Se o gate revelar defeito,
  REPORTE o defeito; nao conserte contornando.
- Se algo exigir sair dessas cercas, PARE e reporte bloqueio.

## ESTADO JA PROVADO (nao precisa refazer)

Storage LAB real, eu-central-1, Postgres 17.11, database receps_ia_lab,
role receps_ia_lab_runtime. Marker ana_lab_schema_metadata presente,
schema_version=1, fingerprint conferido. 17/17 tabelas obrigatorias presentes.
assertProductionStorageIsNotLab barra producao neste storage; validateLabSchema
aprova; fingerprint errado e rejeitado. Tudo isso ja foi provado contra o PG
real por mim.

## O QUE VOCE VAI CONSTRUIR

Um gate executavel que roda contra o PostgreSQL LAB REAL e prova, com dados
EXCLUSIVAMENTE SINTETICOS, as tres recuperacoes locais que o LAB-1 religou:

1. transport_started stale  -> transport_unknown
2. accepted_uncommitted     -> reconciliado, SEM re-POST e sem retransporte
3. ProviderStatusV2 pending -> applied

E prova simultaneamente:
- zero HTTP para o ERP
- zero transporte Meta/WhatsApp
- zero business write externo

Ate agora essas tres so foram provadas com store em memoria. O valor deste
passo e exatamente sair do sintetico em memoria e exercitar o PG de verdade.

## REGRAS DE DADO SINTETICO E LIMPEZA

- Todo id/chave criado pelo gate usa prefixo literal reconhecivel, por exemplo
  `labgate-`. Nada de valor que possa colidir com dado real.
- Ao terminar, o banco NAO pode ficar com row operacional sintetica residual.
  Prefira transacao com rollback onde a superficie permitir; onde nao permitir
  (o sweep precisa enxergar a row commitada), faca cleanup EXPLICITO por id
  sintetico conhecido.
- O marker e o schema PERMANECEM. Nao os toque.
- Ao final, o proprio gate faz auditoria read-only de contagem das tabelas
  operacionais e falha se sobrar qualquer estado vivo: transport_started,
  accepted_uncommitted, successor queued/processing, silent hold
  pending/confirmed, provider status pending, ou qualquer row com o prefixo
  sintetico.

## COMO PROVAR "ZERO CHAMADA EXTERNA"

Nao aceite ausencia de erro como prova. Injete/observe as fronteiras: o gate
deve contar chamadas e afirmar ZERO explicitamente para ERP HTTP, transporte
Meta e business write. Se a superficie nao permitir injecao, diga isso em vez
de fingir que provou.

## ENTREGA

Script proprio, por exemplo scripts/gate-ana-lab-pg-real.ts, com alias npm
dedicado. Ele deve ser reexecutavel: rodar duas vezes seguidas tem de dar o
mesmo resultado, sem residuo acumulado.

Rode o gate contra o PG LAB real e reporte o exit REAL.

Rode tambem, e reporte exit real:
  npm run build
  npm run smoke:ana-lab-runtime

## FORMATO DE RETORNO

status · arquivos criados/alterados · o que cada uma das 3 provas exercitou e o
resultado REAL · como voce provou os tres zeros (e onde nao deu para provar) ·
exit real de cada gate · prova de residuo zero (contagens antes/depois) ·
riscos e pendencias.

Sem raciocinio interno, sem log cru, sem credencial. O commit fica comigo: nas
rodadas anteriores o git falhou no seu sandbox por permissao de gitdir. Deixe o
diff pronto e nao tente commitar.
