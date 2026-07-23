import axios from 'axios';
import type { VoiceEnvConfig } from './voiceConfig';
import { getVoiceEnvConfig } from './voiceConfig';
import type { TtsProvider } from './ttsProvider';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const REQUEST_TIMEOUT_MS = 20_000;

export class ElevenLabsProvider implements TtsProvider {
  readonly name = 'elevenlabs';

  constructor(private readonly config: VoiceEnvConfig = getVoiceEnvConfig()) {}

  async synthesize(text: string): Promise<Buffer> {
    const { data } = await axios.post<ArrayBuffer>(
      `${ELEVENLABS_BASE_URL}/${encodeURIComponent(this.config.voiceId)}`,
      {
        text,
        model_id: this.config.model,
        voice_settings: {
          stability: this.config.stability,
          similarity_boost: this.config.similarity,
          // Validar com a API real do Victor. Se a versão da ElevenLabs rejeitar
          // speed dentro de voice_settings, ajustar conforme a documentação
          // vigente — não remover silenciosamente deste contrato.
          speed: this.config.speed,
          style: this.config.style,
        },
      },
      {
        headers: {
          'xi-api-key': this.config.apiKey,
          accept: 'audio/mpeg',
          'content-type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return Buffer.from(data);
  }
}
