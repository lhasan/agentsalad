/**
 * BrowserManager — Playwright Chromium 싱글톤 관리자
 *
 * 단일 Chromium 프로세스를 lazy-launch하고, 서비스별 BrowserContext로 세션을 격리.
 * idle timeout으로 미사용 리소스를 자동 정리하며, graceful shutdown을 지원.
 *
 * 모드:
 *  - headed (기본): 사용자가 볼 수 있는 Chromium 창이 열림
 *  - headless: BROWSER_HEADLESS=true 환경변수 설정 시 (서버 배포용)
 *  - CDP 연결: BROWSER_CDP_URL 환경변수 설정 시 사용자의 기존 Chrome에 연결
 *
 * ESM 호환: playwright를 동적 import()로 로드하여 미설치 환경에서도 안전.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

import { logger } from '../../logger.js';

const CONTEXT_IDLE_MS = 5 * 60_000;
const BROWSER_IDLE_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, BrowserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private browserIdleSince: number | null = null;
  private isCdpMode = false;

  /**
   * 세션별 Page를 반환. 없으면 Context + Page를 새로 생성.
   * Browser가 없으면 lazy launch.
   */
  async getPage(sessionId: string): Promise<Page> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      this.browserIdleSince = null;
      return existing.page;
    }

    if (existing) {
      await this.closeSessionQuietly(sessionId);
    }

    const browser = await this.ensureBrowser();

    let context: BrowserContext;
    let page: Page;

    if (this.isCdpMode) {
      // CDP: 기존 브라우저의 default context에서 새 탭 열기
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());
      page = await context.newPage();
    } else {
      context = await browser.newContext({
        userAgent: 'AgentSalad/1.0',
        viewport: { width: 1280, height: 720 },
        locale: 'ko-KR',
      });
      page = await context.newPage();
    }

    this.sessions.set(sessionId, {
      context,
      page,
      lastUsed: Date.now(),
    });
    this.browserIdleSince = null;

    logger.debug({ sessionId, cdp: this.isCdpMode }, 'Browser session created');
    return page;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);

    try {
      await session.context.close();
      logger.debug({ sessionId }, 'Browser session closed');
    } catch (err) {
      logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'Error closing browser session',
      );
    }

    this.checkBrowserIdle();
  }

  async shutdown(): Promise<void> {
    this.stopCleanup();

    const sessionIds = [...this.sessions.keys()];
    for (const id of sessionIds) {
      await this.closeSessionQuietly(id);
    }
    this.sessions.clear();

    if (this.browser) {
      try {
        if (this.isCdpMode) {
          // CDP: 사용자의 Chrome은 닫지 않고 연결만 해제
          this.browser.removeAllListeners('disconnected');
        } else {
          await this.browser.close();
        }
        logger.info({ cdp: this.isCdpMode }, 'Playwright browser closed');
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Error closing browser on shutdown',
        );
      }
      this.browser = null;
      this.launching = null;
      this.isCdpMode = false;
    }
  }

  isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launching) return this.launching;

    this.launching = this.launchBrowser();
    try {
      this.browser = await this.launching;
      this.startCleanup();
      return this.browser;
    } catch (err) {
      this.launching = null;
      throw err;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const pw = await import('playwright');
    const cdpUrl = process.env.BROWSER_CDP_URL;

    if (cdpUrl) {
      this.isCdpMode = true;
      const browser = await pw.chromium.connectOverCDP(cdpUrl);
      browser.on('disconnected', () => {
        logger.warn('CDP browser disconnected');
        this.browser = null;
        this.launching = null;
        this.isCdpMode = false;
        this.sessions.clear();
      });
      logger.info({ cdpUrl }, 'Connected to Chrome via CDP');
      return browser;
    }

    this.isCdpMode = false;
    const headless = process.env.BROWSER_HEADLESS === 'true';
    const browser = await pw.chromium.launch({
      headless,
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    });

    browser.on('disconnected', () => {
      logger.warn('Playwright browser disconnected unexpectedly');
      this.browser = null;
      this.launching = null;
      this.sessions.clear();
    });

    logger.info({ headless }, 'Playwright Chromium launched');
    return browser;
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(
      () => this.runCleanup(),
      CLEANUP_INTERVAL_MS,
    );
    // unref: cleanup timer가 프로세스 종료를 막지 않도록
    this.cleanupTimer.unref();
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async runCleanup(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > CONTEXT_IDLE_MS || session.page.isClosed()) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      await this.closeSessionQuietly(id);
      this.sessions.delete(id);
      logger.debug({ sessionId: id }, 'Idle browser session cleaned up');
    }

    this.checkBrowserIdle();

    // browser idle timeout
    if (
      this.browser &&
      this.sessions.size === 0 &&
      this.browserIdleSince &&
      now - this.browserIdleSince > BROWSER_IDLE_MS
    ) {
      logger.info('Browser idle timeout — shutting down Chromium');
      await this.shutdown();
    }
  }

  private checkBrowserIdle(): void {
    if (this.sessions.size === 0 && !this.browserIdleSince) {
      this.browserIdleSince = Date.now();
    }
  }

  private async closeSessionQuietly(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await session.context.close();
    } catch {
      // 이미 닫힌 context — 무시
    }
  }
}

export const browserManager = new BrowserManager();
