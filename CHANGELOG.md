# Changelog

All notable changes to Agent Salad will be documented in this file.

## [0.0.0] — Initial Release

Multi-provider AI agent service platform. Agent + Channel + Target = Service.

### Added
- **Service Platform model**: Agent + Channel + Target = Service
- **Multi-provider support**: Anthropic, OpenAI, Groq, OpenRouter, OpenCode via Vercel AI SDK
- **Web UI admin dashboard**: 3-tab layout (Agent Services / Agents / Skills), drag-and-drop service creation
- **4-language i18n**: EN, KO, JA, ZH with browser auto-detection
- **10 builtin skills**: file I/O, web fetch, Playwright browse, bash, Google (Gmail/Calendar/Drive), cron
- **Custom skills**: script + prompt bundles with file-based execution, per-agent toggle
- **Auto-compaction**: context window management with archival and recursive summarization
- **Cron scheduler**: daily and one-time scheduled prompts with 30s polling
- **Smart Step**: multi-step plan execution with batch loops and user interrupt detection
- **Multi-target workspaces**: per-target subfolders with shared `_shared/` directory
- **Light theme**: food-emoji decoration, custom alert/confirm modals

### Removed
- Container isolation (Docker, Apple Container)
- Claude Agent SDK dependency (replaced with Vercel AI SDK)
- Channel registry pattern (Telegram direct integration)
- IPC file-based communication
- Group-centric architecture
- MCP server infrastructure
