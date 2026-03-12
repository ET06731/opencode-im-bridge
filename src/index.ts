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
 *   8. Optionally start CronService + HeartbeatService
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
import { ChannelManager } from "./channel/manager.js"
import { CronService } from "./cron/cron-service.js"
import { HeartbeatService } from "./cron/heartbeat.js"
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

  if ((!config.feishu?.appId || !config.feishu?.appSecret) && (!config.qq?.appId || !config.qq?.secret) && !config.telegram?.botToken) {
    logger.error(
      "No valid channel credentials found (Feishu, QQ, or Telegram). Run `opencode-im-bridge init` to configure, " +
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

  const outboundMedia = config.feishu
    ? createOutboundMediaHandler({ feishuClient, logger })
    : undefined

  const streamingBridge = config.feishu
    ? createStreamingBridge({
      cardkitClient,
      feishuClient,
      subAgentTracker,
      logger,
      seenInteractiveIds,
      outboundMedia,
      channelManager,
    })
    : undefined

  const observer = config.feishu
    ? createSessionObserver({
      feishuClient,
      eventProcessor,
      addListener: (sessionId, fn) => addListener(eventListeners, sessionId, fn),
      removeListener: (sessionId, fn) => removeListener(eventListeners, sessionId, fn),
      logger,
      seenInteractiveIds,
    })
    : undefined

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
    commandHandler,
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

  const handleCardAction = config.feishu
    ? async (action: FeishuCardAction) => {
      const actionType = action.action?.value?.action
      if (actionType === "view_subagent") {
        return subAgentCardHandler2?.(action)
      }
      if (actionType === "question_answer" || actionType === "permission_reply") {
        return interactiveHandler(action)
      }
      if (actionType === "command_execute") {
        const cmd = action.action?.value?.command
        if (cmd) {
          const chatId = action.open_chat_id
          const messageId = action.open_message_id
          await commandHandler(chatId, chatId, messageId, cmd)
        }
        return
      }
      logger.warn(`Unknown card action type: ${actionType}`)
    }
    : async (_action: FeishuCardAction) => {
      logger.warn("Received card action but Feishu is not configured")
    }

  // ═══════════════════════════════════════════
  // Phase 5: Subscribe to Opencode Events (SSE)
  // ═══════════════════════════════════════════
  logger.info("Phase 5: Subscribing to opencode events...")

    ; (async () => {
      try {
        const events = await client.event.subscribe()
        logger.info("SSE event stream connected")
        for await (const event of events.stream) {
          const eventType = (event as Record<string, unknown>)?.type as string | undefined
          const props = (event as Record<string, unknown>)?.properties as Record<string, unknown> | undefined
          const sessionID = props?.sessionID ?? (props?.part && typeof props.part === "object" ? (props.part as Record<string, unknown>).sessionID : undefined)
          if (eventType) {
            logger.debug(`SSE: ${eventType} session=${sessionID ?? "n/a"}`)
          }

          // Targeted dispatch: send only to matching session's listeners
          if (sessionID && typeof sessionID === "string") {
            const listeners = eventListeners.get(sessionID)
            if (listeners) {
              for (const listener of listeners) {
                try {
                  listener(event)
                } catch (err) {
                  logger.warn(`Event listener for ${sessionID} threw: ${err}`)
                }
              }
            }
          } else {
            // No sessionID — broadcast to all (fallback for non-session events)
            for (const [key, listeners] of eventListeners.entries()) {
              for (const listener of listeners) {
                try {
                  listener(event)
                } catch (err) {
                  logger.warn(`Event listener for ${key} threw: ${err}`)
                }
              }
            }
          }
        }
        logger.warn("SSE event stream ended")
      } catch (err) {
        logger.error(`SSE subscription failed: ${err}`)
      }
    })()

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
    })
    channelManager.register(telegramPlugin)
  }

  // ═══════════════════════════════════════════
  // Phase 7: Start Channels + Webhook Server
  // ═══════════════════════════════════════════
  logger.info("Phase 7: Starting channels...")

  const abortController = new AbortController()
  await channelManager.startAll(abortController.signal)

  let webhookServer: any = undefined
  if (config.feishu) {
    // Start webhook server for card action callbacks
    logger.info("Phase 7b: Starting webhook server for card actions...")
    const webhookPort = parseInt(process.env.FEISHU_WEBHOOK_PORT ?? config.feishu.webhookPort.toString(), 10)
    webhookServer = await createFeishuGateway({
      port: webhookPort,
      verificationToken: config.feishu.verificationToken ?? "",
      onMessage: handleMessage,
      onCardAction: handleCardAction,
      dedup,
    })
    logger.info(`Webhook server started on port ${webhookPort}`)
  }

  // ═══════════════════════════════════════════
  // Phase 8: Optional Services (Cron + Heartbeat)
  // ═══════════════════════════════════════════
  let cronService: CronService | undefined
  let heartbeatService: HeartbeatService | undefined

  if (config.cron) {
    logger.info("Starting cron service...")
    cronService = new CronService({
      config: config.cron,
      sessionManager,
      feishuClient,
      serverUrl,
      logger,
    })
    cronService.start()
  }

  if (config.heartbeat) {
    logger.info("Starting heartbeat service...")
    heartbeatService = new HeartbeatService({
      intervalMs: config.heartbeat.intervalMs,
      serverUrl,
      feishuClient,
      statusChatId: config.heartbeat.statusChatId,
      logger,
    })
    heartbeatService.start()
  }

  // ═══════════════════════════════════════════
  // Graceful Shutdown
  // ═══════════════════════════════════════════
  function shutdown(signal: string) {
    return async () => {
      logger.info(`${signal} received, shutting down...`)
      abortController.abort()
      await channelManager.stopAll()
      if (webhookServer) await webhookServer.close()
      cronService?.stop()
      heartbeatService?.stop()
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
