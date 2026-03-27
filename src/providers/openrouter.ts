/**
 * OpenRouter Provider - 전용 SDK(@openrouter/ai-sdk-provider)로 여러 모델 통합 게이트웨이
 *
 * 전용 SDK가 base URL, 에러 처리 등을 내부 관리.
 * base_url이 비어있으면 SDK 기본값 사용, 값이 있으면 커스텀 엔드포인트로 override.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export function createOpenRouterModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createOpenRouter({
    apiKey: params.apiKey,
    ...(params.baseUrl ? { baseURL: params.baseUrl } : {}),
  });

  return provider.chat(params.model);
}
