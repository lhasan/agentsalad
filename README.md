<p align="center">
  <img src="assets/fork.png" width="420" />
</p>

<h1 align="center">Maru (마루)</h1>

<p align="center">
  Your personal AI assistant, running on your own machine.<br/>
  No cloud. No subscription. No coding required.
</p>

<p align="center">
  <a href="PHILOSOPHY.md">Philosophy</a> ·
  <a href="docs/SERVICE_PLATFORM.md">Architecture</a> ·
  <a href="docs/DATABASE_SCHEMA.md">Database</a> ·
  <a href="docs/SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/license-Elastic--2.0-blue" />
  <img src="https://img.shields.io/badge/languages-EN%20%7C%20KO%20%7C%20JA%20%7C%20ZH-ff69b4" />
</p>

---

## What Is Maru?

Maru lets you run personal AI agents through Telegram, Discord, or Slack — using a visual dashboard.
Pick an AI provider, connect a messenger bot, choose who it talks to, and you're done.

**Agent + Channel + Target = Service.**

- Works with **Anthropic, OpenAI, Google, Groq, OpenRouter, OpenCode, Claude Code CLI**
- Talks through **Telegram, Discord, Slack**
- Runs as a **single Node.js process** on any computer you own
- **Web dashboard** — no terminal commands needed after setup
- **4 languages** — English, Korean, Japanese, Chinese

---

## Quick Start

```bash
git clone https://github.com/lhasan/agentsalad.git maru
cd maru
npm install
npm run dev
```

Open **http://127.0.0.1:3210** — if you see the dashboard, you're good.

---

## Claude Code CLI Provider

Maru supports Claude Code CLI as a provider, enabling Claude's coding capabilities directly through messenger channels.

```bash
# Ensure Claude Code CLI is installed
claude --version

# Set your API key
export ANTHROPIC_API_KEY=your-key-here

# In the dashboard, select "Claude Code CLI" as the provider
# Use model names like: sonnet, opus, haiku
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MARU_STORE_DIR` | `./store` | Data storage path |
| `WEB_UI_PORT` | `3210` | Dashboard port |
| `ANTHROPIC_API_KEY` | — | For Claude Code CLI provider |
| `BROWSER_HEADLESS` | `false` | Playwright headless mode |

---

## Origin

Maru is a fork of [AgentSalad](https://github.com/terry-uu/agentsalad) by terry-uu.
Licensed under Elastic License 2.0.
