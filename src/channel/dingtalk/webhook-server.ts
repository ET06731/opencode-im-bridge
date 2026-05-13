/**
 * DingTalk Webhook server.
 * Receives DingTalk event subscription callbacks and processes messages.
 */

import express from "express"
import type { Server } from "node:http"
import { createLogger } from "../../utils/logger.js"

const logger = createLogger("dingtalk-webhook")

interface WebhookServerOptions {
  port: number
  onMessage: (event: unknown) => Promise<void>
  onCardAction?: (action: unknown) => Promise<void>
}

export interface DingTalkWebhookServer {
  port: number
  close(): Promise<void>
}

export async function createDingTalkGateway(
  options: WebhookServerOptions,
): Promise<DingTalkWebhookServer> {
  const { port, onMessage, onCardAction } = options
  const app = express()

  app.use(express.json())

  app.post("/dingtalk/webhook", (req, res) => {
    const body = req.body as Record<string, unknown>

    logger.info(`[DingTalkWebhook] Received callback: ${JSON.stringify(body).slice(0, 200)}`)

    if (body["eventType"] === "worker_http") {
      const eventData = body["data"]
      if (eventData && typeof eventData === "object") {
        const dataObj = eventData as Record<string, unknown>
        const conversationType = dataObj["conversationType"]
        const isGroup = conversationType === 2 || conversationType === "2"

        const senderId = (dataObj["senderStaffId"] as string) || (dataObj["senderId"] as string) || ""
        const chatId = (dataObj["conversationId"] as string) || ""
        const msgId = (dataObj["msgId"] as string) || `dm_${Date.now()}`
        const msgType = dataObj["msgtype"] as string || "text"
        const content = dataObj["text"] as { content?: string } | undefined
        const senderNick = dataObj["senderNick"] as string | undefined
        const createAt = dataObj["createAt"] as number | undefined

        const text = content?.content || ""

        const syntheticEvent = {
          msgId,
          senderStaffId: senderId,
          senderId: senderId,
          senderNick,
          conversationId: chatId,
          conversationType: String(conversationType || "1"),
          msgtype: msgType,
          text: { content },
          createAt,
          _channelId: "dingtalk",
          _rawMessage: body,
        }

        logger.info(`[DingTalkWebhook] Processed message from ${senderNick || senderId}: ${text.slice(0, 50)}...`)

        onMessage(syntheticEvent).catch((err) => {
          logger.error("[DingTalkWebhook] Error processing message:", err)
        })
      }

      res.status(200).json({ errcode: 0, errmsg: "ok" })
      return
    }

    if (body["challenge"]) {
      logger.info("[DingTalkWebhook] URL verification challenge received")
      res.status(200).json({ challenge: body["challenge"] })
      return
    }

    const eventType = body["eventType"] as string | undefined
    if (eventType === "card.action.trigger" && onCardAction) {
      logger.info("[DingTalkWebhook] Card action callback received")

      const cardAction = body["data"] as Record<string, unknown> | undefined
      if (cardAction) {
        onCardAction(cardAction).catch((err) => {
          logger.error("[DingTalkWebhook] Error processing card action:", err)
        })
      }

      res.status(200).json({ errcode: 0, errmsg: "ok" })
      return
    }

    if (body["msgtype"] || body["text"] || body["conversationId"]) {
      const conversationType = body["conversationType"] as string | number
      const senderId = (body["senderStaffId"] as string) || (body["senderId"] as string) || ""
      const chatId = (body["conversationId"] as string) || ""
      const msgId = (body["msgId"] as string) || `dm_${Date.now()}`
      const msgType = body["msgtype"] as string || "text"
      const content = body["text"] as { content?: string } | undefined
      const senderNick = body["senderNick"] as string | undefined
      const createAt = body["createAt"] as number | undefined

      const syntheticEvent = {
        msgId,
        senderStaffId: senderId,
        senderId: senderId,
        senderNick,
        conversationId: chatId,
        conversationType: String(conversationType || "1"),
        msgtype: msgType,
        text: content,
        createAt,
        _channelId: "dingtalk",
        _rawMessage: body,
      }

      onMessage(syntheticEvent).catch((err) => {
        logger.error("[DingTalkWebhook] Error processing message:", err)
      })

      res.status(200).json({ errcode: 0, errmsg: "ok" })
      return
    }

    logger.warn("[DingTalkWebhook] Unknown callback format")
    res.status(200).json({ errcode: 0, errmsg: "ok" })
  })

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() })
  })

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => {
      logger.info(`DingTalk webhook server listening on port ${port}`)
      resolve(s)
    })
  })

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
