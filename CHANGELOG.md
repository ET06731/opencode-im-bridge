# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.17] - 2026-03-04

### Fixed

- Outbound media: in the event-driven flow, `sendDetectedFiles()` is now called only when no `StreamingBridge` is active, preventing duplicate uploads/sends

## [0.1.16] - 2026-03-04

### Fixed

- Outbound media 文件路径正则扩展支持中文标点，修复含中文符号的路径无法被正确识别的问题

## [0.1.15] - 2026-03-04

### Changed

- Lark 上下文签名策略调整：每条飞书消息都携带签名标记，首条消息注入完整上下文说明，后续消息仅附加简短 `[Lark]` 前缀，减少 token 消耗

### Lark MCP Integration — 2026-03-04 (18/18 tools passed)

End-to-end validation of `lark-openapi-mcp` tool chain — all tools callable directly from opencode agent:

| Category | Tools | Status |
|----------|-------|--------|
| docx | import, markdownWrite, markdownRead, rawContent, search | ✅ 5/5 |
| drive | upload, download | ✅ 2/2 |
| bitable | create app, create table, list tables, list fields, create/search/update record | ✅ 6/6 |
| im | chat list, chat members | ✅ 2/2 |
| wiki | search, getNode | ✅ 2/2 |

## [0.1.14] - 2026-03-04

### Added

- Outbound media: agent responses containing file paths are detected, validated against an allowlist, and uploaded to Feishu as images/files
- Lark context signature: first message per session includes a `[Lark]` prefix with save-file instructions so the AI knows files go to a specific directory
- Bot identity resolution: `getBotInfo()` fetches bot's open_id at startup for accurate @mention filtering in group chats
- `/sessions` command: current active session pinned at top, sessions listed as interactive card buttons for quick connection
- `/sessions` command: sessions displayed as interactive cards (no relative timestamps)
- `sessionManager.getExisting()` method for retrieving current session without creating new one
- `getAttachmentsDir()` shared utility for consistent attachment directory paths (`src/utils/paths.ts`)
- AGENTS.md files in key src/ subdirectories for contributor orientation

### Fixed

- `getBotInfo()` response parsing: Feishu `/bot/v3/info` returns `bot` at top level (not under `data`), causing empty `botOpenId` and broken group @mention filtering
- TOCTOU race condition in outbound media: all filesystem operations now use resolved `realPath` consistently
- String prefix prefilter added to `sendDetectedFiles()` in `outbound-media.ts` — skips unnecessary filesystem calls for paths outside allowlist
- Lark signature Set bounded to 1001 entries (`> 1000` triggers clear) to prevent unbounded memory growth
- 3 failing tests fixed (mock `getExisting`, group @mention test, quoted message assertion)

### Changed

- `MAX_FILE_SIZE_BYTES` split into `MAX_DOWNLOAD_BYTES` (50MB) and `MAX_UPLOAD_BYTES` (20MB) for clarity
- Deleted orphaned `src/memory/` directory (functionality previously removed)
- 8 unused variables prefixed with `_`, removed unused `Statement` import and 3 unused class fields
- `expandTilde`, `extractFilePaths`, `isImageFile` un-exported (internal-only in outbound-media.ts)
- Removed duplicate `dedup:` key in smoke test
- 6 `console.log` calls replaced with no-op in test files
- Centralized 3 hardcoded attachment directory paths to use shared `getAttachmentsDir()`

### Security

- Outbound media allowlist enforces TOCTOU-safe path resolution
- String prefix prefilter in `sendDetectedFiles()` prevents unnecessary filesystem access for non-allowlist paths
- Signature injection bounded (Set clears after exceeding 1000 entries) to prevent memory exhaustion

### Docs

- Root AGENTS.md updated: removed deleted `memory/` module references from Data Flow and Startup Phases
- Sub-directory AGENTS.md files added for handler/, feishu/, streaming/, session/, channel/, utils/

## [0.1.3] - 2026-02-26

### Fixed

- Shebang changed from `#!/usr/bin/env node` to `#!/usr/bin/env bun` — project requires Bun runtime (`bun:sqlite`)

## [0.1.2] - 2026-02-26

### Added

- Interactive CLI setup wizard: first-run experience guides new users through credential entry, server validation, `.env` creation, and auto-start
- `opencode-lark init` command to re-run the setup wizard at any time
- Minimal `.env` file parser (`loadEnvFile`) — loads environment variables before config phase

### Changed

- Startup Phase 0 added: env file loading + setup wizard check before normal boot sequence
- `needsSetup()` only triggers when no config file exists, credentials are missing, AND stdin is a TTY

### Docs

- READMEs updated: setup wizard shown as primary Quick Start path
- Added `opencode-lark init` tip for re-running wizard

## [0.1.1] - 2026-02-26

### Added

- Interactive question cards: when the AI agent asks a question, Feishu users see a card with clickable answer buttons
- Interactive permission cards: file edit, bash, and webfetch approvals rendered as Feishu cards with Allow/Reject buttons
- Card action callbacks via WebSocket long connection (`card.action.trigger`)
- Toast feedback + card replacement on button click (buttons disabled after answering)
- Interactive poller fallback: polls `/question` and `/permission` endpoints every 3s in case SSE events are missed
- Chinese README (`README.zh-CN.md`)

### Fixed

- Card action callback timeout (error 200340): handler now returns immediately within Feishu's 3s requirement
- Interactive cards sent as direct JSON instead of CardKit v2 wrapper (fixes `content type illegal` error)
- Permission event type corrected from `permission.updated` to `permission.asked`
- POST timeout no longer kills SSE listener when session is blocked on a question

### Changed

- Removed dead code: `editMessage`, `appendText`, `SessionBusy`, `ReasoningDelta`

### Docs

- Added callback subscription setup guide (Step 8) — required for interactive cards
- Added `cardkit:card:write` permission to required permissions table
- Added error 200340 to troubleshooting table

## [0.1.0] - 2026-02-25

### Initial Open-Source Release

- Feishu/Lark ↔ opencode bidirectional messaging via WebSocket long connection
- Real-time streaming cards with tool progress indicators (CardKit v2)
- Sub-agent task tracking with expandable progress cards
- Channel abstraction layer (`ChannelPlugin` interface for extensibility)
- Session management with TUI session discovery and automatic binding
- Cron scheduling service with configurable jobs
- Heartbeat monitoring with Feishu status notifications
- SQLite-backed conversation memory with context injection
- Message deduplication to prevent duplicate processing
- Configurable via JSONC config file + environment variables
- TypeScript with strict mode, zero-error build
- 248 unit + integration tests (vitest)
