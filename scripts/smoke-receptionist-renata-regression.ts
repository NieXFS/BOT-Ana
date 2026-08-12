import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ||= 'smoke';

async function main() {
  const { sendConfiguredReply } = await import('../src/messageHandler');
  const sent: string[] = [];
  const text = 'Renata preserva R$ 999,00, dois emojis 😊 🎉 e qualquer copy byte a byte.';
  await sendConfiguredReply('5511000000000', text, { botRole: 'sales' } as any, {
    voiceEnabled: () => false,
    deliverVoice: async () => { throw new Error('voice should be off'); },
    waitTyping: async () => { throw new Error('sales must not type'); },
    sendText: async () => {
      throw new Error('sales must require receipt transport');
    },
    sendSalesText: async (_to, payload) => { sent.push(payload); },
  });
  assert.deepEqual(sent, [text]);
  console.log('smoke receptionist Renata regression: OK');
}
void main();
