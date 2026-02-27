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

const logger = createLogger("opencode-lark")

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
  logger.info("Phase 1: Loading config...")
  const config = await loadConfig()

  if (!config.feishu.appId || !config.feishu.appSecret) {
    logger.error(
      "Feishu credentials missing. Run `opencode-lark init` to configure, " +
      "or set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables.",
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

  const feishuClient = createFeishuApiClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  })

  const cardkitClient = new CardKitClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  })

  const sessionManager = createSessionManager({
    serverUrl,
    db: db.sessions,
    defaultAgent: config.defaultAgent,
  })

  const dedup = new MessageDedup({ db: db.sessions, ttlMs: 60_000 })

  const progressTracker = createProgressTracker({ feishuClient })

  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()
  const seenInteractiveIds = new Set<string>()

  const eventProcessor = new EventProcessor({ ownedSessions, logger })

  const subAgentTracker = new SubAgentTracker({ serverUrl })

  const streamingBridge = createStreamingBridge({
    cardkitClient,
    feishuClient,
    subAgentTracker,
    logger,
    seenInteractiveIds,
  })

  const observer = createSessionObserver({
    feishuClient,
    eventProcessor,
    addListener: (sessionId, fn) => addListener(eventListeners, sessionId, fn),
    removeListener: (sessionId, fn) => removeListener(eventListeners, sessionId, fn),
    logger,
    seenInteractiveIds,
  })


  const commandHandler = createCommandHandler({
    serverUrl,
    sessionManager,
    feishuClient,
    logger,
  })

  const handleMessage = createMessageHandler({
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
  })

  // Create card action handlers
  const subAgentCardHandler = createSubAgentCardHandler({
    subAgentTracker,
    feishuClient,
    logger,
  })

  const interactiveHandler = createInteractiveHandler({
    serverUrl,
    logger,
  })

  const interactivePoller = createInteractivePoller({
    serverUrl,
    feishuClient,
    logger,
    getChatForSession: (sessionId) => observer.getChatForSession(sessionId),
    seenInteractiveIds,
  })
  interactivePoller.start()

  const handleCardAction = async (action: FeishuCardAction) => {
    const actionType = action.action?.value?.action
    if (actionType === "view_subagent") {
      return subAgentCardHandler(action)
    }
    if (actionType === "question_answer" || actionType === "permission_reply") {
      return interactiveHandler(action)
    }
    if (actionType === "command_execute") {
      const cmd = action.action?.value?.command
      if (cmd) {
        const chatId = action.open_chat_id
        const messageId = action.open_message_id
        // For card callbacks, use chatId as feishuKey (best-effort for p2p)
        await commandHandler(chatId, chatId, messageId, cmd)
      }
      return
    }
    logger.warn(`Unknown card action type: ${actionType}`)
  }

  // ═══════════════════════════════════════════
  // Phase 5: Subscribe to Opencode Events (SSE)
  // ═══════════════════════════════════════════
  logger.info("Phase 5: Subscribing to opencode events...")

  ;(async () => {
    try {
      const events = await client.event.subscribe()
      logger.info("SSE event stream connected")
      for await (const event of events.stream) {
        const eventType = (event as Record<string, unknown>)?.type as string | undefined
        if (eventType) {
          const props = (event as Record<string, unknown>)?.properties as Record<string, unknown> | undefined
          const sessionID = props?.sessionID ?? (props?.part && typeof props.part === "object" ? (props.part as Record<string, unknown>).sessionID : undefined)
          logger.debug(`SSE: ${eventType} session=${sessionID ?? "n/a"}`)
        }
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
      logger.warn("SSE event stream ended")
    } catch (err) {
      logger.error(`SSE subscription failed: ${err}`)
    }
  })()

  // ═══════════════════════════════════════════
  // Phase 6: Create FeishuPlugin + ChannelManager
  // ═══════════════════════════════════════════
  logger.info("Phase 6: Creating channel manager...")

  const feishuPlugin = new FeishuPlugin({
    appConfig: config,
    feishuClient,
    cardkitClient,
    logger,
    onMessage: handleMessage,
    onCardAction: handleCardAction,
  })

  const channelManager = new ChannelManager({ logger })
  channelManager.register(feishuPlugin)

  // ═══════════════════════════════════════════
  // Phase 7: Start Channels + Webhook Server
  // ═══════════════════════════════════════════
  logger.info("Phase 7: Starting channels...")

  const abortController = new AbortController()
  await channelManager.startAll(abortController.signal)

  // Start webhook server for card action callbacks
  logger.info("Phase 7b: Starting webhook server for card actions...")
  const webhookPort = parseInt(process.env.FEISHU_WEBHOOK_PORT ?? "3001", 10)
  const webhookServer = await createFeishuGateway({
    port: webhookPort,
    verificationToken: config.feishu.verificationToken ?? "",
    onMessage: handleMessage,
    onCardAction: handleCardAction,
    dedup,
  })
  logger.info(`Webhook server started on port ${webhookPort}`)

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
      await webhookServer.close()
      cronService?.stop()
      heartbeatService?.stop()
      interactivePoller.stop()
      observer.stop()
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
