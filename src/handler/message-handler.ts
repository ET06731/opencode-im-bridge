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
import { FileTooLargeError, type FeishuApiClient } from "../feishu/api-client.js"
import type { ProgressTracker } from "../session/progress-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { FeishuMessageEvent } from "../types.js"
import type { StreamingBridge } from "./streaming-integration.js"
import type { SessionObserver } from "../streaming/session-observer.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import type { CommandHandler } from "./command-handler.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import { getAttachmentsDir } from "../utils/paths.js"
import { writeFile, mkdir, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"

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
  botOpenId?: string
  outboundMedia?: OutboundMediaHandler
}

// ── Constants ──

const EVENT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ── Helper: resolve the download directory ──

let cachedDownloadDir: string | null = null

async function resolveDownloadDir(): Promise<string> {
  if (cachedDownloadDir) return cachedDownloadDir
  const primaryDir = getAttachmentsDir()
  try {
    await mkdir(primaryDir, { recursive: true })
    await access(primaryDir)
    cachedDownloadDir = primaryDir
    return primaryDir
  } catch {
    const fallbackDir = join(tmpdir(), "opencode-lark-downloads")
    await mkdir(fallbackDir, { recursive: true })
    cachedDownloadDir = fallbackDir
    return fallbackDir
  }
}

// ── Helper: sanitize untrusted Feishu filename ──

function sanitizeFilename(raw: string): string {
  // Strip path separators, parent-dir traversals, and control characters
  let name = raw
    .replace(/[/\\]/g, "")
    .replace(/\.\./g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()

  if (!name) name = "file"

  // Clamp to prevent filesystem issues (255 byte limit)
  const MAX_NAME_LEN = 200 // leave room for timestamp-rand prefix
  if (name.length > MAX_NAME_LEN) {
    const dotIdx = name.lastIndexOf(".")
    const ext = dotIdx > 0 ? name.slice(dotIdx) : ""
    name = name.slice(0, MAX_NAME_LEN - ext.length) + ext
  }

  const timestamp = Date.now()
  const rand = randomBytes(2).toString("hex")
  return `${timestamp}-${rand}-${name}`
}

// ── Helper: download and save file/image from Feishu ──

async function handleFileOrImageMessage(
  type: "image" | "file",
  content: string,
  messageId: string,
  feishuClient: FeishuApiClient,
  logger: Logger,
): Promise<string> {
  const parsed = JSON.parse(content) as Record<string, string>

  const downloadDir = await resolveDownloadDir()

  if (type === "image") {
    const imageKey = parsed.image_key
    if (!imageKey) {
      throw new Error("Missing image_key in image message content")
    }

    const { data } = await feishuClient.downloadResource(messageId, imageKey, "image")
    const safeName = sanitizeFilename("image.png")
    const filepath = join(downloadDir, safeName)

    // Guard against path traversal
    if (!resolve(filepath).startsWith(resolve(downloadDir))) {
      throw new Error("Path traversal detected in filename")
    }

    await writeFile(filepath, data, { mode: 0o600 })
    logger.info(`Saved image to ${filepath}`)

    return `User sent an image.\nSaved to: ${filepath}\nPlease look at this image.`
  }

  // type === "file"
  const fileKey = parsed.file_key
  const fileName = parsed.file_name ?? "unknown_file"
  if (!fileKey) {
    throw new Error("Missing file_key in file message content")
  }

  const { data } = await feishuClient.downloadResource(messageId, fileKey, "file")
  const safeName = sanitizeFilename(fileName)
  const filepath = join(downloadDir, safeName)

  // Guard against path traversal
  if (!resolve(filepath).startsWith(resolve(downloadDir))) {
    throw new Error("Path traversal detected in filename")
  }

  await writeFile(filepath, data, { mode: 0o600 })
  logger.info(`Saved file to ${filepath}`)

  return `User sent a file: ${fileName}\nSaved to: ${filepath}\nPlease review this file.`
}

// ── Helper: extract text from Feishu post rich content ──

function extractTextFromPost(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    
    // Determine the post data structure:
    // Format 1 (flat, from WebSocket): { title?: string, content: [[...]] }
    // Format 2 (locale-wrapped, from REST API): { zh_cn: { title?: string, content: [[...]] } }
    let postData: { title?: string; content?: Array<Array<{ tag: string; text?: string }>> }
    
    if (Array.isArray(parsed.content)) {
      // Flat format — content is directly on the object
      postData = parsed as typeof postData
    } else {
      // Locale-wrapped format — pick first locale value
      const locale = Object.values(parsed)[0]
      if (!locale || typeof locale !== "object") return ""
      postData = locale as typeof postData
    }
    
    if (!postData?.content) return ""
    
    const lines: string[] = []
    if (postData.title) lines.push(postData.title)
    
    for (const paragraph of postData.content) {
      const lineText = paragraph
        .filter((el) => (el.tag === "text" || el.tag === "a") && el.text)
        .map((el) => el.text!)
        .join("")
      if (lineText) lines.push(lineText)
    }
    
    return lines.join("\n")
  } catch {
    return ""
  }
}

// ── Helper: fetch quoted message text for reply context ──

async function fetchQuotedText(
  feishuClient: FeishuApiClient,
  parentId: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const resp = await feishuClient.getMessage(parentId)
    if (resp.code !== 0 || !resp.data) return null

    const items = resp.data.items as Array<{
      msg_type?: string
      body?: { content?: string }
    }> | undefined

    const item = items?.[0]
    if (!item?.body?.content) return null

    if (item.msg_type === "text") {
      try {
        const parsed = JSON.parse(item.body.content) as { text?: string }
        return parsed.text ?? null
      } catch {
        return item.body.content
      }
    }

    if (item.msg_type === "post") {
      return extractTextFromPost(item.body.content) || null
    }

    return null
  } catch (err) {
    logger.warn(`Failed to fetch quoted message ${parentId}: ${err}`)
    return null
  }
}

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
  const signedSessions = new Set<string>()

  return async function handleMessage(
    event: FeishuMessageEvent,
  ): Promise<void> {
    // ── 1. Dedup check ──
    if (dedup.isDuplicate(event.event_id)) {
      return
    }

    // ── 1b. Skip group messages that don't @mention the bot ──
    if (event.chat_type === "group") {
      if (!deps.botOpenId) {
        logger.warn("botOpenId not configured — ignoring group message")
        return
      }
      const botMentioned = event.mentions?.some(m => m.id.open_id === deps.botOpenId)
      if (!botMentioned) return
    }

    // ── 2. Handle message types ──
    const messageType = event.message.message_type
    const supportedTypes = ["text", "post", "image", "file"]
    if (!supportedTypes.includes(messageType)) {
      logger.info(
        `Unsupported message type: ${messageType}, only text/post/image/file are supported`,
      )
      return
    }

    // ── 3. Parse user text ──
    let userText: string
    if (messageType === "image" || messageType === "file") {
      try {
        userText = await handleFileOrImageMessage(
          event.message.message_type as "image" | "file",
          event.message.content,
          event.message_id,
          feishuClient,
          logger,
        )
      } catch (err) {
        logger.error(`Failed to handle ${messageType} message: ${err}`)
        // Forward error context to opencode instead of silently skipping
        let fileKey = "unknown"
        try {
          const parsedContent = JSON.parse(event.message.content) as Record<string, string>
          fileKey = parsedContent.file_key ?? parsedContent.image_key ?? "unknown"
        } catch {
          // content wasn't valid JSON, use default
        }
        if (err instanceof FileTooLargeError) {
          userText = `User sent file "${err.filename}" but it exceeds the 50MB size limit. Download skipped.`
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          userText = `User sent a file/image but download failed: ${errMsg}. Feishu message_id: ${event.message_id}, file_key: ${fileKey}`
        }
      }
    } else if (messageType === "post") {
      userText = extractTextFromPost(event.message.content)
    } else {
      try {
        const parsed = JSON.parse(event.message.content) as { text?: string }
        userText = parsed.text ?? ""
      } catch {
        userText = event.message.content
      }
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

    // ── 7b. Include quoted message context ──
    if (event.parent_id) {
      const quotedText = await fetchQuotedText(feishuClient, event.parent_id, logger)
      if (quotedText) {
        parts[0] = {
          type: "text",
          text: `> ${quotedText.split("\n").join("\n> ")}\n\n${userText}`,
        }
      }
    }

    // ── 7c. Add Lark context signature (full context on first message, lightweight tag on subsequent messages) ──
    if (parts[0]) {
      if (!signedSessions.has(sessionId)) {
        // Prevent unbounded growth — re-signing is harmless
        if (signedSessions.size > 1000) signedSessions.clear()
        signedSessions.add(sessionId)
        const attachDir = getAttachmentsDir()
        parts[0] = {
          type: "text",
          text: parts[0].text + `\n[Lark] Save files → ${attachDir} (auto-sent to user)`,
        }
      } else {
        parts[0] = {
          type: "text",
          text: parts[0].text + `\n[Lark]`,
        }
      }
    }

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
      // Tell observer to skip TextDelta/SessionIdle for this session
      if (deps.observer) deps.observer.markSessionBusy(sessionId)

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
          (_responseText: string) => {
            if (ownershipListener) removeListener(eventListeners, sessionId, ownershipListener)
            if (deps.observer) deps.observer.markSessionFree(sessionId)
          },
          event.message_id,
          reactionId,
        )
        logger.info(`Response sent for session ${sessionId} (streaming bridge)`)
        return
      } catch (err) {
        if (ownershipListener) removeListener(eventListeners, sessionId, ownershipListener)
        if (deps.observer) deps.observer.markSessionFree(sessionId)
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
    _userText: string,
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
              .then(async () => {
                // Only upload files here if streaming bridge is NOT handling this session.
                // When streaming bridge is active, it handles outbound media in its own SessionIdle.
                if (deps.outboundMedia && !deps.streamingBridge) {
                  try {
                    await deps.outboundMedia.sendDetectedFiles(event.chat_id, responseText)
                  } catch (err) {
                    logger.warn(`outboundMedia.sendDetectedFiles failed: ${err}`)
                  }
                }
              })
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
    _sessionId: string,
    _userText: string,
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
    if (deps.outboundMedia) {
      try {
        await deps.outboundMedia.sendDetectedFiles(event.chat_id, responseText)
      } catch (err) {
        logger.warn(`outboundMedia.sendDetectedFiles in sync fallback failed: ${err}`)
      }
    }
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
