/**
 * Smoke determinístico da política áudio-primeiro, prosódia, opt-out e gate.
 * Sem DB/rede/ffmpeg reais.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'sk-smoke';
process.env.RENATA_VOICE_ENABLED = 'true';
process.env.RENATA_ELEVENLABS_API_KEY = 'tts-smoke';

import type { TenantBotConfig } from '../src/configProvider';
import type { ConfiguredReplyDeps } from '../src/messageHandler';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function config(botRole: string): TenantBotConfig {
  return {
    tenantSlug: botRole === 'sales' ? 'receps-vendas' : 'clinica-smoke',
    botName: botRole === 'sales' ? 'Renata' : 'Ana',
    botRole,
    systemPrompt: 'x',
    greetingMessage: null,
    fallbackMessage: null,
    aiProvider: botRole === 'sales' ? 'anthropic' : 'openai',
    aiModel: 'smoke',
    aiTemperature: 0.4,
    aiMaxTokens: 500,
    openaiApiKey: null,
    botIsAlwaysActive: true,
    botActiveStart: '00:00',
    botActiveEnd: '23:59',
    timezone: 'America/Sao_Paulo',
    waAccessToken: 'token',
    waApiVersion: 'v21.0',
    phoneNumberId: 'PN_SMOKE',
    isActive: true,
  };
}

async function main(): Promise<void> {
  const policy = await import('../src/voice/channelPolicy');
  const { applyProsody } = await import('../src/voice/prosody');
  const { OPENER_SCRIPTS } = await import('../src/services/salesOpeners');
  const { detectChannelRequest } = await import('../src/voice/channelPref');
  const {
    getVoiceEnvConfig,
    isRenataVoiceEnabled,
    voiceFingerprint,
  } = await import('../src/voice/voiceConfig');
  const { __setFfmpegAvailableForTest } = await import('../src/voice/audioEncoder');
  const { sendConfiguredReply, typingSimEnabled } = await import(
    '../src/messageHandler'
  );

  console.log('▶ matriz de canal');
  check(
    'flag OFF → texto',
    policy.decideDelivery({
      text: 'Oi, posso te ajudar.',
      voiceEnabled: false,
      prefersText: false,
      maxChars: 600,
    }).mode === 'text'
  );
  check(
    'padrão curto → áudio',
    policy.decideDelivery({
      text: 'Oi! Me conta um pouco da sua clínica.',
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'audio'
  );
  check(
    'opt-out persistido → texto',
    policy.decideDelivery({
      text: 'Claro, te explico.',
      voiceEnabled: true,
      prefersText: true,
      maxChars: 600,
    }).mode === 'text'
  );
  check(
    'e-mail → texto',
    policy.decideDelivery({
      text: 'Confirma pra mim: maria@example.com?',
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'text'
  );
  check(
    'lista com 2 horários → texto',
    policy.decideDelivery({
      text: 'Tenho 9h e 10:30. Qual prefere?',
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'text'
  );
  check(
    '1 horário isolado ainda pode ser áudio',
    policy.decideDelivery({
      text: 'Perfeito, ficou para 9h.',
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'audio'
  );
  check(
    '> maxChars → texto',
    policy.decideDelivery({
      text: 'x'.repeat(601),
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'text'
  );

  const split = policy.decideDelivery({
    text: 'Deixei tudo pronto pra você começar com calma por aqui: https://receps.com.br/cadastro?x=1',
    voiceEnabled: true,
    prefersText: false,
    maxChars: 600,
  });
  check(
    'fala + link → áudio+texto',
    split.mode === 'audio+text' &&
      !split.voiceText.includes('https://') &&
      split.linkText === 'https://receps.com.br/cadastro?x=1'
  );
  check(
    'só-link → texto',
    policy.decideDelivery({
      text: 'https://wa.me/5511000000000',
      voiceEnabled: true,
      prefersText: false,
      maxChars: 600,
    }).mode === 'text'
  );

  console.log('▶ detectores');
  check('hasEmail', policy.hasEmail('maria@example.com'));
  check('countTimeMentions', policy.countTimeMentions('9h, 10h30 e 11:45') === 3);
  check(
    'extractUrls preserva uma URL por linha lógica',
    policy.extractUrls('a https://receps.com.br/x. b https://wa.me/1').join('|') ===
      'https://receps.com.br/x|https://wa.me/1'
  );
  check(
    'stripUrls remove URL e pontuação órfã final',
    policy.stripUrls('Te mando aqui: https://receps.com.br/x') === 'Te mando aqui'
  );

  console.log('▶ prosódia');
  const canonical = applyProsody(
    'Oi Maria! Deixa eu te explicar rapidinho! <explicação>. <pergunta>?'
  );
  check(
    'exemplo canônico em 4 blocos',
    canonical ===
      'Oi Maria!\n\nDeixa eu te explicar rapidinho!\n\n<explicação>.\n\n<pergunta>?'
  );
  const formatted = applyProsody(
    '**Olá!**\n- Primeiro item\n- Segundo item\n[Saiba mais](https://example.com)'
  );
  check('markdown removido', !/[*_[\]`()]/.test(formatted));
  check('lista virou frases, sem bullets', !formatted.includes('- ') && !formatted.includes('•'));
  check('saudação ficou em linha própria', formatted.startsWith('Olá!\n\n'));

  const opener0 = applyProsody(OPENER_SCRIPTS[0]);
  const opener1 = applyProsody(OPENER_SCRIPTS[1]);
  check(
    'abertura 1 preserva parágrafos sem grudar "chamou Deixa"',
    !opener0.includes('chamou Deixa') &&
      opener0.includes('chamou\n\nDeixa') &&
      opener0.includes('clínica.\n\nMe conta')
  );
  check(
    'abertura 2 preserva parágrafos sem grudar "interesse A Receps"',
    !opener1.includes('interesse A Receps') &&
      opener1.includes('interesse\n\nA Receps') &&
      opener1.includes('você.\n\nPra eu')
  );

  const spokenNumbers = applyProsody(
    'O plano custa R$ 1.800 e o atendimento funciona 24h.'
  );
  check(
    'prosódia escreve valor monetário por extenso',
    spokenNumbers.includes('mil e oitocentos reais')
  );
  check(
    'prosódia escreve duração por extenso',
    spokenNumbers.includes('vinte e quatro horas')
  );
  check(
    'prosódia remove formatos numéricos originais',
    !spokenNumbers.includes('R$') && !spokenNumbers.includes('24h')
  );

  console.log('▶ opt-out reversível');
  check('manda texto → text', detectChannelRequest('manda por texto') === 'text');
  check('não consigo ouvir → text', detectChannelRequest('não consigo ouvir agora') === 'text');
  check('manda áudio → audio', detectChannelRequest('pode mandar um áudio') === 'audio');
  check('áudio de volta → audio', detectChannelRequest('áudio de volta') === 'audio');
  check('neutro → null', detectChannelRequest('quanto custa?') === null);
  check(
    'texto vence se ambíguo',
    detectChannelRequest('sem áudio; depois pode mandar áudio') === 'text'
  );

  console.log('▶ gate e recepção');
  __setFfmpegAvailableForTest(true);
  const sales = config('sales');
  const receptionist = config('receptionist');
  check('sales + flag/key/ffmpeg → voz', isRenataVoiceEnabled(sales));
  check('receptionist nunca entra na voz', !isRenataVoiceEnabled(receptionist));
  check('typing da recepção continua ligado', typingSimEnabled(receptionist));

  const calls: string[] = [];
  const replyDeps: ConfiguredReplyDeps = {
    voiceEnabled: isRenataVoiceEnabled,
    deliverVoice: async () => {
      calls.push('voice');
    },
    waitTyping: async () => {
      calls.push('typing');
    },
    sendText: async () => {
      calls.push('text');
    },
  };
  await sendConfiguredReply('lead', 'oi', receptionist, replyDeps);
  check('recepção mantém typing → texto', calls.join(',') === 'typing,text');

  process.env.RENATA_VOICE_ENABLED = 'false';
  check('kill-switch OFF bloqueia sales', !isRenataVoiceEnabled(sales));
  process.env.RENATA_VOICE_ENABLED = 'true';

  const cfg = getVoiceEnvConfig();
  const changed = { ...cfg, voiceId: `${cfg.voiceId}-outra` };
  check('fingerprint muda com a voz', voiceFingerprint(cfg) !== voiceFingerprint(changed));

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-voice-policy OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
