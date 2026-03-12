# opencode-im-bridge 配置说明

本文档详细说明了 `opencode-im-bridge` 的变量替换与配置文件选项。

## 环境变量

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

## JSONC 配置文件

`opencode-im-bridge.jsonc`（已加入 .gitignore，可从 `opencode-im-bridge.example.jsonc` 复制）：
（为了兼容，同时也支持加载 `opencode-lark.jsonc` 和 `opencode-feishu.jsonc` 文件）

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

支持 `${ENV_VAR}` 环境变量插值和 JSONC 注释。无配置文件时系统将自动从 `.env` 和进程环境构建默认配置。
