Requested Codex effort: xhigh

# P1: catalogo fechado do V2 obtido por remocao textual — corrigir a CLASSE

Worktree: /Users/niexfs/dev/wt-ana-fix-catalog
Branch: fix/v2-closed-catalog-prompt, criada a partir de def0832 (NAO do LAB-1).

## CADEIA

Voce ORQUESTRA; a implementacao vai para o subagente NATIVO gpt-5.6-luna com
esforco max. codex-em-codex morre no sandbox ("Operation not permitted"), entao
use o subagente nativo. Um escritor por vez. Voce audita o diff e roda os gates.

## CERCAS

NAO deployar, NAO reiniciar PM2, NAO tocar VPS, env, nginx, Meta, Graph API,
Neon, WhatsApp. NAO mexer no LAB-1 neste patch. O commit fica comigo (o git
falha no seu sandbox por permissao de gitdir). Se algo exigir sair disso, PARE.

## CAUSA-RAIZ JA DIAGNOSTICADA E CONFIRMADA — nao reinvestigue

getServices() retorna success:false quando o ERP falha OU quando normaliza zero
servicos. buildServicesBlock() (src/services/brainService.ts:153-155) entao
injeta:

  (Nao foi possivel carregar a lista de servicos agora. Se precisar, chame getServices.)

O v2RulesPrompt tenta converter o prompt legado em catalogo fechado por uma
cadeia de .replace() que cobre SOMENTE as formas do catalogo DISPONIVEL. A frase
de indisponibilidade nao e coberta, sobrevive, e o guard final
/\bgetServices\b/ lanca — antes do provider.

GATILHO: tenant na rota V2 + catalogo success:false + turno alcanca
v2RulesPrompt. NAO depende de conversa nova: catalogState nasce direto de
services.success. Vale para frame novo e estabelecido.

RISCO: latente em producao, qualquer tenant V2, apos restart com cache frio,
TTL de 5 min expirado, falha transitoria do endpoint, ou catalogo vazio. O cache
so guarda sucesso — mascara, nao protege.

OBSERVACAO IMPORTANTE: o codigo JA TEM o fallback CATALOG_UNAVAILABLE_FALLBACK_V2
(src/services/conversationalV2/recoveryCoordinator.ts:31 e 276). A excecao esta
IMPEDINDO uma recuperacao que ja foi projetada. O fix nao e adicionar tratamento
— e parar de bloquear o que existe.

## O FIX, com ESCOPO CONTROLADO

NAO reescreva o v2RulesPrompt inteiro. Ha ali outras adaptacoes V2 alem de
catalogo e o blast radius ficaria grande demais. A meta e UMA: o modo de acesso
ao catalogo nao pode mais ser inferido nem construido por remocao textual.

Introduza capacidade explicita na construcao do prompt:

  buildSystemPromptFromServices(config, services, now, { catalogMode })
  catalogMode: 'refreshable' | 'closed_snapshot'

Default = 'refreshable', para todos os callers legados e V1 ficarem
BYTE-EQUIVALENT sem alteracao. O V2 chama explicitamente 'closed_snapshot'.

Em closed_snapshot o prompt NASCE sem instrucao de chamar getServices. Isso
inclui explicitamente: catalogo disponivel; catalogo INDISPONIVEL; header
SERVICOS DISPONIVEIS; regra de servico ausente; regras criticas de ferramentas;
recuperacao de "Servico nao encontrado"; e qualquer referencia instrucional a
refresh/reload de catalogo.

RECEPTIONIST_V2_TOOLS continua sem getServices.

MANTENHA o /\bgetServices\b/ final, mas com papel trocado: ele passa a ser
ASSERTIVA DE REGRESSAO fail-closed, nao mecanismo de transformacao. Essa
distincao e o ponto do patch.

## CATALOGO INDISPONIVEL PASSA A SER ESTADO SUPORTADO

services.success=false deve exigir:
  catalogState='unavailable'
  nenhuma excecao de prompt
  nenhuma tool getServices
  turno dependente de catalogo termina no fallback ja existente
    CATALOG_UNAVAILABLE_FALLBACK_V2
  zero book/cancel/tool write

## GATES OBRIGATORIOS

- regression exato: loadServices => {success:false} atraves de
  getReceptionistReplyV2, com store em memoria e deps injetadas, sem rede/DB/provider
- o mesmo com frame NOVO
- o mesmo com flowState/pending JA EXISTENTE, provando que nao depende de
  conversa fria
- catalogo vazio normalizado -> comportamento seguro equivalente
- catalogo disponivel -> comportamento V2 anterior preservado
- prompt closed_snapshot contem ZERO getServices
- prompt refreshable BYTE-EQUIVALENT ao baseline def0832
- arsenal V2 continua sem getServices

Depois: smokes V2 mais proximos de prompt/route/recovery, typecheck e build,
com exit REAL de cada um.

## P2, faca SE nao atrasar o principal

Observabilidade do loadServices: receipt/log sanitizado com apenas success,
serviceCount, professionalCount e uma razao tipada
(http_failure | empty_catalog | available). Hoje sabemos que success:false
ocorreu mas nao distinguimos falha de rede de catalogo normalizado vazio — foi
por isso que a investigacao nao fechou esse ponto. Sem PII, sem payload.

## RETORNO

status · diff · funcoes tocadas · resultado REAL de cada gate com exit code ·
prova de que refreshable/V1 ficou byte-equivalent · confirmacao de que o LAB-1
nao foi tocado · riscos. Sem raciocinio interno, sem log cru, sem credencial.
