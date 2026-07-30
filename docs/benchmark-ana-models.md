# Benchmark da Ana — GPT-4o mini × DeepSeek V4 Flash

Comparador `model-in-the-loop` da persona recepcionista. Usa o prompt, os
schemas de ferramentas e o loop de tool calling da produção, mas substitui
Postgres, Receps, WhatsApp, booking e cancelamento por fixtures em memória.

## Garantias de segurança

- O runner sobrescreve `DATABASE_URL`, `ERP_BASE_URL` e
  `RECEPS_INTERNAL_API_URL` com destinos locais inválidos antes de importar o
  brain.
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
