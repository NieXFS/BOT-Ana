import { ElevenLabsProvider } from './elevenLabsProvider';
import { GeminiTtsProvider } from './geminiTtsProvider';
import type {
  VoiceEnvConfig,
  VoiceTtsProviderName,
} from './voiceConfig';
import { getVoiceEnvConfig } from './voiceConfig';

export type TtsAudioFormat = 'mp3' | 'pcm_s16le';

export interface TtsUsage {
  audioTokens?: number;
  textTokens?: number;
}

export interface TtsProviderOutput {
  audio: Buffer;
  /** PCM: sample rate real parseado da resposta; MP3: irrelevante. */
  sampleRate?: number;
  usage?: TtsUsage;
}

export interface TtsProvider {
  readonly name: string;
  readonly outputFormat: TtsAudioFormat;
  synthesize(text: string): Promise<TtsProviderOutput>;
}

export interface TtsSynthesisResult extends TtsProviderOutput {
  format: TtsAudioFormat;
  provider: string;
}

const selfHostedProvider: TtsProvider = {
  name: 'selfhosted',
  outputFormat: 'mp3',
  async synthesize(): Promise<TtsProviderOutput> {
    throw new Error('selfhosted TTS provider not implemented');
  },
};

/** Registry simples e plugável, no mesmo espírito do aiProvider. */
export function getTtsProvider(
  name: VoiceTtsProviderName | 'selfhosted' = 'elevenlabs',
  config: VoiceEnvConfig = getVoiceEnvConfig()
): TtsProvider {
  switch (name.trim().toLowerCase()) {
    case 'elevenlabs':
      return new ElevenLabsProvider(config);
    case 'gemini':
      return new GeminiTtsProvider(config);
    case 'selfhosted':
      return selfHostedProvider;
    default:
      throw new Error(`unknown TTS provider: ${name}`);
  }
}
