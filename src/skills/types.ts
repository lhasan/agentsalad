/**
 * Skill System — 타입 정의
 *
 * BuiltinSkill: 코드 레벨 도구 정의 (AI SDK Tool)
 * 에이전트별 토글로 활성화/비활성화. 활성화 시 tool + 시스템 프롬프트 주입.
 *
 * 멀티타겟 워크스페이스: workspacePath는 타겟별 서브폴더를 가리킴.
 * agentWorkspacePath는 에이전트 루트 (타겟 폴더의 상위). _shared/ 접근에 사용.
 */
import type { Tool } from 'ai';

export type SkillCategory =
  | 'file'
  | 'web'
  | 'system'
  | 'google'
  | 'smart_step'
  | 'cron';

export interface BuiltinSkill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  /** 스킬 활성화 시 시스템 프롬프트에 주입되는 지침 */
  systemPrompt: string;
  /** 워크스페이스 경로를 받아 스코프된 AI SDK Tool 맵을 반환 */
  createTools: (ctx: SkillContext) => Record<string, Tool>;
  /** 런타임 의존성 충족 여부 (gog 설치 등) */
  isAvailable: () => boolean;
}

export interface SkillContext {
  /** 타겟별 워크스페이스 절대 경로 (파일 도구의 루트) */
  workspacePath: string;
  /** 에이전트 워크스페이스 루트 경로 (_shared/ 접근, 플랜 파일 저장 등) */
  agentWorkspacePath: string;
  /** 에이전트 프로필 ID */
  agentId: string;
  /** 대상 사용자 닉네임 (멀티타겟 식별) */
  targetName?: string;
  /** 채널로 메세지 즉시 전송 (send_message 스킬 + plan executor 용) */
  sendMessage?: (text: string) => Promise<void>;
  /** 채널로 이미지 전송 (스크린샷 등) */
  sendPhoto?: (filePath: string, caption?: string) => Promise<void>;
  /** 서비스 ID (플랜 실행 시 식별용) */
  serviceId?: string;
}

export interface ResolvedSkills {
  /** streamChat에 전달할 합쳐진 tool 맵 */
  tools: Record<string, Tool>;
  /** 시스템 프롬프트에 삽입할 스킬 지침 배열 */
  skillPrompts: string[];
}
