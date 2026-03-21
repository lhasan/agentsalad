/**
 * Telegram Channel - grammY 기반 텔레그램 봇
 *
 * 페어링: 봇 토큰 입력 -> getMe() 검증 -> DB 저장
 * 메시지 수신: long polling
 * 메시지 발송: sendMessage API
 */
import { Bot, InputFile } from 'grammy';

import { logger } from '../logger.js';
import type { Channel, OnServiceMessage } from '../types.js';

export interface TelegramChannelConfig {
  channelId: string;
  botToken: string;
  onMessage: OnServiceMessage;
}

export function createTelegramChannel(config: TelegramChannelConfig): Channel {
  const { channelId, botToken, onMessage } = config;

  const bot = new Bot(botToken);
  let connected = false;
  let botUsername = '';

  bot.on('message:text', (ctx) => {
    const userId = String(ctx.from.id);
    const userName =
      ctx.from.first_name +
      (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    const text = ctx.message.text;

    logger.debug(
      { channelId, userId, userName, textLen: text.length },
      'Telegram message received',
    );

    onMessage(channelId, userId, userName, text);
  });

  bot.catch((err) => {
    logger.error({ channelId, err: err.message }, 'Telegram bot error');
  });

  return {
    channelId,
    name: `telegram:${botUsername || channelId}`,

    async connect(): Promise<void> {
      try {
        const me = await bot.api.getMe();
        botUsername = me.username;
        (this as Channel).name = `telegram:${botUsername}`;
        logger.info(
          { channelId, username: botUsername },
          'Telegram bot verified',
        );

        bot.start({
          onStart: () => {
            connected = true;
            logger.info(
              { channelId, username: botUsername },
              'Telegram polling started',
            );
          },
        });
      } catch (err) {
        logger.error({ channelId, err }, 'Failed to connect Telegram bot');
        throw err;
      }
    },

    async sendMessage(targetUserId: string, text: string): Promise<void> {
      const chatId = Number(targetUserId);
      logger.debug(
        {
          channelId,
          targetUserId,
          chatId,
          textLen: text.length,
          textPreview: text.slice(0, 50),
        },
        'Telegram sendMessage called',
      );

      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        const result = await bot.api.sendMessage(chatId, text);
        logger.debug(
          { channelId, chatId, messageId: result.message_id },
          'Telegram message delivered',
        );
        return;
      }
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        const result = await bot.api.sendMessage(
          chatId,
          text.slice(i, i + MAX_LENGTH),
        );
        logger.debug(
          {
            channelId,
            chatId,
            messageId: result.message_id,
            chunk: Math.floor(i / MAX_LENGTH) + 1,
          },
          'Telegram chunk delivered',
        );
      }
    },

    async sendPhoto(targetUserId: string, filePath: string, caption?: string): Promise<void> {
      const chatId = Number(targetUserId);
      try {
        const result = await bot.api.sendPhoto(chatId, new InputFile(filePath), {
          caption: caption ? caption.slice(0, 1024) : undefined,
        });
        logger.debug(
          { channelId, chatId, messageId: result.message_id },
          'Telegram photo delivered',
        );
      } catch (err) {
        logger.warn(
          { channelId, chatId, filePath, err: err instanceof Error ? err.message : String(err) },
          'Failed to send Telegram photo',
        );
      }
    },

    isConnected(): boolean {
      return connected;
    },

    async disconnect(): Promise<void> {
      connected = false;
      bot.stop();
      logger.info({ channelId }, 'Telegram bot stopped');
    },

    async setTyping(targetUserId: string, isTyping = true): Promise<void> {
      if (!isTyping) return; // Telegram has no "stop typing" API; it auto-expires
      try {
        await bot.api.sendChatAction(Number(targetUserId), 'typing');
      } catch {
        // non-critical
      }
    },
  };
}

/**
 * 봇 토큰 검증 - 페어링 시 사용.
 * 성공 시 봇 정보 반환, 실패 시 null.
 */
export async function verifyTelegramBot(
  botToken: string,
): Promise<{ id: number; username: string; firstName: string } | null> {
  try {
    const bot = new Bot(botToken);
    const me = await bot.api.getMe();
    return {
      id: me.id,
      username: me.username,
      firstName: me.first_name,
    };
  } catch (err) {
    logger.warn({ err }, 'Telegram bot token verification failed');
    return null;
  }
}
