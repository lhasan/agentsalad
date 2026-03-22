/**
 * Logger — Pino 기반 로깅 + 인메모리 에러 링버퍼
 *
 * 콘솔 출력: pino-pretty로 컬러 로깅.
 * 에러 버퍼: warn/error/fatal 레벨 로그를 최근 N건까지 메모리에 보관.
 * Web UI Logs 탭에서 getRecentErrors()로 조회.
 */
import pino from 'pino';

/** 인메모리 에러 링버퍼 최대 크기 */
const ERROR_BUFFER_MAX = 200;

export interface ErrorLogEntry {
  timestamp: string;
  level: string;
  message: string;
  details: Record<string, unknown>;
}

const errorBuffer: ErrorLogEntry[] = [];

function levelLabel(levelNum: number): string {
  if (levelNum >= 60) return 'fatal';
  if (levelNum >= 50) return 'error';
  if (levelNum >= 40) return 'warn';
  return 'info';
}

/** warn/error/fatal 로그를 링버퍼에 캡처 */
function captureToBuffer(levelNum: number, obj: Record<string, unknown>, msg: string): void {
  if (levelNum < 40) return;

  const { err, ...rest } = obj;
  const details = { ...rest };
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    details.error = e.message || e.type || String(err);
    if (e.stack) details.stack = e.stack;
  }

  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: levelLabel(levelNum),
    message: msg || (details.error as string) || 'Unknown error',
    details,
  };

  errorBuffer.push(entry);
  if (errorBuffer.length > ERROR_BUFFER_MAX) {
    errorBuffer.shift();
  }
}

/** 최근 에러 로그 조회 (Web UI용). 최신이 앞에 오도록 역순 반환. */
export function getRecentErrors(limit = 100): ErrorLogEntry[] {
  const start = Math.max(0, errorBuffer.length - limit);
  return errorBuffer.slice(start).reverse();
}

/** 에러 버퍼 비우기 */
export function clearErrorBuffer(): void {
  errorBuffer.length = 0;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
  hooks: {
    logMethod(inputArgs, method, level) {
      const [obj, msg] = (typeof inputArgs[0] === 'object' && inputArgs[0] !== null)
        ? [inputArgs[0] as Record<string, unknown>, String(inputArgs[1] ?? '')]
        : [{}, String(inputArgs[0] ?? '')];
      captureToBuffer(level, obj, msg);
      method.apply(this, inputArgs as Parameters<typeof method>);
    },
  },
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
