import axios, { type AxiosRequestConfig } from 'axios';
import type {
  TtsProvider,
  TtsProviderOutput,
  TtsUsage,
} from './ttsProvider';
import type { VoiceEnvConfig } from './voiceConfig';
import { getVoiceEnvConfig } from './voiceConfig';

const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_TTS_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_GEMINI_PCM_SAMPLE_RATE = 24_000;

interface GeminiInlineData {
  data?: string;
  mimeType?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: GeminiInlineData;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: Array<{
      modality?: string;
      tokenCount?: number;
    }>;
    candidatesTokensDetails?: Array<{
      modality?: string;
      tokenCount?: number;
    }>;
    serviceTier?: string;
  };
}

export interface GeminiTtsRequestBody {
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: {
    responseModalities: ['AUDIO'];
    temperature: number;
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: string;
        };
      };
    };
  };
  systemInstruction?: { parts: Array<{ text: string }> };
}

export type GeminiTtsHttpPost = (
  url: string,
  data: GeminiTtsRequestBody,
  config: AxiosRequestConfig
) => Promise<{ data: GeminiGenerateContentResponse }>;

const defaultPost: GeminiTtsHttpPost = (url, data, config) =>
  axios.post<GeminiGenerateContentResponse>(url, data, config);

export function buildGeminiTtsRequestBody(
  text: string,
  config: VoiceEnvConfig
): GeminiTtsRequestBody {
  const { styleMode, stylePrompt, temperature, voice } = config.gemini;
  const spokenInput =
    styleMode === 'prefix' ? `${stylePrompt}: ${text}` : text;
  const body: GeminiTtsRequestBody = {
    contents: [{ parts: [{ text: spokenInput }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
    },
  };

  if (styleMode === 'system') {
    body.systemInstruction = { parts: [{ text: stylePrompt }] };
  }
  return body;
}

export function parseGeminiSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|;)\s*rate\s*=\s*(\d+)/i);
  if (!match) return DEFAULT_GEMINI_PCM_SAMPLE_RATE;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GEMINI_PCM_SAMPLE_RATE;
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function parseGeminiUsage(
  usageMetadata: GeminiGenerateContentResponse['usageMetadata']
): TtsUsage | undefined {
  if (!usageMetadata) return undefined;

  const audioDetail = usageMetadata.candidatesTokensDetails?.find(
    (detail) => detail.modality === 'AUDIO'
  );
  const audioTokens =
    validTokenCount(audioDetail?.tokenCount) ??
    validTokenCount(usageMetadata.candidatesTokenCount);
  const textTokens = validTokenCount(usageMetadata.promptTokenCount);

  return audioTokens === undefined && textTokens === undefined
    ? undefined
    : { audioTokens, textTokens };
}

function safeRequestError(error: unknown): Error {
  const candidate =
    error && typeof error === 'object'
      ? (error as {
          status?: number;
          code?: string;
          response?: { status?: number };
        })
      : {};
  const status = candidate.status ?? candidate.response?.status;
  const safe = new Error(
    `gemini TTS request failed${status ? ` (HTTP ${status})` : ''}`
  ) as Error & { status?: number; code?: string };
  if (status !== undefined) safe.status = status;
  if (candidate.code) safe.code = candidate.code;
  return safe;
}

export class GeminiTtsProvider implements TtsProvider {
  readonly name = 'gemini';
  readonly outputFormat = 'pcm_s16le' as const;

  constructor(
    private readonly config: VoiceEnvConfig = getVoiceEnvConfig(),
    private readonly post: GeminiTtsHttpPost = defaultPost
  ) {}

  async synthesize(text: string): Promise<TtsProviderOutput> {
    const url = `${GEMINI_API_BASE_URL}/${encodeURIComponent(
      this.config.gemini.model
    )}:generateContent`;
    let response: { data: GeminiGenerateContentResponse };
    try {
      response = await this.post(
        url,
        buildGeminiTtsRequestBody(text, this.config),
        {
          headers: {
            'x-goog-api-key': this.config.gemini.apiKey,
            'content-type': 'application/json',
          },
          timeout: GEMINI_TTS_REQUEST_TIMEOUT_MS,
        }
      );
    } catch (error) {
      // Nunca propaga AxiosError: config.data contém o texto da conversa.
      throw safeRequestError(error);
    }

    const inlineData =
      response.data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      // Não inclui finishReason/body: a resposta pode conter texto da conversa.
      throw new Error('gemini TTS response missing inline audio data');
    }

    const audio = Buffer.from(inlineData.data, 'base64');
    if (audio.length === 0) {
      throw new Error('gemini TTS response contained empty audio data');
    }
    return {
      audio,
      sampleRate: parseGeminiSampleRate(inlineData.mimeType),
      usage: parseGeminiUsage(response.data.usageMetadata),
    };
  }
}
