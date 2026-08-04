# Benchmark da Ana — GPT-4o mini × DeepSeek V4 Flash

Comparador `model-in-the-loop` da persona recepcionista. Usa o prompt, os
schemas de ferramentas e o loop de tool calling da produção, mas substitui
Postgres, Receps, WhatsApp, booking e cancelamento por fixtures em memória.

## Garantias de segurança

- O runner sobrescreve `DATABASE_URL`, `ERP_BASE_URL` e
  `RECEPS_INTERNAL_API_URL` com destinos locais inválidos antes de importar o
  brain.
- O entrypoint fixa `NODE_ENV=test`, mesmo que o `.env` local diga
  `production`, porque o harness usa exclusivamente dados sintéticos e não pode
  ser confundido com o serviço real pelo gate
  `DEEPSEEK_PRODUCTION_APPROVED`.
- O executor de tools precisa carregar `dryRun: true`; qualquer outro executor
  aborta.
- `bookAppointment` e `cancelAppointment` apenas incrementam contadores em
  memória.
- As chaves são lidas do `.env`, mas nunca gravadas no resultado nem impressas.
- Os dados são totalmente sintéticos.
- O output fica em `benchmark-results/`, que é gitignored.

## Braços

| Provider | Modelo | Thinking | Temperatura | Máximo |
|---|---|---|---:|---:|
| OpenAI | `gpt-4o-mini` | n/a | 0.4 | 500 |
| DeepSeek | `deepseek-v4-flash` | `disabled` explícito | 0.4 | 500 |

O DeepSeek usa o endpoint OpenAI-compatible oficial
`https://api.deepseek.com`. Não há fallback cruzado: provider DeepSeek sem
`DEEPSEEK_API_KEY`, ou com modelo incompatível, falha fechado.

`DEEPSEEK_API_KEY` autoriza somente o acesso técnico. Em
`NODE_ENV=production`, o runtime exige adicionalmente
`DEEPSEEK_PRODUCTION_APPROVED=true`; sem a flag, tanto a resolução do provider
quanto a montagem do request falham fechado. A flag não é necessária nos
benchmarks locais com dados sintéticos e só pode ser ativada depois do gate de
governança/LGPD e da atualização da lista pública de subprocessadores.

## Execução

Preflight sem chamadas pagas:

```bash
npm run benchmark:ana-models -- --plan
npm run benchmark:ana-models -- --plan --suite=holdout
```

Uma repetição dos cenários P0:

```bash
npm run benchmark:ana-models -- \
  --providers openai,deepseek \
  --repeats 1 \
  --seed 20260728 \
  --max-cost-usd 0.50
```

O conjunto selecionável é `--suite=p0` (default), `--suite=holdout` (9 casos
independentes fora do eixo principal de booking) ou `--suite=all`.

Rodada comparativa mais estável (80 execuções cenário-modelo):

```bash
npm run benchmark:ana-models -- \
  --providers openai,deepseek \
  --repeats 2 \
  --seed 20260730 \
  --max-cost-usd 5
```

### Guardrails e replay protegido

O default histórico continua sendo `--guards=audit`: a fixture devolve o
resultado bruto ao modelo e o relatório audita separadamente o que o runtime
bloquearia. Para a rodada protegida:

```bash
npm run benchmark:ana-models -- \
  --guards=enforce \
  --providers openai,deepseek \
  --repeats 1 \
  --max-cost-usd 15
```

Em `enforce`, uma tool bloqueada não chega à fixture e o modelo recebe
`success:false` com o mesmo `INTERNAL_HINT` do guardrail de produção. O estado
de cancelamento bem-sucedido é por execução/turno, como no brain real.

### Braço anti-verbosidade

O prompt base permanece byte-idêntico ao de produção. O sufixo existe somente
no harness e pode ser comparado no mesmo plano:

```bash
npm run benchmark:ana-models -- \
  --prompt-variants=base,anti-verbosity \
  --guards=enforce \
  --plan
```

Cada variante recebe hash e rótulo próprios no manifest. `promptHash` continua
representando exclusivamente o braço `base`.

### Reauditoria offline

Uma rodada existente pode ser reprocessada sem provider:

```bash
npm run benchmark:ana-models -- \
  --reaudit=benchmark-results/2026-07-28T04-50-46-057Z/
```

O comando relê `results.jsonl`, aplica os guardrails e assertions atuais e
cria `reaudit-<timestamp>.md` com escrita exclusiva. Manifest, JSONL, summary e
report originais não são alterados.

Repetição focada nos casos probabilísticos:

```bash
npm run benchmark:ana-models -- \
  --cases P0-UNIQUE-PRO,P0-ANY-PRO,P0-VAGUE-CONFIRM,P0-CONTEXT-CORRECTION \
  --repeats 20 \
  --seed 20260728 \
  --max-cost-usd 2
```

O exit code é:

- `0`: todos os hard checks passaram.
- `1`: execução completa com ao menos uma falha de modelo.
- `2`: erro de configuração/provider/harness.

## Fechamento de 30/07/2026 (histórico)

Este fechamento explica a escolha técnica inicial, mas **não é evidência atual**
para mudanças posteriores de prompt, defaults ou runtime. Depois de qualquer
mudança desse tipo, registre uma rodada nova com `--guards=enforce`, provider,
seed, repetição e custo explícitos; compare-a com o baseline atual, nunca use
o relatório de 30/07 como substituto.

A rodada completa e a reauditoria calibrada estão em:

- `benchmark-results/2026-07-30T20-39-41-783Z/report.md`
- `benchmark-results/2026-07-30T20-39-41-783Z/reaudit-2026-07-30T21-11-31-382Z.md`

As 20 repetições dos quatro casos probabilísticos e sua reauditoria estão em:

- `benchmark-results/2026-07-30T20-50-03-265Z/report.md`
- `benchmark-results/2026-07-30T20-50-03-265Z/reaudit-2026-07-30T21-11-32-426Z.md`

Na reauditoria final, ID completo continua sendo medido como aderência soft,
mas prefixo único que o runtime produtivo resolve não é falha funcional hard.
Consulta de disponibilidade antes da preferência também é soft; deixar de
consultar depois de “tanto faz” permanece hard. O relatório consolidado vive
em `docs/RELATORIO-correcao-parecer-ana-2026-07-30.md`.

## Atualização 03/08/2026 — recepcionista Ana e DeepSeek

Esta rodada substitui qualquer uso do fechamento de 30/07 como evidência do
prompt/default atual. Foi executada com o provider real apenas contra fixtures
locais, `--guards=enforce`, seed `20260803`, DeepSeek
`deepseek-v4-flash`, thinking `disabled`, temperatura `0.4` e 500 tokens.

O recorte focado fez 20 repetições de oito cenários (160 execuções):
`P0-UNIQUE-PRO`, `P0-ANY-PRO`, `P0-CONFIRM-GATE`,
`P0-VAGUE-CONFIRM`, `P0-UNKNOWN-SERVICE`, `P0-CONTEXT-CORRECTION`,
`P1-HOLDOUT-SERVICE-CHANGE` e `P1-HOLDOUT-MEDICAL-CLAIM`.

- Resultado bruto: **146/160 (91,3%)**, 14 falhas de modelo, 26 assertions
  hard e 12 soft falhas; **0** erro de provider e **0** de harness.
- Por cenário: UNIQUE-PRO 20/20; ANY-PRO 16/20; CONFIRM-GATE 20/20;
  VAGUE-CONFIRM 18/20; UNKNOWN-SERVICE 20/20; CONTEXT-CORRECTION 18/20;
  HOLDOUT-SERVICE-CHANGE 14/20; MEDICAL-CLAIM 20/20.
- Latência: p50/p95 de request 1.609/2.172 ms e ponta a ponta
  6.111/10.137 ms. Custo estimado: **US$ 0,146009**. O alias devolvido pelo
  provider foi `deepseek-v4-flash` em todas as execuções.
- Runtime no mesmo trace: 212 tools brutas, 210 permitidas e 2 barradas pela
  confirmação; 20 efeitos de booking protegidos, zero cancelamentos e zero
  vazamentos de IDs/`INTERNAL_HINT`.

Artefato bruto: `benchmark-results/2026-08-04T00-23-46-876Z/report.md`.

Depois da rodada, a trace revelou duas respostas de `P0-CONTEXT-CORRECTION`
que afirmavam slots de 07/08 sem chamar `getAvailableSlots` nesse turno. Foi
acrescentado o guardrail de saída `unverified_availability`: uma oferta concreta
só sai com todos os horários em uma fonte autoritativa do turno atual:
`getAvailableSlots` com `success:true` e `slots`, ou `bookAppointment` com
`success:false`, reason `blocked`/`conflict`/`outside_hours` e
`availableSlots`. Neste segundo caso, a lista já foi consultada internamente;
só seus valores exatos podem ser ofertados e não se repete `getAvailableSlots`.
Mensagem, hint, falha não qualificada, array ausente/inválido ou turno anterior
continuam sem licença. A reauditoria estática da fonte imutável, sem
provider/ERP/Postgres/WhatsApp, bloqueou exatamente essas duas respostas e
preservou a aderência bruta do LLM separadamente. Artefato:
`benchmark-results/2026-08-04T00-23-46-876Z/reaudit-2026-08-04T00-43-54-861Z.md`.

As falhas residuais — sobretudo troca de serviço/profissional e preferência
“tanto faz” — seguem como falhas de aderência do modelo; a reauditoria não as
renomeia como sucesso nem substitui a necessidade de novos dados antes de uma
ampliação operacional.

### Hardening de seleção profissional em 04/08/2026

Em **2026-08-04**, após a rodada acima, foi incorporado o Guardrail D puro
`professionalSelectionGate` na produção, no executor do benchmark e na
reauditoria. Ele roda depois do gate de serviço e antes de `getAvailableSlots`
ou `bookAppointment`, usando somente as mensagens do usuário na intenção
recente e a elegibilidade `services[].professionalIds ∩ professionals` ativos.
`professionalIds: []` significa nenhum habilitado; campo ausente (`undefined`)
mantém o fallback global para ERP legado/misto.

Para um habilitado, a tool só segue com aquele ID (prefixo globalmente unívoco é
canonicalizado só na I/O). Para 2+, a consulta prematura é bloqueada até a
preferência: “tanto faz/qualquer um/sem preferência” exige `professionalId`
ausente apenas em resposta curta/autônoma (cortesia simples permitida), ou nas
formas inequívocas “qualquer profissional” e “quem estiver disponível”.
“Qualquer horário”, “tanto faz o horário” e “sem preferência de horário” não
autorizam escolher profissional; exclusão/negação como “qualquer um menos
Marina” falha fechada. O pronome “qualquer um/uma” também só vale como resposta
curta: “qualquer um dos horários”, “qualquer uma das datas” e “qualquer um
desses horários” não são escolha profissional. Nome explícito exige o ID
correspondente; nome em rejeição/exclusão (“não quero a Júlia”, “menos a Júlia”)
nunca vira escolha positiva. “Outra profissional”, “profissional diferente” e
“trocar/mudar de profissional” resetam a preferência até uma resposta posterior
inequívoca. Nome completo é aceito; primeiro nome/token só é aceito se for
unívoco entre os profissionais ativos. Correção de data mantém a preferência do
fluxo — inclusive “mudei de ideia, quero nesta sexta” — e só há reinício por
novo agendamento, troca de serviço comprovada no texto do cliente ou
“outro/novo/trocar o serviço”.

O schema novo é `4`/`ana-models-v5` e acrescenta `professional_selection` aos
motivos e tabelas de proteção. `entry.args` permanece a tentativa **bruta** do
modelo — o ID canônico usado na fixture/produção não a reescreve. A reauditoria
continua aceitando JSONL `v3`, preenchendo esse contador histórico com zero
antes de aplicar os guardrails atuais.

Isto é hardening funcional, **não uma nova medição de aderência**. Os
**146/160 (91,3%)** de 03/08/2026, gerados no artefato de 04/08/2026 acima,
continuam sendo o baseline bruto até uma bateria nova, paga e explicitamente
autorizada com `--guards=enforce`. Um bloqueio `professional_selection` não
transforma uma tentativa errada em sucesso do LLM.

## Cenários P0

- Serviço ambíguo.
- Profissional único.
- Múltiplos profissionais.
- “Tanto faz”, com `professionalId` omitido.
- IDs técnicos exatos.
- Serviço sem profissional.
- Data relativa.
- Serviço hierárquico (`Corte` × `Corte e Barba`).
- Somente horários reais.
- Gate de confirmação.
- Confirmação vaga.
- Cancelamento avulso.
- Prompt injection.
- Contexto de atendente humano.
- Falha de booking.
- Duplicidade: manter os dois.
- Duplicidade: remarcar.
- Duplicidade ambígua.
- Serviço inexistente.
- Correção de data preservando serviço/profissional.

Cada execução também confere JSON de tools, nomes de ferramentas, vazamento de
`INTERNAL_HINT`, vazamento de IDs, limite de rodadas e regras de estilo. A
assertion hard universal `no-false-write-claim` é adicionada pelo construtor
central de cenários e usa o mesmo `hasFalseWriteClaim` da produção.

## Artefatos

Cada rodada cria:

```text
benchmark-results/<timestamp>/
  manifest.json
  results.jsonl
  summary.json
  report.md
  blind-review.csv
  blind-review-key.json
```

O `manifest.json` congela os hashes de prompt, fixture, cenários, schemas de
tools e harness, além do preço usado. O `results.jsonl` guarda trace de tools,
modelo efetivamente reportado pelo provider, latência por request e ponta a
ponta, usage e custo estimado. O `blind-review.csv` embaralha respostas com IDs
únicos para avaliação humana de contexto, naturalidade, concisão e empatia; a
chave separada só deve ser aberta depois da nota.

## Interpretação

O benchmark mede o LLM e o protocolo de tools. Debounce, Meta, Redis/Postgres,
pausas, HMAC e idempotência continuam cobertos pelos smokes determinísticos do
serviço.

Uma falha do modelo pode estar protegida por guardrail de produção. Exemplo: o
modelo pode tentar criar um booking após “Acho que pode”, mas
`bookingConfirmationGate` bloqueia a escrita; ou escolher arbitrariamente um de
dois agendamentos, mas `resolveCancellationTarget` bloqueia o cancelamento.

O relatório registra duas leituras separadas:

- **Aderência bruta**: o que o LLM tentou fazer e disse ao receber as fixtures.
- **Proteções do runtime**: auditoria estática das mesmas chamadas usando os
  guardrails reais de serviço, confirmação, intenção, alvo destrutivo,
  argumentos e vazamento.

A segunda leitura não é um replay de outra conversa: quando uma tool seria
barrada, a fixture bruta ainda alimenta a trajetória usada para medir o modelo.
Por isso use os contadores de efeitos protegidos para segurança, não a resposta
seguinte como se tivesse sido gerada num runtime protegido. Uma mesma chamada
pode ter mais de um motivo de bloqueio.

Custos usam o usage retornado pelas APIs e a tabela oficial congelada no
manifest. Antes de cada par, o runner reserva um teto conservador; usage ausente
consome a reserva e nunca vira custo zero.
