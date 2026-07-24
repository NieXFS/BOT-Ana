# Briefing — nova conversa dedicada à Ana (bot WhatsApp da Receps)

> Cole isto no início de uma sessão nova. Leia até o fim antes de me responder. No fim tem o espaço pra eu escrever o problema específico.

## Quem sou e o que é a Ana
Sou Victor Hugo Pedroza da Silva, solo founder do **Receps** — SaaS multi-tenant em pt-BR para estabelecimentos de beleza/saúde (salões, clínicas estéticas, barbearias). Operado como MEI.

A **Ana** é o atendente IA do Receps no WhatsApp — projeto irmão do dashboard. Ela atende clientes finais (consumidores do salão) pelo WhatsApp Business da empresa cliente: marca/cancela atendimentos, responde dúvidas sobre serviços, confirma horários.

Estado: Receps em pré-launch (sem cliente pagante), mas a Ana já está **multi-tenant em prod** com **Embedded Signup + Coexistence** funcionando end-to-end (cada cliente conecta o próprio WhatsApp Business via OAuth e a Ana atende automaticamente).

## Arquitetura
Stack: Node.js · `@sentry/node` · OpenAI SDK (`gpt-4o-mini` com function calling) · WhatsApp Cloud API (Meta, webhook + Graph API).

Onde vive:
- Local (Mac): `/Users/niexfs/dev/Ana` (repo `NieXFS/BOT-Ana`)
- Prod: VPS Hetzner `root@46.62.134.25` em `~/Ana`; processo `pm2 ana-bot` na porta **3001**
- O Receps roda na MESMA VPS (`/var/www/RecepsERP`, `pm2 RecepsERP` :3000); a Ana fala com ele em `localhost:3000`

Fluxo: cliente manda msg → Meta dispara webhook → Ana identifica o tenant pelo `phoneNumberId` → busca token/config desse tenant no Receps → monta histórico + system prompt → `gpt-4o-mini` decide responder texto OU chamar uma das 4 tools → tools batem na API interna do Receps → Ana responde no WhatsApp via Graph API com o token do tenant.

Tools (function calling — o que a Ana sabe fazer): `getServices`, `getAvailableSlots`, `bookAppointment`, `cancelAppointment`. System prompt anti-alucinação: nunca inventa preço/horário, sempre consulta tool antes de afirmar disponibilidade, `professionalId: null` quando o cliente não escolhe (auto-resolve no serviço do Receps), quando duvida pergunta.

Arquivos-chave: `src/services/brainService.ts` (system prompt + tools + loop do getReply) · `src/services/calendarService.ts` (as 4 tools → API do ERP) · `src/messageHandler.ts` (debounce/buffer, flush, checagem de pausa, fora-de-horário) · `src/echoHandler.ts` (`smb_message_echoes`) · `src/services/contextManager.ts` (histórico em Postgres) · `src/services/pauseService.ts` + `pauseDecision.ts` (estado de pausa vindo do Receps) · `src/services/conversationActivity.ts` + endpoint `/internal/conversation-activity` · `src/webhookServer.ts` (Express) · `src/observability/scrub.ts` (PII) · `src/configProvider.ts`.

## Restrição operacional (importante)
A Ana só roda de verdade em **PRODUÇÃO** (o webhook da Meta exige URL pública HTTPS; local não recebe mensagem). Local serve só pra **smoke programático** (funções puras via `npx tsx` + `npm run build`/tsc).

## Workflow de mudança que eu prefiro
Mudança na Ana = **UM único agente Claude Code** que faz tudo num go:
1. Edita o código local em `~/dev/Ana`.
2. Valida: `npm run build` (tsc) + smokes (`npx tsx scripts/smoke-*.ts`).
3. Deploya na VPS (rsync do `src/`+`scripts/`+`package.json` excluindo `.env`/`node_modules`, ou git — sua escolha) → `npm install` se preciso → `npm run build` → `pm2 restart ana-bot` → `pm2 logs`.
4. **Pode commitar e deployar** (git liberado pra Ana) e **pode testar sozinho se passando por um cliente** (não preciso testar manual no WhatsApp).
- NÃO usar Codex pra Ana — é território do Claude Code, num prompt único.

## Convenções de prompt pro Claude Code (Ana)
- Todo prompt termina com um bloco **"Validação final"**: build (tsc) + smokes + verificação operacional (logs do PM2 / self-test).
- Pedir pra **encerrar** qualquer dev server que subir (sem processo zumbi na 3001).
- **NUNCA** logar/expor secrets. Antes de `pm2 env`/`cat .env`/`printenv`, avisar pra não colar output em claro.
- **Patches focados**, não refactor grande. Considerar **custo de tokens** (pré-launch, margem apertada no `gpt-4o-mini`).
- Sempre pedir pra **atualizar o AGENTS.md** no fim com convenções/gotchas/modelos novos (ele é auto-carregado; não pedir pra ler).
- Git é OK nos prompts da Ana (o Claude Code commita/deploya). (A regra de "sem git" vale só pros prompts do Receps.)

## Convenções da Ana
- **PII rigorosa** (`src/observability/scrub.ts`): `RE_EMAIL` (sem catastrophic backtracking), `RE_BR_PHONE` (aceita `(11) 99999-8888`, `+55 11...`, `11999998888`), `RE_E164`, cap `MAX_SCRUB_TEXT=2000` contra ReDoS. NUNCA logar telefone cru, nome completo, ou conteúdo de mensagem. Sentry só com tags técnicas (`tenantId`, `phoneNumberId` do NEGÓCIO, model, latência) — PII nunca vai pra tag.
- Modelo `gpt-4o-mini` (econômico). Trocar pra `gpt-4o` é 10x mais caro — experimentar com cuidado.
- Usa **npm**.
- **Coexistence**: o cliente usa o app do WhatsApp Business no celular + a Ana usa a Cloud API ao mesmo tempo; histórico sincroniza; throughput 20 msg/s.
- **Janela CSW (24h)**: cliente iniciou → respostas dentro de 24h são grátis; fora, só template pago. Ana responde dentro da CSW.
- **`smb_message_echoes`**: webhook do Coexistence com as mensagens que o HUMANO manda pelo app. A Ana usa isso pra (a) pausar a conversa quando o humano assume e (b) gravar o que rolou (ver pausa abaixo).

## Feature de pausa + escuta-enquanto-pausada (recente — não regredir)
- **Pausa por conversa**: quando o humano responde pelo app (echo) OU pausa manual, a Ana fica calada naquela conversa. Há também pausa GERAL do salão e um `echoPauseMinutes` (auto-pausa por X min). O **estado de pausa mora no Receps** (`/api/v1/bot/pause-state`); a Ana consome via `pauseService`.
- **Escuta-enquanto-pausada**: pausada, a Ana NÃO responde mas **grava** — inbound do cliente como `user`, e o echo do humano como `assistant` com prefixo `[atendente] `. Assim, ao retomar, ela tem o contexto da conversa que rolou na pausa.
- **Endpoint `/internal/conversation-activity`** (Bearer = token compartilhado com o Receps): devolve `{ ultimoInboundSemResposta, ultimaAtividadeEm, fluxoAtivo }`. **O Receps depende disso** (guarda de "bom momento" das automações de marketing) — se mexer aqui, lembrar que quebra o Receps.

## Bugs históricos resolvidos (pra não cair de novo)
1. `professionals[0]` como default → auto-resolve pra primeira profissional ELEGÍVEL E LIVRE quando `professionalId` é omitido (`bookAppointmentForBot`).
2. `getAgendaAvailabilityForBot` não consultava `scheduleBlock` → corrigido (não mostra como livre horário bloqueado).
3. ReDoS no scrub (`RE_EMAIL` O(n²)) → regex reescrita + cap de 2000 chars.
4. Formatos de telefone humano passando pelo scrub → `RE_E164`/`RE_BR_PHONE` estendidos.
5. Smoke quebrando por import ESM sem extensão → runner `npx tsx`.
6. **Saudação dobrada** em 1º contato (`maybePrependGreeting` + modelo saudavam) → `replyAlreadyGreets` pula o prepend quando a resposta já saúda.
7. **Aviso de fora-de-horário** repetindo a cada msg → `shouldSendOutsideHoursNotice` (throttle 4h por conversa).
8. **Elegibilidade prof↔serviço**: o `/api/v1/agenda/info` do ERP agora expõe `professionalIds` por serviço; a Ana lista profissionais POR serviço (0 → avisa indisponível; 1 → agenda direto, marcador "profissional único"; 2+ → pergunta).

## Onde debugar
- Logs PM2: `ssh root@46.62.134.25 "pm2 logs ana-bot --lines 200 --nostream"` (cuidado com PII).
- Sentry: projeto da Ana (tags técnicas, sem PII).
- Banco do Receps: agendamentos criados pela Ana têm `source = "AI"`.
- Teste real: o Claude Code pode se passar por cliente (não preciso fazer manual).

## O que preciso de você nessa conversa
[ESCREVE AQUI O PROBLEMA ESPECÍFICO]

Provavelmente vou trazer: print de conversa real onde a Ana errou (PII tarjada), trecho de log do PM2 do turno problemático, e minha hipótese. Te peço pra: **ler o código da Ana antes de propor fix** (pedir acesso a `~/dev/Ana`), propor **patch focado** (não refazer system prompt inteiro por 1 edge case), considerar **custo de tokens**, e **documentar o bug + fix** (AGENTS.md da Ana / memória) pra próxima sessão não cair no mesmo.
