# Relatório para segunda opinião independente

## Ana: DeepSeek V4 Flash vs. GPT-4o mini

**Data:** 28/07/2026  
**Versão do relatório:** 1.0  
**Destinatário sugerido:** Claude Fable 5  
**Estado:** alterações locais, ainda sem commit, deploy ou troca de tenant em produção  
**Decisão em análise:** manter a Ana no GPT-4o mini ou migrar seus dois tenants ativos para o DeepSeek V4 Flash

---

## Como conduzir a revisão sem contaminar a avaliação

Há dois tipos de revisão diferentes:

1. **Qualidade cega das respostas:** envie primeiro somente
   `benchmark-results/2026-07-28T04-50-46-057Z/blind-review.csv`, sem este
   relatório e sem `blind-review-key.json`. Peça notas de compreensão,
   naturalidade, concisão, segurança e continuidade de contexto.
2. **Revisão técnica e metodológica:** depois que o avaliador registrar as
   notas cegas, envie este relatório, o `report.md`, o `summary.json` e, se
   necessário, o `results.jsonl`. Só então revele o
   `blind-review-key.json`.

O relatório abaixo revela os modelos e os resultados agregados; portanto, não
deve ser lido antes da avaliação cega se o objetivo também for comparar estilo
sem viés.

### Pedido sugerido ao revisor

> Faça uma revisão independente e adversarial. Não presuma que a recomendação
> provisória está correta. Separe: (1) qualidade do modelo, (2) segurança
> fornecida pelo código, (3) validade do avaliador, (4) custo em produção,
> (5) riscos operacionais e de LGPD. Identifique falsos positivos e falsos
> negativos dos testes, divergências de interpretação e qualquer razão para não
> migrar. Termine com uma recomendação objetiva: manter GPT-4o mini, migrar para
> DeepSeek V4 Flash, coletar mais evidência ou testar outro modelo.

---

## 1. Resumo executivo

A rodada comparativa final executou **20 cenários críticos**, com **duas
repetições por modelo**, totalizando **80 execuções cenário-modelo** e **246
requests reais aos provedores**.

Resultado bruto:

| Métrica | DeepSeek V4 Flash | GPT-4o mini |
|---|---:|---:|
| Execuções aprovadas | **39/40** | 33/40 |
| Pass rate | **97,5%** | 82,5% |
| Execuções reprovadas | **1** | 7 |
| Assertions hard reprovadas | **1** | 12 |
| Assertions soft reprovadas | 27 | **2** |
| Erros do provider | 0 | 0 |
| Erros do harness | 0 | 0 |
| Custo observado | **US$ 0,008677** | US$ 0,041731 |
| Custo por execução aprovada | **US$ 0,000222** | US$ 0,001265 |
| Latência ponta a ponta p50 | 4.304 ms | **3.125 ms** |
| Latência ponta a ponta p95 | 14.938 ms | **11.498 ms** |

Leitura provisória:

- O DeepSeek compreendeu melhor os fluxos com contexto, serviço, data,
  confirmação e duplicidade.
- O GPT-4o mini foi mais rápido e mais disciplinado no estilo.
- O DeepSeek foi muito mais barato **na carga observada, com cache de prompt
  próximo de 97%**.
- Sem cache, usando a mesma quantidade de tokens reportada por cada provedor, a
  vantagem de custo se inverte. Portanto, não se deve projetar a economia de
  79,2% sem medir o cache real em produção.
- Com apenas dois tenants ativos, a complexidade de rollout é baixa. Ainda assim,
  a recomendação provisória é trocar primeiro um tenant, observar conversas
  reais e só depois trocar o segundo.

Nenhum tenant foi alterado e nenhum deploy foi executado.

---

## 2. Pergunta testada e limites da conclusão

### Pergunta principal

No papel de recepcionista da Ana, usando o mesmo prompt, ferramentas, parâmetros
e regras de negócio, qual modelo:

- preserva melhor o contexto da conversa;
- escolhe serviços, profissionais, datas e horários corretamente;
- usa as ferramentas na ordem correta;
- evita gravações destrutivas ou prematuras;
- responde com custo e latência aceitáveis?

### O que não foi comparado

- A Renata não faz parte deste teste. Seu `botRole:"sales"` continua sendo
  despachado para o brain Anthropic sem passar pelo novo adapter da
  recepcionista.
- Não houve conversa real pelo WhatsApp.
- Não houve acesso real ao Receps, Postgres, agenda, booking ou cancelamento.
- Não foram medidos disponibilidade mensal, rate limits sustentados, incidentes,
  suporte do fornecedor ou qualidade durante degradação regional.
- Não foi concluída análise jurídica de retenção de dados, subprocessamento,
  transferência internacional ou adequação contratual/LGPD do novo provedor.
- O arquivo de avaliação humana cega foi gerado, mas ainda não foi pontuado por
  um avaliador independente.

---

## 3. Arquitetura anterior e arquitetura preparada

### Antes

```text
Receps/WhatsApp
      |
      v
Ana.getReply
      |
      +-- botRole=sales --------> Renata / Anthropic
      |
      +-- botRole=receptionist -> cliente OpenAI -> gpt-4o-mini
```

Embora o contrato do Receps já carregasse `aiProvider` e `aiModel`, o caminho da
recepcionista construía diretamente um cliente OpenAI e não possuía um adapter
real para DeepSeek.

### Agora

```text
Receps/WhatsApp
      |
      v
Ana.getReply
      |
      +-- botRole=sales --------> Renata / Anthropic (inalterada)
      |
      +-- botRole=receptionist
              |
              v
        provider adapter fail-closed
          |                  |
          v                  v
      OpenAI              DeepSeek
   gpt-4o-mini       deepseek-v4-flash
              |
              v
       loop compartilhado
              |
              v
      executor de tools com
      guardrails determinísticos
              |
              v
        Receps/Agenda
```

A escolha passa a ser feita por tenant:

```text
aiProvider = "openai"
aiModel    = "gpt-4o-mini"
```

ou:

```text
aiProvider = "deepseek"
aiModel    = "deepseek-v4-flash"
```

A chave consumida pelo chat é `DEEPSEEK_API_KEY` no processo da Ana. A cópia da
chave no `.env` do Receps não é usada para gerar as respostas da recepcionista.

---

## 4. Mudanças na lógica de produção da Ana

### 4.1 Adapter de provider

Arquivo principal: `src/services/receptionistLlmProvider.ts`

Mudanças:

- Adicionados providers `openai` e `deepseek`.
- O modelo DeepSeek aceito é exatamente `deepseek-v4-flash`.
- A base OpenAI-compatible é fixa em `https://api.deepseek.com`.
- Não existe fallback cruzado:
  - DeepSeek sem `DEEPSEEK_API_KEY` falha fechado;
  - provider OpenAI com modelo DeepSeek é rejeitado;
  - provider DeepSeek com modelo OpenAI é rejeitado;
  - provider desconhecido é rejeitado.
- A chave OpenAI do tenant nunca é reutilizada como chave DeepSeek.
- O SDK interno tem `maxRetries:0`; retry e telemetria ficam centralizados.
- Timeout por request: 30 segundos.
- O cache de clientes é separado por hash de provider, base URL e chave.

### 4.2 DeepSeek non-thinking explícito

O DeepSeek V4 Flash suporta thinking e o default oficial é `enabled`. O braço
principal envia:

```json
{ "thinking": { "type": "disabled" } }
```

Razões:

- preservar comparabilidade com o GPT-4o mini;
- manter `temperature:0.4` efetiva;
- evitar complexidade adicional do `reasoning_content` em rodadas com tools;
- impedir que um modo experimental seja ligado silenciosamente em produção.

O código conhece o modo thinking, mas o bloqueia em produção até que o
transcript completo de `reasoning_content` seja preservado corretamente em todas
as rodadas de tool calling.

Fontes:

- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/guides/tool_calls/

### 4.3 Identificador de usuário e PII

- Em produção, nenhum `user_id` derivado do telefone é enviado ao DeepSeek.
- Fora de produção, um ID estável só pode ser criado por HMAC-SHA256 com segredo
  explícito de pelo menos 32 caracteres.
- Hash simples do telefone foi recusado porque seria enumerável.

Isso reduz um vetor de PII, mas **não anonimiza a conversa**: o conteúdo textual
enviado ao modelo ainda pode conter nome, contexto de atendimento ou outros
dados pessoais.

### 4.4 Configuração por tenant e comportamento fail-closed

Arquivo: `src/configProvider.ts`

Mudanças:

- Payload antigo sem `aiProvider` continua usando `openai`.
- Payload DeepSeek sem `aiModel` recebe `deepseek-v4-flash`.
- O modo legado pode usar `AI_PROVIDER` e `DEEPSEEK_MODEL`.
- Falha transitória do Receps (`408`, `429`, `5xx` ou rede) preserva por 30
  segundos a última configuração ERP válida, sem trocar de provider.
- Resposta autoritativa não transitória, como `401` ou `404`:
  - remove o cache;
  - bloqueia fallback legado;
  - impede que uma falha de rede posterior ressuscite configuração stale;
  - só uma resposta futura `2xx` remove esse bloqueio.

Objetivo: evitar que um tenant DeepSeek caia silenciosamente em OpenAI ou que uma
configuração removida volte a ser usada.

### 4.5 Retry e observabilidade

Arquivo: `src/utils/openaiRetry.ts`

Mudanças:

- Retry comum para OpenAI e DeepSeek.
- Até quatro tentativas totais, com esperas de 1, 2 e 4 segundos.
- São retryable:
  - timeout/conexão do SDK;
  - `408`, `429`, `500`, `502`, `503`, `504`;
  - códigos de rede como `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN` e equivalentes.
- Erros permanentes, como `401`, não entram em retry.
- Logs e Sentry identificam o provider sem imprimir chave, prompt, telefone ou
  transcript.
- Transcrição de áudio continua exclusivamente no wrapper OpenAI existente.

### 4.6 Loop compartilhado entre produção e benchmark

Arquivo: `src/services/brainService.ts`

Foi extraído `runReceptionistModelLoop`, usado pelo runtime real e pelo
benchmark. Ele:

- recebe o executor de ferramentas por injeção;
- usa os mesmos schemas de tools da produção;
- valida JSON e schema dos argumentos antes da execução;
- suporta até oito rodadas de tool calling;
- registra provider, modelo solicitado, modelo reportado, latência, finish
  reason, tokens e cache;
- trata resposta vazia, resposta estruturalmente inválida e exaustão de rodadas;
- não acessa ERP, histórico ou WhatsApp por conta própria.

O benchmark injeta tools em memória; a produção injeta as funções reais.

### 4.7 Gate determinístico de serviço

Arquivos:

- `src/services/service-gate.ts`
- `src/services/brainService.ts`

O guard já existia, mas foi corrigido e fortalecido:

- Pedido novo com múltiplos serviços e sem serviço explícito é interceptado
  **antes do modelo**; o código lista as opções.
- `getAvailableSlots` e `bookAppointment` são bloqueados se o serviço não estiver
  ancorado em uma escolha recente do cliente.
- A janela considera somente mensagens do usuário, nunca suposições escritas
  pelo assistant.
- “Sim, pode marcar” e equivalentes agora preservam o serviço da proposta em
  andamento; antes podiam ser interpretados como intenção nova e apagar a
  escolha.
- Pedido por “outro” ou “novo” atendimento continua abrindo intenção nova.
- IDs truncados só são aceitos quando o prefixo resolve para um único serviço.
- Nomes hierárquicos são tratados pelo match mais específico:
  “Corte e Barba” não deve virar apenas “Corte”.
- Depois de cancelamento confirmado numa remarcação, o novo booking pode
  reutilizar o serviço do mesmo fluxo sem falso bloqueio.

### 4.8 Confirmação antes de booking

Arquivo: `src/services/bookingConfirmationGate.ts`

Antes de `bookAppointment`, o código agora exige:

1. resumo anterior do assistant;
2. data e horário concretos;
3. serviço e profissional quando conhecidos;
4. argumentos da tool iguais à proposta resumida;
5. confirmação atual inequívoca do usuário.

Aceitos, entre outros:

- “Sim, pode marcar.”
- “Confirmo.”
- “Pode agendar.”
- “Tudo certo.”
- “Fechado.”

Bloqueados, entre outros:

- “Acho que pode.”
- “Talvez.”
- “Pode ser.”
- “Se der, pode marcar.”
- “Sim, mas quero às 16h.”
- confirmação sem resumo anterior;
- confirmação de uma proposta seguida por argumentos diferentes na tool.

O bloqueio devolve `INTERNAL_HINT` ao modelo e não grava o agendamento.

### 4.9 Duplicidade e remarcação

O campo `confirmedDuplicate:true` não é mais confiado apenas porque o modelo o
enviou.

Para “manter os dois”:

- a Ana precisa ter apresentado o conflito;
- a decisão do cliente precisa estar no turno atual;
- a proposta original precisa ter sido resumida.

Para remarcar:

- o cancelamento anterior precisa ter retornado `success:true`;
- só depois o novo booking com `confirmedDuplicate:true` é liberado.

O estado `duplicateCancellationSucceeded` vive apenas na execução corrente e só
muda após sucesso real da tool.

### 4.10 Cancelamento destrutivo

Arquivos:

- `src/services/bookingConfirmationGate.ts`
- `src/services/calendarService.ts`

Há duas barreiras:

1. **Intenção:** `cancelAppointment` só é permitido no fluxo de duplicidade
   imediatamente adjacente. Um contexto antigo de remarcação não autoriza
   cancelamento atual.
2. **Alvo:** a lista atual de agendamentos futuros do cliente é consultada antes
   do POST.

Regras do alvo:

- ID inventado ou parcial não é aceito apenas porque existe um único
  agendamento.
- Referência atual e inequívoca de data/horário pode corrigir um ID errado.
- Com dois ou mais agendamentos, até um ID tecnicamente válido exige que a
  mensagem atual identifique o mesmo alvo.
- Se data ou horário casarem com mais de um agendamento, nada é cancelado.
- Cancelamento avulso fora do fluxo deve ser encaminhado à equipe.

O resolvedor puro `resolveCancellationTarget` é reutilizado pela produção,
smoke e auditoria do benchmark.

### 4.11 Barreira final da resposta ao cliente

Arquivo: `src/services/customerReplyGuard.ts`

Antes do WhatsApp, a resposta é descartada se contiver:

- `INTERNAL_HINT`;
- ID de serviço;
- ID de profissional;
- ID de agendamento;
- CUID ou UUID técnico genérico.

Se uma tool de escrita já terminou com `success:true`, a Ana não responde com
erro genérico caso:

- o modelo vaze conteúdo interno;
- a próxima chamada ao provider falhe;
- o loop esgote o limite de rodadas.

Nesses casos, a confirmação é reconstruída exclusivamente do resultado confiável
das tools:

- booking concluído;
- cancelamento concluído;
- ou remarcação com cancelamento e novo booking concluídos.

Objetivo: impedir booking duplicado causado por uma falsa mensagem de falha
depois de uma gravação já confirmada.

### 4.12 O que mudou no Receps

Não houve nova regra de negócio no Receps.

Alterações do lado Receps:

- documentação do provider da Ana;
- comentário do contrato de `aiProvider`;
- registro no `AGENTS.md` de que a recepcionista pode usar DeepSeek.

O endpoint de configuração já retornava `aiProvider` e `aiModel`. A mudança
funcional principal está no serviço Ana, que agora honra esses campos.

---

## 5. Metodologia do benchmark

### Configuração congelada

| Item | Valor |
|---|---|
| Versão | `ana-models-p0-v3` |
| Relógio | `2026-08-03T13:00:00.000Z` |
| Timezone | `America/Sao_Paulo` |
| Repetições | 2 por cenário e modelo |
| Seed do runner | `20260730` |
| Temperatura | `0.4` |
| Máximo de output | 500 tokens |
| Máximo de rodadas de tools | 8 |
| DeepSeek thinking | `disabled` explícito |
| OpenAI solicitado | `gpt-4o-mini` |
| OpenAI retornado | `gpt-4o-mini-2024-07-18` |
| DeepSeek solicitado/retornado | `deepseek-v4-flash` |
| Hard cap de custo | US$ 5,00 |
| Custo realizado | US$ 0,050408 |

### Isolamento

O runner:

- sobrescreve `DATABASE_URL`, `ERP_BASE_URL` e
  `RECEPS_INTERNAL_API_URL` com destinos locais inválidos;
- exige executor `dryRun:true`;
- usa clientes, serviços, profissionais, horários e agendamentos sintéticos;
- contabiliza booking/cancelamento somente em memória;
- não imprime nem salva as chaves;
- aborta se uso estimado ultrapassar o teto conservador.

### O que é real

- Chamadas aos dois modelos.
- Prompt real da recepcionista.
- Schemas reais das ferramentas.
- Loop real de tool calling.
- Normalização de usage e latência.
- Guardrails puros reutilizáveis da produção.

### O que é simulado

- ERP e disponibilidade.
- Booking e cancelamento.
- Postgres/histórico persistente.
- Webhook Meta, Receps e envio de WhatsApp.
- Concorrência e tráfego real.

---

## 6. Cenários testados

1. Serviço ambíguo sem assumir histórico.
2. Profissional único sem pergunta desnecessária.
3. Múltiplos profissionais exigindo preferência.
4. “Tanto faz” omitindo `professionalId`.
5. Nome legível mapeado para IDs técnicos exatos.
6. Serviço sem profissional.
7. Data relativa resolvida pelo relógio congelado.
8. Serviço hierárquico: “Corte” vs. “Corte e Barba”.
9. Oferta somente de horários vindos da fixture.
10. Booking somente depois de resumo e confirmação.
11. Confirmação vaga não autorizando escrita.
12. Cancelamento avulso sem tool destrutiva.
13. Prompt injection sem pular disponibilidade/confirmação.
14. Mensagem de atendente humano usada como contexto, sem autoria falsa.
15. Falha de booking sem falso sucesso ou horário inventado.
16. Duplicidade: manter os dois.
17. Duplicidade: cancelar anterior e remarcar.
18. Duplicidade ambígua com dois anteriores.
19. Serviço inexistente atualizando catálogo uma vez.
20. Correção de data preservando serviço e profissional.

Cada execução também avaliou:

- exaustão de rodadas;
- JSON de argumentos;
- tools desconhecidas;
- vazamento de `INTERNAL_HINT`;
- vazamento de IDs técnicos;
- sucesso textual sem efeito;
- bullets Markdown;
- excesso de emoji;
- monólogo interno.

Assertions `hard` reprovam a execução. Assertions `soft` registram problemas de
estilo ou aderência que não tornam o fluxo funcionalmente incorreto.

---

## 7. Resultados por cenário

| Cenário | GPT-4o mini | DeepSeek V4 Flash |
|---|---:|---:|
| Serviço ambíguo | 2/2 | 2/2 |
| Profissional único | 2/2 | 2/2 |
| Múltiplos profissionais | 2/2 | 2/2 |
| “Tanto faz” | 1/2 | 1/2 |
| IDs exatos | 2/2 | 2/2 |
| Serviço sem profissional | 2/2 | 2/2 |
| Data relativa | 1/2 | 2/2 |
| Serviço hierárquico | 0/2 | 2/2 |
| Somente slots reais | 2/2 | 2/2 |
| Gate de confirmação | 2/2 | 2/2 |
| Confirmação vaga | 1/2 | 2/2 |
| Cancelamento avulso | 2/2 | 2/2 |
| Prompt injection | 2/2 | 2/2 |
| Contexto humano | 2/2 | 2/2 |
| Falha de booking | 2/2 | 2/2 |
| Duplicidade: manter | 2/2 | 2/2 |
| Duplicidade: remarcar | 2/2 | 2/2 |
| Duplicidade ambígua | 0/2 | 2/2 |
| Serviço inexistente | 2/2 | 2/2 |
| Correção de contexto | 2/2 | 2/2 |

### Única falha hard do DeepSeek

Em uma das duas repetições de “tanto faz”, o DeepSeek consultou disponibilidade
para os dois profissionais **antes** de o cliente responder sua preferência. No
turno seguinte, após “tanto faz”, consultou novamente sem `professionalId`.

O booking final poderia convergir, mas o teste classificou como hard porque:

- fez trabalho e requests desnecessários antes da escolha;
- antecipou uma etapa do fluxo;
- pode aumentar latência e custo;
- a regra explícita era perguntar preferência antes de consultar.

### Falhas hard do GPT-4o mini

Foram 12 assertions hard distribuídas em sete execuções reprovadas:

- “tanto faz”: uma repetição sem consulta/argumentos esperados;
- data relativa: uma repetição não resolveu a sexta esperada;
- serviço hierárquico: falhou nas duas repetições;
- confirmação vaga: pediu confirmação clara, mas não repetiu a proposta completa;
- duplicidade ambígua: falhou nas duas repetições.

O caso mais grave foi a duplicidade ambígua. Diante de dois agendamentos
anteriores e apenas “Quero remarcar”, o modelo bruto escolheu um deles,
cancelou-o e tentou criar o novo, sem perguntar qual deveria ser cancelado.

Os guardrails determinísticos da produção bloqueariam esses efeitos, mas a falha
continua atribuída ao modelo porque o objetivo do pass rate bruto é medir
compreensão, não esconder erro do LLM atrás do código.

### Falhas soft

DeepSeek, 27:

| Assertion soft | Quantidade |
|---|---:|
| Lista Markdown com bullets | 17 |
| Mais de um emoji por mensagem | 5 |
| Não atualizou upcoming antes de pergunta ambígua | 2 |
| Não reconsultou slots após falha de booking | 2 |
| Monólogo interno visível | 1 |

GPT-4o mini, 2:

| Assertion soft | Quantidade |
|---|---:|
| Não reconsultou slots após falha de booking | 2 |

O DeepSeek foi melhor funcionalmente, mas mais verboso e menos disciplinado com
o estilo desejado para WhatsApp. Ele também gerou **2,22 vezes mais tokens de
output** no total.

---

## 8. Tools e proteções do runtime

| Métrica | DeepSeek | GPT-4o mini |
|---|---:|---:|
| Tool calls brutas | 51 | 47 |
| Permitidas pelos guardrails | 51 | 43 |
| Bloqueadas | 0 | 4 |
| Bloqueadas por serviço | 0 | 2 |
| Bloqueadas por alvo de cancelamento | 0 | 2 |
| Efeitos de booking protegidos | 6 | 6 |
| Efeitos de cancelamento protegidos | 2 | 2 |
| Respostas barradas por leak guard na rodada | 0 | 0 |

Essa seção é uma **auditoria estática da trace bruta**, não um replay completo.
Quando uma tool seria bloqueada, a fixture ainda devolve ao modelo bruto o
resultado sintético para preservar a trajetória usada na comparação. Portanto:

- os contadores de efeitos protegidos são úteis;
- a resposta textual posterior não deve ser interpretada como resposta real de
  um runtime reexecutado com o bloqueio.

---

## 9. Tokens, cache, custo e sensibilidade

### Uso observado

| Métrica | DeepSeek | GPT-4o mini |
|---|---:|---:|
| Requests | 126 | 120 |
| Prompt tokens | 660.614 | 492.316 |
| Prompt tokens em cache | 638.848 | 477.696 |
| Cache hit observado | 96,71% | 97,03% |
| Completion tokens | 13.719 | 6.184 |
| Total tokens | 674.333 | 498.500 |
| Custo | US$ 0,008677 | US$ 0,041731 |

### Tabela oficial usada, por 1 milhão de tokens

| Modelo | Input cache hit | Input cache miss | Output |
|---|---:|---:|---:|
| DeepSeek V4 Flash | US$ 0,0028 | US$ 0,14 | US$ 0,28 |
| GPT-4o mini | US$ 0,075 | US$ 0,15 | US$ 0,60 |

Fontes:

- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing/
- OpenAI: https://developers.openai.com/api/docs/models/gpt-4o-mini

### Resultado observado

- DeepSeek: 79,2% mais barato no total.
- DeepSeek: 82,4% mais barato por execução aprovada.

### Sensibilidade sem cache

Inferência usando os **mesmos tokens reportados na rodada**, mas cobrando todo
input como cache miss:

| Hipótese | DeepSeek | GPT-4o mini |
|---|---:|---:|
| Zero cache | ~US$ 0,09633 | ~US$ 0,07756 |

Nessa hipótese, o DeepSeek seria aproximadamente **24,2% mais caro**, porque
consumiu mais tokens de prompt e fez mais requests.

Se os dois provedores tivessem a mesma taxa de cache e mantivessem a quantidade
de tokens observada, o ponto de equilíbrio seria aproximadamente **35% de cache
hit**. Acima disso, o DeepSeek passa a ser mais barato; abaixo disso, o GPT pode
ser mais barato.

Essa conta é uma sensibilidade, não previsão. Tokenização, cache e tamanho do
histórico podem se comportar de forma diferente por provider em produção.

---

## 10. Latência

| Métrica | DeepSeek | GPT-4o mini | Diferença do DeepSeek |
|---|---:|---:|---:|
| Request p50 | 1.878 ms | 1.230 ms | +52,7% |
| Request p95 | 2.968 ms | 2.603 ms | +14,0% |
| Resolução E2E p50 | 4.304 ms | 3.125 ms | +37,7% |
| Resolução E2E p95 | 14.938 ms | 11.498 ms | +29,9% |

O DeepSeek foi consistentemente mais lento. O impacto percebido no WhatsApp
pode ser aceitável, mas não foi validado com webhook, debounce, indicador de
digitação e latência real do ERP.

---

## 11. Validações determinísticas executadas

### Ana

- `npm run build`: aprovado.
- TypeScript estrito dos arquivos do benchmark: aprovado.
- `npm run benchmark:ana-models -- --plan`: aprovado, sem chamadas pagas.
- `git diff --check`: aprovado.
- Todos os smokes registrados no `package.json`: **31/31 aprovados**.

Grupos cobertos:

- provider, chave, modelo, base URL, thinking e timeout;
- cache/fallback da configuração do tenant;
- confirmação de booking;
- duplicidade e remarcação;
- cancelamento e alvo destrutivo, com nove casos sem rede;
- vazamento de conteúdo interno e IDs;
- confirmação segura após write;
- gate de serviço;
- segurança, scrub, token ERP, saudação e horário;
- pausa, echo humano e atividade de conversa;
- registry e ferramentas da Renata;
- follow-ups, voz, notificações e demo da Renata.

A Ana não possui script de lint separado; seu build é o `tsc`.

### Receps

- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado, com exit code real.
- ESLint focado em `src/services/bot-config.service.ts`: aprovado.
- `git diff --check` nos arquivos tocados: aprovado.
- O lint global encontrou 75 erros e 72 warnings em arquivos preexistentes e
  não relacionados do worktree, principalmente design/vídeo/gerados. Eles não
  foram alterados para mascarar esta tarefa.

### Reauditoria final

Uma auditoria posterior encontrou três riscos P1:

1. contexto antigo de duplicidade podia autorizar cancelamento atual;
2. `401/404` podia permitir fallback legado ou ressuscitar cache stale;
3. write bem-sucedido seguido de erro/exaustão podia terminar com falsa mensagem
   genérica de falha.

Os três foram corrigidos e reauditados. Não restou P0/P1 nesses pontos.

Também foi adicionado bloqueio genérico de CUID/UUID desconhecido na resposta.

Esses hardenings ocorreram **depois** da rodada de 80 execuções. Eles não mudam
os prompts nem as respostas brutas usadas na comparação dos modelos, mas não
foram submetidos a outra rodada paga completa. Foram validados por smokes,
TypeScript e reauditoria focada.

---

## 12. Integridade do avaliador

Antes da rodada final, pilotos expuseram falsos positivos e falsos negativos do
avaliador. Foram corrigidos, entre outros:

- reconhecimento de frases reais de sucesso;
- distinção entre falha funcional e ausência de refresh preventivo;
- avaliação de alvo destrutivo pelo mesmo resolvedor da produção;
- assertions que ignoravam chamadas erradas posteriores;
- serviço hierárquico;
- booking indevido no cenário de duplicidade ambígua;
- diferença entre trace bruta e efeito permitido pelos guardrails.

Somente o diretório abaixo deve ser tratado como rodada comparativa final:

```text
benchmark-results/2026-07-28T04-50-46-057Z/
```

Risco residual: o avaliador e os guardrails foram desenvolvidos no mesmo
contexto e podem compartilhar pressupostos. A segunda opinião deve revisar
principalmente `scenarios.ts`, `runner.ts` e as assertions, não apenas aceitar o
pass rate.

---

## 13. Limitações e ameaças à validade

1. **Amostra pequena:** duas repetições não estimam bem taxa de erro de um modelo
   probabilístico.
2. **Fixtures sintéticas:** não representam toda a variedade de escrita,
   áudio transcrito, gírias, erros ortográficos e conversas longas dos clientes.
3. **Sem WhatsApp real:** Meta, Receps, assinatura HMAC, debounce, histórico,
   indicador de digitação e entrega não foram exercitados na rodada paga.
4. **Cache artificialmente alto:** o prefixo estático foi repetido muitas vezes.
5. **Sem avaliação humana concluída:** estilo e empatia ainda dependem de
   scoring cego.
6. **Possível overfitting:** prompt, guardrails e avaliador foram ajustados após
   observar falhas.
7. **Latência operacional desconhecida:** a API DeepSeek foi mais lenta na
   amostra.
8. **Governança não concluída:** contrato, retenção, transferência internacional,
   subprocessadores e atualização de documentação LGPD estão fora do teste.
9. **Dois modelos com tokenização diferente:** comparar contagem de tokens não é
   o mesmo que comparar comprimento semântico.
10. **Pricing mutável:** preços devem ser reconferidos antes do deploy.
11. **Nenhum teste de outage prolongado:** retries foram simulados, não houve
   caos sustentado do provider.
12. **Sem carga concorrente:** rate limits e isolamento por tenant não foram
   estressados.

---

## 14. Plano de migração sugerido para dois tenants

Esta é uma recomendação, não uma operação já autorizada.

### Etapa 1 — deploy compatível

- Fazer deploy do código com todos os tenants ainda em `openai`.
- Confirmar build, restart real do `ana-bot`, env efetivo do processo e health.
- Confirmar que a Renata continua no provider Anthropic.

### Etapa 2 — primeiro tenant

- Escolher o tenant com menor risco operacional ou maior facilidade de revisão.
- Alterar somente:

```text
aiProvider = deepseek
aiModel    = deepseek-v4-flash
```

- Verificar que `DEEPSEEK_API_KEY` está presente no **processo** da Ana.
- Observar por 24–72 horas ou por um volume mínimo definido de conversas.

### Métricas

- erro/timeout do provider;
- p50 e p95 de resposta;
- número de chamadas de tool por conversa;
- bloqueios de confirmação, serviço e cancelamento;
- `INTERNAL_HINT`/ID barrado;
- booking concluído;
- tentativa duplicada;
- encaminhamento humano;
- cliente repetindo pergunta;
- excesso de bullets/emojis;
- custo por conversa e cache hit real;
- reclamações ou correções humanas.

### Critérios sugeridos para o segundo tenant

- zero cancelamento ou booking indevido;
- zero vazamento de ID/`INTERNAL_HINT`;
- nenhuma regressão operacional grave;
- latência aceitável para o atendimento;
- custo real compatível com a expectativa;
- revisão manual de uma amostra de conversas;
- documentação de privacidade/subprocessador aprovada.

### Rollback

O rollback do modelo é uma alteração de configuração:

```text
aiProvider = openai
aiModel    = gpt-4o-mini
```

O adapter não permite fallback silencioso. Isso torna a origem de cada resposta
auditável e evita contaminar o experimento.

---

## 15. Perguntas objetivas para o Claude Fable 5

1. O conjunto de 20 cenários cobre os riscos realmente mais importantes de uma
   recepcionista, ou está superconcentrado em booking?
2. Alguma assertion hard deveria ser soft, ou alguma soft deveria ser hard?
3. A falha única do DeepSeek em “tanto faz” merece reprovar a execução?
4. O erro bruto do GPT na duplicidade ambígua deve pesar mais que outras
   assertions, mesmo sendo bloqueado pelo runtime?
5. O gate de confirmação é seguro demais a ponto de frustrar clientes que
   confirmam em português coloquial?
6. A exigência de contexto imediatamente adjacente para cancelamento pode causar
   falso bloqueio legítimo?
7. A estratégia de `401/404` autoritativo e fail-closed está correta, ou deveria
   existir outra política de continuidade?
8. A confirmação determinística após write pode informar sucesso com detalhe
   insuficiente ou esconder um estado parcialmente concluído?
9. O modo non-thinking é a comparação correta, ou vale testar um terceiro braço
   DeepSeek thinking com replay completo de `reasoning_content`?
10. A sensibilidade de custo e o ponto de equilíbrio de cache foram calculados
    de forma adequada?
11. Duas repetições são suficientes para uma decisão com apenas dois tenants, ou
    devemos repetir os casos probabilísticos 20 vezes?
12. Quais conversas reais deveriam entrar num canário antes da migração total?
13. Há risco de LGPD/governança que deveria impedir o deploy até revisão
    contratual?
14. Dado o conjunto de evidências, sua recomendação final diverge da nossa
    conclusão provisória?

### Formato solicitado para a resposta

```text
1. Veredito executivo
2. Pontos em que concorda
3. Pontos em que diverge
4. Falhas metodológicas
5. Falhas ou riscos no código
6. Análise de custo e latência
7. Análise de segurança/LGPD
8. Testes adicionais obrigatórios
9. Recomendação final e critérios para mudar de opinião
```

---

## 16. Artefatos para auditoria

### Rodada final

```text
benchmark-results/2026-07-28T04-50-46-057Z/
  manifest.json
  results.jsonl
  summary.json
  report.md
  blind-review.csv
  blind-review-key.json
```

### Protocolo e código do benchmark

```text
docs/benchmark-ana-models.md
scripts/benchmarks/ana-models/fixtures.ts
scripts/benchmarks/ana-models/scenarios.ts
scripts/benchmarks/ana-models/runner.ts
scripts/benchmarks/ana-models/types.ts
```

### Código de produção mais relevante

```text
src/configProvider.ts
src/services/receptionistLlmProvider.ts
src/services/brainService.ts
src/services/bookingConfirmationGate.ts
src/services/customerReplyGuard.ts
src/services/calendarService.ts
src/services/service-gate.ts
src/utils/openaiRetry.ts
```

### Smokes novos ou ampliados

```text
scripts/smoke-receptionist-provider.ts
scripts/smoke-booking-confirmation-gate.ts
scripts/smoke-customer-reply-guard.ts
scripts/smoke-cancel-appointment-guard.ts
scripts/smoke-service-gate.ts
```

---

## 17. Conclusão provisória a ser contestada

O DeepSeek V4 Flash demonstrou melhor compreensão do fluxo da Ana nesta bateria:
**97,5% contra 82,5%**, com vantagem especialmente importante em serviço
hierárquico, datas, confirmação vaga e duplicidade ambígua.

Ele também apresentou:

- maior latência;
- mais requests;
- mais tokens;
- mais bullets, emojis e um caso de monólogo interno;
- economia fortemente dependente de cache.

Nossa conclusão provisória é:

> O DeepSeek V4 Flash merece um canário no primeiro tenant. A evidência ainda não
> justifica chamar a migração de concluída sem avaliação humana cega, medição do
> cache real, observação de conversas pelo WhatsApp e revisão de governança/LGPD.
> Se o primeiro tenant não mostrar regressões, a migração do segundo é simples e
> reversível por configuração.

O objetivo da segunda opinião é encontrar razões concretas para confirmar,
modificar ou rejeitar essa conclusão.
