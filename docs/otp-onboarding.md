# OTP transacional e roteamento de onboarding

Contrato implementado na branch `codex/otp-onboarding`. Esta onda não gera,
armazena nem valida códigos; não altera a Ana e não publica o runtime.

## Assento existente: mapeamento e extensão

O cérebro de onboarding **já existia** antes desta onda:

- `src/services/onboardingBrain.ts`: brain e toolset de configuração;
- `src/services/onboardingSession.ts`: consulta/reivindicação da sessão no ERP;
- `src/services/brainService.ts`: ponte por conversa dentro do ramo `sales`;
- `BotConfig.botRole` continua `sales`; não existe nem deve existir um segundo
  `botRole` ou um segundo brain para o mesmo número;
- tenant e número continuam sendo os da Renata (`receps-vendas`). Voz, typing,
  pause/takeover e demais gates de sales permanecem os mesmos.

Esta onda **estende somente a fronteira do dispatcher**. O helper puro
`resolveConversationBrainRole` agora recebe o estado autoritativo devolvido pelo
ERP (`open | none | blocked | unavailable`) e é usado pelo caminho real de
`getReply`, em vez de existir apenas como documentação de smoke.

### Precedência por conversa

1. `botRole !== "sales"` → recepcionista/Ana; esta ponte não participa.
2. pausa/takeover ativo → silêncio; nem claim é tentado.
3. claim de onboarding presente:
   - aceito pelo ERP → assento `onboarding` no mesmo turno;
   - rejeitado → resposta determinística de claim; nunca cai em vendas.
4. sem claim, `GET /api/v1/bot/onboarding/session` resolve o estado do telefone:
   - `open` (usuária em onboarding/trial com sessão aberta) →
     `onboardingBrain` existente;
   - `none` (nenhuma sessão de onboarding aberta; conversa de lead) →
     `salesBrain`/Renata existente;
   - `blocked | unavailable` → fail-closed com resposta segura; nunca responde
     como vendas enquanto o ownership do telefone estiver incerto.

Assim, uma mensagem tem exatamente um assento. `smoke:onboarding-routing` trava
essa precedência e prova que o registry base não ganhou um papel novo.

## Transporte transacional, fora de qualquer cérebro

As duas rotas abaixo são síncronas até o recibo `messages[0].id` da Meta, mas o
recibo nunca volta ao ERP. Elas não chamam brain, histórico, `SalesLead`, régua,
pause/resume, opener, tracking ou follow-up.

### Autenticação comum

Ambas exigem, nesta ordem:

1. `Authorization: Bearer <ERP_API_TOKEN>`;
2. `X-Bot-Signature: sha256=<HMAC-SHA256(raw JSON bytes,
   RECEPS_BOT_WEBHOOK_SECRET)>`.

O HMAC é estrito inclusive em desenvolvimento. O ERP deve assinar os bytes
exatos que envia. Bearer ou assinatura ausentes/incorretos retornam `401`; HMAC
sem segredo configurado retorna `503`. Nenhuma resposta ecoa token, assinatura,
telefone, código ou wamid.

### `POST /internal/auth/otp`

Payload estrito (chave extra é `400`):

```json
{
  "phone": "+5511999999999",
  "code": "482913"
}
```

- `phone`: canônico BR, `+55` + DDD + número;
- `code`: somente 4–10 dígitos, já gerado e persistido pelo ERP;
- template: `receps_auth_otp_v1`, `pt_BR`, categoria pretendida
  `AUTHENTICATION`;
- o mesmo código ocupa o parâmetro do body e do botão OTP/copy-code, conforme o
  contrato da Cloud API;
- rate limit local: **5 tentativas por telefone a cada 10 minutos**, chaveado
  somente por SHA-256 curto em memória.

Sucesso:

```json
{
  "ok": true,
  "kind": "auth_otp",
  "status": "accepted",
  "template": "receps_auth_otp_v1",
  "language": "pt_BR"
}
```

### `POST /internal/onboarding/welcome`

Payload estrito:

```json
{
  "phone": "+5511999999999"
}
```

- template: `receps_onboarding_welcome_v1`, `pt_BR`, categoria pretendida
  `UTILITY`;
- copy submetida: “Conta criada ✅ Sou a Renata — qualquer dúvida na
  configuração, responde aqui que eu te ajudo.”;
- rate limit local: **3 tentativas por telefone a cada 24 horas**;
- é convite best-effort para a usuária responder e abrir a janela de 24h; o
  funil e o commit de setup nunca dependem deste envio.

### Erros de transporte

- `400 invalid_payload`: contrato inválido, sem eco do payload;
- `429 rate_limited`: traz `Retry-After`;
- `503 sender_not_configured`: o remetente transacional não é exatamente a
  config ativa `receps-vendas`/`sales`;
- `502 provider_rejected`: a Meta rejeitou de forma conclusiva;
- `202 provider_outcome_unknown`: timeout/reset/recibo ausente depois do POST;
  a Meta pode ter aceitado. O ERP **não deve fazer retry automático** deste
  resultado ambíguo.

O remetente vem de `RECEPS_TRANSACTIONAL_PHONE_NUMBER_ID` (fallback legado:
`WA_PHONE_NUMBER_ID`), mas token e versão são relidos da config autoritativa do
ERP. Um id de outro tenant/papel falha fechado.

## Templates no WABA

`scripts/create-otp-templates.ts` faz get-or-create por nome+idioma em
`/<WABA-ID>/message_templates` usando `WA_BUSINESS_ACCOUNT_ID`,
`WA_ACCESS_TOKEN` e `WA_API_VERSION`. O script:

- nunca imprime credencial, WABA/phone/template ID ou corpo cru de erro;
- aceita como idempotente um template existente compatível;
- falha fechado se o mesmo nome de utility tiver outro body;
- relata somente nome, idioma, categoria devolvida e status;
- aceita que a Meta recategorize a utility como `MARKETING`, sem esconder a
  categoria factual.

## Contrato para a Onda 4.5 do ERP

O ERP deve:

1. gerar, armazenar, expirar e validar o código; o Receps-IA só o transporta;
2. aplicar o rate limit primário e proteção contra enumeração antes da chamada;
3. serializar o JSON uma vez, assinar exatamente esses bytes e enviar Bearer +
   HMAC para `POST /internal/auth/otp`;
4. nunca mandar `tenantId`, `phoneNumberId`, lead, nome ou qualquer chave extra;
5. tratar `200` como aceite do provider, `429` pelo `Retry-After` e `202` como
   outcome desconhecido sem retry automático;
6. chamar `POST /internal/onboarding/welcome` somente depois do commit do setup;
   falha/recategorização do welcome não reverte conta, setup, trial ou funil.
