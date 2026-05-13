/**
 * Zod-validated config loader.
 * Loads from opencode-lark.jsonc (or opencode-feishu.jsonc for backward compat) with env var interpolation.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"

const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  verificationToken: z.string().optional().default(""),
  webhookPort: z.number().int().positive().default(3001),
  encryptKey: z.string().optional(),
})

const QqConfigSchema = z.object({
  appId: z.string().min(1),
  secret: z.string().min(1),
  sandbox: z.boolean().optional().default(false),
})

const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  /** 允许回复的 Chat ID 列表（数字字符串），留空则允许所有 */
  allowedChatIds: z.array(z.string()).optional().default([]),
})

const DiscordConfigSchema = z.object({
  botToken: z.string().min(1),
  /** 允许回复的 Channel ID 列表（数字字符串），留空则允许所有 */
  allowedChannelIds: z.array(z.string()).optional().default([]),
})

const WechatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sessionFile: z.string().optional(),
  baseUrl: z.string().optional().default("https://ilinkai.weixin.qq.com"),
  token: z.string().optional(),
})

const DingTalkConfigSchema = z.object({
  appKey: z.string().min(1),
  appSecret: z.string().min(1),
  agentId: z.string().optional(),
  botName: z.string().optional(),
})

const ProgressConfigSchema = z.object({
  debounceMs: z.number().int().positive().default(500),
  maxDebounceMs: z.number().int().positive().default(3000),
})


const CronJobSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  chatId: z.string(),
  channelId: z.string().optional().default("feishu"),
  enabled: z.boolean().optional().default(true),
  modelProviderId: z.string().optional(),
  modelId: z.string().optional(),
  agent: z.string().optional(),
  projectId: z.string().optional(),
  projectWorktree: z.string().optional(),
})

const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiEnabled: z.boolean().default(true),
  apiPort: z.number().default(4097),
  apiHost: z.string().default("127.0.0.1"),
  jobsFile: z.string().default("./data/cron-jobs.json"),
  jobs: z.array(CronJobSchema).default([]),
})

const HeartbeatConfigSchema = z.object({
  proactiveEnabled: z.boolean().default(false),
  intervalMs: z.number().default(1800000),
  statusChatId: z.string().optional(),
  alertChats: z.array(z.string()).default([]),
  agent: z.string().default("build"),
})

const LauncherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoStartServer: z.boolean().default(false),
  serverCommand: z.string().optional(),
  serverCwd: z.string().optional(),
  serverStartTimeoutMs: z.number().int().positive().default(30000),
  probeTimeoutMs: z.number().int().positive().default(4000),
})

const AppConfigSchema = z.object({
  feishu: FeishuConfigSchema.optional(),
  qq: QqConfigSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
  discord: DiscordConfigSchema.optional(),
  wechat: WechatConfigSchema.optional(),
  dingtalk: DingTalkConfigSchema.optional(),
  defaultAgent: z.string().default("build"),
  dataDir: z.string().default("./data"),
  progress: ProgressConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  launcher: LauncherConfigSchema.optional(),
  messageDebounceMs: z.number().int().min(0).optional().default(10000),
}).refine(data => data.feishu || data.qq || data.telegram || data.discord || data.wechat || data.dingtalk, {
  message: "At least one channel (feishu, qq, telegram, discord, wechat, or dingtalk) must be configured."
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type CronConfig = z.infer<typeof CronConfigSchema>
export type CronJobConfig = z.infer<typeof CronJobSchema>
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>
export type LauncherConfig = z.infer<typeof LauncherConfigSchema>
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>
export type WechatConfig = z.infer<typeof WechatConfigSchema>
export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>

/** Replace ${ENV_VAR} placeholders with actual environment variable values */
function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? ""
  })
}

/** Strip JSONC comments (// and /* *​/) for JSON.parse */
function stripJsoncComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const searchPaths = configPath
    ? [configPath]
    : [
      path.resolve("opencode-lark.jsonc"),
      path.resolve("opencode-lark.json"),
      path.resolve("opencode-feishu.jsonc"),
      path.resolve("opencode-feishu.json"),
    ]

  let rawText: string | undefined
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      rawText = fs.readFileSync(p, "utf-8")
      break
    }
  }

  // Fall back to pure env vars if no config file
  if (!rawText) {
    const cronEnabledEnv = process.env["RELIABILITY_CRON_ENABLED"]
    const cronApiEnabledEnv = process.env["RELIABILITY_CRON_API_ENABLED"]
    const cronConfigured =
      cronEnabledEnv !== undefined ||
      cronApiEnabledEnv !== undefined ||
      process.env["RELIABILITY_CRON_JOBS_FILE"] !== undefined ||
      process.env["RELIABILITY_CRON_API_PORT"] !== undefined ||
      process.env["RELIABILITY_CRON_API_HOST"] !== undefined
    const launcherEnabledEnv = process.env["OPENCODE_LAUNCHER_ENABLED"]
    const launcherAutoStartEnv = process.env["OPENCODE_AUTO_START_SERVER"]
    const launcherCommandEnv = process.env["OPENCODE_SERVER_COMMAND"]
    const launcherConfigured =
      launcherEnabledEnv !== undefined ||
      launcherAutoStartEnv !== undefined ||
      launcherCommandEnv !== undefined ||
      process.env["OPENCODE_SERVER_START_TIMEOUT_MS"] !== undefined ||
      process.env["OPENCODE_SERVER_PROBE_TIMEOUT_MS"] !== undefined ||
      process.env["OPENCODE_SERVER_CWD"] !== undefined

    rawText = JSON.stringify({
      feishu: process.env["FEISHU_APP_ID"] && process.env["FEISHU_APP_ID"] !== "cli_xxxxxxxxxxxxxxxx" && process.env["FEISHU_APP_ID"] !== "your_app_id_here" ? {
        appId: process.env["FEISHU_APP_ID"],
        appSecret: process.env["FEISHU_APP_SECRET"] ?? "",
        verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"] ?? "",
        webhookPort: Number(
          process.env["FEISHU_WEBHOOK_PORT"] ??
          process.env["OPENCODE_FEISHU_PORT"] ??
          "3001",
        ),
        encryptKey: process.env["FEISHU_ENCRYPT_KEY"],
      } : undefined,
      qq: process.env["QQ_APP_ID"] ? {
        appId: process.env["QQ_APP_ID"],
        secret: process.env["QQ_SECRET"] ?? "",
        sandbox: String(process.env["QQ_SANDBOX"]) === "true",
      } : undefined,
      telegram: process.env["TELEGRAM_BOT_TOKEN"] ? {
        botToken: process.env["TELEGRAM_BOT_TOKEN"],
        allowedChatIds: process.env["TELEGRAM_ALLOWED_CHAT_IDS"]
          ? process.env["TELEGRAM_ALLOWED_CHAT_IDS"].split(",").map((s: string) => s.trim()).filter(Boolean)
          : [],
      } : undefined,
      discord: process.env["DISCORD_BOT_TOKEN"] ? {
        botToken: process.env["DISCORD_BOT_TOKEN"],
        allowedChannelIds: process.env["DISCORD_ALLOWED_CHANNEL_IDS"]
          ? process.env["DISCORD_ALLOWED_CHANNEL_IDS"].split(",").map((s: string) => s.trim()).filter(Boolean)
          : [],
      } : undefined,
      wechat: process.env["WECHAT_ENABLED"] === "true" ? {
        enabled: true,
        sessionFile: process.env["WECHAT_SESSION_FILE"],
        baseUrl: process.env["WECHAT_BASE_URL"],
      } : undefined,
      dingtalk: process.env["DINGTALK_APP_KEY"] ? {
        appKey: process.env["DINGTALK_APP_KEY"],
        appSecret: process.env["DINGTALK_APP_SECRET"] ?? "",
        agentId: process.env["DINGTALK_AGENT_ID"],
        botName: process.env["DINGTALK_BOT_NAME"],
      } : undefined,
      defaultAgent: process.env["OPENCODE_DEFAULT_AGENT"] ?? "build",
      dataDir: process.env["OPENCODE_DATA_DIR"] ?? "./data",
      cron: cronConfigured ? {
        enabled: cronEnabledEnv !== "false",
        apiEnabled: cronApiEnabledEnv !== "false",
        apiPort: Number(process.env["RELIABILITY_CRON_API_PORT"] ?? "4097"),
        apiHost: process.env["RELIABILITY_CRON_API_HOST"] ?? "127.0.0.1",
        jobsFile: process.env["RELIABILITY_CRON_JOBS_FILE"] ?? "./data/cron-jobs.json",
        jobs: [],
      } : undefined,
      heartbeat: {
        proactiveEnabled: process.env["RELIABILITY_PROACTIVE_HEARTBEAT_ENABLED"] === "true",
        intervalMs: Number(process.env["RELIABILITY_HEARTBEAT_INTERVAL_MS"] ?? "1800000"),
        statusChatId: process.env["RELIABILITY_HEARTBEAT_STATUS_CHAT_ID"],
        alertChats: process.env["RELIABILITY_HEARTBEAT_ALERT_CHATS"]
          ? process.env["RELIABILITY_HEARTBEAT_ALERT_CHATS"].split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        agent: process.env["RELIABILITY_HEARTBEAT_AGENT"] ?? "build",
      },
      launcher: launcherConfigured ? {
        enabled: launcherEnabledEnv === "true" || launcherAutoStartEnv === "true" || Boolean(launcherCommandEnv),
        autoStartServer: launcherAutoStartEnv === "true",
        serverCommand: launcherCommandEnv,
        serverCwd: process.env["OPENCODE_SERVER_CWD"],
        serverStartTimeoutMs: Number(process.env["OPENCODE_SERVER_START_TIMEOUT_MS"] ?? "30000"),
        probeTimeoutMs: Number(process.env["OPENCODE_SERVER_PROBE_TIMEOUT_MS"] ?? "4000"),
      } : undefined,
    })
  }

  const interpolated = interpolateEnvVars(rawText)
  const stripped = stripJsoncComments(interpolated)
  const parsed = JSON.parse(stripped) as unknown

  return AppConfigSchema.parse(parsed)
}
