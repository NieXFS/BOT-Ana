Requested Codex effort: xhigh

# CERCAS OPERACIONAIS (do coordenador, valem sobre tudo)

Worktree: /Users/niexfs/dev/wt-ana-lab   branch: lab/ana-lab-1   HEAD: 9c9cb03
Commits pequenos SOBRE 9c9cb03. Nao reescreva a fundacao ja aprovada.

1. NAO acesse a VPS, Meta, Graph API, Neon, nginx, PM2, DNS ou firewall.
   Nada de ssh. Trabalhe SOMENTE nesta worktree.
2. NAO execute o bootstrap de schema.
3. Segredo, token, DATABASE_URL, PII e a propria allowlist nunca aparecem em
   log, teste, health ou relatorio.
4. Se algo exigir uma dessas acoes, PARE e reporte como bloqueio.

# O QUE EU JA CONFERI NO CODIGO — use, nao refaca

Confirmei os tres bloqueantes antes de te acionar. Sao reais:

A. runtimePolicy.ts tem SOMENTE allowedTenantSlugs e allowedPhoneNumberIds.
   labPhoneNumberAllowed (linha ~215) confere so o phoneNumberId. Nao existe
   nenhuma cerca sobre quem fala com o numero.

B. questionEscalation.ts: persistSilentEscalationHold e a PRIMEIRA coisa que
   roda (linha ~589), antes de qualquer verificacao de escrita. Os dois ramos
   de falha chamam markFailure e retornam { kind: 'pending' }. E runtime.ts
   (linhas 320-324) lista 'pending' entre os desfechos AUTORITATIVOS. Com o
   sweeper desligado no LAB, o hold pending nunca e limpo.

C. stateStore.ts:1066 bloqueia inbound em 'transport_started' e
   'accepted_uncommitted'. Num LAB que reinicia a cada troca de branch, sem o
   sweep de reconciliacao isso trava sozinho e nao destrava.

# EVIDENCIA QUE EU JA FECHEI — nao precisa repetir

O problema dos quatro smokes tsx era o cache npm com owner root desta maquina.
Workaround provado: prefixar npm_config_cache=/tmp/npm-cache-lab

Rodei os quatro:
  smoke:booking-reasons    exit 0
  smoke:onboarding-tools   exit 0
  smoke:admin-reprocess    exit 0
  smoke:admin-reset        exit 1

O admin-reset falha por "ERP_API_TOKEN missing — required in production", e eu
reproduzi exit 1 IDENTICO na base def0832. E lacuna de ambiente (sem .env nesta
worktree), nao defeito de codigo nem regressao. Use esse mesmo workaround para
rodar seus gates.

O prompt abaixo veio do revisor e vai INTEGRAL.

===============================================================================

Revisão do LAB-1 em 9c9cb03: fundação aprovada, MAS ainda não está liberada
para infraestrutura real.

Não toque em VPS, Meta, Graph API, Neon, nginx, PM2, DNS ou firewall.

Feche três bloqueantes em commit(s) pequenos sobre 9c9cb03.

A. CUSTOMER FENCE

Adicionar no LAB:

ANA_LAB_ALLOWED_CUSTOMER_PHONES

Obrigatória, não vazia, `*` proibido.

A comparação deve usar uma forma canônica estável do telefone e nunca logar a
allowlist.

No webhook LAB:

messages[].from precisa estar autorizado ANTES de:
- state;
- model;
- tool;
- handler.

smb_message_echoes[].to precisa estar autorizado antes do echo handler.

Inbound/echo de customer fora da allowlist:
- zero model;
- zero tool;
- zero state;
- zero outbound.

No transporte WhatsApp LAB:
- além de phoneNumberId permitido,
- o `to` de sendFreeformMessage,
  sendFreeformMessageWithReceipt,
  sendAudioMessage e sendVideoMessage
  também precisa estar na allowlist.

Upload/download de mídia continuam presos à allowlist do phoneNumberId; o envio
final continua exigindo destinatário permitido.

Adicionar adversariais:
- Viti + customer permitido -> passa
- Viti + customer diferente -> bloqueado antes do handler
- echo Viti para customer diferente -> bloqueado
- outbound Viti para customer diferente -> transporte não chamado
- production continua sem customer fence LAB.

B. SILENT ESCALATION NO LAB

Hoje `escalateSilentUnderstandingFailure` persiste hold antes de descobrir que
o POST é proibido. `blocked` cai em markFailure -> pending, e como o LAB não roda
silent escalation sweeper a conversa pode ficar silenciada permanentemente.

Corrigir especificamente para LAB:

- ZERO POST ERP;
- ZERO silent hold `pending`;
- ZERO overlay ativo residual;
- NÃO classificar `lab_write_disabled` como handoff autoritativo;
- NÃO executar flow cutoff de SILENT_ESCALATION como se humano tivesse assumido;
- o cliente de teste precisa receber fallback visível seguro;
- registrar diagnóstico tipado/redacted de que a escalada externa foi bloqueada.

Não use `released` apenas para satisfazer o tipo se o runtime continuar
retornando payload:null.

Adicionar E2E/smoke que força:
primary rejeitado + regen rejeitado -> silent escalation path

e prova:
- escalation POST calls = 0
- silent hold rows = 0
- payload visível != null
- próximo inbound da mesma conversa não é suprimido pelo hold
- produção mantém comportamento byte-equivalent.

C. V2 RECOVERY LOCAL

Dedicated LAB database torna seguro reativar APENAS os mecanismos de recovery
que só operam sobre esse storage.

No LAB, manter OFF:
- silent escalation sweep
- inbound ERP outbox sweep
- WhatsApp status callback sweep
- retention
- sales followups
- voice/global probe
- qualquer worker de negócio externo.

Mas ativar:
- Conversational V2 state reconciliation sweep
- Conversational V2 successor recovery sweep

somente quando a V2 estiver habilitada para o tenant LAB.

Provar que eles usam exclusivamente o DATABASE_URL LAB e que qualquer business
write alcançado pelo successor continua batendo em LAB_WRITE_POLICY.

Health não deve mentir com `backgroundJobs=false` se existem recovery jobs.
Modele explicitamente, por exemplo:
globalBackgroundJobs=false
v2RecoveryJobs=true

ou contrato equivalente.

Smokes:
- stale transport_started LAB vira transport_unknown
- accepted_uncommitted reconcilia commit local sem POST
- queued successor após restart é retomado
- successor nunca escreve ERP
- successor outbound só pode ir para allowed customer
- PROD continua com a sequência histórica atual.

P1, faça se pequeno:
status callback externo bloqueado no LAB não deve ficar em retry eterno.
Terminalize/localmente dispense com razão LAB_WRITE_DISABLED, sem POST.

EVIDÊNCIA OBRIGATÓRIA ANTES DO PRÓXIMO CHECKPOINT

Rode também os quatro gates que ficaram NÃO TESTADOS:
booking-reasons
onboarding-tools
admin-reset
admin-reprocess

Corrija o ambiente/cache npm; não os marque como pass por equivalência.

O smoke boundary preexistente permanece fora deste patch. Documente:
baseline def0832 = red
LAB = mesmo red
nenhuma mudança nesse código.

Depois me entregue novo HEAD + diff + gates.

Ainda NÃO apresente nem execute plano de infraestrutura.

===============================================================================

# CONTRATO DE RETORNO (do coordenador)

Relatorio compacto. Sem raciocinio interno, sem log cru, sem credencial.
Exit REAL de cada gate. Gate ja vermelho na base def0832: diga e prove, nao
atribua ao patch nem esconda. Se nao conseguir commitar por permissao de
gitdir, diga — eu commito.
