/**
 * Agent Salad — Admin Dashboard
 *
 * 단일 페이지 UI (라이트 테마 + 샐러드 메타포 + 4개국어 i18n)
 * My Salads 탭: 서비스 카드 + 크론 영역 + 3열 블록 그리드 (에이전트/채널/대상)
 * Agents 탭: 에이전트 상세 설정 (스킬, 프롬프트)
 * Skills 탭: 기본/커스텀 스킬 카탈로그
 *
 * 멀티채널: Telegram/Discord/Slack 페어링 API 지원 (채널 타입별 분기).
 * WebUiContext에 pairDiscordBot, pairSlackBot 추가.
 */
import http from 'http';
import { URL } from 'url';

import { logger } from './logger.js';
import type {
  AgentProfile,
  AgentSkillToggles,
  ChannelType,
  CronJob,
  CustomSkill,
  LlmProvider,
  ManagedChannel,
  Service,
  ServiceCron,
  TargetProfile,
} from './types.js';

export interface WebUiContext {
  getConnectedChannels: () => string[];
  getActiveServiceCount: () => number;
  getAgentProfiles: () => AgentProfile[];
  upsertAgentProfile: (input: {
    id?: string;
    name?: string;
    description?: string;
    providerId?: string;
    model?: string;
    systemPrompt?: string;
    skills: AgentSkillToggles;
    timeAware?: boolean;
    smartStep?: boolean;
    maxPlanSteps?: number;
  }) => string;
  deleteAgentProfile: (id: string) => void;
  listLlmProviders: () => LlmProvider[];
  setProviderApiKey: (providerId: string, apiKey: string) => void;
  listManagedChannels: () => ManagedChannel[];
  createManagedChannel: (input: {
    type: ChannelType;
    name: string;
    config: Record<string, string>;
  }) => string;
  updateManagedChannel: (
    id: string,
    updates: { name?: string; autoSession?: number },
  ) => void;
  deleteManagedChannel: (id: string) => void;
  pairTelegramBot: (
    channelId: string,
    botToken: string,
  ) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  pairDiscordBot: (
    channelId: string,
    botToken: string,
  ) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  pairSlackBot: (
    channelId: string,
    botToken: string,
    appToken: string,
  ) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  updateChannelPairing: (id: string, status: string, config?: string) => void;
  connectChannel: (channelId: string) => Promise<void>;
  listTargets: () => TargetProfile[];
  createTarget: (input: {
    targetId: string;
    nickname: string;
    platform: ChannelType;
    targetType?: 'user' | 'room';
  }) => string;
  updateTarget: (
    id: string,
    updates: {
      targetId?: string;
      nickname?: string;
      platform?: ChannelType;
      targetType?: 'user' | 'room';
    },
  ) => void;
  deleteTarget: (id: string) => void;
  listServices: () => Service[];
  createService: (input: {
    agentProfileId: string;
    channelId: string;
    targetId: string;
  }) => string;
  updateServiceStatus: (id: string, status: 'active' | 'paused') => void;
  deleteService: (id: string) => void;
  // Skills system
  listBuiltinSkills: () => Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    available: boolean;
  }>;
  listCustomSkills: () => CustomSkill[];
  createCustomSkill: (input: {
    name: string;
    description: string;
    prompt: string;
    script?: string;
    input_schema?: string;
    tool_name?: string;
    timeout_ms?: number;
  }) => string;
  updateCustomSkill: (
    id: string,
    updates: {
      name?: string;
      description?: string;
      prompt?: string;
      script?: string;
      input_schema?: string;
      tool_name?: string;
      timeout_ms?: number;
    },
  ) => void;
  deleteCustomSkill: (id: string) => void;
  getAgentCustomSkills: (
    agentId: string,
  ) => Array<CustomSkill & { enabled: number }>;
  setAgentCustomSkill: (
    agentId: string,
    skillId: string,
    enabled: boolean,
  ) => void;
  updateAgentSkills: (agentId: string, skills: AgentSkillToggles) => void;
  // Workspace
  listWorkspaceFiles: (
    agentId: string,
    subdir?: string,
  ) => Array<{ name: string; type: string; size?: number }>;
  getWorkspacePath: (agentId: string) => string;
  // Skill script files
  getSkillScriptPath: (skillId: string) => string;
  getSkillScriptDir: (skillId: string) => string;
  skillScriptExists: (skillId: string) => boolean;
  // Cron jobs
  listCronJobs: () => CronJob[];
  listServiceCrons: () => ServiceCron[];
  createCronJob: (input: {
    name: string;
    prompt: string;
    skillHint?: string;
    scheduleType: 'daily' | 'once';
    scheduleTime: string;
    notify?: boolean;
  }) => string;
  updateCronJob: (id: string, updates: Record<string, unknown>) => void;
  deleteCronJob: (id: string) => void;
  attachCronToService: (
    serviceId: string,
    cronId: string,
    scheduleType: string,
    scheduleTime: string,
  ) => void;
  detachCronFromService: (serviceId: string, cronId: string) => void;
  // Google integration
  getGogStatus: () => { installed: boolean };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Salad</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#ffffff;--s1:#f5f8f5;--s2:#eaf0ea;--s3:#dbe4db;--border:#c8d5c8;
  --t1:#1a2e1a;--t2:#546e54;--t3:#8a9d8a;
  --indigo:#FF6B35;--indigo-s:rgba(255,107,53,.08);--indigo-h:#FF8C5A;
  --green:#43A047;--green-s:rgba(67,160,71,.08);
  --amber:#F9A825;--amber-s:rgba(249,168,37,.08);
  --red:#E53935;--red-s:rgba(229,57,53,.08);
  --cyan:#E91E63;--cyan-s:rgba(233,30,99,.08);
  --r:12px;--rl:16px;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --mono:'SF Mono','Fira Code','Cascadia Code',monospace;
  --shadow:0 1px 3px rgba(26,46,26,.06),0 1px 2px rgba(26,46,26,.04);
  --shadow-md:0 4px 12px rgba(26,46,26,.08);
}
html{font-family:var(--font);background:var(--bg);color:var(--t1);font-size:16px;-webkit-font-smoothing:antialiased}
body{max-width:1280px;margin:0 auto;padding:32px 28px 80px;position:relative}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
.logo{font-size:1.8rem;font-weight:800;letter-spacing:-.03em;display:flex;align-items:center;gap:8px}.logo b{color:var(--green)}
.logo-icon{font-size:2rem;line-height:1}
.logo-help{font-size:.78rem;font-weight:500;color:var(--t3);text-decoration:underline;text-underline-offset:3px;margin-left:4px;transition:color .12s}
.logo-help:hover{color:var(--t1)}
.hdr-r{display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:24px}
.lang-sel{padding:5px 12px;border:1px solid var(--border);border-radius:8px;background:var(--s1);color:var(--t2);font-size:.78rem;font-weight:600;cursor:pointer;outline:none;font-family:var(--font);transition:.15s;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238a9d8a'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:24px}
.lang-sel:hover{border-color:var(--green);background:var(--s2);color:var(--t1)}
.hdr-btn{padding:5px 12px;border-radius:8px;border:1px solid var(--border);background:var(--s1);cursor:pointer;color:var(--t2);font-size:.78rem;font-weight:600;font-family:var(--font);transition:.15s}
.hdr-btn:hover{background:var(--s2);color:var(--t1);border-color:var(--green)}
.hdr-btn.danger{color:var(--red);border-color:var(--red-s)}
.hdr-btn.danger:hover{background:var(--red-s);color:var(--red)}

/* Section label */
.sec-label{font-size:1rem;font-weight:800;letter-spacing:-.01em;color:var(--green);margin-bottom:12px;padding-left:2px}

/* ======================== SERVICES ======================== */
.svc-area{margin-top:12px;margin-bottom:32px}
.svc-empty,.cron-empty{text-align:center;padding:36px;color:var(--t3);font-size:.9rem;border:1px dashed var(--border);border-radius:var(--rl);background:var(--s1);cursor:pointer;transition:background .15s}
.svc-empty:hover,.cron-empty:hover{background:var(--s2)}
.svc{display:flex;align-items:center;gap:10px;padding:10px 14px;background:transparent;border:none;margin-bottom:0;animation:fadeIn .2s}
.svc .svc-icon{font-size:1.5rem;flex-shrink:0;display:inline-block}
.svc .svc-icon.spinning{animation:saladSpin 3s linear infinite}
@keyframes saladSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
.svc .svc-body{flex:1;min-width:0}
.svc .svc-title{font-size:.88rem;font-weight:400;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.svc .svc-title .svc-ag{color:var(--indigo-h);font-weight:600}
.svc .svc-title .svc-ch{color:var(--green);font-weight:600}
.svc .svc-title .svc-tg{color:var(--amber);font-weight:600}
.svc-targets-row{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;align-items:center}
.svc-targets-label{font-size:.65rem;font-weight:700;color:var(--amber);letter-spacing:.02em}
.tg-card{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:6px;font-size:.68rem;font-weight:500;color:var(--t1);transition:all .12s}
.tg-card:hover{border-color:var(--amber);background:var(--s2)}
.tg-card .tg-name{color:var(--amber);font-weight:600}
.tg-card.paused{opacity:.5;border-style:dashed}
.tg-card .tg-del{background:none;border:none;color:var(--t3);cursor:pointer;font-size:.62rem;padding:0 2px;border-radius:3px}
.tg-card .tg-del:hover{color:var(--red);background:var(--red-s)}
.svc .svc-status{display:flex;gap:5px;align-items:center;flex-shrink:0}
.svc-toggle{white-space:nowrap}

/* ======================== CRON AREA ======================== */
.cron-area{margin-bottom:32px}
.cron-area .col-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:0}
.cron-blocks{display:flex;flex-wrap:wrap;gap:8px;padding:2px 2px 10px}
.cron-blocks .blk{border-bottom:none;padding:8px 12px;background:var(--s1);border:1px solid var(--border);border-radius:8px;min-width:0;flex:0 0 auto}
.cron-blocks .blk:hover{background:var(--s2);border-color:var(--cyan)}

/* ======================== COMPOSER ======================== */
.composer{margin-bottom:32px;padding-top:24px}
.slots{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:start;margin-bottom:12px}
.slot{min-height:48px;border:none;border-bottom:1px solid var(--s2);display:flex;align-items:center;gap:10px;padding:8px 4px;transition:all .15s;position:relative}
.slot.empty{border:1px dashed var(--border);border-radius:var(--r);justify-content:center;padding:14px 4px;flex-direction:column}
.slot.over{background:var(--s2)}
.slot.drop-hint{animation:slotPulse 1.2s ease-in-out infinite;border-style:solid !important}
.slot.drop-hint.a-slot{border-color:var(--indigo) !important;background:color-mix(in srgb,var(--indigo) 6%,transparent)}
.slot.drop-hint.c-slot{border-color:var(--green) !important;background:color-mix(in srgb,var(--green) 6%,transparent)}
.slot.drop-hint.t-slot{border-color:var(--amber) !important;background:color-mix(in srgb,var(--amber) 6%,transparent)}
.slot.drop-hint.over.a-slot{background:color-mix(in srgb,var(--indigo) 14%,transparent)}
.slot.drop-hint.over.c-slot{background:color-mix(in srgb,var(--green) 14%,transparent)}
.slot.drop-hint.over.t-slot{background:color-mix(in srgb,var(--amber) 14%,transparent)}
@keyframes slotPulse{0%,100%{opacity:1}50%{opacity:.7}}
.slot .slot-label{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t3);margin-bottom:2px}
.slot .slot-val{font-size:.84rem;color:var(--t3)}
.slot .slot-clear{position:absolute;top:4px;right:4px;background:none;border:none;color:var(--t3);cursor:pointer;font-size:.65rem;padding:2px 4px;border-radius:4px;opacity:0;transition:.12s}
.slot:hover .slot-clear{opacity:1}
.slot .slot-clear:hover{color:var(--red);background:var(--red-s)}
.slot.filled{border:none;border-bottom:1px solid var(--s2);flex-direction:row;justify-content:flex-start;padding:8px 4px}
.slot-targets-wrap{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0;width:100%}
.slot-target-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--amber-s);border:1px solid var(--amber);border-radius:10px;font-size:.76rem;font-weight:500;color:var(--t1)}
.stc-avatar{width:18px;height:18px;border-radius:50%;background:var(--amber);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;flex-shrink:0}
.stc-name{max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stc-del{background:none;border:none;cursor:pointer;color:var(--t3);font-size:.58rem;padding:0 2px;line-height:1}.stc-del:hover{color:var(--red)}
.slot .slot-avatar{width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.4rem}
.slot .slot-body{flex:1;min-width:0}
.slot .slot-body .slot-name{font-size:.84rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slot .slot-body .slot-meta{font-size:.72rem;color:var(--t3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.composer-actions{display:flex;gap:8px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:5px;padding:8px 16px;border-radius:8px;border:none;font-size:.85rem;font-weight:500;cursor:pointer;font-family:var(--font);transition:all .12s}
.btn:active{transform:scale(.97)}
.btn-p{background:var(--indigo);color:#fff}.btn-p:hover{background:var(--indigo-h)}
.btn-p:disabled{opacity:.35;cursor:default;transform:none}
.btn-g{background:var(--s2);color:var(--t2);border:1px solid var(--border)}.btn-g:hover{background:var(--s3);color:var(--t1)}
.btn-d{background:var(--red-s);color:var(--red);font-size:.7rem;padding:4px 8px;border:none;border-radius:6px;cursor:pointer;font-family:var(--font);font-weight:500;transition:all .12s}.btn-d:hover{background:var(--red);color:#fff}
.btn-sm{padding:4px 9px;font-size:.7rem}

/* ======================== BLOCKS ======================== */
.blocks{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.block-col{}
.block-col .col-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.block-col .col-title{font-size:1rem;font-weight:800;letter-spacing:-.01em}
.col-desc{font-size:.78rem;color:var(--t3);margin:-4px 0 8px;line-height:1.4}
.block-col.ag .col-title{color:var(--indigo)}
.block-col.ch .col-title{color:var(--green)}
.block-col.tg .col-title{color:var(--amber)}
.block-col.cr .col-title{color:var(--cyan)}

.blk{display:flex;align-items:center;gap:10px;padding:8px 4px;background:transparent;border:none;border-bottom:1px solid var(--s2);margin-bottom:0;cursor:grab;user-select:none;transition:all .12s;position:relative}
.blk:last-child{border-bottom:1px solid var(--s2)}
.blk:hover{background:var(--s1)}
.blk:active{cursor:grabbing;transform:scale(.98)}
.blk.dragging{opacity:.4}
.blk-avatar{width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.4rem}
.blk-body{flex:1;min-width:0}
.blk .blk-name{font-size:.84rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blk .blk-meta{font-size:.72rem;color:var(--t3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blk.used{opacity:.55;cursor:pointer}
.blk.used .blk-del{display:none}
.in-use{font-size:.58rem;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.03em;margin-left:4px}
.blk .blk-del{position:absolute;top:6px;right:4px;background:none;border:none;color:var(--t3);cursor:pointer;font-size:.65rem;padding:2px 4px;border-radius:4px;opacity:0;transition:.12s}
.blk:hover .blk-del{opacity:1}
.blk-del:hover{background:var(--red-s);color:var(--red)}
.svc-wrap{margin-bottom:6px;border-bottom:1px solid var(--s2)}
.svc-wrap.cron-over .svc{outline:2px solid var(--cyan);outline-offset:-2px}
.svc-crons{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;align-items:center}
.svc-crons-label{font-size:.65rem;font-weight:700;color:var(--cyan);letter-spacing:.02em}
.cron-card{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-left:3px solid var(--cyan);border-radius:6px;font-size:.68rem;font-weight:500;color:var(--t1);cursor:pointer;transition:all .12s}
.cron-card:hover{border-color:var(--cyan);background:var(--s2)}
.cron-card .cc-name{color:var(--cyan);font-weight:600}
.cron-card .cc-schedule{color:var(--t3);font-size:.6rem}
.cron-card .cc-detach{background:none;border:none;color:var(--t3);cursor:pointer;font-size:.62rem;padding:0 2px;border-radius:3px}
.cron-card .cc-detach:hover{color:var(--red);background:var(--red-s)}
.detail .d-tag.cr{background:var(--cyan-s);color:var(--cyan)}
.blk .paired{color:var(--green);font-size:.6rem;font-weight:600}
.blk .pending{color:var(--t3);font-size:.6rem;font-weight:600}
.blk .blk-warn{font-size:.6rem;font-weight:600;color:var(--red);margin-top:2px}

/* Add forms */

/* Custom Alert/Confirm Modal */
.alert-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:9999}
.alert-modal-bg.show{display:flex}
.alert-modal{background:var(--bg);border:1px solid var(--border);border-radius:var(--rl);padding:28px;width:90%;max-width:400px;text-align:center;animation:alertIn .15s ease-out}
@keyframes alertIn{from{transform:scale(.95);opacity:0}to{transform:none;opacity:1}}
.alert-modal-icon{font-size:2rem;margin-bottom:12px}
.alert-modal-msg{font-size:.92rem;line-height:1.6;color:var(--t1);margin-bottom:20px;white-space:pre-line}
.alert-modal-actions{display:flex;gap:10px;justify-content:center}
.alert-modal-actions .btn{min-width:100px;padding:10px 20px;font-size:.88rem;border-radius:8px}

/* Modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:100}
.modal-bg.show{display:flex}
.modal{background:var(--s2);border:1px solid var(--border);border-radius:var(--rl);padding:24px;width:90%;max-width:480px;max-height:80vh;overflow-y:auto}
.modal h3{font-size:1.1rem;font-weight:700;margin-bottom:16px}
.uc-card{display:flex;gap:14px;padding:16px 18px;background:var(--bg);border:1px solid var(--border);border-radius:10px}
.uc-icon{font-size:1.6rem;flex-shrink:0;width:36px;text-align:center;line-height:1.6}
.uc-name{font-size:.95rem;font-weight:600;color:var(--t1);margin-bottom:4px}
.uc-desc{font-size:.85rem;color:var(--t2);line-height:1.6}
.uc-how{margin-top:10px;padding:12px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px;font-size:.82rem;color:var(--t2);line-height:1.7}
.uc-how b{color:var(--t1)}
.uc-step{margin-bottom:8px}
.uc-step:last-child{margin-bottom:0}
.modal .prov-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
.modal .prov-row:last-child{border:none}
.modal .prov-name{font-weight:600;font-size:.82rem;min-width:90px}
.modal .prov-key{font-size:.68rem;color:var(--t3)}
.modal .prov-input{flex:1;display:flex;gap:5px}
.modal .prov-input input{font-family:var(--mono);font-size:.72rem;flex:1}

/* Detail Panel (slide-in from right) */
.detail-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);display:none;z-index:200;justify-content:flex-end}
.detail-bg.show{display:flex}
.detail{background:var(--s1);border-left:1px solid var(--border);width:420px;max-width:92vw;height:100vh;overflow-y:auto;padding:28px 24px;animation:slideIn .18s ease-out}
@keyframes slideIn{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}
.detail .d-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.detail .d-hdr h3{font-size:1.15rem;font-weight:700;margin:0}
.detail .d-close{background:none;border:none;color:var(--t3);cursor:pointer;font-size:1.1rem;padding:4px;border-radius:6px;transition:.12s}
.detail .d-close:hover{background:var(--s3);color:var(--t1)}
.detail .d-tag{display:inline-block;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:5px;margin-bottom:16px}
.detail .d-tag.ag{background:var(--indigo-s);color:var(--indigo-h)}
.detail .d-tag.ch{background:var(--green-s);color:var(--green)}
.detail .d-tag.tg{background:var(--amber-s);color:var(--amber)}
.detail .d-field,.split-detail .d-field{margin-bottom:14px}
.d-field>label{display:block;font-size:.78rem;font-weight:700;color:var(--t1);margin-bottom:4px}
.d-field>label.check-label{display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:500;margin-bottom:0}
.d-field .skill-toggle label{font-size:.78rem;font-weight:500;color:var(--t1)}
.d-field .check-label{font-size:.82rem;font-weight:500;color:var(--t1)}
.detail .d-field input,.detail .d-field select,.detail .d-field textarea,.split-detail .d-field input,.split-detail .d-field select,.split-detail .d-field textarea{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--t1);font-size:.88rem;font-family:var(--font);outline:none;transition:border-color .12s}
.detail .d-field input:focus,.detail .d-field select:focus,.detail .d-field textarea:focus,.split-detail .d-field input:focus,.split-detail .d-field select:focus,.split-detail .d-field textarea:focus{border-color:var(--indigo)}
.detail .d-field textarea,.split-detail .d-field textarea{resize:vertical;min-height:80px;font-family:var(--font)}
.field-hint{font-size:.72rem;color:var(--t3);margin-bottom:5px;line-height:1.4}
.field-hint a{color:var(--indigo);text-decoration:none;font-weight:500}.field-hint a:hover{text-decoration:underline}
.field-hint code{background:var(--s2);padding:1px 5px;border-radius:4px;font-family:var(--mono);font-size:.68rem;color:var(--t1);user-select:all}
.help-box{margin-top:8px;padding:12px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px}
.help-title{font-size:.78rem;font-weight:700;color:var(--t1);margin-bottom:4px}
.help-body{font-size:.72rem;color:var(--t3);line-height:1.5}
.skill-cta{margin-top:8px;font-size:.74rem;color:var(--indigo);cursor:pointer;font-weight:600;padding:6px 0;transition:color .12s}
.skill-cta:hover{color:var(--indigo-h);text-decoration:underline}
.model-guide{margin-top:6px;padding:8px 12px;background:var(--s1);border:1px solid var(--border);border-radius:6px;font-size:.72rem;line-height:1.5}
.detail .d-field select{appearance:none;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg width='8' height='5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%2363637a' fill='none' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.detail .d-field .d-val{font-size:.78rem;color:var(--t2);font-family:var(--mono);padding:6px 0;word-break:break-all}
.detail .d-actions,.split-detail .d-actions{display:flex;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.detail .d-actions .btn-d,.split-detail .d-actions .btn-d{font-size:.85rem;padding:8px 16px;border-radius:8px}
.detail .d-meta{font-size:.62rem;color:var(--t3);margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.detail .d-meta div{margin-bottom:3px}
/* Unified checkbox */
input[type=checkbox]{accent-color:var(--green);cursor:pointer}
.check-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.82rem;font-weight:500}
.check-label input[type=checkbox],.skill-toggle input[type=checkbox]{width:16px;height:16px;margin:0;flex-shrink:0}
/* Unified skill toggle */
.skill-toggle{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--s1)}
.skill-toggle:last-child{border-bottom:none}
.skill-toggle label{font-size:.78rem;color:var(--t1);cursor:pointer;font-weight:500;flex:1;line-height:1.2}
.skill-toggle .sk-desc{font-size:.68rem;color:var(--t3);font-weight:400;margin-top:2px;line-height:1.35}
.skill-toggle .cat{font-size:.62rem;color:var(--t3);background:var(--s2);padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:1px}
.skill-toggle input[type=checkbox]{margin-top:2px}

/* Tab navigation */
.tab-nav{display:flex;gap:4px;margin-bottom:28px;border-bottom:1px solid var(--border);padding-bottom:0}
.tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:10px 20px;font-size:.9rem;font-weight:600;color:var(--t2);cursor:pointer;transition:all .15s}
.tab-btn:hover{color:var(--t1)}
.tab-btn.active{color:var(--t1);border-bottom-color:var(--green)}
.tab-panel{display:none}
.tab-panel.active{display:block;animation:fadeIn .2s;padding-top:8px}

/* Split layout (shared: Agents tab, Skills tab) */
.split-layout{display:flex;gap:20px;min-height:480px}
.split-list{width:260px;flex-shrink:0;overflow-y:auto;max-height:calc(100vh - 180px);padding-bottom:24px}
.split-detail{flex:1;min-width:0;overflow-y:auto;max-height:calc(100vh - 180px);padding-right:4px;padding-bottom:24px}
.ag-card{padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:6px;cursor:pointer;transition:all .12s;background:var(--bg)}
.ag-card:hover{background:var(--s1)}
.ag-card.selected{background:var(--indigo-s);border-color:var(--indigo);border-left:3px solid var(--indigo)}
.ag-card .ag-card-name{font-size:.88rem;font-weight:600}
.ag-card .ag-card-meta{font-size:.72rem;color:var(--t3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agents-empty{text-align:center;padding:32px 16px;color:var(--t3);font-size:.85rem}
.agent-detail-empty{display:flex;align-items:center;justify-content:center;height:300px;color:var(--t3);font-size:.9rem;border:1px dashed var(--border);border-radius:var(--rl)}
.agent-section{margin-bottom:18px}
.agent-section h4{font-size:.78rem;font-weight:700;color:var(--t2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em}

/* Skills tab */
.skills-section{margin-bottom:16px}
.skills-group{margin:14px 0;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--s1)}
.skills-group h4{font-size:.78rem;font-weight:700;margin-bottom:10px;color:var(--t2)}
.skill-toggle .unavail{font-size:.62rem;color:#c44;font-style:italic}
.skill-info{display:flex;align-items:center;gap:10px;padding:8px 12px;margin:4px 0;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:.78rem}
.skill-info .si-name{font-weight:600;color:var(--t1)}
.skill-info .si-cat{font-size:.62rem;color:var(--t3);background:var(--s2);padding:2px 7px;border-radius:4px;text-transform:uppercase}
.skill-info .si-status{font-size:.62rem;margin-left:auto}
.skill-info .si-ok{color:var(--green);font-weight:600}
.skill-info .si-na{color:var(--t3);font-style:italic}
.cs-card{display:flex;align-items:center;gap:8px;padding:8px 12px;margin:5px 0;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:.75rem}
.cs-card .cs-name{font-weight:600;color:var(--t1);cursor:pointer}
.cs-card .cs-name:hover{color:var(--indigo)}
.cs-card .cs-desc{color:var(--t2);flex:1}
.cs-card button{padding:3px 10px;font-size:.68rem}
/* Skill list cards (left panel) */
.sk-card{padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:6px;cursor:pointer;transition:all .12s;background:var(--bg)}
.sk-card:hover{background:var(--s1)}
.sk-card.selected{background:var(--indigo-s);border-color:var(--indigo);border-left:3px solid var(--indigo)}
.sk-card .sk-name{font-size:.84rem;font-weight:600;display:flex;align-items:center;gap:6px}
.sk-card .sk-meta{font-size:.68rem;color:var(--t3);margin-top:2px;display:flex;align-items:center;gap:6px}
.sk-card .sk-badge{font-size:.56rem;padding:1px 6px;border-radius:3px;font-weight:600;text-transform:uppercase;flex-shrink:0}
.sk-badge-builtin{background:var(--green-s);color:var(--green)}
.sk-badge-script{background:var(--cyan-s);color:var(--cyan)}
.sk-badge-prompt{background:var(--s2);color:var(--t3)}
.sk-list-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.skill-detail-empty{display:flex;align-items:center;justify-content:center;height:300px;color:var(--t3);font-size:.9rem;border:1px dashed var(--border);border-radius:var(--rl)}

@media(max-width:700px){
  .blocks{grid-template-columns:1fr}
  .slots{flex-direction:column}
  body{padding:16px 12px 60px}
  .split-layout{flex-direction:column}
  .split-list{width:100%;max-height:200px}
  .split-detail{max-height:none}
}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes flash{0%{background:var(--indigo-s)}50%{background:var(--green-s)}100%{background:transparent}}
</style>
</head>
<body>

<!-- HEADER -->
<div class="hdr">
  <div class="logo">Agent<b>Salad</b></div>
  <div class="hdr-r">
    <select class="lang-sel" id="langSelect" onchange="setLang(this.value)">
      <option value="en">EN</option>
      <option value="ko">한국어</option>
      <option value="ja">日本語</option>
      <option value="zh">中文</option>
    </select>
    <button class="hdr-btn" id="btnApiKeys" onclick="toggleModal()">API Key Settings</button>
    <button class="hdr-btn danger" id="btnShutdown" onclick="confirmShutdown()">Shut Down Server</button>
  </div>
</div>

<!-- TAB NAV -->
<div class="tab-nav">
  <button class="tab-btn active" data-tab="services" onclick="switchTab('services')" id="tabServices">My Salads</button>
  <button class="tab-btn" data-tab="agents" onclick="switchTab('agents')" id="tabAgents">Agents</button>
  <button class="tab-btn" data-tab="skills" onclick="switchTab('skills')" id="tabSkills">Skills</button>
  <a class="logo-help" id="logoHelp" href="#" onclick="event.preventDefault();$('aboutModal').classList.add('show')" style="margin-left:auto">What is Agent Salad?</a>
</div>

<!-- TAB: SERVICES -->
<div class="tab-panel active" id="tab-services">

<!-- ACTIVE SERVICES -->
<div class="svc-area">
  <div class="sec-label" id="secActive">My Salads</div>
  <div class="sec-desc" style="color:var(--t3);font-size:.82em;margin:4px 0 8px 0"><span id="secSaladDesc">Complete a salad and chat with your own agent!</span> &nbsp;<a href="#" id="useCaseLink" onclick="event.preventDefault();$('useCaseModal').classList.add('show')" style="color:var(--indigo);text-decoration:underline;cursor:pointer;font-size:1em">🥕Try it like this</a></div>
  <div id="svcList"></div>
</div>

<!-- CRONS: 샐러드 바로 아래, 드래그하여 샐러드에 연결 -->
<div class="cron-area">
  <div class="col-hdr">
    <div class="sec-label" style="margin-bottom:0" id="colCrons">Crons</div>
    <button class="btn btn-g btn-sm" onclick="openAddCronModal()" id="btnAddCron">+ Add</button>
  </div>
  <div class="sec-desc" id="cronDesc" style="color:var(--t3);font-size:0.9em;margin:4px 0 10px 0">예약을 만들어 샐러드에 연결하면, 정해진 시간에 예약 작업을 합니다. 예약을 만들고 드래그해서 샐러드에 뿌려보세요.</div>
  <div id="crBlocks" class="cron-blocks"></div>
</div>

<div style="text-align:center;padding:0;overflow:hidden;height:74px"><img src="/assets/fork.png" alt="" style="height:160px;margin-top:-32px"></div>

<!-- COMPOSER: drag slots -->
<div class="composer">
  <div class="sec-label" id="secCreate">샐러드 만들기</div>
  <div class="sec-desc" id="secCreateDesc" style="color:var(--t3);font-size:0.9em;margin:-4px 0 10px 0">아래 블록을 슬롯으로 드래그하세요</div>
  <div class="slots">
    <div class="slot a-slot empty" id="slotA" data-type="agent">
      <div class="slot-label" id="slotALabel">Agent</div>
      <div class="slot-val" id="slotAVal">Drop here</div>
    </div>
    <div class="slot c-slot empty" id="slotC" data-type="channel">
      <div class="slot-label" id="slotCLabel">Channel</div>
      <div class="slot-val" id="slotCVal">Drop here</div>
    </div>
    <div id="slotTContainer" data-type="target">
      <div class="slot t-slot empty" id="slotTEmpty" data-type="target">
        <div class="slot-label" id="slotTLabel">Target</div>
        <div class="slot-val">Drop here</div>
      </div>
      <div id="slotTList"></div>
    </div>
  </div>
  <div class="composer-actions">
    <button class="btn btn-p" id="saveSvcBtn" disabled>Create Service</button>
    <button class="btn btn-g" id="clearSlotsBtn" data-i18n="clear">Clear</button>
  </div>
</div>

<!-- BLOCKS: agents / channels / targets side by side -->
<div class="blocks">
  <div class="block-col ag">
    <div class="col-hdr">
      <div class="col-title" id="colAgents">Agents</div>
      <button class="btn btn-g btn-sm" onclick="openAddAgentModal()" id="btnAddAgent">+ Add</button>
    </div>
    <div class="col-desc" id="colAgDesc"></div>
    <div id="agBlocks"></div>
  </div>
  <div class="block-col ch">
    <div class="col-hdr">
      <div class="col-title" id="colChannels">Channels</div>
      <button class="btn btn-g btn-sm" onclick="openAddChannelModal()" id="btnAddChannel">+ Add</button>
    </div>
    <div class="col-desc" id="colChDesc"></div>
    <div id="chBlocks"></div>
  </div>
  <div class="block-col tg">
    <div class="col-hdr">
      <div class="col-title" id="colTargets">Targets</div>
      <button class="btn btn-g btn-sm" onclick="openAddTargetModal()" id="btnAddTarget">+ Add</button>
    </div>
    <div class="col-desc" id="colTgDesc"></div>
    <div id="tgBlocks"></div>
  </div>

</div>

</div><!-- /tab-services -->

<!-- TAB: AGENTS -->
<div class="tab-panel" id="tab-agents">
  <div class="split-layout">
    <div class="split-list" id="agentsList">
      <div class="sk-list-header">
        <span class="sec-label" style="margin:0" id="agentsTabLabel">Agents</span>
        <button class="btn btn-p btn-sm" id="btnCreateAgent" onclick="openAddAgentModal()">+ Create Agent</button>
      </div>
      <div id="agentsListItems"></div>
    </div>
    <div class="split-detail" id="agentsDetail">
      <div class="agent-detail-empty" id="agentDetailEmpty">목록에서 에이전트를 선택하세요</div>
    </div>
  </div>
</div><!-- /tab-agents -->

<!-- TAB: SKILLS -->
<div class="tab-panel" id="tab-skills">
  <div class="split-layout">
    <div class="split-list" id="skillsList">
      <div class="sk-list-header">
        <span class="sec-label" style="margin:0" id="secSkillsAll">스킬</span>
        <button class="btn btn-p btn-sm" onclick="newCustomSkillInline()" id="btnNewSkillTab">+ 스킬 만들기</button>
      </div>
      <div id="skillsListItems"></div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
        <div class="sec-label" style="font-size:.76rem" id="secGoogle">Google 연동</div>
        <div id="gogStatus"></div>
      </div>
    </div>
    <div class="split-detail" id="skillsDetail">
      <div class="skill-detail-empty" id="skillDetailEmpty">목록에서 스킬을 선택하세요</div>
    </div>
  </div>
</div><!-- /tab-skills -->

<!-- About Modal -->
<div class="modal-bg" id="aboutModal" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="modal" style="max-width:520px">
    <h3 id="aboutTitleEl">What is Agent Salad?</h3>
    <div style="font-size:.88rem;line-height:1.7;color:var(--t2)">
      <p id="aboutP1El"></p>
      <p style="margin-top:10px" id="aboutP2El"></p>
      <ol style="margin:12px 0 12px 20px;font-size:.84rem">
        <li id="aboutStep1El"></li>
        <li id="aboutStep2El"></li>
        <li id="aboutStep3El"></li>
        <li id="aboutStep4El"></li>
      </ol>
      <p style="font-size:.82rem;color:var(--t3)" id="aboutP3El"></p>
    </div>
    <div style="margin-top:14px;text-align:right"><button class="btn btn-g" id="aboutCloseBtn" onclick="$('aboutModal').classList.remove('show')">Close</button></div>
  </div>
</div>

<!-- Use Case Modal -->
<div class="modal-bg" id="useCaseModal" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="modal" style="max-width:620px;max-height:85vh;overflow-y:auto">
    <h3 id="ucTitle">Try it like this</h3>
    <div style="display:flex;flex-direction:column;gap:16px;margin-top:14px">
      <div class="uc-card"><div class="uc-icon">🏋️</div><div style="flex:1"><div class="uc-name" id="uc1T"></div><div class="uc-desc" id="uc1D"></div><div class="uc-how" id="uc1H"></div></div></div>
      <div class="uc-card"><div class="uc-icon">🎬</div><div style="flex:1"><div class="uc-name" id="uc2T"></div><div class="uc-desc" id="uc2D"></div><div class="uc-how" id="uc2H"></div></div></div>
      <div class="uc-card"><div class="uc-icon">📰</div><div style="flex:1"><div class="uc-name" id="uc3T"></div><div class="uc-desc" id="uc3D"></div><div class="uc-how" id="uc3H"></div></div></div>
      <div class="uc-card"><div class="uc-icon">🏫</div><div style="flex:1"><div class="uc-name" id="uc4T"></div><div class="uc-desc" id="uc4D"></div><div class="uc-how" id="uc4H"></div></div></div>
    </div>
    <div style="margin-top:16px;text-align:right"><button class="btn btn-g" id="ucCloseBtn" onclick="$('useCaseModal').classList.remove('show')">Close</button></div>
  </div>
</div>

<!-- Settings Modal -->
<div class="modal-bg" id="modal">
  <div class="modal">
    <h3 id="modalTitle">LLM Provider Keys</h3>
    <div id="provRows"></div>
    <div style="margin-top:14px;text-align:right"><button class="btn btn-g" id="modalCloseBtn" onclick="toggleModal()">Close</button></div>
  </div>
</div>

<!-- Alert/Confirm Modal -->
<div class="alert-modal-bg" id="alertModalBg" onclick="if(event.target===this)dismissAlertModal()">
  <div class="alert-modal">
    <div class="alert-modal-icon" id="alertModalIcon"></div>
    <div class="alert-modal-msg" id="alertModalMsg"></div>
    <div class="alert-modal-actions" id="alertModalActions"></div>
  </div>
</div>

<!-- Detail Panel (slide-in) -->
<div class="detail-bg" id="detailBg" onclick="if(event.target===this)closeDetail()">
  <div class="detail" id="detailPanel"></div>
</div>


<script>
/* ── i18n ── */
const I18N={
en:{
  services:'My Salads',skills:'Skills',activeServices:'My Salads',
  saladDesc:'Complete a salad and chat with your own agent!',
  useCaseLink:'🥕Try it like this',
  useCaseTitle:'Try it like this',
  useCase1Title:'Personal Fitness Trainer',
  useCase1Desc:'Your very own PT agent that sends meal plans and workout lists every morning, then checks if you actually did them.',
  useCase1How:'<div class="uc-step"><b>1. Create an Agent</b><br>In the system prompt, type <i>"You are my personal fitness coach. Manage my daily meals and workout routine."</i> — your agent will now act like a fitness coach.</div><div class="uc-step"><b>2. Turn on Skills</b><br>Enable <b>File</b> — so the agent can save your workout records and check them the next day.<br>Enable <b>Schedule</b> — this lets the agent send messages automatically at a set time.</div><div class="uc-step"><b>3. Pick a Target</b><br>Select yourself as the target. You\\'re the one receiving messages.</div><div class="uc-step"><b>4. Make the Salad &amp; attach a Schedule</b><br>After making the salad, create a schedule and drag it onto your salad.<br>Name: <i>"Daily workout"</i>, Time: <i>07:00</i><br>Prompt: <i>"Send today\\'s meal plan and exercise list. Check from files whether I completed yesterday\\'s workout."</i><br>Now every morning at 7 AM, your agent starts your PT session automatically!</div>',
  useCase2Title:'Audition Scout for a Friend',
  useCase2Desc:'An agent that collects casting calls from forums every day and sends them to your non-tech actor friend via email.',
  useCase2How:'<div class="uc-step"><b>1. Create an Agent</b><br>In the system prompt, type <i>"You are an audition scout. Find acting auditions and casting calls every day and organize them."</i></div><div class="uc-step"><b>2. Turn on Skills</b><br>Enable <b>Web Fetch</b> — so the agent can browse the internet and collect audition listings.<br>Enable <b>File</b> and <b>Schedule</b> as well.</div><div class="uc-step"><b>3. Create a Custom Skill (optional)</b><br>In the Skills tab, create a script skill called <i>"send_email"</i> — this lets the agent forward collected listings via email.</div><div class="uc-step"><b>4. Pick a Target</b><br>Select your friend\\'s Telegram as the target. The agent will message them directly.</div><div class="uc-step"><b>5. Make the Salad &amp; attach a Schedule</b><br>Name: <i>"Fetch auditions"</i>, Time: <i>09:00</i><br>Prompt: <i>"Search actor forums for the latest casting calls, organize them, and send via email."</i><br>Every morning at 9 AM, your agent gathers auditions and delivers them to your friend!</div>',
  useCase3Title:'Daily News Briefing',
  useCase3Desc:'Your personal news curator that summarizes top headlines every morning and delivers a neat digest to your chat.',
  useCase3How:'<div class="uc-step"><b>1. Create an Agent</b><br>In the system prompt, type <i>"You are a news curator. Collect the key headlines every day and summarize them in an easy-to-read format."</i></div><div class="uc-step"><b>2. Turn on Skills</b><br>Enable <b>Web Fetch</b> — so the agent can pull articles directly from news sites.<br>Enable <b>Schedule</b> — to receive your daily briefing automatically at a set time.</div><div class="uc-step"><b>3. Pick a Target</b><br>Select yourself. Or add a friend as a target if you want them to get the briefing too.</div><div class="uc-step"><b>4. Make the Salad &amp; attach a Schedule</b><br>Name: <i>"Morning news"</i>, Time: <i>08:00</i><br>Prompt: <i>"Fetch the top 5 headlines from TechCrunch and Reuters, then summarize them."</i><br>Every morning at 8 AM, your agent fetches, summarizes, and delivers the news!</div>',
  useCase4Title:'Teacher Managing Students',
  useCase4Desc:'A teaching assistant agent that reminds students about homework, sends quizzes, and tracks who submitted.',
  useCase4How:'<div class="uc-step"><b>1. Create an Agent</b><br>In the system prompt, type <i>"You are a classroom assistant. Send homework reminders, create quizzes, and check who has submitted."</i></div><div class="uc-step"><b>2. Turn on Skills</b><br>Enable <b>File</b> — the agent stores each student\\'s progress and submission records in files.<br>Enable <b>Schedule</b> — to automatically send homework reminders at a set time.</div><div class="uc-step"><b>3. Pick Targets</b><br>Add each student as a separate target. When making a salad, drag multiple targets into the slot — all services are created at once.</div><div class="uc-step"><b>4. Make the Salad &amp; attach a Schedule</b><br>Name: <i>"Homework check"</i>, Time: <i>16:00</i><br>Prompt: <i>"Check today\\'s homework submissions and send a reminder to anyone who hasn\\'t submitted."</i><br>Drag the schedule onto the salad — it applies to every student at once.</div><div class="uc-step"><b>✨ Tip</b><br>The agent uses a separate workspace folder for each student, so progress and records never mix between them.</div>',
  createServiceDrag:'Make a Salad',createServiceDesc:'Drag blocks below into the slots',
  agents:'Agents',channels:'Channels',targets:'Targets',crons:'Schedules',
  add:'+ Add',agent:'Agent',channel:'Channel',target:'Target',
  dropHere:'Drop here',createService:'Make Salad',clear:'Clear',
  name:'Name',provider:'Provider',model:'Model',systemPrompt:'System Prompt',
  create:'Create',botToken:'Bot Token',addPair:'Add & Pair',
  platform:'Platform',platformUserId:'Platform User ID',nickname:'Nickname',
  prompt:'Prompt',schedule:'Schedule',dailyRepeat:'Daily Repeat',oneTime:'One-time',
  time:'Time (HH:MM)',dateTime:'Date & Time',sendToChannel:'Send response to channel',
  noServices:'No salads yet. Drag an Agent, Channel, and Target into the slots above to make one.',
  noAgents:'No agents yet',noChannels:'No channels yet',noTargets:'No targets yet',noCrons:'No schedules yet',
  agentSkillConfig:'Agent Skill Configuration',selectAgent:'Select Agent:',
  builtinSkills:'Builtin Skills',customSkills:'Custom Skills',saveToggles:'Save Toggles',
  newSkill:'+ New Skill',googleIntegration:'Google Integration (gog CLI)',
  llmProviderKeys:'LLM Provider Keys',close:'Close',save:'Save',cancel:'Cancel',
  del:'Del','delete':'Delete',pause:'Pause',resume:'Resume',description:'Description',
  svcDesc:'{agent} · {channel} → {target}',
  svcDescMulti:'{agent} serves {targets} via {channel}.',
  agentDesc:'Set the provider and model for your agent.',
  channelDesc:'Register a channel (bot) to chat through.',
  targetDesc:'Who should the agent talk to? You? A friend?',
  customSkillCta:'Can\\'t find the skill you need? Create your own →',
  skillsLabel:'Skills',timeAwareness:'Time Awareness',
  timeAwarenessDesc:'When enabled, timestamps are included in user messages and the agent is aware of current time.',
  smartStep:'Smart Step',
  smartStepDesc:'When enabled, complex tasks can be automatically executed in multiple steps.',
  maxPlanSteps:'Max steps',workspace:'Workspace',openFolder:'Open Folder',
  status:'Status',bot:'Bot',paired:'PAIRED',pending:'PENDING',
  confirmDelete:'Delete?',confirmDeleteAgent:'Delete this agent and all related salads?',
  confirmDeleteChannel:'Delete this channel and all related salads?',
  confirmDeleteTarget:'Delete this target and all related salads?',
  confirmDeleteCron:'Delete this schedule?',
  confirmShutdown1:'Are you sure you want to shut down the server?\\n\\nAll running salads and plans will be stopped.',
  confirmShutdown2:'Final confirmation: Shutting down the server.',
  serverShutDown:'Server shut down.',alreadyAttached:'Already attached',
  missingSkills:'Agent is missing required skills: ',
  skillsToolSelect:'Skills (tool selection)',scriptTool:'Script Tool',promptOnly:'Prompt Only',
  toolName:'Tool Name',toolNameHint:'(lowercase + underscores)',
  skillFolder:'Skill folder',skillFolderWillCreate:'Skill folder will be created on save:',
  nameRequired:'Name is required',toolNameRequired:'Please enter Tool Name',
  toolNameFormat:'Tool Name must be lowercase letters and underscores only',
  nameAndPromptRequired:'Name and Prompt required',dateTimeRequired:'Date & Time required',
  pairingFailed:'Pairing failed: ',failedCreateChannel:'Failed to create channel',typeMismatch:'Channel and target platform must match',
  unknownProvider:'Unknown provider',apiKeyNotSet:'API key not set',notPaired:'Not paired',
  newCustomSkill:'New Custom Skill',editCustomSkill:'Edit Custom Skill',
  deleteCustomSkill:'Delete this custom skill?',
  noCustomSkills:'No custom skills yet. Click "+ New Skill" to create one.',
  noCustomSkillsTitle:'No skills created yet.',
  noCustomSkillsCta:'Give your agent new abilities?',
  gogDetected:'gog CLI detected. Google skills available.',
  gogNotFound:'gog CLI not found. Install to enable Google skills (Gmail, Calendar, Drive).',
  gogSetupSteps:'Setup steps:',
  gogExplain:'gog is a command-line tool that provides OAuth2-authenticated access to Google APIs (Gmail, Calendar, Drive). Agent Salad uses gog CLI to connect to Google services.',
  gogGcpGuide:'Google Cloud Console setup:',
  gogGcpStep1:'Create a project at console.cloud.google.com',
  gogGcpStep2:'Enable Gmail API, Calendar API, Drive API',
  gogGcpStep3:'APIs & Services → Credentials → Create OAuth 2.0 Client ID (Desktop) → Download JSON',
  gogCliGuide:'CLI install & auth:',
  gogSkillNote:'This skill requires gog CLI. Check the "Google Integration" section at the bottom of the Skills tab for setup instructions.',
  gogRestartNote:'After installing gog CLI, restart the server for changes to take effect.',
  clearApiKey:'Clear this API key?',
  setLabel:'Set',notSetLabel:'Not set',opening:'Opening...',opened:'Opened!',
  runScript:'run.sh — Execution script',schemaJson:'schema.json — Input parameters',
  promptTxt:'prompt.txt — LLM tool guide',guideMd:'GUIDE.md — Implementation guide',
  promptHint:'(Guide the LLM on when/how to use this tool)',
  agentsTab:'Agents',selectAgent:'Select an agent',allSkills:'Skills',
  selectSkill:'Select a skill from the list',builtinLabel:'BUILTIN',scriptLabel:'SCRIPT',promptLabel:'PROMPT',
  skillType:'Type',skillAvailable:'Available',skillNotAvailable:'Not available',
  builtinSkillNote:'Built-in skills are managed per agent in the Agents tab.',
  skillCategory:'Category',noSkills:'No skills yet',
  // About modal
  aboutTitle:'What is Agent Salad?',
  aboutP1:'A platform to create your own AI service by combining an <b>Agent</b> (AI brain) + <b>Channel</b> (messenger bot) + <b>Target</b> (user).',
  aboutP2:'Just like making a salad — pick your ingredients and mix them together.',
  aboutStep1:'Create an <b>Agent</b> to define the AI personality and role',
  aboutStep2:'Connect a <b>Channel</b> with a messenger bot',
  aboutStep3:'Register a <b>Target</b> — who to chat with',
  aboutStep4:'Drag all three to make a <b>Salad</b>!',
  aboutP3:'Add schedules to let your agent work automatically at set times.',
  // Header / buttons
  apiKeySetup:'API Key Settings',serverShutdown:'Shut Down Server',
  logoHelp:'What is Agent Salad?',addAgent:'+ Create Agent',createAgent:'+ Create Agent',
  cronDesc:'Create a schedule and attach it to a salad. It will run tasks at the set time. Drag a schedule onto a salad to connect.',
  // Form hints
  agentNameHint:'Give your agent a name to identify it.',phAgentName:'e.g. English Tutor',
  agentDescHint:'Describe what this agent does.',phAgentDesc:'e.g. An agent that helps with English conversation',
  providerSelectHint:'Choose which AI service to use.',
  providerApiKeyNotice:'An API key for the selected provider is required. Register one in <b>API Key Settings</b> above first.',
  providerApiKeyLink:'Get {name} API Key',
  modelInputHint:'Model names differ by provider. Enter the exact name.',
  sysPromptHelpTitle:'What is a System Prompt?',
  sysPromptHelpBody:'Tell the agent what you expect. What personality, what role, what rules should it follow?',
  sysPromptHelpExample:'e.g. "You are a friendly English teacher. Explain in Korean and provide English examples."',
  phSystemPrompt:'Write personality, role, goals freely...',
  agentSkillsHint:'Select tools the agent can use. Files, web, terminal, etc.',
  channelNameHint:'Give this channel a name to identify it.',phChannelName:'e.g. My Telegram Bot',
  channelTypeHint:'Select the messenger platform for this channel.',
  botTokenHint:'Create a bot with <a href="https://t.me/BotFather" target="_blank">@BotFather</a> on Telegram and paste the token here.',
  botTokenHintDiscord:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>Go to <a href="https://discord.com/developers/applications" target="_blank">Discord Developer Portal</a> → <b>New Application</b> → name it → Create</li>'
    +'<li>Left menu → <b>Bot</b> → click <b>Reset Token</b> → <b>Copy</b> the token</li>'
    +'<li>Scroll down to <b>Privileged Gateway Intents</b> → turn on <b>MESSAGE CONTENT INTENT</b> and <b>SERVER MEMBERS INTENT</b> → Save</li>'
    +'<li>Left menu → <b>OAuth2</b> → <b>URL Generator</b></li>'
    +'<li>Scopes: check <b>bot</b> · Bot Permissions: <b>Send Messages</b>, <b>Read Message History</b>, <b>View Channels</b></li>'
    +'<li>Copy the generated URL → open in browser → select your server → Authorize</li>'
    +'</ol>',
  botTokenHintSlack:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>Go to <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> → name it, select workspace → Create</li>'
    +'<li>Left menu → <b>OAuth &amp; Permissions</b> → scroll to <b>Bot Token Scopes</b> → add: <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code>, <code>app_mentions:read</code>, <code>users:read</code></li>'
    +'<li>Scroll up → <b>Install to Workspace</b> → Allow</li>'
    +'<li>Copy the <b>Bot User OAuth Token</b> (starts with <code>xoxb-</code>)</li>'
    +'<li>Left menu → <b>Event Subscriptions</b> → Enable Events → Add bot events: <code>message.im</code>, <code>message.channels</code>, <code>app_mention</code> → Save</li>'
    +'</ol>',
  appTokenHint:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>Left menu → <b>Socket Mode</b> → turn on <b>Enable Socket Mode</b></li>'
    +'<li>A dialog appears → name the token (e.g. "socket") → add scope <code>connections:write</code> → <b>Generate</b></li>'
    +'<li>Copy the token (starts with <code>xapp-</code>)</li>'
    +'<li><i>Or: Basic Information → App-Level Tokens → Generate Token and Scopes</i></li>'
    +'</ol>',
  appToken:'App-Level Token',
  platformSelectHint:'Select the messaging platform.',
  platformUserIdHint:'Send a message to <a href="https://t.me/userinfobot" target="_blank">@userinfobot</a> on Telegram to find your numeric user ID.',phPlatformUserId:'e.g. 123456789',
  platformUserIdHintDiscord:'Discord → Settings → Advanced → turn on <b>Developer Mode</b>. Then right-click a user → <b>Copy User ID</b> (a long number like <code>284102390284</code>).',
  platformUserIdHintSlack:'Click a user\\'s name in Slack → <b>View full profile</b> → click <b>⋮</b> (more) → <b>Copy member ID</b> (like <code>U04ABCDEF</code>).',
  nicknameHint:'A friendly name to recognize this person.',phNickname:'e.g. John',
  targetType:'Target Type',targetTypeHint:'User = DM target, Room = channel/thread target.',
  targetTypeUser:'User (DM)',targetTypeRoom:'Room (Channel)',
  roomId:'Channel/Room ID',roomIdHint:'Copy the channel ID from Discord (Developer Mode) or Slack (Channel Details → bottom).',
  autoSession:'Auto Session',autoSessionHint:'Automatically create sessions when new users/rooms interact with the bot.',
  autoSessionBadge:'Auto',
  cronPromptHint:'Tell the agent what to do at the set time. e.g. "Summarize today\\'s top news"',
  phCronName:'Daily news summary',phCronPrompt:'Instructions to send to agent...',
  cronSkillsHint:'Select tools the agent should use for this schedule. Leave empty if none needed.',
  scheduleHint:'Daily repeat: Runs at the same time every day. One-time: Runs once at the specified date/time.',
  cronNotifyHint:'Enable to receive results via channel. Disable for silent processing.',
  newSkillIntro:'Give your agent new abilities. Write a script to use as a tool, or define text-only instructions.',
  skillNameHint:'Give this skill a name to identify it.',phSkillName:'e.g. YouTube Summarizer',
  skillTypeScriptHint:'Automate tasks that are difficult or time-consuming with built-in skills alone. A guide document will be created in the skill folder.',
  skillTypePromptHint:'Text-only instructions without a script. Write behavioral rules or expertise for the agent to reference.',
  toolNameHintDesc:'The name used when the agent calls this tool. Use only lowercase letters and underscores.',phToolName:'e.g. check_inventory',
  skillPromptHint:'Write instructions for the agent to reference when using this skill.',phSkillPrompt:'e.g. When the user asks for a summary...',
  phApiKey:'API Key',
  // Skill labels / categories / descriptions
  sl_file_read:'File Read',sl_file_write:'File Write',sl_file_list:'File List',
  sl_web_fetch:'Web Page Fetch',sl_web_browse:'Web Browser',sl_bash:'Terminal Commands',
  sl_google_gmail:'Gmail',sl_google_calendar:'Google Calendar',sl_google_drive:'Google Drive',sl_cron:'Auto Schedule',
  sc_file:'File',sc_web:'Web',sc_system:'System',sc_google:'Google',sc_automation:'Automation',
  sd_file_read:'Reads files in the workspace. Use for referencing notes, config files, etc.',
  sd_file_write:'Creates or modifies files in the workspace. Use for saving work results.',
  sd_file_list:'Lists files and folders in the workspace. Use to check what files exist.',
  sd_web_fetch:'Fetches text from a web page URL. Use for reading news, documents, etc.',
  sd_web_browse:'Opens a visible Chromium browser for clicking, typing, scrolling, screenshots, and link extraction. Screenshots are auto-sent to the chat. Set <code>BROWSER_CDP_URL</code> to connect to your own Chrome.',
  sd_bash:'Runs shell commands on the server. Use for script execution, package installation, etc. <b style="color:var(--red)">⚠ Full device access.</b> Only enable for yourself or trusted users.',
  sd_google_gmail:'Search, read, and send Gmail emails. Requires <b>gog CLI</b> (Google OAuth2).',
  sd_google_calendar:'View or create Google Calendar events. Requires <b>gog CLI</b> (Google OAuth2).',
  sd_google_drive:'Search, download, and upload Google Drive files. Requires <b>gog CLI</b> (Google OAuth2).',
  sd_cron:'Agent self-manages scheduled tasks. Use for requests like "summarize news every morning".',
  // Provider hints
  provHintAnthropic:'e.g. claude-sonnet-4-20250514',provHintOpenai:'e.g. gpt-4o',
  provHintGroq:'e.g. llama-3.3-70b-versatile',provHintOpenrouter:'e.g. anthropic/claude-sonnet-4-20250514',
  provHintOpencode:'e.g. claude-sonnet-4-20250514',
  modelListLink:'View {name} model list',
  // Misc
  toolsLabel:'Tools',confirmDetachCron:'Detach "{name}" from this service?',shutdownFailed:'Shutdown failed: ',
  confirmOk:'OK',serviceSingular:'service',servicePlural:'services',
  ok:'OK',
},
ko:{
  services:'내 샐러드',skills:'스킬',activeServices:'내 샐러드',
  saladDesc:'샐러드를 완성해 나만의 에이전트와 이야기 나누세요!',
  useCaseLink:'🥕이렇게 사용해보세요',
  useCaseTitle:'이렇게 사용해보세요',
  useCase1Title:'나만의 피트니스 트레이너',
  useCase1Desc:'매일 아침 식단과 운동 리스트를 보내고, 운동 완료 여부를 체크해주는 나만의 PT 에이전트예요.',
  useCase1How:'<div class="uc-step"><b>1. 에이전트 만들기</b><br>시스템 프롬프트에 <i>"너는 나만의 피트니스 코치야. 매일 식단과 운동 루틴을 관리해줘."</i> 라고 입력하세요. 이제 에이전트는 피트니스 코치처럼 행동할 거예요.</div><div class="uc-step"><b>2. 스킬 켜기</b><br><b>파일</b> 스킬을 켜세요 — 에이전트가 운동 기록을 저장하고 다음 날 확인할 수 있어요.<br><b>예약</b> 스킬을 켜세요 — 정해진 시간에 자동으로 메시지를 보내는 예약 기능이에요.</div><div class="uc-step"><b>3. 대상 선택</b><br>나 자신을 대상으로 선택하세요. 내가 메시지를 받을 사람이에요.</div><div class="uc-step"><b>4. 샐러드 만들고 예약 붙이기</b><br>샐러드를 만든 뒤, 예약 블록을 만들어 샐러드에 드래그하세요.<br>이름: <i>"매일 운동"</i>, 시간: <i>07:00</i><br>프롬프트: <i>"오늘의 식단과 운동 리스트를 보내고, 어제 운동을 했는지 파일에서 확인해줘."</i><br>이제 매일 아침 7시에 에이전트가 자동으로 PT를 시작해요!</div>',
  useCase2Title:'배우 친구를 위한 오디션 스카우트',
  useCase2Desc:'컴퓨터를 잘 모르는 배우 지망생 친구 대신, 매일 포럼에서 오디션 공고를 모아 이메일로 보내주는 에이전트예요.',
  useCase2How:'<div class="uc-step"><b>1. 에이전트 만들기</b><br>시스템 프롬프트에 <i>"너는 오디션 스카우터야. 매일 배우 오디션과 캐스팅 공고를 찾아서 정리해줘."</i> 라고 입력하세요.</div><div class="uc-step"><b>2. 스킬 켜기</b><br><b>웹 가져오기</b>를 켜세요 — 에이전트가 인터넷에서 오디션 정보를 직접 수집할 수 있어요.<br><b>파일</b>과 <b>예약</b>도 켜세요.</div><div class="uc-step"><b>3. 커스텀 스킬 만들기 (선택)</b><br>스킬 탭에서 <i>"send_email"</i> 스크립트 스킬을 만들면, 에이전트가 수집한 공고를 이메일로 바로 전달할 수 있어요.</div><div class="uc-step"><b>4. 대상 선택</b><br>친구의 텔레그램을 대상으로 선택하세요. 에이전트가 친구에게 직접 메시지를 보내요.</div><div class="uc-step"><b>5. 샐러드 만들고 예약 붙이기</b><br>이름: <i>"오디션 수집"</i>, 시간: <i>09:00</i><br>프롬프트: <i>"배우 포럼에서 최신 오디션 모집공고를 검색하고, 정리해서 이메일로 보내줘."</i><br>이제 매일 아침 9시에 에이전트가 알아서 공고를 모아 친구에게 보내요!</div>',
  useCase3Title:'매일 아침 뉴스 브리핑',
  useCase3Desc:'관심 분야의 주요 뉴스를 매일 아침 요약해서 채팅으로 보내주는 나만의 뉴스 큐레이터예요.',
  useCase3How:'<div class="uc-step"><b>1. 에이전트 만들기</b><br>시스템 프롬프트에 <i>"너는 뉴스 큐레이터야. 매일 핵심 헤드라인을 모아서 한눈에 보기 좋게 요약해줘."</i> 라고 입력하세요.</div><div class="uc-step"><b>2. 스킬 켜기</b><br><b>웹 가져오기</b>를 켜세요 — 에이전트가 뉴스 사이트에서 직접 기사를 가져올 수 있어요.<br><b>예약</b>을 켜세요 — 매일 정해진 시간에 자동으로 브리핑을 받을 수 있어요.</div><div class="uc-step"><b>3. 대상 선택</b><br>나 자신을 선택하세요. 혹은, 뉴스를 같이 받아볼 친구를 대상으로 추가해도 돼요.</div><div class="uc-step"><b>4. 샐러드 만들고 예약 붙이기</b><br>이름: <i>"아침 뉴스"</i>, 시간: <i>08:00</i><br>프롬프트: <i>"TechCrunch, Reuters에서 오늘의 주요 뉴스 5개를 가져와서 요약해줘."</i><br>매일 아침 8시, 에이전트가 웹에서 뉴스를 가져와 깔끔하게 정리해서 보내줄 거예요!</div>',
  useCase4Title:'선생님의 학생 관리',
  useCase4Desc:'학생들에게 숙제를 알리고, 퀴즈를 보내고, 제출 여부를 추적하는 선생님용 보조 에이전트예요.',
  useCase4How:'<div class="uc-step"><b>1. 에이전트 만들기</b><br>시스템 프롬프트에 <i>"너는 담임 보조 에이전트야. 학생들에게 숙제 알림을 보내고, 퀴즈를 출제하고, 제출 여부를 확인해줘."</i> 라고 입력하세요.</div><div class="uc-step"><b>2. 스킬 켜기</b><br><b>파일</b>을 켜세요 — 에이전트가 학생별로 제출 기록과 진도를 파일에 저장하고 관리해요.<br><b>예약</b>을 켜세요 — 정해진 시간에 자동으로 숙제 알림을 보낼 수 있어요.</div><div class="uc-step"><b>3. 대상 선택</b><br>학생들을 각각 대상으로 추가하세요. 샐러드 만들 때 대상 슬롯에 여러 명을 드래그하면 한 번에 만들어져요.</div><div class="uc-step"><b>4. 샐러드 만들고 예약 붙이기</b><br>이름: <i>"숙제 확인"</i>, 시간: <i>16:00</i><br>프롬프트: <i>"오늘 숙제 제출 여부를 확인하고, 미제출 학생에게 알림을 보내줘."</i><br>예약을 샐러드에 드래그하면 모든 학생에게 동시에 적용돼요.</div><div class="uc-step"><b>✨ 팁</b><br>에이전트는 학생마다 별도의 워크스페이스 폴더를 사용해서 진도와 제출 기록을 자동으로 관리해요. 학생 A의 기록이 학생 B에게 섞이지 않아요.</div>',
  createServiceDrag:'샐러드 만들기',createServiceDesc:'아래 블록을 슬롯으로 드래그하세요',
  agents:'에이전트',channels:'채널',targets:'대상',crons:'예약',
  add:'+ 추가',agent:'에이전트',channel:'채널',target:'대상',
  agentDesc:'에이전트의 제공자와 모델을 설정하세요.',
  channelDesc:'에이전트와 대화 나눌 채널(봇)을 등록하세요.',
  targetDesc:'에이전트가 누구와 대화하길 원하나요? 나? 친구?',
  dropHere:'여기에 놓기',createService:'샐러드 만들기',clear:'초기화',
  name:'이름',provider:'프로바이더',model:'모델',systemPrompt:'시스템 프롬프트',
  create:'생성',botToken:'봇 토큰',addPair:'추가 & 페어링',
  platform:'플랫폼',platformUserId:'플랫폼 사용자 ID',nickname:'닉네임',
  prompt:'프롬프트',schedule:'스케줄',dailyRepeat:'매일 반복',oneTime:'단발성',
  time:'시간 (HH:MM)',dateTime:'날짜 & 시간',sendToChannel:'채널로 응답 전송',
  noServices:'아직 샐러드가 없습니다. 먼저 아래에서 나만의 맛있는 샐러드를 만드세요.',
  noAgents:'에이전트가 아직 없습니다',noChannels:'채널이 아직 없습니다',
  noTargets:'대상이 아직 없습니다',noCrons:'예약이 아직 없습니다',
  agentSkillConfig:'에이전트 스킬 설정',selectAgent:'에이전트 선택:',
  builtinSkills:'기본 스킬',customSkills:'내 스킬',saveToggles:'토글 저장',
  newSkill:'+ 새 스킬',googleIntegration:'Google 연동 (gog CLI)',
  llmProviderKeys:'LLM 프로바이더 키',close:'닫기',save:'저장',cancel:'취소',
  del:'삭제','delete':'삭제',pause:'일시정지하려면 누르세요',resume:'다시 시작하려면 누르세요',description:'설명',
  svcDesc:'{agent}가 {channel} 채널을 통해 {target}에게 서비스합니다.',
  svcDescMulti:'{agent}가 {channel} 채널을 통해 {targets}에게 서비스합니다.',
  sysPromptHelp:'에이전트의 성격, 역할, 목표를 자연어로 적어주세요. 예: "너는 친절한 영어 선생님이야. 한국어로 설명하고 영어 예문을 함께 알려줘."',
  modelHelp:'프로바이더 공식 문서에서 모델명을 확인하세요.',
  customSkillCta:'원하는 스킬이 없나요? 직접 만들어 보세요 →',
  skillsLabel:'스킬',timeAwareness:'시간 인지',
  timeAwarenessDesc:'활성화하면 사용자 메시지에 타임스탬프가 포함되고, 에이전트가 현재 시간을 인지합니다.',
  smartStep:'스마트 스텝',
  smartStepDesc:'활성화하면 복잡한 작업을 여러 단계로 나눠 자동 실행할 수 있습니다.',
  maxPlanSteps:'최대 단계 수',workspace:'워크스페이스',openFolder:'폴더 열기',
  status:'상태',bot:'봇',paired:'페어링됨',pending:'대기중',
  confirmDelete:'삭제하시겠습니까?',confirmDeleteAgent:'이 에이전트와 관련된 모든 샐러드를 삭제하시겠습니까?',
  confirmDeleteChannel:'이 채널과 관련된 모든 샐러드를 삭제하시겠습니까?',
  confirmDeleteTarget:'이 대상과 관련된 모든 샐러드를 삭제하시겠습니까?',
  confirmDeleteCron:'이 예약을 삭제하시겠습니까?',
  confirmShutdown1:'정말로 서버를 종료하시겠습니까?\\n\\n실행 중인 모든 샐러드와 플랜이 중단됩니다.',
  confirmShutdown2:'최종 확인: 서버를 종료합니다.',
  serverShutDown:'서버가 종료되었습니다.',alreadyAttached:'이미 연결되어 있습니다',
  missingSkills:'에이전트에 필요한 스킬이 없습니다: ',
  skillsToolSelect:'스킬 (도구 선택)',scriptTool:'스크립트 도구',promptOnly:'프롬프트만',
  toolName:'도구 이름',toolNameHint:'(영문 소문자+언더스코어)',
  skillFolder:'스킬 폴더',skillFolderWillCreate:'저장하면 스킬 폴더가 생성됩니다:',
  nameRequired:'이름을 입력하세요',toolNameRequired:'도구 이름을 입력하세요',
  toolNameFormat:'도구 이름은 영문 소문자와 언더스코어만 가능합니다',
  nameAndPromptRequired:'이름과 프롬프트를 입력하세요',dateTimeRequired:'날짜와 시간을 입력하세요',
  pairingFailed:'페어링 실패: ',failedCreateChannel:'채널 생성 실패',typeMismatch:'채널과 대상의 플랫폼이 일치해야 합니다',
  unknownProvider:'알 수 없는 프로바이더',apiKeyNotSet:'API 키 미설정',notPaired:'페어링 안됨',
  newCustomSkill:'새 커스텀 스킬',editCustomSkill:'커스텀 스킬 편집',
  deleteCustomSkill:'이 커스텀 스킬을 삭제하시겠습니까?',
  noCustomSkills:'커스텀 스킬이 없습니다. "+ 새 스킬"을 클릭하여 생성하세요.',
  noCustomSkillsTitle:'아직 만든 스킬이 없습니다.',
  noCustomSkillsCta:'에이전트에게 새로운 능력을 부여해볼까요?',
  gogDetected:'gog CLI가 감지되었습니다. Google 스킬을 사용할 수 있습니다.',
  gogNotFound:'gog CLI를 찾을 수 없습니다. Google 스킬을 사용하려면 설치하세요.',
  gogSetupSteps:'설정 단계:',
  gogExplain:'gog는 Google API(Gmail, Calendar, Drive)에 OAuth2 인증으로 접근할 수 있게 해주는 커맨드라인 도구입니다. Agent Salad의 Google 스킬은 gog CLI를 통해 Google 서비스에 접근합니다.',
  gogGcpGuide:'Google Cloud Console 설정:',
  gogGcpStep1:'console.cloud.google.com에서 프로젝트 생성',
  gogGcpStep2:'Gmail API, Calendar API, Drive API 활성화',
  gogGcpStep3:'API 및 서비스 → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID 만들기 (데스크톱) → JSON 다운로드',
  gogCliGuide:'CLI 설치 및 인증:',
  gogSkillNote:'이 스킬은 gog CLI가 필요합니다. Skills 탭 하단의 "Google 연동" 섹션에서 설치 방법을 확인하세요.',
  gogRestartNote:'gog CLI 설치 후 서버를 재시작해야 반영됩니다.',
  clearApiKey:'이 API 키를 삭제하시겠습니까?',
  setLabel:'설정됨',notSetLabel:'미설정',opening:'열는 중...',opened:'열었습니다!',
  runScript:'run.sh — 실행 스크립트',schemaJson:'schema.json — 입력 파라미터 정의',
  promptTxt:'prompt.txt — LLM 도구 사용 안내',guideMd:'GUIDE.md — 상세 구현 가이드',
  promptHint:'(LLM에게 이 도구를 언제/어떻게 쓸지 안내)',
  agentsTab:'에이전트',selectAgent:'에이전트를 선택하세요',allSkills:'스킬',
  selectSkill:'목록에서 스킬을 선택하세요',builtinLabel:'기본',scriptLabel:'스크립트',promptLabel:'프롬프트',
  skillType:'유형',skillAvailable:'사용 가능',skillNotAvailable:'사용 불가',
  builtinSkillNote:'기본 스킬은 에이전트 탭에서 에이전트별로 설정합니다.',
  skillCategory:'카테고리',noSkills:'아직 스킬이 없습니다',
  aboutTitle:'에이전트 샐러드란?',
  aboutP1:'<b>에이전트</b>(AI 두뇌) + <b>채널</b>(메신저 봇) + <b>대상</b>(사용자)을 조합해 나만의 AI 서비스를 만드는 플랫폼입니다.',
  aboutP2:'마치 샐러드를 만들듯, 원하는 재료를 골라 섞으면 됩니다.',
  aboutStep1:'<b>에이전트</b>를 만들어 AI의 성격과 역할을 정하고',
  aboutStep2:'<b>채널</b>에 메신저 봇을 연결하고',
  aboutStep3:'<b>대상</b>에 대화할 사람을 등록한 뒤',
  aboutStep4:'세 가지를 드래그해서 <b>샐러드</b>를 완성하세요!',
  aboutP3:'예약을 추가하면 정해진 시간에 에이전트가 자동으로 작업할 수도 있습니다.',
  apiKeySetup:'API 키 설정',serverShutdown:'서버 종료',
  logoHelp:'에이전트 샐러드가 무엇인가요?',addAgent:'+ 에이전트 만들기',createAgent:'+ 에이전트 만들기',
  cronDesc:'예약을 만들어 샐러드에 연결하면, 정해진 시간에 예약 작업을 합니다. 예약을 만들고 드래그해서 샐러드에 뿌려보세요.',
  agentNameHint:'에이전트를 구분할 이름을 지어주세요.',phAgentName:'예: 영어 선생님',
  agentDescHint:'이 에이전트가 무엇을 하는지 메모해두세요.',phAgentDesc:'예: 영어 회화를 도와주는 에이전트',
  providerSelectHint:'어떤 AI 서비스를 사용할지 선택하세요.',
  providerApiKeyNotice:'선택한 프로바이더의 API 키가 필요합니다. 상단 <b>API 키 설정</b>에서 먼저 등록하세요.',
  providerApiKeyLink:'{name} API 키 발급받기',
  modelInputHint:'모델명은 프로바이더마다 다릅니다. 정확한 이름을 직접 입력하세요.',
  sysPromptHelpTitle:'시스템 프롬프트란?',
  sysPromptHelpBody:'이 에이전트에게 어떤 것을 기대하나요? 어떤 성격, 어떤 역할, 어떤 규칙을 따르게 할지 적어주세요.',
  sysPromptHelpExample:'예: "너는 친절한 영어 선생님이야. 한국어로 설명하고 영어 예문을 함께 알려줘."',
  phSystemPrompt:'성격, 역할, 목표를 자유롭게 적어주세요...',
  agentSkillsHint:'에이전트가 사용할 수 있는 도구를 선택하세요. 파일, 웹, 터미널 등을 허용할 수 있습니다.',
  channelNameHint:'이 채널을 구분할 이름을 지어주세요.',phChannelName:'예: 내 텔레그램 봇',
  channelTypeHint:'이 채널에 사용할 메신저 플랫폼을 선택하세요.',
  botTokenHint:'Telegram에서 <a href="https://t.me/BotFather" target="_blank">@BotFather</a>로 봇을 만들고, 받은 토큰을 붙여넣으세요.',
  botTokenHintDiscord:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://discord.com/developers/applications" target="_blank">Discord Developer Portal</a> → <b>New Application</b> → 이름 입력 → Create</li>'
    +'<li>왼쪽 메뉴 → <b>Bot</b> → <b>Reset Token</b> 클릭 → 토큰 <b>복사</b></li>'
    +'<li>아래로 스크롤 → <b>Privileged Gateway Intents</b> → <b>MESSAGE CONTENT INTENT</b>와 <b>SERVER MEMBERS INTENT</b> 켜기 → Save</li>'
    +'<li>왼쪽 메뉴 → <b>OAuth2</b> → <b>URL Generator</b></li>'
    +'<li>Scopes: <b>bot</b> 체크 · Bot Permissions: <b>Send Messages</b>, <b>Read Message History</b>, <b>View Channels</b></li>'
    +'<li>생성된 URL 복사 → 브라우저에서 열기 → 서버 선택 → Authorize (봇 초대 완료)</li>'
    +'</ol>',
  botTokenHintSlack:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> → 이름 입력, 워크스페이스 선택 → Create</li>'
    +'<li>왼쪽 메뉴 → <b>OAuth &amp; Permissions</b> → <b>Bot Token Scopes</b>에 추가: <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code>, <code>app_mentions:read</code>, <code>users:read</code></li>'
    +'<li>위로 스크롤 → <b>Install to Workspace</b> → Allow</li>'
    +'<li><b>Bot User OAuth Token</b> 복사 (<code>xoxb-</code>로 시작)</li>'
    +'<li>왼쪽 메뉴 → <b>Event Subscriptions</b> → Enable Events → 봇 이벤트 추가: <code>message.im</code>, <code>message.channels</code>, <code>app_mention</code> → Save</li>'
    +'</ol>',
  appTokenHint:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>왼쪽 메뉴 → <b>Socket Mode</b> → <b>Enable Socket Mode</b> 켜기</li>'
    +'<li>다이얼로그에서 토큰 이름 입력 (예: "socket") → 스코프 <code>connections:write</code> 추가 → <b>Generate</b></li>'
    +'<li>토큰 복사 (<code>xapp-</code>로 시작)</li>'
    +'<li><i>또는: Basic Information → App-Level Tokens → Generate Token and Scopes</i></li>'
    +'</ol>',
  appToken:'앱 레벨 토큰',
  platformSelectHint:'메시지를 전달할 플랫폼을 선택하세요.',
  platformUserIdHint:'Telegram에서 <a href="https://t.me/userinfobot" target="_blank">@userinfobot</a>에게 메시지를 보내면 숫자 ID를 확인할 수 있습니다.',phPlatformUserId:'예: 123456789',
  platformUserIdHintDiscord:'Discord → 설정 → 고급 → <b>개발자 모드</b> 켜기. 유저 우클릭 → <b>사용자 ID 복사</b> (<code>284102390284</code> 같은 긴 숫자).',
  platformUserIdHintSlack:'Slack에서 유저 이름 클릭 → <b>전체 프로필 보기</b> → <b>⋮</b> (더 보기) → <b>멤버 ID 복사</b> (<code>U04ABCDEF</code> 형태).',
  nicknameHint:'누구인지 알아볼 수 있는 별명을 적어주세요.',phNickname:'예: 태형이',
  targetType:'타겟 유형',targetTypeHint:'유저 = DM 대상, 방 = 채널/스레드 대상.',
  targetTypeUser:'유저 (DM)',targetTypeRoom:'방 (채널)',
  roomId:'채널/방 ID',roomIdHint:'Discord에서 개발자 모드 켜고 채널 우클릭 → ID 복사, Slack에서 채널 상세 → 하단의 채널 ID.',
  autoSession:'자동 세션',autoSessionHint:'새로운 유저나 방이 봇과 대화하면 자동으로 세션을 생성합니다.',
  autoSessionBadge:'자동',
  cronPromptHint:'예약된 시간에 에이전트가 무엇을 하길 원하는지 적어주세요. 예: "오늘의 주요 뉴스를 요약해줘"',
  phCronName:'매일 뉴스 요약',phCronPrompt:'에이전트에게 보낼 지시...',
  cronSkillsHint:'예약 활동 시 에이전트가 사용할 도구가 있다면 선택하세요. 없으면 비워둬도 됩니다.',
  scheduleHint:'매일 반복: 매일 같은 시간에 실행됩니다. 단발성: 지정한 날짜·시간에 한 번만 실행됩니다.',
  cronNotifyHint:'활동이 끝난 후 결과를 채널로 보고받고 싶다면 켜두세요. 조용히 처리만 하길 원하면 꺼두세요.',
  newSkillIntro:'에이전트에게 새로운 능력을 부여하세요. 스크립트를 작성해 도구로 쓰거나, 텍스트만으로 지침을 내릴 수 있습니다.',
  skillNameHint:'스킬을 구분할 이름을 지어주세요.',phSkillName:'예: 유튜브 요약기',
  skillTypeScriptHint:'기본 스킬만으로 수행하기 힘들거나 시간이 오래 걸리는 작업을 자동화할 수 있습니다. 스킬을 만들면 스킬 폴더 안에 가이드 문서가 생성됩니다.',
  skillTypePromptHint:'스크립트 없이 텍스트로만 내리는 지침입니다. 에이전트가 참고할 행동 규칙이나 전문 지식을 적어주세요.',
  toolNameHintDesc:'에이전트가 이 도구를 호출할 때 사용하는 이름입니다. 영문 소문자와 언더스코어(_)만 사용하세요.',phToolName:'예: check_inventory',
  skillPromptHint:'에이전트가 이 스킬을 사용할 때 참고할 지침을 적어주세요.',phSkillPrompt:'예: 사용자가 요약을 요청하면...',
  phApiKey:'API 키',
  sl_file_read:'파일 읽기',sl_file_write:'파일 쓰기',sl_file_list:'파일 목록',
  sl_web_fetch:'웹 페이지 가져오기',sl_web_browse:'웹 브라우저',sl_bash:'터미널 명령어',
  sl_google_gmail:'Gmail 메일',sl_google_calendar:'Google 캘린더',sl_google_drive:'Google 드라이브',sl_cron:'예약 스케줄 관리',
  sc_file:'파일',sc_web:'웹',sc_system:'시스템',sc_google:'구글',sc_automation:'자동화',
  sd_file_read:'워크스페이스 안의 파일을 읽습니다. 메모, 설정 파일 등을 참고할 때 사용합니다.',
  sd_file_write:'워크스페이스에 파일을 생성하거나 수정합니다. 작업 결과를 저장할 때 사용합니다.',
  sd_file_list:'워크스페이스의 파일/폴더 목록을 조회합니다. 어떤 파일이 있는지 확인할 때 사용합니다.',
  sd_web_fetch:'URL을 입력하면 해당 웹 페이지의 텍스트를 가져옵니다. 뉴스, 문서 등을 읽을 때 사용합니다.',
  sd_web_browse:'Chromium 브라우저 창이 열려 클릭, 입력, 스크롤, 스크린샷을 수행합니다. 스크린샷은 채팅으로 자동 전송됩니다. <code>BROWSER_CDP_URL</code>을 설정하면 내 Chrome에 연결할 수 있습니다.',
  sd_bash:'서버에서 셸 명령어를 실행합니다. 스크립트 실행, 패키지 설치 등에 사용합니다. <b style="color:var(--red)">⚠ 디바이스 전체 접근 가능.</b> 본인 또는 신뢰하는 사람에게만 서비스하세요.',
  sd_google_gmail:'Gmail에서 메일을 검색·읽기·보내기 합니다. Google OAuth2 인증 도구인 <b>gog CLI</b>가 필요합니다.',
  sd_google_calendar:'Google 캘린더의 일정을 조회하거나 새로 만듭니다. Google OAuth2 인증 도구인 <b>gog CLI</b>가 필요합니다.',
  sd_google_drive:'Google 드라이브에서 파일을 검색·다운로드·업로드 합니다. Google OAuth2 인증 도구인 <b>gog CLI</b>가 필요합니다.',
  sd_cron:'에이전트가 스스로 예약 작업을 만들고 관리합니다. "매일 아침 뉴스 정리해줘" 같은 요청에 사용합니다.',
  provHintAnthropic:'예: claude-sonnet-4-20250514',provHintOpenai:'예: gpt-4o',
  provHintGroq:'예: llama-3.3-70b-versatile',provHintOpenrouter:'예: anthropic/claude-sonnet-4-20250514',
  provHintOpencode:'예: claude-sonnet-4-20250514',
  modelListLink:'{name} 모델 목록 확인하기',
  toolsLabel:'도구',confirmDetachCron:'"{name}" 예약을 이 샐러드에서 분리하시겠습니까?',shutdownFailed:'종료 실패: ',
  confirmOk:'확인',serviceSingular:'서비스',servicePlural:'서비스',
  ok:'확인',
},
ja:{
  services:'マイサラダ',skills:'スキル',activeServices:'マイサラダ',
  saladDesc:'サラダを完成させて、自分だけのエージェントと話しましょう！',
  useCaseLink:'🥕こう使ってみて',
  useCaseTitle:'こう使ってみて',
  useCase1Title:'パーソナルフィットネストレーナー',
  useCase1Desc:'毎朝の食事プランと運動リストを送り、完了をチェックしてくれる自分だけのPTエージェントです。',
  useCase1How:'<div class="uc-step"><b>1. エージェントを作る</b><br>システムプロンプトに<i>「あなたは私のフィットネスコーチ。毎日の食事と運動ルーティンを管理して。」</i>と入力しましょう。エージェントがフィットネスコーチとして動きます。</div><div class="uc-step"><b>2. スキルをオンにする</b><br><b>ファイル</b>をオン — エージェントが運動記録を保存して翌日確認できます。<br><b>スケジュール</b>をオン — 決まった時間に自動メッセージを送る予約機能です。</div><div class="uc-step"><b>3. ターゲットを選ぶ</b><br>自分自身を選びましょう。メッセージを受け取る人です。</div><div class="uc-step"><b>4. サラダを作ってスケジュールを付ける</b><br>サラダ作成後、スケジュールブロックを作ってドラッグしましょう。<br>名前: <i>「毎日の運動」</i>、時間: <i>07:00</i><br>プロンプト: <i>「今日の食事と運動リストを送って、昨日の運動をファイルで確認して。」</i><br>毎朝7時にエージェントが自動でPTを始めます！</div>',
  useCase2Title:'俳優の友達にオーディション情報を',
  useCase2Desc:'パソコンが苦手な俳優志望の友達のために、毎日フォーラムからオーディション情報を集めてメールで届けるエージェントです。',
  useCase2How:'<div class="uc-step"><b>1. エージェントを作る</b><br>システムプロンプトに<i>「あなたはオーディションスカウト。毎日俳優オーディションとキャスティング情報を探して整理して。」</i>と入力しましょう。</div><div class="uc-step"><b>2. スキルをオンにする</b><br><b>Web取得</b>をオン — エージェントがネットからオーディション情報を収集できます。<br><b>ファイル</b>と<b>スケジュール</b>もオンにしましょう。</div><div class="uc-step"><b>3. カスタムスキルを作る（任意）</b><br>スキルタブで<i>「send_email」</i>スクリプトスキルを作ると、集めた情報をメールで転送できます。</div><div class="uc-step"><b>4. ターゲットを選ぶ</b><br>友達のTelegramをターゲットに選びましょう。エージェントが直接メッセージを送ります。</div><div class="uc-step"><b>5. サラダを作ってスケジュールを付ける</b><br>名前: <i>「オーディション収集」</i>、時間: <i>09:00</i><br>プロンプト: <i>「俳優フォーラムから最新のキャスティング情報を検索して、メールで送って。」</i><br>毎朝9時にエージェントが情報を集めて友達に届けます！</div>',
  useCase3Title:'毎朝ニュースブリーフィング',
  useCase3Desc:'関心分野の主要ニュースを毎朝要約してチャットに届けてくれる、自分だけのニュースキュレーターです。',
  useCase3How:'<div class="uc-step"><b>1. エージェントを作る</b><br>システムプロンプトに<i>「あなたはニュースキュレーター。毎日のキーヘッドラインを集めて読みやすくまとめて。」</i>と入力しましょう。</div><div class="uc-step"><b>2. スキルをオンにする</b><br><b>Web取得</b>をオン — エージェントがニュースサイトから記事を取得できます。<br><b>スケジュール</b>をオン — 決まった時間にブリーフィングを自動受信できます。</div><div class="uc-step"><b>3. ターゲットを選ぶ</b><br>自分を選びましょう。友達も一緒にブリーフィングを受けたいなら、ターゲットに追加してもOK。</div><div class="uc-step"><b>4. サラダを作ってスケジュールを付ける</b><br>名前: <i>「朝のニュース」</i>、時間: <i>08:00</i><br>プロンプト: <i>「TechCrunch、Reutersから今日の主要ニュース5件を取得して要約して。」</i><br>毎朝8時、エージェントがニュースをきれいにまとめてお届けします！</div>',
  useCase4Title:'先生の生徒管理',
  useCase4Desc:'生徒に宿題をリマインドし、クイズを送り、提出状況を追跡する先生用のアシスタントエージェントです。',
  useCase4How:'<div class="uc-step"><b>1. エージェントを作る</b><br>システムプロンプトに<i>「あなたは担任アシスタント。生徒に宿題リマインドを送り、クイズを出題し、提出を確認して。」</i>と入力しましょう。</div><div class="uc-step"><b>2. スキルをオンにする</b><br><b>ファイル</b>をオン — 生徒ごとの進捗と提出記録をファイルに保存・管理します。<br><b>スケジュール</b>をオン — 決まった時間に自動で宿題リマインドを送れます。</div><div class="uc-step"><b>3. ターゲットを選ぶ</b><br>各生徒をそれぞれターゲットに追加しましょう。サラダ作成時にターゲットスロットに複数ドラッグすれば一括作成されます。</div><div class="uc-step"><b>4. サラダを作ってスケジュールを付ける</b><br>名前: <i>「宿題チェック」</i>、時間: <i>16:00</i><br>プロンプト: <i>「今日の宿題提出を確認して、未提出の生徒にリマインドを送って。」</i><br>スケジュールをサラダにドラッグすると、全生徒に一括適用されます。</div><div class="uc-step"><b>✨ ヒント</b><br>エージェントは生徒ごとに別のワークスペースフォルダを使うので、進捗や記録が混ざることはありません。</div>',
  createServiceDrag:'サラダを作る',createServiceDesc:'下のブロックをスロットにドラッグ',
  agents:'エージェント',channels:'チャンネル',targets:'ターゲット',crons:'スケジュール',
  add:'+ 追加',agent:'エージェント',channel:'チャンネル',target:'ターゲット',
  dropHere:'ここにドロップ',createService:'サラダを作る',clear:'クリア',
  name:'名前',provider:'プロバイダー',model:'モデル',systemPrompt:'システムプロンプト',
  create:'作成',botToken:'ボットトークン',addPair:'追加＆ペアリング',
  platform:'プラットフォーム',platformUserId:'プラットフォームユーザーID',nickname:'ニックネーム',
  prompt:'プロンプト',schedule:'スケジュール',dailyRepeat:'毎日繰り返し',oneTime:'一回限り',
  time:'時間 (HH:MM)',dateTime:'日時',sendToChannel:'チャンネルに応答を送信',
  noServices:'まだサラダがありません。スロットにエージェント、チャンネル、ターゲットをドラッグして作りましょう。',
  noAgents:'エージェントがまだありません',noChannels:'チャンネルがまだありません',
  noTargets:'ターゲットがまだありません',noCrons:'スケジュールがまだありません',
  agentSkillConfig:'エージェントスキル設定',selectAgent:'エージェント選択:',
  builtinSkills:'ビルトインスキル',customSkills:'カスタムスキル',saveToggles:'トグル保存',
  newSkill:'+ 新規スキル',googleIntegration:'Google連携 (gog CLI)',
  llmProviderKeys:'LLMプロバイダーキー',close:'閉じる',save:'保存',cancel:'キャンセル',
  del:'削除','delete':'削除',pause:'一時停止',resume:'再開',description:'説明',
  svcDesc:'{agent} が {channel} 経由で {target} にサービス中',
  svcDescMulti:'{agent} が {channel} 経由で {targets} にサービス中',
  agentDesc:'エージェントのプロバイダーとモデルを設定します。',
  channelDesc:'会話用のチャンネル（ボット）を登録します。',
  targetDesc:'エージェントは誰と話しますか？自分？友達？',
  customSkillCta:'欲しいスキルがありませんか？自分で作りましょう →',
  skillsLabel:'スキル',timeAwareness:'時間認識',
  timeAwarenessDesc:'有効にすると、ユーザーメッセージにタイムスタンプが含まれ、エージェントが現在時刻を認識します。',
  smartStep:'スマートステップ',
  smartStepDesc:'有効にすると、複雑なタスクを複数ステップに分けて自動実行できます。',
  maxPlanSteps:'最大ステップ数',workspace:'ワークスペース',openFolder:'フォルダを開く',
  status:'ステータス',bot:'ボット',paired:'ペアリング済',pending:'待機中',
  confirmDelete:'削除しますか？',confirmDeleteAgent:'このエージェントと関連する全サラダを削除しますか？',
  confirmDeleteChannel:'このチャンネルと関連する全サラダを削除しますか？',
  confirmDeleteTarget:'このターゲットと関連する全サラダを削除しますか？',
  confirmDeleteCron:'このスケジュールを削除しますか？',
  confirmShutdown1:'サーバーを停止してもよろしいですか？\\n\\n実行中のすべてのサラダとプランが停止します。',
  confirmShutdown2:'最終確認: サーバーを停止します。',
  serverShutDown:'サーバーが停止しました。',alreadyAttached:'既に接続されています',
  missingSkills:'エージェントに必要なスキルがありません: ',
  skillsToolSelect:'スキル（ツール選択）',scriptTool:'スクリプトツール',promptOnly:'プロンプトのみ',
  toolName:'ツール名',toolNameHint:'(英小文字+アンダースコア)',
  skillFolder:'スキルフォルダ',skillFolderWillCreate:'保存するとスキルフォルダが作成されます:',
  nameRequired:'名前を入力してください',toolNameRequired:'ツール名を入力してください',
  toolNameFormat:'ツール名は英小文字とアンダースコアのみ',
  nameAndPromptRequired:'名前とプロンプトを入力してください',dateTimeRequired:'日時を入力してください',
  pairingFailed:'ペアリング失敗: ',failedCreateChannel:'チャンネル作成失敗',typeMismatch:'チャンネルとターゲットのプラットフォームが一致する必要があります',
  unknownProvider:'不明なプロバイダー',apiKeyNotSet:'APIキー未設定',notPaired:'未ペアリング',
  newCustomSkill:'新規カスタムスキル',editCustomSkill:'カスタムスキル編集',
  deleteCustomSkill:'このカスタムスキルを削除しますか？',
  noCustomSkills:'カスタムスキルがありません。「+ 新規スキル」をクリックして作成してください。',
  noCustomSkillsTitle:'まだスキルがありません。',
  noCustomSkillsCta:'エージェントに新しい能力を与えてみませんか？',
  gogDetected:'gog CLIが検出されました。Googleスキルが利用可能です。',
  gogNotFound:'gog CLIが見つかりません。Googleスキルを使用するにはインストールしてください。',
  gogSetupSteps:'セットアップ手順:',
  gogExplain:'gogはGoogle API（Gmail、Calendar、Drive）にOAuth2認証でアクセスするためのコマンドラインツールです。Agent SaladのGoogleスキルはgog CLIを通じてGoogleサービスに接続します。',
  gogGcpGuide:'Google Cloud Console設定:',
  gogGcpStep1:'console.cloud.google.comでプロジェクトを作成',
  gogGcpStep2:'Gmail API、Calendar API、Drive APIを有効化',
  gogGcpStep3:'APIとサービス → 認証情報 → OAuth 2.0クライアントIDを作成（デスクトップ） → JSONをダウンロード',
  gogCliGuide:'CLIインストールと認証:',
  gogSkillNote:'このスキルにはgog CLIが必要です。スキルタブ下部の「Google連携」セクションでセットアップ方法を確認してください。',
  gogRestartNote:'gog CLIインストール後、サーバーを再起動して反映してください。',
  clearApiKey:'このAPIキーを削除しますか？',
  setLabel:'設定済み',notSetLabel:'未設定',opening:'開いています...',opened:'開きました！',
  runScript:'run.sh — 実行スクリプト',schemaJson:'schema.json — 入力パラメータ定義',
  promptTxt:'prompt.txt — LLMツールガイド',guideMd:'GUIDE.md — 実装ガイド',
  promptHint:'(LLMにこのツールの使い方を案内)',
  agentsTab:'エージェント',selectAgent:'エージェントを選択',allSkills:'スキル',
  selectSkill:'リストからスキルを選択してください',builtinLabel:'内蔵',scriptLabel:'スクリプト',promptLabel:'プロンプト',
  skillType:'タイプ',skillAvailable:'利用可能',skillNotAvailable:'利用不可',
  builtinSkillNote:'内蔵スキルはエージェントタブでエージェントごとに管理します。',
  skillCategory:'カテゴリ',noSkills:'まだスキルがありません',
  aboutTitle:'Agent Saladとは？',
  aboutP1:'<b>エージェント</b>（AI頭脳）+ <b>チャンネル</b>（メッセンジャーボット）+ <b>ターゲット</b>（ユーザー）を組み合わせて自分だけのAIサービスを作るプラットフォームです。',
  aboutP2:'サラダを作るように、好きな材料を選んで混ぜるだけです。',
  aboutStep1:'<b>エージェント</b>を作ってAIの性格と役割を決め',
  aboutStep2:'<b>チャンネル</b>にメッセンジャーボットを接続し',
  aboutStep3:'<b>ターゲット</b>に会話する相手を登録して',
  aboutStep4:'3つをドラッグして<b>サラダ</b>を完成させましょう！',
  aboutP3:'スケジュールを追加すると、決まった時間にエージェントが自動で作業します。',
  apiKeySetup:'APIキー設定',serverShutdown:'サーバー停止',
  logoHelp:'Agent Saladとは？',addAgent:'+ エージェント作成',createAgent:'+ エージェント作成',
  cronDesc:'スケジュールを作ってサラダに接続すると、決まった時間にタスクを実行します。ドラッグしてサラダに接続しましょう。',
  agentNameHint:'エージェントを識別する名前を付けてください。',phAgentName:'例: 英語の先生',
  agentDescHint:'このエージェントが何をするかメモしてください。',phAgentDesc:'例: 英会話を助けるエージェント',
  providerSelectHint:'どのAIサービスを使うか選んでください。',
  providerApiKeyNotice:'選択したプロバイダーのAPIキーが必要です。上部の<b>APIキー設定</b>で先に登録してください。',
  providerApiKeyLink:'{name} APIキーを取得',
  modelInputHint:'モデル名はプロバイダーごとに異なります。正確な名前を入力してください。',
  sysPromptHelpTitle:'システムプロンプトとは？',
  sysPromptHelpBody:'このエージェントに何を期待しますか？どんな性格、どんな役割、どんなルールに従わせるか書いてください。',
  sysPromptHelpExample:'例: 「あなたは親切な英語の先生です。日本語で説明し、英語の例文を一緒に教えてください。」',
  phSystemPrompt:'性格、役割、目標を自由に書いてください...',
  agentSkillsHint:'エージェントが使えるツールを選択してください。ファイル、ウェブ、ターミナルなど。',
  channelNameHint:'このチャンネルを識別する名前を付けてください。',phChannelName:'例: マイTelegramボット',
  channelTypeHint:'このチャンネルで使うメッセンジャーを選択してください。',
  botTokenHint:'Telegramで<a href="https://t.me/BotFather" target="_blank">@BotFather</a>からボットを作成し、トークンを貼り付けてください。',
  botTokenHintDiscord:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://discord.com/developers/applications" target="_blank">Discord Developer Portal</a> → <b>New Application</b> → 名前入力 → Create</li>'
    +'<li>左メニュー → <b>Bot</b> → <b>Reset Token</b> → トークンを<b>コピー</b></li>'
    +'<li>下にスクロール → <b>Privileged Gateway Intents</b> → <b>MESSAGE CONTENT INTENT</b>と<b>SERVER MEMBERS INTENT</b>をオン → Save</li>'
    +'<li>左メニュー → <b>OAuth2</b> → <b>URL Generator</b></li>'
    +'<li>Scopes: <b>bot</b> · Bot Permissions: <b>Send Messages</b>, <b>Read Message History</b>, <b>View Channels</b></li>'
    +'<li>生成URLをコピー → ブラウザで開く → サーバー選択 → Authorize（ボット招待完了）</li>'
    +'</ol>',
  botTokenHintSlack:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> → 名前・ワークスペース選択 → Create</li>'
    +'<li>左メニュー → <b>OAuth &amp; Permissions</b> → <b>Bot Token Scopes</b>に追加: <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code>, <code>app_mentions:read</code>, <code>users:read</code></li>'
    +'<li>上にスクロール → <b>Install to Workspace</b> → Allow</li>'
    +'<li><b>Bot User OAuth Token</b>をコピー（<code>xoxb-</code>で始まる）</li>'
    +'<li>左メニュー → <b>Event Subscriptions</b> → Enable Events → ボットイベント追加: <code>message.im</code>, <code>message.channels</code>, <code>app_mention</code> → Save</li>'
    +'</ol>',
  appTokenHint:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>左メニュー → <b>Socket Mode</b> → <b>Enable Socket Mode</b>をオン</li>'
    +'<li>ダイアログでトークン名入力（例: "socket"）→ スコープ<code>connections:write</code>追加 → <b>Generate</b></li>'
    +'<li>トークンをコピー（<code>xapp-</code>で始まる）</li>'
    +'<li><i>または: Basic Information → App-Level Tokens → Generate Token and Scopes</i></li>'
    +'</ol>',
  appToken:'App-Level Token',
  platformSelectHint:'メッセージを送るプラットフォームを選んでください。',
  platformUserIdHint:'Telegramで<a href="https://t.me/userinfobot" target="_blank">@userinfobot</a>にメッセージを送ると数字IDが分かります。',phPlatformUserId:'例: 123456789',
  platformUserIdHintDiscord:'Discord → 設定 → 詳細設定 → <b>開発者モード</b>をオン。ユーザーを右クリック → <b>ユーザーIDをコピー</b>（<code>284102390284</code>のような長い数字）。',
  platformUserIdHintSlack:'Slackでユーザー名をクリック → <b>プロフィール全体を表示</b> → <b>⋮</b> → <b>メンバーIDをコピー</b>（<code>U04ABCDEF</code>形式）。',
  nicknameHint:'この人を識別できるニックネームを付けてください。',phNickname:'例: 太郎',
  targetType:'ターゲットタイプ',targetTypeHint:'ユーザー = DM対象、ルーム = チャンネル/スレッド対象。',
  targetTypeUser:'ユーザー (DM)',targetTypeRoom:'ルーム (チャンネル)',
  roomId:'チャンネル/ルームID',roomIdHint:'Discordで開発者モードをオンにしてチャンネルを右クリック → IDをコピー。Slackでチャンネル詳細 → 下部のチャンネルID。',
  autoSession:'自動セッション',autoSessionHint:'新しいユーザーやルームがボットと会話すると自動的にセッションを作成します。',
  autoSessionBadge:'自動',
  cronPromptHint:'予定時間にエージェントに何をさせたいか書いてください。例: 「今日の主要ニュースをまとめて」',
  phCronName:'毎日ニュースまとめ',phCronPrompt:'エージェントへの指示...',
  cronSkillsHint:'スケジュール実行時にエージェントが使うツールがあれば選択してください。なければ空でOKです。',
  scheduleHint:'毎日繰り返し: 毎日同じ時間に実行。一回限り: 指定した日時に一度だけ実行。',
  cronNotifyHint:'結果をチャンネルで報告してほしければオンにしてください。静かに処理だけしたければオフに。',
  newSkillIntro:'エージェントに新しい能力を与えましょう。スクリプトでツールにしたり、テキストだけで指示を出せます。',
  skillNameHint:'このスキルを識別する名前を付けてください。',phSkillName:'例: YouTube要約',
  skillTypeScriptHint:'ビルトインスキルだけでは難しい作業や時間がかかる作業を自動化できます。スキル作成後、ガイドドキュメントが生成されます。',
  skillTypePromptHint:'スクリプトなしのテキストのみの指示です。エージェントが参考にする行動規則や専門知識を書いてください。',
  toolNameHintDesc:'エージェントがこのツールを呼び出すときの名前です。英小文字とアンダースコアのみ使用。',phToolName:'例: check_inventory',
  skillPromptHint:'エージェントがこのスキルを使う時の指針を書いてください。',phSkillPrompt:'例: ユーザーが要約を求めたら...',
  phApiKey:'APIキー',
  sl_file_read:'ファイル読み取り',sl_file_write:'ファイル書き込み',sl_file_list:'ファイル一覧',
  sl_web_fetch:'Webページ取得',sl_web_browse:'Webブラウザ',sl_bash:'ターミナルコマンド',
  sl_google_gmail:'Gmail',sl_google_calendar:'Googleカレンダー',sl_google_drive:'Googleドライブ',sl_cron:'自動スケジュール',
  sc_file:'ファイル',sc_web:'ウェブ',sc_system:'システム',sc_google:'Google',sc_automation:'自動化',
  sd_file_read:'ワークスペース内のファイルを読みます。メモや設定ファイルの参照に使います。',
  sd_file_write:'ワークスペースにファイルを作成・変更します。作業結果の保存に使います。',
  sd_file_list:'ワークスペースのファイル/フォルダ一覧を表示します。',
  sd_web_fetch:'URLからWebページのテキストを取得します。ニュースやドキュメントの閲覧に使います。',
  sd_web_browse:'Chromiumブラウザウィンドウが開き、クリック、入力、スクロール、スクリーンショットを実行します。スクリーンショットはチャットに自動送信されます。<code>BROWSER_CDP_URL</code>で既存のChromeに接続可能。',
  sd_bash:'サーバーでシェルコマンドを実行します。スクリプト実行やパッケージインストールなどに使います。<b style="color:var(--red)">⚠ デバイス全体にアクセス可能。</b>自分または信頼できる人にのみ使用してください。',
  sd_google_gmail:'Gmailでメールを検索・閲覧・送信します。<b>gog CLI</b>（Google OAuth2）が必要です。',
  sd_google_calendar:'Googleカレンダーの予定を表示・作成します。<b>gog CLI</b>（Google OAuth2）が必要です。',
  sd_google_drive:'Googleドライブでファイルを検索・ダウンロード・アップロードします。<b>gog CLI</b>（Google OAuth2）が必要です。',
  sd_cron:'エージェントが自分で予約タスクを作成・管理します。「毎朝ニュースまとめて」のような依頼に使います。',
  provHintAnthropic:'例: claude-sonnet-4-20250514',provHintOpenai:'例: gpt-4o',
  provHintGroq:'例: llama-3.3-70b-versatile',provHintOpenrouter:'例: anthropic/claude-sonnet-4-20250514',
  provHintOpencode:'例: claude-sonnet-4-20250514',
  modelListLink:'{name}モデル一覧を見る',
  toolsLabel:'ツール',confirmDetachCron:'「{name}」をこのサラダから外しますか？',shutdownFailed:'停止失敗: ',
  confirmOk:'確認',serviceSingular:'サラダ',servicePlural:'サラダ',
  ok:'OK',
},
zh:{
  services:'我的沙拉',skills:'技能',activeServices:'我的沙拉',
  saladDesc:'完成沙拉，和专属代理聊天吧！',
  useCaseLink:'🥕这样试试',
  useCaseTitle:'这样试试',
  useCase1Title:'私人健身教练',
  useCase1Desc:'每天早上发送饮食计划和运动清单，检查你是否完成的专属PT代理。',
  useCase1How:'<div class="uc-step"><b>1. 创建代理</b><br>在系统提示词中输入<i>"你是我的私人健身教练，管理每日饮食和运动计划。"</i>——代理会像健身教练一样工作。</div><div class="uc-step"><b>2. 开启技能</b><br>开启<b>文件</b> — 代理可以保存运动记录并在第二天查看。<br>开启<b>定时</b> — 在固定时间自动发送消息的预约功能。</div><div class="uc-step"><b>3. 选择目标</b><br>选择自己作为目标，你就是接收消息的人。</div><div class="uc-step"><b>4. 制作沙拉并附加定时任务</b><br>制作沙拉后，创建定时块并拖到沙拉上。<br>名称: <i>"每日运动"</i>，时间: <i>07:00</i><br>提示词: <i>"发送今天的饮食和运动清单，从文件中检查昨天是否完成了运动。"</i><br>现在每天早上7点，代理会自动开始你的PT训练！</div>',
  useCase2Title:'为演员朋友找试镜机会',
  useCase2Desc:'为不太懂电脑的演员朋友，每天从论坛收集试镜信息并通过邮件发送的代理。',
  useCase2How:'<div class="uc-step"><b>1. 创建代理</b><br>在系统提示词中输入<i>"你是试镜侦察员，每天寻找演员试镜和选角信息并整理。"</i></div><div class="uc-step"><b>2. 开启技能</b><br>开启<b>网页获取</b> — 代理可以从网上收集试镜信息。<br>同时开启<b>文件</b>和<b>定时</b>。</div><div class="uc-step"><b>3. 创建自定义技能（可选）</b><br>在技能标签中创建<i>"send_email"</i>脚本技能，代理就能通过邮件转发收集到的信息。</div><div class="uc-step"><b>4. 选择目标</b><br>选择朋友的Telegram作为目标，代理会直接给他们发消息。</div><div class="uc-step"><b>5. 制作沙拉并附加定时任务</b><br>名称: <i>"试镜收集"</i>，时间: <i>09:00</i><br>提示词: <i>"从演员论坛搜索最新的选角信息，整理后通过邮件发送。"</i><br>每天早上9点，代理会自动收集试镜信息发送给朋友！</div>',
  useCase3Title:'每日新闻简报',
  useCase3Desc:'每天早上把关注领域的重要新闻总结好发到聊天里的专属新闻策展人。',
  useCase3How:'<div class="uc-step"><b>1. 创建代理</b><br>在系统提示词中输入<i>"你是新闻策展人，每天收集关键头条并以易读格式总结。"</i></div><div class="uc-step"><b>2. 开启技能</b><br>开启<b>网页获取</b> — 代理可以直接从新闻网站获取文章。<br>开启<b>定时</b> — 在固定时间自动接收简报。</div><div class="uc-step"><b>3. 选择目标</b><br>选择自己。如果想让朋友也收到简报，把他们也添加为目标。</div><div class="uc-step"><b>4. 制作沙拉并附加定时任务</b><br>名称: <i>"早间新闻"</i>，时间: <i>08:00</i><br>提示词: <i>"从TechCrunch、Reuters获取今天的5条主要新闻并总结。"</i><br>每天早上8点，代理会把新闻整理好送到你面前！</div>',
  useCase4Title:'老师管理学生',
  useCase4Desc:'帮老师提醒学生交作业、发送测验、追踪提交情况的助教代理。',
  useCase4How:'<div class="uc-step"><b>1. 创建代理</b><br>在系统提示词中输入<i>"你是班主任助手，给学生发作业提醒、出测验题、确认提交情况。"</i></div><div class="uc-step"><b>2. 开启技能</b><br>开启<b>文件</b> — 代理会为每个学生保存进度和提交记录。<br>开启<b>定时</b> — 在固定时间自动发送作业提醒。</div><div class="uc-step"><b>3. 选择目标</b><br>将每个学生分别添加为目标。制作沙拉时把多个目标拖入插槽即可一次创建。</div><div class="uc-step"><b>4. 制作沙拉并附加定时任务</b><br>名称: <i>"作业检查"</i>，时间: <i>16:00</i><br>提示词: <i>"检查今天的作业提交情况，给未提交的学生发送提醒。"</i><br>把定时任务拖到沙拉上，就会对所有学生同时生效。</div><div class="uc-step"><b>✨ 提示</b><br>代理为每个学生使用独立的工作区文件夹，进度和记录不会互相混淆。</div>',
  createServiceDrag:'制作沙拉',createServiceDesc:'将下方块拖拽到插槽',
  agents:'代理',channels:'频道',targets:'目标',crons:'定时',
  add:'+ 添加',agent:'代理',channel:'频道',target:'目标',
  dropHere:'拖放到此',createService:'制作沙拉',clear:'清除',
  name:'名称',provider:'提供商',model:'模型',systemPrompt:'系统提示词',
  create:'创建',botToken:'机器人令牌',addPair:'添加并配对',
  platform:'平台',platformUserId:'平台用户ID',nickname:'昵称',
  prompt:'提示词',schedule:'计划',dailyRepeat:'每日重复',oneTime:'一次性',
  time:'时间 (HH:MM)',dateTime:'日期和时间',sendToChannel:'向频道发送响应',
  noServices:'还没有沙拉。将代理、频道和目标拖到上方插槽来制作吧。',
  noAgents:'暂无代理',noChannels:'暂无频道',noTargets:'暂无目标',noCrons:'暂无定时',
  agentSkillConfig:'代理技能配置',selectAgent:'选择代理:',
  builtinSkills:'内置技能',customSkills:'自定义技能',saveToggles:'保存切换',
  newSkill:'+ 新建技能',googleIntegration:'Google集成 (gog CLI)',
  llmProviderKeys:'LLM提供商密钥',close:'关闭',save:'保存',cancel:'取消',
  del:'删除','delete':'删除',pause:'暂停',resume:'恢复',description:'描述',
  svcDesc:'{agent} 通过 {channel} 为 {target} 服务',
  svcDescMulti:'{agent} 通过 {channel} 为 {targets} 服务',
  agentDesc:'设置代理的提供商和模型。',
  channelDesc:'注册用于聊天的频道（机器人）。',
  targetDesc:'代理和谁聊天？你自己？还是朋友？',
  customSkillCta:'找不到需要的技能？自己创建一个 →',
  skillsLabel:'技能',timeAwareness:'时间感知',
  timeAwarenessDesc:'启用后，用户消息将包含时间戳，代理将感知当前时间。',
  smartStep:'智能步骤',
  smartStepDesc:'启用后，复杂任务可自动分多步执行。',
  maxPlanSteps:'最大步骤数',workspace:'工作空间',openFolder:'打开文件夹',
  status:'状态',bot:'机器人',paired:'已配对',pending:'等待中',
  confirmDelete:'确认删除？',confirmDeleteAgent:'删除此代理及所有相关沙拉？',
  confirmDeleteChannel:'删除此频道及所有相关沙拉？',
  confirmDeleteTarget:'删除此目标及所有相关沙拉？',
  confirmDeleteCron:'删除此定时任务？',
  confirmShutdown1:'确定要关闭服务器吗？\\n\\n所有运行中的沙拉和计划将停止。',
  confirmShutdown2:'最终确认：关闭服务器。',
  serverShutDown:'服务器已关闭。',alreadyAttached:'已经连接',
  missingSkills:'代理缺少所需技能: ',
  skillsToolSelect:'技能（工具选择）',scriptTool:'脚本工具',promptOnly:'仅提示词',
  toolName:'工具名称',toolNameHint:'(英文小写+下划线)',
  skillFolder:'技能文件夹',skillFolderWillCreate:'保存后将创建技能文件夹:',
  nameRequired:'请输入名称',toolNameRequired:'请输入工具名称',
  toolNameFormat:'工具名称只能使用英文小写和下划线',
  nameAndPromptRequired:'请输入名称和提示词',dateTimeRequired:'请输入日期和时间',
  pairingFailed:'配对失败: ',failedCreateChannel:'创建频道失败',typeMismatch:'频道和目标的平台必须一致',
  unknownProvider:'未知提供商',apiKeyNotSet:'API密钥未设置',notPaired:'未配对',
  newCustomSkill:'新建自定义技能',editCustomSkill:'编辑自定义技能',
  deleteCustomSkill:'删除此自定义技能？',
  noCustomSkills:'暂无自定义技能。点击"+ 新建技能"创建。',
  noCustomSkillsTitle:'还没有创建技能。',
  noCustomSkillsCta:'给你的代理赋予新能力？',
  gogDetected:'已检测到gog CLI。Google技能可用。',
  gogNotFound:'未找到gog CLI。安装后可启用Google技能。',
  gogSetupSteps:'设置步骤:',
  gogExplain:'gog是一个通过OAuth2认证访问Google API（Gmail、Calendar、Drive）的命令行工具。Agent Salad的Google技能通过gog CLI连接Google服务。',
  gogGcpGuide:'Google Cloud Console设置:',
  gogGcpStep1:'在console.cloud.google.com中创建项目',
  gogGcpStep2:'启用Gmail API、Calendar API、Drive API',
  gogGcpStep3:'API和服务 → 凭据 → 创建OAuth 2.0客户端ID（桌面） → 下载JSON',
  gogCliGuide:'CLI安装和认证:',
  gogSkillNote:'此技能需要gog CLI。请在技能标签页底部的"Google集成"部分查看安装说明。',
  gogRestartNote:'安装gog CLI后，请重启服务器以使更改生效。',
  clearApiKey:'删除此API密钥？',
  setLabel:'已设置',notSetLabel:'未设置',opening:'正在打开...',opened:'已打开！',
  runScript:'run.sh — 执行脚本',schemaJson:'schema.json — 输入参数定义',
  promptTxt:'prompt.txt — LLM工具指南',guideMd:'GUIDE.md — 实现指南',
  promptHint:'(指导LLM何时/如何使用此工具)',
  agentsTab:'代理',selectAgent:'选择一个代理',allSkills:'技能',
  selectSkill:'从列表中选择一个技能',builtinLabel:'内置',scriptLabel:'脚本',promptLabel:'提示',
  skillType:'类型',skillAvailable:'可用',skillNotAvailable:'不可用',
  builtinSkillNote:'内置技能在代理标签页中按代理进行管理。',
  skillCategory:'类别',noSkills:'暂无技能',
  aboutTitle:'Agent Salad是什么？',
  aboutP1:'将<b>代理</b>（AI大脑）+ <b>频道</b>（消息机器人）+ <b>目标</b>（用户）组合起来，创建专属AI服务的平台。',
  aboutP2:'就像做沙拉一样，选择你喜欢的食材混合在一起。',
  aboutStep1:'创建<b>代理</b>，定义AI的性格和角色',
  aboutStep2:'连接<b>频道</b>的消息机器人',
  aboutStep3:'注册<b>目标</b>——要聊天的对象',
  aboutStep4:'将三者拖拽组合成<b>沙拉</b>！',
  aboutP3:'添加定时任务后，代理会在预定时间自动工作。',
  apiKeySetup:'API密钥设置',serverShutdown:'关闭服务器',
  logoHelp:'Agent Salad是什么？',addAgent:'+ 创建代理',createAgent:'+ 创建代理',
  cronDesc:'创建定时任务并连接到沙拉，会在预定时间执行任务。拖拽定时任务到沙拉上连接。',
  agentNameHint:'给代理起一个名字以便识别。',phAgentName:'例: 英语老师',
  agentDescHint:'记录这个代理是做什么的。',phAgentDesc:'例: 帮助英语会话的代理',
  providerSelectHint:'选择要使用的AI服务。',
  providerApiKeyNotice:'需要所选提供商的API密钥。请先在上方<b>API密钥设置</b>中注册。',
  providerApiKeyLink:'获取{name} API密钥',
  modelInputHint:'模型名称因提供商而异。请输入准确名称。',
  sysPromptHelpTitle:'什么是系统提示词？',
  sysPromptHelpBody:'你对这个代理有什么期望？写下想要的性格、角色和规则。',
  sysPromptHelpExample:'例: "你是一位友善的英语老师。用中文解释并提供英语例句。"',
  phSystemPrompt:'自由描述性格、角色、目标...',
  agentSkillsHint:'选择代理可以使用的工具。文件、网页、终端等。',
  channelNameHint:'给这个频道起一个名字以便识别。',phChannelName:'例: 我的Telegram机器人',
  channelTypeHint:'选择此频道使用的消息平台。',
  botTokenHint:'在Telegram中通过<a href="https://t.me/BotFather" target="_blank">@BotFather</a>创建机器人并粘贴令牌。',
  botTokenHintDiscord:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://discord.com/developers/applications" target="_blank">Discord Developer Portal</a> → <b>New Application</b> → 输入名称 → Create</li>'
    +'<li>左菜单 → <b>Bot</b> → <b>Reset Token</b> → <b>复制</b>令牌</li>'
    +'<li>向下滚动 → <b>Privileged Gateway Intents</b> → 开启 <b>MESSAGE CONTENT INTENT</b> 和 <b>SERVER MEMBERS INTENT</b> → Save</li>'
    +'<li>左菜单 → <b>OAuth2</b> → <b>URL Generator</b></li>'
    +'<li>Scopes: 勾选 <b>bot</b> · Bot Permissions: <b>Send Messages</b>, <b>Read Message History</b>, <b>View Channels</b></li>'
    +'<li>复制生成的URL → 在浏览器打开 → 选择服务器 → Authorize（机器人邀请完成）</li>'
    +'</ol>',
  botTokenHintSlack:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li><a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> → 输入名称、选择工作区 → Create</li>'
    +'<li>左菜单 → <b>OAuth &amp; Permissions</b> → <b>Bot Token Scopes</b> 添加: <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code>, <code>app_mentions:read</code>, <code>users:read</code></li>'
    +'<li>向上滚动 → <b>Install to Workspace</b> → Allow</li>'
    +'<li>复制 <b>Bot User OAuth Token</b>（以 <code>xoxb-</code> 开头）</li>'
    +'<li>左菜单 → <b>Event Subscriptions</b> → Enable Events → 添加机器人事件: <code>message.im</code>, <code>message.channels</code>, <code>app_mention</code> → Save</li>'
    +'</ol>',
  appTokenHint:'<ol style="margin:4px 0 0 16px;padding:0;font-size:.78rem;line-height:1.5">'
    +'<li>左菜单 → <b>Socket Mode</b> → 开启 <b>Enable Socket Mode</b></li>'
    +'<li>弹窗中输入令牌名称（如 "socket"）→ 添加范围 <code>connections:write</code> → <b>Generate</b></li>'
    +'<li>复制令牌（以 <code>xapp-</code> 开头）</li>'
    +'<li><i>或: Basic Information → App-Level Tokens → Generate Token and Scopes</i></li>'
    +'</ol>',
  appToken:'App-Level Token',
  platformSelectHint:'选择消息平台。',
  platformUserIdHint:'在Telegram中向<a href="https://t.me/userinfobot" target="_blank">@userinfobot</a>发消息可查看数字ID。',phPlatformUserId:'例: 123456789',
  platformUserIdHintDiscord:'Discord → 设置 → 高级 → 开启<b>开发者模式</b>。右键用户 → <b>复制用户ID</b>（类似 <code>284102390284</code> 的长数字）。',
  platformUserIdHintSlack:'点击Slack中的用户名 → <b>查看完整资料</b> → <b>⋮</b> → <b>复制成员ID</b>（类似 <code>U04ABCDEF</code>）。',
  nicknameHint:'写一个容易辨认的昵称。',phNickname:'例: 小明',
  targetType:'目标类型',targetTypeHint:'用户 = DM对象，房间 = 频道/线程对象。',
  targetTypeUser:'用户 (DM)',targetTypeRoom:'房间 (频道)',
  roomId:'频道/房间ID',roomIdHint:'在Discord中开启开发者模式后右键频道 → 复制ID。在Slack中频道详情 → 底部的频道ID。',
  autoSession:'自动会话',autoSessionHint:'新用户或房间与机器人交互时自动创建会话。',
  autoSessionBadge:'自动',
  cronPromptHint:'告诉代理在预定时间做什么。例: "总结今天的主要新闻"',
  phCronName:'每日新闻摘要',phCronPrompt:'发给代理的指令...',
  cronSkillsHint:'选择定时活动时代理要用的工具。不需要可留空。',
  scheduleHint:'每日重复: 每天同一时间执行。一次性: 在指定日期时间执行一次。',
  cronNotifyHint:'想接收结果报告就开启。只想静默处理就关闭。',
  newSkillIntro:'给你的代理赋予新能力。编写脚本作为工具，或仅用文本给出指令。',
  skillNameHint:'给这个技能起一个名字以便识别。',phSkillName:'例: YouTube摘要',
  skillTypeScriptHint:'自动化内置技能难以完成或耗时的任务。创建后会生成指南文档。',
  skillTypePromptHint:'无需脚本的纯文本指令。写下代理参考的行为规则或专业知识。',
  toolNameHintDesc:'代理调用此工具时使用的名称。仅限英文小写和下划线。',phToolName:'例: check_inventory',
  skillPromptHint:'写下代理使用此技能时的参考指南。',phSkillPrompt:'例: 当用户要求摘要时...',
  phApiKey:'API密钥',
  sl_file_read:'文件读取',sl_file_write:'文件写入',sl_file_list:'文件列表',
  sl_web_fetch:'网页获取',sl_web_browse:'网页浏览器',sl_bash:'终端命令',
  sl_google_gmail:'Gmail邮件',sl_google_calendar:'Google日历',sl_google_drive:'Google云端硬盘',sl_cron:'定时计划管理',
  sc_file:'文件',sc_web:'网页',sc_system:'系统',sc_google:'Google',sc_automation:'自动化',
  sd_file_read:'读取工作区中的文件。用于参考笔记、配置文件等。',
  sd_file_write:'在工作区中创建或修改文件。用于保存工作结果。',
  sd_file_list:'列出工作区的文件/文件夹。用于查看有哪些文件。',
  sd_web_fetch:'从URL获取网页文本。用于阅读新闻、文档等。',
  sd_web_browse:'打开可见的Chromium浏览器进行点击、输入、滚动和截图。截图会自动发送到聊天。设置<code>BROWSER_CDP_URL</code>可连接您的Chrome。',
  sd_bash:'在服务器上运行Shell命令。用于脚本执行、安装包等。<b style="color:var(--red)">⚠ 可访问整个设备。</b>仅供自己或信任的人使用。',
  sd_google_gmail:'在Gmail中搜索、阅读、发送邮件。需要<b>gog CLI</b>（Google OAuth2）。',
  sd_google_calendar:'查看或创建Google日历事件。需要<b>gog CLI</b>（Google OAuth2）。',
  sd_google_drive:'在Google云端硬盘中搜索、下载、上传文件。需要<b>gog CLI</b>（Google OAuth2）。',
  sd_cron:'代理自主创建和管理定时任务。用于"每天早上整理新闻"之类的请求。',
  provHintAnthropic:'例: claude-sonnet-4-20250514',provHintOpenai:'例: gpt-4o',
  provHintGroq:'例: llama-3.3-70b-versatile',provHintOpenrouter:'例: anthropic/claude-sonnet-4-20250514',
  provHintOpencode:'例: claude-sonnet-4-20250514',
  modelListLink:'查看{name}模型列表',
  toolsLabel:'工具',confirmDetachCron:'从此沙拉中分离"{name}"？',shutdownFailed:'关闭失败: ',
  confirmOk:'确认',serviceSingular:'沙拉',servicePlural:'沙拉',
  ok:'确认',
},
};
let _lang=localStorage.getItem('agent-salad-lang')||(navigator.language.startsWith('ko')?'ko':navigator.language.startsWith('ja')?'ja':navigator.language.startsWith('zh')?'zh':'en');
function t(k){const l=I18N[_lang];if(l&&l[k]!==undefined)return l[k];if(I18N.en[k]!==undefined)return I18N.en[k];return k}
function svcDescHtml(ag,ch,tg){
  const e=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};
  return t('svcDesc')
    .replace('{agent}','<span class="svc-ag">'+e(ag)+'</span>')
    .replace('{channel}','<span class="svc-ch">'+e(ch)+'</span>')
    .replace('{target}','<span class="svc-tg">'+e(tg)+'</span>');
}
function svcDescMultiHtml(ag,ch,tgNames){
  const e=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};
  const tgSpans=tgNames.map(n=>'<span class="svc-tg">'+e(n)+'</span>').join(', ');
  return t('svcDescMulti')
    .replace('{agent}','<span class="svc-ag">'+e(ag)+'</span>')
    .replace('{channel}','<span class="svc-ch">'+e(ch)+'</span>')
    .replace('{targets}',tgSpans);
}
function setLang(l){_lang=l;localStorage.setItem('agent-salad-lang',l);document.documentElement.lang=l;applyLang();load()}
function applyLang(){
  const s=$('langSelect');if(s)s.value=_lang;
  const m={secActive:'activeServices',secSaladDesc:'saladDesc',useCaseLink:'useCaseLink',secCreate:'createServiceDrag',secCreateDesc:'createServiceDesc',
    colAgents:'agents',colChannels:'channels',colTargets:'targets',colCrons:'crons',
    colAgDesc:'agentDesc',colChDesc:'channelDesc',colTgDesc:'targetDesc',
    tabServices:'services',tabAgents:'agentsTab',tabSkills:'skills',
    secGoogle:'googleIntegration',secSkillsAll:'allSkills',
    modalTitle:'llmProviderKeys',saveSvcBtn:'createService',
    slotALabel:'agent',slotCLabel:'channel',slotTLabel:'target',
    btnNewSkillTab:'newSkill',agentDetailEmpty:'selectAgent',
    skillDetailEmpty:'selectSkill',
    btnAddCron:'add',btnAddAgent:'add',btnAddChannel:'add',btnAddTarget:'add',
    btnApiKeys:'apiKeySetup',btnShutdown:'serverShutdown',
    logoHelp:'logoHelp',cronDesc:'cronDesc',
    agentsTabLabel:'agentsTab',btnCreateAgent:'createAgent',
    aboutTitleEl:'aboutTitle',aboutCloseBtn:'close',modalCloseBtn:'close',
    ucTitle:'useCaseTitle',ucCloseBtn:'close'};
  for(const[id,key]of Object.entries(m)){const el=$(id);if(el)el.textContent=t(key)}
  ['aboutP1El','aboutP2El','aboutStep1El','aboutStep2El','aboutStep3El','aboutStep4El','aboutP3El'].forEach(id=>{const el=$(id);if(el)el.innerHTML=t(id.replace('El',''))});
  const ucText={uc1T:'useCase1Title',uc1D:'useCase1Desc',uc2T:'useCase2Title',uc2D:'useCase2Desc',uc3T:'useCase3Title',uc3D:'useCase3Desc',uc4T:'useCase4Title',uc4D:'useCase4Desc'};
  for(const[id,key]of Object.entries(ucText)){const el=$(id);if(el)el.textContent=t(key)}
  const ucHtml={uc1H:'useCase1How',uc2H:'useCase2How',uc3H:'useCase3How',uc4H:'useCase4How'};
  for(const[id,key]of Object.entries(ucHtml)){const el=$(id);if(el)el.innerHTML=t(key)}
  const dh=$('clearSlotsBtn');if(dh)dh.textContent=t('clear');
  ['agent','channel'].forEach(type=>{
    if(!slots[type]){
      const map={agent:'slotA',channel:'slotC'};
      const el=$(map[type]);
      if(el&&el.classList.contains('empty')){
        el.innerHTML='<div class="slot-label">'+t(type)+'</div><div class="slot-val">'+t('dropHere')+'</div>';
      }
    }
  });
  if(slots.targets.length===0){
    const el=$('slotTEmpty');
    if(el){
      el.innerHTML='<div class="slot-label">'+t('target')+'</div><div class="slot-val">'+t('dropHere')+'</div>';
    }
  }
}

/* ── Custom Alert / Confirm Modal ── */
let _alertResolve=null;
function showAlert(msg,icon){
  return new Promise(resolve=>{
    _alertResolve=resolve;
    $('alertModalIcon').textContent=icon||'⚠️';
    $('alertModalMsg').textContent=msg;
    $('alertModalActions').innerHTML='<button class="btn btn-p" onclick="resolveAlertModal(true)">'+t('close')+'</button>';
    $('alertModalBg').classList.add('show');
  });
}
function showConfirm(msg,icon){
  return new Promise(resolve=>{
    _alertResolve=resolve;
    $('alertModalIcon').textContent=icon||'🤔';
    $('alertModalMsg').textContent=msg;
    $('alertModalActions').innerHTML='<button class="btn btn-d" onclick="resolveAlertModal(true)">'+t('confirmOk')+'</button><button class="btn btn-g" onclick="resolveAlertModal(false)">'+t('cancel')+'</button>';
    $('alertModalBg').classList.add('show');
  });
}
function resolveAlertModal(val){$('alertModalBg').classList.remove('show');if(_alertResolve){_alertResolve(val);_alertResolve=null}}
function dismissAlertModal(){resolveAlertModal(false)}

const $=s=>document.getElementById(s);
const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};
const api=async(p,m,b)=>{const o={method:m||'GET',headers:{}};if(b){o.headers['Content-Type']='application/json';o.body=JSON.stringify(b)}return(await fetch(p,o)).json()};

let D={};
let slots={agent:null,channel:null,targets:[]};

/* ---- SCROLL + FLASH ---- */
function scrollToComposer(){
  const el=document.querySelector('.composer');
  if(!el)return;
  el.scrollIntoView({behavior:'smooth',block:'center'});
  el.style.animation='flash .8s ease';
  el.addEventListener('animationend',()=>{el.style.animation=''},{ once:true });
}

/* ---- DRAG & DROP ---- */
let dragData=null;

function onDragStart(e,type,id,name,thumb,meta,platform){
  dragData={type,id,name,thumb:thumb||'',meta:meta||'',platform:platform||''};
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed='all';
  e.dataTransfer.setData('text/plain',id);
  const slotMap={agent:'slotA',channel:'slotC',target:'slotTEmpty'};
  const sid=slotMap[type];
  if(sid){const sl=$(sid);if(sl)sl.classList.add('drop-hint')}
}
function onDragEnd(e){
  e.target.classList.remove('dragging');dragData=null;setTimeout(()=>dragMoved=false,50);
  document.querySelectorAll('.slot.drop-hint').forEach(s=>s.classList.remove('drop-hint'));
}

document.addEventListener('DOMContentLoaded',()=>{
  ['slotA','slotC'].forEach(sid=>{
    const el=$(sid);
    el.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';el.classList.add('over')});
    el.addEventListener('dragleave',()=>el.classList.remove('over'));
    el.addEventListener('drop',e=>{
      e.preventDefault();el.classList.remove('over','drop-hint');
      document.querySelectorAll('.slot.drop-hint').forEach(s=>s.classList.remove('drop-hint'));
      if(!dragData)return;
      const slotType=el.dataset.type;
      if(slotType==='agent'&&dragData.type==='agent'){fillSlot('agent',dragData.id,dragData.name,dragData.thumb,dragData.meta,dragData.platform)}
      else if(slotType==='channel'&&dragData.type==='channel'){fillSlot('channel',dragData.id,dragData.name,dragData.thumb,dragData.meta,dragData.platform)}
    });
  });
  const tCon=$('slotTContainer');
  tCon.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';$('slotTEmpty').classList.add('over')});
  tCon.addEventListener('dragleave',e=>{if(!tCon.contains(e.relatedTarget))$('slotTEmpty').classList.remove('over')});
  tCon.addEventListener('drop',e=>{
    e.preventDefault();$('slotTEmpty').classList.remove('over','drop-hint');
    document.querySelectorAll('.slot.drop-hint').forEach(s=>s.classList.remove('drop-hint'));
    if(!dragData||dragData.type!=='target')return;
    if(slots.channel&&slots.channel.platform&&dragData.platform&&slots.channel.platform!==dragData.platform){
      showAlert(t('typeMismatch'),'⚠️');return;
    }
    addTarget(dragData.id,dragData.name,dragData.thumb,dragData.meta);
  });
});

function fillSlot(type,id,name,thumb,meta,platform){
  slots[type]={id,name,platform:platform||''};
  const map={agent:'slotA',channel:'slotC'};
  const el=$(map[type]);
  el.classList.add('filled');
  el.classList.remove('empty');
  const avatar=thumb||(name||'?').charAt(0).toUpperCase();
  el.innerHTML=
    '<div class="slot-avatar">'+avatar+'</div>'+
    '<div class="slot-body">'+
      '<div class="slot-name">'+esc(name)+'</div>'+
      (meta?'<div class="slot-meta">'+esc(meta)+'</div>':'')+
    '</div>'+
    '<button class="slot-clear" onclick="clearSlot(\\''+type+'\\')">\\u2715</button>';
  if(type==='channel'){
    // 채널 교체 시 플랫폼 불일치 타겟 제거
    if(platform&&slots.targets.length>0){
      slots.targets=slots.targets.filter(function(tg){
        var tgObj=D.targets.find(function(x){return x.id===tg.id});
        return !tgObj||tgObj.platform===platform;
      });
      renderTargetSlot();
    }
    filterTargetsByPlatform();
  }
  checkSaveBtn();
}

function addTarget(id,name,thumb,meta){
  if(slots.targets.find(t=>t.id===id))return;
  slots.targets.push({id,name,thumb,meta});
  renderTargetSlot();
  checkSaveBtn();
}
function removeTarget(id){
  slots.targets=slots.targets.filter(t=>t.id!==id);
  renderTargetSlot();
  checkSaveBtn();
}
function renderTargetSlot(){
  const emptyEl=$('slotTEmpty');
  const listEl=$('slotTList');
  if(slots.targets.length===0){
    emptyEl.style.display='';
    listEl.innerHTML='';
    return;
  }
  emptyEl.style.display='none';
  listEl.innerHTML=slots.targets.map(tg=>{
    const avatar=tg.thumb||(tg.name||'?').charAt(0).toUpperCase();
    return '<div class="slot t-slot filled" style="border:none;border-bottom:1px solid var(--s2);flex-direction:row;justify-content:flex-start;padding:8px 4px">'+
      '<div class="slot-avatar">'+avatar+'</div>'+
      '<div class="slot-body">'+
        '<div class="slot-name">'+esc(tg.name)+'</div>'+
        (tg.meta?'<div class="slot-meta">'+esc(tg.meta)+'</div>':'')+
      '</div>'+
      '<button class="slot-clear" style="opacity:1" onclick="removeTarget(\\''+tg.id+'\\')">\\u2715</button>'+
    '</div>';
  }).join('');
}

function clearSlot(type){
  if(type==='target'){
    slots.targets=[];
    $('slotTEmpty').style.display='';
    $('slotTList').innerHTML='';
    checkSaveBtn();return;
  }
  slots[type]=null;
  var map={agent:'slotA',channel:'slotC'};
  var labelMap={agent:'agent',channel:'channel'};
  var el=$(map[type]);
  el.classList.remove('filled');
  el.classList.add('empty');
  el.innerHTML=
    '<div class="slot-label">'+t(labelMap[type])+'</div>'+
    '<div class="slot-val">'+t('dropHere')+'</div>';
  if(type==='channel'){
    filterTargetsByPlatform();
    // 호환되지 않는 타겟이 이미 추가되어 있으면 제거
    if(slots.targets.length>0){
      slots.targets=[];
      $('slotTEmpty').style.display='';
      $('slotTList').innerHTML='';
    }
  }
  checkSaveBtn();
}

function clearAllSlots(){clearSlot('agent');clearSlot('channel');clearSlot('target')}

function filterTargetsByPlatform(){
  var chPlat=slots.channel&&slots.channel.platform?slots.channel.platform:'';
  document.querySelectorAll('#tgBlocks .blk.tg').forEach(function(el){
    var tPlat=el.getAttribute('data-platform')||'';
    if(chPlat&&tPlat&&chPlat!==tPlat){
      el.style.opacity='0.35';el.style.pointerEvents='none';el.setAttribute('draggable','false');
    }else{
      el.style.opacity='';el.style.pointerEvents='';el.setAttribute('draggable','true');
    }
  });
}

function checkSaveBtn(){$('saveSvcBtn').disabled=!(slots.agent&&slots.channel&&slots.targets.length>0)}

$('saveSvcBtn').onclick=async()=>{
  if(!slots.agent||!slots.channel||!slots.targets.length)return;
  for(const tg of slots.targets){
    const res=await api('/api/services','POST',{agentProfileId:slots.agent.id,channelId:slots.channel.id,targetId:tg.id});
    if(res.error){showAlert(res.error,'❌');return}
  }
  clearAllSlots();load();
};
$('clearSlotsBtn').onclick=clearAllSlots;

/* ---- FORMS & MODALS ---- */
function toggleModal(){$('modal').classList.toggle('show')}

function getProviderDocs(){return{
  anthropic:{url:'https://docs.anthropic.com/en/docs/about-claude/models',keyUrl:'https://console.anthropic.com/settings/keys',name:'Anthropic',hint:t('provHintAnthropic')},
  openai:{url:'https://platform.openai.com/docs/models',keyUrl:'https://platform.openai.com/api-keys',name:'OpenAI',hint:t('provHintOpenai')},
  groq:{url:'https://console.groq.com/docs/models',keyUrl:'https://console.groq.com/keys',name:'Groq',hint:t('provHintGroq')},
  openrouter:{url:'https://openrouter.ai/models',keyUrl:'https://openrouter.ai/settings/keys',name:'OpenRouter',hint:t('provHintOpenrouter')},
  opencode:{url:'https://opencode.ai',keyUrl:'https://opencode.ai/auth',name:'OpenCode',hint:t('provHintOpencode')},
}}
function updateModelGuide(){
  const prov=$('mAgProv')?.value||'anthropic';
  const doc=getProviderDocs()[prov]||{url:'#',keyUrl:'#',name:prov,hint:'model-name'};
  const guide=$('mAgModelGuide');
  if(guide)guide.innerHTML=
    '<a href="'+doc.url+'" target="_blank" style="color:var(--indigo);text-decoration:none;font-weight:600">'+t('modelListLink').replace('{name}',doc.name)+' \\u2197</a>'+
    '<span style="margin-left:8px;color:var(--t3)">'+doc.hint+'</span>';
  const inp=$('mAgModel');
  if(inp)inp.placeholder=doc.hint;
  const keyLink=$('mAgProvKeyLink');
  if(keyLink)keyLink.innerHTML=
    '<a href="'+doc.keyUrl+'" target="_blank" style="color:var(--indigo);text-decoration:none;font-weight:600">'+t('providerApiKeyLink').replace('{name}',doc.name)+' \\u2197</a>';
}
function openAddAgentModal(){
  const provs=D.providers||[];
  const skillToggles=SKILL_IDS.map(k=>{
    const on=['file_read','file_write','file_list','web_fetch'].includes(k);
    return '<div class="skill-toggle"><input type="checkbox" id="mSk_'+k+'"'+(on?' checked':'')+'><label for="mSk_'+k+'">'+skillLabel(k)+(skillDesc(k)?'<div class="sk-desc">'+skillDesc(k)+'</div>':'')+'</label><span class="cat">'+skillCat(k)+'</span></div>';
  }).join('');
  const panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+t('agent')+' '+t('create')+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<div class="d-field"><label>'+t('name')+'</label><div class="field-hint">'+t('agentNameHint')+'</div><input id="mAgName" placeholder="'+t('phAgentName')+'"></div>'+
    '<div class="d-field"><label>'+t('description')+'</label><div class="field-hint">'+t('agentDescHint')+'</div><input id="mAgDesc" placeholder="'+t('phAgentDesc')+'"></div>'+
    '<div class="d-field"><label>'+t('provider')+'</label><div class="field-hint">'+t('providerSelectHint')+'</div><select id="mAgProv" onchange="updateModelGuide()">'+provs.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('')+'</select>'+
    '<div style="margin-top:8px;padding:10px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px;font-size:.82rem;line-height:1.5">'+
    '<span style="color:var(--t2)">\\uD83D\\uDD11 '+t('providerApiKeyNotice')+'</span>'+
    '<div id="mAgProvKeyLink" style="margin-top:6px"></div>'+
    '</div></div>'+
    '<div class="d-field"><label>'+t('model')+'</label><div class="field-hint">'+t('modelInputHint')+'</div><input id="mAgModel" placeholder="claude-sonnet-4-20250514"><div id="mAgModelGuide" class="model-guide"></div></div>'+
    '<div class="d-field"><label>'+t('systemPrompt')+'</label><textarea id="mAgPrompt" rows="5" placeholder="'+t('phSystemPrompt')+'"></textarea>'+
    '<div class="help-box">'+
      '<div class="help-title">\\uD83D\\uDCA1 '+t('sysPromptHelpTitle')+'</div>'+
      '<div class="help-body">'+
        t('sysPromptHelpBody')+'<br><br>'+
        '<span style="color:var(--t3)">'+t('sysPromptHelpExample')+'</span>'+
      '</div>'+
    '</div></div>'+
    '<div class="d-field"><label>'+t('skillsLabel')+'</label><div class="field-hint">'+t('agentSkillsHint')+'</div><div style="display:flex;flex-direction:column">'+skillToggles+'</div>'+
    '<div class="skill-cta" onclick="closeDetail();switchTab(\\'skills\\');newCustomSkillInline()">'+t('customSkillCta')+'</div></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="mAgTimeAware"> '+t('timeAwareness')+'</label><div class="field-hint">'+esc(t('timeAwarenessDesc'))+'</div></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="mAgSmartStep" onchange="toggleSmartStepOptsNew()"> '+t('smartStep')+'</label><div class="field-hint">'+esc(t('smartStepDesc'))+'</div>'+
    '<div id="mAgSmartStepOpts" style="display:none;margin-top:10px;padding:10px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px;align-items:center;gap:10px"><label style="font-size:.78rem;color:var(--t2);white-space:nowrap" for="mAgMaxPlanSteps">'+t('maxPlanSteps')+'</label><input type="number" id="mAgMaxPlanSteps" value="10" min="1" max="30" style="width:64px;padding:6px 10px;font-size:.82rem;text-align:center;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div></div>'+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="submitAddAgent()">'+t('create')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
    '</div>';
  $('detailBg').classList.add('show');
  updateModelGuide();
}
async function submitAddAgent(){
  const name=$('mAgName').value.trim();
  if(!name){showAlert(t('nameRequired'));return}
  const skills={};
  SKILL_IDS.forEach(k=>{skills[k]=$('mSk_'+k).checked});
  await api('/api/agent-profiles','POST',{
    name,description:$('mAgDesc')?.value?.trim()||'',
    providerId:$('mAgProv').value,
    model:$('mAgModel').value.trim()||'claude-sonnet-4-20250514',
    systemPrompt:$('mAgPrompt').value,
    skills,
    timeAware:$('mAgTimeAware').checked,
    smartStep:$('mAgSmartStep').checked,
    maxPlanSteps:parseInt($('mAgMaxPlanSteps')?.value)||10,
  });
  closeDetail();load();
}

function chTypeHintFor(type){
  if(type==='discord')return t('botTokenHintDiscord');
  if(type==='slack')return t('botTokenHintSlack');
  return t('botTokenHint');
}
function updateChTypeFields(){
  var type=$('mChType').value;
  $('mChTokenHint').innerHTML=chTypeHintFor(type);
  var slackRow=$('mChAppTokenRow');
  if(slackRow)slackRow.style.display=type==='slack'?'':'none';
  var ph=type==='discord'?'MTA5...':'123456:ABC-DEF...';
  $('mChToken').placeholder=ph;
}
function openAddChannelModal(){
  var panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+t('channel')+' '+t('create')+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<div class="d-field"><label>'+t('platform')+'</label><div class="field-hint">'+t('channelTypeHint')+'</div>'+
      '<select id="mChType" onchange="updateChTypeFields()"><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option></select></div>'+
    '<div class="d-field"><label>'+t('name')+'</label><div class="field-hint">'+t('channelNameHint')+'</div><input id="mChName" placeholder="'+t('phChannelName')+'"></div>'+
    '<div class="d-field"><label>'+t('botToken')+'</label><div class="field-hint" id="mChTokenHint">'+t('botTokenHint')+'</div><input id="mChToken" placeholder="123456:ABC-DEF..." style="font-family:var(--mono);font-size:.72rem"></div>'+
    '<div class="d-field" id="mChAppTokenRow" style="display:none"><label>'+t('appToken')+'</label><div class="field-hint">'+t('appTokenHint')+'</div><input id="mChAppToken" placeholder="xapp-1-..." style="font-family:var(--mono);font-size:.72rem"></div>'+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="submitAddChannel()">'+t('addPair')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
    '</div>';
  $('detailBg').classList.add('show');
}
async function submitAddChannel(){
  var type=$('mChType').value;
  var name=$('mChName').value.trim();if(!name)return;
  var botToken=$('mChToken').value.trim();if(!botToken)return;
  var config={botToken};
  if(type==='slack'){
    var appToken=$('mChAppToken').value.trim();
    if(!appToken)return;
    config.appToken=appToken;
  }
  var r=await api('/api/channels','POST',{type:type,name:name,config:config});
  if(!r.ok){showAlert(t('failedCreateChannel'),'❌');return}
  var pairBody={channelType:type,botToken:botToken};
  if(type==='slack')pairBody.appToken=config.appToken;
  var pr=await api('/api/channels/'+r.id+'/pair','POST',pairBody);
  if(!pr.success)showAlert(t('pairingFailed')+(pr.error||'Unknown'),'❌');
  closeDetail();load();
}

function tgPlatHintFor(plat){
  if(plat==='discord')return t('platformUserIdHintDiscord');
  if(plat==='slack')return t('platformUserIdHintSlack');
  return t('platformUserIdHint');
}
function updateTgPlatFields(){
  var plat=$('mTgPlat').value;
  var typeEl=$('mTgType');
  var tt=typeEl?typeEl.value:'user';
  if(tt==='room'){
    $('mTgIdHint').innerHTML=t('roomIdHint');
    var lbl=$('mTgIdLabel');if(lbl)lbl.textContent=t('roomId');
  }else{
    $('mTgIdHint').innerHTML=tgPlatHintFor(plat);
    var lbl2=$('mTgIdLabel');if(lbl2)lbl2.textContent=t('platformUserId');
  }
  // Telegram은 room 타입 불가
  if(typeEl){
    var roomOpt=typeEl.querySelector('option[value="room"]');
    if(roomOpt)roomOpt.disabled=(plat==='telegram');
    if(plat==='telegram'&&tt==='room')typeEl.value='user';
  }
}
function openAddTargetModal(){
  var panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+t('target')+' '+t('create')+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<div class="d-field"><label>'+t('platform')+'</label><div class="field-hint">'+t('platformSelectHint')+'</div><select id="mTgPlat" onchange="updateTgPlatFields()"><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option></select></div>'+
    '<div class="d-field"><label>'+t('targetType')+'</label><div class="field-hint">'+t('targetTypeHint')+'</div><select id="mTgType" onchange="updateTgPlatFields()"><option value="user">'+t('targetTypeUser')+'</option><option value="room">'+t('targetTypeRoom')+'</option></select></div>'+
    '<div class="d-field"><label id="mTgIdLabel">'+t('platformUserId')+'</label><div class="field-hint" id="mTgIdHint">'+t('platformUserIdHint')+'</div><input id="mTgId" placeholder="'+t('phPlatformUserId')+'"></div>'+
    '<div class="d-field"><label>'+t('nickname')+'</label><div class="field-hint">'+t('nicknameHint')+'</div><input id="mTgNick" placeholder="'+t('phNickname')+'"></div>'+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="submitAddTarget()">'+t('create')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
    '</div>';
  $('detailBg').classList.add('show');
}
async function submitAddTarget(){
  const tid=$('mTgId').value.trim(),nick=$('mTgNick').value.trim(),plat=$('mTgPlat').value,tt=$('mTgType').value;
  if(!tid||!nick)return;
  const res=await api('/api/targets','POST',{targetId:tid,nickname:nick,platform:plat,targetType:tt});
  if(res&&res.error){showAlert(res.error);return}
  closeDetail();load();
}

function openAddCronModal(){
  const panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+t('crons')+' '+t('create')+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<div class="d-field"><label>'+t('name')+'</label><input id="mCrName" placeholder="'+t('phCronName')+'"></div>'+
    '<div class="d-field"><label>'+t('prompt')+'</label><div class="field-hint">'+t('cronPromptHint')+'</div><textarea id="mCrPrompt" rows="3" placeholder="'+t('phCronPrompt')+'"></textarea></div>'+
    '<div class="d-field"><label>'+t('skillsToolSelect')+'</label><div class="field-hint">'+t('cronSkillsHint')+'</div><div id="mCrSkills" style="max-height:120px;overflow-y:auto;padding:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div></div>'+
    '<div class="d-field"><label>'+t('schedule')+'</label><div class="field-hint">'+t('scheduleHint')+'</div><select id="mCrType" onchange="toggleMCrTime()"><option value="daily">'+t('dailyRepeat')+'</option><option value="once">'+t('oneTime')+'</option></select></div>'+
    '<div class="d-field" id="mCrDailyField"><label>'+t('time')+'</label><input id="mCrTime" type="time" value="08:00"></div>'+
    '<div class="d-field" id="mCrOnceField" style="display:none"><label>'+t('dateTime')+'</label><input id="mCrDatetime" type="datetime-local"></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="mCrNotify" checked> '+t('sendToChannel')+'</label><div class="field-hint">'+t('cronNotifyHint')+'</div></div>'+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="submitAddCron()">'+t('create')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
    '</div>';
  renderCronSkillChecks('mCrSkills',[]);
  $('detailBg').classList.add('show');
}
function toggleMCrTime(){
  const type=$('mCrType').value;
  $('mCrDailyField').style.display=type==='daily'?'':'none';
  $('mCrOnceField').style.display=type==='once'?'':'none';
}
async function submitAddCron(){
  const name=$('mCrName').value.trim();
  const prompt=$('mCrPrompt').value.trim();
  if(!name||!prompt){showAlert(t('nameAndPromptRequired'));return}
  const scheduleType=$('mCrType').value;
  let scheduleTime;
  if(scheduleType==='daily'){scheduleTime=$('mCrTime').value||'08:00'}
  else{scheduleTime=$('mCrDatetime').value;if(!scheduleTime){showAlert(t('dateTimeRequired'));return}}
  const skillHint=JSON.stringify(Array.from(document.querySelectorAll('#mCrSkills input:checked')).map(el=>el.value));
  await api('/api/crons','POST',{name,prompt,skillHint,scheduleType,scheduleTime,notify:$('mCrNotify').checked});
  closeDetail();load();
}

/* ---- DETAIL PANEL ---- */
let detailDirty=false;

function closeDetail(){$('detailBg').classList.remove('show');detailDirty=false}
async function openWorkspace(btn,agentId){
  const orig=btn.textContent;btn.textContent=t('opening');btn.disabled=true;
  await api('/api/agent-profiles/'+encodeURIComponent(agentId)+'/workspace/open','POST');
  btn.textContent=t('opened');
  setTimeout(()=>{btn.textContent=orig;btn.disabled=false},1500);
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('detailBg').classList.contains('show'))closeDetail()});

const SKILL_IDS=['file_read','file_write','file_list','web_fetch','web_browse','bash','google_gmail','google_calendar','google_drive','cron'];
function skillLabel(id){return t('sl_'+id)||id}
function skillCat(id){const catMap={file_read:'file',file_write:'file',file_list:'file',web_fetch:'web',web_browse:'web',bash:'system',google_gmail:'google',google_calendar:'google',google_drive:'google',cron:'automation'};return t('sc_'+(catMap[id]||id))||id}
function skillDesc(id){return t('sd_'+id)||''}

function openAgentDetail(id){
  const ag=D.agentProfiles.find(a=>a.id===id);if(!ag)return;
  const provs=D.providers||[];
  const sk=ag.skills||{};
  const skillToggles=SKILL_IDS.map(k=>{
    const checked=sk[k]?' checked':'';
    return '<div class="skill-toggle"><input type="checkbox" id="dSk_'+k+'"'+checked+'><label for="dSk_'+k+'">'+skillLabel(k)+(skillDesc(k)?'<div class="sk-desc">'+skillDesc(k)+'</div>':'')+'</label><span class="cat">'+skillCat(k)+'</span></div>';
  }).join('');
  const timeAwareChecked=ag.time_aware?' checked':'';
  const smartStepChecked=ag.smart_step?' checked':'';
  const panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+esc(ag.name)+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<span class="d-tag ag">'+t('agent')+'</span>'+
    '<div class="d-field"><label>'+t('name')+'</label><input id="dAgName" value="'+esc(ag.name).replace(/"/g,'&quot;')+'"></div>'+
    '<div class="d-field"><label>'+t('description')+'</label><input id="dAgDesc" value="'+esc(ag.description||'').replace(/"/g,'&quot;')+'"></div>'+
    '<div class="d-field"><label>'+t('provider')+'</label><select id="dAgProv">'+provs.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===ag.provider_id?' selected':'')+'>'+esc(p.name)+'</option>').join('')+'</select></div>'+
    '<div class="d-field"><label>'+t('model')+'</label><input id="dAgModel" value="'+esc(ag.model).replace(/"/g,'&quot;')+'"></div>'+
    '<div class="d-field"><label>'+t('systemPrompt')+'</label><textarea id="dAgPrompt" rows="5">'+esc(ag.system_prompt||'')+'</textarea></div>'+
    '<div class="d-field"><label>'+t('skillsLabel')+'</label><div id="dAgSkills" style="display:flex;flex-direction:column">'+skillToggles+'</div></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="dAgTimeAware"'+timeAwareChecked+'> '+t('timeAwareness')+'</label><div class="field-hint">'+esc(t('timeAwarenessDesc'))+'</div></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="dAgSmartStep"'+smartStepChecked+' onchange="toggleSmartStepOpts()"> '+t('smartStep')+'</label><div class="field-hint">'+esc(t('smartStepDesc'))+'</div>'+
    '<div id="dAgSmartStepOpts" style="'+(ag.smart_step?'':'display:none;')+'margin-top:10px;padding:10px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:10px"><label style="font-size:.78rem;color:var(--t2);white-space:nowrap" for="dAgMaxPlanSteps">'+t('maxPlanSteps')+'</label><input type="number" id="dAgMaxPlanSteps" value="'+(ag.max_plan_steps||10)+'" min="1" max="30" style="width:64px;padding:6px 10px;font-size:.82rem;text-align:center;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div></div>'+
    '<div class="d-field"><label>'+t('workspace')+'</label><button class="btn btn-g btn-sm" onclick="openWorkspace(this,\\''+esc(ag.id)+'\\')">'+t('openFolder')+'</button></div>'+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="saveAgentDetail(\\''+ag.id+'\\')">'+t('save')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
      '<button class="btn btn-d" style="margin-left:auto" onclick="delAg(\\''+ag.id+'\\');closeDetail()">'+t('delete')+'</button>'+
    '</div>'+
    '';
  $('detailBg').classList.add('show');
}

function toggleSmartStepOpts(){
  const el=$('dAgSmartStepOpts');
  if(el)el.style.display=$('dAgSmartStep').checked?'flex':'none';
}
function toggleSmartStepOptsNew(){
  const el=$('mAgSmartStepOpts');
  if(el)el.style.display=$('mAgSmartStep').checked?'flex':'none';
}

async function saveAgentDetail(id){
  const skills={};
  SKILL_IDS.forEach(k=>{skills[k]=$('dSk_'+k).checked});
  await api('/api/agent-profiles/'+id,'PUT',{
    name:$('dAgName').value.trim(),
    description:$('dAgDesc').value.trim(),
    providerId:$('dAgProv').value,
    model:$('dAgModel').value.trim(),
    systemPrompt:$('dAgPrompt').value,
    skills,
    timeAware:$('dAgTimeAware').checked,
    smartStep:$('dAgSmartStep').checked,
    maxPlanSteps:parseInt($('dAgMaxPlanSteps')?.value)||10,
  });
  closeDetail();load();
}

function openChannelDetail(id){
  const ch=D.managedChannels.find(c=>c.id===id);if(!ch)return;
  const paired=ch.pairing_status==='paired';
  const showAutoSession=(ch.type==='discord'||ch.type==='slack');
  let configDisplay='';
  try{const cfg=JSON.parse(ch.config_json||'{}');if(cfg.botUsername)configDisplay='@'+cfg.botUsername;else if(cfg.botName)configDisplay=cfg.botName+(cfg.teamName?' ('+cfg.teamName+')':'');else if(cfg.botToken)configDisplay=cfg.botToken.slice(0,8)+'...'}catch{}
  const panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+esc(ch.name)+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<span class="d-tag ch">'+t('channel')+'</span>'+
    '<div class="d-field"><label>'+t('name')+'</label><input id="dChName" value="'+esc(ch.name).replace(/"/g,'&quot;')+'"></div>'+
    '<div class="d-field"><label>'+t('platform')+'</label><div class="d-val">'+esc(ch.type)+'</div></div>'+
    '<div class="d-field"><label>'+t('status')+'</label><div class="d-val"><span class="'+(paired?'paired':'pending')+'">'+(paired?t('paired'):t('pending'))+'</span></div></div>'+
    (configDisplay?'<div class="d-field"><label>'+t('bot')+'</label><div class="d-val">'+esc(configDisplay)+'</div></div>':'')+
    (showAutoSession?'<div class="d-field"><label class="check-label"><input type="checkbox" id="dChAutoSession"'+(ch.auto_session?' checked':'')+'> '+t('autoSession')+'</label><div class="field-hint">'+t('autoSessionHint')+'</div></div>':'')+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="saveChannelDetail(\\''+ch.id+'\\')">'+t('save')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
      '<button class="btn btn-d" style="margin-left:auto" onclick="delCh(\\''+ch.id+'\\');closeDetail()">'+t('delete')+'</button>'+
    '</div>'+
    '';
  $('detailBg').classList.add('show');
}

async function saveChannelDetail(id){
  const autoEl=$('dChAutoSession');
  const autoSession=autoEl?autoEl.checked?1:0:undefined;
  await api('/api/channels/'+id,'PUT',{name:$('dChName').value.trim(),autoSession:autoSession});
  closeDetail();load();
}

function openTargetDetail(id){
  const tg=D.targets.find(t=>t.id===id);if(!tg)return;
  const svcCount=D.services.filter(s=>s.target_id===tg.id).length;
  const tt=tg.target_type||'user';
  const panel=$('detailPanel');
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+esc(tg.nickname)+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<span class="d-tag tg">'+t('target')+'</span>'+
    '<div class="d-field"><label>'+t('platform')+'</label><select id="dTgPlat"><option value="telegram"'+(tg.platform==='telegram'?' selected':'')+'>Telegram</option><option value="discord"'+(tg.platform==='discord'?' selected':'')+'>Discord</option><option value="slack"'+(tg.platform==='slack'?' selected':'')+'>Slack</option></select></div>'+
    '<div class="d-field"><label>'+t('targetType')+'</label><div class="d-val">'+(tt==='room'?t('targetTypeRoom'):t('targetTypeUser'))+'</div></div>'+
    '<div class="d-field"><label>'+t('nickname')+'</label><input id="dTgNick" value="'+esc(tg.nickname).replace(/"/g,'&quot;')+'"></div>'+
    '<div class="d-field"><label>'+(tt==='room'?t('roomId'):t('platformUserId'))+'</label><input id="dTgId" value="'+esc(tg.target_id).replace(/"/g,'&quot;')+'"></div>'+
    (svcCount?'<div class="d-field"><label>Active Services</label><div class="d-val">'+svcCount+' service'+(svcCount>1?'s':'')+'</div></div>':'')+
    '<div class="d-actions">'+
      '<button class="btn btn-p" onclick="saveTargetDetail(\\''+tg.id+'\\')">'+t('save')+'</button>'+
      '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
      (svcCount?'':'<button class="btn btn-d" style="margin-left:auto" onclick="delTg(\\''+tg.id+'\\');closeDetail()">'+t('delete')+'</button>')+
    '</div>'+
    '';
  $('detailBg').classList.add('show');
}

async function saveTargetDetail(id){
  const res=await api('/api/targets/'+id,'PUT',{nickname:$('dTgNick').value.trim(),targetId:$('dTgId').value.trim(),platform:$('dTgPlat').value});
  if(res&&res.error){showAlert(res.error);return}
  closeDetail();load();
}

/* ---- ACTIONS ---- */
async function toggleSvc(id,s){await api('/api/services/'+id+'/status','PUT',{status:s});load()}
async function delSvc(id){if(!await showConfirm(t('confirmDelete'),'🗑️'))return;await api('/api/services/'+id,'DELETE');load()}
async function delAg(id){if(!await showConfirm(t('confirmDeleteAgent'),'🗑️'))return;await api('/api/agent-profiles/'+id,'DELETE');load()}
async function delCh(id){if(!await showConfirm(t('confirmDeleteChannel'),'🗑️'))return;await api('/api/channels/'+id,'DELETE');load()}
async function delTg(id){if(!await showConfirm(t('confirmDeleteTarget'),'🗑️'))return;await api('/api/targets/'+id,'DELETE');load()}
async function savePk(pid){const v=$('pk_'+pid).value.trim();if(!v)return;await api('/api/providers/'+pid,'PUT',{apiKey:v});$('pk_'+pid).value='';load()}
async function clearPk(pid){if(!await showConfirm(t('clearApiKey'),'🔑'))return;await api('/api/providers/'+pid,'PUT',{apiKey:''});load()}

/* ---- RENDER ---- */
async function load(){
  _cachedAllSkills=null;
  D=await api('/api/overview');


  renderServices();
  renderBlocks();
  renderProviders();
  applyLang();
}

function renderServices(){
  const el=$('svcList');
  if(!D.services||D.services.length===0){el.innerHTML='<div class="svc-empty" onclick="scrollToComposer()">'+esc(t('noServices'))+'</div>';return}

  // 같은 agent+channel 조합을 그룹화
  const groupMap={};const groupOrder=[];
  D.services.forEach(s=>{
    const key=s.agent_profile_id+'::'+s.channel_id;
    if(!groupMap[key]){groupMap[key]={services:[],agentId:s.agent_profile_id,channelId:s.channel_id};groupOrder.push(key)}
    groupMap[key].services.push(s);
  });

  el.innerHTML=groupOrder.map(key=>{
    const g=groupMap[key];
    const svcs=g.services;
    const ag=D.agentProfiles.find(a=>a.id===g.agentId);
    const ch=D.managedChannels.find(c=>c.id===g.channelId);
    const warns=[];
    if(ag&&getAgentWarning(ag))warns.push(getAgentWarning(ag));
    if(ch&&getChannelWarning(ch))warns.push(getChannelWarning(ch));
    const agName=ag?.name||'?';
    const chName=ch?.name||'?';

    // 그룹 내 모든 서비스의 크론 합산 (중복 cron_id 제거)
    const allCronIds=new Set();
    const allLinkedCrons=[];
    svcs.forEach(s=>{
      (D.serviceCrons||[]).filter(sc=>sc.service_id===s.id).forEach(sc=>{
        if(!allCronIds.has(sc.cron_id)){allCronIds.add(sc.cron_id);allLinkedCrons.push({...sc,primarySvcId:s.id})}
      });
    });
    const cronCards=allLinkedCrons.map(sc=>{
      const cj=(D.cronJobs||[]).find(c=>c.id===sc.cron_id);
      const schedLabel=cj?(cj.schedule_type==='daily'?'\\u23F0 '+cj.schedule_time:'\\u2B50 '+cj.schedule_time.slice(0,16).replace('T',' ')):'';
      const firstSvcId=svcs[0].id;
      return '<div class="cron-card" onclick="openCronDetail(\\''+sc.cron_id+'\\')">'+
        '<span class="cc-name">'+esc(cj?.name||'?')+'</span>'+
        '<span class="cc-schedule">'+schedLabel+'</span>'+
        '<button class="cc-detach" onclick="event.stopPropagation();detachCronFromGroup(\\''+key.replace(/'/g,"\\\\&#39;")+'\\',\\''+sc.cron_id+'\\')">\\u2715</button>'+
        '</div>';
    }).join('');
    const hasCrons=allLinkedCrons.length>0;

    // 그룹 드롭 타겟: 첫 번째 서비스 ID를 대표로 (onSvcDrop에서 그룹 전체 처리)
    const groupSvcIds=svcs.map(s=>s.id);
    const dropAttr='ondragover="onSvcDragOver(event)" ondragleave="onSvcDragLeave(event)" ondrop="onGroupDrop(event,'+JSON.stringify(groupSvcIds).replace(/"/g,'&quot;')+')"';

    if(svcs.length===1){
      const s=svcs[0];
      const tg=D.targets.find(t=>t.id===s.target_id);
      const tgName=tg?.nickname||'?';
      const allActive=s.status==='active';
      return '<div class="svc-wrap" '+dropAttr+'>'+
        '<div class="svc">'+
        '<div class="svc-icon'+(allActive?' spinning':'')+'">'+(allActive?'🥗':'🍽️')+'</div>'+
        '<div class="svc-body"><div class="svc-title">'+svcDescHtml(agName,chName,tgName)+(warns.length?' <span style="color:var(--red);font-size:.7rem">\\u26A0</span>':'')+'</div></div>'+
        '<div class="svc-status">'+
        (allActive?'<button class="btn btn-g btn-sm svc-toggle" onclick="toggleSvc(\\''+s.id+'\\',\\'paused\\')">'+t('pause')+'</button>':'<button class="btn btn-g btn-sm svc-toggle" onclick="toggleSvc(\\''+s.id+'\\',\\'active\\')">'+t('resume')+'</button>')+
        '<button class="btn-d btn-sm" onclick="delSvc(\\''+s.id+'\\')">'+t('del')+'</button>'+
        '</div></div>'+
        (hasCrons?'<div class="svc-crons"><span class="svc-crons-label">'+t('crons')+'</span>'+cronCards+'</div>':'')+
        '</div>';
    }

    // 멀티타겟 그룹
    const tgNames=svcs.map(s=>{const tg=D.targets.find(t=>t.id===s.target_id);return tg?.nickname||'?'});
    const allActive=svcs.every(s=>s.status==='active');
    const anyActive=svcs.some(s=>s.status==='active');
    const toggleAction=anyActive?'paused':'active';
    const toggleLabel=anyActive?t('pause'):t('resume');

    const targetCards=svcs.map(s=>{
      const tg=D.targets.find(t=>t.id===s.target_id);
      return '<div class="tg-card'+(s.status==='paused'?' paused':'')+'">'+
        '<span class="tg-name">'+esc(tg?.nickname||'?')+'</span>'+
        '<button class="tg-del" onclick="event.stopPropagation();removeFromGroup(\\''+s.id+'\\')">\\u2715</button>'+
        '</div>';
    }).join('');

    return '<div class="svc-wrap" '+dropAttr+'>'+
      '<div class="svc">'+
      '<div class="svc-icon'+(allActive?' spinning':'')+'">'+(allActive?'🥗':'🍽️')+'</div>'+
      '<div class="svc-body">'+
        '<div class="svc-title">'+svcDescMultiHtml(agName,chName,tgNames)+(warns.length?' <span style="color:var(--red);font-size:.7rem">\\u26A0</span>':'')+'</div>'+
      '</div>'+
      '<div class="svc-status">'+
      '<button class="btn btn-g btn-sm svc-toggle" onclick="toggleGroupSvc('+JSON.stringify(groupSvcIds).replace(/"/g,'&quot;')+',\\''+toggleAction+'\\')">'+toggleLabel+'</button>'+
      '</div></div>'+
      '<div class="svc-targets-row"><span class="svc-targets-label">'+t('target')+'</span>'+targetCards+'</div>'+
      (hasCrons?'<div class="svc-crons"><span class="svc-crons-label">'+t('crons')+'</span>'+cronCards+'</div>':'')+
      '</div>';
  }).join('');
}

/* Track drag vs click — short drags shouldn't open detail */
let dragMoved=false;
document.addEventListener('mouseup',()=>{setTimeout(()=>dragMoved=false,100)});

function getAgentWarning(ag){
  const prov=D.providers.find(pr=>pr.id===ag.provider_id);
  if(!prov)return t('unknownProvider');
  if(!prov.api_key)return t('apiKeyNotSet');
  return '';
}
function getChannelWarning(ch){
  if(ch.pairing_status!=='paired')return t('notPaired');
  return '';
}

function renderBlocks(){
  const agentSvcCount={};
  const channelSvcCount={};
  D.services.forEach(s=>{agentSvcCount[s.agent_profile_id]=(agentSvcCount[s.agent_profile_id]||0)+1;channelSvcCount[s.channel_id]=(channelSvcCount[s.channel_id]||0)+1});
  const usedTargets=new Set(D.services.map(s=>s.target_id));

  // Agents — 항상 드래그 가능 (멀티타겟: 같은 에이전트를 여러 서비스에 재사용)
  $('agBlocks').innerHTML=D.agentProfiles.map(p=>{
    const prov=D.providers.find(pr=>pr.id===p.provider_id);
    const svcCount=agentSvcCount[p.id]||0;
    const warn=getAgentWarning(p);
    const avatar = p.thumbnail || (p.name||'A').charAt(0).toUpperCase();
    const meta = (prov?.name||p.provider_id)+' / '+p.model;
    return '<div class="blk ag" draggable="true" '+
      'ondragstart="dragMoved=false;onDragStart(event,\\'agent\\',\\''+p.id+'\\',\\''+esc(p.name).replace(/'/g,"\\\\&#39;")+'\\',\\''+avatar.replace(/'/g,"\\\\&#39;")+'\\',\\''+esc(meta).replace(/'/g,"\\\\&#39;")+'\\');return true" ondragend="onDragEnd(event)" onmousemove="if(event.buttons)dragMoved=true"'+
      ' onclick="if(!dragMoved){event.stopPropagation();openAgentDetail(\\''+p.id+'\\')}" style="cursor:pointer">'+
      '<div class="blk-avatar">'+avatar+'</div>'+
      '<div class="blk-body">'+
      '<div class="blk-name">'+esc(p.name)+(svcCount?' <span class="in-use">\\u00d7'+svcCount+'</span>':'')+'</div>'+
      '<div class="blk-meta">'+esc((prov?.name||p.provider_id)+' / '+p.model)+'</div>'+
      (warn?'<div class="blk-warn">\\u26A0 '+esc(warn)+'</div>':'')+
      '</div>'+
      (svcCount?'':'<button class="blk-del" onclick="event.stopPropagation();delAg(\\''+p.id+'\\')">\\u2715</button>')+
      '</div>'
  }).join('')||'<div style="color:var(--t3);font-size:.82rem;padding:8px">'+esc(t('noAgents'))+'</div>';

  // Channels — 항상 드래그 가능 (멀티타겟: 같은 채널을 여러 서비스에 재사용)
  $('chBlocks').innerHTML=D.managedChannels.map(c=>{
    const paired=c.pairing_status==='paired';
    const svcCount=channelSvcCount[c.id]||0;
    const warn=getChannelWarning(c);
    const avatar = c.thumbnail || (c.name||'C').charAt(0).toUpperCase();
    const meta = c.type+(paired?' PAIRED':' PENDING');
    return '<div class="blk ch" draggable="true" data-platform="'+c.type+'" '+
      'ondragstart="dragMoved=false;onDragStart(event,\\'channel\\',\\''+c.id+'\\',\\''+esc(c.name).replace(/'/g,"\\\\&#39;")+'\\',\\''+avatar.replace(/'/g,"\\\\&#39;")+'\\',\\''+esc(meta).replace(/'/g,"\\\\&#39;")+'\\',\\''+c.type+'\\');return true" ondragend="onDragEnd(event)" onmousemove="if(event.buttons)dragMoved=true"'+
      ' onclick="if(!dragMoved){event.stopPropagation();openChannelDetail(\\''+c.id+'\\')}" style="cursor:pointer">'+
      '<div class="blk-avatar">'+avatar+'</div>'+
      '<div class="blk-body">'+
      '<div class="blk-name">'+esc(c.name)+(svcCount?' <span class="in-use">\\u00d7'+svcCount+'</span>':'')+'</div>'+
      '<div class="blk-meta">'+({telegram:'Telegram',discord:'Discord',slack:'Slack'}[c.type]||c.type)+' <span class="'+(paired?'paired':'pending')+'">'+(paired?'PAIRED':'PENDING')+'</span></div>'+
      (warn?'<div class="blk-warn">\\u26A0 '+esc(warn)+'</div>':'')+
      '</div>'+
      (svcCount?'':'<button class="blk-del" onclick="event.stopPropagation();delCh(\\''+c.id+'\\')">\\u2715</button>')+
      '</div>'
  }).join('')||'<div style="color:var(--t3);font-size:.82rem;padding:8px">'+esc(t('noChannels'))+'</div>';

  // Targets
  var platBadgeColors={telegram:'#0088cc',discord:'#5865F2',slack:'#4A154B'};
  $('tgBlocks').innerHTML=D.targets.map(t=>{
    const svcCount=D.services.filter(s=>s.target_id===t.id).length;
    const platLabel={telegram:'Telegram',discord:'Discord',slack:'Slack'}[t.platform]||t.platform;
    const platColor=platBadgeColors[t.platform]||'var(--t3)';
    const isRoom=t.target_type==='room';
    const avatar = t.thumbnail || (isRoom?'#':(t.nickname||'T').charAt(0).toUpperCase());
    const displayName = isRoom?'#'+t.nickname:t.nickname;
    const platBadge='<span style="font-size:.62rem;font-weight:700;background:'+platColor+';color:#fff;border-radius:3px;padding:1px 4px;margin-right:3px;vertical-align:1px">'+platLabel+'</span>';
    const typeTag = isRoom?'<span style="font-size:.62rem;font-weight:700;background:var(--accent);color:#fff;border-radius:3px;padding:1px 4px;vertical-align:1px">ROOM</span>':'';
    const meta = t.target_id;
    return '<div class="blk tg" draggable="true" data-platform="'+t.platform+'" ondragstart="dragMoved=false;onDragStart(event,\\'target\\',\\''+t.id+'\\',\\''+esc(t.nickname).replace(/'/g,"\\\\&#39;")+'\\',\\''+avatar.replace(/'/g,"\\\\&#39;")+'\\',\\''+esc(platLabel+' '+meta).replace(/'/g,"\\\\&#39;")+'\\',\\''+t.platform+'\\');return true" ondragend="onDragEnd(event)" onmousemove="if(event.buttons)dragMoved=true"'+
      ' onclick="if(!dragMoved){event.stopPropagation();openTargetDetail(\\''+t.id+'\\')}" style="cursor:pointer">'+
      '<div class="blk-avatar">'+avatar+'</div>'+
      '<div class="blk-body">'+
      '<div class="blk-name">'+platBadge+typeTag+esc(displayName)+(svcCount?' <span class="in-use">\u00d7'+svcCount+'</span>':'')+'</div>'+
      '<div class="blk-meta">'+esc(meta)+'</div>'+
      '</div>'+
      (svcCount?'':'<button class="blk-del" onclick="event.stopPropagation();delTg(\\''+t.id+'\\')">\\u2715</button>')+
      '</div>'
  }).join('')||'<div style="color:var(--t3);font-size:.82rem;padding:8px">'+esc(t('noTargets'))+'</div>';

  // Crons
  $('crBlocks').innerHTML=(D.cronJobs||[]).map(cr=>{
    const linkedCount=(D.serviceCrons||[]).filter(sc=>sc.cron_id===cr.id).length;
    const sBadge=cr.schedule_type==='daily'?('\\u23F0 '+cr.schedule_time):('\\u2B50 '+cr.schedule_time.slice(0,16).replace('T',' '));
    const avatar = cr.thumbnail || (cr.name||'C').charAt(0).toUpperCase();
    return '<div class="blk cr" draggable="true" ondragstart="dragMoved=false;onDragStart(event,\\'cron\\',\\''+cr.id+'\\',\\''+esc(cr.name).replace(/'/g,"\\\\&#39;")+'\\');return true" ondragend="onDragEnd(event)" onmousemove="if(event.buttons)dragMoved=true"'+
      ' onclick="if(!dragMoved){event.stopPropagation();openCronDetail(\\''+cr.id+'\\')}" style="cursor:pointer">'+
      '<div class="blk-avatar">'+avatar+'</div>'+
      '<div class="blk-body">'+
      '<div class="blk-name">'+esc(cr.name)+(linkedCount?' <span class="in-use">\\u00d7'+linkedCount+'</span>':'')+'</div>'+
      '<div class="blk-meta">'+sBadge+(cr.notify?' \\uD83D\\uDD14':'')+(function(){try{const h=JSON.parse(cr.skill_hint||'[]');return h.length?' \\uD83D\\uDEE0'+h.length:''}catch{return ''}}())+'</div>'+
      '</div>'+
      '<button class="blk-del" onclick="event.stopPropagation();delCron(\\''+cr.id+'\\')">\\u2715</button>'+
      '</div>'
  }).join('')||'<div class="cron-empty" onclick="openAddCronModal()">'+esc(t('noCrons'))+'</div>';
}

function renderProviders(){
  $('provRows').innerHTML=D.providers.map(p=>{
    const hasKey=!!p.api_key;
    return '<div class="prov-row">'+
      '<div class="prov-name">'+esc(p.name)+'</div>'+
      '<div class="prov-key">'+(hasKey?'\\u2713 '+t('setLabel'):t('notSetLabel'))+'</div>'+
      '<div class="prov-input"><input type="password" id="pk_'+p.id+'" placeholder="API Key"><button class="btn btn-g btn-sm" onclick="savePk(\\''+p.id+'\\')">'+t('save')+'</button>'+
      (hasKey?'<button class="btn btn-d btn-sm" onclick="clearPk(\\''+p.id+'\\')">'+t('clear')+'</button>':'')+
      '</div></div>'
  }).join('');
}

// ── Cron Functions ──
async function delCron(id){if(!await showConfirm(t('confirmDeleteCron'),'🗑️'))return;await api('/api/crons/'+id,'DELETE');load()}

function onSvcDragOver(e){
  if(!dragData||dragData.type!=='cron')return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  const wrap=e.currentTarget.closest?e.currentTarget:e.currentTarget;
  wrap.classList.add('cron-over');
}
function onSvcDragLeave(e){
  if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove('cron-over');
}
async function onSvcDrop(e,svcId){
  e.preventDefault();e.currentTarget.classList.remove('cron-over');
  if(!dragData||dragData.type!=='cron')return;
  await attachCronToServices([svcId]);
}
async function onGroupDrop(e,svcIds){
  e.preventDefault();e.currentTarget.classList.remove('cron-over');
  if(!dragData||dragData.type!=='cron')return;
  await attachCronToServices(svcIds);
}
async function attachCronToServices(svcIds){
  const cronId=dragData.id;
  const cj=(D.cronJobs||[]).find(c=>c.id===cronId);
  if(!cj)return;
  let hints=[];try{hints=JSON.parse(cj.skill_hint||'[]')}catch{}
  if(hints.length&&svcIds.length>0){
    const svc=(D.services||[]).find(s=>s.id===svcIds[0]);
    const ag=svc&&D.agentProfiles.find(a=>a.id===svc.agent_profile_id);
    if(ag){
      const missing=hints.filter(h=>!ag.skills[h]);
      if(missing.length){showAlert(t('missingSkills')+missing.join(', '));return}
    }
  }
  for(const sid of svcIds){
    const already=(D.serviceCrons||[]).find(sc=>sc.service_id===sid&&sc.cron_id===cronId);
    if(!already) await api('/api/services/'+sid+'/crons','POST',{cronId,scheduleType:cj.schedule_type,scheduleTime:cj.schedule_time});
  }
  load();
}
async function toggleGroupSvc(svcIds,status){
  for(const sid of svcIds) await api('/api/services/'+sid+'/status','PUT',{status});
  load();
}
async function removeFromGroup(svcId){
  await api('/api/services/'+svcId,'DELETE');
  load();
}
async function detachCronFromGroup(groupKey,cronId){
  const g=groupKey.split('::');
  const svcs=(D.services||[]).filter(s=>s.agent_profile_id===g[0]&&s.channel_id===g[1]);
  for(const s of svcs) await api('/api/services/'+s.id+'/crons/'+cronId,'DELETE');
  load();
}

async function detachCronFromSvc(svcId,cronId){
  await api('/api/services/'+svcId+'/crons/'+cronId,'DELETE');
  load();
}

function openCronDetail(id){
  const cr=(D.cronJobs||[]).find(c=>c.id===id);
  if(!cr)return;
  const panel=$('detailPanel');
  const isDaily=cr.schedule_type==='daily';
  const notifyChecked=cr.notify?' checked':'';
  let selectedSkills=[];
  try{selectedSkills=JSON.parse(cr.skill_hint||'[]')}catch{}
  panel.innerHTML=
    '<div class="d-hdr"><h3>'+esc(cr.name)+'</h3><button class="d-close" onclick="closeDetail()">\\u2715</button></div>'+
    '<span class="d-tag cr">'+t('crons')+'</span>'+
    '<div class="d-field"><label>'+t('name')+'</label><input id="dCrName" value="'+esc(cr.name)+'"></div>'+
    '<div class="d-field"><label>'+t('prompt')+'</label><div class="field-hint">'+t('cronPromptHint')+'</div><textarea id="dCrPrompt" rows="4">'+esc(cr.prompt)+'</textarea></div>'+
    '<div class="d-field"><label>'+t('skillsToolSelect')+'</label><div class="field-hint">'+t('cronSkillsHint')+'</div><div id="dCrSkills" style="max-height:160px;overflow-y:auto;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div></div>'+
    '<div class="d-field"><label>'+t('schedule')+'</label><div class="field-hint">'+t('scheduleHint')+'</div>'+
    '<select id="dCrType" onchange="toggleDCrTime()"><option value="daily"'+(isDaily?' selected':'')+'>'+t('dailyRepeat')+'</option><option value="once"'+(!isDaily?' selected':'')+'>'+t('oneTime')+'</option></select></div>'+
    '<div class="d-field" id="dCrDailyField"'+(isDaily?'':' style="display:none"')+'><label>'+t('time')+'</label><input id="dCrTime" type="time" value="'+(isDaily?esc(cr.schedule_time):'08:00')+'"></div>'+
    '<div class="d-field" id="dCrOnceField"'+(!isDaily?'':' style="display:none"')+'><label>'+t('dateTime')+'</label><input id="dCrDatetime" type="datetime-local" value="'+(!isDaily?esc(cr.schedule_time.slice(0,16)):'')+'"></div>'+
    '<div class="d-field"><label class="check-label"><input type="checkbox" id="dCrNotify"'+notifyChecked+'> '+t('sendToChannel')+'</label><div class="field-hint">'+t('cronNotifyHint')+'</div></div>'+
    '<div class="d-actions">'+
    '<button class="btn btn-p" onclick="saveCronDetail(\\''+cr.id+'\\')">'+t('save')+'</button>'+
    '<button class="btn btn-g" onclick="closeDetail()">'+t('cancel')+'</button>'+
    '<button class="btn btn-d" onclick="delCron(\\''+cr.id+'\\');closeDetail()">'+t('delete')+'</button>'+
    '</div>'+
    '';
  renderCronSkillChecks('dCrSkills',selectedSkills);
  $('detailBg').classList.add('show');
}

function toggleDCrTime(){
  const t=$('dCrType').value;
  $('dCrDailyField').style.display=t==='daily'?'':'none';
  $('dCrOnceField').style.display=t==='once'?'':'none';
}

let _cachedAllSkills=null;
async function getAllSkillNames(){
  if(_cachedAllSkills)return _cachedAllSkills;
  const [bs,cs]=await Promise.all([api('/api/builtin-skills'),api('/api/custom-skills')]);
  const skills=[];
  for(const s of (bs||[]))skills.push({id:s.id,name:s.name,cat:s.category});
  for(const s of (cs||[]))skills.push({id:s.tool_name||s.id,name:s.name,cat:'custom'});
  _cachedAllSkills=skills;
  return skills;
}

async function renderCronSkillChecks(containerId,selected){
  const skills=await getAllSkillNames();
  const sel=new Set(selected||[]);
  $(containerId).innerHTML=skills.map(s=>{
    const checked=sel.has(s.id)||sel.has(s.name)?' checked':'';
    const label=skillLabel(s.id)||s.name;
    const cat=skillCat(s.id)||s.cat;
    const desc=skillDesc(s.id)||'';
    return '<div class="skill-toggle"><input type="checkbox" value="'+esc(s.name)+'"'+checked+'><label>'+esc(label)+(desc?'<div class="sk-desc">'+desc+'</div>':'')+'</label><span class="cat">'+esc(cat)+'</span></div>';
  }).join('')||'<span style="font-size:.68rem;color:var(--t3)">'+t('noSkills')+'</span>';
}



async function saveCronDetail(id){
  const name=$('dCrName').value.trim();
  const prompt=$('dCrPrompt').value.trim();
  const type=$('dCrType').value;
  let time;
  if(type==='daily'){time=$('dCrTime').value||'08:00';}
  else{time=$('dCrDatetime').value;if(!time){showAlert(t('dateTimeRequired'));return}}
  const notify=$('dCrNotify').checked?1:0;
  const skill_hint=JSON.stringify(Array.from(document.querySelectorAll('#dCrSkills input:checked')).map(el=>el.value));
  await api('/api/crons/'+id,'PUT',{name,prompt,skill_hint,schedule_type:type,schedule_time:time,notify});
  closeDetail();load();
}

// ── Tab Navigation ──
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'agents') loadAgentsTab();
  if (tab === 'skills') loadSkillsTab();
}

// ── Agents Tab (split layout: list + detail) ──
let builtinSkills = [];
let customSkillPool = [];
let selectedAgentSkills = null;
let _selectedAgentId = null;

async function loadAgentsTab() {
  const [bs, cs] = await Promise.all([api('/api/builtin-skills'), api('/api/custom-skills')]);
  builtinSkills = bs || [];
  customSkillPool = cs || [];
  renderAgentList();
  if (_selectedAgentId) renderAgentDetailPanel(_selectedAgentId);
}

function renderAgentList() {
  const el = $('agentsListItems');
  if (!el) return;
  if (!D.agentProfiles || D.agentProfiles.length === 0) {
    el.innerHTML = '<div class="agents-empty">' + esc(t('noAgents')) + '</div>';
    return;
  }
  el.innerHTML = D.agentProfiles.map(ag => {
    const prov = D.providers.find(p => p.id === ag.provider_id);
    const sel = ag.id === _selectedAgentId ? ' selected' : '';
    return '<div class="ag-card' + sel + '" onclick="selectAgentTab(\\'' + ag.id + '\\')">' +
      '<div class="ag-card-name">' + esc(ag.name) + '</div>' +
      '<div class="ag-card-meta">' + esc((prov?.name || ag.provider_id) + ' / ' + ag.model) + '</div>' +
      '</div>';
  }).join('');
}

function selectAgentTab(id) {
  _selectedAgentId = id;
  document.querySelectorAll('.ag-card').forEach(c => c.classList.remove('selected'));
  const cards = document.querySelectorAll('.ag-card');
  const idx = D.agentProfiles.findIndex(a => a.id === id);
  if (idx >= 0 && cards[idx]) cards[idx].classList.add('selected');
  renderAgentDetailPanel(id);
}

async function renderAgentDetailPanel(id) {
  const ag = D.agentProfiles.find(a => a.id === id);
  if (!ag) { $('agentsDetail').innerHTML = '<div class="agent-detail-empty">' + esc(t('selectAgent')) + '</div>'; return; }
  const provs = D.providers || [];
  const sk = ag.skills || {};
  selectedAgentSkills = { ...sk };

  const skillToggles = SKILL_IDS.map(k => {
    const checked = sk[k] ? ' checked' : '';
    return '<div class="skill-toggle"><input type="checkbox" id="atSk_' + k + '"' + checked + ' onchange="selectedAgentSkills[\\'' + k + '\\']=this.checked"><label for="atSk_' + k + '">' + skillLabel(k) + (skillDesc(k) ? '<div class="sk-desc">' + skillDesc(k) + '</div>' : '') + '</label><span class="cat">' + skillCat(k) + '</span></div>';
  }).join('');

  const timeAwareChecked = ag.time_aware ? ' checked' : '';
  const smartStepChecked = ag.smart_step ? ' checked' : '';

  // Custom skills for this agent
  const agentCS = await api('/api/agent-profiles/' + encodeURIComponent(id) + '/custom-skills');
  const assignedIds = new Set((agentCS || []).map(s => s.id));
  const csToggles = customSkillPool.map(cs => {
    const enabled = assignedIds.has(cs.id) ? (agentCS || []).find(s => s.id === cs.id)?.enabled : false;
    const isScript = cs.tool_name && cs.tool_name.trim();
    const badge = isScript
      ? '<span style="font-size:.58rem;background:var(--cyan-s);color:var(--cyan);padding:1px 5px;border-radius:3px;font-weight:600">SCRIPT</span>'
      : '<span style="font-size:.58rem;background:var(--s2);color:var(--t3);padding:1px 5px;border-radius:3px;font-weight:600">PROMPT</span>';
    return '<div class="skill-toggle"><input type="checkbox"' + (enabled ? ' checked' : '') + ' onchange="toggleAgentCustomSkill(\\'' + id + '\\',\\'' + cs.id + '\\',this.checked)">' + badge + '<label>' + esc(cs.name) + '</label></div>';
  }).join('') || '<div style="color:var(--t3);font-size:.75rem;padding:4px 0">' + esc(t('noCustomSkills')) + '</div>';

  const panel = $('agentsDetail');
  panel.innerHTML =
    '<div class="d-field"><label>' + t('name') + '</label><input id="atAgName" value="' + esc(ag.name).replace(/"/g, '&quot;') + '"></div>' +
    '<div class="d-field"><label>' + t('description') + '</label><input id="atAgDesc" value="' + esc(ag.description || '').replace(/"/g, '&quot;') + '"></div>' +
    '<div class="d-field"><label>' + t('provider') + '</label><select id="atAgProv">' + provs.map(p => '<option value="' + esc(p.id) + '"' + (p.id === ag.provider_id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>' +
    '<div class="d-field"><label>' + t('model') + '</label><input id="atAgModel" value="' + esc(ag.model).replace(/"/g, '&quot;') + '"></div>' +
    '<div class="d-field"><label>' + t('systemPrompt') + '</label><textarea id="atAgPrompt" rows="6" style="resize:vertical;min-height:100px">' + esc(ag.system_prompt || '') + '</textarea></div>' +

    '<div class="agent-section"><h4>' + t('builtinSkills') + '</h4><div style="display:flex;flex-direction:column">' + skillToggles + '</div></div>' +
    '<div class="agent-section"><h4>' + t('customSkills') + '</h4>' + csToggles + '</div>' +

    '<div class="agent-section"><h4>' + t('timeAwareness') + '</h4>' +
    '<label class="check-label"><input type="checkbox" id="atAgTimeAware"' + timeAwareChecked + '> ' + t('timeAwareness') + '</label>' +
    '<div class="field-hint">' + esc(t('timeAwarenessDesc')) + '</div></div>' +

    '<div class="agent-section"><h4>' + t('smartStep') + '</h4>' +
    '<label class="check-label"><input type="checkbox" id="atAgSmartStep"' + smartStepChecked + ' onchange="toggleSmartStepOptsAT()"> ' + t('smartStep') + '</label>' +
    '<div class="field-hint">' + esc(t('smartStepDesc')) + '</div>' +
    '<div id="atSmartStepOpts" style="' + (ag.smart_step ? '' : 'display:none;') + 'margin-top:10px;padding:10px 14px;background:var(--s1);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:10px"><label style="font-size:.78rem;color:var(--t2);white-space:nowrap" for="atAgMaxPlanSteps">' + t('maxPlanSteps') + '</label><input type="number" id="atAgMaxPlanSteps" value="' + (ag.max_plan_steps || 10) + '" min="1" max="30" style="width:64px;padding:6px 10px;font-size:.82rem;text-align:center;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div></div>' +

    '<div class="agent-section"><h4>' + t('workspace') + '</h4><button class="btn btn-g btn-sm" onclick="openWorkspace(this,\\'' + esc(ag.id) + '\\')">' + t('openFolder') + '</button></div>' +

    '<div class="d-actions">' +
    '<button class="btn btn-p" onclick="saveAgentFromTab(\\'' + ag.id + '\\')">' + t('save') + '</button>' +
    '<button class="btn btn-d" style="margin-left:auto" onclick="deleteAgentFromTab(\\'' + ag.id + '\\')">' + t('delete') + '</button>' +
    '</div>' +
    '';
}

function toggleSmartStepOptsAT() {
  const el = $('atSmartStepOpts');
  if (el) el.style.display = $('atAgSmartStep').checked ? 'flex' : 'none';
}

async function saveAgentFromTab(id) {
  const skills = {};
  SKILL_IDS.forEach(k => { skills[k] = $('atSk_' + k)?.checked || false });
  await api('/api/agent-profiles/' + id, 'PUT', {
    name: $('atAgName').value.trim(),
    description: $('atAgDesc').value.trim(),
    providerId: $('atAgProv').value,
    model: $('atAgModel').value.trim(),
    systemPrompt: $('atAgPrompt').value,
    skills,
    timeAware: $('atAgTimeAware').checked,
    smartStep: $('atAgSmartStep').checked,
    maxPlanSteps: parseInt($('atAgMaxPlanSteps')?.value) || 10,
  });
  await load();
  renderAgentList();
  renderAgentDetailPanel(id);
}

async function deleteAgentFromTab(id) {
  if (!await showConfirm(t('confirmDeleteAgent'),'🗑️')) return;
  await api('/api/agent-profiles/' + id, 'DELETE');
  _selectedAgentId = null;
  await load();
  renderAgentList();
  $('agentsDetail').innerHTML = '<div class="agent-detail-empty">' + esc(t('selectAgent')) + '</div>';
}

async function toggleAgentCustomSkill(agentId, skillId, enabled) {
  await api('/api/agent-profiles/' + encodeURIComponent(agentId) + '/custom-skills/' + encodeURIComponent(skillId), 'PUT', { enabled });
}

// ── Skills Tab (split layout: list + detail) ──

let _selectedSkillId = null;
let _selectedSkillType = null; // 'builtin' | 'custom'

async function loadSkillsTab() {
  const [bs, cs, gog] = await Promise.all([
    api('/api/builtin-skills'),
    api('/api/custom-skills'),
    api('/api/integrations/google/status'),
  ]);
  builtinSkills = bs || [];
  customSkillPool = cs || [];
  renderSkillList();
  if (_selectedSkillId) renderSkillDetailPanel(_selectedSkillId, _selectedSkillType);
  renderGogStatus(gog);
}

function renderSkillList() {
  const el = $('skillsListItems');
  let html = '';

  // Custom skills first
  html += '<div style="font-size:.7rem;font-weight:700;color:var(--t3);padding:8px 4px 4px;text-transform:uppercase;letter-spacing:.04em">'+t('customSkills')+'</div>';
  if (customSkillPool.length) {
    customSkillPool.forEach(cs => {
      const sel = (_selectedSkillType === 'custom' && _selectedSkillId === cs.id) ? ' selected' : '';
      const isScript = cs.tool_name && cs.tool_name.trim();
      const badgeClass = isScript ? 'sk-badge-script' : 'sk-badge-prompt';
      const badgeText = isScript ? t('scriptLabel') : t('promptLabel');
      html += '<div class="sk-card' + sel + '" onclick="selectSkill(\\'' + cs.id + '\\',\\'custom\\')">' +
        '<div class="sk-name">' + esc(cs.name) + '</div>' +
        '<div class="sk-meta"><span class="sk-badge ' + badgeClass + '">' + badgeText + '</span> ' + (isScript ? esc(cs.tool_name) : '') + '</div>' +
        '</div>';
    });
  } else {
    html += '<div onclick="newCustomSkillInline()" style="cursor:pointer;text-align:center;padding:28px 16px;color:var(--t3);font-size:.82rem;border:2px dashed var(--border);border-radius:var(--r);margin-bottom:4px;transition:all .15s ease"' +
      ' onmouseenter="this.style.borderColor=\\'var(--green)\\';this.style.color=\\'var(--t1)\\';this.style.background=\\'var(--s1)\\'"' +
      ' onmouseleave="this.style.borderColor=\\'var(--border)\\';this.style.color=\\'var(--t3)\\';this.style.background=\\'\\'">' +
      esc(t('noCustomSkillsTitle')) + '<br><span style="font-size:.74rem;opacity:.7">' + esc(t('noCustomSkillsCta')) + '</span></div>';
  }

  // Builtin skills at bottom
  if (builtinSkills.length) {
    html += '<div style="font-size:.7rem;font-weight:700;color:var(--t3);padding:12px 4px 4px;text-transform:uppercase;letter-spacing:.04em;border-top:1px solid var(--border);margin-top:8px">'+t('builtinSkills')+'</div>';
    builtinSkills.forEach(s => {
      const sel = (_selectedSkillType === 'builtin' && _selectedSkillId === s.name) ? ' selected' : '';
      const statusDot = s.available
        ? '<span style="color:var(--green);font-size:.6rem">\\u25CF</span>'
        : '<span style="color:var(--t3);font-size:.6rem">\\u25CB</span>';
      const label = skillLabel(s.id) || s.name;
      const cat = skillCat(s.id) || s.category;
      html += '<div class="sk-card' + sel + '" onclick="selectSkill(\\'' + esc(s.name).replace(/'/g, "\\\\'") + '\\',\\'builtin\\')">' +
        '<div class="sk-name">' + statusDot + ' ' + esc(label) + '</div>' +
        '<div class="sk-meta"><span class="sk-badge sk-badge-builtin">' + t('builtinLabel') + '</span> ' + esc(cat) + '</div>' +
        '</div>';
    });
  }

  el.innerHTML = html || '<div style="color:var(--t3);font-size:.82rem;padding:16px;text-align:center">' + esc(t('noSkills')) + '</div>';
}

function selectSkill(id, type) {
  _selectedSkillId = id;
  _selectedSkillType = type;
  document.querySelectorAll('#skillsListItems .sk-card').forEach(c => c.classList.remove('selected'));
  const allCards = document.querySelectorAll('#skillsListItems .sk-card');
  let idx = -1;
  if (type === 'custom') {
    idx = customSkillPool.findIndex(s => s.id === id);
  } else {
    idx = customSkillPool.length + builtinSkills.findIndex(s => s.name === id);
  }
  if (idx >= 0 && allCards[idx]) allCards[idx].classList.add('selected');
  renderSkillDetailPanel(id, type);
}

async function renderSkillDetailPanel(id, type) {
  const panel = $('skillsDetail');
  if (type === 'builtin') {
    const s = builtinSkills.find(b => b.name === id);
    if (!s) { panel.innerHTML = '<div class="skill-detail-empty">' + esc(t('selectSkill')) + '</div>'; return; }
    const label = skillLabel(s.id) || s.name;
    const cat = skillCat(s.id) || s.category;
    const desc = skillDesc(s.id) || '';
    const isGoogle = s.id && s.id.startsWith('google_');
    const gogBox = isGoogle ? (
      '<div style="margin-top:14px;padding:14px;background:var(--s2);border:1px solid var(--border);border-radius:8px">' +
        '<div style="font-size:.82rem;font-weight:600;color:var(--t1);margin-bottom:8px">gog CLI</div>' +
        '<div style="font-size:.76rem;color:var(--t2);line-height:1.6;margin-bottom:10px">' + esc(t('gogExplain')) + '</div>' +
        '<div style="font-size:.72rem;color:var(--t3);line-height:1.7">' +
          '<b>' + esc(t('gogSkillNote')) + '</b>' +
        '</div>' +
      '</div>'
    ) : '';
    panel.innerHTML =
      '<div style="padding:4px 0">' +
      '<h3 style="font-size:1.1rem;margin:0 0 12px">' + esc(label) + ' <span class="sk-badge sk-badge-builtin" style="font-size:.62rem;vertical-align:middle">' + t('builtinLabel') + '</span></h3>' +
      (desc ? '<div class="field-hint" style="margin-bottom:12px">' + desc + '</div>' : '') +
      '<div class="d-field"><label>' + t('skillCategory') + '</label><div style="font-size:.88rem;color:var(--t1);padding:6px 0">' + esc(cat) + '</div></div>' +
      '<div class="d-field"><label>' + t('status') + '</label><div style="font-size:.88rem;padding:6px 0">' +
        (s.available ? '<span style="color:var(--green);font-weight:600">\\u2713 ' + t('skillAvailable') + '</span>' : '<span style="color:var(--t3)">' + t('skillNotAvailable') + '</span>') +
      '</div></div>' +
      (s.tools ? '<div class="d-field"><label>'+t('toolsLabel')+'</label><div style="font-size:.82rem;padding:6px 0;font-family:var(--mono);color:var(--cyan)">' + s.tools.map(x => esc(x)).join(', ') + '</div></div>' : '') +
      gogBox +
      '<div style="margin-top:16px;padding:12px;background:var(--s1);border:1px solid var(--border);border-radius:8px;font-size:.78rem;color:var(--t3)">' +
        t('builtinSkillNote') +
      '</div>' +
      '</div>';
    return;
  }

  // Custom skill detail → inline editor
  const cs = customSkillPool.find(s => s.id === id);
  if (!cs) { panel.innerHTML = '<div class="skill-detail-empty">' + esc(t('selectSkill')) + '</div>'; return; }
  const isScript = cs.tool_name && cs.tool_name.trim();

  let scriptInfoHtml = '';
  if (isScript) {
    try {
      const info = await api('/api/custom-skills/'+encodeURIComponent(cs.id)+'/script-info');
      if (info && info.exists) {
        scriptInfoHtml =
          '<div style="margin:10px 0;padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:8px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
          '<span style="font-size:.68rem;font-weight:600;color:var(--t2)">' + t('skillFolder') + '</span>' +
          '<button class="btn btn-g btn-sm" onclick="openSkillFolderInline(\\'' + cs.id + '\\',this)" style="font-size:.6rem;padding:3px 8px">' + t('openFolder') + '</button>' +
          '</div>' +
          '<div style="font-family:var(--mono);font-size:.68rem;color:var(--cyan);word-break:break-all;margin-bottom:8px">' + esc(info.dir) + '</div>' +
          '<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:.62rem;color:var(--t3);line-height:1.7">' +
            '<span style="font-family:var(--mono);color:var(--t2)">run.sh</span><span>' + t('runScript') + '</span>' +
            '<span style="font-family:var(--mono);color:var(--t2)">schema.json</span><span>' + t('schemaJson') + '</span>' +
            '<span style="font-family:var(--mono);color:var(--t2)">prompt.txt</span><span>' + t('promptTxt') + '</span>' +
            '<span style="font-family:var(--mono);color:var(--t2)">GUIDE.md</span><span>' + t('guideMd') + '</span>' +
          '</div></div>';
      }
    } catch {}
  }

  panel.innerHTML =
    '<div style="padding:4px 0">' +
    '<h3 style="font-size:1.1rem;margin:0 0 16px">' + esc(cs.name) + ' <span class="sk-badge ' + (isScript ? 'sk-badge-script' : 'sk-badge-prompt') + '" style="font-size:.62rem;vertical-align:middle">' + (isScript ? t('scriptLabel') : t('promptLabel')) + '</span></h3>' +
    '<input type="hidden" id="skdId" value="' + esc(cs.id) + '">' +
    '<div class="d-field"><label>' + t('name') + '</label><input id="skdName" value="' + esc(cs.name).replace(/"/g, '&quot;') + '"></div>' +
    '<div class="d-field"><label>' + t('skillType') + '</label>' +
      '<div style="display:flex;gap:6px;margin:4px 0">' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.78rem;padding:6px 12px;border:1px solid var(--border);border-radius:6px;white-space:nowrap">' +
          '<input type="radio" name="skdType" value="script" onchange="toggleSkillTypeInline()"' + (isScript ? ' checked' : '') + '> ' + t('scriptLabel') +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.78rem;padding:6px 12px;border:1px solid var(--border);border-radius:6px;white-space:nowrap">' +
          '<input type="radio" name="skdType" value="prompt" onchange="toggleSkillTypeInline()"' + (!isScript ? ' checked' : '') + '> ' + t('promptLabel') +
        '</label>' +
      '</div>' +
      '<div class="field-hint" id="skdTypeHint">' + (isScript ? t('skillTypeScriptHint') : t('skillTypePromptHint')) + '</div>' +
    '</div>' +
    '<div id="skdScriptFields" style="' + (isScript ? '' : 'display:none') + '">' +
      '<div class="d-field"><label>' + t('toolName') + ' <span style="font-weight:400;color:var(--t3)">' + t('toolNameHint') + '</span></label>' +
        '<input id="skdToolName" value="' + esc(cs.tool_name || '').replace(/"/g, '&quot;') + '" style="font-family:var(--mono);font-size:.72rem" pattern="[a-z_][a-z0-9_]*"></div>' +
      scriptInfoHtml +
    '</div>' +
    '<div id="skdPromptField" style="' + (isScript ? 'display:none' : '') + '">' +
      '<div class="d-field"><label>' + t('prompt') + '</label>' +
        '<textarea id="skdPrompt" rows="4" style="resize:vertical">' + esc(cs.prompt || '') + '</textarea></div>' +
    '</div>' +
    '<div class="d-actions">' +
      '<button class="btn btn-p" onclick="saveSkillInline()">' + t('save') + '</button>' +
      '<button class="btn btn-d" style="margin-left:auto" onclick="delSkillInline(\\'' + cs.id + '\\')">' + t('delete') + '</button>' +
    '</div>' +
    '</div>';
}

function toggleSkillTypeInline() {
  const isScript = document.querySelector('input[name="skdType"]:checked')?.value === 'script';
  const sf = $('skdScriptFields'); if (sf) sf.style.display = isScript ? '' : 'none';
  const pf = $('skdPromptField'); if (pf) pf.style.display = isScript ? 'none' : '';
  const hint = $('skdTypeHint');
  if (hint) hint.innerHTML = isScript
    ? t('skillTypeScriptHint')
    : t('skillTypePromptHint');
}

async function newCustomSkillInline() {
  _selectedSkillId = '__new__';
  _selectedSkillType = 'custom';
  renderSkillList();
  const panel = $('skillsDetail');
  panel.innerHTML =
    '<div style="padding:4px 0">' +
    '<h3 style="font-size:1.1rem;margin:0 0 8px">' + t('newCustomSkill') + '</h3>' +
    '<div class="field-hint" style="margin-bottom:16px">' + t('newSkillIntro') + '</div>' +
    '<input type="hidden" id="skdId" value="">' +
    '<div class="d-field"><label>' + t('name') + '</label><div class="field-hint">' + t('skillNameHint') + '</div><input id="skdName" placeholder="' + t('phSkillName') + '" oninput="updateFolderPreviewInline()"></div>' +
    '<div class="d-field"><label>' + t('skillType') + '</label>' +
      '<div style="display:flex;gap:6px;margin:4px 0">' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.78rem;padding:6px 12px;border:1px solid var(--border);border-radius:6px;white-space:nowrap">' +
          '<input type="radio" name="skdType" value="script" onchange="toggleSkillTypeInline()" checked> ' + t('scriptLabel') +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.78rem;padding:6px 12px;border:1px solid var(--border);border-radius:6px;white-space:nowrap">' +
          '<input type="radio" name="skdType" value="prompt" onchange="toggleSkillTypeInline()"> ' + t('promptLabel') +
        '</label>' +
      '</div>' +
      '<div class="field-hint" id="skdTypeHint">' + t('skillTypeScriptHint') + '</div>' +
    '</div>' +
    '<div id="skdScriptFields">' +
      '<div class="d-field"><label>' + t('toolName') + ' <span style="font-weight:400;color:var(--t3)">' + t('toolNameHint') + '</span></label>' +
        '<div class="field-hint">' + t('toolNameHintDesc') + '</div>' +
        '<input id="skdToolName" placeholder="' + t('phToolName') + '" style="font-family:var(--mono);font-size:.72rem" pattern="[a-z_][a-z0-9_]*"></div>' +
      '<div style="margin:10px 0;padding:14px;background:var(--bg);border:1px dashed var(--border);border-radius:8px;font-size:.7rem;color:var(--t2);line-height:1.6">' +
        t('skillFolderWillCreate') + '<br>' +
        '<span style="font-family:var(--mono);font-size:.66rem;color:var(--cyan)">store/skills/<span id="skdFolderPreview">&lt;name&gt;</span>/</span>' +
      '</div>' +
    '</div>' +
    '<div id="skdPromptField" style="display:none">' +
      '<div class="d-field"><label>' + t('prompt') + '</label>' +
        '<div class="field-hint">' + t('skillPromptHint') + '</div>' +
        '<textarea id="skdPrompt" rows="4" style="resize:vertical" placeholder="' + t('phSkillPrompt') + '"></textarea></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">' +
      '<button class="btn btn-p" onclick="saveSkillInline()">' + t('save') + '</button>' +
      '<button class="btn btn-g btn-sm" onclick="cancelNewSkill()">' + t('cancel') + '</button>' +
    '</div>' +
    '</div>';
}

function updateFolderPreviewInline() {
  const el = $('skdFolderPreview');
  if (!el) return;
  const name = $('skdName')?.value?.trim() || '';
  el.textContent = name ? toFolderSlug(name) : '<name>';
}

function cancelNewSkill() {
  _selectedSkillId = null;
  _selectedSkillType = null;
  renderSkillList();
  $('skillsDetail').innerHTML = '<div class="skill-detail-empty">' + esc(t('selectSkill')) + '</div>';
}

async function saveSkillInline() {
  const name = $('skdName')?.value?.trim();
  if (!name) return showAlert(t('nameRequired'));
  const isScript = document.querySelector('input[name="skdType"]:checked')?.value === 'script';
  const toolName = isScript ? ($('skdToolName')?.value?.trim() || '') : '';
  if (isScript && !toolName) return showAlert(t('toolNameRequired'));
  if (toolName && !/^[a-z_][a-z0-9_]*$/.test(toolName)) return showAlert(t('toolNameFormat'));

  const payload = {
    name,
    description: name,
    prompt: $('skdPrompt')?.value || '',
    script: '',
    tool_name: toolName,
    input_schema: '[]',
    timeout_ms: 30000,
  };

  const editId = $('skdId')?.value;
  let resultId = editId;
  if (editId) {
    await api('/api/custom-skills/'+encodeURIComponent(editId), 'PUT', payload);
  } else {
    const r = await api('/api/custom-skills', 'POST', payload);
    resultId = r.id;
  }

  await loadSkillsTab();
  if (resultId) selectSkill(resultId, 'custom');
}

async function delSkillInline(id) {
  if (!await showConfirm(t('deleteCustomSkill'),'🗑️')) return;
  await api('/api/custom-skills/'+encodeURIComponent(id), 'DELETE');
  _selectedSkillId = null;
  _selectedSkillType = null;
  await loadSkillsTab();
  $('skillsDetail').innerHTML = '<div class="skill-detail-empty">' + esc(t('selectSkill')) + '</div>';
}

async function openSkillFolderInline(id, btn) {
  const orig = btn.textContent;
  btn.textContent = t('opening'); btn.disabled = true;
  await api('/api/custom-skills/'+encodeURIComponent(id)+'/open-folder', 'POST');
  btn.textContent = t('opened');
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

async function saveBuiltinSkills() {
  if (!_selectedAgentId) return;
  await api('/api/agent-profiles/' + encodeURIComponent(_selectedAgentId) + '/skills', 'PUT', selectedAgentSkills);
  await load();
  renderAgentDetailPanel(_selectedAgentId);
}

function toFolderSlug(name) {
  return name.trim()
    .replace(/[\\/\\\\:*"<>|.,;!@#$%^&()=+\\[\\]{}~\`]/g, '')
    .replace(/\\s+/g, '-')
    .replace(/^\\.+/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'unnamed';
}

function renderGogStatus(status) {
  const installed = status?.installed;
  if (installed) {
    $('gogStatus').innerHTML = '<div style="color:var(--green);font-size:.82rem">\\u2713 '+esc(t('gogDetected'))+'</div>';
    return;
  }
  $('gogStatus').innerHTML =
    '<div style="font-size:.82rem">' +
      '<p style="color:var(--t2);margin-bottom:10px">'+esc(t('gogNotFound'))+'</p>' +
      '<div style="background:var(--s2);padding:14px;border-radius:8px;font-size:.74rem;color:var(--t2);line-height:1.7">' +
        '<div style="margin-bottom:10px;line-height:1.5">'+esc(t('gogExplain'))+'</div>' +
        '<div style="margin-bottom:8px;font-weight:600;color:var(--t1)">'+esc(t('gogGcpGuide'))+'</div>' +
        '<div style="padding-left:8px;margin-bottom:12px">' +
          '1. '+esc(t('gogGcpStep1'))+'<br>' +
          '2. '+esc(t('gogGcpStep2'))+'<br>' +
          '3. '+esc(t('gogGcpStep3'))+
        '</div>' +
        '<div style="margin-bottom:8px;font-weight:600;color:var(--t1)">'+esc(t('gogCliGuide'))+'</div>' +
        '<div style="padding-left:8px;margin-bottom:12px">' +
          '1. <code style="background:var(--s1);padding:1px 5px;border-radius:3px">brew install gogcli</code><br>' +
          '2. <code style="background:var(--s1);padding:1px 5px;border-radius:3px">gog auth credentials ~/Downloads/client_secret.json</code><br>' +
          '3. <code style="background:var(--s1);padding:1px 5px;border-radius:3px">gog auth add your@gmail.com</code>' +
        '</div>' +
        '<a href="https://gogcli.sh" target="_blank" style="color:var(--green);font-weight:500">gogcli.sh \\u2197</a>' +
        '<div style="margin-top:12px;padding:10px;background:var(--s1);border-radius:6px;color:var(--t1);font-weight:500">\\u26A0\\uFE0F '+esc(t('gogRestartNote'))+'</div>' +
      '</div>' +
    '</div>';
}

async function confirmShutdown(){
  if(!await showConfirm(t('confirmShutdown1'),'⚠️'))return;
  if(!await showConfirm(t('confirmShutdown2'),'🛑'))return;
  try{await api('/api/shutdown','POST');document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:80vh;color:var(--t2);font-size:1.2rem">'+esc(t('serverShutDown'))+'</div>'}catch(e){showAlert(t('shutdownFailed')+e,'❌')}
}

load();
</script>
</body>
</html>`;
}

export function startWebUiServer(
  host: string,
  port: number,
  context: WebUiContext,
): http.Server {
  const html = buildDashboardHtml();
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/overview') {
        sendJson(res, 200, {
          connectedChannels: context.getConnectedChannels(),
          activeServiceCount: context.getActiveServiceCount(),
          agentProfiles: context.getAgentProfiles(),
          providers: context
            .listLlmProviders()
            .map((p) => ({ ...p, api_key: p.api_key ? '***' : '' })),
          managedChannels: context.listManagedChannels(),
          targets: context.listTargets(),
          services: context.listServices(),
          cronJobs: context.listCronJobs(),
          serviceCrons: context.listServiceCrons(),
        });
        return;
      }
      if (url.pathname === '/api/agent-profiles' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const skills = (body.skills || {}) as Partial<AgentSkillToggles>;
        const id = context.upsertAgentProfile({
          name: typeof body.name === 'string' ? body.name : undefined,
          description:
            typeof body.description === 'string' ? body.description : undefined,
          providerId:
            typeof body.providerId === 'string' ? body.providerId : 'anthropic',
          model:
            typeof body.model === 'string'
              ? body.model
              : 'claude-sonnet-4-20250514',
          systemPrompt:
            typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
          skills: {
            file_read: skills.file_read !== false,
            file_write: skills.file_write !== false,
            file_list: skills.file_list !== false,
            web_fetch: skills.web_fetch !== false,
            web_browse: skills.web_browse === true,
            bash: skills.bash === true,
            google_gmail: skills.google_gmail === true,
            google_calendar: skills.google_calendar === true,
            google_drive: skills.google_drive === true,
            cron: skills.cron === true,
          },
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+$/) &&
        req.method === 'PUT'
      ) {
        const id = decodeURIComponent(
          url.pathname.replace('/api/agent-profiles/', ''),
        );
        const body = await readJsonBody(req);
        const skills = (body.skills || undefined) as
          | AgentSkillToggles
          | undefined;
        context.upsertAgentProfile({
          id,
          name: typeof body.name === 'string' ? body.name : undefined,
          description:
            typeof body.description === 'string' ? body.description : undefined,
          providerId:
            typeof body.providerId === 'string' ? body.providerId : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          systemPrompt:
            typeof body.systemPrompt === 'string'
              ? body.systemPrompt
              : undefined,
          skills: skills || {
            file_read: true,
            file_write: true,
            file_list: true,
            web_fetch: true,
            web_browse: false,
            bash: false,
            google_gmail: false,
            google_calendar: false,
            google_drive: false,
            cron: false,
          },
          timeAware:
            typeof body.timeAware === 'boolean' ? body.timeAware : undefined,
          smartStep:
            typeof body.smartStep === 'boolean' ? body.smartStep : undefined,
          maxPlanSteps:
            typeof body.maxPlanSteps === 'number'
              ? body.maxPlanSteps
              : undefined,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+$/) &&
        req.method === 'DELETE'
      ) {
        context.deleteAgentProfile(
          decodeURIComponent(url.pathname.replace('/api/agent-profiles/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith('/api/providers/') && req.method === 'PUT') {
        const id = decodeURIComponent(
          url.pathname.replace('/api/providers/', ''),
        );
        const body = await readJsonBody(req);
        context.setProviderApiKey(
          id,
          typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/channels' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const type = body.type === 'telegram' ? body.type : null;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!type || !name) throw new Error('type/name required');
        const id = context.createManagedChannel({
          type,
          name,
          config: (body.config as Record<string, string>) || {},
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (
        url.pathname.match(/^\/api\/channels\/[^/]+\/pair$/) &&
        req.method === 'POST'
      ) {
        const channelId = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const channelType =
          typeof body.channelType === 'string' ? body.channelType : 'telegram';
        const botToken =
          typeof body.botToken === 'string' ? body.botToken.trim() : '';

        let result: {
          success: boolean;
          error?: string;
          botUsername?: string;
        };
        if (channelType === 'discord') {
          result = await context.pairDiscordBot(channelId, botToken);
        } else if (channelType === 'slack') {
          const appToken =
            typeof body.appToken === 'string' ? body.appToken.trim() : '';
          result = await context.pairSlackBot(channelId, botToken, appToken);
        } else {
          result = await context.pairTelegramBot(channelId, botToken);
        }
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }
      if (
        url.pathname.match(/^\/api\/channels\/[^/]+$/) &&
        req.method === 'PUT'
      ) {
        const id = decodeURIComponent(
          url.pathname.replace('/api/channels/', ''),
        );
        const body = await readJsonBody(req);
        context.updateManagedChannel(id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          autoSession:
            typeof body.autoSession === 'number'
              ? body.autoSession
              : undefined,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.startsWith('/api/channels/') &&
        !url.pathname.includes('/pair') &&
        req.method === 'DELETE'
      ) {
        context.deleteManagedChannel(
          decodeURIComponent(url.pathname.replace('/api/channels/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/targets' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const targetId =
          typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const nickname =
          typeof body.nickname === 'string' ? body.nickname.trim() : '';
        const validPlatforms: string[] = ['telegram', 'discord', 'slack'];
        const platform = (
          validPlatforms.includes(body.platform as string)
            ? body.platform
            : 'telegram'
        ) as 'telegram' | 'discord' | 'slack';
        const targetType =
          body.targetType === 'room' ? ('room' as const) : ('user' as const);
        if (!targetId || !nickname)
          throw new Error('targetId/nickname required');
        const id = context.createTarget({
          targetId,
          nickname,
          platform,
          targetType,
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (
        url.pathname.match(/^\/api\/targets\/[^/]+$/) &&
        req.method === 'PUT'
      ) {
        const id = decodeURIComponent(
          url.pathname.replace('/api/targets/', ''),
        );
        const body = await readJsonBody(req);
        const validPlats: string[] = ['telegram', 'discord', 'slack'];
        context.updateTarget(id, {
          targetId:
            typeof body.targetId === 'string' ? body.targetId : undefined,
          nickname:
            typeof body.nickname === 'string' ? body.nickname : undefined,
          platform: validPlats.includes(body.platform as string)
            ? (body.platform as 'telegram' | 'discord' | 'slack')
            : undefined,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith('/api/targets/') && req.method === 'DELETE') {
        context.deleteTarget(
          decodeURIComponent(url.pathname.replace('/api/targets/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/services' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const agentProfileId =
          typeof body.agentProfileId === 'string'
            ? body.agentProfileId.trim()
            : '';
        const channelId =
          typeof body.channelId === 'string' ? body.channelId.trim() : '';
        const targetId =
          typeof body.targetId === 'string' ? body.targetId.trim() : '';
        if (!agentProfileId || !channelId || !targetId)
          throw new Error('All three fields required');
        const id = context.createService({
          agentProfileId,
          channelId,
          targetId,
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (
        url.pathname.match(/^\/api\/services\/[^/]+\/status$/) &&
        req.method === 'PUT'
      ) {
        const serviceId = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const status =
          body.status === 'active' || body.status === 'paused'
            ? body.status
            : null;
        if (!status) throw new Error('status must be active or paused');
        context.updateServiceStatus(serviceId, status);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.startsWith('/api/services/') &&
        !url.pathname.includes('/status') &&
        !url.pathname.includes('/crons') &&
        req.method === 'DELETE'
      ) {
        context.deleteService(
          decodeURIComponent(url.pathname.replace('/api/services/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── Skills API ──
      if (url.pathname === '/api/builtin-skills' && req.method === 'GET') {
        sendJson(res, 200, context.listBuiltinSkills());
        return;
      }
      if (url.pathname === '/api/custom-skills' && req.method === 'GET') {
        sendJson(res, 200, context.listCustomSkills());
        return;
      }
      if (url.pathname === '/api/custom-skills' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new Error('name required');
        const id = context.createCustomSkill({
          name,
          description:
            typeof body.description === 'string' ? body.description : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          script: typeof body.script === 'string' ? body.script : '',
          input_schema:
            typeof body.input_schema === 'string' ? body.input_schema : '[]',
          tool_name:
            typeof body.tool_name === 'string' ? body.tool_name.trim() : '',
          timeout_ms:
            typeof body.timeout_ms === 'number' ? body.timeout_ms : 30000,
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (
        url.pathname.match(/^\/api\/custom-skills\/[^/]+$/) &&
        req.method === 'PUT'
      ) {
        const id = decodeURIComponent(
          url.pathname.replace('/api/custom-skills/', ''),
        );
        const body = await readJsonBody(req);
        context.updateCustomSkill(id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          description:
            typeof body.description === 'string' ? body.description : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          script: typeof body.script === 'string' ? body.script : undefined,
          input_schema:
            typeof body.input_schema === 'string'
              ? body.input_schema
              : undefined,
          tool_name:
            typeof body.tool_name === 'string'
              ? body.tool_name.trim()
              : undefined,
          timeout_ms:
            typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.match(/^\/api\/custom-skills\/[^/]+$/) &&
        req.method === 'DELETE'
      ) {
        context.deleteCustomSkill(
          decodeURIComponent(url.pathname.replace('/api/custom-skills/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      // Skill script file info
      if (
        url.pathname.match(/^\/api\/custom-skills\/[^/]+\/script-info$/) &&
        req.method === 'GET'
      ) {
        const skillId = decodeURIComponent(url.pathname.split('/')[3]);
        const exists = context.skillScriptExists(skillId);
        sendJson(res, 200, {
          exists,
          path: context.getSkillScriptPath(skillId),
          dir: context.getSkillScriptDir(skillId),
        });
        return;
      }
      // Open skill script folder
      if (
        url.pathname.match(/^\/api\/custom-skills\/[^/]+\/open-folder$/) &&
        req.method === 'POST'
      ) {
        const skillId = decodeURIComponent(url.pathname.split('/')[3]);
        const dir = context.getSkillScriptDir(skillId);
        const { execSync } = await import('child_process');
        const { existsSync, mkdirSync } = await import('fs');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const platform = process.platform;
        if (platform === 'darwin') execSync(`open "${dir}"`);
        else if (platform === 'win32') execSync(`explorer "${dir}"`);
        else execSync(`xdg-open "${dir}"`);
        sendJson(res, 200, { ok: true, dir });
        return;
      }
      // Per-agent builtin skill toggles
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+\/skills$/) &&
        req.method === 'PUT'
      ) {
        const agentId = decodeURIComponent(url.pathname.split('/')[3]);
        const body = (await readJsonBody(req)) as unknown as AgentSkillToggles;
        context.updateAgentSkills(agentId, body);
        sendJson(res, 200, { ok: true });
        return;
      }
      // Per-agent custom skill assignments
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+\/custom-skills$/) &&
        req.method === 'GET'
      ) {
        const agentId = decodeURIComponent(url.pathname.split('/')[3]);
        sendJson(res, 200, context.getAgentCustomSkills(agentId));
        return;
      }
      if (
        url.pathname.match(
          /^\/api\/agent-profiles\/[^/]+\/custom-skills\/[^/]+$/,
        ) &&
        req.method === 'PUT'
      ) {
        const parts = url.pathname.split('/');
        const agentId = decodeURIComponent(parts[3]);
        const skillId = decodeURIComponent(parts[5]);
        const body = await readJsonBody(req);
        context.setAgentCustomSkill(agentId, skillId, body.enabled !== false);
        sendJson(res, 200, { ok: true });
        return;
      }
      // Workspace
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+\/workspace$/) &&
        req.method === 'GET'
      ) {
        const agentId = decodeURIComponent(url.pathname.split('/')[3]);
        const subdir = url.searchParams.get('path') || undefined;
        const files = context.listWorkspaceFiles(agentId, subdir);
        sendJson(res, 200, { path: context.getWorkspacePath(agentId), files });
        return;
      }
      if (
        url.pathname.match(/^\/api\/agent-profiles\/[^/]+\/workspace\/open$/) &&
        req.method === 'POST'
      ) {
        const agentId = decodeURIComponent(url.pathname.split('/')[3]);
        const wsPath = context.getWorkspacePath(agentId);
        const { execSync } = await import('child_process');
        const { existsSync, mkdirSync } = await import('fs');
        if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });
        const platform = process.platform;
        if (platform === 'darwin') execSync(`open "${wsPath}"`);
        else if (platform === 'win32') execSync(`explorer "${wsPath}"`);
        else execSync(`xdg-open "${wsPath}"`);
        sendJson(res, 200, { ok: true, path: wsPath });
        return;
      }
      // ── Cron API ──
      if (url.pathname === '/api/crons' && req.method === 'GET') {
        sendJson(res, 200, context.listCronJobs());
        return;
      }
      if (url.pathname === '/api/crons' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new Error('name required');
        const scheduleType =
          body.scheduleType === 'once' ? ('once' as const) : ('daily' as const);
        const scheduleTime =
          typeof body.scheduleTime === 'string' ? body.scheduleTime : '08:00';
        const id = context.createCronJob({
          name,
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          skillHint: typeof body.skillHint === 'string' ? body.skillHint : '[]',
          scheduleType,
          scheduleTime,
          notify: body.notify !== false,
        });
        sendJson(res, 200, { ok: true, id });
        return;
      }
      if (url.pathname.match(/^\/api\/crons\/[^/]+$/) && req.method === 'PUT') {
        const id = decodeURIComponent(url.pathname.replace('/api/crons/', ''));
        const body = await readJsonBody(req);
        context.updateCronJob(id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          skill_hint:
            typeof body.skill_hint === 'string' ? body.skill_hint : undefined,
          schedule_type:
            body.schedule_type === 'daily' || body.schedule_type === 'once'
              ? body.schedule_type
              : undefined,
          schedule_time:
            typeof body.schedule_time === 'string'
              ? body.schedule_time
              : undefined,
          notify: typeof body.notify === 'number' ? body.notify : undefined,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.match(/^\/api\/crons\/[^/]+$/) &&
        req.method === 'DELETE'
      ) {
        context.deleteCronJob(
          decodeURIComponent(url.pathname.replace('/api/crons/', '')),
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      // Service-cron attach/detach
      if (
        url.pathname.match(/^\/api\/services\/[^/]+\/crons$/) &&
        req.method === 'POST'
      ) {
        const serviceId = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readJsonBody(req);
        const cronId = typeof body.cronId === 'string' ? body.cronId : '';
        const scheduleType =
          typeof body.scheduleType === 'string' ? body.scheduleType : 'daily';
        const scheduleTime =
          typeof body.scheduleTime === 'string' ? body.scheduleTime : '08:00';
        if (!cronId) throw new Error('cronId required');
        context.attachCronToService(
          serviceId,
          cronId,
          scheduleType,
          scheduleTime,
        );
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        url.pathname.match(/^\/api\/services\/[^/]+\/crons\/[^/]+$/) &&
        req.method === 'DELETE'
      ) {
        const parts = url.pathname.split('/');
        const serviceId = decodeURIComponent(parts[3]);
        const cronId = decodeURIComponent(parts[5]);
        context.detachCronFromService(serviceId, cronId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // Server shutdown
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, message: 'Server shutting down...' });
        logger.info('Shutdown requested via Web UI');
        setTimeout(() => process.exit(0), 500);
        return;
      }

      // Google integration status
      if (
        url.pathname === '/api/integrations/google/status' &&
        req.method === 'GET'
      ) {
        sendJson(res, 200, context.getGogStatus());
        return;
      }

      if (url.pathname.startsWith('/assets/')) {
        const { readFile } = await import('fs/promises');
        const { join } = await import('path');
        const safeName = url.pathname
          .slice('/assets/'.length)
          .replace(/[^a-zA-Z0-9._-]/g, '');
        const ext = safeName.split('.').pop()?.toLowerCase() || '';
        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          svg: 'image/svg+xml',
          gif: 'image/gif',
          webp: 'image/webp',
          ico: 'image/x-icon',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        try {
          const buf = await readFile(join(process.cwd(), 'assets', safeName));
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(buf);
          return;
        } catch {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
        });
        res.end(html);
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ url: req.url, err }, 'Web UI error');
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  server.listen(port, host, () => {
    logger.info({ host, port }, 'Web UI started');
  });
  return server;
}
