/**
 * Feishu Webhook server.
 * Receives Feishu event subscription callbacks and card action callbacks.
 */

import express from "express"
import type { Server } from "node:http"
import { createLogger } from "../utils/logger.js"
import { MessageDedup } from "./message-dedup.js"
import type { FeishuMessageEvent, FeishuCardAction } from "../types.js"

const logger = createLogger("feishu-webhook")

interface WebhookServerOptions {
  port: number
  verificationToken: string
  onMessage: (event: FeishuMessageEvent) => Promise<void>
  onCardAction: (action: FeishuCardAction) => Promise<void>
  dedup: MessageDedup
}

export interface WebhookServer {
  port: number
  close(): Promise<void>
}

export async function createFeishuGateway(
  options: WebhookServerOptions,
): Promise<WebhookServer> {
  const { port, verificationToken, onMessage, onCardAction } = options
  const app = express()
  const dedup = options.dedup

  app.use(express.json())

  // ── Feishu event subscription endpoint ──
  app.post("/feishu/webhook", (req, res) => {
    const body = req.body as Record<string, unknown>

    // URL verification (Feishu sends challenge on first webhook setup)
    if (body["type"] === "url_verification") {
      logger.info("URL verification received")
      res.json({ challenge: body["challenge"] })
      return
    }

    // Verify token
    if (body["token"] !== verificationToken) {
      logger.warn("Invalid verification token")
      res.status(403).json({ error: "Invalid token" })
      return
    }

    // Respond within 3s (Feishu requirement)
    res.status(200).json({ code: 0 })

    // Async processing
    const header = body["header"] as Record<string, unknown> | undefined
    const event = body["event"] as Record<string, unknown> | undefined
    if (!header || !event) return

    const eventId = header["event_id"] as string | undefined
    if (!eventId) return

    // Dedup
    if (dedup.isDuplicate(eventId)) {
      logger.debug(`Duplicate event: ${eventId}`)
      return
    }

    // Ignore bot's own messages
    const sender = event["sender"] as Record<string, unknown> | undefined
    if (sender?.["sender_type"] === "app") return

    const eventType = header["event_type"] as string | undefined
    if (eventType !== "im.message.receive_v1") return

    const message = event["message"] as Record<string, unknown> | undefined
    if (!message) return

    const messageEvent: FeishuMessageEvent = {
      event_id: eventId,
      event_type: eventType,
      chat_id: message["chat_id"] as string,
      chat_type: message["chat_type"] as "p2p" | "group",
      message_id: message["message_id"] as string,
      root_id: message["root_id"] as string | undefined,
      parent_id: message["parent_id"] as string | undefined,
      sender: {
        sender_id: (sender?.["sender_id"] as { open_id: string; user_id?: string }) ?? {
          open_id: "unknown",
        },
        sender_type: (sender?.["sender_type"] as string) ?? "unknown",
        tenant_key: (sender?.["tenant_key"] as string) ?? "unknown",
      },
      message: {
        message_type: message["message_type"] as string,
        content: message["content"] as string,
      },
      mentions: message["mentions"] as Array<{ id: { open_id: string } }>,
    }

    onMessage(messageEvent).catch((err) => {
      logger.error("Error processing webhook event:", err)
    })
  })

  // ── Card action callback endpoint ──
  app.post("/feishu/card/action", (req, res) => {
    const body = req.body as Record<string, unknown>

    if (body["token"] !== verificationToken) {
      res.status(403).json({ error: "Invalid token" })
      return
    }

    res.status(200).json({ code: 0 })

    const action: FeishuCardAction = {
      action: body["action"] as FeishuCardAction["action"],
      open_message_id: body["open_message_id"] as string,
      open_chat_id: body["open_chat_id"] as string,
      operator: body["operator"] as { open_id: string },
    }

    onCardAction(action).catch((err) => {
      logger.error("Error processing card action:", err)
    })
  })

  // ── Health check ──
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() })
  })

  // ── Start server ──
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => {
      logger.info(`Feishu webhook server listening on port ${port}`)
      resolve(s)
    })
  })

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
