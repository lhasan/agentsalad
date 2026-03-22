/**
 * Slack Channel — @slack/bolt Socket Mode 기반 슬랙 봇
 *
 * Socket Mode: WebSocket 연결 (공개 URL 불필요, 자체호스팅 완벽 호환).
 * 토큰 2개 필요: Bot User OAuth Token + App-Level Token.
 * DM/채널 메시지 수신 + @멘션 감지.
 * DM 감지: message.channel_type === 'im'.
 * @멘션 감지: <@봇ID> 패턴 → 멘션 텍스트 제거 후 LLM에 전달.
 * sendToRoom(): 채널/스레드에 메시지 전송 (thread_ts로 스레드 응답 지원).
 * Slack 메시지 제한: 약 40,000자 (안전 분할 4,000자 단위).
 */
import { App, LogLevel } from '@slack/bolt';

import { logger } from '../logger.js';
import type { Channel, OnServiceMessage } from '../types.js';

const MAX_LENGTH = 4000;

/** 긴 텍스트를 MAX_LENGTH 이하 청크로 분할 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

export interface SlackChannelConfig {
  channelId: string;
  botToken: string;
  appToken: string;
  onMessage: OnServiceMessage;
}

export function createSlackChannel(config: SlackChannelConfig): Channel {
  const { channelId, botToken, appToken, onMessage } = config;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  let connected = false;
  let botUserId = '';
  let botName = '';

  app.message(async ({ message }) => {
    if (message.subtype) return;
    if (!('text' in message) || !message.text) return;
    if (!('user' in message) || !message.user) return;

    const userId = message.user;
    if (userId === botUserId) return;

    const msg = message as unknown as Record<string, unknown>;
    const channelType = msg.channel_type as string | undefined;
    const isDM = channelType === 'im';
    const slackChannel = msg.channel as string;
    const roomId = isDM ? undefined : slackChannel;
    const threadTs = msg.thread_ts as string | undefined;

    const botMentionPattern = botUserId
      ? new RegExp(`<@${botUserId}>`, 'g')
      : null;
    const isMention =
      !isDM && botMentionPattern ? botMentionPattern.test(message.text) : false;

    let text = message.text;
    if (isMention && botMentionPattern) {
      text = text.replace(botMentionPattern, '').trim();
    }
    if (!text) return;

    let userName = userId;
    try {
      const userInfo = await app.client.users.info({ user: userId });
      userName =
        userInfo.user?.real_name ||
        userInfo.user?.profile?.display_name ||
        userInfo.user?.name ||
        userId;
    } catch {
      // 이름 조회 실패 시 userId 사용
    }

    logger.debug(
      {
        channelId,
        userId,
        userName,
        isDM,
        roomId,
        isMention,
        textLen: text.length,
      },
      'Slack message received',
    );

    onMessage(channelId, userId, userName, text, {
      isDM,
      roomId,
      isMention,
      threadId: threadTs,
    });
  });

  app.error(async (error) => {
    logger.error(
      { channelId, err: error.message || String(error) },
      'Slack app error',
    );
  });

  return {
    channelId,
    name: `slack:${botName || channelId}`,

    async connect(): Promise<void> {
      try {
        await app.start();

        const authResult = await app.client.auth.test();
        botUserId = (authResult.user_id as string) || '';
        botName = (authResult.user as string) || '';
        (this as Channel).name = `slack:${botName || botUserId}`;

        connected = true;
        logger.info(
          { channelId, botName, botUserId },
          'Slack bot connected (Socket Mode)',
        );
      } catch (err) {
        logger.error({ channelId, err }, 'Failed to connect Slack bot');
        throw err;
      }
    },

    async sendMessage(targetUserId: string, text: string): Promise<void> {
      logger.debug(
        { channelId, targetUserId, textLen: text.length },
        'Slack sendMessage (DM)',
      );

      for (const chunk of splitText(text, MAX_LENGTH)) {
        await app.client.chat.postMessage({
          channel: targetUserId,
          text: chunk,
        });
      }
    },

    async sendToRoom(
      roomId: string,
      text: string,
      threadId?: string,
    ): Promise<void> {
      logger.debug(
        { channelId, roomId, threadId, textLen: text.length },
        'Slack sendToRoom',
      );

      for (const chunk of splitText(text, MAX_LENGTH)) {
        await app.client.chat.postMessage({
          channel: roomId,
          text: chunk,
          ...(threadId ? { thread_ts: threadId } : {}),
        });
      }
    },

    isConnected(): boolean {
      return connected;
    },

    async disconnect(): Promise<void> {
      connected = false;
      await app.stop();
      logger.info({ channelId }, 'Slack bot disconnected');
    },

    async setTyping(): Promise<void> {
      // Slack has no typing indicator API for bots
    },
  };
}

/**
 * Slack 봇 토큰 검증 — 페어링 시 사용.
 * 성공 시 봇 정보 반환, 실패 시 null.
 */
export async function verifySlackBot(
  botToken: string,
  appToken: string,
): Promise<{ userId: string; botName: string; teamName: string } | null> {
  try {
    const tempApp = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    const authResult = await tempApp.client.auth.test();
    const info = {
      userId: (authResult.user_id as string) || '',
      botName: (authResult.user as string) || '',
      teamName: (authResult.team as string) || '',
    };

    return info;
  } catch (err) {
    logger.warn({ err }, 'Slack bot token verification failed');
    return null;
  }
}
