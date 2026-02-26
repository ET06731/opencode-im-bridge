/**
 * Feishu WebSocket long-connection client.
 * No public URL needed — connects outbound to Feishu's servers.
 * Reference: ~/openclaw/extensions/feishu/src/monitor.ts
 */

import * as Lark from "@larksuiteoapi/node-sdk"
import { createLogger } from "../utils/logger.js"
import type { FeishuMessageEvent, FeishuCardAction } from "../types.js"
const logger = createLogger("feishu-ws")

interface WSClientOptions {
  appId: string
  appSecret: string
  onMessage: (event: FeishuMessageEvent) => Promise<void>
  onCardAction?: (action: FeishuCardAction) => Promise<void>
}

export function createFeishuWSGateway(options: WSClientOptions) {
  const { appId, appSecret, onMessage, onCardAction } = options

  const eventDispatcher = new Lark.EventDispatcher({})

  // Register im.message.receive_v1 handler
  eventDispatcher.register({
    "im.message.receive_v1": async (data: any) => {
      try {
        const msg = data.message
        const sender = data.sender

        // Ignore bot's own messages
        if (sender?.sender_type === "app") return

        const messageEvent: FeishuMessageEvent = {
          event_id: data.header?.event_id ?? msg.message_id ?? `ws_${Date.now()}`,
          event_type: "im.message.receive_v1",
          chat_id: msg.chat_id,
          chat_type: msg.chat_type as "p2p" | "group",
          message_id: msg.message_id,
          root_id: msg.root_id,
          parent_id: msg.parent_id,
          sender: {
            sender_id: sender?.sender_id ?? { open_id: "unknown" },
            sender_type: sender?.sender_type ?? "unknown",
            tenant_key: sender?.tenant_key ?? "unknown",
          },
          message: {
            message_type: msg.message_type,
            content: msg.content,
          },
        }

        await onMessage(messageEvent)
      } catch (err) {
        logger.error("Error handling WS message:", err)
      }
    },
  })

  // Register card.action.trigger handler (receives card button clicks via WebSocket)
  if (onCardAction) {
    eventDispatcher.register({
      "card.action.trigger": async (data: any) => {
        try {
          const action: FeishuCardAction = {
            action: data.action ?? { tag: "button", value: {} },
            open_message_id: data.context?.open_message_id ?? "",
            open_chat_id: data.context?.open_chat_id ?? "",
            operator: { open_id: data.operator?.open_id ?? "unknown" },
          }
          logger.info(`Card action received: ${action.action?.value?.action ?? "unknown"}`)
          await onCardAction(action)
        } catch (err) {
          logger.error("Error handling card action:", err)
        }
      },
    })
  }

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  })

  return {
    start() {
      logger.info("Starting Feishu WebSocket connection...")
      wsClient.start({ eventDispatcher })
      logger.info("Feishu WebSocket client started (long-polling Feishu servers)")
    },
  }
}
