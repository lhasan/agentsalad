/**
 * Builtin Skill: cron — 에이전트 자율 크론 관리
 *
 * 에이전트가 대화 중 사용자의 요청에 따라 자기 서비스에
 * 예약 작업(크론)을 직접 생성/조회/삭제할 수 있게 하는 빌트인 스킬.
 * Web UI에서 만든 크론과 동일 테이블 사용 → 양방향 관리 가능.
 * schedule_type: once(일회) / weekly(요일반복, 구 daily 통합) / interval(간격 반복).
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
  computeWeeklyNextRun,
  computeIntervalNextRun,
  computeOnceNextRun,
  parseScheduleDays,
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
- Set up interval-based tasks ("check every 2 hours", "ping me every 30 minutes")
- Set up weekly tasks ("every Mon/Wed/Fri at 9am", "on weekends at 10am")
- Any request involving reminders, alarms, schedules, recurring tasks, or "every day/morning/evening"

DO NOT just say you will remind them — you MUST actually call create_cron to register the schedule. If you don't call the tool, no reminder will ever be sent. Words alone do nothing.

## How it works
- "weekly" schedule: repeats on selected days of the week at HH:MM (24-hour, local timezone). Use schedule_days to specify which days (0=Sunday, 1=Monday, ..., 6=Saturday). For "every day", use "0,1,2,3,4,5,6".
- "interval" schedule: repeats every N minutes, starting from a specified datetime. Use interval_minutes (minimum 5) and schedule_time for the first execution time.
- "once" schedule: fires once at ISO datetime (e.g. "2026-03-19T07:00:00") then auto-deletes
- The prompt field is an instruction sent to YOU at the scheduled time. Write it as a self-instruction.
- notify=true (default): result is sent to the user via messenger
- notify=false: saved in conversation only (silent)

## Examples
User: "Every morning at 7, tell me today's workout"
→ schedule_type="weekly", schedule_days="0,1,2,3,4,5,6", schedule_time="07:00", prompt="Tell the user today's workout routine."

User: "Every Mon/Wed/Fri at 9am, send a report"
→ schedule_type="weekly", schedule_days="1,3,5", schedule_time="09:00", prompt="Generate and send the weekly report."

User: "Check server status every 2 hours starting now"
→ schedule_type="interval", interval_minutes=120, schedule_time=(current time as ISO), prompt="Check the server status and report any issues."

User: "Remind me about the meeting at 3pm tomorrow"
→ schedule_type="once", schedule_time="2026-03-20T15:00:00", prompt="Remind the user about their meeting."

Always confirm what you created after calling the tool.`,

  isAvailable: () => true,

  createTools: (ctx) => ({
    create_cron: tool({
      description:
        'Create a scheduled task (cron job) on the current service. weekly = repeat on selected days, interval = repeat every N minutes, once = auto-delete after execution.',
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
          .enum(['weekly', 'interval', 'once'])
          .describe(
            '"weekly" = repeat on selected days at HH:MM, "interval" = repeat every N minutes, "once" = single execution at ISO datetime',
          ),
        schedule_time: z
          .string()
          .describe(
            'weekly: "HH:MM" (24h local), interval: ISO 8601 datetime for first execution, once: ISO 8601 datetime',
          ),
        schedule_days: z
          .string()
          .optional()
          .describe(
            'weekly only: comma-separated day numbers (0=Sun,1=Mon,...,6=Sat). e.g. "1,3,5" for Mon/Wed/Fri, "0,1,2,3,4,5,6" for every day',
          ),
        interval_minutes: z
          .number()
          .min(5)
          .optional()
          .describe('interval only: repeat every N minutes (minimum 5)'),
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
        schedule_days,
        interval_minutes,
        notify,
      }) => {
        if (!ctx.serviceId) {
          return { error: 'Service context unavailable. Cannot create cron.' };
        }

        if (
          schedule_type === 'weekly' &&
          !/^\d{2}:\d{2}$/.test(schedule_time)
        ) {
          return {
            error: 'weekly schedule_time must be HH:MM format (e.g. "09:00")',
          };
        }

        if (schedule_type === 'weekly') {
          if (!schedule_days) {
            return {
              error:
                'weekly requires schedule_days (e.g. "0,1,2,3,4,5,6" for every day)',
            };
          }
          const days = parseScheduleDays(schedule_days);
          if (days.length === 0) {
            return {
              error: 'schedule_days must contain at least one valid day (0-6)',
            };
          }
        }

        if (schedule_type === 'interval') {
          if (!interval_minutes || interval_minutes < 5) {
            return {
              error: 'interval requires interval_minutes (minimum 5)',
            };
          }
          const parsed = new Date(schedule_time);
          if (isNaN(parsed.getTime())) {
            return {
              error:
                'interval schedule_time must be valid ISO datetime for first execution',
            };
          }
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
            intervalMinutes: interval_minutes ?? null,
            scheduleDays: schedule_days ?? null,
            notify,
          });

          let nextRun: string | null = null;
          if (schedule_type === 'weekly') {
            const days = parseScheduleDays(schedule_days ?? '');
            nextRun = computeWeeklyNextRun(schedule_time, days);
          } else if (schedule_type === 'interval') {
            // 시작 시간이 미래면 그 시간부터, 과거/현재면 지금부터 간격 적용
            const startTime = new Date(schedule_time);
            if (startTime.getTime() > Date.now()) {
              nextRun = startTime.toISOString();
            } else {
              nextRun = computeIntervalNextRun(interval_minutes!);
            }
          } else {
            nextRun = computeOnceNextRun(schedule_time);
          }

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
              schedule_days,
              interval_minutes,
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
            schedule_days: schedule_days ?? null,
            interval_minutes: interval_minutes ?? null,
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
