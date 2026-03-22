/**
 * Plan Executor — 스마트 스텝 플랜 실행 엔진
 *
 * _plan-{serviceId}.json을 읽고 배치별로 service-router 파이프라인을 반복 호출.
 * 배치 사이 쿨다운(3초)에서 유저 인터럽트를 감지.
 *
 * 서비스별 플랜 파일: 멀티타겟 환경에서 동일 에이전트의 여러 서비스가
 * 동시에 플랜을 실행해도 파일 충돌 없음.
 *
 * 안전 레이어:
 * - 유한 step 목록 → 무한루프 불가
 * - 배치 사이 유저 메시지 감지 → 즉시 중단
 * - 에러/빈 응답 → 플랜 중단
 * - 서버 시작 시 잔여 _plan-*.json 자동 삭제 (크래시 복구)
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'fs';
import { join } from 'path';

import type { PlanFile } from './skills/builtin/submit-plan.js';
import { hasNewUserMessages } from './db.js';
import { logger } from './logger.js';
import { getWorkspacePath } from './skills/workspace.js';

const COOLDOWN_MS = 3000;

/** 서비스별 플랜 파일명 */
function planFilename(serviceId: string): string {
  return `_plan-${serviceId}.json`;
}

export interface PlanExecutorDeps {
  serviceId: string;
  agentId: string;
  /** 타겟 닉네임 (멀티타겟 워크스페이스) */
  targetName?: string;
  /** 현재 배치 프롬프트로 LLM 호출 (service-router의 processPlanTurn) */
  processTurn: (prompt: string) => Promise<string>;
  /** 유저에게 알림 전송 */
  sendNotification: (text: string) => Promise<void>;
}

/** 플랜 파일이 저장될 디렉토리 (에이전트 루트) */
function planDir(agentId: string): string {
  return getWorkspacePath(agentId);
}

/**
 * 플랜 파일 읽기. 없으면 null.
 */
export function readPlanFile(
  agentId: string,
  serviceId: string,
): PlanFile | null {
  const planPath = join(planDir(agentId), planFilename(serviceId));
  if (!existsSync(planPath)) return null;
  try {
    return JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 플랜 파일 삭제.
 */
function deletePlanFile(agentId: string, serviceId: string): void {
  const planPath = join(planDir(agentId), planFilename(serviceId));
  try {
    if (existsSync(planPath)) unlinkSync(planPath);
  } catch (err) {
    logger.warn({ agentId, serviceId, err }, 'Failed to delete plan file');
  }
}

/**
 * 플랜 파일에 현재 상태 저장 (step 완료 추적).
 */
function savePlanFile(
  agentId: string,
  serviceId: string,
  plan: PlanFile,
): void {
  const planPath = join(planDir(agentId), planFilename(serviceId));
  writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
}

/**
 * 배치 실행 컨텍스트 프롬프트 생성.
 */
function buildBatchPrompt(
  batchIndex: number,
  totalBatches: number,
  batchSteps: Array<{ description: string }>,
  isLastBatch: boolean,
): string {
  const items = batchSteps
    .map((s, i) => `${i + 1}. ${s.description}`)
    .join('\n');

  let prompt = `[SMART STEP ${batchIndex + 1}/${totalBatches}]\nYou are executing batch ${batchIndex + 1} of ${totalBatches} in a planned task.\n\nItems to process this turn:\n${items}\n\nInstructions:\n- Process each item and use send_message to deliver results separately\n- Focus only on the listed items\n- Do not call submit_plan again\n- When all items are processed, end your response with a brief status`;

  if (isLastBatch) {
    prompt +=
      '\n- This is the final batch. Summarize overall completion after processing.';
  }

  return prompt;
}

/**
 * 플랜 실행 루프.
 * submit_plan 호출 후 _plan.json이 존재하면 service-router에서 이 함수를 호출.
 */
export async function executePlan(deps: PlanExecutorDeps): Promise<void> {
  const { serviceId, agentId, processTurn, sendNotification } = deps;
  const plan = readPlanFile(agentId, serviceId);
  if (!plan) {
    logger.warn(
      { agentId, serviceId },
      'executePlan called but no plan file found',
    );
    return;
  }

  const totalBatches = Math.ceil(plan.steps.length / plan.batch_size);
  const startBatch = plan.current_batch;

  logger.info(
    {
      agentId,
      serviceId,
      totalSteps: plan.steps.length,
      batchSize: plan.batch_size,
      totalBatches,
    },
    'Starting plan execution',
  );

  await sendNotification(
    `📋 실행 계획 시작: ${plan.summary}\n` +
      `총 ${plan.steps.length}단계, ${totalBatches}배치로 실행합니다.\n` +
      `중단하려면 아무 메시지나 보내세요.`,
  );

  for (let batchIdx = startBatch; batchIdx < totalBatches; batchIdx++) {
    if (batchIdx > startBatch) {
      await sleep(COOLDOWN_MS);
    }

    if (hasNewUserMessages(serviceId, plan.started_at)) {
      logger.info(
        { agentId, serviceId, batchIdx },
        'Plan interrupted by user message',
      );
      await sendNotification(
        '⛔ 실행 계획이 사용자 메시지에 의해 중단되었습니다.',
      );
      deletePlanFile(agentId, serviceId);
      return;
    }

    const startIdx = batchIdx * plan.batch_size;
    const endIdx = Math.min(startIdx + plan.batch_size, plan.steps.length);
    const batchSteps = plan.steps.slice(startIdx, endIdx);
    const isLastBatch = batchIdx === totalBatches - 1;

    const prompt = buildBatchPrompt(
      batchIdx,
      totalBatches,
      batchSteps,
      isLastBatch,
    );

    logger.info(
      {
        agentId,
        serviceId,
        batch: batchIdx + 1,
        totalBatches,
        stepRange: `${startIdx + 1}-${endIdx}`,
      },
      'Executing plan batch',
    );

    try {
      const response = await processTurn(prompt);

      if (!response.trim()) {
        logger.warn(
          { agentId, serviceId, batchIdx },
          'Empty response during plan execution, aborting',
        );
        await sendNotification(
          '⚠️ 에이전트가 빈 응답을 반환하여 실행 계획을 중단합니다.',
        );
        deletePlanFile(agentId, serviceId);
        return;
      }

      for (let i = startIdx; i < endIdx; i++) {
        plan.steps[i].status = 'done';
      }
      plan.current_batch = batchIdx + 1;
      savePlanFile(agentId, serviceId, plan);
    } catch (err) {
      logger.error(
        {
          agentId,
          serviceId,
          batchIdx,
          err: err instanceof Error ? err.message : String(err),
        },
        'Plan batch execution error, aborting plan',
      );
      for (let i = startIdx; i < endIdx; i++) {
        plan.steps[i].status = 'error';
      }
      savePlanFile(agentId, serviceId, plan);
      await sendNotification(
        `⚠️ 배치 ${batchIdx + 1} 실행 중 오류가 발생하여 계획을 중단합니다.`,
      );
      deletePlanFile(agentId, serviceId);
      return;
    }
  }

  logger.info(
    { agentId, serviceId, totalSteps: plan.steps.length },
    'Plan execution completed',
  );
  await sendNotification(
    `✅ 실행 계획이 완료되었습니다. (${plan.steps.length}단계 처리 완료)`,
  );
  deletePlanFile(agentId, serviceId);
}

/**
 * 서버 시작 시 잔여 _plan-*.json 파일 스캔 후 삭제 (크래시 복구).
 * 중단된 플랜은 재개하지 않고 안전하게 폐기.
 * 레거시 _plan.json도 함께 정리.
 */
export function cleanupStalePlans(workspacesRoot: string): void {
  try {
    if (!existsSync(workspacesRoot)) return;
    const entries = readdirSync(workspacesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsDir = join(workspacesRoot, entry.name);
      try {
        const files = readdirSync(wsDir);
        for (const file of files) {
          if (
            file === '_plan.json' ||
            (file.startsWith('_plan-') && file.endsWith('.json'))
          ) {
            const planPath = join(wsDir, file);
            unlinkSync(planPath);
            logger.warn(
              { workspace: entry.name, planPath },
              'Removed stale plan file from previous session',
            );
          }
        }
      } catch {
        /* permission etc */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error during stale plan cleanup');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
