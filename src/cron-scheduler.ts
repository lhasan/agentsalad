/**
 * Cron Scheduler — 서비스 단위 예약 작업 실행 엔진
 *
 * 30초 간격으로 service_crons 테이블의 due 작업을 체크하여
 * service-router의 processCronMessage를 통해 실행.
 * daily 크론은 다음 날 같은 시간으로, once 크론은 실행 후 삭제.
 *
 * 의도적 직렬 실행: due 작업을 for...of + await로 순차 처리.
 * - LLM API rate limit 보호 (동시 다발 호출 시 429 에러 방지)
 * - 동일 에이전트의 컨텍스트 충돌 방지 (대화 이력 동시 쓰기 회피)
 * - 단일 프로세스에서의 메모리/CPU 안정성
 *
 * 대규모 서비스(수십 건 이상 동시 due) 환경에서는
 * p-limit 등으로 동시 실행 수를 제한하는 병렬화를 고려할 것.
 */
import { TIMEZONE } from './config.js';
import {
  getDueServiceCrons,
  getTargetById,
  listConcreteServicesForTemplate,
  updateServiceCronAfterRun,
  cleanupOrphanedOnceCrons,
} from './db.js';
import { processCronMessage } from './service-router.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = 30_000;

let running = false;

/**
 * daily 크론의 next_run을 다음 날 같은 시간으로 계산.
 * 시스템 타임존 기준으로 HH:MM을 해석.
 */
export function computeDailyNextRun(timeHHMM: string): string {
  const [h, m] = timeHHMM.split(':').map(Number);
  const now = new Date();

  const todayAtTime = new Date(now);
  todayAtTime.setHours(h, m, 0, 0);

  const next =
    todayAtTime.getTime() > now.getTime()
      ? todayAtTime
      : new Date(todayAtTime.getTime() + 24 * 60 * 60 * 1000);

  return next.toISOString();
}

/**
 * once 크론의 next_run 초기값 계산.
 * schedule_time이 ISO datetime이므로 그대로 사용.
 */
export function computeOnceNextRun(isoDatetime: string): string | null {
  const target = new Date(isoDatetime);
  if (isNaN(target.getTime())) return null;
  return target.toISOString();
}

function buildScheduleLabel(type: string, time: string): string {
  if (type === 'daily') return `매일 ${time}`;
  const d = new Date(time);
  if (isNaN(d.getTime())) return `단발 ${time}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function tick(): Promise<void> {
  try {
    const dueItems = getDueServiceCrons();
    if (dueItems.length === 0) return;

    logger.info({ count: dueItems.length }, 'Cron: found due jobs');

    for (const item of dueItems) {
      const scheduleLabel = buildScheduleLabel(
        item.schedule_type,
        item.schedule_time,
      );
      const notify = item.notify === 1;
      const target = getTargetById(item.target_id);
      const isEveryoneTemplate = target?.target_type === 'everyone';

      let ok = true;
      if (isEveryoneTemplate) {
        const childServices = listConcreteServicesForTemplate(item.service_id);
        logger.info(
          {
            serviceId: item.service_id,
            cronId: item.cron_id,
            childCount: childServices.length,
          },
          'Cron: expanding everyone template to concrete services',
        );
        for (const child of childServices) {
          const childOk = await processCronMessage(
            child.id,
            item.name,
            item.prompt,
            item.skill_hint || '[]',
            scheduleLabel,
            notify,
          );
          ok = ok && childOk;
        }
      } else {
        ok = await processCronMessage(
          item.service_id,
          item.name,
          item.prompt,
          item.skill_hint || '[]',
          scheduleLabel,
          notify,
        );
      }

      if (ok) {
        if (item.schedule_type === 'daily') {
          const nextRun = computeDailyNextRun(item.schedule_time);
          updateServiceCronAfterRun(item.service_id, item.cron_id, nextRun);
        } else {
          // once: 실행 완료 → service_cron 삭제
          updateServiceCronAfterRun(item.service_id, item.cron_id, null);
        }
      } else {
        logger.warn(
          { serviceId: item.service_id, cronId: item.cron_id },
          'Cron execution failed or skipped',
        );
      }
    }

    cleanupOrphanedOnceCrons();
  } catch (err) {
    logger.error({ err }, 'Error in cron scheduler tick');
  }
}

export function startCronScheduler(): void {
  if (running) {
    logger.debug('Cron scheduler already running');
    return;
  }
  running = true;
  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, timezone: TIMEZONE },
    'Cron scheduler started',
  );

  const loop = async () => {
    await tick();
    if (running) setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

export function stopCronScheduler(): void {
  running = false;
}
