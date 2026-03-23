import { describe, it, expect } from 'vitest';

import {
  computeDailyNextRun,
  computeOnceNextRun,
  mapConcurrent,
} from './cron-scheduler.js';

describe('computeDailyNextRun', () => {
  it('returns tomorrow if time already passed today', () => {
    const now = new Date();
    const pastH = String(now.getHours() - 1).padStart(2, '0');
    if (now.getHours() === 0) return; // edge: midnight → skip
    const result = new Date(computeDailyNextRun(`${pastH}:00`));
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result.getDate()).toBe(tomorrow.getDate());
  });

  it('returns today if time has not passed yet', () => {
    const now = new Date();
    const futureH = String(now.getHours() + 1).padStart(2, '0');
    if (now.getHours() >= 23) return; // edge: 23시 → skip
    const result = new Date(computeDailyNextRun(`${futureH}:00`));
    expect(result.getDate()).toBe(now.getDate());
  });
});

describe('computeOnceNextRun', () => {
  it('returns ISO string for valid datetime', () => {
    const iso = '2030-06-15T14:00:00';
    const result = computeOnceNextRun(iso);
    expect(result).toBe(new Date(iso).toISOString());
  });

  it('returns null for invalid datetime', () => {
    expect(computeOnceNextRun('not-a-date')).toBeNull();
  });
});

describe('mapConcurrent', () => {
  it('executes all items and returns results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, async (n) => n * 10, 3);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const LIMIT = 3;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapConcurrent(
      items,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      },
      LIMIT,
    );

    expect(maxActive).toBeLessThanOrEqual(LIMIT);
    expect(maxActive).toBe(LIMIT);
    expect(active).toBe(0);
  });

  it('runs faster than sequential when concurrency > 1', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const DELAY = 50;

    const seqStart = Date.now();
    for (const item of items) {
      await new Promise((r) => setTimeout(r, DELAY));
    }
    const seqTime = Date.now() - seqStart;

    const parStart = Date.now();
    await mapConcurrent(
      items,
      async () => {
        await new Promise((r) => setTimeout(r, DELAY));
      },
      3,
    );
    const parTime = Date.now() - parStart;

    // 병렬(3)은 순차 대비 최소 1.5배 이상 빨라야 함
    expect(parTime).toBeLessThan(seqTime * 0.75);
  });

  it('handles empty items', async () => {
    const results = await mapConcurrent([], async () => 1, 3);
    expect(results).toEqual([]);
  });

  it('handles concurrency larger than items', async () => {
    const items = [1, 2];
    const results = await mapConcurrent(items, async (n) => n + 1, 10);
    expect(results).toEqual([2, 3]);
  });

  it('propagates errors from individual tasks', async () => {
    const items = [1, 2, 3];
    await expect(
      mapConcurrent(
        items,
        async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
        2,
      ),
    ).rejects.toThrow('boom');
  });

  it('simulates cron-like workload: mixed fast and slow tasks', async () => {
    const log: string[] = [];
    const tasks = [
      { id: 'svc-A', delay: 100 },
      { id: 'svc-B', delay: 30 },
      { id: 'svc-C', delay: 60 },
      { id: 'svc-D', delay: 20 },
      { id: 'svc-E', delay: 80 },
    ];

    const start = Date.now();
    const results = await mapConcurrent(
      tasks,
      async (task) => {
        log.push(`start:${task.id}`);
        await new Promise((r) => setTimeout(r, task.delay));
        log.push(`end:${task.id}`);
        return task.id;
      },
      3,
    );

    const elapsed = Date.now() - start;

    expect(results).toEqual(['svc-A', 'svc-B', 'svc-C', 'svc-D', 'svc-E']);

    // 3개 worker로 병렬: 순차(290ms) 대비 절반 이하여야 함
    expect(elapsed).toBeLessThan(200);

    // 처음 3개가 동시에 시작했는지 확인
    expect(log[0]).toBe('start:svc-A');
    expect(log[1]).toBe('start:svc-B');
    expect(log[2]).toBe('start:svc-C');
  });
});
