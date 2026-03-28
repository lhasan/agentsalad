/**
 * Maru - Configuration
 *
 * 서비스 플랫폼 전역 설정. STORE_DIR, TIMEZONE, Web UI, Browser 설정 관리.
 *
 * STORE_DIR 결정 순서:
 *  1. MARU_STORE_DIR 환경변수 (Electron 패키징에서 userData 경로 주입)
 *  2. process.cwd()/store (개발 환경 기본값)
 * Electron 패키징 시 process.cwd()가 앱 번들 내부로 잡히면
 * 업데이트 시 데이터가 소실되므로, 반드시 userData로 분리한다.
 *
 * Browser 환경변수:
 *  BROWSER_HEADLESS=true   → headless 모드 (기본: false, headed 모드로 창이 열림)
 *  BROWSER_CDP_URL=http://localhost:9222  → 기존 Chrome에 CDP로 연결
 *    Chrome 실행: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 */
import path from 'path';

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = process.env.MARU_STORE_DIR
  ? path.resolve(process.env.MARU_STORE_DIR)
  : process.env.AGENTSALAD_STORE_DIR
    ? path.resolve(process.env.AGENTSALAD_STORE_DIR)
    : path.resolve(PROJECT_ROOT, 'store');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Web UI (management only; chat still happens in channels)
export const WEB_UI_ENABLED =
  (process.env.WEB_UI_ENABLED || 'true').toLowerCase() !== 'false';
export const WEB_UI_HOST = process.env.WEB_UI_HOST || '127.0.0.1';
export const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT || '3210', 10);
