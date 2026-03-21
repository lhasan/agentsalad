/**
 * Service Router - 에이전트 서비스 메시지 처리 엔진
 *
 * Channel 메시지 수신 -> Service 매칭 -> 스킬 resolve -> 자동 compaction
 * -> Provider 호출(tool calling 포함) -> 응답 전송.
 * Cron 스케줄러도 processCronMessage()를 통해 동일한 파이프라인 사용.
 *
 * Typing Loop: LLM 처리 중 4초 간격으로 typing indicator를 채널에 반복 전송.
 * 응답 완료 또는 에러 시 자동 중지.
 *
 * Smart Step: agent.smart_step=1인 경우 submit_plan 호출 감지 → plan-executor로
 * 배치 실행 위임. sendMessage 콜백을 SkillContext에 주입하여 턴 중간 메시지 전송 지원.
 */
import {
  addConversationMessage,
  findActiveService,
  getConversationHistory,
  getAgentProfileById,
  getEnabledCustomSkills,
  getLlmProviderById,
  getServiceById,
  getTargetById,
  listServices,
  listManagedChannels,
} from './db.js';
import { chat, streamChat } from './providers/index.js';
import { resolveSkills } from './skills/registry.js';
import { logger } from './logger.js';
import {
  ProviderError,
  type AgentProfile,
  type Channel,
  type LlmProvider,
  type OnServiceMessage,
} from './types.js';
import {
  createTelegramChannel,
  verifyTelegramBot,
} from './channels/telegram.js';
import { compactIfNeeded } from './compaction.js';
import { executePlan, readPlanFile } from './plan-executor.js';

const MAX_HISTORY_MESSAGES = 200;

/** Typing indicator 재전송 간격 (ms). Telegram은 ~5초 만료, 여유 있게 4초. */
const TYPING_INTERVAL_MS = 4_000;

/**
 * 채널에 typing indicator를 주기적으로 전송하는 루프 시작.
 * 반환된 함수를 호출하면 루프 중지 + 'paused' 전송.
 */
function startTypingLoop(
  channel: Channel | undefined,
  targetUserId: string,
): () => void {
  if (!channel?.setTyping) return () => {};

  channel.setTyping(targetUserId, true).catch(() => {});
  const interval = setInterval(() => {
    channel.setTyping!(targetUserId, true).catch(() => {});
  }, TYPING_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    channel.setTyping!(targetUserId, false).catch(() => {});
  };
}

/**
 * ISO 타임스탬프를 [YYYY-MM-DD HH:MM] 로컬 시간 포맷으로 변환.
 * time_aware 에이전트의 user 메시지에 프리픽스로 사용.
 */
function formatTimestamp(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]`;
}

/**
 * 대화 히스토리를 LLM 메시지 배열로 변환.
 * timeAware가 true면 user 메시지에 타임스탬프 프리픽스를 붙임.
 */
function buildLlmMessages(
  history: Array<{ role: string; content: string; timestamp: string }>,
  timeAware: boolean,
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return history.map((m) => {
    const role = m.role as 'user' | 'assistant' | 'system';
    if (timeAware && role === 'user') {
      const ts = formatTimestamp(m.timestamp);
      return { role, content: ts ? `${ts} ${m.content}` : m.content };
    }
    return { role, content: m.content };
  });
}

/** Active channel instances, keyed by managed_channels.id */
const activeChannels = new Map<string, Channel>();

/** Lock per service to prevent concurrent processing */
const processingLocks = new Set<string>();

/**
 * Handle inbound message from any channel.
 * Finds matching service, builds context, calls provider, sends response.
 */
const handleMessage: OnServiceMessage = (
  channelId: string,
  senderUserId: string,
  senderName: string,
  text: string,
) => {
  // Fire-and-forget; errors are logged internally
  processMessage(channelId, senderUserId, senderName, text).catch((err) => {
    logger.error(
      {
        channelId,
        senderUserId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to process service message',
    );
  });
};

async function processMessage(
  channelId: string,
  senderUserId: string,
  senderName: string,
  text: string,
): Promise<void> {
  const serviceMatch = findActiveService(channelId, senderUserId);
  if (!serviceMatch) {
    logger.debug(
      { channelId, senderUserId },
      'No active service for this channel+user, ignoring',
    );
    return;
  }

  const { id: serviceId, agent, provider } = serviceMatch;

  // Prevent concurrent processing for the same service
  if (processingLocks.has(serviceId)) {
    logger.debug(
      { serviceId },
      'Service is busy, message will be queued in conversation',
    );
    addConversationMessage(serviceId, 'user', text);
    return;
  }

  processingLocks.add(serviceId);

  const channel = activeChannels.get(channelId);
  const stopTyping = startTypingLoop(channel, senderUserId);

  // 타겟 닉네임 조회 (멀티타겟 워크스페이스 분리용)
  const target = getTargetById(serviceMatch.target_id);
  const targetName = target?.nickname || senderName;

  try {
    // Store user message
    addConversationMessage(serviceId, 'user', text);

    // Auto-compaction: summarize if context exceeds provider's window
    const compacted = await compactIfNeeded({
      serviceId,
      providerId: provider.provider_key,
      model: agent.model,
      apiKey: provider.api_key,
      baseUrl: provider.base_url || undefined,
      agentSystemPrompt: agent.system_prompt,
    });

    if (compacted) {
      logger.info({ serviceId }, 'Context compacted before API call');
    }

    // Build conversation context (after potential compaction)
    const history = getConversationHistory(serviceId, MAX_HISTORY_MESSAGES);
    const timeAware = agent.time_aware === 1;
    const messages = buildLlmMessages(history, timeAware);

    // sendMessage 콜백: Smart Step의 send_message 도구 + plan-executor 알림용
    const sendToUser = async (text: string) => {
      if (channel) await channel.sendMessage(senderUserId, text);
    };

    // Resolve skills: builtin tools + custom skills (script + prompt)
    const customSkills = getEnabledCustomSkills(agent.id);
    const sendPhotoToUser = channel?.sendPhoto
      ? async (filePath: string, caption?: string) => { await channel.sendPhoto!(senderUserId, filePath, caption); }
      : undefined;
    const ctxOverrides: Record<string, unknown> = { serviceId, targetName, sendPhoto: sendPhotoToUser };
    if (agent.smart_step === 1) {
      ctxOverrides.sendMessage = sendToUser;
    }
    const { tools, skillPrompts } = await resolveSkills(
      agent,
      customSkills,
      ctxOverrides,
    );
    const hasTools = Object.keys(tools).length > 0;

    logger.info(
      {
        serviceId,
        provider: provider.provider_key,
        model: agent.model,
        historyLen: messages.length,
        toolCount: Object.keys(tools).length,
        timeAware,
        smartStep: agent.smart_step === 1,
      },
      'Processing service message',
    );

    // Call provider (streaming, with tool calling if skills active)
    const response = await callProvider(
      agent,
      provider,
      messages,
      skillPrompts,
      tools,
      hasTools,
      timeAware,
      targetName,
    );

    stopTyping();

    if (!response.trim()) {
      logger.warn({ serviceId }, 'Empty response from provider');
      if (channel) {
        await channel
          .sendMessage(
            senderUserId,
            '⚠️ AI로부터 빈 응답을 받았습니다. 다시 시도해주세요.',
          )
          .catch(() => {});
      }
      return;
    }

    // Store assistant response
    addConversationMessage(serviceId, 'assistant', response);

    // Send response through channel
    if (channel) {
      await channel.sendMessage(senderUserId, response);
      logger.info(
        { serviceId, responseLen: response.length },
        'Service response sent',
      );
    } else {
      logger.warn({ channelId }, 'Channel not found for response delivery');
    }

    // Smart Step: 플랜 제출 감지 → plan-executor 실행
    if (agent.smart_step === 1) {
      const plan = readPlanFile(agent.id, serviceId);
      if (plan) {
        logger.info(
          { serviceId, agentId: agent.id },
          'Plan detected, starting plan execution',
        );
        // 플랜 실행은 비동기로 진행 (lock은 executePlan 내부에서 재획득)
        processingLocks.delete(serviceId);
        executePlan({
          serviceId,
          agentId: agent.id,
          targetName,
          processTurn: (prompt) =>
            processPlanTurn(
              serviceId,
              agent,
              provider,
              prompt,
              sendToUser,
              targetName,
            ),
          sendNotification: sendToUser,
        }).catch((err) => {
          logger.error(
            {
              serviceId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Plan execution failed',
          );
        });
        return; // lock은 executePlan이 관리
      }
    }
  } catch (err) {
    stopTyping();

    if (err instanceof ProviderError) {
      logger.warn(
        { serviceId, errorType: err.type, statusCode: err.statusCode },
        `Provider error forwarded to user: ${err.type}`,
      );
      if (channel) {
        await channel
          .sendMessage(senderUserId, err.userMessage)
          .catch(() => {});
      }
    } else {
      logger.error(
        { serviceId, err: err instanceof Error ? err.message : String(err) },
        'Service message processing error',
      );
      if (channel) {
        await channel
          .sendMessage(
            senderUserId,
            '⚠️ 메시지 처리 중 알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
          )
          .catch(() => {});
      }
    }
  } finally {
    processingLocks.delete(serviceId);
  }
}

/**
 * Initialize and connect all paired channels.
 * Called at startup from main().
 */
export async function initServiceChannels(): Promise<void> {
  const managedChannels = listManagedChannels();

  for (const mc of managedChannels) {
    if (mc.pairing_status !== 'paired') {
      logger.debug(
        { channelId: mc.id, type: mc.type },
        'Skipping unpaired channel',
      );
      continue;
    }

    try {
      const config = JSON.parse(mc.config_json || '{}');
      let channel: Channel | null = null;

      if (mc.type === 'telegram' && config.botToken) {
        channel = createTelegramChannel({
          channelId: mc.id,
          botToken: config.botToken,
          onMessage: handleMessage,
        });
      }

      if (channel) {
        await channel.connect();
        activeChannels.set(mc.id, channel);
        logger.info(
          { channelId: mc.id, type: mc.type },
          'Service channel connected',
        );
      }
    } catch (err) {
      logger.error(
        {
          channelId: mc.id,
          type: mc.type,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to connect service channel',
      );
    }
  }

  const services = listServices();
  const activeCount = services.filter((s) => s.status === 'active').length;
  logger.info(
    { channels: activeChannels.size, activeServices: activeCount },
    'Service router initialized',
  );
}

/**
 * Connect a newly paired channel at runtime (after pairing via Web UI).
 */
export async function connectChannel(channelId: string): Promise<void> {
  // Disconnect existing if any
  const existing = activeChannels.get(channelId);
  if (existing) {
    await existing.disconnect();
    activeChannels.delete(channelId);
  }

  const mc = listManagedChannels().find((c) => c.id === channelId);
  if (!mc) throw new Error(`Channel ${channelId} not found`);

  const config = JSON.parse(mc.config_json || '{}');
  let channel: Channel | null = null;

  if (mc.type === 'telegram' && config.botToken) {
    channel = createTelegramChannel({
      channelId: mc.id,
      botToken: config.botToken,
      onMessage: handleMessage,
    });
  }

  if (channel) {
    await channel.connect();
    activeChannels.set(mc.id, channel);
    logger.info({ channelId, type: mc.type }, 'Channel connected at runtime');
  }
}

/**
 * Disconnect a channel at runtime.
 */
export async function disconnectChannel(channelId: string): Promise<void> {
  const channel = activeChannels.get(channelId);
  if (channel) {
    await channel.disconnect();
    activeChannels.delete(channelId);
    logger.info({ channelId }, 'Channel disconnected');
  }
}

/**
 * Get connected channel count and names for status display.
 */
export function getConnectedChannelInfo(): { count: number; names: string[] } {
  const names: string[] = [];
  for (const ch of activeChannels.values()) {
    if (ch.isConnected()) names.push(ch.name);
  }
  return { count: names.length, names };
}

/**
 * Graceful shutdown - disconnect all channels.
 */
export async function shutdownServiceChannels(): Promise<void> {
  for (const [id, channel] of activeChannels) {
    try {
      await channel.disconnect();
    } catch (err) {
      logger.warn(
        { channelId: id, err },
        'Error disconnecting channel during shutdown',
      );
    }
  }
  activeChannels.clear();
}

/**
 * Provider 호출 공통 로직. processMessage + processPlanTurn에서 공유.
 */
async function callProvider(
  agent: AgentProfile,
  provider: LlmProvider,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  skillPrompts: string[],
  tools: Record<string, import('ai').Tool>,
  hasTools: boolean,
  timeAware: boolean,
  targetName?: string,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamChat({
    messages,
    agentSystemPrompt: agent.system_prompt,
    skillPrompts,
    providerId: provider.provider_key,
    model: agent.model,
    apiKey: provider.api_key,
    baseUrl: provider.base_url || undefined,
    timeAware,
    smartStep: agent.smart_step === 1,
    targetName,
    ...(hasTools ? { tools } : {}),
  })) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

/**
 * 플랜 배치 실행 턴. plan-executor가 호출.
 * 배치 프롬프트를 user 메시지로 주입 → LLM 호출 → 응답 저장.
 */
async function processPlanTurn(
  serviceId: string,
  agent: AgentProfile,
  provider: LlmProvider,
  batchPrompt: string,
  sendToUser: (text: string) => Promise<void>,
  targetName?: string,
): Promise<string> {
  // 배치 프롬프트를 시스템이 주입한 user 메시지로 저장
  addConversationMessage(serviceId, 'user', batchPrompt);

  await compactIfNeeded({
    serviceId,
    providerId: provider.provider_key,
    model: agent.model,
    apiKey: provider.api_key,
    baseUrl: provider.base_url || undefined,
    agentSystemPrompt: agent.system_prompt,
  });

  const history = getConversationHistory(serviceId, MAX_HISTORY_MESSAGES);
  const timeAware = agent.time_aware === 1;
  const messages = buildLlmMessages(history, timeAware);

  const customSkills = getEnabledCustomSkills(agent.id);
  const ctxOverrides = { sendMessage: sendToUser, serviceId, targetName };
  const { tools, skillPrompts } = await resolveSkills(
    agent,
    customSkills,
    ctxOverrides,
  );
  const hasTools = Object.keys(tools).length > 0;

  const response = await callProvider(
    agent,
    provider,
    messages,
    skillPrompts,
    tools,
    hasTools,
    timeAware,
    targetName,
  );

  if (response.trim()) {
    addConversationMessage(serviceId, 'assistant', response);
  }

  return response;
}

/**
 * Process a cron-triggered message for a service.
 * Wraps the prompt with cron metadata and runs through the same LLM pipeline.
 * Returns true if processed, false if lock conflict after retries.
 */
export async function processCronMessage(
  serviceId: string,
  cronName: string,
  cronPrompt: string,
  skillHintJson: string,
  scheduleLabel: string,
  notify: boolean,
): Promise<boolean> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 10_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!processingLocks.has(serviceId)) break;
    if (attempt < MAX_RETRIES - 1) {
      logger.debug({ serviceId, attempt }, 'Cron waiting for service lock');
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  if (processingLocks.has(serviceId)) {
    logger.warn(
      { serviceId, cronName },
      'Cron skipped: service still locked after retries',
    );
    return false;
  }

  processingLocks.add(serviceId);
  let stopCronTyping: () => void = () => {};

  try {
    const service = getServiceById(serviceId);
    if (!service || service.status !== 'active') return false;

    const agent = getAgentProfileById(service.agent_profile_id);
    if (!agent) return false;
    const provider = getLlmProviderById(agent.provider_id);
    if (!provider) return false;

    let skillLine = '';
    try {
      const hints: string[] = JSON.parse(skillHintJson);
      if (hints.length > 0)
        skillLine = `\n\n이 작업에 다음 도구를 활용하세요: ${hints.join(', ')}`;
    } catch {
      /* invalid JSON — skip */
    }

    const wrappedPrompt = `[예약 작업: "${cronName}" | ${scheduleLabel}]\n사용자가 예약한 작업입니다. 다음을 수행해주세요:\n\n${cronPrompt}${skillLine}`;

    addConversationMessage(serviceId, 'user', wrappedPrompt);

    const channel = activeChannels.get(service.channel_id);
    const targetId = service.target_id;

    const target = getTargetById(targetId);
    const platformUserId = target?.target_id || '';
    const cronTargetName = target?.nickname || '';

    if (notify && platformUserId) {
      stopCronTyping = startTypingLoop(channel, platformUserId);
    }

    await compactIfNeeded({
      serviceId,
      providerId: provider.provider_key,
      model: agent.model,
      apiKey: provider.api_key,
      baseUrl: provider.base_url || undefined,
      agentSystemPrompt: agent.system_prompt,
    });

    const history = getConversationHistory(serviceId, MAX_HISTORY_MESSAGES);
    const cronTimeAware = agent.time_aware === 1;
    const messages = buildLlmMessages(history, cronTimeAware);

    const customSkills = getEnabledCustomSkills(agent.id);
    const cronSendPhoto = channel?.sendPhoto && platformUserId
      ? async (filePath: string, caption?: string) => { await channel.sendPhoto!(platformUserId, filePath, caption); }
      : undefined;
    const { tools, skillPrompts } = await resolveSkills(agent, customSkills, {
      serviceId,
      targetName: cronTargetName,
      sendPhoto: cronSendPhoto,
    });
    const hasTools = Object.keys(tools).length > 0;

    logger.info(
      {
        serviceId,
        cronName,
        provider: provider.provider_key,
        model: agent.model,
        timeAware: cronTimeAware,
      },
      'Processing cron message',
    );

    const chunks: string[] = [];
    for await (const chunk of streamChat({
      messages,
      agentSystemPrompt: agent.system_prompt,
      skillPrompts,
      providerId: provider.provider_key,
      model: agent.model,
      apiKey: provider.api_key,
      baseUrl: provider.base_url || undefined,
      timeAware: cronTimeAware,
      ...(hasTools ? { tools } : {}),
    })) {
      chunks.push(chunk);
    }

    const response = chunks.join('');
    stopCronTyping();

    if (response.trim()) {
      addConversationMessage(serviceId, 'assistant', response);
      if (notify && channel && platformUserId) {
        await channel.sendMessage(platformUserId, response);
        logger.info(
          { serviceId, cronName, responseLen: response.length },
          'Cron response sent',
        );
      } else {
        logger.info(
          { serviceId, cronName, responseLen: response.length },
          'Cron response saved (notify=off)',
        );
      }
    }

    return true;
  } catch (err) {
    stopCronTyping();
    logger.error(
      {
        serviceId,
        cronName,
        err: err instanceof Error ? err.message : String(err),
      },
      'Cron message processing error',
    );
    return false;
  } finally {
    processingLocks.delete(serviceId);
  }
}

export { verifyTelegramBot };
