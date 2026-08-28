# Spec — Receps-IA: OTP transacional + cérebro de onboarding

> Decisões do Victor (2026-08-26): mesmo número WABA da Renata; código por
> WhatsApp (SMS descartado); cérebro separado pra ajudar no onboarding pelo
> WhatsApp. Este documento é a spec da tarefa no repositório
> `/Users/niexfs/dev/Receps-IA` — vira briefing de executor quando a onda
> abrir. Nada aqui depende do ledger de migrations do ERP.

## 1 · Envio transacional de OTP (fora de qualquer cérebro)

- Caminho **determinístico**, módulo próprio (ex.: `src/services/authOtp.ts`):
  recebe o telefone canônico `+55DDDNUMERO` e o código **já gerado pelo ERP**.
  O Receps-IA **não gera, não valida e não armazena** código — só transporta.
- Template categoria **AUTHENTICATION** (conteúdo travado pela Meta: código +
  disclaimer + botão copy-code). Precisa ser submetido e aprovado no WABA.
- Exposição pro ERP: endpoint interno autenticado reusando o padrão de
  token/HMAC ERP↔IA já existente; rate limit também deste lado (defesa em
  profundidade — o rate limit primário é do ERP).
- **Marcação transacional (guardrail testável)**: mensagens deste caminho
  NUNCA criam `SalesLead`, NUNCA disparam follow-up, NUNCA pausam/retomam a
  Renata, NUNCA entram no histórico como conversa comercial.
- Logs/Sentry: telefone e código **sempre redigidos** (padrão de scrub da casa).

## 2 · Welcome utility pós-conta

- Template categoria **UTILITY**, enviado após o commit do setup no ERP:
  "Conta criada ✅ Sou a Renata — qualquer dúvida na configuração, responde
  aqui que eu te ajudo." O convite à resposta é o gancho: a resposta abre a
  janela de 24h.
- **O funil NÃO depende deste template** (a Meta pode recategorizá-lo como
  marketing): o gancho redundante é o CTA "Falar com a Renata" na tela 08 do
  app, que abre o wa.me com mensagem pré-preenchida.
- Disparo: notificação ERP → IA pós-commit (reusar o hook de funil existente
  se couber; senão, chamada explícita no mesmo canal autenticado do item 1).

## 3 · Cérebro de onboarding

- ⚠️ **Conflito 10 do roadmap (2026-08-27), resolvido por decisão do Fable: o
  Receps-IA JÁ TEM um papel/brain de onboarding pós-trial. ESTENDER esse
  assento existente — nunca criar um segundo cérebro pro mesmo telefone.**
  O executor da onda mapeia o assento atual primeiro e evolui a partir dele;
  dois cérebros respondendo ao mesmo número é o bug a evitar por desenho.
- Assento no **brain registry** (padrão descrito em `docs/features/renata.md`),
  mesmo tenant `receps-vendas`, mesmo número.
- **Roteamento por estado do telefone**, resolvido contra o ERP: telefone de
  usuário em onboarding/trial → cérebro de onboarding; lead de vendas →
  Renata. Como é a MESMA thread do WhatsApp, a precedência precisa ser
  documentada e testada — nunca dois cérebros respondendo à mesma mensagem.
- Escopo do cérebro: tirar dúvidas de configuração e produto, guiar os
  primeiros passos, handoff pra humano quando pedido. **Não** faz follow-up de
  vendas, **não** promete capability inexistente (todo gate com pergunta entra
  no contrato elicitor×matcher, regra da casa), **não** acessa dados além das
  APIs read já permitidas ao serviço.
- Mensagem livre só dentro da janela de 24h (renovada a cada resposta da
  usuária); fora dela, só template aprovado.

## 4 · Dev e teste

- O Receps-IA só roda em produção: em dev, o ERP usa **bypass de código fixo**
  atrás de flag explícita (nunca ativa em prod).
- Smokes programáticos: (a) guardrail do item 1 — tráfego de auth não cria
  lead/follow-up/pausa; (b) precedência de roteamento do item 3.

## 5 · Fora de escopo desta tarefa

Geração/armazenamento/validação do código (ERP, Onda 4.5); claim do
`SalesLead` (ERP); qualquer mudança na Ana ou nos fluxos das clínicas.

## Pré-requisito operacional (Victor)

Submeter os dois templates (auth + utility) no gerenciador do WABA — a
aprovação da Meta pode levar de minutos a dias e não bloqueia o
desenvolvimento (dev usa bypass).
