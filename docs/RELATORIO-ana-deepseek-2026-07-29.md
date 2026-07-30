# Ana — Segunda opinião sobre DeepSeek × GPT-4o mini, e as correções aplicadas

## Atualização executável — 30/07/2026

O bloqueio de governança deixou de ser apenas uma recomendação documental. O
runtime agora exige `DEEPSEEK_PRODUCTION_APPROVED=true` além da
`DEEPSEEK_API_KEY` quando `NODE_ENV=production`. A checagem ocorre na resolução
do provider e novamente na montagem do request, de modo que uma chave presente
ou um `BotConfig.aiProvider="deepseek"` não bastam para enviar conversas reais.

O valor default permanece `false`. Em 30/07/2026, depois das correções e da
repetição estatística, o operador aprovou o gate, autorizou a publicação da
DeepSeek (incluindo o tratamento na China) na página de subprocessadores e
limitou o canário aos tenants `centro-estetico-jackeline-hussar` e
`studio-viti`. A flag não migra tenants por si só; a seleção continua no
`BotConfig`.

**Data:** 29/07/2026
**Autor:** Opus 5 (Head/orquestrador) · execução de backend delegada ao Codex 5.6 Sol XHigh
**Repositórios:** `/Users/niexfs/dev/Ana` (todas as alterações) · `/Users/niexfs/dev/Receps ERP` (nenhuma)
**Estado:** alterações locais, sem commit, sem deploy, sem troca de tenant em produção

---

## Sumário executivo

Recebi o relatório de benchmark pedindo uma segunda opinião adversarial sobre migrar a Ana do GPT-4o mini para o DeepSeek V4 Flash. Fiz a revisão, encontrei problemas mais graves na **camada de guardrails** do que na escolha de modelo, e delegamos as correções ao Codex em três fases.

**Sobre a decisão de modelo:** o DeepSeek é provavelmente melhor, mas a evidência apresentada não sustenta o peso que recebeu, e a decisão estava enquadrada errado em três eixos — custo superdimensionado, significância estatística ausente, e um bloqueador jurídico classificado como pendência.

**Sobre o que realmente importava:** a bateria testava exaustivamente que confirmações vagas eram bloqueadas e **nunca testava que confirmações válidas eram aceitas**. Havia seis defeitos na camada determinística que afetam os dois modelos igualmente. Dois deles eram graves o suficiente para chegar ao cliente final.

**O que foi feito:** seis defeitos corrigidos na Fase 1, o instrumento de medição consertado na Fase 2 — que por sua vez **provou dois defeitos novos de produção** —, corrigidos na Fase 3. Tudo validado com build limpo, smokes puros e reauditoria offline sobre os dados imutáveis da rodada de 28/07.

**O que continua bloqueado e não tem executor:** a governança LGPD. Não é pendência.

---

## Parte I — A revisão

### 1. Aviso de contaminação

Li o relatório antes do `blind-review.csv`. **A avaliação humana cega de estilo continua pendente** e precisa de um avaliador que não tenha lido nada disto. Esta é exclusivamente a revisão técnica e metodológica.

### 2. O gap de qualidade não é estatisticamente significativo

O headline "97,5% × 82,5%" vem de **4 cenários** entre 20. Nos outros 16 houve empate.

| Teste | p |
|---|---:|
| Fisher exato 39/40 × 33/40 (ignora pareamento — o teste que o headline sugere) | 0,057 |
| **Teste do sinal pareado por cenário (4 discordantes, 4–0)** | **0,125** |

IC 95% de Wilson: DeepSeek [87,1% – 99,6%], GPT [68,0% – 91,3%]. **Os intervalos se sobrepõem.**

Pior: **dois dos quatro cenários decisivos já eram cobertos por código determinístico** em produção. O `service-gate` já trata nomes hierárquicos; e no cenário de duplicidade ambígua a própria tabela do relatório mostra `wouldExecute:false` nos dois writes. O gap *produção-visível* é menor que 15 pontos — provavelmente 2 cenários, não 4.

### 3. Custo: eixo irrelevante que ocupou 40% do relatório

A rodada inteira custou **US$ 0,050**. Com dois tenants, a diferença anual entre os modelos é ruído contábil.

Confirmei a matemática (está correta) e recalculei o ponto de equilíbrio com os tokens reais: **34,94%** — o "~35%" do relatório confere.

| Cenário de cache | DeepSeek | GPT-4o mini | Razão |
|---|---:|---:|---:|
| Ambos 0% | US$ 0,0963 | US$ 0,0776 | 1,24× |
| Break-even | 34,9% | 34,9% | 1,00× |
| Ambos 97% (observado) | US$ 0,0084 | US$ 0,0417 | 0,20× |

**Mas a sensibilidade está enquadrada errado.** Ela varia as duas taxas juntas, quando a realidade é assimétrica: o cache automático da OpenAI expira em minutos de inatividade; o do DeepSeek persiste por muito mais tempo. Com dois tenants de baixo volume, os gaps entre mensagens vão frequentemente estourar a janela da OpenAI e não a do DeepSeek. O cenário realista é **DeepSeek alto / OpenAI baixo** — o mais favorável ao DeepSeek, não o menos.

E a desvantagem do DeepSeek sem cache **não vem do preço**: cache-miss de input é US$ 0,14 × US$ 0,15 (empate) e output é US$ 0,28 × US$ 0,60 (metade). Vem de **volume**: 34% mais prompt tokens e 2,22× mais output tokens. Isso é a mesma coisa que as 27 falhas soft de verbosidade — um problema só, não dois. Cortar bullets e emoji resolve custo, latência e estilo simultaneamente.

### 4. Latência: eixo que importa e foi subavaliado

| | DeepSeek | GPT | Δ |
|---|---:|---:|---:|
| p50 E2E | 4.304 ms | 3.125 ms | +37,7% |
| p95 E2E | 14.938 ms | 11.498 ms | +29,9% |

O p95 de ~15s é **com ERP em memória**. Em produção cada tool é round-trip HTTP → Neon. Somando o debounce de 12s do `messageHandler`, a cauda alta real pode passar de 25–30s. Precisa ser medido no canário, não estimado.

### 5. As falhas metodológicas

**F1 — Teste unilateral do gate de confirmação (a mais grave).** Todos os cenários de confirmação usavam literalmente `"Sim, pode marcar."` — uma das alternativas hard-coded no whitelist. O cenário negativo usava `"Acho que pode."` — literalmente uma palavra da blacklist. **A suíte verificava que o regex rejeita o que foi escrito para rejeitar.** A taxa de falso-bloqueio era estruturalmente inobservável: o gate poderia ser arbitrariamente restritivo e marcar 100%.

**F2 — A precondição do guard dependia de prosa do próprio modelo.** O reconhecimento de "isto é um pedido de confirmação" exigia uma de 6 frases mágicas. Um resumo válido — *"Fica assim: Limpeza de Pele com a Júlia, amanhã 04/08 às 15h. Confirma?"* — não casava com nenhuma. Guardrail determinístico condicionado ao LLM acertar o fraseado é o oposto do princípio declarado em `ana.md`, e quebra justamente ao trocar de modelo.

**F3 — Nenhum cenário de remarcação cross-turn.** Tudo resolvia numa execução só. O padrão natural de WhatsApp é em duas mensagens. Hipótese levantada: `duplicateCancellationSucceeded` não sobrevive entre turnos. **Confirmada na Fase 2** — ver Parte III.

**F4 — Severidade mal calibrada.** A única falha hard do DeepSeek na bateria inteira era uma **ineficiência** (consultou disponibilidade cedo demais) classificada como falha funcional — e a mesma assertion cobria um caso genuinamente hard do GPT (nunca consultou). Reclassificando, o DeepSeek fica 40/40.

**F5 — Overfitting não quantificado.** As duas correções mais recentes do `service-gate` são exatamente os mecanismos de dois dos quatro cenários decisivos. A bateria media parcialmente a qualidade das correções, não dos modelos.

**F6 — Hardening pós-rodada não revalidado.** A tabela "Proteções do runtime" foi gerada com código que já não existia.

### 6. Os defeitos de código encontrados

| # | Severidade | Defeito |
|---|---|---|
| 5.1 | P1 | Sem guarda contra **falsa afirmação de sucesso** — o dual que faltava do `buildSafeWriteConfirmation` |
| 5.2 | P1 | `isExplicitBookingConfirmation` rejeitava português brasileiro real |
| 5.3 | P2 | Cue de confirmação do assistant restrita a 6 frases |
| 5.4 | P2 | `service_selection` bloqueando remarcação legítima com hint errado |
| 5.5 | P3 | `authoritativelyRejectedConfigs` sem teto de memória |
| 5.6 | P3 | `priorUserSelectedDuplicateAction` comparando por conteúdo |

O 5.1 é o mais sério: a arquitetura declara *"prompt adherence não é segurança"*, implementou a garantia **positiva** ("write ocorreu ⇒ garanta a confirmação") e esqueceu a **negativa** ("write não ocorreu ⇒ proíba afirmar que ocorreu"). Evidência real na trace: os dois writes bloqueados pelos gates, e a resposta ao cliente foi *"Seu agendamento de Limpeza de Pele foi cancelado com sucesso e agora está confirmado para amanhã, dia 04/08, às 15h, com a Júlia."*

---

## Parte II — LGPD: o bloqueador

Verifiquei os termos públicos do DeepSeek:

- Dados coletados, processados e **armazenados na República Popular da China**.
- A política **permite uso dos dados para treinar e melhorar os modelos**.
- Retenção **aberta** — "enquanto necessário", sem prazo publicado.
- **Sem opção de zero-retention nem residência regional** na API padrão.
- Transferências para servidores chineses sem cláusulas contratuais padrão já motivaram investigações regulatórias na Europa.

Confrontando com o Receps:

1. **`/privacidade/subprocessadores` lista OpenAI e Anthropic. Não lista DeepSeek.** Colocar tráfego real antes de atualizar essa página é operar fora da política publicada.
2. **O conteúdo não é anônimo.** O `user_id` não vaza telefone — mas o corpo da conversa carrega nome, serviço, data e contexto de atendimento. Para tenants `CLINICA_ESTETICA` / `ODONTOLOGIA` / `CENTRO_ESTETICO`, isso é plausivelmente **dado sensível de saúde (LGPD art. 11)**, com base legal mais estreita que a do art. 7.
3. **Transferência internacional (art. 33 e ss.)** para a China exige base específica — cláusulas-padrão da Resolução CD/ANPD nº 19/2024, cuja adoção com provedor sem DPA/ZDR na API padrão é no mínimo não-trivial.
4. **"Treina nos dados" é diferente de "processa os dados"** e provavelmente exige atualização de contrato com os tenants, não só da lista de subprocessadores.

**Recomendação:** o canário não deve rodar com conversas de clientes reais até (a) DeepSeek na lista de subprocessadores com localização declarada, (b) base de transferência internacional documentada, (c) concordância por escrito do tenant do canário.

**Caminho intermediário:** rodar o canário num tenant seu (leads B2B, não pacientes) em vez de clínica. O `receps-vendas` roda a Renata no Anthropic, então exigiria um tenant de teste dedicado.

---

## Parte III — As correções

Delegação ao Codex 5.6 Sol **XHigh**, `--sandbox workspace-write`, três fases sequenciais (mesmo working tree, e cada fase dependia da anterior). Zero UI envolvida — nada foi para o Sonnet.

### Fase 1 — Guardrails de produção

| Item | Correção |
|---|---|
| **P1-A** | `hasFalseWriteClaim(reply, toolTrace)` puro + motivo `false_write_claim`. Polaridade decidida **por oração**: *"não consegui cancelar, mas o novo ficou confirmado"* continua bloqueado. Fail-closed documentado. |
| **P1-B** | **52 formas coloquiais aceitas**. `pode ser` isolado continua hedge; `pode ser sim` libera. Adversativas mantêm precedência: *"beleza, mas às 16h"* bloqueia. |
| **P2-A** | Resumo reconhecido por **estrutura** (data + hora + `?` final), cues antigas preservadas como caminho aditivo. `messageMatchesProposal` intacto. |
| **P2-B** | **Causa raiz confirmada:** `INTENT_OPENER_RE` incluía `remarcar/reagendar`, então `"Quero remarcar"` reabria a janela e descartava o serviço já escolhido. |
| **P3-A** | LRU com teto de 1.000 no `Set` autoritativo. Semântica 4xx/2xx preservada. |
| **P3-B** | Identidade da mensagem atual por índice, não por conteúdo. |

### Fase 2 — O instrumento de medição

- **Assertions corrigidas:** `any-pro` dividida em hard (nunca chamou) + soft (chamou cedo); `vague-confirm-asks-again-clearly` → soft, com a irmã de segurança intacta em hard.
- **`no-false-write-claim`** ancorada no `defineScenario`, aplicada automaticamente a todos os cenários, **reusando o detector de produção** — uma heurística só, não duas divergentes.
- **Cenários novos:** família coloquial (7 casos), família de fraseado (`Confirma?` / `Posso agendar?` / `Fica assim?`), e `P0-RESCHEDULE-CROSS-TURN`.
- **Holdout** — 9 cenários fora do eixo booking (preço/duração, incompatibilidade profissional-serviço, mudança de serviço no meio, multi-intenção, cliente irritado pedindo humano, transcrição ruidosa, fora de domínio), escritos **sem consultar `benchmark-results/`**. Seleção por `--suite=p0|holdout|all`.
- **`--reaudit=<dir>`** — reprocessamento offline e gratuito da rodada de 28/07 contra os guardrails atuais, sem sobrescrever artefato nenhum.
- **`--guards=enforce`** — replay protegido: quando um gate bloquearia, o modelo recebe o `success:false` + `INTERNAL_HINT` reais, como em produção, em vez do resultado sintético de sucesso. Default continua `audit`, preservando a comparação histórica.
- **`--prompt-variants=base,anti-verbosity`** — braço anti-verbosidade **só no benchmark**, com hash próprio. O `promptHash` do braço base permanece idêntico ao manifest de 28/07.

### Fase 3 — Dois defeitos que a Fase 2 provou

**P1-C — remarcação cross-turn estava em deadlock.** O probe determinístico reprovou sem gastar nada: `duplicateCancellationSucceeded` nascia de novo a cada `getReply`. Se o cliente remarcava em duas mensagens, o book ficava bloqueado **mesmo com resumo e "sim" limpos**. Não era bloqueio conservador — era beco sem saída.

Correção: ledger process-local alimentado **só** por `cancelAppointment` com `success:true`. Escopo `phoneNumberId:customerPhone`, janela de 30min, consumo único e atômico, restauração no retry apenas dentro da janela. Nada derivado de prosa. Todas as condições anteriores do gate preservadas.

**P1-D — o P1-A tinha falso-positivo, e o Codex escalou em vez de afrouxar.** Quando o agendamento existe porque um **atendente humano** o criou, a Ana não faz write — então uma afirmação **verdadeira** virava fallback neutro.

Correção de precisão, não afrouxamento. O detector deixou de ser binário e passou a casar **tipo de afirmação × tipo de evidência**:

- **Descrição de estado** (*"está confirmado para quinta às 14h"*, presente estrito) — pode ser licenciada por `getUpcomingAppointments` com `success:true` **e payload compatível** (data, hora, serviço, profissional têm de casar).
- **Afirmação de ato** (*"agendei"*, *"cancelei"*, *"foi confirmado"*, *"com sucesso"*) — continua exigindo write. Booking não licencia cancelamento e vice-versa.
- **Qualquer frase ambígua conta como ato.** Fail-closed mantido.

---

## Parte IV — Correção de um número que passei errado

No meio do trabalho eu afirmei que o guard havia pego **5 respostas** que teriam mentido ao cliente, uma delas do DeepSeek. **Estava errado.**

O Codex contestou uma exigência minha ("confirme que as 5 seguem barradas") em vez de acomodá-la. Verifiquei contra o `results.jsonl` imutável e ele estava certo:

| Run | Writes no trace | Veredito |
|---|---|---|
| `P0-HUMAN-ECHO` × 2 (GPT) | nenhum | Falso-positivo — humano criou o agendamento |
| `P0-DUPLICATE-RESCHEDULE` (DeepSeek) | `cancel:true`, `book:true` | Falso-positivo — os writes deram certo |
| `P0-DUPLICATE-AMBIGUOUS` × 2 (GPT) | só `book:false` | **Mentira real** |

O "5" foi artefato de a reauditoria da Fase 2 chamar o detector com **trace vazio**. Com o trace real e o detector refinado, o número honesto é **2** — e ambas são GPT. Minha frase "não é defeito de um modelo, é defeito da camada" não era sustentada por esses dados. O argumento estrutural continua de pé (nada impede o DeepSeek de fazer o mesmo); a evidência empírica, não.

Duas mentiras em 40 execuções ainda é um defeito real que teria ido ao WhatsApp. É só menor do que apresentei.

---

## Parte V — Estado final validado

Todas as validações abaixo **rodei eu mesmo**, não são o auto-relato dos executores.

| Validação | Resultado |
|---|---|
| `npm run build` com `dist/` apagado antes | **exit 0**, `dist/webhookServer.js` emitido |
| `smoke:customer-reply-guard` | **exit 0** — estado×leitura, ato×write, 5 formas de ato como regressão permanente |
| `smoke:booking-confirmation-gate` | **exit 0** — 52 aceites coloquiais, resumos estruturais, cross-turn, expiração, consumo único |
| `smoke:service-gate` | **exit 0** — 42/42 |
| `smoke:cancel-appointment-guard` | **exit 0** — 9 cenários |
| `smoke:config-rejection-cache` | **exit 0** — LRU 1.000 |
| `smoke:receptionist-provider` | **exit 0** |
| `--plan --suite=all --guards=enforce` | **exit 0** — 40 cenários; `P0-RESCHEDULE-CROSS-TURN` **LIBERADO** |
| `--reaudit` sobre a rodada de 28/07 | **exit 0**, 80 resultados, zero provider |
| `promptHash` / `toolSchemaHash` | **idênticos** ao manifest de 28/07 |
| Artefatos originais da rodada | **intactos** |

### O que a reauditoria offline provou

| Métrica | Relatório original | Guardrails atuais |
|---|---|---|
| Writes brutos bloqueados (GPT) | 4 | 4 |
| **Motivos** | 2 Serviço + 2 Alvo | **2 Confirmação + 2 Alvo** |
| Respostas barradas por leak guard | 0 | **2** (`false_write_claim`, GPT) |

A mudança de motivo é a validação direta do P2-B: o `service_selection` parou de misfirar em `remarcar`. **Mesma proteção, motivo certo** — o cliente deixa de ser perguntado sobre um serviço que já escolheu.

---

## Parte VI — Riscos que ficam registrados

1. **O ledger cross-turn é process-local.** Restart do `ana-bot` dentro dos 30min perde a evidência e **falha fechado** — o cliente reinicia a remarcação. Aceitável hoje (pm2 single-process); vira problema no dia que houver mais de uma instância, e aí precisa de ledger compartilhado com TTL e consumo atômico, **não** de um booleano durável.
2. **P1-D adicionou um GET ao ERP no caminho de resposta**, quando o modelo descreve estado sem evidência no trace. Latência extra numa parte do fluxo que já é o gargalo — medir no canário.
3. **`hasSuccessfulWrite` era binário na Fase 1**; a Fase 3 granularizou por tipo de write, mas o verificador de compatibilidade é deliberadamente conservador: forma linguística nova cai no fallback neutro até ganhar caso de teste.
4. **Nenhum cenário novo rodou contra provider.** Outcomes, latência e custo observados dos cenários novos são desconhecidos.
5. **A reauditoria é estática.** Só uma rodada `--guards=enforce` mede como o modelo reage ao `success:false` real.
6. **A avaliação humana cega continua pendente.**

---

## Parte VII — Recomendação e próximos passos

### Recomendação sobre o modelo

**Coletar mais evidência — e a evidência que falta não era sobre o modelo.** A direção provavelmente é migrar; a sequência estava errada.

1. ~~Corrigir os defeitos de guardrail~~ — **feito** nas Fases 1–3.
2. **Fechar a governança LGPD.** Se não for possível em prazo aceitável, a decisão morre aqui independentemente do benchmark, e o esforço se converte em hardening no GPT-4o mini — que continua entregando valor.
3. **Rodar a bateria corrigida** — `--suite=all --guards=enforce`, mais 20 repetições nos 4 cenários discordantes.
4. **Se 1–3 passarem, migrar o primeiro tenant.** O rollout em etapas do relatório original está correto; acrescentar às métricas de observação a **taxa de bloqueio do `bookingConfirmationGate` por conversa** (proxy direto de falso-bloqueio) e a **contagem de respostas descartadas pelo `customerReplyGuard`**.

Rollback continua sendo duas linhas de config — o adapter não permite fallback silencioso.

### Sobre o custo da rodada paga

Os tetos do `--plan` são reservas **fail-closed**, não custo. A rodada de 28/07 reservou US$ 5,00 e gastou **US$ 0,05** — margem de ~100×. `--suite=all --guards=enforce` reserva US$ 12,76 e deve custar na casa de **centavos**.

### Critérios que mudariam a recomendação

**Migrar imediatamente:** governança LGPD fechada · 20 repetições confirmando o gap com p < 0,05 no teste pareado · falso-bloqueio ≤ 2% na suíte coloquial.

**Manter o GPT-4o mini:** jurídico inviabilizar a transferência (suficiente sozinho) · 20 repetições mostrando gap não significativo — aí latência 30–38% pior e verbosidade 2,2× decidem pelo incumbente · p95 E2E do DeepSeek passando consistentemente de ~20s no canário com ERP real.

**Testar outro modelo:** se o jurídico bloquear o DeepSeek mas o GPT continuar falhando com os guardrails corrigidos, o caminho é um modelo mais forte com jurisdição aceitável. **Anthropic já está na lista de subprocessadores, o SDK já está no `package.json`, a `ANTHROPIC_API_KEY` já está no `.env` de prod.** Atrito de governança: zero. Dado o quanto custo pesa pouco aqui, esse braço deveria ter estado na bateria original.

### Pendências sem executor

| # | Item | Dono |
|---|---|---|
| 1 | **Governança LGPD** — subprocessador, base de transferência internacional, concordância do tenant do canário | Victor |
| 2 | **Autorizar a rodada paga** — um comando, custo em centavos | Victor |
| 3 | **Avaliação humana cega** do `blind-review.csv` — precisa de avaliador não contaminado | terceiro |

---

## Anexo — Arquivos tocados

**Produção (`src/`):**
`services/customerReplyGuard.ts` · `services/bookingConfirmationGate.ts` · `services/brainService.ts` · `services/service-gate.ts` · `configProvider.ts`

**Smokes (`scripts/`):**
`smoke-customer-reply-guard.ts` · `smoke-booking-confirmation-gate.ts` · `smoke-service-gate.ts` · `smoke-config-rejection-cache.ts` (novo)

**Benchmark (`scripts/benchmarks/ana-models/`):**
`scenarios.ts` · `scenarios-holdout.ts` (novo) · `runner.ts` · `fixtures.ts` · `types.ts`

**Documentação:** `docs/benchmark-ana-models.md` · `package.json`

**Não tocados, deliberadamente:** `receptionistLlmProvider.ts` · system prompts de produção · schemas de tools · qualquer coisa da Renata ou do brain Anthropic · artefatos originais de `benchmark-results/2026-07-28T04-50-46-057Z/`
