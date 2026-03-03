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
          event_id: data.event_id ?? data.header?.event_id ?? msg.message_id ?? `ws_${Date.now()}`,
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
          mentions: msg.mentions,
        }

        await onMessage(messageEvent)
      } catch (err) {
        logger.error("Error handling WS message:", err)
      }
    },
  })

  // Register card.action.trigger callback (receives card button clicks via WebSocket)
  // See: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication
  // CRITICAL: Feishu requires a response within 3 seconds or it shows error 200340.
  // After EventDispatcher v2 parse, the data is flattened:
  //   { operator: { open_id }, action: { value, tag }, context?: { open_message_id, open_chat_id }, ... }
  if (onCardAction) {
    eventDispatcher.register({
      "card.action.trigger": async (data: any) => {
        try {
          const action: FeishuCardAction = {
            action: data.action ?? { tag: "button", value: {} },
            open_message_id: data.context?.open_message_id ?? data.open_message_id ?? "",
            open_chat_id: data.context?.open_chat_id ?? data.open_chat_id ?? "",
            operator: { open_id: data.operator?.open_id ?? "unknown" },
          }
          const actionType = action.action?.value?.action ?? "unknown"
          logger.info(`Card action received via WS: ${actionType}`, {
            open_message_id: action.open_message_id,
            operator: action.operator.open_id,
          })
          // Fire and forget — do NOT await.
          // The opencode POST may take >3s and Feishu will timeout the callback.
          void onCardAction(action).catch((err) => {
            logger.error("Error in card action handler:", err)
          })
          // Return toast + updated card to give instant feedback and disable buttons.
          // WSClient sends this back to Feishu as the callback response.
          return buildCallbackResponse(action)
        } catch (err) {
          logger.error("Error handling card action:", err)
          // Return empty object even on error to avoid Feishu error 200340.
          return {}
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

// ── Callback Response Builder ──

const PERMISSION_LABELS: Record<string, string> = {
  once: "Allowed (once)",
  always: "Always allowed",
  reject: "Rejected",
}

/**
 * Build the Feishu card callback response.
 * Returns a toast notification + an updated card with buttons disabled.
 * See: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication
 */
function buildCallbackResponse(action: FeishuCardAction): Record<string, unknown> {
  const actionType = action.action?.value?.action
  const value = action.action?.value ?? {}

  if (actionType === "question_answer") {
    let answerLabel = "(unknown)"
    try {
      const parsed = JSON.parse(value.answers ?? "[]") as string[][]
      answerLabel = parsed[0]?.[0] ?? answerLabel
    } catch { /* ignore parse errors */ }

    return {
      toast: { type: "success", content: `✅ Answered: ${answerLabel}` },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: "✅ Question Answered" },
            template: "green",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: `**Answer:** ${answerLabel}` } },
          ],
        },
      },
    }
  }

  if (actionType === "permission_reply") {
    const reply = value.reply ?? "unknown"
    const label = PERMISSION_LABELS[reply] ?? reply
    const isRejected = reply === "reject"

    return {
      toast: { type: isRejected ? "warning" : "success", content: `${isRejected ? "❌" : "✅"} ${label}` },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: `${isRejected ? "❌" : "✅"} Permission: ${label}` },
            template: isRejected ? "red" : "green",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: `**Decision:** ${label}` } },
          ],
        },
      },
    }
  }

  // Unknown action type — just acknowledge
  return {}
}
