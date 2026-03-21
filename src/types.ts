/**
 * Agent Salad - Type Definitions
 *
 * Agent + Channel + Target = Service. 3요소 결합으로 서비스 활성화.
 * CustomSkill: script(실행) + prompt(사용법) 묶음.
 * CronJob/ServiceCron: 서비스 단위 예약 작업 (daily/once 스케줄).
 */

// --- Agent Profile ---

/** Per-agent toggle map for builtin skills */
export interface AgentSkillToggles {
  file_read: boolean;
  file_write: boolean;
  file_list: boolean;
  web_fetch: boolean;
  web_browse: boolean;
  bash: boolean;
  google_gmail: boolean;
  google_calendar: boolean;
  google_drive: boolean;
  cron: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  provider_id: string;
  model: string;
  system_prompt: string;
  skills: AgentSkillToggles;
  /** 시간 인지 모드: 1이면 사용자 메시지에 타임스탬프 포함 + 현재 시간 시스템 프롬프트 주입 */
  time_aware: number;
  /** 스마트 스텝: 1이면 submit_plan + send_message 도구 활성화 + 전용 시스템 프롬프트 주입 */
  smart_step: number;
  /** 스마트 스텝 플랜 최대 step 수 (1~30, 기본 10) */
  max_plan_steps: number;
  /** 워크스페이스 폴더명 (이름 기반, 리네임 추적) */
  folder_name: string;
  /** 재료 이모지 썸네일 (랜덤 배정, 카테고리별 셋) */
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

// --- Custom Skill (global pool, per-agent toggle) ---
// 스킬 = 스크립트(실행) + 프롬프트(사용법) 묶음. 둘 다 optional.
// script가 있으면 AI SDK Tool로 등록, prompt만 있으면 시스템 프롬프트 주입.

export interface InputSchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  /** LLM에게 이 도구를 언제/어떻게 쓸지 알려주는 시스템 프롬프트 조각 */
  prompt: string;
  /** 실행할 셸 스크립트 본문. 비어있으면 prompt-only 스킬 */
  script: string;
  /** 입력 파라미터 스키마 JSON: InputSchemaField[] */
  input_schema: string;
  /** LLM이 호출할 도구 이름 (예: check_inventory). script 있을 때 필수 */
  tool_name: string;
  /** 스크립트 실행 타임아웃 (ms) */
  timeout_ms: number;
  /** 스킬 폴더명 (이름 기반, 리네임 추적) */
  folder_name: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCustomSkill {
  agent_profile_id: string;
  custom_skill_id: string;
  enabled: number;
}

// --- LLM Provider ---

export interface LlmProvider {
  id: string;
  provider_key: string;
  name: string;
  base_url: string;
  auth_scheme: 'bearer' | 'x-api-key';
  api_key: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// --- Channel (Bot) ---

export interface ManagedChannel {
  id: string;
  type: 'telegram';
  name: string;
  config_json: string;
  status: string;
  pairing_status: 'pending' | 'paired' | 'error';
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

// --- Target (User) ---

export interface TargetProfile {
  id: string;
  target_id: string;
  nickname: string;
  platform: 'telegram';
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

// --- Service (Agent + Channel + Target) ---

export interface Service {
  id: string;
  agent_profile_id: string;
  channel_id: string;
  target_id: string;
  status: 'active' | 'paused' | 'error';
  created_at: string;
  updated_at: string;
}

// --- Cron (서비스 단위 예약 작업) ---

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  /** 에이전트에게 사용하라고 지시할 도구/스킬 이름 목록 (JSON 배열) */
  skill_hint: string;
  schedule_type: 'daily' | 'once';
  schedule_time: string; // daily: HH:MM, once: ISO datetime
  notify: number; // 1 = 채널 전송, 0 = 대화 저장만
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceCron {
  service_id: string;
  cron_id: string;
  status: 'active' | 'paused';
  last_run: string | null;
  next_run: string | null;
}

// --- Conversation (per-service history for AI context) ---

export interface ConversationMessage {
  id: number;
  service_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

// --- Conversation Archive (compaction backup) ---

export interface ConversationArchive {
  id: number;
  service_id: string;
  messages_json: string;
  summary: string;
  message_count: number;
  estimated_tokens: number;
  created_at: string;
}

// --- Channel abstraction ---

export interface Channel {
  /** Unique channel identifier matching managed_channels.id */
  channelId: string;
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendPhoto?(jid: string, filePath: string, caption?: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  ownsJid?(jid: string): boolean;
  syncGroups?(force: boolean): Promise<void>;
}

/**
 * Callback when a channel receives a message from a user.
 * channelId: which managed channel received it
 * senderUserId: the platform-specific user identifier (telegram user id, etc.)
 * text: message content
 */
export type OnServiceMessage = (
  channelId: string,
  senderUserId: string,
  senderName: string,
  text: string,
) => void;

// --- Provider Error (API 에러 분류) ---

export type ProviderErrorType =
  | 'rate_limit' // 429
  | 'auth' // 401 / 403
  | 'model_not_found' // 404 또는 모델 미지원
  | 'overloaded' // 503 / 529
  | 'context_length' // 토큰 한도 초과
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    public readonly type: ProviderErrorType,
    public readonly statusCode: number | undefined,
    public readonly userMessage: string,
    cause?: unknown,
  ) {
    super(userMessage);
    this.name = 'ProviderError';
    this.cause = cause;
  }
}
