import 'dotenv/config';
import express, { Request, Response } from 'express';
import { getTenantConfig } from './configProvider';
import {
  handleIncomingMessage,
  CloudMessage,
  CloudContact,
} from './messageHandler';

interface CloudWebhookMetadata {
  phone_number_id?: string;
}

interface CloudWebhookValue {
  metadata?: CloudWebhookMetadata;
  contacts?: CloudContact[];
  messages?: CloudMessage[];
}

const app = express();
app.use(express.json());

const VERIFY_TOKEN =
  process.env.WA_GLOBAL_VERIFY_TOKEN ?? process.env.WA_VERIFY_TOKEN ?? '';
const LEGACY_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID ?? '';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function processWebhookValue(value: CloudWebhookValue): Promise<void> {
  const phoneNumberId =
    value.metadata?.phone_number_id?.trim() || LEGACY_PHONE_NUMBER_ID;

  if (!phoneNumberId) {
    console.warn('⚠️ Webhook recebido sem phone_number_id.');
    return;
  }

  const config = await getTenantConfig(phoneNumberId);

  if (!config || !config.isActive) {
    console.warn(`⚠️ Nenhuma configuração ativa encontrada para ${phoneNumberId}.`);
    return;
  }

  const contacts = value.contacts ?? [];

  for (const message of value.messages ?? []) {
    const contact = contacts.find((entry) => entry.wa_id === message.from);

    handleIncomingMessage(message, contact, config).catch((err) =>
      console.error(`❌ Erro ao processar mensagem de ${message.from}:`, err)
    );
  }
}

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado pela Meta.');
    res.status(200).send(challenge);
    return;
  }

  console.warn('⚠️ Falha na verificação do webhook — token incorreto.');
  res.sendStatus(403);
});

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value as CloudWebhookValue | undefined;

      if (!value?.messages?.length) {
        continue;
      }

      processWebhookValue(value).catch((err) =>
        console.error('❌ Erro ao processar payload do webhook:', err)
      );
    }
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Ana — Atendente Virtual rodando na porta ${PORT}`);
});
