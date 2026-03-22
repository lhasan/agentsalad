/**
 * Skill Registry — 빌트인 + 커스텀 + 스마트 스텝 스킬 해석기
 *
 * 에이전트의 스킬 토글과 커스텀 스킬 할당을 읽어
 * 실제 AI SDK tools + 시스템 프롬프트 조각으로 변환.
 *
 * 워크스페이스 3-depth: ctxOverrides에 channelId + targetFolderName이 있으면
 * store/workspaces/<agent>/<channel>/<target>/ 경로를 사용.
 * 최근 수정: targetName은 프롬프트용 표시값으로만 쓰고, 실제 경로는
 * targetFolderName(folder_name)으로 해석한다.
 *
 * Smart Step (agent.smart_step === 1) 활성 시 submit_plan + send_message
 * 도구를 추가 등록. 기존 빌트인 스킬과 분리된 에이전트 레벨 옵션.
 *
 * 커스텀 스킬 실행 우선순위:
 *   1. store/skills/<folder_name>/run.sh 파일 (파일 기반, 기본)
 *   2. DB custom_skills.script 인라인 본문 (하위 호환)
 *   3. prompt만 있으면 시스템 프롬프트 주입 (prompt-only)
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

import type {
  AgentProfile,
  AgentSkillToggles,
  CustomSkill,
  InputSchemaField,
} from '../types.js';
import type { BuiltinSkill, ResolvedSkills, SkillContext } from './types.js';
import { BUILTIN_SKILLS } from './builtin/index.js';
import {
  getWorkspacePath,
  ensureWorkspace,
  ensureTargetWorkspace,
  skillScriptExists,
  getSkillScriptPath,
  getSkillSchemaPath,
  getSkillPromptPath,
} from './workspace.js';
import { executeScriptFile, executeCustomScript } from './custom-executor.js';
import { logger } from '../logger.js';
import { readFileSync, existsSync } from 'fs';

/** 빌트인 도구명 세트 — 커스텀 tool_name 충돌 방지용 */
const BUILTIN_TOOL_NAMES = new Set([
  'run_command',
  'read_file',
  'write_file',
  'list_files',
  'fetch_url',
  'browse_navigate',
  'browse_content',
  'browse_click',
  'browse_type',
  'browse_screenshot',
  'browse_scroll',
  'browse_wait',
  'browse_links',
  'gmail_search',
  'gmail_send',
  'gmail_read',
  'calendar_list',
  'calendar_create',
  'drive_list',
  'drive_download',
  'drive_upload',
  'create_cron',
  'list_crons',
  'delete_cron',
]);

/**
 * 에이전트의 활성 스킬 토글 + 커스텀 스킬을 해석하여
 * tools 맵과 시스템 프롬프트 조각을 반환.
 *
 * Smart Step (agent.smart_step === 1) 활성 시:
 * - submit_plan, send_message 도구를 추가 등록
 * - 기존 AgentSkillToggles와는 분리된 에이전트 레벨 옵션
 */
export async function resolveSkills(
  agent: AgentProfile,
  customSkills: CustomSkill[] = [],
  ctxOverrides?: Partial<SkillContext>,
): Promise<ResolvedSkills> {
  const tools: Record<string, Tool> = {};
  const skillPrompts: string[] = [];
  const toggles = agent.skills;

  const agentWsPath = getWorkspacePath(agent.id);
  const channelId = ctxOverrides?.channelId;
  const targetFolderName = ctxOverrides?.targetFolderName;

  // 채널+타겟이 있으면 채널→타겟 서브폴더를 워크스페이스로 사용
  const workspacePath =
    channelId && targetFolderName
      ? ensureTargetWorkspace(agent.id, channelId, targetFolderName)
      : ensureWorkspace(agent.id);

  const ctx: SkillContext = {
    workspacePath,
    agentWorkspacePath: agentWsPath,
    agentId: agent.id,
    ...ctxOverrides,
  };

  // 빌트인 스킬 처리
  for (const skill of BUILTIN_SKILLS) {
    const toggleKey = skill.id as keyof AgentSkillToggles;
    if (!toggles[toggleKey]) continue;

    if (!skill.isAvailable()) {
      logger.debug(
        { skillId: skill.id, agentId: agent.id },
        'Skill unavailable, skipping',
      );
      continue;
    }

    try {
      const skillTools = skill.createTools(ctx);
      Object.assign(tools, skillTools);
      skillPrompts.push(skill.systemPrompt);
    } catch (err) {
      logger.warn(
        {
          skillId: skill.id,
          agentId: agent.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to create skill tools',
      );
    }
  }

  // 커스텀 스킬 처리
  for (const cs of customSkills) {
    const hasScriptFile = skillScriptExists(cs.id);
    const hasInlineScript = cs.script.trim().length > 0;
    const hasToolName = cs.tool_name.trim().length > 0;

    // 스크립트 파일 또는 인라인 스크립트 + tool_name이 있으면 AI SDK Tool로 등록
    if ((hasScriptFile || hasInlineScript) && hasToolName) {
      if (BUILTIN_TOOL_NAMES.has(cs.tool_name) || tools[cs.tool_name]) {
        logger.warn(
          { skillId: cs.id, toolName: cs.tool_name, agentId: agent.id },
          'Custom skill tool_name conflicts with existing tool, skipping',
        );
        continue;
      }

      try {
        const customTool = createCustomTool(
          cs,
          ctx.workspacePath,
          hasScriptFile,
        );
        tools[cs.tool_name] = customTool;
        logger.debug(
          {
            skillId: cs.id,
            toolName: cs.tool_name,
            agentId: agent.id,
            fileMode: hasScriptFile,
          },
          'Custom skill tool registered',
        );
      } catch (err) {
        logger.warn(
          {
            skillId: cs.id,
            agentId: agent.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to create custom skill tool',
        );
      }
    }

    // prompt 주입: prompt.txt 파일 우선 → DB prompt 폴백 + 타임아웃 자동 첨부
    const prompt = loadSkillPrompt(cs);
    if (prompt) {
      const timeoutSec = Math.round(cs.timeout_ms / 1000);
      skillPrompts.push(
        `${prompt}\n[이 도구의 실행 제한시간: ${timeoutSec}초. 초과 시 강제 종료됩니다.]`,
      );
    }
  }

  // Smart Step: 에이전트 레벨 토글이 켜져 있을 때만 도구 등록
  if (agent.smart_step === 1) {
    try {
      const { sendMessageSkill } = await import('./builtin/send-message.js');
      const { submitPlanSkill } = await import('./builtin/submit-plan.js');

      // submit_plan에 maxPlanSteps를 전달하기 위해 ctx를 확장
      const smartCtx = { ...ctx, maxPlanSteps: agent.max_plan_steps || 10 };

      if (ctx.sendMessage) {
        Object.assign(tools, sendMessageSkill.createTools(ctx));
      }
      Object.assign(
        tools,
        submitPlanSkill.createTools(smartCtx as SkillContext),
      );

      logger.debug(
        { agentId: agent.id, maxPlanSteps: agent.max_plan_steps },
        'Smart Step tools registered',
      );
    } catch (err) {
      logger.warn(
        {
          agentId: agent.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to register Smart Step tools',
      );
    }
  }

  return { tools, skillPrompts };
}

/**
 * 스킬의 프롬프트를 로드.
 * 우선순위: store/skills/<id>/prompt.txt 파일 > DB prompt 필드.
 */
function loadSkillPrompt(skill: CustomSkill): string {
  const promptFilePath = getSkillPromptPath(skill.id);
  if (existsSync(promptFilePath)) {
    try {
      const content = readFileSync(promptFilePath, 'utf-8').trim();
      if (content) return content;
    } catch (err) {
      logger.warn(
        {
          skillId: skill.id,
          path: promptFilePath,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to read prompt.txt, falling back to DB',
      );
    }
  }
  return skill.prompt.trim();
}

/**
 * CustomSkill로부터 AI SDK Tool을 동적 생성.
 * useFile=true → store/skills/<id>/run.sh 파일 실행
 * useFile=false → DB 인라인 스크립트 실행 (하위 호환)
 *
 * 입력 스키마 우선순위: schema.json 파일 > DB input_schema
 */
function createCustomTool(
  skill: CustomSkill,
  workspacePath: string,
  useFile: boolean,
): Tool {
  const schema = loadSkillSchema(skill);

  return tool({
    description: skill.description || `Custom skill: ${skill.name}`,
    inputSchema: schema,
    execute: async (input) => {
      const result = useFile
        ? await executeScriptFile(
            getSkillScriptPath(skill.id),
            input as Record<string, unknown>,
            workspacePath,
            skill.timeout_ms,
          )
        : await executeCustomScript(
            skill.script,
            input as Record<string, unknown>,
            workspacePath,
            skill.timeout_ms,
          );

      if (result.exitCode !== 0) {
        return {
          error: result.stderr || `Script exited with code ${result.exitCode}`,
          exitCode: result.exitCode,
          stdout: result.stdout || undefined,
        };
      }

      const output = result.stdout.trim();
      try {
        return JSON.parse(output);
      } catch {
        return { output };
      }
    },
  });
}

/**
 * 스킬의 입력 스키마를 로드.
 * 우선순위: store/skills/<id>/schema.json 파일 > DB input_schema 필드.
 */
function loadSkillSchema(
  skill: CustomSkill,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  let fields: InputSchemaField[] = [];

  // 1. schema.json 파일 우선 (_로 시작하는 메타 항목은 무시)
  const schemaFilePath = getSkillSchemaPath(skill.id);
  if (existsSync(schemaFilePath)) {
    try {
      const raw = readFileSync(schemaFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        fields = parsed.filter(
          (f: Record<string, unknown>) =>
            f.name && !String(f.name).startsWith('_'),
        );
      }
    } catch (err) {
      logger.warn(
        {
          skillId: skill.id,
          path: schemaFilePath,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to read schema.json, falling back to DB',
      );
    }
  }

  // 2. DB input_schema 폴백
  if (fields.length === 0 && skill.input_schema) {
    try {
      const parsed = JSON.parse(skill.input_schema);
      if (Array.isArray(parsed)) fields = parsed;
    } catch {
      /* 파싱 실패 시 빈 스키마 */
    }
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    switch (field.type) {
      case 'number':
        shape[field.name] = z
          .number()
          .describe(field.description || field.name);
        break;
      case 'boolean':
        shape[field.name] = z
          .boolean()
          .describe(field.description || field.name);
        break;
      default:
        shape[field.name] = z
          .string()
          .describe(field.description || field.name);
        break;
    }
  }

  return z.object(shape);
}

/** 등록된 빌트인 스킬 메타데이터 목록 (UI 렌더용) */
export function listBuiltinSkillMeta(): Array<{
  id: string;
  name: string;
  description: string;
  category: string;
  available: boolean;
}> {
  return BUILTIN_SKILLS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    available: s.isAvailable(),
  }));
}
