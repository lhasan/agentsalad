/**
 * Service Router — 멀티채널 메시지 처리 엔진
 *
 * Channel 메시지 수신 -> MessageContext 기반 DM/room 분기 -> Service 매칭
 * -> 스킬 resolve (channelId 전파) -> 자동 compaction -> Provider 호출 -> 응답 전송.
 *
 * DM 메시지: findActiveService(channelId, userId) → user 타겟 매칭
 * 채널 메시지: findActiveServiceByRoom(channelId, roomId) → room 타겟 매칭
 *   → room 미매칭 시 findActiveService(channelId, userId) → user 타겟으로 방 내 응답
 * everyone 템플릿: 에이전트+채널+모두에게 서비스가 있으면 미매칭 시
 * 실제 userId/roomId별 Target+Service를 자동 생성
 *
 * 응답 라우팅: 타겟 타입이 아니라 메시지 원점(context.roomId) 기반.
 * 방에서 온 메시지 → 방으로 응답, DM → DM으로 응답. user 타겟이 방에서
 * 매칭돼도 방으로 응답한다 (DM이 아닌 발신 채널로 회신).
 *
 * Cron 스케줄러도 processCronMessage()를 통해 동일한 파이프라인 사용.
 * 채널 팩토리: createChannelByType()으로 Telegram/Discord/Slack 분기.
 * 워크스페이스 3-depth: store/workspaces/<agent>/<channel>/<target>/
 * 동일 서비스에 대한 동시 메시지를 배치 큐잉하여 순차 처리.
 */
import {
  addConversationMessage,
  createService,
  createTarget,
  findActiveService,
  findActiveServiceByRoom,
  findEveryoneTemplateService,
  getConversationHistory,
  getAgentProfileById,
  getEnabledCustomSkills,
  getLlmProviderById,
  getManagedChannelById,
  getServiceById,
  getTargetById,
  getTargetByTargetIdAndType,
  listServices,
  listManagedChannels,
} from './db.js';
import { streamChat } from './providers/index.js';
import { resolveSkills } from './skills/registry.js';
import { logger } from './logger.js';
import {
  ProviderError,
  type AgentProfile,
  type Channel,
  type LlmProvider,
  type MessageContext,
  type OnServiceMessage,
} from './types.js';
import { createChannelByType } from './channels/factory.js';
import { verifyTelegramBot } from './channels/telegram.js';
import { verifyDiscordBot } from './channels/discord.js';
import { verifySlackBot } from './channels/slack.js';
import { compactIfNeeded } from './compaction.js';
import { executePlan, readPlanFile } from './plan-executor.js';
import { toFolderSlug } from './skills/workspace.js';

const MAX_HISTORY_MESSAGES = 200;

/** Typing indicator 재전송 간격 (ms). Telegram은 ~5초 만료, 여유 있게 4초. */
const TYPING_INTERVAL_MS = 4_000;

/**
 * 채널에 typing indicator를 주기적으로 전송하는 루프 시작.
 * roomId가 주어지면 room typing (Discord 서버 채널 등), 아니면 DM typing.
 * 반환된 함수를 호출하면 루프 중지.
 */
function startTypingLoop(
  channel: Channel | undefined,
  targetUserId: string,
  roomId?: string,
): () => void {
  if (roomId && channel?.setTypingInRoom) {
    channel.setTypingInRoom(roomId, true).catch(() => {});
    const interval = setInterval(() => {
      channel.setTypingInRoom!(roomId, true).catch(() => {});
    }, TYPING_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      channel.setTypingInRoom!(roomId, false).catch(() => {});
    };
  }

  if (!channel?.setTyping || !targetUserId) return () => {};

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

/** 처리 중 도착한 메시지의 배치 대기열 (서비스별, 현재 턴 완료 시 드레인) */
interface PendingBatch {
  channelId: string;
  senderUserId: string;
  senderName: string;
  context?: MessageContext;
  count: number;
}

const pendingBatches = new Map<string, PendingBatch>();

/**
 * Handle inbound message from any channel.
 * Finds matching service, builds context, calls provider, sends response.
 */
const handleMessage: OnServiceMessage = (
  channelId: string,
  senderUserId: string,
  senderName: string,
  text: string,
  context?: MessageContext,
) => {
  processMessage(channelId, senderUserId, senderName, text, context).catch(
    (err) => {
      logger.error(
        {
          channelId,
          senderUserId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to process service message',
      );
    },
  );
};

function createTargetAndServiceFromTemplate(
  templateService: NonNullable<ReturnType<typeof findEveryoneTemplateService>>,
  platformId: string,
  displayName: string,
  targetType: 'user' | 'room',
): ReturnType<typeof findActiveService> {
  const channel = getManagedChannelById(templateService.channel_id);
  if (!channel) return undefined;

  const existingTarget = getTargetByTargetIdAndType(platformId, targetType);
  let targetInternalId = existingTarget?.id;

  if (!targetInternalId) {
    targetInternalId = `tgt-${Date.now().toString(36)}`;
    createTarget({
      id: targetInternalId,
      targetId: platformId,
      nickname: displayName,
      platform: channel.type,
      targetType,
      folderName: toFolderSlug(platformId),
      creationSource: 'everyone_template',
    });
    logger.info(
      {
        channelId: templateService.channel_id,
        platformId,
        targetType,
        templateServiceId: templateService.id,
        targetInternalId,
      },
      'Everyone template: target created',
    );
  }

  const serviceId = `svc-${Date.now().toString(36)}`;
  try {
    createService({
      id: serviceId,
      agentProfileId: templateService.agent.id,
      channelId: templateService.channel_id,
      targetId: targetInternalId,
      creationSource: 'everyone_template',
      spawnedFromTemplateServiceId: templateService.id,
    });
  } catch (err) {
    logger.warn(
      {
        channelId: templateService.channel_id,
        platformId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Everyone template: service creation failed (may already exist)',
    );
    if (targetType === 'user')
      return findActiveService(templateService.channel_id, platformId);
    return findActiveServiceByRoom(templateService.channel_id, platformId);
  }

  logger.info(
    {
      channelId: templateService.channel_id,
      templateServiceId: templateService.id,
      serviceId,
      agentId: templateService.agent.id,
      platformId,
      targetType,
    },
    'Everyone template: service created',
  );

  return {
    id: serviceId,
    agent_profile_id: templateService.agent.id,
    channel_id: templateService.channel_id,
    target_id: targetInternalId,
    creation_source: 'everyone_template' as const,
    spawned_from_template_service_id: templateService.id,
    status: 'active' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    agent: templateService.agent,
    provider: templateService.provider,
  };
}

function resolveTemplateService(
  channelId: string,
  platformId: string,
  displayName: string,
  targetType: 'user' | 'room',
): ReturnType<typeof findActiveService> {
  const templateService = findEveryoneTemplateService(channelId);
  if (templateService) {
    return createTargetAndServiceFromTemplate(
      templateService,
      platformId,
      displayName,
      targetType,
    );
  }
  return undefined;
}

/**
 * 서비스 턴 처리 코어: compaction → 히스토리 → 스킬 → LLM 호출 → 응답 전송.
 * processMessage와 배치 드레인 양쪽에서 공유. 유저 메시지 DB 저장은 호출자 책임.
 * @returns true if Smart Step plan executor took over (caller should stop draining)
 */
async function processServiceTurn(
  serviceId: string,
  agent: AgentProfile,
  provider: LlmProvider,
  targetId: string,
  channelId: string,
  senderUserId: string,
  senderName: string,
  context?: MessageContext,
): Promise<boolean> {
  const channel = activeChannels.get(channelId);
  const target = getTargetById(targetId);
  const targetName = target?.nickname || senderName;
  const targetFolderName =
    target?.folder_name || target?.target_id || senderUserId;
  const roomId = context?.roomId;
  const respondInRoom = !!roomId;

  const stopTyping = startTypingLoop(channel, senderUserId, roomId);

  const sendResponse = async (responseText: string) => {
    if (!channel) return;
    if (respondInRoom && channel.sendToRoom) {
      await channel.sendToRoom(roomId!, responseText, context?.threadId);
    } else {
      await channel.sendMessage(senderUserId, responseText);
    }
  };

  const sendToUser = async (notifyText: string) => {
    await sendResponse(notifyText);
  };

  try {
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

    const history = getConversationHistory(serviceId, MAX_HISTORY_MESSAGES);
    const timeAware = agent.time_aware === 1;
    const messages = buildLlmMessages(history, timeAware);

    const customSkills = getEnabledCustomSkills(agent.id);
    const sendPhotoToUser = channel?.sendPhoto
      ? async (filePath: string, caption?: string) => {
          await channel.sendPhoto!(senderUserId, filePath, caption);
        }
      : undefined;
    const ctxOverrides: Record<string, unknown> = {
      serviceId,
      channelId,
      targetName,
      targetFolderName,
      sendPhoto: sendPhotoToUser,
    };
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
        targetType: target?.target_type,
        respondInRoom,
      },
      'Processing service message',
    );

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
      await sendResponse(
        '⚠️ Received an empty response from AI. Please try again.',
      ).catch(() => {});
      return false;
    }

    addConversationMessage(serviceId, 'assistant', response);

    await sendResponse(response);
    logger.info(
      { serviceId, responseLen: response.length, respondInRoom },
      'Service response sent',
    );

    if (agent.smart_step === 1) {
      const plan = readPlanFile(agent.id, serviceId);
      if (plan) {
        logger.info(
          { serviceId, agentId: agent.id },
          'Plan detected, starting plan execution',
        );
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
              targetFolderName,
              channelId,
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
        return true;
      }
    }

    return false;
  } catch (err) {
    stopTyping();

    if (err instanceof ProviderError) {
      logger.warn(
        { serviceId, errorType: err.type, statusCode: err.statusCode },
        `Provider error forwarded to user: ${err.type}`,
      );
      await sendResponse(err.userMessage).catch(() => {});
    } else {
      logger.error(
        { serviceId, err: err instanceof Error ? err.message : String(err) },
        'Service message processing error',
      );
      await sendResponse(
        '⚠️ An unexpected error occurred while processing your message. Please try again shortly.',
      ).catch(() => {});
    }
    return false;
  }
}

/**
 * 메시지 처리 메인 함수. DM/room 분기 → 서비스 매칭 → 배치 큐잉 → LLM 호출 → 응답 전송.
 * 처리 중 도착한 메시지는 pendingBatches에 누적, 현재 턴 완료 후 드레인 루프로 일괄 처리.
 */
async function processMessage(
  channelId: string,
  senderUserId: string,
  senderName: string,
  text: string,
  context?: MessageContext,
): Promise<void> {
  const isDM = !context || context.isDM;
  const roomId = context?.roomId;

  // --- 서비스 매칭 ---
  let serviceMatch: ReturnType<typeof findActiveService>;

  if (isDM) {
    serviceMatch = findActiveService(channelId, senderUserId);
    if (!serviceMatch) {
      serviceMatch = resolveTemplateService(
        channelId,
        senderUserId,
        senderName,
        'user',
      );
    }
  } else if (roomId) {
    serviceMatch = findActiveServiceByRoom(channelId, roomId);
    if (!serviceMatch) {
      serviceMatch = findActiveService(channelId, senderUserId);
    }
    if (!serviceMatch) {
      serviceMatch = resolveTemplateService(
        channelId,
        roomId,
        `#${roomId}`,
        'room',
      );
    }
  } else {
    serviceMatch = undefined;
  }

  if (!serviceMatch) {
    logger.debug(
      { channelId, senderUserId, isDM, roomId },
      'No active service matched, ignoring',
    );
    return;
  }

  const { id: serviceId, agent, provider } = serviceMatch;

  // 처리 중이면 DB 저장 + 배치 대기열에 추가 (현재 턴 완료 후 일괄 처리)
  if (processingLocks.has(serviceId)) {
    addConversationMessage(serviceId, 'user', text);
    const existing = pendingBatches.get(serviceId);
    if (existing) {
      existing.count++;
      existing.senderUserId = senderUserId;
      existing.senderName = senderName;
      existing.context = context;
    } else {
      pendingBatches.set(serviceId, {
        channelId,
        senderUserId,
        senderName,
        context,
        count: 1,
      });
    }
    logger.debug(
      { serviceId, pendingCount: pendingBatches.get(serviceId)!.count },
      'Service busy, message queued for batch processing',
    );
    return;
  }

  processingLocks.add(serviceId);

  try {
    addConversationMessage(serviceId, 'user', text);

    const planStarted = await processServiceTurn(
      serviceId,
      agent,
      provider,
      serviceMatch.target_id,
      channelId,
      senderUserId,
      senderName,
      context,
    );
    if (planStarted) return;

    // 처리 중 쌓인 배치 메시지 드레인 (while: 드레인 중 추가 메시지 대응)
    while (pendingBatches.has(serviceId)) {
      const batch = pendingBatches.get(serviceId)!;
      pendingBatches.delete(serviceId);

      logger.info(
        { serviceId, batchCount: batch.count },
        'Draining batched messages',
      );

      const batchPlanStarted = await processServiceTurn(
        serviceId,
        agent,
        provider,
        serviceMatch.target_id,
        batch.channelId,
        batch.senderUserId,
        batch.senderName,
        batch.context,
      );
      if (batchPlanStarted) return;
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
      const channel = createChannelByType(
        mc.type,
        mc.id,
        config,
        handleMessage,
      );

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
  const existing = activeChannels.get(channelId);
  if (existing) {
    await existing.disconnect();
    activeChannels.delete(channelId);
  }

  const mc = listManagedChannels().find((c) => c.id === channelId);
  if (!mc) throw new Error(`Channel ${channelId} not found`);

  const config = JSON.parse(mc.config_json || '{}');
  const channel = createChannelByType(mc.type, mc.id, config, handleMessage);

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
  targetFolderName?: string,
  planChannelId?: string,
): Promise<string> {
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
  const ctxOverrides = {
    sendMessage: sendToUser,
    serviceId,
    channelId: planChannelId,
    targetName,
    targetFolderName,
  };
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
    const cronTargetFolderName = target?.folder_name || platformUserId;
    const isRoomTarget = target?.target_type === 'room';

    if (notify && platformUserId) {
      stopCronTyping = isRoomTarget
        ? startTypingLoop(channel, '', platformUserId)
        : startTypingLoop(channel, platformUserId);
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
    const cronSendPhoto =
      channel?.sendPhoto && platformUserId
        ? async (filePath: string, caption?: string) => {
            await channel.sendPhoto!(platformUserId, filePath, caption);
          }
        : undefined;
    const { tools, skillPrompts } = await resolveSkills(agent, customSkills, {
      serviceId,
      channelId: service.channel_id,
      targetName: cronTargetName,
      targetFolderName: cronTargetFolderName,
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
        if (isRoomTarget && channel.sendToRoom) {
          await channel.sendToRoom(platformUserId, response);
        } else {
          await channel.sendMessage(platformUserId, response);
        }
        logger.info(
          { serviceId, cronName, responseLen: response.length, isRoomTarget },
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

export { verifyTelegramBot, verifyDiscordBot, verifySlackBot };
