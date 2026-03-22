/**
 * Slack App Manifest helper
 *
 * Agent Salad Slack 채널 연동에 필요한 최소 권한/이벤트/Socket Mode 설정을
 * 공식 App Manifest 형식으로 제공한다.
 * 최근 수정: Slack 온보딩 복잡도를 줄이기 위해 Web UI에서 바로 내려받을
 * 수 있는 manifest JSON 생성기를 추가했고, app/bot 이름은 사용자 입력값으로
 * 내려주도록 바꿨다.
 */

const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'im:history',
  'users:read',
] as const;

const SLACK_BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.im',
] as const;

function normalizeSlackName(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = (value || '').trim();
  return trimmed || fallback;
}

export function getSlackAppManifest(input?: {
  appName?: string;
  botName?: string;
}): Record<string, unknown> {
  const appName = normalizeSlackName(input?.appName, 'My Agent Salad App');
  const botName = normalizeSlackName(input?.botName, appName);
  return {
    _metadata: {
      major_version: 1,
      minor_version: 1,
    },
    display_information: {
      name: appName,
      description:
        'Self-hosted AI agent platform with Slack, Discord, and Telegram channels.',
      background_color: '#43A047',
    },
    features: {
      bot_user: {
        display_name: botName,
        always_online: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [...SLACK_BOT_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export function getSlackAppManifestJson(input?: {
  appName?: string;
  botName?: string;
}): string {
  return JSON.stringify(getSlackAppManifest(input), null, 2);
}
