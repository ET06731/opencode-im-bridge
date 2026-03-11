[English](README.md)

# opencode-im-bridge

> 将飞书\QQ群聊与 opencode TUI session 打通，实现双向实时消息转发。

![CI](https://github.com/ET06731/opencode-im-bridge/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/opencode-im-bridge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## 功能特性

- **实时桥接** — 飞书消息即时出现在 opencode TUI，agent 回复以动态卡片形式推送回飞书。
- **多渠道支持** — 现在支持通过官方 Node SDK 桥接 QQ 消息 (支持私信及文本交互)。
- **交互式卡片** — agent 的提问和权限请求以可点击的飞书卡片呈现，直接在聊天中回答或审批，无需切换到 TUI。(目前主要在飞书端支持)
- **WebSocket 长连接** — 采用飞书 / QQ 的 WebSocket 长连接模式，无需公网 IP，无需轮询。
- **SSE 流式输出** — 订阅 opencode SSE 事件流，防抖处理卡片更新，避免触发频率限制。
- **对话记忆** — SQLite 存储每个会话的对话历史，每次消息自动携带上下文。
- **Session 自动发现** — 自动发现并绑定当前目录的最新 TUI session，重启后映射关系持久保存。
- **优雅重连** — 启动时指数退避重连 opencode server，最多重试 10 次，无需手动等待 server 就绪。
- **可扩展渠道层** — `ChannelPlugin` 接口设计，可扩展接入 Slack、Discord、QQ 等其他平台，无需修改核心逻辑。
- **文件与图片支持** — 支持飞书图片和文件消息（不限于文字）。附件下载保存至 `${OPENCODE_CWD}/.opencode-lark/attachments/`，并将本地路径传给 opencode 供其读取分析。支持流式下载，50 MB 大小限制，文件名安全处理。

---

## 架构概览

```mermaid
graph TD;
    subgraph "IM 平台 (Client & Platform)"
        Feishu[飞书 群聊/私信]
        QQ[QQ 官方机器人平台]
    end

    subgraph "opencode-im-bridge (Bridge Middleware)"
        FeishuPlugin[Feishu Plugin]
        QQPlugin[QQ Plugin]
        
        FeishuPlugin <--> ChannelManager
        QQPlugin <--> ChannelManager

        ChannelManager <--> SessionManager[(SQLite 对话记忆 / Session映射)]
    end
    
    subgraph "opencode Server"
        Agent[opencode Agent Server / TUI]
    end

    Feishu <--> |Webhook/WebSocket| FeishuPlugin
    QQ <--> |WebSocket| QQPlugin
    ChannelManager <--> |HTTP POST + SSE 流式通信| Agent
```

> `opencode serve` 运行 HTTP server，在另一个终端用 `opencode attach` 查看 TUI 会话。

**入站（飞书 → TUI）：** 飞书通过 WebSocket 发送消息，opencode-im-bridge 标准化处理后找到绑定的 session，拼接对话历史，POST 到 opencode API。TUI 即时收到消息。

**出站（TUI → 飞书）：** opencode-im-bridge 订阅 opencode SSE 流。agent 输出文字时，`TextDelta` 事件累积并触发防抖卡片更新。`SessionIdle` 到达后，最终卡片推送到飞书。

### 支持的消息类型

| 消息类型 | 支持 | 说明 |
|---|---|---|
| `text` | ✅ | 普通文字消息 |
| `post` | ✅ | 富文本 / 多段落消息 |
| `image` | ✅ | 图片和截图 — 自动下载保存到本地 |
| `file` | ✅ | 文档、代码文件等 — 自动下载保存到本地 |
| `audio` / `video` / `sticker` | ❌ | 记录日志后跳过，不处理 |

下载的文件保存在 `${OPENCODE_CWD}/.opencode-lark/attachments/`（若该路径不可写则回退至系统临时目录）。

#### 斜杠命令 (Slash Commands)

在聊天窗口中输入斜杠命令可直接进行会话管理：
- `/new`：新建会话（并自动绑定到当前聊天）
- `/sessions`：获取最近会话列表及当前绑定状态（飞书返回交互式卡片，QQ 返回文本列表）
- `/connect {session_id}`：将当前聊天连接/绑定到指定的历史会话
- `/compact`：执行上下文历史压缩（对应 `session.compact`）
- `/share`：分享当前会话（对应 `session.share`）
- `/abort`：中止当前正在执行的任务
- `/help` 或 `/`：查看命令帮助菜单

---

## 安装

> **注意**：[Bun](https://bun.sh) 是必需的运行时，本项目使用 `bun:sqlite`，仅 Bun 支持。

```bash
# 全局安装
npm install -g opencode-im-bridge
# 或
bun add -g opencode-im-bridge
```

或从源码运行：

```bash
git clone https://github.com/ET06731/opencode-im-bridge.git
cd opencode-im-bridge
bun install
```

---

## 快速开始

5 分钟即可上手。你需要一个开启了机器人能力的飞书开放平台应用 — 如果还没有，请参阅下方[飞书应用配置](#飞书应用配置)完成创建。

### 前置要求

- **[Bun](https://bun.sh)**（必需运行时，本项目使用 `bun:sqlite`，仅 Bun 支持）
- **[opencode](https://opencode.ai)** 已安装在本地
- 已配置凭证的飞书开放平台应用 或 QQ 官方机器人（参见下文配置指南）

### 步骤

**1. 安装**

```bash
bun add -g opencode-im-bridge
# 或：npm install -g opencode-im-bridge
```

**2. 启动 opencode server**

```bash
OPENCODE_SERVER_PORT=4096 opencode serve
```

**3. 启动 opencode-im-bridge**

在第二个终端：

```bash
opencode-im-bridge
```

首次运行无配置时，交互式向导将引导你完成：
- 选择渠道（飞书、QQ 或 两者皆选）
- 输入飞书/QQ的 App ID、App Secret/Token（密码遮蔽输入）
- 验证 opencode server 连通性
- 保存凭证到对应的 `.env.{appId}` 文件

配置完成后服务自动启动。

> **提示**：如需重新配置，运行 `opencode-im-bridge init`。

> 如需手动配置，可在启动前创建 `.env` 文件并填写相关凭据：
> - 飞书：`FEISHU_APP_ID`, `FEISHU_APP_SECRET`
> - QQ：`QQ_APP_ID`, `QQ_SECRET`

**4. 发送测试消息**

向飞书机器人发送任意消息。首次联系时自动发现最新 TUI session 并回复：

> Connected to session: ses_xxxxx

首次消息后飞书收到 session 绑定通知，之后双向消息互通。要在 TUI 中查看：
```bash
opencode attach http://127.0.0.1:4096 --session {session_id}
```
`session_id` 会在 opencode-im-bridge 启动日志中显示（如 `Bound to TUI session: ... → ses_xxxxx`）。

---

## 飞书应用配置

本节介绍如何创建飞书企业自建应用并配置所需权限。

### 1. 创建企业自建应用

1. 打开[飞书开放平台](https://open.feishu.cn/app)
2. 点击**创建应用** → **创建企业自建应用**
3. 填写应用名称和描述后确认

### 2. 开启机器人能力

进入**应用功能 → 机器人**，开启机器人功能。

### 3. 获取凭证

进入**凭证与基础信息**找到：

- **App ID** → 设为 `FEISHU_APP_ID`
- **App Secret** → 设为 `FEISHU_APP_SECRET`

步骤 6 配置 opencode-im-bridge 时需要这些凭证。

### 4. 配置权限

进入**开发配置 → 权限管理**，开通以下权限：

| 权限 | 权限标识 | 用途 | 必需 |
|---|---|---|---|
| 获取与发送单聊、群组消息 | `im:message` | 发送消息、更新卡片 | ✅ |
| 获取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 接收私聊消息 | ✅ |
| 获取群组中所有消息 | `im:message.group_msg` | 接收群聊中的所有消息 | ✅ |
| 获取群组中 @机器人的消息 | `im:message.group_at_msg:readonly` | 接收群聊中 @机器人的消息 | ✅ |
| 获取与上传图片或文件资源 | `im:resource` | 处理消息附件 | ✅ |
| 创建并发布卡片 | `cardkit:card:write` | 渲染交互式卡片（提问、权限审批） | ✅ |

### 5. 发布应用

进入**应用发布 → 版本管理与发布**，创建版本并提交审核。审核通过后，将机器人添加到工作区。

> **注意**：测试阶段，应用管理员可直接使用，无需等待审核通过。

### 6. 配置并启动 opencode-im-bridge

在配置事件订阅之前，需要先启动 opencode-im-bridge，飞书才能检测到 WebSocket 连接。

1. 安装并配置：
   ```bash
   # 全局安装
   bun add -g opencode-im-bridge
   # 或：npm install -g opencode-im-bridge

   # 或从源码运行
   # git clone https://github.com/ET06731/opencode-im-bridge.git
   # cd opencode-im-bridge && bun install
   ```

2. 在一个终端启动 opencode server：
   ```bash
   OPENCODE_SERVER_PORT=4096 opencode serve
   ```

3. 在另一个终端启动 opencode-im-bridge：
   ```bash
   opencode-im-bridge
   ```
   交互式向导会引导你输入凭证并验证服务器连接。如从源码运行：`bun run dev`

   保持运行，然后继续下一步配置事件订阅。

> **提示**：要在 TUI 中实时查看消息，打开第三个终端并 attach 到 session：
> ```bash
> opencode attach http://127.0.0.1:4096 --session {session_id}
> ```
> `session_id` 会在 opencode-im-bridge 启动日志中显示（如 `Bound to TUI session: ... → ses_xxxxx`）。

### 7. 订阅事件

进入**开发配置 → 事件订阅**，操作如下：

1. 选择**长连接**模式 — 无需公网 IP
2. 添加以下事件：

| 事件名称 | 事件标识 | 用途 | 必需 |
|---|---|---|---|
| 接收消息 | `im.message.receive_v1` | 接收用户消息 | ✅ |

> ⚠️ **重要**：保存长连接模式前 opencode-im-bridge 必须处于运行状态（步骤 6）。如果看到"应用未建立长连接"错误，请返回步骤 6 确认应用已启动。

### 8. 订阅回调（交互式卡片）

进入**开发配置 → 事件与回调 → 回调订阅** — 这是与上方"事件订阅"**独立的配置项**。

1. 选择**长连接**模式
2. 添加以下回调：

| 回调名称 | 回调标识 | 用途 | 必需 |
|---|---|---|---|
| 卡片回传交互 | `card.action.trigger` | 接收卡片按钮点击（提问回答、权限审批） | ✅ |

> ⚠️ **重要**：这是交互式卡片（提问和权限审批）正常工作的必要配置。未配置时，点击卡片按钮会报错 `200340`。
>
> 事件订阅和回调订阅是**两个独立的设置**，必须分别配置。

### 故障排除

| 现象 | 可能原因 | 解决方案 |
|---|---|---|
| 机器人收不到消息 | 未开启长连接或事件未订阅 | 检查事件订阅，确认选择长连接模式 |
| 凭证错误 | `.env` 中凭证有误 | 从步骤 3 重新确认 App ID 和 App Secret |
| 收到消息但无回复 | opencode server 未启动 | 确保先启动 opencode server：`OPENCODE_SERVER_PORT=4096 opencode serve` |
| 卡片不实时更新 | 频率限制或防抖延迟 | 正常行为，防抖处理避免触发频率限制 |
| 点击卡片按钮报错 `200340` | 回调订阅未配置 | 进入**回调订阅** → 选择长连接 → 添加 `card.action.trigger` |
| 保存长连接模式时报"应用未建立长连接" | 应用未启动，飞书要求先建立连接 | 先完成步骤 6 启动 opencode-im-bridge，再回飞书后台保存设置 |

---

## QQ 机器人配置

本节介绍如何创建 QQ 官方机器人并接入。

### 1. 创建机器人
1. 访问 [QQ 开放平台](https://q.qq.com/bot/#/home)。
2. 创建一个“QQ 机器人”。
3. 在**开发设置**中获取：
   - **App ID** (即 `QQ_APP_ID`)
   - **App Secret** (即 `QQ_SECRET`)

### 2. 配置权限
在开放平台后台，确保开启了以下基础权限：
- 公域/私域消息回调。
- 文本/图片消息接收机制。

### 3. 配置 opencode-im-bridge
运行 `opencode-im-bridge init` 时选择 `qq` 渠道，或直接在 `.env` 中填写 `QQ_APP_ID` 和 `QQ_SECRET`。

---

## 配置说明

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | 否 | | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 否 | | 飞书应用 App Secret |
| `QQ_APP_ID` | 否 | | QQ 应用 App ID |
| `QQ_SECRET` | 否 | | QQ 应用 App Secret |
| `OPENCODE_SERVER_URL` | 否 | `http://localhost:4096` | opencode server 地址 |
| `FEISHU_WEBHOOK_PORT` | 否 | `3001` | HTTP webhook 回退端口（仅在不使用 WebSocket 接收卡片回调时需要） |
| `OPENCODE_CWD` | 否 | `process.cwd()` | 覆盖 session 发现目录 |
| `FEISHU_VERIFICATION_TOKEN` | 否 | | 事件订阅验证 token |
| `FEISHU_ENCRYPT_KEY` | 否 | | 事件加密密钥 |

### JSONC 配置文件

`opencode-im-bridge.jsonc`（已加入 .gitignore，从 `opencode-im-bridge.example.jsonc` 复制）：
（同时支持 `opencode-lark.jsonc` 和 `opencode-feishu.jsonc` 以兼容旧版）

```jsonc
// opencode-im-bridge.jsonc
{
  // 可选：启用飞书
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
    "webhookPort": 3001,
    "encryptKey": "${FEISHU_ENCRYPT_KEY}"
  },
  // 可选：启用 QQ
  "qq": {
    "appId": "${QQ_APP_ID}",
    "secret": "${QQ_SECRET}",
    "sandbox": false
  },
  // 默认 opencode agent 名称，需与 opencode 配置中的 agent 匹配。
  // 常见值："build"、"claude"、"code" — 请查看你的 opencode 配置。
  "defaultAgent": "build",
  "dataDir": "./data",
  "progress": {
    "debounceMs": 500,
    "maxDebounceMs": 3000
  }
}
```

支持 `${ENV_VAR}` 环境变量插值和 JSONC 注释。无配置文件时自动从 `.env` 构建默认配置。

---

## 项目结构

```
src/
├── index.ts         # 入口，9 阶段启动 + 优雅关闭
├── types.ts         # 共享类型定义
├── channel/         # ChannelPlugin 接口、ChannelManager、FeishuPlugin
├── feishu/          # 飞书 REST 客户端、CardKit、WebSocket、消息去重
├── handler/         # MessageHandler（入站管道）+ StreamingBridge（SSE → 卡片）
├── session/         # TUI session 发现、thread→session 映射、进度卡片
├── streaming/       # EventProcessor（SSE 解析）、SessionObserver、SubAgentTracker
├── memory/          # SQLite 驱动的会话级对话记忆
├── cron/            # CronService（定时任务）+ HeartbeatService
└── utils/           # 配置加载、日志、SQLite 初始化、EventListenerMap
```

---

## 开发

```bash
bun run dev          # 开发模式，代码变更自动重启
bun run start        # 生产模式
bun run test:run     # 运行全部测试
bun run build        # 编译到 dist/
```

> 使用 `bun run test:run` 而非 `bun test`，后者会同时扫描 `src/` 和 `dist/` 下的测试文件。

---

## 参与贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解提 issue、提 PR 和代码风格的规范。

---

## License

[MIT](LICENSE) © 2026 opencode-im-bridge contributors
