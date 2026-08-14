# 10 Roteiros de teste — Ana conversacional v2

Formato: cada roteiro é uma cliente fictícia conversando com o estabelecimento (canário studio-viti; catálogo real: **Drenagem linfática · Limpeza de pele profunda · Peeling facial**). Cada passo tem a mensagem exata da cliente e o comportamento esperado da Ana. **REPROVA** lista o que não pode acontecer em hipótese alguma. Os roteiros servem tanto pro replay manual no WhatsApp de teste quanto como cenários da matriz DeepSeek (após aprovação).

---

## R1 — Camila: reabertura de fluxo (replay do incidente I3 + variantes)

**Valida:** eliminação dos dois denials pré-modelo (D2), pendência velha (D3, gate 4h), reinício explícito.
**Pré-condição:** ontem a Ana perguntou "qual serviço você prefere?" e a Camila nunca respondeu.

1. (dia seguinte) Camila: **"Quero agendar"**
   → Esperado: Ana trata como reabertura — repergunta o serviço com naturalidade ("Claro! Temos... qual você prefere?") ou confirma se ainda vale a conversa de ontem. Tom acolhedor.
2. Camila: **"quero agendar de manhã"** (numa conversa nova, sem serviço definido)
   → Esperado: Ana pergunta QUAL serviço e registra a preferência de período ("de manhã, perfeito — pra qual serviço?").
3. Camila: **"quero agendar um retorno"**
   → Esperado: Ana esclarece ("Claro! Retorno de qual procedimento / com quem?") ou pergunta o serviço.

**REPROVA:** "Esse tipo de atendimento não está disponível neste estabelecimento." em QUALQUER um dos 3 passos; silêncio; escolher um serviço sozinha.

---

## R2 — Bruna: seleção elíptica + agendamento completo até a confirmação

**Valida:** ordinal estrito (D2), follow-up sem re-listar (falha Rose Pacheco), disponibilidade só com evidência (D5), confirmação só após write real (guarda intacta).

1. Bruna: **"Oi! Quero agendar um horário"**
   → Esperado: pergunta de serviço com a lista dos 3 (primeira vez — listar é correto aqui).
2. Bruna: **"a segunda opção"**
   → Esperado: Ana fixa **Limpeza de pele profunda** (2ª da lista QUE ELA APRESENTOU), confirma a escolha e pergunta dia/horário. **Não repete a lista.**
3. Bruna: **"quinta à tarde"**
   → Esperado: Ana consulta a disponibilidade REAL e oferece horários que existem (ou diz que não há e sugere alternativa). Nunca inventa horário.
4. Bruna: **"pode ser às 15h"** (assumindo 15:00 ofertado no passo 3)
   → Esperado: resumo (serviço + dia + hora + profissional se aplicável) e pedido de confirmação.
5. Bruna: **"sim, pode marcar"**
   → Esperado: agendamento criado de verdade; SÓ ENTÃO "confirmado/agendado". Tom caloroso no fechamento.

**REPROVA:** re-listar serviços no passo 2; ofertar horário sem consulta; dizer "agendado/confirmado" antes do write com sucesso; trocar o serviço escolhido.

---

## R3 — Renata P.: "segunda" ambígua (dia × ordinal)

**Valida:** "segunda" nua NUNCA é ordinal (D2); desambiguação natural pelo modelo.

1. Renata P.: **"quero marcar limpeza de pele"**
   → Esperado: Ana fixa o serviço e pergunta dia/horário.
2. *(Nova conversa/outra cliente, com a pergunta de serviço aberta e a lista apresentada)* Renata P.: **"segunda"**
   → Esperado: Ana entende **segunda-feira** como leitura mais provável e desambigua com naturalidade ("Segunda-feira, perfeito! Pra qual dos serviços?") — ou pergunta qual serviço mantendo o dia.

**REPROVA:** fixar "Limpeza de pele profunda" (2ª da lista) por causa de "segunda"; silêncio; negação.

---

## R4 — Dona Marlene: typo e nome parcial (digitação real de celular)

**Valida:** typo/parcial vai ao modelo, nunca vira negação (D5/N3).

1. Dona Marlene: **"boa tarde, voces fazem drenajem?"**
   → Esperado: Ana entende Drenagem linfática (confirmando com gentileza) e conduz pro agendamento se a cliente quiser.
2. Dona Marlene: **"e peeling tem?"**
   → Esperado: reconhece **Peeling facial** pelo nome parcial e responde que sim, com convite a agendar.
3. Dona Marlene: **"quanto custa a limpeza?"**
   → Esperado: se houver preço no catálogo, informa o valor REAL; senão, responde sem inventar número.

**REPROVA:** "não temos esse serviço" pra typo/nome parcial; preço inventado; silêncio.

---

## R5 — Patrícia: serviço genuinamente inexistente

**Valida:** negação licenciada por evidência (D5), polaridade no matcher de oferta, redirecionamento comercial.

1. Patrícia: **"vocês fazem botox?"**
   → Esperado: negação educada e HUMANA ("Não trabalhamos com botox, mas temos limpeza de pele, peeling e drenagem — quer conhecer?"). A negação pode citar o catálogo real como alternativa.
2. Patrícia: **"e micropigmentação de sobrancelha?"**
   → Esperado: mesma classe de resposta — nega com educação, oferece o que existe.

**REPROVA:** oferecer/afirmar que faz um serviço fora do catálogo; resposta suprimida (silêncio por bloqueio da própria negação); frase seca "Esse tipo de atendimento não está disponível neste estabelecimento." sem acolhimento.

---

## R6 — Juliana: social no meio do fluxo (pendência preservada + humanização)

**Valida:** rota social opt-in humanizada (D6), PendingFrame preservado (D7), retomada do fluxo após social.

1. Juliana: **"Oi, boa tarde!"**
   → Esperado: saudação CALOROSA e natural (não necessariamente idêntica ao template antigo).
2. Ana pergunta em seguida como pode ajudar; Juliana: **"quero marcar um horário"** → Ana lista os 3 serviços.
3. Juliana: **"nossa, vocês são super organizados!! 🥰"**
   → Esperado: agradecimento humano, quente, SEM mencionar serviços/preços/horários espontaneamente. A pergunta de serviço continua "viva".
4. Juliana: **"a primeira opção"**
   → Esperado: Ana fixa **Drenagem linfática** — a lista do passo 2 ainda vale (o elogio não apagou a pendência) — e segue pra dia/horário.

**REPROVA:** o elogio matar o fluxo (passo 4 sem âncora); resposta robótica idêntica repetida; social puxando agenda ("aproveita e agenda!").

---

## R7 — Vanessa: papo pessoal com dia e hora (replay do turno real de 2026-08-12 21:31)

**Valida:** eco de dia/hora do próprio inbound não é drift (D6); fim dos templates secos; nenhuma oferta de agenda não pedida.

1. Vanessa: **"Hoje foi corrido, mas sexta às 20h tem uma festa. Vai ser top!"**
   → Esperado: resposta humana e específica ("Que demais! Aproveita muito a festa na sexta! 🎉" — pode ecoar "sexta"/"20h" porque a PRÓPRIA cliente disse). Sem operacional.
2. Vanessa: **"kkkkk obrigada"**
   → Esperado: fechamento social leve, sem repetir a mesma frase do passo 1.

**REPROVA:** "Tudo bem. Se precisar de algo, é só chamar." (template seco em ambos os passos); oferecer horário/serviço; silêncio; transformar "sexta às 20h" em tentativa de agendamento.

---

## R8 — Carol: mensagem mista (social + operacional na mesma bolha)

**Valida:** detecção social totalmente consumidora (D6) — leftover operacional vai pro modelo; disponibilidade real.

1. Carol: **"obrigada!! e amanhã tem horário pra drenagem?"**
   → Esperado: Ana responde o agradecimento E a pergunta operacional na MESMA resposta, consultando a disponibilidade real de amanhã pra Drenagem linfática (oferece horários existentes ou diz que não há).
2. Carol: **"então deixa pra próxima semana, obrigada de novo ❤️"**
   → Esperado: acolhe, se coloca à disposição, sem insistir.

**REPROVA:** tratar a mensagem 1 como só-social (ignorar a pergunta de horário); inventar disponibilidade; no passo 2, oferecer horários da semana que vem sem a cliente pedir.

---

## R9 — Fernanda: correção em rajada (mensagens em sequência rápida)

**Valida:** supersession (D9) — nunca responder à mensagem velha e se corrigir depois; anti-starvation.

1. Ana perguntou o serviço (lista apresentada). Fernanda: **"Drenagem"** e, ~3 segundos depois, antes de qualquer resposta: **"não, peraí, peeling!"**
   → Esperado: UMA única resposta da Ana, já com **Peeling facial** fixado ("Peeling facial então! Qual dia fica bom?").
2. Fernanda manda 3 bolhas seguidas: **"na verdade"** / **"pode ser sexta"** / **"de manhã"**
   → Esperado: UMA resposta consolidando (sexta de manhã), sem responder cada bolha separadamente.

**REPROVA:** confirmar Drenagem e depois "corrigir" pra Peeling (duas respostas contraditórias); duplicata; silêncio prolongado (>40s) sem resposta nenhuma.

---

## R10 — Aline + dona: takeover humano e retomada (o teste do "chefe")

**Valida:** HUMAN_ACTIVE (D1), silêncio correto durante takeover, retomada via chefe sem mudez permanente (regressão do I2).
**Nota de execução:** a parte da "dona" exige eco de coexistência real (número recepcionista no WhatsApp Business) OU eco sintético no harness — no número de teste da Meta só a matriz sintética cobre; o E2E real fica pendente como já registrado.

1. Aline: **"vocês atendem sábado?"** → Ana responde normalmente.
2. **Dona responde manualmente** (texto ou áudio) na conversa: "Oi Aline! Sábado sim, eu te encaixo, pode deixar comigo 😉"
3. Aline: **"ahh tá bom kkkk"**
   → Esperado: **silêncio TOTAL da Ana** (a conversa é da dona agora). Sem transcrição de áudio pra cliente, sem fallback.
4. *(No dia seguinte, mesma conversa)* Aline: **"oi! queria marcar uma limpeza de pele pra semana que vem"**
   → Esperado: o chefe (DeepSeek Thinking) reconhece pedido novo e independente → Ana VOLTA a responder normalmente e conduz o agendamento.
5. *(Contra-prova)* Se em vez do passo 4 a Aline mandar **"combinado então, sábado!"**
   → Esperado: Ana PERMANECE em silêncio (é continuação do combinado com a dona).

**REPROVA:** Ana responder no passo 3 ou 5; Ana ficar muda PARA SEMPRE no passo 4 (mudez permanente = regressão I2); Ana "brigar" com o que a dona combinou.

---

## Critérios transversais (valem para os 10)

- **Nunca silêncio em fluxo ativo** fora de takeover humano; toda rejeição interna termina em resposta útil (re-pergunta ou esclarecimento).
- **Nunca fato inventado:** horário/vaga/preço/profissional só com evidência do turno; "confirmado" só após write com sucesso.
- **Tom:** pt-BR natural, caloroso, 1–3 frases por resposta social, sem repetir a mesma string na conversa, no máximo 1 emoji.
- **Latência:** resposta em até ~25s no pior caso (debounce + regeneração); típico bem abaixo.
- **Recibos:** cada turno gera TurnPlanReceipt/TurnDeliveryReceipt coerentes (rota, regen, preempção) — verificado na matriz, não no WhatsApp.
