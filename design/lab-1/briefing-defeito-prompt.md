Requested Codex effort: xhigh

# INVESTIGACAO: por que o guardrail de catalogo quebra no LAB e nao em producao

Worktree: /Users/niexfs/dev/wt-ana-lab   branch lab/ana-lab-1   HEAD cae2c05

## CADEIA

Voce ORQUESTRA. A leitura pesada de codigo pode ir para o subagente NATIVO
gpt-5.6-luna com esforco max — codex-em-codex morre no sandbox com "Operation
not permitted", entao use o subagente nativo, nao `codex exec` aninhado.
Um escritor por vez na arvore.

## ESCOPO: DIAGNOSTICO. NAO CONSERTE AINDA.

Quero causa-raiz e resposta sobre risco em producao. Se voce identificar o fix,
DESCREVA — nao aplique. A decisao de corrigir e do Victor.

PROIBIDO: deployar, reiniciar/reloadar PM2, alterar env, nginx, Meta, Graph API,
enviar WhatsApp, escrever no banco de producao, mandar inbound para o LAB.
Leitura de codigo e de log e liberada. Se precisar de algo fora disso, PARE e
reporte.

## O QUE EU JA ESTABELECI — nao refaca, confirme se for barato

O erro, disparado na PRIMEIRA mensagem sintetica que o LAB processou:

  Error: Prompt v2 reteve referencia a tool de catalogo removida
  em v2RulesPrompt  (src/services/conversationalV2/runtime.ts, linhas ~436-450)
  chamado por getReceptionistReplyV2 e alcancado por flushBuffer

O guardrail monta um "closedCatalogPrompt" aplicando uma cadeia de .replace()
que remove referencias a getServices, e depois faz:

  if (/\bgetServices\b/u.test(closedCatalogPrompt)) throw ...

FATOS QUE EU MEDI:

1. NAO e dado do tenant. Busquei a config do Viti no ERP de producao pelo
   endpoint /api/v1/bot/config: prompt com 3074 chars e ZERO ocorrencias de
   getServices. Logo, a referencia que sobrevive ao strip e injetada pelo
   PROPRIO RUNTIME ao compor as regras v2.

2. PRODUCAO NAO SOFRE. Contei nos arquivos certos (receps-ia-out-3.log e
   receps-ia-error-3.log, NAO os do lab): ~13 mil linhas, 700 mencoes ao
   phoneNumberId do Viti, 533 "Processando mensagens", 2 fallbacks, e ZERO
   ocorrencias do erro.

3. Mesma flag V2: producao tem studio-viti,rose-pacheco-podologia,
   centro-estetico-jackeline-hussar. O LAB tem studio-viti.

4. Mesmo codigo base: producao roda def0832; o LAB roda cae2c05, que e
   def0832 + os commits do LAB-1. O LAB-1 nao tocou prompt nem runtime v2 —
   confirme isso lendo o diff, nao acredite em mim.

5. O LAB tem STORAGE VAZIO. A conversa que quebrou era a primeira daquele
   convHash naquele banco.

## PERGUNTAS, em ordem de importancia

1. CAUSA-RAIZ: qual string com getServices sobrevive a cadeia de .replace(),
   e de onde ela vem? Aponte o arquivo e a linha que a injeta.

2. Por que producao nao quebra? Minha hipotese principal: o ramo do catalogo
   fechado so e tomado sob certas condicoes de flow state, e uma conversa NOVA
   em storage vazio toma um caminho que conversas em andamento nao tomam.
   Confirme ou derrube. Se for outra coisa (cache de config, ordem de
   composicao, algo do LAB-1), diga qual.

3. PRODUCAO ESTA EM RISCO LATENTE? Essa e a pergunta que decide urgencia.
   Se o ramo depende de conversa nova, entao a proxima conversa realmente nova
   do Viti — ou de qualquer tenant com V2 — quebraria em producao. Se for isso,
   e incidente, nao curiosidade. Responda com evidencia.

4. O guardrail esta certo em existir? Ele parece ser fail-closed deliberado
   contra o modelo receber uma tool que nao existe mais. Se sim, o defeito esta
   na cadeia de .replace() ser fragil a variacoes de texto — a mesma classe de
   "camada que promete divergindo da que decide" que perseguimos a onda inteira.

5. Qual seria o fix minimo e por que? Descreva, nao aplique. Diga tambem o que
   um teste de regressao precisaria cobrir para essa classe nao voltar.

## RETORNO

status · causa-raiz com arquivo e linha · resposta objetiva sobre risco em
producao (SIM/NAO e por que) · o fix proposto, sem aplicar · o que o teste de
regressao precisa cobrir · o que voce nao conseguiu determinar.
Sem raciocinio interno, sem log cru, sem credencial, sem PII.
