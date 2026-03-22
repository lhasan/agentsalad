/**
 * Builtin Skill: web_browse — Playwright 헤드리스 브라우저 (8개 도구)
 *
 * BrowserManager 싱글톤을 통해 서비스별 격리된 브라우저 세션을 제공.
 * navigate → content/click/type/screenshot/scroll/wait/links 패턴.
 *
 * ESM 호환: playwright를 동적 import()로 가용성 검사.
 * 스크린샷은 에이전트 workspace에 PNG 저장, 경로 + 메타데이터 반환.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

import type { BuiltinSkill, SkillContext } from '../types.js';
import { browserManager } from './browser-manager.js';
import { logger } from '../../logger.js';

const MAX_TEXT_LENGTH = 8000;
const NAV_TIMEOUT = 20_000;
const ACTION_TIMEOUT = 5_000;
const WAIT_MAX_TIMEOUT = 30_000;

let playwrightAvailable: boolean | null = null;

async function checkPlaywright(): Promise<boolean> {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    await import('playwright');
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

// 동기 버전: isAvailable()용 — 최초 호출 전까지는 false
function checkPlaywrightSync(): boolean {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    // createRequire 대신 단순 resolve 시도
    import.meta.resolve?.('playwright');
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

function getSessionId(ctx: SkillContext): string {
  return ctx.serviceId ?? ctx.agentId;
}

export const webBrowseSkill: BuiltinSkill = {
  id: 'web_browse',
  name: 'Web Browser',
  description: 'Playwright로 웹 브라우저를 제어합니다',
  category: 'web',
  systemPrompt: `You can control a Chromium browser with these tools:
- browse_navigate: Go to a URL and get page text
- browse_content: Get current page text without navigating
- browse_click: Click an element by CSS selector or visible text
- browse_type: Type text into an input field
- browse_screenshot: Take a screenshot — automatically sent to the user in chat
- browse_scroll: Scroll the page up or down
- browse_wait: Wait for an element to appear
- browse_links: Extract all links from the current page
Always navigate to a page first before using other browse tools.
When the user asks to "show" a page, use browse_screenshot after navigating to send them the visual.`,
  isAvailable: () => checkPlaywrightSync(),
  createTools: (ctx: SkillContext) => {
    const sessionId = getSessionId(ctx);

    return {
      browse_navigate: tool({
        description:
          'Navigate the browser to a URL. Returns page title, final URL, and text content.',
        inputSchema: z.object({
          url: z.string().url().describe('Full URL to navigate to'),
        }),
        execute: async ({ url }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: NAV_TIMEOUT,
            });
            const title = await page.title();
            const text = await page.innerText('body').catch(() => '');
            return {
              title,
              url: page.url(),
              content: text.slice(0, MAX_TEXT_LENGTH),
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ sessionId, url, err: msg }, 'browse_navigate failed');
            return { error: `Navigation failed: ${msg}` };
          }
        },
      }),

      browse_content: tool({
        description:
          'Get the current page text content and metadata without navigating.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const page = await browserManager.getPage(sessionId);
            const title = await page.title();
            const url = page.url();
            const text = await page.innerText('body').catch(() => '');
            return { title, url, content: text.slice(0, MAX_TEXT_LENGTH) };
          } catch (err) {
            return {
              error: `Failed to get content: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_click: tool({
        description:
          'Click an element on the current page. Tries CSS selector first, then visible text match.',
        inputSchema: z.object({
          selector: z
            .string()
            .describe('CSS selector or visible text of the element to click'),
        }),
        execute: async ({ selector }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            try {
              await page.click(selector, { timeout: ACTION_TIMEOUT });
              return { success: true, clicked: selector };
            } catch {
              await page
                .getByText(selector)
                .first()
                .click({ timeout: ACTION_TIMEOUT });
              return { success: true, clicked: selector, method: 'text_match' };
            }
          } catch (err) {
            return {
              error: `Could not click "${selector}": ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_type: tool({
        description:
          'Type text into an input element. Clears existing value first.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the input element'),
          text: z.string().describe('Text to type into the field'),
        }),
        execute: async ({ selector, text }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            await page.fill(selector, text, { timeout: ACTION_TIMEOUT });
            return { success: true, selector, typed: `${text.length} chars` };
          } catch (err) {
            return {
              error: `Could not type into "${selector}": ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_screenshot: tool({
        description:
          'Take a screenshot of the current page. The image is saved to workspace and automatically sent to the user via chat.',
        inputSchema: z.object({
          filename: z
            .string()
            .optional()
            .describe(
              'Optional filename (without path). Defaults to screenshot-<timestamp>.png',
            ),
          fullPage: z
            .boolean()
            .optional()
            .describe('Capture the full scrollable page (default: false)'),
        }),
        execute: async ({ filename, fullPage }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            const ts = Date.now();
            const fname = filename || `screenshot-${ts}.png`;
            const screenshotDir = join(ctx.workspacePath, '_screenshots');
            mkdirSync(screenshotDir, { recursive: true });
            const filePath = join(screenshotDir, fname);

            const buffer = await page.screenshot({
              path: filePath,
              fullPage: fullPage ?? false,
            });

            const title = await page.title();
            const viewport = page.viewportSize();

            logger.debug(
              { sessionId, filePath, bytes: buffer.length },
              'Screenshot saved',
            );

            let sentToChat = false;
            if (ctx.sendPhoto) {
              try {
                await ctx.sendPhoto(filePath, title || undefined);
                sentToChat = true;
              } catch (photoErr) {
                logger.warn(
                  {
                    sessionId,
                    err:
                      photoErr instanceof Error
                        ? photoErr.message
                        : String(photoErr),
                  },
                  'Failed to send screenshot to chat',
                );
              }
            }

            return {
              success: true,
              path: filePath,
              relativePath: `_screenshots/${fname}`,
              url: page.url(),
              title,
              viewport: viewport
                ? `${viewport.width}x${viewport.height}`
                : 'unknown',
              sizeBytes: buffer.length,
              sentToChat,
            };
          } catch (err) {
            return {
              error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_scroll: tool({
        description:
          'Scroll the page up or down by a specified amount in pixels.',
        inputSchema: z.object({
          direction: z.enum(['up', 'down']).describe('Scroll direction'),
          pixels: z
            .number()
            .optional()
            .describe('Pixels to scroll (default: 500)'),
        }),
        execute: async ({ direction, pixels }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            const amount = pixels ?? 500;
            const delta = direction === 'down' ? amount : -amount;
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(300);

            const scrollY = (await page.evaluate(
              'window.scrollY' as string,
            )) as number;
            const scrollHeight = (await page.evaluate(
              'document.documentElement.scrollHeight' as string,
            )) as number;
            const clientHeight = (await page.evaluate(
              'document.documentElement.clientHeight' as string,
            )) as number;

            return {
              success: true,
              direction,
              scrolledPixels: amount,
              currentScrollY: Math.round(scrollY),
              scrollHeight,
              viewportHeight: clientHeight,
              atBottom: scrollY + clientHeight >= scrollHeight - 1,
            };
          } catch (err) {
            return {
              error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_wait: tool({
        description:
          'Wait for an element matching the CSS selector to appear on the page.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector to wait for'),
          timeout: z
            .number()
            .optional()
            .describe(
              `Max wait time in milliseconds (default: 5000, max: ${WAIT_MAX_TIMEOUT})`,
            ),
        }),
        execute: async ({ selector, timeout }) => {
          const waitMs = Math.min(timeout ?? ACTION_TIMEOUT, WAIT_MAX_TIMEOUT);
          try {
            const page = await browserManager.getPage(sessionId);
            await page.waitForSelector(selector, {
              state: 'visible',
              timeout: waitMs,
            });
            return { success: true, selector, waited: true };
          } catch (err) {
            return {
              error: `Element "${selector}" not found within ${waitMs}ms: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),

      browse_links: tool({
        description:
          'Extract all links (anchor tags) from the current page. Returns up to 100 links with their text and href.',
        inputSchema: z.object({
          filter: z
            .string()
            .optional()
            .describe(
              'Optional text filter — only return links whose text or href contain this string',
            ),
        }),
        execute: async ({ filter }) => {
          try {
            const page = await browserManager.getPage(sessionId);
            const allLinks = await page.$$eval('a[href]', (anchors) =>
              anchors.map((a) => ({
                text: (a.textContent || '').trim().slice(0, 200),
                href: a.getAttribute('href') || '',
              })),
            );

            let links = allLinks.filter((l) => l.href && l.href !== '#');

            if (filter) {
              const lower = filter.toLowerCase();
              links = links.filter(
                (l) =>
                  l.text.toLowerCase().includes(lower) ||
                  l.href.toLowerCase().includes(lower),
              );
            }

            const capped = links.slice(0, 100);
            return {
              total: links.length,
              returned: capped.length,
              links: capped,
              url: page.url(),
            };
          } catch (err) {
            return {
              error: `Failed to extract links: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),
    };
  },
};
