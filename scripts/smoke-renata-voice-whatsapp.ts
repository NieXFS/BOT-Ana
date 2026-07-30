/**
 * Smoke determinístico do payload/upload WhatsApp, com POST injetado.
 * O contrato após qualquer provider/encoder continua sendo OGG + PTT voice:true.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type {
  WhatsAppHttpPost,
  WhatsAppTenantConfig,
} from '../src/whatsappCloudService';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const {
    buildAudioMessagePayload,
    uploadMedia,
    sendAudioMessage,
  } = await import('../src/whatsappCloudService');

  const config: WhatsAppTenantConfig = {
    phoneNumberId: 'PN',
    waAccessToken: 'TOKEN',
    waApiVersion: 'v21.0',
  };
  const calls: Array<{ url: string; data: unknown; config: unknown }> = [];
  const post: WhatsAppHttpPost = async (url, data, requestConfig) => {
    calls.push({ url, data, config: requestConfig });
    return { data: { id: 'MEDIA_ID' } };
  };

  const payload = buildAudioMessagePayload('5511000000000', 'MEDIA_ID');
  check('type audio', payload.type === 'audio');
  check('voice:true (PTT)', payload.audio.id === 'MEDIA_ID' && payload.audio.voice === true);

  const mediaId = await uploadMedia(Buffer.from('ogg'), config, post);
  check('upload retorna id', mediaId === 'MEDIA_ID');
  check('endpoint /media', calls[0]?.url.endsWith('/v21.0/PN/media') === true);
  check('upload usa FormData', calls[0]?.data instanceof FormData);
  const uploadedForm = calls[0]?.data as FormData;
  const file = uploadedForm.get('file');
  check(
    'multipart messaging_product=whatsapp',
    uploadedForm.get('messaging_product') === 'whatsapp'
  );
  check(
    'multipart file audio/ogg',
    file instanceof Blob && file.type === 'audio/ogg'
  );

  await sendAudioMessage('5511000000000', 'MEDIA_ID', config, post);
  const sendCall = calls[1];
  const body = sendCall?.data as ReturnType<typeof buildAudioMessagePayload>;
  check('endpoint /messages', sendCall?.url.endsWith('/v21.0/PN/messages') === true);
  check(
    'body exato PTT',
    body.messaging_product === 'whatsapp' &&
      body.to === '5511000000000' &&
      body.type === 'audio' &&
      body.audio.id === 'MEDIA_ID' &&
      body.audio.voice === true
  );

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-voice-whatsapp OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
