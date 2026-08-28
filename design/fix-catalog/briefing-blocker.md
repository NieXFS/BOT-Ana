Requested Codex effort: xhigh

# BLOCKER no efa179d: o caminho SAUDAVEL do V2 mudou de prompt

Worktree /Users/niexfs/dev/wt-ana-fix-catalog · branch fix/v2-closed-catalog-prompt · HEAD efa179d

## CADEIA
Voce ORQUESTRA; implementacao no subagente NATIVO gpt-5.6-luna, esforco max.
codex-em-codex morre no sandbox. Um escritor por vez. Voce audita e roda gates.

## CERCAS
NAO deployar, NAO tocar VPS/PM2/env/nginx/Meta/Neon/WhatsApp, NAO mexer no LAB-1.
Commit fica comigo. Novo commit na MESMA branch.

## A ARQUITETURA DO P1 ESTA APROVADA — nao reabra

catalogMode com default refreshable, V2 pedindo closed_snapshot explicito, o
getServices deixando de ser removido para fabricar o catalogo fechado, e o regex
virando assertiva fail-closed: tudo isso esta aprovado e permanece.

## O BLOCKER, que eu confirmei no codigo

O P1 devia corrigir SOMENTE o caminho de catalogo indisponivel. Mas o builder
closed_snapshot tambem mudou o prompt do caminho DISPONIVEL — que e o que todo
tenant V2 recebe hoje em producao.

  def0832, apos o transformador (producao hoje):
    1. Use diretamente os IDs de servico e profissional do snapshot "SERVICOS
       DISPONIVEIS". O catalogo ja esta completo e imutavel neste turno; nao
       existe ferramenta para rele-lo ou atualiza-lo.

  efa179d, brainService.ts:295 (novo):
    1. Use os IDs de servico e profissional listados no snapshot imutavel
       "SERVICOS DISPONIVEIS" acima diretamente nas ferramentas
       (getAvailableSlots, bookAppointment). Opere somente com os dados deste
       turno e nao invente IDs ou dados de catalogo.

Semanticamente proximo, bytes diferentes, instrucao diferente ao modelo. Num
hotfix P1 isso e inaceitavel: estamos mexendo justamente no prompt que decide o
comportamento do modelo. Se da para corrigir o bug deixando o caminho saudavel
byte-identico, e o que fazemos.

## CORRECAO

1. criticalToolRuleOne no closed_snapshot deve NASCER com a copy EXATA que o
   transformador de def0832 produzia. Mantem o desenho "por construcao", sem
   voltar a .replace(), e preserva o contrato produtivo.

2. Confira e garanta byte-equivalencia, contra o resultado POS-TRANSFORMACAO do
   def0832, tambem para:
     - header fechado
     - style block fechado (o antigo, apos remover getServices)
     - regra 4 fechada

3. As adaptacoes A e E continuam sendo feitas pelo v2RulesPrompt exatamente como
   antes. Nao as mova para o builder.

## O GATE QUE FALTOU — e essa e a parte que mais importa

O smoke atual NAO prova preservacao do caminho saudavel. O caso de catalogo
disponivel termina em fast_path e so verifica a copy da resposta
("Por aqui: Drenagem..."); ele nunca captura um system prompt que realmente
chegue ao runModelLoop. Os modelPrompts so sao validados nos casos de catalogo
indisponivel.

E a terceira vez nesta onda que um gate verde exercita o caminho errado. Trate
como classe, nao como descuido pontual.

Adicione um caso de catalogo DISPONIVEL que alcance de fato o runModelLoop, e:
  - capture o system prompt FINAL do v2RulesPrompt (nao so o de
    buildSystemPromptFromServices)
  - gere primeiro a referencia rodando em def0832 com a MESMA fixture, config e
    frame, e grave o SHA-256 esperado
  - no HEAD novo exija finalV2AvailablePromptSHA === baselineDef0832SHA
  - se der, exija igualdade byte-a-byte

## PRESERVAR os gates atuais

unavailable com frame novo (nao lanca + fallback) · unavailable com state
existente · catalogo vazio · V1 refreshable byte-equivalent · zero getServices no
V2 · arsenal V2 sem a tool.

Reexecute os mesmos smokes e gates, com exit REAL.

Os dois baseline-red (v2-route e v2-boundary) seguem FORA do escopo; apenas
confirme de novo que def0832 RED == HEAD RED.

## RETORNO
status · diff · a copy final de cada bloco fechado · a prova de SHA do prompt V2
final no caminho disponivel · exit real de cada gate · confirmacao de que LAB-1
nao foi tocado · riscos. Sem raciocinio interno, sem log cru, sem credencial.
