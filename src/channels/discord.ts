/**
 * Discord Channel — discord.js 기반 디스코드 봇
 *
 * Gateway WebSocket 연결 (공개 URL 불필요, 자체호스팅 호환).
 * DM + 서버 채널 메시지 수신, DM 및 채널 발송.
 * DM 감지: msg.guild 없으면 DM. 서버 채널: roomId = msg.channelId.
 * @멘션 감지: msg.mentions.has(client.user) → 멘션 텍스트 제거 후 LLM에 전달.
 * sendToRoom(): 서버 채널/스레드에 메시지 전송 (room 타겟 응답용).
 * 메시지 2000자 분할 로직 포함.
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js';

import { logger } from '../logger.js';
import type { Channel, OnServiceMessage } from '../types.js';

const MAX_LENGTH = 2000;

/** 긴 텍스트를 MAX_LENGTH 이하 청크로 분할 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

export interface DiscordChannelConfig {
  channelId: string;
  botToken: string;
  onMessage: OnServiceMessage;
}

export function createDiscordChannel(config: DiscordChannelConfig): Channel {
  const { channelId, botToken, onMessage } = config;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  let connected = false;
  let botUsername = '';

  client.on('messageCreate', (msg: Message) => {
    if (msg.author.bot) return;
    if (!msg.content) return;

    const userId = msg.author.id;
    const userName =
      msg.author.globalName || msg.author.displayName || msg.author.username;

    const isDM = !msg.guild;
    const roomId = isDM ? undefined : msg.channelId;
    const isMention = !isDM && !!client.user && msg.mentions.has(client.user);

    let text = msg.content;
    if (isMention) {
      text = text.replace(/<@!?\d+>/g, '').trim();
    }

    if (!text) return;

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
      'Discord message received',
    );

    onMessage(channelId, userId, userName, text, {
      isDM,
      roomId,
      isMention,
    });
  });

  client.on('error', (err) => {
    logger.error({ channelId, err: err.message }, 'Discord client error');
  });

  return {
    channelId,
    name: `discord:${botUsername || channelId}`,

    async connect(): Promise<void> {
      try {
        await client.login(botToken);
        if (client.user) {
          botUsername = client.user.username;
          (this as Channel).name = `discord:${botUsername}`;
        }
        connected = true;
        logger.info(
          { channelId, username: botUsername },
          'Discord bot connected',
        );
      } catch (err) {
        logger.error({ channelId, err }, 'Failed to connect Discord bot');
        throw err;
      }
    },

    async sendMessage(targetUserId: string, text: string): Promise<void> {
      logger.debug(
        { channelId, targetUserId, textLen: text.length },
        'Discord sendMessage (DM)',
      );

      const user = await client.users.fetch(targetUserId).catch(() => null);
      if (!user) {
        logger.warn(
          { channelId, targetUserId },
          'Discord user not found for DM',
        );
        return;
      }

      for (const chunk of splitText(text, MAX_LENGTH)) {
        await user.send(chunk);
      }
    },

    async sendToRoom(
      roomId: string,
      text: string,
      threadId?: string,
    ): Promise<void> {
      logger.debug(
        { channelId, roomId, threadId, textLen: text.length },
        'Discord sendToRoom',
      );

      const targetChannelId = threadId || roomId;
      let ch: TextBasedChannel | null = null;
      try {
        const fetched = await client.channels.fetch(targetChannelId);
        if (fetched?.isTextBased()) ch = fetched as TextBasedChannel;
      } catch {
        logger.warn(
          { channelId, targetChannelId },
          'Discord channel not found for sendToRoom',
        );
        return;
      }

      if (!ch || !('send' in ch)) return;
      for (const chunk of splitText(text, MAX_LENGTH)) {
        await (ch as { send: (text: string) => Promise<unknown> }).send(chunk);
      }
    },

    isConnected(): boolean {
      return connected;
    },

    async disconnect(): Promise<void> {
      connected = false;
      await client.destroy();
      logger.info({ channelId }, 'Discord bot disconnected');
    },

    async setTyping(targetUserId: string): Promise<void> {
      try {
        const user = await client.users.fetch(targetUserId).catch(() => null);
        if (!user) return;
        const dm = await user.createDM();
        await dm.sendTyping();
      } catch {
        // non-critical
      }
    },

    async setTypingInRoom(roomId: string): Promise<void> {
      try {
        const ch = await client.channels.fetch(roomId).catch(() => null);
        if (ch?.isTextBased() && 'sendTyping' in ch) {
          await (ch as { sendTyping: () => Promise<void> }).sendTyping();
        }
      } catch {
        // non-critical
      }
    },
  };
}

/**
 * 봇 토큰 검증 — 페어링 시 사용.
 * 성공 시 봇 정보 반환, 실패 시 null.
 */
export async function verifyDiscordBot(
  botToken: string,
): Promise<{ id: string; username: string } | null> {
  const tempClient = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await tempClient.login(botToken);
    const user = tempClient.user;
    if (!user) {
      await tempClient.destroy();
      return null;
    }
    const info = { id: user.id, username: user.username };
    await tempClient.destroy();
    return info;
  } catch (err) {
    logger.warn({ err }, 'Discord bot token verification failed');
    try {
      await tempClient.destroy();
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}
