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
import type { CommandHandlerEx } from "./command-handler.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import { MessageDebouncer, type BufferedMessage, type BatchContext } from "./message-debounce.js"
import { getAttachmentsDir } from "../utils/paths.js"
import { writeFile, mkdir, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { downloadQQMedia, parseQQMediaMessage, type QQMediaMessage } from "../channel/qq/qq-api-client.js"
import type { ServiceLauncher } from "../reliability/service-launcher.js"

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
  commandHandler?: CommandHandlerEx
  botOpenId?: string
  outboundMedia?: OutboundMediaHandler
  debounceMs?: number
  channelManager?: any // ChannelManager type
  serviceLauncher?: ServiceLauncher
}

// ── Constants ──

const EVENT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Thrown when POST /session/{id}/message returns 404 — session no longer exists. */
export class SessionGoneError extends Error {
  constructor(public readonly sessionId: string, public readonly status: number) {
    super(`Session ${sessionId} returned HTTP ${status} — session no longer exists`)
    this.name = "SessionGoneError"
  }
}

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

// ── Helper: handle QQ media messages ──

async function handleQQMediaMessage(
  content: string,
  rawMessage: any[],
  messageId: string,
  logger: Logger,
): Promise<string> {
  let parsed: { media?: any[]; text?: string }
  try {
    parsed = JSON.parse(content)
  } catch {
    return content || ""
  }

  const mediaItems: any[] = parsed.media || parseQQMediaMessage(rawMessage)

  if (mediaItems.length === 0) {
    return parsed.text || content || ""
  }

  const results: string[] = []

  for (const media of mediaItems) {
    try {
      const localPath = await downloadQQMedia(media, logger)
      results.push(`User sent a ${media.type}: ${media.fileName || "unnamed"}\nSaved to: ${localPath}\nPlease look at this ${media.type}.`)
    } catch (err) {
      logger.error(`[QQPlugin] Failed to download ${media.type}: ${err}`)
      results.push(`User sent a ${media.type} (${media.fileName || "unnamed"}) but download failed: ${err}`)
    }
  }

  if (parsed.text) {
    results.push(parsed.text)
  }

  return results.join("\n\n")
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

function getPlatformSignatureLabel(
  channelId: string,
  plugin?: { meta?: { label?: string } },
): string {
  if (channelId === "feishu" || channelId === "lark") {
    return "Lark"
  }

  const label = plugin?.meta?.label?.trim()
  if (label) return label
  if (!channelId) return "Chat"
  return channelId.charAt(0).toUpperCase() + channelId.slice(1)
}

function appendPlatformContextSignature(
  text: string,
  sessionId: string,
  channelId: string,
  signedSessions: Set<string>,
  plugin?: { meta?: { label?: string } },
): string {
  const signatureLabel = getPlatformSignatureLabel(channelId, plugin)

  if (!signedSessions.has(sessionId)) {
    if (signedSessions.size > 1000) signedSessions.clear()
    signedSessions.add(sessionId)

    const attachDir = getAttachmentsDir()
    return `${text}\n[${signatureLabel}] Save files -> ${attachDir} (auto-send to user). You can save files to this directory.\n\nScheduled Task: Use /cron {natural language description} to create a scheduled task, e.g., "/cron set a reminder to eat everyday at 19:10", "/cron meeting at 9am on weekdays".`
  }

  return `${text}\n[${signatureLabel}]`
}

export interface MessageHandlerResult {
  handleMessage: (event: FeishuMessageEvent) => Promise<void>
  /** Flush all pending debounce buffers and clear timers. */
  dispose: () => void
}

export function createMessageHandler(
  deps: HandlerDeps,
): MessageHandlerResult {
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

  // ── Debouncer (opt-in via debounceMs > 0) ──
  const debouncer = deps.debounceMs && deps.debounceMs > 0
    ? new MessageDebouncer(deps.debounceMs, handleBatchFlush, logger)
    : null

  async function fetchWithWakeRetry(
    url: string,
    init: RequestInit,
    reason: string,
  ): Promise<Response> {
    try {
      return await fetch(url, init)
    } catch (err) {
      const wakeResult = await deps.serviceLauncher?.ensureServerReady(reason)
      if (!wakeResult?.healthy) {
        throw err
      }
      logger.info(`[launcher] retrying request after wake (${reason})`)
      return await fetch(url, init)
    }
  }

  async function handleMessage(
    event: FeishuMessageEvent,
  ): Promise<void> {
    // ── 1. Dedup check ──
    if (dedup.isDuplicate(event.event_id)) {
      return
    }

    // ── 0. Channel detection ──
    const channelId = (event as any)._channelId || "feishu"
    const plugin = deps.channelManager?.getChannel(channelId)
    logger.info(`MessageHandler handleMessage: channelId detected as ${channelId} (raw _channelId: ${(event as any)._channelId})`)

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

    const feishuSupportedTypes = ["text", "post", "image", "file"]
    const qqSupportedTypes = ["text", "image", "file"]
    const wechatSupportedTypes = ["text", "image", "file", "voice", "video"]
    let supportedTypes: string[]
    if (channelId === "qq") {
      supportedTypes = qqSupportedTypes
    } else if (channelId === "wechat") {
      supportedTypes = wechatSupportedTypes
    } else {
      supportedTypes = feishuSupportedTypes
    }

    if (!supportedTypes.includes(messageType)) {
      logger.info(
        `Unsupported message type: ${messageType} for channel ${channelId}, only ${supportedTypes.join("/")} are supported`,
      )
      return
    }

    // ── 3. Parse user text ──
    let userText: string
    if (messageType === "image" || messageType === "file") {
      try {
        if (channelId === "qq") {
          userText = await handleQQMediaMessage(
            event.message.content,
            (event as any)._rawMessage || [],
            event.message_id,
            logger,
          )
        } else if (channelId === "wechat") {
          // 微信：使用已提取的文本内容（包含媒体类型和文件信息）
          // 微信的图片/文件消息已经在 normalizeInbound 中提取了文本
          const parsed = JSON.parse(event.message.content)
          userText = parsed.text || ""
        } else {
          // 飞书
          userText = await handleFileOrImageMessage(
            event.message.message_type as "image" | "file",
            event.message.content,
            event.message_id,
            feishuClient,
            logger,
          )
        }
      } catch (err) {
        logger.error(`Failed to handle ${messageType} message for ${channelId}: ${err}`)
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
          userText = `User sent a ${messageType} but download failed: ${errMsg}. Message ID: ${event.message_id}`
        }
      }
    } else if (messageType === "voice" || messageType === "video") {
      // 微信语音/视频消息处理
      try {
        const parsed = JSON.parse(event.message.content)
        userText = parsed.text || ""
      } catch {
        userText = event.message.content || ""
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
      const handled = await deps.commandHandler(
        feishuKey,
        event.chat_id,
        event.message_id,
        userText.trim(),
        channelId,
        { replyToMessageId: event.parent_id, quotedText: (event as any).quoted_text },
      )
      if (handled) return
    }

    // ── 4c. If there's an active task creation flow, route ALL messages there ──
    const cmdHandlerEx = deps.commandHandler as CommandHandlerEx | undefined
    if (cmdHandlerEx?.handleTaskConfirmation) {
      const confirmed = await cmdHandlerEx.handleTaskConfirmation(feishuKey, event.chat_id, event.message_id, channelId, userText)
      if (confirmed) return
    }

    // ── 4d. Check for natural language schedule intent ──
    const schedulePatterns = [/每天.*[点时]/, /每周.*[点时]/, /每.*小时/, /每.*分钟/, /提醒我/, /定时任务/]
    if (schedulePatterns.some(p => p.test(userText))) {
      logger.info(`[schedule-intent] Detected schedule intent in: "${userText}"`)
      if (cmdHandlerEx?.handleTaskConfirmation) {
        // Start a new task creation flow
        const session = deps.sessionManager?.getSession(feishuKey)
        logger.info(`[schedule-intent] Session check for ${feishuKey}: ${session ? 'found' : 'not found'}`)
        if (session && deps.commandHandler) {
          await deps.commandHandler(feishuKey, event.chat_id, event.message_id, "/cron add", channelId)
          const confirmed = await cmdHandlerEx.handleTaskConfirmation(feishuKey, event.chat_id, event.message_id, channelId, userText)
          logger.info(`[schedule-intent] handleTaskConfirmation result: ${confirmed}`)
          if (confirmed) return
        } else {
          logger.warn(`[schedule-intent] No session found for ${feishuKey}, cannot create task`)
        }
      }
    }

    // ── 4c. Debounce path (when enabled) ──
    // Strategy: image/file → buffer + timer (wait for follow-up text).
    //          text/post  → if buffer has pending media, add + immediate flush;
    //                       if buffer is empty, skip debounce entirely.
    if (debouncer) {
      const debounceKey = `${event.sender.sender_id.open_id}:${feishuKey}`
      const isMedia = messageType === "image" || messageType === "file"

      if (isMedia) {
        // Media message: buffer it and wait for follow-up text
        const isFirst = debouncer.add(debounceKey, {
          userText,
          event,
          timestamp: Date.now(),
        }, { startTimer: false })

        if (isFirst) {
          // Mark as initializing BEFORE any async work. While initializing,
          // subsequent add() calls will buffer but NOT start/reset the timer.
          // This prevents the race where media2 arrives during init and starts
          // a timer that fires before context (reaction, thinking) is set.
          debouncer.setInitializing(debounceKey)

          try {
            // Send thinking indicator for first message in batch
            const thinkMsgId = deps.streamingBridge
              ? null
              : await progressTracker.sendThinking(event.chat_id)
            let firstReactionId: string | null = null
            if (deps.streamingBridge) {
              try {
                const reactionResult = await feishuClient.addReaction(
                  event.message_id, "Typing",
                )
                firstReactionId = (reactionResult?.data?.reaction_id as string) ?? null
              } catch (err) {
                logger.warn(`addReaction failed: ${err}`)
              }
            }
            debouncer.updateContext(debounceKey, {
              thinkingMessageId: thinkMsgId,
              reactionId: firstReactionId,
              reactionMessageId: firstReactionId ? event.message_id : null,
            })
          } finally {
            // Always resolve init, even if sendThinking/addReaction threw.
            // This ensures the buffer never gets stuck in initializing state.
            debouncer.resolveInit(debounceKey)
          }
        }

        return // Wait for timer or follow-up text
      }

      // Text/post message: check if there's pending media in buffer
      if (debouncer.hasPending(debounceKey)) {
        // Buffer the text message
        debouncer.add(debounceKey, {
          userText,
          event,
          timestamp: Date.now(),
        })

        if (debouncer.isInitializing(debounceKey)) {
          // Init still in progress — context (reaction/thinking) not set yet.
          // Mark for immediate flush when init completes, preserving context.
          debouncer.markFlushOnInit(debounceKey)
        } else {
          // Init done, context ready — safe to flush now
          debouncer.flush(debounceKey)
        }
        return
      }

      // No pending media — fall through to non-debounced path below
    }

    // ── 5. Send thinking indicator ──
    // With streaming bridge: add emoji reaction to user message.
    // Without streaming bridge: send thinking card via sendMessage.
    const thinkingMessageId = deps.streamingBridge || channelId !== "feishu"
      ? null
      : await progressTracker.sendThinking(event.chat_id)
    let reactionId: string | null = null
    if (channelId === "feishu") {
      try {
        // Use a more appropriate reaction for thinking
        const reactionResult = await feishuClient.addReaction(event.message_id, "THINKING")
        reactionId = (reactionResult?.data?.reaction_id as string) ?? null
        // Send real-time typing indicator
        await feishuClient.sendTypingIndicator(event.chat_id)
      } catch (err) {
        logger.warn(`addReaction/typingIndicator failed: ${err}`)
      }
    }

    // ── 6. Get/create session ──
    let sessionId = await sessionManager.getOrCreate(feishuKey)
    ownedSessions.add(sessionId)
    // ── 6a. First-bind notification ──
    if (!notifiedFeishuKeys.has(feishuKey)) {
      notifiedFeishuKeys.add(feishuKey)
      const bindText = "已连接 session: " + sessionId
      if (plugin?.outbound) {
        await plugin.outbound.sendText({ address: event.chat_id }, bindText)
      } else {
        await feishuClient.sendMessage(event.chat_id, {
          msg_type: "text",
          content: JSON.stringify({ text: bindText }),
        })
      }
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

    // ── 7c. Add platform context signature (full context on first message, lightweight tag on subsequent messages) ──
    if (parts[0]) {
      parts[0] = {
        type: "text",
        text: appendPlatformContextSignature(
          parts[0].text,
          sessionId,
          channelId,
          signedSessions,
          plugin,
        ),
      }
    }

    // ── 8. Build the POST-to-opencode function ──
    let currentSessionId = sessionId
    const preferredAgent = sessionManager.getSession(feishuKey)?.agent
    const postBody = JSON.stringify({ parts, agent: preferredAgent })

    async function postToOpencode(): Promise<string> {
      const url = `${serverUrl}/session/${currentSessionId}/message`
      const resp = await fetchWithWakeRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody,
      }, "incoming message")
      if (resp.status === 404) {
        throw new SessionGoneError(currentSessionId, 404)
      }
      if (!resp.ok) {
        throw new Error(`Prompt HTTP error: ${resp.status}`)
      }
      const rawText = await resp.text()
      logger.info(
        `Prompt response (${rawText.length} bytes): ${rawText.slice(0, 200)}`,
      )
      return rawText
    }

    /** Recover from 404: clear stale mapping, re-resolve session, retry POST once. */
    async function postWithRecovery(): Promise<string> {
      try {
        return await postToOpencode()
      } catch (err) {
        if (!(err instanceof SessionGoneError)) throw err
        logger.warn(`Session ${currentSessionId} returned 404 — clearing stale mapping and retrying`)
        sessionManager.deleteMapping(feishuKey)
        const newSessionId = await sessionManager.getOrCreate(feishuKey, preferredAgent)
        ownedSessions.add(newSessionId)
        logger.info(`Session self-healed: ${currentSessionId} → ${newSessionId}`)
        currentSessionId = newSessionId
        sessionId = newSessionId
        // Retry once with new session
        return await postToOpencode()
      }
    }

    // ── 9. Try streaming bridge (registers listener BEFORE POST) → sync fallback ──
    if (deps.streamingBridge) {
      // Helper: run streaming bridge for a given session, with proper listener lifecycle
      const runStreamingBridge = async (sid: string): Promise<void> => {
        if (deps.observer) deps.observer.markSessionBusy(sid)

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
          addListener(eventListeners, sid, ownershipListener)
        }

        // Capture current session in closure for postToOpencode
        currentSessionId = sid

        try {
          const channelId = (event as any)._channelId || "feishu"
          await deps.streamingBridge!.handleMessage(
            event.chat_id,
            sid,
            eventListeners,
            eventProcessor,
            postToOpencode,
            (_responseText: string) => {
              if (ownershipListener) removeListener(eventListeners, sid, ownershipListener)
              if (deps.observer) deps.observer.markSessionFree(sid)
            },
            event.message_id,
            reactionId,
            channelId,
          )
        } catch (err) {
          // Always clean up on error
          if (ownershipListener) removeListener(eventListeners, sid, ownershipListener)
          if (deps.observer) deps.observer.markSessionFree(sid)
          throw err
        }
      }

      try {
        if (deps.outboundMedia) {
          await deps.outboundMedia.snapshotAttachments(event.chat_id)
        }
        await runStreamingBridge(sessionId)
        logger.info(`Response sent for session ${sessionId} (streaming bridge)`)
        return
      } catch (err) {
        logger.error(`StreamingBridge failed for session ${sessionId}: ${err}`)
        if (err instanceof SessionGoneError) {
          // 404 self-healing: clear stale mapping, get new session, retry once
          logger.warn(`Session ${sessionId} returned 404 in streaming path — clearing stale mapping and retrying`)
          sessionManager.deleteMapping(feishuKey)
          const newSessionId = await sessionManager.getOrCreate(feishuKey)
          ownedSessions.add(newSessionId)
          logger.info(`Session self-healed (streaming): ${sessionId} → ${newSessionId}`)
          sessionId = newSessionId

          try {
            await runStreamingBridge(newSessionId)
            logger.info(`Response sent for session ${newSessionId} (streaming bridge, after 404 recovery)`)
            return
          } catch (retryErr) {
            // Retry failed — fall through to sync fallback below
            logger.warn(`Streaming bridge retry also failed: ${retryErr}`)
          }
        } else {
          logger.warn(`Streaming bridge failed, falling back to sync: ${err}`)
        }

        // Sync fallback — reaction cleanup only here (not during 404 retry)
        if (reactionId) {
          await feishuClient.deleteReaction(event.message_id, reactionId).catch(() => { })
        }
        if (deps.outboundMedia) {
          await deps.outboundMedia.snapshotAttachments(event.chat_id)
        }
        try {
          const rawText = await postWithRecovery()
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
          if (plugin?.outbound) {
            await plugin.outbound.sendText({ address: event.chat_id }, errorMessage)
          } else {
            await feishuClient.replyMessage(event.message_id, {
              msg_type: "text",
              content: JSON.stringify({ text: errorMessage }),
            })
          }
        }
        logger.info(`Response sent for session ${sessionId} (sync fallback)`)
        return
      }
    }

    // No streaming bridge — direct POST then event-driven → sync fallback
    let rawText: string
    try {
      rawText = await postWithRecovery()
    } catch (err) {
      logger.error(`POST to opencode failed: ${err}`)
      if (thinkingMessageId) {
        await progressTracker.updateWithError(
          thinkingMessageId,
          "处理请求时出错了。",
        )
      } else {
        const errorMsg = "抱歉，处理请求时出错了。"
        if (plugin?.outbound) {
          await plugin.outbound.sendText({ address: event.chat_id }, errorMsg)
        } else {
          await feishuClient.sendMessage(event.chat_id, {
            msg_type: "text",
            content: JSON.stringify({ text: errorMsg }),
          })
        }
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

  // ── Debounce flush handler ──

  async function handleBatchFlush(
    _debounceKey: string,
    messages: BufferedMessage[],
    context: BatchContext,
  ): Promise<void> {
    const mergedText = messages.map(m => m.userText).join("\n")
    const event = context.firstEvent
    const lastEvent = context.lastEvent
    const thinkingMessageId = context.thinkingMessageId
    const reactionId = context.reactionId
    const reactionMessageId = context.reactionMessageId

    // Resolve feishuKey from first event
    const feishuKey =
      event.chat_type === "p2p"
        ? event.chat_id
        : event.root_id
          ? `${event.chat_id}:${event.root_id}`
          : `${event.chat_id}:${event.message_id}`

    logger.info(
      `Flushing ${messages.length} debounced message(s) for ${feishuKey}: ${mergedText.slice(0, 80)}...`,
    )

    // Get/create session
    let sessionId = await sessionManager.getOrCreate(feishuKey)
    ownedSessions.add(sessionId)

    // First-bind notification
    if (!notifiedFeishuKeys.has(feishuKey)) {
      notifiedFeishuKeys.add(feishuKey)
      const bindMsg = "已连接 session: " + sessionId
      const qqPlugin = deps.channelManager?.getChannel("qq")
      const feishuPlugin = deps.channelManager?.getChannel("feishu")
      const plugin = (event as any)._channelId === "qq" ? qqPlugin : feishuPlugin

      if (plugin?.outbound) {
        await plugin.outbound.sendText({ address: event.chat_id }, bindMsg)
      } else {
        await feishuClient.sendMessage(event.chat_id, {
          msg_type: "text",
          content: JSON.stringify({ text: bindMsg }),
        })
      }
    }

    // Wire observer
    if (deps.observer) {
      deps.observer.observe(sessionId, event.chat_id)
    }

    // Build parts from merged text
    const parts: Array<{ type: string; text: string }> = [
      { type: "text", text: mergedText },
    ]

    // Include quoted message context from first event only
    if (event.parent_id) {
      const quotedText = await fetchQuotedText(feishuClient, event.parent_id, logger)
      if (quotedText) {
        parts[0] = {
          type: "text",
          text: `> ${quotedText.split("\n").join("\n> ")}\n\n${mergedText}`,
        }
      }
    }

    // Add platform context signature
    if (parts[0]) {
      const channelId = (event as any)._channelId || "feishu"
      const platformPlugin = deps.channelManager?.getChannel(channelId)
      parts[0] = {
        type: "text",
        text: appendPlatformContextSignature(
          parts[0].text,
          sessionId,
          channelId,
          signedSessions,
          platformPlugin,
        ),
      }
    }

    // Build POST function
    let currentSessionId = sessionId
    const postBody = JSON.stringify({ parts })

    async function postToOpencode(): Promise<string> {
      const url = `${serverUrl}/session/${currentSessionId}/message`
      const resp = await fetchWithWakeRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody,
      }, "debounced message")
      if (resp.status === 404) {
        throw new SessionGoneError(currentSessionId, 404)
      }
      if (!resp.ok) {
        throw new Error(`Prompt HTTP error: ${resp.status}`)
      }
      const rawText = await resp.text()
      logger.info(
        `Prompt response (${rawText.length} bytes): ${rawText.slice(0, 200)}`,
      )
      return rawText
    }

    /** Recover from 404: clear stale mapping, re-resolve session, retry POST once. */
    async function postWithRecovery(): Promise<string> {
      try {
        return await postToOpencode()
      } catch (err) {
        if (!(err instanceof SessionGoneError)) throw err
        logger.warn(`Session ${currentSessionId} returned 404 in debounced path — clearing stale mapping and retrying`)
        sessionManager.deleteMapping(feishuKey)
        const newSessionId = await sessionManager.getOrCreate(feishuKey)
        ownedSessions.add(newSessionId)
        logger.info(`Session self-healed (debounced): ${currentSessionId} → ${newSessionId}`)
        currentSessionId = newSessionId
        sessionId = newSessionId
        // Retry once with new session
        return await postToOpencode()
      }
    }

    // Use streaming bridge or event-driven/sync path (same as non-debounced flow)
    if (deps.streamingBridge) {
      const reactionMsgId = reactionMessageId ?? lastEvent.message_id

      // Helper: run streaming bridge for a given session, with proper listener lifecycle
      const runStreamingBridge = async (sid: string): Promise<void> => {
        if (deps.observer) deps.observer.markSessionBusy(sid)

        let ownershipListener: ((ev: unknown) => void) | null = null
        if (deps.observer) {
          ownershipListener = (rawEvent: unknown): void => {
            const props = rawEvent && typeof rawEvent === "object" ? (rawEvent as Record<string, unknown>).properties : null
            if (!props || typeof props !== "object") return
            const p = props as Record<string, unknown>
            const part = p.part
            const mid = part && typeof part === "object" ? (part as Record<string, unknown>).messageID : p.messageID
            if (typeof mid === "string") deps.observer!.markOwned(mid)
          }
          addListener(eventListeners, sid, ownershipListener)
        }

        // Capture current session in closure for postToOpencode
        currentSessionId = sid

        try {
          const channelId = (event as any)._channelId || "feishu"
          await deps.streamingBridge!.handleMessage(
            event.chat_id,
            sid,
            eventListeners,
            eventProcessor,
            postToOpencode,
            (_responseText: string) => {
              if (ownershipListener) removeListener(eventListeners, sid, ownershipListener)
              if (deps.observer) deps.observer.markSessionFree(sid)
            },
            reactionMsgId,
            reactionId,
            channelId,
          )
        } catch (err) {
          if (ownershipListener) removeListener(eventListeners, sid, ownershipListener)
          if (deps.observer) deps.observer.markSessionFree(sid)
          throw err
        }
      }

      try {
        await runStreamingBridge(sessionId)
        logger.info(`Response sent for session ${sessionId} (streaming bridge, debounced)`)
        return
      } catch (err) {
        if (err instanceof SessionGoneError) {
          logger.warn(`Session ${sessionId} returned 404 in debounced streaming path — clearing stale mapping and retrying`)
          sessionManager.deleteMapping(feishuKey)
          const newSessionId = await sessionManager.getOrCreate(feishuKey)
          ownedSessions.add(newSessionId)
          logger.info(`Session self-healed (debounced streaming): ${sessionId} → ${newSessionId}`)
          sessionId = newSessionId

          try {
            await runStreamingBridge(newSessionId)
            logger.info(`Response sent for session ${newSessionId} (streaming bridge, debounced, after 404 recovery)`)
            return
          } catch (retryErr) {
            logger.warn(`Streaming bridge retry also failed in debounced path: ${retryErr}`)
          }
        } else {
          logger.warn(`Streaming bridge failed in debounced path, falling back to sync: ${err}`)
        }

        // Sync fallback — reaction cleanup only here
        if (reactionId) {
          await feishuClient.deleteReaction(reactionMsgId, reactionId).catch(() => { })
        }
        try {
          const rawText = await postWithRecovery()
          await handleSyncFallback(rawText, sessionId, mergedText, event, thinkingMessageId)
        } catch (postErr) {
          logger.error(`Sync fallback POST also failed in debounced path: ${postErr}`)
          const errorMessage = "处理请求时出错了。"
          const channelId = (lastEvent as any)._channelId || "feishu"
          const plugin = deps.channelManager?.getChannel(channelId)
          if (plugin?.outbound) {
            await plugin.outbound.sendText({ address: lastEvent.chat_id }, errorMessage)
          } else {
            await feishuClient.replyMessage(lastEvent.message_id, {
              msg_type: "text",
              content: JSON.stringify({ text: errorMessage }),
            })
          }
        }
        return
      }
    }

    // No streaming bridge — event-driven → sync fallback
    let rawText: string
    try {
      rawText = await postWithRecovery()
    } catch (err) {
      logger.error(`POST to opencode failed in debounced path: ${err}`)
      if (thinkingMessageId) {
        await progressTracker.updateWithError(thinkingMessageId, "处理请求时出错了。")
      } else {
        await feishuClient.sendMessage(event.chat_id, {
          msg_type: "text",
          content: JSON.stringify({ text: "抱歉，处理请求时出错了。" }),
        })
      }
      return
    }

    let ownershipListenerEd: ((ev: unknown) => void) | null = null
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
      await waitForEventDrivenResponse(sessionId, mergedText, event, thinkingMessageId)
    } catch (err) {
      logger.warn(`Event-driven flow failed in debounced path, falling back to sync: ${err}`)
      await handleSyncFallback(rawText, sessionId, mergedText, event, thinkingMessageId)
    } finally {
      if (ownershipListenerEd) removeListener(eventListeners, sessionId, ownershipListenerEd)
    }
    logger.info(`Response sent for session ${sessionId} (debounced)`)
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
                    const channelId = (event as any)._channelId || "feishu"
                    const adapter = deps.channelManager?.getChannel(channelId)?.outbound
                    await deps.outboundMedia.sendDetectedFiles({ address: event.chat_id }, responseText, adapter)
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
        const channelId = (event as any)._channelId || "feishu"
        const adapter = deps.channelManager?.getChannel(channelId)?.outbound
        await deps.outboundMedia.sendDetectedFiles({ address: event.chat_id }, responseText, adapter)
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
    const channelId = (event as any)._channelId || "feishu"
    const plugin = deps.channelManager?.getChannel(channelId)

    if (thinkingMessageId) {
      await progressTracker.updateWithResponse(thinkingMessageId, responseText)
    } else if (plugin?.outbound) {
      await plugin.outbound.sendText({ address: event.chat_id }, responseText)
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

  return {
    handleMessage,
    dispose: () => debouncer?.dispose(true),
  }
}
