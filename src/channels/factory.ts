/**
 * Channel Factory — 채널 타입별 어댑터 생성
 *
 * managed_channels.type에 따라 적절한 채널 인스턴스를 반환.
 * 지원 채널: Telegram (grammY), Discord (discord.js), Slack (Bolt Socket Mode).
 */
import type { Channel, ChannelType, OnServiceMessage } from '../types.js';
import { createTelegramChannel } from './telegram.js';
import { createDiscordChannel } from './discord.js';
import { createSlackChannel } from './slack.js';
import { logger } from '../logger.js';

/**
 * 채널 타입과 설정으로 Channel 인스턴스를 생성.
 * 필수 설정이 누락되면 null 반환 + 로그 경고.
 */
export function createChannelByType(
  type: ChannelType,
  channelId: string,
  config: Record<string, unknown>,
  onMessage: OnServiceMessage,
): Channel | null {
  switch (type) {
    case 'telegram': {
      const botToken = config.botToken as string | undefined;
      if (!botToken) {
        logger.warn({ channelId, type }, 'Missing botToken for Telegram');
        return null;
      }
      return createTelegramChannel({ channelId, botToken, onMessage });
    }

    case 'discord': {
      const botToken = config.botToken as string | undefined;
      if (!botToken) {
        logger.warn({ channelId, type }, 'Missing botToken for Discord');
        return null;
      }
      return createDiscordChannel({ channelId, botToken, onMessage });
    }

    case 'slack': {
      const botToken = config.botToken as string | undefined;
      const appToken = config.appToken as string | undefined;
      if (!botToken || !appToken) {
        logger.warn(
          { channelId, type },
          'Missing botToken or appToken for Slack',
        );
        return null;
      }
      return createSlackChannel({ channelId, botToken, appToken, onMessage });
    }

    default:
      logger.warn({ channelId, type }, 'Unsupported channel type');
      return null;
  }
}
