/**
 * Agent Salad - Database Layer
 *
 * 단일 SQLite DB (store/messages.db)로 모든 상태 관리.
 * Agent + Channel + Target = Service 모델. Target은 user(DM), room(채널/스레드),
 * everyone(기본 자동 생성 템플릿)로 구분된다.
 * 멀티채널: Telegram/Discord/Slack. managed_channels.type 기반으로 채널을 구분한다.
 * 서비스 크론: cron_jobs + service_crons. schedule_type: once/weekly/interval.
 *   weekly(구 daily 통합): schedule_days + HH:MM. interval: interval_minutes + 시작시각.
 *   기존 daily 크론은 시작 시 weekly(전체요일)로 자동 마이그레이션.
 * 커스텀 스킬: custom_skills + agent_custom_skills로 스크립트 기반 스킬 관리.
 * 스마트 스텝: agent_profiles.smart_step/max_plan_steps + hasNewUserMessages() 인터럽트 감지.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AgentProfile,
  type ChannelType,
  type TargetType,
  EVERYONE_TARGET_NICKNAME,
  getEveryoneTargetId,
  ConversationMessage,
  CronJob,
  CustomSkill,
  AgentCustomSkill,
  LlmProvider,
  ManagedChannel,
  Service,
  ServiceCron,
  TargetProfile,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    -- Agent profiles
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT NOT NULL DEFAULT 'sonnet',
      system_prompt TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Managed channels (Telegram bots)
    CREATE TABLE IF NOT EXISTS managed_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'configured',
      pairing_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Targets (users to serve)
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      folder_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Services: Agent + Channel + Target = active service (유일한 관계 모델)
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      creation_source TEXT NOT NULL DEFAULT 'manual',
      spawned_from_template_service_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id),
      FOREIGN KEY (channel_id) REFERENCES managed_channels(id),
      FOREIGN KEY (target_id) REFERENCES targets(id),
      FOREIGN KEY (spawned_from_template_service_id) REFERENCES services(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_channel_target
      ON services(channel_id, target_id);

    -- Conversations: per-service message history for AI context
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_service
      ON conversations(service_id, timestamp);

    -- Conversation archives: full history backup before compaction
    CREATE TABLE IF NOT EXISTS conversation_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_service
      ON conversation_archives(service_id, created_at);

    -- LLM providers
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      auth_scheme TEXT NOT NULL DEFAULT 'bearer',
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Custom skills: global pool — 스크립트(실행) + 프롬프트(사용법) 묶음
    CREATE TABLE IF NOT EXISTS custom_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      input_schema TEXT NOT NULL DEFAULT '[]',
      tool_name TEXT NOT NULL DEFAULT '',
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Agent ↔ custom skill assignments (per-agent toggle)
    CREATE TABLE IF NOT EXISTS agent_custom_skills (
      agent_profile_id TEXT NOT NULL,
      custom_skill_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_profile_id, custom_skill_id),
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id),
      FOREIGN KEY (custom_skill_id) REFERENCES custom_skills(id)
    );

    -- Cron jobs (서비스 단위 예약 작업)
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      skill_hint TEXT NOT NULL DEFAULT '[]',
      schedule_type TEXT NOT NULL,
      schedule_time TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Service ↔ cron job bindings
    CREATE TABLE IF NOT EXISTS service_crons (
      service_id TEXT NOT NULL,
      cron_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_run TEXT,
      next_run TEXT,
      PRIMARY KEY (service_id, cron_id),
      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (cron_id) REFERENCES cron_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_service_crons_next
      ON service_crons(next_run);
  `);

  // --- Migrations for existing DBs ---
  const safeAlter = (sql: string) => {
    try {
      database.exec(sql);
    } catch {
      /* already exists */
    }
  };

  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN model TEXT NOT NULL DEFAULT 'sonnet'`,
  );
  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'anthropic'`,
  );
  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''`,
  );
  safeAlter(
    `ALTER TABLE managed_channels ADD COLUMN pairing_status TEXT NOT NULL DEFAULT 'pending'`,
  );
  safeAlter(
    `ALTER TABLE targets ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'`,
  );

  // Custom skills: script-based skill system (prompt + script 묶음)
  safeAlter(
    `ALTER TABLE custom_skills ADD COLUMN script TEXT NOT NULL DEFAULT ''`,
  );
  safeAlter(
    `ALTER TABLE custom_skills ADD COLUMN input_schema TEXT NOT NULL DEFAULT '[]'`,
  );
  safeAlter(
    `ALTER TABLE custom_skills ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''`,
  );
  safeAlter(
    `ALTER TABLE custom_skills ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 30000`,
  );

  // Cron jobs: skill_hint (도구 힌트)
  safeAlter(
    `ALTER TABLE cron_jobs ADD COLUMN skill_hint TEXT NOT NULL DEFAULT '[]'`,
  );

  // folder_name: 이름 기반 폴더 명명
  safeAlter(`ALTER TABLE agent_profiles ADD COLUMN folder_name TEXT`);
  safeAlter(`ALTER TABLE custom_skills ADD COLUMN folder_name TEXT`);
  safeAlter(`ALTER TABLE managed_channels ADD COLUMN folder_name TEXT`);
  safeAlter(`ALTER TABLE targets ADD COLUMN folder_name TEXT`);

  // time_aware: 시간 인지 모드 (타임스탬프 포함 + 현재 시간 시스템 프롬프트)
  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN time_aware INTEGER NOT NULL DEFAULT 0`,
  );

  // smart_step: 스마트 스텝 (submit_plan + send_message 도구 활성화)
  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN smart_step INTEGER NOT NULL DEFAULT 0`,
  );
  safeAlter(
    `ALTER TABLE agent_profiles ADD COLUMN max_plan_steps INTEGER NOT NULL DEFAULT 10`,
  );

  // target_type: 'user'(DM 대상) / 'room'(채널/스레드 대상)
  safeAlter(
    `ALTER TABLE targets ADD COLUMN target_type TEXT NOT NULL DEFAULT 'user'`,
  );

  // auto_session: 레거시 필드 유지 (런타임에서는 사용하지 않음)
  safeAlter(
    `ALTER TABLE managed_channels ADD COLUMN auto_session INTEGER NOT NULL DEFAULT 0`,
  );

  // services provenance: 수동 생성 vs everyone 템플릿 자동 생성
  safeAlter(
    `ALTER TABLE services ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'manual'`,
  );
  safeAlter(
    `ALTER TABLE services ADD COLUMN spawned_from_template_service_id TEXT`,
  );

  // thumbnail: 카테고리별 재료 이모지 (랜덤 배정)
  safeAlter(`ALTER TABLE agent_profiles ADD COLUMN thumbnail TEXT`);
  safeAlter(`ALTER TABLE managed_channels ADD COLUMN thumbnail TEXT`);
  safeAlter(`ALTER TABLE targets ADD COLUMN thumbnail TEXT`);
  safeAlter(`ALTER TABLE cron_jobs ADD COLUMN thumbnail TEXT`);

  // targets provenance: 수동 생성 vs everyone 템플릿 자동 생성
  safeAlter(
    `ALTER TABLE targets ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'manual'`,
  );

  // 반복예약 크론: interval_minutes(간격 반복), schedule_days(요일 반복)
  safeAlter(`ALTER TABLE cron_jobs ADD COLUMN interval_minutes INTEGER`);
  safeAlter(`ALTER TABLE cron_jobs ADD COLUMN schedule_days TEXT`);

  // daily → weekly 마이그레이션: 기존 daily 크론을 weekly(전체 요일)로 변환
  database.exec(
    `UPDATE cron_jobs SET schedule_type = 'weekly', schedule_days = '0,1,2,3,4,5,6' WHERE schedule_type = 'daily'`,
  );

  // 기존 레코드에 thumbnail 랜덤 배정
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const TA = ['🥩', '🍗', '🥚', '🧀', '🍤', '🥓', '🐟', '🦐', '🍖', '🥜'];
  const TC = ['🥬', '🥦', '🥒', '🫑', '🌿', '🍃', '🌱', '🪴', '🥝', '🫛'];
  const TT = ['🍅', '🥕', '🌽', '🧅', '🥑', '🫒', '🍋', '🧄', '🫐', '🍊'];
  const TR = ['🌶️', '🧂', '🫚', '🍯', '🫘', '🥫', '🥣', '🍶', '🧈', '🥄'];
  for (const r of database
    .prepare(`SELECT id FROM agent_profiles WHERE thumbnail IS NULL`)
    .all() as { id: string }[])
    database
      .prepare(`UPDATE agent_profiles SET thumbnail=? WHERE id=?`)
      .run(pick(TA), r.id);
  for (const r of database
    .prepare(`SELECT id FROM managed_channels WHERE thumbnail IS NULL`)
    .all() as { id: string }[])
    database
      .prepare(`UPDATE managed_channels SET thumbnail=? WHERE id=?`)
      .run(pick(TC), r.id);
  for (const r of database
    .prepare(`SELECT id FROM targets WHERE thumbnail IS NULL`)
    .all() as { id: string }[])
    database
      .prepare(`UPDATE targets SET thumbnail=? WHERE id=?`)
      .run(pick(TT), r.id);
  for (const r of database
    .prepare(`SELECT id FROM cron_jobs WHERE thumbnail IS NULL`)
    .all() as { id: string }[])
    database
      .prepare(`UPDATE cron_jobs SET thumbnail=? WHERE id=?`)
      .run(pick(TR), r.id);

  // 서비스 유니크 제약 강화: (channel, target) 조합은 1:1이어야 함
  // 같은 채널+타겟에 다른 에이전트를 연결하면 findActiveService(LIMIT 1)가 비결정적
  try {
    db.exec(`DROP INDEX IF EXISTS idx_service_combo`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_channel_target ON services(channel_id, target_id)`,
    );
  } catch {
    /* already exists or fresh DB */
  }
}

/** 레거시 AgentToolToggles → AgentSkillToggles 마이그레이션 포함 */
function normalizeSkillsJson(value: unknown): AgentProfile['skills'] {
  const raw =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};

  // 레거시 포맷 감지 (allowBash 등 존재 시 마이그레이션)
  if ('allowBash' in raw || 'allowFileRead' in raw || 'allowWeb' in raw) {
    return {
      file_read: raw.allowFileRead !== false,
      file_write: raw.allowFileWrite !== false,
      file_list: raw.allowFileRead !== false,
      web_fetch: raw.allowWeb !== false,
      web_browse: false,
      bash: raw.allowBash === true,
      google_gmail: false,
      google_calendar: false,
      google_drive: false,
      cron: false,
    };
  }

  return {
    file_read: raw.file_read !== false,
    file_write: raw.file_write !== false,
    file_list: raw.file_list !== false,
    web_fetch: raw.web_fetch !== false,
    web_browse: raw.web_browse === true,
    bash: raw.bash === true,
    google_gmail: raw.google_gmail === true,
    google_calendar: raw.google_calendar === true,
    google_drive: raw.google_drive === true,
    cron: raw.cron === true,
  };
}

function ensureDefaultProviders(): void {
  const now = new Date().toISOString();
  const defaults = [
    {
      id: 'anthropic',
      provider_key: 'anthropic',
      name: 'Anthropic',
      base_url: '',
      auth_scheme: 'x-api-key' as const,
    },
    {
      id: 'openrouter',
      provider_key: 'openrouter',
      name: 'OpenRouter',
      base_url: '',
      auth_scheme: 'bearer' as const,
    },
    {
      id: 'openai',
      provider_key: 'openai',
      name: 'OpenAI',
      base_url: '',
      auth_scheme: 'bearer' as const,
    },
    {
      id: 'groq',
      provider_key: 'groq',
      name: 'Groq',
      base_url: '',
      auth_scheme: 'bearer' as const,
    },
    {
      id: 'google',
      provider_key: 'google',
      name: 'Google (Gemini)',
      base_url: '',
      auth_scheme: 'bearer' as const,
    },
    {
      id: 'opencode',
      provider_key: 'opencode',
      name: 'OpenCode',
      base_url: 'https://opencode.ai/zen/v1',
      auth_scheme: 'bearer' as const,
    },
    {
      id: 'claude-code',
      provider_key: 'claude-code',
      name: 'Claude Code CLI',
      base_url: '',
      auth_scheme: 'bearer' as const,
    },
  ];
  for (const p of defaults) {
    db.prepare(
      `INSERT OR IGNORE INTO llm_providers (id, provider_key, name, base_url, auth_scheme, api_key, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 1, ?, ?)`,
    ).run(p.id, p.provider_key, p.name, p.base_url, p.auth_scheme, now, now);
  }

  // 전용 SDK 프로바이더의 잘못된 base_url 마이그레이션.
  // 이전 버전에서 시드된 base_url이 SDK 기본값을 덮어써서 404를 유발.
  // 사용자가 커스텀으로 변경한 경우는 건드리지 않음.
  const staleBaseUrls: Record<string, string> = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    groq: 'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
  };
  for (const [id, staleUrl] of Object.entries(staleBaseUrls)) {
    db.prepare(
      `UPDATE llm_providers SET base_url = '', updated_at = ? WHERE id = ? AND base_url = ?`,
    ).run(now, id, staleUrl);
  }
}

/**
 * Migrate legacy ui_route_sets -> services (if table still exists from old DB).
 */
function migrateRouteSetToServices(): void {
  try {
    const rows = db
      .prepare(
        `SELECT id, agent_profile_id, channel_id, target_id, created_at, updated_at FROM ui_route_sets`,
      )
      .all() as Array<{
      id: string;
      agent_profile_id: string;
      channel_id: string;
      target_id: string;
      created_at: string;
      updated_at: string;
    }>;
    for (const row of rows) {
      db.prepare(
        `INSERT OR IGNORE INTO services (id, agent_profile_id, channel_id, target_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        row.id,
        row.agent_profile_id,
        row.channel_id,
        row.target_id,
        row.created_at,
        row.updated_at,
      );
    }
  } catch {
    // ui_route_sets table doesn't exist in fresh DBs — that's fine
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createSchema(db);
  ensureDefaultProviders();
  migrateRouteSetToServices();
}

/** @internal - for tests only */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
  ensureDefaultProviders();
}

// ============================================================
// Agent profiles
// ============================================================

interface AgentProfileRow {
  id: string;
  name: string;
  description: string;
  provider_id: string;
  model: string;
  system_prompt: string;
  tools_json: string;
  folder_name: string | null;
  time_aware: number | null;
  smart_step: number | null;
  max_plan_steps: number | null;
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

function mapAgentProfileRow(row: AgentProfileRow): AgentProfile {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.tools_json);
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider_id: row.provider_id || 'anthropic',
    model: row.model || 'sonnet',
    system_prompt: row.system_prompt || '',
    skills: normalizeSkillsJson(parsed),
    time_aware: row.time_aware ?? 0,
    smart_step: row.smart_step ?? 0,
    max_plan_steps: row.max_plan_steps ?? 10,
    folder_name: row.folder_name || row.id,
    thumbnail: row.thumbnail ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listAgentProfiles(): AgentProfile[] {
  return (
    db
      .prepare(
        `SELECT id, name, description, provider_id, model, system_prompt, tools_json, folder_name, time_aware, smart_step, max_plan_steps, thumbnail, created_at, updated_at FROM agent_profiles ORDER BY name ASC`,
      )
      .all() as AgentProfileRow[]
  ).map(mapAgentProfileRow);
}

export function getAgentProfileById(id: string): AgentProfile | undefined {
  const row = db
    .prepare(
      `SELECT id, name, description, provider_id, model, system_prompt, tools_json, folder_name, time_aware, smart_step, max_plan_steps, thumbnail, created_at, updated_at FROM agent_profiles WHERE id = ?`,
    )
    .get(id) as AgentProfileRow | undefined;
  return row ? mapAgentProfileRow(row) : undefined;
}

export function createAgentProfile(
  profile: Pick<
    AgentProfile,
    | 'id'
    | 'name'
    | 'description'
    | 'provider_id'
    | 'model'
    | 'system_prompt'
    | 'skills'
  > & {
    folder_name?: string;
    thumbnail?: string;
    time_aware?: number;
    smart_step?: number;
    max_plan_steps?: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_profiles (id, name, description, provider_id, model, system_prompt, tools_json, folder_name, thumbnail, time_aware, smart_step, max_plan_steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.id,
    profile.name,
    profile.description,
    profile.provider_id || 'anthropic',
    profile.model || 'sonnet',
    profile.system_prompt || '',
    JSON.stringify(normalizeSkillsJson(profile.skills)),
    profile.folder_name ?? null,
    profile.thumbnail ?? null,
    profile.time_aware ?? 0,
    profile.smart_step ?? 0,
    profile.max_plan_steps ?? 10,
    now,
    now,
  );
}

export function updateAgentProfile(
  id: string,
  updates: Partial<
    Pick<
      AgentProfile,
      | 'name'
      | 'description'
      | 'provider_id'
      | 'model'
      | 'system_prompt'
      | 'skills'
      | 'folder_name'
      | 'time_aware'
      | 'smart_step'
      | 'max_plan_steps'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.provider_id !== undefined) {
    fields.push('provider_id = ?');
    values.push(updates.provider_id);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.system_prompt !== undefined) {
    fields.push('system_prompt = ?');
    values.push(updates.system_prompt);
  }
  if (updates.skills !== undefined) {
    fields.push('tools_json = ?');
    values.push(JSON.stringify(normalizeSkillsJson(updates.skills)));
  }
  if (updates.folder_name !== undefined) {
    fields.push('folder_name = ?');
    values.push(updates.folder_name);
  }
  if (updates.time_aware !== undefined) {
    fields.push('time_aware = ?');
    values.push(updates.time_aware);
  }
  if (updates.smart_step !== undefined) {
    fields.push('smart_step = ?');
    values.push(updates.smart_step);
  }
  if (updates.max_plan_steps !== undefined) {
    fields.push('max_plan_steps = ?');
    values.push(updates.max_plan_steps);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE agent_profiles SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteAgentProfile(id: string): void {
  const row = db
    .prepare('SELECT id FROM agent_profiles WHERE id = ?')
    .get(id) as { id: string } | undefined;
  if (!row) return;
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM conversation_archives WHERE service_id IN (SELECT id FROM services WHERE agent_profile_id = ?)`,
    ).run(id);
    db.prepare(
      `DELETE FROM conversations WHERE service_id IN (SELECT id FROM services WHERE agent_profile_id = ?)`,
    ).run(id);
    db.prepare('DELETE FROM services WHERE agent_profile_id = ?').run(id);
    db.prepare(
      'DELETE FROM agent_custom_skills WHERE agent_profile_id = ?',
    ).run(id);
    try {
      db.prepare(
        `DELETE FROM agent_target_links WHERE agent_profile_id = ?`,
      ).run(id);
    } catch {
      /* table may not exist */
    }
    try {
      db.prepare(`DELETE FROM ui_route_sets WHERE agent_profile_id = ?`).run(
        id,
      );
    } catch {
      /* table may not exist */
    }
    db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
  });
  txn();
}

// ============================================================
// LLM providers
// ============================================================

export function listLlmProviders(): LlmProvider[] {
  return db
    .prepare(
      `SELECT id, provider_key, name, base_url, auth_scheme, api_key, enabled, created_at, updated_at FROM llm_providers ORDER BY created_at ASC`,
    )
    .all() as LlmProvider[];
}

export function getLlmProviderById(id: string): LlmProvider | undefined {
  return db
    .prepare(
      `SELECT id, provider_key, name, base_url, auth_scheme, api_key, enabled, created_at, updated_at FROM llm_providers WHERE id = ?`,
    )
    .get(id) as LlmProvider | undefined;
}

export function upsertLlmProvider(input: {
  id: string;
  providerKey: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key';
  apiKey: string;
  enabled?: boolean;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO llm_providers (id, provider_key, name, base_url, auth_scheme, api_key, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider_key = excluded.provider_key,
       name = excluded.name,
       base_url = excluded.base_url,
       auth_scheme = excluded.auth_scheme,
       api_key = excluded.api_key,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.providerKey,
    input.name,
    input.baseUrl,
    input.authScheme,
    input.apiKey,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
}

// ============================================================
// Managed channels (Telegram / Discord / Slack bots)
// ============================================================

const MC_COLUMNS =
  'id, type, name, config_json, status, pairing_status, folder_name, auto_session, thumbnail, created_at, updated_at';

export function listManagedChannels(): ManagedChannel[] {
  return db
    .prepare(
      `SELECT ${MC_COLUMNS} FROM managed_channels ORDER BY created_at DESC`,
    )
    .all() as ManagedChannel[];
}

export function getManagedChannelById(id: string): ManagedChannel | undefined {
  return db
    .prepare(`SELECT ${MC_COLUMNS} FROM managed_channels WHERE id = ?`)
    .get(id) as ManagedChannel | undefined;
}

/** 동일 봇 토큰으로 이미 등록된 채널 조회 (중복 방지용) */
export function findChannelByBotToken(
  botToken: string,
): ManagedChannel | undefined {
  return db
    .prepare(
      `SELECT ${MC_COLUMNS} FROM managed_channels WHERE json_extract(config_json, '$.botToken') = ?`,
    )
    .get(botToken) as ManagedChannel | undefined;
}

export function createManagedChannel(input: {
  id: string;
  type: ChannelType;
  name: string;
  configJson: string;
  status?: string;
  folderName?: string;
  thumbnail?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO managed_channels (id, type, name, config_json, status, pairing_status, folder_name, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.type,
    input.name,
    input.configJson,
    input.status || 'configured',
    input.folderName ?? null,
    input.thumbnail ?? null,
    now,
    now,
  );
}

export function updateManagedChannel(
  id: string,
  updates: {
    configJson?: string;
    status?: string;
    pairingStatus?: string;
    name?: string;
    folderName?: string;
    autoSession?: number;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.configJson !== undefined) {
    fields.push('config_json = ?');
    values.push(updates.configJson);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.pairingStatus !== undefined) {
    fields.push('pairing_status = ?');
    values.push(updates.pairingStatus);
  }
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.folderName !== undefined) {
    fields.push('folder_name = ?');
    values.push(updates.folderName);
  }
  if (updates.autoSession !== undefined) {
    fields.push('auto_session = ?');
    values.push(updates.autoSession);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(
    `UPDATE managed_channels SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteManagedChannel(id: string): void {
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM conversation_archives WHERE service_id IN (SELECT id FROM services WHERE channel_id = ?)`,
    ).run(id);
    db.prepare(
      `DELETE FROM conversations WHERE service_id IN (SELECT id FROM services WHERE channel_id = ?)`,
    ).run(id);
    db.prepare(`DELETE FROM services WHERE channel_id = ?`).run(id);
    // Legacy tables that may reference managed_channels
    try {
      db.prepare(`DELETE FROM channel_targets WHERE channel_id = ?`).run(id);
    } catch {
      /* table may not exist */
    }
    try {
      db.prepare(`DELETE FROM channel_target_links WHERE channel_id = ?`).run(
        id,
      );
    } catch {
      /* table may not exist */
    }
    try {
      db.prepare(`DELETE FROM ui_route_sets WHERE channel_id = ?`).run(id);
    } catch {
      /* table may not exist */
    }
    db.prepare(`DELETE FROM managed_channels WHERE id = ?`).run(id);
  });
  txn();
}

// ============================================================
// Targets (users to serve)
// ============================================================

const TG_COLUMNS =
  'id, target_id, nickname, platform, target_type, creation_source, COALESCE(folder_name, target_id) AS folder_name, thumbnail, created_at, updated_at';

export function listTargets(): TargetProfile[] {
  return db
    .prepare(`SELECT ${TG_COLUMNS} FROM targets ORDER BY created_at DESC`)
    .all() as TargetProfile[];
}

export function getTargetById(id: string): TargetProfile | undefined {
  return db
    .prepare(`SELECT ${TG_COLUMNS} FROM targets WHERE id = ?`)
    .get(id) as TargetProfile | undefined;
}

export function getTargetByTargetId(
  targetId: string,
): TargetProfile | undefined {
  return db
    .prepare(`SELECT ${TG_COLUMNS} FROM targets WHERE target_id = ?`)
    .get(targetId) as TargetProfile | undefined;
}

export function getTargetByTargetIdAndType(
  targetId: string,
  targetType: Exclude<TargetType, 'everyone'>,
): TargetProfile | undefined {
  return db
    .prepare(
      `SELECT ${TG_COLUMNS} FROM targets WHERE target_id = ? AND target_type = ?`,
    )
    .get(targetId, targetType) as TargetProfile | undefined;
}

export function createTarget(input: {
  id: string;
  targetId: string;
  nickname: string;
  platform: ChannelType;
  targetType?: TargetType;
  folderName?: string;
  thumbnail?: string;
  creationSource?: 'manual' | 'everyone_template';
}): void {
  const normalizedType = input.targetType ?? 'user';
  const normalizedTargetId =
    normalizedType === 'everyone'
      ? getEveryoneTargetId(input.platform)
      : input.targetId;
  const normalizedNickname =
    normalizedType === 'everyone'
      ? EVERYONE_TARGET_NICKNAME
      : input.nickname.trim();
  const normalizedFolderName = input.folderName ?? normalizedTargetId;
  if (normalizedType !== 'everyone') {
    const dup = db
      .prepare(`SELECT id FROM targets WHERE platform = ? AND nickname = ?`)
      .get(input.platform, normalizedNickname) as { id: string } | undefined;
    if (dup)
      throw new Error(
        `같은 플랫폼(${input.platform})에 동일한 닉네임이 이미 존재합니다: ${normalizedNickname}`,
      );
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO targets (id, target_id, nickname, platform, target_type, creation_source, folder_name, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    normalizedTargetId,
    normalizedNickname,
    input.platform,
    normalizedType,
    input.creationSource ?? 'manual',
    normalizedFolderName,
    input.thumbnail ?? null,
    now,
    now,
  );
}

export function updateTarget(
  id: string,
  updates: {
    targetId?: string;
    nickname?: string;
    platform?: ChannelType;
    targetType?: TargetType;
    folderName?: string;
  },
): void {
  const current = getTargetById(id);
  if (!current) return;
  if (current.target_type === 'everyone') {
    throw new Error('everyone target is system-managed and cannot be edited');
  }
  const finalPlatform = updates.platform ?? current.platform;
  const finalType = updates.targetType ?? current.target_type;
  const finalNickname =
    finalType === 'everyone'
      ? EVERYONE_TARGET_NICKNAME
      : (updates.nickname ?? current.nickname);

  // 닉네임 또는 플랫폼 변경 시 중복 체크
  if (
    updates.nickname !== undefined ||
    updates.platform !== undefined ||
    updates.targetType !== undefined
  ) {
    const dup = db
      .prepare(
        `SELECT id FROM targets WHERE platform = ? AND nickname = ? AND id != ?`,
      )
      .get(finalPlatform, finalNickname, id) as { id: string } | undefined;
    if (dup)
      throw new Error(
        `같은 플랫폼(${finalPlatform})에 동일한 닉네임이 이미 존재합니다: ${finalNickname}`,
      );
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.targetId !== undefined || finalType === 'everyone') {
    fields.push('target_id = ?');
    values.push(
      finalType === 'everyone'
        ? getEveryoneTargetId(finalPlatform)
        : (updates.targetId ?? current.target_id),
    );
  }
  if (updates.nickname !== undefined || updates.targetType === 'everyone') {
    fields.push('nickname = ?');
    values.push(finalNickname);
  }
  if (updates.platform !== undefined) {
    fields.push('platform = ?');
    values.push(updates.platform);
  }
  if (updates.targetType !== undefined) {
    fields.push('target_type = ?');
    values.push(updates.targetType);
  }
  if (updates.folderName !== undefined) {
    fields.push('folder_name = ?');
    values.push(updates.folderName);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE targets SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteTarget(id: string): void {
  const target = getTargetById(id);
  if (target?.target_type === 'everyone') {
    throw new Error('everyone target is system-managed and cannot be deleted');
  }
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM conversation_archives WHERE service_id IN (SELECT id FROM services WHERE target_id = ?)`,
    ).run(id);
    db.prepare(
      `DELETE FROM conversations WHERE service_id IN (SELECT id FROM services WHERE target_id = ?)`,
    ).run(id);
    db.prepare(`DELETE FROM services WHERE target_id = ?`).run(id);
    try {
      db.prepare(`DELETE FROM channel_target_links WHERE target_id = ?`).run(
        id,
      );
    } catch {
      /* table may not exist */
    }
    try {
      db.prepare(`DELETE FROM ui_route_sets WHERE target_id = ?`).run(id);
    } catch {
      /* table may not exist */
    }
    db.prepare(`DELETE FROM targets WHERE id = ?`).run(id);
  });
  txn();
}

// ============================================================
// Services (Agent + Channel + Target — 유일한 관계 모델)
// ============================================================

export function listServices(): Service[] {
  return db
    .prepare(
      `SELECT id, agent_profile_id, channel_id, target_id, creation_source, spawned_from_template_service_id, status, created_at, updated_at FROM services ORDER BY created_at DESC`,
    )
    .all() as Service[];
}

export function getServiceById(id: string): Service | undefined {
  return db
    .prepare(
      `SELECT id, agent_profile_id, channel_id, target_id, creation_source, spawned_from_template_service_id, status, created_at, updated_at FROM services WHERE id = ?`,
    )
    .get(id) as Service | undefined;
}

export function findActiveService(
  channelId: string,
  platformUserId: string,
): (Service & { agent: AgentProfile; provider: LlmProvider }) | undefined {
  const row = db
    .prepare(
      `SELECT s.id, s.agent_profile_id, s.channel_id, s.target_id, s.status, s.created_at, s.updated_at
              , s.creation_source, s.spawned_from_template_service_id
       FROM services s
       JOIN targets t ON s.target_id = t.id
       WHERE s.channel_id = ? AND t.target_id = ? AND t.target_type = 'user' AND s.status = 'active'
       LIMIT 1`,
    )
    .get(channelId, platformUserId) as Service | undefined;
  if (!row) return undefined;
  const agent = getAgentProfileById(row.agent_profile_id);
  if (!agent) return undefined;
  const provider = getLlmProviderById(agent.provider_id);
  if (!provider) return undefined;
  return { ...row, agent, provider };
}

/**
 * room 타겟 매칭: 서버 채널 내 메시지 → target_type='room'인 타겟과 매칭.
 * channel_id + target.target_id(=roomId) + target_type='room' + status='active'
 */
export function findActiveServiceByRoom(
  channelId: string,
  roomId: string,
): (Service & { agent: AgentProfile; provider: LlmProvider }) | undefined {
  const row = db
    .prepare(
      `SELECT s.id, s.agent_profile_id, s.channel_id, s.target_id, s.status, s.created_at, s.updated_at
              , s.creation_source, s.spawned_from_template_service_id
       FROM services s
       JOIN targets t ON s.target_id = t.id
       WHERE s.channel_id = ? AND t.target_id = ? AND t.target_type = 'room' AND s.status = 'active'
       LIMIT 1`,
    )
    .get(channelId, roomId) as Service | undefined;
  if (!row) return undefined;
  const agent = getAgentProfileById(row.agent_profile_id);
  if (!agent) return undefined;
  const provider = getLlmProviderById(agent.provider_id);
  if (!provider) return undefined;
  return { ...row, agent, provider };
}

export function findEveryoneTemplateService(
  channelId: string,
): (Service & { agent: AgentProfile; provider: LlmProvider }) | undefined {
  const row = db
    .prepare(
      `SELECT s.id, s.agent_profile_id, s.channel_id, s.target_id, s.status, s.created_at, s.updated_at
              , s.creation_source, s.spawned_from_template_service_id
       FROM services s
       JOIN targets t ON s.target_id = t.id
       WHERE s.channel_id = ? AND t.target_type = 'everyone' AND s.status = 'active'
       LIMIT 1`,
    )
    .get(channelId) as Service | undefined;
  if (!row) return undefined;
  const agent = getAgentProfileById(row.agent_profile_id);
  if (!agent) return undefined;
  const provider = getLlmProviderById(agent.provider_id);
  if (!provider) return undefined;
  return { ...row, agent, provider };
}

export function listConcreteServicesForTemplate(
  templateServiceId: string,
): Array<Service & { target: TargetProfile }> {
  const template = getServiceById(templateServiceId);
  if (!template) return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.agent_profile_id, s.channel_id, s.target_id, s.creation_source, s.spawned_from_template_service_id, s.status, s.created_at, s.updated_at,
              t.id AS target_internal_id, t.target_id AS target_platform_id,
              t.nickname AS target_nickname, t.platform AS target_platform,
              t.target_type AS target_type, t.creation_source AS target_creation_source,
              COALESCE(t.folder_name, t.target_id) AS target_folder_name,
              t.thumbnail AS target_thumbnail,
              t.created_at AS target_created_at, t.updated_at AS target_updated_at
       FROM services s
       JOIN targets t ON s.target_id = t.id
       WHERE s.channel_id = ? AND s.agent_profile_id = ? AND s.id != ? AND s.status = 'active' AND t.target_type != 'everyone'
       ORDER BY s.created_at ASC`,
    )
    .all(
      template.channel_id,
      template.agent_profile_id,
      templateServiceId,
    ) as Array<
    Service & {
      target_internal_id: string;
      target_platform_id: string;
      target_nickname: string;
      target_platform: ChannelType;
      target_type: TargetType;
      target_creation_source: 'manual' | 'everyone_template';
      target_folder_name: string;
      target_thumbnail: string | null;
      target_created_at: string;
      target_updated_at: string;
    }
  >;

  return rows.map((row) => ({
    id: row.id,
    agent_profile_id: row.agent_profile_id,
    channel_id: row.channel_id,
    target_id: row.target_id,
    creation_source: row.creation_source,
    spawned_from_template_service_id: row.spawned_from_template_service_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    target: {
      id: row.target_internal_id,
      target_id: row.target_platform_id,
      nickname: row.target_nickname,
      platform: row.target_platform,
      target_type: row.target_type,
      creation_source: row.target_creation_source,
      folder_name: row.target_folder_name,
      thumbnail: row.target_thumbnail,
      created_at: row.target_created_at,
      updated_at: row.target_updated_at,
    },
  }));
}

export function getActiveServicesByChannel(
  channelId: string,
): Map<string, Service> {
  const rows = db
    .prepare(
      `SELECT s.id, s.agent_profile_id, s.channel_id, s.target_id, s.creation_source, s.spawned_from_template_service_id, s.status, s.created_at, s.updated_at, t.target_id as platform_user_id FROM services s JOIN targets t ON s.target_id = t.id WHERE s.channel_id = ? AND s.status = 'active'`,
    )
    .all(channelId) as Array<Service & { platform_user_id: string }>;
  const map = new Map<string, Service>();
  for (const row of rows)
    map.set(row.platform_user_id, {
      id: row.id,
      agent_profile_id: row.agent_profile_id,
      channel_id: row.channel_id,
      target_id: row.target_id,
      creation_source: row.creation_source,
      spawned_from_template_service_id: row.spawned_from_template_service_id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  return map;
}

export function createService(input: {
  id: string;
  agentProfileId: string;
  channelId: string;
  targetId: string;
  creationSource?: Service['creation_source'];
  spawnedFromTemplateServiceId?: string | null;
}): void {
  const existing = db
    .prepare(`SELECT id FROM services WHERE channel_id = ? AND target_id = ?`)
    .get(input.channelId, input.targetId) as { id: string } | undefined;
  if (existing) throw new Error('이 채널+타겟 조합에 이미 서비스가 존재합니다');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO services (id, agent_profile_id, channel_id, target_id, creation_source, spawned_from_template_service_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    input.id,
    input.agentProfileId,
    input.channelId,
    input.targetId,
    input.creationSource ?? 'manual',
    input.spawnedFromTemplateServiceId ?? null,
    now,
    now,
  );
}

export function updateServiceStatus(
  id: string,
  status: 'active' | 'paused' | 'error',
): void {
  db.prepare(`UPDATE services SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    id,
  );
}

export function deleteService(id: string): void {
  const txn = db.transaction(() => {
    const childIds = db
      .prepare(
        `SELECT id FROM services WHERE spawned_from_template_service_id = ?`,
      )
      .all(id) as { id: string }[];
    for (const child of childIds) {
      db.prepare(`DELETE FROM service_crons WHERE service_id = ?`).run(
        child.id,
      );
      db.prepare(`DELETE FROM conversation_archives WHERE service_id = ?`).run(
        child.id,
      );
      db.prepare(`DELETE FROM conversations WHERE service_id = ?`).run(
        child.id,
      );
    }
    if (childIds.length) {
      db.prepare(
        `DELETE FROM services WHERE spawned_from_template_service_id = ?`,
      ).run(id);
    }
    db.prepare(`DELETE FROM service_crons WHERE service_id = ?`).run(id);
    db.prepare(`DELETE FROM conversation_archives WHERE service_id = ?`).run(
      id,
    );
    db.prepare(`DELETE FROM conversations WHERE service_id = ?`).run(id);
    db.prepare(`DELETE FROM services WHERE id = ?`).run(id);
  });
  txn();
}

// ============================================================
// Conversations (per-service AI context)
// ============================================================

export function addConversationMessage(
  serviceId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): void {
  db.prepare(
    `INSERT INTO conversations (service_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
  ).run(serviceId, role, content, new Date().toISOString());
}

export function getConversationHistory(
  serviceId: string,
  limit: number = 50,
): ConversationMessage[] {
  return db
    .prepare(
      `SELECT * FROM (SELECT id, service_id, role, content, timestamp FROM conversations WHERE service_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
    )
    .all(serviceId, limit) as ConversationMessage[];
}

export function clearConversation(serviceId: string): void {
  db.prepare(`DELETE FROM conversations WHERE service_id = ?`).run(serviceId);
}

export function getConversationCount(serviceId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM conversations WHERE service_id = ?`)
    .get(serviceId) as { cnt: number };
  return row.cnt;
}

/**
 * Get ALL conversation messages (no limit) for compaction archiving.
 */
export function getAllConversationMessages(
  serviceId: string,
): ConversationMessage[] {
  return db
    .prepare(
      `SELECT id, service_id, role, content, timestamp FROM conversations WHERE service_id = ? ORDER BY id ASC`,
    )
    .all(serviceId) as ConversationMessage[];
}

/**
 * Archive conversation before compaction, then replace with summary.
 * Atomic: archive + delete old + insert summary in one transaction.
 */
export function compactConversation(
  serviceId: string,
  messages: ConversationMessage[],
  summary: string,
  estimatedTokens: number,
): void {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO conversation_archives (service_id, messages_json, summary, message_count, estimated_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      serviceId,
      JSON.stringify(
        messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
      ),
      summary,
      messages.length,
      estimatedTokens,
      now,
    );

    db.prepare(`DELETE FROM conversations WHERE service_id = ?`).run(serviceId);

    db.prepare(
      `INSERT INTO conversations (service_id, role, content, timestamp) VALUES (?, 'system', ?, ?)`,
    ).run(serviceId, summary, now);
  });
  txn();
}

/**
 * 플랜 시작 이후 유저 메시지가 있는지 확인 (Smart Step 인터럽트 감지).
 * role='user'인 메시지가 sinceTimestamp 이후에 있으면 true.
 */
export function hasNewUserMessages(
  serviceId: string,
  sinceTimestamp: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM conversations WHERE service_id = ? AND role = 'user' AND timestamp > ?`,
    )
    .get(serviceId, sinceTimestamp) as { cnt: number };
  return row.cnt > 0;
}

export function getArchiveCount(serviceId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM conversation_archives WHERE service_id = ?`,
    )
    .get(serviceId) as { cnt: number };
  return row.cnt;
}

export function deleteArchivesByService(serviceId: string): void {
  db.prepare(`DELETE FROM conversation_archives WHERE service_id = ?`).run(
    serviceId,
  );
}

// ============================================================
// Custom skills (global pool + per-agent toggle)
// ============================================================

const CS_COLUMNS =
  'id, name, description, prompt, script, input_schema, tool_name, timeout_ms, folder_name, created_at, updated_at';

export function listCustomSkills(): CustomSkill[] {
  return db
    .prepare(`SELECT ${CS_COLUMNS} FROM custom_skills ORDER BY name ASC`)
    .all() as CustomSkill[];
}

export function getCustomSkillById(id: string): CustomSkill | undefined {
  return db
    .prepare(`SELECT ${CS_COLUMNS} FROM custom_skills WHERE id = ?`)
    .get(id) as CustomSkill | undefined;
}

export function createCustomSkill(input: {
  id: string;
  name: string;
  description: string;
  prompt: string;
  script?: string;
  input_schema?: string;
  tool_name?: string;
  timeout_ms?: number;
  folder_name?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO custom_skills (id, name, description, prompt, script, input_schema, tool_name, timeout_ms, folder_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.description,
    input.prompt,
    input.script ?? '',
    input.input_schema ?? '[]',
    input.tool_name ?? '',
    input.timeout_ms ?? 30000,
    input.folder_name ?? null,
    now,
    now,
  );
}

export function updateCustomSkill(
  id: string,
  updates: Partial<
    Pick<
      CustomSkill,
      | 'name'
      | 'description'
      | 'prompt'
      | 'script'
      | 'input_schema'
      | 'tool_name'
      | 'timeout_ms'
      | 'folder_name'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script);
  }
  if (updates.input_schema !== undefined) {
    fields.push('input_schema = ?');
    values.push(updates.input_schema);
  }
  if (updates.tool_name !== undefined) {
    fields.push('tool_name = ?');
    values.push(updates.tool_name);
  }
  if (updates.timeout_ms !== undefined) {
    fields.push('timeout_ms = ?');
    values.push(updates.timeout_ms);
  }
  if (updates.folder_name !== undefined) {
    fields.push('folder_name = ?');
    values.push(updates.folder_name);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE custom_skills SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteCustomSkill(id: string): void {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM agent_custom_skills WHERE custom_skill_id = ?`).run(
      id,
    );
    db.prepare(`DELETE FROM custom_skills WHERE id = ?`).run(id);
  });
  txn();
}

export function getAgentCustomSkills(
  agentProfileId: string,
): Array<CustomSkill & { enabled: number }> {
  return db
    .prepare(
      `
    SELECT ${CS_COLUMNS.split(', ')
      .map((c) => 'cs.' + c)
      .join(', ')}, acs.enabled
    FROM agent_custom_skills acs
    JOIN custom_skills cs ON cs.id = acs.custom_skill_id
    WHERE acs.agent_profile_id = ?
    ORDER BY cs.name ASC
  `,
    )
    .all(agentProfileId) as Array<CustomSkill & { enabled: number }>;
}

/** @deprecated resolveSkills에는 getEnabledCustomSkills를 사용. 하위 호환용 유지. */
export function getEnabledCustomSkillPrompts(agentProfileId: string): string[] {
  const rows = db
    .prepare(
      `
    SELECT cs.prompt FROM agent_custom_skills acs
    JOIN custom_skills cs ON cs.id = acs.custom_skill_id
    WHERE acs.agent_profile_id = ? AND acs.enabled = 1 AND cs.prompt != ''
  `,
    )
    .all(agentProfileId) as Array<{ prompt: string }>;
  return rows.map((r) => r.prompt);
}

/** 에이전트에 활성화된 커스텀 스킬 전체 객체 반환 (resolveSkills용) */
export function getEnabledCustomSkills(agentProfileId: string): CustomSkill[] {
  return db
    .prepare(
      `
    SELECT ${CS_COLUMNS.split(', ')
      .map((c) => 'cs.' + c)
      .join(', ')}
    FROM agent_custom_skills acs
    JOIN custom_skills cs ON cs.id = acs.custom_skill_id
    WHERE acs.agent_profile_id = ? AND acs.enabled = 1
  `,
    )
    .all(agentProfileId) as CustomSkill[];
}

export function setAgentCustomSkill(
  agentProfileId: string,
  customSkillId: string,
  enabled: boolean,
): void {
  db.prepare(
    `
    INSERT INTO agent_custom_skills (agent_profile_id, custom_skill_id, enabled) VALUES (?, ?, ?)
    ON CONFLICT (agent_profile_id, custom_skill_id) DO UPDATE SET enabled = excluded.enabled
  `,
  ).run(agentProfileId, customSkillId, enabled ? 1 : 0);
}

export function removeAgentCustomSkill(
  agentProfileId: string,
  customSkillId: string,
): void {
  db.prepare(
    `DELETE FROM agent_custom_skills WHERE agent_profile_id = ? AND custom_skill_id = ?`,
  ).run(agentProfileId, customSkillId);
}

// ============================================================
// Cron jobs (서비스 단위 예약 작업)
// ============================================================

const CJ_COLUMNS =
  'id, name, prompt, skill_hint, schedule_type, schedule_time, interval_minutes, schedule_days, notify, thumbnail, created_at, updated_at';

export function listCronJobs(): CronJob[] {
  return db
    .prepare(`SELECT ${CJ_COLUMNS} FROM cron_jobs ORDER BY created_at DESC`)
    .all() as CronJob[];
}

export function getCronJobById(id: string): CronJob | undefined {
  return db
    .prepare(`SELECT ${CJ_COLUMNS} FROM cron_jobs WHERE id = ?`)
    .get(id) as CronJob | undefined;
}

const CRON_THUMBS = [
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

export function createCronJob(input: {
  id: string;
  name: string;
  prompt: string;
  skillHint?: string;
  scheduleType: 'once' | 'weekly' | 'interval';
  scheduleTime: string;
  intervalMinutes?: number | null;
  scheduleDays?: string | null;
  notify?: boolean;
  thumbnail?: string;
}): void {
  const now = new Date().toISOString();
  const thumb =
    input.thumbnail ||
    CRON_THUMBS[Math.floor(Math.random() * CRON_THUMBS.length)];
  db.prepare(
    `INSERT INTO cron_jobs (id, name, prompt, skill_hint, schedule_type, schedule_time, interval_minutes, schedule_days, notify, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.prompt,
    input.skillHint ?? '[]',
    input.scheduleType,
    input.scheduleTime,
    input.intervalMinutes ?? null,
    input.scheduleDays ?? null,
    input.notify === false ? 0 : 1,
    thumb,
    now,
    now,
  );
}

export function updateCronJob(
  id: string,
  updates: Partial<
    Pick<
      CronJob,
      | 'name'
      | 'prompt'
      | 'skill_hint'
      | 'schedule_type'
      | 'schedule_time'
      | 'interval_minutes'
      | 'schedule_days'
      | 'notify'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.skill_hint !== undefined) {
    fields.push('skill_hint = ?');
    values.push(updates.skill_hint);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_time !== undefined) {
    fields.push('schedule_time = ?');
    values.push(updates.schedule_time);
  }
  if (updates.interval_minutes !== undefined) {
    fields.push('interval_minutes = ?');
    values.push(updates.interval_minutes);
  }
  if (updates.schedule_days !== undefined) {
    fields.push('schedule_days = ?');
    values.push(updates.schedule_days);
  }
  if (updates.notify !== undefined) {
    fields.push('notify = ?');
    values.push(updates.notify);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE cron_jobs SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteCronJob(id: string): void {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM service_crons WHERE cron_id = ?`).run(id);
    db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  });
  txn();
}

// --- Service ↔ Cron bindings ---

export function listServiceCrons(): ServiceCron[] {
  return db
    .prepare(
      `SELECT service_id, cron_id, status, last_run, next_run FROM service_crons`,
    )
    .all() as ServiceCron[];
}

export function getServiceCronsByService(
  serviceId: string,
): Array<ServiceCron & CronJob> {
  return db
    .prepare(
      `
    SELECT sc.service_id, sc.cron_id, sc.status, sc.last_run, sc.next_run,
           cj.id, cj.name, cj.prompt, cj.schedule_type, cj.schedule_time,
           cj.interval_minutes, cj.schedule_days, cj.notify, cj.created_at, cj.updated_at
    FROM service_crons sc JOIN cron_jobs cj ON cj.id = sc.cron_id
    WHERE sc.service_id = ?
  `,
    )
    .all(serviceId) as Array<ServiceCron & CronJob>;
}

export function attachCronToService(
  serviceId: string,
  cronId: string,
  nextRun: string | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO service_crons (service_id, cron_id, status, next_run) VALUES (?, ?, 'active', ?)`,
  ).run(serviceId, cronId, nextRun);
}

/** 크론 스케줄 변경 시 연결된 모든 service_crons의 next_run을 일괄 갱신 */
export function updateNextRunByCronId(
  cronId: string,
  nextRun: string | null,
): void {
  db.prepare(
    `UPDATE service_crons SET next_run = ? WHERE cron_id = ? AND status = 'active'`,
  ).run(nextRun, cronId);
}

export function detachCronFromService(serviceId: string, cronId: string): void {
  db.prepare(
    `DELETE FROM service_crons WHERE service_id = ? AND cron_id = ?`,
  ).run(serviceId, cronId);
}

export function getDueServiceCrons(): Array<
  ServiceCron &
    CronJob & {
      agent_profile_id: string;
      channel_id: string;
      target_id: string;
    }
> {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT sc.service_id, sc.cron_id, sc.status, sc.last_run, sc.next_run,
           cj.name, cj.prompt, cj.skill_hint, cj.schedule_type, cj.schedule_time,
           cj.interval_minutes, cj.schedule_days, cj.notify,
           s.agent_profile_id, s.channel_id, s.target_id
    FROM service_crons sc
    JOIN cron_jobs cj ON cj.id = sc.cron_id
    JOIN services s ON s.id = sc.service_id
    WHERE sc.status = 'active' AND s.status = 'active'
      AND sc.next_run IS NOT NULL AND sc.next_run <= ?
    ORDER BY sc.next_run
  `,
    )
    .all(now) as Array<
    ServiceCron &
      CronJob & {
        agent_profile_id: string;
        channel_id: string;
        target_id: string;
      }
  >;
}

export function updateServiceCronAfterRun(
  serviceId: string,
  cronId: string,
  nextRun: string | null,
): void {
  const now = new Date().toISOString();
  if (nextRun === null) {
    db.prepare(
      `DELETE FROM service_crons WHERE service_id = ? AND cron_id = ?`,
    ).run(serviceId, cronId);
  } else {
    db.prepare(
      `UPDATE service_crons SET last_run = ?, next_run = ? WHERE service_id = ? AND cron_id = ?`,
    ).run(now, nextRun, serviceId, cronId);
  }
}

/** once 크론: 모든 service_crons가 삭제되면 cron_jobs도 정리 */
export function cleanupOrphanedOnceCrons(): void {
  db.prepare(
    `
    DELETE FROM cron_jobs WHERE schedule_type = 'once'
      AND id NOT IN (SELECT DISTINCT cron_id FROM service_crons)
  `,
  ).run();
}
