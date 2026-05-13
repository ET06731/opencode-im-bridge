/**
 * Interactive CLI setup wizard for opencode-lark.
 * Guides new users through Feishu credentials, server connection, and .env creation.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as readline from "node:readline/promises"
import { createLogger } from "../utils/logger.js"
import {
  listEnvFiles,
  ensureConfigDir,
  CONFIG_DIR,
  DEFAULT_SERVER_URL,
  DEFAULT_LAUNCHER_COMMAND,
  shouldBootstrapLauncher,
  buildLauncherEnvLines,
} from "../utils/env-loader.js"

const logger = createLogger("setup-wizard")

// ANSI color helpers
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

/** Config file search paths — must match src/utils/config.ts lines 69-76 */
const CONFIG_SEARCH_PATHS = [
  path.resolve("opencode-lark.jsonc"),
  path.resolve("opencode-lark.json"),
  path.resolve("opencode-feishu.jsonc"),
  path.resolve("opencode-feishu.json"),
]

/**
 * Check whether interactive setup is needed.
 * Returns true only when no env files exist in CONFIG_DIR, no env credentials are set,
 * no config files exist in cwd, and stdin is a TTY (so we can prompt).
 */
export async function needsSetup(): Promise<boolean> {
  // 1. Env files exist in CONFIG_DIR → no setup needed
  if (listEnvFiles().length > 0) return false

  // 2. Config file exists in cwd → no setup needed
  for (const p of CONFIG_SEARCH_PATHS) {
    if (fs.existsSync(p)) return false
  }

  // 3. Env vars already provide credentials → no setup needed
  const hasFeishu = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
  const hasQq = !!(process.env.QQ_APP_ID && process.env.QQ_SECRET)
  const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN
  const hasDiscord = !!process.env.DISCORD_BOT_TOKEN
  const hasWechat = process.env.WECHAT_ENABLED === "true"
  if (hasFeishu || hasQq || hasTelegram || hasDiscord || hasWechat) {
    return false
  }

  // 4. Non-interactive environment → skip
  if (process.stdin.isTTY !== true) return false

  return true
}

/**
 * Read a single line with masked input (shows * per character).
 * Uses raw-mode stdin to intercept each keypress.
 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const buf: string[] = []

    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    const onData = (key: string) => {
      for (const ch of key) {
        const code = ch.charCodeAt(0)

        // Ctrl+C
        if (code === 0x03) {
          process.stdin.setRawMode(wasRaw ?? false)
          process.stdin.pause()
          process.stdin.removeListener("data", onData)
          process.stdout.write("\n")
          process.exit(0)
        }

        // Enter
        if (code === 0x0d || code === 0x0a) {
          process.stdin.setRawMode(wasRaw ?? false)
          process.stdin.pause()
          process.stdin.removeListener("data", onData)
          process.stdout.write("\n")
          resolve(buf.join(""))
          return
        }

        // Backspace
        if (code === 0x7f || code === 0x08) {
          if (buf.length > 0) {
            buf.pop()
            process.stdout.write("\b \b")
          }
          continue
        }

        // Regular printable character
        if (code >= 0x20) {
          buf.push(ch)
          process.stdout.write("*")
        }
      }
    }

    process.stdin.on("data", onData)
  })
}

/**
 * Interactive config picker for multiple Feishu accounts.
 * Returns the selected env file path, or null if no configs exist.
 */
export async function pickConfig(): Promise<string | null> {
  const envFiles = listEnvFiles()
    .sort((a, b) => a.appId.localeCompare(b.appId) || a.filePath.localeCompare(b.filePath))

  if (envFiles.length === 0) return null

  // 1. Check if a specific config is requested via argument --config <appId>
  const configArgIndex = process.argv.indexOf("--config")
  if (configArgIndex !== -1 && process.argv.length > configArgIndex + 1) {
    const requestedAppId = process.argv[configArgIndex + 1]
    const matched = envFiles.find(e => e.appId === requestedAppId)
    if (matched) {
      process.stdout.write(`Auto-selecting requested config: ${matched.appId}\n`)
      return matched.filePath
    }
    process.stdout.write(red(`Requested config '${requestedAppId}' not found.\n`))
    throw new Error(`Requested config '${requestedAppId}' not found.`)
  }

  // 2. Check if a specific config is requested via ENV OPENCODE_IM_CONFIG
  const envAppId = process.env.OPENCODE_IM_CONFIG
  if (envAppId) {
    const matched = envFiles.find(e => e.appId === envAppId)
    if (matched) {
      process.stdout.write(`Auto-selecting requested config from ENV: ${matched.appId}\n`)
      return matched.filePath
    }
    process.stdout.write(red(`Requested config from ENV '${envAppId}' not found.\n`))
    throw new Error(`Requested config from ENV '${envAppId}' not found.`)
  }

  if (envFiles.length === 1 || !process.stdin.isTTY) {
    const first = envFiles[0]!
    if (!process.stdin.isTTY && envFiles.length > 1) {
      process.stdout.write(`Non-interactive environment detected. Auto-selecting config 1: ${first.appId}\n`)
    } else {
      process.stdout.write(`Auto-selecting config: ${first.appId}\n`)
    }
    return first.filePath
  }

  // Multiple configs — show picker
  process.stdout.write("\nAvailable configurations:\n")
  for (let i = 0; i < envFiles.length; i++) {
    process.stdout.write(`  ${i + 1}. ${envFiles[i]!.appId}\n`)
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const answer = await rl.question(`Select [1]: `)
    const trimmed = answer.trim()
    const index = trimmed === "" ? 0 : parseInt(trimmed, 10) - 1

    if (isNaN(index) || index < 0 || index >= envFiles.length) {
      process.stdout.write(red("Invalid selection, using first config.\n"))
      return envFiles[0]!.filePath
    }

    return envFiles[index]!.filePath
  } catch {
    // Ctrl+C or other error
    return envFiles[0]!.filePath
  } finally {
    rl.close()
  }
}

/**
 * Run the 4-step interactive setup wizard.
 */
export async function runSetupWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    // ── Welcome ──
    process.stdout.write(
      `\n${bold("🚀 Welcome to opencode-im (Cross-platform Edition)!")}\n\nNo configuration found. Let's set things up.\n\n`,
    )

    // ── Step 1/3: Channel Selection & Credentials ──
    process.stdout.write(dim("Step 1/3: Channel Credentials") + "\n")

    let setupFeishu = false
    let setupQq = false
    let setupTelegram = false
    let setupDiscord = false
    let setupWechat = false
    while (!setupFeishu && !setupQq && !setupTelegram && !setupDiscord && !setupWechat) {
      const choice = (await rl.question("  Which channel do you want to configure? [feishu, qq, telegram, discord, wechat, all]: ")).trim().toLowerCase()
      if (choice === "feishu" || choice === "all") setupFeishu = true
      if (choice === "qq" || choice === "all") setupQq = true
      if (choice === "telegram" || choice === "all") setupTelegram = true
      if (choice === "discord" || choice === "all") setupDiscord = true
      if (choice === "wechat" || choice === "all") setupWechat = true
      if (!setupFeishu && !setupQq && !setupTelegram && !setupDiscord && !setupWechat) process.stdout.write(red("  Please select at least one valid channel.") + "\n")
    }

    let feishuAppId = "", feishuAppSecret = ""
    if (setupFeishu) {
      process.stdout.write("\n" + dim("--- Feishu Configuration ---") + "\n")
      while (!feishuAppId) {
        feishuAppId = (await rl.question("  Enter your Feishu App ID: ")).trim()
      }
      // Close rl temporarily so we can use raw mode for secret input
      rl.close()
      while (!feishuAppSecret) {
        feishuAppSecret = (await readSecret("  Enter your Feishu App Secret: ")).trim()
      }
      process.stdout.write("\n")
    }

    let qqAppId = "", qqSecret = ""
    let qqSandbox = false
    if (setupQq) {
      // If rl was closed by feishu secret input, reopen it or adjust approach
      // Wait, readSecret works without readline interface
      const rlQq = setupFeishu ? readline.createInterface({ input: process.stdin, output: process.stdout }) : rl
      process.stdout.write("\n" + dim("--- QQ Bot Configuration ---") + "\n")
      while (!qqAppId) {
        qqAppId = (await rlQq.question("  Enter your QQ App ID: ")).trim()
      }
      if (setupFeishu) rlQq.close()
      else rl.close()

      while (!qqSecret) {
        qqSecret = (await readSecret("  Enter your QQ App Secret: ")).trim()
      }
      process.stdout.write("\n")
    } else if (!setupFeishu) {
      rl.close()
    }

    let telegramBotToken = ""
    let telegramAllowedChatIds = ""
    if (setupTelegram) {
      const rlTg = setupFeishu || setupQq
        ? readline.createInterface({ input: process.stdin, output: process.stdout })
        : rl
      process.stdout.write("\n" + dim("--- Telegram Bot Configuration ---") + "\n")
      process.stdout.write(dim("  Get a bot token from @BotFather on Telegram.") + "\n")
      if (setupFeishu || setupQq) rlTg.close()
      else if (!setupDiscord) rl.close()
      while (!telegramBotToken) {
        telegramBotToken = (await readSecret("  Enter your Telegram Bot Token: ")).trim()
      }
      process.stdout.write("\n")
      // Re-create rl for optional prompts
      const rlTgOpt = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        telegramAllowedChatIds = (
          await rlTgOpt.question("  Allowed Chat IDs (comma-separated, leave blank to allow all): ")
        ).trim()
      } finally {
        rlTgOpt.close()
      }
    }

    let discordBotToken = ""
    let discordAllowedChannelIds = ""
    if (setupDiscord) {
      const rlDc = setupFeishu || setupQq || setupTelegram
        ? readline.createInterface({ input: process.stdin, output: process.stdout })
        : rl
      process.stdout.write("\n" + dim("--- Discord Bot Configuration ---") + "\n")
      process.stdout.write(dim("  Get a bot token from the Discord Developer Portal.") + "\n")
      if (setupFeishu || setupQq || setupTelegram) rlDc.close()
      else rl.close()
      while (!discordBotToken) {
        discordBotToken = (await readSecret("  Enter your Discord Bot Token: ")).trim()
      }
      process.stdout.write("\n")
      // Re-create rl for optional prompts
      const rlDcOpt = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        discordAllowedChannelIds = (
          await rlDcOpt.question("  Allowed Channel IDs (comma-separated, leave blank to allow all): ")
        ).trim()
      } finally {
        rlDcOpt.close()
      }
    }

    // WeChat uses QR code login, no credentials needed
    if (setupWechat) {
      process.stdout.write("\n" + dim("--- WeChat Configuration ---") + "\n")
      process.stdout.write(dim("  WeChat uses QR code login on first run.") + "\n")
      process.stdout.write(dim("  Enable WeChat by setting WECHAT_ENABLED=true") + "\n")
    }

    // Re-create rl for the remaining prompts
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    try {
      // ── Step 2/3: opencode Server ──
      process.stdout.write(dim("Step 2/3: opencode Server") + "\n")

      const urlInput = (
        await rl2.question(`  opencode server URL [${DEFAULT_SERVER_URL}]: `)
      ).trim()
      const serverUrl = urlInput || DEFAULT_SERVER_URL

      try {
        await fetch(serverUrl)
        process.stdout.write(green("  ✓ Connected to opencode server") + "\n\n")
      } catch {
        if (shouldBootstrapLauncher(serverUrl)) {
          process.stdout.write(
            dim(`  未检测到 opencode 服务：${serverUrl}`) + "\n" +
            dim(`  将自动写入 launcher 默认配置，后续启动时会尝试执行：${DEFAULT_LAUNCHER_COMMAND}`) +
            "\n\n",
          )
        } else {
          let connected = false
          while (!connected) {
            process.stdout.write(
              red(`  ✗ Cannot reach opencode server at ${serverUrl}`) +
              "\n\n" +
              "  Please start it in another terminal or use a reachable server URL:\n" +
              dim("    OPENCODE_SERVER_PORT=4096 opencode serve") +
              "\n\n",
            )
            await rl2.question("  Press Enter to retry...")
            try {
              await fetch(serverUrl)
              connected = true
              process.stdout.write(green("  ✓ Connected to opencode server") + "\n\n")
            } catch {
              // Continue retry loop until the server is reachable.
            }
          }
        }
      }

      // ── Step 3/3: Save Configuration ──
      process.stdout.write(dim("Step 3/3: Save Configuration") + "\n")

      ensureConfigDir()
      const mainId = feishuAppId || qqAppId || telegramBotToken || discordBotToken || "bot"
      const envPath = path.join(CONFIG_DIR, `.env.${mainId}`)

      // Build .env content
      const lines: string[] = []
      if (setupFeishu) {
        lines.push(`FEISHU_APP_ID=${feishuAppId}`)
        lines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`)
      } else {
        lines.push(`FEISHU_APP_ID=`)
        lines.push(`FEISHU_APP_SECRET=`)
      }
      if (setupQq) {
        lines.push(`QQ_APP_ID=${qqAppId}`)
        lines.push(`QQ_SECRET=${qqSecret}`)
        lines.push(`QQ_SANDBOX=false`)
      } else {
        lines.push(`QQ_APP_ID=`)
        lines.push(`QQ_SECRET=`)
      }
      if (setupTelegram) {
        lines.push(`TELEGRAM_BOT_TOKEN=${telegramBotToken}`)
        if (telegramAllowedChatIds) {
          lines.push(`TELEGRAM_ALLOWED_CHAT_IDS=${telegramAllowedChatIds}`)
        }
      } else {
        lines.push(`TELEGRAM_BOT_TOKEN=`)
      }
      if (setupDiscord) {
        lines.push(`DISCORD_BOT_TOKEN=${discordBotToken}`)
        if (discordAllowedChannelIds) {
          lines.push(`DISCORD_ALLOWED_CHANNEL_IDS=${discordAllowedChannelIds}`)
        }
      } else {
        lines.push(`DISCORD_BOT_TOKEN=`)
      }
      if (setupWechat) {
        lines.push(`WECHAT_ENABLED=true`)
      }

      if (serverUrl !== DEFAULT_SERVER_URL) {
        lines.push(`OPENCODE_SERVER_URL=${serverUrl}`)
      }
      lines.push(...buildLauncherEnvLines(serverUrl))

      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8")
      process.stdout.write(green(`  ✓ Configuration saved to ${envPath}`) + "\n")

      // Set on process.env so loadConfig() picks them up immediately
      if (setupFeishu) {
        process.env.FEISHU_APP_ID = feishuAppId
        process.env.FEISHU_APP_SECRET = feishuAppSecret
      } else {
        delete process.env.FEISHU_APP_ID
        delete process.env.FEISHU_APP_SECRET
      }
      if (setupQq) {
        process.env.QQ_APP_ID = qqAppId
        process.env.QQ_SECRET = qqSecret
      } else {
        delete process.env.QQ_APP_ID
        delete process.env.QQ_SECRET
      }
      if (setupTelegram) {
        process.env.TELEGRAM_BOT_TOKEN = telegramBotToken
        if (telegramAllowedChatIds) {
          process.env.TELEGRAM_ALLOWED_CHAT_IDS = telegramAllowedChatIds
        } else {
          delete process.env.TELEGRAM_ALLOWED_CHAT_IDS
        }
      } else {
        delete process.env.TELEGRAM_BOT_TOKEN
      }
      if (setupDiscord) {
        process.env.DISCORD_BOT_TOKEN = discordBotToken
        if (discordAllowedChannelIds) {
          process.env.DISCORD_ALLOWED_CHANNEL_IDS = discordAllowedChannelIds
        } else {
          delete process.env.DISCORD_ALLOWED_CHANNEL_IDS
        }
      } else {
        delete process.env.DISCORD_BOT_TOKEN
      }
      if (setupWechat) {
        process.env.WECHAT_ENABLED = "true"
      }
      if (serverUrl !== DEFAULT_SERVER_URL) {
        process.env.OPENCODE_SERVER_URL = serverUrl
      }
      const launcherEnvLines = buildLauncherEnvLines(serverUrl)
      if (launcherEnvLines.length > 0) {
        process.env.OPENCODE_LAUNCHER_ENABLED = "true"
        process.env.OPENCODE_AUTO_START_SERVER = "true"
        process.env.OPENCODE_SERVER_COMMAND = DEFAULT_LAUNCHER_COMMAND
      } else {
        delete process.env.OPENCODE_LAUNCHER_ENABLED
        delete process.env.OPENCODE_AUTO_START_SERVER
        delete process.env.OPENCODE_SERVER_COMMAND
      }

      logger.info("Setup wizard completed, .env written to %s", envPath)

      // ── Starting ──
      process.stdout.write(`\n${bold("Starting opencode-im...")}\n\n`)
    } finally {
      rl2.close()
    }
  } finally {
    // rl may already be closed; close is idempotent
    rl.close()
  }
}
