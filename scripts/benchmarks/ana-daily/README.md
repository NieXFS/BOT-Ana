# Harness cotidiano DeepSeek da Ana

Validação comportamental **real** do `deepseek-v4-flash` para:

- (A) classificador de retomada — thinking `enabled`, sem tools, JSON
- (B) recepcionista — thinking `disabled`, tools em fixtures sintéticas

Não usa mock de LLM, OpenAI nem WhatsApp/ERP/Postgres reais. Artefatos em
`benchmark-results/ana-deepseek-daily/` (gitignored).

```bash
npx tsx scripts/behavioral-ana-deepseek-daily.ts --plan
npx tsx scripts/behavioral-ana-deepseek-daily.ts --max-cost-usd 8
npx tsx scripts/behavioral-ana-deepseek-daily.ts --ids=B01-boa-tarde-contaminado --repeats 1
```

Exige `DEEPSEEK_API_KEY` no ambiente. Em `NODE_ENV=test` o gate
`DEEPSEEK_PRODUCTION_APPROVED` não é necessário. Sentry DSN é forçado vazio.
