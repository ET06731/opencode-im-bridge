/**
 * TelegramPlugin - channel adapter for Telegram Bot API.
 *
 * Uses long polling (getUpdates) to receive messages and callback queries,
 * and routes them through the standard channel pipeline.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { BaseChannelPlugin } from "../base-plugin.js"
import type {
  ChannelId,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  NormalizedMessage,
  OutboundMessage,
  OutboundTarget,
  StreamTarget,
  StreamingSession,
  ThreadKey,
} from "../types.js"
import type { AppConfig, TelegramConfig } from "../../utils/config.js"
import type { Logger } from "../../utils/logger.js"
import type { FeishuCardAction } from "../../types.js"
import {
  createTelegramInlineCard,
  decodeTelegramCallbackPayload,
  type TelegramInlineCard,
} from "./telegram-interactive.js"

interface TelegramChat {
  id: number
  first_name?: string
  title?: string
  username?: string
}

interface TelegramUser {
  id: number
  first_name: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  date: number
  reply_to_message?: TelegramReplyToMessage
}

interface TelegramReplyToMessage {
  message_id: number
  from?: TelegramUser
  text?: string
  date: number
}

interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

interface TelegramApiEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096
const TELEGRAM_API_BASE = "https://api.telegram.org"
const TELEGRAM_STREAM_THROTTLE_MS = 900

export interface TelegramPluginDeps {
  appConfig: AppConfig
  logger: Logger
  onMessage?: (event: any) => Promise<void>
  onCardAction?: (action: FeishuCardAction) => Promise<void>
}

export class TelegramPlugin extends BaseChannelPlugin {
  override id = "telegram" as ChannelId
  override meta: ChannelMeta = {
    id: "telegram" as ChannelId,
    label: "Telegram",
    description: "Telegram Bot bridge integration",
  }

  private readonly appConfig: AppConfig
  private readonly telegramConfig: TelegramConfig
  private readonly logger: Logger
  private readonly onMessage?: (event: any) => Promise<void>
  private readonly onCardAction?: (action: FeishuCardAction) => Promise<void>
  private abortController: AbortController | null = null

  override config: ChannelConfigAdapter
  override gateway: ChannelGatewayAdapter
  override messaging: ChannelMessagingAdapter
  override outbound: ChannelOutboundAdapter
  override streaming?: ChannelStreamingAdapter | undefined
  override threading: ChannelThreadingAdapter

  private readonly threadMap = new Map<ThreadKey, string>()

  constructor(deps: TelegramPluginDeps) {
    super()
    this.appConfig = deps.appConfig
    this.logger = deps.logger
    this.onMessage = deps.onMessage
    this.onCardAction = deps.onCardAction

    if (!this.appConfig.telegram) {
      throw new Error("Telegram config is missing but TelegramPlugin was instantiated")
    }
    this.telegramConfig = this.appConfig.telegram

    this.config = {
      listAccountIds: () => ["default"],
      resolveAccount: () => this.telegramConfig,
    }

    this.gateway = {
      startAccount: async (_accountId: string, signal: AbortSignal): Promise<void> => {
        this.abortController = new AbortController()
        signal.addEventListener("abort", () => {
          this.abortController?.abort()
        })

        this.startPolling().catch((err) => {
          this.logger.error(`[TelegramPlugin] Poll loop crashed: ${err}`)
        })

        this.registerCommands().catch((err) => {
          this.logger.warn(`[TelegramPlugin] Failed to register commands: ${err}`)
        })

        this.logger.info("[TelegramPlugin] Gateway started (long polling)")
      },

      stopAccount: async (): Promise<void> => {
        this.abortController?.abort()
        this.abortController = null
        this.logger.info("[TelegramPlugin] Gateway stopped")
      },
    }

    this.messaging = {
      normalizeInbound: (raw: unknown): NormalizedMessage => {
        const update = raw as TelegramUpdate
        const message = update.message ?? update.callback_query?.message
        if (!message) {
          throw new Error("Telegram update does not contain a message")
        }
        const sender = update.callback_query?.from ?? message.from
        const chatId = String(message.chat.id)
        const senderId = sender ? String(sender.id) : chatId
        const senderName = sender?.username ?? sender?.first_name

        return {
          messageId: String(message.message_id),
          senderId,
          senderName,
          text: message.text ?? "",
          chatId,
          timestamp: message.date * 1000,
        }
      },

      formatOutbound: (msg: OutboundMessage): unknown => msg.text,
    }

    this.outbound = {
      sendText: async (target: OutboundTarget, text: string): Promise<void> => {
        const converted = mdToMarkdownV2(text)
        const chunks = splitMessage(converted, TELEGRAM_MAX_MESSAGE_LENGTH)
        for (const chunk of chunks) {
          await this.sendMarkdownMessage(target.address, chunk)
        }
      },

      sendPlainText: async (target: OutboundTarget, text: string): Promise<void> => {
        await this.sendChatAction(target.address, "typing")
        const chunks = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH)
        for (const chunk of chunks) {
          await this.callApi("sendMessage", {
            chat_id: target.address,
            text: chunk,
          })
        }
      },

      sendCard: async (target: OutboundTarget, card: unknown): Promise<void> => {
        const inlineCard = card as TelegramInlineCard
        const params: Record<string, unknown> = {
          chat_id: target.address,
          text: inlineCard.text,
          reply_markup: inlineCard.reply_markup,
        }
        if (inlineCard.parse_mode) {
          params.parse_mode = inlineCard.parse_mode
        }
        await this.callApi("sendMessage", params)
      },

      sendImage: async (target: OutboundTarget, filePath: string): Promise<void> => {
        this.logger.info(`[TelegramPlugin] Attempting to send image to ${target.address}: ${filePath}`)
        try {
          const fileData = await readFile(filePath)
          const fileName = basename(filePath)
          await this.callApiMultipart("sendDocument", target.address, "document", fileData, fileName)
          this.logger.info(`[TelegramPlugin] Image sent successfully: ${filePath}`)
        } catch (err) {
          this.logger.error(`[TelegramPlugin] Failed to send image to ${target.address}: ${err}`)
          throw err
        }
      },

      sendFile: async (target: OutboundTarget, filePath: string): Promise<void> => {
        this.logger.info(`[TelegramPlugin] Attempting to send file to ${target.address}: ${filePath}`)
        try {
          const fileData = await readFile(filePath)
          const fileName = basename(filePath)
          await this.callApiMultipart("sendDocument", target.address, "document", fileData, fileName)
          this.logger.info(`[TelegramPlugin] File sent successfully: ${filePath}`)
        } catch (err) {
          this.logger.error(`[TelegramPlugin] Failed to send file to ${target.address}: ${err}`)
          throw err
        }
      },

      sendAudio: async (target: OutboundTarget, filePath: string): Promise<void> => {
        this.logger.info(`[TelegramPlugin] Attempting to send audio to ${target.address}: ${filePath}`)
        try {
          const fileData = await readFile(filePath)
          const fileName = basename(filePath)
          await this.callApiMultipart("sendAudio", target.address, "audio", fileData, fileName)
          this.logger.info(`[TelegramPlugin] Audio sent successfully: ${filePath}`)
        } catch (err) {
          this.logger.error(`[TelegramPlugin] Failed to send audio to ${target.address}: ${err}`)
          throw err
        }
      },

      sendVideo: async (target: OutboundTarget, filePath: string): Promise<void> => {
        this.logger.info(`[TelegramPlugin] Attempting to send video to ${target.address}: ${filePath}`)
        try {
          const fileData = await readFile(filePath)
          const fileName = basename(filePath)
          await this.callApiMultipart("sendVideo", target.address, "video", fileData, fileName)
          this.logger.info(`[TelegramPlugin] Video sent successfully: ${filePath}`)
        } catch (err) {
          this.logger.error(`[TelegramPlugin] Failed to send video to ${target.address}: ${err}`)
          throw err
        }
      },
    }

    // Telegram 不支持消息编辑的流式传输，直接禁用
    // 原因：多次发送 "▌" 导致消息混乱，直接发送完整消息更可靠
    this.streaming = undefined

    this.threading = {
      resolveThread: (inbound: NormalizedMessage): ThreadKey => inbound.chatId as ThreadKey,
      mapSession: (threadKey: ThreadKey, sessionId: string): void => {
        this.threadMap.set(threadKey, sessionId)
      },
      getSession: (threadKey: ThreadKey): string | null => {
        return this.threadMap.get(threadKey) ?? null
      },
    }
  }

  private async callApi<T = unknown>(method: string, params: Record<string, unknown>): Promise<TelegramApiEnvelope<T>> {
    const token = this.telegramConfig.botToken
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
    const data = (await res.json()) as TelegramApiEnvelope<T>

    if (!data.ok) {
      this.logger.error(`[TelegramPlugin] API Error (${method}): ${data.description}`, {
        error_code: data.error_code,
        params,
      })
      throw new Error(`Telegram API error (${method}): ${data.description ?? "unknown"}`)
    }

    return data
  }

  private async callApiMultipart(
    method: string,
    chatId: string,
    fieldName: string,
    fileData: Uint8Array,
    fileName: string,
  ): Promise<void> {
    const token = this.telegramConfig.botToken
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`

    const form = new FormData()
    form.append("chat_id", chatId)
    form.append(fieldName, new Blob([fileData]), fileName)

    const res = await fetch(url, { method: "POST", body: form })
    const data = (await res.json()) as TelegramApiEnvelope<unknown>

    if (!data.ok) {
      this.logger.error(`[TelegramPlugin] API Error (${method}): ${data.description}`, {
        error_code: data.error_code,
        chatId,
        fileName,
      })
      throw new Error(`Telegram API error (${method}): ${data.description ?? "unknown"}`)
    }

    this.logger.debug(`[TelegramPlugin] Multipart API Success (${method})`)
    return
  }

  /**
   * 注册 Bot 斜杠命令菜单。
   * 用户在 Telegram 中输入 "/" 后会弹出可选命令列表。
   */
  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "new", description: "新建会话" },
      { command: "sessions", description: "连接会话" },
      { command: "projects", description: "切换项目" },
      { command: "status", description: "显示状态" },
      { command: "compact", description: "压缩历史" },
      { command: "share", description: "分享会话" },
      { command: "unshare", description: "取消分享" },
      { command: "abort", description: "中止任务" },
      { command: "agent", description: "列出/切换智能体" },
      { command: "models", description: "列出/切换模型" },
      { command: "cron", description: "计划任务管理" },
      { command: "help", description: "显示此帮助" },
    ]
    await this.callApi("setMyCommands", { commands })
    this.logger.info("[TelegramPlugin] Bot commands registered successfully")
  }

  /**
   * 长轮询主循环。
   * 使用 AbortController 支持优雅关闭。
   */
  private async startPolling(onMessage?: (event: unknown) => Promise<void>): Promise<void> {
    let offset = 0
    let connectAttempt = 0
    this.logger.info("[TelegramPlugin] Long polling started")

    while (this.abortController && !this.abortController.signal.aborted) {
      try {
        const token = this.telegramConfig.botToken
        const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates`

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
          }),
          signal: this.abortController.signal,
        })

        const data = (await res.json()) as TelegramApiEnvelope<TelegramUpdate[]>
        if (!data.ok || !Array.isArray(data.result)) {
          this.logger.warn(`[TelegramPlugin] getUpdates failed: ${data.description ?? "unknown"} (code: ${data.error_code})`)
          await sleep(2000)
          continue
        }

        for (const update of data.result) {
          if (update.update_id >= offset) {
            offset = update.update_id + 1
          }

          if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query)
            continue
          }

          if (!update.message?.text) {
            continue
          }

          const chatId = String(update.message.chat.id)
          if (!this.isAllowedChat(chatId)) {
            this.logger.warn(`[TelegramPlugin] Blocked message from unauthorized chatId: ${chatId}`)
            continue
          }

          if (this.onMessage) {
            try {
              await this.onMessage(this.createSyntheticMessageEvent(update))
            } catch (err) {
              this.logger.error(`[TelegramPlugin] onMessage handler error: ${err}`)
            }
          }
        }
      } catch (err) {
        const controller = this.abortController
        if (
          !controller ||
          controller.signal.aborted ||
          (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted")))
        ) {
          break
        }
        connectAttempt++
        const retryDelay = Math.min(1_000 * Math.pow(2, connectAttempt - 1), 30_000)
        this.logger.warn(`[TelegramPlugin] Polling error (attempt ${connectAttempt}): ${err}. Retrying in ${retryDelay}ms...`)
        await sleep(retryDelay)
      }
    }

    this.logger.info("[TelegramPlugin] Long polling stopped")
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const chatId = String(query.message?.chat.id ?? "")
    if (!chatId || !this.isAllowedChat(chatId)) {
      await this.safeAnswerCallbackQuery(query.id, "This chat is not allowed.")
      return
    }

    const payload = query.data ? decodeTelegramCallbackPayload(query.data) : null
    if (!payload) {
      await this.safeAnswerCallbackQuery(query.id, "Unsupported action.")
      return
    }

    try {
      if (payload.action === "cmd" && payload.command && this.onMessage) {
        await this.safeAnswerCallbackQuery(query.id, "Working...")
        const messageEvent = this.createSyntheticMessageEvent({
          update_id: Date.now(),
          message: {
            message_id: query.message?.message_id ?? Date.now(),
            chat: query.message?.chat ?? { id: Number(chatId) },
            from: query.from,
            text: payload.command,
            date: query.message?.date ?? Math.floor(Date.now() / 1000),
          },
        })
        await this.onMessage(messageEvent)
        return
      }

      if ((payload.action === "qa" || payload.action === "pr") && this.onCardAction) {
        await this.safeAnswerCallbackQuery(query.id, "Submitted.")
        const value: Record<string, string> = payload.action === "qa"
          ? {
            action: "question_answer",
            requestId: payload.requestId ?? "",
            answers: JSON.stringify(payload.answers ?? []),
          }
          : {
            action: "permission_reply",
            requestId: payload.requestId ?? "",
            reply: payload.reply ?? "reject",
          }
        await this.onCardAction({
          action: {
            tag: "button",
            value,
          },
          open_message_id: String(query.message?.message_id ?? ""),
          open_chat_id: chatId,
          operator: { open_id: String(query.from.id) },
        })
        return
      }

      await this.safeAnswerCallbackQuery(query.id, "No handler available.")
    } catch (err) {
      this.logger.error(`[TelegramPlugin] callback_query handler error: ${err}`)
      await this.safeAnswerCallbackQuery(query.id, "Action failed.")
    }
  }

  private createSyntheticMessageEvent(update: TelegramUpdate): any {
    const message = update.message!
    const chatId = String(message.chat.id)
    const synthetic: any = {
      event_id: String(update.update_id),
      event_type: "message",
      chat_id: chatId,
      chat_type: "p2p" as const,
      message_id: String(message.message_id),
      sender: {
        sender_id: { open_id: String(message.from?.id ?? chatId) },
        sender_type: "user",
        tenant_key: "telegram",
      },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: message.text ?? "" }),
      },
      _channelId: "telegram",
    }

    if (message.reply_to_message) {
      synthetic.parent_id = String(message.reply_to_message.message_id)
      synthetic.quoted_text = message.reply_to_message.text ?? ""
    }

    return synthetic
  }

  private isAllowedChat(chatId: string): boolean {
    return this.telegramConfig.allowedChatIds.length === 0 || this.telegramConfig.allowedChatIds.includes(chatId)
  }

  private async sendMarkdownMessage(chatId: string, text: string): Promise<void> {
    await this.sendChatAction(chatId, "typing")
    await this.callApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
    })
  }

  private async sendChatAction(chatId: string, action: string): Promise<void> {
    try {
      await this.callApi("sendChatAction", {
        chat_id: chatId,
        action,
      })
    } catch {}
  }

  private buildStreamingPreview(text: string): string {
    const converted = mdToMarkdownV2(text)
    if (converted.endsWith("\n")) return converted + "▌"
    return converted + " ▌"
  }

  private async upsertStreamingMessage(
    chatId: string,
    session: StreamingSession,
    text: string,
  ): Promise<void> {
    if (session.lastMessageId) {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: session.lastMessageId,
        text,
        parse_mode: "MarkdownV2",
      })
    } else {
      const result = await this.callApi<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
      })
      if (result.result) {
        session.lastMessageId = String(result.result.message_id)
      }
    }
  }

  private async safeAnswerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    try {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 180),
      })
    } catch (err) {
      this.logger.warn(`[TelegramPlugin] answerCallbackQuery failed: ${err}`)
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let pos = 0
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + maxLen))
    pos += maxLen
  }
  return chunks
}

export function mdToMarkdownV2(text: string): string {
  const links: { text: string; url: string }[] = []
  const codeblocks: string[] = []
  const inlinecodes: string[] = []
  const bold: string[] = []
  const italic: string[] = []
  let remaining = text.replace(/\r\n/g, "\n")

  remaining = remaining.replace(/```([a-zA-Z0-9_+-]+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const index = codeblocks.push((lang ? `\`\`\`${lang}\n` : "```\n") + `${code.trimEnd()}\n\`\`\``) - 1
    return `\x02CODEBLOCK${index}\x03`
  })

  remaining = remaining.replace(/`([^`]+)`/g, (_match, code) => {
    const index = inlinecodes.push(code) - 1
    return `\x02INLINECODE${index}\x03`
  })

  remaining = remaining.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
    const index = links.push({ text, url }) - 1
    return `\x02LINK${index}\x03`
  })

  remaining = remaining.replace(/\*\*([^*]+)\*\*/g, (_match, content) => {
    const index = bold.push(content) - 1
    return `\x02BOLD${index}\x03`
  })

  remaining = remaining.replace(/\*([^*]+)\*/g, (_match, content) => {
    const index = italic.push(content) - 1
    return `\x02ITALIC${index}\x03`
  })
  remaining = remaining.replace(/_(?![\x02-\x03])([^_]+)_(?![\x02-\x03])/g, (_match, content) => {
    const index = italic.push(content) - 1
    return `\x02ITALIC${index}\x03`
  })

  let md = remaining
  md = md.replace(/^>\s?(.*)$/gm, "$1")
  md = md.replace(/^\s*-\s+(.*)$/gm, "• $1")
  md = md.replace(/^\s*\d+\.\s+(.*)$/gm, "$1")
  md = md.replace(/\|\|([^|]+)\|\|/g, "||$1||")
  md = md.replace(/~~([^~]+)~~/g, "~$1~")

  md = escapeMarkdownV2(md)

  md = md.replace(/\x02BOLD(\d+)\x03/g, (_match, index) => {
    const content = bold[Number(index)]
    return content ? `*${escapeMarkdownV2(content)}*` : ""
  })
  md = md.replace(/\x02ITALIC(\d+)\x03/g, (_match, index) => {
    const content = italic[Number(index)]
    return content ? `_${escapeMarkdownV2(content)}_` : ""
  })
  md = md.replace(/\x02LINK(\d+)\x03/g, (_match, index) => {
    const link = links[Number(index)]
    return link ? `[${escapeMarkdownV2(link.text)}](${escapeMarkdownV2(link.url)})` : ""
  })
  md = md.replace(/\x02INLINECODE(\d+)\x03/g, (_match, index) => {
    const content = inlinecodes[Number(index)]
    // Inside inline code, only ` and \ need escaping
    const escaped = content ? content.replace(/([`\\])/g, "\\$1") : ""
    return content ? `\`${escaped}\`` : ""
  })
  md = md.replace(/\x02CODEBLOCK(\d+)\x03/g, (_match, index) => codeblocks[Number(index)] ?? "")

  return md
}

function escapeMarkdownV2(text: string): string {
  let result = text.replace(/\\/g, "\\\\")
  result = result.replace(/([_\*\[\]()~`>#+\-=|{}.!])/g, "\\$1")
  return result
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { createTelegramInlineCard }
