# AGENTS.md — Ana (bot WhatsApp de agendamento)

Bot de atendimento via WhatsApp Cloud API que conversa com o cliente (OpenAI, function calling) e agenda no ERP **Receps** via HTTP (`/api/v1/agenda/*`). Prod: VPS `root@46.62.134.25` em `~/Ana`, processo pm2 **ana-bot** (porta **3001**). O Receps roda na MESMA VPS em `localhost:3000`. Auth Ana→Receps: `Authorization: Bearer <ERP_API_TOKEN>` (= `AI_BOT_API_KEY` do Receps; ver `src/erpApiToken.ts`).

## Deploy (SEM git)
Sincroniza por rsync e builda na VPS:
```
rsync -avz --exclude node_modules --exclude dist --exclude .env --exclude .git ~/dev/Ana/ root@46.62.134.25:~/Ana/
ssh root@46.62.134.25 "cd ~/Ana && npm install --no-audit --no-fund && npm run build && pm2 restart ana-bot"
```
`npm run build` é só `tsc` (saída em `dist/`, `start` roda `dist/webhookServer.js`).

## Smokes (determinísticos, sem rede/OpenAI/DB)
Rodados com `npx tsx`. Padrão pós-ESM: setar `process.env.DATABASE_URL`/`OPENAI_API_KEY` dummy ANTES de carregar o módulo (o `contextManager` LANÇA no load sem `DATABASE_URL`; o `Pool` do pg é lazy, não conecta), usar `import type` pros tipos e `await import()` dinâmico pro módulo real. Lista em `package.json` (`smoke:*`).

## PII / scrub
NUNCA logar PII em claro nem colar telefone/nome/mensagem crus. O Sentry tem scrub (`src/observability/scrub.ts`) por chave E em strings livres (`event.message`, exceptions, breadcrumbs). Ao acompanhar `pm2 logs ana-bot`, redija telefone/nome ao reportar.

## Fixes registrados

### FIX 1 — Saudação dobrada no 1º contato (`src/services/brainService.ts`)
A **saudação de boas-vindas é da PRÓPRIA Ana** (não do ERP): no 1º contato, `maybePrependGreeting` colava `config.greetingMessage` ("Olá! Sou a Ana... Como posso te ajudar hoje?") na frente da resposta, mas o modelo TAMBÉM saudava → "Como posso ajudar" duplicado. O guard antigo (`reply.includes(greeting)`) só pegava match exato da string inteira. Agora há `replyAlreadyGreets(reply)` (PURO, exportado): normaliza os ~80 primeiros chars (lowercase, sem acento) e retorna true se baterem padrões de saudação (`ola`/`oi`/`bom dia`/`boa tarde`/`boa noite`, com fronteira de palavra) OU `como posso ... ajudar`. `maybePrependGreeting` pula o prepend quando `replyAlreadyGreets` é true; continua prependando quando a resposta NÃO saúda (ex.: cliente pergunta preço direto). Smoke: `smoke:greeting-prepend`.

### FIX 2 — Aviso de fora-de-horário sem throttle / spam (`src/messageHandler.ts`)
O **aviso de fora-de-horário também é da PRÓPRIA Ana** (`buildOutsideHoursMessage`, montado a partir de `botActiveStart`/`botActiveEnd`). Quando `isBotActive` é false, o handler mandava o aviso 1x POR mensagem recebida (sem dedup) → 3 mensagens iguais seguidas no teste real. Agora há `shouldSendOutsideHoursNotice(bufferKey, now?)` (PURO, exportado) com um `Map` "suprimido até" (mesmo padrão do `flushRecoveryUntil`), janela `OUTSIDE_HOURS_NOTICE_WINDOW_MS = 4h`. Só envia o aviso se a função autorizar (e ela marca o timestamp ao autorizar). Chave = `bufferKey` (`phoneNumberId:from`). O `Map` é limpo em `__resetFlushStateForTest`. Smoke: `smoke:outside-hours-throttle`.

### FIX 3 — Elegibilidade profissional↔serviço (`calendarService.ts` + `brainService.ts`)
**Fonte de elegibilidade por serviço = `services[].professionalIds` do ERP** (`/api/v1/agenda/info`): array de ids dos profissionais habilitados PRA CADA serviço. A Ana consome isso pra só ofertar/agendar com profissional que atende o serviço escolhido. **Tolerante ao campo ausente** (ERP antigo): sem ele, mantém o comportamento antigo (lista global).
- `calendarService.ts`: `ErpService.professionalIds?: (string|number)[]`; `ServiceSummary.professionalIds?: string[]`; `normalizeServices` mapeia pra `string[]` SÓ quando presente (senão `undefined`). Tipos `ServiceSummary`/`ProfessionalSummary`/`ServicesResult` exportados. Defesa em profundidade: no catch de `getAvailableSlots`, erro axios 400 cuja msg case com `/não pode realizar|não está ativo/i` → `INTERNAL_HINT` específico (profissional não atende o serviço; oferecer outro habilitado), nunca repassado ao cliente.
- `brainService.ts`: `buildServicesBlock(servicesResult)` (PURO, exportado) monta o bloco de serviços do system prompt. Modo elegibilidade (quando há `professionalIds`): lista "Profissionais habilitados" POR serviço (interseção com a lista global ativa) com nome + id; interseção vazia → marca "NENHUM no momento" (não ofertar/agendar); NÃO repete o bloco global "PROFISSIONAIS DISPONÍVEIS" (economia de tokens). Fallback (sem `professionalIds`): formato antigo (lista global + bloco "PROFISSIONAIS DISPONÍVEIS"). Regra de fluxo **C (ESCOLHA DO PROFISSIONAL)** reescrita pra usar o set POR SERVIÇO: 0 habilitados → avisa sem profissional e oferece outro serviço; 1 → agenda direto sem perguntar; 2+ sem escolha → pergunta "específico ou tanto faz?" ("tanto faz" → bookAppointment SEM professionalId, auto-resolve). Smoke: `smoke:services-block-eligibility`.

#### Marcador de "profissional único" (adesão do mini à regra C(b))
No self-test pós-FIX 3, o gpt-4o-mini ignorava a regra C(b) ~1 em 4: perguntava preferência de profissional MESMO quando o serviço tinha só 1 habilitado. Os dados/filtragem estavam certos — era adesão do modelo. Fix: em `buildServicesBlock` (modo elegibilidade), quando a interseção (habilitados ∩ global ativa) tem **exatamente 1**, a linha do serviço vira um marcador IMPERATIVO inline em vez do rótulo plural: `Profissional único habilitado: <Nome> — id: <id>. Agende DIRETO com ele(a); NÃO pergunte preferência de profissional.` Instrução colada na própria linha do serviço cola muito melhor no mini do que a regra C genérica lá embaixo (que segue intacta, como backup). 2+ habilitados → formato plural normal; 0 → aviso "NENHUM no momento". Smoke cobre os 3 ramos (1/2+/0). Resultado medido (studio-viti, 1 habilitado, self-test de 20 turns "quero Peeling"): perguntas de preferência caíram de ~1/4 pra ~1/20 (5%).

> Contraparte no Receps: `getAgendaInfoForBot` (`src/services/agenda-api.service.ts`) expõe `services[].professionalIds` de forma aditiva. Ver AGENTS.md do Receps.

### FIX 4 — Pausa da Ana (echo humano + checagem de pausa) (2026-06-22)
A Ana **fica calada** quando a CONVERSA ou o SALÃO estão pausados, e **se pausa sozinha** quando o humano responde pelo app do WhatsApp (echo). O **Receps é a fonte da verdade** da pausa; a Ana só consome 2 endpoints (auth `Bearer ERP_API_TOKEN`, base `RECEPS_INTERNAL_API_URL`, padrão do `optOutService`). **Mudança ADITIVA e FAIL-OPEN**: se a API de pausa falhar/timeout/404, a Ana age como antes (responde normal). **Nunca loga PII** (só `phoneNumberId` nas tags Sentry, nunca número/nome do cliente).

- **Endpoints consumidos** (`src/services/pauseService.ts`):
  - `GET /api/v1/bot/pause-state?phoneNumberId=&customerPhone=` → `{ globalPausedUntil, conversationPausedUntil }` (ISO|null; passado/null = não pausado).
  - `POST /api/v1/bot/pause-conversation { phoneNumberId, customerPhone, source: "echo" }` → `{ pausedUntil }` (o ERP aplica o `echoPauseMinutes` do tenant).
- **Echo (`smb_message_echoes`, Coexistence)** — `src/echoHandler.ts` + branch novo no `src/webhookServer.ts`: o POST `/webhook` agora ramifica por `change.field`. `field === "smb_message_echoes"` → `handleSmbMessageEchoes` (NÃO vai pro `handleIncomingMessage` — não é mensagem de cliente); senão segue o caminho `value.messages` de sempre. Parser PURO `parseEchoTargets(value, fallbackPhoneNumberId?)`: shape da Meta = `value.metadata.phone_number_id` + `value.message_echoes[]` com `from`(salão)/`to`(**cliente**) → o número a pausar é o **`to`**. Como a Ana envia pelo Cloud API (não pelo app), **todo** echo = ação humana → pausa (não filtra por type; o mais simples/seguro). Defensivo: ignora payload sem `phone_number_id`/`to`; deduplica por cliente. Pra cada alvo chama `pauseConversationByEcho` (POST acima) **e** escreve no cache local na hora.
- **Checagem antes de responder** — `src/messageHandler.ts`, em `handleIncomingMessage` DEPOIS do `tryHandleOptOut` (opt-out/compliance vale mesmo pausado) e ANTES do `conversationTracker.markActive`/buffer: `if (await isConversationPaused(config.phoneNumberId, from)) return;` (sem OpenAI, sem buffer; log sem PII). **Não grava no histórico enquanto pausado** (os echoes do humano não entram no histórico da Ana → registrar só o lado do cliente confundiria o contexto na volta; mais simples ficar 100% em silêncio).
- **Cache** (`pauseService`): por conversa (`phoneNumberId:customerPhone`, mesma forma do `bufferKey`). TTL curto do GET (`PAUSE_STATE_TTL_MS = 25s`) → 1 GET cobre uma rajada e reflete pausas do painel em ~25s. O echo faz **write-through imediato** (Ana respeita a pausa já na próxima mensagem, sem esperar o GET); se o POST de echo falhar, aplica pausa local **otimista** (`ECHO_LOCAL_FALLBACK_MS = 60min`) pra não falar por cima do humano. Decisão PURA isolada em `src/services/pauseDecision.ts` (`isActivePause`/`isPausedFromState`).
- **Smokes**: `smoke:pause-decision` (helper puro: futuro=pausado, passado/null/inválido=ativo, global vs conversa) e `smoke:echo-handler` (parser extrai `phoneNumberId`+`to` do payload da Meta e dispara a pausa com deps mockadas; malformado=noop).

> Contraparte no Receps: model `ConversationPause` + `BotConfig.botPausedUntil`/`echoPauseMinutes` + os 2 endpoints `pause-state`/`pause-conversation`. Ver AGENTS.md do Receps ("Pausa da Ana — contrato"). **Requer os endpoints no Receps de PRODUÇÃO** (mesma VPS, `localhost:3000`) — sem eles, a Ana cai no fail-open (responde normal).
