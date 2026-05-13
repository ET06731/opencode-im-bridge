import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Logger } from "../utils/logger.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SessionManager } from "../session/session-manager.js"
import type { HeartbeatConfig } from "../utils/config.js"
import type { ServiceLauncher } from "../reliability/service-launcher.js"

export interface HeartbeatOptions {
  config: HeartbeatConfig
  serverUrl: string
  sessionManager: SessionManager
  feishuClient?: FeishuApiClient
  logger: Logger
  serviceLauncher?: ServiceLauncher
}

export class HeartbeatService {
  private readonly options: HeartbeatOptions
  private intervalId: ReturnType<typeof setInterval> | null = null
  private running = false
  private successCount = 0
  private failCount = 0

  constructor(options: HeartbeatOptions) {
    this.options = options
  }

  start(): void {
    if (this.running || !this.options.config.proactiveEnabled) return

    const { logger, config } = this.options
    logger.info(`Heartbeat service started (interval: ${config.intervalMs}ms)`)

    this.intervalId = setInterval(() => {
      void this.tick()
    }, config.intervalMs)

    this.running = true
  }

  stop(): void {
    if (!this.running) return

    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.running = false
    this.options.logger.info("Heartbeat service stopped")
  }

  private async tick(): Promise<void> {
    const { serverUrl, logger, config, sessionManager } = this.options
    let heartbeatContent = "SYSTEM OK"

    try {
      const filePath = path.resolve(process.cwd(), "HEARTBEAT.md")
      heartbeatContent = await fs.readFile(filePath, "utf-8")
    } catch (e: any) {
      logger.debug("HEARTBEAT.md not found, using default ping")
    }

    try {
      await this.options.serviceLauncher?.ensureServerReady("heartbeat")

      // Create or get the dedicated heartbeat session
      const heartbeatSessionId = await sessionManager.getOrCreate("reliability:heartbeat")
      
      const prompt = `Please perform a system routine check based on the following instructions:\n\n${heartbeatContent}\n\nIf all checks pass and there are no issues, reply EXACTLY with "HEARTBEAT_OK". Do not include any other text. If there are issues, reply with the details of the failure.`

      const resp = await fetch(`${serverUrl}/session/${heartbeatSessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: prompt }],
        }),
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} on send message`)
      }

      const result = await this.waitForResponse(heartbeatSessionId)

      if (result.trim() === "HEARTBEAT_OK") {
        this.successCount++
        logger.info("Server healthy (Heartbeat OK)")
      } else {
        this.failCount++
        logger.error(`Heartbeat agent returned failure: ${result}`)
        await this.broadcastAlert(result)
      }
    } catch (err) {
      this.failCount++
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Heartbeat check failed to execute: ${message}`)
      await this.broadcastAlert(`Agent check failed to execute: ${message}`)
    }
  }

  private async waitForResponse(sessionId: string, maxWaitMs = 60_000): Promise<string> {
    const { serverUrl } = this.options
    const start = Date.now()
    const pollInterval = 2_000

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval))
      const statusResp = await fetch(`${serverUrl}/session/${sessionId}`)
      if (!statusResp.ok) continue

      const session = (await statusResp.json()) as { status?: { type?: string } }
      if (session.status?.type === "idle") {
        const msgResp = await fetch(`${serverUrl}/session/${sessionId}/message?limit=1`)
        if (msgResp.ok) {
          const messages = (await msgResp.json()) as Array<{ role?: string; text?: string }>
          const last = messages.find((m) => m.role === "assistant")
          return last?.text ?? ""
        }
        return ""
      }
    }
    return "(timed out waiting for heartbeat response)"
  }

  private async broadcastAlert(errorMsg: string): Promise<void> {
    const { feishuClient, config, logger } = this.options
    if (!feishuClient) return

    const targets = new Set<string>()
    if (config.statusChatId) targets.add(config.statusChatId)
    for (const chat of config.alertChats) targets.add(chat)

    for (const chatId of targets) {
      try {
        await feishuClient.sendMessage(chatId, {
          msg_type: "text",
          content: JSON.stringify({
            text: `❌ [可靠性告警] 心跳探针异常\n\n详情：${errorMsg}\n(成功: ${this.successCount}, 失败: ${this.failCount})`,
          }),
        })
      } catch (err) {
        logger.error(`Failed to send heartbeat alert to ${chatId}:`, err)
      }
    }
  }

  getStats(): { successCount: number; failCount: number } {
    return { successCount: this.successCount, failCount: this.failCount }
  }
}
