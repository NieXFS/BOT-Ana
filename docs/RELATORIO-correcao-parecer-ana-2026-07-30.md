# Ana — fechamento das correções do parecer independente

**Data:** 30/07/2026
**Escopo:** Ana recepcionista, GPT-4o mini × DeepSeek V4 Flash
**Status:** hardening e validação local concluídos; operador aprovou um canário
produtivo restrito a dois tenants-clientes, com gate global e rollback por
config.

## Veredito atualizado

O parecer estava correto sobre a ordem das prioridades. As falhas comuns aos
dois motores foram tratadas antes de usar o benchmark para escolher o provider.
Depois das correções metodológicas e de 20 repetições dos quatro cenários
probabilísticos, a vantagem técnica do DeepSeek deixou de ser apenas sugestiva:
foram 79/80 execuções aprovadas contra 24/80 do GPT-4o mini. Nos 55 pares
discordantes, todos favoreceram o DeepSeek; o teste exato pareado resulta em
`p ≈ 5,55 × 10⁻¹⁷`.

Isso resolve o critério técnico/estatístico proposto no parecer. Em decisão
posterior, o operador autorizou o canário produtivo e assumiu o gate de
governança, com estas restrições:

1. publicar DeepSeek, a finalidade e o tratamento na China antes do primeiro
   dado real;
2. exigir chave + aprovação global + seleção explícita por tenant;
3. migrar somente `centro-estetico-jackeline-hussar` e `studio-viti`;
4. manter `receps-admin` em OpenAI e a Renata em Anthropic;
5. preservar rollback para OpenAI por configuração.

Essa decisão operacional não substitui parecer jurídico independente nem
afirma que exista um contrato individual assinado com a DeepSeek.

## Correções implementadas

### Segurança e fluxo

- Afirmação de agendamento/cancelamento concluído agora exige `success:true` da
  escrita correspondente. Estado atual exige leitura autoritativa compatível.
  A checagem cobre todas as respostas da conversa, não só a última.
- Frases de estado em português real foram ampliadas: “ficou para”, “é
  amanhã”, “você já tem”, serviço + profissional antes de “agendada” e
  contagens explícitas de dois/três agendamentos.
- Confirmações coloquiais têm 52 positivos determinísticos, incluindo “isso
  mesmo”, “beleza”, “perfeito”, “pode sim”, “pode ser sim”, “ta bom”, “aham”,
  “uhum” e polegar.
- O resumo não depende mais apenas de frases mágicas: data, hora e pergunta
  estruturada também formam uma solicitação válida de confirmação.
- Remarcação cross-turn usa evidência autoritativa por conversa, com TTL,
  consumo único e restauração em falha. O cancelamento bem-sucedido autoriza o
  novo booking sem depender de `confirmedDuplicate` emitido pelo modelo.
- A autorização é derivada de modo diferente no gate e na API: no mesmo turno,
  a escolha explícita de remarcar abre o ramo de duplicidade; após um novo
  resumo em outro turno, a confirmação passa pelo gate normal, enquanto a
  chamada ao ERP ainda recebe o bypass derivado do cancelamento.
- Pedidos com múltiplas partes ganharam regra explícita: preço e agenda devem
  ser tratados na mesma interação.
- A saída enviada ao WhatsApp passa por normalização mecânica: remove Markdown
  e marcadores de lista e limita a um emoji, sem truncar conteúdo operacional.
- O cache de configs rejeitadas é LRU limitado a 1.000 entradas.

### Gate jurídico de produção

- `DEEPSEEK_API_KEY` sozinha não autoriza tráfego real.
- Em `NODE_ENV=production`, resolução do provider e montagem do request exigem
  `DEEPSEEK_PRODUCTION_APPROVED=true`.
- A defesa é duplicada para impedir que um runtime construído antes da carga do
  ambiente contorne o gate.
- O benchmark fixa `NODE_ENV=test` e continua exclusivamente sintético.
- A página pública foi corrigida para não afirmar falsamente que o payload da
  OpenAI é anônimo; mensagens podem conter nome, serviço, data e outros dados
  pessoais.
- DeepSeek foi incluído na lista pública antes do canário, com finalidade,
  categorias de dados, localização na China e link para a política oficial.
- A política de privacidade informa que o texto e o contexto recente da
  conversa podem ser enviados ao provider selecionado para gerar a resposta.

### Metodologia do benchmark

- `--guards=enforce` continua usando apenas fixtures em memória.
- O runner e a reauditoria espelham consumo/restauração da evidência
  cross-turn.
- A fixture agora espelha a resolução produtiva de ID exato ou prefixo único.
  Prefixo inequivocamente resolvível é sucesso funcional e desvio soft de
  aderência; não é mais falha hard falsa.
- Consulta antecipada antes da preferência de profissional virou soft;
  ausência total da consulta após “tanto faz” continua hard.
- A assertion universal de falsa escrita considera qualquer resposta barrada
  ao longo do cenário.
- Foram adicionados holdout, confirmações coloquiais, três fraseados de resumo,
  remarcação cross-turn, eco humano, multi-intent e transcrição ruidosa.
- Reauditoria é offline e não altera os resultados originais.

## Evidência

### Rodada completa — 40 cenários, 80 execuções

Fonte paga imutável:
`benchmark-results/2026-07-30T20-39-41-783Z/report.md`

Reauditoria com assertions calibradas:
`benchmark-results/2026-07-30T20-39-41-783Z/reaudit-2026-07-30T21-11-31-382Z.md`

| Modelo | Aprovado após reauditoria | Cenários com falha hard |
|---|---:|---:|
| DeepSeek V4 Flash | 38/40 (95%) | 2 |
| GPT-4o mini | 34/40 (85%) | 6 |

Na rodada paga original, antes da reclassificação de prefixos resolvíveis e da
consulta antecipada, o relatório mostrou 37/40 e 31/40. A trace original foi
preservada; o número atualizado vem de reauditoria gratuita e reproduzível.

Latência E2E dessa rodada:

| Modelo | p50 | p95 |
|---|---:|---:|
| DeepSeek V4 Flash | 4.652 ms | 15.162 ms |
| GPT-4o mini | 2.595 ms | 8.871 ms |

O DeepSeek foi substancialmente mais lento. A remarcação cross-turn chegou a
20.840 ms com DeepSeek e 13.279 ms com GPT, ainda com ERP em memória. Portanto,
latência real continua sendo métrica obrigatória do futuro canário.

### Rodada probabilística — 20 repetições

Fonte paga imutável:
`benchmark-results/2026-07-30T20-50-03-265Z/report.md`

Reauditoria final:
`benchmark-results/2026-07-30T20-50-03-265Z/reaudit-2026-07-30T21-11-32-426Z.md`

| Cenário | DeepSeek | GPT-4o mini |
|---|---:|---:|
| Qualquer profissional | 19/20 | 6/20 |
| Data relativa | 20/20 | 8/20 |
| Serviço hierárquico | 20/20 | 9/20 |
| Duplicidade ambígua | 20/20 | 1/20 |
| **Total** | **79/80** | **24/80** |

Pareamento: 24 ambos passaram, 1 ambos falharam, 55 só DeepSeek passou e 0 só
GPT passou. Teste exato do sinal/McNemar binomial: `p ≈ 5,55 × 10⁻¹⁷`.

O custo total das duas rodadas foi aproximadamente US$ 0,247. Como o parecer
apontou, custo não é eixo decisório para dois tenants.

## Validação técnica final

- Ana: `npm run smoke:security`, smokes de provider, confirmação, reply guard,
  service gate, cancelamento e cache LRU passaram; `npm run build` e
  `git diff --check` passaram.
- Receps: `npx tsc --noEmit`, `npm run lint`, `npm run build` e
  `git diff --check` passaram. O lint global encerrou com zero erros e 37
  avisos não bloqueantes.
- O escopo global do ESLint foi corrigido para não analisar protótipos,
  projetos auxiliares e Prisma gerado que já estavam fora do aplicativo
  (`design/`, `design_handoff_tour_ana/`, `mockups/`, `video/` e
  `src/generated/prisma/`). O smoke financeiro versionado que ainda tinha
  oito usos de `any` foi tipado sem desabilitar a regra.
- As páginas `/privacidade` e `/privacidade/subprocessadores` foram inspecionadas
  localmente em 1440×900 e 390×844. O overflow horizontal móvel encontrado
  durante a revisão foi corrigido; ambas encerraram sem overflow da página.

## Limitações que permanecem

- O benchmark não usou conversa WhatsApp real, tráfego de paciente, ERP,
  Postgres ou produção; a migração de configuração não muda essa propriedade
  metodológica.
- A latência do ERP/Neon e o debounce real não estão incluídos nos números.
- O DeepSeek ainda produz prosa bruta mais verbosa; a normalização determinística
  corrige formatação/emoji enviados ao cliente, mas não resume conteúdo.
- Avaliação humana cega continua pendente e precisa de avaliador não contaminado
  pelos relatórios.
- Revisão jurídica independente, instrumentos contratuais adicionais e a forma
  de informar cada tenant são ações externas; código e aviso público não as
  substituem.

## Gate de liberação aprovado

- `DEEPSEEK_PRODUCTION_APPROVED=true` foi autorizado pelo operador.
- DeepSeek e o tratamento na China foram adicionados à lista pública.
- A migração exige allowlist literal dos dois tenants-clientes, host de produção
  confirmado, dry-run, CAS serializável e auditoria.
- `receps-admin` e `receps-vendas` ficam fora da allowlist.
- O rollback permanece uma troca explícita de provider/model por tenant.
- O acompanhamento deve medir falso-bloqueio do booking gate, respostas
  descartadas, p50/p95 E2E e erros do provider.

Estado operacional: **DeepSeek vencedor técnico e aprovado para canário
produtivo restrito**, sem equivaler a parecer jurídico.
