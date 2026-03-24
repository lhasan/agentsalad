# Agent Salad — Design Decisions

## Core Model

**Agent + Channel + Target = Service.**

A Service is the atomic unit. It binds one AI agent configuration, one messenger channel, and one target user. Multiple services run concurrently in a single Node.js process. This model is intentionally simple — no groups, no shared contexts, no permission hierarchies.

## Key Decisions

### Direct API Calls (No Containers)

The upstream used containers for OS-level isolation. This fork trades isolation for simplicity and multi-provider support:
- Any LLM provider works (Anthropic, OpenAI, Groq, OpenRouter, OpenCode)
- No Docker/container runtime dependency
- Sub-second response latency (no container spin-up)
- Tool calling via Vercel AI SDK's `streamText` with `tools`

### Web UI Over CLI

The upstream was CLI-driven via Claude Code. This fork adds a full Web UI:
- Non-developers can manage agents, channels, targets, services, and crons
- Drag-and-drop service creation
- Per-agent skill toggles
- 4-language i18n (EN/KO/JA/ZH)

### Builtin Skills Over MCP

The upstream used MCP servers for tool access. This fork uses Vercel AI SDK's native tool calling:
- 10 builtin skills registered as AI SDK tools
- Custom skills as script + prompt bundles
- Per-agent toggle in the Web UI
- No MCP server infrastructure

### Auto-Compaction

Mirrors the Claude Agent SDK's compaction pattern but implemented independently:
- Token estimation heuristic (no tokenizer dependency)
- 75% threshold triggers archival + summarization
- Recursive — handles repeated overflows
- Per-provider context window map

### Cron Scheduler

Native scheduler instead of MCP-based task management:
- 30-second polling loop
- Cron jobs are standalone entities, attachable to any service
- Daily and one-time schedule types
- Crons can self-trigger LLM responses through the same pipeline as user messages

### Single Process

Everything runs in one Node.js process:
- Telegram polling
- Service routing
- LLM API calls
- Cron scheduling
- Web UI serving
- SQLite operations

No microservices, no message queues, no worker processes.

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict) |
| LLM SDK | Vercel AI SDK v6 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) |
| Channel | grammY (Telegram Bot API) |
| Database | SQLite via `better-sqlite3` |
| Logging | Pino |
| Validation | Zod v4 |
| Cron parsing | `cron-parser` |
| Testing | Vitest |
