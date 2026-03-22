# wechat/

WeChat iLink Bot API channel integration.

## Overview

WeChat integration uses the official iLink Bot API published by Tencent via OpenClaw framework. This enables bridging WeChat messages with opencode TUI sessions.

## Architecture

```
WeChat Client
    ↓
iLink Bot API (ilinkai.weixin.qq.com)
    ↓
WechatPlugin (src/channel/wechat/)
    ↓
SessionManager + opencode HTTP API
```

## Files

### `types.ts`
- iLink API type definitions
- Message types (WechatMessage, MessageItem)
- Session types (WechatSession)
- Config types (WechatConfig)

### `client.ts`
- HTTP API client with `X-WECHAT-UIN` header (anti-replay)
- `getUpdates()` - Long polling for incoming messages
- `sendMessage()` - Send text to WeChat
- `getQrcode()` / `getQrcodeStatus()` - QR login flow

### `auth.ts`
- QR code login flow
- Session token persistence (saved to `wechat-session.json`)
- `ensureSession()` - Load existing or perform new login

### `wechat-plugin.ts`
- Implements `ChannelPlugin` interface
- Gateway: Long polling loop for message reception
- Outbound: Send messages with `context_token`
- Stores per-user `context_token` for reply routing

## Key Differences from Other Channels

| Aspect | Feishu/QQ/Telegram | WeChat |
|--------|-------------------|--------|
| Protocol | WebSocket | HTTP Long Polling |
| Auth | App credentials | QR code login |
| Message token | message_id | `context_token` (required for reply) |
| Session | Stored in config | Stored in separate session file |

## Configuration

```jsonc
{
  "wechat": {
    "enabled": true,
    "sessionFile": "./data/wechat-session.json"
  }
}
```

Environment variable: `WECHAT_ENABLED=true`

## Gotchas

- WeChat requires QR code login on first run
- `context_token` must be included in every reply
- Long polling timeout is 35 seconds
- Session file stores bot_token and baseUrl
