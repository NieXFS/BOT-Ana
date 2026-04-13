import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const clientCache = new Map<string, OpenAI>();

function getOpenAIClient(apiKey?: string | null): OpenAI {
  const resolvedApiKey = apiKey?.trim() || process.env.OPENAI_API_KEY;

  if (!resolvedApiKey) {
    throw new Error('OPENAI_API_KEY não configurada para transcrição.');
  }

  const cached = clientCache.get(resolvedApiKey);
  if (cached) return cached;

  const client = new OpenAI({ apiKey: resolvedApiKey });
  clientCache.set(resolvedApiKey, client);
  return client;
}

async function transcribeBuffer(
  buffer: Buffer,
  apiKey?: string | null
): Promise<string> {
  const tempPath = path.resolve('/tmp', `wpp_audio_${Date.now()}.ogg`);
  fs.writeFileSync(tempPath, buffer);

  try {
    const result = await getOpenAIClient(apiKey).audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'pt',
    });
    return result.text;
  } finally {
    fs.unlinkSync(tempPath);
  }
}

/** Cloud API path — receives a Buffer from downloadMedia() */
export async function transcreverAudioBuffer(
  buffer: Buffer,
  apiKey?: string | null
): Promise<string> {
  return transcribeBuffer(buffer, apiKey);
}

/** Legacy path — receives base64 string from whatsapp-web.js media.data */
export async function transcreverAudioBase64(
  base64Data: string,
  apiKey?: string | null
): Promise<string> {
  return transcribeBuffer(Buffer.from(base64Data, 'base64'), apiKey);
}
