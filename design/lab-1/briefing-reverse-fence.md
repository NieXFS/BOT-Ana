Requested Codex effort: xhigh

# CERCAS OPERACIONAIS (do coordenador, valem sobre tudo)

Worktree: /Users/niexfs/dev/wt-ana-lab   branch: lab/ana-lab-1   HEAD: 5dbadaa
NAO acesse a VPS (sem ssh/scp), Meta, Graph API, Neon, nginx, PM2, DNS, firewall.
NAO execute o bootstrap de schema. NAO envie WhatsApp real.
Trabalhe SOMENTE nesta worktree. Segredo/token/DATABASE_URL/PII nunca em codigo,
log, teste ou relatorio. Se algo exigir isso para avancar, PARE e reporte.

Os tres bloqueantes anteriores foram APROVADOS na revisao: customer fence,
silent escalation sem hold residual, e recovery V2 local. NAO os reabra.

O prompt abaixo veio do revisor e vai INTEGRAL.

===============================================================================

Revisão do 5dbadaa:

Os três bloqueantes anteriores estão APROVADOS:
- customer fence;
- silent escalation sem hold residual;
- V2 state/successor recovery local.

Ainda NÃO execute infraestrutura.

Feche um bloqueante final de storage e um P1 de recovery.

1. BLOQUEANTE — REVERSE STORAGE FENCE

Hoje:
ANA_RUNTIME_MODE ausente -> production.

Isso é obrigatório para compatibilidade, mas deixa um acidente perigoso:

processo receps-ia-lab
+ DATABASE_URL do LAB
+ ANA_RUNTIME_MODE ausente por erro de PM2/env
→ sobe como production
→ writes externos liberados
→ customer fence desligada
→ workers production ligados.

O banco LAB já possui o marker reservado:
`ana_lab_schema_metadata`.

Transforme a identidade de storage numa cerca bidirecional:

LAB:
→ marker LAB obrigatório e validado, como hoje.

PRODUCTION:
→ marker LAB PROIBIDO.

Antes de QUALQUER DDL/worker no caminho production, faça uma leitura
read-only equivalente a:

SELECT to_regclass('ana_lab_schema_metadata')

Se existir:
→ FAIL BOOT com erro constante/sanitizado.

NÃO leia rows operacionais.
NÃO logue DATABASE_URL/fingerprint.
NÃO tente limpar/corrigir o banco.

Crie algo como:
`assertProductionStorageIsNotLab()`.

A ordem precisa ser:

resolve runtime
→ reverse storage assertion
→ somente então boot histórico production.

Gates:

production + storage sem marker
→ sequência histórica segue íntegra depois da nova preflight.

production + storage com marker LAB
→ FAIL antes de:
- ensure*
- worker
- HTTP listen
- model
- external write.

lab + marker correto
→ continua funcionando.

lab + marker ausente/incorreto
→ continua FAIL como hoje.

Isso fecha as duas direções:
LAB→PROD DB e PROD→LAB DB.

2. P1 — PROVIDER STATUS RECOVERY LOCAL

O LAB reativou state reconciliation e successor recovery, mas deixou de fora
a terceira recuperação local relevante:

ProviderStatusV2 pending/unmatched.

`sweepWhatsAppStatusCallbacks()` hoje também chama
`providerStatusStore.sweep()`.

Sem isso:
status da Meta pode chegar antes do commit do outbox,
ficar pending,
o outbox aparecer depois,
e ninguém reconciliar.

Não quero reativar write externo.

Escolha a menor solução segura:

preferência:
um recovery local separado para ProviderStatusV2;

aceitável:
reusar o status sweep existente SE provar que, em ANA_RUNTIME_MODE=lab,
todas as superfícies externas permanecem bloqueadas e ele só altera storage LAB.

O P1 já criado (`markCallbackDismissed(... LAB_WRITE_DISABLED)`) precisa ser
preservado.

Gate real:
- provider status chega antes do outbox → pending;
- outbox correspondente aparece;
- recovery LAB → applied;
- zero callback HTTP ERP;
- zero outro external write.

Health deve descrever corretamente os recoveries ativos.
Não chame tudo simplesmente de globalBackgroundJobs.

3. ADMIN RESET

Rode novamente o gate com ambiente sintético, não segredo real:

npm_config_cache=/tmp/npm-cache-lab
ERP_API_TOKEN=smoke-invalid

O próprio smoke usa DB fake e deps in-memory.

Quero:
smoke:admin-reset exit 0

Se ainda falhar, reporte a falha NOVA; não classifique automaticamente como
"environment".

4. PRESERVE

Não mexer em:
- customer fence aprovada;
- silent escalation aprovada;
- write policy;
- bootstrap;
- Meta/VPS/Neon/nginx/PM2;
- IA-23/25d/26/26b;
- boundary baseline-red.

Boundary continua formalmente:
def0832 RED
LAB RED
mesma asserção
fora deste diff.

Depois entregue novo HEAD e gates.

Ainda NÃO leve o plano para execução.

===============================================================================

# CONTRATO DE RETORNO (do coordenador)

Relatorio compacto: status · arquivos alterados · decisao tomada no P1 (recovery
separado ou reuso, e a prova) · os gates da reverse fence com resultado REAL ·
admin-reset com exit REAL · exit real de cada gate rodado · riscos e pendencias.
Sem raciocinio interno, sem log cru, sem credencial.

O commit fica comigo: nas duas rodadas anteriores o git falhou no seu sandbox
por permissao de gitdir. Deixe o diff pronto e nao tente commitar.
