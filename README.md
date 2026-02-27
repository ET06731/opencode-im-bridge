[中文版](README.zh-CN.md)

# opencode-lark

> Bridge Feishu group chats to opencode TUI sessions with real-time two-way messaging.

![CI](https://github.com/guazi04/opencode-lark/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/opencode-lark.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## Features

- **Real-time bridging** — Messages sent in Feishu arrive in your opencode TUI instantly, and agent replies stream back as live-updating cards.
- **Interactive cards** — Agent questions and permission requests appear as clickable Feishu cards. Answer or approve directly from the chat — no need to switch to the TUI.
- **WebSocket connection** — Uses Feishu's long-lived WebSocket mode. No webhook polling, no public IP required.
- **SSE streaming** — Consumes the opencode SSE event stream and debounces card updates to stay within rate limits.
- **Conversation memory** — SQLite-backed per-thread history is prepended to each message, giving the agent context across turns.
- **Session auto-discovery** — Finds and binds to the latest opencode TUI session for a working directory. Survives restarts.
- **Graceful recovery** — Reconnects to the opencode server with exponential backoff (up to 10 attempts) on startup.
- **Extensible channel layer** — `ChannelPlugin` interface lets you add Slack, Discord, or any other platform without touching core logic.

---

## Architecture

```
Feishu client
    ↕  WebSocket
Feishu Open Platform
    ↕  WebSocket
opencode-lark  (this project)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

> `opencode serve` runs the HTTP server. Use `opencode attach` in a separate terminal to view the session in TUI.

**Inbound (Feishu → TUI):** Feishu sends a message over WebSocket. opencode-lark normalizes it, resolves the bound session, prepends conversation history, then POSTs to the opencode API. The TUI sees the message immediately.

**Outbound (TUI → Feishu):** opencode-lark subscribes to the opencode SSE stream. As the agent produces text, `TextDelta` events accumulate and a debounced card update fires. Once `SessionIdle` arrives, the final card is flushed to Feishu.

---

## Install

> **Note**: [Bun](https://bun.sh) is the required runtime — this project uses `bun:sqlite` which is Bun-only.

```bash
# Global install
npm install -g opencode-lark
# or
bun add -g opencode-lark
```

Or clone and run from source:

```bash
git clone https://github.com/guazi04/opencode-lark.git
cd opencode-lark
bun install
```

---

## Quick Start

Get up and running in 5 minutes. You'll need a Feishu Open Platform app with bot capability — see [Feishu App Setup](#feishu-app-setup) below for the detailed walkthrough if you haven't created one yet.

### Prerequisites

- **[Bun](https://bun.sh)** (required runtime — this project uses `bun:sqlite` which is Bun-only)
- **[opencode](https://opencode.ai)** installed locally
- A **Feishu Open Platform app** with credentials and event subscriptions configured (see [Feishu App Setup](#feishu-app-setup))

### Steps

**1. Install and configure**

```bash
# Global install (recommended)
bun add -g opencode-lark
# or: npm install -g opencode-lark
```

Create a working directory and `.env` file:
```bash
mkdir opencode-lark-config && cd opencode-lark-config
echo 'FEISHU_APP_ID=your_app_id' >> .env
echo 'FEISHU_APP_SECRET=your_app_secret' >> .env
```

Or clone and run from source:
```bash
git clone https://github.com/guazi04/opencode-lark.git
cd opencode-lark
bun install
cp .env.example .env
```

Open `.env` and fill in `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

**2. Start opencode server**

```bash
OPENCODE_SERVER_PORT=4096 opencode serve
```

The opencode server listens on port 4096 by default (increments if that port is taken).

**3. Start opencode-lark**

In a second terminal:

```bash
opencode-lark
```

If running from source: `bun run dev`

`dev` mode runs with `--watch`, so code changes trigger an automatic restart.

**4. Send a test message**

Send any message to your Feishu bot. On first contact it auto-discovers the latest TUI session and replies:

> Connected to session: ses_xxxxx

After that, Feishu and the TUI share a live two-way channel. To attach the TUI:
```bash
opencode attach http://127.0.0.1:4096 --session {session_id}
```
The `session_id` is shown in opencode-lark's startup logs (e.g. `Bound to TUI session: ... → ses_xxxxx`).

---

## Feishu App Setup

### 1. Create an Internal App

1. Open [Feishu Open Platform](https://open.feishu.cn/app)
2. Click **Create App** → **Create Internal App**
3. Fill in app name and description, then confirm

### 2. Enable Bot Capability

Navigate to **App Features → Bot** and enable the bot capability.

### 3. Get Credentials

Navigate to **Credentials & Basic Info** to find:

- **App ID** → set as `FEISHU_APP_ID`
- **App Secret** → set as `FEISHU_APP_SECRET`

You'll need these in Step 6 to configure opencode-lark.

### 4. Configure Permissions

Navigate to **Development Config → Permissions & Scopes** and add the following:

| Permission | Scope Identifier | Purpose | Required |
|---|---|---|---|
| 获取与发送单聊、群组消息 | `im:message` | Send messages & update cards | ✅ |
| 获取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | Receive direct messages | ✅ |
| 获取群组中所有消息 | `im:message.group_msg` | Receive all group messages | ✅ |
| 获取群组中 @机器人的消息 | `im:message.group_at_msg:readonly` | Receive group messages that @mention the bot | ✅ |
| 获取与上传图片或文件资源 | `im:resource` | Handle message attachments | ✅ |
| 创建并发布卡片 | `cardkit:card:write` | Render interactive cards (questions, permissions) | ✅ |

### 5. Publish the App

Navigate to **App Release → Version Management & Release**, create a version and submit for review. After approval, add the bot to your workspace.

> **Note**: Internal apps in trial status can be used by app administrators immediately without review for testing.

### 6. Configure & Start opencode-lark

Before configuring event subscriptions, start opencode-lark so Feishu can detect the WebSocket connection.

1. Install and configure:
   ```bash
   # Install globally
   bun add -g opencode-lark
   # or: npm install -g opencode-lark

   # Or run from source
   # git clone https://github.com/guazi04/opencode-lark.git
   # cd opencode-lark && bun install
   ```

2. Create a working directory and configure credentials:
   ```bash
   mkdir opencode-lark-config && cd opencode-lark-config
   ```
   Create a `.env` file with your credentials:
   ```bash
   echo 'FEISHU_APP_ID=your_app_id' >> .env
   echo 'FEISHU_APP_SECRET=your_app_secret' >> .env
   ```

3. Start opencode server in one terminal:
   ```bash
   OPENCODE_SERVER_PORT=4096 opencode serve
   ```

4. Start opencode-lark in another terminal:
   ```bash
   opencode-lark
   ```
   If running from source: `bun run dev`

   Keep this running while you configure event subscriptions in the next step.

> **Tip**: To see messages in real-time in the TUI, open a third terminal and attach to the session:
> ```bash
> opencode attach http://127.0.0.1:4096 --session {session_id}
> ```
> The `session_id` is shown in opencode-lark's startup logs (e.g. `Bound to TUI session: ... → ses_xxxxx`).

### 7. Subscribe to Events

Navigate to **Development Config → Event Subscriptions** and:

1. Select **Long Connection** (WebSocket) mode — no public IP required
2. Add the following event:

| Event Name | Event Identifier | Purpose | Required |
|---|---|---|---|
| 接收消息 | `im.message.receive_v1` | Receive all user messages | ✅ |

> ⚠️ **Important**: opencode-lark must be running (Step 6) before you can save Long Connection mode. If you see "应用未建立长连接", go back to Step 6 and ensure the app is running.

### 8. Subscribe to Callbacks (Interactive Cards)

Navigate to **Development Config → Event Subscriptions → Callback Subscription** (回调订阅) — this is a **separate section** from Event Subscription above.

1. Select **Long Connection** (WebSocket) mode
2. Add the following callback:

| Callback Name | Callback Identifier | Purpose | Required |
|---|---|---|---|
| 卡片回传交互 | `card.action.trigger` | Receive card button clicks (question answers, permission replies) | ✅ |

> ⚠️ **Important**: This is required for interactive cards (questions & permissions). Without it, clicking card buttons shows error `200340`.
>
> Event Subscription and Callback Subscription are **two separate settings**. You must configure both.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Bot doesn't receive messages | WebSocket not enabled or wrong subscription | Check event subscription, ensure Long Connection mode is selected |
| "Invalid App ID or Secret" | Wrong credentials in .env | Double-check App ID and App Secret from Step 3 |
| Messages received but no reply | opencode server not running | Ensure opencode server is running: `OPENCODE_SERVER_PORT=4096 opencode serve` |
| Card not updating in real-time | Rate limit or debounce delay | Normal behavior — updates are debounced to stay within Feishu rate limits |
| Error `200340` when clicking card buttons | Callback subscription not configured | Go to **Callback Subscription** (回调订阅) → select Long Connection → add `card.action.trigger` |
| "应用未建立长连接" when saving Long Connection mode | App not running — Feishu requires an active WebSocket connection before saving | Start opencode-lark first (Step 6), then save the setting in Feishu console |

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | HTTP webhook fallback port (only needed if not using WebSocket for card callbacks) |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |
| `FEISHU_VERIFICATION_TOKEN` | no | | Event subscription verification token |
| `FEISHU_ENCRYPT_KEY` | no | | Event encryption key |

### JSONC Config

`opencode-lark.jsonc` (gitignored; copy from `opencode-lark.example.jsonc`):
(also supports `opencode-feishu.jsonc` for backward compatibility)

```jsonc
// opencode-lark.jsonc
{
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
    "webhookPort": 3001,
    "encryptKey": "${FEISHU_ENCRYPT_KEY}"
  },
  // Default opencode agent name. This should match an agent configured in your opencode setup.
  // Common values: "build", "claude", "code" — check your opencode config for available agents.
  "defaultAgent": "build",
  "dataDir": "./data",
  "progress": {
    "debounceMs": 500,
    "maxDebounceMs": 3000
  }
}
```

Supports `${ENV_VAR}` interpolation and JSONC comments. If no config file is found, the app builds a default config from `.env` values directly.

---

## Project Structure

```
src/
├── index.ts         # Entry point, 9-phase startup + graceful shutdown
├── types.ts         # Shared type definitions
├── channel/         # ChannelPlugin interface, ChannelManager, FeishuPlugin
├── feishu/          # Feishu REST client, CardKit, WebSocket, message dedup
├── handler/         # MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── session/         # TUI session discovery, thread→session mapping, progress cards
├── streaming/       # EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── memory/          # SQLite-backed per-thread conversation history
├── cron/            # CronService (scheduled jobs) + HeartbeatService
└── utils/           # Config loader, logger, SQLite init, EventListenerMap
```

---

## Development

```bash
bun run dev          # Watch mode, auto-restart on changes
bun run start        # Production mode
bun run test:run     # Run all tests (vitest)
bun run build        # Compile TypeScript to dist/
```

> **Note:** Use `bun run test:run` rather than `bun test`. The latter picks up both `src/` and `dist/` test files; `vitest` is configured to scope to `src/` only.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on issues, pull requests, and code style.

---

## License

[MIT](LICENSE) © 2026 opencode-lark contributors
