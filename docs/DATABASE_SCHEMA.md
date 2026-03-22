# Agent Salad — Database Schema

`store/messages.db` — single SQLite database managing all state.

## Core Model: Agent + Channel + Target = Service

- **Agent**: AI agent profile (provider, model, system prompt)
- **Channel**: Messenger bot (Telegram, Discord, Slack)
- **Target**: User to serve
- **Service**: Active binding of the above three

## Service Tables

### `services`
Active service bindings (Agent + Channel + Target).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Service ID |
| `agent_profile_id` | TEXT FK | References agent_profiles |
| `channel_id` | TEXT FK | References managed_channels |
| `target_id` | TEXT FK | References targets |
| `status` | TEXT | `active` / `paused` / `error` |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

- Unique: `(agent_profile_id, channel_id, target_id)`
- Index: `(channel_id, target_id)` — fast lookup during message routing

### `conversations`
Per-service message history for LLM context.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `service_id` | TEXT FK | References services |
| `role` | TEXT | `user` / `assistant` / `system` |
| `content` | TEXT | Message content (or compaction summary when role=system) |
| `timestamp` | TEXT | |

- Index: `(service_id, timestamp)`
- After compaction, all messages are replaced with a single `system` role summary

### `conversation_archives`
Full conversation backup before each compaction. One row per compaction event.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `service_id` | TEXT FK | References services |
| `messages_json` | TEXT | Full message history as JSON array |
| `summary` | TEXT | LLM-generated summary that replaced the messages |
| `message_count` | INTEGER | Number of messages that were compacted |
| `estimated_tokens` | INTEGER | Estimated token count before compaction |
| `created_at` | TEXT | |

- Index: `(service_id, created_at)`
- Deleted when service is deleted

## Agent Profile Table

### `agent_profiles`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | |
| `name` | TEXT UNIQUE | Agent display name |
| `description` | TEXT | |
| `provider_id` | TEXT | LLM provider ID (anthropic, openai, groq, etc.) |
| `model` | TEXT | Model name (e.g. claude-sonnet-4-20250514) |
| `system_prompt` | TEXT | User-defined personality/role (System Prompt Layer 3) |
| `tools_json` | TEXT | Skill toggle JSON (builtin skill on/off map) |
| `is_default` | INTEGER | Whether this is the default profile |
| `folder_name` | TEXT | Workspace folder name (name-based, auto-renamed) |
| `time_aware` | INTEGER | 0 = off, 1 = inject message timestamps + current time |
| `smart_step` | INTEGER | 0 = off, 1 = enable submit_plan + send_message tools |
| `max_plan_steps` | INTEGER | Max plan steps (1-30, default 10). Only used when smart_step=1 |
| `thumbnail` | TEXT | Food emoji thumbnail (randomly assigned) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### System Prompt Architecture (3-layer + Smart Step)
- **Layer 1 (immutable)**: `SYSTEM_PROMPT_BASE` in `src/providers/system-prompt.ts`
- **Layer 2 (dynamic)**: Enabled skill prompts (builtin + custom), injected per-agent at call time
- **Layer 3 (mutable)**: `agent_profiles.system_prompt`, editable via Web UI
- **Smart Step (conditional)**: `buildSmartStepPrompt()` — only injected for smart_step=1 agents
- Combined via `buildSystemPrompt(agentPrompt, skillPrompts[], timeAware, smartStep)`

## Channel Table

### `managed_channels`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | |
| `type` | TEXT | `telegram` / `discord` / `slack` (ChannelType) |
| `name` | TEXT | Display name |
| `config_json` | TEXT | Bot token, auth credentials, etc. |
| `status` | TEXT | `configured` / `active` |
| `pairing_status` | TEXT | `pending` / `paired` / `error` |
| `folder_name` | TEXT | Workspace folder name (type-name slug, workspace 3-depth 중간층) |
| `auto_session` | INTEGER | 0 = off (default), 1 = auto-create Target+Service for new users/rooms |
| `thumbnail` | TEXT | Food emoji thumbnail (randomly assigned) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

- `auto_session`: Discord/Slack 전용. 활성화 시 미등록 유저의 DM이나 채널 @멘션에 자동으로 Target+Service 생성.
- 자동 생성 조건: 해당 채널에 연결된 에이전트가 정확히 1개일 때만 (2개 이상이면 어떤 에이전트인지 결정 불가).

## Target Table

### `targets`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Internal ID |
| `target_id` | TEXT UNIQUE | Platform user ID or room/channel ID |
| `nickname` | TEXT | Display name (room targets use `#channel-name` convention) |
| `platform` | TEXT | `telegram` / `discord` / `slack` (ChannelType) |
| `target_type` | TEXT | `user` (DM target) / `room` (channel/thread target). Default `user` |
| `thumbnail` | TEXT | Food emoji thumbnail (randomly assigned) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

- `target_type = 'user'`: DM으로 응답. Telegram/Discord/Slack 공통.
- `target_type = 'room'`: 해당 채널/스레드에 응답. Discord/Slack 전용 (Telegram 미지원).

## LLM Provider Table

### `llm_providers`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | |
| `provider_key` | TEXT UNIQUE | anthropic, openai, groq, openrouter, opencode |
| `name` | TEXT | Display name |
| `base_url` | TEXT | API endpoint |
| `auth_scheme` | TEXT | `bearer` / `x-api-key` |
| `api_key` | TEXT | API key |
| `enabled` | INTEGER | |

Five default providers are auto-registered at startup.

## Skill Toggle JSON Shape

`agent_profiles.tools_json` (column name kept for backward compat):
```json
{
  "file_read": true,
  "file_write": true,
  "file_list": true,
  "web_fetch": true,
  "web_browse": false,
  "bash": false,
  "google_gmail": false,
  "google_calendar": false,
  "google_drive": false,
  "cron": false
}
```

Legacy format (`allowBash`, `allowFileRead`, etc.) is auto-migrated on read by `normalizeSkillsJson()`.

## Custom Skills Tables

### `custom_skills`
Global pool of user-defined skills. Each skill = script file (execution) + prompt (usage guide) bundle.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Skill ID |
| `name` | TEXT UNIQUE | Skill display name |
| `description` | TEXT | What this skill does (shown to LLM as tool description) |
| `prompt` | TEXT | System prompt snippet — tells LLM when/how to use this tool |
| `script` | TEXT | Legacy inline script body. New skills use file-based execution |
| `input_schema` | TEXT | JSON array of `InputSchemaField[]` — tool input parameters |
| `tool_name` | TEXT | Tool name LLM calls (e.g. `check_inventory`). Required for Script Tool type |
| `timeout_ms` | INTEGER | Script execution timeout in ms (default 30000) |
| `folder_name` | TEXT | Skill folder name (name-based, auto-renamed) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

**Script execution priority** (in `resolveSkills()`):
1. File-based: `store/skills/<folder_name>/run.sh` — default for new skills
2. Inline: `custom_skills.script` DB field — backward compatibility
3. Prompt-only: no script, `prompt` injected into system prompt

**Skill creation flow:**
1. Web UI: set metadata (name, description, tool_name)
2. On save: `store/skills/<skill-id>/` folder + 4 template files auto-generated (run.sh, schema.json, prompt.txt, GUIDE.md)
3. User/LLM edits files directly (Python, Node.js, Shell, etc.)
4. Open Folder button in Web UI for direct file access

### `agent_custom_skills`
Per-agent custom skill toggle (junction table).

| Column | Type | Description |
|--------|------|-------------|
| `agent_profile_id` | TEXT FK | References agent_profiles |
| `custom_skill_id` | TEXT FK | References custom_skills |
| `enabled` | INTEGER | 0 or 1 |
| PK | `(agent_profile_id, custom_skill_id)` | |

## Cron Tables

### `cron_jobs`
Scheduled task definitions. Create cron blocks and attach them to active services.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `cron-{Date.now().toString(36)}` |
| `name` | TEXT | Display name |
| `prompt` | TEXT | Prompt to send to the agent |
| `skill_hint` | TEXT | Tool names JSON array (e.g. `["fetch_url","gmail_send"]`), default `[]` |
| `schedule_type` | TEXT | `daily` / `once` |
| `schedule_time` | TEXT | daily: `HH:MM`, once: ISO datetime |
| `notify` | INTEGER | 1 = send to channel, 0 = save conversation only |
| `thumbnail` | TEXT | Food emoji thumbnail (randomly assigned) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### `service_crons`
Service ↔ Cron junction table. One cron can be reused across multiple services.

| Column | Type | Description |
|--------|------|-------------|
| `service_id` | TEXT FK | References services |
| `cron_id` | TEXT FK | References cron_jobs |
| `status` | TEXT | `active` / `paused` |
| `last_run` | TEXT | Last execution time (nullable) |
| `next_run` | TEXT | Next scheduled execution time |
| PK | | `(service_id, cron_id)` |

- Index: `(next_run)` — scheduler polling optimization
- Daily crons: after execution, `next_run` is set to next day same time
- Once crons: after execution, removed from `service_crons`; when all links are gone, `cron_jobs` row is auto-deleted
- Service deletion cascades to linked `service_crons`

## Runtime Rules

- Service matching (user target): lookup by `channel_id + target.target_id` where `target_type='user'`
- Service matching (room target): lookup by `channel_id + target.target_id` where `target_type='room'`
- Auto-session: `managed_channels.auto_session=1` + single agent → auto-create target+service on first interaction
- Conversation context: up to 200 recent messages per service
- Service deletion cascades to conversations and archives
- Agent deletion cascades to linked services, custom skill assignments, and workspace (default profile cannot be deleted)
- Targets are reusable across multiple services
- Agent workspaces at `store/workspaces/<folder_name>/` — name-based folder, auto-renamed on agent rename
- Multi-channel + multi-target workspace: `store/workspaces/<agent>/<channel>/<target>/` — 3-depth 구조, `_shared/` for shared files (에이전트 루트)
- Plan files: `_plan-{serviceId}.json` in agent workspace root (service-scoped)
- Custom skill scripts at `store/skills/<folder_name>/` — 4 files auto-generated (run.sh, schema.json, prompt.txt, GUIDE.md), auto-renamed on skill rename
- Prompt priority: `prompt.txt` file > DB `custom_skills.prompt` field
- Schema priority: `schema.json` file > DB `custom_skills.input_schema` field
- Cron scheduler: 30s polling, `service_crons.next_run <= now` for due tasks
- Smart Step: `_plan-{serviceId}.json` in agent workspace root, server startup cleans up stale files, 3s cooldown between batches for user interrupt detection

## Auto-Compaction

Before each message processing, token count is estimated. If it exceeds 75% of the provider's context window:
1. Full conversation archived to `conversation_archives`
2. Same LLM generates a conversation summary
3. All messages deleted, replaced with a single `system` role summary
4. When summary + new messages overflow again → re-summarize (recursive compaction)

Related file: `src/compaction.ts`
