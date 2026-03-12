# opencode-im-bridge Configuration

This document covers the advanced configuration options for `opencode-im-bridge`, including environment variables and the JSONC configuration file.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | HTTP webhook fallback port (only needed if not using WebSocket for card callbacks) |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |
| `FEISHU_VERIFICATION_TOKEN` | no | | Event subscription verification token |
| `FEISHU_ENCRYPT_KEY` | no | | Event encryption key |

## JSONC Config

`opencode-im-bridge.jsonc` (gitignored; copy from `opencode-im-bridge.example.jsonc`):
(also supports `opencode-lark.jsonc` and `opencode-feishu.jsonc` for backward compatibility)

```jsonc
// opencode-im-bridge.jsonc
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
  },
  "messageDebounceMs": 10000,  // Debounce timer for batching rapid multi-message inputs (text=immediate, media=buffer)
  // Optional: Enable QQ
  "qq": {
    "appId": "${QQ_APP_ID}",
    "secret": "${QQ_SECRET}",
    "sandbox": false
  }
}
```

Supports `${ENV_VAR}` interpolation and JSONC comments. If no config file is found, the app builds a default config from `.env` values directly.
