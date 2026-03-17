<p align="center">
  <img src="assets/fork.png" width="420" />
</p>

<h1 align="center">Agent Salad</h1>

<p align="center">
  Your own AI agent, running on your own machine.<br/>
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
  <img src="https://img.shields.io/badge/channel-Telegram-26A5E4?logo=telegram&logoColor=white" />
</p>

---

## What Is This?

Agent Salad lets anyone run AI agents through Telegram — using a visual dashboard.
Pick an AI provider, connect a messenger bot, choose who it talks to, and you're done.

**Agent + Channel + Target = Service.**

- Works with **Anthropic, OpenAI, Groq, OpenRouter, OpenCode**
- Talks through **Telegram**
- Runs as a **single Node.js process** on any computer you own
- **Web dashboard** — no terminal commands needed after setup
- **4 languages** — English, Korean, Japanese, Chinese

---

## Quick Start

```bash
git clone https://github.com/terry-uu/agentsalad.git
cd agentsalad
npm install
npm run dev
```

Open **http://127.0.0.1:3210** — if you see the dashboard, you're good.

<details>
<summary><strong>macOS</strong> — detailed setup</summary>

Git comes pre-installed. Just install Node.js:

```bash
# Option A: Download from https://nodejs.org (LTS version)

# Option B: Using Homebrew
brew install node@22
```

Open **Terminal** (search "Terminal" in Spotlight) and run the Quick Start commands above.

</details>

<details>
<summary><strong>Windows</strong> — requires WSL2</summary>

**Step 1: Install WSL2**

Open **PowerShell as Administrator**:

```powershell
wsl --install
```

Restart your computer. Ubuntu will set up automatically — create a username and password when prompted.

**Step 2: Install Node.js inside WSL**

Open the **Ubuntu** app from Start menu:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

**Step 3:** Run the Quick Start commands above inside Ubuntu.

</details>

<details>
<summary><strong>Linux (Ubuntu / Debian)</strong></summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

Then run the Quick Start commands above.

</details>

---

## Story

Before Agent Salad, I was building something called **Celi** — an agent that evolves with you by sharing your knowledge system. OpenAI and Claude weren't learning me the way I intended, and I couldn't own or archive the data they learned. Vector DBs, RAG, MCP — I was throwing everything at it to build an agent that truly replaces me.

Then [Moltbot](https://github.com/moltbot/moltbot) launched. I was devastated. The approach was almost identical to mine. Why build my own when I could just use theirs?

So I tried it. Moltbot was hardcore. Every feature imaginable was already built. Honestly, learning all those features felt harder than building them myself. Bugs everywhere. I spent days bouncing between TUI, WebUI, and Telegram, restarting the gateway thousands of times. Eventually, I gave up.

Here's something you might have noticed: **I'm not a developer.** I didn't know how to code five months ago. I've been vibe-coding for five months. Over a decade in IT product planning and management — but writing code? That's new.

Around that time, I met a friend — an aspiring actor. She spends three to four hours every day browsing casting forums and writing application emails by hand. She said ChatGPT won't do it for her. AI is flipping the world upside down, but she couldn't access any of it.

I told her about Moltbot. *"Just buy a Mac Mini and everything's solved!"*

After actually using Moltbot myself, I regretted saying that. I could picture exactly what would happen: she'd buy the Mac Mini, have some daemon running somewhere she couldn't see, spend all day fighting with Telegram — *"Why won't you answer! How do I stop this!"* — and next month, find her $100 Anthropic credit drained to zero.

Vibe coding has narrowed the gap between developers and everyone else. But the real benefits still aren't reaching everyone. We marvel at AI every day, yet we lack sensitivity toward people who aren't digitally fluent. For them, even the "easy" tools are just a wall of jargon.

So I decided: **if my friend buys a Mac Mini, I'll make the easiest possible agent platform she can install and use immediately.** And if even that's too hard, I'll set up the agent myself and serve it to her Telegram directly.

That's when I found [NanoClaw](https://github.com/qwibitai/nanoclaw). Learned a lot from it. Grateful for it.

What I actually built is this: I took complex agent platform concepts, defined them, grouped them, and visualized them. If you can read text and try things — you can run an agent on your own machine and serve it to your family, friends, and coworkers.

It's not perfect. But I'll keep improving it.

---

## How It Works

In Agent Salad, a service is called a **Salad**.

A Salad has three ingredients:

| Ingredient | What it is |
|------------|-----------|
| **Agent** | The AI brain — provider, model, system prompt, and skills |
| **Channel** | The messenger — a Telegram bot |
| **Target** | Who it talks to — a Telegram user |

Combine the three and your service starts immediately. No terminal commands. Just drag, drop, and click **Make**.

<video src="assets/make-salad.mp4" autoplay loop muted playsinline></video>

### Skills

An Agent carries a **system prompt** and **skills**.

**Builtin skills** come out of the box — file read/write, shell commands, web fetch, and Google services (Gmail, Calendar, Drive) via CLI.

**Custom skills** handle everything else. Choose whether your skill needs a script or not. If it does, a skill folder is created with a guide document and a script file — this part requires development. Wire it to an n8n workflow, write your own logic, whatever works — the agent just executes it and handles the rest.

Every skill includes a prompt that tells the agent how to use its tools.

### Cron

A Cron has a **time**, a **prompt**, and a **skill hint**.

Attach a Cron to a Salad, and the prompt fires to the agent on schedule. The skill hint tells the agent which tools it needs for that job.

<video src="assets/attach-cron.mp4" autoplay loop muted playsinline></video>

### Multi-Target

A single Salad can serve **multiple targets**. A teacher registers all their students' Telegram accounts, creates one Salad, and the agent runs independent sessions with each student through one bot. Attach a Cron — homework quizzes go out to everyone at once.

Each agent also has a **shared folder** that all targets can access — useful for teamwork.

### Providers

Agent Salad was built with accessibility in mind. Free models matter. **OpenRouter** is the default provider for broad model access, and **OpenCode** is available for coding-focused workflows. The big three — OpenAI, Anthropic, Groq — are fully supported, all powered by Vercel AI SDK.

> My dream is to live as a wanderer. I can't open a laptop while walking down the street. But I can open Telegram. That's what Agent Salad is for.

---

## First-Time Setup

> 5 minutes. All done from the web dashboard.

**1. Add an API Key** — Click **API Key Settings** at the top. Enter provider name and paste your key.

**2. Create an Agent** — Go to **Agents** tab → **+ Create Agent**. Pick a provider, model, system prompt, and skills.

**3. Connect Telegram** — Go to **Agent Services** tab → **+ Add** under Channels. Paste your bot token.

**4. Add a Target** — **+ Add** under Targets. Enter the Telegram user ID and a nickname.

**5. Make a Salad** — Drag an Agent, a Channel, and a Target into the salad bowl. Done.

Open Telegram and start chatting.

<details>
<summary>Getting an API Key</summary>

| Provider | Where to get it |
|----------|----------------|
| Anthropic | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| OpenCode | [opencode.ai/auth](https://opencode.ai/auth) |

</details>

<details>
<summary>Creating a Telegram Bot</summary>

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the **token** it gives you (looks like `123456789:ABCdef...`)

To find your **Telegram user ID**: search for **@userinfobot** on Telegram and send it any message.

</details>

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-provider** | Anthropic, OpenAI, Groq, OpenRouter, OpenCode via Vercel AI SDK |
| **10 builtin skills** | File I/O, web fetch, browser automation, bash, Google (Gmail/Calendar/Drive), cron |
| **Custom skills** | Create your own script or prompt-based tools |
| **Auto-compaction** | Automatically summarizes when conversation gets too long |
| **Cron scheduler** | Schedule recurring tasks — daily summaries, morning briefings |
| **Smart Step** | Multi-step plan execution with interrupt detection |
| **Web dashboard** | Visual drag-and-drop, 4 languages |

---

## Keeping It Running

> Your agent only works while the program is running and the computer is on.
> Think of it like a Wi-Fi router — unplug it, the Wi-Fi stops.

**Quick run** — `npm run dev` starts in your terminal. Close terminal = agent stops.

**Always-on** — use pm2 for 24/7 operation:

```bash
npm run build
npm install -g pm2

pm2 start dist/index.js --name agentsalad
pm2 save
pm2 startup
```

<details>
<summary>Prevent your computer from sleeping</summary>

| Platform | How |
|----------|-----|
| **macOS** | System Settings > Energy > Disable "Put hard disks to sleep", enable "Prevent automatic sleeping when the display is off" |
| **Linux** | `sudo systemctl mask sleep.target suspend.target hibernate.target` |
| **Windows (WSL2)** | Settings > System > Power > Set sleep to "Never" |

</details>

<details>
<summary>pm2 commands</summary>

```bash
pm2 status              # check if running
pm2 logs agentsalad     # see what the agent is doing
pm2 restart agentsalad  # restart
pm2 stop agentsalad     # stop
```

</details>

---

## Development

```bash
npm run dev          # Hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
npm run format       # Format code
```

Dashboard: `http://127.0.0.1:3210` · Health check: `http://127.0.0.1:3210/api/health`

---

## Philosophy

> We want a world where running your own AI agent is as normal as running your own Wi-Fi router.
> Not a luxury. Not a service you subscribe to. Just something you set up once and it works for you.

Read [PHILOSOPHY.md](PHILOSOPHY.md) for the full story.

## Contact

Ideas, feedback, or collaboration — reach out anytime.

**terry.youu@gmail.com**

## License

[Elastic License 2.0](LICENSE) — Free to use, modify, and distribute. Cannot be offered as a managed service.
