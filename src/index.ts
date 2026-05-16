/**
 * OhMyOpenclaw — Feishu channel integration for opencode.
 *
 * Standalone process entry point:
 *   0. Load .env + interactive setup wizard (first run)
 *   1. Load config
 *   1. Load config
 *   2. Connect to existing opencode server (createOpencodeClient)
 *   3. Initialize SQLite database
 *   4. Create shared services (session, memory, event processor, etc.)
 *   5. Create FeishuPlugin + ChannelManager
 *   6. Subscribe to opencode events (SSE)
 *   7. Route incoming messages via message handler
 *   8. Optionally start HeartbeatService + ScheduledTaskRuntime
 *   9. Graceful shutdown
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { loadConfig } from "./utils/config.js"
import { initDatabase } from "./utils/db.js"
import { createLogger } from "./utils/logger.js"
import type { EventListenerMap } from "./utils/event-listeners.js"
import type { FeishuCardAction } from "./types.js"
import { createFeishuApiClient } from "./feishu/api-client.js"
import { CardKitClient } from "./feishu/cardkit-client.js"
import { MessageDedup } from "./feishu/message-dedup.js"
import { createSessionManager } from "./session/session-manager.js"
import { createProgressTracker } from "./session/progress-tracker.js"
import { EventProcessor } from "./streaming/event-processor.js"
import { SubAgentTracker } from "./streaming/subagent-tracker.js"
import { createMessageHandler } from "./handler/message-handler.js"
import { createStreamingBridge } from "./handler/streaming-integration.js"
import { createCommandHandler } from "./handler/command-handler.js"
import { createOutboundMediaHandler } from "./handler/outbound-media.js"
import { createSessionObserver } from "./streaming/session-observer.js"
import { addListener, removeListener } from "./utils/event-listeners.js"
import { createSubAgentCardHandler } from "./streaming/subagent-card.js"
import { createInteractiveHandler } from "./handler/interactive-handler.js"
import { createInteractivePoller } from "./handler/interactive-poller.js"
import { createFeishuGateway } from "./feishu/webhook-server.js"
import { FeishuPlugin } from "./channel/feishu/feishu-plugin.js"
import { DingTalkPlugin } from "./channel/dingtalk/dingtalk-plugin.js"
import { ChannelManager } from "./channel/manager.js"
import type { ChannelId } from "./channel/types.js"
import { HeartbeatService } from "./cron/heartbeat.js"
import { scheduledTaskRuntime } from "./scheduled-task/runtime.js"
import type { TaskDelivery } from "./scheduled-task/types.js"
import { loadEnvFile } from "./utils/env-loader.js"
import { needsSetup, runSetupWizard, pickConfig } from "./cli/setup-wizard.js"

const logger = createLogger("opencode-im")

process.on("unhandledRejection", (reason, promise) => {
  logger.error(`[SILENT HOOK] Unhandled Rejection at: ${promise}, reason: ${reason}`);
  if (reason instanceof Error && reason.stack) {
    logger.error(reason.stack);
  }
});
process.on("uncaughtException", (error) => {
  logger.error(`[SILENT HOOK] Uncaught Exception: ${error}`);
  if (error.stack) {
    logger.error(error.stack);
  }
});

async function main(): Promise<void> {
  // ═══════════════════════════════════════════
  // Phase 0: Config Selection
  // ═══════════════════════════════════════════
  const forceInit = process.argv.includes("init")

  if (forceInit) {
    await runSetupWizard()
  } else {
    const configPath = await pickConfig()
    if (configPath) {
      loadEnvFile(configPath)
    } else if (await needsSetup()) {
      await runSetupWizard()
    }
    // If needsSetup() is false (env vars already set externally), proceed without loading file
  }

  // ═══════════════════════════════════════════
  // Phase 1: Load Config
  // ═══════════════════════════════════════════
  logger.info("@@@@@ opencode-im starting PRECISE VERSION @@@@@")
  logger.info("Phase 1: Loading config...")
  const config = await loadConfig()

  if ((!config.feishu?.appId || !config.feishu?.appSecret) && (!config.qq?.appId || !config.qq?.secret) && !config.telegram?.botToken && !config.discord?.botToken && !config.wechat?.enabled) {
    logger.error(
      "No valid channel credentials found (Feishu, QQ, Telegram, Discord, or WeChat). Run `opencode-im-bridge init` to configure, " +
      "or set environment variables.",
    )
    process.exit(1)
  }

  // ═══════════════════════════════════════════
  // Phase 2: Connect to Opencode Server
  // ═══════════════════════════════════════════
  logger.info("Phase 2: Connecting to opencode server...")
  const serverUrl = (
    process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096"
  ).replace("localhost", "127.0.0.1")
  logger.info(`Connecting to opencode server at ${serverUrl}`)
  const client = createOpencodeClient({
    baseUrl: serverUrl,
  })

  async function waitForServer(maxRetries = 10): Promise<void> {
    let delay = 250
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await client.session.status()
        return
      } catch {
        if (attempt === maxRetries) {
          throw new Error(
            `Opencode server not reachable after ${maxRetries} attempts`,
          )
        }
        logger.info(
          `Waiting for opencode server (attempt ${attempt}/${maxRetries})...`,
        )
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 5000)
      }
    }
  }

  await waitForServer()
  logger.info("Opencode server ready")

  // ═══════════════════════════════════════════
  // Phase 3: Database Init
  // ═══════════════════════════════════════════
  logger.info("Phase 3: Initializing database...")
  const db = initDatabase(config.dataDir)

  // ═══════════════════════════════════════════
  // Phase 4: Create Shared Services
  // ═══════════════════════════════════════════
  logger.info("Phase 4: Creating shared services...")

  let feishuClient: any = undefined
  let cardkitClient: any = undefined
  let botOpenId: string | undefined

  if (config.feishu) {
    feishuClient = createFeishuApiClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    })

    // Fetch bot's own open_id for @mention filtering in group chats
    try {
      const botInfo = await feishuClient.getBotInfo()
      botOpenId = botInfo.open_id || undefined
      logger.info(`Feishu Bot identity: ${botInfo.app_name} (${botInfo.open_id})`)
    } catch (err) {
      logger.warn(`Failed to fetch Feishu bot info — group @mention filtering disabled: ${err}`)
    }

    cardkitClient = new CardKitClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    })
  }

  const channelManager = new ChannelManager({ logger })

  const sessionManager = createSessionManager({
    serverUrl,
    db: db.sessions,
    defaultAgent: config.defaultAgent,
  })

  // Validate stored session mappings against the running opencode server
  logger.info("Phase 4b: Validating stored session mappings...")
  try {
    const cleaned = await sessionManager.validateAndCleanupStale()
    if (cleaned > 0) {
      logger.info(`Phase 4b: Removed ${cleaned} stale session mapping(s)`)
    }
  } catch (err) {
    logger.warn(`Phase 4b: Session mapping validation failed (non-fatal): ${err}`)
  }


  const dedup = new MessageDedup({ db: db.sessions, ttlMs: 60_000 })

  const progressTracker = createProgressTracker({ feishuClient: feishuClient as any })

  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()
  const seenInteractiveIds = new Set<string>()

  const eventProcessor = new EventProcessor({ ownedSessions, logger })

  const subAgentTracker = new SubAgentTracker({ serverUrl })

  const outboundMedia = createOutboundMediaHandler({
    logger,
    outbound: channelManager?.getChannel("feishu" as ChannelId)?.outbound,
  })

  const streamingBridge = createStreamingBridge({
    cardkitClient,
    feishuClient,
    subAgentTracker,
    logger,
    seenInteractiveIds,
    outboundMedia,
    channelManager,
  })

  const observer = createSessionObserver({
    feishuClient,
    eventProcessor,
    addListener: (sessionId, fn) => addListener(eventListeners, sessionId, fn),
    removeListener: (sessionId, fn) => removeListener(eventListeners, sessionId, fn),
    logger,
    seenInteractiveIds,
  })

  const subAgentCardHandler = config.feishu
    ? createSubAgentCardHandler({ subAgentTracker, feishuClient, logger })
    : undefined

  const commandHandler = createCommandHandler({
    serverUrl,
    sessionManager,
    feishuClient,
    logger,
    channelManager,
  })

  const { handleMessage, dispose: disposeDebouncer } = createMessageHandler({
    serverUrl,
    sessionManager,
    dedup,
    eventProcessor,
    feishuClient,
    progressTracker,
    eventListeners,
    ownedSessions,
    logger,
    streamingBridge,
    observer,
    commandHandler: commandHandler as any,
    botOpenId,
    outboundMedia,
    debounceMs: config.messageDebounceMs,
    channelManager,
  })

  // Create card action handlers (Feishu only)
  const subAgentCardHandler2 = subAgentCardHandler  // alias already defined above

  const interactiveHandler = createInteractiveHandler({
    serverUrl,
    logger,
  })

  let interactivePoller: ReturnType<typeof createInteractivePoller> | undefined
  if (config.feishu && observer) {
    interactivePoller = createInteractivePoller({
      serverUrl,
      feishuClient,
      logger,
      getChatForSession: (sessionId) => observer.getChatForSession(sessionId),
      seenInteractiveIds,
    })
    interactivePoller.start()
    logger.info("Interactive poller started (interval=3000ms)")
  }

  // Handle card actions from all channels (Feishu, Telegram, etc.)
  // question_answer and permission_reply are channel-agnostic - always route to interactiveHandler
  // which POSTs to opencode server APIs directly
  const handleCardAction = async (action: FeishuCardAction): Promise<void> => {
    // Channel-agnostic: always handle via interactiveHandler
    const actionType = action.action?.value?.action
    if (actionType === "question_answer" || actionType === "permission_reply") {
      return interactiveHandler(action)
    }

    // Feishu-specific handlers (only when Feishu is configured)
    if (config.feishu) {
      if (actionType === "view_subagent") {
        return subAgentCardHandler2?.(action)
      }
      if (actionType === "command_execute") {
        const cmd = (action.action?.value as any)?.command
        if (cmd) {
          const chatId = action.open_chat_id
          const messageId = action.open_message_id
          await commandHandler(chatId, chatId, messageId, cmd)
        }
        return
      }
      // Handle string value directly (e.g., overflow options)
      const rawVal = action.action?.value as unknown
      if (typeof rawVal === "string" && rawVal.startsWith("/")) {
        const chatId = action.open_chat_id
        const messageId = action.open_message_id
        await commandHandler(chatId, chatId, messageId, rawVal)
        return
      }
      // Handle object with command property
      if (rawVal && typeof rawVal === "object" && "command" in rawVal && typeof (rawVal as any).command === "string" && (rawVal as any).command.startsWith("/")) {
        const chatId = action.open_chat_id
        const messageId = action.open_message_id
        await commandHandler(chatId, chatId, messageId, (rawVal as any).command)
        return
      }
    }

    logger.warn(`Unknown card action type: ${actionType}, value: ${JSON.stringify(action.action?.value)?.slice(0, 100)}`)
  }

  // ═══════════════════════════════════════════
  // Phase 5: Subscribe to Opencode Events (SSE)
  // ═══════════════════════════════════════════
  logger.info("Phase 5: Subscribing to opencode events...")

  /**
   * Dispatch a single SSE event to all matching listeners.
   */
  function dispatchSseEvent(event: unknown): void {
    const eventObj = event as Record<string, unknown>
    const props = eventObj?.properties as Record<string, unknown> | undefined
    const eventType = eventObj?.type as string | undefined
    const sessionID = props?.sessionID ?? (props?.part && typeof props.part === "object" ? (props.part as Record<string, unknown>).sessionID : undefined)
    
    if (eventType) {
      logger.debug(`SSE: ${eventType} session=${sessionID ?? "n/a"}`)
    }
    
    if (sessionID && typeof sessionID === "string") {
      const listeners = eventListeners.get(sessionID)
      if (listeners) {
        for (const listener of listeners) {
          try { listener(event) } catch (err) { logger.warn(`Event listener for ${sessionID} threw: ${err}`) }
        }
      }
    } else {
      // No sessionID — broadcast to all (fallback for non-session events)
      for (const [key, listeners] of eventListeners.entries()) {
        for (const listener of listeners) {
          try { listener(event) } catch (err) { logger.warn(`Event listener for ${key} threw: ${err}`) }
        }
      }
    }
  }

  /**
   * SSE subscription loop with exponential-backoff reconnect.
   * Must be started AFTER abortController is created.
   */
  async function startSseLoop(signal: AbortSignal): Promise<void> {
    let delay = 1_000
    while (!signal.aborted) {
      try {
        const events = await client.event.subscribe()
        logger.info("SSE event stream connected")
        delay = 1_000  // reset backoff on successful connect
        for await (const event of events.stream) {
          if (signal.aborted) break
          dispatchSseEvent(event)
        }
        if (!signal.aborted) {
          logger.warn("SSE event stream ended, reconnecting...")
        }
      } catch (err) {
        if (signal.aborted) break
        logger.warn(`SSE subscription error: ${err}. Retrying in ${delay}ms...`)
      }
      if (!signal.aborted) {
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30_000)
      }
    }
  }

  // ═══════════════════════════════════════════
  // Phase 6: Create Plugins
  // ═══════════════════════════════════════════
  logger.info("Phase 6: Initializing channel plugins...")

  if (config.feishu && feishuClient && cardkitClient) {
    const feishuPlugin = new FeishuPlugin({
      appConfig: config,
      feishuClient,
      cardkitClient,
      logger,
      onMessage: handleMessage,
      onCardAction: handleCardAction,
    })
    channelManager.register(feishuPlugin)
  }

  if (config.qq) {
    // QQPlugin imported asynchronously to avoid top-level require if not used
    const { QQPlugin } = await import("./channel/qq/index.js") as any
    const qqPlugin = new QQPlugin({
      appConfig: config,
      logger,
      onMessage: handleMessage,
    })
    channelManager.register(qqPlugin)
  }

  if (config.telegram) {
    // TelegramPlugin imported asynchronously to avoid top-level require if not used
    const { TelegramPlugin } = await import("./channel/telegram/index.js")
    const telegramPlugin = new TelegramPlugin({
      appConfig: config,
      logger,
      onMessage: handleMessage,
      onCardAction: handleCardAction,
    })
    channelManager.register(telegramPlugin)
  }

  if (config.discord) {
    const { DiscordPlugin } = await import("./channel/discord/index.js") as any
    const discordPlugin = new DiscordPlugin({
      appConfig: config,
      logger,
      onMessage: handleMessage,
    })
    channelManager.register(discordPlugin)
  }

  if (config.wechat) {
    const { WechatPlugin } = await import("./channel/wechat/index.js")
    const wechatPlugin = new WechatPlugin({
      appConfig: config,
      logger,
      onMessage: handleMessage,
    })
    channelManager.register(wechatPlugin)
  }

  if (config.dingtalk) {
    const dingtalkPlugin = new DingTalkPlugin({
      appConfig: config,
      logger,
      onMessage: handleMessage,
    })
    channelManager.register(dingtalkPlugin)
  }

  // ═══════════════════════════════════════════
  // Phase 7: Start Channels + Webhook Server
  // ═══════════════════════════════════════════
  logger.info("Phase 7: Starting channels...")

  const abortController = new AbortController()
  await channelManager.startAll(abortController.signal)

  // Start SSE reconnect loop NOW that abortController is available
  startSseLoop(abortController.signal).catch((err) => {
    logger.error(`SSE loop crashed unexpectedly: ${err}`)
  })

  let webhookServer: any = undefined
  if (config.feishu) {
    // Start webhook server for card action callbacks (non-blocking fallback)
    logger.info("Phase 7b: Starting webhook server for card actions...")
    const webhookPort = parseInt(process.env.FEISHU_WEBHOOK_PORT ?? config.feishu.webhookPort.toString(), 10)
    createFeishuGateway({
      port: webhookPort,
      verificationToken: config.feishu.verificationToken ?? "",
      onMessage: handleMessage,
      onCardAction: handleCardAction,
      dedup,
    }).then((server) => {
      webhookServer = server
      logger.info(`Webhook server started on port ${webhookPort}`)
    }).catch((err) => {
      logger.warn(`Webhook server failed to start (non-fatal, using WebSocket for callbacks): ${err}`)
    })
  }

  // ═══════════════════════════════════════════
  // Phase 8: Optional Services (Heartbeat)
  // ═══════════════════════════════════════════
  let heartbeatService: HeartbeatService | undefined

  if (config.heartbeat) {
    logger.info("Starting heartbeat service...")
    heartbeatService = new HeartbeatService({
      config: config.heartbeat,
      sessionManager,
      serverUrl,
      feishuClient,
      logger,
    })
    heartbeatService.start()
  }

  const sendTaskDelivery: (delivery: TaskDelivery) => Promise<void> = async (delivery) => {
    logger.info(`[sendTaskDelivery] Sending task result to channel=${delivery.channelId}, chatId=${delivery.chatId}, status=${delivery.status}`)

    const statusEmoji = delivery.status === "success" ? "✅" : "❌"
    const messageContent = delivery.status === "success"
      ? `**任务执行成功**\n\n**Session:** ${delivery.sessionId || "N/A"}\n\n**执行结果:**\n${delivery.messageText}`
      : `**任务执行失败**\n\n**Session:** ${delivery.sessionId || "N/A"}\n\n**错误信息:**\n${delivery.messageText}`

    const fullMessage = `🕒 **${delivery.taskName}** (${delivery.scheduleSummary})\n\n${messageContent}`

    const plugin = channelManager?.getChannel(delivery.channelId as ChannelId)
    if (plugin?.outbound) {
      logger.info(`[sendTaskDelivery] Using plugin outbound for ${delivery.channelId}`)
      await plugin.outbound.sendText(
        { address: delivery.chatId },
        fullMessage,
      )
      logger.info(`[sendTaskDelivery] Message sent via plugin`)
    } else if (delivery.channelId === "feishu") {
      logger.info(`[sendTaskDelivery] Using feishuClient directly`)
      await feishuClient.sendMessage(delivery.chatId, {
        msg_type: "text",
        content: JSON.stringify({ text: fullMessage }),
      })
      logger.info(`[sendTaskDelivery] Message sent via feishuClient`)
    } else {
      logger.error(`[sendTaskDelivery] No delivery method available for channel ${delivery.channelId}`)
    }

    logger.info(`[sendTaskDelivery] Checking file send: status=${delivery.status}, outboundMedia=${!!outboundMedia}`)
    if (delivery.status === "success" && outboundMedia) {
      const adapter = channelManager?.getChannel(delivery.channelId as ChannelId)?.outbound
      logger.info(`[sendTaskDelivery] Calling sendDetectedFiles with adapter=${!!adapter}`)
      try {
        await outboundMedia.sendDetectedFiles({ address: delivery.chatId }, delivery.messageText, adapter)
        logger.info(`[sendTaskDelivery] Files sent successfully`)
      } catch (err) {
        logger.warn(`[sendTaskDelivery] sendDetectedFiles failed: ${err}`)
      }
    } else {
      logger.info(`[sendTaskDelivery] Skipping file send: status=${delivery.status}, hasOutboundMedia=${!!outboundMedia}`)
    }
  }

  await scheduledTaskRuntime.initialize(sendTaskDelivery, {
    serverUrl,
    logger,
    snapshotAttachments: (chatId: string) => outboundMedia.snapshotAttachments(chatId),
  })
  logger.info("Scheduled task runtime initialized")

  // ═══════════════════════════════════════════
  // Graceful Shutdown
  // ═══════════════════════════════════════════
  function shutdown(signal: string) {
    return async () => {
      logger.info(`${signal} received, shutting down...`)
      abortController.abort()
      await channelManager.stopAll()
      if (webhookServer) await webhookServer.close()
      heartbeatService?.stop()
      await scheduledTaskRuntime.shutdown()
      interactivePoller?.stop()
      observer?.stop()
      disposeDebouncer()
      dedup.close()
      db.close()
      process.exit(0)
    }
  }

  process.on("SIGTERM", shutdown("SIGTERM"))
  process.on("SIGINT", shutdown("SIGINT"))

  logger.info("OhMyOpenclaw started — channels active")
}

main().catch((err) => {
  logger.error("Fatal error:", err)
  process.exit(1)
})
