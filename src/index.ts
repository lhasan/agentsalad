/**
 * Agent Salad - Main Orchestrator
 *
 * Agent + Channel + Target = Service 모델 기반.
 * 서비스 라우터: 채널에서 메시지 수신 -> 서비스 매칭 -> 프로바이더 호출 -> 응답 전송.
 * Web UI: 관리 대시보드 (에이전트/채널/타겟/서비스 CRUD).
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
import { getTargetById } from './db.js';

/**
 * folder_name이 NULL인 기존 데이터에 슬러그 세팅 + 물리 폴더 리네임.
 * 서버 시작마다 실행해도 안전 (이미 세팅된 행은 스킵).
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

  initFolderNames(entries);
  logger.info({ count: entries.length }, 'Folder name map initialized');
}

/**
 * 워크스페이스 구조 마이그레이션: 에이전트 루트에 직접 있던 파일을 타겟 서브폴더로 이동.
 * 에이전트에 연결된 서비스가 정확히 1개일 때만 자동 마이그레이션.
 * 여러 서비스가 이미 연결된 경우 소유권 판단이 불가하므로 스킵 + 경고.
 */
function migrateWorkspaceToTargetFolders(): void {
  const services = listServices();
  const byAgent = new Map<string, typeof services>();
  for (const svc of services) {
    const list = byAgent.get(svc.agent_profile_id) || [];
    list.push(svc);
    byAgent.set(svc.agent_profile_id, list);
  }

  for (const [agentId, agentServices] of byAgent) {
    const wsPath = getWorkspacePath(agentId);
    if (!existsSync(wsPath)) continue;

    // 이미 타겟 서브폴더 구조가 있으면 스킵 (_shared/ 존재 = 이미 마이그레이션 됨)
    if (existsSync(join(wsPath, '_shared'))) continue;

    // 루트에 파일/폴더가 있는지 확인
    let rootEntries: string[];
    try {
      rootEntries = readdirSync(wsPath).filter(
        (n) => !n.startsWith('.') && !n.startsWith('_plan'),
      );
    } catch {
      continue;
    }
    if (rootEntries.length === 0) continue;

    if (agentServices.length !== 1) {
      logger.warn(
        { agentId, serviceCount: agentServices.length },
        'Workspace migration skipped: multiple services use this agent. Move files manually.',
      );
      continue;
    }

    const target = getTargetById(agentServices[0].target_id);
    if (!target) continue;

    const targetSlug = toFolderSlug(target.nickname);
    const targetPath = join(wsPath, targetSlug);

    if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });

    let moved = 0;
    for (const entry of rootEntries) {
      if (entry === targetSlug || entry === '_shared') continue;
      const src = join(wsPath, entry);
      const dst = join(targetPath, entry);
      try {
        if (!existsSync(dst)) {
          renameSync(src, dst);
          moved++;
        }
      } catch (err) {
        logger.warn(
          { agentId, entry, err },
          'Failed to migrate workspace entry',
        );
      }
    }

    // _shared/ 폴더 생성
    const sharedPath = join(wsPath, '_shared');
    if (!existsSync(sharedPath)) mkdirSync(sharedPath, { recursive: true });

    if (moved > 0) {
      logger.info(
        { agentId, target: target.nickname, movedEntries: moved },
        'Migrated workspace files to target subfolder',
      );
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');

  // folder_name 마이그레이션 + 인메모리 맵 초기화
  migrateFolderNames();

  // 워크스페이스 구조 마이그레이션 (에이전트 루트 → 타겟 서브폴더)
  migrateWorkspaceToTargetFolders();

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
        createManagedChannel({
          id,
          type: input.type,
          name: input.name,
          configJson: JSON.stringify(input.config || {}),
          status: 'configured',
          thumbnail: pickRandom(THUMBS_CHANNEL),
        });
        return id;
      },
      updateManagedChannel: (id, updates) => {
        updateManagedChannel(id, { name: updates.name });
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

          // Connect the channel immediately
          await connectChannel(channelId);

          return { success: true, botUsername: info.username };
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
        createTarget({
          id,
          targetId: input.targetId,
          nickname: input.nickname,
          platform: input.platform,
          thumbnail: pickRandom(THUMBS_TARGET),
        });
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
        const id = `svc-${Date.now().toString(36)}`;
        createService({
          id,
          agentProfileId: input.agentProfileId,
          channelId: input.channelId,
          targetId: input.targetId,
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
