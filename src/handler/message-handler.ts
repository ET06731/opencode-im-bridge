/**
 * Message handler — extracted from index.ts handleMessage().
 *
 * Supports two modes:
 *   1. Event-driven (preferred): POST message → subscribe to SSE events → collect TextDelta → respond on SessionIdle
 *   2. Sync fallback: POST message → parse response body → respond immediately
 */

import type { SessionManager } from "../session/session-manager.js"
import type { MessageDedup } from "../feishu/message-dedup.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { ProgressTracker } from "../session/progress-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { FeishuMessageEvent } from "../types.js"
import type { StreamingBridge } from "./streaming-integration.js"
import type { SessionObserver } from "../streaming/session-observer.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import type { CommandHandler } from "./command-handler.js"

// ── Dependency injection interface ──

export interface HandlerDeps {
  serverUrl: string
  sessionManager: SessionManager
  dedup: MessageDedup
  eventProcessor: EventProcessor
  feishuClient: FeishuApiClient
  progressTracker: ProgressTracker
  eventListeners: EventListenerMap
  ownedSessions: Set<string>
  logger: Logger
  streamingBridge?: StreamingBridge
  observer?: SessionObserver
  commandHandler?: CommandHandler
}

// ── Constants ──

const EVENT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ── Factory ──

export function createMessageHandler(
  deps: HandlerDeps,
): (event: FeishuMessageEvent) => Promise<void> {
  const {
    serverUrl,
    sessionManager,
    dedup,
    eventProcessor,
    feishuClient,
    progressTracker,
    eventListeners,
    ownedSessions,
    logger,
  } = deps
  const notifiedFeishuKeys = new Set<string>()

  return async function handleMessage(
    event: FeishuMessageEvent,
  ): Promise<void> {
    // ── 1. Dedup check ──
    if (dedup.isDuplicate(event.event_id)) {
      return
    }

    // ── 2. Skip non-text messages ──
    if (event.message.message_type !== "text") {
      logger.debug(
        `Skipping non-text message: ${event.message.message_type}`,
      )
      return
    }

    // ── 3. Parse user text ──
    let userText: string
    try {
      const parsed = JSON.parse(event.message.content) as { text?: string }
      userText = parsed.text ?? ""
    } catch {
      userText = event.message.content
    }

    if (!userText.trim()) return

    // ── 4. Resolve feishuKey ──
    const feishuKey =
      event.chat_type === "p2p"
        ? event.chat_id
        : event.root_id
          ? `${event.chat_id}:${event.root_id}`
          : `${event.chat_id}:${event.message_id}`

    logger.info(`Message from ${feishuKey}: ${userText.slice(0, 80)}...`)

    // ── 4b. Check for slash command ──
    if (userText.startsWith("/") && deps.commandHandler) {
      const handled = await deps.commandHandler(feishuKey, event.chat_id, event.message_id, userText.trim())
      if (handled) return
    }

    // ── 5. Send thinking indicator ──
    // With streaming bridge: add emoji reaction to user message.
    // Without streaming bridge: send thinking card via sendMessage.
    const thinkingMessageId = deps.streamingBridge
      ? null
      : await progressTracker.sendThinking(event.chat_id)
    let reactionId: string | null = null
    if (deps.streamingBridge) {
      try {
        const reactionResult = await feishuClient.addReaction(event.message_id, "Typing")
        reactionId = (reactionResult?.data?.reaction_id as string) ?? null
      } catch (err) {
        logger.warn(`addReaction failed: ${err}`)
      }
    }

    // ── 6. Get/create session ──
    const sessionId = await sessionManager.getOrCreate(feishuKey)
    ownedSessions.add(sessionId)
    // ── 6a. First-bind notification ──
    if (!notifiedFeishuKeys.has(feishuKey)) {
      notifiedFeishuKeys.add(feishuKey)
      await feishuClient.sendMessage(event.chat_id, {
        msg_type: "text",
        content: JSON.stringify({ text: "已连接 session: " + sessionId }),
      })
    }

    // ── 6b. Wire observer ──
    if (deps.observer) {
      deps.observer.observe(sessionId, event.chat_id)
    }

    // ── 7. Build parts ──
    const parts: Array<{ type: string; text: string }> = [
      { type: "text", text: userText },
    ]

    // ── 8. Build the POST-to-opencode function ──
    const promptUrl = `${serverUrl}/session/${sessionId}/message`
    const postBody = JSON.stringify({ parts })

    async function postToOpencode(): Promise<string> {
      const resp = await fetch(promptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody,
      })
      if (!resp.ok) {
        throw new Error(`Prompt HTTP error: ${resp.status}`)
      }
      const rawText = await resp.text()
      logger.info(
        `Prompt response (${rawText.length} bytes): ${rawText.slice(0, 200)}`,
      )
      return rawText
    }

    // ── 9. Try streaming bridge (registers listener BEFORE POST) → sync fallback ──
    if (deps.streamingBridge) {
      // Register ownership listener to mark Feishu-initiated messageIds
      let ownershipListener: ((event: unknown) => void) | null = null
      if (deps.observer) {
        ownershipListener = (rawEvent: unknown): void => {
          const props = rawEvent && typeof rawEvent === "object" ? (rawEvent as Record<string, unknown>).properties : null
          if (!props || typeof props !== "object") return
          const p = props as Record<string, unknown>
          const part = p.part
          const mid = part && typeof part === "object" ? (part as Record<string, unknown>).messageID : p.messageID
          if (typeof mid === "string") deps.observer!.markOwned(mid)
        }
        addListener(eventListeners, sessionId, ownershipListener)
      }

      try {
        await deps.streamingBridge.handleMessage(
          event.chat_id,
          sessionId,
          eventListeners,
          eventProcessor,
          postToOpencode,
          (responseText: string) => {
            if (ownershipListener) removeListener(eventListeners, sessionId, ownershipListener)
          },
          event.message_id,
          reactionId,
        )
        logger.info(`Response sent for session ${sessionId} (streaming bridge)`)
        return
      } catch (err) {
        if (ownershipListener) removeListener(eventListeners, sessionId, ownershipListener)
        logger.warn(
          `Streaming bridge failed, falling back to sync: ${err}`,
        )
        if (reactionId) {
          await feishuClient.deleteReaction(event.message_id, reactionId).catch(() => {})
        }
        try {
          const rawText = await postToOpencode()
          await handleSyncFallback(
            rawText,
            sessionId,
            userText,
            event,
            thinkingMessageId,
          )
        } catch (postErr) {
          logger.error(`Sync fallback POST also failed: ${postErr}`)
          const errorMessage = "处理请求时出错了。"
          await feishuClient.replyMessage(event.message_id, {
            msg_type: "text",
            content: JSON.stringify({ text: errorMessage }),
          })
        }
        logger.info(`Response sent for session ${sessionId} (sync fallback)`)
        return
      }
    }

    // No streaming bridge — direct POST then event-driven → sync fallback
    let rawText: string
    try {
      rawText = await postToOpencode()
    } catch (err) {
      logger.error(`POST to opencode failed: ${err}`)
      if (thinkingMessageId) {
        await progressTracker.updateWithError(
          thinkingMessageId,
          "处理请求时出错了。",
        )
      } else {
        await feishuClient.sendMessage(event.chat_id, {
          msg_type: "text",
          content: JSON.stringify({ text: "抱歉，处理请求时出错了。" }),
        })
      }
      return
    }

    // Register ownership listener for event-driven path
    let ownershipListenerEd: ((event: unknown) => void) | null = null
    if (deps.observer) {
      ownershipListenerEd = (rawEvent: unknown): void => {
        const props = rawEvent && typeof rawEvent === "object" ? (rawEvent as Record<string, unknown>).properties : null
        if (!props || typeof props !== "object") return
        const p = props as Record<string, unknown>
        const part = p.part
        const mid = part && typeof part === "object" ? (part as Record<string, unknown>).messageID : p.messageID
        if (typeof mid === "string") deps.observer!.markOwned(mid)
      }
      addListener(eventListeners, sessionId, ownershipListenerEd)
    }

    try {
      await waitForEventDrivenResponse(
        sessionId,
        userText,
        event,
        thinkingMessageId,
      )
    } catch (err) {
      logger.warn(
        `Event-driven flow failed, falling back to sync: ${err}`,
      )
      await handleSyncFallback(
        rawText,
        sessionId,
        userText,
        event,
        thinkingMessageId,
      )
    } finally {
      if (ownershipListenerEd) removeListener(eventListeners, sessionId, ownershipListenerEd)
    }
    logger.info(`Response sent for session ${sessionId}`)
  }

  // ── Event-driven flow ──

  async function waitForEventDrivenResponse(
    sessionId: string,
    userText: string,
    event: FeishuMessageEvent,
    thinkingMessageId: string | null,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let textBuffer = ""
      let settled = false

      const myListener = (rawEvent: unknown): void => {
        const action = eventProcessor.processEvent(rawEvent)
        if (!action) return
        if (action.sessionId !== sessionId) return

        switch (action.type) {
          case "TextDelta":
            textBuffer += action.text
            break

          case "SessionIdle": {
            if (settled) return
            settled = true
            cleanup()

            const responseText = textBuffer.trim() || "（无回复）"

            // Send response

            sendResponse(responseText, event, thinkingMessageId)
              .then(resolve)
              .catch(reject)
            break
          }


          default:
            break
        }
      }

      // Timeout guard
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(
          new Error(
            `Event-driven flow timed out after ${EVENT_TIMEOUT_MS}ms`,
          ),
        )
      }, EVENT_TIMEOUT_MS)

      function cleanup() {
        clearTimeout(timer)
        removeListener(eventListeners, sessionId, myListener)
      }

      // Register listener keyed by sessionId
      addListener(eventListeners, sessionId, myListener)
    })
  }

  // ── Sync fallback (existing behavior) ──

  async function handleSyncFallback(
    rawText: string,
    sessionId: string,
    userText: string,
    event: FeishuMessageEvent,
    thinkingMessageId: string | null,
  ): Promise<void> {
    if (!rawText.trim()) {
      logger.error("Empty response body from opencode server")
      if (thinkingMessageId) {
        await progressTracker.updateWithError(
          thinkingMessageId,
          "服务器返回了空响应。",
        )
      } else {
        await feishuClient.sendMessage(event.chat_id, {
          msg_type: "text",
          content: JSON.stringify({ text: "抱歉，服务器返回了空响应。" }),
        })
      }
      return
    }

    let promptData: { parts?: Array<{ type: string; text?: string }> } = {}
    try {
      promptData = JSON.parse(rawText)
    } catch (e) {
      logger.error(`Failed to parse prompt response: ${e}`)
      logger.error(`Raw response: ${rawText.slice(0, 500)}`)
    }

    logger.info(`Prompt parts count: ${promptData.parts?.length ?? 0}`)

    const responseText =
      promptData.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "（无回复）"


    await sendResponse(responseText, event, thinkingMessageId)
  }

  // ── Shared response sender ──

  async function sendResponse(
    responseText: string,
    event: FeishuMessageEvent,
    thinkingMessageId: string | null,
  ): Promise<void> {
    if (thinkingMessageId) {
      await progressTracker.updateWithResponse(thinkingMessageId, responseText)
    } else if (event.chat_type === "p2p") {
      const truncated =
        responseText.length > 4000
          ? responseText.slice(0, 4000) + "\n\n...(truncated)"
          : responseText
      await feishuClient.sendMessage(event.chat_id, {
        msg_type: "text",
        content: JSON.stringify({ text: truncated }),
      })
    } else {
      const truncated =
        responseText.length > 4000
          ? responseText.slice(0, 4000) + "\n\n...(truncated)"
          : responseText
      await feishuClient.replyMessage(event.message_id, {
        msg_type: "text",
        content: JSON.stringify({ text: truncated }),
      })
    }
  }
}
