Requested Codex effort: xhigh

# CERCAS OPERACIONAIS DESTA RODADA (do coordenador, valem sobre tudo)

Worktree: /Users/niexfs/dev/wt-ana-lab   branch: lab/ana-lab-1   base: def0832 (origin/main)
Repo: Receps-IA (runtime da Ana). O ERP e outro repo e NAO deve ser alterado aqui.

1. NAO acesse a VPS. Nada de ssh, scp, rsync ou qualquer comando remoto.
   A auditoria de producao ja foi feita e o resultado esta no bloco de contexto.
2. NAO toque em nginx, PM2, DNS, firewall, Meta/WABA/callback, Neon, .env produtivo
   nem em processo em execucao. Nem para "testar".
3. NAO consulte a Graph API e NAO leia waAccessToken/waVerifyToken/waRegistrationPin.
4. Trabalhe SOMENTE dentro desta worktree.
5. Segredo, token, DATABASE_URL e PII nunca aparecem em codigo, log, teste ou relatorio.
6. Se algo exigir uma dessas acoes para avancar, PARE e reporte como bloqueio.

Um dado que ja levantei e que voce pode aproveitar: os workers globais citados no
item 5 do prompt existem mesmo em boot() de src/webhookServer.ts —
startSilentEscalationHoldSweep, startConversationalV2Sweep,
startConversationalV2SuccessorSweep, startAnaRetentionScheduler,
startInboundOutboxSweep, startWhatsAppStatusCallbackSweep, startFollowupPoller.
Confirme por conta propria e procure os que eu nao listei.

O prompt abaixo veio do revisor e vai INTEGRAL. Siga-o como especificacao.

===============================================================================

# RECEPS-IA LAB-1 — ambiente real isolado para Studio Viti

Quero construir a infraestrutura lógica do `receps-ia-lab`.

IMPORTANTE: esta tarefa começa com CÓDIGO + AUDITORIA + PLANO.

NÃO altere ainda:
- nginx;
- PM2;
- Meta/WABA/callback;
- DNS;
- firewall;
- banco/branch/database Neon;
- processo produtivo;
- `.env` produtivo.

Antes de QUALQUER uma dessas mudanças, PARE e peça autorização explícita ao Victor.

Não interprete esta mensagem como autorização de infraestrutura.

---

# 0. CONTEXTO JÁ AUDITADO

Produção atual:

RecepsERP                :3000
receps-ia                 :3001
RecepsERP-native-preview  :3101

Nginx externo:

receps.com.br/
→ 127.0.0.1:3000

receps.com.br/webhook-clinica
→ receps-ia :3001

O servidor Receps-IA internamente expõe `/webhook`.
Portanto o `/webhook-clinica` é uma preocupação do proxy, não a rota interna
do Express.

Porta 3002 estava livre na auditoria.

Studio Viti possui WABA própria e, no banco do Receps, é o único tenant
configurado nessa WABA.

Os outros tenants relevantes têm WABAs próprias, uma por tenant.

Isso significa que um override de callback específico da WABA do Viti não
deveria redirecionar Jackeline, Rose ou Renata.

LIMITAÇÃO conhecida:
o inventário foi feito no banco do Receps, não pela Graph API.
Pode existir teoricamente outro número dentro da WABA do Viti que não esteja
configurado no Receps.

NÃO busque waAccessToken nem consulte Graph API sem autorização explícita.

---

# 1. OBJETIVO DO LAB-1

Quero chegar futuramente a:

Meta — WABA Studio Viti
        ↓
receps.com.br/webhook-clinica-lab
        ↓
nginx
        ↓
127.0.0.1:3002
        ↓
PM2 receps-ia-lab
        ↓
worktree/checkout independente
        ↓
branch candidata
        ↓
DeepSeek/modelo/provider que estivermos testando

Enquanto isso:

Produção continua:

receps.com.br/webhook-clinica
        ↓
127.0.0.1:3001
        ↓
PM2 receps-ia
        ↓
/root/Receps-IA
        ↓
main produtiva

O LAB deve permitir:

WhatsApp REAL do Studio Viti;
provider REAL;
tools READ reais;
catálogo REAL do tenant;
receipts reais;
flow state real;
pending state real;
testes de branch antes de merge/deploy;

SEM permitir alteração operacional do ERP.

---

# 2. CORREÇÃO CRÍTICA DE ARQUITETURA — BANCO ISOLADO É OBRIGATÓRIO

Não considero suficiente:

LAB process separado
+
LAB_WRITE_POLICY=disabled
+
mesmo DATABASE_URL de produção.

O `webhookServer.ts` atual inicia workers globais no boot, incluindo:

silent escalation sweep;
Conversational V2 sweep;
successor sweep;
retention;
retention scheduler;
inbound outbox sweep;
WhatsApp status callback sweep;
sales follow-up poller.

Mesmo que você desligue esses workers NO LAB, o processo PROD continua ligado e
pode observar rows criadas pelo LAB no mesmo banco.

Portanto:

**LAB-1 NÃO pode entrar em operação usando o mesmo state database da produção.**

Precisamos de isolamento de data plane.

Investigue no código qual é a opção menos invasiva:

A) database Postgres/Neon separado;

B) branch Neon dedicada ao LAB;

C) outro mecanismo realmente isolado que você consiga PROVAR que impede
prod e lab de consumirem rows um do outro.

Não aceite namespace de conversationKey sozinho se existirem sweepers globais
capazes de buscar rows sem esse namespace.

Não faça a mudança de banco agora.
Somente audite dependências e proponha a solução.

Preferência:
um database/state store dedicado ao LAB.

O ERP continua sendo autoridade externa para catálogo/disponibilidade,
mas o estado interno da Ana deve morar no storage do LAB.

Se uma branch Neon for clone de produção, não ligue nenhum worker sobre ela
antes de avaliar os rows clonados.
Preferencialmente o storage LAB nasce sem estado operacional de outros tenants.

---

# 3. ANA_RUNTIME_MODE

Implemente contrato explícito:

ANA_RUNTIME_MODE=production|lab

Comportamento:

ausente:
→ `production`, para preservar compatibilidade atual.

production:
→ comportamento atual byte-equivalent.

lab:
→ ativa as cercas abaixo.

Valor desconhecido:
→ FAIL BOOT.

Não derive modo a partir de:

tenantSlug;
NODE_ENV;
porta;
hostname;
nome do processo;
branch Git.

Quero uma decisão explícita.

Crie helper central, não espalhe `process.env.ANA_RUNTIME_MODE` pelo código.

---

# 4. LAB_WRITE_POLICY

Introduza:

LAB_WRITE_POLICY=disabled

Na primeira versão, `disabled` deve ser a ÚNICA política suportada no LAB.

Não implemente `enabled` ainda.

Se:

ANA_RUNTIME_MODE=lab
e
LAB_WRITE_POLICY ausente

→ trate como `disabled`.

Se vier qualquer valor desconhecido:
→ FAIL BOOT.

IMPORTANTE:
"writes disabled" NÃO significa desligar tudo.

Precisamos permitir:

READ do ERP;
getServices;
getAvailableSlots;
getUpcomingAppointments quando aplicável;
chamada ao provider;
envio de resposta pelo WhatsApp do Viti;
persistência de receipts/flow/pending/history NO BANCO ISOLADO DO LAB.

Precisamos BLOQUEAR:

bookAppointment;
cancelAppointment;
qualquer POST operacional equivalente no ERP;
criação de escalation/pergunta humana no ERP;
purge;
reprocessamento mutável;
qualquer write administrativo;
qualquer outro caminho que altere estado de negócio fora do storage LAB.

Faça um inventário completo das write surfaces antes de implementar.

Não proteja só a tool definition.

A cerca deve ficar perto da menor boundary que antecede o efeito real.

Se um write for tentado no LAB:

NÃO faça HTTP;
NÃO finja sucesso;
registre resultado tipado equivalente a:

class=write
outcome=blocked
writeCommitted=false
reason=lab_write_disabled

sem segredo/PII.

A copy do LAB não pode afirmar que o agendamento/cancelamento foi realizado.

---

# 5. BACKGROUND JOB POLICY

Em `ANA_RUNTIME_MODE=lab`, por default:

NENHUM worker global deve iniciar.

Isso inclui pelo menos todos os schedulers/sweeps existentes no `boot()`.

LAB-1 deve inicialmente rodar somente o necessário para:

HTTP webhook;
processamento síncrono/durável do inbound;
provider;
reads;
resposta WhatsApp;
state do próprio turno.

Não crie um segundo consumer global sobre o banco.

Se algum worker for absolutamente necessário para o E2E, demonstre primeiro:

por que ele é necessário;
qual tabela consome;
como será tenant/runtime-scoped;
por que PROD não consegue consumir os mesmos rows.

Caso contrário, permanece OFF.

---

# 6. DDL / ENSURE TABLES

O boot atual executa vários `ensure*Table()`.

No LAB com storage dedicado precisamos distinguir:

bootstrap de schema
vs
boot normal.

Não quero que todo boot LAB execute DDL automaticamente sem necessidade.

Projete preferencialmente:

LAB normal boot:
→ valida schema;
→ FAIL CLOSED se schema obrigatório não existe.

Bootstrap explícito:
→ comando/script separado;
→ só funciona em ANA_RUNTIME_MODE=lab;
→ somente contra storage LAB validado;
→ executado manualmente uma vez.

NÃO execute bootstrap agora.

---

# 7. CERCA DE DATABASE

Quero uma proteção contra alguém copiar `.env` de PROD para o processo LAB e
ligá-lo sem perceber.

Projete uma asserção de identidade do storage.

Exemplo aceitável:

ANA_LAB_DATABASE_FINGERPRINT=<sha256 da identidade sanitizada host/database>

No boot:

ANA_RUNTIME_MODE=lab
→ calcula fingerprint da conexão configurada
→ compara com valor esperado
→ mismatch/missing = FAIL BOOT

Nunca logue DATABASE_URL.

Nunca grave senha/token no fingerprint.

Pode propor mecanismo melhor, desde que seja objetivo e fail-closed.

---

# 8. CERCA DE TENANT + PHONE NUMBER

Não confie apenas na callback da Meta.

Adicione defesa em profundidade:

ANA_LAB_ALLOWED_TENANT_SLUGS=studio-viti
ANA_LAB_ALLOWED_PHONE_NUMBER_IDS=<id configurado por env>

Regras:

lista obrigatória em modo LAB;
`*` proibido;
lista vazia → FAIL BOOT.

Em LAB, mensagem precisa satisfazer TODOS:

phone_number_id está na allowlist;
getTenantConfig resolve config;
config.isActive=true;
config.botRole='receptionist';
tenantSlug está na allowlist;
config.phoneNumberId corresponde ao inbound.

Se qualquer uma falhar:

NÃO chamar modelo;
NÃO chamar tool;
NÃO escrever state;
NÃO responder WhatsApp.

Faça o bloqueio o mais cedo possível.

---

# 9. DESABILITAR LEGACY PHONE FALLBACK NO LAB

Hoje o webhook pode cair em `WA_PHONE_NUMBER_ID` quando
`metadata.phone_number_id` não vem.

Isso NÃO é aceitável no LAB.

Em:

ANA_RUNTIME_MODE=lab

`metadata.phone_number_id` deve ser obrigatório.

Nunca use `WA_PHONE_NUMBER_ID` como fallback para decidir tenant no LAB.

Vale para:

messages;
statuses;
echo/coexistence.

Não queremos que payload incompleto seja atribuído silenciosamente ao Viti.

---

# 10. FENCE ANTES DO ACK

Avalie o fluxo atual do POST `/webhook`.

Não quero descobrir tenant inválido somente dentro de uma Promise disparada
depois de o servidor já ter respondido 200.

Para LAB, a cerca bruta de `phone_number_id` precisa acontecer antes de
autorizar o processamento.

Se uma callback inesperada atingir o LAB:

fail closed;
não processar;
não transformar em sucesso silencioso.

Defina o HTTP apropriado e teste a retransmissão esperada da Meta.

Não altere o comportamento de produção.

---

# 11. NETWORK BINDING

Adicione suporte explícito a host de bind se necessário:

HOST

Para produção:
preservar comportamento atual.

Para LAB:
127.0.0.1 obrigatório/recomendado.

Objetivo:

receps-ia-lab :3002
NÃO escuta publicamente.

O tráfego externo passa SOMENTE por nginx.

Assim não dependemos apenas de iptables para proteger 3002.

---

# 12. HEALTH / OBSERVABILIDADE

`/health` no LAB deve permitir provar, sem segredo:

status=ok
runtimeMode=lab
writePolicy=disabled
backgroundJobs=false

Opcionalmente:
commit SHA/version do build.

Não retornar:

DATABASE_URL;
phoneNumberId;
tenantSlug se não for necessário;
tokens;
API keys.

Sentry/logs devem carregar tag técnica:

runtime_mode=lab

para não confundirmos incidentes do Viti LAB com PROD.

---

# 13. ENDPOINTS INTERNOS

O servidor possui vários endpoints além de `/webhook`.

No deployment preferido NÃO quero expor o app LAB inteiro pelo nginx.

Preferência de LAB-1:

externo:
https://receps.com.br/webhook-clinica-lab

nginx:
location específica

interno:
http://127.0.0.1:3002/webhook

Não faça:

ana-lab.receps.com.br/
→ proxy de TODO o Express

sem necessidade.

Isso reduziria desnecessariamente a superfície pública de:

admin;
privacy purge;
internal question replies;
reprocess;
etc.

Se você encontrar motivo técnico para preferir subdomínio, apresente antes.

---

# 14. WORKTREE / DEPLOYMENT ISOLADO

PROD nunca pode compartilhar checkout mutável com LAB.

Planeje algo equivalente a:

/root/Receps-IA
→ produção / main

/root/Receps-IA-lab
→ worktree/clone independente do LAB

Nunca:

git checkout de branch experimental dentro de `/root/Receps-IA`.

O objetivo é eu conseguir:

LAB branch A
→ build
→ restart receps-ia-lab

sem tocar em:

receps-ia
:3001
main
build de produção.

Logs PM2 também precisam ser distinguíveis.

---

# 15. CONFIGURAÇÃO PM2 FUTURA

Planeje processo separado:

name:
receps-ia-lab

cwd:
diretório LAB

PORT:
3002

HOST:
127.0.0.1

NODE_ENV:
production

ANA_RUNTIME_MODE:
lab

LAB_WRITE_POLICY:
disabled

background jobs:
off

allowlist:
somente Studio Viti.

NODE_ENV=production é intencional:
quero o mesmo comportamento técnico de build/runtime da produção.

Experimentos de modelo no futuro devem usar ANA_RUNTIME_MODE=lab como
autorização explícita, não depender de NODE_ENV=development.

NÃO crie/reinicie processo ainda.

---

# 16. META / WABA

NÃO altere Meta ainda.

Antes do callback real, há uma verificação adicional que considero relevante:

o banco do Receps prova que nenhum tenant CONFIGURADO divide a WABA do Viti,
mas não prova que a Meta não tenha outro número não cadastrado naquela WABA.

Antes do override quero um checkpoint explícito:

"Posso fazer uma consulta READ-ONLY na Graph API para listar os números da WABA
do Studio Viti usando a credencial existente?"

Só faça se Victor autorizar.

Não imprima token.

Se Victor não autorizar essa leitura, registre o risco residual e peça
aceitação explícita dele antes do override.

---

# 17. TESTES DE CÓDIGO OBRIGATÓRIOS

Quero smokes provando pelo menos:

production default == baseline atual;

ANA_RUNTIME_MODE inválido → boot falha;

LAB sem allowlist → boot falha;

LAB com `*` → boot falha;

LAB DB fingerprint inválido → boot falha;

LAB inbound de Viti → permitido;

LAB inbound de outro phoneNumberId → bloqueado ANTES de modelo/tool;

LAB config com outro tenantSlug → bloqueado;

LAB role sales → bloqueado;

LAB payload sem metadata.phone_number_id → bloqueado, sem legacy fallback;

LAB getServices → permitido;

LAB getAvailableSlots → permitido;

LAB booking write → executor HTTP NÃO chamado;

LAB cancel write → executor HTTP NÃO chamado;

LAB escalation write → executor HTTP NÃO chamado;

write bloqueado → receipt/tool effect mostra blocked/writeCommitted=false;

WhatsApp outbound do tenant LAB → continua permitido;

nenhum background worker inicia no LAB;

health LAB não contém segredo/PII;

shadow/IA-23/IA-25d/IA-26/IA-26b continuam verdes.

Faça também uma busca adversarial por outros caminhos mutáveis que eu não
listei.

Não assuma que `bookAppointment` é o único write.

---

# 18. TESTE DE PRODUÇÃO EQUIVALENTE

Como este código eventualmente vai para main, o modo production precisa ser
provado.

Com:

ANA_RUNTIME_MODE ausente

e com:

ANA_RUNTIME_MODE=production

o comportamento atual precisa permanecer equivalente em:

boot;
workers;
webhook;
model;
tools;
writes;
routes;
receipts;
health existente, salvo campos aditivos seguros.

Nenhuma flag LAB pode armar implicitamente em PROD.

---

# 19. NÃO IMPLEMENTAR AGORA

Ainda NÃO:

criar banco Neon;
criar worktree na VPS;
criar processo PM2;
abrir/configurar porta;
editar nginx;
reload nginx;
alterar callback Meta;
consultar Graph API com token;
mandar WhatsApp real;
alterar Studio Viti;
alterar Jackeline/Rose/Renata;
deployar branch experimental.

---

# 20. CHECKPOINT DE AUTORIZAÇÃO

Depois de terminar código + smokes + auditoria:

PARE.

Me entregue:

arquitetura final;
diff;
commits;
gates;
inventário completo de writes;
inventário dos workers;
opção escolhida para storage LAB;
prova de produção default-equivalent;
prova de write policy;
prova de tenant fence;
prova de background workers OFF.

Depois apresente o plano EXATO de infraestrutura que faria, SEM executar.

O plano deve conter, na ordem:

1. provisionamento do storage LAB;
2. bootstrap de schema LAB;
3. criação da worktree `/root/Receps-IA-lab`;
4. build;
5. criação do `receps-ia-lab` PM2 :3002;
6. prova via localhost `/health`;
7. nginx `/webhook-clinica-lab`;
8. `nginx -t`;
9. eventual reload;
10. consulta Graph API read-only da WABA, se autorizada;
11. mudança de callback SOMENTE da WABA Studio Viti;
12. verificação GET do webhook;
13. primeiro inbound real;
14. prova de zero business writes;
15. prova de receipt/model/tool;
16. rollback.

Inclua o rollback ANTES de pedir autorização.

Rollback deve restaurar callback da WABA para PROD, remover/parar LAB sem tocar
em `receps-ia`, e preservar os artefatos necessários para investigação.

Só depois diga:

"Plano pronto. Posso executar as mudanças de infraestrutura acima?"

E PARE esperando resposta explícita do Victor.

Uma autorização genérica anterior NÃO vale para esses passos.

---

# CRITÉRIO FINAL DO LAB-1

Só considero LAB-1 pronto quando pudermos provar simultaneamente:

WhatsApp real Studio Viti
→ branch LAB
→ provider real
→ state/receipts isolados
→ reads reais do ERP
→ resposta real no WhatsApp

E:

0 agendamentos escritos
0 cancelamentos escritos
0 escalations produtivas
0 workers globais concorrentes
0 rows LAB consumidas por PROD
0 outro tenant roteado ao LAB
0 porta LAB exposta diretamente
0 alteração de processo/build PROD.

Primeiro implemente SOMENTE o código e faça a auditoria.
Não execute a infraestrutura.

===============================================================================

# CONTRATO DE RETORNO (do coordenador)

Trabalhe autonomamente dentro do escopo acima. Devolva SOMENTE relatorio compacto,
seguindo o item 20. Sem raciocinio interno, sem JSONL, sem log cru, sem credencial.
Reporte exit REAL de cada gate que rodar. Se um gate ja estava vermelho na base
def0832, diga isso e prove — nao atribua ao seu patch nem esconda.
