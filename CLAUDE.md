# Agent Salad — Service Platform

Multi-provider AI agent platform served through messenger channels. Direct LLM API calls via Vercel AI SDK, Web UI, and a skills system.

See [docs/SERVICE_PLATFORM.md](docs/SERVICE_PLATFORM.md) for full architecture. See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) for schema reference. See [docs/RELEASE.md](docs/RELEASE.md) for build & release workflow.

## Quick Context

**Agent + Channel + Target = Service.** A single Node.js process manages multiple concurrent services. Each service binds one AI agent (any LLM provider) to one messenger channel (Telegram, Discord, or Slack) for one target (user or room). Target can be a user (DM) or a room (channel/thread). Discord/Slack support auto-session: `auto_session=1` channels auto-create Target+Service on first interaction. Direct API calls via Vercel AI SDK — no proxy, no containers for chat.

Auto-compaction (Claude SDK pattern): when conversation context exceeds 75% of the provider's context window, the engine archives the full history, asks the same LLM to summarize, and replaces all messages with the summary. Recursive — if summary + new messages overflow again, re-summarizes.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator: DB init, service router, Web UI |
| `src/service-router.ts` | Message processing engine: service matching → auto-compaction → LLM call → response + processCronMessage |
| `src/cron-scheduler.ts` | Cron scheduler: 30s polling loop, due check, prompt wrapping, once cleanup |
| `src/compaction.ts` | Token estimation, context window map, auto-compaction engine |
| `src/providers/index.ts` | Multi-provider router (Vercel AI SDK: streamChat, chat) |
| `src/providers/system-prompt.ts` | Immutable System Prompt 1 (base rules for all agents) |
| `src/providers/anthropic.ts` | Anthropic provider adapter |
| `src/providers/openai.ts` | OpenAI provider adapter |
| `src/providers/google.ts` | Google Gemini provider adapter |
| `src/providers/groq.ts` | Groq provider adapter |
| `src/providers/openrouter.ts` | OpenRouter provider adapter |
| `src/providers/opencode.ts` | OpenCode provider adapter |
| `src/channels/factory.ts` | Channel factory: createChannelByType() — Telegram/Discord/Slack 분기 |
| `src/channels/telegram.ts` | Telegram channel (grammY) |
| `src/channels/discord.ts` | Discord channel (discord.js, Gateway WebSocket, DM) |
| `src/channels/slack.ts` | Slack channel (@slack/bolt, Socket Mode, DM) |
| `src/plan-executor.ts` | Smart Step plan execution engine (batch loop, interrupt check, crash recovery) |
| `src/web-ui.ts` | Admin dashboard: 3 tabs (Agent Services / Agents / Skills), i18n, light theme |
| `src/db.ts` | SQLite: services, conversations, archives, providers, custom_skills, cron_jobs, service_crons |
| `src/types.ts` | Type definitions (ChannelType, AgentSkillToggles, CustomSkill, CronJob, ServiceCron, Service, etc.) |
| `src/skills/types.ts` | BuiltinSkill, SkillContext, ResolvedSkills interfaces |
| `src/skills/registry.ts` | resolveSkills(agent, customSkills) → tools + skillPrompts (prompt.txt file-first) |
| `src/skills/custom-executor.ts` | Custom skill executor (file-based + inline fallback, stdin JSON + env vars) |
| `src/skills/workspace.ts` | Agent workspace management (3-depth: agent/channel/target, _shared/ at agent root, name-based folders, rename tracking) |
| `src/skills/builtin/index.ts` | All 10 builtin skills registered |
| `src/skills/builtin/file-read.ts` | read_file tool (workspace scoped) |
| `src/skills/builtin/file-write.ts` | write_file tool (workspace scoped) |
| `src/skills/builtin/file-list.ts` | list_files tool (workspace scoped) |
| `src/skills/builtin/web-fetch.ts` | fetch_url tool (HTML→text) |
| `src/skills/builtin/web-browse.ts` | Playwright browse_* 8 tools (navigate, content, click, type, screenshot, scroll, wait, links) |
| `src/skills/builtin/browser-manager.ts` | BrowserManager singleton (lazy Chromium, per-service context, idle cleanup) |
| `src/skills/builtin/bash.ts` | run_command tool (workspace cwd) |
| `src/skills/builtin/google/index.ts` | gog CLI availability check + runner |
| `src/skills/builtin/google/gmail.ts` | gmail_search, gmail_send, gmail_read |
| `src/skills/builtin/google/calendar.ts` | calendar_list, calendar_create |
| `src/skills/builtin/google/drive.ts` | drive_list, drive_download, drive_upload |
| `src/skills/builtin/cron.ts` | create_cron, list_crons, delete_cron (agent self-service cron) |
| `src/skills/builtin/send-message.ts` | send_message tool (Smart Step channel delivery) |
| `src/skills/builtin/submit-plan.ts` | submit_plan tool (Smart Step plan submission) |
| `src/logger.ts` | Pino logger setup |
| `src/timezone.ts` | Timezone utilities |
| `electron/main.ts` | Electron main process: BrowserWindow, Tray, IPC, 서버 자동 감지 |
| `electron/server-manager.ts` | 서버 프로세스 spawn/kill/health-check (EventEmitter) |
| `electron/preload.ts` | contextBridge IPC 브릿지 (renderer ↔ main) |
| `electron/renderer/index.html` | Electron 상태 페이지 (stopped/starting/error UI) |
| `electron/update-checker.ts` | GitHub Release 기반 업데이트 알림 (4시간 간격 체크) |
| `electron/launch.cjs` | Electron 런처 (ELECTRON_RUN_AS_NODE 해제) |
| `electron/tsconfig.json` | Electron 전용 TS 설정 (CJS, dist-electron/) |
| `scripts/download-node.cjs` | Electron 패키징용 Node.js 바이너리 다운로더 |

## Architecture

```
User ──▶ Messenger ──▶ Channel (Telegram/Discord/Slack)
                              │
                              ▼
                     Service Router
                     ├─ DM → findActiveService(channelId, userId)
                     ├─ Channel msg → findActiveServiceByRoom(channelId, roomId)
                     ├─ No match + auto_session → tryAutoCreateSession()
                     ├─ Auto-compact if context > 75% window
                     ├─ Build context (summary + recent messages)
                     ├─ resolveSkills(agent) → tools + skillPrompts
                     └─ Stream response via Provider Router
                              │
                              ▼
                     Provider Router (Vercel AI SDK)
                     ├─ 3-layer system prompt (base + skills + agent)
                     ├─ tools + stopWhen(stepCountIs(10))
                     ├─ Anthropic  ├─ OpenAI  ├─ Google (Gemini)
                     ├─ Groq  ├─ OpenRouter └─ OpenCode
                              │
                    ┌─────────┼─────────┐ (tool calling loop)
                    ▼         ▼         ▼
              File Tools  Web Tools  Bash/Google
              (workspace)  (fetch/   (gog CLI)
                           browse)
                              │
                              ▼
                     Response ──▶ Channel ──▶ User (DM) or Room (channel)

 Cron Scheduler (30s loop)
 ├─ getDueServiceCrons()
 ├─ Wrap prompt with cron metadata
 └─ processCronMessage() ──▶ same LLM pipeline
```

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run vitest
npm run electron     # Electron 데스크톱 앱 실행
npm run electron:build  # 배포용 빌드 (.dmg / .exe / .AppImage)
```

Web UI: `http://127.0.0.1:3210`

## Electron Desktop Wrapper

`src/` 코드 무변경. `electron/` 폴더 완전 분리.

- **서버 자동 감지**: 앱 시작 시 :3210 포트 체크 → 이미 서버 떠있으면 바로 웹 UI 로드
- **서버 관리**: Start/Stop 버튼으로 `node dist/index.js` spawn/kill
- **시스템 트레이**: X 버튼 → 창 숨김 (서버 유지), Quit → 완전 종료
- **상태 감지**: 5초 간격 health check, 서버 죽으면 자동으로 상태 페이지 복귀
- **Node.js 번들링**: 패키징 시 `scripts/download-node.cjs`로 Node.js 바이너리 다운로드 → `build/node/`에 저장 → extraResources로 포함. 시스템 Node 미설치 환경에서도 동작.
- **빌드**: `electron/tsconfig.json` → CJS로 `dist-electron/`에 출력, `dist-electron/package.json`으로 CJS 강제
- **주의**: Cursor 등 Electron IDE 터미널에서 `ELECTRON_RUN_AS_NODE=1` 상속 → `launch.cjs`에서 해제

## Compaction System

Mirrors Claude Agent SDK's auto-compaction:
1. Every message: estimate tokens (ASCII ~4 chars/token, CJK ~1.5 chars/token)
2. If total context > 75% of provider's context window → compact
3. Archive full conversation to `conversation_archives` table
4. Ask same LLM to summarize all messages
5. Replace all messages with single system summary
6. Summary + new messages overflow → re-summarize (recursive)

Config: `src/compaction.ts` — threshold ratio, min messages, context window map.

