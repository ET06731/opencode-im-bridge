# Changelog

## 0.46.0 - 2026-05-16

### Features
- Add DingTalk channel support with stream client and webhook server
- Add service launcher for auto-starting opencode server
- Add command context with fork source resolution for cross-channel reply handling
- Add fetchWithWakeRetry for waking server on incoming messages
- Improve setup wizard with interactive config prompts and env detection
- Add /variants command support with model variant selection
- Add /help card buttons for /new, /unshare, /rename, /cron commands
- Add i18n updates for new features (en/zh-CN)

### Fixes
- Fix scheduled task execution: schedule parsing, non-blocking startup, idle detection, result delivery (by @shf-275599)
- Fix /status model display to prioritize session API over file-based detection
- Improve Discord/QQ/Telegram plugin error handling and reconnection logic
- Fix card-builder for variant selector display
- Fix modelStr variable shadowing in handleStatus
- Fix CronJobSchema missing fields and package files

### Documentation
- Update README with current project structure and DingTalk support
- Update example config with new options
- Add donation QR code
- Add skills-lock.json

## 0.45.2-beta.0 - 2026-05-13

### Features
- Add service launcher for auto-starting opencode server (reliability module)
- Add DingTalk channel support with stream client and webhook server
- Add command context with fork source resolution for cross-channel reply handling
- Add fetchWithWakeRetry for waking server on incoming messages
- Improve setup wizard with interactive config prompts and env detection
- Add i18n updates for new features (en/zh-CN)
- Add QQ plugin test suite
- Add scheduled task seeder

### Fixes
- Improve Discord/QQ/Telegram plugin error handling and reconnection logic
- Fix card-builder for variant selector display
- Improve heartbeat service with service launcher integration
- Fix startup scripts for Windows bridge

### Documentation
- Update README with current project structure and DingTalk support
- Update example config with new options
- Add skills-lock.json

## 0.45.1 - 2026-05-09

### Features
- Add /variants command support with model variant selection
- Add buildVariantSelectorCard in card-builder
- Modify handleModels to show variant card after model selection
- Add i18n strings for variant-related messages
- Add /variants and /variant command routing

## 0.43.0 - 2026-03-28

### Features
- Add interactive confirm/reject cards for Feishu task preview
- Add Telegram inline keyboard support for /cron remove
- Add Discord button rows for /cron remove
- Add rich task info display in remove cards (name, ID, schedule, status, timestamps)

### Improvements
- Improve Chinese number parsing in schedule parser ("每五分钟" now works)
- Improve LLM prompt to correctly extract taskPrompt from natural language
- Inject IM context and file attachment instructions in scheduled task executor
- Add snapshotAttachments before task execution for automatic file detection and sending

### Fixes
- Fix action.nodes structure in Feishu cards (buttons should be in body.elements)
- Fix prefix stripping in schedule parser ("创建任务", "请", "帮我" now properly ignored)
