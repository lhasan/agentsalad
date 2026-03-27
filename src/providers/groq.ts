/**
 * Groq Provider - 전용 SDK(@ai-sdk/groq)로 Groq API 직접 호출
 *
 * 전용 SDK가 base URL, 에러 처리, structured outputs 등을 내부 관리.
 * base_url이 비어있으면 SDK 기본값 사용, 값이 있으면 커스텀 엔드포인트로 override.
 */
import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

export function createGroqModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createGroq({
    apiKey: params.apiKey,
    baseURL: params.baseUrl || undefined,
  });

  return provider(params.model);
}
