/**
 * Agent Salad — Main Orchestrator
 *
 * Agent + Channel + Target = Service 모델 기반.
 * Target은 user/room 외에 everyone(기본 자동 생성 템플릿)도 지원한다.
 * 멀티채널: Telegram/Discord/Slack. 채널 팩토리로 타입별 분기.
 * 워크스페이스 3-depth: store/workspaces/<agent>/<channel>/<target>/.
 * Web UI: 관리 대시보드 (에이전트/채널/타겟/서비스 CRUD).
 * 서버 시작 시 folder_name 마이그레이션 + 2-depth→3-depth 워크스페이스 변환.
 * 최근 수정: targets.folder_name을 도입해 자동 생성 타겟 워크스페이스를
 * 닉네임이 아니라 안정적인 식별자 기반 폴더로 고정한다.
 */
import { WEB_UI_ENABLED, WEB_UI_HOST, WEB_UI_PORT } from './config.js';
import {
  createAgentProfile,
  createCustomSkill,
  createManagedChannel,
  createService,
  createTarget,
  attachCronToService,
  createCronJob,
  deleteAgentProfile,
  deleteCustomSkill,
  deleteCronJob,
  deleteManagedChannel,
  deleteService,
  deleteTarget,
  detachCronFromService,
  getAgentCustomSkills,
  getLlmProviderById,
  getManagedChannelById,
  getTargetById,
  initDatabase,
  listAgentProfiles,
  listCronJobs,
  listCustomSkills,
  listLlmProviders,
  listManagedChannels,
  listServiceCrons,
  listServices,
  listTargets,
  setAgentCustomSkill,
  updateAgentProfile,
  updateCronJob,
  updateCustomSkill,
  updateManagedChannel,
  updateServiceStatus,
  updateTarget,
  upsertLlmProvider,
} from './db.js';
import { listBuiltinSkillMeta } from './skills/registry.js';
import {
  getWorkspacePath,
  getTargetWorkspacePath,
  ensureWorkspace,
  ensureSkillScript,
  removeSkillScript,
  getSkillScriptDir,
  getSkillScriptPath,
  skillScriptExists,
  initFolderNames,
  registerFolderName,
  toFolderSlug,
  uniqueFolderSlug,
  renameSkillFolder,
  renameWorkspaceFolder,
  renameChannelFolder,
  getSkillsRoot,
  getWorkspacesRoot,
} from './skills/workspace.js';
import { isGogAvailable } from './skills/builtin/google/index.js';
import {
  initServiceChannels,
  shutdownServiceChannels,
  getConnectedChannelInfo,
  connectChannel,
  verifyTelegramBot,
  verifyDiscordBot,
  verifySlackBot,
} from './service-router.js';
import { startWebUiServer } from './web-ui.js';
import {
  startCronScheduler,
  stopCronScheduler,
  computeDailyNextRun,
  computeOnceNextRun,
} from './cron-scheduler.js';
import { logger } from './logger.js';
import type { AgentProfile } from './types.js';
import { getEveryoneTargetId } from './types.js';
import { cleanupStalePlans } from './plan-executor.js';
import { browserManager } from './skills/builtin/browser-manager.js';
import { readdirSync, statSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, relative } from 'path';

// 카테고리별 샐러드 재료 이모지 (랜덤 배정용)
const THUMBS_AGENT = [
  '🥩',
  '🍗',
  '🥚',
  '🧀',
  '🍤',
  '🥓',
  '🐟',
  '🦐',
  '🍖',
  '🥜',
];
const THUMBS_CHANNEL = [
  '🥬',
  '🥦',
  '🥒',
  '🫑',
  '🌿',
  '🍃',
  '🌱',
  '🪴',
  '🥝',
  '🫛',
];
const THUMBS_TARGET = [
  '🍅',
  '🥕',
  '🌽',
  '🧅',
  '🥑',
  '🫒',
  '🍋',
  '🧄',
  '🫐',
  '🍊',
];
const THUMBS_CRON = [
  '🌶️',
  '🧂',
  '🫚',
  '🍯',
  '🫘',
  '🥫',
  '🥣',
  '🍶',
  '🧈',
  '🥄',
];
const pickRandom = (arr: string[]) =>
  arr[Math.floor(Math.random() * arr.length)];

/**
 * folder_name이 NULL인 기존 데이터에 슬러그 세팅 + 물리 폴더 리네임.
 * 서버 시작마다 실행해도 안전 (이미 세팅된 행은 스킵).
 * 에이전트, 채널, 타겟, 커스텀 스킬 모두 처리.
 */
function migrateFolderNames(): void {
  const entries: Array<{ id: string; folderName: string }> = [];

  // Agent profiles
  for (const agent of listAgentProfiles()) {
    if (!agent.folder_name || agent.folder_name === agent.id) {
      const slug = uniqueFolderSlug(
        getWorkspacesRoot(),
        toFolderSlug(agent.name),
      );
      const oldPath = join(getWorkspacesRoot(), agent.id);
      const newPath = join(getWorkspacesRoot(), slug);
      if (existsSync(oldPath) && !existsSync(newPath)) {
        renameSync(oldPath, newPath);
        logger.info(
          { agentId: agent.id, from: agent.id, to: slug },
          'Migrated agent workspace folder',
        );
      }
      updateAgentProfile(agent.id, { folder_name: slug });
      entries.push({ id: agent.id, folderName: slug });
    } else {
      entries.push({ id: agent.id, folderName: agent.folder_name });
    }
  }

  // Managed channels (채널 folder_name 마이그레이션)
  for (const mc of listManagedChannels()) {
    if (!mc.folder_name || mc.folder_name === mc.id) {
      const slug = toFolderSlug(`${mc.type}-${mc.name}`);
      updateManagedChannel(mc.id, { folderName: slug });
      entries.push({ id: mc.id, folderName: slug });
    } else {
      entries.push({ id: mc.id, folderName: mc.folder_name });
    }
  }

  // Custom skills
  for (const cs of listCustomSkills()) {
    if (!cs.folder_name || cs.folder_name === cs.id) {
      const slug = uniqueFolderSlug(getSkillsRoot(), toFolderSlug(cs.name));
      const oldPath = join(getSkillsRoot(), cs.id);
      const newPath = join(getSkillsRoot(), slug);
      if (existsSync(oldPath) && !existsSync(newPath)) {
        renameSync(oldPath, newPath);
        logger.info(
          { skillId: cs.id, from: cs.id, to: slug },
          'Migrated skill folder',
        );
      }
      updateCustomSkill(cs.id, { folder_name: slug });
      entries.push({ id: cs.id, folderName: slug });
    } else {
      entries.push({ id: cs.id, folderName: cs.folder_name });
    }
  }

  // Targets
  for (const target of listTargets()) {
    const folderName = target.folder_name || toFolderSlug(target.nickname);
    if (!target.folder_name) {
      updateTarget(target.id, { folderName });
    }
    entries.push({ id: target.id, folderName });
  }

  initFolderNames(entries);
  logger.info({ count: entries.length }, 'Folder name map initialized');
}

/**
 * 플랫폼별 기본 everyone 타겟을 항상 보장.
 * 사용자가 생성/삭제하는 객체가 아니라 시스템 기본 템플릿으로 노출된다.
 */
function ensureDefaultEveryoneTargets(): void {
  const existing = listTargets();
  const platforms = ['telegram', 'discord', 'slack'] as const;

  for (const platform of platforms) {
    const everyoneTargetId = getEveryoneTargetId(platform);
    const already = existing.find(
      (target) =>
        target.platform === platform && target.target_type === 'everyone',
    );
    if (already) continue;

    createTarget({
      id: `target-${platform}-everyone`,
      targetId: everyoneTargetId,
      nickname: '모두에게',
      platform,
      targetType: 'everyone',
      folderName: toFolderSlug(`everyone-${platform}`),
      thumbnail: pickRandom(THUMBS_TARGET),
    });
  }
}

/**
 * 워크스페이스 3-depth 마이그레이션: agent/<target>/ → agent/<channel>/<target>/.
 * 기존 2-depth 구조 (에이전트 루트에 타겟 폴더가 직접 있는 경우)를
 * 서비스 테이블의 channel_id를 참조하여 채널 폴더 아래로 이동.
 *
 * 판단 기준: 에이전트 워크스페이스에 채널 folder_name과 일치하는 폴더가 없으면
 * 기존 2-depth로 간주하고 마이그레이션.
 */
function migrateWorkspaceToChannelFolders(): void {
  const services = listServices();
  const channels = listManagedChannels();
  const channelMap = new Map(channels.map((c) => [c.id, c]));

  // 서비스별로 처리: 각 서비스의 target 폴더를 channel 하위로 이동
  for (const svc of services) {
    const agentWsPath = getWorkspacePath(svc.agent_profile_id);
    if (!existsSync(agentWsPath)) continue;

    const target = getTargetById(svc.target_id);
    if (!target) continue;

    const mc = channelMap.get(svc.channel_id);
    if (!mc) continue;

    const targetSlug = target.folder_name || toFolderSlug(target.nickname);
    const channelSlug = mc.folder_name || toFolderSlug(`${mc.type}-${mc.name}`);

    const oldTargetPath = join(agentWsPath, targetSlug);
    const newChannelDir = join(agentWsPath, channelSlug);
    const newTargetPath = join(newChannelDir, targetSlug);

    // 이미 3-depth 구조에 있으면 스킵
    if (existsSync(newTargetPath)) continue;

    // 기존 2-depth 폴더가 있으면 이동
    if (existsSync(oldTargetPath)) {
      mkdirSync(newChannelDir, { recursive: true });
      try {
        renameSync(oldTargetPath, newTargetPath);
        logger.info(
          {
            agentId: svc.agent_profile_id,
            target: target.nickname,
            channel: channelSlug,
          },
          'Migrated workspace to 3-depth (agent/channel/target)',
        );
      } catch (err) {
        logger.warn(
          { agentId: svc.agent_profile_id, target: target.nickname, err },
          'Failed to migrate workspace to 3-depth',
        );
      }
    }
  }

  // _shared/ 폴더는 에이전트 루트에 유지 (이동 불필요)
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');

  ensureDefaultEveryoneTargets();

  // folder_name 마이그레이션 + 인메모리 맵 초기화
  migrateFolderNames();

  // 워크스페이스 3-depth 마이그레이션 (agent/target → agent/channel/target)
  migrateWorkspaceToChannelFolders();

  // 기존 스킬 폴더에 누락된 prompt.txt, GUIDE.md 생성
  for (const cs of listCustomSkills()) {
    if (cs.tool_name?.trim()) {
      ensureSkillScript(cs.id, cs.tool_name);
    }
  }

  // 크래시 복구: 이전 세션에서 남은 _plan-*.json 파일 삭제
  cleanupStalePlans(getWorkspacesRoot());

  // Initialize service channels (connect all paired Telegram bots)
  await initServiceChannels();

  let webUiServer: import('http').Server | null = null;
  if (WEB_UI_ENABLED) {
    webUiServer = startWebUiServer(WEB_UI_HOST, WEB_UI_PORT, {
      getConnectedChannels: () => getConnectedChannelInfo().names,
      getActiveServiceCount: () =>
        listServices().filter((s) => s.status === 'active').length,

      // Agent profiles
      getAgentProfiles: () => listAgentProfiles(),
      upsertAgentProfile: (input) => {
        if (input.id) {
          // 이름 변경 감지 → 폴더 리네임
          if (input.name) {
            const existing = listAgentProfiles().find((a) => a.id === input.id);
            if (existing && existing.name !== input.name) {
              const newSlug = uniqueFolderSlug(
                getWorkspacesRoot(),
                toFolderSlug(input.name),
              );
              renameWorkspaceFolder(input.id, newSlug);
              updateAgentProfile(input.id, { folder_name: newSlug });
            }
          }
          updateAgentProfile(input.id, {
            name: input.name,
            description: input.description,
            provider_id: input.providerId,
            model: input.model,
            system_prompt: input.systemPrompt,
            skills: input.skills,
            ...(input.timeAware !== undefined
              ? { time_aware: input.timeAware ? 1 : 0 }
              : {}),
            ...(input.smartStep !== undefined
              ? { smart_step: input.smartStep ? 1 : 0 }
              : {}),
            ...(input.maxPlanSteps !== undefined
              ? {
                  max_plan_steps: Math.max(1, Math.min(30, input.maxPlanSteps)),
                }
              : {}),
          });
          return input.id;
        }
        const id = `agent-${Date.now().toString(36)}`;
        const agentName = input.name || `에이전트-${id.slice(-4)}`;
        const folderName = uniqueFolderSlug(
          getWorkspacesRoot(),
          toFolderSlug(agentName),
        );
        createAgentProfile({
          id,
          name: agentName,
          description: input.description || '',
          provider_id: input.providerId || 'anthropic',
          model: input.model || 'claude-sonnet-4-20250514',
          system_prompt: input.systemPrompt || '',
          skills: input.skills,
          folder_name: folderName,
          thumbnail: pickRandom(THUMBS_AGENT),
          time_aware: input.timeAware ? 1 : 0,
          smart_step: input.smartStep ? 1 : 0,
          max_plan_steps: input.maxPlanSteps ?? 10,
        });
        registerFolderName(id, folderName);
        return id;
      },
      deleteAgentProfile: (id) => {
        deleteAgentProfile(id);
      },

      // LLM providers
      listLlmProviders: () => listLlmProviders(),
      setProviderApiKey: (providerId, apiKey) => {
        const existing = getLlmProviderById(providerId);
        if (!existing) throw new Error('Unknown provider id');
        upsertLlmProvider({
          id: existing.id,
          providerKey: existing.provider_key,
          name: existing.name,
          baseUrl: existing.base_url,
          authScheme: existing.auth_scheme,
          apiKey: typeof apiKey === 'string' ? apiKey : existing.api_key,
          enabled: existing.enabled === 1,
        });
      },

      // Channels
      listManagedChannels: () => listManagedChannels(),
      createManagedChannel: (input) => {
        const id = `channel-${Date.now().toString(36)}`;
        const folderName = toFolderSlug(
          `${input.type}-${input.name || 'channel'}`,
        );
        createManagedChannel({
          id,
          type: input.type,
          name: input.name,
          configJson: JSON.stringify(input.config || {}),
          status: 'configured',
          folderName,
          thumbnail: pickRandom(THUMBS_CHANNEL),
        });
        registerFolderName(id, folderName);
        return id;
      },
      updateManagedChannel: (id, updates) => {
        updateManagedChannel(id, {
          name: updates.name,
          autoSession: updates.autoSession,
        });
      },
      deleteManagedChannel: (id) => {
        deleteManagedChannel(id);
      },

      pairTelegramBot: async (channelId, botToken) => {
        try {
          const info = await verifyTelegramBot(botToken);
          if (!info) return { success: false, error: 'Invalid bot token' };

          updateManagedChannel(channelId, {
            configJson: JSON.stringify({
              botToken,
              botId: info.id,
              botUsername: info.username,
            }),
            pairingStatus: 'paired',
            status: 'active',
          });

          await connectChannel(channelId);
          return { success: true, botUsername: info.username };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      pairDiscordBot: async (channelId: string, botToken: string) => {
        try {
          const info = await verifyDiscordBot(botToken);
          if (!info)
            return { success: false, error: 'Invalid Discord bot token' };

          updateManagedChannel(channelId, {
            configJson: JSON.stringify({
              botToken,
              botId: info.id,
              botUsername: info.username,
            }),
            pairingStatus: 'paired',
            status: 'active',
          });

          await connectChannel(channelId);
          return { success: true, botUsername: info.username, botId: info.id };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },

      pairSlackBot: async (
        channelId: string,
        botToken: string,
        appToken: string,
      ) => {
        try {
          const info = await verifySlackBot(botToken, appToken);
          if (!info) return { success: false, error: 'Invalid Slack tokens' };

          updateManagedChannel(channelId, {
            configJson: JSON.stringify({
              botToken,
              appToken,
              botUserId: info.userId,
              botName: info.botName,
              teamName: info.teamName,
            }),
            pairingStatus: 'paired',
            status: 'active',
          });

          await connectChannel(channelId);
          return { success: true, botUsername: info.botName };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      updateChannelPairing: (id, status, config) => {
        updateManagedChannel(id, { pairingStatus: status, configJson: config });
      },
      connectChannel: async (channelId) => {
        await connectChannel(channelId);
      },

      // Targets
      listTargets: () => listTargets(),
      createTarget: (input) => {
        const id = `target-${Date.now().toString(36)}`;
        const folderName =
          input.targetType === 'everyone'
            ? toFolderSlug(`everyone-${input.platform}`)
            : toFolderSlug(input.nickname || input.targetId || id);
        createTarget({
          id,
          targetId: input.targetId,
          nickname: input.nickname,
          platform: input.platform,
          targetType: input.targetType,
          folderName,
          thumbnail: pickRandom(THUMBS_TARGET),
        });
        registerFolderName(id, folderName);
        return id;
      },
      updateTarget: (id, updates) => {
        updateTarget(id, updates);
      },
      deleteTarget: (id) => {
        deleteTarget(id);
      },

      // Services
      listServices: () => listServices(),
      createService: (input) => {
        const mc = getManagedChannelById(input.channelId);
        const tg = getTargetById(input.targetId);
        if (mc && tg && mc.type !== tg.platform) {
          throw new Error(
            `Channel type "${mc.type}" does not match target platform "${tg.platform}"`,
          );
        }
        const id = `svc-${Date.now().toString(36)}`;
        createService({
          id,
          agentProfileId: input.agentProfileId,
          channelId: input.channelId,
          targetId: input.targetId,
          creationSource: 'manual',
        });
        return id;
      },
      updateServiceStatus: (id, status) => {
        updateServiceStatus(id, status);
      },
      deleteService: (id) => {
        deleteService(id);
      },

      // Skills system
      listBuiltinSkills: () => listBuiltinSkillMeta(),
      listCustomSkills: () => listCustomSkills(),
      createCustomSkill: (input) => {
        const id = `cskill-${Date.now().toString(36)}`;
        const folderName = uniqueFolderSlug(
          getSkillsRoot(),
          toFolderSlug(input.name),
        );
        createCustomSkill({
          id,
          name: input.name,
          description: input.description,
          prompt: input.prompt,
          script: input.script,
          input_schema: input.input_schema,
          tool_name: input.tool_name,
          timeout_ms: input.timeout_ms,
          folder_name: folderName,
        });
        registerFolderName(id, folderName);
        if (input.tool_name) {
          ensureSkillScript(id, input.tool_name);
        }
        return id;
      },
      updateCustomSkill: (id, updates) => {
        // 이름 변경 감지 → 폴더 리네임
        if (updates.name) {
          const existing = listCustomSkills().find((s) => s.id === id);
          if (existing && existing.name !== updates.name) {
            const newSlug = uniqueFolderSlug(
              getSkillsRoot(),
              toFolderSlug(updates.name),
            );
            renameSkillFolder(id, newSlug);
            updateCustomSkill(id, { folder_name: newSlug });
          }
        }
        updateCustomSkill(id, updates);
        if (updates.tool_name && !skillScriptExists(id)) {
          ensureSkillScript(id, updates.tool_name);
        }
      },
      deleteCustomSkill: (id) => {
        deleteCustomSkill(id);
        removeSkillScript(id);
      },
      getAgentCustomSkills: (agentId) => getAgentCustomSkills(agentId),
      setAgentCustomSkill: (agentId, skillId, enabled) => {
        setAgentCustomSkill(agentId, skillId, enabled);
      },
      updateAgentSkills: (agentId, skills) => {
        updateAgentProfile(agentId, { skills });
      },
      getSkillScriptPath: (skillId) => getSkillScriptPath(skillId),
      getSkillScriptDir: (skillId) => getSkillScriptDir(skillId),
      skillScriptExists: (skillId) => skillScriptExists(skillId),

      // Workspace
      listWorkspaceFiles: (agentId, subdir) => {
        const wsPath = ensureWorkspace(agentId);
        const targetDir = subdir ? join(wsPath, subdir) : wsPath;
        try {
          const items = readdirSync(targetDir, { withFileTypes: true });
          return items
            .slice(0, 200)
            .map((item: { isDirectory: () => boolean; name: string }) => {
              const full = join(targetDir, item.name);
              const rel = relative(wsPath, full);
              if (item.isDirectory())
                return { name: rel + '/', type: 'directory' };
              try {
                const s = statSync(full);
                return { name: rel, type: 'file', size: s.size };
              } catch {
                return { name: rel, type: 'file' };
              }
            });
        } catch {
          return [];
        }
      },
      getWorkspacePath: (agentId) => getWorkspacePath(agentId),
      getTargetWorkspacePath: (agentId, channelId, targetFolderRef) =>
        getTargetWorkspacePath(agentId, channelId, targetFolderRef),

      // Cron jobs
      listCronJobs: () => listCronJobs(),
      listServiceCrons: () => listServiceCrons(),
      createCronJob: (input: {
        name: string;
        prompt: string;
        skillHint?: string;
        scheduleType: 'daily' | 'once';
        scheduleTime: string;
        notify?: boolean;
      }) => {
        const id = `cron-${Date.now().toString(36)}`;
        createCronJob({
          id,
          name: input.name,
          prompt: input.prompt,
          skillHint: input.skillHint,
          scheduleType: input.scheduleType,
          scheduleTime: input.scheduleTime,
          notify: input.notify,
          thumbnail: pickRandom(THUMBS_CRON),
        });
        return id;
      },
      updateCronJob: (id: string, updates: Record<string, unknown>) => {
        updateCronJob(id, updates as Parameters<typeof updateCronJob>[1]);
      },
      deleteCronJob: (id: string) => {
        deleteCronJob(id);
      },
      attachCronToService: (
        serviceId: string,
        cronId: string,
        scheduleType: string,
        scheduleTime: string,
      ) => {
        const nextRun =
          scheduleType === 'daily'
            ? computeDailyNextRun(scheduleTime)
            : computeOnceNextRun(scheduleTime);
        attachCronToService(serviceId, cronId, nextRun);
      },
      detachCronFromService: (serviceId: string, cronId: string) => {
        detachCronFromService(serviceId, cronId);
      },

      // Google integration
      getGogStatus: () => ({ installed: isGogAvailable() }),
    });
  }

  // Start cron scheduler
  startCronScheduler();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopCronScheduler();
    webUiServer?.close();
    await browserManager.shutdown();
    await shutdownServiceChannels();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelInfo = getConnectedChannelInfo();
  const services = listServices().filter((s) => s.status === 'active');
  logger.info(
    { connectedChannels: channelInfo.count, activeServices: services.length },
    'Agent Salad running',
  );

  if (channelInfo.count === 0 && WEB_UI_ENABLED) {
    logger.warn(
      'No channels connected. Visit the Web UI to add and pair channels.',
    );
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start Agent Salad');
    process.exit(1);
  });
}
