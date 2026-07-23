import { ElevenLabsProvider } from './elevenLabsProvider';

export interface TtsProvider {
  readonly name: string;
  /** Retorna o áudio completo em MP3 (batch, sem streaming). */
  synthesize(text: string): Promise<Buffer>;
}

const selfHostedProvider: TtsProvider = {
  name: 'selfhosted',
  async synthesize(): Promise<Buffer> {
    throw new Error('selfhosted TTS provider not implemented');
  },
};

/** Registry simples e plugável, no mesmo espírito do aiProvider. */
export function getTtsProvider(name: string = 'elevenlabs'): TtsProvider {
  switch (name.trim().toLowerCase()) {
    case 'elevenlabs':
      return new ElevenLabsProvider();
    case 'selfhosted':
      return selfHostedProvider;
    default:
      throw new Error(`unknown TTS provider: ${name}`);
  }
}
