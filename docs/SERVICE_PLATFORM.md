# Agent Salad — Service Platform Architecture

Full architecture reference for the Agent Salad service platform.

Multi-provider, multi-channel AI agent system with direct LLM API calls via Vercel AI SDK.

---

## Core Model: Agent + Channel + Target = Service

The platform's fundamental unit is a **Service** — a bound triple of:

| Component | What it is | Storage |
|-----------|-----------|---------|
| **Agent** | LLM configuration: provider, model, system prompt, tool toggles | `agent_profiles` table |
| **Channel** | Messenger bot: Telegram, Discord, Slack with pairing state | `managed_channels` table |
| **Target** | User to serve: platform-specific user ID + nickname | `targets` table |
| **Service** | Active binding of the above three | `services` table |

- Agents and channels are 1:1 with services (one agent/channel per service)
- Targets are reusable (one person can be served by multiple agent+channel combos)
- Multiple services run concurrently in a single Node.js process
- Services track provenance: `manual` vs `everyone_template` for Web UI public/personal filtering

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    HOST (Node.js Process)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐  ┌─────────┐  ┌───────┐     │
│  │ Web UI       │   │ Telegram     │  │ Discord │  │ Slack │     │
│  │ :3210        │   │ (grammY)     │  │ (d.js)  │  │ (bolt)│     │
│  │ Admin CRUD   │   │ Bot API      │  │ Gateway │  │ Socket│     │
│  └──────┬───────┘   └──────┬───────┘  └────┬────┘  └───┬───┘     │
│         │                  │              │             │          │
│         │        ┌─────────┴──────────────┴─────────────┘          │
│         │        │  onMessage(channelId, userId, name, text)     │
│         │        ▼                                               │
│         │  ┌──────────────────────────────────────────────┐     │
│         │  │            Service Router                     │     │
│         │  │                                               │     │
│         │  │  1. findActiveService(channelId, userId)      │     │
│         │  │  2. compactIfNeeded() — auto-compaction       │     │
│         │  │  3. getConversationHistory()                  │     │
│         │  │  4. streamChat() via Provider Router          │     │
│         │  │  5. addConversationMessage() — store response │     │
│         │  │  6. channel.sendMessage() — deliver           │     │
│         │  └──────────────────┬───────────────────────────┘     │
│         │                     │                                  │
│         │                     ▼                                  │
│         │  ┌──────────────────────────────────────────────┐     │
│         │  │          Provider Router (Vercel AI SDK)      │     │
│         │  │                                               │     │
│         │  │  ┌───────────┐ ┌────────┐ ┌──────┐           │     │
│         │  │  │ Anthropic │ │ OpenAI │ │ Groq │           │     │
│         │  │  └───────────┘ └────────┘ └──────┘           │     │
│         │  │  ┌────────────┐ ┌──────────┐                 │     │
│         │  │  │ OpenRouter │ │ OpenCode │                 │     │
│         │  │  └────────────┘ └──────────┘                 │     │
│         │  └──────────────────────────────────────────────┘     │
│         │                                                        │
│         │       ┌──────────────────┐                             │
│         │       │  Cron Scheduler  │                             │
│         │       │  30s poll loop   │                             │
│         │       │  → processCron() │                             │
│         │       └──────────────────┘                             │
│         │                                                        │
│         └──▶ ┌──────────────────┐                               │
│              │   SQLite          │                               │
│              │   messages.db     │                               │
│              │                   │                               │
│              │   services        │                               │
│              │   conversations   │                               │
│              │   conv_archives   │                               │
│              │   agent_profiles  │                               │
│              │   managed_channels│                               │
│              │   targets         │                               │
│              │   llm_providers   │                               │
│              │   custom_skills   │                               │
│              │   cron_jobs       │                               │
│              │   service_crons   │                               │
│              └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Message Processing Flow

```
1. User sends message via Telegram
   │
   ▼
2. Channel adapter receives message, calls handleMessage(channelId, userId, name, text)
   │
   ▼
3. Service Router: findActiveService(channelId, userId)
   ├── No match → ignore (user not in any active service)
   └── Match found → continue
   │
   ▼
4. Store user message in conversations table
   │
   ▼
5. Auto-compaction check:
   ├── Estimate tokens (system prompt + all messages)
   ├── Compare against provider's context window × 0.75
   ├── If under threshold → skip
   └── If over threshold:
       ├── Archive all messages to conversation_archives
       ├── Ask LLM to summarize full conversation
       └── Replace all messages with single system summary
   │
   ▼
6. Build context: getConversationHistory() → message array
   │
   ▼
6b. Skill resolve: resolveSkills(agent, customPrompts)
   ├── Check agent's builtin skill toggles → create AI SDK tools
   ├── Collect enabled custom skill prompts
   └── Return { tools, skillPrompts }
   │
   ▼
7. Provider Router: streamChat(messages, systemPrompt, provider, model, apiKey, tools, skillPrompts)
   ├── Build 3-layer system prompt = SYSTEM_PROMPT_BASE + skillPrompts + agent.system_prompt
   ├── Create provider model via factory (Anthropic/OpenAI/Groq/etc.)
   ├── If tools present: streamText with tools + stopWhen(stepCountIs(10))
   ├── LLM executes tool calls automatically (file ops, web, bash, google, etc.)
   └── Stream final text response chunks
   │
   ▼
8. Store assistant response in conversations table
   │
   ▼
9. Send response through channel to user
```

---

## System Prompt Architecture (3-layer)

Three-layer system prompt, combined at call time via `buildSystemPrompt(agentPrompt, skillPrompts[])`:

| Layer | Source | Mutable | Purpose |
|-------|--------|---------|---------|
| **Layer 1: Base** | `src/providers/system-prompt.ts` | No | Core rules: response format, context awareness, safety, language matching |
| **Layer 2: Skills** | Enabled builtin + custom skill prompts | Per-agent toggle | Tool usage instructions (e.g., "You can read files using read_file") |
| **Layer 3: Agent** | `agent_profiles.system_prompt` | Yes (Web UI) | Agent personality, role, goals, custom instructions |

When `smart_step=1`, an additional Smart Step prompt is injected via `buildSmartStepPrompt()` — describes `submit_plan` / `send_message` tool usage.

## Skill System

Builtin skills (code-level tools, per-agent toggle):

| ID | Category | AI SDK Tools | Requires |
|----|----------|-------------|----------|
| `file_read` | File | `read_file(path)` | — |
| `file_write` | File | `write_file(path, content)` | — |
| `file_list` | File | `list_files(directory?)` | — |
| `web_fetch` | Web | `fetch_url(url)` | — |
| `web_browse` | Web | `browse_navigate`, `browse_content`, `browse_click`, `browse_type`, `browse_screenshot`, `browse_scroll`, `browse_wait`, `browse_links` | `playwright` (bundled) |
| `bash` | System | `run_command(command)` | — |
| `google_gmail` | Google | `gmail_search`, `gmail_send`, `gmail_read` | `gog CLI` |
| `google_calendar` | Google | `calendar_list`, `calendar_create` | `gog CLI` |
| `google_drive` | Google | `drive_list`, `drive_download`, `drive_upload` | `gog CLI` |
| `cron` | Cron | `create_cron`, `list_crons`, `delete_cron` | — |

Custom skills: script + prompt bundles stored in `custom_skills` table, per-agent toggle via `agent_custom_skills`.
When a custom skill has a `script`, it is dynamically registered as an AI SDK Tool (via `tool_name` + `input_schema` → Zod schema). Scripts execute via `child_process.exec` with agent workspace as cwd, input passed as JSON stdin + `INPUT_*` environment variables. Prompt-only skills (no script) inject system prompt text.

### Agent Workspaces (Multi-Channel + Multi-Target, 3-depth)

Each agent gets a workspace at `store/workspaces/<agent-name>/`. Within it, channels get a subfolder, and each target user gets a personal subfolder inside the channel, plus a shared `_shared/` folder at agent root:

```
store/workspaces/<agent>/
├── _shared/                    ← Shared folder (all channels, all targets can access)
├── <telegram-bot>/             ← Channel folder (type-name slug)
│   ├── <target-A>/             ← Target A's personal folder (file tool root)
│   └── <target-B>/             ← Target B's personal folder
├── <discord-bot>/              ← Another channel
│   └── <target-C>/
└── <slack-bot>/
    └── <target-D>/
```

- File tools (read/write/list) are scoped to the channel→target subfolder by default
- `_shared/` prefix in file paths routes to the agent-root shared folder
- Path traversal is blocked via `resolveWorkspacePath()`
- Channel folder name: `managed_channels.folder_name` (type-name slug)
- Target folder name: `targets.folder_name` (stable key). Auto-created targets use an ID-based slug so nickname changes do not break workspace matching.

### Tool Calling Flow

Uses Vercel AI SDK's `streamText` with `tools` and `stopWhen: stepCountIs(10)`:
1. LLM receives message + tool definitions
2. LLM may call tools (file read, web fetch, bash, etc.)
3. SDK automatically executes tools and feeds results back
4. LLM generates final text response
5. Max 10 tool-calling steps per turn

---

## Auto-Compaction

See `src/compaction.ts`.

### Token Estimation

Heuristic (no external tokenizer dependency):
- ASCII characters: ~4 chars per token
- Non-ASCII (CJK, emoji, etc.): ~1.5 chars per token
- +4 tokens overhead per message for role/framing

### Context Window Map

Known limits per `provider:model` key. Falls back to 128K for unknown models.

| Provider | Notable Models | Context Window |
|----------|---------------|----------------|
| Anthropic | Claude Sonnet 4, Opus 4, Haiku 3 | 200K |
| OpenAI | GPT-4o, GPT-4o-mini | 128K |
| OpenAI | o1, o3-mini | 200K |
| Groq | Llama 3.3 70B, Llama 3.1 8B | 128K |
| Groq | Mixtral 8x7B | 32K |
| OpenRouter / OpenCode | (proxied) | 128K default |

### Compaction Flow

```
Threshold exceeded (estimated tokens > 75% of context window)
   │
   ▼
Archive: INSERT INTO conversation_archives (service_id, messages_json, summary, ...)
   │
   ▼
Summarize: chat({ messages: [{ role: 'user', content: SUMMARIZATION_PROMPT + conversation }] })
   │
   ▼
Replace: DELETE all conversations for service → INSERT summary as role='system'
   │
   ▼
Next message: context = [summary (system)] + [new user message]
   ...later...
   Re-compact: [summary + all messages] → new summary (recursive)
```

### Configuration

| Constant | Default | Location |
|----------|---------|----------|
| `COMPACTION_THRESHOLD_RATIO` | 0.75 | `src/compaction.ts` |
| `MIN_MESSAGES_FOR_COMPACTION` | 6 | `src/compaction.ts` |
| `DEFAULT_CONTEXT_WINDOW` | 128,000 | `src/compaction.ts` |
| `MAX_HISTORY_MESSAGES` | 200 | `src/service-router.ts` |

---

## Provider Router

`src/providers/index.ts` — unified interface for all LLM providers using Vercel AI SDK.

### Supported Providers

| Provider | SDK Package | Auth |
|----------|------------|------|
| Anthropic | `@ai-sdk/anthropic` | `x-api-key` |
| OpenAI | `@ai-sdk/openai` | Bearer |
| Groq | `@ai-sdk/openai` (compatible) | Bearer |
| OpenRouter | `@ai-sdk/openai` (compatible) | Bearer |
| OpenCode | `@ai-sdk/openai` (compatible) | Bearer |

### API

```typescript
streamChat(params: ChatParams): AsyncGenerator<string>  // real-time delivery
chat(params: ChatParams): Promise<ChatResult>            // compaction summaries
```

Direct API calls to each provider — no proxy layer, minimal latency.

---

## Channel System

### Supported Channels

| Channel | Package | Connection | Public URL |
|---------|---------|-----------|------------|
| **Telegram** | `grammy` | Long-polling (Bot API) | Not required |
| **Discord** | `discord.js` | Gateway WebSocket | Not required |
| **Slack** | `@slack/bolt` | Socket Mode (WebSocket) | Not required |

All three channels use WebSocket/polling — **no public URL needed** for self-hosting.

### Channel Factory

`src/channels/factory.ts` — `createChannelByType(type, channelId, config, onMessage)` dispatches to the appropriate adapter based on `managed_channels.type`.

### Telegram (grammY)
- Bot token verification via `verifyTelegramBot()`
- Long-polling for message reception
- `sendMessage()` via Bot API

### Discord (discord.js)
- Bot token verification via `verifyDiscordBot()`
- Gateway WebSocket with Intents: Guilds, DirectMessages, GuildMessages, MessageContent
- DM: `user.send()`, requires mutual guild
- Message split at 2000 chars

### Slack (@slack/bolt)
- Token verification via `verifySlackBot()` (auth.test)
- Socket Mode: WebSocket via App-Level Token (no public URL)
- DM: `chat.postMessage()` to user channel
- Requires 2 tokens: Bot User OAuth Token + App-Level Token
- Web UI exposes `/api/integrations/slack/manifest` to prefill scopes, bot events, and Socket Mode via Slack App Manifest import

## Message Routing (DM / Room / User-in-Room)

서비스 매칭 우선순위:

| 메시지 원점 | 매칭 순서 | 응답 목적지 |
|------------|----------|-----------|
| **DM** | 1. user 서비스 → 2. everyone 템플릿 (user 자동 생성) | DM |
| **서버 채널(Room)** | 1. room 서비스 → 2. user 서비스 → 3. everyone 템플릿 (room 자동 생성) | Room |

- **응답 라우팅은 타겟 타입이 아니라 메시지 원점 기반.** 방에서 온 메시지에 user 타겟이 매칭돼도 방으로 응답한다.
- Discord/Slack에서 user 타겟은 DM뿐 아니라 서버 채널에서도 작동한다. 해당 유저가 방에서 말하면 봇이 방에서 응답.
- Room 서비스가 있으면 room 서비스가 우선 (방 전체 대상). User 서비스는 room 서비스가 없을 때만 매칭.

## Everyone Template

- `모두에게`는 실제 공유 타겟이 아니라 `에이전트 + 채널 + 모두에게` 조합으로 만드는 기본 자동 생성 템플릿이다.
- Telegram/Discord/Slack 각 플랫폼마다 시스템 기본 타겟으로 항상 노출되며, 사용자가 수동 생성/삭제하지 않는다.
- 새 DM 또는 room 메시지가 오면 해당 `userId` 또는 `roomId`로 실제 Target+Service가 생성된다.
- 기존 명시적 타겟 서비스(room 또는 user)가 있으면 그 서비스가 우선 반응한다.
- Telegram은 DM만 지원하므로 everyone 템플릿이 새 발신자별 DM 서비스를 만든다.
- Discord/Slack은 DM과 room 모두에서 같은 템플릿 규칙을 사용한다.
- everyone 템플릿에 붙은 크론은 템플릿 자신에게 발송되지 않고, 같은 `agent + channel` 그룹의 활성 개별 서비스들에 fan-out 실행된다.
- 개별 타겟 서비스에는 별도의 크론을 추가로 붙일 수 있다.
- legacy `auto_session` fallback은 폐기되었고, 퍼블릭 자동 생성은 everyone 템플릿만 사용한다.
- Web UI는 `전체 관리 / 개인 사용` 토글로 `creation_source='everyone_template'` 서비스와 그에만 연결된 타겟/크론을 분리해서 볼 수 있다.

### Channel Interface

```typescript
interface Channel {
  channelId: string;
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

---

## Cron Scheduler

`src/cron-scheduler.ts` — 30-second polling loop for scheduled task execution.

### How It Works
1. Every 30 seconds, query `service_crons` for rows where `next_run <= now`
2. For each due cron, wrap the prompt with cron metadata (name, schedule info)
3. Call `processCronMessage()` — same LLM pipeline as user messages
4. Update `next_run` for daily crons (next day same time)
5. Remove `service_crons` entry for once crons; auto-delete orphaned `cron_jobs`

### Schedule Types

| Type | `schedule_time` Format | Behavior |
|------|----------------------|----------|
| `daily` | `HH:MM` | Repeats daily at the specified time |
| `once` | ISO datetime | Executes once, then auto-removed |

---

## Web UI (Admin Dashboard)

Single-page admin interface at `http://127.0.0.1:3210`.

### 3-Tab Layout

1. **Agent Services** — Active services as `Agent → Channel → Target` chips, drag-and-drop service creation, cron attachment
2. **Agents** — Split layout: left agent list + right agent detail (name, description, provider, model, system prompt, builtin/custom skill toggles, time-aware, smart step, workspace)
3. **Skills** — Builtin skill catalog (with installation status) + custom skill CRUD

### Features
- 4-language i18n (EN/KO/JA/ZH) with browser auto-detection
- Light theme with food-emoji decoration
- Custom alert/confirm modals
- API key management modal
- Google integration guide (gog CLI)

---

## Database

SQLite via `better-sqlite3`. See [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) for full schema reference.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `ai` | Vercel AI SDK — unified LLM interface |
| `@ai-sdk/anthropic` | Anthropic provider |
| `@ai-sdk/openai` | OpenAI provider (also Groq, OpenRouter, OpenCode) |
| `grammy` | Telegram Bot API framework |
| `discord.js` | Discord Gateway API (WebSocket) |
| `@slack/bolt` | Slack SDK (Socket Mode, Bot Events) |
| `better-sqlite3` | SQLite database |
| `cron-parser` | Cron expression parsing |
| `playwright` | Headless Chromium browser automation (web_browse skill) |
| `pino` | Structured logging |
| `zod` | Tool input schema validation |

---

## Folder Structure

```
agentsalad/
├── src/
│   ├── index.ts                   # Main orchestrator
│   ├── service-router.ts          # Message processing engine
│   ├── cron-scheduler.ts          # Cron scheduler
│   ├── compaction.ts              # Auto-compaction engine
│   ├── plan-executor.ts           # Smart Step plan execution
│   ├── config.ts                  # Configuration constants
│   ├── db.ts                      # SQLite operations
│   ├── types.ts                   # Type definitions
│   ├── logger.ts                  # Pino logger setup
│   ├── timezone.ts                # Timezone utilities
│   ├── web-ui.ts                  # Admin dashboard
│   ├── channels/
│   │   ├── factory.ts             # Channel factory (type dispatch)
│   │   ├── telegram.ts            # Telegram channel (grammY)
│   │   ├── discord.ts             # Discord channel (discord.js)
│   │   └── slack.ts               # Slack channel (@slack/bolt)
│   ├── providers/
│   │   ├── index.ts               # Provider router
│   │   ├── system-prompt.ts       # Base system prompt
│   │   ├── anthropic.ts           # Anthropic adapter
│   │   ├── openai.ts              # OpenAI adapter
│   │   ├── groq.ts                # Groq adapter
│   │   ├── openrouter.ts          # OpenRouter adapter
│   │   └── opencode.ts            # OpenCode adapter
│   └── skills/
│       ├── registry.ts            # Skill resolver
│       ├── types.ts               # Skill type definitions
│       ├── workspace.ts           # Workspace management
│       ├── custom-executor.ts     # Custom skill executor
│       └── builtin/
│           ├── index.ts           # Builtin skill registration
│           ├── file-read.ts       # read_file tool
│           ├── file-write.ts      # write_file tool
│           ├── file-list.ts       # list_files tool
│           ├── web-fetch.ts       # fetch_url tool
│           ├── web-browse.ts      # Playwright browse tools (8 tools)
│           ├── browser-manager.ts # BrowserManager singleton (lifecycle, session isolation)
│           ├── bash.ts            # run_command tool
│           ├── cron.ts            # create/list/delete cron tools
│           ├── send-message.ts    # send_message tool
│           ├── submit-plan.ts     # submit_plan tool (Smart Step)
│           └── google/
│               ├── index.ts       # gog CLI availability check
│               ├── gmail.ts       # Gmail tools
│               ├── calendar.ts    # Calendar tools
│               └── drive.ts       # Drive tools
├── store/                         # Runtime data (gitignored)
│   ├── messages.db                # SQLite database
│   ├── workspaces/                # Agent workspaces
│   └── skills/                    # Custom skill scripts
├── docs/                          # Documentation
└── groups/                        # Per-group CLAUDE.md memory
```
