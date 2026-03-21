/**
 * Builtin Skill: cron — 에이전트 자율 크론 관리
 *
 * 에이전트가 대화 중 사용자의 요청에 따라 자기 서비스에
 * 예약 작업(크론)을 직접 생성/조회/삭제할 수 있게 하는 빌트인 스킬.
 * Web UI에서 만든 크론과 동일 테이블 사용 → 양방향 관리 가능.
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';
import {
  createCronJob,
  attachCronToService,
  getServiceCronsByService,
  detachCronFromService,
  getCronJobById,
  deleteCronJob,
  cleanupOrphanedOnceCrons,
} from '../../db.js';
import {
  computeDailyNextRun,
  computeOnceNextRun,
} from '../../cron-scheduler.js';
import { logger } from '../../logger.js';

function generateCronId(): string {
  return `cron-${Date.now().toString(36)}`;
}

export const cronSkill: BuiltinSkill = {
  id: 'cron',
  name: 'Cron Management',
  description: '예약 작업(크론)을 생성, 조회, 삭제합니다',
  category: 'cron',
  systemPrompt: `You have the ability to schedule tasks using create_cron, list_crons, and delete_cron tools.

## WHEN TO USE (IMPORTANT)
Use create_cron whenever the user asks you to:
- Remind them at a specific time ("remind me at 7am tomorrow", "check on me every morning")
- Do something regularly ("summarize news every day", "send me a report every Monday")
- Set up recurring checks ("check my diet every evening", "send workout reminders every morning")
- Schedule a future one-time task ("remind me about the meeting at 3pm tomorrow")
- Any request involving reminders, alarms, schedules, recurring tasks, or "every day/morning/evening"

DO NOT just say you will remind them — you MUST actually call create_cron to register the schedule. If you don't call the tool, no reminder will ever be sent. Words alone do nothing.

## How it works
- "daily" schedule: repeats every day at HH:MM (24-hour, local timezone)
- "once" schedule: fires once at ISO datetime (e.g. "2026-03-19T07:00:00") then auto-deletes
- The prompt field is an instruction sent to YOU at the scheduled time. Write it as a self-instruction.
- notify=true (default): result is sent to the user via messenger
- notify=false: saved in conversation only (silent)

## Example
User: "Every morning at 7, tell me today's workout"
→ Call create_cron with: name="Morning workout reminder", schedule_type="daily", schedule_time="07:00", prompt="Tell the user today's workout routine and check their diet plan.", notify=true

Always confirm what you created after calling the tool.`,

  isAvailable: () => true,

  createTools: (ctx) => ({
    create_cron: tool({
      description:
        'Create a scheduled task (cron job) on the current service. Daily tasks repeat every day; once tasks auto-delete after execution.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Short display name for the task (e.g. "매일 뉴스 요약")'),
        prompt: z
          .string()
          .describe(
            'Instruction prompt that will be sent to you at the scheduled time',
          ),
        schedule_type: z
          .enum(['daily', 'once'])
          .describe(
            '"daily" = every day at HH:MM, "once" = single execution at ISO datetime',
          ),
        schedule_time: z
          .string()
          .describe(
            'daily: "HH:MM" (24h local), once: ISO 8601 datetime (e.g. "2026-03-17T09:00:00")',
          ),
        notify: z
          .boolean()
          .default(true)
          .describe(
            'true = send result to user via messenger, false = save in conversation only',
          ),
      }),
      execute: async ({
        name,
        prompt,
        schedule_type,
        schedule_time,
        notify,
      }) => {
        if (!ctx.serviceId) {
          return { error: 'Service context unavailable. Cannot create cron.' };
        }

        if (schedule_type === 'daily' && !/^\d{2}:\d{2}$/.test(schedule_time)) {
          return {
            error: 'daily schedule_time must be HH:MM format (e.g. "09:00")',
          };
        }

        if (schedule_type === 'once') {
          const parsed = new Date(schedule_time);
          if (isNaN(parsed.getTime())) {
            return {
              error:
                'once schedule_time must be valid ISO datetime (e.g. "2026-03-17T09:00:00")',
            };
          }
          if (parsed.getTime() <= Date.now()) {
            return { error: 'once schedule_time must be in the future' };
          }
        }

        try {
          const cronId = generateCronId();

          createCronJob({
            id: cronId,
            name,
            prompt,
            scheduleType: schedule_type,
            scheduleTime: schedule_time,
            notify,
          });

          const nextRun =
            schedule_type === 'daily'
              ? computeDailyNextRun(schedule_time)
              : computeOnceNextRun(schedule_time);

          if (!nextRun) {
            deleteCronJob(cronId);
            return {
              error:
                'Failed to compute next run time. Check schedule_time format.',
            };
          }

          attachCronToService(ctx.serviceId, cronId, nextRun);

          logger.info(
            {
              cronId,
              serviceId: ctx.serviceId,
              name,
              schedule_type,
              schedule_time,
              notify,
            },
            'Agent created cron',
          );

          return {
            created: true,
            cron_id: cronId,
            name,
            schedule_type,
            schedule_time,
            notify,
            next_run: nextRun,
          };
        } catch (err) {
          logger.error(
            {
              serviceId: ctx.serviceId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to create cron',
          );
          return {
            error: `Failed to create cron: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),

    list_crons: tool({
      description:
        'List all scheduled tasks (cron jobs) attached to the current service.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.serviceId) {
          return { error: 'Service context unavailable.' };
        }

        try {
          const crons = getServiceCronsByService(ctx.serviceId);

          if (crons.length === 0) {
            return {
              crons: [],
              message: 'No scheduled tasks on this service.',
            };
          }

          return {
            crons: crons.map((c) => ({
              cron_id: c.cron_id,
              name: c.name,
              prompt: c.prompt,
              schedule_type: c.schedule_type,
              schedule_time: c.schedule_time,
              notify: c.notify === 1,
              status: c.status,
              last_run: c.last_run,
              next_run: c.next_run,
            })),
          };
        } catch (err) {
          return {
            error: `Failed to list crons: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),

    delete_cron: tool({
      description:
        'Delete a scheduled task from the current service. Use list_crons first to find the cron_id.',
      inputSchema: z.object({
        cron_id: z
          .string()
          .describe('ID of the cron job to delete (from list_crons)'),
      }),
      execute: async ({ cron_id }) => {
        if (!ctx.serviceId) {
          return { error: 'Service context unavailable.' };
        }

        try {
          const existing = getCronJobById(cron_id);
          if (!existing) {
            return { error: `Cron job not found: ${cron_id}` };
          }

          detachCronFromService(ctx.serviceId, cron_id);
          cleanupOrphanedOnceCrons();

          // daily 크론도 다른 서비스에 연결되어 있지 않으면 삭제
          const remaining = getCronJobById(cron_id);
          if (remaining) {
            try {
              deleteCronJob(cron_id);
            } catch {
              // 다른 서비스에 연결된 경우 FK 제약으로 실패 가능 → 무시
            }
          }

          logger.info(
            { cronId: cron_id, serviceId: ctx.serviceId },
            'Agent deleted cron',
          );

          return { deleted: true, cron_id, name: existing.name };
        } catch (err) {
          return {
            error: `Failed to delete cron: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
  }),
};
